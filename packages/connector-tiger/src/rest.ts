import * as crypto from 'node:crypto'
import type {
  AccountBalance,
  Interval,
  Kline,
  Order,
  OrderRequest,
  Position,
  Ticker,
  TradingErrorCode,
} from '@dshtrading/api'

export class TradingServiceError extends Error {
  readonly code: TradingErrorCode

  constructor(code: TradingErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'TradingServiceError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

export const INTERVAL_VOCABULARY = ['1m', '5m', '15m', '30m', '1h', '1d', '1w', '1M'] as const

export function toTigerSymbol(raw: string): { symbol: string; canonical: string; secType: 'STK' } {
  const clean = raw.trim().toUpperCase()
  if (!clean) throw new TradingServiceError('TRADING_INVALID_ARGUMENT', 'Symbol cannot be empty')
  if (clean.includes('.')) {
    const parts = clean.split('.')
    return { symbol: parts[0], canonical: clean, secType: 'STK' }
  }
  if (/^\d{5}$/.test(clean)) {
    return { symbol: clean, canonical: `${clean}.HK`, secType: 'STK' }
  }
  return { symbol: clean, canonical: clean, secType: 'STK' }
}

export function generateTigerSignature(params: Record<string, string>, privateKeyPem: string): string {
  const sortedKeys = Object.keys(params).filter((k) => k !== 'sign' && params[k] !== undefined && params[k] !== '').sort()
  const content = sortedKeys.map((k) => `${k}=${params[k]}`).join('&')
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(content, 'utf8')
  sign.end()
  return sign.sign(privateKeyPem, 'base64')
}

export interface TigerRestOptions {
  baseUrl?: string
  tigerId?: string
  privateKey?: string
  accountId?: string
  fetchImpl?: typeof fetch
}

export class TigerRestClient {
  readonly baseUrl: string
  readonly tigerId?: string
  readonly privateKey?: string
  readonly accountId?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: TigerRestOptions = {}) {
    this.baseUrl = options.baseUrl ?? (process.env.TIGER_API_URL || 'https://openapi.itiger.com/gateway')
    this.tigerId = options.tigerId ?? process.env.TIGER_ID
    this.privateKey = options.privateKey ?? process.env.TIGER_PRIVATE_KEY
    this.accountId = options.accountId ?? process.env.TIGER_ACCOUNT_ID
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(bizContent: Record<string, unknown>, method: string): Promise<T> {
    const tigerId = this.tigerId ?? 'demo'
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const bizContentStr = JSON.stringify(bizContent)

    const rawParams: Record<string, string> = {
      tiger_id: tigerId,
      method,
      charset: 'UTF-8',
      sign_type: 'RSA2',
      timestamp,
      version: '1.0',
      biz_content: bizContentStr,
    }

    if (this.privateKey) {
      try {
        rawParams.sign = generateTigerSignature(rawParams, this.privateKey)
      } catch (err) {
        throw new TradingServiceError('TRADING_AUTH_FAILED', `Tiger RSA signature generation failed: ${err instanceof Error ? err.message : String(err)}`, err)
      }
    }

    try {
      const res = await this.fetchImpl(this.baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rawParams),
      })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `Tiger HTTP ${res.status}: ${res.statusText}`)
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `Tiger network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const { symbol: sym, canonical } = toTigerSymbol(symbol)
    const data = await this.requestJson<{
      code: number
      message?: string
      data?: Array<{ symbol: string; latestPrice: number; volume: number; timestamp: number }>
    }>({ symbols: [sym] }, 'quote_real_time')

    if (data.code !== 0) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Tiger getTicker failed: ${data.message ?? `code ${data.code}`}`)
    }
    // 上游回 code 0 但没有可用报价行时**抛错**：静默返回 price 0 会把「这条标的没有行情」
    // 伪装成一个可交易的价格，消费方无法把 0 与真报价区分开。
    const row = Array.isArray(data.data) ? data.data[0] : undefined
    if (!row || !Number.isFinite(row.latestPrice) || row.latestPrice <= 0) {
      throw new TradingServiceError(
        'TRADING_EXCHANGE_ERROR',
        `Tiger getTicker: response carries no usable quote for ${canonical} (${JSON.stringify(data)})`,
      )
    }

    return {
      symbol: canonical,
      price: row.latestPrice,
      volume: row.volume,
      timestamp: row.timestamp,
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const { symbol: sym } = toTigerSymbol(symbol)
    const data = await this.requestJson<{
      code: number
      message?: string
      data?: Array<{ items?: Array<{ time: number; open: number; close: number; high: number; low: number; volume: number }> }>
    }>({ symbols: [sym], period: interval, limit }, 'kline_quote')

    if (data.code !== 0) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Tiger getKlines failed: ${data.message ?? `code ${data.code}`}`)
    }
    // 上游回**空数组**是明确的「无序列」，属合法空值；其余不可识别的形状一律抛错，
    // 不把「看不懂的回包」当成「没有 K 线」。
    if (!Array.isArray(data.data)) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Tiger getKlines: unrecognizable payload (${JSON.stringify(data)})`)
    }
    if (data.data.length === 0) return []

    const items = data.data[0]?.items
    if (!Array.isArray(items)) {
      throw new TradingServiceError(
        'TRADING_EXCHANGE_ERROR',
        `Tiger getKlines: response carries no items array (${JSON.stringify(data)})`,
      )
    }
    return items.map((r) => ({
      openTime: r.time,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      closeTime: r.time + 86400000 - 1,
    }))
  }

  async getBalance(): Promise<AccountBalance> {
    if (!this.privateKey) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'Tiger: privateKey (RSA PEM) is required for getBalance')
    }
    const acc = this.accountId
    const res = await this.requestJson<{
      code: number
      message?: string
      data?: { cash?: number; netLiquidation?: number; currency?: string }
    }>({ account: acc }, 'user_asset')

    if (res.code !== 0 || !res.data) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Tiger getBalance failed: ${res.message ?? `code ${res.code}`}`)
    }

    return {
      currency: res.data.currency ?? 'HKD',
      available: res.data.cash ?? 0,
      total: res.data.netLiquidation ?? res.data.cash ?? 0,
    }
  }

  async getPositions(): Promise<Position[]> {
    if (!this.privateKey) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'Tiger: privateKey (RSA PEM) is required for getPositions')
    }
    const res = await this.requestJson<{
      code: number
      message?: string
      data?: Array<{ symbol: string; quantity: number; averageCost: number; unrealizedPnl: number }>
    }>({ account: this.accountId }, 'positions')

    if (res.code !== 0 || !Array.isArray(res.data)) return []
    return res.data.map((p) => ({
      symbol: toTigerSymbol(p.symbol).canonical,
      quantity: p.quantity,
      entryPrice: p.averageCost,
      unrealizedPnl: p.unrealizedPnl,
    }))
  }

  async placeOrder(_creds: unknown, req: OrderRequest): Promise<Order> {
    if (!this.privateKey) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'Tiger: privateKey (RSA PEM) is required for placeOrder')
    }
    const { symbol: sym, canonical } = toTigerSymbol(req.symbol)
    const res = await this.requestJson<{
      code: number
      message?: string
      data?: { id?: string; orderId?: string; status?: string }
    }>({
      account: this.accountId,
      symbol: sym,
      action: req.side.toUpperCase(),
      orderType: req.type === 'market' ? 'MKT' : 'LMT',
      totalQuantity: req.quantity,
      limitPrice: req.price,
    }, 'trade_order')

    if (res.code !== 0) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Tiger placeOrder failed: ${res.message ?? `code ${res.code}`}`)
    }
    // 回执缺订单 id 时**抛错**，绝不自己编一个（编出来的 id 会让「这单在不在 venue 上」
    // 变成一句假话；意图台账只接受真实 venue 句柄）。
    const payload = res.data
    if (payload === undefined) {
      throw new TradingServiceError(
        'TRADING_EXCHANGE_ERROR',
        'Tiger placeOrder: response carries no data payload — the order is not confirmed',
      )
    }
    const id = payload.id ?? payload.orderId
    if (typeof id !== 'string' || id.trim() === '') {
      throw new TradingServiceError(
        'TRADING_EXCHANGE_ERROR',
        `Tiger placeOrder: response carries no real order id (${JSON.stringify(res.data)}) — the order is not confirmed`,
      )
    }

    return {
      id,
      symbol: canonical,
      side: req.side,
      type: req.type,
      status: (payload.status?.toLowerCase() as Order['status']) ?? 'new',
      quantity: req.quantity,
      price: req.price ?? 0,
      dryRun: false,
      timestamp: Date.now(),
    }
  }

  async cancelOrder(_creds: unknown, orderId: string): Promise<{ orderId: string; status: 'canceled' }> {
    if (!this.privateKey) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'Tiger: privateKey (RSA PEM) is required for cancelOrder')
    }
    const res = await this.requestJson<{ code: number; message?: string }>({
      account: this.accountId,
      orderId,
    }, 'cancel_order')

    if (res.code !== 0) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Tiger cancelOrder failed: ${res.message ?? `code ${res.code}`}`)
    }

    return { orderId, status: 'canceled' }
  }
}

export type { AccountBalance, Interval, Kline, Order, Position, Ticker }

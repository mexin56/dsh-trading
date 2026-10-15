/**
 * @dshtrading/connector-qmt/rest
 * 迅投 MiniQMT A 股券商实盘交易与行情客户端。
 */

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

export function toQmtCode(symbol: string): string {
  const clean = symbol.trim().toUpperCase()
  if (clean.includes('.')) return clean
  if (clean.startsWith('6') || clean.startsWith('5')) return `${clean}.SH`
  if (clean.startsWith('0') || clean.startsWith('3')) return `${clean}.SZ`
  if (clean.startsWith('8') || clean.startsWith('4')) return `${clean}.BJ`
  return `${clean}.SH`
}

/**
 * 东财回退报价的行字段（ulist.np/get）：f1=小数位数 f2=最新价 f5=成交量(手) f124=行情时间(秒)。
 * 价格类字段是 ×10^f1 的整数。
 */
const EM_QUOTE_FIELDS = 'f1,f2,f5,f124'

/** 东财报价字段 → 有限数；null/空串/停牌占位返回 undefined，由调用方兜底。 */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 东财报价行的价格除数 = 10^f1（f1 = 上游给该标的声明的小数位数）：A 股股票 f1=2、A 股 ETF
 * f1=3（2026-10-14 实测），故取价一律按行——市场级 ×100 会把 ETF 读成 10 倍。
 * f1 缺失或落在 0..6 之外时回落到市场级 ×100。
 */
function quotePriceScale(decimalDigits: unknown): number {
  const digits = toFiniteNumber(decimalDigits)
  if (digits === undefined || !Number.isInteger(digits) || digits < 0 || digits > 6) return 100
  return 10 ** digits
}

export interface QmtRestOptions {
  gatewayUrl?: string
  accountId?: string
  fetchImpl?: typeof fetch
}

export class QmtRestClient {
  readonly gatewayUrl: string
  readonly accountId?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: QmtRestOptions = {}) {
    this.gatewayUrl = options.gatewayUrl ?? (process.env.QMT_GATEWAY_URL || 'http://127.0.0.1:5800')
    this.accountId = options.accountId ?? process.env.QMT_ACCOUNT_ID
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.gatewayUrl}${path}`
    try {
      const res = await this.fetchImpl(url, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers as Record<string, string>) },
      })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `QMT HTTP ${res.status}: ${res.statusText}`)
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `QMT network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  /**
   * 网关报价。网关**传输层**失败（连不上 / 非 2xx / 非 JSON）与网关明确回「业务码非 0 或缺
   * data」走**同一条**回退路径（[quoteViaEastmoneyFallback]）：主取价路径任一形态不可用即降级，
   * 不在业务码上另立第三种语义——上游业务错误码与 HTTP 4xx/5xx 在本仓是同一类失败
   * （`@dshtrading/api` 的 `TRADING_UPSTREAM_ERROR` 注释即此口径）。
   */
  async getTicker(symbol: string): Promise<Ticker> {
    const qmtCode = toQmtCode(symbol)
    let gatewayFailure: unknown
    try {
      const data = await this.requestJson<{
        code: number
        message?: string
        data?: { lastPrice: number; volume: number; timestamp?: number }
      }>(`/api/v1/market/ticker?symbol=${encodeURIComponent(qmtCode)}`)
      if (data.code === 0 && data.data) {
        return {
          symbol: qmtCode,
          price: data.data.lastPrice,
          volume: data.data.volume,
          timestamp: data.data.timestamp ?? Date.now(),
        }
      }
      gatewayFailure = new TradingServiceError(
        'TRADING_EXCHANGE_ERROR',
        `QMT getTicker failed: ${data.message ?? `gateway returned code ${data.code} without a quote payload`}`,
      )
    } catch (err) {
      gatewayFailure = err
    }

    return await this.quoteViaEastmoneyFallback(qmtCode, gatewayFailure)
  }

  /**
   * 网关取价路径不可用时的东财回退报价——2026-10-14 实测建立的降级设计：本地网关离线仍要能出价。
   *
   * 报价走批量端点 ulist.np/get（2026-10-14 实测单标的 /api/qt/stock/get 对任意 secid 都是传输层
   * 空回，而同一时刻同域同 UA 的 ulist.np/get 正常），取价按该行自带的 f1 小数位数——市场级 ÷100
   * 会把 A 股 ETF（f1=3）读成 10 倍。原始证据见 spikes/impl-eastmoney-quote-endpoint/。
   *
   * 每次调用最多一个请求：push2 域对突发并发极敏感（connector-eastmoney/README「已知边界」：
   * 2026-10-14 实测在飞 4 即被断连且失效面持续 ≥12 分钟），这条路径不做批量、不重试。
   *
   * 拿不到可用报价行时抛结构化错误，**绝不交出零价快照**：`price: 0` 在消费方读起来是「这只标的
   * 不值钱」，而不是「本次没取到价」。`cause` 一律是触发本次降级的网关失败，便于回溯主路径为何不可用。
   */
  private async quoteViaEastmoneyFallback(qmtCode: string, cause: unknown): Promise<Ticker> {
    const secid = qmtCode.startsWith('6') || qmtCode.startsWith('5') ? `1.${qmtCode.split('.')[0]}` : `0.${qmtCode.split('.')[0]}`
    let res: Response
    try {
      res = await this.fetchImpl(
        `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${secid}&fields=${EM_QUOTE_FIELDS}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://quote.eastmoney.com/' } },
      )
    } catch (err) {
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `Eastmoney fallback unreachable: ${String(err)}`,
        err,
      )
    }

    // 非 2xx：请求到达了上游、上游明确报错（与 connector-eastmoney 同一映射）。
    if (!res.ok) {
      throw new TradingServiceError(
        'TRADING_UPSTREAM_ERROR',
        `Eastmoney fallback HTTP ${res.status} ${res.statusText}`,
        cause,
      )
    }

    // 非 JSON：上游回了一个不成形的载荷（与 connector-eastmoney 同一映射）。
    let payload: { data?: { diff?: Array<Record<string, unknown>> } | null }
    try {
      payload = await res.json() as typeof payload
    } catch (err) {
      throw new TradingServiceError(
        'TRADING_EXCHANGE_ERROR',
        `Eastmoney fallback returned a non-JSON body for ${qmtCode}: ${String(err)}`,
        cause,
      )
    }

    // 未收录的 secid 上游是「少返回行」（只传无效 secid 时 data:null；HTTP 仍 200），停牌占位是
    // f2 缺失或 0——两种形态都没有可用价格。不借用 TRADING_SYMBOL_NOT_FOUND（该码 2026-10-15 已
    // 收录进 TradingErrorCode 词汇表；bybit 对同一缺口的取舍记在 2026-10-08 那份 note）：走进这条
    // 支路的唯一原因是**主取价路径不可用**，从 push2 的沉默推不出「该标的不存在」（secid 由
    // toQmtCode 的启发式映射派生）。照实报「上游没给出可用报价」。
    const row = payload.data?.diff?.[0]
    const rawPrice = toFiniteNumber(row?.f2)
    if (row === undefined || rawPrice === undefined || rawPrice <= 0) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `Eastmoney fallback returned no usable quote for ${qmtCode}`, cause)
    }

    const quoteTime = toFiniteNumber(row.f124)
    return {
      symbol: qmtCode,
      price: rawPrice / quotePriceScale(row.f1),
      volume: toFiniteNumber(row.f5) ?? 0,
      timestamp: quoteTime !== undefined && quoteTime > 0 ? quoteTime * 1000 : Date.now(),
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const qmtCode = toQmtCode(symbol)
    try {
      const data = await this.requestJson<{
        code: number
        data?: { klines?: Array<{ openTime: number; open: number; close: number; high: number; low: number; volume: number }> }
      }>(`/api/v1/market/klines?symbol=${encodeURIComponent(qmtCode)}&period=${interval}&limit=${limit}`)
      if (data.code === 0 && Array.isArray(data.data?.klines)) {
        return data.data.klines
      }
    } catch {
      // 回退东财
      const secid = qmtCode.startsWith('6') || qmtCode.startsWith('5') ? `1.${qmtCode.split('.')[0]}` : `0.${qmtCode.split('.')[0]}`
      const res = await this.fetchImpl(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&lmt=${limit}&fields2=f51,f52,f53,f54,f55,f56`)
      const d = await res.json() as { data?: { klines?: string[] } }
      if (!d.data?.klines) return []
      return d.data.klines.map((l) => {
        const p = l.split(',')
        const openTime = new Date(p[0].replace(/-/g, '/')).getTime()
        return {
          openTime,
          open: parseFloat(p[1]),
          close: parseFloat(p[2]),
          high: parseFloat(p[3]),
          low: parseFloat(p[4]),
          volume: parseFloat(p[5]),
          closeTime: openTime + 86400000 - 1,
        }
      })
    }

    return []
  }

  async getBalance(accountId?: string): Promise<AccountBalance> {
    const acc = accountId ?? this.accountId
    if (!acc) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'QMT: accountId is required to query balance')
    }
    const res = await this.requestJson<{
      code: number
      message?: string
      data?: { cash?: number; total_asset?: number; frozen_cash?: number; currency?: string }
    }>(`/api/v1/trade/asset?account_id=${encodeURIComponent(acc)}`)

    if (res.code !== 0 || !res.data) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `QMT getBalance failed: ${res.message ?? `code ${res.code}`}`)
    }

    return {
      currency: res.data.currency ?? 'CNY',
      available: res.data.cash ?? 0,
      total: res.data.total_asset ?? res.data.cash ?? 0,
    }
  }

  async getPositions(accountId?: string): Promise<Position[]> {
    const acc = accountId ?? this.accountId
    if (!acc) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'QMT: accountId is required to query positions')
    }
    const res = await this.requestJson<{
      code: number
      message?: string
      data?: Array<{
        stock_code: string
        volume: number
        can_use_volume: number
        open_price: number
        market_value: number
      }>
    }>(`/api/v1/trade/positions?account_id=${encodeURIComponent(acc)}`)

    if (res.code !== 0 || !Array.isArray(res.data)) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `QMT getPositions failed: ${res.message ?? `code ${res.code}`}`)
    }

    return res.data.map((p) => ({
      symbol: toQmtCode(p.stock_code),
      quantity: p.volume,
      entryPrice: p.open_price,
      unrealizedPnl: 0,
    }))
  }

  async placeOrder(creds: { accountId?: string } | undefined, req: OrderRequest): Promise<Order> {
    const acc = creds?.accountId ?? this.accountId
    if (!acc) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'QMT: accountId is required to place order')
    }
    const qmtCode = toQmtCode(req.symbol)
    const res = await this.requestJson<{
      code: number
      message?: string
      data?: { order_id: string; status?: string }
    }>('/api/v1/trade/order', {
      method: 'POST',
      body: JSON.stringify({
        account_id: acc,
        stock_code: qmtCode,
        order_type: req.type,
        order_side: req.side,
        price: req.price ?? 0,
        order_volume: req.quantity,
      }),
    })

    if (res.code !== 0 || !res.data?.order_id) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `QMT placeOrder failed: ${res.message ?? `code ${res.code}`}`)
    }

    return {
      id: res.data.order_id,
      symbol: qmtCode,
      side: req.side,
      type: req.type,
      status: (res.data.status as Order['status']) ?? 'new',
      quantity: req.quantity,
      price: req.price ?? 0,
      dryRun: false,
      timestamp: Date.now(),
    }
  }

  async cancelOrder(creds: { accountId?: string } | undefined, orderId: string): Promise<{ orderId: string; status: 'canceled' }> {
    const acc = creds?.accountId ?? this.accountId
    if (!acc) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'QMT: accountId is required to cancel order')
    }
    const res = await this.requestJson<{
      code: number
      message?: string
      data?: { order_id: string }
    }>('/api/v1/trade/cancel', {
      method: 'POST',
      body: JSON.stringify({
        account_id: acc,
        order_id: orderId,
      }),
    })

    if (res.code !== 0) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `QMT cancelOrder failed: ${res.message ?? `code ${res.code}`}`)
    }

    return { orderId, status: 'canceled' }
  }
}

export type { AccountBalance, Interval, Kline, Order, Position, Ticker }

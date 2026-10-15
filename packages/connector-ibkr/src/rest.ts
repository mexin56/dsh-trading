/**
 * @dshtrading/connector-ibkr/rest
 * Interactive Brokers (盈透证券) Client Portal Gateway REST 客户端。
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

export const INTERVAL_VOCABULARY = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'] as const

export function normalizeUsSymbol(raw: string): string {
  const clean = raw.trim().toUpperCase()
  if (!clean) throw new TradingServiceError('TRADING_INVALID_ARGUMENT', 'Symbol cannot be empty')
  return clean
}

/** 把上游回包压成一行摘要，只用于错误消息；超长截断，避免整页响应灌进日志。 */
function summarizePayload(value: unknown, max = 200): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > max ? `${text.slice(0, max)}...(truncated)` : text
}

export interface IbkrRestOptions {
  gatewayUrl?: string
  accountId?: string
  fetchImpl?: typeof fetch
}

export class IbkrRestClient {
  readonly gatewayUrl: string
  readonly accountId?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: IbkrRestOptions = {}) {
    this.gatewayUrl = options.gatewayUrl ?? (process.env.IBKR_GATEWAY_URL || 'https://127.0.0.1:5000/v1/api')
    this.accountId = options.accountId ?? process.env.IBKR_ACCOUNT_ID
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
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `IBKR HTTP ${res.status}: ${res.statusText}`)
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `IBKR network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const sym = normalizeUsSymbol(symbol)
    // 行情面零跨源回落：网关失败就失败，绝不改打公共源兜底（旧实现的 Yahoo 回退分支已删除）。
    const data = await this.requestJson<unknown>(
      `/iserver/marketdata/snapshot?symbols=${encodeURIComponent(sym)}&fields=31,84,86`,
    )
    if (!Array.isArray(data) || data.length === 0) {
      throw new TradingServiceError(
        'TRADING_EXCHANGE_ERROR',
        `IBKR getTicker ${sym}: gateway snapshot carries no row (${summarizePayload(data)})`,
      )
    }

    const row = data[0] as Record<string, unknown> | null | undefined
    const price = Number.parseFloat(String(row?.['31'] ?? ''))
    // 缺失/非数值/0/负数一律视为「没有可用价格」：宁可报错，也不回 0 或 NaN 的伪行情。
    if (!Number.isFinite(price) || price <= 0) {
      throw new TradingServiceError(
        'TRADING_EXCHANGE_ERROR',
        `IBKR getTicker ${sym}: gateway snapshot carries no usable price (${summarizePayload(row)})`,
      )
    }

    return {
      symbol: sym,
      price,
      timestamp: Date.now(),
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const sym = normalizeUsSymbol(symbol)
    // 同上：历史序列同样只认网关这一个源，不回落任何公共端点。
    const data = await this.requestJson<{ data?: Array<{ t: number; o: number; c: number; h: number; l: number; v: number }> }>(
      `/hmds/history?symbol=${sym}&period=${limit}d&bar=${interval}`,
    )
    if (!Array.isArray(data?.data)) {
      throw new TradingServiceError(
        'TRADING_EXCHANGE_ERROR',
        `IBKR getKlines ${sym} ${interval}: gateway history response is not a bar array (${summarizePayload(data)})`,
      )
    }

    // 空数组是上游明确的「该序列无数据」，属合法空值，不升级为错误。
    return data.data.map((r) => ({
      openTime: r.t,
      open: r.o,
      high: r.h,
      low: r.l,
      close: r.c,
      volume: r.v,
      closeTime: r.t + 86400000 - 1,
    }))
  }

  async getBalance(accountId?: string): Promise<AccountBalance> {
    const acc = accountId ?? this.accountId
    if (!acc) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'IBKR: accountId is required to query balance')
    }
    const res = await this.requestJson<Record<string, { cashbalance?: number; netliquidationvalue?: number; currency?: string }>>(
      `/portfolio/${encodeURIComponent(acc)}/ledger`,
    )

    const base = res.USD ?? res.BASE ?? Object.values(res)[0]
    if (!base) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'IBKR getBalance: empty ledger returned')
    }

    return {
      currency: base.currency ?? 'USD',
      available: base.cashbalance ?? 0,
      total: base.netliquidationvalue ?? base.cashbalance ?? 0,
    }
  }

  async getPositions(accountId?: string): Promise<Position[]> {
    const acc = accountId ?? this.accountId
    if (!acc) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'IBKR: accountId is required to query positions')
    }
    const res = await this.requestJson<Array<{
      ticker?: string
      contractDesc?: string
      position?: number
      mktPrice?: number
      avgPrice?: number
      unrealizedPnl?: number
    }>>(`/portfolio/${encodeURIComponent(acc)}/positions/0`)

    if (!Array.isArray(res)) return []
    return res.map((p) => ({
      symbol: normalizeUsSymbol(p.ticker ?? p.contractDesc ?? ''),
      quantity: p.position ?? 0,
      entryPrice: p.avgPrice ?? 0,
      unrealizedPnl: p.unrealizedPnl ?? 0,
    }))
  }

  async placeOrder(creds: { accountId?: string } | undefined, req: OrderRequest, clientOrderId?: string): Promise<Order> {
    const acc = creds?.accountId ?? this.accountId
    if (!acc) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'IBKR: accountId is required to place order')
    }
    const sym = normalizeUsSymbol(req.symbol)
    let res = await this.requestJson<Array<{ order_id?: string; order_status?: string; id?: string; message?: string[] }>>(
      `/iserver/account/${encodeURIComponent(acc)}/orders`,
      {
        method: 'POST',
        body: JSON.stringify({
          orders: [
            {
              acctId: acc,
              secType: 'STK',
              ticker: sym,
              orderType: req.type === 'market' ? 'MKT' : 'LMT',
              side: req.side.toUpperCase(),
              quantity: req.quantity,
              price: req.price,
              tif: 'DAY',
              // IBKR 官方 cOID（Customer Order ID）：24h 内必须唯一；由 intentId 确定性派生。
              ...(clientOrderId !== undefined ? { cOID: clientOrderId } : {}),
            },
          ],
        }),
      },
    )

    if (!Array.isArray(res) || res.length === 0) {
      throw new TradingServiceError('TRADING_EXCHANGE_ERROR', 'IBKR placeOrder: empty response from gateway')
    }

    // 处理 IBKR Pre-order Warning 确认提示
    if (res[0].id && !res[0].order_id) {
      const replyId = res[0].id
      res = await this.requestJson<Array<{ order_id?: string; order_status?: string }>>(
        `/iserver/reply/${encodeURIComponent(replyId)}`,
        {
          method: 'POST',
          body: JSON.stringify({ confirmed: true }),
        },
      )
    }

    const first = res[0]
    // 回执缺 order_id 时**抛错**，绝不自己编一个：编出来的 id 会让「这单在不在 venue 上」
    // 变成一句假话，而意图台账只接受真实 venue 句柄（issue 43 资金正确性）。
    const orderId = typeof first?.order_id === 'string' && first.order_id.trim() !== '' ? first.order_id : undefined
    if (orderId === undefined) {
      throw new TradingServiceError(
        'TRADING_EXCHANGE_ERROR',
        `IBKR placeOrder: gateway response carries no real order_id (${JSON.stringify(first ?? null)}) — the order is not confirmed`,
      )
    }

    return {
      id: orderId,
      symbol: sym,
      side: req.side,
      type: req.type,
      status: (first?.order_status?.toLowerCase() as Order['status']) ?? 'new',
      quantity: req.quantity,
      price: req.price ?? 0,
      dryRun: false,
      timestamp: Date.now(),
    }
  }

  async cancelOrder(creds: { accountId?: string } | undefined, orderId: string): Promise<{ orderId: string; status: 'canceled' }> {
    const acc = creds?.accountId ?? this.accountId
    if (!acc) {
      throw new TradingServiceError('TRADING_AUTH_FAILED', 'IBKR: accountId is required to cancel order')
    }
    await this.requestJson(`/iserver/account/${encodeURIComponent(acc)}/order/${encodeURIComponent(orderId)}`, {
      method: 'DELETE',
    })
    return { orderId, status: 'canceled' }
  }
}

export type { AccountBalance, Interval, Kline, Order, Position, Ticker }

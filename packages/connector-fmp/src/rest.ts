/**
 * @dshtrading/connector-fmp/rest
 * Financial Modeling Prep 美股 REST 客户端（支持行情与基本面）。
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

/** FMP 上游真实支持的周期：6 个日内档（`/historical-chart`）+ 日线 EOD（`/historical-price-full`）。 */
export const INTERVAL_VOCABULARY = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const

/** `INTERVAL_VOCABULARY` 的类型面：调用方在断言后即可按穷尽联合处理周期。 */
export type SupportedInterval = (typeof INTERVAL_VOCABULARY)[number]

/**
 * 表外周期显式拒绝（fail-closed）：`Interval` 是 15 档规范联合，比 FMP 实际上游能力宽，
 * 本包不接受静默降级到日线。断言签名同时把 `interval` 收窄到受支持联合，
 * 使下游 `switch` 穷尽——新增/漏掉一档映射是编译错误而非运行期回落到日线。
 */
export function assertSupportedInterval(interval: Interval): asserts interval is SupportedInterval {
  if (!(INTERVAL_VOCABULARY as readonly string[]).includes(interval)) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_INTERVAL',
      'FMP upstream does not serve interval "' + interval + '"; supported: ' + INTERVAL_VOCABULARY.join(', '),
    )
  }
}

export function toFmpInterval(interval: Interval): string {
  assertSupportedInterval(interval)
  switch (interval) {
    case '1m': return '1min'
    case '5m': return '5min'
    case '15m': return '15min'
    case '30m': return '30min'
    case '1h': return '1hour'
    case '4h': return '4hour'
    case '1d': return '1day'
  }
}

export function parseIntervalMs(interval: Interval): number {
  assertSupportedInterval(interval)
  switch (interval) {
    case '1m': return 60 * 1000
    case '5m': return 5 * 60 * 1000
    case '15m': return 15 * 60 * 1000
    case '30m': return 30 * 60 * 1000
    case '1h': return 60 * 60 * 1000
    case '4h': return 4 * 60 * 60 * 1000
    case '1d': return 24 * 60 * 60 * 1000
  }
}

export function normalizeUsSymbol(raw: string): string {
  const clean = raw.trim().toUpperCase()
  if (!clean) throw new TradingServiceError('TRADING_INVALID_ARGUMENT', 'Symbol cannot be empty')
  return clean
}

export interface FmpRestOptions {
  baseUrl?: string
  apiKey?: string
  /**
   * 惰性凭证源：**每次请求**解析一次（BYOK）。设置中心 `dshtrading.credentials.fmp.apiKey`
   * 由它取、`process.env[apiKeyRef]` 兜底（见 `createApiKeyProvider`）。静态 `apiKey` 保留作
   * 直调用法（README 出网复跑命令、离线用例）的构造期兜底。
   */
  apiKeyProvider?: () => string | undefined
  fetchImpl?: typeof fetch
}

export class FmpRestClient {
  readonly baseUrl: string
  private readonly apiKey?: string
  private readonly apiKeyProvider?: () => string | undefined
  private readonly fetchImpl: typeof fetch

  constructor(options: FmpRestOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://financialmodelingprep.com/api/v3'
    this.apiKey = options.apiKey
    this.apiKeyProvider = options.apiKeyProvider
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  /** 取值顺序：惰性 provider（设置中心优先、env 兜底）→ 构造期静态快照。 */
  private resolvedApiKey(): string | undefined {
    return this.apiKeyProvider?.() ?? this.apiKey
  }

  private async requestJson<T>(path: string): Promise<T> {
    const sep = path.includes('?') ? '&' : '?'
    const apiKey = this.resolvedApiKey()
    const keyQuery = apiKey ? `${sep}apikey=${encodeURIComponent(apiKey)}` : ''
    const url = `${this.baseUrl}${path}${keyQuery}`
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'Accept': 'application/json' },
      })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `FMP request failed: HTTP ${res.status}`)
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `FMP network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const sym = normalizeUsSymbol(symbol)
    const data = await this.requestJson<Array<Record<string, unknown>>>(`/quote/${sym}`)
    if (!Array.isArray(data) || data.length === 0) {
      throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `FMP quote not found for ${sym}`)
    }

    const row = data[0]
    const price = typeof row.price === 'number' ? row.price : 0
    const volume = typeof row.volume === 'number' ? row.volume : 0
    const timestamp = typeof row.timestamp === 'number' ? row.timestamp * 1000 : Date.now()

    return {
      symbol: sym,
      price,
      volume,
      timestamp,
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    // 周期闸门必须在分支判定之前：`toFmpInterval` 只在日内分支被调用，表外周期
    // （如 1w/1M）会因 isIntraday=false 绕过它、静默落到日线端点。
    assertSupportedInterval(interval)
    const sym = normalizeUsSymbol(symbol)
    const isIntraday = ['1m', '5m', '15m', '30m', '1h', '4h'].includes(interval)
    const stepMs = parseIntervalMs(interval)

    if (isIntraday) {
      const fmpInt = toFmpInterval(interval)
      const data = await this.requestJson<Array<{ date: string; open: number; low: number; high: number; close: number; volume: number }>>(
        `/historical-chart/${fmpInt}/${sym}`,
      )
      if (!Array.isArray(data)) return []
      const rows = data.slice(0, limit).reverse()
      return rows.map((r) => {
        const openTime = new Date(r.date).getTime()
        return {
          openTime,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume,
          closeTime: openTime + stepMs - 1,
        }
      })
    }

    const data = await this.requestJson<{ historical?: Array<{ date: string; open: number; low: number; high: number; close: number; volume: number }> }>(
      `/historical-price-full/${sym}?timeseries=${limit}`,
    )
    if (!data.historical || !Array.isArray(data.historical)) return []
    const rows = [...data.historical].reverse().slice(-limit)
    return rows.map((r) => {
      const openTime = new Date(r.date).getTime()
      return {
        openTime,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        closeTime: openTime + stepMs - 1,
      }
    })
  }

  async getProfile(symbol: string): Promise<Record<string, unknown>> {
    const sym = normalizeUsSymbol(symbol)
    const data = await this.requestJson<Array<Record<string, unknown>>>(`/profile/${sym}`)
    return Array.isArray(data) && data.length > 0 ? data[0] : {}
  }

  async listInstruments(query?: string): Promise<Array<{ symbol: string; name: string }>> {
    if (!query) return []
    const data = await this.requestJson<Array<{ symbol: string; name: string }>>(`/search?query=${encodeURIComponent(query)}&limit=10`)
    if (!Array.isArray(data)) return []
    return data.map((d) => ({ symbol: d.symbol, name: d.name }))
  }

  async getBalance(): Promise<AccountBalance> {
    return { currency: 'USD', available: 100000, total: 100000 }
  }

  async placeOrder(_creds: unknown, req: OrderRequest): Promise<Order> {
    return {
      id: `sim-fmp-${Date.now()}`,
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      status: 'filled',
      quantity: req.quantity,
      price: req.price ?? 0,
      dryRun: true,
      timestamp: Date.now(),
    }
  }

  async cancelOrder(_creds: unknown, orderId: string): Promise<{ orderId: string; status: 'canceled' }> {
    return { orderId, status: 'canceled' }
  }
}

export type { AccountBalance, Interval, Kline, Order, Position, Ticker }

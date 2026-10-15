/**
 * @dshtrading/connector-ccxt/rest
 * CCXT 跨所加密通用 REST 客户端。
 */

import {
  instrumentFormOf,
  type Interval,
  type Kline,
  type Order,
  type OrderRequest,
  type Position,
  type Ticker,
  type TradingErrorCode,
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

/**
 * 登记的所名 = 本包真有直连分支的所名（ticker 面三条）。
 *
 * 此前这里登记 9 个所名、却只有 bybit/okx 两个具名分支，其余 6 个静默落 Binance 兜底 URL
 * （选 kraken 拿到 Binance 的报价）。现在未登记所名在**任何 fetch 之前**结构化拒绝
 * （见 notImplementedError）；真要加所是另一张卡的事（补分支，而不是放宽登记）。
 */
export const SUPPORTED_EXCHANGES = ['binance', 'okx', 'bybit'] as const

/** K 线面的实现分支只有一条（Binance）：单独一份登记，免得被 ticker 的三所误读。 */
export const KLINE_EXCHANGES = ['binance'] as const

/** 数据面方法名（拒绝文案按面区分）。 */
type DataSurface = 'ticker' | 'klines'

const IMPLEMENTED_EXCHANGES: Record<DataSurface, readonly string[]> = {
  ticker: SUPPORTED_EXCHANGES,
  klines: KLINE_EXCHANGES,
}

const UNIMPLEMENTED_HINT: Record<DataSurface, string> = {
  ticker: 'ticker has three implemented direct branches (binance/okx/bybit): use one of them, or the dedicated per-exchange packages @dshtrading/connector-okx / @dshtrading/connector-bybit.',
  klines: 'klines have a single implemented branch (binance): use exchange=binance.',
}

/** 未实现所名的统一拒绝构造：两处调用点共用，禁止各自复制文案。 */
function notImplementedError(surface: DataSurface, exchange: string): TradingServiceError {
  return new TradingServiceError(
    'TRADING_NOT_IMPLEMENTED',
    `CCXT connector has no ${surface} branch for exchange "${exchange}" (implemented: ${IMPLEMENTED_EXCHANGES[surface].join(', ')}); `
      + `zero network requests were made. ${UNIMPLEMENTED_HINT[surface]}`,
  )
}

/**
 * 现货符号归一化（本轮 CCXT 面只做现货）。
 *
 * 入参带规范永续后缀 `-SWAP` 时**显式报 TRADING_UNSUPPORTED_SYMBOL**：此前实现会先剥掉
 * 后缀、再拿同一个符号去打现货端点，等于把永续静默报成现货价（P3 硬不变量：任何路径
 * 不得把 `-SWAP` 落到 spot 端点）。CCXT 的合约面不属本轮范围，要做得走单独的卡。
 */
export function normalizeSymbol(raw: string): string {
  const upper = raw.trim().toUpperCase()
  if (instrumentFormOf(upper) === 'perp') {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_SYMBOL',
      `CCXT connector is spot-only: ${upper} is a perpetual (form=perp). Use a spot symbol such as ${upper.replace(/-SWAP$/, '')}, or a perpetual-capable connector (okx/bybit) for contract quotes.`,
    )
  }
  const clean = upper.replace(/[-_]/g, '')
  if (clean.includes('/')) return clean.replace('/', '')
  return clean
}

export interface CcxtRestOptions {
  exchange?: string
  apiKey?: string
  secret?: string
  fetchImpl?: typeof fetch
}

export class CcxtRestClient {
  readonly exchange: string
  private readonly apiKey?: string
  private readonly secret?: string
  private readonly fetchImpl: typeof fetch

  constructor(options: CcxtRestOptions = {}) {
    this.exchange = options.exchange ?? 'binance'
    this.apiKey = options.apiKey
    this.secret = options.secret
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(url: string): Promise<T> {
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'Accept': 'application/json' },
      })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `CCXT HTTP ${res.status}: ${res.statusText}`)
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `CCXT network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string, exchange: string = this.exchange): Promise<Ticker> {
    const sym = normalizeSymbol(symbol)
    // 登记面 = 实现面：未登记所名在任何 fetch 之前结构化拒绝（此前静默落 Binance 兜底）。
    if (!(SUPPORTED_EXCHANGES as readonly string[]).includes(exchange)) throw notImplementedError('ticker', exchange)
    if (exchange === 'bybit') {
      const url = `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${sym}`
      const res = await this.requestJson<{ result?: { list?: Array<{ symbol: string; lastPrice: string; volume24h: string }> } }>(url)
      const row = res.result?.list?.[0]
      if (!row) throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `CCXT/Bybit ticker not found: ${symbol}`)
      return {
        symbol: sym,
        price: parseFloat(row.lastPrice),
        volume: parseFloat(row.volume24h),
        timestamp: Date.now(),
      }
    }

    if (exchange === 'okx') {
      const url = `https://www.okx.com/api/v5/market/ticker?instId=${symbol.includes('-') ? symbol : `${sym.replace('USDT', '')}-USDT`}`
      const res = await this.requestJson<{ data?: Array<{ instId: string; last: string; vol24h: string; ts: string }> }>(url)
      const row = res.data?.[0]
      if (!row) throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `CCXT/OKX ticker not found: ${symbol}`)
      return {
        symbol: sym,
        price: parseFloat(row.last),
        volume: parseFloat(row.vol24h),
        timestamp: parseInt(row.ts, 10),
      }
    }

    // 入口守卫（SUPPORTED_EXCHANGES）已收窄到这里：能走到此处的只可能是 binance，
    // 不存在「未实现所名静默落 Binance」的兜底分支。
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}`
    const data = await this.requestJson<{ symbol: string; lastPrice: string; volume: string; closeTime: number }>(url)
    return {
      symbol: sym,
      price: parseFloat(data.lastPrice),
      volume: parseFloat(data.volume),
      timestamp: data.closeTime,
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100, exchange: string = this.exchange): Promise<Kline[]> {
    const sym = normalizeSymbol(symbol)
    // K 线只有 Binance 一条分支：非 binance 所名在 fetch 之前拒绝，
    // 不再「形态上接收 exchange、实现上忽略它恒打 Binance」
    if (!(KLINE_EXCHANGES as readonly string[]).includes(exchange)) throw notImplementedError('klines', exchange)
    const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${limit}`
    const data = await this.requestJson<Array<[number, string, string, string, string, string, number]>>(url)
    if (!Array.isArray(data)) return []
    return data.map((r) => ({
      openTime: r[0],
      open: parseFloat(r[1]),
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[5]),
      closeTime: r[6],
    }))
  }

  async placeOrder(_creds: unknown, req: OrderRequest): Promise<Order> {
    const sym = normalizeSymbol(req.symbol)
    return {
      id: `sim-ccxt-${Date.now()}`,
      symbol: sym,
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

export type { Interval, Kline, Order, Position, Ticker }

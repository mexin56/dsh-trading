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

/**
 * 本包错误码词汇 = api 的 `TradingErrorCode` + 本包实际会抛、但 api 联合尚未收录的码。
 *
 * `TRADING_SYMBOL_NOT_FOUND` 已被多个连接器实际使用（bybit/akshare/eastmoney/finnhub/…），
 * 却漏在 api 的联合里（与 `TRADING_UPSTREAM_ERROR` 曾经的缺口同形）。在这里显式登记一次，
 * 每一处行级判空就能用同一个码，不必逐处 cast、也不必往包内 tsc 债里逐处加一条错误。
 */
export type CcxtErrorCode = TradingErrorCode | 'TRADING_SYMBOL_NOT_FOUND'

export class TradingServiceError extends Error {
  readonly code: CcxtErrorCode

  constructor(code: CcxtErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'TradingServiceError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

export const INTERVAL_VOCABULARY = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'] as const

/**
 * 登记的所名 = 本包真有 ticker 直连分支的所名（九条）。
 *
 * 此前这里登记 9 个所名、却只有 bybit/okx 两个具名分支，其余 6 个静默落 Binance 兜底 URL
 * （选 kraken 拿到 Binance 的报价）。上一轮把登记面收窄到 3 所；本轮六条分支补齐，
 * 登记面重新等于实现面。未登记所名仍在**任何 fetch 之前**结构化拒绝（见 notImplementedError）。
 */
export const SUPPORTED_EXCHANGES = ['binance', 'okx', 'bybit', 'gateio', 'kucoin', 'kraken', 'coinbase', 'bitfinex', 'htx'] as const

/**
 * K 线面的实现分支只有一条（Binance）：单独一份登记。
 *
 * 形参面的 `exchange` 已撤掉（getKlines 不再接收），本表只剩一个用途：客户端默认所名
 * （`new CcxtRestClient({ exchange })`）落在表外时在 fetch 之前结构化拒绝。
 */
export const KLINE_EXCHANGES = ['binance'] as const

/** 数据面方法名（拒绝文案按面区分）。 */
type DataSurface = 'ticker' | 'klines'

const IMPLEMENTED_EXCHANGES: Record<DataSurface, readonly string[]> = {
  ticker: SUPPORTED_EXCHANGES,
  klines: KLINE_EXCHANGES,
}

const UNIMPLEMENTED_HINT: Record<DataSurface, string> = {
  ticker: 'ticker has nine implemented direct branches (binance/okx/bybit/gateio/kucoin/kraken/coinbase/bitfinex/htx): use one of them, or the dedicated per-exchange packages @dshtrading/connector-binance / @dshtrading/connector-okx / @dshtrading/connector-bybit.',
  klines: 'klines have a single implemented branch (binance): set the connector defaultExchange to binance, or use @dshtrading/connector-binance.',
}

/** 未实现所名的统一拒绝构造：两处调用点共用，禁止各自复制文案。 */
function notImplementedError(surface: DataSurface, exchange: string): TradingServiceError {
  return new TradingServiceError(
    'TRADING_NOT_IMPLEMENTED',
    `CCXT connector has no ${surface} branch for exchange "${exchange}" (implemented: ${IMPLEMENTED_EXCHANGES[surface].join(', ')}); `
      + `zero network requests were made. ${UNIMPLEMENTED_HINT[surface]}`,
  )
}

/** 行级判空的统一拒绝：上游答了、但没有这个标的的行（≠ 网络故障、≠ 上游故障）。 */
function symbolNotFoundError(exchange: string, symbol: string): TradingServiceError {
  return new TradingServiceError(
    'TRADING_SYMBOL_NOT_FOUND',
    `CCXT/${exchange} ticker not found: ${symbol} (the venue answered, but without a usable row for this pair)`,
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

/** quote 后缀表：`splitPair` 按**最长优先**匹配它（USDT/USDC 必须先于 USD 尝试）。 */
export const QUOTE_SUFFIXES = ['USDT', 'USDC', 'USD', 'EUR', 'TRY', 'BRL', 'BTC', 'ETH'] as const

/**
 * 裸符号 → `{ base, quote }`，按 `QUOTE_SUFFIXES` 最长优先匹配。
 *
 * 只服务需要形态变换的七条分支（`requestSymbol`）；binance/bybit 把裸符号原样发上游，
 * 不经过这里——上游存在 `ETHBNB`/`BTCFDUSD` 这类不在 quote 表里的计价对。
 * base 为空（如 `USDT`）或后缀不在表内（如 `BTCJPY`）→ TRADING_UNSUPPORTED_SYMBOL，
 * 文案点名该输入与支持的 quote 表：猜一个 quote 会变成给上游发错符号。
 */
export function splitPair(symbol: string): { base: string; quote: string } {
  const clean = symbol.trim().toUpperCase()
  const quotes = [...QUOTE_SUFFIXES].sort((a, b) => b.length - a.length)
  for (const quote of quotes) {
    if (clean.length > quote.length && clean.endsWith(quote)) {
      return { base: clean.slice(0, clean.length - quote.length), quote }
    }
  }
  throw new TradingServiceError(
    'TRADING_UNSUPPORTED_SYMBOL',
    `CCXT connector cannot split "${symbol}" into base+quote: supported quote suffixes are ${QUOTE_SUFFIXES.join(', ')} (longest match first, base must be non-empty).`,
  )
}

/**
 * 需要请求符号**形态变换**的七条分支。
 *
 * binance / bybit 不在此列：它们把 `normalizeSymbol` 的裸符号原样发上游，**永不调用
 * `requestSymbol`/`splitPair`**——上游确实存在 `ETHBNB`/`BTCFDUSD` 这类不在 quote 表里的
 * 计价对，本地替上游裁决会变成功能回归（上游的错误语义留给上游）。
 */
type TransformExchange = 'okx' | 'kucoin' | 'gateio' | 'kraken' | 'coinbase' | 'bitfinex' | 'htx'

/**
 * 各所现货端点的请求符号形态（入参 = `normalizeSymbol` 的裸符号，如 BTCUSDT）。
 *
 * okx/kucoin/coinbase 用 `-`、gateio 用 `_`、kraken 把 BTC 记作 XBT、bitfinex 加 `t`
 * 前缀且 USDT 记作 UST、htx 全小写。
 */
function requestSymbol(exchange: TransformExchange, sym: string): string {
  const { base, quote } = splitPair(sym)
  switch (exchange) {
    case 'okx':
    case 'kucoin':
    case 'coinbase':
      return `${base}-${quote}`
    case 'gateio':
      return `${base}_${quote}`
    case 'kraken':
      return `${base === 'BTC' ? 'XBT' : base}${quote}`
    case 'bitfinex':
      return `t${base}${quote === 'USDT' ? 'UST' : quote}`
    case 'htx':
      return `${base}${quote}`.toLowerCase()
  }
}

/**
 * 上游字段读成数值：缺失、空串或非有限数一律 undefined（判空统一走 symbolNotFoundError）。
 * 各所报价字段有的是字符串（gateio/kucoin/coinbase/bithumb 系）有的是数字（bitfinex/htx 系）。
 */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 400 + JSON 正文里 `label` 以 `INVALID_` 开头 = 上游明确说「这个符号/币种不存在」，
 * 不是基础设施故障（gateio 实测 `{"label":"INVALID_CURRENCY_PAIR"}` / `INVALID_CURRENCY`）。
 * 正文不是 JSON 时一律返回 false（bybit 的 403 正文就是非 JSON 的拦截片段）。
 */
function invalidSymbolLabel(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { label?: unknown } | null
    return typeof parsed?.label === 'string' && parsed.label.startsWith('INVALID_')
  } catch {
    return false
  }
}

/** 上游正文的取证片段：压成单行、截断约 200 字符（进 message，不进日志正文）。 */
function bodySnippet(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 200)
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
        // 非 2xx 的正文**必须容忍非 JSON**（实测 bybit 的 403 正文是 CloudFront 的地域拦截
        // 片段，不是合法 JSON）：先 text() 再压成单行片段，判定与取证共用同一份原文。
        const body = await res.text().catch(() => '')
        const snippet = bodySnippet(body)
        // 404 与「400 + label=INVALID_*」都是「上游没有这个标的/资源」，不是上游故障：
        // 映射到 SYMBOL_NOT_FOUND，免得消费方把一个不存在的符号当基础设施抖动去重试。
        if (res.status === 404) {
          throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `CCXT HTTP 404 ${res.statusText}: ${snippet} (${url})`)
        }
        if (res.status === 400 && invalidSymbolLabel(body)) {
          throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `CCXT HTTP 400 ${res.statusText}: ${snippet}`)
        }
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `CCXT HTTP ${res.status} ${res.statusText}: ${snippet}`)
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
    // 形态变换只发生在七条分支里（见 requestSymbol 的类型约束）：binance/bybit 用裸符号直发。

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
      // 请求符号改用共享 splitPair（此前是 `symbol.includes('-') ? symbol : sym.replace('USDT','')`
      // 的启发式：非 USDT 计价对会被拼成错符号）。
      const pair = requestSymbol('okx', sym)
      const url = `https://www.okx.com/api/v5/market/ticker?instId=${pair}`
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

    // 以下六条为本轮补的直连分支：各自只打自己的主机，volume 一律取**基础币 24h 量**
    // （与 binance/bybit/okx 同口径）。时间戳口径：上游有服务器时间就用它（binance closeTime /
    // okx ts / kucoin data.time / htx ts），没有就用本地观测时刻（bybit/gateio/kraken/bitfinex/
    // coinbase）——Ticker.timestamp 是数值契约，NaN/undefined 会污染消费方的时间新鲜度判断。
    if (exchange === 'gateio') {
      const pair = requestSymbol('gateio', sym)
      const url = `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${pair}`
      const res = await this.requestJson<Array<{ last?: unknown; base_volume?: unknown }>>(url)
      const row = Array.isArray(res) ? res[0] : undefined
      const price = toNumber(row?.last)
      const volume = toNumber(row?.base_volume)
      if (price === undefined || volume === undefined) throw symbolNotFoundError('gateio', symbol)
      return { symbol: sym, price, volume, timestamp: Date.now() }
    }

    if (exchange === 'kucoin') {
      const pair = requestSymbol('kucoin', sym)
      const url = `https://api.kucoin.com/api/v1/market/stats?symbol=${pair}`
      const res = await this.requestJson<{ code?: string; data?: { last?: unknown; vol?: unknown; time?: unknown } }>(url)
      const price = toNumber(res.data?.last)
      const volume = toNumber(res.data?.vol)
      if (res.code !== '200000' || price === undefined || volume === undefined) throw symbolNotFoundError('kucoin', symbol)
      return {
        symbol: sym,
        price,
        volume,
        timestamp: typeof res.data?.time === 'number' && Number.isFinite(res.data.time) ? res.data.time : Date.now(),
      }
    }

    if (exchange === 'kraken') {
      const pair = requestSymbol('kraken', sym)
      const url = `https://api.kraken.com/0/public/Ticker?pair=${pair}`
      const res = await this.requestJson<{ error?: unknown[]; result?: Record<string, { c?: unknown[]; v?: unknown[] }> }>(url)
      // 唯一键：Kraken 用自己那套规范键（BTC→XBT），不保证等于我们发出的 pair。
      const key = Object.keys(res.result ?? {})[0]
      const row = key === undefined ? undefined : res.result?.[key]
      const price = toNumber(row?.c?.[0])
      const volume = toNumber(row?.v?.[1]) // v = [24h 量, 24h 加权量]，[1] 才是 24h 基础币量
      if ((res.error?.length ?? 0) > 0 || price === undefined || volume === undefined) throw symbolNotFoundError('kraken', symbol)
      return { symbol: sym, price, volume, timestamp: Date.now() }
    }

    if (exchange === 'coinbase') {
      const pair = requestSymbol('coinbase', sym)
      const url = `https://api.exchange.coinbase.com/products/${pair}/ticker`
      const res = await this.requestJson<{ price?: unknown; volume?: unknown; time?: string }>(url)
      const price = toNumber(res.price)
      const volume = toNumber(res.volume)
      if (price === undefined || volume === undefined) throw symbolNotFoundError('coinbase', symbol)
      // 不用响应里的 `time`：它是**最后成交时间**不是服务器时间（实测薄标的 tsAge≈449s），
      // 拿它当观测时刻会让消费方把当前有效报价读成陈旧——这里取本地观测时刻。
      return { symbol: sym, price, volume, timestamp: Date.now() }
    }

    if (exchange === 'bitfinex') {
      const pair = requestSymbol('bitfinex', sym)
      const url = `https://api-pub.bitfinex.com/v2/ticker/${pair}`
      const res = await this.requestJson<unknown>(url)
      // 响应恰为 11 个元素（下标 0..10）。
      if (!Array.isArray(res) || res.length === 0) throw symbolNotFoundError('bitfinex', symbol)
      const price = toNumber(res[6])
      const volume = toNumber(res[7])
      if (price === undefined || volume === undefined) throw symbolNotFoundError('bitfinex', symbol)
      // 下标 10 是**上游字段不可用**，不是我们没解析：实测 BTC 1552298737974 / ETH 1552298634552
      // （均为 2019-03-11，比抓取时刻早 7.6 年，两对都坏），禁止当 timestamp 用——这里取本地时间，
      // 与 gateio/kraken 同口径。
      return { symbol: sym, price, volume, timestamp: Date.now() }
    }

    if (exchange === 'htx') {
      const pair = requestSymbol('htx', sym)
      const url = `https://api.htx.com/market/detail/merged?symbol=${pair}`
      const res = await this.requestJson<{ status?: string; ts?: unknown; tick?: { close?: unknown; amount?: unknown } }>(url)
      const price = toNumber(res.tick?.close)
      // amount = 基础币量，vol = 计价币量：取 amount。
      const volume = toNumber(res.tick?.amount)
      if (res.status !== 'ok' || price === undefined || volume === undefined) throw symbolNotFoundError('htx', symbol)
      return {
        symbol: sym,
        price,
        volume,
        timestamp: typeof res.ts === 'number' && Number.isFinite(res.ts) ? res.ts : Date.now(),
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

  /**
   * K 线只有 Binance 一条分支（形参 `exchange` 已撤掉）：裁决对象是**客户端默认所名**
   * `this.exchange`，非 binance 在 fetch 之前结构化拒绝，不再「形态上接收 exchange、
   * 实现上忽略它恒打 Binance」。
   */
  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const sym = normalizeSymbol(symbol)
    if (!(KLINE_EXCHANGES as readonly string[]).includes(this.exchange)) throw notImplementedError('klines', this.exchange)
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

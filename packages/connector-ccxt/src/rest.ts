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
 * 登记的所名 = 本包真有 ticker 直连分支的所名（九条）。
 *
 * 此前这里登记 9 个所名、却只有 bybit/okx 两个具名分支，其余 6 个静默落 Binance 兜底 URL
 * （选 kraken 拿到 Binance 的报价）。上一轮把登记面收窄到 3 所；本轮六条分支补齐，
 * 登记面重新等于实现面。未登记所名仍在**任何 fetch 之前**结构化拒绝（见 notImplementedError）。
 */
export const SUPPORTED_EXCHANGES = ['binance', 'okx', 'bybit', 'gateio', 'kucoin', 'kraken', 'coinbase', 'bitfinex', 'htx'] as const

/**
 * K 线登记面（2026-10-15 起九条直连分支）。
 *
 * 上一轮曾把 K 线面撤成单分支（binance）并把「按所取 K 线」记为另一张卡；本卡就是那张卡：
 * 九所各有自己的 K 线端点、周期词汇与行结构，周期映射表见 KLINE_INTERVAL_PARAMS。
 * 未登记所名（如 bitstamp）仍在**任何 fetch 之前**结构化拒绝（零请求）。
 */
export const KLINE_EXCHANGES = ['binance', 'okx', 'bybit', 'gateio', 'kucoin', 'kraken', 'coinbase', 'bitfinex', 'htx'] as const

export type KlineExchange = (typeof KLINE_EXCHANGES)[number]

/** 数据面方法名（拒绝文案按面区分）。 */
type DataSurface = 'ticker' | 'klines'

const IMPLEMENTED_EXCHANGES: Record<DataSurface, readonly string[]> = {
  ticker: SUPPORTED_EXCHANGES,
  klines: KLINE_EXCHANGES,
}

const UNIMPLEMENTED_HINT: Record<DataSurface, string> = {
  ticker: 'ticker has nine implemented direct branches (binance/okx/bybit/gateio/kucoin/kraken/coinbase/bitfinex/htx): use one of them, or the dedicated per-exchange packages @dshtrading/connector-binance / @dshtrading/connector-okx / @dshtrading/connector-bybit.',
  klines: 'klines have nine implemented direct branches (binance/okx/bybit/gateio/kucoin/kraken/coinbase/bitfinex/htx): use one of them, or the dedicated per-exchange packages @dshtrading/connector-binance / @dshtrading/connector-okx / @dshtrading/connector-bybit.',
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
 * 行级判空的统一拒绝：上游答了、但没有这个标的的行（≠ 网络故障、≠ 上游故障）。
 *
 * 上游明确报「查不到」的三种形态都归到这里：ticker 的空行、K 线的错误信封，
 * 以及 requestJson 里的 HTTP 404 / 400 + `label=INVALID_*`。
 */
function symbolNotFoundError(surface: DataSurface, exchange: string, symbol: string): TradingServiceError {
  return new TradingServiceError(
    'TRADING_SYMBOL_NOT_FOUND',
    `CCXT/${exchange} ${surface} not found: ${symbol} (the venue answered, but without a usable row for this pair)`,
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

/**
 * 各所 quote 资产表（**按所维护**，2026-10-15 起）。
 *
 * 数据来源 = 该所公开挂牌端点的逐所普查（原始响应 `census-*.json` 与派生命题见
 * `spikes/impl-ccxt-exchange-expansion/EVIDENCE-2026-10-15-quote-census-and-klines.md`）：
 * - okx `GET /api/v5/public/instruments?instType=SPOT` → `quoteCcy`（剔除空串）
 * - kucoin `GET /api/v2/symbols` → `quoteCurrency`
 * - gateio `GET /api/v4/spot/currency_pairs` → `quote`
 * - kraken `GET /0/public/AssetPairs` → `wsname` 的 quote 段（kraken 的 `quote` 字段是
 *   Z/X 前缀的旧代号 ZEUR/XXBT，而请求符号用现代形 EUR/XBT）
 * - coinbase `GET /products` → `quote_currency`
 * - bitfinex `GET /v2/conf/pub:list:pair:exchange` + `.../pub:list:currency` → 最长货币后缀
 *   （`UST` 归一成用户写法的 `USDT`；`:` 分隔的挂牌对按分隔符切开）
 * - htx `GET /v2/settings/common/symbols` → `qcdn`（大写展示形）
 *
 * 表只登记上游确实挂牌的 quote：表外计价对在七条变换分支上仍是本地
 * `TRADING_UNSUPPORTED_SYMBOL` 且零请求——「猜一个 quote」等于给上游发错符号，比本地拒绝更糟。
 * 每条表都由 `spikes/impl-ccxt-exchange-expansion/run-probe.ts` 按同一条普查规则现场复核
 * （表 = 普查结果），上游新增 quote 而表未跟进即探针失败。
 */
export const QUOTE_TABLES: Readonly<Record<TransformExchange, readonly string[]>> = {
  okx: ['AED', 'AUD', 'BRL', 'BTC', 'ETH', 'EUR', 'PLN', 'SGD', 'SOL', 'TRY', 'USD', 'USDC', 'USDT'],
  kucoin: ['BTC', 'DOGE', 'ETH', 'EUR', 'KCS', 'TRX', 'USD1', 'USDC', 'USDG', 'USDT'],
  gateio: ['BTC', 'ETH', 'GUSD', 'RLUSD', 'USD', 'USD1', 'USDC', 'USDT'],
  kraken: ['AUD', 'AUSD', 'CAD', 'CHF', 'DAI', 'ETH', 'EUR', 'EURC', 'EUROP', 'FIDD', 'GBP', 'JPY', 'PYUSD', 'RLUSD', 'SOFID', 'SOL', 'USD', 'USD1', 'USDC', 'USDD', 'USDQ', 'USDR', 'USDT', 'XBT'],
  coinbase: ['AUD', 'BRL', 'BTC', 'CAD', 'DAI', 'ETH', 'EUR', 'GBP', 'INR', 'SGD', 'USD', 'USDC', 'USDT'],
  bitfinex: ['BTC', 'ETH', 'EUR', 'GBP', 'TESTUSD', 'TESTUSDT', 'USD', 'USDT', 'XAUT'],
  htx: ['BRL', 'BTC', 'ETH', 'EUR', 'EUROC', 'GBP', 'HT', 'HUSD', 'KGST', 'PYUSD', 'RUB', 'TRX', 'TRY', 'TUSD', 'UAH', 'USD1', 'USDC', 'USDD', 'USDT', 'USTC'],
}

/**
 * 裸符号 → `{ base, quote }`，按**该所**的 quote 表最长优先匹配。
 *
 * 只服务需要形态变换的七条分支（`requestSymbol`）；binance/bybit 把裸符号原样发上游，
 * 不经过这里——上游存在 `ETHBNB`/`BTCFDUSD` 这类不在任何 quote 表里的计价对。
 * base 为空（如 `USDT`）或后缀不在该所表内（如 gateio 的 `BTCJPY`、kraken 的 `BTCBRL`）
 * → TRADING_UNSUPPORTED_SYMBOL，文案点名该所与该所的 quote 表：猜一个 quote 会变成给上游发错符号。
 */
export function splitPair(symbol: string, exchange: TransformExchange): { base: string; quote: string } {
  const clean = symbol.trim().toUpperCase()
  const table = QUOTE_TABLES[exchange]
  const quotes = [...table].sort((a, b) => b.length - a.length)
  for (const quote of quotes) {
    if (clean.length > quote.length && clean.endsWith(quote)) {
      return { base: clean.slice(0, clean.length - quote.length), quote }
    }
  }
  throw new TradingServiceError(
    'TRADING_UNSUPPORTED_SYMBOL',
    `CCXT connector cannot split "${symbol}" into base+quote for ${exchange}: ${exchange} quotes are ${[...table].sort().join(', ')} (longest match first, base must be non-empty).`,
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
 * 前缀且 USDT 记作 UST、htx 全小写。导出让离线用例与探针能直接断言拼出来的符号形态
 * （不必为了看一个 URL 去打网络）。
 */
export function requestSymbol(exchange: TransformExchange, sym: string): string {
  const { base, quote } = splitPair(sym, exchange)
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

/* ── K 线周期映射与行归一（2026-10-15 起九所）──────────────────────────────── */

/**
 * api `Interval` → 各所 K 线周期参数（缺键 = 该所不支持，抛 TRADING_UNSUPPORTED_INTERVAL 且零请求）。
 *
 * 逐所实测口径（原始响应见 `spikes/impl-ccxt-exchange-expansion/klines-*.json` 与同目录 EVIDENCE）：
 * - binance 原文直发；bybit `1/5/15/30/60/240/D/W/M`
 * - okx bar 取 **utc 变体**（`1Dutc`/`1Wutc`/`1Mutc`）：与 connector-okx 同一裁决，
 *   日界对齐 UTC（Binance 口径）；okx 的 `1D` 是 UTC+8 零点，跨连接器会错位 8 小时
 * - gateio 无 1M（实测 400 `invalid interval 1M`）；1w 用上游的 `7d`
 * - kucoin 无 1M（实测 400 `Incorrect candlestick type`）
 * - kraken 周期是**分钟数**（1w=10080、1M=21600）
 * - coinbase granularity 是**秒**，且实测只接受 60/300/900/3600/21600/86400：30m→1800 与
 *   4h→14400 都回 400 `Unsupported granularity`（1w/1M 同），故本词汇表内只支持 1m/5m/15m/1h/1d
 * - bitfinex `1m..1h` 小写、日线及以上大写（`1D`/`1W`/`1M`）；4h 实测上游接受
 * - htx `1min/5min/…/60min/4hour/1day/1mon/1week`
 */
const KLINE_INTERVAL_PARAMS: Readonly<Record<KlineExchange, Readonly<Partial<Record<Interval, string>>>>> = {
  binance: { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w', '1M': '1M' },
  okx: { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '1d': '1Dutc', '1w': '1Wutc', '1M': '1Mutc' },
  bybit: { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D', '1w': 'W', '1M': 'M' },
  gateio: { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '7d' },
  kucoin: { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1hour', '4h': '4hour', '1d': '1day', '1w': '1week' },
  kraken: { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': '1440', '1w': '10080', '1M': '21600' },
  coinbase: { '1m': '60', '5m': '300', '15m': '900', '1h': '3600', '1d': '86400' },
  bitfinex: { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1D', '1w': '1W', '1M': '1M' },
  htx: { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '60min', '4h': '4hour', '1d': '1day', '1w': '1week', '1M': '1mon' },
}

/** 周期毫秒时长（closeTime 补算用；1M 以 30 天近似，与 connector-okx 同口径）。 */
const INTERVAL_MS: Readonly<Record<Interval, number>> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '3d': 259_200_000,
  '1w': 604_800_000,
  '1M': 2_592_000_000,
}

/** 某所支持的周期（映射表键集；供离线用例与探针断言，不在运行时按上游探测）。 */
export function klineSupportedIntervals(exchange: KlineExchange): readonly Interval[] {
  return Object.keys(KLINE_INTERVAL_PARAMS[exchange]) as Interval[]
}

/**
 * `Interval` → 该所周期参数；该所不支持（coinbase 的 30m/4h/1w/1M、gateio/kucoin 的 1M、
 * 以及任何词汇表外取值）→ TRADING_UNSUPPORTED_INTERVAL，**在 fetch 之前**（零请求）。
 */
export function klineIntervalParam(exchange: KlineExchange, interval: Interval): string {
  const param = KLINE_INTERVAL_PARAMS[exchange][interval]
  if (param === undefined) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_INTERVAL',
      `CCXT/${exchange} klines: unsupported interval ${String(interval)} — ${exchange} supports ${klineSupportedIntervals(exchange).join('/')}; no network request was made.`,
    )
  }
  return param
}

/** 单根 K 线的形状判空：任一分量非有限数即整根丢弃（丢行，不猜值）。 */
function klineRow(
  openTime: number,
  open: unknown,
  high: unknown,
  low: unknown,
  close: unknown,
  volume: unknown,
  closeTime: number,
): Kline | undefined {
  const o = toNumber(open)
  const h = toNumber(high)
  const l = toNumber(low)
  const c = toNumber(close)
  const v = toNumber(volume)
  if (!Number.isFinite(openTime) || !Number.isFinite(closeTime)) return undefined
  if (o === undefined || h === undefined || l === undefined || c === undefined || v === undefined) return undefined
  return { openTime, open: o, high: h, low: l, close: c, volume: v, closeTime }
}

/**
 * 行集归一：按 openTime 去重、**升序（旧→新）**排序、只保留最新 limit 根。
 *
 * 九所里只有 binance 与 kraken 的上游序列本来就是升序；okx/kucoin/gateio/coinbase/bitfinex/htx/bybit
 * 都是新→旧。统一在这里归一，消费方拿到的序列与 connector-binance 同向。
 */
function finalizeKlines(rows: Array<Kline | undefined>, limit: number): Kline[] {
  const byOpenTime = new Map<number, Kline>()
  for (const row of rows) {
    if (row === undefined) continue
    byOpenTime.set(row.openTime, row)
  }
  const sorted = [...byOpenTime.values()].sort((a, b) => a.openTime - b.openTime)
  return limit > 0 ? sorted.slice(-limit) : sorted
}

/**
 * 各所单请求的根数参数与上限（超出上限只请求上限内的根数，**不翻页**）。
 * kucoin / kraken / coinbase 的上游没有根数参数（kucoin 固定回 1500、kraken 720、coinbase 300），
 * 一律留空并在 finalizeKlines 里切成 limit 根。
 */
const KLINE_LIMIT_PARAMS: Readonly<Record<KlineExchange, { query: string; max: number } | undefined>> = {
  binance: { query: 'limit', max: 1000 },
  okx: { query: 'limit', max: 300 },
  bybit: { query: 'limit', max: 1000 },
  gateio: { query: 'limit', max: 1000 },
  kucoin: undefined,
  kraken: undefined,
  coinbase: undefined,
  bitfinex: { query: 'limit', max: 10_000 },
  htx: { query: 'size', max: 2000 },
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
      if (!row) throw symbolNotFoundError('ticker', 'bybit', symbol)
      return {
        symbol: sym,
        price: parseFloat(row.lastPrice),
        volume: parseFloat(row.volume24h),
        timestamp: Date.now(),
      }
    }

    if (exchange === 'okx') {
      // 请求符号走 okx 的 quote 表（此前是 `symbol.includes('-') ? symbol : sym.replace('USDT','')`
      // 的启发式：非 USDT 计价对会被拼成错符号）。
      const pair = requestSymbol('okx', sym)
      const url = `https://www.okx.com/api/v5/market/ticker?instId=${pair}`
      const res = await this.requestJson<{ data?: Array<{ instId: string; last: string; vol24h: string; ts: string }> }>(url)
      const row = res.data?.[0]
      if (!row) throw symbolNotFoundError('ticker', 'okx', symbol)
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
      if (price === undefined || volume === undefined) throw symbolNotFoundError('ticker', 'gateio', symbol)
      return { symbol: sym, price, volume, timestamp: Date.now() }
    }

    if (exchange === 'kucoin') {
      const pair = requestSymbol('kucoin', sym)
      const url = `https://api.kucoin.com/api/v1/market/stats?symbol=${pair}`
      const res = await this.requestJson<{ code?: string; data?: { last?: unknown; vol?: unknown; time?: unknown } }>(url)
      const price = toNumber(res.data?.last)
      const volume = toNumber(res.data?.vol)
      if (res.code !== '200000' || price === undefined || volume === undefined) throw symbolNotFoundError('ticker', 'kucoin', symbol)
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
      if ((res.error?.length ?? 0) > 0 || price === undefined || volume === undefined) throw symbolNotFoundError('ticker', 'kraken', symbol)
      return { symbol: sym, price, volume, timestamp: Date.now() }
    }

    if (exchange === 'coinbase') {
      const pair = requestSymbol('coinbase', sym)
      const url = `https://api.exchange.coinbase.com/products/${pair}/ticker`
      const res = await this.requestJson<{ price?: unknown; volume?: unknown; time?: string }>(url)
      const price = toNumber(res.price)
      const volume = toNumber(res.volume)
      if (price === undefined || volume === undefined) throw symbolNotFoundError('ticker', 'coinbase', symbol)
      // 不用响应里的 `time`：它是**最后成交时间**不是服务器时间（实测薄标的 tsAge≈449s），
      // 拿它当观测时刻会让消费方把当前有效报价读成陈旧——这里取本地观测时刻。
      return { symbol: sym, price, volume, timestamp: Date.now() }
    }

    if (exchange === 'bitfinex') {
      const pair = requestSymbol('bitfinex', sym)
      const url = `https://api-pub.bitfinex.com/v2/ticker/${pair}`
      const res = await this.requestJson<unknown>(url)
      // 响应恰为 11 个元素（下标 0..10）。
      if (!Array.isArray(res) || res.length === 0) throw symbolNotFoundError('ticker', 'bitfinex', symbol)
      const price = toNumber(res[6])
      const volume = toNumber(res[7])
      if (price === undefined || volume === undefined) throw symbolNotFoundError('ticker', 'bitfinex', symbol)
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
      if (res.status !== 'ok' || price === undefined || volume === undefined) throw symbolNotFoundError('ticker', 'htx', symbol)
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
   * K 线九条直连分支（2026-10-15 起）：周期按所映射（KLINE_INTERVAL_PARAMS）、行结构按所解析，
   * 输出一律**升序（旧→新）且只含最新 limit 根**。
   *
   * `exchange` 是**连接器自有形参**（缺省 = 客户端默认所名）：`@dshtrading/api` 的
   * `MarketDataService.getKlines(symbol, interval, limit?)` 没有这个形参，服务缝保持与契约同形，
   * 形参只在本客户端方法与 `crypto_get_klines` 工具上暴露（见包 README「周期与契约」）。
   * 未登记所名 → TRADING_NOT_IMPLEMENTED、该所不支持的周期 → TRADING_UNSUPPORTED_INTERVAL，
   * 两者都在 fetch 之前（零请求）。
   */
  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100, exchange: string = this.exchange): Promise<Kline[]> {
    const sym = normalizeSymbol(symbol)
    if (!(KLINE_EXCHANGES as readonly string[]).includes(exchange)) throw notImplementedError('klines', exchange)
    const venue = exchange as KlineExchange
    const period = klineIntervalParam(venue, interval)
    const stepMs = INTERVAL_MS[interval]
    const cap = KLINE_LIMIT_PARAMS[venue]
    const cappedLimit = cap === undefined ? undefined : Math.min(Math.max(limit, 1), cap.max)
    // 已有 query 串的端点接 `&`；bitfinex 的 base URL 没有 query 串，必须用 `?`（`&limit=` 会被当成路径）。
    const limitQuery = cap === undefined || cappedLimit === undefined ? '' : `&${cap.query}=${cappedLimit}`
    const limitQueryStart = cap === undefined || cappedLimit === undefined ? '' : `?${cap.query}=${cappedLimit}`

    switch (venue) {
      case 'binance': {
        const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${period}${limitQuery}`
        const data = await this.requestJson<unknown>(url)
        if (!Array.isArray(data)) return []
        return finalizeKlines(data.map((raw): Kline | undefined => {
          if (!Array.isArray(raw)) return undefined
          const [openTime, open, high, low, close, volume, closeTime] = raw as unknown[]
          return klineRow(Number(openTime), open, high, low, close, volume, Number(closeTime))
        }), limit)
      }
      case 'bybit': {
        const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=${period}&limit=${cappedLimit ?? 200}`
        const data = await this.requestJson<{ retCode?: number; result?: { list?: unknown } }>(url)
        if (data.retCode !== 0) throw symbolNotFoundError('klines', 'bybit', symbol)
        const rows = Array.isArray(data.result?.list) ? data.result.list : []
        return finalizeKlines(rows.map((raw): Kline | undefined => {
          if (!Array.isArray(raw)) return undefined
          const [openTime, open, high, low, close, volume] = raw as unknown[]
          const t = Number(openTime)
          return klineRow(t, open, high, low, close, volume, t + stepMs - 1)
        }), limit)
      }
      case 'okx': {
        const pair = requestSymbol('okx', sym)
        const url = `https://www.okx.com/api/v5/market/candles?instId=${pair}&bar=${period}${limitQuery}`
        const data = await this.requestJson<{ code?: string; data?: unknown }>(url)
        if (data.code !== '0') throw symbolNotFoundError('klines', 'okx', symbol)
        const rows = Array.isArray(data.data) ? data.data : []
        return finalizeKlines(rows.map((raw): Kline | undefined => {
          if (!Array.isArray(raw)) return undefined
          const [ts, open, high, low, close, volume] = raw as unknown[]
          const t = Number(ts)
          return klineRow(t, open, high, low, close, volume, t + stepMs - 1)
        }), limit)
      }
      case 'gateio': {
        const pair = requestSymbol('gateio', sym)
        const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${pair}&interval=${period}${limitQuery}`
        const data = await this.requestJson<unknown>(url)
        if (!Array.isArray(data)) return []
        return finalizeKlines(data.map((raw): Kline | undefined => {
          if (!Array.isArray(raw)) return undefined
          // 行结构 [秒级 ts, 计价量, close, high, low, open, 基础量, windowClosed]
          const [ts, , close, high, low, open, baseVolume] = raw as unknown[]
          const t = Number(ts) * 1000
          return klineRow(t, open, high, low, close, baseVolume, t + stepMs - 1)
        }), limit)
      }
      case 'kucoin': {
        const pair = requestSymbol('kucoin', sym)
        const url = `https://api.kucoin.com/api/v1/market/candles?symbol=${pair}&type=${period}`
        const data = await this.requestJson<{ code?: string; data?: unknown }>(url)
        if (data.code !== '200000') throw symbolNotFoundError('klines', 'kucoin', symbol)
        const rows = Array.isArray(data.data) ? data.data : []
        return finalizeKlines(rows.map((raw): Kline | undefined => {
          if (!Array.isArray(raw)) return undefined
          // 行结构 [秒级 ts, open, close, high, low, 基础量, 计价量]
          const [ts, open, close, high, low, volume] = raw as unknown[]
          const t = Number(ts) * 1000
          return klineRow(t, open, high, low, close, volume, t + stepMs - 1)
        }), limit)
      }
      case 'kraken': {
        const pair = requestSymbol('kraken', sym)
        const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${period}`
        const data = await this.requestJson<{ error?: unknown[]; result?: Record<string, unknown> }>(url)
        if ((data.error?.length ?? 0) > 0) throw symbolNotFoundError('klines', 'kraken', symbol)
        // result 里除 <pair> 数组外还有一个 `last` 数字：按形状取数组。
        const rows = Object.values(data.result ?? {}).find((value) => Array.isArray(value))
        if (!Array.isArray(rows)) return []
        return finalizeKlines(rows.map((raw): Kline | undefined => {
          if (!Array.isArray(raw)) return undefined
          // 行结构 [秒级 ts, open, high, low, close, vwap, 基础量, count]
          const [ts, open, high, low, close, , volume] = raw as unknown[]
          const t = Number(ts) * 1000
          return klineRow(t, open, high, low, close, volume, t + stepMs - 1)
        }), limit)
      }
      case 'coinbase': {
        const pair = requestSymbol('coinbase', sym)
        const url = `https://api.exchange.coinbase.com/products/${pair}/candles?granularity=${period}`
        const data = await this.requestJson<unknown>(url)
        if (!Array.isArray(data)) return []
        return finalizeKlines(data.map((raw): Kline | undefined => {
          if (!Array.isArray(raw)) return undefined
          // 行结构 [秒级 ts, low, high, open, close, 基础量]
          const [ts, low, high, open, close, volume] = raw as unknown[]
          const t = Number(ts) * 1000
          return klineRow(t, open, high, low, close, volume, t + stepMs - 1)
        }), limit)
      }
      case 'bitfinex': {
        const pair = requestSymbol('bitfinex', sym)
        const url = `https://api-pub.bitfinex.com/v2/candles/trade:${period}:${pair}/hist${limitQueryStart}`
        const data = await this.requestJson<unknown>(url)
        if (!Array.isArray(data)) return []
        return finalizeKlines(data.map((raw): Kline | undefined => {
          if (!Array.isArray(raw)) return undefined
          // 行结构 [毫秒级 mts, open, close, high, low, 基础量]
          const [mts, open, close, high, low, volume] = raw as unknown[]
          const t = Number(mts)
          return klineRow(t, open, high, low, close, volume, t + stepMs - 1)
        }), limit)
      }
      case 'htx': {
        const pair = requestSymbol('htx', sym)
        const url = `https://api.htx.com/market/history/kline?symbol=${pair}&period=${period}${limitQuery}`
        const data = await this.requestJson<{ status?: string; data?: unknown }>(url)
        if (data.status !== 'ok') throw symbolNotFoundError('klines', 'htx', symbol)
        const rows = Array.isArray(data.data) ? data.data : []
        return finalizeKlines(rows.map((raw): Kline | undefined => {
          const row = raw as { id?: unknown; open?: unknown; close?: unknown; low?: unknown; high?: unknown; amount?: unknown }
          const t = Number(row.id) * 1000
          return klineRow(t, row.open, row.high, row.low, row.close, row.amount, t + stepMs - 1)
        }), limit)
      }
    }
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

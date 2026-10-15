/**
 * @dshtrading/connector-akshare/rest
 * AkShare A 股宏观与量化另类数据 REST 客户端。
 */

import type {
  Interval,
  Kline,
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

/**
 * K 线周期 → 东财 kline/get 的 klt 周期码 + 单根时长。
 *
 * klt 与同打 push2his kline/get 的 connector-eastmoney 同一张表（该包 `mapIntervalToKlt`）；
 * stepMs 是 K 线覆盖时长，用于 closeTime = openTime + stepMs - 1——分钟线不再按日线加满一天，
 * 周/月线也必须长于 2 天，否则 packages/indicators 的 klineTradingDay 会把周 K 当成单日 K。
 */
const KLINES_INTERVAL_SPEC: Readonly<Record<string, { readonly klt: string; readonly stepMs: number }>> = {
  '5m': { klt: '5', stepMs: 5 * 60_000 },
  '15m': { klt: '15', stepMs: 15 * 60_000 },
  '30m': { klt: '30', stepMs: 30 * 60_000 },
  '1h': { klt: '60', stepMs: 60 * 60_000 },
  '1d': { klt: '101', stepMs: 24 * 60 * 60_000 },
  '1w': { klt: '102', stepMs: 7 * 24 * 60 * 60_000 },
  '1M': { klt: '103', stepMs: 30 * 24 * 60 * 60_000 },
}

/** 本包 K 线真实可服务的周期（`INTERVAL_VOCABULARY` 的严格子集：1m 不在其中）。 */
export const SUPPORTED_KLINES_INTERVALS: readonly string[] = Object.keys(KLINES_INTERVAL_SPEC)

/**
 * 周期 → klt 与时长；映射表外的周期在发请求前显式拒绝（`TRADING_UNSUPPORTED_INTERVAL`），
 * 不静默按日线返回。`1m` 也在拒绝之列：kline/get 的 klt=1 只回当日（`lmt` 被上游忽略，
 * connector-eastmoney/src/rest.ts 实测），本包没有 trends2 分时通道，取不到多日 1m 序列。
 */
export function resolveKlinesInterval(interval: Interval): { readonly klt: string; readonly stepMs: number } {
  const spec = KLINES_INTERVAL_SPEC[interval]
  if (spec === undefined) {
    throw new TradingServiceError(
      'TRADING_UNSUPPORTED_INTERVAL',
      `AkShare/Eastmoney klines do not serve interval "${String(interval)}"; supported: ${SUPPORTED_KLINES_INTERVALS.join(', ')}`,
    )
  }
  return spec
}

export function toEastmoneySecid(symbol: string): { secid: string; canonical: string } {
  const clean = symbol.trim().toUpperCase()
  let code = clean
  let market = 'SH'
  if (clean.includes('.')) {
    const parts = clean.split('.')
    code = parts[0]
    market = parts[1]
  } else if (code.startsWith('0') || code.startsWith('3')) {
    market = 'SZ'
  }
  const prefix = market === 'SH' ? '1' : '0'
  return { secid: `${prefix}.${code}`, canonical: `${code}.${market}` }
}

/**
 * ulist.np/get 报价行字段：f1=小数位数 f2=最新价 f3=涨跌幅(%) f5=成交量(手) f12=代码
 * f13=市场 f14=名称 f18=昨收 f124=行情时间(秒)。价格类字段是 ×10^f1 的整数。
 */
const QUOTE_FIELDS = 'f1,f2,f3,f5,f12,f13,f14,f18,f124'

/** ulist.np/get 响应骨架：命中的行在 data.diff；未收录的 secid 使 data 为 null。 */
interface QuoteListResponse {
  data?: { total?: number; diff?: Array<Record<string, unknown>> } | null
}

/** 报价字段 → 有限数；null/空串/停牌占位返回 undefined，由调用方决定兜底值。 */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** cn 市场的分精度兜底倍率：×100（2 位小数），只在报价行没给出可用的 f1 时使用。 */
const CN_PRICE_SCALE = 100

/**
 * 报价行的价格除数 = 10^f1（f1 = 上游给该标的声明的小数位数）：A 股股票 f1=2、A 股 ETF
 * f1=3（2026-10-14 实测），故取价一律按行——市场级 ×100 会把 ETF 读成 10 倍。
 * f1 缺失或落在 0..6 之外时回落到市场级常数。
 */
function quotePriceScale(decimalDigits: unknown): number {
  const digits = toFiniteNumber(decimalDigits)
  if (digits === undefined || !Number.isInteger(digits) || digits < 0 || digits > 6) return CN_PRICE_SCALE
  return 10 ** digits
}

export interface AkshareRestOptions {
  fetchImpl?: typeof fetch
}

export class AkshareRestClient {
  private readonly fetchImpl: typeof fetch

  constructor(options: AkshareRestOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  private async requestJson<T>(url: string): Promise<T> {
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'Accept': 'application/json' },
      })
      if (!res.ok) {
        throw new TradingServiceError('TRADING_UPSTREAM_ERROR', `Akshare HTTP ${res.status}: ${res.statusText}`)
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `Akshare network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const { secid, canonical } = toEastmoneySecid(symbol)
    // 报价走批量端点 ulist.np/get（secids 传单个 secid 等价）：2026-10-14 实测
    // /api/qt/stock/get 对任意 secid 都是传输层空回，而同一时刻同域同 UA 的
    // ulist.np/get 正常。原始响应与逐只交叉验证见 spikes/impl-eastmoney-quote-endpoint/。
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${secid}&fields=${QUOTE_FIELDS}`
    const res = await this.requestJson<QuoteListResponse>(url)
    // 未收录的 secid 上游是「少返回行」而不是报错（只传无效 secid 时 data:null），
    // 故拿不到行即该标的不存在，按 not found 抛错（与旧端点 data 为空时的语义一致）。
    const row = res.data?.diff?.[0]
    if (row === undefined) {
      throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `AkShare/Eastmoney quote not found: ${symbol}`)
    }

    const scale = quotePriceScale(row.f1)
    const rawPrice = toFiniteNumber(row.f2)
    const price = rawPrice !== undefined && rawPrice > 0 ? rawPrice / scale : 0
    // 官方昨收锚点（与 tencent fields[4] 同语义）：涨跌幅基准，UI 头部/侧栏直接消费。
    const prevClose = toFiniteNumber(row.f18)
    const changePercent = toFiniteNumber(row.f3)
    const quoteTime = toFiniteNumber(row.f124)
    const name = typeof row.f14 === 'string' && row.f14.trim() ? row.f14.trim() : undefined

    return {
      symbol: canonical,
      ...(name ? { name } : {}),
      price,
      volume: toFiniteNumber(row.f5) ?? 0,
      timestamp: quoteTime !== undefined && quoteTime > 0 ? quoteTime * 1000 : Date.now(),
      ...(prevClose !== undefined && prevClose > 0 ? { prevClose: prevClose / scale } : {}),
      ...(changePercent !== undefined ? { changePercent: changePercent / 100 } : {}),
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    // 周期先于任何请求解析：不支持的周期在这里抛错，绝不落日线。
    const { klt, stepMs } = resolveKlinesInterval(interval)
    const { secid } = toEastmoneySecid(symbol)
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=${klt}&fqt=1&lmt=${limit}&fields2=f51,f52,f53,f54,f55,f56`
    const res = await this.requestJson<{ data?: { klines?: string[] } }>(url)
    if (!res.data?.klines) return []

    return res.data.klines.map((line) => {
      const parts = line.split(',')
      const openTime = new Date(parts[0].replace(/-/g, '/')).getTime()
      return {
        openTime,
        open: parseFloat(parts[1]),
        close: parseFloat(parts[2]),
        high: parseFloat(parts[3]),
        low: parseFloat(parts[4]),
        volume: parseFloat(parts[5]),
        closeTime: openTime + stepMs - 1,
      }
    })
  }

  async getSectorFundFlow(): Promise<Array<{ name: string; changePercent: number; mainNetInflow: number }>> {
    const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=10&po=1&np=1&fields=f12,f14,f3,f62&fs=m:90+t:2'
    const res = await this.requestJson<{ data?: { diff?: Array<{ f14: string; f3: number; f62: number }> } }>(url)
    const list = res.data?.diff ?? []
    return list.map((item) => ({
      name: item.f14,
      changePercent: typeof item.f3 === 'number' ? item.f3 / 100 : 0,
      mainNetInflow: item.f62,
    }))
  }
}

export type { Interval, Kline, Ticker }

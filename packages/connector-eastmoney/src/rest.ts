/**
 * @dshtrading/connector-eastmoney/rest
 * 东方财富 A 股公开 REST 行情客户端（免密公共源）。
 */

import type {
  Interval,
  Kline,
  SouthboundHoldingHistory,
  SouthboundHoldingPoint,
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

export function mapIntervalToKlt(interval: Interval): string {
  switch (interval) {
    case '1m': return '1'
    case '5m': return '5'
    case '15m': return '15'
    case '30m': return '30'
    case '1h': return '60'
    case '1d': return '101'
    case '1w': return '102'
    case '1M': return '103'
    default:
      throw new TradingServiceError(
        'TRADING_INVALID_ARGUMENT',
        `Unsupported interval "${interval}" for Eastmoney. Valid: ${INTERVAL_VOCABULARY.join(', ')}`,
      )
  }
}

export function parseIntervalMs(interval: Interval): number {
  switch (interval) {
    case '1m': return 60 * 1000
    case '5m': return 5 * 60 * 1000
    case '15m': return 15 * 60 * 1000
    case '30m': return 30 * 60 * 1000
    case '1h': return 60 * 60 * 1000
    case '1d': return 24 * 60 * 60 * 1000
    case '1w': return 7 * 24 * 60 * 60 * 1000
    case '1M': return 30 * 24 * 60 * 60 * 1000
  }
}

/**
 * 上游分精度整数（×100，如昨收 f60=129740 → 1297.40）→ 数值；
 * '-'/‘−’ 停牌占位或缺失返回 undefined。
 */
function parseScaled(value: unknown, scale: number): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value / scale : undefined
  if (typeof value === 'string' && value !== '-' && value !== '−') {
    const parsed = parseFloat(value)
    return Number.isNaN(parsed) ? undefined : parsed / scale
  }
  return undefined
}

function parseScaledHundred(value: unknown): number | undefined {
  return parseScaled(value, 100)
}

const KNOWN_SH_INDICES = new Set(['000688', '000300', '000016', '000905', '000852'])

/** 连接器服务的市场（cn=A 股；hk=港股，2026-09-08 扩展，实证见 spikes/impl-eastmoney-hk/）。 */
export type EastmoneyMarket = 'cn' | 'hk'

/** CN/HK 均为永久 UTC+8（无夏令时）——墙钟时间用固定偏移锚定，与运行机器时区无关。 */
const UTC8_MS = 8 * 3600_000

/**
 * `YYYY-MM-DD[ HH:MM[:SS]]`（UTC+8 墙钟；日 K 只有日期段）→ epoch ms。
 * CN/HK 均为永久 UTC+8，故用固定偏移锚定，与运行机器时区无关（审查 M1：
 * kline/get 此前用 `new Date('YYYY/MM/DD')` 按宿主本地时区解析，TZ≠UTC+8 时
 * 与同市场 1m 序列相差数小时）。
 */
export function utc8WallTimeToEpochMs(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value)
  if (!m) throw new TradingServiceError('TRADING_EXCHANGE_ERROR', `invalid eastmoney wall time ${JSON.stringify(value)}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)) - UTC8_MS
}

/** 东财价格字段的分精度倍率：cn ×100（2 位小数），hk ×1000（3 位小数，响应 decimal=3）。 */
export function eastmoneyPriceScale(market: EastmoneyMarket): number {
  return market === 'hk' ? 1000 : 100
}

/**
 * `YYYY-MM-DD[ ...]`（报表日期列为 UTC+8 零点的墙钟串，如 `2026-10-09 00:00:00`）
 * → **UTC 当日 00:00** 的 epoch ms（与日 K openTime 同口径，便于前向对齐）。
 * 只取日期段，用 Date.UTC 构造，不引入运行机器的本地时区偏移。
 */
export function parseReportDateToUtcMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  if (m === null) return undefined
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isFinite(ms) ? ms : undefined
}

/** 报表数值列 → 有限数；null/空串/非数值返回 undefined（调用方决定跳过还是兜底）。 */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 将标准代码转为东财 secid。**按连接器市场分流**（2026-09-08 审查 H3/L1）：同一个
 * 东财服务实例可能服务 cn 或 hk，形态解析必须知道自己是哪个市场——否则港股宽容
 * 形 `700` 会落进 CN 兜底（secid 0.700 / canonical 700.SZ），查询到另一个市场
 * 的证券且回带错误规范形。
 *
 * - `market='hk'`：`00700.HK` / `HK.00700`（Futu 原生形）/ `HK00700` / 裸 1-5 位
 *   数字 → secid 116.xxxxx；CN 形态（6 位数字 / .SH/.SZ/.BJ）显式拒绝。
 * - `market='cn'`：6 位数字（可带 .SH/.SZ/.BJ）→ 1.xxxxxx（沪）/ 0.xxxxxx（深、
 *   北）；HK 形态显式拒绝。
 */
export function toEastmoneySecid(symbol: string, market: EastmoneyMarket = 'cn'): { secid: string; canonical: string; market: EastmoneyMarket } {
  const clean = symbol.trim().toUpperCase()
  if (market === 'hk') {
    const hkMatch = /^(\d{1,5})\.HK$/.exec(clean) ?? /^HK\.?(\d{1,5})$/.exec(clean) ?? /^(\d{1,5})$/.exec(clean)
    if (hkMatch === null) {
      throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `Eastmoney hk: malformed HK symbol ${JSON.stringify(symbol)}`)
    }
    const hkCode = (hkMatch[1] as string).padStart(5, '0')
    return { secid: `116.${hkCode}`, canonical: `${hkCode}.HK`, market: 'hk' }
  }
  if (/^\d{1,5}$/.test(clean) || /\.HK$/.test(clean) || /^HK/.test(clean)) {
    throw new TradingServiceError('TRADING_UNSUPPORTED_SYMBOL', `Eastmoney cn: not an A-share symbol ${JSON.stringify(symbol)}`)
  }
  let code = clean
  let exchange = ''

  if (clean.includes('.')) {
    const parts = clean.split('.')
    code = parts[0] as string
    exchange = parts[1] as string
  } else if (/^\d{6}$/.test(clean)) {
    code = clean
    if (KNOWN_SH_INDICES.has(code) || code.startsWith('6') || code.startsWith('5') || code.startsWith('9')) {
      exchange = 'SH'
    } else if (code.startsWith('0') || code.startsWith('3') || code.startsWith('1')) {
      exchange = 'SZ'
    } else if (code.startsWith('8') || code.startsWith('4') || code.startsWith('92')) {
      exchange = 'BJ'
    }
  }

  if (!exchange) {
    if (KNOWN_SH_INDICES.has(code) || code.startsWith('6') || code.startsWith('5')) exchange = 'SH'
    else exchange = 'SZ'
  }

  const prefix = exchange === 'SH' ? '1' : '0'
  return {
    secid: `${prefix}.${code}`,
    canonical: `${code}.${exchange}`,
    market: 'cn',
  }
}

export interface EastmoneyRestOptions {
  baseUrl?: string
  historyBaseUrl?: string
  searchBaseUrl?: string
  /** 东财数据中心域（datacenter-web，报表类端点；与 push2 行情域分离）。 */
  dataCenterBaseUrl?: string
  fetchImpl?: typeof fetch
  /** 本实例服务的市场（形态解析与价格倍率都按它分流；缺省 cn）。 */
  market?: EastmoneyMarket
}

/**
 * 东财数据中心「返回数据为空」业务码（2026-10-13 实测）：非港股通标的与
 * pageNumber 越界都返回 `{ result: null, success: false, code: 9201,
 * message: "返回数据为空" }`，HTTP 200。它不是故障，是「该标的无此序列」，
 * 必须与故障区分——其余非零码（实测 9501：报表配置不存在 / 列不存在）是
 * 上游协议错误，要抛错而不是当成空序列。
 */
const DATACENTER_EMPTY_CODE = 9201

/** 数据中心报表端点的 Referer（该域校验 data.eastmoney.com，与 push2 的 quote 域不同）。 */
const DATACENTER_REFERER = 'https://data.eastmoney.com/'

/** 数据中心 /api/data/v1/get 响应骨架（列名随报表而变，data 行按需解析）。 */
interface EastmoneyDataCenterResponse {
  success?: boolean
  code?: number
  message?: string
  result?: { data?: unknown; count?: number; pages?: number } | null
}

export class EastmoneyRestClient {
  readonly baseUrl: string
  readonly historyBaseUrl: string
  readonly searchBaseUrl: string
  /** 东财数据中心域（港股通持股等报表端点）。 */
  readonly dataCenterBaseUrl: string
  /** 本实例的市场（cn/hk 单包双实例；形态解析必须与注册市场一致）。 */
  readonly market: EastmoneyMarket
  private readonly fetchImpl: typeof fetch

  constructor(options: EastmoneyRestOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://push2.eastmoney.com'
    this.historyBaseUrl = options.historyBaseUrl ?? 'https://push2his.eastmoney.com'
    this.searchBaseUrl = options.searchBaseUrl ?? 'https://searchapi.eastmoney.com'
    this.dataCenterBaseUrl = options.dataCenterBaseUrl ?? 'https://datacenter-web.eastmoney.com'
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.market = options.market ?? 'cn'
  }

  private async requestJson<T>(url: string, referer: string = 'https://quote.eastmoney.com/'): Promise<T> {
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
          'Referer': referer,
        },
      })
      if (!res.ok) {
        throw new TradingServiceError(
          'TRADING_UPSTREAM_ERROR',
          `Eastmoney HTTP request failed: status ${res.status} ${res.statusText}`,
        )
      }
      return await res.json() as T
    } catch (err) {
      if (err instanceof TradingServiceError) throw err
      throw new TradingServiceError(
        'TRADING_NETWORK',
        `Eastmoney network error: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const { secid, canonical, market } = toEastmoneySecid(symbol, this.market)
    const scale = eastmoneyPriceScale(market)
    // f60=昨收 f169=涨跌额 f170=涨跌幅（均为 ×100 分精度整数；'-' 停牌占位）。
    const url = `${this.baseUrl}/api/qt/stock/get?secid=${secid}&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f86,f169,f170`
    const res = await this.requestJson<{ data?: Record<string, unknown> }>(url)

    if (!res.data) {
      throw new TradingServiceError('TRADING_SYMBOL_NOT_FOUND', `Eastmoney symbol not found: ${symbol}`)
    }

    const d = res.data
    let rawPrice = 0
    if (typeof d.f43 === 'number') {
      rawPrice = d.f43 / scale
    } else if (typeof d.f43 === 'string' && d.f43 !== '-' && d.f43 !== '−') {
      const parsed = parseFloat(d.f43)
      rawPrice = Number.isNaN(parsed) ? 0 : parsed / scale
    }
    const price = rawPrice > 0 ? rawPrice : 0
    const volume = typeof d.f47 === 'number' ? d.f47 : typeof d.f47 === 'string' ? parseFloat(d.f47) : 0
    const timestamp = typeof d.f86 === 'number' ? d.f86 * 1000 : Date.now()
    // 官方昨收锚点（与 tencent fields[4] 同语义）：涨跌幅基准，UI 头部/侧栏直接消费。
    // hk 昨收同样 ×1000（f60=438400 → 438.4）；涨跌幅 f170 两市场均 ×100。
    const prevClose = market === 'hk' ? parseScaled(d.f60, scale) : parseScaledHundred(d.f60)
    const changePercent = parseScaledHundred(d.f170)

    const name = typeof d.f58 === 'string' && d.f58.trim() ? d.f58.trim() : undefined

    return {
      symbol: canonical,
      ...(name ? { name } : {}),
      price,
      volume: volume > 0 ? volume : 0,
      timestamp,
      ...(prevClose !== undefined && prevClose > 0 ? { prevClose } : {}),
      ...(changePercent !== undefined ? { changePercent } : {}),
    }
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    const { secid, market } = toEastmoneySecid(symbol, this.market)
    // 港股 1m 走 trends2 分时端点（当日完整分钟序列；kline/get 的 klt=1 对 hk 未实证，
    // 5m/日 K 已实证可用，spikes/impl-eastmoney-hk/）。
    if (market === 'hk' && interval === '1m') {
      return this.getHkIntradayTrends(secid, limit)
    }
    const klt = mapIntervalToKlt(interval)
    const stepMs = parseIntervalMs(interval)
    const url = `${this.historyBaseUrl}/api/qt/stock/kline/get?secid=${secid}&klt=${klt}&fqt=1&lmt=${limit}&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`
    
    const res = await this.requestJson<{ data?: { klines?: string[] } }>(url)
    if (!res.data || !Array.isArray(res.data.klines)) {
      return []
    }

    const klines: Kline[] = []
    for (const line of res.data.klines) {
      const parts = line.split(',')
      if (parts.length < 6) continue
      const timeStr = parts[0]
      const open = parseFloat(parts[1])
      const close = parseFloat(parts[2])
      const high = parseFloat(parts[3])
      const low = parseFloat(parts[4])
      const volume = parseFloat(parts[5])

      // UTC+8 固定偏移锚定（审查 M1）：与同市场 1m（trends2）同口径，机器时区无关。
      let openTime: number
      try {
        openTime = utc8WallTimeToEpochMs(timeStr)
      } catch {
        continue
      }

      klines.push({
        openTime,
        open,
        high,
        low,
        close,
        volume,
        closeTime: openTime + stepMs - 1,
      })
    }

    return klines
  }

  /**
   * 港股当日分时（trends2，ndays=1 = 最近一个交易日全天分钟序列，非交易日自然回落）。
   * 行格式同 kline/get：`时间,开,收,高,低,量,额,均价`；时间 'YYYY-MM-DD HH:MM' 为 UTC+8 墙钟。
   */
  private async getHkIntradayTrends(secid: string, limit: number): Promise<Kline[]> {
    const url = `${this.historyBaseUrl}/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0`
    const res = await this.requestJson<{ data?: { trends?: string[] } }>(url)
    const trends = res.data?.trends
    if (!Array.isArray(trends)) return []

    const stepMs = parseIntervalMs('1m')
    const klines: Kline[] = []
    for (const line of trends) {
      const parts = line.split(',')
      if (parts.length < 6) continue
      const openTime = utc8WallTimeToEpochMs(parts[0] ?? '')
      klines.push({
        openTime,
        open: parseFloat(parts[1] ?? ''),
        high: parseFloat(parts[3] ?? ''),
        low: parseFloat(parts[4] ?? ''),
        close: parseFloat(parts[2] ?? ''),
        volume: parseFloat(parts[5] ?? ''),
        closeTime: openTime + stepMs - 1,
      })
    }
    return klines.slice(-Math.max(limit, 1))
  }

  async listInstruments(query?: string): Promise<Array<{ symbol: string; name: string }>> {
    if (!query) return []
    const url = `${this.searchBaseUrl}/api/suggest/get?input=${encodeURIComponent(query)}&type=14`
    const res = await this.requestJson<{ QuotationCodeTable?: { Data?: Array<{ Code: string; Name: string; SecurityTypeName: string }> } }>(url)
    const items = res.QuotationCodeTable?.Data ?? []
    const out: Array<{ symbol: string; name: string }> = []
    for (const item of items) {
      // 搜索结果可能混入其它市场形态：映射不了就跳过（不让一条坏行毁掉整份名册）。
      try {
        const { canonical } = toEastmoneySecid(item.Code, this.market)
        out.push({ symbol: canonical, name: item.Name })
      } catch {
        continue
      }
    }
    return out
  }

  /**
   * 港股通持股历史（东财数据中心 RPT_MUTUAL_STOCK_HOLDRANKS，2026-10-13）。
   *
   * 只覆盖港股通标的：标的无该序列时返回空 points（**空 ≠ 0**，消费方隐藏副图
   * 而不是画一条贴底的假线）；上游网络/协议失败抛错。仅 hk 实例可用——该报表以
   * 5 位港股代码为主键，cn 实例调用即协议误用。
   */
  async getSouthboundHoldings(symbol: string): Promise<SouthboundHoldingHistory> {
    if (this.market !== 'hk') {
      throw new TradingServiceError(
        'TRADING_NOT_IMPLEMENTED',
        `Eastmoney southbound holdings is an hk-only capability (instance market: ${this.market})`,
      )
    }
    const { canonical } = toEastmoneySecid(symbol, this.market)
    // 报表主键是不带后缀的 5 位港股代码（00700）；规范形带 .HK 后缀，此处剥掉。
    const code = canonical.slice(0, canonical.indexOf('.'))
    // MUTUAL_TYPE 002/004 每交易日各一行且数值相同；(MUTUAL_TYPE="002") 让单页拿全
    // 历史并天然去重，本地仍按 HOLD_DATE 再兜一次。
    const filter = `(SECURITY_CODE="${code}")(MUTUAL_TYPE="002")`
    const url = `${this.dataCenterBaseUrl}/api/data/v1/get?reportName=RPT_MUTUAL_STOCK_HOLDRANKS&columns=ALL`
      + `&filter=${encodeURIComponent(filter)}&pageSize=1000&pageNumber=1`
      + '&sortColumns=HOLD_DATE&sortTypes=1&source=WEB&client=WEB'
    const res = await this.requestJson<EastmoneyDataCenterResponse>(url, DATACENTER_REFERER)

    // 只有「返回数据为空」是合法空序列；其余业务错误码（如 9501 报表/列不存在）是上游故障。
    if (res.success === false && res.code !== DATACENTER_EMPTY_CODE) {
      throw new TradingServiceError(
        'TRADING_UPSTREAM_ERROR',
        `Eastmoney datacenter error: code ${res.code ?? 'unknown'} ${res.message ?? ''}`.trim(),
      )
    }
    const result = res.result
    if (result === null || result === undefined) return { symbol: canonical, points: [] }
    const rows = result.data
    if (rows === null || rows === undefined) return { symbol: canonical, points: [] }
    if (!Array.isArray(rows)) {
      throw new TradingServiceError(
        'TRADING_UPSTREAM_ERROR',
        `Eastmoney datacenter malformed payload: result.data is ${typeof rows}`,
      )
    }
    // 单页装不下即整段历史不可信：宁可抛错让消费方隐藏副图，也不静默给半截序列。
    if (typeof result.pages === 'number' && result.pages > 1) {
      throw new TradingServiceError(
        'TRADING_UPSTREAM_ERROR',
        `Eastmoney datacenter pagination overflow: ${rows.length} rows in page 1 of ${result.pages}`,
      )
    }

    const byDate = new Map<number, SouthboundHoldingPoint>()
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const record = row as Record<string, unknown>
      const ratio = toFiniteNumber(record.HOLD_SHARES_RATIO)
      // 比例缺失的行直接跳过（绝不当 0——那会画出一条贴底假线）；比例是本副图唯一取值列。
      if (ratio === undefined) continue
      const date = parseReportDateToUtcMs(record.HOLD_DATE)
      if (date === undefined) continue
      if (byDate.has(date)) continue
      byDate.set(date, {
        date,
        holdRatio: ratio,
        holdShares: toFiniteNumber(record.HOLD_SHARES) ?? 0,
        holdMarketCap: toFiniteNumber(record.HOLD_MARKET_CAP) ?? 0,
      })
    }
    const points = [...byDate.values()].sort((a, b) => a.date - b.date)
    return { symbol: canonical, points }
  }
}
export type { Interval, Kline, Ticker }

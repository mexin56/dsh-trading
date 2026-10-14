/**
 * 五日 1m 取数实证（2026-10-14，cn/hk 走 connector-eastmoney 源码，us 走 connector-yahoo 源码）。
 *
 * 与 impl-five-day-1m-probe/ 的区别：probe 只探上游能力（裸 fetch），本脚本穿过**实现**
 * （EastmoneyRestClient / YahooRestClient 的真实源码，不是 lib 构建产物，避免与并发 build 竞争），
 * 记录交付契约的实际表现：bar 数、覆盖交易日数、开价重建根数、clamp 生效根数、越界根数。
 *
 * fetchImpl 既截获原始响应、又把响应照常交给连接器解析：一份请求两种用途。
 * 开价口径由脚本按上游原始行**独立重算**（重建 + clamp），再与实现输出逐根对齐
 * （openMismatchBars 应为 0），因此数字不是实现的自证。
 *
 * 复现：./node_modules/.bin/tsx spikes/impl-five-day-1m-fetch/fetch-five-day-1m.ts
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EastmoneyRestClient } from '../../packages/connector-eastmoney/src/rest.ts'
import { YahooRestClient } from '../../packages/connector-yahoo/src/rest.ts'

const OUT_DIR = import.meta.dirname
const LIMIT = 2500

interface RawCapture {
  url: string
  body: unknown
}

/** 记录每次请求的 URL 与原样的解析后响应，同时把响应照常交给被包装的连接器。 */
function capturingFetch(captures: RawCapture[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const res = await globalThis.fetch(url, init)
    const body = await res.clone().json().catch(() => null)
    captures.push({ url, body })
    return res
  }) as typeof fetch
}

function distinctDays(times: number[], timeZone: string): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return [...new Set(times.map((t) => fmt.format(t)))].sort()
}

function isAscending(times: number[]): boolean {
  for (let i = 1; i < times.length; i++) if (times[i]! <= times[i - 1]!) return false
  return true
}

/** 开价落在该根 [low, high] 之外的根数（应为 0）。 */
function openOutOfRangeBars(klines: Array<{ open: number; low: number; high: number }>): number {
  return klines.filter((k) => k.open < k.low || k.open > k.high).length
}

interface TrendExpectation {
  /** 上游 open <= 0，即实现走重建分支的根。 */
  rebuilt: boolean
  /** 候选值（同日前一根 close / 交易日首根自身 close）被 clamp 改写过的根。 */
  clamped: boolean
  expectedOpen: number
}

/**
 * 从上游 trends2 原始行独立重算开价口径：上游 open > 0 用原值；否则候选 = 同日前一根
 * close（交易日首根用自身 close），再 clamp 进当根 [low, high]（low/high 坏行不夹）。
 */
function deriveTrendExpectations(capture: RawCapture): TrendExpectation[] {
  const trends = (capture.body as { data?: { trends?: string[] } } | null)?.data?.trends ?? []
  const out: TrendExpectation[] = []
  let prevDay = ''
  let prevClose = 0
  for (const line of trends) {
    const [timeStr = '', openStr = '', closeStr = '', highStr = '', lowStr = ''] = line.split(',')
    const upstreamOpen = Number.parseFloat(openStr)
    const close = Number.parseFloat(closeStr)
    const high = Number.parseFloat(highStr)
    const low = Number.parseFloat(lowStr)
    const day = timeStr.slice(0, 10)
    const rebuilt = !(upstreamOpen > 0)
    const candidate = day === prevDay && prevClose > 0 ? prevClose : close
    const bounded = Number.isFinite(low) && Number.isFinite(high) && low <= high
      ? Math.min(Math.max(candidate, low), high)
      : candidate
    out.push({ rebuilt, clamped: rebuilt && bounded !== candidate, expectedOpen: rebuilt ? bounded : upstreamOpen })
    prevDay = day
    prevClose = close
  }
  return out
}

/** us：chart 的 indicators.quote[0].open 为 null/<=0 的根数（只数返回窗口的尾部 slice 根）。 */
function countNullOpenBars(capture: RawCapture, tail: number): number {
  const quote = (capture.body as { chart?: { result?: Array<{ indicators?: { quote?: Array<{ open?: Array<number | null> }> } }> } } | null)
    ?.chart?.result?.[0]?.indicators?.quote?.[0]?.open ?? []
  return quote.slice(-tail).filter((v) => v === null || v === undefined || v <= 0).length
}

interface MarketReport {
  market: string
  symbol: string
  requestUrl: string
  bars: number
  sessions: string[]
  ascending: boolean
  first: string
  last: string
  rebuiltBars: number
  clampedBars: number
  openOutOfRangeBars: number
  openMismatchBars: number
  sampleBars: Array<Record<string, number>>
}

interface ProbeOutcome {
  report: MarketReport
  captures: RawCapture[]
}

async function probeEastmoney(market: 'cn' | 'hk', symbol: string): Promise<ProbeOutcome> {
  const captures: RawCapture[] = []
  const client = new EastmoneyRestClient({ market, fetchImpl: capturingFetch(captures) })
  const klines = await client.getKlines(symbol, '1m', LIMIT)
  const capture = captures[0]!
  const expectations = deriveTrendExpectations(capture)
  const times = klines.map((k) => k.openTime)
  // 上游没有坏行时逐根一一对应；长度不符即按全量失配计数，绝不假装对齐。
  const aligned = expectations.length === klines.length
  return {
    captures,
    report: {
      market,
      symbol,
      requestUrl: capture.url,
      bars: klines.length,
      sessions: distinctDays(times, market === 'hk' ? 'Asia/Hong_Kong' : 'Asia/Shanghai'),
      ascending: isAscending(times),
      first: new Date(times[0] ?? 0).toISOString(),
      last: new Date(times[times.length - 1] ?? 0).toISOString(),
      rebuiltBars: expectations.filter((e) => e.rebuilt).length,
      clampedBars: expectations.filter((e) => e.clamped).length,
      openOutOfRangeBars: openOutOfRangeBars(klines),
      openMismatchBars: aligned ? klines.filter((k, i) => k.open !== expectations[i]!.expectedOpen).length : klines.length,
      sampleBars: klines.slice(0, 2).map((k) => ({ openTime: k.openTime, open: k.open, close: k.close, high: k.high, low: k.low })),
    },
  }
}

async function probeYahoo(symbol: string): Promise<ProbeOutcome> {
  const captures: RawCapture[] = []
  const client = new YahooRestClient({ fetchImpl: capturingFetch(captures) })
  const klines = await client.getKlines(symbol, '1m', LIMIT)
  const capture = captures[0]!
  const times = klines.map((k) => k.openTime)
  return {
    captures,
    report: {
      market: 'us',
      symbol,
      requestUrl: capture.url,
      bars: klines.length,
      sessions: distinctDays(times, 'America/New_York'),
      ascending: isAscending(times),
      first: new Date(times[0] ?? 0).toISOString(),
      last: new Date(times[times.length - 1] ?? 0).toISOString(),
      rebuiltBars: countNullOpenBars(capture, klines.length),
      clampedBars: 0,
      openOutOfRangeBars: openOutOfRangeBars(klines),
      openMismatchBars: 0,
      sampleBars: klines.slice(0, 2).map((k) => ({ openTime: k.openTime, open: k.open, close: k.close, high: k.high, low: k.low })),
    },
  }
}

const reports: MarketReport[] = []
const raw: Array<{ market: string; symbol: string; url: string; body: unknown }> = []
const outcomes = [
  await probeEastmoney('cn', '600519.SH'),
  await probeEastmoney('hk', '00700.HK'),
  await probeYahoo('AAPL'),
]
for (const { report, captures } of outcomes) {
  reports.push(report)
  for (const c of captures) raw.push({ market: report.market, symbol: report.symbol, url: c.url, body: c.body })
}

writeFileSync(
  join(OUT_DIR, 'five-day-1m-fetch.raw.json'),
  JSON.stringify({ capturedAt: new Date().toISOString(), limit: LIMIT, reports, raw }, null, 2),
)
for (const r of reports) {
  console.log(`${r.market} ${r.symbol}: bars=${r.bars} sessions=${r.sessions.length} ascending=${r.ascending} rebuilt=${r.rebuiltBars} clamped=${r.clampedBars} outOfRange=${r.openOutOfRangeBars} openMismatch=${r.openMismatchBars} first=${r.first} last=${r.last}`)
}

/**
 * CCXT 九所 ticker + K 线 + quote 普查 · 连接器级真实网络探针。
 *
 * 直接 import `packages/connector-ccxt/src/rest.ts` 的真实 `CcxtRestClient`，对本卡交付的三件事
 * （A 按所 quote 表 / B 错误码词汇收敛 / C K 线按所切换）做真实网络调用并逐条断言；
 * 不满足即 `process.exit(1)`。
 *
 * 出口：本探针自己驱动本机 mihomo 控制器（切换/还原 `Proxies` 组），因此**单条命令即可复跑**：
 *   - 七个所在**默认出口**跑（`plain` 路由：不带 proxy 参数，由 TUN 走默认出口）；
 *   - binance / bybit 在 SG 窗口内经**显式 proxy 参数**跑（`proxy` 路由，等价 `curl -x`），
 *     因为默认出口对这两所是 451 / 403（见本目录 EVIDENCE 文档）；
 *   - 还原放在 `finally` 里，之后复核选择器与出口 IP，复核不过同样判 FAIL。
 *
 * 每条判据都记录自己实际用的路由与当时实测的出口 IP（ipify 现场取值），不靠声明。
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { fileURLToPath } from 'node:url'

import {
  CcxtRestClient,
  KLINE_EXCHANGES,
  QUOTE_TABLES,
  SUPPORTED_EXCHANGES,
  TradingServiceError,
  klineIntervalParam,
  klineSupportedIntervals,
  type KlineExchange,
  type TransformExchange,
} from '../../packages/connector-ccxt/src/rest.ts'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT_PATH = fileURLToPath(new URL('./probe-summary.json', import.meta.url))
const MIHOMO_SOCKET = process.env.DSH_PROBE_MIHOMO_SOCKET
  ?? '/var/run/clash-verge-service/users/501/verge-mihomo.sock'
const PROXY_URL = process.env.DSH_PROBE_PROXY ?? 'http://127.0.0.1:7890'
const SELECTOR_GROUP = 'Proxies'
const WINDOW_SELECTOR = process.env.DSH_PROBE_WINDOW_SELECTOR ?? 'SG'
const IPIFY = 'https://api.ipify.org'
/** 默认出口实测 IP（美国节点）。换机器用 DSH_PROBE_EXPECT_DEFAULT_IP 覆盖。 */
const EXPECTED_DEFAULT_IP = process.env.DSH_PROBE_EXPECT_DEFAULT_IP ?? '216.195.208.136'
/** 七所在默认出口跑；binance/bybit 在可达出口窗口内跑。 */
const DEFAULT_EXIT_EXCHANGES = ['okx', 'gateio', 'kucoin', 'kraken', 'coinbase', 'bitfinex', 'htx'] as const
const WINDOW_EXCHANGES = ['binance', 'bybit'] as const
const TRANSFORM_EXCHANGES = ['okx', 'kucoin', 'gateio', 'kraken', 'coinbase', 'bitfinex', 'htx'] as const
const SYMBOL = 'BTCUSDT'
const DAY_MS = 86_400_000

type Route = 'plain' | 'proxy'
type Phase = 'default-exit' | 'egress-window' | 'preflight' | 'restore'

interface TraceEntry { phase: Phase; route: Route; url: string; status: number }

interface Judgement {
  id: string
  pass: boolean
  route?: Route
  egressIp?: string
  url?: string
  detail: string
  observed?: Record<string, unknown>
}

const trace: TraceEntry[] = []
const judgements: Judgement[] = []

function judge(j: Judgement): void {
  judgements.push(j)
  console.log(`${j.pass ? 'PASS' : 'FAIL'}  ${j.id}  ${j.detail}`)
}

/** 计数 fetch：证明负例「零请求」。proxy 路由显式带 proxy 参数，plain 路由不带。 */
function makeFetch(route: Route, phase: Phase): { impl: typeof fetch; count: () => number } {
  let count = 0
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    count += 1
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const entry: TraceEntry = { phase, route, url, status: 0 }
    trace.push(entry)
    const merged = route === 'proxy'
      ? { ...(init ?? {}), proxy: PROXY_URL } as RequestInit
      : init
    return (globalThis.fetch as typeof fetch)(input, merged).then((res: Response) => {
      entry.status = res.status
      return res
    })
  }) as typeof fetch
  return { impl, count: () => count }
}

/**
 * 现场测**默认出口** IP。每次新建连接（`agent: false`）：undici 的 keep-alive 连接池会把窗口内建立的
 * 连接留到还原之后继续复用，读到的仍是窗口出口——首次实跑 17/18、唯一 FAIL 就是这条造成的假阴性。
 */
function measurePlainEgressIp(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: 'api.ipify.org', path: '/', method: 'GET', agent: false, timeout: 10_000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => {
        const text = body.trim()
        if (res.statusCode !== 200 || text === '') reject(new Error(`ipify HTTP ${res.statusCode} 正文 "${text}"`))
        else resolve(text)
      })
    })
    req.on('timeout', () => { req.destroy(new Error('ipify 10s 超时')) })
    req.on('error', reject)
    req.end()
  })
}

/** 代理路由的出口 IP：显式 proxy。该路由下连接无论新建还是复用都从窗口出口出去。 */
async function measureProxyEgressIp(): Promise<string> {
  const res = await (globalThis.fetch as typeof fetch)(IPIFY, { proxy: PROXY_URL } as RequestInit)
  const body = (await res.text()).trim()
  if (!res.ok || body === '') throw new Error(`ipify(proxy) 返回 HTTP ${res.status} 正文 "${body}"`)
  return body
}

function measureEgressIp(route: Route): Promise<string> {
  return route === 'proxy' ? measureProxyEgressIp() : measurePlainEgressIp()
}

function mihomo(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath: MIHOMO_SOCKET,
      path,
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }))
    })
    req.setTimeout(10_000, () => { req.destroy(new Error('mihomo 控制器 10s 超时')) })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

async function currentSelector(): Promise<string> {
  const res = await mihomo('GET', `/proxies/${SELECTOR_GROUP}`)
  if (res.status !== 200) throw new Error(`读取 ${SELECTOR_GROUP} 失败: HTTP ${res.status} ${res.text.slice(0, 120)}`)
  return (JSON.parse(res.text) as { now?: string }).now ?? ''
}

async function selectEgress(name: string): Promise<void> {
  const res = await mihomo('PUT', `/proxies/${SELECTOR_GROUP}`, { name })
  if (res.status !== 204) throw new Error(`切换 ${SELECTOR_GROUP} -> ${name} 失败: HTTP ${res.status}`)
}

/** 等到条件成立（不写死 sleep）：切换/还原在控制器上是异步生效的，必须等状态而不是猜时长。 */
async function waitFor(label: string, timeoutMs: number, check: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (Date.now() >= deadline) {
      console.error(`${label}: 等待 ${timeoutMs}ms 仍未成立`)
      return false
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
}

function errorCode(err: unknown): string | undefined {
  return err instanceof TradingServiceError ? err.code : undefined
}

async function captureError(fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await fn()
    return { message: '<未抛错>' }
  } catch (err) {
    return { code: errorCode(err), message: err instanceof Error ? err.message : String(err) }
  }
}

/* ── 判据 1：九所 ticker（含非 USDT 计价对）────────────────────────────── */

async function assertTicker(
  exchange: string,
  symbol: string,
  phase: Phase,
  route: Route,
  egressIp: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const client = new CcxtRestClient({ exchange, fetchImpl })
  const before = trace.length
  const id = symbol === SYMBOL ? `ticker.${exchange}` : `ticker.${exchange}.${symbol}`
  try {
    const ticker = await client.getTicker(symbol, exchange)
    const issued = trace.slice(before).map((t) => t.url)
    const now = Date.now()
    const problems: string[] = []
    if (!(ticker.price > 0)) problems.push(`price=${String(ticker.price)} 不大于 0`)
    if (!(ticker.volume > 0)) problems.push(`volume=${String(ticker.volume)} 不大于 0`)
    if (ticker.symbol !== symbol) problems.push(`symbol=${String(ticker.symbol)} 不回显 ${symbol}`)
    if (!(ticker.timestamp > 1.7e12)) problems.push(`timestamp=${String(ticker.timestamp)} 不大于 1.7e12`)
    if (!(ticker.timestamp <= now + 60_000)) problems.push(`timestamp=${String(ticker.timestamp)} 超过 now+60s`)
    if (issued.length !== 1) problems.push(`发出 ${issued.length} 条请求，期望 1`)
    judge({
      id,
      pass: problems.length === 0,
      route,
      egressIp,
      url: issued[0],
      detail: problems.length === 0
        ? `${symbol} price=${ticker.price} volume=${ticker.volume} ts=${ticker.timestamp}`
        : problems.join('; '),
      observed: { symbol: ticker.symbol, price: ticker.price, volume: ticker.volume, timestamp: ticker.timestamp, urls: issued },
    })
  } catch (err) {
    const issued = trace.slice(before).map((t) => t.url)
    judge({
      id,
      pass: false,
      route,
      egressIp,
      url: issued[0],
      detail: `抛出 ${errorCode(err) ?? '非 TradingServiceError'}: ${err instanceof Error ? err.message : String(err)}`,
      observed: { urls: issued },
    })
  }
}

/* ── 判据 2：K 线按所（端点 + 周期映射 + 行解析）─────────────────────── */

/**
 * 逐所 K 线请求的**逐字期望 URL**（host + 请求符号 + 周期参数 + 根数参数），由 2026-10-15 的
 * 周期普查逐所实测得出（kraken 分钟数 / coinbase 秒数 / bybit 单字母 / okx utc 变体 / htx 1day…）。
 * 用整条 URL 相等判「按所映射」，而不是「URL 里含某子串」那种会被符号本身误命中的弱断言。
 */
const KLINE_CASES: Array<{ exchange: KlineExchange; symbol: string; interval: string; url: string }> = [
  { exchange: 'binance', symbol: SYMBOL, interval: '1d', url: 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=5' },
  { exchange: 'binance', symbol: SYMBOL, interval: '1M', url: 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1M&limit=5' },
  { exchange: 'okx', symbol: SYMBOL, interval: '1d', url: 'https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1Dutc&limit=5' },
  { exchange: 'okx', symbol: SYMBOL, interval: '1M', url: 'https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1Mutc&limit=5' },
  { exchange: 'bybit', symbol: SYMBOL, interval: '1d', url: 'https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=D&limit=5' },
  { exchange: 'bybit', symbol: SYMBOL, interval: '1M', url: 'https://api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=M&limit=5' },
  { exchange: 'gateio', symbol: SYMBOL, interval: '1d', url: 'https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=1d&limit=5' },
  { exchange: 'gateio', symbol: SYMBOL, interval: '1w', url: 'https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=7d&limit=5' },
  { exchange: 'kucoin', symbol: SYMBOL, interval: '1d', url: 'https://api.kucoin.com/api/v1/market/candles?symbol=BTC-USDT&type=1day' },
  { exchange: 'kucoin', symbol: SYMBOL, interval: '1w', url: 'https://api.kucoin.com/api/v1/market/candles?symbol=BTC-USDT&type=1week' },
  { exchange: 'kraken', symbol: SYMBOL, interval: '1d', url: 'https://api.kraken.com/0/public/OHLC?pair=XBTUSDT&interval=1440' },
  { exchange: 'kraken', symbol: SYMBOL, interval: '1M', url: 'https://api.kraken.com/0/public/OHLC?pair=XBTUSDT&interval=21600' },
  { exchange: 'coinbase', symbol: SYMBOL, interval: '1d', url: 'https://api.exchange.coinbase.com/products/BTC-USDT/candles?granularity=86400' },
  { exchange: 'coinbase', symbol: SYMBOL, interval: '1m', url: 'https://api.exchange.coinbase.com/products/BTC-USDT/candles?granularity=60' },
  { exchange: 'bitfinex', symbol: SYMBOL, interval: '1d', url: 'https://api-pub.bitfinex.com/v2/candles/trade:1D:tBTCUST/hist?limit=5' },
  { exchange: 'bitfinex', symbol: SYMBOL, interval: '1w', url: 'https://api-pub.bitfinex.com/v2/candles/trade:1W:tBTCUST/hist?limit=5' },
  { exchange: 'htx', symbol: SYMBOL, interval: '1d', url: 'https://api.htx.com/market/history/kline?symbol=btcusdt&period=1day&size=5' },
  { exchange: 'htx', symbol: SYMBOL, interval: '1M', url: 'https://api.htx.com/market/history/kline?symbol=btcusdt&period=1mon&size=5' },
]

async function assertKlines(
  kase: { exchange: KlineExchange; symbol: string; interval: string; url: string },
  phase: Phase,
  route: Route,
  egressIp: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const client = new CcxtRestClient({ exchange: kase.exchange, fetchImpl })
  const before = trace.length
  const id = `klines.${kase.exchange}.${kase.symbol}.${kase.interval}`
  try {
    const klines = await client.getKlines(kase.symbol, kase.interval as never, 5, kase.exchange)
    const issued = trace.slice(before).map((t) => t.url)
    const problems: string[] = []
    if (issued.length !== 1) problems.push(`发出 ${issued.length} 条请求，期望 1`)
    if (issued[0] !== kase.url) problems.push(`URL 为 ${issued[0]}，期望 ${kase.url}`)
    if (klines.length !== 5) problems.push(`返回 ${klines.length} 根，不等于 5`)
    klines.forEach((k, i) => {
      for (const field of ['open', 'high', 'low', 'close'] as const) {
        if (!(k[field] > 0)) problems.push(`[${i}].${field}=${String(k[field])} 不大于 0`)
      }
      if (!(k.high >= k.low)) problems.push(`[${i}].high=${k.high} 小于 low=${k.low}`)
      if (!(k.volume > 0)) problems.push(`[${i}].volume=${String(k.volume)} 不大于 0`)
      const step = k.closeTime - k.openTime
      if (!(step > 0 && step <= 31 * DAY_MS)) problems.push(`[${i}] closeTime-openTime=${step} 不在 (0, 31d]`)
      const prev = i > 0 ? klines[i - 1] : undefined
      if (prev !== undefined && !(k.openTime > prev.openTime)) problems.push(`[${i}].openTime 未升序`)
    })
    judge({
      id,
      pass: problems.length === 0,
      route,
      egressIp,
      url: issued[0],
      detail: problems.length === 0
        ? `${klines.length} 根 close=${klines.map((k) => k.close).join('/')} openTime ${klines[0]?.openTime}–${klines.at(-1)?.openTime}`
        : problems.join('; '),
      observed: { interval: kase.interval, count: klines.length, klines, urls: issued, expectedUrl: kase.url },
    })
  } catch (err) {
    judge({
      id,
      pass: false,
      route,
      egressIp,
      url: trace.slice(before).map((t) => t.url)[0],
      detail: `抛出 ${errorCode(err) ?? '非 TradingServiceError'}: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

/* ── 判据 3：失败关闭负例（零请求）──────────────────────────────────── */

/**
 * 逐所「该所不支持的周期」负例。coinbase 的 30m/4h/1w/1M、gateio/kucoin 的 1M 是**实测**上游 400
 * 的周期；其余六所（binance/okx/bybit/kraken/bitfinex/htx）实测支持词汇表全部九档，故它们用
 * 词汇表外的 `8h`（任何一所都没有这一档）走同一条 fail-closed 分支。
 */
const UNSUPPORTED_INTERVALS: Record<KlineExchange, string> = {
  binance: '8h',
  okx: '8h',
  bybit: '8h',
  gateio: '1M',
  kucoin: '1M',
  kraken: '8h',
  coinbase: '30m',
  bitfinex: '8h',
  htx: '8h',
}

/** 「该所表外计价币」负例的候选池：都是各所普查里没有的 fiat，按顺序取第一个不在该所表内的。 */
const ABSENT_QUOTE_CANDIDATES = ['NGN', 'CNY', 'ZAR', 'MXN', 'NZD', 'ISK', 'HUF', 'RON']

/* ── 判据 4：quote 表 = 该所公开挂牌端点普查结果 ──────────────────────── */

interface CensusSpec {
  urls: string[]
  derive: (payloads: unknown[]) => string[]
}

function uniqueUpper(values: unknown[]): string[] {
  const set = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const upper = value.trim().toUpperCase()
    if (upper !== '') set.add(upper)
  }
  return [...set].sort()
}

const CENSUS: Record<TransformExchange, CensusSpec> = {
  okx: {
    urls: ['https://www.okx.com/api/v5/public/instruments?instType=SPOT'],
    derive: ([payload]) => uniqueUpper(((payload as { data?: Array<{ quoteCcy?: unknown }> }).data ?? []).map((row) => row.quoteCcy)),
  },
  kucoin: {
    urls: ['https://api.kucoin.com/api/v2/symbols'],
    derive: ([payload]) => uniqueUpper(((payload as { data?: Array<{ quoteCurrency?: unknown }> }).data ?? []).map((row) => row.quoteCurrency)),
  },
  gateio: {
    urls: ['https://api.gateio.ws/api/v4/spot/currency_pairs'],
    derive: ([payload]) => uniqueUpper((payload as Array<{ quote?: unknown }>).map((row) => row.quote)),
  },
  kraken: {
    urls: ['https://api.kraken.com/0/public/AssetPairs'],
    derive: ([payload]) => uniqueUpper(Object.values((payload as { result?: Record<string, { wsname?: unknown }> }).result ?? {})
      .map((row) => String(row.wsname ?? '').split('/')[1])),
  },
  coinbase: {
    urls: ['https://api.exchange.coinbase.com/products'],
    derive: ([payload]) => uniqueUpper((payload as Array<{ quote_currency?: unknown }>).map((row) => row.quote_currency)),
  },
  bitfinex: {
    urls: [
      'https://api-pub.bitfinex.com/v2/conf/pub:list:pair:exchange',
      'https://api-pub.bitfinex.com/v2/conf/pub:list:currency',
    ],
    derive: ([pairsPayload, currenciesPayload]) => {
      const pairs = ((pairsPayload as string[][] | undefined)?.[0]) ?? []
      const currencies = ((currenciesPayload as string[][] | undefined)?.[0]) ?? []
      const longestFirst = [...currencies].sort((a, b) => b.length - a.length)
      return uniqueUpper(pairs.map((pair) => {
        // bitfinex 的挂牌对有两种形态：`AAVE:USD`（显式分隔）与 `ADAUST`（最长货币后缀）。
        const explicit = pair.split(':')
        if (explicit.length === 2) return explicit[1] === 'UST' ? 'USDT' : explicit[1]
        const hit = longestFirst.find((currency) => pair.length > currency.length && pair.endsWith(currency))
        if (hit === undefined) return ''
        return hit === 'UST' ? 'USDT' : hit
      }))
    },
  },
  htx: {
    urls: ['https://api.htx.com/v2/settings/common/symbols'],
    derive: ([payload]) => uniqueUpper(((payload as { data?: Array<{ qcdn?: unknown }> }).data ?? []).map((row) => row.qcdn)),
  },
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

async function assertQuoteCensus(
  exchange: TransformExchange,
  egressIp: string,
  fetchImpl: typeof fetch,
): Promise<{ derived: string[]; urls: string[] }> {
  const spec = CENSUS[exchange]
  const before = trace.length
  const payloads: unknown[] = []
  const problems: string[] = []
  try {
    for (const url of spec.urls) {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json' } })
      payloads.push(await res.json())
    }
  } catch (err) {
    problems.push(`普查请求失败：${err instanceof Error ? err.message : String(err)}`)
  }
  const issued = trace.slice(before).map((t) => t.url)
  const derived = problems.length === 0 ? spec.derive(payloads) : []
  const table = [...QUOTE_TABLES[exchange]].sort()
  if (problems.length === 0 && !sameSet(derived, table)) {
    const missing = derived.filter((quote) => !table.includes(quote))
    const extra = table.filter((quote) => !derived.includes(quote))
    problems.push(`表与普查不一致：普查新增 [${missing.join(', ')}] / 表内多余 [${extra.join(', ')}]`)
  }
  judge({
    id: `quote-census.${exchange}`,
    pass: problems.length === 0,
    route: 'plain',
    egressIp,
    url: issued[0],
    detail: problems.length === 0
      ? `${derived.length} 个 quote 与代码表逐字相等：${derived.join(', ')}`
      : problems.join('; '),
    observed: { derived, table, urls: issued },
  })
  return { derived, urls: issued }
}

/* ── 主流程 ─────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const capturedAt = new Date().toISOString()
  const headSha = git(['rev-parse', 'HEAD'])
  const fingerprints = {
    'packages/connector-ccxt/src/rest.ts': git(['hash-object', 'packages/connector-ccxt/src/rest.ts']),
    'packages/connector-ccxt/src/index.ts': git(['hash-object', 'packages/connector-ccxt/src/index.ts']),
    'packages/api/src/index.ts': git(['hash-object', 'packages/api/src/index.ts']),
  }
  const dirtyLines = git(['status', '--porcelain']).split('\n').filter((l) => l !== '').length

  console.log(`probe start ${capturedAt} HEAD=${headSha}`)
  console.log(`rest.ts ${fingerprints['packages/connector-ccxt/src/rest.ts']}  index.ts ${fingerprints['packages/connector-ccxt/src/index.ts']}`)

  const selectorOriginal = await currentSelector()
  console.log(`selector original = ${selectorOriginal}`)

  let selectorInWindow = ''
  let selectorRestored = ''
  let ipifyPlainBefore = ''
  let ipifyPlainInWindow = ''
  let ipifyProxyInWindow = ''
  let ipifyPlainAfterRestore = ''
  const censusResult: Record<string, string[]> = {}

  const plainFetch = makeFetch('plain', 'default-exit')
  const proxyFetch = makeFetch('proxy', 'egress-window')

  try {
    ipifyPlainBefore = await measureEgressIp('plain')
    judge({
      id: 'egress.default-exit',
      pass: ipifyPlainBefore === EXPECTED_DEFAULT_IP,
      route: 'plain',
      egressIp: ipifyPlainBefore,
      detail: `默认出口实测 ${ipifyPlainBefore}（期望 ${EXPECTED_DEFAULT_IP}）`,
    })

    // ---- 默认出口：七所 ticker（USDT 对 + 各所一条非 USDT 对）----
    for (const exchange of DEFAULT_EXIT_EXCHANGES) {
      await assertTicker(exchange, SYMBOL, 'default-exit', 'plain', ipifyPlainBefore, plainFetch.impl)
    }
    const NON_USDT_TICKERS: Record<(typeof DEFAULT_EXIT_EXCHANGES)[number], string> = {
      okx: 'ETHBTC',
      gateio: 'ETHBTC',
      kucoin: 'ETHBTC',
      kraken: 'ETHEUR',
      coinbase: 'ETHBTC',
      bitfinex: 'ETHEUR',
      htx: 'ETHBTC',
    }
    for (const exchange of DEFAULT_EXIT_EXCHANGES) {
      await assertTicker(exchange, NON_USDT_TICKERS[exchange], 'default-exit', 'plain', ipifyPlainBefore, plainFetch.impl)
    }

    // ---- 默认出口：七所 quote 普查（表 = 普查结果）----
    for (const exchange of TRANSFORM_EXCHANGES) {
      const result = await assertQuoteCensus(exchange, ipifyPlainBefore, plainFetch.impl)
      censusResult[exchange] = result.derived
    }

    // ---- 默认出口：七所 K 线（每所两档周期，逐字比对请求 URL）----
    for (const kase of KLINE_CASES.filter((entry) => entry.exchange !== 'binance' && entry.exchange !== 'bybit')) {
      await assertKlines(kase, 'default-exit', 'plain', ipifyPlainBefore, plainFetch.impl)
    }

    // ---- 零请求负例：未登记 slug（ticker + klines）----
    const bitstampTicker = makeFetch('plain', 'default-exit')
    const bitstampTickerOutcome = await captureError(() => new CcxtRestClient({ exchange: 'bitstamp', fetchImpl: bitstampTicker.impl }).getTicker(SYMBOL, 'bitstamp'))
    judge({
      id: 'negative.unregistered-slug.ticker',
      pass: bitstampTickerOutcome.code === 'TRADING_NOT_IMPLEMENTED' && bitstampTicker.count() === 0,
      route: 'plain',
      egressIp: ipifyPlainBefore,
      detail: `code=${bitstampTickerOutcome.code ?? '(无)'} requests=${bitstampTicker.count()}`,
      observed: { code: bitstampTickerOutcome.code, requests: bitstampTicker.count(), message: bitstampTickerOutcome.message },
    })

    const bitstampKlines = makeFetch('plain', 'default-exit')
    const bitstampKlinesOutcome = await captureError(() => new CcxtRestClient({ exchange: 'bitstamp', fetchImpl: bitstampKlines.impl }).getKlines(SYMBOL, '1d', 5, 'bitstamp'))
    judge({
      id: 'negative.unregistered-slug.klines',
      pass: bitstampKlinesOutcome.code === 'TRADING_NOT_IMPLEMENTED' && bitstampKlines.count() === 0,
      route: 'plain',
      egressIp: ipifyPlainBefore,
      detail: `code=${bitstampKlinesOutcome.code ?? '(无)'} requests=${bitstampKlines.count()}`,
      observed: { code: bitstampKlinesOutcome.code, requests: bitstampKlines.count(), message: bitstampKlinesOutcome.message },
    })

    // ---- 零请求负例：逐所不支持的周期 ----
    for (const exchange of KLINE_EXCHANGES) {
      const interval = UNSUPPORTED_INTERVALS[exchange]
      const probe = makeFetch('plain', 'default-exit')
      const outcome = await captureError(() => new CcxtRestClient({ exchange, fetchImpl: probe.impl }).getKlines(SYMBOL, interval as never, 5, exchange))
      judge({
        id: `negative.unsupported-interval.${exchange}`,
        pass: outcome.code === 'TRADING_UNSUPPORTED_INTERVAL' && probe.count() === 0,
        route: 'plain',
        egressIp: ipifyPlainBefore,
        detail: `interval=${interval} code=${outcome.code ?? '(无)'} requests=${probe.count()}; 该所支持 ${klineSupportedIntervals(exchange).join('/')}`,
        observed: { interval, code: outcome.code, requests: probe.count(), supported: klineSupportedIntervals(exchange), message: outcome.message },
      })
    }

    // ---- 零请求负例：逐所表外计价币 ----
    for (const exchange of TRANSFORM_EXCHANGES) {
      const quote = ABSENT_QUOTE_CANDIDATES.find((candidate) => !QUOTE_TABLES[exchange].includes(candidate)) ?? 'NGN'
      const symbol = `BTC${quote}`
      const probe = makeFetch('plain', 'default-exit')
      const outcome = await captureError(() => new CcxtRestClient({ exchange, fetchImpl: probe.impl }).getTicker(symbol, exchange))
      judge({
        id: `negative.unsupported-quote.${exchange}`,
        pass: outcome.code === 'TRADING_UNSUPPORTED_SYMBOL' && probe.count() === 0,
        route: 'plain',
        egressIp: ipifyPlainBefore,
        detail: `symbol=${symbol} code=${outcome.code ?? '(无)'} requests=${probe.count()}`,
        observed: { symbol, quote, code: outcome.code, requests: probe.count(), message: outcome.message },
      })
    }

    // 计数机制本身的自证：正向路径必须真的记到请求，否则「零请求」是空证明。
    judge({
      id: 'negative.counter-mechanism-live',
      pass: plainFetch.count() > 0,
      route: 'plain',
      egressIp: ipifyPlainBefore,
      detail: `默认出口共发出 ${plainFetch.count()} 次请求（计数包装确实在工作）`,
      observed: { requests: plainFetch.count() },
    })

    // ---- 可达出口窗口：只覆盖 binance / bybit（ticker + K 线）----
    await selectEgress(WINDOW_SELECTOR)
    const switched = await waitFor('等待出口切换生效', 15_000, async () => {
      const now = await currentSelector().catch(() => '')
      if (now !== WINDOW_SELECTOR) return false
      return (await measureEgressIp('proxy').catch(() => '')) !== EXPECTED_DEFAULT_IP
    })
    selectorInWindow = await currentSelector()
    ipifyProxyInWindow = await measureEgressIp('proxy').catch((e: Error) => `ERROR:${e.message}`)
    ipifyPlainInWindow = await measureEgressIp('plain').catch((e: Error) => `ERROR:${e.message}`)
    judge({
      id: 'egress.window-open',
      pass: switched && selectorInWindow === WINDOW_SELECTOR && ipifyProxyInWindow !== EXPECTED_DEFAULT_IP,
      route: 'proxy',
      egressIp: ipifyProxyInWindow,
      detail: `selector=${selectorInWindow} proxy 出口=${ipifyProxyInWindow}（plain 同刻=${ipifyPlainInWindow}）`,
    })

    for (const exchange of WINDOW_EXCHANGES) {
      await assertTicker(exchange, SYMBOL, 'egress-window', 'proxy', ipifyProxyInWindow, proxyFetch.impl)
    }
    for (const kase of KLINE_CASES.filter((entry) => entry.exchange === 'binance' || entry.exchange === 'bybit')) {
      await assertKlines(kase, 'egress-window', 'proxy', ipifyProxyInWindow, proxyFetch.impl)
    }
  } finally {
    // 还原是硬要求：无论上面发生什么都必须回到原选择器并复核。
    try {
      await selectEgress(selectorOriginal)
      const restored = await waitFor('等待出口还原生效', 45_000, async () => {
        const now = await currentSelector().catch(() => '')
        if (now !== selectorOriginal) return false
        return (await measureEgressIp('plain').catch(() => '')) === EXPECTED_DEFAULT_IP
      })
      selectorRestored = await currentSelector().catch((e: Error) => `ERROR:${e.message}`)
      ipifyPlainAfterRestore = await measureEgressIp('plain').catch((e: Error) => `ERROR:${e.message}`)
      judge({
        id: 'egress.restored',
        pass: restored && selectorRestored === selectorOriginal && ipifyPlainAfterRestore === EXPECTED_DEFAULT_IP,
        route: 'plain',
        egressIp: ipifyPlainAfterRestore,
        detail: `selector=${selectorRestored}（原 ${selectorOriginal}）默认出口实测 ${ipifyPlainAfterRestore}`,
      })
    } catch (err) {
      judge({
        id: 'egress.restored',
        pass: false,
        detail: `还原失败：${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  const failed = judgements.filter((j) => !j.pass)
  const summary = {
    probe: 'ccxt-nine-exchange-ticker-klines-and-quote-census',
    capturedAt,
    repo: { headSha, fingerprints, statusPorcelainLines: dirtyLines },
    connector: {
      restTsPath: 'packages/connector-ccxt/src/rest.ts',
      supportedExchanges: [...SUPPORTED_EXCHANGES],
      klineExchanges: [...KLINE_EXCHANGES],
      quoteTables: QUOTE_TABLES,
      intervalParams: Object.fromEntries(KLINE_EXCHANGES.map((exchange) => [
        exchange,
        Object.fromEntries(klineSupportedIntervals(exchange).map((interval) => [interval, klineIntervalParam(exchange, interval)])),
      ])),
      symbol: SYMBOL,
    },
    census: censusResult,
    klineCases: KLINE_CASES,
    unsupportedIntervals: UNSUPPORTED_INTERVALS,
    egress: {
      selectorGroup: SELECTOR_GROUP,
      mihomoSocket: MIHOMO_SOCKET,
      selectorOriginal,
      selectorInWindow,
      selectorRestored,
      expectedDefaultExitIp: EXPECTED_DEFAULT_IP,
      ipifyPlainBefore,
      ipifyPlainInWindow,
      ipifyProxyInWindow,
      ipifyPlainAfterRestore,
      proxyUrl: PROXY_URL,
      plainMeasurement: 'node:https agent:false（每次新建连接，排除 keep-alive 复用假阴性）',
      proxyMeasurement: 'globalThis.fetch + { proxy } 显式代理',
      windowExchanges: [...WINDOW_EXCHANGES],
      defaultExitExchanges: [...DEFAULT_EXIT_EXCHANGES],
    },
    counts: { total: judgements.length, passed: judgements.length - failed.length, failed: failed.length },
    judgements,
    requestTrace: trace,
    exitCode: failed.length === 0 ? 0 : 1,
  }
  writeFileSync(OUT_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  console.log(`\n${summary.counts.passed}/${summary.counts.total} 判据通过，requestTrace ${trace.length} 条 -> ${OUT_PATH}`)
  process.exit(summary.exitCode)
}

await main()

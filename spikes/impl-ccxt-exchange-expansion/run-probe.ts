/**
 * CCXT 九所 ticker 直连分支 · 连接器级真实网络探针（Phase 2）。
 *
 * 直接 import `packages/connector-ccxt/src/rest.ts` 的真实 `CcxtRestClient`，对九所 ticker、
 * binance K 线、三条负例做真实网络调用并逐条断言；不满足即 `process.exit(1)`。
 *
 * 出口：本探针自己驱动本机 mihomo 控制器（切换/还原 `Proxies` 组），因此**单条命令即可复跑**：
 *   - 七个所在**默认出口**跑（`plain` 路由：不带 proxy 参数，由 TUN 走默认出口）；
 *   - binance / bybit / klines 在 SG 窗口内经**显式 proxy 参数**跑（`proxy` 路由，等价 `curl -x`），
 *     因为默认出口对这两所是 451 / 403（见本目录 EVIDENCE.md §3）；
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
  SUPPORTED_EXCHANGES,
  TradingServiceError,
} from '../../packages/connector-ccxt/src/rest.ts'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const OUT_PATH = fileURLToPath(new URL('./probe-summary.json', import.meta.url))
const MIHOMO_SOCKET = process.env.DSH_PROBE_MIHOMO_SOCKET
  ?? '/var/run/clash-verge-service/users/501/verge-mihomo.sock'
const PROXY_URL = process.env.DSH_PROBE_PROXY ?? 'http://127.0.0.1:7890'
const SELECTOR_GROUP = 'Proxies'
const WINDOW_SELECTOR = process.env.DSH_PROBE_WINDOW_SELECTOR ?? 'SG'
const IPIFY = 'https://api.ipify.org'
/** Phase 1 实测的本机默认出口 IP（美国节点）。换机器用 DSH_PROBE_EXPECT_DEFAULT_IP 覆盖。 */
const EXPECTED_DEFAULT_IP = process.env.DSH_PROBE_EXPECT_DEFAULT_IP ?? '216.195.208.136'
/** 七所在默认出口跑（ticker 面）；binance/bybit 与 K 线在可达出口窗口内跑。 */
const DEFAULT_EXIT_EXCHANGES = ['okx', 'gateio', 'kucoin', 'kraken', 'coinbase', 'bitfinex', 'htx'] as const
const WINDOW_EXCHANGES = ['binance', 'bybit'] as const
const SYMBOL = 'BTCUSDT'

type Route = 'plain' | 'proxy'
type Phase = 'default-exit' | 'egress-window' | 'preflight' | 'restore'

interface TraceEntry {
  phase: Phase
  route: Route
  url: string
  status: number
}

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

/** 计数 fetch：证明负例「零请求」。proxy 路由显式带 proxy 参数（Node 25 原生支持），plain 路由不带。 */
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
 * 测出口必须排除「连接复用」这个变量，否则还原是否真的生效说不清。
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

/** 代理路由的出口 IP：显式 proxy。该路由下连接无论新建还是复用都从窗口出口出去，复用不改变结论。 */
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

/** 一条 ticker 判据：真实网络取价 + 四条数值/回显断言。 */
async function assertTicker(
  exchange: string,
  phase: Phase,
  route: Route,
  egressIp: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const client = new CcxtRestClient({ exchange, fetchImpl })
  const before = trace.length
  try {
    const ticker = await client.getTicker(SYMBOL, exchange)
    const issued = trace.slice(before).map((t) => t.url)
    const now = Date.now()
    const problems: string[] = []
    if (!(ticker.price > 0)) problems.push(`price=${String(ticker.price)} 不大于 0`)
    if (!(ticker.volume > 0)) problems.push(`volume=${String(ticker.volume)} 不大于 0`)
    if (ticker.symbol !== SYMBOL) problems.push(`symbol=${String(ticker.symbol)} 不回显 ${SYMBOL}`)
    if (!(ticker.timestamp > 1.7e12)) problems.push(`timestamp=${String(ticker.timestamp)} 不大于 1.7e12`)
    if (!(ticker.timestamp <= now + 60_000)) problems.push(`timestamp=${String(ticker.timestamp)} 超过 now+60s`)
    judge({
      id: `ticker.${exchange}`,
      pass: problems.length === 0,
      route,
      egressIp,
      url: issued[0],
      detail: problems.length === 0
        ? `price=${ticker.price} volume=${ticker.volume} symbol=${ticker.symbol} ts=${ticker.timestamp}`
        : problems.join('; '),
      observed: { price: ticker.price, volume: ticker.volume, symbol: ticker.symbol, timestamp: ticker.timestamp, urls: issued },
    })
  } catch (err) {
    const issued = trace.slice(before).map((t) => t.url)
    judge({
      id: `ticker.${exchange}`,
      pass: false,
      route,
      egressIp,
      url: issued[0],
      detail: `抛出 ${errorCode(err) ?? '非 TradingServiceError'}: ${err instanceof Error ? err.message : String(err)}`,
      observed: { urls: issued },
    })
  }
}

/** binance K 线判据：5 根，每根 OHLC > 0 且 high >= low。 */
async function assertKlines(egressIp: string, fetchImpl: typeof fetch): Promise<void> {
  const client = new CcxtRestClient({ exchange: 'binance', fetchImpl })
  const before = trace.length
  try {
    const klines = await client.getKlines(SYMBOL, '1d', 5)
    const issued = trace.slice(before).map((t) => t.url)
    const problems: string[] = []
    if (klines.length !== 5) problems.push(`返回 ${klines.length} 根，不等于 5`)
    klines.forEach((k, i) => {
      for (const field of ['open', 'high', 'low', 'close'] as const) {
        if (!(k[field] > 0)) problems.push(`[${i}].${field}=${String(k[field])} 不大于 0`)
      }
      if (!(k.high >= k.low)) problems.push(`[${i}].high=${k.high} 小于 low=${k.low}`)
      if (!(k.volume > 0)) problems.push(`[${i}].volume=${String(k.volume)} 不大于 0`)
    })
    judge({
      id: 'klines.binance.BTCUSDT.1d',
      pass: problems.length === 0,
      route: 'proxy',
      egressIp,
      url: issued[0],
      detail: problems.length === 0
        ? `${klines.length} 根，收盘价 ${klines.map((k) => k.close).join('/')}，openTime ${klines[0]?.openTime}–${klines.at(-1)?.openTime}`
        : problems.join('; '),
      observed: { count: klines.length, klines, urls: issued },
    })
  } catch (err) {
    judge({
      id: 'klines.binance.BTCUSDT.1d',
      pass: false,
      route: 'proxy',
      egressIp,
      url: trace.slice(before).map((t) => t.url)[0],
      detail: `抛出 ${errorCode(err) ?? '非 TradingServiceError'}: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
}

async function main(): Promise<void> {
  const capturedAt = new Date().toISOString()
  const headSha = git(['rev-parse', 'HEAD'])
  const fingerprints = {
    'packages/connector-ccxt/src/rest.ts': git(['hash-object', 'packages/connector-ccxt/src/rest.ts']),
    'packages/connector-ccxt/src/index.ts': git(['hash-object', 'packages/connector-ccxt/src/index.ts']),
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

  // plainFetch 的请求全部发生在窗口打开**之前**，因此连接池里不可能有窗口期的旧连接（
  // 这也正是「七个所在默认出口跑」这条设计顺带消除的污染面）。
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

    for (const exchange of DEFAULT_EXIT_EXCHANGES) {
      await assertTicker(exchange, 'default-exit', 'plain', ipifyPlainBefore, plainFetch.impl)
    }

    // 负例一：未登记 slug（ticker + klines 两处都必须在任何 fetch 之前拒绝）。
    const bitstampTicker = makeFetch('plain', 'default-exit')
    const bitstampTickerClient = new CcxtRestClient({ exchange: 'bitstamp', fetchImpl: bitstampTicker.impl })
    const bitstampTickerOutcome = await captureError(() => bitstampTickerClient.getTicker(SYMBOL, 'bitstamp'))
    judge({
      id: 'negative.unregistered-slug.ticker',
      pass: bitstampTickerOutcome.code === 'TRADING_NOT_IMPLEMENTED' && bitstampTicker.count() === 0,
      route: 'plain',
      egressIp: ipifyPlainBefore,
      detail: `code=${bitstampTickerOutcome.code ?? '(无)'} requests=${bitstampTicker.count()}`,
      observed: { code: bitstampTickerOutcome.code, requests: bitstampTicker.count(), message: bitstampTickerOutcome.message },
    })

    const bitstampKlines = makeFetch('plain', 'default-exit')
    const bitstampKlinesClient = new CcxtRestClient({ exchange: 'bitstamp', fetchImpl: bitstampKlines.impl })
    const bitstampKlinesOutcome = await captureError(() => bitstampKlinesClient.getKlines(SYMBOL, '1d', 5))
    judge({
      id: 'negative.unregistered-slug.klines',
      pass: bitstampKlinesOutcome.code === 'TRADING_NOT_IMPLEMENTED' && bitstampKlines.count() === 0,
      route: 'plain',
      egressIp: ipifyPlainBefore,
      detail: `code=${bitstampKlinesOutcome.code ?? '(无)'} requests=${bitstampKlines.count()}`,
      observed: { code: bitstampKlinesOutcome.code, requests: bitstampKlines.count(), message: bitstampKlinesOutcome.message },
    })

    // 负例二：已登记所名 okx 的 K 线面（形参面已撤，裁决对象是客户端默认所名）。
    const okxKlines = makeFetch('plain', 'default-exit')
    const okxKlinesClient = new CcxtRestClient({ exchange: 'okx', fetchImpl: okxKlines.impl })
    const okxKlinesOutcome = await captureError(() => okxKlinesClient.getKlines(SYMBOL, '1d', 5))
    judge({
      id: 'negative.okx-default-exchange.klines',
      pass: okxKlinesOutcome.code === 'TRADING_NOT_IMPLEMENTED' && okxKlines.count() === 0,
      route: 'plain',
      egressIp: ipifyPlainBefore,
      detail: `code=${okxKlinesOutcome.code ?? '(无)'} requests=${okxKlines.count()}`,
      observed: { code: okxKlinesOutcome.code, requests: okxKlines.count(), message: okxKlinesOutcome.message },
    })

    // 负例三：quote 表外的符号（BTCJPY）在七条形态变换分支之一（gateio）本地拒绝。
    const btcjpy = makeFetch('plain', 'default-exit')
    const btcjpyClient = new CcxtRestClient({ exchange: 'gateio', fetchImpl: btcjpy.impl })
    const btcjpyOutcome = await captureError(() => btcjpyClient.getTicker('BTCJPY', 'gateio'))
    judge({
      id: 'negative.unsupported-quote.BTCJPY',
      pass: btcjpyOutcome.code === 'TRADING_UNSUPPORTED_SYMBOL' && btcjpy.count() === 0,
      route: 'plain',
      egressIp: ipifyPlainBefore,
      detail: `code=${btcjpyOutcome.code ?? '(无)'} requests=${btcjpy.count()}`,
      observed: { code: btcjpyOutcome.code, requests: btcjpy.count(), message: btcjpyOutcome.message },
    })

    // 计数机制本身的自证：正向路径必须真的记到请求，否则「零请求」是空证明。
    judge({
      id: 'negative.counter-mechanism-live',
      pass: plainFetch.count() > 0,
      route: 'plain',
      egressIp: ipifyPlainBefore,
      detail: `默认出口七所共发出 ${plainFetch.count()} 次请求（计数包装确实在工作）`,
      observed: { requests: plainFetch.count() },
    })

    // ---- 可达出口窗口：只覆盖 binance / bybit / klines ----
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
      await assertTicker(exchange, 'egress-window', 'proxy', ipifyProxyInWindow, proxyFetch.impl)
    }
    await assertKlines(ipifyProxyInWindow, proxyFetch.impl)
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
    probe: 'ccxt-nine-exchange-ticker-and-klines',
    capturedAt,
    repo: { headSha, fingerprints, statusPorcelainLines: dirtyLines },
    connector: {
      restTsPath: 'packages/connector-ccxt/src/rest.ts',
      supportedExchanges: [...SUPPORTED_EXCHANGES],
      klineExchanges: [...KLINE_EXCHANGES],
      symbol: SYMBOL,
    },
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

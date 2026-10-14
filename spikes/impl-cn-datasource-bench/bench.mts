/**
 * 中国 A 股公开行情源「时延 + 并发」现场实测。
 *
 * 复现（仓库根）：
 *   ./node_modules/.bin/tsx spikes/impl-cn-datasource-bench/bench.mts              # 全部 5 个阶段
 *   ./node_modules/.bin/tsx spikes/impl-cn-datasource-bench/bench.mts --only=latency
 *
 * 取数穿过**实现**：packages/connector-tencent/src/rest.ts 与
 * packages/connector-eastmoney/src/rest.ts 的源码类（tsx 直跑 .ts，不用 lib/ 构建产物，
 * 避免与并发 build 竞争）。连接器只负责 URL 拼装与解析；传输、计时、落盘由 transport.mts 接管，
 * 连接器自带的 headers（含东财的 Referer）在替身 fetch 里被丢弃，统一改为最小 `Mozilla/5.0`。
 */
import { join } from 'node:path'
import { TencentRestClient } from '../../packages/connector-tencent/src/rest.ts'
import { EastmoneyRestClient } from '../../packages/connector-eastmoney/src/rest.ts'
import { httpGet, makeFetch, newAgent, type CallRecord, type SocketTiming } from './transport.mts'
import {
  BATCH_100, BATCH_8, COVERAGE_CN, COVERAGE_HK, OUT_DIR, PACING_MS, P1_SYMBOL,
  ROUND_GAP_MS, round, sleep, summarizeRound, writeOut, writeRaw,
} from './common.mts'

type Source = 'tencent' | 'eastmoney'
type Market = 'cn' | 'hk'
type Agent = ReturnType<typeof newAgent> | false

/* ------------------------------------------------------------------ */
/* 采样原语                                                             */
/* ------------------------------------------------------------------ */

interface Sample {
  readonly i: number
  /** 连接器调用往返（含解析）。 */
  readonly wallMs: number
  /** 传输层 request→body 读完。 */
  readonly httpMs: number | null
  readonly status: number
  /** 连接器未抛错即为 true。 */
  readonly ok: boolean
  readonly error: string | null
  readonly timing: SocketTiming | null
  readonly bytes: number
  readonly sha256: string | null
}

function toSample(i: number, wallMs: number, rec: CallRecord | null, error: string | null): Sample {
  return {
    i,
    wallMs: round(wallMs, 1) as number,
    httpMs: rec === null ? null : round(rec.timing.totalMs, 1),
    status: rec?.status ?? 0,
    ok: error === null,
    error,
    timing: rec?.timing ?? null,
    bytes: rec?.bodyBytes ?? 0,
    sha256: rec?.sha256 ?? null,
  }
}

async function sampleOne(i: number, jar: CallRecord[], op: () => Promise<unknown>): Promise<Sample> {
  const before = jar.length
  const t0 = performance.now()
  let error: string | null = null
  try {
    await op()
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  }
  const wallMs = performance.now() - t0
  return toSample(i, wallMs, jar[before] ?? null, error)
}

function makeClient(source: Source, market: Market, agent: Agent, jar: CallRecord[]): any {
  const fetchImpl = makeFetch(agent, jar)
  return source === 'tencent'
    ? new TencentRestClient(market, { fetchImpl })
    : new EastmoneyRestClient({ fetchImpl, market })
}

/** 路径定义：每个路径恰好 1 次上游请求。 */
type PathId = 'P1' | 'P2' | 'P3' | 'P4'
const PATH_LABEL: Record<PathId, string> = {
  P1: '单标的报价',
  P2: '批量报价 8 只',
  P3: '日 K 100 根',
  P4: '分钟 K（腾讯 5m / 东财 1m）',
}

function pathOp(source: Source, client: any, pathId: PathId): () => Promise<unknown> {
  switch (pathId) {
    case 'P1': return () => client.getTicker(P1_SYMBOL)
    case 'P2': return () => client.getTickers([...BATCH_8])
    case 'P3': return () => client.getKlines(P1_SYMBOL, '1d', 100)
    case 'P4':
      return source === 'tencent'
        ? () => client.getKlines(P1_SYMBOL, '5m', 100)
        : () => client.getKlines(P1_SYMBOL, '1m', 100)
  }
}

function summarizeSamples(samples: readonly Sample[]): Record<string, unknown> {
  const wall = samples.filter((s) => s.ok).map((s) => s.wallMs)
  const http = samples.filter((s) => s.httpMs !== null).map((s) => s.httpMs as number)
  const dns = samples.map((s) => s.timing?.dnsMs).filter((v): v is number => typeof v === 'number')
  const tcp = samples.map((s) => s.timing?.tcpMs).filter((v): v is number => typeof v === 'number')
  const tls = samples.map((s) => s.timing?.tlsMs).filter((v): v is number => typeof v === 'number')
  const conn = samples.map((s) => s.timing?.connMs).filter((v): v is number => typeof v === 'number')
  const server = samples.map((s) => s.timing?.serverMs).filter((v): v is number => typeof v === 'number')
  const reused = samples.filter((s) => s.timing?.reused === true).length
  const statusDist: Record<string, number> = {}
  for (const s of samples) {
    const key = s.status === 0 ? (s.error === null ? 'no-request' : 'network-error') : String(s.status)
    statusDist[key] = (statusDist[key] ?? 0) + 1
  }
  return {
    samples: samples.length,
    ok: samples.filter((s) => s.ok).length,
    failed: samples.filter((s) => !s.ok).length,
    reusedConnections: reused,
    errors: samples.filter((s) => s.error !== null).map((s) => ({ i: s.i, error: s.error })),
    statusDist,
    wallMs: summarizeRound(wall),
    /** 传输层 request→body 读完。 */
    httpMs: summarizeRound(http),
    dnsMs: summarizeRound(dns),
    tcpMs: summarizeRound(tcp),
    tlsMs: summarizeRound(tls),
    /** request→连接可用（含 DNS+TCP+TLS）。 */
    connMs: summarizeRound(conn),
    /** 连接可用→响应头（TTFB 的服务端段）。 */
    serverMs: summarizeRound(server),
    bytes: summarizeRound(samples.map((s) => s.bytes)),
  }
}

/* ------------------------------------------------------------------ */
/* 阶段 1：时延                                                          */
/* ------------------------------------------------------------------ */

interface LatencyGroup {
  source: Source
  pathId: PathId
  label: string
  mode: 'keep-alive' | 'cold'
  summary: Record<string, unknown>
  sampleDetail: Sample[]
  rawFile: string | null
  rawSha256: string | null
  rawBytes: number
  /** 首个样本单独列出：keep-alive 组里它就是「建立连接」的那次。 */
  firstSampleMs: number | null
  steadyState: Record<string, unknown> | null
}

async function phaseLatency(sources: readonly Source[]): Promise<{ groups: LatencyGroup[]; requests: Record<Source, number>; p1Warm: Record<Source, Sample[]> }> {
  const groups: LatencyGroup[] = []
  const requests: Record<Source, number> = { tencent: 0, eastmoney: 0 }
  const p1Warm: Record<Source, Sample[]> = { tencent: [], eastmoney: [] }

  for (const source of sources) {
    for (const [mode, agentFactory, gap] of [
      ['keep-alive', () => newAgent(8), PACING_MS],
      ['cold', () => false as Agent, PACING_MS],
    ] as const) {
      const pathIds: PathId[] = mode === 'keep-alive' ? ['P1', 'P2', 'P3', 'P4'] : ['P1', 'P3']
      for (const pathId of pathIds) {
        const agent = agentFactory()
        const jar: CallRecord[] = []
        const client = makeClient(source, 'cn', agent, jar)
        const samples: Sample[] = []
        const op = pathOp(source, client, pathId)
        for (let i = 0; i < 20; i += 1) {
          samples.push(await sampleOne(i, jar, op))
          await sleep(gap)
        }
        requests[source] += jar.length
        if (agent !== false) agent.destroy()

        const lastGood = [...jar].reverse().find((r) => r.error === null && r.status === 200) ?? null
        let rawFile: string | null = null
        if (lastGood) {
          const ext = source === 'tencent' ? (pathId === 'P1' || pathId === 'P2' ? 'gbk' : 'json') : 'json'
          const name = `${source}-${pathId}-${mode}.${ext}`
          writeRaw(name, lastGood.body)
          rawFile = `raw/${name}`
        }
        if (pathId === 'P1' && mode === 'keep-alive') p1Warm[source] = samples
        const okSamples = samples.filter((s) => s.ok)
        groups.push({
          source,
          pathId,
          label: PATH_LABEL[pathId],
          mode,
          summary: summarizeSamples(samples),
          sampleDetail: samples,
          rawFile,
          rawSha256: lastGood?.sha256 ?? null,
          rawBytes: lastGood?.bodyBytes ?? 0,
          firstSampleMs: samples.find((s) => s.ok)?.wallMs ?? null,
          steadyState: summarizeRound(samples.slice(1).filter((s) => s.ok).map((s) => s.wallMs)),
        })
        console.log(`[latency] ${source} ${mode} ${pathId} ${PATH_LABEL[pathId]} ok=${okSamples.length}/20 bytes=${lastGood?.bodyBytes ?? 0}`)
      }
    }
  }
  return { groups, requests, p1Warm }
}

/* ------------------------------------------------------------------ */
/* 阶段 2：并发                                                          */
/* ------------------------------------------------------------------ */

interface ConcurrencyRound {
  source: Source
  concurrency: number
  requests: number
  summary: Record<string, unknown>
  statusDist: Record<string, number>
  wallMsTotal: number
}

async function phaseConcurrency(sources: readonly Source[], p1Warm: Record<Source, Sample[]>): Promise<{ rounds: ConcurrencyRound[]; requests: Record<Source, number> }> {
  const rounds: ConcurrencyRound[] = []
  const requests: Record<Source, number> = { tencent: 0, eastmoney: 0 }

  for (const source of sources) {
    // c=1 轮复用 latency 阶段的 keep-alive P1 样本（Lead 裁决：同一批样本，不重复发请求）。
    const base = p1Warm[source] ?? []
    if (base.length > 0) {
      const summary = summarizeSamples(base)
      rounds.push({
        source,
        concurrency: 1,
        requests: base.length,
        summary,
        statusDist: summary.statusDist as Record<string, number>,
        wallMsTotal: round(base.reduce((a, s) => a + s.wallMs, 0), 1) as number,
      })
      console.log(`[concurrency] ${source} c=1 复用 latency keep-alive P1 样本 ${base.length} 次`)
    }

    for (const concurrency of [4, 8, 16]) {
      const agent = newAgent(concurrency)
      // 每个在飞请求各自一个 jar + client（共用同一个 Agent），这样「本次请求的记录」不会串台。
      const slots = Array.from({ length: 16 }, () => {
        const jar: CallRecord[] = []
        return { jar, client: makeClient(source, 'cn', agent, jar) }
      })
      const t0 = performance.now()
      const samples = await Promise.all(slots.map(async (slot, i) => {
        const start = performance.now()
        let error: string | null = null
        try {
          await slot.client.getTicker(P1_SYMBOL)
        } catch (err) {
          error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        }
        return toSample(i, performance.now() - start, slot.jar[0] ?? null, error)
      }))
      const wallTotal = performance.now() - t0
      agent.destroy()
      requests[source] += slots.reduce((a, s) => a + s.jar.length, 0)
      const summary = summarizeSamples(samples)
      rounds.push({
        source,
        concurrency,
        requests: samples.length,
        summary,
        statusDist: summary.statusDist as Record<string, number>,
        wallMsTotal: round(wallTotal, 1) as number,
      })
      console.log(`[concurrency] ${source} c=${concurrency} ok=${summary.ok}/${samples.length} status=${JSON.stringify(summary.statusDist)} wall=${round(wallTotal, 1)}ms`)
      await sleep(ROUND_GAP_MS)
    }
  }
  return { rounds, requests }
}

/* ------------------------------------------------------------------ */
/* 阶段 3：品种覆盖                                                      */
/* ------------------------------------------------------------------ */

interface CoverageRow {
  source: Source
  market: Market
  input: string
  requestsMade: number
  status: number
  verdict: '取到' | '取不到' | '返回形态异常'
  detail: string
  rawLine: string | null
  rawFile: string | null
  bytes: number
  sha256: string | null
  /** 传输层错误（非 null = 连接已建立但上游未回 HTTP 响应 / 连接被重置等）。 */
  transportError: string | null
  timing: SocketTiming | null
  reused: boolean | null
}

function firstLine(rec: CallRecord): string {
  const text = rec.body.toString('utf8')
  return text.split('\n').find((l) => l.trim().length > 0)?.slice(0, 240) ?? ''
}

async function phaseCoverage(sources: readonly Source[], maxConsecutiveNetFailures: number): Promise<{ rows: CoverageRow[]; requests: Record<Source, number>; aborted: string | null }> {
  const rows: CoverageRow[] = []
  const requests: Record<Source, number> = { tencent: 0, eastmoney: 0 }
  let aborted: string | null = null
  let consecutiveNetFailures = 0

  const probe = async (source: Source, market: Market, input: string): Promise<void> => {
    if (aborted !== null) return
    const agent = newAgent(4)
    const jar: CallRecord[] = []
    const client = makeClient(source, market, agent,jar)
    let detail = ''
    let verdict: CoverageRow['verdict'] = '取不到'
    try {
      const t = await client.getTicker(input)
      detail = `${String(t.name)} ${String(t.price)} ${String(t.currency ?? '')} symbol=${String(t.symbol)}`
      verdict = '取到'
    } catch (err) {
      detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    }
    agent.destroy()
    requests[source] += jar.length
    const rec = jar[0] ?? null
    const rawFile = rec === null ? null : (() => {
      const name = `coverage-${source}-${market}-${input.replace(/[^\w.-]/g, '_')}.${rec.body[0] === 0x7b || rec.body[0] === 0x5b ? 'json' : 'raw'}`
      writeRaw(name, rec.body)
      return `raw/${name}`
    })()
    rows.push({
      source, market, input,
      requestsMade: jar.length,
      status: rec?.status ?? 0,
      verdict,
      detail,
      rawLine: rec === null ? null : firstLine(rec),
      rawFile,
      bytes: rec?.bodyBytes ?? 0,
      sha256: rec?.sha256 ?? null,
      transportError: rec?.error ?? null,
      timing: rec?.timing ?? null,
      reused: rec?.timing.reused ?? null,
    })
    console.log(`[coverage] ${source}/${market} ${input} -> ${verdict} req=${jar.length} ${detail.slice(0, 90)}`)
    // 早停：连续 N 次「发出了请求但没拿到 HTTP 响应」视为该源对本机进入不可用状态，不再继续打。
    if (rec !== null && rec.error !== null && rec.status === 0) {
      consecutiveNetFailures += 1
      if (consecutiveNetFailures >= maxConsecutiveNetFailures) {
        aborted = `${source}: 连续 ${consecutiveNetFailures} 次传输层失败（${rec.error}），按预算保护停止后续抽样`
        console.log(`[coverage] !!! ${aborted}`)
      }
    } else {
      consecutiveNetFailures = 0
    }
    await sleep(PACING_MS)
  }

  if (sources.includes('tencent')) {
    for (const input of COVERAGE_CN) await probe('tencent', 'cn', input)
    await probe('tencent', 'hk', COVERAGE_HK)
  }
  if (sources.includes('eastmoney')) {
    for (const input of COVERAGE_CN) await probe('eastmoney', 'cn', input)
    await probe('eastmoney', 'hk', COVERAGE_HK)
  }

  // 腾讯对北交所没有连接器入口（normalizeCnSymbol 只认 sh|sz），补一次裸 wire 探针，
  // 只回答「上游对 bj 前缀到底有没有这一行」，不代表连接器行为。
  if (sources.includes('tencent') && aborted === null) {
    const bjAgent = newAgent(2)
    const bjRec = await httpGet('https://qt.gtimg.cn/q=bj835185', { agent: bjAgent })
    bjAgent.destroy()
    requests.tencent += 1
    writeRaw('probe-tencent-bj835185.raw', bjRec.body)
    rows.push({
      source: 'tencent', market: 'cn', input: 'bj835185（裸 wire 探针，绕过连接器）',
      requestsMade: 1,
      status: bjRec.status,
      verdict: bjRec.body.length > 60 ? '取到' : '返回形态异常',
      detail: `raw wire bj835185：${firstLine(bjRec)}`,
      rawLine: firstLine(bjRec),
      rawFile: 'raw/probe-tencent-bj835185.raw',
      bytes: bjRec.bodyBytes,
      sha256: bjRec.sha256,
      transportError: bjRec.error,
      timing: bjRec.timing,
      reused: bjRec.timing.reused,
    })
    console.log(`[coverage] 腾讯裸 wire bj835185 bytes=${bjRec.bodyBytes} ${firstLine(bjRec).slice(0, 120)}`)
  }

  return { rows, requests, aborted }
}

/* ------------------------------------------------------------------ */
/* 阶段 4：分钟 K 真实上限（裸 URL，绕过实现里的 min(limit,800) 夹取）        */
/* ------------------------------------------------------------------ */

interface BoundRow {
  source: Source
  url: string
  requested: string
  status: number
  rows: number | null
  days: number | null
  firstBar: string | null
  lastBar: string | null
  upstreamCode: unknown
  msg: unknown
  bytes: number
  sha256: string
  rawFile: string
  note: string
}

function countDay(rows: Array<unknown>, fmt: 'compact' | 'dashed'): { days: number; first: string; last: string } {
  const set = new Set<string>()
  let first = ''
  let last = ''
  for (const row of rows) {
    const line = Array.isArray(row) ? String(row[0]) : String(row)
    const t = fmt === 'compact' ? line.slice(0, 8) : line.slice(0, 10)
    if (!first) first = line
    last = line
    set.add(t)
  }
  return { days: set.size, first, last }
}

async function phaseBounds(mode: 'main' | 'm5'): Promise<{ rows: BoundRow[]; requests: Record<Source, number> }> {
  const rows: BoundRow[] = []
  const requests: Record<Source, number> = { tencent: 0, eastmoney: 0 }
  const agent = newAgent(2)

  const tencentProbe = async (tf: string, count: number): Promise<void> => {
    const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=sh600519,${tf},,${count}`
    const rec = await httpGet(url, { agent })
    requests.tencent += 1
    const name = `bound-tencent-${tf}-${count}.json`
    writeRaw(name, rec.body)
    let parsed: any = null
    try { parsed = JSON.parse(rec.body.toString('utf8')) } catch { /* 非 JSON 保留 null */ }
    const market = parsed?.data?.sh600519
    const arr: unknown[] = Array.isArray(market?.[tf]) ? market[tf] : []
    const counted = countDay(arr, 'compact')
    rows.push({
      source: 'tencent', url, requested: `${tf} count=${count}`, status: rec.status,
      rows: arr.length, days: arr.length === 0 ? null : counted.days,
      firstBar: counted.first || null, lastBar: counted.last || null,
      upstreamCode: parsed?.code ?? null, msg: parsed?.msg ?? null,
      bytes: rec.bodyBytes, sha256: rec.sha256, rawFile: `raw/${name}`,
      note: arr.length === 0 ? '无行' : '',
    })
    console.log(`[bounds] tencent ${tf} count=${count} -> rows=${arr.length} code=${String(parsed?.code)} ${counted.first || ''}..${counted.last || ''}`)
    await sleep(PACING_MS)
  }

  const emProbe = async (ndays: number): Promise<void> => {
    const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=1.600519&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=${ndays}&iscr=0`
    const rec = await httpGet(url, { agent })
    requests.eastmoney += 1
    const name = `bound-eastmoney-trends-ndays${ndays}.json`
    writeRaw(name, rec.body)
    let parsed: any = null
    try { parsed = JSON.parse(rec.body.toString('utf8')) } catch { /* 非 JSON 保留 null */ }
    const arr: unknown[] = Array.isArray(parsed?.data?.trends) ? parsed.data.trends : []
    const counted = countDay(arr, 'dashed')
    rows.push({
      source: 'eastmoney', url, requested: `trends2 ndays=${ndays}`, status: rec.status,
      rows: arr.length, days: arr.length === 0 ? null : counted.days,
      firstBar: counted.first || null, lastBar: counted.last || null,
      upstreamCode: parsed?.rc ?? null, msg: parsed?.msg ?? null,
      bytes: rec.bodyBytes, sha256: rec.sha256, rawFile: `raw/${name}`,
      note: arr.length === 0 ? '无行' : '',
    })
    console.log(`[bounds] eastmoney trends2 ndays=${ndays} -> rows=${arr.length} days=${counted.days} rc=${String(parsed?.rc)} ${counted.first || ''}..${counted.last || ''}`)
    await sleep(PACING_MS)
  }

  if (mode === 'main') {
    await tencentProbe('m1', 800)
    await tencentProbe('m1', 1000)
    await tencentProbe('m1', 2000)
    await tencentProbe('m5', 800)
    await emProbe(5)
    await emProbe(10)
  } else {
    await tencentProbe('m5', 1000)
    await tencentProbe('m5', 2000)
    // 第二个北交所代码：区分「835185 自身停牌」与「腾讯对北交所整体不刷新」
    const bjUrl = 'https://qt.gtimg.cn/q=bj832982'
    const bjRec = await httpGet(bjUrl, { agent })
    requests.tencent += 1
    writeRaw('bound-tencent-bj832982.raw', bjRec.body)
    const bjText = new TextDecoder('gbk').decode(bjRec.body)
    const bjLine = bjText.split('\n').find((l) => l.includes('v_bj832982')) ?? ''
    const bjFields = (/v_bj832982="([^"]*)"/.exec(bjLine)?.[1] ?? '').split('~')
    rows.push({
      source: 'tencent', url: bjUrl, requested: '北交所 bj832982 裸 wire', status: bjRec.status,
      rows: bjFields.length > 1 ? 1 : 0, days: null,
      firstBar: bjFields[30] ?? null, lastBar: bjFields[1] ?? null,
      upstreamCode: null, msg: null,
      bytes: bjRec.bodyBytes, sha256: bjRec.sha256, rawFile: 'raw/bound-tencent-bj832982.raw',
      note: `字段数=${bjFields.length} 最新价=${bjFields[3] ?? '—'} 成交量=${bjFields[6] ?? '—'} 行情时间=${bjFields[30] ?? '—'}`,
    })
    console.log(`[bounds] tencent bj832982 -> 字段数=${bjFields.length} 价=${bjFields[3] ?? ''} 量=${bjFields[6] ?? ''} 时间=${bjFields[30] ?? ''}`)
  }
  agent.destroy()
  return { rows, requests }
}

/* ------------------------------------------------------------------ */
/* 阶段 5：一次请求 N 只 vs N 次单请求 + 批量加长断点                       */
/* ------------------------------------------------------------------ */

interface BatchRow {
  source: Source
  kind: 'batch' | 'sequential'
  n: number
  requests: number
  wallMs: number
  rowsReturned: number
  bytes: number
  status: number
  detail: string
}

async function phaseBatch(sources: readonly Source[]): Promise<{ rows: BatchRow[]; requests: Record<Source, number> }> {
  const rows: BatchRow[] = []
  const requests: Record<Source, number> = { tencent: 0, eastmoney: 0 }

  for (const source of sources) {
    const agent = newAgent(2)

    // 一次请求 N 只：N 逐步加长到 100（或失败）
    for (const n of [8, 24, 60, 100]) {
      const jar: CallRecord[] = []
      const client = makeClient(source, 'cn', agent, jar)
      const symbols = BATCH_100.slice(0, n)
      const t0 = performance.now()
      let rowsReturned = 0
      let detail = ''
      try {
        const result = await client.getTickers([...symbols])
        rowsReturned = Object.keys(result).length
        detail = `返回 ${rowsReturned}/${n}`
      } catch (err) {
        detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      }
      const wallMs = performance.now() - t0
      requests[source] += jar.length
      const rec = jar[0] ?? null
      rows.push({
        source, kind: 'batch', n, requests: jar.length,
        wallMs: round(wallMs, 1) as number, rowsReturned, bytes: rec?.bodyBytes ?? 0,
        status: rec?.status ?? 0, detail,
      })
      console.log(`[batch] ${source} 一次取 ${n} 只 -> 上游请求 ${jar.length} / ${round(wallMs, 1)}ms / ${rec?.bodyBytes ?? 0}B / ${detail}`)
      await sleep(PACING_MS)
    }

    // N 次单请求（同一批 8 只标的）
    {
      const jar: CallRecord[] = []
      const client = makeClient(source, 'cn', agent, jar)
      const t0 = performance.now()
      let okCount = 0
      for (const symbol of BATCH_8) {
        try { await client.getTicker(symbol); okCount += 1 } catch { /* 逐只失败单独计入 okCount */ }
      }
      const wallMs = performance.now() - t0
      requests[source] += jar.length
      rows.push({
        source, kind: 'sequential', n: BATCH_8.length, requests: jar.length,
        wallMs: round(wallMs, 1) as number, rowsReturned: okCount,
        bytes: jar.reduce((a, r) => a + r.bodyBytes, 0), status: jar[0]?.status ?? 0,
        detail: `${okCount}/${BATCH_8.length} 只成功`,
      })
      console.log(`[batch] ${source} N 次单请求 ${BATCH_8.length} 只 -> 上游请求 ${jar.length} / ${round(wallMs, 1)}ms`)
      await sleep(PACING_MS)
    }

    agent.destroy()
  }
  return { rows, requests }
}

/* ------------------------------------------------------------------ */
/* 阶段 6：东财 push2 受限后的收尾复测（预算内，最多 5 次请求）               */
/* ------------------------------------------------------------------ */

const MISSING_EASTMONEY: ReadonlyArray<{ input: string; market: Market }> = [
  { input: '159869.SZ', market: 'cn' },   // 深市 ETF
  { input: '000001.SH', market: 'cn' },   // 上证指数
  { input: '000300.SH', market: 'cn' },   // 沪深300
  { input: '835185.BJ', market: 'cn' },   // 北交所
  { input: '00700.HK', market: 'hk' },    // 港股（对照）
]

async function phaseReprobe(): Promise<{ rows: CoverageRow[]; requests: Record<Source, number>; note: string }> {
  const rows: CoverageRow[] = []
  const requests: Record<Source, number> = { tencent: 0, eastmoney: 0 }
  let note = 'push2 (push2.eastmoney.com) 直连复测'
  let push2Dead = false
  let usedMirror = false

  for (const [idx, item] of MISSING_EASTMONEY.entries()) {
    // 首个 item 先走产品默认域；若它仍 hang up，则把剩余 item 改走 push2his 镜像域。
    const useMirror = push2Dead
    const agent = newAgent(2)
    const jar: CallRecord[] = []
    const client = new EastmoneyRestClient({
      fetchImpl: makeFetch(agent, jar),
      market: item.market,
      ...(useMirror ? { baseUrl: 'https://push2his.eastmoney.com' } : {}),
    }) as any
    let detail = ''
    let verdict: CoverageRow['verdict'] = '取不到'
    try {
      const t = await client.getTicker(item.input)
      detail = `${String(t.name)} ${String(t.price)} ${String(t.currency ?? '')} symbol=${String(t.symbol)}`
      verdict = '取到'
    } catch (err) {
      detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    }
    agent.destroy()
    requests.eastmoney += jar.length
    const rec = jar[0] ?? null
    const netDead = rec !== null && rec.error !== null && rec.status === 0
    if (netDead && !useMirror) {
      push2Dead = true
      usedMirror = true
    }
    const rawFile = rec === null ? null : (() => {
      const name = `reprobe-${useMirror ? 'mirror' : 'push2'}-${item.input.replace(/[^\w.-]/g, '_')}.json`
      writeRaw(name, rec.body)
      return `raw/${name}`
    })()
    rows.push({
      source: 'eastmoney', market: item.market, input: item.input,
      requestsMade: jar.length,
      status: rec?.status ?? 0,
      verdict,
      detail: `[${useMirror ? 'push2his 镜像' : 'push2 默认'}] ${detail}`,
      rawLine: rec === null ? null : firstLine(rec),
      rawFile,
      bytes: rec?.bodyBytes ?? 0,
      sha256: rec?.sha256 ?? null,
      transportError: rec?.error ?? null,
      timing: rec?.timing ?? null,
      reused: rec?.timing.reused ?? null,
    })
    console.log(`[reprobe ${idx + 1}/${MISSING_EASTMONEY.length}] ${useMirror ? 'mirror' : 'push2'} ${item.input} -> ${verdict} req=${jar.length} ${detail.slice(0, 80)}`)
    if (netDead && useMirror) note = 'push2 与 push2his 镜像均不可用'
    await sleep(PACING_MS)
  }
  if (usedMirror) note = 'push2 直连仍 hang up；其余项改走 push2his 镜像域（非产品默认域，已在每行标注）'
  return { rows, requests, note }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='))
  const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',')) : new Set(['latency', 'concurrency', 'coverage', 'bounds', 'batch'])
  const sourceArg = process.argv.find((a) => a.startsWith('--source='))
  const sources = (sourceArg ? sourceArg.slice('--source='.length).split(',') : ['tencent', 'eastmoney']) as Source[]
  const tagArg = process.argv.find((a) => a.startsWith('--tag='))
  const tag = tagArg ? tagArg.slice('--tag='.length) : ''
  const startedAt = new Date().toISOString()
  const results: Record<string, unknown> = { startedAt, phases: {}, requests: { tencent: 0, eastmoney: 0 } }

  console.log(`== impl-cn-datasource-bench ${startedAt} phases=${[...only].join(',')} sources=${sources.join(',')} tag=${tag || '-'} ==`)

  let r1: { groups: LatencyGroup[]; requests: Record<Source, number>; p1Warm: Record<Source, Sample[]> } | null = null
  if (only.has('latency')) {
    r1 = await phaseLatency(sources)
    results.phases = { ...(results.phases as object), latency: { groups: r1.groups } }
    results.requests = { tencent: (results.requests as any).tencent + r1.requests.tencent, eastmoney: (results.requests as any).eastmoney + r1.requests.eastmoney }
    writeOut('latency.json', { groups: r1.groups })
    await sleep(ROUND_GAP_MS)
  }

  if (only.has('concurrency')) {
    // c=1 复用 latency 的 keep-alive P1 样本：单独跑本阶段时从 out/latency.json 读回。
    let p1Warm: Record<Source, Sample[]> = { tencent: [], eastmoney: [] }
    if (only.has('latency')) {
      p1Warm = (r1 as { p1Warm: Record<Source, Sample[]> }).p1Warm
    } else {
      const { readFileSync } = await import('node:fs')
      const prior = JSON.parse(readFileSync(join(OUT_DIR, 'latency.json'), 'utf8')) as { groups: LatencyGroup[] }
      for (const source of ['tencent', 'eastmoney'] as Source[]) {
        p1Warm[source] = prior.groups.find((g) => g.source === source && g.mode === 'keep-alive' && g.pathId === 'P1')?.sampleDetail ?? []
      }
    }
    const r = await phaseConcurrency(sources, p1Warm)
    results.phases = { ...(results.phases as object), concurrency: { rounds: r.rounds, note: 'c=1 轮与 latency keep-alive P1 组为同一批样本' } }
    results.requests = { tencent: (results.requests as any).tencent + r.requests.tencent, eastmoney: (results.requests as any).eastmoney + r.requests.eastmoney }
    writeOut('concurrency.json', { rounds: r.rounds })
    await sleep(ROUND_GAP_MS)
  }

  if (only.has('coverage')) {
    const r = await phaseCoverage(sources, 3)
    results.phases = { ...(results.phases as object), [tag === '' ? 'coverage' : `coverage${tag}`]: { rows: r.rows, aborted: r.aborted } }
    results.requests = { tencent: (results.requests as any).tencent + r.requests.tencent, eastmoney: (results.requests as any).eastmoney + r.requests.eastmoney }
    writeOut(`coverage${tag}.json`, { rows: r.rows, aborted: r.aborted })
    await sleep(ROUND_GAP_MS)
  }

  if (only.has('bounds')) {
    const r = await phaseBounds('main')
    results.phases = { ...(results.phases as object), bounds: { rows: r.rows } }
    results.requests = { tencent: (results.requests as any).tencent + r.requests.tencent, eastmoney: (results.requests as any).eastmoney + r.requests.eastmoney }
    writeOut('bounds.json', { rows: r.rows })
    await sleep(ROUND_GAP_MS)
  }

  if (only.has('bounds5m')) {
    const r = await phaseBounds('m5')
    results.phases = { ...(results.phases as object), bounds5m: { rows: r.rows } }
    results.requests = { tencent: (results.requests as any).tencent + r.requests.tencent, eastmoney: (results.requests as any).eastmoney + r.requests.eastmoney }
    writeOut('bounds5m.json', { rows: r.rows })
  }

  if (only.has('batch')) {
    const r = await phaseBatch(sources)
    results.phases = { ...(results.phases as object), batch: { rows: r.rows } }
    results.requests = { tencent: (results.requests as any).tencent + r.requests.tencent, eastmoney: (results.requests as any).eastmoney + r.requests.eastmoney }
    writeOut('batch.json', { rows: r.rows })
  }

  if (only.has('reprobe')) {
    const r = await phaseReprobe()
    results.phases = { ...(results.phases as object), reprobe: { rows: r.rows, note: r.note } }
    results.requests = { tencent: (results.requests as any).tencent + r.requests.tencent, eastmoney: (results.requests as any).eastmoney + r.requests.eastmoney }
    writeOut('reprobe.json', { rows: r.rows, note: r.note })
  }

  const finishedAt = new Date().toISOString()
  // 与已有 results.json 合并（分阶段重跑时不丢前面阶段的数据）。
  let prior: { phases?: Record<string, unknown>; requests?: Record<Source, number>; runs?: unknown[] } = {}
  try {
    const { readFileSync } = await import('node:fs')
    prior = JSON.parse(readFileSync(join(OUT_DIR, 'results.json'), 'utf8')) as typeof prior
  } catch { /* 首次运行没有旧文件 */ }
  const merged = {
    ...results,
    phases: { ...(prior.phases ?? {}), ...(results.phases as object) },
    requests: {
      tencent: (prior.requests?.tencent ?? 0) + (results.requests as any).tencent,
      eastmoney: (prior.requests?.eastmoney ?? 0) + (results.requests as any).eastmoney,
    },
    runs: [...(Array.isArray(prior.runs) ? prior.runs : []), { startedAt, finishedAt, phases: [...only], sources, tag, requests: results.requests }],
    finishedAt,
  }
  writeOut('results.json', merged)
  console.log(`== 上游请求计数（本次） tencent=${(results.requests as any).tencent} eastmoney=${(results.requests as any).eastmoney} ==`)
  console.log(`== 上游请求计数（累计） tencent=${merged.requests.tencent} eastmoney=${merged.requests.eastmoney} ==`)
  console.log(`== done ${finishedAt} ==`)
}

await main()

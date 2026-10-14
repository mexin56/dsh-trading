/**
 * 腾讯报价端点**批量取数**（getTickers）的真实网络探针（2026-10-14）。
 *
 * 做法：直接跑产品代码本体 `packages/connector-tencent/src/rest.ts`（node 类型剥离，非另写一份
 * 解析），只把 fetch 包一层——真实请求照走，同时**计数**并把响应原始字节落盘。因此
 * 「请求次数 = 1」不是推断，而是包装层实测的 URL 条数；行解析、GBK 解码、跳过语义与线上同路径。
 *
 * 运行（仓库根）：node spikes/impl-tencent-quote-batch/r0-live-probe.mjs
 * 产物：r0-raw-cn-batch.gbk / r0-raw-hk-batch.gbk / r0-raw-cn-single.gbk / r0-result.json，stdout 打印
 *       wire → 名称/价格 对照与每阶段上游请求条数。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { normalizeCnSymbol, normalizeHkSymbol, TencentRestClient } from '../../packages/connector-tencent/src/rest.ts'

/** cn 入参：一只股票 + 一只 ETF + 一只指数 + 一个**未收录**代码（验证整行缺席被跳过）。 */
const CN_SYMBOLS = ['600519.SH', '000001.SZ', '159869.SZ', '000688.SH', '999999.SZ']
/** hk 入参：两只股票 + 指数（指数 wire 是 r_hkHSI，验证大写键归一）。 */
const HK_SYMBOLS = ['00700.HK', '02714.HK', 'HSI']

const log = []
const out = (...args) => { console.log(...args); log.push(args.join(' ')) }
const sha16 = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16)

/** 计数 + 落盘的 fetch：真实网络请求照走，响应字节留档，并把同一 Response 交回产品代码。 */
function probeFetch(rawFile) {
  const urls = []
  const impl = async (input, init) => {
    const url = String(input)
    urls.push(url)
    const res = await globalThis.fetch(url, init)
    const bytes = new Uint8Array(await res.arrayBuffer())
    writeFileSync(new URL(`./${rawFile}`, import.meta.url), bytes)
    out(`  [fetch] ${url} → HTTP ${res.status} ${bytes.length} B sha256:${sha16(bytes)} → ${rawFile}`)
    return new Response(bytes, { status: res.status, statusText: res.statusText, headers: res.headers })
  }
  return { impl, urls }
}

const wireOf = (market, symbol) =>
  market === 'hk' ? `r_hk${normalizeHkSymbol(symbol)}` : normalizeCnSymbol(symbol)

// ---- 阶段 1：cn 批量（5 入参 → 1 请求） ----
out('== cn 批量 getTickers ==')
const cnProbe = probeFetch('r0-raw-cn-batch.gbk')
const cnClient = new TencentRestClient('cn', { fetchImpl: cnProbe.impl })
const cnTickers = await cnClient.getTickers(CN_SYMBOLS)
for (const input of CN_SYMBOLS) {
  const ticker = cnTickers[input]
  out(
    ticker === undefined
      ? `  ${input.padEnd(11)} wire=${wireOf('cn', input).padEnd(10)} → 跳过（未收录/无行）`
      : `  ${input.padEnd(11)} wire=${wireOf('cn', input).padEnd(10)} → ${ticker.name} ${ticker.price} ${ticker.currency} ts=${ticker.timestamp} symbol=${ticker.symbol}`,
  )
}
out(`  入参 ${CN_SYMBOLS.length} 个 / 返回 ${Object.keys(cnTickers).length} 个 / 上游请求 ${cnProbe.urls.length} 次`)

// ---- 阶段 2：hk 批量（3 入参 → 1 请求） ----
out('== hk 批量 getTickers ==')
const hkProbe = probeFetch('r0-raw-hk-batch.gbk')
const hkClient = new TencentRestClient('hk', { fetchImpl: hkProbe.impl })
const hkTickers = await hkClient.getTickers(HK_SYMBOLS)
for (const input of HK_SYMBOLS) {
  const ticker = hkTickers[input]
  out(
    ticker === undefined
      ? `  ${input.padEnd(9)} wire=${wireOf('hk', input).padEnd(11)} → 跳过（未收录/无行）`
      : `  ${input.padEnd(9)} wire=${wireOf('hk', input).padEnd(11)} → ${ticker.name} ${ticker.price} ${ticker.currency} ts=${ticker.timestamp} symbol=${ticker.symbol}`,
  )
}
out(`  入参 ${HK_SYMBOLS.length} 个 / 返回 ${Object.keys(hkTickers).length} 个 / 上游请求 ${hkProbe.urls.length} 次`)

// ---- 阶段 3：单标的路径回归（重构后同一行读数须与批量一致） ----
out('== 单标的 getTicker 回归（重构后单/批量读数一致） ==')
const singleProbe = probeFetch('r0-raw-cn-single.gbk')
const single = await new TencentRestClient('cn', { fetchImpl: singleProbe.impl }).getTicker('600519.SH')
const batch = cnTickers['600519.SH']
// 两次真实请求之间行情会跳动（价格按 tick 复读，价格相等不是等价判据）；判据是同一行解析出的
// 名称/币种/规范形 symbol 一致，价格差只作盘中跳动量记录。
const sameRow = single.name === batch?.name && single.symbol === batch?.symbol
out(`  getTicker('600519.SH') → ${single.name} ${single.price} / 上游请求 ${singleProbe.urls.length} 次`)
out(`  批量同标的          → ${batch?.name} ${batch?.price} / 同一行(名称+规范形 symbol 一致)=${sameRow} 价格跳动=${(single.price - (batch?.price ?? 0)).toFixed(2)}`)

// ---- 阶段 4：空入参不发请求 ----
const idleProbe = probeFetch('r0-raw-never-written.gbk')
const empty = await new TencentRestClient('cn', { fetchImpl: idleProbe.impl }).getTickers([])
out(`== 空入参 == → ${JSON.stringify(empty)} / 上游请求 ${idleProbe.urls.length} 次`)

// ---- 阶段 5：离线重放（注入刚落盘的原始字节，零网络）----
// 让证据可复跑：不给网络也能从原始字节重放同一条解析路径，结果须与在线一致。
const replay = (rawFile) => {
  const bytes = new Uint8Array(readFileSync(new URL(`./${rawFile}`, import.meta.url)))
  let calls = 0
  const impl = async () => { calls += 1; return new Response(bytes, { headers: { 'content-type': 'text/html; charset=GBK' } }) }
  return { impl, calls: () => calls }
}
const cnReplay = replay('r0-raw-cn-batch.gbk')
const hkReplay = replay('r0-raw-hk-batch.gbk')
const cnOffline = await new TencentRestClient('cn', { fetchImpl: cnReplay.impl }).getTickers(CN_SYMBOLS)
const hkOffline = await new TencentRestClient('hk', { fetchImpl: hkReplay.impl }).getTickers(HK_SYMBOLS)
const same = (a, b) => Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every((k) => a[k]?.name === b[k]?.name && a[k]?.price === b[k]?.price && a[k]?.symbol === b[k]?.symbol)
out(`== 离线重放（注入落盘字节，零网络）==`)
out(`  cn 与在线一致=${same(cnTickers, cnOffline)}（离线注入 fetch 被调用 ${cnReplay.calls()} 次，零真实网络）`)
out(`  hk 与在线一致=${same(hkTickers, hkOffline)}（离线注入 fetch 被调用 ${hkReplay.calls()} 次，零真实网络）`)

const summary = {
  probedAt: new Date().toISOString(),
  offlineReplay: { cnMatchesLive: same(cnTickers, cnOffline), hkMatchesLive: same(hkTickers, hkOffline) },
  cn: {
    requested: CN_SYMBOLS,
    returnedKeys: Object.keys(cnTickers),
    upstreamRequests: cnProbe.urls.length,
    upstreamUrl: cnProbe.urls[0],
    rows: Object.fromEntries(Object.entries(cnTickers).map(([k, v]) => [k, { name: v.name, price: v.price, symbol: v.symbol, timestamp: v.timestamp }])),
  },
  hk: {
    requested: HK_SYMBOLS,
    returnedKeys: Object.keys(hkTickers),
    upstreamRequests: hkProbe.urls.length,
    upstreamUrl: hkProbe.urls[0],
    rows: Object.fromEntries(Object.entries(hkTickers).map(([k, v]) => [k, { name: v.name, price: v.price, symbol: v.symbol, timestamp: v.timestamp }])),
  },
  singlePath: { price: single.price, batchPrice: batch?.price, sameRow, upstreamRequests: singleProbe.urls.length },
  emptyInput: { result: empty, upstreamRequests: idleProbe.urls.length },
}
writeFileSync(new URL('./r0-result.json', import.meta.url), `${JSON.stringify(summary, null, 2)}\n`)
writeFileSync(new URL('./r0-stdout.txt', import.meta.url), `${log.join('\n')}\n`)

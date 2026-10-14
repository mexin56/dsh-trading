/**
 * 探针 p3：报价路径不可用 → 用同源分钟序列（push2his trends2）派生快照，并证明降级态自身有界。
 *
 * 复现：
 *   pnpm --filter @dshtrading/connector-eastmoney build    # 探针 import 构建产物 lib/rest.js
 *   node spikes/impl-eastmoney-quote-endpoint/p3-derive-fallback.mjs
 *
 * 只用真实网络，无桩：包一层 globalThis.fetch 记录每次请求的 URL，直接调构建产物的
 * EastmoneyRestClient.getTicker / getTickers。按顺序取证：
 *   1. 报价快照路径（push2 ulist.np/get）确实不可用——这是降级的前提；若它已恢复，
 *      探针打印 SKIP 并退出 0（故障没了，本探针不适用，不是失败）。
 *   2. cn 五只、hk 两只逐只 getTicker，派生快照与同刻腾讯 qt.gtimg.cn（GBK 解码）对照
 *      name/price/prevClose。
 *   3. 降级态请求上界：同一 secid 第二次取价（换一种写法）命中 60s TTL 缓存，trends2 请求数不增；
 *      新客户端跑 getTickers（批量失败 → 逐只派生）后再来一次批量，trends2 请求数为 0。
 *   4. 全量请求计数表 + 派生快照自洽性（changePercent 由同一对 price/prevClose 推出、无 volume）。
 *
 * 判定口径的说明：派生价是**最近一根已完成分钟 bar 的收盘**。盘后（本探针取证时点）它与腾讯
 * 的收盘价逐位一致，故价格容差取 0.005；盘中重跑时它最多滞后一分钟，可能相差一个最小变动价位，
 * 那时同一行会打印 Δ 而不是判 OK——读输出时按「Δ 与当时是否处于交易时段」判断。
 * hk 用两条独立锚点判价格：腾讯 `r_hk` wire（连接器 hk 报价实际用法——`hkXXXXX` 是 K 线形态、
 * 行布局不同，拿它当报价 wire 会得到与自身高低价矛盾的假读数）与东财日 K 收盘（另一端点，含
 * 16:00 后收市竞价）。
 * 预期不满足即 exit 1。
 */
import { EastmoneyRestClient } from '../../packages/connector-eastmoney/lib/rest.js'

const QUOTE_PATH = '/api/qt/ulist.np/get'
const TRENDS_PATH = '/api/qt/stock/trends2/get'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)'
const PRICE_TOL = 0.005

const failures = []
const check = (ok, label) => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures.push(label)
}
/** 对照源取不到（出口经 fake-IP 代理，会偶发空回）→ 本轮 SKIP 该对照：不算失败，但结论里逐条列出。 */
const skips = []
const skip = (label) => {
  console.log(`  SKIP ${label}`)
  skips.push(label)
}

// --- 请求记账：所有出网请求都经过这层包装（探针自己的对照请求也在内，按 URL 过滤区分） ---
const calls = []
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  calls.push(String(input))
  return realFetch(input, init)
}
const countSince = (from, needle) => calls.slice(from).filter((u) => u.includes(needle)).length

/** 腾讯报价（GBK 编码；cn/hk 的 v_xxx="…" 里 [1]=名称 [3]=最新价 [4]=昨收）。 */
async function tencentQuote(code) {
  try {
    const res = await fetch(`https://qt.gtimg.cn/q=${code}`)
    const text = new TextDecoder('gbk').decode(await res.arrayBuffer())
    const quoted = text.slice(text.indexOf('"') + 1, text.lastIndexOf('"'))
    const f = quoted.split('~')
    return { name: f[1], price: Number(f[3]), prevClose: Number(f[4]) }
  } catch {
    return null // 对照取不到：本轮 SKIP 对照，不判失败（也不掩盖连接器侧的断言）
  }
}

/** 东财日 K 最后收盘（与 trends2 不同端点；hk 收市竞价成交计入其中）。 */
async function dailyClose(secid) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&lmt=1&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' } })
    const body = await res.json()
    const row = body.data?.klines?.[body.data.klines.length - 1]
    return row === undefined ? undefined : Number(row.split(',')[2])
  } catch {
    return null // 同上：对照取不到就 SKIP
  }
}

function describe(t) {
  return `name=${t.name ?? '-'} price=${t.price} prevClose=${t.prevClose ?? '-'} chg=${t.changePercent?.toFixed(4) ?? '-'}% t=${new Date(t.timestamp).toISOString()} volume=${'volume' in t ? t.volume : '(缺省)'}`
}

/** 派生快照自洽性：涨跌幅由同一对 price/prevClose 推出，且不给 volume。 */
function checkSelfConsistent(t, label) {
  const expected = ((t.price - t.prevClose) / t.prevClose) * 100
  check(Math.abs((t.changePercent ?? NaN) - expected) < 1e-9,
    `${label} changePercent 由同一对 price/prevClose 推出（${t.changePercent} vs ${expected}）`)
  check(!('volume' in t), `${label} 不给 volume（窗口合计不是当日累计，宁可缺省）`)
}

const CN = [
  { input: '002714.SZ', tencent: 'sz002714', secid: '0.002714' },
  { input: '001201.SZ', tencent: 'sz001201', secid: '0.001201' },
  { input: '159869.SZ', tencent: 'sz159869', secid: '0.159869' },
  { input: '513050.SH', tencent: 'sh513050', secid: '1.513050' },
  { input: '517520.SH', tencent: 'sh517520', secid: '1.517520' },
]
const HK = [
  // 腾讯报价必须用 r_hk wire（连接器 hk 报价实际用法）；hkXXXXX 是 K 线形态，行布局不同。
  { input: '02714.HK', tencent: 'r_hk02714', secid: '116.02714' },
  { input: '00700.HK', tencent: 'r_hk00700', secid: '116.00700' },
]
const DERIVED = []

// ===================== 1. 报价快照路径现状 =====================
console.log('== 1. 报价快照路径现状（降级触发条件的前提）==')
let quotePathBlocked = false
try {
  const res = await fetch(`https://push2.eastmoney.com${QUOTE_PATH}?secids=0.002714&fields=f1,f2,f3,f5,f12,f13,f14,f18,f124`,
    { headers: { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' } })
  const body = await res.text()
  console.log(`  HTTP ${res.status}，响应体 ${body.length} 字节：${body.slice(0, 160) || '(空)'}`)
  quotePathBlocked = body.trim() === ''
} catch (err) {
  console.log(`  fetch 抛错：${err.constructor.name}: ${err.message}（cause: ${err.cause?.code ?? err.cause?.message ?? '-'}）`)
  quotePathBlocked = true
}
check(quotePathBlocked, '报价快照路径不可用（TCP 通、服务端收到即断/空回）——派生兜底的前提成立')
if (!quotePathBlocked) {
  console.log('\nSKIP：报价路径已恢复，本探针不适用（退出码 0，不是失败）')
  process.exit(0)
}

// ===================== 2. cn：派生快照 + 腾讯交叉验证 =====================
console.log('\n== 2. cn 五只：getTicker 降级派生，与同刻腾讯 GBK 报价逐只对照 ==')
const cn = new EastmoneyRestClient({ market: 'cn' })
const cnStart = calls.length
const cnDerived = new Map()
for (const s of CN) {
  const t = await cn.getTicker(s.input)
  cnDerived.set(s.input, t)
  DERIVED.push(t)
  const tx = await tencentQuote(s.tencent)
  console.log(`  ${s.input.padEnd(10)} ${describe(t)}`)
  if (tx === null) {
    skip(`${s.input} 腾讯对照取不到（出口瞬时掉线），本轮跳过对照`)
  } else {
    const dPrice = t.price - tx.price
    const dPrev = (t.prevClose ?? NaN) - tx.prevClose
    console.log(`  ${''.padEnd(10)} 腾讯 ${s.tencent.padEnd(8)} name=${tx.name} price=${tx.price} prevClose=${tx.prevClose} | Δprice=${dPrice} ΔprevClose=${dPrev}`)
    check(t.name === tx.name, `${s.input} 名称与腾讯一致（${t.name}）`)
    check(Math.abs(dPrice) <= PRICE_TOL, `${s.input} 派生价与腾讯一致（Δ=${dPrice}${dPrice === 0 ? '，逐位一致' : ''}）`)
    check(Math.abs(dPrev) < 1e-9, `${s.input} 昨收与腾讯一致（Δ=${dPrev}）`)
  }
  checkSelfConsistent(t, s.input)
}
const cnDerivedTrends = countSince(cnStart, TRENDS_PATH)
const cnDerivedQuote = countSince(cnStart, QUOTE_PATH)
check(cnDerivedTrends === CN.length, `五只各派生一次 trends2（${cnDerivedTrends} 次）`)
check(cnDerivedQuote === CN.length, `首选取价路径每只各试一次（${cnDerivedQuote} 次），失败后才降级`)

// ===================== 3. 降级态请求上界（TTL 缓存） =====================
console.log('\n== 3. 降级态请求上界：同一 secid 第二次取价命中 TTL 缓存 ==')
const repeatStart = calls.length
// `002714` 与 `002714.SZ` 是同一个 secid，缓存共享一份。
const repeat = await cn.getTicker('002714')
const repeatTrends = countSince(repeatStart, TRENDS_PATH)
const repeatQuote = countSince(repeatStart, QUOTE_PATH)
check(repeatTrends === 0, `换一种写法再取：trends2 请求数 = ${repeatTrends}（期望 0，命中 60s 缓存）`)
check(countSince(repeatStart, QUOTE_PATH) === 1, `首选取价路径仍被尝试 ${countSince(repeatStart, QUOTE_PATH)} 次（缓存只管降级分支，主路径恢复即返回新鲜值）`)
check(repeat.price === cnDerived.get('002714.SZ').price && repeat.timestamp === cnDerived.get('002714.SZ').timestamp,
  `第二次拿到同一份快照（price=${repeat.price}，symbol=${repeat.symbol}）`)

// ===================== 4. 批量失败 → 逐只派生 =====================
console.log('\n== 4. getTickers：批量失败后逐只派生（新客户端，缓存为空）==')
const cn2 = new EastmoneyRestClient({ market: 'cn' })
const batchStart = calls.length
const batch = await cn2.getTickers([...CN.map((s) => s.input), '00700.HK'])
const batchTrends = countSince(batchStart, TRENDS_PATH)
const batchQuote = countSince(batchStart, QUOTE_PATH)
for (const s of CN) {
  const t = batch[s.input]
  if (t !== undefined) { DERIVED.push(t); console.log(`  ${s.input.padEnd(10)} ${describe(t)}`) }
}
check(batchQuote === 1, `批量报价只试一次首选取价路径（${batchQuote} 次）`)
check(batchTrends === CN.length, `失败后对请求表里的 ${CN.length} 只逐只派生（trends2 ${batchTrends} 次）`)
check(Object.keys(batch).length === CN.length, `五只全部拿到派生快照（${Object.keys(batch).length}/${CN.length}）`)
check(!('00700.HK' in batch), '入参里转不成 secid 的港股形态按契约跳过（不进结果、整批不失败）')
for (const s of CN) check(batch[s.input]?.symbol === s.input, `${s.input} 按入参原字符串回填，symbol 仍是规范形`)

const batchAgainStart = calls.length
const batchAgain = await cn2.getTickers(CN.map((s) => s.input))
check(countSince(batchAgainStart, TRENDS_PATH) === 0,
  `同一客户端第二次批量：trends2 请求数 = ${countSince(batchAgainStart, TRENDS_PATH)}（期望 0，TTL 缓存对批量路径同样成立）`)
check(Object.keys(batchAgain).length === CN.length, `第二次批量仍五只齐全（缓存命中，不返回空表）`)

// ===================== 5. hk：同样生效 =====================
console.log('\n== 5. hk 两只：getTicker 降级派生（腾讯 r_hk wire 与东财日 K 收盘两条独立锚点）==')
const hk = new EastmoneyRestClient({ market: 'hk' })
const hkStart = calls.length
for (const s of HK) {
  const t = await hk.getTicker(s.input)
  DERIVED.push(t)
  const tx = await tencentQuote(s.tencent)
  const klineClose = await dailyClose(s.secid)
  console.log(`  ${s.input.padEnd(10)} ${describe(t)}`)
  console.log(`  ${''.padEnd(10)} 东财日K收盘=${klineClose ?? '(取不到)'} | 腾讯 name=${tx?.name ?? '(取不到)'} price=${tx?.price ?? '-'} prevClose=${tx?.prevClose ?? '-'}`)
  if (tx === null) {
    skip(`${s.input} 腾讯对照取不到（出口瞬时掉线），本轮跳过`)
  } else {
    check(t.name === tx.name, `${s.input} 名称与腾讯一致（${t.name}）`)
    check(Math.abs((t.prevClose ?? NaN) - tx.prevClose) < 1e-9, `${s.input} 昨收与腾讯一致（${t.prevClose}）`)
    const dHkPrice = Math.abs(t.price - tx.price)
    check(dHkPrice <= PRICE_TOL, `${s.input} 派生价与腾讯 r_hk 报价一致（Δ=${dHkPrice}）`)
  }
  if (klineClose === null || klineClose === undefined) {
    skip(`${s.input} 东财日 K 收盘取不到（出口瞬时掉线），本轮跳过`)
  } else {
    check(Math.abs(t.price - klineClose) <= PRICE_TOL, `${s.input} 派生价 = 东财日 K 收盘（${t.price}，含 16:00 后收市竞价）`)
  }
  checkSelfConsistent(t, s.input)
}
const hkDerivedTrends = countSince(hkStart, TRENDS_PATH)
check(hkDerivedTrends === HK.length, `两只各派生一次 trends2（${hkDerivedTrends} 次）`)

const hkBatchStart = calls.length
const hkBatch = await hk.getTickers(HK.map((s) => s.input))
check(countSince(hkBatchStart, TRENDS_PATH) === 0,
  `hk 批量取价复用同一份缓存：trends2 请求数 = ${countSince(hkBatchStart, TRENDS_PATH)}（期望 0）`)
check(Object.keys(hkBatch).length === HK.length, `hk 批量两只齐全（${Object.keys(hkBatch).length}/${HK.length}）`)

// ===================== 6. 全量请求计数 =====================
console.log('\n== 6. 本次运行全量上游请求计数 ==')
const tally = new Map()
for (const raw of calls) {
  const url = new URL(raw)
  const key = `${url.host}${url.pathname}`
  tally.set(key, (tally.get(key) ?? 0) + 1)
}
for (const [key, n] of [...tally.entries()].sort()) console.log(`  ${String(n).padStart(3)}  ${key}`)
console.log(`  派生快照 ${DERIVED.length} 份，其中 trends2 请求 ${countSince(0, TRENDS_PATH)} 次`)
console.log(`  降级态上界：同一 secid 60s 内最多一次 trends2（第 3/4/5 节的「0 次」即缓存生效的证据）`)

console.log(`\n结论：${failures.length === 0 ? 'PASS' : `FAIL（${failures.length} 项）`}${skips.length > 0 ? `（另有 ${skips.length} 项 SKIP：对照源瞬时取不到，非连接器侧问题）` : ''}`)
for (const f of failures) console.log(`  - ${f}`)
for (const s of skips) console.log(`  - SKIP: ${s}`)
process.exit(failures.length === 0 ? 0 : 1)

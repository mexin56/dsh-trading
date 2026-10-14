/**
 * 探针：批量报价 getTickers 是否把「N 只标的 N 次请求」压成 1 次（2026-10-14 契约）。
 *
 * 复现：
 *   pnpm --filter @dshtrading/connector-eastmoney build    # 探针 import 构建产物 lib/rest.js
 *   node spikes/impl-eastmoney-quote-endpoint/p2-getTickers-batch.mjs
 *
 * 只用真实网络，无桩：包一层 globalThis.fetch 记录每次请求的 URL，然后直接调构建产物
 * EastmoneyRestClient.getTickers，自选栏的 cn 五只 / hk 两只各跑一次。请求次数与 URL 列
 * 表是「一次请求取全」的证据——不是靠 getTickers 的返回值自证。预期不满足即 exit 1。
 */
import { EastmoneyRestClient } from '../../packages/connector-eastmoney/lib/rest.js'

const calls = []
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  calls.push(String(input))
  return realFetch(input, init)
}

const failures = []
const check = (ok, label) => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures.push(label)
}

const CN = ['002714.SZ', '001201.SZ', '159869.SZ', '513050.SH', '517520.SH']
const HK = ['02714.HK', '00700.HK']
const FOREIGN = '00700.HK'

function report(title, symbols, tickers, expected) {
  const got = Object.keys(tickers)
  const missing = expected.filter((s) => !(s in tickers))
  console.log(`\n${title}`)
  console.log(`  ${got.length}/${expected.length} 只取到，缺失 [${missing.join(', ') || '无'}]`)
  for (const symbol of expected) {
    const t = tickers[symbol]
    const line = t === undefined
      ? '（无）'
      : `${t.name ?? '-'}  price=${t.price}  prevClose=${t.prevClose ?? '-'}  chg=${t.changePercent ?? '-'}%`
    console.log(`    ${symbol.padEnd(11)} ${line}`)
  }
  return { got, missing, missingInput: symbols.filter((s) => !(s in tickers)) }
}

console.log('\n== 批量报价 getTickers：一次上游请求取全（真实网络）==')

// --- cn：5 只自选 + 1 个港股形态（cn 实例按契约跳过，不跨市场取数） ---
const cn = new EastmoneyRestClient({ market: 'cn' })
const cnBefore = calls.length
const cnInput = [...CN, FOREIGN]
let cnTickers = {}
try {
  cnTickers = await cn.getTickers(cnInput)
} catch (err) {
  failures.push(`cn getTickers 抛错：${err?.message ?? err}`)
}
const cnCalls = calls.length - cnBefore
const cnReport = report(`cn 五只（${CN.join('/')}）一次请求取全`, cnInput, cnTickers, CN)
check(cnCalls === 1, `cn 上游请求次数 = ${cnCalls}（期望 1）`)
check(cnReport.missing.length === 0, `cn 五只全部取到（缺失 ${cnReport.missing.length}）`)
check(!(FOREIGN in cnTickers), `入参里的港股形态 ${FOREIGN} 按契约跳过（结果里不出现，整批仍成功）`)
check(cnTickers['159869.SZ']?.price === 1.059 || Math.abs(cnTickers['159869.SZ']?.price - 1.059) < 0.5,
  `cn ETF 行按 f1=3 取价（159869 游戏ETF华夏 price=${cnTickers['159869.SZ']?.price}，市场级 ÷100 会得到 ~10.6）`)

// --- hk：2 只 ---
const hk = new EastmoneyRestClient({ market: 'hk' })
const hkBefore = calls.length
let hkTickers = {}
try {
  hkTickers = await hk.getTickers(HK)
} catch (err) {
  failures.push(`hk getTickers 抛错：${err?.message ?? err}`)
}
const hkCalls = calls.length - hkBefore
const hkReport = report(`hk 两只（${HK.join('/')}）一次请求取全`, HK, hkTickers, HK)
check(hkCalls === 1, `hk 上游请求次数 = ${hkCalls}（期望 1）`)
check(hkReport.missing.length === 0, `hk 两只全部取到（缺失 ${hkReport.missing.length}）`)

// --- 空入参：不发请求 ---
const emptyBefore = calls.length
const empty = await cn.getTickers([])
const emptyCalls = calls.length - emptyBefore
console.log('\n空入参（自选为空）')
check(Object.keys(empty).length === 0, '返回空表 {}')
check(emptyCalls === 0, `上游请求次数 = ${emptyCalls}（期望 0）`)

// --- 请求证据：URL 列表 ---
console.log(`\n上游请求 URL（共 ${calls.length} 次）`)
for (const url of calls) console.log(`  ${url.replace('https://push2.eastmoney.com', '')}`)
console.log(`\n本次探针合计上游请求 ${calls.length} 次（cn 批量 1 + hk 批量 1 + 空入参 0）。`)
console.log('对照：改动前自选 7 只走 getTicker 是 7 次请求。')

if (failures.length > 0) {
  console.log(`\nFAIL：${failures.length} 项不符合契约`)
  for (const f of failures) console.log(`  - ${f}`)
  process.exitCode = 1
} else {
  console.log('\n全部检查通过。')
}

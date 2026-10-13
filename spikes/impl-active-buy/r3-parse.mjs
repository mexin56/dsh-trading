/**
 * cn 主动买盘快照：**真实响应字节**的离线重放验证（任务 W1 交付证据）。
 *
 * 做法：curl 落盘的 GBK 原文（r1/r2-*.gbk，见 EVIDENCE.md 的复现命令）喂回**产品代码本体**
 * `packages/connector-tencent/src/rest.ts`（node 类型剥离直跑源文件，非另写一份解析），
 * 因此 GBK 解码、字段映射、失败语义与线上是同一条路径；只有「取数时刻」为注入值。
 *
 * 运行（仓库根）：node spikes/impl-active-buy/r3-parse.mjs
 * 产物：r3-parsed.json（解析结果 + sumGap 对照 + 失败语义），stdout 打印字段映射对照。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { ACTIVE_BUY_SOURCE, TencentRestClient } from '../../packages/connector-tencent/src/rest.ts'

const raw = (name) => new Uint8Array(readFileSync(new URL(`./${name}`, import.meta.url)))
const sha16 = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16)
/** 离线重放：注入的 fetch 返回落盘字节（含 content-type charset=GBK，与线上同形态）。 */
const replay = (bytes) => (async () => new Response(bytes, { headers: { 'content-type': 'text/html; charset=GBK' } }))

/** 参考字段位（解析器只读这些位；打印出来供人工对照原始响应）。 */
const MAPPED_FIELDS = [6, 7, 8, 30, 47, 48]
const FIXED_NOW = Date.UTC(2026, 9, 13, 2, 9, 35) // 注入取数时刻 2026-10-13 10:09:35 +08:00

const cases = [
  { label: 'sz002714', symbol: '002714', file: 'r1-raw-sz002714.gbk' },
  { label: 'sh600519', symbol: '600519', file: 'r2-raw-sh600519.gbk' },
]

const results = []
for (const c of cases) {
  const bytes = raw(c.file)
  const decoded = new TextDecoder('gbk').decode(bytes)
  const fields = /="([^"]*)"/.exec(decoded)?.[1].split('~') ?? []
  const snapshot = await new TencentRestClient('cn', { fetchImpl: replay(bytes), now: () => FIXED_NOW })
    .getActiveBuySnapshot(c.symbol)
  const sumGapLots = snapshot.totalLots - snapshot.outerLots - snapshot.innerLots
  const row = {
    ...c,
    rawBytes: bytes.length,
    rawSha256_16: sha16(bytes),
    mappedFields: Object.fromEntries(MAPPED_FIELDS.map((i) => [`f${i}`, fields[i] ?? null])),
    snapshot,
    sumGapLots,
    sumGapPct: Number(((sumGapLots / snapshot.totalLots) * 100).toFixed(4)),
  }
  results.push(row)
  console.log(`=== ${c.label} (${bytes.length}B, sha256:${row.rawSha256_16})`)
  console.log(`    字段映射: ${JSON.stringify(row.mappedFields)}`)
  console.log(`    快照: ${JSON.stringify(snapshot)}`)
  console.log(`    sumGap: ${sumGapLots} 手 = ${row.sumGapPct}%（未归向成交；原样返回不修正）`)
}

// 失败语义：未知代码（腾讯短 body）与非 cn 市场（r_hk 行没有外盘/内盘字段）都不返回 0。
const unknownBytes = raw('r2-raw-unknown-sz999999.gbk')
const unknownError = await new TencentRestClient('cn', { fetchImpl: replay(unknownBytes), now: () => FIXED_NOW })
  .getActiveBuySnapshot('999999').catch((e) => e)
const hkError = await new TencentRestClient('hk', { fetchImpl: replay(raw('r2-raw-hk00700.gbk')), now: () => FIXED_NOW })
  .getActiveBuySnapshot('00700').catch((e) => e)
console.log(`=== 未知代码 sz999999: ${JSON.stringify({ raw: new TextDecoder('gbk').decode(unknownBytes).trim(), code: unknownError.code })}`)
console.log(`=== hk r_hk00700: ${JSON.stringify({ code: hkError.code, message: hkError.message })}`)

const parsed = {
  replayedAt: new Date().toISOString(),
  sourceModule: 'packages/connector-tencent/src/rest.ts',
  injectedNow: new Date(FIXED_NOW).toISOString(),
  results,
  failures: {
    unknownSymbol: { body: new TextDecoder('gbk').decode(unknownBytes).trim(), code: unknownError.code },
    hkActiveBuy: { code: hkError.code, message: hkError.message },
  },
}
// 默认只打印：复跑本脚本不得写脏工作区（2026-10-13 独立验收实测踩过——重放会改 tracked 的
// r3-parsed.json 的 replayedAt，执行后 git status 从 0 变 1）。需要更新这份证据快照时显式加 --write。
const serialized = `${JSON.stringify(parsed, null, 2)}\n`
console.log(serialized)
if (process.argv.includes('--write')) {
  writeFileSync(new URL('./r3-parsed.json', import.meta.url), serialized)
  console.log('=== 已写入 r3-parsed.json（--write）')
} else {
  console.log('=== 未落盘（默认 stdout-only；需要更新 r3-parsed.json 时加 --write）')
}

// 断言：读数与落盘字节逐项对上，占比口径固定，失败语义不降级成 0。
const [sz, sh] = results
const expect = (ok, message) => { if (!ok) throw new Error(message) }
expect(sz.snapshot.outerLots === 54093 && sz.snapshot.innerLots === 67703 && sz.snapshot.totalLots === 121808, `sz002714 读数不符: ${JSON.stringify(sz.snapshot)}`)
expect(sz.snapshot.buySharePct === 44.41 && sz.snapshot.netSharePct === -11.17, `sz002714 占比不符: ${JSON.stringify(sz.snapshot)}`)
expect(sz.snapshot.limitUp === 45.96 && sz.snapshot.limitDown === 37.6, `sz002714 涨跌停不符: ${JSON.stringify(sz.snapshot)}`)
expect(sz.snapshot.date === '2026-10-13' && sz.snapshot.time === '10:09:30', `sz002714 交易日/时刻不符: ${sz.snapshot.date} ${sz.snapshot.time}`)
expect(sz.snapshot.source === ACTIVE_BUY_SOURCE, `source 不符: ${sz.snapshot.source}`)
expect(sh.snapshot.buySharePct === 52.53 && sh.snapshot.netSharePct === 5.69, `sh600519 占比不符: ${JSON.stringify(sh.snapshot)}`)
// 读数原样返回（= 原始字段值），残差不参与修正；残差本身**不是**固定量级，故不断言上界。
for (const r of results) {
  expect(r.snapshot.totalLots === Number(r.mappedFields.f6), `${r.label} 总量被改写: ${r.snapshot.totalLots} != f6 ${r.mappedFields.f6}`)
  expect(r.snapshot.outerLots === Number(r.mappedFields.f7), `${r.label} 外盘被改写: ${r.snapshot.outerLots} != f7 ${r.mappedFields.f7}`)
  expect(r.snapshot.innerLots === Number(r.mappedFields.f8), `${r.label} 内盘被改写: ${r.snapshot.innerLots} != f8 ${r.mappedFields.f8}`)
}
expect(unknownError.code === 'TRADING_UNSUPPORTED_SYMBOL', `未知代码错误码不符: ${unknownError.code}`)
expect(hkError.code === 'TRADING_NOT_IMPLEMENTED', `hk 错误码不符: ${hkError.code}`)
console.log(`REAL-RESPONSE REPLAY PASS: ${results.length} 个真实行 + 2 条失败语义（GBK + 字段映射 + 占比 + sumGap 全部核对）`)

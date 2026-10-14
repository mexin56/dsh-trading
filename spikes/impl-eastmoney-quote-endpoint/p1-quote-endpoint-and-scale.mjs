/**
 * 探针：东财单标的报价端点 /api/qt/stock/get 是否还可用，以及报价行小数位数 f1 的取价含义。
 *
 * 复现：node spikes/impl-eastmoney-quote-endpoint/p1-quote-endpoint-and-scale.mjs
 *
 * 背景（2026-10-14，用户报「东财数据源下左侧自选栏最新报价有问题」）：侧栏每行价格显示 "—"、
 * 名称回落到代码。定位到 EastmoneyRestClient.getTicker 走的 /api/qt/stock/get 空回。
 * 本探针只用真实网络响应，不用任何桩：
 *   1) 旧端点 vs 同域其它路径（隔离「路径没了」还是「网络故障」）
 *   2) 批量端点 ulist.np/get 的原始响应（含每行 f1）
 *   3) 用构建产物 lib/rest.js（部署里跑的就是它）对用户自选里的 7 只标的取价
 *   4) 与腾讯 qt.gtimg.cn 逐只交叉验证价格量级
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { EastmoneyRestClient } from '../../packages/connector-eastmoney/lib/rest.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const raw = { probedAt: new Date().toISOString(), ua: UA }

/** text=true 时按 GBK 解码（腾讯 qt.gtimg.cn 是 GBK，其余是 UTF-8 JSON）。 */
async function get(url, gbk = false) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' } })
    const buf = await res.arrayBuffer()
    const text = new TextDecoder(gbk ? 'gbk' : 'utf-8').decode(buf)
    return { status: res.status, bytes: buf.byteLength, text }
  } catch (err) {
    return { error: String(err?.cause?.code ?? err?.message ?? err) }
  }
}

function record(key, url, outcome) {
  raw[key] = { url, ...outcome, text: outcome.text?.slice(0, 4000) }
  const summary = outcome.error !== undefined
    ? `ERROR ${outcome.error}`
    : `HTTP ${outcome.status} bytes=${outcome.bytes}`
  console.log(`  ${summary.padEnd(34)} ${url.replace('https://push2.eastmoney.com', '')}`)
  return outcome
}

console.log('\n== 1. 端点存活对照（同一时刻、同一 UA、同一域）==')
const F_OLD = 'f43,f44,f45,f46,f47,f48,f57,f58,f60,f86,f169,f170'
record('stockGet_cn', `https://push2.eastmoney.com/api/qt/stock/get?secid=0.001201&fields=${F_OLD}`, await get(`https://push2.eastmoney.com/api/qt/stock/get?secid=0.001201&fields=${F_OLD}`))
record('stockGet_hk', `https://push2.eastmoney.com/api/qt/stock/get?secid=116.00700&fields=${F_OLD}`, await get(`https://push2.eastmoney.com/api/qt/stock/get?secid=116.00700&fields=${F_OLD}`))
// 对照：同一时刻另两组同源路径（push2 的批量报价、push2his 的分钟序列）——证明域与网络都活着。
const klineUrl = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.001201&klt=101&fqt=1&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56'
record('klineGet_control_push2his', klineUrl, await get(klineUrl))
const trendsUrl = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=0.001201&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&ndays=1&iscr=0'
record('trends2_control_push2his', trendsUrl, await get(trendsUrl))

console.log('\n== 2. 批量端点 ulist.np/get（新路径）==')
const F_NEW = 'f1,f2,f3,f5,f12,f13,f14,f18,f124'
const cnSecids = '0.002714,0.001201,0.159869,1.513050,1.517520'
const hkSecids = '116.02714,116.00700'
const cnUrl = `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${cnSecids}&fields=${F_NEW}`
const hkUrl = `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${hkSecids}&fields=${F_NEW}`
record('ulist_cn', cnUrl, await get(cnUrl))
record('ulist_hk', hkUrl, await get(hkUrl))
const missUrl = 'https://push2.eastmoney.com/api/qt/ulist.np/get?secids=0.001201,0.999999&fields=f1,f2,f12,f14'
record('ulist_mixedValidInvalid', missUrl, await get(missUrl))

console.log('\n== 3. 构建产物 lib/rest.js 对自选 7 行的取价（部署里跑的就是这份代码）==')
const cn = new EastmoneyRestClient({ market: 'cn' })
const hk = new EastmoneyRestClient({ market: 'hk' })
const rows = [
  ['cn', cn, '002714.SZ'],
  ['cn', cn, '001201.SZ'],
  ['cn', cn, '159869.SZ'],
  ['cn', cn, '513050.SH'],
  ['cn', cn, '517520.SH'],
  ['hk', hk, '02714.HK'],
  ['hk', hk, '00700.HK'],
]
const tickers = {}
for (const [market, client, symbol] of rows) {
  try {
    tickers[symbol] = await client.getTicker(symbol)
  } catch (err) {
    tickers[symbol] = { error: String(err?.message ?? err) }
  }
}
raw.tickers = tickers

console.log('\n== 4. 与腾讯 qt.gtimg.cn 逐只交叉验证 ==')
const txCodes = ['sz002714', 'sz001201', 'sz159869', 'sh513050', 'sh517520', 'hk02714', 'hk00700']
const txUrl = `https://qt.gtimg.cn/q=${txCodes.join(',')}`
const tx = await get(txUrl, true)
raw.tencent = { url: txUrl, status: tx.status, text: tx.text?.slice(0, 6000) }
const txBy = new Map()
for (const chunk of (tx.text ?? '').split(';')) {
  const m = /^v_(\w+)="([^"]*)"/.exec(chunk.trim())
  if (m === null) continue
  const f = m[2].split('~')
  txBy.set(m[1], { name: f[1], price: Number(f[3]), prevClose: Number(f[4]) })
}

const pad = (s, n) => String(s).padEnd(n)
console.log(`  ${pad('symbol', 11)}${pad('东财 name', 16)}${pad('东财 price', 11)}${pad('东财 prevClose', 14)}${pad('腾讯 name', 16)}${pad('腾讯 price', 11)}一致`)
for (const [, , symbol] of rows) {
  const t = tickers[symbol]
  const key = symbol.endsWith('.HK') ? `hk${symbol.slice(0, 5)}` : `${symbol.startsWith('6') || symbol.startsWith('5') ? 'sh' : 'sz'}${symbol.slice(0, 6)}`
  const q = txBy.get(key)
  // 两个源不是同一时刻取的快照，盘中会有跳动，故按 0.5% 相对差判「一致」并把偏离量打出来。
  const drift = q !== undefined && t?.price !== undefined ? Math.abs(t.price - q.price) / q.price : undefined
  const verdict = drift === undefined ? 'NO-DATA' : drift < 0.005 ? 'OK' : `DIFF ${(drift * 100).toFixed(2)}%`
  console.log(`  ${pad(symbol, 11)}${pad(t?.name ?? t?.error ?? '-', 16)}${pad(t?.price ?? '-', 11)}${pad(t?.prevClose ?? '-', 14)}${pad(q?.name ?? '-', 16)}${pad(q?.price ?? '-', 11)}${verdict}`)
}

writeFileSync(join(HERE, 'p1-quote-endpoint-and-scale.raw.json'), JSON.stringify(raw, null, 2))
console.log(`\n原始响应落盘：spikes/impl-eastmoney-quote-endpoint/p1-quote-endpoint-and-scale.raw.json\n`)

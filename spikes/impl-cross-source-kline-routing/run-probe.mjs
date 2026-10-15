/**
 * 跨源 K 线能力路由探针（2026-10-15）：用**真实连接器客户端 + 真实 TradingBridge**
 * 打真实上游，验证四件事：
 *   1. 腾讯 A 股公开端点对 1m 是结构性拒绝（不是网络失败）；
 *   2. 东财 1m 单请求能给最近 5 个交易日（cn/hk 各自窗口）；
 *   3. 桥在 cn/hk 路由 = tencent 时把 1m 请求解析到东财，且 1d 请求仍在腾讯（零跨源）；
 *   4. /tickers 的显式 provider 走真实取价路径，未注册 provider 被 400 拒绝。
 *
 * 服务对象是**围绕真实 REST 客户端的最小适配器**（getKlines/getTicker/klineCapabilities
 * 直通客户端本体）——不伪造业务行为，证据只关于「上游能力 + 桥的解析」，
 * 不覆盖 cordis dataplane 注册（那条由各连接器 dataplane-loader 用例覆盖）。
 *
 * 运行：node spikes/impl-cross-source-kline-routing/run-probe.mjs
 * 前置：pnpm build（探针 import 的是各包 lib/ 产物）。
 */
import { writeFileSync } from 'node:fs'
import { TencentRestClient } from '../../packages/connector-tencent/lib/rest.js'
import { EastmoneyRestClient } from '../../packages/connector-eastmoney/lib/rest.js'
import { TradingBridge, createBridgeHost, dispatchBridgeRequest } from '../../packages/bot-api/lib/bridge.js'

const out = { ranAt: new Date().toISOString(), direct: {}, bridge: {} }

/** 真服务形状的最小适配器：直通真实客户端。 */
function serviceOf(client) {
  return {
    getTicker: symbol => client.getTicker(symbol),
    getKlines: (symbol, interval, limit) => client.getKlines(symbol, interval, limit),
    klineCapabilities: () => client.klineCapabilities(),
    subscribeTicker: () => ({ dispose() {} }),
  }
}

async function capture(run) {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return { ok: false, code: error?.code ?? null, message: String(error?.message ?? error) }
  }
}

/** 按市场本地日历日数 bar 覆盖了几个交易日。 */
function tradingDays(bars, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  return new Set(bars.map(bar => fmt.format(new Date(bar.openTime)))).size
}

function summarize(bars, timeZone) {
  return {
    bars: bars.length,
    tradingDays: tradingDays(bars, timeZone),
    first: bars.length === 0 ? null : new Date(bars[0].openTime).toISOString(),
    last: bars.length === 0 ? null : new Date(bars[bars.length - 1].openTime).toISOString(),
  }
}

const cnTencent = new TencentRestClient('cn')
const hkTencent = new TencentRestClient('hk')
const cnEastmoney = new EastmoneyRestClient({ market: 'cn' })
const hkEastmoney = new EastmoneyRestClient({ market: 'hk' })

/* ---------- 1/2. 上游能力直证 ---------- */
out.direct.tencentCn1m = await capture(async () => summarize(await cnTencent.getKlines('600519', '1m', 100), 'Asia/Shanghai'))
out.direct.tencentHk1m = await capture(async () => summarize(await hkTencent.getKlines('00700', '1m', 100), 'Asia/Hong_Kong'))
out.direct.eastmoneyCn1m2500 = await capture(async () => summarize(await cnEastmoney.getKlines('600519', '1m', 2500), 'Asia/Shanghai'))
out.direct.eastmoneyHk1m2500 = await capture(async () => summarize(await hkEastmoney.getKlines('00700', '1m', 2500), 'Asia/Hong_Kong'))
out.direct.declared = {
  tencentCn: cnTencent.klineCapabilities(),
  tencentHk: hkTencent.klineCapabilities(),
  eastmoneyCn: cnEastmoney.klineCapabilities(),
  eastmoneyHk: hkEastmoney.klineCapabilities(),
}

/* ---------- 3/4. 真实桥（cn/hk 路由 = tencent） ---------- */
const entries = {
  cn: [
    { provider: 'tencent', service: serviceOf(cnTencent) },
    { provider: 'eastmoney', service: serviceOf(cnEastmoney) },
  ],
  hk: [
    { provider: 'tencent', service: serviceOf(hkTencent) },
    { provider: 'eastmoney', service: serviceOf(hkEastmoney) },
  ],
}
const registry = {
  active: market => entries[market]?.find(entry => entry.provider === 'tencent'),
  list: market => entries[market] ?? [],
}
const bridge = new TradingBridge(createBridgeHost({ registry, legacy: () => undefined }))

async function call(path, query) {
  const { payload } = await dispatchBridgeRequest(bridge, 'GET', path, new URLSearchParams(query))
  return payload
}

out.bridge.markets = await capture(async () => (await bridge.markets()).markets)
out.bridge.cn1m2500 = await capture(async () => {
  const wire = await call('/klines', { market: 'cn', symbol: '600519', interval: '1m', limit: '2500' })
  return { provider: wire.provider ?? null, ...summarize(wire.klines, 'Asia/Shanghai') }
})
out.bridge.cn1d750 = await capture(async () => {
  const wire = await call('/klines', { market: 'cn', symbol: '600519', interval: '1d', limit: '750' })
  return { provider: wire.provider ?? null, ...summarize(wire.klines, 'Asia/Shanghai') }
})
out.bridge.hk1m2500 = await capture(async () => {
  const wire = await call('/klines', { market: 'hk', symbol: '00700', interval: '1m', limit: '2500' })
  return { provider: wire.provider ?? null, ...summarize(wire.klines, 'Asia/Hong_Kong') }
})
out.bridge.tickersActive = await capture(async () => {
  const wire = await call('/tickers', { market: 'cn', symbols: '600519' })
  return wire.tickers['600519']
})
out.bridge.tickersByProvider = await capture(async () => {
  const wire = await call('/tickers', { market: 'cn', symbols: '600519', provider: 'eastmoney' })
  return wire.tickers['600519']
})
out.bridge.tickersUnregisteredProvider = await capture(async () =>
  (await call('/tickers', { market: 'cn', symbols: '600519', provider: 'stooq' })))

writeFileSync(new URL('./probe.raw.json', import.meta.url), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))

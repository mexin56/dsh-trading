/**
 * cn preset 组行「路由互斥」判据（2026-10-14）。
 *
 * 复现用户报的 `agent-preset/invalid: dsh-trading-cn-connector-eastmoney … service
 * "tradingCnMarketData" has been registered at <dsh-trading-tencent>`，并给出修复后的对照。
 *
 * 机制（loader 源码 cordis-plugin-loader/lib/index.js:505-560 `isolate()`）：
 * `isolate: { tradingCnMarketData: true }` 的 label=true → 该行拿到 `entry.realm ??= new
 * LocalRealm(entry)`，**组内所有子行共用同一个 realm**；因此组内任意时刻只能有一个
 * provider 真正 provide 该服务键——靠各连接器 apply 里的 routeAllows 闸门互斥。
 * 本脚本用 `ctx.isolate(key)` 把两张同市场行挂进同一个 realm，等价复现这一约束
 * （不引 cordis-plugin-loader 的整棵树，避免复刻 preset 装载链路）。
 *
 * 用法（仓库根目录；读取桌面实例实际加载的 profile 副本）：
 *   node spikes/impl-cn-preset-route-mutex/run-cn-group-route-mutex-probe.mjs
 * 覆盖模块目录（对照仓库产物时用，须与同一份 cordis 实例同树）：
 *   LIB_ROOT=<dir> node spikes/impl-cn-preset-route-mutex/run-cn-group-route-mutex-probe.mjs
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOST_CORDIS = '/Applications/DSH Trading.app/Contents/Resources/runtime/host/node_modules/@deepseek-ai/cordis/lib/index.js'
const DEFAULT_LIB_ROOT = join(homedir(), '.dsh-trading/profiles/trading-web/node_modules/@dshtrading')
const LIB_ROOT = process.env.LIB_ROOT ?? DEFAULT_LIB_ROOT

const { Context } = await import(HOST_CORDIS)
const router = await import(join(LIB_ROOT, 'router/lib/index.js'))
const tencent = await import(join(LIB_ROOT, 'connector-tencent/lib/index.js'))
const eastmoney = await import(join(LIB_ROOT, 'connector-eastmoney/lib/index.js'))

const KEY = 'tradingCnMarketData'

/** 挂一行（组内子行语义：同一 realm），返回错误消息或 undefined。 */
async function mount(realm, plugin, config) {
  try {
    await realm.plugin(plugin, config)
    return undefined
  } catch (error) {
    return `${error.name}: ${String(error.message).split('\n')[0]}`
  }
}

async function scenario(routedProvider) {
  const ctx = new Context()
  await ctx.plugin(router, { markets: { cn: { provider: routedProvider } } })
  const realm = ctx.isolate(KEY)
  const tools = []
  realm.reflect.provide('tools', {
    register: (tool) => { tools.push(tool.name) },
    get: () => undefined,
  })

  const tencentError = await mount(realm, tencent.default ?? tencent, { market: 'cn', dryRun: true, liveTrading: false })
  const eastmoneyError = await mount(realm, eastmoney.default ?? eastmoney, { market: 'cn', enabled: true, dryRun: true, liveTrading: false })
  const provided = realm.get(KEY, false)
  return { routedProvider, tencentError, eastmoneyError, provided: provided === undefined ? undefined : provided.constructor.name, toolCount: tools.length }
}

for (const routed of ['eastmoney', 'tencent']) {
  const result = await scenario(routed)
  console.log(`\n== cn 路由选中 ${routed}（组内同一 realm）`)
  console.log(`  tencent 行:   ${result.tencentError === undefined ? 'ok（未报错）' : 'THROW ' + result.tencentError}`)
  console.log(`  eastmoney 行: ${result.eastmoneyError === undefined ? 'ok' : 'THROW ' + result.eastmoneyError}`)
  console.log(`  ${KEY} = ${result.provided === undefined ? '未提供' : result.provided} | 注册工具数 ${result.toolCount}`)
}

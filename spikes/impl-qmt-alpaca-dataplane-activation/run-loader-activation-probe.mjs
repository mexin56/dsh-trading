/**
 * qmt/alpaca 数据面行「激活」判据（2026-10-14）。
 *
 * 复现桌面宿主启动时的那段告警，并给出修复前后的对照——走的正是 loader 的激活路径
 * （`ctx.registry.plugin(模块, 行 config)` → `Fiber._resolveConfig` → `resolveConfig` → `apply`，
 * 见 @deepseek-ai/cordis/lib/index.js 的 Entry._init 与 Fiber._reload），失败即宿主
 * `dsh: warning: N entries did not activate` 的那一条。
 *
 * 用法（仓库根目录）：
 *   node spikes/impl-qmt-alpaca-dataplane-activation/run-loader-activation-probe.mjs
 *
 * 对照组：
 *   A 修复后——仓库构建产物 packages/connector-<slug>/lib/dataplane.js
 *   B 修复前——桌面实例当前加载的 profile 副本
 *             ~/.dsh-trading/profiles/trading-web/node_modules/@dshtrading/connector-<slug>/lib/dataplane.js
 *   B 组缺失时跳过（不伪造对照）。
 *
 * 行 config 取自 bundle patch：cn/us 两行的 dataplane 行只写 `enabled: true`
 * （`dsh --profile trading-web --dump-config` 实测）。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '')
const PROFILE_COPY = join(homedir(), '.dsh-trading/profiles/trading-web/node_modules/@dshtrading')

/** 待验证的行：market / provider / 连接器 slug。 */
const ROWS = [
  { market: 'cn', provider: 'qmt', slug: 'connector-qmt' },
  { market: 'us', provider: 'alpaca', slug: 'connector-alpaca' },
]

/** 桌面宿主实际加载的那份与仓库构建产物的路径。 */
const BUILDS = [
  { label: 'repo（修复后）', path: (slug) => join(REPO, 'packages', slug, 'lib/dataplane.js') },
  { label: 'profile 副本（修复前）', path: (slug) => join(PROFILE_COPY, slug, 'lib/dataplane.js') },
]

/** 真实 router 插件：两张注册表由它同 fiber 提供（base patch 行零改动）。 */
const router = await import(join(REPO, 'packages/router/lib/index.js'))

/** 挂一行，返回 loader 激活路径上的判定结果（异常即宿主说的「未激活」）。 */
async function activate(row, modulePath) {
  const ctx = new Context()
  await ctx.plugin(router, { markets: { [row.market]: { provider: row.provider } } })
  const module = await import(modulePath)
  const plugin = module.default ?? module // loader.unwrapExports：无 default → 命名空间自身
  let failure
  try {
    await ctx.plugin(plugin, { enabled: true })
  } catch (error) {
    failure = `${error.name}: ${String(error.message).split('\n')[0]}`
  }
  const market = ctx.get('tradingMarketDataRegistry', false)?.list(row.market).map((e) => e.provider) ?? []
  const trade = ctx.get('tradingTradeRegistry', false)?.list(row.market).map((e) => e.provider) ?? []
  const hasSchema = plugin.Config !== undefined
  return { failure, market, trade, hasSchema }
}

let failures = 0
for (const build of BUILDS) {
  console.log(`\n== ${build.label}`)
  for (const row of ROWS) {
    const modulePath = build.path(row.slug)
    if (!existsSync(modulePath)) {
      console.log(`  ${row.market}/${row.provider}: SKIP（无此构建：${modulePath}）`)
      continue
    }
    const result = await activate(row, modulePath)
    const verdict = result.failure === undefined ? 'activated' : 'did not activate'
    if (result.failure !== undefined) failures += 1
    console.log(
      `  ${row.market}/${row.provider}: ${verdict}`
      + ` | 模块导出 Config=${result.hasSchema}`
      + ` | market=[${result.market}] trade=[${result.trade}]`
      + (result.failure === undefined ? '' : ` | ${result.failure}`),
    )
  }
}
console.log(`\n本脚本观测到的未激活行数（对照两组累计）：${failures}`)

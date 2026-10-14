/**
 * 数据面行 loader 解析面单测（2026-10-14「dataplane 入口未导出 Config schema」同类债收敛）。
 *
 * 守卫的是**加载路径**，不是包内直调：patch 行只写 `enabled: true`，loader 只认
 * `lib/dataplane.js` 自己导出的 Config 补默认值（cordis resolveConfig）。缺它时行 config
 * 原样传入 → schema 默认值全丢（Yahoo 本行不吃 config，故不崩，但行 config 失去校验面）。
 * Yahoo 是纯数据源：无交易面、schema 里也没有行级开关，本行恒注册。
 */
import { describe, expect, it } from 'vitest'
import { resolveConfig, type Context } from '@deepseek-ai/cordis'
import * as dataplane from '../src/dataplane.ts'
import { TRADING_US_MARKET_DATA_KEY, type Config as ConfigType } from '../src/index.ts'

interface Registration { market: string; provider: string; service: unknown }

/**
 * 形状合法的假 ctx：连接器对 router 包零依赖，故按鸭式消费面手搓注册表
 * （register 真实收集 + isolate 记录 realm 键），不引入通用 mock 工具。
 */
function registryCtx(): { ctx: Context; market: Registration[]; isolated: string[] } {
  const market: Registration[] = []
  const isolated: string[] = []
  const marketRegistry = {
    register: (m: string, p: string, service: unknown) => {
      market.push({ market: m, provider: p, service })
      return () => {}
    },
  }
  const ctx = {
    get: (key: string) => (key === 'tradingMarketDataRegistry' ? marketRegistry : undefined),
    isolate: (name: string) => {
      isolated.push(name)
      return { reflect: { provide: () => {} } }
    },
    effect: (fn: () => () => void) => { fn() },
    reflect: { provide: () => {} },
  } as unknown as Context
  return { ctx, market, isolated }
}

/** loader.unwrapExports 语义：无 default 导出 → 模块命名空间自身即插件对象。 */
const plugin = (dataplane as unknown as { default?: unknown }).default ?? dataplane

describe('Yahoo 连接器数据面行的 loader 解析面', () => {
  it('用户环境按子路径包名挂行时 dataplane 入口自己导出 apply 与 Config', () => {
    // Given: patch 行写 @dshtrading/connector-yahoo/dataplane → loader 只读 lib/dataplane.js
    // When: 检查子入口导出面
    // Then: apply 与 Config 都在（缺 Config 时行 config 无 schema 可补默认值）
    expect(typeof dataplane.apply).toBe('function')
    expect(dataplane.Config).toBeDefined()
    expect(dataplane.inject).toEqual([])
  })

  it('用户 patch 行只写 enabled: true 时 loader 补全 schema 默认值', () => {
    // Given: us bundle 的行 config（enabled: true）
    // When: 按 cordis loader 语义解析行 config
    // Then: dryRun 缺省 true、liveTrading 缺省 false，行 config 过 schema 校验
    const resolved = resolveConfig(plugin as never, { enabled: true }) as ConfigType
    expect(resolved.dryRun).toBe(true)
    expect(resolved.liveTrading).toBe(false)
  })

  it('用户宿主挂载该行时 (us, yahoo) 注册进行情注册表', () => {
    // Given: loader 解析后的行 config（真服务构造，不经假服务替身）
    // When: 挂载数据面行
    // Then: (us, yahoo) 进行情注册表且不占 host 根市场键；本行无行级开关，恒注册
    const { ctx, market, isolated } = registryCtx()
    dataplane.apply(ctx)
    expect(market.map((r) => `${r.market}/${r.provider}`)).toEqual(['us/yahoo'])
    expect(market[0]?.service).toBeDefined()
    expect(isolated).toEqual([TRADING_US_MARKET_DATA_KEY])
  })
})

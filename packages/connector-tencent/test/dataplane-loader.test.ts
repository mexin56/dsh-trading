/**
 * 数据面行 loader 解析面单测（2026-10-14「dataplane 入口未导出 Config schema」同类债收敛）。
 *
 * 守卫的是**加载路径**，不是包内直调：patch 行只写 `market: cn`（cn 行）或
 * `enabled: true` + `market: hk`（hk 行），loader 只认 `lib/dataplane.js` 自己导出的 Config
 * 补默认值（cordis resolveConfig）。缺它时行 config 原样传入 → schema 默认值全丢，
 * 且单包双市场靠行内 `market` 分流，schema 是它唯一的校验面。
 */
import { describe, expect, it } from 'vitest'
import { resolveConfig, type Context } from '@deepseek-ai/cordis'
import * as dataplane from '../src/dataplane.ts'
import {
  marketDataKey,
  TRADING_CN_MARKET_DATA_KEY,
  TRADING_HK_MARKET_DATA_KEY,
  type Config as ConfigType,
} from '../src/index.ts'

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

describe('Tencent 连接器数据面行的 loader 解析面', () => {
  it('用户环境按子路径包名挂行时 dataplane 入口自己导出 apply 与 Config', () => {
    // Given: cn/hk 两个 patch 行都写 @dshtrading/connector-tencent/dataplane → loader 只读 lib/dataplane.js
    // When: 检查子入口导出面
    // Then: apply 与 Config 都在（缺 Config 时行 config 无 schema 可补默认值）
    expect(typeof dataplane.apply).toBe('function')
    expect(dataplane.Config).toBeDefined()
    expect(dataplane.inject).toEqual([])
  })

  it('用户 cn 行只写 market: cn 时 loader 补全闸门默认值', () => {
    // Given: cn bundle 的行 config（market: cn）
    // When: 按 cordis loader 语义解析行 config
    // Then: market 原样保留、dryRun 缺省 true、liveTrading 缺省 false
    const resolved = resolveConfig(plugin as never, { market: 'cn' }) as ConfigType
    expect(resolved.market).toBe('cn')
    expect(resolved.dryRun).toBe(true)
    expect(resolved.liveTrading).toBe(false)
  })

  it('用户宿主挂载 cn 行时 (cn, tencent) 注册进行情注册表', () => {
    // Given: loader 解析后的 cn 行 config（真服务构造，不经假服务替身）
    // When: 挂载数据面行
    // Then: (cn, tencent) 进 cn 市场 realm 键
    const resolved = resolveConfig(plugin as never, { market: 'cn' }) as ConfigType
    const { ctx, market, isolated } = registryCtx()
    dataplane.apply(ctx, resolved)
    expect(market.map((r) => `${r.market}/${r.provider}`)).toEqual(['cn/tencent'])
    expect(market[0]?.service).toBeDefined()
    expect(isolated).toEqual([marketDataKey('cn')])
  })

  it('用户宿主挂载 hk 行时 (hk, tencent) 注册进行情注册表', () => {
    // Given: hk bundle 的行 config（enabled: true + market: hk）
    // When: 按 loader 语义解析并挂载
    // Then: 同一模块的第二个实例注册进 hk 市场 realm 键，两个市场互不覆盖
    const resolved = resolveConfig(plugin as never, { enabled: true, market: 'hk' }) as ConfigType
    const { ctx, market, isolated } = registryCtx()
    dataplane.apply(ctx, resolved)
    expect(market.map((r) => `${r.market}/${r.provider}`)).toEqual(['hk/tencent'])
    expect(isolated).toEqual([marketDataKey('hk')])
    expect(TRADING_CN_MARKET_DATA_KEY).not.toBe(TRADING_HK_MARKET_DATA_KEY)
  })

  it('用户手工构造 ctx 且不传 config 时缺 market 依 schema 报错而不静默猜市场', () => {
    // Given: 单测/第三方宿主直接 apply 不传 config（单包双市场，market 是 required 字段）
    // When: 挂载数据面行
    // Then: 按 schema 抛错（缺 $market），不把 cn/hk 里的任意一个当缺省
    const { ctx } = registryCtx()
    expect(() => dataplane.apply(ctx)).toThrow(/market/)
  })
})

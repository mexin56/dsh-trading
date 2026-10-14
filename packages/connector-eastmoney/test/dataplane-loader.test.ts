/**
 * 数据面行 loader 解析面单测（2026-10-14「dataplane 入口未导出 Config schema」同类债收敛）。
 *
 * 守卫的是**加载路径**，不是包内直调：patch 行只写 `enabled: true`（cn 行）/ `enabled: true` + `market: hk`（hk 行），loader 只认
 * `lib/dataplane.js` 自己导出的 Config 补默认值（cordis resolveConfig）。缺它时行 config
 * 原样传入 → schema 默认值全丢 → apply 读到 undefined：行情服务靠 `config.market ?? 'cn'` 兜底，schema 默认值（market 缺省 cn）不生效
 */
import { describe, expect, it } from 'vitest'
import { resolveConfig, type Context } from '@deepseek-ai/cordis'
import * as dataplane from '../src/dataplane.ts'
import {
  marketDataKey,
  type Config as ConfigType,
} from '../src/index.ts'

interface Registration { market: string; provider: string; service: unknown }

/**
 * 形状合法的假 ctx：连接器对 router 包零依赖，故按鸭式消费面手搓注册表
 * （register 真实收集 + isolate 记录 realm 键），不引入通用 mock 工具。
 */
function registryCtx(withTrade = true): {
  ctx: Context
  market: Registration[]
  trade: Registration[]
  isolated: string[]
} {
  const market: Registration[] = []
  const trade: Registration[] = []
  const isolated: string[] = []
  const marketRegistry = {
    register: (m: string, p: string, service: unknown) => {
      market.push({ market: m, provider: p, service })
      return () => {}
    },
  }
  const tradeRegistry = {
    register: (m: string, p: string, service: unknown) => {
      trade.push({ market: m, provider: p, service })
      return () => {}
    },
  }
  const ctx = {
    get: (key: string) => {
      if (key === 'tradingMarketDataRegistry') return marketRegistry
      if (key === 'tradingTradeRegistry' && withTrade) return tradeRegistry
      return undefined
    },
    isolate: (name: string) => {
      isolated.push(name)
      return { reflect: { provide: () => {} } }
    },
    effect: (fn: () => () => void) => { fn() },
    reflect: { provide: () => {} },
  } as unknown as Context
  return { ctx, market, trade, isolated }
}

/** loader.unwrapExports 语义：无 default 导出 → 模块命名空间自身即插件对象。 */
const plugin = (dataplane as unknown as { default?: unknown }).default ?? dataplane

describe('Eastmoney 连接器数据面行的 loader 解析面', () => {
  it('用户环境按子路径包名挂行时 dataplane 入口自己导出 apply 与 Config', () => {
    // Given: patch 行写 @dshtrading/connector-eastmoney/dataplane → loader 只读 lib/dataplane.js
    // When: 检查子入口导出面
    // Then: apply 与 Config 都在（缺 Config 时行 config 无 schema 可补默认值）
    expect(typeof dataplane.apply).toBe('function')
    expect(dataplane.Config).toBeDefined()
    expect(dataplane.inject).toEqual([])
  })

  it('用户 patch 行只写 `enabled: true`（cn 行）/ `enabled: true` + `market: hk`（hk 行） 时 loader 补全 schema 默认值', () => {
    // Given: cn bundle 的行 config（`enabled: true`（cn 行）/ `enabled: true` + `market: hk`（hk 行））
    // When: 按 cordis loader 语义解析行 config
    // Then: enabled 原样保留、market 取 schema 缺省 cn
    const resolved = resolveConfig(plugin as never, { enabled: true }) as ConfigType
    expect(resolved.enabled).toBe(true)
    expect(resolved.market).toBe('cn')
  })

  it('用户宿主挂载该行时 (cn, eastmoney) 注册进行情注册表', () => {
    // Given: loader 解析后的行 config（真服务构造，不经假服务替身）
    // When: 挂载数据面行
    // Then: (cn, eastmoney) 进行情注册表，realm 键按实例市场分流
    const resolved = resolveConfig(plugin as never, { enabled: true }) as ConfigType
    const { ctx, market, trade, isolated } = registryCtx()
    dataplane.apply(ctx, resolved)
    expect(market.map((r) => `${r.market}/${r.provider}`)).toEqual(['cn/eastmoney'])
    expect(trade).toHaveLength(0)
    expect(isolated).toEqual([marketDataKey('cn')])
  })

  it('用户手工构造 ctx 且不传 config 时按 schema 默认值挂载而不崩', () => {
    // Given: 单测/第三方宿主直接 apply 不传 config（loader 不参与补默认值）
    // When: 挂载数据面行
    // Then: 按 schema 默认值（enabled=true、market=cn）注册行情服务
    const { ctx, market, trade } = registryCtx()
    expect(() => dataplane.apply(ctx)).not.toThrow()
    expect(market.map((r) => `${r.market}/${r.provider}`)).toEqual(['cn/eastmoney'])
  })

  it('用户 hk 行显式写 market: hk 时注册 (hk, eastmoney) 而不是被打回 cn', () => {
    // Given: hk bundle 的行 config（enabled + market: hk）
    // When: 按 cordis loader 语义解析并挂载
    // Then: 显式 market 原样保留，注册进 hk 市场的 realm 键
    const resolved = resolveConfig(plugin as never, { enabled: true, market: 'hk' }) as ConfigType
    const { ctx, market, isolated } = registryCtx()
    dataplane.apply(ctx, resolved)
    expect(resolved.market).toBe('hk')
    expect(market.map((r) => `${r.market}/${r.provider}`)).toEqual(['hk/eastmoney'])
    expect(isolated).toEqual([marketDataKey('hk')])
  })
})

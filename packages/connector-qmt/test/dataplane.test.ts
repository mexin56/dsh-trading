/**
 * 数据面行 loader 解析面单测（2026-10-14 缺陷回归）。
 *
 * 守卫的是**加载路径**，不是包内直调：patch 行只写 `enabled: true`，loader 只认
 * `lib/dataplane.js` 自己导出的 Config 补默认值（cordis resolveConfig）。缺它时
 * 行 config 原样传入 → `env` 无默认值 → QmtTradeService 构造时 OrderIntentLedger
 * 的 requireNonEmpty 抛 TypeError → 整行 apply 失败，行情与交易两个服务都不注册
 * （两个下单面从未激活）。
 */
import { describe, expect, it } from 'vitest'
import { resolveConfig, type Context } from '@deepseek-ai/cordis'
import * as dataplane from '../src/dataplane.ts'
import { TRADING_CN_MARKET_DATA_KEY, TRADING_CN_TRADE_KEY, type Config as ConfigType } from '../src/index.ts'

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

describe('QMT 连接器数据面行的 loader 解析面', () => {
  it('用户环境按子路径包名挂行时 dataplane 入口自己导出 apply 与 Config', () => {
    // Given: patch 行写 @dshtrading/connector-qmt/dataplane → loader 只读 lib/dataplane.js
    // When: 检查子入口导出面
    // Then: apply 与 Config 都在（缺 Config 时行 config 无 schema 可补默认值）
    expect(typeof dataplane.apply).toBe('function')
    expect(dataplane.Config).toBeDefined()
    expect(dataplane.inject).toEqual([])
  })

  it('用户 patch 行只写 enabled:true 时 loader 补全 env/闸门/网关默认值', () => {
    // Given: cn bundle 的行 config 只有 enabled: true（其余靠 schema 默认值）
    // When: 按 cordis loader 语义解析行 config
    // Then: env=demo、dryRun=true、liveTrading=false、网关指向本机 5800
    const resolved = resolveConfig(plugin as never, { enabled: true }) as ConfigType
    expect(resolved.enabled).toBe(true)
    expect(resolved.env).toBe('demo')
    expect(resolved.dryRun).toBe(true)
    expect(resolved.liveTrading).toBe(false)
    expect(resolved.gatewayUrl).toBe('http://127.0.0.1:5800')
  })

  it('用户显式写 env:live 时不被 schema 默认值打回 demo', () => {
    // Given: 用户在行 config 里显式声明实盘环境
    // When: 按 cordis loader 语义解析行 config
    // Then: env=live 原样保留（默认值只补缺省字段，不覆盖显式值）
    const resolved = resolveConfig(plugin as never, { enabled: true, env: 'live' }) as ConfigType
    expect(resolved.env).toBe('live')
    expect(resolved.liveTrading).toBe(false)
  })

  it('用户宿主挂载该行时行情与交易两个服务都注册进各自注册表', () => {
    // Given: loader 解析后的行 config（真服务构造，不经假服务替身）
    // When: 挂载数据面行
    // Then: (cn, qmt) 同时进行情注册表与交易注册表——两个下单面都被激活
    const resolved = resolveConfig(plugin as never, { enabled: true }) as ConfigType
    const { ctx, market, trade, isolated } = registryCtx()
    dataplane.apply(ctx, resolved)
    expect(market.map((r) => `${r.market}/${r.provider}`)).toEqual(['cn/qmt'])
    expect(trade.map((r) => `${r.market}/${r.provider}`)).toEqual(['cn/qmt'])
    expect(market[0]?.service).toBeDefined()
    expect(trade[0]?.service).toBeDefined()
    expect(isolated).toEqual([TRADING_CN_MARKET_DATA_KEY, TRADING_CN_TRADE_KEY])
  })

  it('用户手工构造 ctx 且不传 config 时按 schema 默认值挂载而不崩', () => {
    // Given: 单测/第三方宿主直接 apply 不传 config（loader 不参与补默认值）
    // When: 挂载数据面行
    // Then: 按 schema 默认值（enabled=true）注册两个服务，不因读 config.enabled 抛错
    const { ctx, market, trade } = registryCtx()
    expect(() => dataplane.apply(ctx)).not.toThrow()
    expect(market).toHaveLength(1)
    expect(trade).toHaveLength(1)
  })
})

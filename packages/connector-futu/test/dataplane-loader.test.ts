/**
 * 数据面行 loader 解析面单测（2026-10-14「dataplane 入口未导出 Config schema」同类债收敛）。
 *
 * 守卫的是**加载路径**，不是包内直调：patch 行只写 `enabled: true` 与 `gatewayUrl`（OpenD 桥 11112），loader 只认
 * `lib/dataplane.js` 自己导出的 Config 补默认值（cordis resolveConfig）。缺它时行 config
 * 原样传入 → schema 默认值全丢 → apply 读到 undefined：行情面与交易面都读 config.gatewayUrl，行内网关地址不生效即回落到 11111（OpenD 原生 TCP）
 */
import { describe, expect, it } from 'vitest'
import { resolveConfig, type Context } from '@deepseek-ai/cordis'
import * as dataplane from '../src/dataplane.ts'
import {
  TRADING_HK_MARKET_DATA_KEY,
  TRADING_HK_TRADE_KEY,
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

describe('Futu 连接器数据面行的 loader 解析面', () => {
  it('用户环境按子路径包名挂行时 dataplane 入口自己导出 apply 与 Config', () => {
    // Given: patch 行写 @dshtrading/connector-futu/dataplane → loader 只读 lib/dataplane.js
    // When: 检查子入口导出面
    // Then: apply 与 Config 都在（缺 Config 时行 config 无 schema 可补默认值）
    expect(typeof dataplane.apply).toBe('function')
    expect(dataplane.Config).toBeDefined()
    expect(dataplane.inject).toEqual([])
  })

  it('用户 patch 行只写 `enabled: true` 与 `gatewayUrl`（OpenD 桥 11112） 时 loader 补全 schema 默认值', () => {
    // Given: hk bundle 的行 config（`enabled: true` 与 `gatewayUrl`（OpenD 桥 11112））
    // When: 按 cordis loader 语义解析行 config
    // Then: enabled=true（schema 缺省是 false）、gatewayUrl 原样保留、dryRun 缺省 true
    const resolved = resolveConfig(plugin as never, { enabled: true, gatewayUrl: 'http://127.0.0.1:11112' }) as ConfigType
    expect(resolved.enabled).toBe(true)
    expect(resolved.gatewayUrl).toBe('http://127.0.0.1:11112')
    expect(resolved.dryRun).toBe(true)
  })

  it('用户宿主挂载该行时 (hk, futu) 与额外行情市场 (us, futu) 及交易注册表都拿到服务', () => {
    // Given: loader 解析后的行 config（真服务构造，不经假服务替身）
    // When: 挂载数据面行
    // Then: (hk, futu) + 额外 (us, futu) 进行情注册表，(hk, futu) 进交易注册表
    const resolved = resolveConfig(plugin as never, { enabled: true, gatewayUrl: 'http://127.0.0.1:11112' }) as ConfigType
    const { ctx, market, trade, isolated } = registryCtx()
    dataplane.apply(ctx, resolved)
    expect(market.map((r) => `${r.market}/${r.provider}`)).toEqual(['hk/futu', 'us/futu'])
    expect(trade.map((r) => `${r.market}/${r.provider}`)).toEqual(['hk/futu'])
    expect(isolated).toEqual([TRADING_HK_MARKET_DATA_KEY, 'tradingUsMarketData', TRADING_HK_TRADE_KEY])
  })

  it('用户手工构造 ctx 且不传 config 时按 schema 默认值硬关（enabled 缺省 false）而不崩', () => {
    // Given: 单测/第三方宿主直接 apply 不传 config（loader 不参与补默认值）
    // When: 挂载数据面行
    // Then: schema 默认 enabled=false 是行级开关，缺省即零注册（不猜、不静默激活）
    const { ctx, market, trade } = registryCtx()
    expect(() => dataplane.apply(ctx)).not.toThrow()
    expect(market).toHaveLength(0)
    expect(trade).toHaveLength(0)
  })
})

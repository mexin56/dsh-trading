/**
 * 路由互斥闸门单测（2026-10-14）。
 *
 * preset 平面的同市场连接器行全部挂在同一个 `cordis:group + isolate` realm 里
 * （loader 的 `isolate()` 对 label=true 给该组一个 LocalRealm、组内子行共用），
 * 组内任意时刻只能有一个 provider 真正 provide 市场服务键。腾讯实例缺这道闸门时，
 * 用户把 cn/hk 路由切到别家（如 eastmoney）会让两行同时 provide →
 * `service "tradingCnMarketData" has been registered at <dsh-trading-tencent>` →
 * agent preset 判 invalid，新建会话失败（2026-10-14 实测复现）。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  ROUTER_PROVIDER,
  TRADING_CN_MARKET_DATA_KEY,
  TRADING_HK_MARKET_DATA_KEY,
  apply,
  type Config,
  type MarketOption,
} from '../src/index.js'

function config(market: MarketOption): Config {
  return { market, dryRun: true, liveTrading: false }
}

/**
 * 形状合法的假 ctx：`get` 供路由 consult、`reflect.provide` 真实收集服务（并挂回 ctx[key]，
 * 因为 inject 回调按 ctx[key] 取服务）、`tools.register` 真实收集工具名。
 * routed=null 表示 router 存在但该市场未选 provider；省略 routed 表示老部署无 router。
 */
function fakeCtx(routed?: string | null): {
  ctx: Context
  provided: Record<string, unknown>
  registered: string[]
} {
  const provided: Record<string, unknown> = {}
  const registered: string[] = []
  const ctx: Record<string, unknown> = {
    get: (key: string) => (key === 'tradingMarketRouter' && routed !== undefined
      ? { activeProvider: () => routed ?? undefined }
      : undefined),
    reflect: {
      provide: (name: string, value: unknown) => {
        provided[name] = value
        ctx[name] = value
      },
    },
    tools: {
      register: (tool: { name: string }) => { registered.push(tool.name) },
      get: () => undefined,
    },
    inject: (_deps: string[], cb: (c: unknown) => void) => { cb(ctx) },
  }
  return { ctx: ctx as unknown as Context, provided, registered }
}

describe('腾讯连接器路由互斥闸门（cn 实例）', () => {
  it('用户把 cn 路由切到 eastmoney 时腾讯让位：既不 provide 服务也不注册工具', () => {
    // Given: 路由 cn = eastmoney（组内另一家会被选中）
    // When: 挂载腾讯 cn 实例
    // Then: 零 provide、零工具注册——组内服务键留给 eastmoney 那行
    const { ctx, provided, registered } = fakeCtx('eastmoney')
    apply(ctx, config('cn'))
    expect(provided[TRADING_CN_MARKET_DATA_KEY]).toBeUndefined()
    expect(registered).toEqual([])
  })

  it('用户把 cn 路由选中 tencent 时腾讯照常激活并提供行情服务', () => {
    // Given: 路由 cn = tencent
    // When: 挂载腾讯 cn 实例
    // Then: provide tradingCnMarketData 且注册 cn_* 工具
    const { ctx, provided, registered } = fakeCtx(ROUTER_PROVIDER)
    apply(ctx, config('cn'))
    expect(provided[TRADING_CN_MARKET_DATA_KEY]).toBeDefined()
    expect(registered).toContain('cn_get_ticker')
    expect(registered).toContain('cn_get_klines')
    expect(registered).toContain('cn_place_order')
    expect(registered.length).toBeGreaterThan(0)
  })

  it('用户环境没有路由服务（老部署）时腾讯按旧行为直接激活', () => {
    // Given: 无 tradingMarketRouter（老部署 / 手搓 ctx 的单测）
    // When: 挂载腾讯 cn 实例
    // Then: 放行（保持旧的单 provider 行为）
    const { ctx, provided } = fakeCtx()
    apply(ctx, config('cn'))
    expect(provided[TRADING_CN_MARKET_DATA_KEY]).toBeDefined()
  })

  it('用户路由服务存在但该市场未选 provider 时腾讯让位（不静默降级）', () => {
    // Given: router 存在，activeProvider('cn') = undefined
    // When: 挂载腾讯 cn 实例
    // Then: 让位——用户设置是权威，不由连接器擅自兜底
    const { ctx, provided, registered } = fakeCtx(null)
    apply(ctx, config('cn'))
    expect(provided[TRADING_CN_MARKET_DATA_KEY]).toBeUndefined()
    expect(registered).toEqual([])
  })
})

describe('腾讯连接器路由互斥闸门（hk 实例，同包双市场）', () => {
  it('用户把 hk 路由切到 eastmoney 时 hk 实例让位', () => {
    // Given: 路由 hk = eastmoney
    // When: 挂载腾讯 hk 实例（同包、config.market=hk）
    // Then: 不 provide tradingHkMarketData、不注册 hk_* 工具
    const { ctx, provided, registered } = fakeCtx('eastmoney')
    apply(ctx, config('hk'))
    expect(provided[TRADING_HK_MARKET_DATA_KEY]).toBeUndefined()
    expect(registered).toEqual([])
  })

  it('用户把 hk 路由选中 tencent 时 hk 实例激活且不动 cn 服务键', () => {
    // Given: 路由 hk = tencent
    // When: 挂载腾讯 hk 实例
    // Then: provide tradingHkMarketData，cn 键缺席
    const { ctx, provided, registered } = fakeCtx(ROUTER_PROVIDER)
    apply(ctx, config('hk'))
    expect(provided[TRADING_HK_MARKET_DATA_KEY]).toBeDefined()
    expect(provided[TRADING_CN_MARKET_DATA_KEY]).toBeUndefined()
    expect(registered).toContain('hk_get_ticker')
  })
})

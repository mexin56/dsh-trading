/**
 * 设置页 provider 登记项 = 连接器 dataplane 实际注册面 的一致性守卫。
 *
 * 候选面板按 `p.markets.includes(market)` 过滤（src/client/trading-settings-controller.ts），
 * 所以 markets 写宽了就是一句实现不了的承诺：用户在该市场下拉里看得见候选、选中后路由到一个
 * 根本没注册的 provider。判据只有一个——连接器 dataplane 那次
 * `register(market, provider, service)` 的真实取值。
 *
 * 本用例按 loader 语义（cordis resolveConfig 补行 config 默认值）驱动**真**连接器 dataplane
 * 模块，用鸭式 ctx 的真注册表收集注册结果，再与 PROVIDER_LABELS 对齐；四个连接器的唯一挂载处
 * 是 packages/hk、packages/cn、packages/us 各自的 cordis.patch.yml（futu 挂在 hk bundle）。
 *
 * 边界：只覆盖本卡点名的四个连接器（tiger/akshare/ibkr/futu），其余 provider 的注册面留在各自包内。
 */
import { describe, expect, it } from 'vitest'
import { resolveConfig, type Context } from '@deepseek-ai/cordis'
import * as tigerDataplane from '@dshtrading/connector-tiger/dataplane'
import * as akshareDataplane from '@dshtrading/connector-akshare/dataplane'
import * as ibkrDataplane from '@dshtrading/connector-ibkr/dataplane'
import * as futuDataplane from '@dshtrading/connector-futu/dataplane'
import { PROVIDER_LABELS } from '../src/client/trading-settings-controller.js'

interface Registration { market: string; provider: string; service: unknown }

interface RegistryHarness {
  ctx: Context
  quote: Registration[]
  trade: Registration[]
}

/**
 * 形状合法的假 ctx：连接器对 router 包零依赖，故按鸭式消费面手搓注册表（register 真实收集 +
 * isolate 返回真服务构造所需的最小 ctx 面），与 packages/connector-ccxt/test/dataplane-loader.test.ts
 * 同款，不引通用 mock 工具。
 */
function registryHarness(): RegistryHarness {
  const quote: Registration[] = []
  const trade: Registration[] = []
  const quoteRegistry = {
    register: (m: string, p: string, service: unknown) => {
      quote.push({ market: m, provider: p, service })
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
      if (key === 'tradingMarketDataRegistry') return quoteRegistry
      if (key === 'tradingTradeRegistry') return tradeRegistry
      return undefined
    },
    isolate: () => ({ reflect: { provide: () => {} } }),
    effect: (fn: () => () => void) => { fn() },
    reflect: { provide: () => {} },
  } as unknown as Context
  return { ctx, quote, trade }
}

/** loader.unwrapExports 语义：无 default 导出 → 模块命名空间自身即插件对象。 */
function pluginOf(mod: unknown): unknown {
  return (mod as { default?: unknown }).default ?? mod
}

/** 驱动一个连接器 dataplane 行：补行 config 默认值后 apply，返回（行情/交易）注册面。 */
function mount(mod: unknown): RegistryHarness {
  const harness = registryHarness()
  const plugin = pluginOf(mod) as { apply: (ctx: Context, config: unknown) => void }
  plugin.apply(harness.ctx, resolveConfig(plugin as never, { enabled: true }))
  return harness
}

/** 设置页登记项声明的市场（缺失 id 时空集合，让断言给出可读失败）。 */
function declaredMarkets(id: string): string[] {
  return [...(PROVIDER_LABELS.find((p) => p.id === id)?.markets ?? [])].sort()
}

/** 注册面实际落到的市场集合。 */
function registeredMarkets(rows: readonly Registration[]): string[] {
  return [...new Set(rows.map((row) => row.market))].sort()
}

describe('设置页 provider 登记面与连接器 dataplane 注册面一致', () => {
  it('用户打开港股行情设置时 tiger 只作为 hk 候选（dataplane 仅注册 hk）', () => {
    // Given: hk bundle cordis.patch.yml 挂载的 @dshtrading/connector-tiger/dataplane 行
    // When: 按 loader 语义解析行 config（enabled: true）并驱动真 dataplane 模块
    // Then: 实际注册面只有 hk/tiger，且与登记表 tiger.markets 相等（写宽即假候选）
    // （dataplane.ts 的 MARKET = 'hk'；us/cn 面未实现）
    const { quote, trade } = mount(tigerDataplane)
    expect(quote.map((row) => `${row.market}/${row.provider}`)).toEqual(['hk/tiger'])
    expect(registeredMarkets(quote)).toEqual(declaredMarkets('tiger'))
    expect(trade).toHaveLength(0)
  })

  it('用户打开 A 股行情设置时 akshare 只作为 cn 候选（dataplane 仅注册 cn）', () => {
    // Given: cn bundle cordis.patch.yml 挂载的 @dshtrading/connector-akshare/dataplane 行
    // When: 按 loader 语义解析行 config（enabled: true）并驱动真 dataplane 模块
    // Then: 实际注册面只有 cn/akshare，且与登记表 akshare.markets 相等
    // （dataplane.ts 的 MARKET = 'cn'；hk 面未实现）
    const { quote } = mount(akshareDataplane)
    expect(quote.map((row) => `${row.market}/${row.provider}`)).toEqual(['cn/akshare'])
    expect(registeredMarkets(quote)).toEqual(declaredMarkets('akshare'))
  })

  it('用户打开美股行情设置时 ibkr 只作为 us 候选（dataplane 仅注册 us）', () => {
    // Given: us bundle cordis.patch.yml 挂载的 @dshtrading/connector-ibkr/dataplane 行
    // When: 按 loader 语义解析行 config（enabled: true）并驱动真 dataplane 模块
    // Then: 实际注册面只有 us/ibkr，且与登记表 ibkr.markets 相等
    // （dataplane.ts 的 MARKET = 'us'；hk 面未实现）
    const { quote } = mount(ibkrDataplane)
    expect(quote.map((row) => `${row.market}/${row.provider}`)).toEqual(['us/ibkr'])
    expect(registeredMarkets(quote)).toEqual(declaredMarkets('ibkr'))
  })

  it('用户打开富途设置时行情面是 hk+us、交易面只有 hk（行情面与登记表 markets 相等）', () => {
    // Given: hk bundle cordis.patch.yml 挂载的 @dshtrading/connector-futu/dataplane 行
    // When: 按 loader 语义解析行 config（enabled: true）并驱动真 dataplane 模块
    // Then: 行情注册面 hk+us == 登记表 futu.markets；交易注册面仅 hk（美股下单未接）
    // （dataplane.ts MARKET = 'hk' + EXTRA_QUOTE_MARKETS = ['us']）
    const { quote, trade } = mount(futuDataplane)
    expect(quote.map((row) => `${row.market}/${row.provider}`)).toEqual(['hk/futu', 'us/futu'])
    expect(registeredMarkets(quote)).toEqual(declaredMarkets('futu'))
    expect(trade.map((row) => `${row.market}/${row.provider}`)).toEqual(['hk/futu'])
  })

  it('用户看到 futu 的配置提示时它指向 Config 字段 gatewayUrl，而不是环境变量名或无人读的 host/port', () => {
    // Given: connector-futu dataplane 的 Config schema（loader 补默认值用的那一份）
    // When: 解析行 config 并读登记表里 futu 的提示字段
    // Then: 提示落在 configField 槽（env 槽为空），值是 'gatewayUrl' 且真出现在 resolveConfig 结果里
    // （futu 的 rest 客户端没有 gatewayUrl 的 env 兜底，全包唯一 process.env 读取是 unlockPwdRef；
    //   面板原来的 host/port 字段不在这份 schema 里，写进设置字典也无人读——2026-10-15 已撤）
    const futu = PROVIDER_LABELS.find((p) => p.id === 'futu')
    const resolved = resolveConfig(pluginOf(futuDataplane) as never, { enabled: true }) as Record<string, unknown>
    expect(futu?.env).toBeUndefined()
    expect(futu?.configField).toBe('gatewayUrl')
    expect(Object.keys(resolved)).toContain('gatewayUrl')
  })

  it('用户浏览任一市场的 provider 候选时每条登记都有市场（markets 非空）', () => {
    // Given: PROVIDER_LABELS 全表
    // When: 检查每条登记的 markets
    // Then: 没有空 markets（空则该 provider 在任何市场下拉里都不可见）
    expect(PROVIDER_LABELS.length).toBeGreaterThan(0)
    expect(PROVIDER_LABELS.filter((p) => p.markets.length === 0).map((p) => p.id)).toEqual([])
  })
})

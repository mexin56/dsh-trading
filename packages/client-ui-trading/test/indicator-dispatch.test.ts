/**
 * 指标调度与定义白名单的纯逻辑用例（契约 §5，决策 3/5/7）：
 * 声明 aux 的实例在外部序列未就绪时整体不进调度（副图 pane 不存在，不是空线），
 * 就绪后只走 computeAux 且取 holdRatio 口径；未声明 aux 的指标维持 compute 路径；
 * definition.markets 白名单在选择器/词条带与调度两条路上一致生效；
 * 新挂载的港股通持股比例默认只适用 1d/1w/1M。
 */
import { describe, expect, it } from 'vitest'
import type { IndicatorDefinition, IndicatorInstance, Kline } from '@dshtrading/indicators'
import { createIndicatorRegistry, isInstanceApplicableOn, presetDefinitions } from '@dshtrading/indicators'
import type { AuxSeriesMap } from '@dshtrading/indicators'
import { HK_CONNECT_HOLDING_KEY } from '../src/client/aux-series.ts'
import { defaultScopeEntries } from '../src/client/indicator-defaults.ts'
import { availableDefinitions, dispatchIndicatorGroups } from '../src/client/indicator-dispatch.ts'

const DAY = 86_400_000
const HOLDING_ID = 'hk-connect-holding'

/** 真实注册表 + 真实预置名册（参数 clamp 与实例 key 都走生产实现）。 */
const registry = createIndicatorRegistry()
for (const definition of presetDefinitions()) registry.register(definition)

const deps = {
  getDefinition: (id: string): IndicatorDefinition | undefined => registry.get(id),
  clampParams: (definition: IndicatorDefinition, params: Record<string, number>): Record<string, number> => registry.clampParams(definition, params),
  instanceKey: (instance: IndicatorInstance): string => registry.instanceKey(instance),
}

/** 三个连续交易日（2026-10-05/06/07），收盘恒为 10.5。 */
function dailyBars(): Kline[] {
  return [0, 1, 2].map(offset => {
    const openTime = Date.UTC(2026, 9, 5 + offset)
    return { openTime, closeTime: openTime + DAY - 1, open: 10, high: 11, low: 9, close: 10.5, volume: 100 }
  })
}

/** 外部序列：只有前两个交易日有值（第三个交易日按前向填充重复 12.5）。 */
const HOLDING_SERIES: AuxSeriesMap = {
  [HK_CONNECT_HOLDING_KEY]: [
    { date: Date.UTC(2026, 9, 5), value: 11.9 },
    { date: Date.UTC(2026, 9, 6), value: 12.5 },
  ],
}

const holdingInstance: IndicatorInstance = { id: HOLDING_ID, params: {} }
const maInstance: IndicatorInstance = { id: 'ma', params: {} }

describe('指标调度（副图门控与定义白名单）', () => {
  it('用户尚未取到港股通持股数据时，该副图整体不进调度（不是空线也不是零线）', () => {
    // Given 港股通持股比例已挂载，但外部序列为空表（取数失败 / 非港股通标的）
    // When 调度渲染组
    const groups = dispatchIndicatorGroups({
      klines: dailyBars(), instances: [holdingInstance], market: 'hk', symbol: '00700.HK', aux: {}, deps,
    })

    // Then 该实例完全不在渲染输入里：副图 pane 不存在
    expect(groups).toEqual([])
  })

  it('用户取到港股通持股数据后，副图走 computeAux 并按交易日对齐 holdRatio', () => {
    // Given 港股通持股比例已挂载且外部序列就绪（预置 definition 的 compute 兜底返回空数组，
    // 若调度误走 compute，下面断言的非空输出必然失败）
    // When 调度渲染组
    const groups = dispatchIndicatorGroups({
      klines: dailyBars(), instances: [holdingInstance], market: 'hk', symbol: '00700.HK', aux: HOLDING_SERIES, deps,
    })

    // Then 恰好一个副图组，单条曲线的值 = 持股比例（未覆盖的交易日前向填充）
    expect(groups).toHaveLength(1)
    expect(groups[0]?.pane).toBe('sub')
    expect(groups[0]?.title).toBe('港股通持股比例')
    expect(groups[0]?.outputs).toEqual([
      expect.objectContaining({ key: 'HK_CONNECT_HOLDING', values: [11.9, 12.5, 12.5] }),
    ])
  })

  it('用户挂载了空的外部序列时，副图同样隐藏（空 ≠ 0）', () => {
    // Given 桥返回了 0 条持股记录（标的不在港股通范围）
    // When 调度渲染组
    const groups = dispatchIndicatorGroups({
      klines: dailyBars(), instances: [holdingInstance], market: 'hk', symbol: '00700.HK', aux: { [HK_CONNECT_HOLDING_KEY]: [] }, deps,
    })

    // Then 不画出一条贴底的假线
    expect(groups).toEqual([])
  })

  it('用户挂载未声明 aux 的指标时，仍走 compute 路径且不受外部序列缺席影响', () => {
    // Given MA（无 aux 声明）与空的港股通序列
    // When 调度渲染组
    const groups = dispatchIndicatorGroups({
      klines: dailyBars(), instances: [maInstance], market: 'hk', symbol: '00700.HK', aux: {}, deps,
    })

    // Then MA 照常产出六条均线（零回归：既有主图叠加不受新门控影响）
    expect(groups).toHaveLength(1)
    expect(groups[0]?.pane).toBe('main')
    expect(groups[0]?.outputs.map(output => output.key)).toEqual(['MA5', 'MA10', 'MA20', 'MA30', 'MA60', 'MA120'])
  })

  it('用户切到美股时，港股通持股比例既不进选择器也不进渲染调度', () => {
    // Given 定义白名单里只允许港股的指标
    // When 在美股市场枚举选择器定义并调度同一实例
    const onUs = availableDefinitions(presetDefinitions(), 'us')
    const groups = dispatchIndicatorGroups({
      klines: dailyBars(), instances: [holdingInstance], market: 'us', symbol: 'AAPL', aux: HOLDING_SERIES, deps,
    })

    // Then 选择器与渲染两条路都不出现该指标；港股选择器里则正常出现
    expect(onUs.some(definition => definition.id === HOLDING_ID)).toBe(false)
    expect(groups).toEqual([])
    expect(availableDefinitions(presetDefinitions(), 'hk').some(definition => definition.id === HOLDING_ID)).toBe(true)
  })

  it('用户无聚焦市场时，选择器不过滤（与实例级兜底同款：市场缺失不隐藏指标）', () => {
    // Given 无聚焦市场（market 缺席）
    // When 枚举选择器定义
    const definitions = availableDefinitions(presetDefinitions(), undefined)

    // Then 限额指标照常出现，不会因市场未知而消失
    expect(definitions.some(definition => definition.id === HOLDING_ID)).toBe(true)
  })
})

describe('港股通持股比例的默认适用范围', () => {
  /** 预置定义（默认范围的唯一一个家，客户端只读取不另存一份表）。 */
  const holdingDefinition = presetDefinitions().find(definition => definition.id === HOLDING_ID)
  const maDefinition = presetDefinitions().find(definition => definition.id === 'ma')

  it('用户首次挂载港股通持股比例时，默认只勾日线及以上级别', () => {
    // Given 定义侧声明的默认适用范围
    const applyScope = holdingDefinition?.defaultApplyScope

    // When 按该默认值构建实例并逐级别判定适用性
    const instance: IndicatorInstance = { id: HOLDING_ID, params: {}, applyScope: applyScope ?? {} }

    // Then 1d/1w/1M 适用，分钟级不适用（决策 7）
    expect(isInstanceApplicableOn(instance, 'hk', '1d')).toBe(true)
    expect(isInstanceApplicableOn(instance, 'hk', '1w')).toBe(true)
    expect(isInstanceApplicableOn(instance, 'hk', '1M')).toBe(true)
    for (const interval of ['5m', '15m', '30m', '1h']) {
      expect(isInstanceApplicableOn(instance, 'hk', interval)).toBe(false)
    }
  })

  it('用户挂载其它指标时，定义未声明默认范围则不写入任何条目', () => {
    // Given 未声明默认范围的普通指标与已声明的港股通持股比例
    // When 读取挂载时要补写的条目
    // Then 空表（存量指标维持「全部级别应用」，零迁移），声明的指标给出日线及以上
    expect(defaultScopeEntries(maDefinition)).toEqual([])
    expect(defaultScopeEntries(undefined)).toEqual([])
    expect(defaultScopeEntries(holdingDefinition)).toEqual([
      { market: 'hk', scope: { enabled: true, intervals: ['1d', '1w', '1M'] } },
    ])
  })

  it('用户挂载港股通持股比例时，客户端补写的条目是定义默认值的副本', () => {
    // Given 定义侧声明的默认适用范围
    if (holdingDefinition === undefined) throw new Error('preset hk-connect-holding missing')

    // When 取挂载时要补写的条目并改动它
    const entries = defaultScopeEntries(holdingDefinition)
    entries[0]?.scope.intervals.push('5m')

    // Then definition 不被调用方改动（写入路径之间不共享可变引用）
    expect(holdingDefinition.defaultApplyScope).toEqual({ hk: { enabled: true, intervals: ['1d', '1w', '1M'] } })
  })
})

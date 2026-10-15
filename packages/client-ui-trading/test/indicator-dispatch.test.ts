/**
 * 指标调度与定义白名单的纯逻辑用例（契约 §5，决策 3/5/7）：
 * 声明 aux 的实例在外部序列未就绪时出「空 outputs + 空态键位」的占位组（副图 pane
 * 出现并给理由，不是空线、不是零线），未就绪的其它形态（宿主缺 computeAux、部分键有
 * 数据）仍然整组不进调度；就绪后只走 computeAux 且取 holdRatio 口径；未声明 aux 的
 * 指标维持 compute 路径；definition.markets 白名单在选择器/词条带与调度两条路上一致生效；
 * 新挂载的港股通持股比例默认只适用 1d/1w/1M。
 */
import { describe, expect, it } from 'vitest'
import type { IndicatorDefinition, IndicatorInstance, Kline } from '@dshtrading/indicators'
import { FIVE_DAY_VOLUME_TIER_AUX_KEY, createIndicatorRegistry, isInstanceApplicableOn, presetDefinitions } from '@dshtrading/indicators'
import type { AuxBarSeriesMap, AuxSeriesMap } from '@dshtrading/indicators'
import { CN_ACTIVE_BUY_KEY, HK_CONNECT_HOLDING_KEY } from '../src/client/aux-series.ts'
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
const activeBuyInstance: IndicatorInstance = { id: 'active-buy', params: {} }

/** 主动买盘的外部序列（两个交易日有值，第三根无点 → 区间匹配留空）。 */
const ACTIVE_BUY_SERIES: AuxSeriesMap = {
  [CN_ACTIVE_BUY_KEY]: [
    { date: Date.UTC(2026, 9, 5), value: 4.11 },
    { date: Date.UTC(2026, 9, 6), value: -2.5 },
  ],
}

describe('指标调度（副图门控与定义白名单）', () => {
  it('用户尚未取到港股通持股数据时，副图不再静默消失而是出一个带空态标记的占位组', () => {
    // Given 港股通持股比例已挂载，但外部序列为空表（取数失败 / 非港股通标的）
    // When 调度渲染组
    const groups = dispatchIndicatorGroups({
      klines: dailyBars(), instances: [holdingInstance], market: 'hk', symbol: '00700.HK', aux: {}, deps,
    })

    // Then 恰好一个占位组：pane 照常出现、组内没有任何输出、没有 live 标记，
    // 只带一个数据域键位供 UI 层翻译空态理由（空 ≠ 0）
    expect(groups).toEqual([{
      id: HOLDING_ID,
      title: '港股通持股比例',
      pane: 'sub',
      key: 'hk-connect-holding:',
      outputs: [],
      auxEmptyKey: HK_CONNECT_HOLDING_KEY,
    }])
    expect(groups[0]?.outputs).toHaveLength(0)
    expect(Object.hasOwn(groups[0] ?? {}, 'live')).toBe(false)
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

  it('用户挂载了空的外部序列时，同样出占位组而不是画一条贴底的假线（空 ≠ 0）', () => {
    // Given 桥返回了 0 条持股记录（标的不在港股通范围）
    // When 调度渲染组
    const groups = dispatchIndicatorGroups({
      klines: dailyBars(), instances: [holdingInstance], market: 'hk', symbol: '00700.HK', aux: { [HK_CONNECT_HOLDING_KEY]: [] }, deps,
    })

    // Then 显示为占位组（键位说明「取不到」），零数据点
    expect(groups.map(group => [group.auxEmptyKey, group.outputs.length])).toEqual([[HK_CONNECT_HOLDING_KEY, 0]])
  })

  it('用户挂载主动买盘却没有采集记录时，占位组的空态键位指向主动买盘自己的文案', () => {
    // Given A 股标的 + 已挂载的主动买盘，外部序列两种形态都没有数据
    // When 分别以缺席与空数组调度
    const absent = dispatchIndicatorGroups({ klines: dailyBars(), instances: [activeBuyInstance], market: 'cn', symbol: '600519.SH', aux: {}, deps })
    const empty = dispatchIndicatorGroups({ klines: dailyBars(), instances: [activeBuyInstance], market: 'cn', symbol: '600519.SH', aux: { [CN_ACTIVE_BUY_KEY]: [] }, deps })

    // Then 两条路都出同一个占位组，键位是 cn-active-buy（不是通用文案、也不是港股通那条）
    expect(absent).toEqual(empty)
    expect(absent).toEqual([{
      id: 'active-buy',
      title: '主动买盘',
      pane: 'sub',
      key: 'active-buy:',
      outputs: [],
      auxEmptyKey: CN_ACTIVE_BUY_KEY,
    }])
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

describe('港股通持股比例的默认适用范围', () => {  /** 预置定义（默认范围的唯一一个家，客户端只读取不另存一份表）。 */
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

/**
 * 逐根序列通道的探针定义（真实 definition 对象，注入真实注册表）：barAux 声明冻结键，
 * compute 与 computeBarAux 的输出刻意可区分（1 与 5），用来钉住调度实际走了哪条入口——
 * 不靠调用计数，靠**值**。
 */
const PROBE_ID = 'volume-tier-probe'

function probeDefinition(): IndicatorDefinition {
  return {
    id: PROBE_ID,
    pane: 'sub',
    title: '五日成交量档位',
    params: [],
    barAux: [FIVE_DAY_VOLUME_TIER_AUX_KEY],
    compute: () => [{ key: 'VOL', kind: 'histogram', color: '#888888', values: [1, 1, 1] }],
    computeBarAux: (_bars, _params, barAux) => [{
      key: 'VOL',
      kind: 'histogram',
      color: '#888888',
      values: (barAux[FIVE_DAY_VOLUME_TIER_AUX_KEY] ?? []).map(code => code ?? -1),
    }],
  }
}

const barAuxRegistry = createIndicatorRegistry()
barAuxRegistry.register(probeDefinition())

const barAuxDeps = {
  getDefinition: (id: string): IndicatorDefinition | undefined => barAuxRegistry.get(id),
  clampParams: (definition: IndicatorDefinition, params: Record<string, number>): Record<string, number> => barAuxRegistry.clampParams(definition, params),
  instanceKey: (instance: IndicatorInstance): string => barAuxRegistry.instanceKey(instance),
}

const probeInstance: IndicatorInstance = { id: PROBE_ID, params: {} }

/** 逐根序列齐备（长度 = 3 根 bar）与两种未就绪形态（短 / 长）。 */
const READY_BAR_AUX: AuxBarSeriesMap = { [FIVE_DAY_VOLUME_TIER_AUX_KEY]: [0, 2, 4] }

function dispatchProbe(barAux?: AuxBarSeriesMap) {
  return dispatchIndicatorGroups({
    klines: dailyBars(),
    instances: [probeInstance],
    market: 'us',
    symbol: 'AAPL',
    aux: {},
    ...(barAux !== undefined ? { barAux } : {}),
    deps: barAuxDeps,
  })
}

describe('逐根序列通道（barAux）的调度选择', () => {
  it('用户看五日图且档位序列与图表序列等长时，成交量指标走 computeBarAux 并逐根取档位编码', () => {
    // Given 三日图表序列 + 等长的三日档位编码

    // When 调度渲染组
    const groups = dispatchProbe(READY_BAR_AUX)

    // Then 副图照常出现，值就是注入的编码（若误走 compute 会是全 1）
    expect(groups).toHaveLength(1)
    expect(groups[0]?.pane).toBe('sub')
    expect(groups[0]?.title).toBe('五日成交量档位')
    expect(groups[0]?.outputs).toEqual([expect.objectContaining({ key: 'VOL', values: [0, 2, 4] })])
  })

  it('用户不在五日级别时，逐根序列缺席也照常渲染——回落 compute 而不是隐藏实例', () => {
    // Given 未传 barAux（非五日级别）+ 空表形态的 barAux，两种「没有逐根数据」
    // When 分别调度渲染组
    const withoutBarAux = dispatchProbe()
    const withEmptyMap = dispatchProbe({})

    // Then 两次都出组（与 aux 的「缺失即隐藏」相反），走的是 compute 路径
    for (const groups of [withoutBarAux, withEmptyMap]) {
      expect(groups).toHaveLength(1)
      expect(groups[0]?.outputs).toEqual([expect.objectContaining({ key: 'VOL', values: [1, 1, 1] })])
    }
  })

  it('用户刚切到五日级别、档位序列尚未算出（声明了键但数组为空）时，同样回落 compute', () => {
    // Given 声明键存在但值为空数组（切级别瞬间的中间态）
    // When 调度渲染组
    const groups = dispatchProbe({ [FIVE_DAY_VOLUME_TIER_AUX_KEY]: [] })

    // Then 不把「没有档位」当成 0 档画成中性色，而是回落 compute
    expect(groups).toHaveLength(1)
    expect(groups[0]?.outputs).toEqual([expect.objectContaining({ key: 'VOL', values: [1, 1, 1] })])
  })

  it('用户在级别切换/换档的中间帧拿到长度不符的档位序列时，按未就绪回落 compute（不错位着色）', () => {
    // Given 比图表序列短一根与长一根的两种档位序列
    // When 分别调度渲染组
    const tooShort = dispatchProbe({ [FIVE_DAY_VOLUME_TIER_AUX_KEY]: [0, 2] })
    const tooLong = dispatchProbe({ [FIVE_DAY_VOLUME_TIER_AUX_KEY]: [0, 2, 4, 1] })

    // Then 两种都不进逐根通道：下标对齐不猜，宁可无色
    for (const groups of [tooShort, tooLong]) {
      expect(groups).toHaveLength(1)
      expect(groups[0]?.outputs).toEqual([expect.objectContaining({ key: 'VOL', values: [1, 1, 1] })])
    }
  })

  it('用户挂载未声明 barAux 的指标时，注入的逐根序列不影响其 compute 路径（零回归）', () => {
    // Given 声明 aux 的港股通指标（不声明 barAux）与齐备的逐根序列
    // When 调度渲染组
    const groups = dispatchIndicatorGroups({
      klines: dailyBars(),
      instances: [holdingInstance],
      market: 'hk',
      symbol: '00700.HK',
      aux: HOLDING_SERIES,
      barAux: READY_BAR_AUX,
      deps,
    })

    // Then 仍只走 computeAux，输出与不传逐根序列时一致
    expect(groups).toHaveLength(1)
    expect(groups[0]?.outputs).toEqual([
      expect.objectContaining({ key: 'HK_CONNECT_HOLDING', values: [11.9, 12.5, 12.5] }),
    ])
  })
})

/**
 * 占位机制的边界探针（真实 definition 对象，注入真实注册表）：双键定义用来钉住
 * 「部分键有数据不发明新语义」，缺 computeAux 的定义用来钉住「宿主没这个能力 ≠ 该标的没数据」。
 */
const TWO_KEY_PROBE_ID = 'aux-two-key-probe'
const NO_IMPL_PROBE_ID = 'aux-no-impl-probe'

function auxProbeDefinition(id: string, auxKeys: readonly string[], withImpl: boolean): IndicatorDefinition {
  return {
    id,
    pane: 'sub',
    title: id,
    params: [],
    aux: auxKeys,
    compute: () => [],
    ...(withImpl
      ? { computeAux: (_bars: readonly Kline[], _params: Record<string, number>, aux: AuxSeriesMap) => [{ key: 'PROBE', kind: 'line' as const, color: '#000000', values: (aux[HK_CONNECT_HOLDING_KEY] ?? []).map(point => point.value) }] }
      : {}),
  }
}

const auxProbeRegistry = createIndicatorRegistry()
auxProbeRegistry.register(auxProbeDefinition(TWO_KEY_PROBE_ID, [HK_CONNECT_HOLDING_KEY, CN_ACTIVE_BUY_KEY], true))
auxProbeRegistry.register(auxProbeDefinition(NO_IMPL_PROBE_ID, [HK_CONNECT_HOLDING_KEY], false))

const auxProbeDeps = {
  getDefinition: (id: string): IndicatorDefinition | undefined => auxProbeRegistry.get(id),
  clampParams: (definition: IndicatorDefinition, params: Record<string, number>): Record<string, number> => auxProbeRegistry.clampParams(definition, params),
  instanceKey: (instance: IndicatorInstance): string => auxProbeRegistry.instanceKey(instance),
}

function dispatchProbeAux(id: string, aux: AuxSeriesMap) {
  return dispatchIndicatorGroups({
    klines: dailyBars(), instances: [{ id, params: {} }], market: 'hk', symbol: '00700.HK', aux, deps: auxProbeDeps,
  })
}

describe('aux 占位组的边界（不发明新语义）', () => {
  it('用户挂载的双键指标只有部分键有数据时，仍然整组不进调度（不猜该画哪条）', () => {
    // Given 声明两个 aux 键的探针，只备了其中一个键的非空序列
    // When 调度渲染组
    const groups = dispatchProbeAux(TWO_KEY_PROBE_ID, HOLDING_SERIES)

    // Then 既没有数据组也没有占位组：空态只能来自「每个声明键都没有非空序列」
    expect(groups).toEqual([])
  })

  it('用户挂载的双键指标一个键都没有数据时，占位组的空态键位取首个声明键', () => {
    // Given 声明两个 aux 键的探针，两个键都没有非空序列
    // When 调度渲染组
    const groups = dispatchProbeAux(TWO_KEY_PROBE_ID, {})

    // Then 出占位组且键位是声明顺序的第一个，输出仍为空
    expect(groups.map(group => [group.auxEmptyKey, group.outputs.length])).toEqual([[HK_CONNECT_HOLDING_KEY, 0]])
  })

  it('用户挂载的定义声明了 aux 但宿主没有该通道实现时，维持隐藏而不是谎报「无采集记录」', () => {
    // Given 一个声明 aux 却没有 computeAux 的定义（宿主未实现该能力）
    // When 调度渲染组
    const groups = dispatchProbeAux(NO_IMPL_PROBE_ID, {})

    // Then 整组不进调度：没有数据源可画，「宿主不支持」与「该标的没有记录」是两回事
    expect(groups).toEqual([])
  })
})

describe('占位机制对有数据副图的零回归', () => {
  it('用户看有数据的港股通副图时，调度输出与占位机制引入前逐字一致', () => {
    // Given 有非空外部序列的港股通持股比例（第三根按前向填充）
    // When 调度渲染组并整体序列化
    const groups = dispatchIndicatorGroups({
      klines: dailyBars(), instances: [holdingInstance], market: 'hk', symbol: '00700.HK', aux: HOLDING_SERIES, deps,
    })

    // Then 逐字等于改动前捕获的同一输入输出：没有新增字段、没有值漂移
    expect(JSON.stringify(groups)).toBe('[{"id":"hk-connect-holding","title":"港股通持股比例","pane":"sub","key":"hk-connect-holding:","outputs":[{"key":"HK_CONNECT_HOLDING","kind":"line","color":"#7c5cff","values":[11.9,12.5,12.5],"precision":2}]}]')
    expect(Object.hasOwn(groups[0] ?? {}, 'auxEmptyKey')).toBe(false)
  })

  it('用户看有数据的主动买盘副图时，调度输出与占位机制引入前逐字一致', () => {
    // Given 有非空外部序列的主动买盘
    // When 调度渲染组并整体序列化
    const groups = dispatchIndicatorGroups({
      klines: dailyBars(), instances: [activeBuyInstance], market: 'cn', symbol: '600519.SH', aux: ACTIVE_BUY_SERIES, deps,
    })

    // Then 逐字等于改动前捕获的同一输入输出（含净值/买占两条输出的派生值）
    expect(JSON.stringify(groups)).toBe('[{"id":"active-buy","title":"主动买盘","pane":"sub","key":"active-buy:","outputs":[{"key":"净买","kind":"histogram","histogramBySign":true,"color":"#e64545","values":[4.11,-2.5,null],"precision":2},{"key":"买占","kind":"line","color":"#3b82f6","values":[52.055,48.75,null],"precision":2}]}]')
  })

  it('用户看有数据的主动买盘副图且该键命中 live 时，live 标记与改动前一致', () => {
    // Given 同一非空序列 + 命中的 live 键
    // When 调度渲染组
    const groups = dispatchIndicatorGroups({
      klines: dailyBars(), instances: [activeBuyInstance], market: 'cn', symbol: '600519.SH', aux: ACTIVE_BUY_SERIES, liveKeys: [CN_ACTIVE_BUY_KEY], deps,
    })

    // Then live 仍是唯一被注入的标记，数值输出不受影响
    expect(groups.map(group => group.live)).toEqual([true])
    expect(groups[0]?.outputs.map(output => output.values)).toEqual([[4.11, -2.5, undefined], [52.055, 48.75, undefined]])
  })
})

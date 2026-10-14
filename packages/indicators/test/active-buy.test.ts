/**
 * 主动买盘预置指标单测（冻结规格）：元数据与适用范围/说明、数值向量与口径恒等式
 * （买占 = (100 + 净买占比) / 2）、无数据返回空输出（空 ≠ 0）、交易日对齐（只取 K 线
 * 覆盖区间内的点，含周 K 端点、当日点缺席与区间内无点，无前向填充）、脏数据断开、
 * 旧宿主误调 compute 不画线、市场可用性。
 */
import { describe, expect, it } from 'vitest'
import type { AuxPoint, IndicatorDefinition, Kline } from '../src/index.ts'
import { isDefinitionAvailableOn, presetDefinitions } from '../src/index.ts'

const DAY = 86_400_000
/** 外部序列键（冻结字面量，与桥端点/宿主 prefetch 键同名）。 */
const AUX_KEY = 'cn-active-buy'

function day(year: number, month: number, date: number): number {
  return Date.UTC(year, month - 1, date)
}

function dailyBar(tradingDay: number): Kline {
  return {
    openTime: tradingDay,
    closeTime: tradingDay + DAY - 1,
    open: 10, high: 11, low: 9, close: 10.5, volume: 100,
  }
}

function weeklyBar(periodStart: number): Kline {
  return {
    openTime: periodStart,
    closeTime: periodStart + 7 * DAY - 1,
    open: 10, high: 11, low: 9, close: 10.5, volume: 500,
  }
}

/** 覆盖指定首末日（闭区间）的周 K：用于区间端点与区间内无点的边界用例。 */
function spanBar(periodStart: number, periodEnd: number): Kline {
  return {
    openTime: periodStart,
    closeTime: periodEnd + DAY - 1,
    open: 10, high: 11, low: 9, close: 10.5, volume: 500,
  }
}

function activeBuyDefinition(): IndicatorDefinition {
  const definition = presetDefinitions().find(entry => entry.id === 'active-buy')
  if (definition === undefined) throw new Error('preset active-buy missing')
  return definition
}

/** 取该 definition 的 aux 输出（无 aux 输出时返回空数组，便于断言「空 ≠ 0」）。 */
function auxOutputs(bars: readonly Kline[], aux: Record<string, readonly AuxPoint[]>) {
  return activeBuyDefinition().computeAux?.(bars, {}, aux) ?? []
}

describe('主动买盘预置定义', () => {
  it('用户看指标选择器时，该指标仅 A 股可用、副图、无参数，并标明数据来源与盘中口径', () => {
    // Given: 预置定义名册里的主动买盘
    const definition = activeBuyDefinition()
    // When: 读取其展示、适用范围与说明元数据
    const { pane, title, params, markets, aux, defaultApplyScope } = definition
    const description = definition.description ?? ''
    // Then: 冻结规格逐项成立
    expect(definition.id).toBe('active-buy')
    expect(title).toBe('主动买盘')
    expect(pane).toBe('sub')
    expect(params).toEqual([])
    expect(markets).toEqual(['cn'])
    expect(aux).toEqual([AUX_KEY])
    expect(defaultApplyScope).toEqual({ cn: { enabled: true, intervals: ['1d', '1w', '1M'] } })
    // Then: 说明写明数据来源与失真前提、以及「当日柱是盘中累计值」的口径
    expect(description).toContain('腾讯盘口')
    expect(description).toContain('非交易所官方逐笔方向')
    expect(description).toContain('盘中累计到最新取数时刻')
    expect(description).toContain('当日终值')
  })

  it('用户看日 K 时，净买柱与买占线逐日对齐且满足口径恒等式', () => {
    // Given: 三个交易日的日 K 与三天的净主动买占比
    const bars = [dailyBar(day(2026, 10, 5)), dailyBar(day(2026, 10, 6)), dailyBar(day(2026, 10, 7))]
    const points: AuxPoint[] = [
      { date: day(2026, 10, 5), value: -9.25 },
      { date: day(2026, 10, 6), value: 3.5 },
      { date: day(2026, 10, 7), value: 0 },
    ]
    // When: 走 computeAux 入口
    const outputs = auxOutputs(bars, { [AUX_KEY]: points })
    // Then: 两条输出（净买柱 + 买占线），样式与精度按冻结规格
    expect(outputs).toHaveLength(2)
    expect(outputs[0]?.key).toBe('净买')
    expect(outputs[0]?.kind).toBe('histogram')
    expect(outputs[0]?.histogramBySign).toBe(true)
    expect(outputs[0]?.color).toBe('#e64545')
    expect(outputs[0]?.precision).toBe(2)
    expect(outputs[1]?.key).toBe('买占')
    expect(outputs[1]?.kind).toBe('line')
    expect(outputs[1]?.color).toBe('#3b82f6')
    expect(outputs[1]?.precision).toBe(2)
    // Then: 数值向量与交易日一一对应（net = aux 原值，买占 = (100 + net) / 2）
    expect(outputs[0]?.values).toEqual([-9.25, 3.5, 0])
    expect(outputs[1]?.values).toEqual([45.375, 51.75, 50])
    expect(outputs[0]?.values).toHaveLength(bars.length)
    expect(outputs[1]?.values).toHaveLength(bars.length)
    // Then: 两条序列之间的恒等式逐条成立（买占 − 卖占 = 净买，卖占 = 100 − 买占）
    const net = outputs[0]?.values ?? []
    const buyShare = outputs[1]?.values ?? []
    for (let index = 0; index < net.length; index += 1) {
      const buy = buyShare[index]
      expect(buy).toBeDefined()
      expect(2 * (buy ?? 0) - 100).toBeCloseTo(net[index] ?? Number.NaN, 10)
    }
  })

  it('用户看周 K 时，每根取该周区间内最新一条净主动买占比', () => {
    // Given: 两根周 K，第一周内 10-06 与 10-09 各有一条外部值，第二周有 10-13
    const bars = [weeklyBar(day(2026, 10, 5)), weeklyBar(day(2026, 10, 12))]
    const points: AuxPoint[] = [
      { date: day(2026, 10, 6), value: 3.5 },
      { date: day(2026, 10, 9), value: -9.25 },
      { date: day(2026, 10, 13), value: 6 },
    ]
    // When: 计算副图序列
    const outputs = auxOutputs(bars, { [AUX_KEY]: points })
    // Then: 取区间末已知值（不是周期起点的 3.5，也不越界取下一周的值）
    expect(outputs[0]?.values).toEqual([-9.25, 6])
    expect(outputs[1]?.values).toEqual([45.375, 53])
  })

  it('用户看序列起点之前的 K 线时，该段留空而不是回填', () => {
    // Given: 盘口快照从第二个交易日才开始累积
    const bars = [dailyBar(day(2026, 10, 5)), dailyBar(day(2026, 10, 6)), dailyBar(day(2026, 10, 7))]
    const points: AuxPoint[] = [
      { date: day(2026, 10, 6), value: -9.25 },
      { date: day(2026, 10, 7), value: 6 },
    ]
    // When: 计算副图序列
    const outputs = auxOutputs(bars, { [AUX_KEY]: points })
    // Then: 首根两根序列都是 undefined（不画），长度仍与 K 线一致
    expect(outputs[0]?.values).toEqual([undefined, -9.25, 6])
    expect(outputs[1]?.values).toEqual([undefined, 45.375, 53])
    expect(outputs[0]?.values).toHaveLength(bars.length)
  })

  it('用户当期没取到主动买盘时，该日及之后的 K 线留空而不是沿用昨日读数', () => {
    // Given: 外部序列只有 10-12 一条（10-13 与 10-20 当日点缺席：live 能力失败 / 漏采 / 上游日期过期）
    const bars = [dailyBar(day(2026, 10, 12)), dailyBar(day(2026, 10, 13)), dailyBar(day(2026, 10, 20))]
    const points: AuxPoint[] = [{ date: day(2026, 10, 12), value: 8.25 }]
    // When: 计算副图序列（这条路径曾把 8.25 前向填充成三天同值）
    const outputs = auxOutputs(bars, { [AUX_KEY]: points })
    // Then: 只有 10-12 那根有值，其余两根 undefined——昨日读数不冒充当日累计
    expect(outputs[0]?.values).toEqual([8.25, undefined, undefined])
    expect(outputs[1]?.values).toEqual([54.125, undefined, undefined])
    expect(outputs[0]?.values).toHaveLength(bars.length)
  })

  it('用户看日 K 时，某交易日的点只落在该交易日的 bar 上', () => {
    // Given: 三个相邻交易日，只有中间 10-13 有净主动买占比
    const bars = [dailyBar(day(2026, 10, 12)), dailyBar(day(2026, 10, 13)), dailyBar(day(2026, 10, 14))]
    const points: AuxPoint[] = [{ date: day(2026, 10, 13), value: 6.73 }]
    // When: 计算副图序列
    const outputs = auxOutputs(bars, { [AUX_KEY]: points })
    // Then: 既不前向铺到 10-14，也不回填到 10-12
    expect(outputs[0]?.values).toEqual([undefined, 6.73, undefined])
    expect(outputs[1]?.values).toEqual([undefined, 53.365, undefined])
  })

  it('用户看周 K 时，区间内无点的周留空而不是复用上一周的值', () => {
    // Given: 两周（10-05~10-09、10-12~10-16），只有前一周区间内 10-07 有一条外部值
    const bars = [spanBar(day(2026, 10, 5), day(2026, 10, 9)), spanBar(day(2026, 10, 12), day(2026, 10, 16))]
    const points: AuxPoint[] = [{ date: day(2026, 10, 7), value: -4.5 }]
    // When: 计算副图序列
    const outputs = auxOutputs(bars, { [AUX_KEY]: points })
    // Then: 前一周取区间内 10-07 的值，后一周区间内无点 → undefined（更早的周有点也不沿用）
    expect(outputs[0]?.values).toEqual([-4.5, undefined])
    expect(outputs[1]?.values).toEqual([47.75, undefined])
  })

  it('用户看周 K 时，区间首末日当天的点也算落在区间内', () => {
    // Given: 一根覆盖 10-05~10-09 的周 K，区间首末日各有一条外部值
    const bars = [spanBar(day(2026, 10, 5), day(2026, 10, 9))]
    const points: AuxPoint[] = [
      { date: day(2026, 10, 5), value: -1.5 },
      { date: day(2026, 10, 9), value: 3.5 },
    ]
    // When: 计算副图序列
    const outputs = auxOutputs(bars, { [AUX_KEY]: points })
    // Then: 首末日都算命中，取区间内最新的 10-09
    expect(outputs[0]?.values).toEqual([3.5])
    expect(outputs[1]?.values).toEqual([51.75])
  })

  it('user 看月 K 时首末日均命中且无数据月份不沿用相邻月份读数', () => {
    // Given 三根完整月 K，十月无点，区间外也有真实日期的读数
    const bars = [
      spanBar(day(2026, 9, 1), day(2026, 9, 30)),
      spanBar(day(2026, 10, 1), day(2026, 10, 31)),
      spanBar(day(2026, 11, 1), day(2026, 11, 30)),
    ]
    const firstDays: AuxPoint[] = [
      { date: day(2026, 9, 1), value: -1 },
      { date: day(2026, 11, 1), value: -2 },
    ]
    const boundaries: AuxPoint[] = [
      { date: day(2026, 8, 31), value: 8 },
      firstDays[0]!,
      { date: day(2026, 9, 30), value: 4 },
      firstDays[1]!,
      { date: day(2026, 11, 30), value: 6 },
      { date: day(2026, 12, 1), value: 9 },
    ]
    // When 分别只有首日点与同时存在末日点时计算预设本体
    const first = auxOutputs(bars, { [AUX_KEY]: firstDays })
    const latest = auxOutputs(bars, { [AUX_KEY]: boundaries })
    // Then 首日包含、末日最新点优先，缺失月及区间外点不被填入
    expect(first[0]?.values).toEqual([-1, undefined, -2])
    expect(first[1]?.values).toEqual([49.5, undefined, 49])
    expect(latest[0]?.values).toEqual([4, undefined, 6])
    expect(latest[1]?.values).toEqual([52, undefined, 53])
  })

  it('用户尚未取到外部数据时，该指标输出空数组而不是零线', () => {
    // Given: 有 K 线但宿主没有注入外部序列（键缺失），以及注入了空序列两种情形
    const bars = [dailyBar(day(2026, 10, 5)), dailyBar(day(2026, 10, 6))]
    // When: 两种情况各算一次
    const missing = auxOutputs(bars, {})
    const empty = auxOutputs(bars, { [AUX_KEY]: [] })
    // Then: 都是空输出（消费方据此隐藏整个副图 pane），绝不降级为 0 值曲线
    expect(missing).toEqual([])
    expect(empty).toEqual([])
  })

  it('用户遇到脏数据（NaN / 无穷）时，该点两条序列都断开', () => {
    // Given: 外部序列里混入 NaN 与 Infinity
    const bars = [dailyBar(day(2026, 10, 5)), dailyBar(day(2026, 10, 6)), dailyBar(day(2026, 10, 7))]
    const points: AuxPoint[] = [
      { date: day(2026, 10, 5), value: Number.NaN },
      { date: day(2026, 10, 6), value: Number.NEGATIVE_INFINITY },
      { date: day(2026, 10, 7), value: 5 },
    ]
    // When: 计算副图序列
    const outputs = auxOutputs(bars, { [AUX_KEY]: points })
    // Then: 非有限值一律落成 undefined（含由净买推导的买占线），有限值保留，长度不变
    expect(outputs[0]?.values).toEqual([undefined, undefined, 5])
    expect(outputs[1]?.values).toEqual([undefined, undefined, 52.5])
    expect(outputs[1]?.values).toHaveLength(bars.length)
    expect((outputs[0]?.values ?? []).some(value => typeof value === 'number' && !Number.isFinite(value))).toBe(false)
  })

  it('用户用未升级的宿主直接调 compute 时，该指标不报错也不画线', () => {
    // Given: 声明了 aux 的 definition 与一段 K 线
    const definition = activeBuyDefinition()
    const bars = [dailyBar(day(2026, 10, 5))]
    // When: 旧宿主走 compute 入口（新宿主只认 computeAux）
    const outputs = definition.compute(bars, {})
    // Then: 空输出，等价于不画任何东西
    expect(outputs).toEqual([])
  })

  it('用户切换市场时，该指标只在 A 股可用', () => {
    // Given: 主动买盘 definition
    const definition = activeBuyDefinition()
    // When: 分别按 A 股 / 港股 / 美股判定可用性
    const cn = isDefinitionAvailableOn(definition, 'cn')
    const hk = isDefinitionAvailableOn(definition, 'hk')
    const us = isDefinitionAvailableOn(definition, 'us')
    // Then: 只有 A 股为真
    expect(cn).toBe(true)
    expect(hk).toBe(false)
    expect(us).toBe(false)
  })
})

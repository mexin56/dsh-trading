/**
 * 港股通持股比例预置指标单测（冻结规格）：元数据（id/title/pane/params/markets/aux）、
 * 无数据返回空输出（空 ≠ 0）、日 K 一字对齐、周 K 取区间最新值、防前视与长度严格性。
 */
import { describe, expect, it } from 'vitest'
import type { AuxPoint, IndicatorDefinition, Kline } from '../src/index.ts'
import { presetDefinitions } from '../src/index.ts'

const DAY = 86_400_000
/** 外部序列键（冻结字面量，与宿主 prefetch 键一致）。 */
const AUX_KEY = 'hk-connect-holding'

function day(year: number, month: number, date: number): number {
  return Date.UTC(year, month - 1, date)
}

function dailyBar(tradingDay: number, offsetMs = 0): Kline {
  const openTime = tradingDay + offsetMs
  return { openTime, closeTime: openTime + DAY - 1, open: 10, high: 11, low: 9, close: 10.5, volume: 100 }
}

function weeklyBar(periodStart: number, days: number): Kline {
  return {
    openTime: periodStart,
    closeTime: periodStart + days * DAY - 1,
    open: 10, high: 11, low: 9, close: 10.5, volume: 500,
  }
}

function hkDefinition(): IndicatorDefinition {
  const definition = presetDefinitions().find(entry => entry.id === 'hk-connect-holding')
  if (definition === undefined) throw new Error('preset hk-connect-holding missing')
  return definition
}

/** 取该 definition 的 aux 输出（无 aux 输出时返回空数组，便于断言「空 ≠ 0」）。 */
function auxOutputs(bars: readonly Kline[], aux: Record<string, readonly AuxPoint[]>) {
  return hkDefinition().computeAux?.(bars, {}, aux) ?? []
}

describe('港股通持股比例预置定义', () => {
  it('用户看指标选择器时，该指标仅港股可用、副图、无参数', () => {
    // Given: 预置定义名册里的港股通持股比例
    const definition = hkDefinition()
    // When: 读取其展示与适用范围元数据
    const { pane, title, params, markets, aux } = definition
    // Then: 冻结规格逐项成立
    expect(definition.id).toBe('hk-connect-holding')
    expect(title).toBe('港股通持股比例')
    expect(pane).toBe('sub')
    expect(params).toEqual([])
    expect(markets).toEqual(['hk'])
    expect(aux).toEqual([AUX_KEY])
  })

  it('用户尚未取到外部数据时，该指标输出空数组而不是零线', () => {
    // Given: 有 K 线但宿主没有注入外部序列（键缺失），以及注入了空序列两种情形
    const bars = [dailyBar(day(2026, 10, 5)), dailyBar(day(2026, 10, 6))]
    // When: 两种情况各算一次
    const missing = auxOutputs(bars, {})
    const empty = auxOutputs(bars, { [AUX_KEY]: [] })
    // Then: 都是空输出（消费方据此隐藏副图），绝不降级为 0 值曲线
    expect(missing).toEqual([])
    expect(empty).toEqual([])
  })

  it('用户看日 K 时，持股比例按其交易日逐根对齐并保留两位小数', () => {
    // Given: 三个交易日的日 K 与逐日外部值
    const bars = [dailyBar(day(2026, 10, 5)), dailyBar(day(2026, 10, 6)), dailyBar(day(2026, 10, 7))]
    const points: AuxPoint[] = [
      { date: day(2026, 10, 5), value: 11.1 },
      { date: day(2026, 10, 6), value: 11.4 },
      { date: day(2026, 10, 7), value: 11.9 },
    ]
    // When: 走 computeAux 入口
    const outputs = auxOutputs(bars, { [AUX_KEY]: points })
    // Then: 单条 line 序列，长度严格等于 K 线数，数值与交易日一一对应
    expect(outputs).toHaveLength(1)
    expect(outputs[0]?.kind).toBe('line')
    expect(outputs[0]?.color).toBe('#7c5cff')
    expect(outputs[0]?.precision).toBe(2)
    expect(outputs[0]?.values).toHaveLength(bars.length)
    expect(outputs[0]?.values).toEqual([11.1, 11.4, 11.9])
  })

  it('用户看周 K 时，每根取该周区间内最新一条持股比例', () => {
    // Given: 两根周 K，第一周内 10-06 与 10-09 各有一条外部值
    const bars = [weeklyBar(day(2026, 10, 5), 7), weeklyBar(day(2026, 10, 12), 7)]
    const points: AuxPoint[] = [
      { date: day(2026, 10, 6), value: 11.1 },
      { date: day(2026, 10, 9), value: 11.7 },
      { date: day(2026, 10, 13), value: 12.3 },
    ]
    // When: 计算副图序列
    const outputs = auxOutputs(bars, { [AUX_KEY]: points })
    // Then: 取区间末已知值 11.7 / 12.3（不是周期起点的 11.1，也不越界取下一周的值）
    expect(outputs[0]?.values).toEqual([11.7, 12.3])
    expect(outputs[0]?.values).toHaveLength(bars.length)
  })

  it('用户看上市初期的 K 线时，首条外部数据之前留空而不是回填', () => {
    // Given: 外部序列从第三个交易日才有（此前该股不在港股通范围）
    const bars = [dailyBar(day(2026, 10, 1)), dailyBar(day(2026, 10, 2)), dailyBar(day(2026, 10, 5))]
    const points: AuxPoint[] = [{ date: day(2026, 10, 5), value: 11.1 }]
    // When: 计算副图序列
    const outputs = auxOutputs(bars, { [AUX_KEY]: points })
    // Then: 前两根 undefined（不画线），长度仍与 K 线一致
    expect(outputs[0]?.values).toEqual([undefined, undefined, 11.1])
    expect(outputs[0]?.values).toHaveLength(bars.length)
  })

  it('用户看开盘时刻带盘中偏移的日 K 时，不误取次日才公布的持股比例', () => {
    // Given: 日 K 的 openTime 带 09:30 偏移（closeTime 因此落在次日 09:29:59）
    const bars = [dailyBar(day(2026, 10, 6), 9.5 * 3600 * 1000)]
    const points: AuxPoint[] = [
      { date: day(2026, 10, 5), value: 11.1 },
      { date: day(2026, 10, 6), value: 11.4 },
      { date: day(2026, 10, 7), value: 11.9 },
    ]
    // When: 计算副图序列
    const outputs = auxOutputs(bars, { [AUX_KEY]: points })
    // Then: 取 10-06 当日的 11.4，绝不吃到 10-07 的未来值
    expect(outputs[0]?.values).toEqual([11.4])
  })

  it('用户遇到脏数据（NaN / 无穷）时，该点断开而不是画出异常值', () => {
    // Given: 外部序列里混入 NaN 与 Infinity
    const bars = [dailyBar(day(2026, 10, 5)), dailyBar(day(2026, 10, 6)), dailyBar(day(2026, 10, 7))]
    const points: AuxPoint[] = [
      { date: day(2026, 10, 5), value: Number.NaN },
      { date: day(2026, 10, 6), value: Number.POSITIVE_INFINITY },
      { date: day(2026, 10, 7), value: 11.9 },
    ]
    // When: 计算副图序列
    const outputs = auxOutputs(bars, { [AUX_KEY]: points })
    // Then: 非有限值按 warm-up 处理为 undefined，有限值保留，长度不变
    expect(outputs[0]?.values).toEqual([undefined, undefined, 11.9])
    expect(outputs[0]?.values).toHaveLength(bars.length)
  })

  it('用户用未升级的宿主直接调 compute 时，该指标不报错也不画线', () => {
    // Given: 声明了 aux 的 definition 与一段 K 线
    const definition = hkDefinition()
    const bars = [dailyBar(day(2026, 10, 5))]
    // When: 旧宿主走 compute 入口（新宿主只认 computeAux）
    const outputs = definition.compute(bars, {})
    // Then: 空输出，等价于不画任何东西
    expect(outputs).toEqual([])
  })
})

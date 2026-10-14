/**
 * 量比分档量能预置指标单测（冻结规格）：契约元数据（副图 / 单参数 / 默认勾选 / 不限
 * 市场与级别 / 五档 themeColor 与五日图例同色）、档位边界（比值 < 1、= 1、= 2、= 3 与
 * 阈值两侧的略大略小）、前值窗口不可用与前值无量（本周期也无量 → 中性灰；本周期有量
 * → 最高档，与五日 five-day-series.ts:220-225 同口径）、柱高 = 本周期成交量、每根柱只落
 * 在一条输出上、五条输出与 K 线严格等长、无 NaN/Infinity、周期参数可调。
 */
import { describe, expect, it } from 'vitest'
import type { IndicatorDefinition, IndicatorOutput, Kline } from '../src/index.ts'
import { isDefinitionAvailableOn, presetDefinitions } from '../src/index.ts'

const DAY = 86_400_000

/** 只带成交量的 K 线（本指标只读 volume）。 */
function bar(volume: number, openTime: number): Kline {
  return { openTime, open: 10, high: 11, low: 9, close: 10.5, volume }
}

/** 按给定成交量构造等间隔的连续周期 K 线。 */
function barsOf(volumes: readonly number[]): Kline[] {
  return volumes.map((volume, index) => bar(volume, index * DAY))
}

function volTierDefinition(): IndicatorDefinition {
  const definition = presetDefinitions().find(entry => entry.id === 'vol-tier')
  if (definition === undefined) throw new Error('preset vol-tier missing')
  return definition
}

function compute(volumes: readonly number[], params: Record<string, number> = { n: 4 }): IndicatorOutput[] {
  return volTierDefinition().compute(barsOf(volumes), params)
}

/** 某下标上「有值」的输出 key：0 条 = 该根不出柱，>1 条 = 一根落进多条（都是违规）。 */
function ownersAt(outputs: readonly IndicatorOutput[], index: number): string[] {
  return outputs.filter(output => output.values[index] !== undefined).map(output => output.key)
}

/** 五条输出里所有出现过的值（含 undefined），用于「无非有限值」的整体断言。 */
function allValues(outputs: readonly IndicatorOutput[]): Array<number | undefined> {
  return outputs.flatMap(output => [...output.values])
}

/** 某档位输出在该下标的柱高。 */
function heightOf(outputs: readonly IndicatorOutput[], tier: string, index: number): number | undefined {
  return outputs.find(output => output.key === tier)?.values[index]
}

describe('量比分档量能预置定义', () => {
  it('用户看指标选择器时，它是默认勾选的副图指标、单参数周期默认 4、不限市场与级别', () => {
    // Given 预置定义名册
    // When 读 vol-tier 的元数据
    const definition = volTierDefinition()
    // Then pane / 参数 schema / 默认勾选逐项冻结
    expect(definition.title).toBe('量比分档量能')
    expect(definition.pane).toBe('sub')
    expect(definition.params).toEqual([{ key: 'n', label: '周期', default: 4, min: 2, max: 250 }])
    expect(definition.defaultActive).toBe(true)
    // Then 不限市场、不限级别（缺席 = 全部适用）、不依赖外部序列
    expect(definition.markets).toBeUndefined()
    expect(definition.defaultApplyScope).toBeUndefined()
    expect(definition.aux).toBeUndefined()
    expect(isDefinitionAvailableOn(definition, 'cn')).toBe(true)
    expect(isDefinitionAvailableOn(definition, 'us')).toBe(true)
    expect(isDefinitionAvailableOn(definition, 'hk')).toBe(true)
    // Then 说明写明口径、阈值区间与「不受涨跌配色影响」
    expect(definition.description).toContain('前 N 个周期成交量均值')
    expect(definition.description).toContain('阈值 1 / 2 / 3')
    expect(definition.description).toContain('不受红涨绿跌配色设置影响')
  })

  it('用户看图例时，五条柱序列按档位排序、各带亮暗双色、亮色与 color 兜底同值', () => {
    // Given 一段有前值的量序列
    const volumes = [10, 10, 10, 10, 10]
    // When 计算输出
    const outputs = compute(volumes)
    // Then 五条 histogram，key 顺序固定
    expect(outputs.map(output => output.key)).toEqual(['无前值', '量比<1', '量比1-2', '量比2-3', '量比≥3'])
    expect(outputs.map(output => output.kind)).toEqual([
      'histogram', 'histogram', 'histogram', 'histogram', 'histogram',
    ])
    expect(outputs.map(output => output.themeColor)).toEqual([
      { light: '#a8adb8', dark: '#6b7280' },
      { light: '#d9a01f', dark: '#e8c552' },
      { light: '#ee7f72', dark: '#f0958b' },
      { light: '#c62828', dark: '#e5484d' },
      { light: '#1c1c1e', dark: '#f2f4f8' },
    ])
    // Then color 兜底 = 同语义亮色（旧消费方读到亮色值，不会无色可用）
    expect(outputs.map(output => output.color)).toEqual(outputs.map(output => output.themeColor?.light))
  })

  it('用户看到量比恰好等于 1 / 2 / 3 的三根时，它们分别落在较高一档', () => {
    // Given 前 4 根量均为 10（前值均值 10），本根量分别取 10 / 20 / 30
    // When 逐根计算量比档位（n = 4：下标 4 的前值 = 前 4 根均值）
    // Then = 1 落「1-2」、= 2 落「2-3」、= 3 落「≥3」（区间语义 1 ≤ 量比 < 2 那套）
    expect(ownersAt(compute([10, 10, 10, 10, 10]), 4)).toEqual(['量比1-2'])
    expect(ownersAt(compute([10, 10, 10, 10, 20]), 4)).toEqual(['量比2-3'])
    expect(ownersAt(compute([10, 10, 10, 10, 30]), 4)).toEqual(['量比≥3'])
  })

  it('用户看到量比在阈值两侧略大略小的几根时，档位按阈值严格切分', () => {
    // Given 前 4 根量均为 10，本根量取 0.9 / 1.99 / 2.99 / 3.1 倍
    // When 逐根计算档位
    // Then 阈值两侧分别落低一档与高一档
    expect(ownersAt(compute([10, 10, 10, 10, 9]), 4)).toEqual(['量比<1'])
    expect(ownersAt(compute([10, 10, 10, 10, 19.9]), 4)).toEqual(['量比1-2'])
    expect(ownersAt(compute([10, 10, 10, 10, 29.9]), 4)).toEqual(['量比2-3'])
    expect(ownersAt(compute([10, 10, 10, 10, 31]), 4)).toEqual(['量比≥3'])
    // Then 本周期无量（量比 0）落「量比<1」档；灰档只留给不可判（无前值 / 前值无量且本周期无量 / 窗口含脏值）
    expect(ownersAt(compute([10, 10, 10, 10, 0]), 4)).toEqual(['量比<1'])
  })

  it('用户看序列开头没有前值的几根时，它们落中性灰档且柱高是各自的成交量', () => {
    // Given 6 根量、n = 4：下标 0..3 还没有完整的前值窗口
    const volumes = [10, 20, 30, 40, 50, 60]
    // When 计算输出
    const outputs = compute(volumes)
    // Then 前 4 根全部落「无前值」灰档，且灰档里挂着它们的成交量柱
    expect([0, 1, 2, 3].map(index => ownersAt(outputs, index))).toEqual([
      ['无前值'], ['无前值'], ['无前值'], ['无前值'],
    ])
    expect([0, 1, 2, 3].map(index => heightOf(outputs, '无前值', index))).toEqual([10, 20, 30, 40])
    // Then 第 5 根（下标 4）已有前值：前 4 根均值 25 → 量比 2 落「2-3」档，不再落灰档
    expect(ownersAt(outputs, 4)).toEqual(['量比2-3'])
    expect(heightOf(outputs, '量比2-3', 4)).toBe(50)
  })

  it('用户遇到前 N 根都无量且本周期也无量的一根时，它落中性灰档', () => {
    // Given 前 4 根量为 0（前值均值 0），本根量也为 0
    const volumes = [0, 0, 0, 0, 0]
    // When 计算输出
    const outputs = compute(volumes)
    // Then 本根落灰档（前值无量、本周期也无量，比值无定义），柱高是 0
    expect(ownersAt(outputs, 4)).toEqual(['无前值'])
    expect(heightOf(outputs, '无前值', 4)).toBe(0)
    // Then 灰档以外四条在本根都留空，且没有任何 NaN/Infinity 值
    expect(outputs.filter(output => output.key !== '无前值').map(output => output.values[4]))
      .toEqual([undefined, undefined, undefined, undefined])
    expect(allValues(outputs).every(value => value === undefined || Number.isFinite(value))).toBe(true)
  })

  it('用户遇到前值全为零但本周期有量的一根时，它落最高档而不是灰档', () => {
    // Given 前 4 根量为 0（前值均值 0），本根量为 100
    const volumes = [0, 0, 0, 0, 100]
    // When 计算输出
    const outputs = compute(volumes)
    // Then 比值发散，本根只落在「量比≥3」这一条序列上（柱高仍是本根成交量）
    // （判定依据：「行情·5日」现行分支 five-day-series.ts:220-225——
    //   前值全零时本周期也为 0 才是 noPrior 中性灰，有量则取 POSITIVE_INFINITY 落最高档）
    expect(ownersAt(outputs, 4)).toEqual(['量比≥3'])
    expect(heightOf(outputs, '量比≥3', 4)).toBe(100)
    expect(outputs.filter(output => output.key !== '量比≥3').map(output => output.values[4]))
      .toEqual([undefined, undefined, undefined, undefined])
    // Then 五条序列里没有任何非有限值交给渲染层（发散的比值只用于定档，不落进 values）
    expect(allValues(outputs).every(value => value === undefined || Number.isFinite(value))).toBe(true)
  })

  it('用户看一段含零量、无前值与四档齐备的量序列时，每根柱只落在一条输出上且等长', () => {
    // Given 12 根量：无前值段 + 前值无量（本周期也无量）+ 四档各若干
    const volumes = [0, 0, 0, 0, 0, 50, 15, 40, 10, 120, 60, 150]
    // When 计算输出
    const outputs = compute(volumes)
    // Then 五条输出与 K 线严格等长
    expect(outputs.map(output => output.values.length)).toEqual([12, 12, 12, 12, 12])
    // Then 每根柱恰好落在一条输出上（不出柱或落多条都算违规）
    expect(volumes.map((_volume, index) => ownersAt(outputs, index).length)).toEqual(new Array(12).fill(1))
    // Then 柱高等于该根成交量（档位只决定颜色，不改柱高）
    expect(volumes.map((_volume, index) => heightOf(outputs, ownersAt(outputs, index)[0] as string, index)))
      .toEqual(volumes)
    // Then 全序列无非有限值
    expect(allValues(outputs).every(value => value === undefined || Number.isFinite(value))).toBe(true)
    // Then 五条序列都被这段序列覆盖（灰档 + 四个量比档各至少一根）
    expect([...new Set(volumes.map((_volume, index) => ownersAt(outputs, index)[0]))].sort())
      .toEqual(['无前值', '量比1-2', '量比2-3', '量比<1', '量比≥3'].sort())
  })

  it('用户遇到脏数据（成交量为 NaN）的一根时，该根不出柱、其后的前值窗口被污染也走灰档', () => {
    // Given 一段正常量序列里混入一根 NaN 成交量
    const volumes = [10, 10, 10, 10, Number.NaN, 10]
    // When 计算输出
    const outputs = compute(volumes)
    // Then 脏数据那根五条都留空（不画），下一根的前值窗口含 NaN → 均值不可判，同样走灰档（不猜档位）
    expect(ownersAt(outputs, 4)).toEqual([])
    expect(ownersAt(outputs, 5)).toEqual(['无前值'])
    expect(heightOf(outputs, '无前值', 5)).toBe(10)
    // Then 全序列没有任何 NaN/Infinity 值交给渲染层
    expect(allValues(outputs).every(value => value === undefined || Number.isFinite(value))).toBe(true)
  })

  it('用户把周期参数改成 2 时，前值窗口与前值起点都跟着变', () => {
    // Given 4 根量 10/10/10/30，n = 2
    const volumes = [10, 10, 10, 30]
    // When 计算输出
    const outputs = compute(volumes, { n: 2 })
    // Then 前 2 根没有前值、下标 2 的前值 = 前 2 根均值 10 → 量比 1 落「1-2」
    expect([0, 1].map(index => ownersAt(outputs, index))).toEqual([['无前值'], ['无前值']])
    expect(ownersAt(outputs, 2)).toEqual(['量比1-2'])
    // Then 下标 3 的前值 = 下标 1..2 均值 10 → 量比 3 落「≥3」
    expect(ownersAt(outputs, 3)).toEqual(['量比≥3'])
    expect(heightOf(outputs, '量比≥3', 3)).toBe(30)
  })

  it('用户看不含成交量的空序列时，五条输出都是空数组而不是补零', () => {
    // Given 没有任何 K 线
    // When 计算输出
    const outputs = compute([])
    // Then 五条都是空数组（空 ≠ 0），且都不含非有限值
    expect(outputs.map(output => output.key)).toEqual(['无前值', '量比<1', '量比1-2', '量比2-3', '量比≥3'])
    expect(outputs.map(output => output.values.length)).toEqual([0, 0, 0, 0, 0])
    expect(allValues(outputs).every(value => value === undefined || Number.isFinite(value))).toBe(true)
  })
})

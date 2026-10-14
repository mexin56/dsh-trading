/**
 * 成交量预置指标单测（冻结规格）：契约元数据（副图 / 无参数 / 默认勾选 / 不限市场与
 * 级别 / 只声明 barAux 不声明 aux）、涨跌色路径（收盘 ≥ 开盘归上涨含等号、柱高 = 成交量、
 * 每根至多一条输出、脏数据不出柱、与 K 线严格等长）、五日档位路径（五条输出 key 与
 * 量比分档量能完全一致且同色、编码 0..4 分档、越界与缺失不画、长度严格对齐、无 NaN）。
 */
import { describe, expect, it } from 'vitest'
import type { AuxBarSeriesMap, IndicatorDefinition, IndicatorOutput, Kline } from '../src/index.ts'
import {
  FIVE_DAY_VOLUME_TIER_AUX_KEY, FIVE_DAY_VOLUME_TIER_CODES, isDefinitionAvailableOn, presetDefinitions,
} from '../src/index.ts'

const DAY = 86_400_000

/** 第 index 根 K 线：方向由 open/close 决定，柱高由 volume 决定。 */
function barOf(open: number, close: number, volume: number, index: number): Kline {
  return {
    openTime: index * DAY,
    open,
    close,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    volume,
  }
}

/** 按 [开盘, 收盘, 成交量] 三元组构造连续 K 线。 */
function barsOf(specs: readonly (readonly [number, number, number])[]): Kline[] {
  return specs.map(([open, close, volume], index) => barOf(open, close, volume, index))
}

function definitionOf(id: string): IndicatorDefinition {
  const definition = presetDefinitions().find(entry => entry.id === id)
  if (definition === undefined) throw new Error(`preset ${id} missing`)
  return definition
}

const vol = (): IndicatorDefinition => definitionOf('vol')

/** 按 definition 的 schema 取默认参数（遍历其它预置时用）。 */
function defaultParams(definition: IndicatorDefinition): Record<string, number> {
  return Object.fromEntries(definition.params.map(param => [param.key, param.default]))
}

const volCompute = (bars: readonly Kline[]): IndicatorOutput[] => vol().compute(bars, {})

/** 逐根档位序列注入（键即冻结字面量，长度按需）。 */
function tiersOf(codes: readonly (number | undefined)[]): AuxBarSeriesMap {
  return { [FIVE_DAY_VOLUME_TIER_AUX_KEY]: codes }
}

const volBarAux = (bars: readonly Kline[], codes: readonly (number | undefined)[]): IndicatorOutput[] =>
  vol().computeBarAux!(bars, {}, tiersOf(codes))

/** 某下标上「有值」的输出 key：0 条 = 该根不出柱，>1 条 = 一根落进多条（都是违规）。 */
function ownersAt(outputs: readonly IndicatorOutput[], index: number): string[] {
  return outputs.filter(output => output.values[index] !== undefined).map(output => output.key)
}

/** 所有输出里出现过的值（含 undefined），用于「无非有限值」的整体断言。 */
function allValues(outputs: readonly IndicatorOutput[]): Array<number | undefined> {
  return outputs.flatMap(output => [...output.values])
}

/** 某个 key 的输出在该下标的柱高。 */
function heightAt(outputs: readonly IndicatorOutput[], key: string, index: number): number | undefined {
  return outputs.find(output => output.key === key)?.values[index]
}

describe('成交量预置定义（vol）', () => {
  it('用户看指标选择器时，它是默认勾选的副图指标、无参数、不限市场与级别', () => {
    // Given 预置定义名册
    // When 读 vol 的元数据
    const definition = vol()
    // Then 身份与面板归属
    expect(definition.id).toBe('vol')
    expect(definition.title).toBe('成交量')
    expect(definition.pane).toBe('sub')
    expect(definition.params).toEqual([])
    // Then 默认勾选（进面板即勾上，取消由客户端负责隐藏整个副图）
    expect(definition.defaultActive).toBe(true)
    // Then 不限市场、不限级别、不声明日频外部序列
    expect(definition.markets).toBeUndefined()
    expect(definition.defaultApplyScope).toBeUndefined()
    expect(definition.aux).toBeUndefined()
    expect(isDefinitionAvailableOn(definition, 'crypto')).toBe(true)
    expect(isDefinitionAvailableOn(definition, 'us')).toBe(true)
    expect(isDefinitionAvailableOn(definition, 'cn')).toBe(true)
    expect(isDefinitionAvailableOn(definition, 'hk')).toBe(true)
    // Then 只声明逐根通道一条键：它缺失时回落 compute，绝不隐藏实例
    expect(definition.barAux).toEqual([FIVE_DAY_VOLUME_TIER_AUX_KEY])
    expect(typeof definition.computeBarAux).toBe('function')
    // Then 说明写明涨跌判据与「不随红涨绿跌设置翻转」
    expect(definition.description).toContain('收盘 ≥ 开盘')
    expect(definition.description).toContain('不随红涨绿跌配色设置翻转')
  })

  it('用户看图例时，两条柱序列按涨跌顺序排列、颜色是红涨绿跌缺省档 0.55 不透明度的语义色', () => {
    // Given 一段有涨有跌的 K 线
    const bars = barsOf([[10, 11, 30], [10, 9, 40]])
    // When 计算输出
    const outputs = volCompute(bars)
    // Then 两条 histogram，key 顺序固定（先涨后跌）
    expect(outputs.map(output => output.key)).toEqual(['上涨量', '下跌量'])
    expect(outputs.map(output => output.kind)).toEqual(['histogram', 'histogram'])
    // Then 颜色写死为 color-mode.ts PALETTES['red-up'] 的 upAlpha(0.55)/downAlpha(0.55)
    expect(outputs.map(output => output.color)).toEqual(['rgba(230, 69, 69, 0.55)', 'rgba(43, 164, 113, 0.55)'])
    // Then 不走主题双色（成交量柱不随红涨绿跌设置翻转）
    expect(outputs.map(output => output.themeColor)).toEqual([undefined, undefined])
  })
})

describe('vol.compute（涨跌色路径）', () => {
  it('用户看阳线（收盘 ≥ 开盘）时，柱落在上涨量且柱高等于该根成交量', () => {
    // Given 一根阳线
    const bars = barsOf([[10, 12, 300]])
    // When 计算
    const outputs = volCompute(bars)
    // Then 上涨量有柱、下跌量留空
    expect(heightAt(outputs, '上涨量', 0)).toBe(300)
    expect(heightAt(outputs, '下跌量', 0)).toBeUndefined()
  })

  it('用户看收盘等于开盘的平盘 K 线时，等号归上涨一档', () => {
    // Given 两根平盘 K 线（open === close）
    const bars = barsOf([[10, 10, 7], [4.5, 4.5, 8]])
    // When 计算
    const outputs = volCompute(bars)
    // Then 两根都落在上涨量而不是下跌量
    expect(ownersAt(outputs, 0)).toEqual(['上涨量'])
    expect(ownersAt(outputs, 1)).toEqual(['上涨量'])
    expect(heightAt(outputs, '上涨量', 1)).toBe(8)
  })

  it('用户看阴线时，柱落在下跌量且柱高等于该根成交量', () => {
    // Given 一根阴线
    const bars = barsOf([[12, 10, 55]])
    // When 计算
    const outputs = volCompute(bars)
    // Then 下跌量有柱、上涨量留空
    expect(heightAt(outputs, '下跌量', 0)).toBe(55)
    expect(heightAt(outputs, '上涨量', 0)).toBeUndefined()
  })

  it('用户看一整段涨跌混排 K 线时，每根至多落在一条输出上、两条序列与 K 线严格等长', () => {
    // Given 涨/平/跌混排的五根 K 线
    const bars = barsOf([[10, 11, 1], [11, 11, 2], [11, 10, 3], [10, 10, 4], [12, 9, 5]])
    // When 计算
    const outputs = volCompute(bars)
    // Then 每条输出长度严格等于 K 线数
    for (const output of outputs) expect(output.values).toHaveLength(bars.length)
    // Then 每根恰好落一条（涨跌二分 + 平盘归涨，覆盖完整）
    expect(bars.map((_bar, index) => ownersAt(outputs, index))).toEqual([
      ['上涨量'], ['上涨量'], ['下跌量'], ['上涨量'], ['下跌量'],
    ])
  })

  it('用户遇到脏成交量（NaN / Infinity）时，该根不出柱且输出里没有任何非有限值', () => {
    // Given 成交量分别为 NaN 与 Infinity 的两根 K 线，中间夹一根正常 K 线
    const bars = barsOf([[10, 11, Number.NaN], [10, 11, 66], [11, 10, Number.POSITIVE_INFINITY]])
    // When 计算
    const outputs = volCompute(bars)
    // Then 脏数据两根不出柱，正常那根照常出柱
    expect(ownersAt(outputs, 0)).toEqual([])
    expect(ownersAt(outputs, 1)).toEqual(['上涨量'])
    expect(ownersAt(outputs, 2)).toEqual([])
    // Then 全部值要么有限、要么 undefined
    expect(allValues(outputs).every(value => value === undefined || Number.isFinite(value))).toBe(true)
  })

  it('用户拿不到任何 K 线时，两条输出仍各返回一条空序列', () => {
    // Given 空 K 线
    // When 计算
    const outputs = volCompute([])
    // Then 两条输出、长度都是 0
    expect(outputs.map(output => output.key)).toEqual(['上涨量', '下跌量'])
    expect(outputs.map(output => output.values)).toEqual([[], []])
  })
})

describe('vol.computeBarAux（五日同分钟档位路径）', () => {
  it('用户看五日档位量能时，五条输出 key 与颜色与量比分档量能完全一致（同一张色表）', () => {
    // Given 一段五日级别 K 线与对应档位编码
    const bars = barsOf([[10, 11, 10], [10, 11, 20], [10, 11, 30], [10, 11, 40], [10, 11, 50]])
    // When 逐根档位路径与量比分档量能各算一次
    const tiered = volBarAux(bars, [0, 1, 2, 3, 4])
    const ratioTier = definitionOf('vol-tier').compute(bars, { n: 4 })
    // Then key / kind / 亮暗双色逐项同源（档位色表只有一份）
    expect(tiered.map(output => output.key)).toEqual(ratioTier.map(output => output.key))
    expect(tiered.map(output => output.kind)).toEqual(ratioTier.map(output => output.kind))
    expect(tiered.map(output => output.themeColor)).toEqual(ratioTier.map(output => output.themeColor))
    expect(tiered.map(output => output.color)).toEqual(ratioTier.map(output => output.color))
    // Then 档位顺序与编码表下标一一对应（下标即编码值）
    expect(tiered.map(output => output.key)).toEqual(['无前值', '量比<1', '量比1-2', '量比2-3', '量比≥3'])
    expect(FIVE_DAY_VOLUME_TIER_CODES).toHaveLength(tiered.length)
  })

  it('用户看编码 0..4 的逐根档位时，每根落在对应档且柱高等于该根成交量', () => {
    // Given 五根 K 线，档位编码依次为 0/1/2/3/4，成交量依次递增
    const bars = barsOf([[10, 11, 10], [10, 11, 20], [10, 11, 30], [10, 11, 40], [10, 11, 50]])
    // When 走逐根档位路径
    const outputs = volBarAux(bars, [0, 1, 2, 3, 4])
    // Then 每根恰好落一条、且落在第 index 档
    expect(bars.map((_bar, index) => ownersAt(outputs, index))).toEqual([
      ['无前值'], ['量比<1'], ['量比1-2'], ['量比2-3'], ['量比≥3'],
    ])
    // Then 柱高 = 本周期成交量（档位只决定颜色）
    expect(outputs.map((output, index) => heightAt(outputs, output.key, index))).toEqual([10, 20, 30, 40, 50])
  })

  it('用户遇到越界编码或该根缺失值时，该根不出柱（越界/undefined 都不落档）', () => {
    // Given 六根 K 线，编码依次为 undefined / -1 / 5 / 1.5 / NaN / 合法 2
    const bars = barsOf([[10, 11, 1], [10, 11, 2], [10, 11, 3], [10, 11, 4], [10, 11, 5], [10, 11, 6]])
    // When 走逐根档位路径
    const outputs = volBarAux(bars, [undefined, -1, 5, 1.5, Number.NaN, 2])
    // Then 前五根都不出柱，只有最后一根落在「量比1-2」档
    expect(bars.map((_bar, index) => ownersAt(outputs, index))).toEqual([[], [], [], [], [], ['量比1-2']])
    expect(heightAt(outputs, '量比1-2', 5)).toBe(6)
  })

  it('用户遇到脏成交量时，该根不出柱且输出里没有任何非有限值', () => {
    // Given 两根成交量非有限的 K 线，档位编码合法
    const bars = barsOf([[10, 11, Number.NaN], [10, 11, Number.POSITIVE_INFINITY], [10, 11, 90]])
    // When 走逐根档位路径
    const outputs = volBarAux(bars, [1, 4, 3])
    // Then 脏数据两根不出柱，正常那根落在「量比2-3」档
    expect(bars.map((_bar, index) => ownersAt(outputs, index))).toEqual([[], [], ['量比2-3']])
    expect(allValues(outputs).every(value => value === undefined || Number.isFinite(value))).toBe(true)
  })

  it('用户拿到的档位序列比 K 线短时，缺口那几根不出柱而不是越界取错值', () => {
    // Given 三根 K 线，档位序列只给了前两根
    const bars = barsOf([[10, 11, 10], [10, 11, 20], [10, 11, 30]])
    // When 走逐根档位路径
    const outputs = volBarAux(bars, [0, 4])
    // Then 三条输出都严格等长，第三根不出柱
    for (const output of outputs) expect(output.values).toHaveLength(bars.length)
    expect(bars.map((_bar, index) => ownersAt(outputs, index))).toEqual([['无前值'], ['量比≥3'], []])
  })

  it('用户当前级别拿不到档位序列时（键缺席），五条输出仍等长且全空', () => {
    // Given 空注入集合（宿主没有该级别的档位数据源）
    const bars = barsOf([[10, 11, 10], [10, 11, 20]])
    // When 走逐根档位路径
    const outputs = vol().computeBarAux!(bars, {}, {})
    // Then 五条输出等长、逐根留空（客户端据此回落 compute 的涨跌色路径）
    expect(outputs.map(output => output.key)).toEqual(['无前值', '量比<1', '量比1-2', '量比2-3', '量比≥3'])
    for (const output of outputs) expect(output.values).toEqual([undefined, undefined])
  })

  it('用户拿不到任何 K 线时，五条输出都返回空序列', () => {
    // Given 空 K 线
    // When 走逐根档位路径
    const outputs = volBarAux([], [])
    // Then 五条输出长度都是 0
    expect(outputs.map(output => output.values)).toEqual([[], [], [], [], []])
  })
})

describe('vol 输出的纵轴格式', () => {
  it('用户看成交量副图的纵轴时，涨跌色两条与档位色五条输出都声明成交量紧凑格式', () => {
    // Given 一段五日级别 K 线（两条路径都算得出来）
    const bars = barsOf([[10, 11, 10], [10, 9, 20]])
    // When 涨跌色路径与逐根档位路径各算一次
    const fallback = volCompute(bars)
    const tiered = volBarAux(bars, [0, 4])
    // Then 两条输出、五条输出逐条都带 priceFormat: 'volume'
    expect(fallback.map(output => output.priceFormat)).toEqual(['volume', 'volume'])
    expect(tiered.map(output => output.priceFormat)).toEqual(['volume', 'volume', 'volume', 'volume', 'volume'])
  })

  it('用户看其它预置指标的纵轴时，它们都不被误加成交量紧凑格式', () => {
    // Given 除 vol 外的全部预置定义（含 vol-tier）
    const others = presetDefinitions().filter(definition => definition.id !== 'vol')
    expect(others.map(definition => definition.id)).toContain('vol-tier')
    // When 逐个用 schema 默认参数算一遍
    const bars = barsOf([[10, 11, 10], [10, 9, 20]])
    const outputs = others.flatMap(definition => definition.compute(bars, defaultParams(definition)))
    // Then 没有一条输出声明 priceFormat（缺省 'price' 由消费方兜底）
    expect(outputs.length).toBeGreaterThan(0)
    expect(outputs.map(output => output.priceFormat)).toEqual(outputs.map(() => undefined))
  })
})

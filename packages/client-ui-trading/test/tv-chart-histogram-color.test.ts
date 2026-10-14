/**
 * 图表侧柱状序列着色直测（TvChart.toHistogramData）：证明副图柱状指标的主色确实
 * 走主题解析（themeColor 存在时按主题取色），且 histogramBySign 的符号柱色优先级
 * 不被改变；暖机/缺值根不产出。
 *
 * 只调用纯数据映射函数，不挂载图表（jsdom 无 canvas，createChart 不可用）。
 */
import { describe, expect, it } from 'vitest'
import type { UTCTimestamp } from 'lightweight-charts'
import { toHistogramData } from '../src/client/TvChart.tsx'
import type { IndicatorOutput } from '@dshtrading/indicators'

/** 主题双色柱状输出（与 packages/indicators 的 IndicatorOutput 结构一致）。 */
function themedHistogram(themeColor?: { light: string; dark: string }): IndicatorOutput {
  return {
    key: 'VOL_TIER',
    kind: 'histogram',
    color: '#8a8f99',
    themeColor,
    values: [1, 2, 3],
  }
}

const AXIS = [1 as UTCTimestamp, 2 as UTCTimestamp, 3 as UTCTimestamp]

describe('toHistogramData 主题取色', () => {
  it('用户在亮色主题下看到逐根柱都取 themeColor.light', () => {
    // Given 一条带主题双色的副图柱状输出与三根对齐的柱
    const output = themedHistogram({ light: '#dbeafe', dark: '#1e3a8a' })
    // When 按亮色主题生成柱数据
    const data = toHistogramData(output, AXIS, false)
    // Then 三根柱全部取 light，且时间轴与值逐根对齐
    expect(data).toEqual([
      { time: 1, value: 1, color: '#dbeafe' },
      { time: 2, value: 2, color: '#dbeafe' },
      { time: 3, value: 3, color: '#dbeafe' },
    ])
  })

  it('用户切换到暗色主题后同一输出逐根柱改为取 themeColor.dark', () => {
    // Given 同一条主题双色输出
    const output = themedHistogram({ light: '#dbeafe', dark: '#1e3a8a' })
    // When 按暗色主题生成柱数据
    const data = toHistogramData(output, AXIS, true)
    // Then 柱色切换为 dark（与亮色结果无一相同）
    expect(data.map(bar => bar.color)).toEqual(['#1e3a8a', '#1e3a8a', '#1e3a8a'])
  })

  it('用户面对无 themeColor 的存量柱状指标时两个主题下柱色都为 output.color', () => {
    // Given 只有单色的存量柱状输出
    const output = themedHistogram()
    // When 分别按亮色与暗色主题生成柱数据
    const light = toHistogramData(output, AXIS, false)
    const dark = toHistogramData(output, AXIS, true)
    // Then 两边的柱色都等于 color，逐根一致
    expect(light.map(bar => bar.color)).toEqual(['#8a8f99', '#8a8f99', '#8a8f99'])
    expect(dark).toEqual(light)
  })

  it('用户启用 histogramBySign 的柱状输出仍按符号着色且主题色不参与', () => {
    // Given 同时带 themeColor 与 histogramBySign 的输出，含正负值与暖机缺值
    const output: IndicatorOutput = {
      key: 'MACD',
      kind: 'histogram',
      color: '#8a8f99',
      themeColor: { light: '#dbeafe', dark: '#1e3a8a' },
      histogramBySign: true,
      values: [1.5, -1.5, undefined],
    }
    // When 暗色主题下生成柱数据
    const data = toHistogramData(output, AXIS, true)
    // Then 正柱红、负柱绿，暖机缺值根不产出
    expect(data).toEqual([
      { time: 1, value: 1.5, color: 'rgba(230, 69, 69, 0.75)' },
      { time: 2, value: -1.5, color: 'rgba(43, 164, 113, 0.75)' },
    ])
  })
})

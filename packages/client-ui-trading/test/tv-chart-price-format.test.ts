/**
 * 序列 priceFormat 直测（TvChart.outputPriceFormat）：成交量搬进指标系统后由
 * `vol` 指标经 createSeries 建序列，`priceFormat: 'volume'` 的输出必须拿到库的
 * 紧凑量格式（亿/万、K/M/B），否则成交量 pane 纵轴会显示成 12000000.00；不带该
 * 字段（或显式 'price'）的输出维持既有 `{type:'price', precision, minMove}`。
 *
 * 只调用纯映射函数，不挂载图表（jsdom 无 canvas，createChart 不可用）。
 */
import { describe, expect, it } from 'vitest'
import { outputPriceFormat } from '../src/client/TvChart.tsx'
import type { IndicatorOutput } from '@dshtrading/indicators'

function histogramOutput(extra: { priceFormat?: 'price' | 'volume'; precision?: number } = {}): IndicatorOutput {
  return { key: 'VOL', kind: 'histogram', color: '#8a8f99', values: [1, 2, 3], ...extra }
}

describe('outputPriceFormat', () => {
  it('用户看到的成交量指标纵轴用紧凑量格式（亿/万、K/M/B），不是原始数字', () => {
    // Given 成交量类指标声明 priceFormat: 'volume'
    const output = histogramOutput({ priceFormat: 'volume' })
    // When 取该输出交给 lightweight-charts 的 priceFormat
    const format = outputPriceFormat(output)
    // Then 取库的 volume 紧凑格式，不带价格精度字段
    expect(format).toEqual({ type: 'volume' })
  })

  it('用户看到的不带 priceFormat 的指标保持价格格式，精度取自输出的 precision', () => {
    // Given 两条未声明 priceFormat 的输出（缺省 precision 与显式 precision）
    const defaulted = histogramOutput()
    const threeDigits = histogramOutput({ precision: 3 })
    // When 分别取它们的 priceFormat
    const formatDefaulted = outputPriceFormat(defaulted)
    const formatThreeDigits = outputPriceFormat(threeDigits)
    // Then 都用价格格式，precision/minMove 分别落到 2/0.01 与 3/0.001
    expect(formatDefaulted).toEqual({ type: 'price', precision: 2, minMove: 0.01 })
    expect(formatThreeDigits).toEqual({ type: 'price', precision: 3, minMove: 0.001 })
  })

  it('用户看到的显式 price 输出与缺省输出逐字同格式（存量输出不变）', () => {
    // Given 同一 precision 下一份显式 'price' 与一份缺省输出
    const explicit = histogramOutput({ priceFormat: 'price', precision: 3 })
    const implicit = histogramOutput({ precision: 3 })
    // When 分别取 priceFormat
    const explicitFormat = outputPriceFormat(explicit)
    const implicitFormat = outputPriceFormat(implicit)
    // Then 两者完全一致，且 precision 越界时同样收敛到 outputDigits 口径（9 → 8）
    expect(explicitFormat).toEqual(implicitFormat)
    expect(outputPriceFormat(histogramOutput({ precision: 9 }))).toEqual({ type: 'price', precision: 8, minMove: 1e-8 })
  })
})

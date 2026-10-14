/**
 * 指标输出主题双色解析单测（indicator-color.ts）：亮色取 light、暗色取 dark、
 * 无 themeColor 回落 color（存量指标零迁移），以及 histogramBySign 符号柱色的
 * 最高优先级（主题色不参与）。
 */
import { describe, expect, it } from 'vitest'
import { resolveHistogramBarColor, resolveOutputColor } from '../src/client/indicator-color.ts'

describe('resolveOutputColor', () => {
  it('管理员在亮色主题下取 themeColor.light', () => {
    // Given 一条同时给出单色与主题双色的输出
    const output = { color: '#8a8f99', themeColor: { light: '#2f6fd0', dark: '#7aa2f7' } }
    // When 按亮色主题解析
    const color = resolveOutputColor(output, false)
    // Then 取 light，而不是 color 或 dark
    expect(color).toBe('#2f6fd0')
  })

  it('管理员在暗色主题下取 themeColor.dark', () => {
    // Given 同一条主题双色输出
    const output = { color: '#8a8f99', themeColor: { light: '#2f6fd0', dark: '#7aa2f7' } }
    // When 按暗色主题解析
    const color = resolveOutputColor(output, true)
    // Then 取 dark
    expect(color).toBe('#7aa2f7')
  })

  it('用户面对无 themeColor 的存量指标时回落 color', () => {
    // Given 只有单色的存量输出（自定义指标同样如此）
    const output = { color: '#e64545' }
    // When 亮色与暗色主题各自解析
    const light = resolveOutputColor(output, false)
    const dark = resolveOutputColor(output, true)
    // Then 两个主题都返回 color，逐字不变
    expect(light).toBe('#e64545')
    expect(dark).toBe('#e64545')
  })

  it('用户拿到的是所选主题的原始色串而非混合或透明化结果', () => {
    // Given 主题双色的浅深两值刻意不同
    const output = { color: 'transparent', themeColor: { light: 'rgba(230, 69, 69, 0.75)', dark: 'rgba(43, 164, 113, 0.75)' } }
    // When 分别解析两个主题
    const light = resolveOutputColor(output, false)
    const dark = resolveOutputColor(output, true)
    // Then 完整返回各自的原始色串（不做混合/透明处理）
    expect(light).toBe('rgba(230, 69, 69, 0.75)')
    expect(dark).toBe('rgba(43, 164, 113, 0.75)')
  })
})

describe('resolveHistogramBarColor', () => {
  it('用户启用 histogramBySign 时柱色按符号红涨绿跌且不随主题变化', () => {
    // Given 一条既有 themeColor 又启用 histogramBySign 的柱状输出
    const output = { color: '#8a8f99', themeColor: { light: '#2f6fd0', dark: '#7aa2f7' }, histogramBySign: true }
    // When 亮色/暗色主题下分别解析正负两根柱
    const lightUp = resolveHistogramBarColor(output, 1.5, false)
    const lightDown = resolveHistogramBarColor(output, -1.5, false)
    const darkUp = resolveHistogramBarColor(output, 1.5, true)
    const darkDown = resolveHistogramBarColor(output, -1.5, true)
    // Then 柱色恒为符号色，themeColor 与 color 都不参与
    expect(lightUp).toBe('rgba(230, 69, 69, 0.75)')
    expect(lightDown).toBe('rgba(43, 164, 113, 0.75)')
    expect(darkUp).toBe(lightUp)
    expect(darkDown).toBe(lightDown)
  })

  it('用户未启用 histogramBySign 时柱色回落主题解析色', () => {
    // Given 一条带 themeColor 但未启用 histogramBySign 的柱状输出
    const output = { color: '#8a8f99', themeColor: { light: '#2f6fd0', dark: '#7aa2f7' } }
    // When 明暗两个主题下各解析一根正值柱
    const light = resolveHistogramBarColor(output, 1.5, false)
    const dark = resolveHistogramBarColor(output, 1.5, true)
    // Then 走 themeColor 取色，而非符号色或单色
    expect(light).toBe('#2f6fd0')
    expect(dark).toBe('#7aa2f7')
  })

  it('用户面对 histogramBySign 显式为 false 的存量柱状指标时仍回落 color', () => {
    // Given histogramBySign 显式为 false 且无 themeColor 的存量输出
    const output = { color: '#e64545', histogramBySign: false }
    // When 暗色主题下解析正负两根柱
    const up = resolveHistogramBarColor(output, 2, true)
    const down = resolveHistogramBarColor(output, -2, true)
    // Then 两根柱都是 output.color，不落到符号色
    expect(up).toBe('#e64545')
    expect(down).toBe('#e64545')
  })
})

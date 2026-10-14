/**
 * 主题热切换只改视觉、不动时轴视窗（TvChart 的 dark 变更 effect 该重放哪一份选项）。
 *
 * 事故背景（2026-10-14 五日级别实测）：热切换重放整套 getChartThemeOptions 时，与主题
 * 无关的 timeScale 几何（barSpacing=9 / minBarSpacing=0.5 / fixLeftEdge / …）被一并下发，
 * 轻量图表据此重排可见范围——fit 铺满 5 个交易日（4 条日界）的视窗塌回约一小时。
 *
 * 只调用纯选项构造函数，不挂载图表（jsdom 无 canvas，createChart 不可用）。
 */
import { describe, expect, it } from 'vitest'
import { TIME_SCALE_GEOMETRY, getChartThemeOptions, getChartThemeVisualOptions } from '../src/client/TvChart.tsx'
import { AXIS_FONT_FAMILY, AXIS_FONT_SIZE } from '../src/client/axis-width.ts'

const GEOMETRY_KEYS = Object.keys(TIME_SCALE_GEOMETRY)
const THEMES = [false, true] as const
const at = (options: object, key: string): unknown => (options as Record<string, unknown>)[key]

describe('TvChart 主题热切换选项', () => {
  it('用户在任一主题下切主题时下发的选项都不含时轴几何，手上的缩放/平移不会被重排', () => {
    // Given 与主题无关的时轴几何（barSpacing / minBarSpacing / fixLeftEdge / …）
    expect(GEOMETRY_KEYS.length).toBeGreaterThan(0)
    for (const dark of THEMES) {
      // When 取主题热切换要重放的那一份选项
      const hotTimeScale = getChartThemeVisualOptions(dark).timeScale as Record<string, unknown>
      // Then 几何键一个都不在里面，只留下随主题变化的时轴边框色
      for (const key of GEOMETRY_KEYS) expect(hotTimeScale, `${key} 不应出现在热切换选项中`).not.toHaveProperty(key)
      expect(hotTimeScale).toHaveProperty('borderColor')
    }
  })

  it('用户在任一主题下切主题时下发的选项都不含创建期结构键 autoSize，容器不会被重新量测', () => {
    // Given 创建期结构选项 autoSize（只在 createChart 给一次）
    for (const dark of THEMES) {
      // When 取主题热切换要重放的那一份选项
      const hot = getChartThemeVisualOptions(dark)
      // Then 热切换选项里没有 autoSize，而 createChart 的完整选项里有
      expect(at(hot, 'autoSize')).toBeUndefined()
      expect(getChartThemeOptions(dark).autoSize).toBe(true)
    }
  })

  it('用户在亮色与暗色间切换时看到的颜色逐项翻转，字体与坐标轴结构保持不变', () => {
    // Given 同一份主题视觉选项的两种主题
    const light = getChartThemeVisualOptions(false)
    const dark = getChartThemeVisualOptions(true)
    // When 对比两套选项的键与值
    // Then 键集合相同：切主题不漏项、不引入新结构
    expect(Object.keys(dark)).toEqual(Object.keys(light))
    // Then 承载主题语义的颜色全部不同（背景、网格、双轴边框、十字线、时轴边框）
    const flipped: Array<[string, unknown, unknown]> = [
      ['layout.background.color', at(light.layout, 'background'), at(dark.layout, 'background')],
      ['layout.textColor', light.layout.textColor, dark.layout.textColor],
      ['layout.panes.separatorColor', at(at(light.layout, 'panes') as object, 'separatorColor'), at(at(dark.layout, 'panes') as object, 'separatorColor')],
      ['grid.vertLines.color', at(light.grid.vertLines, 'color'), at(dark.grid.vertLines, 'color')],
      ['grid.horzLines.color', at(light.grid.horzLines, 'color'), at(dark.grid.horzLines, 'color')],
      ['leftPriceScale.borderColor', light.leftPriceScale.borderColor, dark.leftPriceScale.borderColor],
      ['rightPriceScale.borderColor', light.rightPriceScale.borderColor, dark.rightPriceScale.borderColor],
      ['timeScale.borderColor', light.timeScale.borderColor, dark.timeScale.borderColor],
      ['crosshair.vertLine.color', light.crosshair.vertLine.color, dark.crosshair.vertLine.color],
      ['crosshair.horzLine.labelBackgroundColor', light.crosshair.horzLine.labelBackgroundColor, dark.crosshair.horzLine.labelBackgroundColor],
    ]
    for (const [path, lightValue, darkValue] of flipped) expect(darkValue, path).not.toEqual(lightValue)
    // Then 与主题无关的键保持同值（字号、字体、轴边距、自动尺寸）
    expect(dark.layout.fontSize).toEqual(light.layout.fontSize)
    expect(dark.layout.fontFamily).toEqual(light.layout.fontFamily)
    expect(dark.layout.fontSize).toEqual(AXIS_FONT_SIZE)
    expect(dark.layout.fontFamily).toEqual(AXIS_FONT_FAMILY)
    expect(dark.leftPriceScale.scaleMargins).toEqual(light.leftPriceScale.scaleMargins)
    expect(dark.rightPriceScale.scaleMargins).toEqual(light.rightPriceScale.scaleMargins)
  })

  it('用户开图时下发的完整选项 = 创建期结构键（autoSize + 时轴几何）+ 切主题时重放的视觉选项', () => {
    // Given createChart 与主题热切换各用一份构造函数
    for (const dark of THEMES) {
      // When 分别取完整选项与热切换选项
      const full = getChartThemeOptions(dark)
      const hot = getChartThemeVisualOptions(dark)
      // Then 完整选项 = autoSize + 热切换的全部键；差异只在 timeScale（完整选项带满几何，热切换只带边框色）
      expect(Object.keys(full).sort()).toEqual(['autoSize', ...Object.keys(hot)].sort())
      for (const [key, value] of Object.entries(full)) {
        if (key === 'timeScale' || key === 'autoSize') continue
        expect(at(hot, key)).toEqual(value)
      }
      expect(full.timeScale).toEqual({ ...TIME_SCALE_GEOMETRY, borderColor: hot.timeScale.borderColor })
    }
    // Then 时轴几何两套主题逐键相同（唯一随主题变的仍是边框色）
    const fullLight = getChartThemeOptions(false)
    const fullDark = getChartThemeOptions(true)
    for (const key of GEOMETRY_KEYS) expect(at(fullDark.timeScale as object, key), key).toEqual(at(fullLight.timeScale as object, key))
    expect(fullDark.timeScale.borderColor).not.toEqual(fullLight.timeScale.borderColor)
  })
})

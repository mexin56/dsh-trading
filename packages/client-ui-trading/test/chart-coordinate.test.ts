/**
 * 图表坐标 ↔ 容器坐标换算的单测：锁定「加/减左价格轴宽」的方向，以及
 * 视窗外（v5 返回 null）时不产出 overlay 标记。
 *
 * 背景：lightweight-charts 的坐标 API 以绘图区左缘为原点，而 overlay 挂在容器上；
 * 漏加一个轴宽会让日界竖线/选区整体平移（不报错、肉眼在不含轴宽的场景下也未必发现）。
 */
import { describe, expect, it } from 'vitest'
import { chartXToContainerX, containerXToChartX } from '../src/client/chart-coordinate.ts'

describe('图表坐标与容器坐标的换算', () => {
  it('用户看到的日界竖线落在交易日首根K线上：图表坐标加左轴宽度得到容器x', () => {
    // Given 一根日界在绘图区内的坐标 120 与左价格轴宽 48
    // When 换算为容器坐标
    const containerX = chartXToContainerX(120, 48)

    // Then 加轴宽（不是减），且可空签名只对 null 短路
    expect(containerX).toBe(168)
    expect(chartXToContainerX(0, 48)).toBe(48)
    expect(chartXToContainerX(-10, 48)).toBe(38)
  })

  it('用户把视窗拖到看不到某日界时该日界不产出标记：null 原样返回', () => {
    // Given 该日界在视窗外（v5 的 timeToCoordinate 返回 null）
    // When 换算
    const containerX = chartXToContainerX(null, 48)

    // Then 仍是 null（调用方据此跳过，不得当成 0 画到左缘）
    expect(containerX).toBeNull()
    expect(containerX).not.toBe(48)
  })

  it('用户框选与点右键时报出的下标不因轴宽偏移：指针坐标减轴宽与加法互逆', () => {
    // Given 容器坐标 200 与左轴宽 48
    const chartX = containerXToChartX(200, 48)

    // Then 减轴宽得到绘图区坐标，且与 chartXToContainerX 往返一致
    expect(chartX).toBe(152)
    expect(chartXToContainerX(chartX, 48)).toBe(200)
    expect(containerXToChartX(0, 48)).toBe(-48)
  })
})

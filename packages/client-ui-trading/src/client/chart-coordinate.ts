/**
 * 图表坐标 ↔ 容器坐标的唯一换算（2026-10-14）。
 *
 * lightweight-charts 的坐标 API（`timeToCoordinate` / `logicalToCoordinate`）返回的是
 * **绘图区（pane）内坐标**，pane 左边还有一条左价格轴；而宿主的 overlay（选区高亮带、
 * 十字线标记、五日级别日界竖线）挂在容器上，因此：
 * - 图表坐标 → 容器坐标 = 加左轴宽度；
 * - 容器坐标（指针）→ 图表坐标 = 减同一宽度。
 *
 * 轴宽是动态的（由 axis-width.ts 的 axisMinimumWidth 决定，随价位小数位与百分比
 * 徽标宽度变化），所以这个加减只能有一份实现——第二份会漏加或漏减，且现象是「竖线/
 * 选区整体平移一个轴宽」，不报错、测试也未必发现。
 */
import type { Coordinate } from 'lightweight-charts'

/**
 * 图表坐标 → 容器坐标。传入 null（该点在视窗外，v5 的返回值）时原样返回 null，
 * 调用方据此不产出 overlay 标记，而不是把 null 当 0 画到左缘。
 */
export function chartXToContainerX(chartX: Coordinate | null, paneOffset: number): number | null {
  return chartX === null ? null : Number(chartX) + paneOffset
}

/** 容器坐标（指针位置）→ 图表坐标；与 chartXToContainerX 互逆。 */
export function containerXToChartX(containerX: number, paneOffset: number): number {
  return containerX - paneOffset
}

/**
 * 日界竖线的容器 x 集合：只保留落在可视宽度内的坐标，四舍五入避免亚像素抖动。
 * 视窗外（v5 返回 null）与容器外（坐标存在但已滚出可视区）都不产出标记——
 * 挂着只是被裁掉的隐形 DOM 节点（五日级别缩放/平移后最容易出现）。
 */
export function visibleDayMarkXs(chartXs: readonly (Coordinate | null)[], paneOffset: number, containerWidth: number): number[] {
  const xs: number[] = []
  for (const chartX of chartXs) {
    const x = chartXToContainerX(chartX, paneOffset)
    if (x === null || !Number.isFinite(x) || x < 0 || x > containerWidth) continue
    xs.push(Math.round(x))
  }
  return xs
}

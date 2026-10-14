/**
 * 指标输出着色的单一实现（2026-10-14 提取自 TvChart）：输出的可选「主题双色」
 * themeColor 是 packages/indicators 侧扩展的字段，这里以本地结构类型承载入参——
 * 本包 typecheck 与对方的落地时序解耦，且存量输出（只有 color）行为逐字不变。
 *
 * 取色语义：themeColor 存在时按当前宿主主题取 light/dark，否则回落 color。
 * 例外：histogramBySign 的逐根柱色是符号色（红涨绿跌），与主题无关，优先级最高。
 */

/** 消费侧的结构化着色入参（IndicatorOutput 的着色子集）。 */
export type ThemedOutputColor = {
  /** 单色回退值（存量指标与自定义指标只有它）。 */
  color: string
  /** 主题双色；缺省 = 不随主题变化。 */
  themeColor?: { light: string; dark: string }
}

/** 符号柱色（与红涨绿跌口径同源，非主题色）。 */
const SIGN_UP_COLOR = 'rgba(230, 69, 69, 0.75)'
const SIGN_DOWN_COLOR = 'rgba(43, 164, 113, 0.75)'

/** 按当前是否深色主题解析输出色：有 themeColor 取对应主题色，否则回落 color。 */
export function resolveOutputColor(output: ThemedOutputColor, dark: boolean): string {
  if (output.themeColor === undefined) return output.color
  return dark ? output.themeColor.dark : output.themeColor.light
}

/**
 * 单根柱色：histogramBySign === true 时按符号着色（themeColor 不参与），
 * 否则按主题解析输出色。
 */
export function resolveHistogramBarColor(
  output: ThemedOutputColor & { histogramBySign?: boolean },
  value: number,
  dark: boolean,
): string {
  if (output.histogramBySign === true) return value >= 0 ? SIGN_UP_COLOR : SIGN_DOWN_COLOR
  return resolveOutputColor(output, dark)
}

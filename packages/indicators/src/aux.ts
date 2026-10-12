/**
 * 指标外部序列注入缝（纯数据 + 纯函数，零 Node 依赖，浏览器安全）。
 *
 * 为什么需要：definition.compute 是纯同步函数（只吃 bars + params），没有取数
 * 能力；而港股通持股比例这类指标的数据来自宿主预取的**日频外部序列**（按交易日
 * 公布，与 K 线周期不对应）。本模块定义该注入缝的类型与对齐纯函数：指标用
 * definition.aux 声明需要的序列键，宿主按需 prefetch 后以同名键注入
 * definition.computeAux 的第三参。
 */
import type { Kline } from './types.ts'

/** 指标可声明消费的外部日频序列数据点（按交易日升序、已去重）。 */
export interface AuxPoint {
  /** 交易日（UTC 当日 00:00 的 epoch ms）。 */
  readonly date: number
  readonly value: number
}

/**
 * 指标外部序列来源键（开放词汇；当前仅 'hk-connect-holding'）。
 * 消费方（宿主）据此 prefetch，并把结果按同名键注入 compute 第三参。
 */
export type AuxSeriesKey = string

/** 注入进 compute 的外部序列集合：键 = 指标 definition.aux 声明的键。 */
export type AuxSeriesMap = Readonly<Record<string, readonly AuxPoint[]>>

/**
 * 把日频外部序列对齐到 K 线序列：对每根 K 线取「date ≤ 该 K 线所属交易日」的
 * 最新一条外部值（前向填充，反映「该交易日收盘时已知的最新持股比例」）。
 * 早于首条外部数据的 K 线填 undefined。返回数组长度严格等于 bars.length。
 * dayOfKline: 由宿主传入的「K 线 → 交易日(UTC 00:00)」取值函数，避免本纯库
 * 依赖行情周期词汇。
 *
 * 前向填充的理由：港股通持股日频公布，K 线级别 ≥ 1d 时一个交易日一个点；但周 K/
 * 月 K 上一个 bar 覆盖多日，必须取区间内最新已知值，否则会用到未来数据。
 *
 * 每根 K 线独立二分取值：只依赖 points 升序（契约要求），不假设 bars 升序——
 * 宿主倒序传入或周期混排时每根 K 线拿到的仍是同一条值。
 */
export function alignAuxToBars(
  bars: readonly Kline[],
  points: readonly AuxPoint[],
  dayOfKline: (bar: Kline) => number,
): Array<number | undefined> {
  const aligned = new Array<number | undefined>(bars.length)
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]
    aligned[index] = bar === undefined ? undefined : valueAtOrBefore(points, dayOfKline(bar))
  }
  return aligned
}

/** 升序序列里 date ≤ day 的最后一条值；无命中（早于首条数据 / 空序列）返回 undefined。 */
function valueAtOrBefore(points: readonly AuxPoint[], day: number): number | undefined {
  let low = 0
  let high = points.length - 1
  let hit = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    const point = points[mid]
    if (point === undefined) break
    if (point.date <= day) {
      hit = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return hit < 0 ? undefined : points[hit]?.value
}

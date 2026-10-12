/**
 * 指标外部序列的客户端接线（契约 §5）：宿主按 definition.aux 声明的键预取日频
 * 序列，取不到（undefined / 空序列）即隐藏该副图 pane——「空 ≠ 0」，不画零线。
 *
 * 为什么单独成模块：QuoteStage 的取数与调度要留下三条可回归的纯逻辑点——
 * 「取 holdRatio 口径」「无数据则整体隐藏」「换标的丢弃在途应答」；渲染层在 jsdom
 * 里挂不起图表（lightweight-charts 需 canvas），纯函数是唯一能钉住行为的落点。
 */
import type { AuxPoint, AuxSeriesKey, AuxSeriesMap, IndicatorDefinition, IndicatorInstance } from '@dshtrading/indicators'
import { isDefinitionAvailableOn } from '@dshtrading/indicators'
import type { SouthboundHoldingHistory } from '@dshtrading/api'
import type { MarketId } from './types.ts'

/** 港股通持股比例的外部序列键（冻结字面量，与预置 definition.aux 同名）。 */
export const HK_CONNECT_HOLDING_KEY: AuxSeriesKey = 'hk-connect-holding'

/**
 * 外部序列取数缝：键之外的取数实现由调用方注入（生产传 api.ts 的
 * fetchSouthboundHoldings）。失败以 undefined 表示，不抛——单个序列取不到只影响
 * 依赖它的指标，不牵连主图与其它副图。
 */
export type HoldingsFetcher = (market: MarketId, symbol: string) => Promise<SouthboundHoldingHistory | undefined>

/**
 * 港股通持股历史 → 外部序列。口径冻结为 holdRatio（持股比例，百分比数值）；
 * 取数失败或空 points 一律 undefined（标的不在港股通范围时上游返回空序列，
 * 语义与失败同为「没有可画的数据」）。
 */
export function southboundHoldingsToAuxPoints(history: SouthboundHoldingHistory | undefined): readonly AuxPoint[] | undefined {
  if (history === undefined) return undefined
  const points = history.points.map(point => ({ date: point.date, value: point.holdRatio }))
  return points.length === 0 ? undefined : points
}

/**
 * 按键取一条外部序列。未登记的键返回 undefined（后续新增 aux 键时宿主只需在此
 * 补一条分支，未接线即「没有数据」，不会静默画错线）。
 */
export async function loadAuxSeries(
  key: AuxSeriesKey,
  market: MarketId,
  symbol: string,
  fetchHoldings: HoldingsFetcher,
): Promise<readonly AuxPoint[] | undefined> {
  if (key !== HK_CONNECT_HOLDING_KEY) return undefined
  // 取数缝理论上不抛（api 层已吞错），再兜一层：一个序列异常不得让 Promise.all 整体失败。
  const history = await fetchHoldings(market, symbol).catch(() => undefined)
  return southboundHoldingsToAuxPoints(history)
}

/**
 * 当前需要预取的外部序列键（去重、保持首现序）：只统计在当前市场可用的
 * definition（决策 5 白名单）所声明的键。无声明 = 无需取数。
 */
export function requiredAuxKeys(
  instances: readonly IndicatorInstance[],
  market: MarketId | undefined,
  getDefinition: (id: string) => IndicatorDefinition | undefined,
): AuxSeriesKey[] {
  const keys: AuxSeriesKey[] = []
  for (const instance of instances) {
    const definition = getDefinition(instance.id)
    if (definition === undefined || !isDefinitionAvailableOn(definition, market)) continue
    for (const key of definition.aux ?? []) {
      if (!keys.includes(key)) keys.push(key)
    }
  }
  return keys
}

/**
 * 该 definition 的外部序列是否已就绪：未声明 aux → 恒真（走 compute）；声明了 →
 * 每个键都要有**非空**序列。空数组按未取到处理（决策 3：整体隐藏副图，不是画空线）。
 */
export function auxSeriesReady(definition: Pick<IndicatorDefinition, 'aux'>, series: AuxSeriesMap): boolean {
  const keys = definition.aux ?? []
  if (keys.length === 0) return true
  return keys.every(key => (series[key]?.length ?? 0) > 0)
}

/** 在途取数句柄：只有自己的请求键仍是当前键时 isCurrent() 为真。 */
export interface AuxRequestHandle {
  readonly key: string
  isCurrent(): boolean
}

/**
 * 竞态守卫（对齐 QuoteStage 既有 requestRef 模式）：记录最新请求键，旧请求的应答
 * 回来时 isCurrent() 为假 → 调用方丢弃，换标的/换市场时在途慢响应不得覆盖新状态。
 */
export function createAuxRequestGuard(): { start: (key: string) => AuxRequestHandle } {
  let current = ''
  return {
    start(key) {
      current = key
      return { key, isCurrent: () => current === key }
    },
  }
}

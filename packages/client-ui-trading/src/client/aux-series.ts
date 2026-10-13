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
import type { ActiveBuyHistory } from './api.ts'
import type { MarketId } from './types.ts'

/** 港股通持股比例的外部序列键（冻结字面量，与预置 definition.aux 同名）。 */
export const HK_CONNECT_HOLDING_KEY: AuxSeriesKey = 'hk-connect-holding'
export const CN_ACTIVE_BUY_KEY: AuxSeriesKey = 'cn-active-buy'
export type ActiveBuyFetcher = (market: MarketId, symbol: string) => Promise<ActiveBuyHistory | undefined>

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

export function activeBuyToAuxPoints(history: ActiveBuyHistory | undefined): readonly AuxPoint[] | undefined {
  if (history === undefined || history.points.length === 0) return undefined
  return history.points.map(point => ({ date: Date.parse(`${point.date}T00:00:00Z`), value: point.netSharePct }))
}

/**
 * Asia/Shanghai（UTC+8，无夏令时），起止分钟均包含。
 * 尾段延至 15:12，覆盖 15:05 采集任务落盘后的五分钟复取，使 live 收敛为 close。
 * 15:00 收盘至 close 行落盘前仍取 live 点、显示「盘中」（数值即当日终值读数）；
 * 这段差异是有意的，不按时间猜徽标：节假日无 live 点，数据门控保证徽标不误显。
 */
export function isCnPollingWindow(nowMs: number): boolean {
  const shanghai = new Date(nowMs + 8 * 60 * 60 * 1000)
  const day = shanghai.getUTCDay()
  const minute = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes()
  return day >= 1 && day <= 5 && ((minute >= 9 * 60 + 25 && minute <= 11 * 60 + 32) || (minute >= 12 * 60 + 58 && minute <= 15 * 60 + 12))
}

export interface AuxSeriesSnapshot {
  readonly points: readonly AuxPoint[] | undefined
  readonly live: boolean
}

export async function loadAuxSeriesSnapshot(
  key: AuxSeriesKey,
  market: MarketId,
  symbol: string,
  fetchHoldings: HoldingsFetcher,
  fetchActiveBuy?: ActiveBuyFetcher,
): Promise<AuxSeriesSnapshot> {
  if (key !== HK_CONNECT_HOLDING_KEY && key !== CN_ACTIVE_BUY_KEY) return { points: undefined, live: false }
  if (key === CN_ACTIVE_BUY_KEY) {
    const history = await fetchActiveBuy?.(market, symbol).catch(() => undefined)
    return { points: activeBuyToAuxPoints(history), live: history?.points.some(point => point.phase === 'live') ?? false }
  }
  const history = await fetchHoldings(market, symbol).catch(() => undefined)
  return { points: southboundHoldingsToAuxPoints(history), live: false }
}

export async function loadAuxSeries(
  key: AuxSeriesKey,
  market: MarketId,
  symbol: string,
  fetchHoldings: HoldingsFetcher,
  fetchActiveBuy?: ActiveBuyFetcher,
): Promise<readonly AuxPoint[] | undefined> {
  return (await loadAuxSeriesSnapshot(key, market, symbol, fetchHoldings, fetchActiveBuy)).points
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
 * 每次 start 都生成新代际，换标的后再切回同一键也不能复活旧应答。
 */
export function createAuxRequestGuard(): { start: (key: string) => AuxRequestHandle } {
  let generation = 0
  return {
    start(key) {
      const requestGeneration = ++generation
      return { key, isCurrent: () => generation === requestGeneration }
    },
  }
}

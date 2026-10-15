/**
 * 各市场当前 provider 与 kline 能力并集的单一缓存（2026-10-14 提取自 holdings-store，
 * 行情级别能力判定与持仓来源标签共用一处）。
 *
 * 来源只能是 `GET /dshtrading/api/markets` 的 `MarketInfo`（连接器路由的实际落点与该
 * 市场全部已注册源声明的能力并集）——禁止按标的逐个探测，也禁止按市场名硬编码推断
 * 路由或能力。
 *
 * 冷启动去重：sidebar 挂载时会拉一次 markets（它需要全部行），拿到后经
 * publishMarketProviders 喂进本缓存；别的消费者（中栏图表能力判定）用
 * ensureMarketProviders，命中缓存即不发请求。
 *
 * 缓存本体是 MarketInfo 全量，provider 表与能力表是它的两份派生视图（引用只在真正
 * 变化时重建，useSyncExternalStore 的快照身份才稳定）。
 */
import { useSyncExternalStore } from 'react'
import { fetchMarkets } from './api.ts'
import type { KlineCapability, MarketId, MarketInfo } from './types.ts'

export type MarketProviderMap = Readonly<Partial<Record<MarketId, string>>>

/** 市场 → 该市场声明的 kline 能力并集；无声明的市场缺席（读侧按未知处理）。 */
export type MarketCapabilityMap = Readonly<Partial<Record<MarketId, readonly KlineCapability[]>>>

const EMPTY: MarketProviderMap = {}
const EMPTY_CAPABILITIES: MarketCapabilityMap = {}

let infos: readonly MarketInfo[] | null = null
let providers: MarketProviderMap = EMPTY
let capabilities: MarketCapabilityMap = EMPTY_CAPABILITIES
let inflight: Promise<MarketProviderMap> | null = null

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function toProviderMap(rows: readonly MarketInfo[]): MarketProviderMap {
  const map: Partial<Record<MarketId, string>> = {}
  for (const info of rows) {
    if (info.provider !== undefined) map[info.id] = info.provider
  }
  return map
}

function toCapabilityMap(rows: readonly MarketInfo[]): MarketCapabilityMap {
  const map: Partial<Record<MarketId, readonly KlineCapability[]>> = {}
  for (const info of rows) {
    if (info.klineCapabilities !== undefined) map[info.id] = info.klineCapabilities
  }
  return map
}

/** 能力声明等价判定：逐条比 interval/maxBars（顺序敏感——桥按源声明顺序上报）。 */
function sameCapabilities(a: readonly KlineCapability[] | undefined, b: readonly KlineCapability[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.length === b.length
    && a.every((cap, index) => cap.interval === b[index]?.interval && cap.maxBars === b[index]?.maxBars)
}

/** provider 或能力任一变化都要重建视图并通知订阅者。 */
function sameInfos(next: readonly MarketInfo[], prev: readonly MarketInfo[] | null): boolean {
  if (prev === null || prev.length !== next.length) return false
  const before = new Map(prev.map(info => [info.id, info]))
  return next.every((info) => {
    const previous = before.get(info.id)
    return previous !== undefined
      && previous.provider === info.provider
      && sameCapabilities(previous.klineCapabilities, info.klineCapabilities)
  })
}

/** 已取到的 markets 列表（sidebar 的响应）喂进缓存；内容等价时不通知订阅者。 */
export function publishMarketProviders(rows: readonly MarketInfo[]): void {
  if (sameInfos(rows, infos)) return
  infos = rows
  providers = toProviderMap(rows)
  capabilities = toCapabilityMap(rows)
  emit()
}

/** 拉一次 markets 并缓存（在途请求去重；失败不缓存，下次调用重试）。 */
export async function ensureMarketProviders(): Promise<MarketProviderMap> {
  if (infos !== null) return providers
  if (inflight === null) {
    inflight = fetchMarkets()
      .then((rows) => {
        publishMarketProviders(rows)
        return providers
      })
      .catch(() => providers)
      .finally(() => { inflight = null })
  }
  return await inflight
}

/** 当前缓存的 provider（未取到时 undefined——调用方按「未知」处理，不得当成不可得）。 */
export function marketProviderOf(market: MarketId): string | undefined {
  return providers[market]
}

/** 当前缓存的能力并集（未取到或该市场无声明时 undefined——同样是「未知」，不是「不可得」）。 */
export function marketCapabilitiesOf(market: MarketId): readonly KlineCapability[] | undefined {
  return capabilities[market]
}

export function marketProviderSnapshot(): MarketProviderMap {
  return providers
}

export function marketCapabilitySnapshot(): MarketCapabilityMap {
  return capabilities
}

export function subscribeMarketProviders(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** provider 表（快照身份稳定，仅在真正变化时触发重渲染）。 */
export function useMarketProviders(): MarketProviderMap {
  return useSyncExternalStore(subscribeMarketProviders, marketProviderSnapshot, () => EMPTY)
}

/** 能力并集表（同上；供五日级别判定与 supportedIntervals 使用）。 */
export function useMarketCapabilities(): MarketCapabilityMap {
  return useSyncExternalStore(subscribeMarketProviders, marketCapabilitySnapshot, () => EMPTY_CAPABILITIES)
}

/**
 * 各市场当前 provider 的单一缓存（2026-10-14 提取自 holdings-store，行情级别
 * 能力判定与持仓来源标签共用一处）。
 *
 * 来源只能是 `GET /dshtrading/api/markets` 的 `MarketInfo.provider`（连接器路由
 * 的实际落点）——禁止按标的逐个探测，也禁止按市场名硬编码推断路由。
 *
 * 冷启动去重：sidebar 挂载时会拉一次 markets（它需要全部行），拿到后经
 * publishMarketProviders 喂进本缓存；别的消费者（中栏图表能力判定）用
 * ensureMarketProviders，命中缓存即不发请求。
 */
import { useSyncExternalStore } from 'react'
import { fetchMarkets } from './api.ts'
import type { MarketId, MarketInfo } from './types.ts'

export type MarketProviderMap = Readonly<Partial<Record<MarketId, string>>>

const EMPTY: MarketProviderMap = {}

let providers: MarketProviderMap | null = null
let inflight: Promise<MarketProviderMap> | null = null

const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function toMap(infos: readonly MarketInfo[]): MarketProviderMap {
  const map: Partial<Record<MarketId, string>> = {}
  for (const info of infos) {
    if (info.provider !== undefined) map[info.id] = info.provider
  }
  return map
}

/** 已取到的 markets 列表（sidebar 的响应）喂进缓存；重复发布不通知订阅者。 */
export function publishMarketProviders(infos: readonly MarketInfo[]): void {
  const next = toMap(infos)
  const same = providers !== null && Object.keys(next).length === Object.keys(providers).length
    && Object.entries(next).every(([market, provider]) => providers?.[market as MarketId] === provider)
  if (same) return
  providers = next
  emit()
}

/** 拉一次 markets 并缓存（在途请求去重；失败不缓存，下次调用重试）。 */
export async function ensureMarketProviders(): Promise<MarketProviderMap> {
  if (providers !== null) return providers
  if (inflight === null) {
    inflight = fetchMarkets()
      .then((infos) => {
        publishMarketProviders(infos)
        return providers ?? EMPTY
      })
      .catch(() => EMPTY)
      .finally(() => { inflight = null })
  }
  return await inflight
}

/** 当前缓存的 provider（未取到时 undefined——调用方按「未知」处理，不得当成不可得）。 */
export function marketProviderOf(market: MarketId): string | undefined {
  return providers?.[market]
}

export function marketProviderSnapshot(): MarketProviderMap {
  return providers ?? EMPTY
}

export function subscribeMarketProviders(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** provider 表（快照身份稳定，仅在真正变化时触发重渲染）。 */
export function useMarketProviders(): MarketProviderMap {
  return useSyncExternalStore(subscribeMarketProviders, marketProviderSnapshot, () => EMPTY)
}

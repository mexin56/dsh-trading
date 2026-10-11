/**
 * GUI 行情轮询预算执行（市场维度）。
 *
 * 金十（`global` 市场）上游配额**按工具分池**，而 `global_quote` / `global_klines`
 * 的 UI/价格路径预算为 **0 常驻**：固定间隔轮询按秒折算，单品种一天的调用量就是
 * 配额的一个数量级以上。所以 global 市场的行情只做**按需取数**——聚焦/切标的/
 * 切周期/回到前台各取一次，不挂定时器。
 *
 * 数值与分配口径的家在 dsh-trading-bot：`packages/tradectl/bin/feeds-budget.mjs`
 * 与 `docs/guides/connectors-guide.md` 的「金十额度预算分配」节。本仓只落**规则**，
 * 不复写数值——两仓各存一份字面量则漂移无从判定。
 *
 * @module client/quote-budget
 */
import type { MarketId } from './types.ts'

/** 无固定间隔轮询预算的市场（行情只按需取数）。 */
export const NO_RESIDENT_POLL_MARKETS: readonly MarketId[] = ['global']

/** 该市场是否允许挂常驻轮询（未选标的时不允许：等选到标的再由依赖变化触发）。 */
export function isResidentPollMarket(market: MarketId | undefined): boolean {
  return market !== undefined && !NO_RESIDENT_POLL_MARKETS.includes(market)
}

/**
 * 常驻轮询间隔：允许的市场原样返回，否则返回 `null`——`usePoll` 收到 null 即不挂
 * 定时器，只在依赖变化与文档重新可见时各取一次（见 usePoll.ts）。
 */
export function residentPollMs(market: MarketId | undefined, intervalMs: number): number | null {
  return isResidentPollMarket(market) ? intervalMs : null
}

/**
 * 把 `${market}:${symbol}` 键串筛成允许常驻的市场子集（盯市/批量取价用）；
 * 无键或全被筛掉时返回空串，调用方据此跳过本轮取数。
 */
export function residentTargetKeys(keyCsv: string): string {
  if (keyCsv === '') return ''
  return keyCsv
    .split(',')
    .filter(key => isResidentPollMarket(key.slice(0, key.indexOf(':')) as MarketId))
    .join(',')
}

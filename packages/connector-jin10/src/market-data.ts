/**
 * global 市场数据面（registry 注册面）：金十 get_quote / get_kline / quote://codes
 * → `MarketDataService`（GUI 行情桥与 <market> 工具族共用同一实现）。
 *
 * 词汇与粒度事实（2026-09-13 实测，见 spikes/impl-jin10-mcp/EVIDENCE）：
 * - 品种代码就是市场规范形（XAUUSD / USOIL / USDJPY / GSPC 式指数），金十原生大写形；
 * - get_kline 只有**分钟级** K 线，且单次 `count` 上限 100、语义是「从 time 往后取
 *   count 根」——所以更粗的周期由本地按桶聚合，深度上限 = 拼窗口（本仓最多 300 分钟，
 *   即 3 次上游调用）。再深的历史上游不提供，不做假数据、不换源冒充；
 * - 休市/无数据时上游回 `klines: []`（合法结果），本层照实返回空序列（≠ 报错）。
 */
import type { Disposable, Interval, Kline, MarketDataService, Ticker } from '@dshtrading/api'
import { Jin10Error } from './errors.js'
import type { Jin10Kline, Jin10Quote } from './parse.js'
import type { Jin10Service } from './service.js'

/** 市场 id：全局品种（大宗/外汇/海外指数），与 crypto/us/cn/hk/futures 同级。 */
export const GLOBAL_MARKET = 'global'
/** 路由 provider slug（router PROVIDER_VOCABULARY 同步登记）。 */
export const JIN10_PROVIDER = 'jin10'
/** Context 服务键（与其余市场 trading<Market>MarketData 命名一致）。 */
export const TRADING_GLOBAL_MARKET_DATA_KEY = 'tradingGlobalMarketData'

/** 上游单次 get_kline 上限（count 1..100，从 time 往后取）。 */
export const MINUTE_BARS_PER_CALL = 100
/** 本仓最多拼的分钟窗口（3 次上游调用）；再深的历史上游没有，不做假数据。 */
export const MAX_MINUTE_WINDOW = 300
/**
 * 本市场**不提供常驻 ticker 订阅**：`global_quote` / `global_klines` 的 UI/价格
 * 路径预算为 **0 常驻**——上游配额按工具分池，固定间隔轮询按秒折算必然超出一个
 * 数量级。分配口径与折算数值的家是 dsh-trading-bot 的
 * `packages/tradectl/bin/feeds-budget.mjs` 与 `docs/guides/connectors-guide.md`
 * 的「金十额度预算分配」节（本仓只引用规则，不复写数值）；GUI 侧节奏执行见
 * client-ui-trading 的 quote-budget.ts。要价格一律按需：`getTicker` / `getKlines`。
 */

/** 支持的周期 → 每根分钟数（api Interval 的子集：分钟级来源能诚实支撑的部分）。 */
const INTERVAL_MINUTES: Record<string, number> = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60 }

export function resolveIntervalMinutes(interval: string): number | undefined {
  return INTERVAL_MINUTES[interval]
}

/** 按分钟数聚合（桶起点 = 本地时间轴对齐；量能求和，缺量按 0）。 */
export function aggregateKlines(bars: readonly Kline[], minutes: number): Kline[] {
  if (minutes <= 1) return bars.map(bar => ({ ...bar }))
  const bucketMs = minutes * 60_000
  const out: Kline[] = []
  for (const bar of bars) {
    const start = Math.floor(bar.openTime / bucketMs) * bucketMs
    const last = out[out.length - 1]
    if (last !== undefined && last.openTime === start) {
      out[out.length - 1] = {
        openTime: last.openTime,
        closeTime: bar.closeTime,
        open: last.open,
        high: Math.max(last.high, bar.high),
        low: Math.min(last.low, bar.low),
        close: bar.close,
        volume: last.volume + bar.volume,
      }
      continue
    }
    out.push({ ...bar, openTime: start, closeTime: start + bucketMs - 1 })
  }
  return out
}

/** get_quote → Ticker（缺失最新价 = 上游形状异常，如实报错，不编价格）。 */
export function tickerFromQuote(quote: Jin10Quote): Ticker {
  const price = quote.close
  if (price === undefined || !Number.isFinite(price)) {
    throw new Jin10Error('TRADING_EXCHANGE_ERROR', 'jin10 get_quote: ' + quote.code + ' has no latest price (market closed or symbol unavailable)')
  }
  const change = quote.change
  const prevClose = change === undefined ? undefined : Number((price - change).toFixed(6))
  // parseJin10Time 归一为 ISO 字符串（见 parse.ts），契约 Ticker.timestamp 是 epoch ms。
  const parsedTime = quote.time === undefined ? Number.NaN : Date.parse(quote.time)
  return {
    symbol: quote.code.toUpperCase(),
    ...(quote.name !== undefined ? { name: quote.name } : {}),
    price,
    ...(prevClose !== undefined ? { prevClose } : {}),
    ...(quote.changePercent !== undefined ? { changePercent: quote.changePercent } : {}),
    ...(quote.volume !== undefined ? { volume: quote.volume } : {}),
    timestamp: Number.isFinite(parsedTime) ? parsedTime : Date.now(),
  }
}

/**
 * 单根分钟 K → 契约 Kline（openTime/closeTime 毫秒，量缺省 0）。
 * 上游字段可缺省 → 缺 OHLC 的残根返回 undefined（丢弃，不编价格）。
 */
function minuteBarToKline(bar: Jin10Kline): Kline | undefined {
  const { open, high, low, close } = bar
  if (open === undefined || high === undefined || low === undefined || close === undefined) return undefined
  const openTime = bar.time * 1000
  return {
    openTime,
    closeTime: openTime + 60_000 - 1,
    open,
    high,
    low,
    close,
    volume: bar.volume ?? 0,
  }
}

/** global 市场数据面实现（纯对象；与快讯面同款，避免 Service 构造签名的类型漂移）。 */
export function createJin10GlobalMarketDataService(feed: Jin10Service): MarketDataService {

  const requireCode = (symbol: string): string => {
    const trimmed = symbol.trim().toUpperCase()
    if (trimmed === '') throw new Jin10Error('TRADING_UNKNOWN', 'jin10 global: symbol must not be empty')
    return trimmed
  }

  const loadTicker = async (symbol: string): Promise<Ticker> => tickerFromQuote(await feed.getQuote(requireCode(symbol)))

  /** 拼分钟窗口（从 time 往后取，最多 3 次上游调用；按时间戳去重后升序）。 */
  const loadMinuteWindow = async (symbol: string, minutes: number): Promise<Kline[]> => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const start = nowSeconds - minutes * 60
    const calls = Math.max(1, Math.min(Math.ceil(minutes / MINUTE_BARS_PER_CALL), Math.ceil(MAX_MINUTE_WINDOW / MINUTE_BARS_PER_CALL)))
    const seen = new Set<number>()
    const collected: Kline[] = []
    for (let index = 0; index < calls; index += 1) {
      const from = start + index * MINUTE_BARS_PER_CALL * 60
      const raw = await feed.getKlines(symbol, { time: from, count: MINUTE_BARS_PER_CALL })
      for (const bar of raw) {
        if (seen.has(bar.time)) continue
        const kline = minuteBarToKline(bar)
        if (kline === undefined) continue
        seen.add(bar.time)
        collected.push(kline)
      }
    }
    return collected.sort((a, b) => a.openTime - b.openTime)
  }

  return {
    async getTicker(symbol: string): Promise<Ticker> {
      return loadTicker(symbol)
    },

    async getKlines(symbol: string, interval: Interval, limit = 120): Promise<Kline[]> {
      const minutes = resolveIntervalMinutes(interval)
      if (minutes === undefined) {
        throw new Jin10Error('TRADING_UNKNOWN', 'jin10 global: unsupported interval "' + interval + '" (upstream serves minute bars only: 1m/3m/5m/15m/30m/1h)')
      }
      const wanted = Math.max(1, Math.min(Math.floor(limit), Math.floor(MAX_MINUTE_WINDOW / minutes)))
      const bars = await loadMinuteWindow(requireCode(symbol), wanted * minutes)
      return aggregateKlines(bars, minutes).slice(-wanted)
    },

    /**
     * 常驻 ticker 订阅显式拒绝（见模块头注释）：本市场没有常驻轮询预算，静默
     * 轮询正是预算失控的形态。要价格请按需 `getTicker`。
     */
    subscribeTicker(symbol: string): Disposable {
      throw new Jin10Error(
        'TRADING_NOT_IMPLEMENTED',
        'jin10 global: 不提供常驻 ticker 订阅（global_quote 的 UI/价格路径预算为 0 常驻，见 connectors-guide「金十额度预算分配」）；请按需调用 getTicker。symbol=' + symbol,
      )
    },

    async listInstruments(): Promise<Array<{ symbol: string; name?: string }>> {
      const items = await feed.listInstruments()
      return items.map(item => ({ symbol: item.code.toUpperCase(), name: item.name }))
    },
  }
}

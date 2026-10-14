/**
 * 五日级别（客户端视图级别 '5d'）的纯计算：量比着色、交易日分组与拼接轴。
 *
 * 级别语义：把最近 5 个交易日的 1 分钟 K 线按本地时钟分钟对齐，用「该分钟成交量
 * ÷ 前 1-4 个交易日同分钟成交量均值」的量比给成交量分档着色。窗口内最早一日是
 * 基准日（没有前值，只作参照），不着色。
 *
 * 三条不变量：
 * 1. 该级别是**纯客户端视图**——'5d' 不属于 @dshtrading/api 的 Interval 联合
 *    （连接器不认识这个词汇），取数永远是 `fetchKlines(market, symbol, '1m', n)`
 *    加本地按交易日分组。
 * 2. 能力驱动：只有当前路由数据源能诚实提供 5 交易日 1m 时才允许出现该级别
 *    （见 fiveDayCapability，事实来源 spikes/impl-five-day-1m-probe/EVIDENCE.md）。
 *    不可得即不出现，绝不裁剪/复制数据冒充五个交易日。
 * 3. 无副作用：本模块只做纯计算，localStorage/DOM/网络都不碰。
 *
 * x 轴拼接：lightweight-charts 的横轴是「一根 bar 一个槽位」，相邻槽位之间没有
 * 时间距离——隔夜与午休空档天然被压缩掉。日界由 fiveDayDayStarts 显式标出。
 */
import type { Kline, MarketId } from './types.ts'
import { MARKET_TIMEZONE, marketLocalDay, marketLocalMinute } from './market-time.ts'
import { MARKET_INTERVALS } from './store.ts'

/** 客户端视图级别 id（不进连接器词汇表）。 */
export const FIVE_DAY_INTERVAL = '5d'

/** 窗口交易日数。 */
export const FIVE_DAY_TRADING_DAYS = 5

/** 取数上限：cn 每日 241 根、hk 331 根、us 390 根，5 日最坏 5×390=1950，留余量取 2500。 */
export const FIVE_DAY_KLINE_LIMIT = 2500

/**
 * 重取节奏：60s。该级别一次拉约 1200-1950 根（us 5 日约 1950 根 ≈ 8 倍于常规
 * 周期的 500 根），沿用 30s 全量重取等于把上游配额翻倍——盘中最新一根由既有
 * ticker 5s 合并推进（withTickerBar），60s 只做兜底校正。
 */
export const FIVE_DAY_RESYNC_MS = 60_000

/** 该级别可能可得的市场（真实可得性还看当前路由 provider）。 */
export const FIVE_DAY_MARKETS: readonly MarketId[] = ['us', 'cn', 'hk']

/**
 * 能力三态：yes = 当前路由能诚实提供 5 交易日 1m；no = 该路由结构性不可得；
 * unknown = provider 尚未取到（不能据此判定不可得——按 unknown 保留记忆中的
 * 级别，等 provider 到位后再定）。
 */
export type FiveDayCapability = 'yes' | 'no' | 'unknown'

/** (市场, 路由 provider) → 是否可得 5 交易日 1m。 */
const CAPABLE_ROUTES: ReadonlyArray<readonly [MarketId, string]> = [
  ['us', 'yahoo'],      // chart 1m range=7d：2730 根 / 7 个会话，≥5 ✓
  ['cn', 'eastmoney'],  // trends2 ndays=5：1205 根 / 5 个交易日 ✓（历史开价由连接器用前收盘重建）
  ['hk', 'eastmoney'],  // trends2 ndays=5：1655 根 / 5 个交易日 ✓
]

/**
 * 当前路由能否诚实提供 5 交易日 1m。tencent 路由（cn/hk 默认）只有 800 根
 * m1 ≈ 3.3 个交易日且无翻页；crypto/futures/global 结构性不足（上游单请求
 * 300/100/当日分时）——这些一律 no，胶囊不出现。
 */
export function fiveDayCapability(market: MarketId, provider: string | undefined): FiveDayCapability {
  if (!FIVE_DAY_MARKETS.includes(market)) return 'no'
  if (provider === undefined || provider === '') return 'unknown'
  return CAPABLE_ROUTES.some(([routeMarket, routeProvider]) => routeMarket === market && routeProvider === provider)
    ? 'yes'
    : 'no'
}

/**
 * 该市场当前路由下的图表级别列表（'5d' 紧跟 '1d'，与日 K/分钟级别平级）。
 * 不可得的市场/路由原样返回连接器级别集——胶囊不出现，且不渲染任何假数据。
 */
export function chartIntervals(market: MarketId, provider: string | undefined): string[] {
  const base = MARKET_INTERVALS[market] ?? ['1d']
  if (fiveDayCapability(market, provider) !== 'yes') return [...base]
  const index = base.indexOf('1d')
  const next = [...base]
  next.splice(index < 0 ? next.length : index + 1, 0, FIVE_DAY_INTERVAL)
  return next
}

/**
 * 级别记忆的读回判据：连接器级别集之外，'5d' 按「市场是否属于可能可得族」接受。
 * 不按当前路由判定——路由切换（tencent ↔ eastmoney）会让记住的 5d 被读回判据
 * 静默丢弃；真正的路由回落由调用方的能力守卫处理。
 */
export function rememberableInterval(market: MarketId, interval: string): boolean {
  if ((MARKET_INTERVALS[market] ?? []).includes(interval)) return true
  return interval === FIVE_DAY_INTERVAL && FIVE_DAY_MARKETS.includes(market)
}

/**
 * 数据重置（dataKey 变化 / 首帧落地）时的默认视窗策略：
 * - `fit-window`：五日级别铺满整个 5 日窗口——该级别的语义就是「5 段拼接 + 4 条
 *   日界」，沿用常规级别的默认 barSpacing 会只露出最近一两个小时（user 点「五日」
 *   却看到一张一小时的图）。不锁定视窗，`fitContent` 之后仍可自由缩放平移。
 * - `recent-edge`：常规级别维持既有 `resetTimeScale + scrollToRealTime`（默认
 *   barSpacing、最新价贴右缘）。
 */
export type ViewportResetStrategy = 'fit-window' | 'recent-edge'

export function viewportResetStrategy(fiveDayActive: boolean): ViewportResetStrategy {
  return fiveDayActive ? 'fit-window' : 'recent-edge'
}

/** 分档（量比 r）：r<1 黄；1≤r<2 浅红；2≤r<3 深红；r≥3 黑。 */
export type FiveDayRatioTier = 'lt1' | 'lt2' | 'lt3' | 'gte3'

/** 着色档位：四档量比 + 基准日 + 无前值（后两者同为中性灰）。 */
export type FiveDayTier = FiveDayRatioTier | 'baseline' | 'noPrior'

export function ratioTier(ratio: number): FiveDayRatioTier {
  if (ratio < 1) return 'lt1'
  if (ratio < 2) return 'lt2'
  if (ratio < 3) return 'lt3'
  return 'gte3'
}

export interface FiveDayBar {
  kline: Kline
  /** 窗口内交易日下标：0 = 基准日（最早一日）。 */
  dayIndex: number
  /** 本地日历日 YYYY-MM-DD。 */
  date: string
  /** 本地时钟分钟数（0..1439）——跨日对齐键。 */
  minute: number
  /** 参与均值的前值交易日数（0..4）。 */
  priorDays: number
  /** 量比；null = 无任何前值（或前值均值与本分钟量同为 0，比值无定义）。 */
  ratio: number | null
  tier: FiveDayTier
}

export interface FiveDayTradingDay {
  date: string
  bars: Kline[]
}

/**
 * 按市场本地日历日分组（升序，日序与时间序一致）。crypto/global 无交易日概念，
 * 返回空数组——五日级别本就不对它们开放。
 */
export function groupTradingDays(market: MarketId, klines: readonly Kline[]): FiveDayTradingDay[] {
  const tz = MARKET_TIMEZONE[market]
  if (tz === null) return []
  const out: FiveDayTradingDay[] = []
  for (const kline of klines) {
    const date = marketLocalDay(tz, kline.openTime)
    const last = out[out.length - 1]
    if (last === undefined || last.date !== date) out.push({ date, bars: [kline] })
    else last.bars.push(kline)
  }
  return out
}

/** 最近 count 个交易日（升序）。当日进行中也照常入窗——最后一个交易日天然是部分会话。 */
export function recentTradingDays(market: MarketId, klines: readonly Kline[], count: number = FIVE_DAY_TRADING_DAYS): FiveDayTradingDay[] {
  const days = groupTradingDays(market, klines)
  return days.slice(Math.max(0, days.length - count))
}

/**
 * 最近 5 个交易日的 1m bar → 逐根量比与着色档位（升序拼接，与入窗 bar 一一对应）。
 *
 * 量比口径：第 i 日（窗口内 i≥1）某本地时钟分钟的量为 v 时
 *   r = v ÷ mean(前 1-4 个交易日中「存在该分钟」的那些日的同分钟量)
 * 前值不足 4 日按可得天数；某前日缺该分钟则不参与均值。窗口最早一日（i=0）是
 * 基准日，恒为中性灰；i≥1 但无任何前值（或前值均值与 v 同为 0）也是中性灰。
 */
export function toFiveDayBars(market: MarketId, klines: readonly Kline[], count: number = FIVE_DAY_TRADING_DAYS): FiveDayBar[] {
  const tz = MARKET_TIMEZONE[market]
  if (tz === null) return []
  const days = recentTradingDays(market, klines, count)
  // 每日本地分钟 → 量（缺分钟不建键，故「缺该分钟」自然不参与均值）。
  const volumeByMinute: Array<Map<number, number>> = days.map(day => {
    const map = new Map<number, number>()
    for (const bar of day.bars) map.set(marketLocalMinute(tz, bar.openTime), bar.volume)
    return map
  })

  const out: FiveDayBar[] = []
  for (let dayIndex = 0; dayIndex < days.length; dayIndex++) {
    const day = days[dayIndex] as FiveDayTradingDay
    const prior = volumeByMinute.slice(Math.max(0, dayIndex - 4), dayIndex)
    for (const kline of day.bars) {
      const minute = marketLocalMinute(tz, kline.openTime)
      if (dayIndex === 0 || prior.length === 0) {
        out.push({ kline, dayIndex, date: day.date, minute, priorDays: 0, ratio: null, tier: 'baseline' })
        continue
      }
      let sum = 0
      let priorDays = 0
      for (const dayVolumes of prior) {
        const volume = dayVolumes.get(minute)
        if (volume === undefined) continue
        sum += volume
        priorDays += 1
      }
      if (priorDays === 0) {
        out.push({ kline, dayIndex, date: day.date, minute, priorDays: 0, ratio: null, tier: 'noPrior' })
        continue
      }
      const mean = sum / priorDays
      if (mean === 0) {
        // 前值全零：本分钟也为 0 时比值无定义（中性灰）；有量则比值发散，按最高档处理。
        if (kline.volume === 0) out.push({ kline, dayIndex, date: day.date, minute, priorDays, ratio: null, tier: 'noPrior' })
        else out.push({ kline, dayIndex, date: day.date, minute, priorDays, ratio: Number.POSITIVE_INFINITY, tier: 'gte3' })
        continue
      }
      const ratio = kline.volume / mean
      out.push({ kline, dayIndex, date: day.date, minute, priorDays, ratio, tier: ratioTier(ratio) })
    }
  }
  return out
}

/**
 * 日界位置：每个交易日首根 bar 的开盘时刻（毫秒），不含窗口首日（它在图左端）。
 * 轴 formatter 用它显示日期标签，TvChart 用它画竖分隔线。
 */
export function fiveDayDayStarts(bars: readonly FiveDayBar[]): number[] {
  const starts: number[] = []
  let seenDayIndex = bars[0]?.dayIndex
  for (const bar of bars) {
    if (seenDayIndex === undefined) seenDayIndex = bar.dayIndex
    if (bar.dayIndex !== seenDayIndex) starts.push(bar.kline.openTime)
    seenDayIndex = bar.dayIndex
  }
  return starts
}

/** 成交量档位色（亮色主题）。 */
const TIER_COLORS_LIGHT: Record<FiveDayTier, string> = {
  lt1: '#d9a01f',
  lt2: '#ee7f72',
  lt3: '#c62828',
  gte3: '#1c1c1e',
  baseline: '#a8adb8',
  noPrior: '#a8adb8',
}

/** 成交量档位色（深色主题）：同语义高对比换色——深色底上真正的黑不可辨认，最高一档改用近白。 */
const TIER_COLORS_DARK: Record<FiveDayTier, string> = {
  lt1: '#e8c552',
  lt2: '#f0958b',
  lt3: '#e5484d',
  gte3: '#f2f4f8',
  baseline: '#6b7280',
  noPrior: '#6b7280',
}

/** 档位 → 成交量柱颜色。不受红涨绿跌设置影响（该级别读的是量比，不是涨跌）。 */
export function fiveDayVolumeColor(tier: FiveDayTier, dark: boolean): string {
  return (dark ? TIER_COLORS_DARK : TIER_COLORS_LIGHT)[tier]
}

/** 图例档位顺序（含阈值语义与基准日）。 */
export const FIVE_DAY_LEGEND_TIERS: readonly FiveDayTier[] = ['lt1', 'lt2', 'lt3', 'gte3', 'baseline', 'noPrior']

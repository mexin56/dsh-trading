/**
 * 市场本地时间口径的单一实现（2026-10-14 提取自 intraday-series）：
 * 「最后一根 bar 落在哪个交易日」「同分钟跨日对齐」「固定交易时段 x 位置」
 * 三处消费共用同一张时区表与同一组格式化器——第二份时区表会让分组口径与
 * 轴口径悄悄漂移，且没有任何测试能发现。
 *
 * crypto/global 为 null：滚动窗口 / 跨时区连续交易，没有交易日本地日概念。
 */
import type { MarketId } from './types.ts'

export const MARKET_TIMEZONE: Record<MarketId, string | null> = {
  crypto: null,
  us: 'America/New_York',
  cn: 'Asia/Shanghai',
  hk: 'Asia/Hong_Kong',
  futures: 'Asia/Shanghai',
  // 全球品种跨时区连续交易（周一 06:00 — 周六 05:00 北京时间），不做交易日分组。
  global: null,
}

/** 该市场的本地时区（无交易日概念的市场返回 null）。 */
export function marketTimezone(market: MarketId): string | null {
  return MARKET_TIMEZONE[market]
}

const dayFmtCache = new Map<string, Intl.DateTimeFormat>()
const clockFmtCache = new Map<string, Intl.DateTimeFormat>()

function dayFmt(tz: string): Intl.DateTimeFormat {
  let fmt = dayFmtCache.get(tz)
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    dayFmtCache.set(tz, fmt)
  }
  return fmt
}

function clockFmt(tz: string): Intl.DateTimeFormat {
  let fmt = clockFmtCache.get(tz)
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    clockFmtCache.set(tz, fmt)
  }
  return fmt
}

/** 市场本地日历日 YYYY-MM-DD（DST 由 Intl 处理）。 */
export function marketLocalDay(tz: string, openTime: number): string {
  return dayFmt(tz).format(openTime)
}

/** 市场本地时刻的分钟数（0..1439）；跨日同分钟对齐键。 */
export function marketLocalMinute(tz: string, openTime: number): number {
  const parts = clockFmt(tz).formatToParts(openTime)
  const hour = Number(parts.find(p => p.type === 'hour')?.value)
  const minute = Number(parts.find(p => p.type === 'minute')?.value)
  return hour * 60 + minute
}

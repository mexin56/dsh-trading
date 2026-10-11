/**
 * 行情轮询预算（市场维度）：金十（`global`）市场的 `global_quote` / `global_klines`
 * 常驻预算为 0——只按需取数；其余市场维持既有节奏。数值口径的家在
 * dsh-trading-bot（feeds-budget.mjs + connectors-guide「金十额度预算分配」），
 * 这里只测本仓落下的**规则**。
 */
import { describe, expect, it } from 'vitest'
import {
  NO_RESIDENT_POLL_MARKETS,
  isResidentPollMarket,
  residentPollMs,
  residentTargetKeys,
} from '../src/client/quote-budget.ts'

describe('行情轮询预算（市场维度）', () => {
  it('用户聚焦全球品种时不挂常驻轮询（间隔收为 null）', () => {
    // Given 全球（金十）在无常驻预算的市场名单里
    expect(NO_RESIDENT_POLL_MARKETS).toContain('global')
    // When 解析该市场的轮询间隔
    const interval = residentPollMs('global', 5_000)
    // Then 返回 null（usePoll 据此不挂定时器），且该市场不算可常驻
    expect(interval).toBeNull()
    expect(isResidentPollMarket('global')).toBe(false)
  })

  it('用户聚焦其它市场时节奏原样保留（预算策略不误伤）', () => {
    // Given 有预算的市场
    // When 解析各自的轮询间隔
    // Then 原样返回，不被策略改写
    expect(residentPollMs('us', 5_000)).toBe(5_000)
    expect(residentPollMs('crypto', 30_000)).toBe(30_000)
  })

  it('用户尚未选标的时不挂常驻轮询（等选到再由依赖变化触发）', () => {
    // Given 未选市场（undefined）
    // When 解析间隔
    // Then 收为 null，且不算可常驻市场
    expect(residentPollMs(undefined, 5_000)).toBeNull()
    expect(isResidentPollMarket(undefined)).toBe(false)
  })

  it('用户打开资产面板时，盯市目标只留可常驻市场且键序不变', () => {
    // Given 跨市场盯市键串（含 global）
    const keyCsv = 'cn:600519,global:XAUUSD,us:AAPL'
    // When 按常驻预算过滤
    const kept = residentTargetKeys(keyCsv)
    // Then 只留下有预算的市场键（顺序不变）；空串与全被筛掉都返回空串
    expect(kept).toBe('cn:600519,us:AAPL')
    expect(residentTargetKeys('')).toBe('')
    expect(residentTargetKeys('global:XAUUSD')).toBe('')
  })
})

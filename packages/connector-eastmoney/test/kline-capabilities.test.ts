/**
 * eastmoney K 线能力声明用例（api 可选契约 klineCapabilities，2026-10-15 跨源 K 线路由）。
 *
 * 本连接器是 cn/hk 跨源取五日 1m 的供数方，故 1m 的声明深度是整条路由的关键判据：
 * 声明必须承接桥的参数闸门（MAX_KLINE_LIMIT = 2500），否则客户端会判定「该市场取不到
 * 5 个交易日的 1m」而隐藏五日级别（packages/client-ui-trading 的 fiveDayCapability）。
 * 实现侧证据：trends2 ndays=5 是上游唯一的多日 1m 通道（ndays=10 → rc:1），一次给最近
 * 5 个交易日（cn ≈1205 根 / hk ≈1655 根，实测每交易日 cn 241 / hk 331）；5m 及以上走
 * kline/get，lmt 直通上游且有深历史（klt=5&lmt=1000 → 1000 根）
 * —— spikes/impl-five-day-1m-probe/EVIDENCE.md §3。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  EASTMONEY_KLINE_MAX_BARS,
  EastmoneyRestClient,
  INTERVAL_VOCABULARY,
} from '../src/rest.js'
import { EastmoneyMarketDataService } from '../src/index.ts'

/** 连接器单测惯用的最小 ctx 面（真 Service 构造路径，不 mock 业务行为）。 */
function duckCtx(): Context {
  return { reflect: { provide: () => {} } } as unknown as Context
}

describe('eastmoney K 线能力声明（klineCapabilities）', () => {
  it('用户查询 A 股五日 1m 时声明 1m 且深度承接 2500 根请求（否则客户端会隐藏该级别）', () => {
    // Given cn 实例（1m 走 trends2 五日窗口）
    const declared = new EastmoneyRestClient({ market: 'cn' }).klineCapabilities()

    // Then 1m 在位且 maxBars = 承接闸门 2500（客户端判据是同值比较）
    const oneMinute = declared.find(cap => cap.interval === '1m')
    expect(oneMinute).toEqual({ interval: '1m', maxBars: EASTMONEY_KLINE_MAX_BARS })
    expect(oneMinute?.maxBars).toBeGreaterThanOrEqual(2500)
  })

  it('用户查询任一受支持周期时声明集 = 实现面（cn/hk 两条通道周期相同）', () => {
    // Given cn 与 hk 两个实例
    const cn = new EastmoneyRestClient({ market: 'cn' }).klineCapabilities()
    const hk = new EastmoneyRestClient({ market: 'hk' }).klineCapabilities()

    // Then 两个市场的声明逐条相同，且周期集 = mapIntervalToKlt 支持的词汇
    expect(cn.map(cap => cap.interval)).toEqual([...INTERVAL_VOCABULARY])
    expect(hk).toEqual(cn)
  })

  it('运营注册 dataplane 行时 cn/hk 服务实例都透传同一份声明（注册面 = 声明面）', () => {
    // Given 与 dataplane 同参构造的两个服务实例
    const cn = new EastmoneyMarketDataService(duckCtx(), { market: 'cn' }, 'tradingCnMarketData')
    const hk = new EastmoneyMarketDataService(duckCtx(), { market: 'hk' }, 'tradingHkMarketData')

    // Then 两个实例的声明与同市场 REST 客户端逐条相同
    expect(cn.klineCapabilities()).toEqual(new EastmoneyRestClient({ market: 'cn' }).klineCapabilities())
    expect(hk.klineCapabilities()).toEqual(new EastmoneyRestClient({ market: 'hk' }).klineCapabilities())
  })
})

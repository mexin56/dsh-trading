/**
 * yahoo K 线能力声明用例（api 可选契约 klineCapabilities，2026-10-15 跨源 K 线路由）。
 *
 * 1m 是 us 市场五日级别的取数通道，其深度有实测值：chart/AAPL|MSFT?interval=1m&range=7d
 * 返回 2730 根非空 bar（覆盖 7 个会话，2026-10-05..10-13），窗口再大上游直接 422
 * 「Only 8 days worth of 1m granularity data are allowed」
 * —— spikes/impl-five-day-1m-probe/EVIDENCE.md §5。
 * 其余周期的窗口根数随市场/交易日数浮动，本客户端没有可报的实测数字，故声明承接闸门
 * （上游无 limit 语义：窗口由 range= 决定，返回后按 limit 截尾）。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  INTERVAL_VOCABULARY,
  YAHOO_KLINE_MAX_BARS,
  YAHOO_ONE_MINUTE_MAX_BARS,
  YahooRestClient,
  yahooKlineCapabilities,
} from '../src/rest.js'
import { YahooMarketDataService } from '../src/index.ts'

/** 连接器单测惯用的最小 ctx 面（真 Service 构造路径，不 mock 业务行为）。 */
function duckCtx(): Context {
  return { reflect: { provide: () => {} } } as unknown as Context
}

describe('yahoo K 线能力声明（klineCapabilities）', () => {
  it('用户查询美股 1m 时声明实测窗口深度 2730（range=7d 原窗口，再大上游 422）', () => {
    // Given Yahoo chart 端点的受支持周期集
    const declared = new YahooRestClient().klineCapabilities()

    // Then 1m 声明实测值 2730（≥ 桥参数闸门 2500，五日级别因此可用）
    expect(declared.find(cap => cap.interval === '1m')).toEqual({ interval: '1m', maxBars: YAHOO_ONE_MINUTE_MAX_BARS })
    expect(YAHOO_ONE_MINUTE_MAX_BARS).toBeGreaterThanOrEqual(2500)
  })

  it('用户查询其余周期时声明承接闸门 2500 且周期集 = 实现面', () => {
    // Given 同一份声明
    const declared = new YahooRestClient().klineCapabilities()

    // Then 周期集 = INTERVAL_TO_YAHOO 的键；除 1m 外深度都是承接闸门（没有实测的窗口根数）
    expect(declared.map(cap => cap.interval)).toEqual([...INTERVAL_VOCABULARY])
    expect(declared.filter(cap => cap.interval !== '1m').every(cap => cap.maxBars === YAHOO_KLINE_MAX_BARS)).toBe(true)
  })

  it('运营注册 dataplane 行时服务实例透传同一份声明（注册面 = 声明面）', () => {
    // Given 与 dataplane 同参构造的服务实例
    const service = new YahooMarketDataService(duckCtx(), {}, 'tradingUsMarketData')

    // When 读取服务（而不是 REST 客户端）的能力声明
    // Then 与连接器导出的声明函数逐条相同
    expect(service.klineCapabilities()).toEqual(yahooKlineCapabilities())
  })
})

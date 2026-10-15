/**
 * tencent K 线能力声明用例（api 可选契约 klineCapabilities，2026-10-15 跨源 K 线路由）。
 *
 * 声明的两个方向都有代价：多报一个周期会让桥把请求路由到本源再吃错误码（多一次上游
 * 往返），少报会让桥无谓跨源（用户选了本源却拿到别家数据）。故这里断言声明集**等于**
 * 实现面（INTERVAL_TO_TENCENT 的周期集去掉 hk 的分钟），深度等于连接器自己的裁剪点
 * （getKlines 的 Math.min(limit, TENCENT_KLINE_MAX_BARS)）。
 *
 * 实证：spikes/impl-five-day-1m-probe/EVIDENCE.md §1（mkline count ≤ 800；> 800 上游静默
 * 降到 320 根，无游标可翻页；hk mkline 一律 msg=param error）、§2（cn 无 1m 通道）。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { INTERVAL_VOCABULARY, TENCENT_KLINE_MAX_BARS, TencentRestClient } from '../src/rest.js'
import { TencentMarketDataService } from '../src/index.ts'

/** 连接器单测惯用的最小 ctx 面（真 Service 构造路径，不 mock 业务行为）。 */
function duckCtx(): Context {
  return { reflect: { provide: () => {} } } as unknown as Context
}

describe('tencent K 线能力声明（klineCapabilities）', () => {
  it('用户查询 A 股时声明集不含 1m，其余受支持周期一律按单请求上限 800 上报', () => {
    // Given cn 实例：mkline 只有 5m/30m，公开端点无 1m 通道
    const declared = new TencentRestClient('cn').klineCapabilities()

    // Then 周期集 = 实现面（INTERVAL_VOCABULARY 由同一份映射导出），深度 = 连接器的裁剪点 800
    expect(declared.map(cap => cap.interval)).toEqual([...INTERVAL_VOCABULARY])
    expect(declared.every(cap => cap.maxBars === TENCENT_KLINE_MAX_BARS)).toBe(true)
    expect(declared.map(cap => cap.interval)).not.toContain('1m')
  })

  it('用户查询港股时声明集只留日周月（hk mkline 端点一律 param error）', () => {
    // Given hk 实例：getKlines 对分钟周期显式抛 TRADING_UNSUPPORTED_INTERVAL
    const declared = new TencentRestClient('hk').klineCapabilities()

    // Then 声明集 = 日/周/月三个周期，分钟周期一个都不在里面（1m/5m/30m 全排除）
    expect(declared.map(cap => cap.interval)).toEqual(['1d', '1w', '1M'])
    expect(declared.some(cap => ['1m', '5m', '30m'].includes(cap.interval))).toBe(false)
    expect(declared.every(cap => cap.maxBars === TENCENT_KLINE_MAX_BARS)).toBe(true)
  })

  it('运营注册 dataplane 行时服务实例透传同一份声明（注册面 = 声明面）', () => {
    // Given 与 dataplane 同参构造的服务实例
    const service = new TencentMarketDataService(duckCtx(), 'hk', {}, 'tradingHkMarketData')

    // When 读取服务（而不是 REST 客户端）的能力声明
    const declared = service.klineCapabilities()

    // Then 与同市场 REST 客户端逐条相同：桥在注册表里看到的就是这份
    expect(declared).toEqual(new TencentRestClient('hk').klineCapabilities())
  })
})

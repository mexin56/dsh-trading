/**
 * 桥 /prediction/fomc 用例：真实 TradingBridge（真实桥逻辑，无 mock 库）。
 *
 * 核心判据（验收要求）：服务缺席时返回 TRADING_NOT_IMPLEMENTED，**绝不是空列表**
 * ——「没装数据源」与「确实没有数据」必须可区分。
 */
import { describe, expect, it } from 'vitest'
import { TradingBridge, createBridgeHost, dispatchBridgeRequest, type PredictionFeedLike } from '../src/bridge.ts'
import type { PredictionFeed } from '@dshtrading/api'

const OCTOBER = {
  id: '606422',
  slug: 'fed-decision-in-october-20260617190323537',
  title: 'Fed Decision in October?',
  endDate: '2026-10-29T03:59:00Z',
  meetingWindow: 'October 27-28, 2026',
  closed: false,
  buckets: [
    { key: 'dec_50plus', label: '50+ bps decrease', changeBps: -50, probability: 0.0015, bestBid: 0.001, bestAsk: 0.002, spread: 0.001, liquidity: 956480.38091, acceptingOrders: true, closed: false },
    { key: 'no_change', label: 'No change', changeBps: 0, probability: 0.835, bestBid: 0.83, bestAsk: 0.84, spread: 0.01, liquidity: 646357.7906, acceptingOrders: true, closed: false },
    { key: 'inc_25', label: '25 bps increase', changeBps: 25, probability: 0.155, bestBid: 0.15, bestAsk: 0.16, spread: 0.01, liquidity: 733805.9941, acceptingOrders: true, closed: false },
  ],
  probabilitySum: 0.9915,
  degraded: [],
} as const

const FEED: PredictionFeed = { fetchedAt: '2026-10-11T01:55:19.000Z', meetings: [OCTOBER] }

function makeBridge(predictionFeed?: PredictionFeedLike): TradingBridge {
  return new TradingBridge(createBridgeHost({ legacy: () => undefined, predictionFeed }))
}

const LIVE: PredictionFeedLike = { listFomcMeetings: async () => FEED }

describe('桥 /prediction/fomc（Polymarket 预测市场接入）', () => {
  it('运营请求预测市场时拿到会议、档位与数据时间戳', async () => {
    // Given 已挂载的预测市场服务
    // When 请求 /prediction/fomc
    const wire = await makeBridge(LIVE).predictionFomc()

    // Then 信封含 fetchedAt 与会议（档位字段原样透传，桥不改口径）
    expect(wire.ok).toBe(true)
    expect(wire.fetchedAt).toBe('2026-10-11T01:55:19.000Z')
    expect(wire.meetings).toEqual([OCTOBER])
  })

  it('运营在未安装预测市场连接器时看到 TRADING_NOT_IMPLEMENTED，而不是一场空会议', async () => {
    // Given 服务缺席（连接器未装/未启用）
    // When / Then 明确报「未实现」，绝不返回空数组冒充无数据
    await expect(makeBridge(undefined).predictionFomc()).rejects.toMatchObject({
      code: 'TRADING_NOT_IMPLEMENTED',
      message: 'prediction feed is not mounted (install/enable the polymarket connector)',
    })
  })

  it('运营看到上游失败时错误原样向上传播（桥不吞成空数据）', async () => {
    // Given 服务内部抛上游错误
    const failing: PredictionFeedLike = {
      listFomcMeetings: async () => {
        throw Object.assign(new Error('polymarket gamma /events: HTTP 403 — error code: 1010'), { code: 'TRADING_UPSTREAM_ERROR' })
      },
    }

    // When / Then 桥不改写成败，交给 HTTP 层按错误词汇下发
    await expect(makeBridge(failing).predictionFomc()).rejects.toMatchObject({ code: 'TRADING_UPSTREAM_ERROR' })
  })

  it('运营经 HTTP 路由 GET /prediction/fomc 拿到同一份形状', async () => {
    // Given 已挂载服务
    // When 走真实分发函数
    const result = await dispatchBridgeRequest(makeBridge(LIVE), 'GET', '/prediction/fomc', new URLSearchParams())

    // Then 200 + 信封
    expect(result.status).toBe(200)
    expect(result.payload).toEqual({ ok: true, fetchedAt: '2026-10-11T01:55:19.000Z', meetings: [OCTOBER] })
  })

  it('运营看到上游确实没有会议时桥如实回空数组（真无数据与未安装可区分）', async () => {
    // Given 服务成功但返回空会议
    const empty: PredictionFeedLike = { listFomcMeetings: async () => ({ fetchedAt: '2026-10-11T01:55:19.000Z', meetings: [] }) }

    // When 请求
    const wire = await makeBridge(empty).predictionFomc()

    // Then ok + 空数组（与上面缺席用例的 TRADING_NOT_IMPLEMENTED 明确不同）
    expect(wire).toEqual({ ok: true, fetchedAt: '2026-10-11T01:55:19.000Z', meetings: [] })
  })
})

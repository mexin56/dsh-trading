/**
 * GUI 实盘提交身份与拒绝回执的用例（user 视角 BDD）。
 *
 * 被测面（对应 QuoteStage.tsx:431/450/468 的真实接线）：
 *   - 提交身份 = 官方当前会话 id + 稳定意图 id（UUID）。未知结果/网络失败重试必须
 *     保持同一意图；参数变化、成功之后、主动新意图才换新（`intentId` 经 api.ts 的
 *     请求体透传给宿主，最终落到 OrderRequest）；
 *   - 会话上下文来自官方 client context（QuotePane 的 `useSessions` → currentSessionId），
 *     拿不到会话时照样把动作送交宿主裁决——权威拒绝只出在宿主，不在客户端伪造；
 *   - 审批拒绝（TRADING_APPROVAL_DENIED）必须原样呈现，绝不显示成成交/模拟回执。
 *
 * 网络边界用真实的全局 fetch 替身（普通 async 函数记录请求体并回放响应），
 * 不引入通用 mock 工具：断言看的是线上真实请求体与渲染结果。
 *
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { MarketLocaleKey } from '../src/client/contract.ts'
import { OrderPanel } from '../src/client/OrderPanel.tsx'
import { placeGuiOrder } from '../src/client/api.ts'
import type { GuiOrderInput, GuiOrderResult } from '../src/client/api.ts'
import {
  GUI_APPROVAL_DENIED,
  createOrderIntentTracker,
  guiOrderFailureText,
  submitGuiOrder,
} from '../src/client/gui-approval.ts'

/** 交易面板当前会话（官方主视图会话 id）。 */
const SESSION = 'session-gui-1'

interface WireCall {
  readonly url: string
  readonly body: Record<string, unknown>
}

/**
 * 全局 fetch 替身：按序回放响应并记录真实请求体（最后一条响应重复使用）。
 * @param replies - 每次调用的响应工厂。
 */
function wireStub(replies: Array<() => Response>): { calls: WireCall[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: WireCall[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const reply = replies[Math.min(calls.length, replies.length - 1)]!
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return reply()
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

function orderReply(id: string): Response {
  return new Response(JSON.stringify({
    ok: true,
    order: {
      id, symbol: 'BTCUSDT-SWAP', side: 'buy', type: 'limit',
      quantity: 0.02, price: 42000, dryRun: false, status: 'new', timestamp: 1,
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function denialReply(): Response {
  return new Response(JSON.stringify({
    ok: false,
    code: GUI_APPROVAL_DENIED,
    message: `${GUI_APPROVAL_DENIED}: no live agent for session ${SESSION}`,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

const LIMIT_ORDER: GuiOrderInput = { symbol: 'BTCUSDT-SWAP', side: 'buy', type: 'limit', quantity: 0.02, price: 42000 }

afterEach(() => { cleanup() })

describe('GUI 实盘提交身份（当前会话 + 稳定意图）', () => {
  it('user retrying a live order after an unknown result keeps the same intent id', async () => {
    // Given: 第一次提交网关故障（结果未知），第二次会成功
    const wire = wireStub([() => new Response('gateway down', { status: 502 }), () => orderReply('ord-1')])
    try {
      const tracker = createOrderIntentTracker()
      // When: 用户用同一笔参数重试
      const first = await submitGuiOrder({ market: 'crypto', input: LIMIT_ORDER, sessionId: SESSION, tracker, place: placeGuiOrder })
      const retry = await submitGuiOrder({ market: 'crypto', input: LIMIT_ORDER, sessionId: SESSION, tracker, place: placeGuiOrder })

      // Then: 两次请求带同一个稳定意图，重试真实落地
      expect(first.order).toBeUndefined()
      expect(retry.order?.id).toBe('ord-1')
      expect(wire.calls[0]!.body.intentId).toMatch(/^[0-9a-f-]{36}$/)
      expect(wire.calls[1]!.body.intentId).toBe(wire.calls[0]!.body.intentId)
    } finally {
      wire.restore()
    }
  })

  it('user changing the order after an unknown result places it under a new intent id', async () => {
    // Given: 第一笔结果未知
    const wire = wireStub([() => new Response('gateway down', { status: 502 }), () => orderReply('ord-2')])
    try {
      const tracker = createOrderIntentTracker()
      await submitGuiOrder({ market: 'crypto', input: LIMIT_ORDER, sessionId: SESSION, tracker, place: placeGuiOrder })

      // When: 用户改数量后重新提交（主动新意图）
      await submitGuiOrder({
        market: 'crypto', input: { ...LIMIT_ORDER, quantity: 0.05 }, sessionId: SESSION, tracker, place: placeGuiOrder,
      })

      // Then: 意图换了，免得把两笔不同动作当成同一笔去重
      expect(wire.calls[1]!.body.intentId).not.toBe(wire.calls[0]!.body.intentId)
    } finally {
      wire.restore()
    }
  })

  it('user submitting another identical order after a success gets a new intent id', async () => {
    // Given: 第一笔已经成功落地
    const wire = wireStub([() => orderReply('ord-3'), () => orderReply('ord-4')])
    try {
      const tracker = createOrderIntentTracker()
      await submitGuiOrder({ market: 'crypto', input: LIMIT_ORDER, sessionId: SESSION, tracker, place: placeGuiOrder })

      // When: 用户再下一笔相同参数的单
      const second = await submitGuiOrder({ market: 'crypto', input: LIMIT_ORDER, sessionId: SESSION, tracker, place: placeGuiOrder })

      // Then: 新意图 + 新订单（成功过的意图不复用）
      expect(second.order?.id).toBe('ord-4')
      expect(wire.calls[1]!.body.intentId).not.toBe(wire.calls[0]!.body.intentId)
    } finally {
      wire.restore()
    }
  })

  it('user live order carries the current session and a stable intent to the host', async () => {
    // Given: 面板拿得到当前会话
    const wire = wireStub([() => orderReply('ord-5')])
    try {
      // When: 用户提交实盘限价单
      await submitGuiOrder({
        market: 'crypto', input: LIMIT_ORDER, sessionId: SESSION, tracker: createOrderIntentTracker(), place: placeGuiOrder,
      })

      // Then: 请求体带会话、稳定意图与实盘标志（默认 dryRun 仍为 false）
      expect(wire.calls).toHaveLength(1)
      expect(wire.calls[0]!.url).toContain('/dshtrading/api/trade/order?market=crypto')
      expect(wire.calls[0]!.body).toMatchObject({
        symbol: 'BTCUSDT-SWAP', side: 'buy', type: 'limit', quantity: 0.02, price: 42000,
        dryRun: false, sessionId: SESSION,
      })
      expect(wire.calls[0]!.body.intentId).toMatch(/^[0-9a-f-]{36}$/)
    } finally {
      wire.restore()
    }
  })

  it('user with no current session still gets the host authoritative denial', async () => {
    // Given: 没有当前会话（首页/无主视图会话），宿主会拒绝
    const wire = wireStub([() => denialReply()])
    try {
      // When: 用户提交实盘单
      const result = await submitGuiOrder({
        market: 'crypto', input: LIMIT_ORDER, sessionId: undefined, tracker: createOrderIntentTracker(), place: placeGuiOrder,
      })

      // Then: 动作照旧送交宿主（客户端不自行放行/不放行），并原样带回拒绝码
      expect(wire.calls).toHaveLength(1)
      expect(wire.calls[0]!.body.sessionId).toBe('')
      expect(result.order).toBeUndefined()
      expect(result.code).toBe(GUI_APPROVAL_DENIED)
    } finally {
      wire.restore()
    }
  })

  it('user rejected by the approval gate sees the pinned denial code instead of a generic failure', () => {
    // Given: 宿主拒绝回执（审批没成）
    const denial: GuiOrderResult = {
      error: `${GUI_APPROVAL_DENIED}: user rejected the approval`,
      code: GUI_APPROVAL_DENIED,
    }

    // When: 渲染失败回执文案
    const text = guiOrderFailureText('提交失败', denial)
    const retried = guiOrderFailureText('提交失败', { error: 'network unreachable' })

    // Then: 带码的结果以码开头（一眼可辨是审批拒绝），无码的仍是通用失败文案
    expect(text).toBe(`${GUI_APPROVAL_DENIED}: user rejected the approval`)
    expect(retried).toBe('提交失败: network unreachable')
  })

  it('user sees the approval denial in the order panel and no simulated receipt', async () => {
    // Given: 下单面板接一个审批被拒的提交通道
    const t = (key: MarketLocaleKey): string => key
    const view = render(
      <OrderPanel
        t={t}
        symbol="BTCUSDT-SWAP"
        market="crypto"
        colorMode="red-up"
        onSubmit={async (): Promise<GuiOrderResult> => ({
          error: `${GUI_APPROVAL_DENIED}: user rejected the approval`,
          code: GUI_APPROVAL_DENIED,
        })}
      />,
    )

    // When: 用户填数量并点买入
    fireEvent.change(view.container.querySelector('#order-panel-quantity')!, { target: { value: '0.02' } })
    fireEvent.click(view.getByRole('button', { name: /trade\.buy/ }))

    // Then: 回执以拒绝码开头（不是笼统的「提交失败」），且没有任何成交/模拟回执
    await waitFor(() => { expect(view.container.querySelector('[data-state="error"]')).not.toBeNull() })
    const receipt = view.container.querySelector('[data-state="error"]')!
    expect(receipt.textContent).toBe(`${GUI_APPROVAL_DENIED}: user rejected the approval`)
    expect(view.container.querySelector('[data-state="success"]')).toBeNull()
  })
})

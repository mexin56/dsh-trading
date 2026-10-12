/**
 * MiniQMT 本地 HTTP 网关的**契约化假网关**（可复用夹具）。
 *
 * 契约依据：本仓 connector-qmt/src/rest.ts 与仓库自身的网关契约说明
 * （.agents/notes/implemented/feature/2026-08-31-real-trading-suite-and-cn-fix.md：
 * `POST /api/v1/trade/order` 收 `{account_id, stock_code, order_type, order_side, price, order_volume}`，
 * 回 `{code, message, data:{order_id, status}}`；`code !== 0` 即失败）。
 * 该网关契约不在本仓、也不是官方契约，因此本连接器**不发 venue client key**
 * （不加网关没承诺过的键），幂等完全靠本地台账。
 */
export type FakeQmtOutcome = 'ack' | 'lost-response' | 'no-id' | 'rejected'

export interface FakeQmtVenue {
  readonly fetchImpl: typeof fetch
  orders(): readonly Record<string, unknown>[]
  requests(): readonly Record<string, unknown>[]
  setOutcome(outcome: FakeQmtOutcome): void
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function fakeQmtVenue(options: { outcome?: FakeQmtOutcome } = {}): FakeQmtVenue {
  const orders: Record<string, unknown>[] = []
  const requests: Record<string, unknown>[] = []
  let outcome: FakeQmtOutcome = options.outcome ?? 'ack'

  const fetchImpl = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    if (url.includes('/api/v1/trade/order')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      requests.push(body)
      if (outcome === 'rejected') return jsonResponse({ code: -1, message: '资金不足' })
      const orderId = `qmt-venue-${orders.length + 1}`
      orders.push({ order_id: orderId, stock_code: body.stock_code, order_volume: body.order_volume })
      if (outcome === 'lost-response') throw new Error('fake QMT gateway: connection reset after the order was accepted')
      if (outcome === 'no-id') return jsonResponse({ code: 0, data: { status: 'SUBMITTED' } })
      return jsonResponse({ code: 0, data: { order_id: orderId, status: 'SUBMITTED' } })
    }
    throw new Error(`fake QMT gateway: unexpected request ${url}`)
  }) as unknown as typeof fetch

  return { fetchImpl, orders: () => orders, requests: () => requests, setOutcome: (next) => { outcome = next } }
}

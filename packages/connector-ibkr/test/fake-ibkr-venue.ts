/**
 * IBKR Client Portal Web API 的**契约化假网关**（可复用夹具）。
 *
 * 契约依据：
 *   - IBKR Web API「Place Order」：`POST /iserver/account/{accountId}/orders`，
 *     请求体 `{orders:[{acctId, conid|ticker, secType, orderType, side, quantity, price, tif, cOID?}]}`（JSON 数组），
 *     回执数组含 `order_id`；若出现 `id`（无 order_id）表示 Pre-order Warning，
 *     需 `POST /iserver/reply/{replyId}` 确认（本仓 rest.ts 的既有流程）。
 *   - `cOID`（Customer Order ID）：官方文档写明是任意字符串、**24 小时内唯一**。
 */
export type FakeIbkrOutcome = 'ack' | 'lost-response' | 'no-id' | 'rejected'

export interface FakeIbkrVenue {
  readonly fetchImpl: typeof fetch
  orders(): readonly Record<string, unknown>[]
  requests(): readonly Record<string, unknown>[]
  setOutcome(outcome: FakeIbkrOutcome): void
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function fakeIbkrVenue(options: { outcome?: FakeIbkrOutcome } = {}): FakeIbkrVenue {
  const orders: Record<string, unknown>[] = []
  const requests: Record<string, unknown>[] = []
  let outcome: FakeIbkrOutcome = options.outcome ?? 'ack'

  const fetchImpl = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    if (url.includes('/orders') && (init?.method ?? 'GET') === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { orders?: Record<string, unknown>[] }
      const ticket = body.orders?.[0] ?? {}
      requests.push(ticket)
      if (outcome === 'rejected') return jsonResponse([{ error: 'insufficient funds' }], 400)
      const orderId = `ibkr-venue-${orders.length + 1}`
      orders.push({ order_id: orderId, cOID: ticket.cOID, ticker: ticket.ticker, quantity: ticket.quantity })
      if (outcome === 'lost-response') throw new Error('fake IBKR gateway: connection reset after the order was accepted')
      if (outcome === 'no-id') return jsonResponse([{ order_status: 'Submitted' }])
      return jsonResponse([{ order_id: orderId, order_status: 'Submitted' }])
    }
    throw new Error(`fake IBKR gateway: unexpected request ${url}`)
  }) as unknown as typeof fetch

  return { fetchImpl, orders: () => orders, requests: () => requests, setOutcome: (next) => { outcome = next } }
}

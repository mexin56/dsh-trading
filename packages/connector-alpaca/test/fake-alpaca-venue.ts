/**
 * Alpaca 交易面的**契约化假交易所**（可复用夹具；按官方契约应答并记账建了几笔单）。
 *
 * 契约依据：
 *   - Alpaca Trading API `POST /v2/orders`：请求体 `{symbol, qty, side, type, time_in_force, limit_price?, client_order_id?}`；
 *     回执含 `id`（Alpaca 生成的订单 id）与 `status`（alpaca-docs 仓 orders.md 的 Order Entity）。
 *   - `client_order_id`：官方 OpenAPI 注明 maxLength 48、不传则自动生成；
 *     重复 id 只在订单**仍活跃**时被拒（422），终态后可复用 ⇒ 非跨时间 exactly-once。
 */
export type FakeAlpacaOutcome = 'ack' | 'lost-response' | 'no-id' | 'rejected'

export interface FakeAlpacaVenue {
  readonly fetchImpl: typeof fetch
  /** venue 侧已创建的订单（按受理顺序）。 */
  orders(): readonly Record<string, unknown>[]
  /** 到达 POST /v2/orders 的请求体。 */
  requests(): readonly Record<string, unknown>[]
  setOutcome(outcome: FakeAlpacaOutcome): void
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function fakeAlpacaVenue(options: { outcome?: FakeAlpacaOutcome } = {}): FakeAlpacaVenue {
  const orders: Record<string, unknown>[] = []
  const requests: Record<string, unknown>[] = []
  let outcome: FakeAlpacaOutcome = options.outcome ?? 'ack'

  const fetchImpl = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.endsWith('/orders') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      requests.push(body)
      if (outcome === 'rejected') {
        return jsonResponse({ code: 40310000, message: 'insufficient buying power' }, 403)
      }
      const id = `alpaca-venue-${orders.length + 1}`
      orders.push({ id, symbol: body.symbol, qty: body.qty, client_order_id: body.client_order_id })
      if (outcome === 'lost-response') throw new Error('fake Alpaca venue: connection reset after the order was accepted')
      if (outcome === 'no-id') return jsonResponse({ status: 'accepted' })
      return jsonResponse({ id, client_order_id: body.client_order_id, symbol: body.symbol, qty: body.qty, side: body.side, type: body.type, status: 'accepted' })
    }
    throw new Error(`fake Alpaca venue: unexpected request ${method} ${url}`)
  }) as unknown as typeof fetch

  return { fetchImpl, orders: () => orders, requests: () => requests, setOutcome: (next) => { outcome = next } }
}

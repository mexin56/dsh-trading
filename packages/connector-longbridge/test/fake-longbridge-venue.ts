/**
 * Longbridge OpenAPI 的**契约化假网关**（可复用夹具）。
 *
 * 契约依据：本仓 connector-longbridge/src/rest.ts 按 LongPort 官方规范签名并请求
 * `POST {baseUrl}/v1/trade/order`，请求体字段名取自官方
 * （`symbol / order_type / side / submitted_quantity / submitted_price / time_in_force / remark`，
 * open.longbridge.com「Submit Order」），回执 `{code, message, data:{order_id}}`（`code !== 0` 即失败）。
 * `remark` 只作对账标签：官方不承诺按它去重。
 */
export type FakeLongbridgeOutcome = 'ack' | 'lost-response' | 'no-id' | 'rejected'

export interface FakeLongbridgeVenue {
  readonly fetchImpl: typeof fetch
  orders(): readonly Record<string, unknown>[]
  requests(): readonly Record<string, unknown>[]
  setOutcome(outcome: FakeLongbridgeOutcome): void
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function fakeLongbridgeVenue(options: { outcome?: FakeLongbridgeOutcome } = {}): FakeLongbridgeVenue {
  const orders: Record<string, unknown>[] = []
  const requests: Record<string, unknown>[] = []
  let outcome: FakeLongbridgeOutcome = options.outcome ?? 'ack'

  const fetchImpl = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    if (url.includes('/v1/trade/order') && (init?.method ?? 'GET') === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      requests.push(body)
      if (outcome === 'rejected') return jsonResponse({ code: 3, message: 'insufficient funds' })
      const orderId = `lb-venue-${orders.length + 1}`
      orders.push({ order_id: orderId, symbol: body.symbol, remark: body.remark })
      if (outcome === 'lost-response') throw new Error('fake Longbridge gateway: connection reset after the order was accepted')
      if (outcome === 'no-id') return jsonResponse({ code: 0, data: {} })
      return jsonResponse({ code: 0, data: { order_id: orderId } })
    }
    throw new Error(`fake Longbridge gateway: unexpected request ${url}`)
  }) as unknown as typeof fetch

  return { fetchImpl, orders: () => orders, requests: () => requests, setOutcome: (next) => { outcome = next } }
}

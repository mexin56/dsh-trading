/**
 * Futu 交易面的**契约化假网关**（可复用夹具）。
 *
 * 契约依据（本仓真实往返证据，不是猜的）：
 *   - 桥契约 `scripts/futu-openapi-bridge.py` 头注：`POST /api/trd/place-order`
 *     收 `{security, trdSide(1买2卖), orderType(1限价2市价), qty, price, trdEnv, accId?, remark?}`，
 *     回 `{orderId, code}`（`remark` 原样透传给 OpenD 的 `place_order(remark=...)`）。
 *   - `spikes/impl-futu-bridge/trd-place-order.json`：真实往返
 *     `{retType:0, data:{orderId:'9769893', code:'HK.00700'}}`（请求里带 remark 锚）。
 *   - Futu 官方 place_order 签名含 `remark`（openapi.futunn.com），但**官方不承诺按 remark 去重**。
 */
export type FakeFutuOutcome = 'ack' | 'lost-response' | 'no-id' | 'rejected'

export interface FakeFutuVenue {
  readonly fetchImpl: typeof fetch
  orders(): readonly Record<string, unknown>[]
  requests(): readonly Record<string, unknown>[]
  setOutcome(outcome: FakeFutuOutcome): void
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function fakeFutuVenue(options: { outcome?: FakeFutuOutcome } = {}): FakeFutuVenue {
  const orders: Record<string, unknown>[] = []
  const requests: Record<string, unknown>[] = []
  let outcome: FakeFutuOutcome = options.outcome ?? 'ack'

  const fetchImpl = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    if (url.includes('/api/trd/place-order')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      requests.push(body)
      if (outcome === 'rejected') return jsonResponse({ retType: -1, retMsg: '下单被 OpenD 拒绝' })
      const orderId = `futu-venue-${orders.length + 1}`
      orders.push({ orderId, code: body.security, remark: body.remark, qty: body.qty })
      if (outcome === 'lost-response') throw new Error('fake Futu bridge: connection reset after the order was accepted')
      if (outcome === 'no-id') return jsonResponse({ retType: 0, data: { code: body.security } })
      return jsonResponse({ retType: 0, retMsg: '', data: { orderId, code: body.security } })
    }
    throw new Error(`fake Futu bridge: unexpected request ${url}`)
  }) as unknown as typeof fetch

  return { fetchImpl, orders: () => orders, requests: () => requests, setOutcome: (next) => { outcome = next } }
}

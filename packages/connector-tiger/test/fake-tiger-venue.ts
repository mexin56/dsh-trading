/**
 * Tiger OpenAPI 网关的**契约化假网关**（可复用夹具）。
 *
 * 契约依据：本仓 connector-tiger/src/rest.ts 的 `requestJson`——POST 到
 * `https://openapi.itiger.com/gateway`（可被 TIGER_API_URL 覆盖），表单参数
 * `{tiger_id, method, charset, sign_type:'RSA2', timestamp, version, biz_content(JSON 串), sign}`，
 * 回执 `{code, message, data}`（`code !== 0` 即失败）。
 * 本连接器**不发 venue client key**（官方 `user_mark` 的键名尚未与官方 biz-content 逐字对齐，
 * 按「不猜字段」纪律不加），因此这个假网关只记账 method 与业务内容。
 */
export type FakeTigerOutcome = 'ack' | 'lost-response' | 'no-id' | 'rejected'

export interface FakeTigerVenue {
  readonly fetchImpl: typeof fetch
  orders(): readonly Record<string, unknown>[]
  requests(): readonly Record<string, unknown>[]
  setOutcome(outcome: FakeTigerOutcome): void
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function fakeTigerVenue(options: { outcome?: FakeTigerOutcome } = {}): FakeTigerVenue {
  const orders: Record<string, unknown>[] = []
  const requests: Record<string, unknown>[] = []
  let outcome: FakeTigerOutcome = options.outcome ?? 'ack'

  const fetchImpl = (async (_input: unknown, init?: { method?: string; body?: string }) => {
    const params = JSON.parse(String(init?.body ?? '{}')) as { method?: string; biz_content?: string }
    if (params.method !== 'trade_order') {
      throw new Error(`fake Tiger gateway: unexpected method ${String(params.method)}`)
    }
    const biz = JSON.parse(String(params.biz_content ?? '{}')) as Record<string, unknown>
    requests.push(biz)
    if (outcome === 'rejected') return jsonResponse({ code: 1200, message: 'insufficient funds' })
    const id = `tiger-venue-${orders.length + 1}`
    orders.push({ id, symbol: biz.symbol, totalQuantity: biz.totalQuantity })
    if (outcome === 'lost-response') throw new Error('fake Tiger gateway: connection reset after the order was accepted')
    if (outcome === 'no-id') return jsonResponse({ code: 0, data: { status: 'NEW' } })
    return jsonResponse({ code: 0, data: { id, status: 'NEW' } })
  }) as unknown as typeof fetch

  return { fetchImpl, orders: () => orders, requests: () => requests, setOutcome: (next) => { outcome = next } }
}

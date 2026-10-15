/**
 * IBKR Client Portal Web API 的**契约化假网关**（可复用夹具）。
 *
 * 契约依据：
 *   - IBKR Web API「Market Data Snapshot」：`GET /iserver/marketdata/snapshot?symbols=…&fields=31,84,86`，
 *     回包是数组，`31` 为最新价字段（`84`/`86` 为其它字段）。
 *   - IBKR Web API「Historical Market Data」：`GET /hmds/history?symbol=…&period=…&bar=…`，
 *     回包 `{data:[{t,o,c,h,l,v}]}`。
 *   - IBKR Web API「Place Order」：`POST /iserver/account/{accountId}/orders`，
 *     请求体 `{orders:[{acctId, conid|ticker, secType, orderType, side, quantity, price, tif, cOID?}]}`（JSON 数组），
 *     回执数组含 `order_id`；若出现 `id`（无 order_id）表示 Pre-order Warning，
 *     需 `POST /iserver/reply/{replyId}` 确认（本仓 rest.ts 的既有流程）。
 *   - `cOID`（Customer Order ID）：官方文档写明是任意字符串、**24 小时内唯一**。
 *
 * 本夹具**只服务本机网关地址** `FAKE_IBKR_GATEWAY_URL`：任何其它地址（例如公共行情源）都被拒绝，
 * 并被逐条记进 `urls()` —— 用例据此断言「零跨源出网」（见 market-data-fail-closed.test.ts）。
 */
export type FakeIbkrOutcome =
  | 'ack'
  | 'lost-response'
  | 'no-id'
  | 'rejected'
  | 'outage'
  | 'http-error'
  | 'empty-snapshot'
  | 'no-price'
  | 'zero-price'
  | 'empty-history'
  | 'bad-history'

export const FAKE_IBKR_GATEWAY_URL = 'https://ibkr.test/v1/api'

export interface FakeIbkrVenue {
  readonly fetchImpl: typeof fetch
  orders(): readonly Record<string, unknown>[]
  requests(): readonly Record<string, unknown>[]
  /** 本夹具收到过的每一个 URL（含被拒绝的跨源请求），按到达顺序。 */
  urls(): readonly string[]
  setOutcome(outcome: FakeIbkrOutcome): void
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 快照回包：正常价、空数组、`31` 非数值、`31` 为 0 各一种（由 outcome 选择）。 */
function snapshotBody(outcome: FakeIbkrOutcome): unknown {
  if (outcome === 'empty-snapshot') return []
  if (outcome === 'no-price') return [{ conid: 265598, '31': 'n/a', '84': 'n/a', '86': 'n/a' }]
  if (outcome === 'zero-price') return [{ conid: 265598, '31': '0', '84': '0', '86': '0' }]
  return [{ conid: 265598, '31': '190.25', '84': '189.10', '86': '1.0' }]
}

/** 历史回包：两根日线；期望值由 market-data-fail-closed.test.ts 独立写成字面量逐字段核对。 */
const HISTORY_BARS = [
  { t: 1735689600000, o: 190.1, c: 191.2, h: 191.9, l: 189.5, v: 1200000 },
  { t: 1735776000000, o: 191.2, c: 190.4, h: 192.0, l: 190.0, v: 980000 },
] as const

export function fakeIbkrVenue(options: { outcome?: FakeIbkrOutcome } = {}): FakeIbkrVenue {
  const orders: Record<string, unknown>[] = []
  const requests: Record<string, unknown>[] = []
  const urls: string[] = []
  let outcome: FakeIbkrOutcome = options.outcome ?? 'ack'

  const fetchImpl = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    // 先记后判：跨源请求也要留痕，否则测试断言不到「零跨源出网」。
    urls.push(url)
    if (!url.startsWith(`${FAKE_IBKR_GATEWAY_URL}/`)) {
      throw new Error(`fake IBKR gateway: unexpected request ${url} (this venue only serves ${FAKE_IBKR_GATEWAY_URL})`)
    }
    if (outcome === 'outage') throw new Error('fake IBKR gateway: gateway unreachable (connection refused)')
    if (outcome === 'http-error') return jsonResponse({ error: 'gateway internal failure' }, 500)

    const method = init?.method ?? 'GET'
    const path = url.slice(FAKE_IBKR_GATEWAY_URL.length)

    if (path.startsWith('/iserver/marketdata/snapshot') && method === 'GET') {
      return jsonResponse(snapshotBody(outcome))
    }

    if (path.startsWith('/hmds/history') && method === 'GET') {
      if (outcome === 'empty-history') return jsonResponse({ data: [] })
      if (outcome === 'bad-history') return jsonResponse({ data: null })
      return jsonResponse({ data: HISTORY_BARS.map((bar) => ({ ...bar })) })
    }

    if (path.includes('/orders') && method === 'POST') {
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

  return {
    fetchImpl,
    orders: () => orders,
    requests: () => requests,
    urls: () => urls,
    setOutcome: (next) => { outcome = next },
  }
}

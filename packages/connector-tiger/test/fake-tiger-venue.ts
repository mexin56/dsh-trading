/**
 * Tiger OpenAPI 网关的**契约化假网关**（可复用夹具）。
 *
 * 契约依据：本仓 connector-tiger/src/rest.ts 的 `requestJson`——POST 到
 * `https://openapi.itiger.com/gateway`（可被 TIGER_API_URL 覆盖），表单参数
 * `{tiger_id, method, charset, sign_type:'RSA2', timestamp, version, biz_content(JSON 串), sign}`，
 * 回执 `{code, message, data}`（`code !== 0` 即失败）。
 * 本连接器**不发 venue client key**（官方 `user_mark` 的键名尚未与官方 biz-content 逐字对齐，
 * 按「不猜字段」纪律不加），因此这个假网关只记账 method 与业务内容。
 *
 * 覆盖面：交易 `trade_order` 与行情 `quote_real_time` / `kline_quote`。交易面的
 * `orders()` / `requests()` / `setOutcome()` 语义与既有用例（test/order-intent.test.ts）共用，
 * 不得改形状。行情面回夹具自带样本值（`FAKE_TIGER_TICKER` / `FAKE_TIGER_KLINES`），
 * 用例按字段逐个比对——改这里的样本就得改期望值。
 * `httpCalls()` 记录每次请求的 method 与 URL，且注入的 fetchImpl 见到非
 * `FAKE_TIGER_BASE_URL` 的地址一律抛错：任何跨源出网（例如曾经的腾讯公开端点回落）
 * 都会留下痕迹并用例直接失败。
 */
export type FakeTigerOutcome =
  | 'ack'
  | 'lost-response'
  | 'no-id'
  | 'rejected'
  /** 网关不可达：fetch 直接抛错（连接层失败，请求没有到达网关）。 */
  | 'outage'
  /** HTTP 500：响应非 2xx。 */
  | 'http-error'
  /** 业务码非 0：HTTP 200，但回执 `{code: 1200, message}`。 */
  | 'biz-error'
  /** `code: 0` 但 `data` 是空数组（行情面：无报价行 / 明确的空序列）。 */
  | 'empty'
  /** `code: 0` 但回包形状不可识别（行情面：`data: [{}]`，没有 items/报价字段）。 */
  | 'malformed'

/** 假网关唯一认可的基地址：其它地址（跨源回落目标）一律被拒。 */
export const FAKE_TIGER_BASE_URL = 'https://tiger.test/gateway'

/** 行情夹具的固定报价行（字段名取自 src/rest.ts 的 `quote_real_time` 映射）。 */
export const FAKE_TIGER_TICKER = { latestPrice: 406.8, volume: 1234500, timestamp: 1759276800000 } as const

/** 行情夹具的固定 K 线序列（字段名取自 src/rest.ts 的 `kline_quote` 映射）。 */
export const FAKE_TIGER_KLINES = [
  { time: 1759190400000, open: 400.2, high: 410.6, low: 398.8, close: 406.8, volume: 1234500 },
  { time: 1759276800000, open: 406.8, high: 412.4, low: 405.1, close: 409.2, volume: 987654 },
] as const

/** 每次出网的记录：method 取自表单参数，URL 是 fetchImpl 收到的地址。 */
export interface FakeTigerHttpCall {
  readonly method: string
  readonly url: string
}

export interface FakeTigerVenue {
  readonly fetchImpl: typeof fetch
  orders(): readonly Record<string, unknown>[]
  requests(): readonly Record<string, unknown>[]
  httpCalls(): readonly FakeTigerHttpCall[]
  setOutcome(outcome: FakeTigerOutcome): void
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function firstSymbol(biz: Record<string, unknown>): string {
  const symbols = Array.isArray(biz.symbols) ? biz.symbols : []
  return typeof symbols[0] === 'string' ? symbols[0] : ''
}

export function fakeTigerVenue(options: { outcome?: FakeTigerOutcome } = {}): FakeTigerVenue {
  const orders: Record<string, unknown>[] = []
  const requests: Record<string, unknown>[] = []
  const httpCalls: FakeTigerHttpCall[] = []
  let outcome: FakeTigerOutcome = options.outcome ?? 'ack'

  const fetchImpl = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const params = JSON.parse(String(init?.body ?? '{}')) as { method?: string; biz_content?: string }
    const url = String(input)
    // 先记账再校验基地址：非老虎端点的出网必须留下痕迹（用例据此断言零跨源出网）。
    httpCalls.push({ method: typeof params.method === 'string' ? params.method : '', url })
    if (url !== FAKE_TIGER_BASE_URL) {
      throw new Error(`fake Tiger gateway: refusing non-test base URL ${url}`)
    }
    if (outcome === 'outage') throw new Error('fake Tiger gateway: connection refused')
    const biz = JSON.parse(String(params.biz_content ?? '{}')) as Record<string, unknown>
    requests.push(biz)
    if (outcome === 'http-error') return jsonResponse({ code: 500, message: 'internal error' }, 500)
    if (outcome === 'biz-error') return jsonResponse({ code: 1200, message: 'invalid parameter' })

    if (params.method === 'trade_order') {
      if (outcome === 'rejected') return jsonResponse({ code: 1200, message: 'insufficient funds' })
      const id = `tiger-venue-${orders.length + 1}`
      orders.push({ id, symbol: biz.symbol, totalQuantity: biz.totalQuantity })
      if (outcome === 'lost-response') throw new Error('fake Tiger gateway: connection reset after the order was accepted')
      if (outcome === 'no-id') return jsonResponse({ code: 0, data: { status: 'NEW' } })
      return jsonResponse({ code: 0, data: { id, status: 'NEW' } })
    }

    if (params.method === 'quote_real_time') {
      if (outcome === 'empty') return jsonResponse({ code: 0, data: [] })
      if (outcome === 'malformed') return jsonResponse({ code: 0, data: [{}] })
      return jsonResponse({ code: 0, data: [{ symbol: firstSymbol(biz), ...FAKE_TIGER_TICKER }] })
    }

    if (params.method === 'kline_quote') {
      if (outcome === 'empty') return jsonResponse({ code: 0, data: [] })
      if (outcome === 'malformed') return jsonResponse({ code: 0, data: [{}] })
      const items = FAKE_TIGER_KLINES.map((bar) => ({ ...bar }))
      return jsonResponse({ code: 0, data: [{ symbol: firstSymbol(biz), items }] })
    }

    throw new Error(`fake Tiger gateway: unexpected method ${String(params.method)}`)
  }) as unknown as typeof fetch

  return {
    fetchImpl,
    orders: () => orders,
    requests: () => requests,
    httpCalls: () => httpCalls,
    setOutcome: (next) => { outcome = next },
  }
}

/**
 * OKX 交易面的**契约化假交易所**（可复用夹具；不是通用 mock——它按 OKX 官方契约应答，
 * 并像真交易所一样记账「我到底建了几笔单」）。
 *
 * 契约依据：
 *   - okx.com/docs-v5「Place order」：POST /api/v5/trade/order 成功信封
 *     `{code:'0', data:[{ordId, clOrdId, sCode, sMsg}]}`；**业务拒绝也是 HTTP 200**，
 *     靠 `data[0].sCode !== '0'` 表达（connector-okx/src/rest.ts 的 processEnvelope 同款判据）。
 *   - clOrdId：官方「case-sensitive alphanumerics ... up to 32 characters」，
 *     且在**未成交挂单**之间唯一（成交/撤销后释放 ⇒ 不是跨时间 exactly-once）。
 *   - spikes/impl-okx/r5-order-loop-result.json：真实 demo 盘下单回执
 *     `{httpStatus:200, code:'0', sCode:'0', sMsg:'Order placed', ordId:'3875693089022251008'}`。
 *
 * 用例判据是「venue 侧有几笔外部订单 / 收到哪些请求」，而不是「某个函数被调用过」。
 */

/** 假交易所的应答模式。 */
export type FakeOkxOutcome =
  /** 正常受理：建单 + 回带真实 ordId。 */
  | 'ack'
  /** venue **已经建单**，但客户端拿不到响应（连接断开/超时）——「已创建但响应失败」。 */
  | 'lost-response'
  /** 业务拒绝（sCode 51008 余额不足）：请求没有进撮合，venue 侧不建单。 */
  | 'rejected'
  /** 受理了但回执里没有可用 orderId：客户端拿不到 venue 句柄（不算成功）。 */
  | 'no-ordId'

/** 现货规格（真实 OKX /public/instruments 的字段形状，量纲照搬）。 */
export const FAKE_OKX_SPOT_INSTRUMENT = {
  instId: 'BTC-USDT',
  instType: 'SPOT',
  lotSz: '0.00000001',
  minSz: '0.00001',
  tickSz: '0.1',
  baseCcy: 'BTC',
  quoteCcy: 'USDT',
}

export interface FakeOkxVenue {
  readonly fetchImpl: typeof fetch
  /** venue 侧已创建的外部订单（按受理顺序；重复下单会让它变长）。 */
  orders(): readonly Record<string, unknown>[]
  /** 到达 POST /api/v5/trade/order 的请求体（按到达顺序）。 */
  requests(): readonly Record<string, unknown>[]
  /** 切换后续请求的应答模式。 */
  setOutcome(outcome: FakeOkxOutcome): void
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function fakeOkxVenue(options: { outcome?: FakeOkxOutcome } = {}): FakeOkxVenue {
  const orders: Record<string, unknown>[] = []
  const requests: Record<string, unknown>[] = []
  let outcome: FakeOkxOutcome = options.outcome ?? 'ack'

  const fetchImpl = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.includes('/api/v5/public/instruments')) {
      return jsonResponse({ code: '0', data: [FAKE_OKX_SPOT_INSTRUMENT] })
    }
    if (url.includes('/api/v5/trade/order') && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      requests.push(body)
      if (outcome === 'rejected') {
        // 业务拒绝：HTTP 200 + sCode != 0；订单没有进撮合。
        return jsonResponse({ code: '1', msg: '', data: [{ sCode: '51008', sMsg: 'Insufficient funds' }] })
      }
      // 其余模式都代表「请求已被受理」⇒ venue 侧真的多了一笔外部订单。
      // lost-response / no-ordId 刻意保留这一笔：客户端看不到回执 ≠ venue 没有建单。
      const ordId = `okx-venue-${orders.length + 1}`
      orders.push({ ordId, clOrdId: body.clOrdId, instId: body.instId, sz: body.sz, tdMode: body.tdMode })
      if (outcome === 'lost-response') throw new Error('fake OKX venue: connection reset after the order was accepted')
      if (outcome === 'no-ordId') return jsonResponse({ code: '0', data: [{ ordId: '', sCode: '0', sMsg: 'Order placed' }] })
      return jsonResponse({ code: '0', data: [{ ordId, clOrdId: body.clOrdId, sCode: '0', sMsg: 'Order placed' }] })
    }
    throw new Error(`fake OKX venue: unexpected request ${method} ${url}`)
  }) as unknown as typeof fetch

  return {
    fetchImpl,
    orders: () => orders,
    requests: () => requests,
    setOutcome: (next) => { outcome = next },
  }
}

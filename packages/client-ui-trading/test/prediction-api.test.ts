/**
 * client 取数层用例：**真实本地 HTTP 上游**（node:http）+ 真实 fetch 语义。
 *
 * 与 macro 两个 fetcher（失败回 null）不同，预测市场用显式错误状态：
 * 「连接器没装」（TRADING_NOT_IMPLEMENTED）、「上游失败」与「真的没有会议」
 * 是三种不同事实，面板要分别提示——这三条各有一个用例钉住。
 */
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fetchPredictionFomc } from '../src/client/api.ts'

let server: Server
let baseUrl = ''

/** 桥的响应信封：与真实 /dshtrading/api/prediction/fomc 同形状。 */
const OCTOBER = {
  id: '606422',
  slug: 'fed-decision-in-october-20260617190323537',
  title: 'Fed Decision in October?',
  endDate: '2026-10-29T03:59:00Z',
  meetingWindow: 'October 27-28, 2026',
  closed: false,
  buckets: [
    { key: 'no_change', label: 'No change', changeBps: 0, probability: 0.835, bestBid: 0.83, bestAsk: 0.84, spread: 0.01, liquidity: 646357.7906, acceptingOrders: true, closed: false },
  ],
  probabilitySum: 0.9985,
  degraded: [],
}

beforeEach(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url?.includes('unavailable')) {
      res.statusCode = 200
      res.end(JSON.stringify({ ok: false, code: 'TRADING_NOT_IMPLEMENTED', message: 'prediction feed is not mounted (install/enable the polymarket connector)' }))
      return
    }
    if (req.url?.includes('upstream')) {
      res.statusCode = 200
      res.end(JSON.stringify({ ok: false, code: 'TRADING_UPSTREAM_ERROR', message: 'polymarket gamma /events: HTTP 403 — error code: 1010' }))
      return
    }
    if (req.url?.includes('notfound')) {
      res.statusCode = 404
      res.end('404 page not found')
      return
    }
    res.statusCode = 200
    res.end(JSON.stringify({ ok: true, fetchedAt: '2026-10-11T01:55:19.000Z', meetings: req.url?.includes('empty') ? [] : [OCTOBER] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/**
 * 真实 fetch 的引用（在替换 globalThis.fetch 之前抓住）——否则 routedFetch
 * 会调用它自己，栈溢出。
 */
const realFetch = globalThis.fetch

/** 把 fetch 指向真实本地服务器（真实 HTTP 往返，不是 mock 库）。 */
function routedFetch(path: string): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input).replace('/dshtrading/api', '') || '/'
    return realFetch(baseUrl + (target.startsWith('/') ? target : `/${target}`) + path, init)
  }) as typeof globalThis.fetch
}

async function withRouting<T>(path: string, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = routedFetch(path)
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

describe('fetchPredictionFomc（客户端取数层）', () => {
  it('运营拿到会议与档位时请求成功且数据时间戳来自服务端', async () => {
    // Given 桥正常回一场会议
    // When 取数
    const result = await withRouting('', () => fetchPredictionFomc())

    // Then ok 状态、fetchedAt 来自响应、档位字段完整
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('unreachable')
    expect(result.fetchedAt).toBe('2026-10-11T01:55:19.000Z')
    expect(result.meetings[0]?.buckets[0]).toMatchObject({ key: 'no_change', probability: 0.835, liquidity: 646357.7906 })
  })

  it('运营在未安装连接器时看到 TRADING_NOT_IMPLEMENTED 错误状态，而不是空列表', async () => {
    // Given 桥报服务缺席
    // When 取数
    const result = await withRouting('/unavailable', () => fetchPredictionFomc())

    // Then 明确错误状态 + 可读原因（面板据此提示「未安装数据源」）；
    // 消息沿用 loadJson 既有惯例（`<code>: <message>`），code 另在字段上
    expect(result).toEqual({
      status: 'error',
      code: 'TRADING_NOT_IMPLEMENTED',
      message: 'TRADING_NOT_IMPLEMENTED: prediction feed is not mounted (install/enable the polymarket connector)',
    })
  })

  it('运营在上游失败时看到错误状态与上游错误码', async () => {
    // Given 桥报上游 403
    // When 取数
    const result = await withRouting('/upstream', () => fetchPredictionFomc())

    // Then 错误状态保留 code 与原始消息（消息带既有 `<code>:` 前缀惯例）
    expect(result).toEqual({
      status: 'error',
      code: 'TRADING_UPSTREAM_ERROR',
      message: 'TRADING_UPSTREAM_ERROR: polymarket gamma /events: HTTP 403 — error code: 1010',
    })
  })

  it('运营在路由不存在（404）时看到错误状态而不是空数据', async () => {
    // Given 桥返回 404
    // When 取数
    const result = await withRouting('/notfound', () => fetchPredictionFomc())

    // Then 错误状态（不是 ok + 空数组）
    expect(result.status).toBe('error')
    if (result.status !== 'error') throw new Error('unreachable')
    expect(result.code).toBe('TRADING_PROTOCOL')
    expect(result.message).toContain('404')
  })

  it('运营看到上游真的没有会议时是 ok 状态配空数组（合法的空态）', async () => {
    // Given 桥成功但会议为空
    // When 取数
    const result = await withRouting('/empty', () => fetchPredictionFomc())

    // Then ok + 空数组（与上面三种失败明确可区分）
    expect(result).toEqual({ status: 'ok', fetchedAt: '2026-10-11T01:55:19.000Z', meetings: [] })
  })

  it('运营遇到响应体缺 meetings 数组时看到协议错误而不是崩', async () => {
    // Given 桥回了不合契约的信封
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, fetchedAt: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch
    try {
      // When 取数
      const result = await fetchPredictionFomc()

      // Then 协议错误状态
      expect(result).toEqual({ status: 'error', code: 'TRADING_PROTOCOL', message: 'bridge returned no meetings array' })
    } finally {
      globalThis.fetch = original
    }
  })

  it('运营遇到网络中断时看到 TRADING_NETWORK 错误状态', async () => {
    // Given 一个不可达的地址
    const original = globalThis.fetch
    globalThis.fetch = (async () => { throw new TypeError('fetch failed') }) as typeof globalThis.fetch
    try {
      // When 取数
      const result = await fetchPredictionFomc()

      // Then 网络错误状态（不是空数据）
      expect(result).toEqual({ status: 'error', code: 'TRADING_NETWORK', message: 'fetch failed' })
    } finally {
      globalThis.fetch = original
    }
  })
})

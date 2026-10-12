/**
 * 港股通持股取数层用例（契约 §5）：真实本地 HTTP 上游（node:http）+ 真实 fetch 语义，
 * 钉住三条事实——信封字段名 southboundHoldings、标的不在港股通时是空序列而非报错、
 * 宿主失败一律降级为 undefined（副图隐藏，连主图一起炸才是 bug）。
 *
 * fetch 桩照抄本包既有手法（prediction-api.test.ts）：替换 globalThis.fetch 为
 * 指向真实本地服务器的真函数，并在 finally 还原；不引入通用 mock 工具。
 */
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fetchSouthboundHoldings } from '../src/client/api.ts'

let server: Server
let baseUrl = ''
/** 最近一次请求的查询串（断言客户端确实带了 market/symbol）。 */
let lastQuery = ''

/** 桥的响应信封，与真实 /dshtrading/api/southbound-holdings 同形状。 */
const HOLDINGS = {
  symbol: '00700.HK',
  points: [
    { date: Date.UTC(2026, 9, 5), holdRatio: 11.9, holdShares: 1_234_567, holdMarketCap: 555_000_000 },
    { date: Date.UTC(2026, 9, 6), holdRatio: 12.5, holdShares: 1_240_000, holdMarketCap: 560_000_000 },
  ],
}

beforeEach(async () => {
  server = createServer((req, res) => {
    lastQuery = req.url ?? ''
    res.setHeader('content-type', 'application/json')
    if (req.url?.includes('unavailable')) {
      res.statusCode = 200
      res.end(JSON.stringify({ ok: false, code: 'TRADING_NOT_IMPLEMENTED', message: 'no market data source implements getSouthboundHoldings' }))
      return
    }
    if (req.url?.includes('broken')) {
      res.statusCode = 500
      res.end('{}')
      return
    }
    res.statusCode = 200
    // 标的不在港股通范围时上游返回空序列（空 ≠ 0，语义与失败区分）。
    res.end(JSON.stringify({
      ok: true,
      southboundHoldings: req.url?.includes('empty') ? { symbol: '08083.HK', points: [] } : HOLDINGS,
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** 真实 fetch 的引用（在替换 globalThis.fetch 之前抓住），否则替换品会调用自己。 */
const realFetch = globalThis.fetch

/** 把 fetch 指向真实本地服务器（真实 HTTP 往返，非 mock 库）。 */
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

describe('fetchSouthboundHoldings（客户端取数层）', () => {
  it('用户查看港股副图时，取数带 market/symbol 并解析 southboundHoldings 信封', async () => {
    // Given 桥正常回一段持股历史
    // When 按市场与标的取数
    const history = await withRouting('', () => fetchSouthboundHoldings('hk', '00700.HK'))

    // Then 信封被解开、交易日与持股比例逐条保留，请求带上了查询参数
    expect(lastQuery).toContain('market=hk')
    expect(lastQuery).toContain('symbol=00700.HK')
    expect(history).toEqual({ symbol: '00700.HK', points: HOLDINGS.points })
  })

  it('运营在标的不在港股通范围时看到空序列（合法的空态，不是错误）', async () => {
    // Given 上游对该标的返回 result 空（points 为空数组，绝不是 0）
    // When 取数
    const history = await withRouting('/empty', () => fetchSouthboundHoldings('hk', '08083.HK'))

    // Then 返回带空 points 的历史——消费侧据此隐藏副图，而不是画一条贴底的零线
    expect(history?.points).toEqual([])
  })

  it('运营在宿主未实现该端点时看到 undefined 而不是抛错', async () => {
    // Given 桥回 HTTP 200 + ok:false 的业务错误信封
    // When 取数
    const history = await withRouting('/unavailable', () => fetchSouthboundHoldings('hk', '00700.HK'))

    // Then 取数层吞掉错误返回 undefined（副图隐藏，主图与其它指标不受影响）
    expect(history).toBeUndefined()
  })

  it('运营在宿主取数失败（HTTP 500）时看到 undefined 而不是抛错', async () => {
    // Given 桥以 500 失败
    // When 取数
    const history = await withRouting('/broken', () => fetchSouthboundHoldings('hk', '00700.HK'))

    // Then 同样降级为 undefined
    expect(history).toBeUndefined()
  })
})

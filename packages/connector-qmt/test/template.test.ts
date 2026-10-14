import { describe, expect, it } from 'vitest'
import {
  INTERVAL_VOCABULARY,
  QmtRestClient,
  toQmtCode,
} from '../src/rest.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubFetch(routes: Array<{ match: string; body: unknown; status?: number }>) {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) throw new Error(`unexpected request: ${url}`)
    return jsonResponse(route.body, route.status)
  }) as typeof fetch
  return { impl, urls }
}

describe('QmtRestClient 符号与周期映射', () => {
  it('代码格式化', () => {
    expect(toQmtCode('600519')).toBe('600519.SH')
    expect(toQmtCode('000001')).toBe('000001.SZ')
    expect(toQmtCode('600519.SH')).toBe('600519.SH')
  })

  it('支持的 interval 词汇', () => {
    expect(INTERVAL_VOCABULARY).toContain('1m')
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1d')
  })
})

describe('QmtRestClient 交易接口', () => {
  it('真实拉取可用资金与总资产', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/v1/trade/asset',
        body: {
          code: 0,
          data: {
            cash: 250000.5,
            total_asset: 680000.0,
            frozen_cash: 50000.0,
            currency: 'CNY',
          },
        },
      },
    ])
    const client = new QmtRestClient({ fetchImpl: impl, accountId: '12345678' })
    const bal = await client.getBalance()

    expect(urls[0]).toContain('account_id=12345678')
    expect(bal).toEqual({
      currency: 'CNY',
      available: 250000.5,
      total: 680000.0,
    })
  })

  it('真实提交 A 股委托订单', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/v1/trade/order',
        body: {
          code: 0,
          data: {
            order_id: 'qmt-ord-8888',
            status: 'new',
          },
        },
      },
    ])
    const client = new QmtRestClient({ fetchImpl: impl, accountId: '12345678' })
    const order = await client.placeOrder(undefined, {
      symbol: '600519.SH',
      side: 'buy',
      type: 'limit',
      quantity: 100,
      price: 1750.0,
    })

    expect(urls[0]).toContain('/api/v1/trade/order')
    expect(order.id).toBe('qmt-ord-8888')
    expect(order.symbol).toBe('600519.SH')
    expect(order.side).toBe('buy')
    expect(order.dryRun).toBe(false)
  })

  it('真实撤销 A 股委托订单', async () => {
    const { impl } = stubFetch([
      {
        match: '/api/v1/trade/cancel',
        body: {
          code: 0,
          data: { order_id: 'qmt-ord-8888' },
        },
      },
    ])
    const client = new QmtRestClient({ fetchImpl: impl, accountId: '12345678' })
    const res = await client.cancelOrder(undefined, 'qmt-ord-8888')
    expect(res).toEqual({ orderId: 'qmt-ord-8888', status: 'canceled' })
  })

  it('无 accountId 时抛出 TRADING_AUTH_FAILED', async () => {
    const client = new QmtRestClient({})
    await expect(client.getBalance()).rejects.toThrowError(/accountId is required/)
  })
})

describe('QmtRestClient.getTicker 网关离线时的东财回退', () => {
  // fixture 是 2026-10-14 14:52（Asia/Shanghai 盘中）push2 `ulist.np/get` 的真实响应行，
  // 逐字段照抄；旧回退打的 /api/qt/stock/get 同日对任意 secid 都是传输层空回。
  it('用户查普通股票报价且本地网关离线时，回退按报价行的 f1=2 取价', async () => {
    // Given 本地 QMT 网关不可达（stub 对网关路径直接抛错），东财对该 secid 返回贵州茅台报价行
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/ulist.np/get',
        body: {
          data: {
            total: 1,
            diff: [{ f1: 2, f2: 128547, f5: 21865, f124: 1791960743 }],
          },
        },
      },
    ])
    const client = new QmtRestClient({ fetchImpl: impl })

    // When 用户查询 600519.SH
    const ticker = await client.getTicker('600519.SH')

    // Then 先试网关、失败后落在 ulist.np/get 上，价格是 128547 / 10^2
    expect(urls[0]).toContain('/api/v1/market/ticker')
    expect(urls[1]).toContain('/api/qt/ulist.np/get?secids=1.600519')
    expect(ticker).toEqual({
      symbol: '600519.SH',
      price: 1285.47,
      volume: 21865,
      timestamp: 1791960743000,
    })
  })

  it('用户查 A 股 ETF 报价且本地网关离线时，回退按报价行的 f1=3 取价，而不是市场级 ÷100', async () => {
    // Given 本地网关不可达，东财对 0.159869 返回游戏ETF华夏报价行（ETF 的 f1=3 与股票不同档）
    const { impl } = stubFetch([
      {
        match: '/api/qt/ulist.np/get',
        body: {
          data: {
            total: 1,
            diff: [{ f1: 3, f2: 1056, f5: 4824962, f124: 1791960744 }],
          },
        },
      },
    ])
    const client = new QmtRestClient({ fetchImpl: impl })

    // When 用户查询 159869.SZ
    const ticker = await client.getTicker('159869.SZ')

    // Then 价格是 1056 / 10^3 = 1.056 元（同刻腾讯同值），市场级 ÷100 会得到 10.56 元
    expect(ticker.price).toBe(1.056)
    expect(ticker.volume).toBe(4824962)
  })

  it('用户查未收录的代码且本地网关离线时，回退保持零价快照的降级语义，不另抛新错误码', async () => {
    // Given 本地网关不可达，东财对未收录的 secid 只回 data:null（HTTP 仍 200）
    const { impl } = stubFetch([{ match: '/api/qt/ulist.np/get', body: { rc: 102, data: null } }])
    const client = new QmtRestClient({ fetchImpl: impl })

    // When 用户查询一个不存在的代码
    const ticker = await client.getTicker('999999.SZ')

    // Then 与网关返回非 0 code 时的兜底同形（价格 0），不改动本连接器的错误契约
    expect(ticker.price).toBe(0)
    expect(ticker.volume).toBe(0)
    expect(ticker.symbol).toBe('999999.SZ')
  })
})

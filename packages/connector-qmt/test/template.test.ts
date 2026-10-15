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

function stubFetch(
  routes: Array<{ match: string; body?: unknown; status?: number; rawBody?: string; networkError?: boolean }>,
) {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const route = routes.find((r) => url.includes(r.match))
    // 没配路由即视为不可达：本地网关离线（原有手法）走这一形态；networkError 是传输层拒绝
    // （TCP 通、服务端收到即断，node fetch 抛 TypeError，2026-10-14 实测）的显式写法。
    if (!route) throw new Error(`unexpected request: ${url}`)
    if (route.networkError) throw new TypeError('fetch failed')
    // rawBody：非 JSON 响应的真实形态（上游回 HTML / 空体），res.json() 抛 SyntaxError。
    if (route.rawBody !== undefined) {
      return new Response(route.rawBody, {
        status: route.status ?? 200,
        headers: { 'content-type': 'text/html' },
      })
    }
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

describe('QmtRestClient.getTicker 网关可用时的直取', () => {
  it('用户查询且本地网关可用时，报价原样取自网关、不触发任何回退', async () => {
    // Given 网关正常返回最新价与成交量（一条带 timestamp、一条不带）
    const { impl, urls } = stubFetch([
      {
        match: '/api/v1/market/ticker',
        body: { code: 0, data: { lastPrice: 1285.47, volume: 21865, timestamp: 1791960743000 } },
      },
    ])
    const { impl: noTimestampImpl } = stubFetch([
      { match: '/api/v1/market/ticker', body: { code: 0, data: { lastPrice: 1.056, volume: 4824962 } } },
    ])

    // When 用户查询 600519.SH 与 159869.SZ
    const withTimestamp = await new QmtRestClient({ fetchImpl: impl }).getTicker('600519.SH')
    const withoutTimestamp = await new QmtRestClient({ fetchImpl: noTimestampImpl }).getTicker('159869.SZ')

    // Then 价格按网关原值透传（不经东财的 ÷10^f1），缺 timestamp 时以本机时钟兜底，且只发一次请求
    expect(withTimestamp).toEqual({
      symbol: '600519.SH',
      price: 1285.47,
      volume: 21865,
      timestamp: 1791960743000,
    })
    expect(urls).toHaveLength(1)
    expect(withoutTimestamp.price).toBe(1.056)
    expect(withoutTimestamp.timestamp).toBeGreaterThan(1_700_000_000_000)
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

  it('用户查未收录的代码且本地网关离线时，回退拿不到报价行就抛错，不再交零价快照', async () => {
    // Given 本地网关不可达，东财对未收录的 secid 只回 data:null（HTTP 仍 200）
    const { impl } = stubFetch([{ match: '/api/qt/ulist.np/get', body: { rc: 102, data: null } }])
    const client = new QmtRestClient({ fetchImpl: impl })

    // When 用户查询一个不存在的代码
    // Then 抛结构化错误——price 0 会被消费方读成「这只标的不值钱」，不是「没取到价」
    await expect(client.getTicker('999999.SZ')).rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
  })

  it('用户查停牌占位报价且本地网关离线时，同样抛错而不是零价快照', async () => {
    // Given 东财回了行但没有可用价格（f2 缺失 / f2 为 0，停牌占位的两种实测形态）
    const { impl } = stubFetch([
      { match: '/api/qt/ulist.np/get', body: { data: { diff: [{ f1: 2, f5: 0, f124: 0 }] } } },
    ])
    const { impl: zeroImpl } = stubFetch([
      { match: '/api/qt/ulist.np/get', body: { data: { diff: [{ f1: 2, f2: 0, f5: 0, f124: 0 }] } } },
    ])

    // When 用户分别查询这两只标的
    // Then 都没有可用价格，一律抛错
    await expect(new QmtRestClient({ fetchImpl: impl }).getTicker('600519.SH'))
      .rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
    await expect(new QmtRestClient({ fetchImpl: zeroImpl }).getTicker('600519.SH'))
      .rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
  })

  it('用户查询时网关回 code 0 却不带报价数据，仍走同一条回退而不是零价快照', async () => {
    // Given 网关 HTTP 200、code 0 但缺 data（网关契约不成立的形态），东财行里也没有 f5/f124
    const { impl, urls } = stubFetch([
      { match: '/api/v1/market/ticker', body: { code: 0 } },
      { match: '/api/qt/ulist.np/get', body: { data: { total: 1, diff: [{ f1: 2, f2: 128547 }] } } },
    ])

    // When 用户查询 600519.SH
    const ticker = await new QmtRestClient({ fetchImpl: impl }).getTicker('600519.SH')

    // Then 缺 data 与传输失败同路降级：出东财价，成交量缺省为 0，时间戳回落到本机时钟
    expect(urls[1]).toContain('/api/qt/ulist.np/get?secids=1.600519')
    expect(ticker.price).toBe(1285.47)
    expect(ticker.volume).toBe(0)
    expect(ticker.timestamp).toBeGreaterThan(1_700_000_000_000)
  })

  it('用户查询时网关回业务码非 0，走与传输失败同一条回退而不是零价快照', async () => {
    // Given 网关 HTTP 200 但 code=1（网关自己报错），东财对同一 secid 有真实报价行
    const { impl, urls } = stubFetch([
      { match: '/api/v1/market/ticker', body: { code: 1, message: 'gateway not logged in' } },
      {
        match: '/api/qt/ulist.np/get',
        body: { data: { total: 1, diff: [{ f1: 2, f2: 128547, f5: 21865, f124: 1791960743 }] } },
      },
    ])

    // When 用户查询 600519.SH
    const ticker = await new QmtRestClient({ fetchImpl: impl }).getTicker('600519.SH')

    // Then 先试网关、业务码失败后落在与网关离线同一条 ulist.np/get 回退上，价格是东财价
    expect(urls[0]).toContain('/api/v1/market/ticker')
    expect(urls[1]).toContain('/api/qt/ulist.np/get?secids=1.600519')
    expect(ticker.price).toBe(1285.47)
  })

  it('用户查询时网关离线且东财回退遇 5xx，拿到 TRADING_UPSTREAM_ERROR', async () => {
    // Given 本地网关不可达，东财回退端点回 502
    const { impl } = stubFetch([{ match: '/api/qt/ulist.np/get', body: { data: null }, status: 502 }])
    const client = new QmtRestClient({ fetchImpl: impl })

    // When 用户查询 600519.SH
    // Then 请求到达了上游、上游明确报错，按上游错误上报，不落穿成零价快照
    await expect(client.getTicker('600519.SH')).rejects.toMatchObject({ code: 'TRADING_UPSTREAM_ERROR' })
  })

  it('用户查询时网关离线且东财回退回非 JSON，拿到 TRADING_EXCHANGE_ERROR', async () => {
    // Given 本地网关不可达，东财回退端点回一段 HTML（非 JSON 体）
    const { impl } = stubFetch([{ match: '/api/qt/ulist.np/get', rawBody: '<html>Bad Gateway</html>' }])
    const client = new QmtRestClient({ fetchImpl: impl })

    // When 用户查询 600519.SH
    // Then 上游回了个不成形的载荷，按上游载荷错误上报，不落穿成零价快照
    await expect(client.getTicker('600519.SH')).rejects.toMatchObject({ code: 'TRADING_EXCHANGE_ERROR' })
  })

  it('用户查询时网关与东财回退都连不上，拿到 TRADING_NETWORK', async () => {
    // Given 本地网关不可达，东财回退端点也断连（TCP 通、服务端收到即断）
    const { impl } = stubFetch([{ match: 'push2.eastmoney.com', networkError: true }])
    const client = new QmtRestClient({ fetchImpl: impl })

    // When 用户查询 600519.SH
    // Then 两条路径都够不着，报网络不可达
    await expect(client.getTicker('600519.SH')).rejects.toMatchObject({ code: 'TRADING_NETWORK' })
  })
})

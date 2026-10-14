import { describe, expect, it } from 'vitest'
import {
  AkshareRestClient,
  INTERVAL_VOCABULARY,
  toEastmoneySecid,
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

describe('AkshareRestClient 符号与周期映射', () => {
  it('代码格式化', () => {
    expect(toEastmoneySecid('600519')).toEqual({ secid: '1.600519', canonical: '600519.SH' })
    expect(toEastmoneySecid('000001')).toEqual({ secid: '0.000001', canonical: '000001.SZ' })
  })

  it('支持的 interval 词汇', () => {
    expect(INTERVAL_VOCABULARY).toContain('1m')
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1d')
  })
})

describe('AkshareRestClient.getTicker', () => {
  // 下面两行的 fixture 是 2026-10-14 14:52（Asia/Shanghai 盘中）push2 `ulist.np/get`
  // 的真实响应行，逐字段照抄；同刻腾讯 qt.gtimg.cn 对照见
  // spikes/impl-eastmoney-quote-endpoint/。
  it('用户查 A 股股票报价时拿到按行小数位数 f1=2 还原的价格与官方昨收', async () => {
    // Given 上游对 secid=1.600519 返回贵州茅台的报价行（f1=2，即价格是 ×100 的整数）
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/ulist.np/get',
        body: {
          data: {
            total: 1,
            diff: [{ f1: 2, f2: 128547, f3: 83, f5: 21865, f12: '600519', f13: 1, f14: '贵州茅台', f18: 127489, f124: 1791960743 }],
          },
        },
      },
    ])
    const client = new AkshareRestClient({ fetchImpl: impl })

    // When 用户查询 600519.SH
    const ticker = await client.getTicker('600519.SH')

    // Then 请求打在 ulist.np/get 上，价格/昨收按该行 f1 取除数、涨跌幅 ×100
    expect(urls[0]).toContain('/api/qt/ulist.np/get?secids=1.600519')
    expect(urls[0]).toContain('fields=f1,f2,f3,f5,f12,f13,f14,f18,f124')
    expect(ticker).toEqual({
      symbol: '600519.SH',
      name: '贵州茅台',
      price: 1285.47,
      volume: 21865,
      timestamp: 1791960743000,
      prevClose: 1274.89,
      changePercent: 0.83,
    })
  })

  it('用户查 A 股 ETF 报价时按该行的 f1=3 取价，而不是市场级 ÷100', async () => {
    // Given 上游对 secid=0.159869 返回游戏ETF华夏的报价行（ETF 的 f1=3 与股票不同档）
    const { impl } = stubFetch([
      {
        match: '/api/qt/ulist.np/get',
        body: {
          data: {
            total: 1,
            diff: [{ f1: 3, f2: 1056, f3: 76, f5: 4824962, f12: '159869', f13: 0, f14: '游戏ETF华夏', f18: 1048, f124: 1791960744 }],
          },
        },
      },
    ])
    const client = new AkshareRestClient({ fetchImpl: impl })

    // When 用户查询 159869.SZ
    const ticker = await client.getTicker('159869.SZ')

    // Then 价格是 1056 / 10^3 = 1.056 元（同刻腾讯同值），而市场级 ÷100 会得到 10.56 元
    expect(ticker.price).toBe(1.056)
    expect(ticker.prevClose).toBe(1.048)
    expect(ticker.name).toBe('游戏ETF华夏')
  })

  it('用户查未收录的代码时拿到 TRADING_SYMBOL_NOT_FOUND，而不是价格 0 的假快照', async () => {
    // Given 上游对未收录的 secid 只回 data:null（或空 diff），HTTP 仍是 200
    const nullData = stubFetch([{ match: '/api/qt/ulist.np/get', body: { rc: 102, data: null } }])
    const emptyDiff = stubFetch([{ match: '/api/qt/ulist.np/get', body: { data: { total: 0, diff: [] } } }])

    // When 用户查询一个不存在的代码
    const fromNull = await new AkshareRestClient({ fetchImpl: nullData.impl })
      .getTicker('999999.SZ')
      .catch((err: unknown) => err as { code?: string })
    const fromEmpty = await new AkshareRestClient({ fetchImpl: emptyDiff.impl })
      .getTicker('999999.SZ')
      .catch((err: unknown) => err as { code?: string })

    // Then 两种空响应形态都判 not found
    expect(fromNull).toMatchObject({ code: 'TRADING_SYMBOL_NOT_FOUND' })
    expect(fromEmpty).toMatchObject({ code: 'TRADING_SYMBOL_NOT_FOUND' })
  })
})

describe('AkshareRestClient.getSectorFundFlow', () => {
  it('拉取板块资金流（f3 涨跌幅除以 100）', async () => {
    const { impl } = stubFetch([
      {
        match: 'clist/get',
        body: {
          data: {
            diff: [
              { f14: '半导体', f3: 345, f62: 1250000000 },
              { f14: '航空机场', f3: -120, f62: -50000000 },
            ],
          },
        },
      },
    ])
    const client = new AkshareRestClient({ fetchImpl: impl })
    const list = await client.getSectorFundFlow()

    expect(list).toHaveLength(2)
    expect(list[0]).toEqual({
      name: '半导体',
      changePercent: 3.45,
      mainNetInflow: 1250000000,
    })
    expect(list[1]).toEqual({
      name: '航空机场',
      changePercent: -1.2,
      mainNetInflow: -50000000,
    })
  })
})

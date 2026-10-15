import { describe, expect, it } from 'vitest'
import {
  AkshareRestClient,
  INTERVAL_VOCABULARY,
  SUPPORTED_KLINES_INTERVALS,
  toEastmoneySecid,
  type Interval,
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

  it('用户对照周期词汇表与真实可服务的子集，看到 1m 只在词汇表里', () => {
    // Given: 工具枚举用的规范 interval 词汇表（`src/index.ts` 的 enum）
    // When: 与本包 K 线实际可服务的周期清单对照
    // Then: 词汇表含 1m，可服务子集不含 1m，且覆盖 5m 到月线七档
    expect(INTERVAL_VOCABULARY).toContain('1m')
    expect(SUPPORTED_KLINES_INTERVALS).not.toContain('1m')
    expect(SUPPORTED_KLINES_INTERVALS).toEqual(
      expect.arrayContaining(['5m', '15m', '30m', '1h', '1d', '1w', '1M']),
    )
  })
})

/** kline/get 响应行：时间,开,收,高,低,量（日线时间无时分，分钟线带 `HH:mm`）。 */
function klineRow(time: string): string {
  return `${time},1280.00,1285.47,1290.00,1279.00,21865`
}

describe('AkshareRestClient.getKlines 周期与 closeTime', () => {
  it('用户请求周线/月线时拿到 klt=102/103 的周期码，而不是静默的日线', async () => {
    // Given: 上游按 klt 回同一行（旧实现 1w/1M 都发 klt=101，静默返日线）
    const weekly = stubFetch([{ match: 'klt=102', body: { data: { klines: [klineRow('2026-10-09')] } } }])
    const monthly = stubFetch([{ match: 'klt=103', body: { data: { klines: [klineRow('2026-09-30')] } } }])

    // When: 用户分别请求周线与月线
    const weekBars = await new AkshareRestClient({ fetchImpl: weekly.impl }).getKlines('600519.SH', '1w', 1)
    const monthBars = await new AkshareRestClient({ fetchImpl: monthly.impl }).getKlines('600519.SH', '1M', 1)

    // Then: 请求打在各自的 klt 上并解析出一根 K 线
    expect(weekly.urls[0]).toContain('klt=102')
    expect(monthly.urls[0]).toContain('klt=103')
    expect(weekBars).toHaveLength(1)
    expect(monthBars).toHaveLength(1)
    expect(weekBars[0]?.close).toBe(1285.47)
  })

  it('用户请求 5m 与 1d 时 klt 按时段分派，closeTime 是各自周期的末尾', async () => {
    // Given: 上游对 klt=5 回一根 09:35 分钟线、对 klt=101 回一根日线
    const intraday = stubFetch([{ match: 'klt=5', body: { data: { klines: [klineRow('2026-10-14 09:35')] } } }])
    const daily = stubFetch([{ match: 'klt=101', body: { data: { klines: [klineRow('2026-10-14')] } } }])

    // When: 用户分别请求 5m 与 1d
    const minuteBar = (await new AkshareRestClient({ fetchImpl: intraday.impl }).getKlines('600519.SH', '5m', 1))[0]
    const dailyBar = (await new AkshareRestClient({ fetchImpl: daily.impl }).getKlines('600519.SH', '1d', 1))[0]

    // Then: 5m 覆盖 5 分钟（旧实现按日线加满一天），1d 仍覆盖一天
    expect(intraday.urls[0]).toContain('klt=5')
    expect(minuteBar!.closeTime - minuteBar!.openTime).toBe(5 * 60_000 - 1)
    expect(dailyBar!.closeTime - dailyBar!.openTime).toBe(24 * 60 * 60_000 - 1)
  })

  it('用户请求周线时 closeTime 覆盖整周，供指标库识别跨日周期', async () => {
    // Given: 上游 klt=102 回一根周期末交易日 2026-10-09 的周线
    const { impl } = stubFetch([{ match: 'klt=102', body: { data: { klines: [klineRow('2026-10-09')] } } }])

    // When: 用户请求 1w
    const bar = (await new AkshareRestClient({ fetchImpl: impl }).getKlines('600519.SH', '1w', 1))[0]

    // Then: 跨度是 7 天减 1 毫秒（packages/indicators 以「跨度 ≥ 2 天」判周/月 K）
    expect(bar!.closeTime - bar!.openTime).toBe(7 * 24 * 60 * 60_000 - 1)
  })

  it('用户请求词汇表外的周期（3m/2h/3d）时本地抛 TRADING_UNSUPPORTED_INTERVAL 且不发请求', async () => {
    // Given: 会记录每次请求的假 fetch（任何出网都会被记进 urls）
    const { impl, urls } = stubFetch([])
    const client = new AkshareRestClient({ fetchImpl: impl })

    // When: 用户请求词汇表外的周期
    const outcomes = await Promise.all(
      (['3m', '2h', '3d'] as Interval[]).map((interval) =>
        client.getKlines('600519.SH', interval, 1).catch((err: unknown) => err as { code?: string; message?: string }),
      ),
    )

    // Then: 三个周期都抛 TRADING_UNSUPPORTED_INTERVAL，且一个请求都没发出
    expect(outcomes.map((o) => o.code)).toEqual([
      'TRADING_UNSUPPORTED_INTERVAL',
      'TRADING_UNSUPPORTED_INTERVAL',
      'TRADING_UNSUPPORTED_INTERVAL',
    ])
    expect(outcomes[0]?.message).toContain('3m')
    expect(urls).toEqual([])
  })

  it('用户请求 1m 时本地拒绝而不是拿当日分时冒充多日序列', async () => {
    // Given: 会记录每次请求的假 fetch
    const { impl, urls } = stubFetch([])

    // When: 用户请求 1m（上游 kline/get klt=1 只回当日，本包无 trends2 分时通道）
    const outcome = await new AkshareRestClient({ fetchImpl: impl })
      .getKlines('600519.SH', '1m', 100)
      .catch((err: unknown) => err as { code?: string })

    // Then: 本地拒绝，不发请求
    expect(outcome).toMatchObject({ code: 'TRADING_UNSUPPORTED_INTERVAL' })
    expect(urls).toEqual([])
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

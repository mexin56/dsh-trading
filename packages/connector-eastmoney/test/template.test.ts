import { describe, expect, it } from 'vitest'
import {
  EastmoneyRestClient,
  INTERVAL_VOCABULARY,
  mapIntervalToKlt,
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

describe('EastmoneyRestClient 符号与周期映射', () => {
  it('A股标准代码转东财 secid 与规范形', () => {
    expect(toEastmoneySecid('600519.SH')).toEqual({ secid: '1.600519', canonical: '600519.SH', market: 'cn' })
    expect(toEastmoneySecid('000001.SZ')).toEqual({ secid: '0.000001', canonical: '000001.SZ', market: 'cn' })
    expect(toEastmoneySecid('600519')).toEqual({ secid: '1.600519', canonical: '600519.SH', market: 'cn' })
    expect(toEastmoneySecid('000001')).toEqual({ secid: '0.000001', canonical: '000001.SZ', market: 'cn' })
    expect(toEastmoneySecid('832023.BJ')).toEqual({ secid: '0.832023', canonical: '832023.BJ', market: 'cn' })
  })

  it('港股代码转东财 secid（market=hk；形态 00700.HK / HK.00700 / HK00700 / 裸 1-5 位）', () => {
    expect(toEastmoneySecid('00700.HK', 'hk')).toEqual({ secid: '116.00700', canonical: '00700.HK', market: 'hk' })
    expect(toEastmoneySecid('HK00700', 'hk')).toEqual({ secid: '116.00700', canonical: '00700.HK', market: 'hk' })
    expect(toEastmoneySecid('HK.00700', 'hk')).toEqual({ secid: '116.00700', canonical: '00700.HK', market: 'hk' })
    expect(toEastmoneySecid('02714.HK', 'hk')).toEqual({ secid: '116.02714', canonical: '02714.HK', market: 'hk' })
    expect(toEastmoneySecid('00700', 'hk')).toEqual({ secid: '116.00700', canonical: '00700.HK', market: 'hk' })
    // 审查 H3：裸短码在 hk 上下文是港股（补零），不再落 CN 兜底查深市。
    expect(toEastmoneySecid('700', 'hk')).toEqual({ secid: '116.00700', canonical: '00700.HK', market: 'hk' })
    // 跨市场形态显式拒绝（fail-closed，绝不查询另一个市场的证券）。
    expect(() => toEastmoneySecid('600519.SH', 'hk')).toThrowError(/malformed HK symbol/)
    expect(() => toEastmoneySecid('00700.HK', 'cn')).toThrowError(/not an A-share symbol/)
    expect(() => toEastmoneySecid('700', 'cn')).toThrowError(/not an A-share symbol/)
  })

  it('支持的 interval 词汇包含 1m/5m/15m/30m/1h/1d/1w/1M', () => {
    expect(INTERVAL_VOCABULARY).toContain('1m')
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('15m')
    expect(INTERVAL_VOCABULARY).toContain('30m')
    expect(INTERVAL_VOCABULARY).toContain('1h')
    expect(INTERVAL_VOCABULARY).toContain('1d')
    expect(mapIntervalToKlt('5m')).toBe('5')
    expect(mapIntervalToKlt('1h')).toBe('60')
    expect(mapIntervalToKlt('1d')).toBe('101')
  })
})

describe('EastmoneyRestClient.getTicker', () => {
  it('拉取并解析 A 股 Ticker 快照（分精度整数除以 100，含官方昨收/涨跌幅）', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/stock/get',
        body: {
          data: {
            f43: 175050,
            f47: 25000,
            f58: '贵州茅台',
            f60: 174800,
            f86: 1725000000,
            f170: 15,
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('600519.SH')

    expect(urls[0]).toContain('secid=1.600519')
    expect(urls[0]).toContain('f60')
    expect(ticker).toEqual({
      symbol: '600519.SH',
      name: '贵州茅台',
      price: 1750.5,
      volume: 25000,
      timestamp: 1725000000000,
      prevClose: 1748,
      changePercent: 0.15,
    })
  })

  it('处理 "-" 停牌/无数据占位符', async () => {
    const { impl } = stubFetch([
      {
        match: '/api/qt/stock/get',
        body: {
          data: {
            f43: '-',
            f47: 0,
            f58: '退市标的',
            f86: 1725000000,
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('600519.SH')
    expect(ticker.price).toBe(0)
  })

  it('防回归断言：茅台 ticker price 与最近 K 线 close 在 ±5% 以内', async () => {
    const klineClose = 1755.0
    const tickerPriceRaw = 175050 // 上游返回 175050 即 1750.50 元
    const { impl } = stubFetch([
      {
        match: '/api/qt/stock/get',
        body: { data: { f43: tickerPriceRaw, f47: 25000, f58: '贵州茅台', f86: 1725000000 } },
      },
      {
        match: '/api/qt/stock/kline/get',
        body: { data: { klines: [`2026-08-31 09:35,1750.0,${klineClose},1758.0,1748.0,5000,87500000.0,0.57`] } },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })
    const ticker = await client.getTicker('600519.SH')
    const klines = await client.getKlines('600519.SH', '5m', 1)

    const ratio = Math.abs(ticker.price - klines[0].close) / klines[0].close
    expect(ratio).toBeLessThan(0.05)
  })
})

describe('EastmoneyRestClient.getKlines', () => {
  it('拉取并解析 5m 分钟 K 线', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/stock/kline/get',
        body: {
          data: {
            klines: [
              '2026-08-31 09:35,1750.0,1755.0,1758.0,1748.0,5000,87500000.0,0.57',
            ],
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })
    const klines = await client.getKlines('600519.SH', '5m', 10)

    expect(urls[0]).toContain('secid=1.600519')
    expect(urls[0]).toContain('klt=5')
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({
      open: 1750.0,
      close: 1755.0,
      high: 1758.0,
      low: 1748.0,
      volume: 5000,
    })
  })

  it('用户取 A 股 1m 时走 trends2 五日窗口，open=0 的行按同日前一根 close 重建', async () => {
    // Given 上游 trends2 ndays=5 的真实形态：历史交易日每根的第 2 列为 0.00，
    // 当日那一段带真实开价（2026-10-14 实测，spikes/impl-five-day-1m-probe/p4）
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/stock/trends2/get',
        body: {
          data: {
            trends: [
              '2026-10-13 14:59,0.00,1285.00,1287.80,1280.14,1200,1540000.000,0.00',
              '2026-10-13 15:00,0.00,1286.00,1288.00,1284.00,1300,1670000.000,0.00',
              '2026-10-14 09:30,1287.00,1287.50,1288.20,1286.80,900,1160000.000,0.00',
              '2026-10-14 09:31,1287.50,1290.00,1290.50,1287.20,1100,1420000.000,0.00',
            ],
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })

    // When 用户以五日窗口的取数上限查询 A 股 1m
    const klines = await client.getKlines('600519.SH', '1m', 2500)

    // Then 请求落在 trends2 且 ndays=5（kline/get 的 klt=1 只有当日，表达不了五日窗口）
    expect(urls[0]).toContain('/api/qt/stock/trends2/get')
    expect(urls[0]).toContain('secid=1.600519')
    expect(urls[0]).toContain('ndays=5')
    // Then 序列升序，closeTime 与 1m 名义时长自洽
    expect(klines.map((k) => k.openTime)).toEqual([
      Date.UTC(2026, 9, 13, 6, 59),
      Date.UTC(2026, 9, 13, 7, 0),
      Date.UTC(2026, 9, 14, 1, 30),
      Date.UTC(2026, 9, 14, 1, 31),
    ])
    expect(klines[0]!.closeTime).toBe(Date.UTC(2026, 9, 13, 6, 59) + 60_000 - 1)
    // Then 开价重建：上游为 0 时同日前一根 close；窗口内某交易日首根用该根自身 close；
    // 当日（上游有真实开价）直接用上游值
    expect(klines.map((k) => k.open)).toEqual([1285.0, 1285.0, 1287.0, 1287.5])
    expect(klines.map((k) => k.close)).toEqual([1285.0, 1286.0, 1287.5, 1290.0])
  })

  it('用户请求的 limit 小于 trends2 窗口时只拿到最近 limit 根', async () => {
    // Given 上游回 3 根（跨两个交易日）
    const { impl } = stubFetch([
      {
        match: '/api/qt/stock/trends2/get',
        body: {
          data: {
            trends: [
              '2026-10-13 15:00,0.00,1286.00,1288.00,1284.00,1300,1670000.000,0.00',
              '2026-10-14 09:30,1287.00,1287.50,1288.20,1286.80,900,1160000.000,0.00',
              '2026-10-14 09:31,1287.50,1290.00,1290.50,1287.20,1100,1420000.000,0.00',
            ],
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })

    // When 用户只要最近 2 根
    const klines = await client.getKlines('600519.SH', '1m', 2)

    // Then 截尾保留最新两根，跨日首根仍用该根自身 close
    expect(klines).toHaveLength(2)
    expect(klines.map((k) => k.openTime)).toEqual([Date.UTC(2026, 9, 14, 1, 30), Date.UTC(2026, 9, 14, 1, 31)])
    expect(klines.map((k) => k.open)).toEqual([1287.0, 1287.5])
  })

  it('用户取历史 1m 时重建开价被夹进当根高低区间（越界候选收敛到边界）', async () => {
    // Given 上游 4 根全为 0.00 开价，且候选值分别越过当根 high 与 low：
    //   09:30 首根用自身 close（1250.00，落在 1248.00..1252.00 内，不触发 clamp）
    //   09:31 候选=前一根 close 1250.00，但当根 high=1248.50 → 夹到 high
    //   09:32 候选=前一根 close 1247.20，但当根 low=1249.60 → 夹到 low
    //   09:33 候选=前一根 close 1250.60，落在 1249.00..1251.00 内 → 原值
    const { impl } = stubFetch([
      {
        match: '/api/qt/stock/trends2/get',
        body: {
          data: {
            trends: [
              '2026-10-13 09:30,0.00,1250.00,1252.00,1248.00,900,1160000.000,0.00',
              '2026-10-13 09:31,0.00,1247.20,1248.50,1246.80,1100,1420000.000,0.00',
              '2026-10-13 09:32,0.00,1250.60,1251.40,1249.60,1200,1500000.000,0.00',
              '2026-10-13 09:33,0.00,1250.20,1251.00,1249.00,800,1000000.000,0.00',
            ],
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })

    // When 用户取该段 1m
    const klines = await client.getKlines('600519.SH', '1m', 2500)

    // Then 越界候选被夹到当根边界，未越界的候选保持原值
    expect(klines.map((k) => k.open)).toEqual([1250.0, 1248.5, 1249.6, 1250.6])
    // Then 每根都满足 low <= open <= high（蜡烛实体不戳出影线）
    expect(klines.every((k) => k.low <= k.open && k.open <= k.high)).toBe(true)
    // Then close 不被改写（下一根的候选仍取真实 close）
    expect(klines.map((k) => k.close)).toEqual([1250.0, 1247.2, 1250.6, 1250.2])
  })
})

describe('EastmoneyRestClient.listInstruments', () => {
  it('搜索股票代码联想', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/suggest/get',
        body: {
          QuotationCodeTable: {
            Data: [
              { Code: '600519', Name: '贵州茅台', SecurityTypeName: '沪A' },
            ],
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl })
    const results = await client.listInstruments('茅台')

    expect(urls[0]).toContain('input=%E8%8C%85%E5%8F%B0')
    expect(results).toEqual([
      { symbol: '600519.SH', name: '贵州茅台' },
    ])
  })
})


describe('EastmoneyRestClient 港股面（2026-09-08，实证 spikes/impl-eastmoney-hk/）', () => {
  it('港股 ticker：价格字段 ×1000（decimal=3），涨跌幅仍 ×100', async () => {
    // 2026-09-08 11:23 实测：f43=437600 → 437.600，f60=438400 → 438.4，f170=-18 → -0.18%
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/stock/get',
        body: { data: { f43: 437600, f44: 439200, f45: 435000, f46: 437000, f47: 4239248, f58: '腾讯控股', f60: 438400, f86: 1788837793, f170: -18 } },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl, market: 'hk' })
    const ticker = await client.getTicker('00700.HK')
    expect(urls[0]).toContain('secid=116.00700')
    expect(ticker).toEqual({
      symbol: '00700.HK',
      name: '腾讯控股',
      price: 437.6,
      volume: 4239248,
      timestamp: 1788837793000,
      prevClose: 438.4,
      changePercent: -0.18,
    })
  })

  it('用户取港股 1m 时拿到 trends2 五日窗口，时间按 UTC+8 墙钟锚定（与机器时区无关）', async () => {
    // Given 上游 trends2 回五日窗口：前一日全部 0.00 开价，当日带真实开价
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/stock/trends2/get',
        body: {
          data: {
            trends: [
              '2026-09-07 15:59,0.00,436.000,436.400,435.600,100000,43600000.000,436.0000',
              '2026-09-08 09:30,437.000,437.000,437.400,437.000,159900,69876300.000,437.0000',
              '2026-09-08 09:31,437.400,436.200,437.800,435.800,183300,80009040.000,436.7288',
            ],
          },
        },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl, market: 'hk' })

    // When 用户查询港股 1m
    const klines = await client.getKlines('00700.HK', '1m', 500)

    // Then 请求是港股 secid 的五日 trends2 窗口
    expect(urls[0]).toContain('secid=116.00700')
    expect(urls[0]).toContain('ndays=5')
    expect(klines).toHaveLength(3)
    // Then 时间锚定 UTC+8 墙钟（2026-09-08 09:30 UTC+8 = 2026-09-08 01:30 UTC）
    expect(klines[1]!.openTime).toBe(Date.UTC(2026, 8, 8, 1, 30))
    expect(klines[0]!.openTime).toBe(Date.UTC(2026, 8, 7, 7, 59))
    // Then 开价：上游 0 的首根用该根自身 close，当日带真实开价的行用上游值
    expect(klines.map((k) => k.open)).toEqual([436.0, 437.0, 437.4])
    expect(klines[1]).toMatchObject({ open: 437, close: 437, high: 437.4, low: 437, volume: 159900 })
    expect(klines[2]).toMatchObject({ open: 437.4, close: 436.2 })
  })

  it('港股 5m 走 kline/get（klt=5，secid=116）', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/api/qt/stock/kline/get',
        body: { data: { klines: ['2026-09-08 11:25,437.800,437.600,437.800,437.600,15400,6741180.000,0.05'] } },
      },
    ])
    const client = new EastmoneyRestClient({ fetchImpl: impl, market: 'hk' })
    const klines = await client.getKlines('00700.HK', '5m', 4)
    expect(urls[0]).toContain('secid=116.00700')
    expect(urls[0]).toContain('klt=5')
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({ open: 437.8, close: 437.6, volume: 15400 })
    // 审查 M1：kline/get 也按 UTC+8 墙钟锚定（11:25 UTC+8 = 03:25 UTC），与 1m 同口径。
    expect(klines[0].openTime).toBe(Date.UTC(2026, 8, 8, 3, 25))
  })
})

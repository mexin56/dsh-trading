/**
 * Polygon 连接器 REST 层单测：符号归一、周期词汇与表外周期闸门、/prev 取价语义。
 *
 * 零 mock 纪律：HTTP 面用**注入的 fetchImpl 真实函数**（连接器依赖注入缝，
 * PolygonRestOptions.fetchImpl）而非通用 mock 工具；断言的是连接器对外契约。
 */
import { describe, expect, it } from 'vitest'
import type { Interval } from '@dshtrading/api'
import {
  INTERVAL_VOCABULARY,
  PolygonRestClient,
  assertSupportedInterval,
  normalizeUsSymbol,
  parseIntervalMs,
  toPolygonTimespan,
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

describe('PolygonRestClient 符号与周期映射', () => {
  it('用户给大小写与空格混杂的美股代码时归一化为大写', () => {
    // Given 用户给 'aapl' 与 ' TSLA ' 两种写法
    // When 归一化符号
    // Then 一律 trim + 大写
    expect(normalizeUsSymbol('aapl')).toBe('AAPL')
    expect(normalizeUsSymbol(' TSLA ')).toBe('TSLA')
  })

  it('用户读周期词汇表与 Polygon timespan 时受支持档位在表内且映射到位', () => {
    // Given 本包导出的周期词汇表与 timespan 映射函数
    // When 查 5m/1h 是否在表内并逐档映射 1m/5m/1h/1d
    // Then 在表内且依次为 minute×1、minute×5、hour×1、day×1
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1h')
    expect(toPolygonTimespan('1m')).toEqual({ multiplier: 1, timespan: 'minute' })
    expect(toPolygonTimespan('5m')).toEqual({ multiplier: 5, timespan: 'minute' })
    expect(toPolygonTimespan('1h')).toEqual({ multiplier: 1, timespan: 'hour' })
    expect(toPolygonTimespan('1d')).toEqual({ multiplier: 1, timespan: 'day' })
  })

  it('用户看到的周期词汇表恰为 Polygon 上游声明的 9 档', () => {
    // Given 本包声明的周期词汇表
    // When 读 INTERVAL_VOCABULARY
    // Then 恰好 9 档；3m/2h/6h/8h/12h/3d 都不在表内
    expect(INTERVAL_VOCABULARY).toEqual(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'])
  })

  it('用户按受支持周期取数时 9 档逐档映射到 Polygon timespan', () => {
    // Given 9 档受支持周期
    // When 逐档求上游 aggregates 的 multiplier/timespan
    // Then 每档一一对应，没有一档落到别的粒度
    expect(toPolygonTimespan('1m')).toEqual({ multiplier: 1, timespan: 'minute' })
    expect(toPolygonTimespan('5m')).toEqual({ multiplier: 5, timespan: 'minute' })
    expect(toPolygonTimespan('15m')).toEqual({ multiplier: 15, timespan: 'minute' })
    expect(toPolygonTimespan('30m')).toEqual({ multiplier: 30, timespan: 'minute' })
    expect(toPolygonTimespan('1h')).toEqual({ multiplier: 1, timespan: 'hour' })
    expect(toPolygonTimespan('4h')).toEqual({ multiplier: 4, timespan: 'hour' })
    expect(toPolygonTimespan('1d')).toEqual({ multiplier: 1, timespan: 'day' })
    expect(toPolygonTimespan('1w')).toEqual({ multiplier: 1, timespan: 'week' })
    expect(toPolygonTimespan('1M')).toEqual({ multiplier: 1, timespan: 'month' })
  })

  it('用户按受支持周期取数时 9 档逐档给出名义步长', () => {
    // Given 9 档受支持周期
    // When 逐档求名义毫秒步长（只用于推算取数窗口下界与 closeTime）
    // Then 分钟/小时/日/周/月四族步长逐档对应
    expect(parseIntervalMs('1m')).toBe(60 * 1000)
    expect(parseIntervalMs('5m')).toBe(5 * 60 * 1000)
    expect(parseIntervalMs('15m')).toBe(15 * 60 * 1000)
    expect(parseIntervalMs('30m')).toBe(30 * 60 * 1000)
    expect(parseIntervalMs('1h')).toBe(60 * 60 * 1000)
    expect(parseIntervalMs('4h')).toBe(4 * 60 * 60 * 1000)
    expect(parseIntervalMs('1d')).toBe(24 * 60 * 60 * 1000)
    expect(parseIntervalMs('1w')).toBe(7 * 24 * 60 * 60 * 1000)
    expect(parseIntervalMs('1M')).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('用户请求表外周期时映射与步长都抛码，不静默降级', () => {
    // Given 6 档规范 Interval 联合里可表达、但本包声明集之外的周期
    const unsupported: Interval[] = ['3m', '2h', '6h', '8h', '12h', '3d']
    // When 逐档求 timespan 与名义步长
    // Then 两处都以 TRADING_UNSUPPORTED_INTERVAL 拒绝，闸门本身同样拒绝，表内周期不受影响
    for (const x of unsupported) {
      expect(() => toPolygonTimespan(x)).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
      expect(() => parseIntervalMs(x)).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
      expect(() => assertSupportedInterval(x)).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
    }
    expect(() => assertSupportedInterval('1d')).not.toThrow()
  })
})

describe('PolygonRestClient.getTicker', () => {
  it('用户取报价时按 /prev 上一交易日聚合解析，不是最新快照', async () => {
    // Given 注入式 fetch 返回 /v2/aggs/ticker/AAPL/prev 一行
    // When 取该标的报价
    // Then 打该端点带 apiKey，price/volume/timestamp 全部来自该聚合行
    const { impl, urls } = stubFetch([
      {
        match: '/v2/aggs/ticker/AAPL/prev',
        body: {
          ticker: 'AAPL',
          resultsCount: 1,
          results: [
            {
              T: 'AAPL',
              c: 220.5,
              h: 221.0,
              l: 219.5,
              o: 220.0,
              v: 50000000,
              t: 1725000000000,
            },
          ],
        },
      },
    ])
    const client = new PolygonRestClient({ fetchImpl: impl, apiKey: 'test-key' })
    const ticker = await client.getTicker('AAPL')

    expect(urls[0]).toContain('/v2/aggs/ticker/AAPL/prev')
    expect(urls[0]).toContain('apiKey=test-key')
    expect(ticker).toEqual({
      symbol: 'AAPL',
      price: 220.5,
      volume: 50000000,
      timestamp: 1725000000000,
    })
  })

  it('用户取上一交易日收盘聚合时 /prev 结果按毫秒直通', async () => {
    // Given 注入式 fetch 按 URL 匹配返回官方 /prev 示例响应（复权收盘价 + 毫秒窗口时间）
    const { impl, urls } = stubFetch([
      {
        match: '/v2/aggs/ticker/AAPL/prev',
        body: {
          ticker: 'AAPL',
          resultsCount: 1,
          results: [
            { T: 'AAPL', c: 115.97, h: 117.59, l: 114.13, o: 115.55, t: 1605042000000, v: 131704427 },
          ],
        },
      },
    ])
    const client = new PolygonRestClient({ apiKey: 'k', fetchImpl: impl })
    // When 取价
    const ticker = await client.getTicker('AAPL')
    // Then 打到 /prev；price 取收盘聚合价、volume 取当日量、timestamp 是窗口起点毫秒（未乘 1000 也未除 1000）
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('/v2/aggs/ticker/AAPL/prev')
    expect(ticker.price).toBe(115.97)
    expect(ticker.timestamp).toBe(1605042000000)
    expect(ticker.volume).toBe(131704427)
  })
})

describe('PolygonRestClient.getKlines', () => {
  it('用户取 5m 分钟线时打 range/5/minute 并归一为 K 线', async () => {
    // Given 注入式 fetch 返回 /v2/aggs/ticker/AAPL/range/5/minute
    // When 取 5m 分钟线
    // Then 打到该端点，OHLCV 与响应逐字段一致
    const { impl, urls } = stubFetch([
      {
        match: '/v2/aggs/ticker/AAPL/range/5/minute',
        body: {
          results: [
            {
              c: 220.5,
              h: 221.0,
              l: 219.5,
              o: 220.0,
              v: 250000,
              t: 1725000000000,
            },
          ],
        },
      },
    ])
    const client = new PolygonRestClient({ fetchImpl: impl })
    const klines = await client.getKlines('AAPL', '5m', 10)

    expect(urls[0]).toContain('/range/5/minute')
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({
      open: 220.0,
      close: 220.5,
      high: 221.0,
      low: 219.5,
      volume: 250000,
    })
  })

  it('用户请求 3m 时 getKlines 直接拒绝且一个上游请求都不发', async () => {
    // Given 一个记录请求 URL 的注入式 fetch（无任何路由，若被调用即抛错）
    const { impl, urls } = stubFetch([])
    const client = new PolygonRestClient({ fetchImpl: impl, apiKey: 'k' })
    // When 请求本包声明集之外的 3m
    // Then 抛 TRADING_UNSUPPORTED_INTERVAL，且一个请求都没发出——不拿上游报错当兜底
    await expect(client.getKlines('AAPL', '3m')).rejects.toThrowError(
      expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }),
    )
    expect(urls).toHaveLength(0)
  })
})

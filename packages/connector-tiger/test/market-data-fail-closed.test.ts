/**
 * connector-tiger 行情面的 **fail-closed** 用例（离线、契约化假网关、零 mock）。
 *
 * 背景：`getTicker` / `getKlines` 曾在上游失败时静默回落腾讯公开端点
 * （`qt.gtimg.cn` / `web.ifzq.gtimg.cn`），且 `code !== 0` 会返回 `price: 0` 的伪报价。
 * 本文件用假网关记录每次请求的 method 与 URL，断言失败路径只上报结构化错误码、
 * **绝不改打非老虎端点**（零跨源出网），正常路径的字段映射未被改坏。
 */
import { describe, expect, it } from 'vitest'
import { TigerRestClient, TradingServiceError } from '../src/rest.js'
import {
  FAKE_TIGER_BASE_URL,
  FAKE_TIGER_KLINES,
  FAKE_TIGER_TICKER,
  fakeTigerVenue,
  type FakeTigerVenue,
} from './fake-tiger-venue.js'

const SYMBOL = '00700.HK'

function clientFor(venue: FakeTigerVenue): TigerRestClient {
  // privateKey 显式置空串（不是 nullish，构造器不会回落环境变量）：行情两法本就不发 sign，
  // 用例也不该被机器上的 TIGER_PRIVATE_KEY 影响。
  return new TigerRestClient({ baseUrl: FAKE_TIGER_BASE_URL, privateKey: '', fetchImpl: venue.fetchImpl })
}

/** 把「resolve 还是 reject」都收进返回值，便于同时断言「没有成功回执」与错误码。 */
function outcomeOf<T>(run: () => Promise<T>): Promise<{ value?: T; failure?: TradingServiceError }> {
  return run().then(
    (value) => ({ value }),
    (failure: unknown) => ({ failure: failure as TradingServiceError }),
  )
}

/** 夹具记录里落到腾讯公开端点（gtimg.cn 家族）的 URL——零跨源回落应为空。 */
function tencentUrls(venue: FakeTigerVenue): readonly string[] {
  return venue.httpCalls().map((call) => call.url).filter((url) => url.includes('gtimg.cn'))
}

describe('connector-tiger 行情面 fail-closed（零跨源回落）', () => {
  it('用户 网关不可达时 getTicker 上报网络错误且零跨源出网', async () => {
    // Given 一个连接层直接失败的契约化假网关
    const venue = fakeTigerVenue({ outcome: 'outage' })
    // When 取实时报价
    const { value, failure } = await outcomeOf(() => clientFor(venue).getTicker(SYMBOL))
    // Then 只上报 TRADING_NETWORK，且唯一一次出网打在老虎网关，没有任何腾讯端点
    expect(value).toBeUndefined()
    expect(failure).toBeInstanceOf(TradingServiceError)
    expect(failure?.code).toBe('TRADING_NETWORK')
    expect(venue.httpCalls().map((call) => call.url)).toEqual([FAKE_TIGER_BASE_URL])
    expect(tencentUrls(venue)).toEqual([])
  })

  it('用户 网关回非 2xx 时 getTicker 上报上游错误且零跨源出网', async () => {
    // Given 一个回 500 的契约化假网关
    const venue = fakeTigerVenue({ outcome: 'http-error' })
    // When 取实时报价
    const { value, failure } = await outcomeOf(() => clientFor(venue).getTicker(SYMBOL))
    // Then 只上报 TRADING_UPSTREAM_ERROR（HTTP 状态随消息带出），不回落腾讯
    expect(value).toBeUndefined()
    expect(failure?.code).toBe('TRADING_UPSTREAM_ERROR')
    expect(failure?.message).toContain('500')
    expect(venue.httpCalls().map((call) => call.url)).toEqual([FAKE_TIGER_BASE_URL])
    expect(tencentUrls(venue)).toEqual([])
  })

  it('用户 网关回业务码非 0 时 getTicker 抛交易所错误而不是价格 0', async () => {
    // Given 一个回 code 1200 的契约化假网关
    const venue = fakeTigerVenue({ outcome: 'biz-error' })
    // When 取实时报价
    const { value, failure } = await outcomeOf(() => clientFor(venue).getTicker(SYMBOL))
    // Then 抛 TRADING_EXCHANGE_ERROR 并带上游 message；没有成功回执，也就不会有 price 0
    expect(value).toBeUndefined()
    expect(failure?.code).toBe('TRADING_EXCHANGE_ERROR')
    expect(failure?.message).toContain('Tiger getTicker failed')
    expect(failure?.message).toContain('invalid parameter')
    expect(tencentUrls(venue)).toEqual([])
  })

  it('用户 网关不可达时 getKlines 上报网络错误且零跨源出网', async () => {
    // Given 一个连接层直接失败的契约化假网关
    const venue = fakeTigerVenue({ outcome: 'outage' })
    // When 取日线
    const { value, failure } = await outcomeOf(() => clientFor(venue).getKlines(SYMBOL))
    // Then 只上报 TRADING_NETWORK，且记录里只有老虎网关这一条出网
    expect(value).toBeUndefined()
    expect(failure?.code).toBe('TRADING_NETWORK')
    expect(venue.httpCalls().map((call) => call.url)).toEqual([FAKE_TIGER_BASE_URL])
    expect(tencentUrls(venue)).toEqual([])
  })

  it('用户 正常取行情时报价与 K 线逐字段等于假网关返回值', async () => {
    // Given 一个按契约回正常数据的假网关
    const venue = fakeTigerVenue()
    const client = clientFor(venue)
    // When 取一次实时报价与两根日线
    const ticker = await client.getTicker(SYMBOL)
    const klines = await client.getKlines(SYMBOL, '1d', 2)
    // Then 报价字段逐个相等
    expect(ticker.symbol).toBe(SYMBOL)
    expect(ticker.price).toBe(FAKE_TIGER_TICKER.latestPrice)
    expect(ticker.volume).toBe(FAKE_TIGER_TICKER.volume)
    expect(ticker.timestamp).toBe(FAKE_TIGER_TICKER.timestamp)
    // Then K 线逐根、逐字段相等（closeTime 仍是 openTime + 一天 - 1 ms）
    expect(klines).toHaveLength(FAKE_TIGER_KLINES.length)
    FAKE_TIGER_KLINES.forEach((bar, index) => {
      expect(klines[index]).toEqual({
        openTime: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        closeTime: bar.time + 86400000 - 1,
      })
    })
    // Then 两次请求都打在老虎网关的对应 method 上，且 period/limit 仍原样透传
    expect(venue.httpCalls().map((call) => call.method)).toEqual(['quote_real_time', 'kline_quote'])
    expect(venue.httpCalls().map((call) => call.url)).toEqual([FAKE_TIGER_BASE_URL, FAKE_TIGER_BASE_URL])
    expect(venue.requests()[1]).toEqual({ symbols: ['00700'], period: '1d', limit: 2 })
    expect(tencentUrls(venue)).toEqual([])
  })

  it('用户 用 1m 周期且网关不可达时抛错而不是返回日线回落 bar', async () => {
    // Given 一个连接层直接失败的契约化假网关
    const venue = fakeTigerVenue({ outcome: 'outage' })
    // When 取 1 分钟线
    const { value, failure } = await outcomeOf(() => clientFor(venue).getKlines(SYMBOL, '1m', 5))
    // Then 抛 TRADING_NETWORK；出网只有 kline_quote 一条，没有第二条日线端点请求
    expect(value).toBeUndefined()
    expect(failure?.code).toBe('TRADING_NETWORK')
    expect(venue.httpCalls()).toHaveLength(1)
    expect(venue.httpCalls()[0]?.method).toBe('kline_quote')
    expect(tencentUrls(venue)).toEqual([])
  })

  it('客户 网关回 code 0 但没有报价行时 getTicker 抛交易所错误而不是价格 0', async () => {
    // Given 一个回 code 0 + 空 data 的契约化假网关
    const venue = fakeTigerVenue({ outcome: 'empty' })
    // When 取实时报价
    const { value, failure } = await outcomeOf(() => clientFor(venue).getTicker(SYMBOL))
    // Then 抛 TRADING_EXCHANGE_ERROR，消息带符号与回包摘要；没有成功回执
    expect(value).toBeUndefined()
    expect(failure?.code).toBe('TRADING_EXCHANGE_ERROR')
    expect(failure?.message).toContain(SYMBOL)
    expect(failure?.message).toContain('"code":0')
    expect(tencentUrls(venue)).toEqual([])
  })

  it('访客 网关回明确的空序列时 getKlines 返回空数组', async () => {
    // Given 一个回 code 0 + 空 data 的契约化假网关
    const venue = fakeTigerVenue({ outcome: 'empty' })
    // When 取日线
    const klines = await clientFor(venue).getKlines(SYMBOL)
    // Then 空序列是合法空值（不是错误），也没有跨源出网
    expect(klines).toEqual([])
    expect(venue.httpCalls().map((call) => call.url)).toEqual([FAKE_TIGER_BASE_URL])
    expect(tencentUrls(venue)).toEqual([])
  })

  it('运营 K 线回包没有 items 数组时抛交易所错误而不是空序列', async () => {
    // Given 一个回 code 0 但 data 里没有 items 的契约化假网关
    const venue = fakeTigerVenue({ outcome: 'malformed' })
    // When 取日线
    const { value, failure } = await outcomeOf(() => clientFor(venue).getKlines(SYMBOL))
    // Then 形状不可识别一律抛错，不当成「没有 K 线」
    expect(value).toBeUndefined()
    expect(failure?.code).toBe('TRADING_EXCHANGE_ERROR')
    expect(failure?.message).toContain('items')
    expect(tencentUrls(venue)).toEqual([])
  })
})

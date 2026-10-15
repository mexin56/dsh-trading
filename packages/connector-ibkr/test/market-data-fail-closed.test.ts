/**
 * 行情面的 **fail-closed** 用例（IBKR；离线、契约化假网关、零跨源出网）。
 *
 * 不变量：IBKR 行情只认用户本机的 Client Portal Gateway 一个源。网关失败即失败
 * （TRADING_NETWORK / TRADING_UPSTREAM_ERROR），网关 200 但回包形状不可识别或无可用
 * 价格即报 TRADING_EXCHANGE_ERROR——绝不改打 Yahoo 之类的公共源，也绝不回 0/NaN 的伪行情。
 * 夹具逐条记录收到的 URL，用例据此对「零跨源出网」下断言。
 */
import { describe, expect, it } from 'vitest'
import { IbkrRestClient } from '../src/index.js'
import { FAKE_IBKR_GATEWAY_URL, fakeIbkrVenue, type FakeIbkrVenue } from './fake-ibkr-venue.js'

const GATEWAY = FAKE_IBKR_GATEWAY_URL

function client(venue: FakeIbkrVenue): IbkrRestClient {
  return new IbkrRestClient({ gatewayUrl: GATEWAY, fetchImpl: venue.fetchImpl })
}

async function errorOf(run: () => Promise<unknown>): Promise<{ code?: string; message?: string }> {
  return run().then(() => ({}), (error: unknown) => error as { code?: string; message?: string })
}

/** 零跨源出网的判据：夹具收到的每一个 URL 都必须落在假网关地址下。 */
function crossSourceUrls(venue: FakeIbkrVenue): readonly string[] {
  return venue.urls().filter((url) => !url.startsWith(`${GATEWAY}/`))
}

describe('IBKR 行情面 fail-closed（零跨源回落）', () => {
  it('用户 网关不可达时取快照价：报 TRADING_NETWORK 且零跨源出网', async () => {
    // Given 一个连接被拒的假网关
    const venue = fakeIbkrVenue({ outcome: 'outage' })
    const market = client(venue)
    // When 取快照价
    const failure = await errorOf(() => market.getTicker('AAPL'))
    // Then 连接器网络错误，且只打过网关这一个地址
    expect(failure.code).toBe('TRADING_NETWORK')
    expect(venue.urls()).toHaveLength(1)
    expect(venue.urls().some((url) => url.includes('finance.yahoo.com'))).toBe(false)
    expect(crossSourceUrls(venue)).toEqual([])
  })

  it('用户 网关回非 2xx 时取快照价：报 TRADING_UPSTREAM_ERROR 且零跨源出网', async () => {
    // Given 一个回 500 的假网关
    const venue = fakeIbkrVenue({ outcome: 'http-error' })
    const market = client(venue)
    // When 取快照价
    const failure = await errorOf(() => market.getTicker('AAPL'))
    // Then 上游错误，且没有改打别的源
    expect(failure.code).toBe('TRADING_UPSTREAM_ERROR')
    expect(failure.message).toContain('500')
    expect(venue.urls()).toEqual([`${GATEWAY}/iserver/marketdata/snapshot?symbols=AAPL&fields=31,84,86`])
    expect(crossSourceUrls(venue)).toEqual([])
  })

  it('用户 网关回 200 但快照为空数组：报 TRADING_EXCHANGE_ERROR 并带原样回包', async () => {
    // Given 一个 200 但快照为空的假网关
    const venue = fakeIbkrVenue({ outcome: 'empty-snapshot' })
    const market = client(venue)
    // When 取快照价
    const failure = await errorOf(() => market.getTicker('AAPL'))
    // Then 交易所错误，绝不回 0 价
    expect(failure.code).toBe('TRADING_EXCHANGE_ERROR')
    expect(failure.message).toContain('AAPL')
    expect(failure.message).toContain('[]')
    expect(crossSourceUrls(venue)).toEqual([])
  })

  it('用户 网关回 200 但 31 字段非数值：报 TRADING_EXCHANGE_ERROR 并带原样回包', async () => {
    // Given 一个 200 但最新价字段是 "n/a" 的假网关
    const venue = fakeIbkrVenue({ outcome: 'no-price' })
    const market = client(venue)
    // When 取快照价
    const failure = await errorOf(() => market.getTicker('AAPL'))
    // Then 交易所错误，绝不回 NaN
    expect(failure.code).toBe('TRADING_EXCHANGE_ERROR')
    expect(failure.message).toContain('AAPL')
    expect(failure.message).toContain('"31":"n/a"')
    expect(crossSourceUrls(venue)).toEqual([])
  })

  it('用户 网关回 200 但 31 为 "0"：报 TRADING_EXCHANGE_ERROR 而不是 0 价行情', async () => {
    // Given 一个 200 但最新价字段是 "0" 的假网关
    const venue = fakeIbkrVenue({ outcome: 'zero-price' })
    const market = client(venue)
    // When 取快照价
    const failure = await errorOf(() => market.getTicker('AAPL'))
    // Then 交易所错误：0 不是可用价格
    expect(failure.code).toBe('TRADING_EXCHANGE_ERROR')
    expect(failure.message).toContain('"31":"0"')
    expect(crossSourceUrls(venue)).toEqual([])
  })

  it('用户 网关不可达时取 K 线：报 TRADING_NETWORK 且零跨源出网', async () => {
    // Given 一个连接被拒的假网关
    const venue = fakeIbkrVenue({ outcome: 'outage' })
    const market = client(venue)
    // When 取日线序列
    const failure = await errorOf(() => market.getKlines('AAPL', '1d', 100))
    // Then 网络错误，且没有回落到任何公共源
    expect(failure.code).toBe('TRADING_NETWORK')
    expect(venue.urls()).toEqual([`${GATEWAY}/hmds/history?symbol=AAPL&period=100d&bar=1d`])
    expect(venue.urls().some((url) => url.includes('finance.yahoo.com'))).toBe(false)
    expect(crossSourceUrls(venue)).toEqual([])
  })

  it('用户 正常取行情：快照价与 K 线各字段与网关返回值逐字段一致', async () => {
    // Given 一个正常应答的假网关
    const venue = fakeIbkrVenue({ outcome: 'ack' })
    const market = client(venue)
    // When 依次取快照价与日线序列
    const ticker = await market.getTicker('AAPL')
    const bars = await market.getKlines('AAPL', '1d', 100)
    // Then 快照价原样、K 线逐字段按既有映射返回，且请求端点未变
    expect(ticker.symbol).toBe('AAPL')
    expect(ticker.price).toBe(190.25)
    expect(ticker.timestamp).toBeGreaterThan(0)
    expect(bars).toHaveLength(2)
    expect(bars[0]).toEqual({
      openTime: 1735689600000,
      open: 190.1,
      high: 191.9,
      low: 189.5,
      close: 191.2,
      volume: 1200000,
      closeTime: 1735689600000 + 86400000 - 1,
    })
    expect(bars[1]).toEqual({
      openTime: 1735776000000,
      open: 191.2,
      high: 192.0,
      low: 190.0,
      close: 190.4,
      volume: 980000,
      closeTime: 1735776000000 + 86400000 - 1,
    })
    expect(venue.urls()).toEqual([
      `${GATEWAY}/iserver/marketdata/snapshot?symbols=AAPL&fields=31,84,86`,
      `${GATEWAY}/hmds/history?symbol=AAPL&period=100d&bar=1d`,
    ])
  })

  it('用户 用 1m 周期且网关不可达：报错而不是回落到日线 bar', async () => {
    // Given 一个连接被拒的假网关
    const venue = fakeIbkrVenue({ outcome: 'outage' })
    const market = client(venue)
    // When 取 1 分钟序列
    const failure = await errorOf(() => market.getKlines('AAPL', '1m', 5))
    // Then 报网络错误；请求只有这一条，周期原样透传，没有任何别源或日线兜底
    expect(failure.code).toBe('TRADING_NETWORK')
    expect(venue.urls()).toEqual([`${GATEWAY}/hmds/history?symbol=AAPL&period=5d&bar=1m`])
    expect(crossSourceUrls(venue)).toEqual([])
  })

  it('用户 网关历史回包不是 bar 数组：报 TRADING_EXCHANGE_ERROR 并带原样回包', async () => {
    // Given 一个 200 但 data 不是数组的假网关
    const venue = fakeIbkrVenue({ outcome: 'bad-history' })
    const market = client(venue)
    // When 取日线序列
    const failure = await errorOf(() => market.getKlines('AAPL', '1d', 100))
    // Then 交易所错误，回包形状不可识别不静默成空序列
    expect(failure.code).toBe('TRADING_EXCHANGE_ERROR')
    expect(failure.message).toContain('"data":null')
    expect(crossSourceUrls(venue)).toEqual([])
  })

  it('用户 网关历史回包是空数组：返回空序列而不是错误', async () => {
    // Given 一个 200 且该序列确实无数据的假网关
    const venue = fakeIbkrVenue({ outcome: 'empty-history' })
    const market = client(venue)
    // When 取日线序列
    const bars = await market.getKlines('AAPL', '1d', 100)
    // Then 合法的空值原样返回，且不触发任何跨源请求
    expect(bars).toEqual([])
    expect(venue.urls()).toEqual([`${GATEWAY}/hmds/history?symbol=AAPL&period=100d&bar=1d`])
    expect(crossSourceUrls(venue)).toEqual([])
  })
})

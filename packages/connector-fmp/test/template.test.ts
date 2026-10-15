import { describe, expect, it } from 'vitest'
import {
  FmpRestClient,
  INTERVAL_VOCABULARY,
  normalizeUsSymbol,
  parseIntervalMs,
  toFmpInterval,
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

describe('FmpRestClient 符号与周期映射', () => {
  it('美股代码归一化', () => {
    expect(normalizeUsSymbol('aapl')).toBe('AAPL')
    expect(normalizeUsSymbol(' TSLA ')).toBe('TSLA')
  })

  it('支持的 interval 词汇与 FMP 周期映射', () => {
    expect(INTERVAL_VOCABULARY).toContain('5m')
    expect(INTERVAL_VOCABULARY).toContain('1h')
    expect(toFmpInterval('5m')).toBe('5min')
    expect(toFmpInterval('1h')).toBe('1hour')
    expect(toFmpInterval('4h')).toBe('4hour')
  })

  it('用户看到的周期词汇表恰为 FMP 真实支持的 7 档', () => {
    // Given FMP 上游只有 6 个日内档（/historical-chart）与日线 EOD（/historical-price-full）
    // When 读本包导出的周期词汇表
    // Then 恰好这 7 档，周/月与 3m/2h/6h/8h/12h/3d 都不在表内
    expect(INTERVAL_VOCABULARY).toEqual(['1m', '5m', '15m', '30m', '1h', '4h', '1d'])
  })

  it('用户按受支持周期取数时 7 档逐档映射到 FMP 周期词', () => {
    // Given 7 档受支持周期
    // When 逐档映射到上游 /historical-chart 或 EOD 的周期词
    // Then 每档一一对应，无一档落到日线
    expect(toFmpInterval('1m')).toBe('1min')
    expect(toFmpInterval('5m')).toBe('5min')
    expect(toFmpInterval('15m')).toBe('15min')
    expect(toFmpInterval('30m')).toBe('30min')
    expect(toFmpInterval('1h')).toBe('1hour')
    expect(toFmpInterval('4h')).toBe('4hour')
    expect(toFmpInterval('1d')).toBe('1day')
  })

  it('用户请求表外周期时映射与步长都抛码，不静默回落日线', () => {
    // Given 8 档规范 Interval 联合里可表达、但 FMP 上游没有的周期
    const unsupported: Interval[] = ['3m', '2h', '6h', '8h', '12h', '3d', '1w', '1M']
    // When 逐档求 FMP 周期词与名义步长
    // Then 两处都以 TRADING_UNSUPPORTED_INTERVAL 拒绝
    for (const x of unsupported) {
      expect(() => toFmpInterval(x)).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
      expect(() => parseIntervalMs(x)).toThrowError(expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }))
    }
  })
})

describe('FmpRestClient.getTicker', () => {
  it('拉取并解析美股 Quote', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/quote/AAPL',
        body: [
          {
            symbol: 'AAPL',
            price: 220.5,
            volume: 45000000,
            timestamp: 1725000000,
          },
        ],
      },
    ])
    const client = new FmpRestClient({ fetchImpl: impl, apiKey: 'test-key' })
    const ticker = await client.getTicker('AAPL')

    expect(urls[0]).toContain('/quote/AAPL')
    expect(urls[0]).toContain('apikey=test-key')
    expect(ticker).toEqual({
      symbol: 'AAPL',
      price: 220.5,
      volume: 45000000,
      timestamp: 1725000000000,
    })
  })
})

describe('FmpRestClient.getKlines', () => {
  it('拉取日内 5m 分钟 K 线', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/historical-chart/5min/AAPL',
        body: [
          {
            date: '2026-08-31 09:35:00',
            open: 220.0,
            low: 219.8,
            high: 221.2,
            close: 221.0,
            volume: 150000,
          },
        ],
      },
    ])
    const client = new FmpRestClient({ fetchImpl: impl })
    const klines = await client.getKlines('AAPL', '5m', 10)

    expect(urls[0]).toContain('/historical-chart/5min/AAPL')
    expect(klines).toHaveLength(1)
    expect(klines[0]).toMatchObject({
      open: 220.0,
      close: 221.0,
      high: 221.2,
      low: 219.8,
      volume: 150000,
    })
  })

  it('用户请求 1w 时 getKlines 直接拒绝且一个上游请求都不发', async () => {
    // Given 一个记录请求 URL 的注入式 fetch（无任何路由，若被调用即抛错）
    const { impl, urls } = stubFetch([])
    const client = new FmpRestClient({ fetchImpl: impl, apiKey: 'k' })
    // When 请求上游没有的周线周期
    // Then 抛 TRADING_UNSUPPORTED_INTERVAL，且一个请求都没发出——不静默落到日线端点
    await expect(client.getKlines('AAPL', '1w')).rejects.toThrowError(
      expect.objectContaining({ code: 'TRADING_UNSUPPORTED_INTERVAL' }),
    )
    expect(urls).toHaveLength(0)
  })
})

describe('FmpRestClient.getProfile', () => {
  it('获取公司基本面 Profile', async () => {
    const { impl, urls } = stubFetch([
      {
        match: '/profile/AAPL',
        body: [
          {
            symbol: 'AAPL',
            companyName: 'Apple Inc.',
            industry: 'Consumer Electronics',
            sector: 'Technology',
            mktCap: 3400000000000,
          },
        ],
      },
    ])
    const client = new FmpRestClient({ fetchImpl: impl })
    const profile = await client.getProfile('AAPL')

    expect(urls[0]).toContain('/profile/AAPL')
    expect(profile.companyName).toBe('Apple Inc.')
  })
})

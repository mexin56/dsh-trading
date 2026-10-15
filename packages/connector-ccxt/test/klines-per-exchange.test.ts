/**
 * K 线**按所切换**（2026-10-15 起九所直连分支）。
 *
 * 九所各有自己的 K 线端点、周期词汇（分钟数 / 秒数 / 所内词）与行结构；本组用例守卫四件事：
 * ① 逐所一条日线请求：打自己的端点、周期参数按所映射、行按所解析并归一成**升序（旧→新）**；
 * ② 该所不支持的周期（coinbase 的 30m/4h/1w/1M、gateio/kucoin 的 1M，以及词汇表外取值）
 *   在 fetch 之前抛 `TRADING_UNSUPPORTED_INTERVAL` 且**零请求**；
 * ③ 周期映射的具名判据（kraken 分钟数、coinbase 秒数、htx 1mon、gateio 7d、okx utc 变体…）；
 * ④ 单请求根数按该所上限裁剪，无根数参数的上游（kucoin/kraken/coinbase）在本地切成 limit 根。
 *
 * fetch 走契约化注入缝（本仓零 mock 纪律），夹具形状全部取自真实原始响应
 * （spikes/impl-ccxt-exchange-expansion/klines-*.json）。
 */
import { describe, expect, it } from 'vitest'
import { CcxtRestClient, klineIntervalParam, klineSupportedIntervals } from '../src/rest.ts'

const DAY = 86_400_000
const T1 = 1_725_000_000_000
const T2 = T1 + DAY

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stubFetch(body: unknown): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    urls.push(String(input))
    return jsonResponse(body)
  }) as typeof fetch
  return { impl, urls }
}

/** 任何请求都会失败的注入缝：用来证明被拒的周期根本没发出网络请求。 */
function forbiddenFetch(): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    urls.push(String(input))
    throw new Error('no request expected for an interval this venue does not support')
  }) as typeof fetch
  return { impl, urls }
}

/** 升序期望行：closeTime = openTime + 1d - 1（binance 用上游回传的 closeTime，两者同值）。 */
const EXPECTED = [
  { openTime: T1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 5, closeTime: T1 + DAY - 1 },
  { openTime: T2, open: 2, high: 3, low: 1, close: 2.5, volume: 10, closeTime: T2 + DAY - 1 },
]

/** 逐所夹具：行结构按该所真实响应形状，且**故意有的所新→旧、有的所旧→新**。 */
const VENUES: Record<string, { fragment: string; body: unknown }> = {
  binance: {
    fragment: 'api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=10',
    body: [
      [T1, '1', '2', '0.5', '1.5', '5', T1 + DAY - 1],
      [T2, '2', '3', '1', '2.5', '10', T2 + DAY - 1],
    ],
  },
  okx: {
    fragment: 'www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1Dutc&limit=10',
    body: {
      code: '0',
      data: [
        [String(T2), '2', '3', '1', '2.5', '10', '0', '0', '1'],
        [String(T1), '1', '2', '0.5', '1.5', '5', '0', '0', '1'],
      ],
    },
  },
  bybit: {
    fragment: 'api.bybit.com/v5/market/kline?category=spot&symbol=BTCUSDT&interval=D&limit=10',
    body: {
      retCode: 0,
      result: {
        list: [
          [String(T2), '2', '3', '1', '2.5', '10', 'x'],
          [String(T1), '1', '2', '0.5', '1.5', '5', 'x'],
        ],
      },
    },
  },
  gateio: {
    // 行结构 [秒级 ts, 计价量, close, high, low, open, 基础量, windowClosed]
    fragment: 'api.gateio.ws/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=1d&limit=10',
    body: [
      [String(T2 / 1000), 'q', '2.5', '3', '1', '2', '10', 'true'],
      [String(T1 / 1000), 'q', '1.5', '2', '0.5', '1', '5', 'true'],
    ],
  },
  kucoin: {
    // 行结构 [秒级 ts, open, close, high, low, 基础量, 计价量]
    fragment: 'api.kucoin.com/api/v1/market/candles?symbol=BTC-USDT&type=1day',
    body: {
      code: '200000',
      data: [
        [String(T2 / 1000), '2', '2.5', '3', '1', '10', 'q'],
        [String(T1 / 1000), '1', '1.5', '2', '0.5', '5', 'q'],
      ],
    },
  },
  kraken: {
    // 行结构 [秒级 ts, open, high, low, close, vwap, 基础量, count]；result 里还有 last 数字
    fragment: 'api.kraken.com/0/public/OHLC?pair=XBTUSDT&interval=1440',
    body: {
      error: [],
      result: {
        XBTUSDT: [
          [T1 / 1000, '1', '2', '0.5', '1.5', '1.2', '5', '3'],
          [T2 / 1000, '2', '3', '1', '2.5', '2', '10', '4'],
        ],
        last: T2 / 1000,
      },
    },
  },
  coinbase: {
    // 行结构 [秒级 ts, low, high, open, close, 基础量]
    fragment: 'api.exchange.coinbase.com/products/BTC-USDT/candles?granularity=86400',
    body: [
      [T2 / 1000, 1, 3, 2, 2.5, 10],
      [T1 / 1000, 0.5, 2, 1, 1.5, 5],
    ],
  },
  bitfinex: {
    // 行结构 [毫秒级 mts, open, close, high, low, 基础量]
    fragment: 'api-pub.bitfinex.com/v2/candles/trade:1D:tBTCUST/hist?limit=10',
    body: [
      [T2, '2', '2.5', '3', '1', '10'],
      [T1, '1', '1.5', '2', '0.5', '5'],
    ],
  },
  htx: {
    fragment: 'api.htx.com/market/history/kline?symbol=btcusdt&period=1day&size=10',
    body: {
      status: 'ok',
      data: [
        { id: T2 / 1000, open: 2, close: 2.5, low: 1, high: 3, amount: 10 },
        { id: T1 / 1000, open: 1, close: 1.5, low: 0.5, high: 2, amount: 5 },
      ],
    },
  },
}

describe('CCXT K 线按所切换', () => {
  it('用户按所请求日线时九所各自打自己的 K 线端点、按所解析并归一成升序序列', async () => {
    // Given 九所各自真实行结构的最小夹具（有的所新→旧、有的所旧→新）与 1d / limit=10
    // When 用户逐个所请求同一对 BTCUSDT 的日线
    // Then 每所只发一条请求、命中自己的端点与周期参数，且解析结果一律升序、字段与量同口径
    for (const [exchange, venue] of Object.entries(VENUES)) {
      const stub = stubFetch(venue.body)
      const rows = await new CcxtRestClient({ exchange, fetchImpl: stub.impl }).getKlines('BTCUSDT', '1d', 10, exchange)
      expect(stub.urls).toHaveLength(1)
      expect(stub.urls[0]).toContain(venue.fragment)
      expect(rows).toEqual(EXPECTED)
    }
  })

  it('用户请求某所不支持的周期时在发请求之前零请求拒绝', async () => {
    // Given 任何请求都会失败的注入缝 + 逐所实测不支持的周期（coinbase 30m/4h/1w/1M、gateio/kucoin 1M）
    const { impl, urls } = forbiddenFetch()
    const client = new CcxtRestClient({ fetchImpl: impl })
    const unsupported: Array<[string, string]> = [
      ['coinbase', '30m'],
      ['coinbase', '4h'],
      ['coinbase', '1w'],
      ['coinbase', '1M'],
      ['gateio', '1M'],
      ['kucoin', '1M'],
    ]
    // When 用户逐个请求这些「词汇表内但该所没有」的周期，并额外请求一个词汇表外的 8h
    const rejected = []
    for (const [exchange, interval] of unsupported) {
      rejected.push(await client.getKlines('BTCUSDT', interval as never, 10, exchange).catch((e: unknown) => e as Error & { code?: string }))
    }
    const outOfVocabulary = await client.getKlines('BTCUSDT', '8h' as never, 10, 'binance').catch((e: unknown) => e as Error & { code?: string })
    // Then 七次都报 TRADING_UNSUPPORTED_INTERVAL（文案点名该所支持的周期），且一条请求都没发
    expect(rejected).toHaveLength(unsupported.length)
    for (const err of rejected) {
      expect(err).toMatchObject({ code: 'TRADING_UNSUPPORTED_INTERVAL' })
      expect(String(err?.message)).toContain('no network request was made')
    }
    expect(String(rejected[0]?.message)).toContain('coinbase supports 1m/5m/15m/1h/1d')
    expect(outOfVocabulary).toMatchObject({ code: 'TRADING_UNSUPPORTED_INTERVAL' })
    expect(urls).toHaveLength(0)
  })

  it('用户查各所周期映射时看到该所的上游参数词汇与支持集', () => {
    // Given 各所真实接受的上游周期词汇（原始响应见 spikes/impl-ccxt-exchange-expansion/）
    // When 用户查询各所的周期参数与支持集
    // Then 分钟数（kraken）、秒数（coinbase）、所内词（htx/gateio/kucoin/bybit/okx）逐条对得上
    expect(klineIntervalParam('kraken', '1w')).toBe('10080')
    expect(klineIntervalParam('kraken', '1M')).toBe('21600')
    expect(klineIntervalParam('kraken', '1h')).toBe('60')
    expect(klineIntervalParam('coinbase', '1m')).toBe('60')
    expect(klineIntervalParam('coinbase', '1d')).toBe('86400')
    expect(klineIntervalParam('gateio', '1w')).toBe('7d')
    expect(klineIntervalParam('kucoin', '1w')).toBe('1week')
    expect(klineIntervalParam('htx', '1M')).toBe('1mon')
    expect(klineIntervalParam('htx', '1h')).toBe('60min')
    expect(klineIntervalParam('bybit', '1h')).toBe('60')
    expect(klineIntervalParam('okx', '1d')).toBe('1Dutc')
    expect(klineIntervalParam('okx', '1M')).toBe('1Mutc')
    expect(klineIntervalParam('bitfinex', '1w')).toBe('1W')
    expect(klineIntervalParam('binance', '4h')).toBe('4h')
    expect([...klineSupportedIntervals('coinbase')]).toEqual(['1m', '5m', '15m', '1h', '1d'])
    expect([...klineSupportedIntervals('gateio')]).toEqual(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'])
    expect([...klineSupportedIntervals('binance')]).toHaveLength(9)
  })

  it('用户遇到上游错误信封或坏行时得到结构化语义而不是伪造 K 线', async () => {
    // Given 五个所的「错误信封」响应（okx code≠0 / kucoin code≠200000 / bybit retCode≠0 /
    //       htx status≠ok / kraken error 非空）与一个含坏行的 gateio 响应
    const envelopes: Array<[string, unknown]> = [
      ['okx', { code: '51001', data: [] }],
      ['kucoin', { code: '400100', data: [] }],
      ['bybit', { retCode: 10001, retMsg: 'params error', result: { list: [] } }],
      ['htx', { status: 'error', data: [] }],
      ['kraken', { error: ['EQuery:Unknown asset pair'], result: {} }],
    ]
    // When 用户逐个所请求 K 线
    // Then 每个都抛 TRADING_SYMBOL_NOT_FOUND（上游答了但没有这个标的），而不是返回空数组冒充「没有数据」
    for (const [exchange, body] of envelopes) {
      const stub = stubFetch(body)
      const err = await new CcxtRestClient({ exchange, fetchImpl: stub.impl })
        .getKlines('BTCUSDT', '1d', 5, exchange)
        .catch((e: unknown) => e as Error & { code?: string })
      expect(err).toMatchObject({ code: 'TRADING_SYMBOL_NOT_FOUND' })
      expect(String(err?.message)).toContain(exchange)
    }
    // Given 一条形状合法但含坏分量（close 为 null）的 gateio 行
    const malformed = stubFetch([
      [String(T2 / 1000), 'q', null, '3', '1', '2', '10', 'true'],
      [String(T1 / 1000), 'q', '1.5', '2', '0.5', '1', '5', 'true'],
    ])
    // When 用户请求该响应
    const rows = await new CcxtRestClient({ exchange: 'gateio', fetchImpl: malformed.impl }).getKlines('BTCUSDT', '1d', 5, 'gateio')
    // Then 坏行被丢弃、好行照常归一（丢行不猜值，也不整批失败）
    expect(rows).toEqual([{ openTime: T1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 5, closeTime: T1 + DAY - 1 }])
  })

  it('用户请求全量根数时拿到该所单请求上限内的全部升序序列', async () => {
    // Given 返回 3 根的 coinbase 夹具
    const stub = stubFetch([
      [T2 / 1000, 1, 3, 2, 2.5, 10],
      [T1 / 1000, 0.5, 2, 1, 1.5, 5],
      [(T1 - DAY) / 1000, 0.4, 1, 0.8, 0.9, 3],
    ])
    // When 用户用 limit=0 请求（<=0 = 要该所单请求上限内的全量）
    const rows = await new CcxtRestClient({ exchange: 'coinbase', fetchImpl: stub.impl }).getKlines('BTCUSDT', '1d', 0, 'coinbase')
    // Then 三根都在且升序（不裁剪）
    expect(rows.map((row) => row.openTime)).toEqual([T1 - DAY, T1, T2])
  })

  it('用户把 limit 交给连接器时单请求根数按该所上限裁剪、无根数参数的上游在本地切成 limit 根', async () => {
    // Given okx 上限 300 / binance 上限 1000 的夹具，与返回 3 根的 coinbase 夹具
    const okx = stubFetch({ code: '0', data: [] })
    const binance = stubFetch([])
    const coinbase = stubFetch([
      [T2 / 1000, 1, 3, 2, 2.5, 10],
      [T1 / 1000, 0.5, 2, 1, 1.5, 5],
      [(T1 - DAY) / 1000, 0.4, 1, 0.8, 0.9, 3],
    ])
    // When 用户请求 limit=5000（okx/binance）与 limit=2（coinbase）
    await new CcxtRestClient({ exchange: 'okx', fetchImpl: okx.impl }).getKlines('BTCUSDT', '1d', 5000, 'okx')
    await new CcxtRestClient({ exchange: 'binance', fetchImpl: binance.impl }).getKlines('BTCUSDT', '1d', 5000, 'binance')
    const tail = await new CcxtRestClient({ exchange: 'coinbase', fetchImpl: coinbase.impl }).getKlines('BTCUSDT', '1d', 2, 'coinbase')
    // Then 有根数参数的所被裁到该所上限，没有根数参数的所在本地只留最新 limit 根（升序）
    expect(okx.urls[0]).toContain('&limit=300')
    expect(binance.urls[0]).toContain('&limit=1000')
    expect(coinbase.urls[0]).not.toContain('limit')
    expect(tail.map((row) => row.openTime)).toEqual([T1, T2])
  })
})

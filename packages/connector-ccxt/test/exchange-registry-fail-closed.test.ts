/**
 * 所名登记面 = 实现事实（fail-closed）。
 *
 * 历史：`SUPPORTED_EXCHANGES` 曾登记 9 个所名而实现只有 bybit/okx 两条具名分支，其余 6 个
 * 静默落 Binance 兜底 URL（选 kraken 拿到 Binance 的报价，没有任何提示）。上一轮把登记面
 * 收窄到 3 所，本轮把六条分支补齐、登记面重新等于实现面。本组用例守卫四件事：
 * ① 未登记所名（如 bitstamp）在**任何 fetch 之前**抛 `TRADING_NOT_IMPLEMENTED`（零请求）；
 * ② 九条 ticker 分支各自只打自己的主机（逐所一条）；
 * ③ K 线单分支：非 binance 的**客户端默认所名**在 fetch 之前拒绝；
 * ④ 注册出来的工具枚举与登记面逐字相等，且 `crypto_get_klines` 不再有 exchange 形参。
 *
 * fetch 走契约化注入缝（本仓零 mock 纪律），工具登记面用鸭子 ctx 驱动 `apply`，
 * 与 `test/dataplane-loader.test.ts` 同一体例。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '../src/index.ts'
import { CcxtRestClient, SUPPORTED_EXCHANGES } from '../src/rest.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stubFetch(routes: Array<{ match: string; body: unknown }>): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const route = routes.find((r) => url.includes(r.match))
    if (route === undefined) throw new Error(`unexpected request: ${url}`)
    return jsonResponse(route.body)
  }) as typeof fetch
  return { impl, urls }
}

/** 任何请求都会失败的注入缝：用来证明被拒的调用根本没发出网络请求。 */
function forbiddenFetch(): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    urls.push(String(input))
    throw new Error('no request expected for a rejected exchange/symbol')
  }) as typeof fetch
  return { impl, urls }
}

interface RegisteredTool {
  name: string
  description: string
  parameters: { properties: Record<string, { enum?: readonly string[] }> }
}

/**
 * 形状合法的假 ctx：`apply` 消费面是 `get`（路由）／`inject`（工具注册）／
 * `reflect.provide`（cordis Service 构造），按鸭式手搓，不引入通用 mock 工具。
 */
function toolsCtx(): { ctx: Context; registered: Map<string, RegisteredTool> } {
  const registered = new Map<string, RegisteredTool>()
  const tools = {
    register: (definition: RegisteredTool) => { registered.set(definition.name, definition) },
    get: (toolName: string) => registered.get(toolName),
  }
  const reflect = { provide: () => {} }
  const ctx = {
    tools,
    reflect,
    get: () => undefined,
    isolate: () => ({ reflect }),
    effect: (fn: () => () => void) => { fn() },
    inject: (_keys: string[], cb: (inner: unknown) => void) => { cb({ tools }) },
  } as unknown as Context
  return { ctx, registered }
}

describe('CCXT 未登记所名在请求前拒绝', () => {
  it('用户请求未登记所名 bitstamp 的 ticker 时得到结构化拒绝且零网络请求', async () => {
    // Given 任何请求都会失败的注入缝
    const { impl, urls } = forbiddenFetch()
    const client = new CcxtRestClient({ fetchImpl: impl })
    // When 用户请求未登记所名 bitstamp 的 ticker
    const err = await client.getTicker('BTCUSDT', 'bitstamp').catch((e: unknown) => e as Error & { code?: string })
    // Then 报 TRADING_NOT_IMPLEMENTED，文案点名所名、列出九所、明说零请求、指向专包，且无一条请求发出
    expect(err).toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    expect(String(err?.message)).toContain('"bitstamp"')
    expect(String(err?.message)).toContain('binance, okx, bybit, gateio, kucoin, kraken, coinbase, bitfinex, htx')
    expect(String(err?.message)).toContain('zero network requests were made')
    expect(String(err?.message)).toContain('@dshtrading/connector-binance')
    expect(String(err?.message)).toContain('@dshtrading/connector-okx')
    expect(String(err?.message)).toContain('@dshtrading/connector-bybit')
    expect(urls).toHaveLength(0)
  })

  it('用户把默认所名设为未登记 slug 并请求 K 线时同样拒绝且零网络请求', async () => {
    // Given 任何请求都会失败的注入缝 + 默认所名为未登记 slug 的客户端
    const { impl, urls } = forbiddenFetch()
    const client = new CcxtRestClient({ exchange: 'bitstamp', fetchImpl: impl })
    // When 用户请求该客户端的 K 线
    const err = await client.getKlines('BTCUSDT', '1d', 10).catch((e: unknown) => e as Error & { code?: string })
    // Then 报 TRADING_NOT_IMPLEMENTED（K 线只有 Binance 一条分支）、零请求
    expect(err).toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    expect(String(err?.message)).toContain('"bitstamp"')
    expect(String(err?.message)).toContain('implemented: binance')
    expect(String(err?.message)).toContain('zero network requests were made')
    expect(String(err?.message)).toContain('set the connector defaultExchange to binance')
    expect(String(err?.message)).toContain('@dshtrading/connector-binance')
    expect(urls).toHaveLength(0)
  })
})

describe('CCXT ticker 九条实现分支各自的主机', () => {
  it('用户请求 binance 的 ticker 时只打 api.binance.com 并解析现货字段', async () => {
    // Given 登记 binance 现货 ticker 响应的注入缝
    const stub = stubFetch([{
      match: '/api/v3/ticker/24hr',
      body: { symbol: 'BTCUSDT', lastPrice: '64000.5', volume: '35000.2', closeTime: 1725000000000 },
    }])
    // When 用户请求 binance 的 ticker
    const ticker = await new CcxtRestClient({ fetchImpl: stub.impl }).getTicker('BTCUSDT', 'binance')
    // Then 只打 binance 的现货端点且解析正常
    expect(stub.urls).toHaveLength(1)
    expect(stub.urls[0]).toContain('api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT')
    expect(ticker).toEqual({ symbol: 'BTCUSDT', price: 64000.5, volume: 35000.2, timestamp: 1725000000000 })
  })

  it('用户请求 okx 的 ticker 时只打 www.okx.com 且请求符号为 BTC-USDT', async () => {
    // Given 登记 okx 响应的注入缝
    const stub = stubFetch([{
      match: '/api/v5/market/ticker',
      body: { data: [{ instId: 'BTC-USDT', last: '64001.5', vol24h: '35001.5', ts: '1725000000000' }] },
    }])
    // When 用户以裸符号请求 okx 的 ticker
    const ticker = await new CcxtRestClient({ fetchImpl: stub.impl }).getTicker('BTCUSDT', 'okx')
    // Then 请求符号由 splitPair 生成（不再是 USDT 替换启发式）且解析正常
    expect(stub.urls).toHaveLength(1)
    expect(stub.urls[0]).toContain('www.okx.com/api/v5/market/ticker?instId=BTC-USDT')
    expect(ticker).toEqual({ symbol: 'BTCUSDT', price: 64001.5, volume: 35001.5, timestamp: 1725000000000 })
  })

  it('用户请求 bybit 的 ticker 时只打 api.bybit.com 的现货类目', async () => {
    // Given 登记 bybit 响应的注入缝
    const stub = stubFetch([{
      match: '/v5/market/tickers?category=spot&symbol=BTCUSDT',
      body: { retCode: 0, result: { list: [{ symbol: 'BTCUSDT', lastPrice: '64002.5', volume24h: '35002.5' }] } },
    }])
    // When 用户请求 bybit 的 ticker
    const ticker = await new CcxtRestClient({ fetchImpl: stub.impl }).getTicker('BTCUSDT', 'bybit')
    // Then 只打 bybit 现货类目且解析正常（timestamp 取本地时间）
    expect(stub.urls).toHaveLength(1)
    expect(stub.urls[0]).toContain('api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT')
    expect(ticker).toMatchObject({ symbol: 'BTCUSDT', price: 64002.5, volume: 35002.5 })
    expect(ticker.timestamp).toBeGreaterThan(1_700_000_000_000)
  })

  it('用户请求 gateio 的 ticker 时只打 api.gateio.ws 且请求符号为 BTC_USDT', async () => {
    // Given 登记 gateio 真实响应形态的注入缝
    const stub = stubFetch([{
      match: '/api/v4/spot/tickers?currency_pair=BTC_USDT',
      body: [{ currency_pair: 'BTC_USDT', last: '81708.4', base_volume: '10073.85', quote_volume: '832217740.3' }],
    }])
    // When 用户请求 gateio 的 ticker
    const ticker = await new CcxtRestClient({ fetchImpl: stub.impl }).getTicker('BTCUSDT', 'gateio')
    // Then 只打 gateio 且量取基础币 24h 量（base_volume，不是 quote_volume）
    expect(stub.urls).toHaveLength(1)
    expect(stub.urls[0]).toContain('api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT')
    expect(ticker).toMatchObject({ symbol: 'BTCUSDT', price: 81708.4, volume: 10073.85 })
  })

  it('用户请求 kucoin 的 ticker 时只打 api.kucoin.com 且用上游 time 作时间戳', async () => {
    // Given 登记 kucoin 真实响应形态的注入缝
    const stub = stubFetch([{
      match: '/api/v1/market/stats?symbol=BTC-USDT',
      body: { code: '200000', data: { time: 1792029214220, vol: '6369.28', last: '81714.1', symbol: 'BTC-USDT' } },
    }])
    // When 用户请求 kucoin 的 ticker
    const ticker = await new CcxtRestClient({ fetchImpl: stub.impl }).getTicker('BTCUSDT', 'kucoin')
    // Then 只打 kucoin，量为 data.vol、时间戳为 data.time
    expect(stub.urls).toHaveLength(1)
    expect(stub.urls[0]).toContain('api.kucoin.com/api/v1/market/stats?symbol=BTC-USDT')
    expect(ticker).toEqual({ symbol: 'BTCUSDT', price: 81714.1, volume: 6369.28, timestamp: 1792029214220 })
  })

  it('用户请求 kraken 的 ticker 时只打 api.kraken.com 且 base 记作 XBT、量取 v[1]', async () => {
    // Given 登记 kraken 真实响应形态的注入缝（唯一键与请求 pair 同名）
    const stub = stubFetch([{
      match: '/0/public/Ticker?pair=XBTUSDT',
      body: { error: [], result: { XBTUSDT: { c: ['81718.20', '0.00024484'], v: ['4.74', '124.87'] } } },
    }])
    // When 用户请求 kraken 的 ticker
    const ticker = await new CcxtRestClient({ fetchImpl: stub.impl }).getTicker('BTCUSDT', 'kraken')
    // Then 只打 kraken，BTC→XBT、量为 24h 量 v[1]（v[0] 是滚动 24h 的另一口径）
    expect(stub.urls).toHaveLength(1)
    expect(stub.urls[0]).toContain('api.kraken.com/0/public/Ticker?pair=XBTUSDT')
    expect(ticker).toMatchObject({ symbol: 'BTCUSDT', price: 81718.2, volume: 124.87 })
  })

  it('用户请求 coinbase 的 ticker 时只打 api.exchange.coinbase.com 且按 quote 拼 dash 符号', async () => {
    // Given 登记 coinbase 真实响应形态的注入缝（USDT 计价与 USD 计价各一条）
    const ticker = { ask: '81614.07', bid: '81614.05', volume: '6462.15', price: '81614.06', time: '2026-10-15T01:53:37.43Z' }
    const usdtQuoted = stubFetch([{ match: '/products/BTC-USDT/ticker', body: ticker }])
    const usdQuoted = stubFetch([{ match: '/products/BTC-USD/ticker', body: ticker }])
    // When 用户分别以 BTCUSDT 与 BTCUSD 请求 coinbase 的 ticker
    const viaUsdt = await new CcxtRestClient({ fetchImpl: usdtQuoted.impl }).getTicker('BTCUSDT', 'coinbase')
    const viaUsd = await new CcxtRestClient({ fetchImpl: usdQuoted.impl }).getTicker('BTCUSD', 'coinbase')
    // Then 只打 coinbase，符号按 quote 归一（USDT 与 USD 各自保留），时间戳取本地观测时刻
    expect(usdtQuoted.urls).toHaveLength(1)
    expect(usdtQuoted.urls[0]).toContain('api.exchange.coinbase.com/products/BTC-USDT/ticker')
    expect(usdQuoted.urls[0]).toContain('api.exchange.coinbase.com/products/BTC-USD/ticker')
    expect(viaUsdt).toMatchObject({ symbol: 'BTCUSDT', price: 81614.06, volume: 6462.15 })
    expect(viaUsd).toMatchObject({ symbol: 'BTCUSD', price: 81614.06, volume: 6462.15 })
    // 不用响应里的 time（那是最后成交时间，实测薄标的能差数百秒），与 gateio/kraken/bitfinex 同口径
    expect(viaUsdt.timestamp).toBeGreaterThan(1_700_000_000_000)
    expect(viaUsdt.timestamp).not.toBe(Date.parse('2026-10-15T01:53:37.43Z'))
  })

  it('用户请求 bitfinex 的 ticker 时只打 api-pub.bitfinex.com 且不把第 11 位坏值当时间戳', async () => {
    // Given 登记 bitfinex 真实响应形态的注入缝（末位 1552298737974 是实测坏值）
    const badEpoch = 1552298737974
    const stub = stubFetch([{
      match: '/v2/ticker/tBTCUST',
      body: [81718, 3.37, 81731, 1.65, -1716, -0.0205, 81732, 788.51, 84143, 81393, badEpoch],
    }])
    // When 用户请求 bitfinex 的 ticker
    const ticker = await new CcxtRestClient({ fetchImpl: stub.impl }).getTicker('BTCUSDT', 'bitfinex')
    // Then 只打 bitfinex，符号为 t+BTC+UST、价为 [6]、量为 [7]，时间戳取本地时间而非数组坏值
    expect(stub.urls).toHaveLength(1)
    expect(stub.urls[0]).toContain('api-pub.bitfinex.com/v2/ticker/tBTCUST')
    expect(ticker).toMatchObject({ symbol: 'BTCUSDT', price: 81732, volume: 788.51 })
    expect(ticker.timestamp).not.toBe(badEpoch)
    expect(ticker.timestamp).toBeGreaterThan(1_700_000_000_000)
  })

  it('用户请求 htx 的 ticker 时只打 api.htx.com 且请求符号全小写、量取基础币 amount', async () => {
    // Given 登记 htx 真实响应形态的注入缝（amount 是基础币量、vol 是计价币量）
    const stub = stubFetch([{
      match: '/market/detail/merged?symbol=btcusdt',
      body: { ch: 'market.btcusdt.detail.merged', status: 'ok', ts: 1792029219380, tick: { close: 81703.5, amount: 3046.88, vol: 2.528e8 } },
    }])
    // When 用户请求 htx 的 ticker
    const ticker = await new CcxtRestClient({ fetchImpl: stub.impl }).getTicker('BTCUSDT', 'htx')
    // Then 只打 htx，符号全小写、量为 tick.amount、时间戳为 ts
    expect(stub.urls).toHaveLength(1)
    expect(stub.urls[0]).toContain('api.htx.com/market/detail/merged?symbol=btcusdt')
    expect(ticker).toEqual({ symbol: 'BTCUSDT', price: 81703.5, volume: 3046.88, timestamp: 1792029219380 })
  })
})

describe('CCXT K 线的单一实现分支', () => {
  it('用户把默认所名设为 okx 或 bybit 并请求 K 线时零请求结构化拒绝', async () => {
    // Given 任何请求都会失败的注入缝
    const { impl, urls } = forbiddenFetch()
    // When/Then 两个所名的客户端请求 K 线都被拒（K 线形参已无 exchange，裁决走默认所名）
    await expect(new CcxtRestClient({ exchange: 'okx', fetchImpl: impl }).getKlines('BTCUSDT', '1d', 10))
      .rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    await expect(new CcxtRestClient({ exchange: 'bybit', fetchImpl: impl }).getKlines('BTCUSDT', '1d', 10))
      .rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    expect(urls).toHaveLength(0)
  })
})

describe('CCXT 工具登记面与实现面一致', () => {
  it('运营驱动 apply() 注册的两个工具，ticker 枚举逐字等于九所且 K 线无 exchange 形参', () => {
    // Given 鸭子 ctx（收集注册定义）+ schema 默认配置
    const { ctx, registered } = toolsCtx()
    // When 挂载插件行
    apply(ctx, Config({}))
    // Then 两个行情工具都注册出来，ticker 枚举 = 九条实现分支，K 线不再有 exchange 形参
    expect([...registered.keys()].sort()).toEqual(['crypto_get_klines', 'crypto_get_ticker'])
    const ticker = registered.get('crypto_get_ticker')
    const klines = registered.get('crypto_get_klines')
    expect(ticker?.parameters.properties.exchange?.enum).toEqual([...SUPPORTED_EXCHANGES])
    expect(ticker?.parameters.properties.exchange?.enum)
      .toEqual(['binance', 'okx', 'bybit', 'gateio', 'kucoin', 'kraken', 'coinbase', 'bitfinex', 'htx'])
    expect(klines?.parameters.properties.exchange).toBeUndefined()
    expect(Object.keys(klines?.parameters.properties ?? {}).sort()).toEqual(['interval', 'limit', 'symbol'])
    // 描述面与实现面一致：不再有「100+ 所」这类宽表述，K 线说明单分支与默认所名裁决
    expect(ticker?.description).not.toContain('100+')
    expect(ticker?.description).toContain('binance, okx, bybit, gateio, kucoin, kraken, coinbase, bitfinex, htx')
    expect(klines?.description).toContain('binance')
    expect(klines?.description).toContain('defaultExchange')
  })
})

describe('CCXT binance 现货路径零回归', () => {
  it('用户请求 binance 现货 ticker 与 K 线时仍打现货端点且解析正常', async () => {
    // Given 登记 binance 现货 ticker 与 K 线响应
    const tickerStub = stubFetch([{
      match: '/api/v3/ticker/24hr',
      body: { symbol: 'BTCUSDT', lastPrice: '64000.5', volume: '35000.2', closeTime: 1725000000000 },
    }])
    const klinesStub = stubFetch([{
      match: '/api/v3/klines',
      body: [[1725000000000, '64000.0', '65000.0', '63000.0', '64500.0', '123.4', 1725003599999]],
    }])
    // When 用户请求 binance 现货 ticker 与 K 线（K 线只有三个形参，走客户端缺省 binance）
    const ticker = await new CcxtRestClient({ fetchImpl: tickerStub.impl }).getTicker('BTCUSDT', 'binance')
    const klines = await new CcxtRestClient({ fetchImpl: klinesStub.impl }).getKlines('BTCUSDT', '1d', 10)
    // Then 命中现货端点且解析正常
    expect(tickerStub.urls[0]).toContain('api.binance.com/api/v3/ticker/24hr')
    expect(ticker).toMatchObject({ symbol: 'BTCUSDT', price: 64000.5, volume: 35000.2 })
    expect(klinesStub.urls[0]).toContain('api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=10')
    expect(klines).toEqual([{
      openTime: 1725000000000,
      open: 64000,
      high: 65000,
      low: 63000,
      close: 64500,
      volume: 123.4,
      closeTime: 1725003599999,
    }])
  })
})

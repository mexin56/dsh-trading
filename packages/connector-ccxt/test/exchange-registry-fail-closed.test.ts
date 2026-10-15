/**
 * 所名登记面收窄到实现事实（fail-closed）。
 *
 * 此前 `SUPPORTED_EXCHANGES` 登记 9 个所名、实现只有 bybit/okx 两个具名分支，其余 6 个
 * 静默落 Binance 兜底 URL（选 kraken 拿到 Binance 的报价，没有任何提示）；`getKlines` 干脆
 * 忽略 `exchange` 形参。本组用例守卫三件事：① 未实现所名在**任何 fetch 之前**抛
 * `TRADING_NOT_IMPLEMENTED`（零请求）；② 三条 ticker 分支各自打自己的主机（okx 分支此前
 * 无单测，这里补上）；③ 注册出来的工具枚举与登记面逐字相等——登记面不得再宽于实现面。
 *
 * fetch 走契约化注入缝（本仓零 mock 纪律），工具登记面用鸭子 ctx 驱动 `apply`，
 * 与 `test/dataplane-loader.test.ts` 同一体例。
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '../src/index.ts'
import { CcxtRestClient, KLINE_EXCHANGES, SUPPORTED_EXCHANGES } from '../src/rest.ts'

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

/** 任何请求都会失败的注入缝：用来证明未实现所名根本没发出网络请求。 */
function forbiddenFetch(): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    urls.push(String(input))
    throw new Error('no request expected for an unimplemented exchange')
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

describe('CCXT 未实现所名在请求前拒绝', () => {
  it('用户请求未实现所名的 ticker 时得到结构化拒绝且零网络请求', async () => {
    // Given 任何请求都会失败的注入缝
    const { impl, urls } = forbiddenFetch()
    const client = new CcxtRestClient({ fetchImpl: impl })
    // When 用户请求未实现所名 kraken 的 ticker
    const err = await client.getTicker('BTCUSDT', 'kraken').catch((e: unknown) => e as Error & { code?: string })
    // Then 报 TRADING_NOT_IMPLEMENTED，文案点名所名、列出三所、明说零请求、指向专包，且无一条请求发出
    expect(err).toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    expect(String(err?.message)).toContain('"kraken"')
    expect(String(err?.message)).toContain('binance, okx, bybit')
    expect(String(err?.message)).toContain('zero network requests were made')
    expect(String(err?.message)).toContain('@dshtrading/connector-okx')
    expect(String(err?.message)).toContain('@dshtrading/connector-bybit')
    expect(urls).toHaveLength(0)
  })

  it('用户请求其余未实现所名的 ticker 时一律拒绝且零网络请求', async () => {
    // Given 任何请求都会失败的注入缝 + 曾登记但从未实现的所名清单
    const formerNames = ['gateio', 'kucoin', 'coinbase', 'bitfinex', 'htx']
    // When/Then 逐个所名请求 ticker，全部结构性拒绝且不发请求
    for (const exchange of formerNames) {
      const { impl, urls } = forbiddenFetch()
      const client = new CcxtRestClient({ exchange, fetchImpl: impl })
      await expect(client.getTicker('BTCUSDT')).rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
      expect(urls).toHaveLength(0)
    }
  })
})

describe('CCXT ticker 三条实现分支各自的主机', () => {
  it('用户请求 binance / okx / bybit 的 ticker 时各自打自己的主机', async () => {
    // Given 三条分支各自的注入缝与响应
    const binance = stubFetch([{
      match: '/api/v3/ticker/24hr',
      body: { symbol: 'BTCUSDT', lastPrice: '64000.5', volume: '35000.2', closeTime: 1725000000000 },
    }])
    const okx = stubFetch([{
      match: '/api/v5/market/ticker',
      body: { data: [{ instId: 'BTC-USDT', last: '64001.5', vol24h: '35001.5', ts: '1725000000000' }] },
    }])
    const bybit = stubFetch([{
      match: '/v5/market/tickers?category=spot&symbol=ETHUSDT',
      body: { retCode: 0, result: { list: [{ symbol: 'ETHUSDT', lastPrice: '2500.25', volume24h: '1000.5' }] } },
    }])
    // When 用户分别请求三所的 ticker
    const binanceTicker = await new CcxtRestClient({ fetchImpl: binance.impl }).getTicker('BTCUSDT', 'binance')
    const okxTicker = await new CcxtRestClient({ fetchImpl: okx.impl }).getTicker('BTCUSDT', 'okx')
    const bybitTicker = await new CcxtRestClient({ fetchImpl: bybit.impl }).getTicker('ETHUSDT', 'bybit')
    // Then 每条分支只打自己的主机，且各自解析正常
    expect(binance.urls).toHaveLength(1)
    expect(binance.urls[0]).toContain('api.binance.com/api/v3/ticker/24hr')
    expect(binanceTicker).toMatchObject({ symbol: 'BTCUSDT', price: 64000.5, volume: 35000.2 })
    expect(okx.urls).toHaveLength(1)
    expect(okx.urls[0]).toContain('www.okx.com/api/v5/market/ticker')
    expect(okx.urls[0]).toContain('instId=BTC-USDT')
    expect(okxTicker).toMatchObject({ symbol: 'BTCUSDT', price: 64001.5, volume: 35001.5, timestamp: 1725000000000 })
    expect(bybit.urls).toHaveLength(1)
    expect(bybit.urls[0]).toContain('api.bybit.com/v5/market/tickers?category=spot&symbol=ETHUSDT')
    expect(bybitTicker).toMatchObject({ symbol: 'ETHUSDT', price: 2500.25, volume: 1000.5 })
  })
})

describe('CCXT K 线的单一实现分支', () => {
  it('用户请求非 binance 所名的 K 线时得到结构化拒绝且零网络请求', async () => {
    // Given 任何请求都会失败的注入缝
    const { impl, urls } = forbiddenFetch()
    const client = new CcxtRestClient({ fetchImpl: impl })
    // When 用户请求 okx 所名的 K 线
    const err = await client.getKlines('BTCUSDT', '1d', 10, 'okx').catch((e: unknown) => e as Error & { code?: string })
    // Then 报 TRADING_NOT_IMPLEMENTED（K 线只有 Binance 一条分支）、零请求
    expect(err).toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    expect(String(err?.message)).toContain('"okx"')
    expect(String(err?.message)).toContain('implemented: binance')
    expect(String(err?.message)).toContain('zero network requests were made')
    expect(urls).toHaveLength(0)
  })

  it('用户请求 bybit / kraken 所名的 K 线时同样拒绝且零网络请求', async () => {
    // Given 任何请求都会失败的注入缝
    const { impl, urls } = forbiddenFetch()
    // When/Then 两个所名的 K 线请求都被拒且不发请求
    await expect(new CcxtRestClient({ fetchImpl: impl }).getKlines('BTCUSDT', '1d', 10, 'bybit'))
      .rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    await expect(new CcxtRestClient({ exchange: 'kraken', fetchImpl: impl }).getKlines('BTCUSDT', '1d', 10))
      .rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    expect(urls).toHaveLength(0)
  })
})

describe('CCXT 工具登记面与实现面一致', () => {
  it('运营驱动 apply() 注册的两个工具，exchange 枚举与登记面逐字相等', () => {
    // Given 鸭子 ctx（收集注册定义）+ schema 默认配置
    const { ctx, registered } = toolsCtx()
    // When 挂载插件行
    apply(ctx, Config({}))
    // Then 两个行情工具都注册出来，且枚举就是实现面（登记面不得再宽于实现面）
    expect([...registered.keys()].sort()).toEqual(['crypto_get_klines', 'crypto_get_ticker'])
    const ticker = registered.get('crypto_get_ticker')
    const klines = registered.get('crypto_get_klines')
    expect(ticker?.parameters.properties.exchange?.enum).toEqual([...SUPPORTED_EXCHANGES])
    expect(klines?.parameters.properties.exchange?.enum).toEqual([...KLINE_EXCHANGES])
    expect(ticker?.parameters.properties.exchange?.enum).toEqual(['binance', 'okx', 'bybit'])
    expect(klines?.parameters.properties.exchange?.enum).toEqual(['binance'])
    // 描述面同步收窄：不再有「100+ 所」这类宽表述
    expect(ticker?.description).not.toContain('100+')
    expect(ticker?.description).toContain('binance, okx, bybit')
    expect(klines?.description).toContain('binance')
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
    // When 用户请求 binance 现货 ticker 与 K 线（K 线不传 exchange，走客户端缺省 binance）
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

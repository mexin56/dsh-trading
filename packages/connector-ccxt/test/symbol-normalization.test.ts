/**
 * 符号归一：裸符号 ↔ 各所请求符号形态。
 *
 * 本轮把**需要形态变换**的七条分支（okx/kucoin/gateio/kraken/coinbase/bitfinex/htx）的请求
 * 符号从「就着一处启发式拼字符串」改成共享的 `splitPair`（quote 表最长优先：USDT/USDC/USD/
 * EUR/TRY/BRL/BTC/ETH）再按所映射。本组用例守卫四件事：
 * ① 九所各自把 `BTCUSDT` 发出的请求符号形态（kraken BTC→XBT、bitfinex t+UST、htx 小写，
 *   binance/bybit 是恒等形态）；
 * ② binance/bybit **不经过** quote 表：`ETHBNB`/`BTCFDUSD` 这类上游存在的计价对照发裸符号；
 * ③ 非 USDT 计价对也走同一条归一（quote 表不是只有一个成员）；
 * ④ 七条变换分支遇到拼不出 base+quote 的输入 → `TRADING_UNSUPPORTED_SYMBOL` 且**零网络请求**
 *   （猜一个 quote 等于给上游发错符号）。
 *
 * fetch 走契约化注入缝（本仓零 mock 纪律）。
 */
import { describe, expect, it } from 'vitest'
import { CcxtRestClient, normalizeSymbol, QUOTE_SUFFIXES, splitPair, SUPPORTED_EXCHANGES } from '../src/rest.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 固定回同一个 body 的注入缝（本文件只关心请求符号，不关心解析）。 */
function fixedFetch(body: unknown): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    urls.push(String(input))
    return jsonResponse(body)
  }) as typeof fetch
  return { impl, urls }
}

/** 任何请求都会失败的注入缝：用来证明归一失败的输入没发出网络请求。 */
function forbiddenFetch(): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    urls.push(String(input))
    throw new Error('no request expected for a symbol that cannot be split into base+quote')
  }) as typeof fetch
  return { impl, urls }
}

/**
 * 九所请求符号形态（URL 片段含足够上下文，避免 `BTC-USD` 被 `BTC-USDT` 子串误命中）
 * + 能解析出 price=1 / volume=2 的最小上游响应。
 */
const REQUEST_FORMS: Record<string, { fragment: string; body: unknown }> = {
  binance: { fragment: 'ticker/24hr?symbol=BTCUSDT', body: { lastPrice: '1', volume: '2', closeTime: 1 } },
  okx: { fragment: 'market/ticker?instId=BTC-USDT', body: { data: [{ instId: 'BTC-USDT', last: '1', vol24h: '2', ts: '1' }] } },
  bybit: { fragment: 'tickers?category=spot&symbol=BTCUSDT', body: { result: { list: [{ lastPrice: '1', volume24h: '2' }] } } },
  gateio: { fragment: 'spot/tickers?currency_pair=BTC_USDT', body: [{ last: '1', base_volume: '2' }] },
  kucoin: { fragment: 'market/stats?symbol=BTC-USDT', body: { code: '200000', data: { last: '1', vol: '2', time: 1 } } },
  kraken: { fragment: 'Ticker?pair=XBTUSDT', body: { error: [], result: { XBTUSDT: { c: ['1'], v: ['0', '2'] } } } },
  coinbase: { fragment: 'products/BTC-USDT/ticker', body: { price: '1', volume: '2', time: '2026-10-15T01:53:37.43Z' } },
  bitfinex: { fragment: 'ticker/tBTCUST', body: [0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0] },
  htx: { fragment: 'detail/merged?symbol=btcusdt', body: { status: 'ok', ts: 1, tick: { close: 1, amount: 2 } } },
}

describe('CCXT 裸符号到各所请求符号的归一', () => {
  it('用户用裸符号请求九所 ticker 时各自被翻译成该所的请求符号形态', async () => {
    // Given 九所各自的最小上游响应（price=1 / volume=2）与裸符号 BTCUSDT
    const exchanges = [...SUPPORTED_EXCHANGES]
    // When 逐个所请求同一个裸符号
    // Then 每个所只发一条请求、请求符号等于该所形态、回包的 symbol 一律是裸符号
    for (const exchange of exchanges) {
      const form = REQUEST_FORMS[exchange]
      expect(form, `缺少 ${exchange} 的期望形态`).toBeDefined()
      const stub = fixedFetch(form?.body)
      const ticker = await new CcxtRestClient({ fetchImpl: stub.impl }).getTicker('BTCUSDT', exchange)
      expect(stub.urls).toHaveLength(1)
      expect(stub.urls[0]).toContain(form?.fragment)
      expect(ticker).toEqual({ symbol: 'BTCUSDT', price: 1, volume: 2, timestamp: expect.any(Number) })
    }
  })

  it('用户用非 USDT 计价的裸符号请求 okx 时按 quote 表切出 base 与 quote', async () => {
    // Given 登记 okx 响应的注入缝 + quote 表含 BTC/ETH/USDC 等非 USDT 成员
    const stub = fixedFetch({ data: [{ last: '1', vol24h: '2', ts: '1' }] })
    // When 用户请求 ETHBTC（quote=BTC）与 BTCUSDC（quote=USDC）
    const vsBtc = await new CcxtRestClient({ fetchImpl: stub.impl }).getTicker('ETHBTC', 'okx')
    const vsUsdc = await new CcxtRestClient({ fetchImpl: stub.impl }).getTicker('BTCUSDC', 'okx')
    // Then 两对都切成 instId=base-quote 的形态，而不是被 USDT 启发式拼成错符号
    expect(stub.urls[0]).toContain('instId=ETH-BTC')
    expect(stub.urls[1]).toContain('instId=BTC-USDC')
    expect(vsBtc.symbol).toBe('ETHBTC')
    expect(vsUsdc.symbol).toBe('BTCUSDC')
    expect(QUOTE_SUFFIXES).toEqual(['USDT', 'USDC', 'USD', 'EUR', 'TRY', 'BRL', 'BTC', 'ETH'])
  })

  it('用户用 BTC/USDT 或 btc_usdt 等写法请求时归一成同一个裸符号', async () => {
    // Given 登记 binance 响应的注入缝 + normalizeSymbol 行为不变的既有契约
    const stub = fixedFetch({ lastPrice: '1', volume: '2', closeTime: 1 })
    // When 用户分别用斜杠形、下划线形、小写形请求
    const slash = await new CcxtRestClient({ fetchImpl: stub.impl }).getTicker('BTC/USDT', 'binance')
    const underscore = await new CcxtRestClient({ fetchImpl: stub.impl }).getTicker('btc_usdt', 'binance')
    // Then 三种写法归一成同一个裸符号，请求 URL 逐字相同
    expect(normalizeSymbol('BTC/USDT')).toBe('BTCUSDT')
    expect(slash.symbol).toBe('BTCUSDT')
    expect(underscore.symbol).toBe('BTCUSDT')
    expect(stub.urls[0]).toBe(stub.urls[1])
    expect(stub.urls[0]).toContain('symbol=BTCUSDT')
  })

  it('用户用不在 quote 表里的计价对请求 binance/bybit 时仍原样发裸符号到各自主机', async () => {
    // Given 登记 binance 与 bybit 响应的注入缝 + 上游确实存在的非 quote 表计价对
    const binance = fixedFetch({ lastPrice: '1', volume: '2', closeTime: 1 })
    const bybit = fixedFetch({ result: { list: [{ lastPrice: '1', volume24h: '2' }] } })
    // When 用户用 ETHBNB / BTCFDUSD 请求 binance，用 ETHBNB 请求 bybit
    const binanceEthBnb = await new CcxtRestClient({ fetchImpl: binance.impl }).getTicker('ETHBNB', 'binance')
    const binanceBtcFdusd = await new CcxtRestClient({ fetchImpl: binance.impl }).getTicker('BTCFDUSD', 'binance')
    const bybitEthBnb = await new CcxtRestClient({ fetchImpl: bybit.impl }).getTicker('ETHBNB', 'bybit')
    // Then 两个所把裸符号原样发到自己的主机、各只发一条请求（形态变换与 quote 表只管七条变换分支）
    expect(binance.urls).toHaveLength(2)
    expect(binance.urls[0]).toContain('api.binance.com/api/v3/ticker/24hr?symbol=ETHBNB')
    expect(binance.urls[1]).toContain('api.binance.com/api/v3/ticker/24hr?symbol=BTCFDUSD')
    expect(bybit.urls).toHaveLength(1)
    expect(bybit.urls[0]).toContain('api.bybit.com/v5/market/tickers?category=spot&symbol=ETHBNB')
    expect(binanceEthBnb.symbol).toBe('ETHBNB')
    expect(binanceBtcFdusd.symbol).toBe('BTCFDUSD')
    expect(bybitEthBnb.symbol).toBe('ETHBNB')
  })

  it('用户请求拼不出 base+quote 的符号时七条变换分支零请求拒绝', async () => {
    // Given 任何请求都会失败的注入缝 + 需要形态变换的七条分支
    const { impl, urls } = forbiddenFetch()
    const client = new CcxtRestClient({ fetchImpl: impl })
    const transformExchanges = ['okx', 'kucoin', 'gateio', 'kraken', 'coinbase', 'bitfinex', 'htx']
    // When 用户用未知 quote 的 BTCJPY 逐个请求七条变换分支，再用没有 base 的 USDT 请求 htx
    const rejected = []
    for (const exchange of transformExchanges) {
      rejected.push(await client.getTicker('BTCJPY', exchange).catch((e: unknown) => e as Error & { code?: string }))
    }
    const emptyBase = await client.getTicker('USDT', 'htx').catch((e: unknown) => e as Error & { code?: string })
    // Then 七条分支都报 TRADING_UNSUPPORTED_SYMBOL（文案点名输入与 quote 表），且一条请求都没发
    expect(rejected).toHaveLength(transformExchanges.length)
    for (const err of rejected) {
      expect(err).toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
      expect(String(err?.message)).toContain('"BTCJPY"')
    }
    expect(String(rejected[0]?.message)).toContain('USDT, USDC, USD, EUR, TRY, BRL, BTC, ETH')
    expect(emptyBase).toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
    expect(String(emptyBase?.message)).toContain('"USDT"')
    expect(() => splitPair('USDT')).toThrow(/cannot split "USDT" into base\+quote/)
    expect(urls).toHaveLength(0)
  })
})

/**
 * 符号归一：裸符号 ↔ 各所请求符号形态（quote 表**按所**维护，2026-10-15 起）。
 *
 * 需要形态变换的七条分支（okx/kucoin/gateio/kraken/coinbase/bitfinex/htx）各有一份 quote 资产表
 * （`QUOTE_TABLES`，数据来源 = 该所公开挂牌端点普查，见 spikes/impl-ccxt-exchange-expansion/），
 * `splitPair` 只按**该所**的表切 base+quote。本组用例守卫五件事：
 * ① 九所各自把 `BTCUSDT` 发出的请求符号形态（kraken BTC→XBT、bitfinex t+UST、htx 小写，
 *   binance/bybit 是恒等形态）；
 * ② binance/bybit **不经过** quote 表：`ETHBNB`/`BTCFDUSD` 这类上游存在的计价对照发裸符号；
 * ③ 表内每所一条非 USDT 计价对能拼对（kraken ETHEUR / bitfinex tETHEUR / htx ethbtc …）；
 * ④ 表是**按所**的：`ETHJPY` 在 kraken（表内）拼得出、在 gateio（表外）本地拒绝，`ETHBRL` 反之；
 * ⑤ 任何拼不出 base+quote 的输入 → `TRADING_UNSUPPORTED_SYMBOL` 且**零网络请求**。
 *
 * fetch 走契约化注入缝（本仓零 mock 纪律）。
 */
import { describe, expect, it } from 'vitest'
import {
  CcxtRestClient,
  QUOTE_TABLES,
  SUPPORTED_EXCHANGES,
  normalizeSymbol,
  requestSymbol,
  splitPair,
} from '../src/rest.ts'

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

/** 七条变换分支各自的非 USDT 计价对（都取该所表内确实挂牌的计价币）。 */
const NON_USDT_FORMS: Record<string, { symbol: string; fragment: string; body: unknown }> = {
  okx: { symbol: 'ETHBTC', fragment: 'market/ticker?instId=ETH-BTC', body: { data: [{ last: '1', vol24h: '2', ts: '1' }] } },
  kucoin: { symbol: 'ETHBTC', fragment: 'market/stats?symbol=ETH-BTC', body: { code: '200000', data: { last: '1', vol: '2', time: 1 } } },
  gateio: { symbol: 'ETHBTC', fragment: 'spot/tickers?currency_pair=ETH_BTC', body: [{ last: '1', base_volume: '2' }] },
  kraken: { symbol: 'ETHEUR', fragment: 'Ticker?pair=ETHEUR', body: { error: [], result: { ETHEUR: { c: ['1'], v: ['0', '2'] } } } },
  coinbase: { symbol: 'ETHBTC', fragment: 'products/ETH-BTC/ticker', body: { price: '1', volume: '2', time: '2026-10-15T01:53:37.43Z' } },
  bitfinex: { symbol: 'ETHEUR', fragment: 'ticker/tETHEUR', body: [0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0] },
  htx: { symbol: 'ETHBTC', fragment: 'detail/merged?symbol=ethbtc', body: { status: 'ok', ts: 1, tick: { close: 1, amount: 2 } } },
}

const TRANSFORM_EXCHANGES = ['okx', 'kucoin', 'gateio', 'kraken', 'coinbase', 'bitfinex', 'htx'] as const

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

  it('用户用该所表内的非 USDT 计价对请求七条变换分支时按该所 quote 表切出 base 与 quote', async () => {
    // Given 七条变换分支各自的非 USDT 计价对（kraken/bitfinex 取 EUR，其余取 BTC）
    // When 逐个所请求该对
    // Then 请求符号由该所 quote 表切成 base+quote（而不是 USDT 启发式），且每所只发一条请求
    for (const exchange of TRANSFORM_EXCHANGES) {
      const form = NON_USDT_FORMS[exchange]
      expect(form, `缺少 ${exchange} 的非 USDT 形态`).toBeDefined()
      const stub = fixedFetch(form?.body)
      const ticker = await new CcxtRestClient({ fetchImpl: stub.impl }).getTicker(form?.symbol ?? '', exchange)
      expect(stub.urls).toHaveLength(1)
      expect(stub.urls[0]).toContain(form?.fragment)
      expect(ticker.symbol).toBe(form?.symbol)
      expect(ticker.price).toBe(1)
      expect(ticker.volume).toBe(2)
    }
  })

  it('用户请求只在部分所有挂牌的计价币时，登记该币的所拼得出、未登记的所本地拒绝', async () => {
    // Given JPY 在 kraken 表内而 gateio 表外，BRL 在 okx/coinbase/htx 表内而 kraken/gateio 表外
    const stub = fixedFetch({ error: [], result: { ETHJPY: { c: ['1'], v: ['0', '2'] } } })
    const client = new CcxtRestClient({ fetchImpl: stub.impl })
    // When 用户分别用 ETHJPY / ETHBRL 请求两边的所
    // Then 表内的所拼得出请求符号，表外的所在发请求之前就拒绝
    expect(requestSymbol('kraken', 'ETHJPY')).toBe('ETHJPY')
    await expect(client.getTicker('ETHJPY', 'gateio')).rejects.toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
    expect(requestSymbol('okx', 'ETHBRL')).toBe('ETH-BRL')
    expect(requestSymbol('coinbase', 'ETHBRL')).toBe('ETH-BRL')
    expect(requestSymbol('htx', 'ETHBRL')).toBe('ethbrl')
    expect(() => splitPair('ETHBRL', 'kraken')).toThrow(/cannot split "ETHBRL" into base\+quote for kraken/)
    expect(() => splitPair('ETHBRL', 'gateio')).toThrow(/cannot split "ETHBRL" into base\+quote for gateio/)
    // 只有 kraken 的那条请求真的发出去了（表内的所各一条，这里只调了 kraken 一次）
    await client.getTicker('ETHJPY', 'kraken')
    expect(stub.urls).toHaveLength(1)
  })

  it('用户读取各所 quote 表时看到的是逐所普查结果：最长优先且互不相同', () => {
    // Given 各所公开挂牌端点普查出的 quote 集合（原始响应在 spikes/impl-ccxt-exchange-expansion/）
    // When 用户查表并让 splitPair 按表切一个与既有 quote 同前缀的符号 BTCUSD1
    // Then 表内是各所真实的计价币（kraken 记 XBT、gateio 无 JPY、okx/kucoin 有 USD 系变体），
    //      最长优先把 USD1 切在 USD 之前，而不是把它切成 base=BTCUSD/quote=1
    expect(QUOTE_TABLES.kraken).toContain('XBT')
    expect(QUOTE_TABLES.kraken).toContain('JPY')
    expect(QUOTE_TABLES.gateio).not.toContain('JPY')
    expect(QUOTE_TABLES.gateio).toContain('USD1')
    expect(QUOTE_TABLES.kucoin).toContain('KCS')
    expect(QUOTE_TABLES.htx).toContain('USTC')
    expect(QUOTE_TABLES.bitfinex).toContain('XAUT')
    expect(splitPair('BTCUSD1', 'gateio')).toEqual({ base: 'BTC', quote: 'USD1' })
    expect(splitPair('BTCUSDT', 'okx')).toEqual({ base: 'BTC', quote: 'USDT' })
    for (const exchange of TRANSFORM_EXCHANGES) {
      expect([...QUOTE_TABLES[exchange]].every((quote) => quote === quote.toUpperCase())).toBe(true)
      expect(new Set(QUOTE_TABLES[exchange]).size).toBe(QUOTE_TABLES[exchange].length)
    }
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

  it('用户用不在任何 quote 表里的计价对请求 binance/bybit 时仍原样发裸符号到各自主机', async () => {
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
    // When 用户用七条分支表外（任何一所都没挂牌 NGN）的 BTCNGN 逐个请求，再用没有 base 的 USDT 请求 htx
    const rejected = []
    for (const exchange of TRANSFORM_EXCHANGES) {
      rejected.push(await client.getTicker('BTCNGN', exchange).catch((e: unknown) => e as Error & { code?: string }))
    }
    const emptyBase = await client.getTicker('USDT', 'htx').catch((e: unknown) => e as Error & { code?: string })
    // Then 七条分支都报 TRADING_UNSUPPORTED_SYMBOL（文案点名输入与该所的 quote 表），且一条请求都没发
    expect(rejected).toHaveLength(TRANSFORM_EXCHANGES.length)
    for (const err of rejected) {
      expect(err).toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
      expect(String(err?.message)).toContain('"BTCNGN"')
    }
    expect(String(rejected[0]?.message)).toContain('okx quotes are')
    expect(String(rejected[3]?.message)).toContain('kraken quotes are')
    expect(emptyBase).toMatchObject({ code: 'TRADING_UNSUPPORTED_SYMBOL' })
    expect(String(emptyBase?.message)).toContain('"USDT"')
    expect(() => splitPair('USDT', 'htx')).toThrow(/cannot split "USDT" into base\+quote for htx/)
    expect(urls).toHaveLength(0)
  })
})

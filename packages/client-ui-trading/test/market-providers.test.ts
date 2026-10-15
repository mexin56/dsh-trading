/**
 * 市场 provider 缓存的单测（用户可见后果：五日级别胶囊的出现判定）。
 *
 * 覆盖：请求失败不缓存（下次重试）、一次 /markets 喂全所有市场且并发调用只发
 * 一次、二次索取零请求、sidebar 已拉到的结果直接进缓存不再发第二个请求。
 *
 * 无 mock/无 sleep：fetch 用真实 Response 桩（与 holdings 用例同款）。
 * 用例顺序即缓存生命周期（首次失败 → 成功 → 命中 → 发布覆盖）。
 */
import { describe, expect, it } from 'vitest'
import {
  ensureMarketProviders, marketCapabilitiesOf, marketCapabilitySnapshot, marketProviderOf,
  marketProviderSnapshot, publishMarketProviders,
} from '../src/client/market-providers.ts'
import type { MarketInfo } from '../src/client/types.ts'
import { fiveDayCapability } from '../src/client/five-day-series.ts'

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

const MARKETS: MarketInfo[] = [
  { id: 'crypto', provider: 'okx' },
  { id: 'us', provider: 'yahoo' },
  { id: 'cn', provider: 'eastmoney' },
  { id: 'hk', provider: 'eastmoney' },
]

/** 真实 Response 桩：记录 /markets 请求次数。 */
function stubMarkets(payload: MarketInfo[], options: { fail?: boolean } = {}): { requests: number } {
  const observation = { requests: 0 }
  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    if (String(input).includes('/dshtrading/api/markets')) {
      observation.requests += 1
      if (options.fail === true) return new Response('boom', { status: 500 })
      return jsonResponse({ markets: payload })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return observation
}

describe('市场 provider 缓存', () => {
  it('用户遇到 markets 请求失败时不会拿到伪造的 provider，下次仍会重试', async () => {
    // Given markets 返回 500
    const observation = stubMarkets(MARKETS, { fail: true })

    // When 索取 provider 表
    const map = await ensureMarketProviders()

    // Then 失败如实返回空表且不写缓存（provider 缺席 = unknown，交给能力三态）
    expect(observation.requests).toBe(1)
    expect(map).toEqual({})
    expect(marketProviderOf('us')).toBeUndefined()
  })

  it('用户首次打开行情时一次 /markets 就喂全所有市场，并发调用也只发一次', async () => {
    // Given 一个记录请求次数的 markets 桩
    const observation = stubMarkets(MARKETS)

    // When 三处消费者并发索取 provider 表
    await Promise.all([ensureMarketProviders(), ensureMarketProviders(), ensureMarketProviders()])

    // Then 只发一次请求，且每个市场的 provider 按市场落位
    expect(observation.requests).toBe(1)
    expect(marketProviderSnapshot()).toEqual({ crypto: 'okx', us: 'yahoo', cn: 'eastmoney', hk: 'eastmoney' })
    expect(marketProviderOf('cn')).toBe('eastmoney')
    expect(marketProviderOf('futures')).toBeUndefined()
  })

  it('用户切换标的时不再探测：同一市场二次索取零请求', async () => {
    // Given 缓存已填充，并换成会再次计数的桩
    const observation = stubMarkets(MARKETS)

    // When 换标的（同一市场）再次索取
    const map = await ensureMarketProviders()

    // Then 命中缓存，零请求，且快照引用稳定（不触发无谓重渲染）
    expect(observation.requests).toBe(0)
    expect(map).toBe(marketProviderSnapshot())
    expect(map.us).toBe('yahoo')
  })

  it('用户 sidebar 已拉到的 markets 直接进缓存，图表能力判定不再发第二个请求', async () => {
    // Given 换成别的路由（东财 → 腾讯）并发布 sidebar 的那份结果
    const observation = stubMarkets(MARKETS)

    // When 发布 + 索取
    publishMarketProviders([{ id: 'cn', provider: 'tencent' }, { id: 'hk', provider: 'tencent' }])
    await ensureMarketProviders()

    // Then 缓存按发布更新且零请求（cn/hk 走腾讯 → 五日级别不可得）
    expect(observation.requests).toBe(0)
    expect(marketProviderOf('cn')).toBe('tencent')
    expect(marketProviderOf('hk')).toBe('tencent')
  })
})

describe('市场 kline 能力并集缓存', () => {
  it('用户的 A 股 active 是腾讯时，能力并集里仍有东财声明的 1m/2500 根', () => {
    // Given 桥上报的 cn 行：provider 是腾讯，能力并集同时含腾讯的 800 根与东财的 2500 根
    publishMarketProviders([{
      id: 'cn',
      provider: 'tencent',
      klineCapabilities: [{ interval: '1m', maxBars: 800 }, { interval: '1m', maxBars: 2500 }],
    }])

    // When/Then provider 表语义不变，能力表按市场落位；cn 因此仍能出五日级别
    expect(marketProviderOf('cn')).toBe('tencent')
    expect(marketCapabilitiesOf('cn')).toEqual([{ interval: '1m', maxBars: 800 }, { interval: '1m', maxBars: 2500 }])
    expect(fiveDayCapability('cn', marketCapabilitiesOf('cn'))).toBe('yes')
    // 行里没有能力声明的市场在能力表里缺席（读侧按 unknown 处理，不是不可得）
    expect(marketCapabilitiesOf('us')).toBeUndefined()
    expect(fiveDayCapability('us', marketCapabilitiesOf('us'))).toBe('unknown')
  })

  it('用户的市场只有 1m/800 根声明时能力表照实反映，五日级别判为不可得', () => {
    // Given 只声明腾讯式 800 根 1m 的市场
    publishMarketProviders([{ id: 'hk', provider: 'tencent', klineCapabilities: [{ interval: '1m', maxBars: 800 }] }])

    // When/Then 能力表不粉饰：五日判定为 no（胶囊不出现，也不取数）
    expect(marketCapabilitiesOf('hk')).toEqual([{ interval: '1m', maxBars: 800 }])
    expect(fiveDayCapability('hk', marketCapabilitiesOf('hk'))).toBe('no')
  })

  it('用户遇到能力声明变化时快照跟着换新（订阅者据此重渲染），内容等价则不换', () => {
    // Given 能力表当前快照
    publishMarketProviders([{ id: 'cn', provider: 'tencent', klineCapabilities: [{ interval: '1m', maxBars: 800 }] }])
    const before = marketCapabilitySnapshot()

    // When 只改能力声明（provider 不变）发布新的一份
    publishMarketProviders([{ id: 'cn', provider: 'tencent', klineCapabilities: [{ interval: '1m', maxBars: 2500 }] }])

    // Then 快照换新（useSyncExternalStore 才会通知），再次发布等价内容则引用稳定
    expect(marketCapabilitySnapshot()).not.toBe(before)
    expect(marketCapabilitySnapshot().cn).toEqual([{ interval: '1m', maxBars: 2500 }])
    const stable = marketCapabilitySnapshot()
    publishMarketProviders([{ id: 'cn', provider: 'tencent', klineCapabilities: [{ interval: '1m', maxBars: 2500 }] }])
    expect(marketCapabilitySnapshot()).toBe(stable)
  })
})

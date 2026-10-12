/**
 * 实盘下单的**意图幂等**用例（Futu；离线、真实临时 DSH_HOME、契约化假桥）。
 *
 * remark 只作对账锚：官方与桥都不承诺按它去重，所以「同 ID 只下一单」由本地台账保证。
 */
import { deriveVenueClientKey } from '@dshtrading/authority/order-intents'
import { installTestAuthority, type TestAuthority } from '@dshtrading/authority/testing'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FUTU_REMARK_RULE, FutuTradeService, type Config } from '../src/index.js'
import { FutuRestClient } from '../src/rest.js'
import { fakeFutuVenue, type FakeFutuVenue } from './fake-futu-venue.js'

let testAuthority: TestAuthority | undefined
let home = ''
let savedHome: string | undefined

beforeAll(() => {
  testAuthority = installTestAuthority()
  savedHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'dsh-futu-order-intent-'))
  process.env.DSH_HOME = home
})

afterAll(() => {
  testAuthority?.uninstall()
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    gatewayUrl: 'http://futu.test',
    dryRun: false,
    liveTrading: true,
    unlockPwdRef: 'FUTU_UNLOCK_PWD',
    accId: 12345,
    ...overrides,
  }
}

function makeService(venue: FakeFutuVenue, overrides: Partial<Config> = {}): FutuTradeService {
  const config = baseConfig(overrides)
  return new FutuTradeService(new CordisContext() as never, {
    client: new FutuRestClient({ gatewayUrl: 'http://futu.test', fetchImpl: venue.fetchImpl, accId: config.accId, trdEnv: 'REAL' }),
    config,
  })
}

let seq = 0
function nextIntentId(): string {
  seq += 1
  return `futu-intent-${seq}`
}

const ORDER = { symbol: '00700.HK', side: 'buy' as const, type: 'limit' as const, quantity: 100, price: 406.8 }

async function errorOf(run: () => Promise<unknown>): Promise<{ code?: string; message?: string }> {
  return run().then(() => ({}), (error: unknown) => error as { code?: string; message?: string })
}

describe('实盘下单的意图幂等（Futu）', () => {
  it('user 实盘下单没带 intentId：结构化拒绝且桥没有收到请求', async () => {
    // Given 已获授权的 Futu 服务与假桥
    const venue = fakeFutuVenue()
    // When 不带 intentId 下实盘单
    const failure = await errorOf(() => makeService(venue).placeOrder({ ...ORDER, dryRun: false }))
    // Then 拒绝且零请求
    expect(failure.code).toBe('TRADING_INTENT_REQUIRED')
    expect(venue.requests()).toHaveLength(0)
  })

  it('user 用同一 intentId 重试同一笔单：只创建一笔并回带同一回执', async () => {
    // Given 一笔已提交的实盘单
    const venue = fakeFutuVenue()
    const trade = makeService(venue)
    const intentId = nextIntentId()
    const first = await trade.placeOrder({ ...ORDER, dryRun: false, intentId })
    // When 同 ID 同载荷重试
    const second = await trade.placeOrder({ ...ORDER, dryRun: false, intentId })
    // Then 桥只收到一笔，回执一致
    expect(venue.orders()).toHaveLength(1)
    expect(second).toEqual(first)
  })

  it('user 遇到「桥已建单但响应失败」后重试同 ID：不产生第二笔', async () => {
    // Given 一个受理后断连的假桥
    const venue = fakeFutuVenue({ outcome: 'lost-response' })
    const trade = makeService(venue)
    const intentId = nextIntentId()
    // When 首次失败后用同 ID 重试
    const first = await errorOf(() => trade.placeOrder({ ...ORDER, dryRun: false, intentId }))
    const retry = await errorOf(() => trade.placeOrder({ ...ORDER, dryRun: false, intentId }))
    // Then 首次网络错误、重试未知/在飞，桥侧仍只有一笔
    expect(first.code).toBeTruthy()
    expect(retry.code).toBe('TRADING_INTENT_UNKNOWN')
    expect(venue.orders()).toHaveLength(1)
  })

  it('user 用同 ID 换载荷：冲突拒绝且桥看不到第二笔', async () => {
    // Given 一笔已提交的限价单
    const venue = fakeFutuVenue()
    const trade = makeService(venue)
    const intentId = nextIntentId()
    await trade.placeOrder({ ...ORDER, dryRun: false, intentId })
    // When 用同 ID 改价格
    const failure = await errorOf(() => trade.placeOrder({ ...ORDER, price: 400, dryRun: false, intentId }))
    // Then 冲突拒绝、桥侧只有一笔
    expect(failure.code).toBe('TRADING_INTENT_CONFLICT')
    expect(venue.orders()).toHaveLength(1)
  })

  it('user 的实盘单带上 remark 对账锚：确定性派生且不进回执', async () => {
    // Given 会记账请求体的假桥
    const venue = fakeFutuVenue()
    const trade = makeService(venue)
    const intentId = nextIntentId()
    // When 提交实盘单
    const order = await trade.placeOrder({ ...ORDER, dryRun: false, intentId })
    // Then 请求体带 remark（= 确定性派生值），回执里没有它（remark 不是 venue 幂等键）
    const body = venue.requests()[0] ?? {}
    expect(body.remark).toBe(deriveVenueClientKey(intentId, FUTU_REMARK_RULE))
    expect(JSON.stringify(order)).not.toContain(String(body.remark))
  })

  it('user 的桥回执没有 orderId：报错且重试仍是未知', async () => {
    // Given 一个受理了但不回 orderId 的假桥
    const venue = fakeFutuVenue({ outcome: 'no-id' })
    const trade = makeService(venue)
    const intentId = nextIntentId()
    // When 提交一次再用同 ID 重试
    const first = await errorOf(() => trade.placeOrder({ ...ORDER, dryRun: false, intentId }))
    const retry = await errorOf(() => trade.placeOrder({ ...ORDER, dryRun: false, intentId }))
    // Then 先上游错误、再未知/在飞，桥侧仍只有一笔
    expect(first.code).toBe('TRADING_UPSTREAM_ERROR')
    expect(retry.code).toBe('TRADING_INTENT_UNKNOWN')
    expect(venue.orders()).toHaveLength(1)
  })
})

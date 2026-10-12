/**
 * 实盘下单的**意图幂等**用例（QMT；离线、真实临时 DSH_HOME、契约化假网关）。
 */
import { installTestAuthority, type TestAuthority } from '@dshtrading/authority/testing'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { QmtTradeService, type Config } from '../src/index.js'
import { fakeQmtVenue, type FakeQmtVenue } from './fake-qmt-venue.js'

let testAuthority: TestAuthority | undefined
let home = ''
let savedHome: string | undefined

beforeAll(() => {
  testAuthority = installTestAuthority()
  savedHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'dsh-qmt-order-intent-'))
  process.env.DSH_HOME = home
})

afterAll(() => {
  testAuthority?.uninstall()
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

function baseConfig(overrides: Partial<Config> = {}): Config {
  return { enabled: true, env: 'live', dryRun: false, liveTrading: true, gatewayUrl: 'http://qmt.test', accountId: 'Q-1', ...overrides }
}

function makeService(venue: FakeQmtVenue, overrides: Partial<Config> = {}): QmtTradeService {
  const config = baseConfig(overrides)
  return new QmtTradeService(new CordisContext() as never, {
    gatewayUrl: 'http://qmt.test',
    accountId: 'Q-1',
    fetchImpl: venue.fetchImpl,
    config,
  })
}

let seq = 0
function nextIntentId(): string {
  seq += 1
  return `qmt-intent-${seq}`
}

const ORDER = { symbol: '600519.SH', side: 'buy' as const, type: 'limit' as const, quantity: 100, price: 1500 }

async function errorOf(run: () => Promise<unknown>): Promise<{ code?: string; message?: string }> {
  return run().then(() => ({}), (error: unknown) => error as { code?: string; message?: string })
}

describe('实盘下单的意图幂等（QMT）', () => {
  it('user 实盘下单没带 intentId：结构化拒绝且网关没有收到请求', async () => {
    // Given 已获授权的 QMT 服务与假网关
    const venue = fakeQmtVenue()
    // When 不带 intentId 下实盘单
    const failure = await errorOf(() => makeService(venue).placeOrder({ ...ORDER, dryRun: false }))
    // Then 拒绝且零请求
    expect(failure.code).toBe('TRADING_INTENT_REQUIRED')
    expect(venue.requests()).toHaveLength(0)
  })

  it('user 用同一 intentId 重试同一笔单：只创建一笔并回带同一回执', async () => {
    // Given 一笔已提交的实盘单
    const venue = fakeQmtVenue()
    const trade = makeService(venue)
    const intentId = nextIntentId()
    const first = await trade.placeOrder({ ...ORDER, dryRun: false, intentId })
    // When 同 ID 同载荷重试
    const second = await trade.placeOrder({ ...ORDER, dryRun: false, intentId })
    // Then 网关只收到一笔，回执一致
    expect(venue.orders()).toHaveLength(1)
    expect(second).toEqual(first)
  })

  it('user 遇到「网关已建单但响应失败」后重试同 ID：不产生第二笔', async () => {
    // Given 一个受理后断连的假网关
    const venue = fakeQmtVenue({ outcome: 'lost-response' })
    const trade = makeService(venue)
    const intentId = nextIntentId()
    // When 首次失败后用同 ID 重试
    const first = await errorOf(() => trade.placeOrder({ ...ORDER, dryRun: false, intentId }))
    const retry = await errorOf(() => trade.placeOrder({ ...ORDER, dryRun: false, intentId }))
    // Then 首次错误已上报（不谎报订单）、重试未知/在飞，网关侧仍只有一笔
    expect(first.code).toBeTruthy()
    expect(retry.code).toBe('TRADING_INTENT_UNKNOWN')
    expect(venue.orders()).toHaveLength(1)
  })

  it('user 用同 ID 换载荷：冲突拒绝且网关看不到第二笔', async () => {
    // Given 一笔已提交的实盘单
    const venue = fakeQmtVenue()
    const trade = makeService(venue)
    const intentId = nextIntentId()
    await trade.placeOrder({ ...ORDER, dryRun: false, intentId })
    // When 用同 ID 改数量
    const failure = await errorOf(() => trade.placeOrder({ ...ORDER, quantity: 700, dryRun: false, intentId }))
    // Then 冲突拒绝、网关侧只有一笔
    expect(failure.code).toBe('TRADING_INTENT_CONFLICT')
    expect(venue.orders()).toHaveLength(1)
  })

  it('user 的网关回执没有订单 id：报错且重试仍是未知（不编 id）', async () => {
    // Given 一个受理了但不回订单 id 的假网关
    const venue = fakeQmtVenue({ outcome: 'no-id' })
    const trade = makeService(venue)
    const intentId = nextIntentId()
    // When 提交一次再用同 ID 重试
    const first = await errorOf(() => trade.placeOrder({ ...ORDER, dryRun: false, intentId }))
    const retry = await errorOf(() => trade.placeOrder({ ...ORDER, dryRun: false, intentId }))
    // Then 先交易所错误（不造 id）、再未知/在飞，网关侧仍只有一笔
    expect(first.code).toBe('TRADING_EXCHANGE_ERROR')
    expect(retry.code).toBe('TRADING_INTENT_UNKNOWN')
    expect(venue.orders()).toHaveLength(1)
  })
})

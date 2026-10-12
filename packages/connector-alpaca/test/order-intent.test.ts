/**
 * 实盘下单的**意图幂等**用例（Alpaca；离线、真实临时 DSH_HOME、契约化假交易所）。
 *
 * 场景先写：同 ID 同载荷只准一笔外部订单；venue 建了单而响应丢失时绝不自动重发；
 * 换载荷冲突拒绝；只有真实 venue orderId 才算 confirmed（不再有 synthetic id 兜底）。
 */
import { deriveVenueClientKey } from '@dshtrading/authority/order-intents'
import { installTestAuthority, type TestAuthority } from '@dshtrading/authority/testing'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ALPACA_CLIENT_ORDER_ID_RULE, AlpacaTradeService, type Config } from '../src/index.js'
import { fakeAlpacaVenue, type FakeAlpacaVenue } from './fake-alpaca-venue.js'

let testAuthority: TestAuthority | undefined
let home = ''
let savedHome: string | undefined

beforeAll(() => {
  testAuthority = installTestAuthority()
  savedHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'dsh-alpaca-order-intent-'))
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
    env: 'demo',
    dryRun: false,
    liveTrading: true,
    apiKeyRef: 'ALPACA_API_KEY',
    secretRef: 'ALPACA_SECRET_KEY',
    demoApiKeyRef: 'ALPACA_PAPER_API_KEY',
    demoSecretRef: 'ALPACA_PAPER_SECRET_KEY',
    ...overrides,
  }
}

/** 真实 TradeService；只有 HTTP 缝换成契约化假交易所。 */
function makeService(venue: FakeAlpacaVenue, overrides: Partial<Config> = {}): AlpacaTradeService {
  const config = baseConfig(overrides)
  return new AlpacaTradeService(
    new CordisContext() as never,
    { fetchImpl: venue.fetchImpl, tradingBaseUrl: 'https://alpaca.test/v2', env: config.env, config },
    async () => ({ key: 'alpaca-key-material-AAA', secret: 'alpaca-secret-material-BBB' }),
  )
}

let seq = 0
function nextIntentId(): string {
  seq += 1
  return `alpaca-intent-${seq}`
}

const ORDER = { symbol: 'AAPL', side: 'buy' as const, type: 'market' as const, quantity: 3 }

async function errorOf(run: () => Promise<unknown>): Promise<{ code?: string; message?: string }> {
  return run().then(() => ({}), (error: unknown) => error as { code?: string; message?: string })
}

describe('实盘下单的意图幂等（Alpaca）', () => {
  it('user 实盘下单没带 intentId：结构化拒绝且不触网', async () => {
    // Given 已获授权的 Alpaca 服务与假交易所
    const venue = fakeAlpacaVenue()
    const trade = makeService(venue)
    // When 不带 intentId 下实盘单
    const failure = await errorOf(() => trade.placeOrder({ ...ORDER, dryRun: false }))
    // Then 拒绝且交易所没有收到任何订单
    expect(failure.code).toBe('TRADING_INTENT_REQUIRED')
    expect(venue.requests()).toHaveLength(0)
  })

  it('user 用同一 intentId 重试同一笔单：只创建一笔并回带同一回执', async () => {
    // Given 一笔已提交的实盘单
    const venue = fakeAlpacaVenue()
    const trade = makeService(venue)
    const intentId = nextIntentId()
    const first = await trade.placeOrder({ ...ORDER, dryRun: false, intentId })
    // When 同一 ID 同一载荷重试
    const second = await trade.placeOrder({ ...ORDER, dryRun: false, intentId })
    // Then 交易所只有一笔，两次回执一致
    expect(venue.orders()).toHaveLength(1)
    expect(second).toEqual(first)
  })

  it('user 遇到「venue 已建单但响应失败」后重试同 ID：不产生第二笔', async () => {
    // Given 一个受理后断连的假交易所
    const venue = fakeAlpacaVenue({ outcome: 'lost-response' })
    const trade = makeService(venue)
    const intentId = nextIntentId()
    // When 首次失败后用同 ID 重试
    const first = await errorOf(() => trade.placeOrder({ ...ORDER, dryRun: false, intentId }))
    const retry = await errorOf(() => trade.placeOrder({ ...ORDER, dryRun: false, intentId }))
    // Then 首次是网络错误、重试是未知/在飞，交易所仍只有一笔
    expect(first.code).toBe('TRADING_NETWORK')
    expect(retry.code).toBe('TRADING_INTENT_UNKNOWN')
    expect(venue.orders()).toHaveLength(1)
  })

  it('user 用同 ID 换载荷：冲突拒绝且交易所看不到第二笔', async () => {
    // Given 一笔已提交的市价单
    const venue = fakeAlpacaVenue()
    const trade = makeService(venue)
    const intentId = nextIntentId()
    await trade.placeOrder({ ...ORDER, dryRun: false, intentId })
    // When 用同 ID 改数量
    const failure = await errorOf(() => trade.placeOrder({ ...ORDER, quantity: 9, dryRun: false, intentId }))
    // Then 冲突拒绝、交易所仍然只有一笔
    expect(failure.code).toBe('TRADING_INTENT_CONFLICT')
    expect(venue.orders()).toHaveLength(1)
  })

  it('user 的实盘单带上官方 client_order_id：确定性派生且 ≤48，不进回执', async () => {
    // Given 会记账请求体的假交易所
    const venue = fakeAlpacaVenue()
    const trade = makeService(venue)
    const intentId = nextIntentId()
    // When 提交实盘单
    const order = await trade.placeOrder({ ...ORDER, dryRun: false, intentId })
    // Then 请求体带 client_order_id（Alpaca 官方字段，≤48）且回执里没有它
    const body = venue.requests()[0] ?? {}
    expect(body.client_order_id).toBe(deriveVenueClientKey(intentId, ALPACA_CLIENT_ORDER_ID_RULE))
    expect(String(body.client_order_id).length).toBeLessThanOrEqual(48)
    expect(JSON.stringify(order)).not.toContain(String(body.client_order_id))
  })

  it('user 的 venue 回执没有订单 id：报交易所错误且重试仍是未知', async () => {
    // Given 一个受理了但不回 id 的假交易所
    const venue = fakeAlpacaVenue({ outcome: 'no-id' })
    const trade = makeService(venue)
    const intentId = nextIntentId()
    // When 提交一次再用同 ID 重试
    const first = await errorOf(() => trade.placeOrder({ ...ORDER, dryRun: false, intentId }))
    const retry = await errorOf(() => trade.placeOrder({ ...ORDER, dryRun: false, intentId }))
    // Then 不造 id、不写 confirmed：先交易所错误，再未知/在飞
    expect(first.code).toBe('TRADING_EXCHANGE_ERROR')
    expect(retry.code).toBe('TRADING_INTENT_UNKNOWN')
    expect(venue.orders()).toHaveLength(1)
  })
})

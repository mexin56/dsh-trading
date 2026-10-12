/**
 * 实盘下单的**意图幂等**用例（离线；真实临时 DSH_HOME、真实跨进程文件锁、契约化假交易所）。
 *
 * 场景先写：同 ID 同载荷只允许一笔外部订单；venue 建了单但我们没拿到回执时**绝不自动重发**；
 * 换载荷/provider/环境/账户要冲突拒绝；只有真实非空 venue orderId 才算 confirmed。
 * 零通用 mock 工具、零任意等待：假交易所按官方契约记账，用例只断言可见业务状态。
 */
import { liveTradingEnabled } from '@dshtrading/authority'
import { deriveVenueClientKey } from '@dshtrading/authority/order-intents'
import { installTestAuthority, type TestAuthority } from '@dshtrading/authority/testing'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Config, OkxCredentials } from '../src/index.js'
import { OKX_CLIENT_ORDER_ID_RULE, OkxTradeService } from '../src/index.js'
import { OkxRestClient } from '../src/rest.js'
import { fakeOkxVenue, type FakeOkxVenue } from './fake-okx-venue.js'

/* ------------------------------------------------------------------ */
/* 夹具：真实签名授权平面 + 显式临时 home（绝不继承宿主 DSH_HOME）           */
/* ------------------------------------------------------------------ */

let testAuthority: TestAuthority | undefined
let home = ''
let savedHome: string | undefined

beforeAll(() => {
  testAuthority = installTestAuthority()
  savedHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'dsh-okx-order-intent-'))
  process.env.DSH_HOME = home
})

afterAll(() => {
  testAuthority?.uninstall()
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

const CREDENTIALS: OkxCredentials = {
  key: 'okx-key-material-AAA',
  secret: 'okx-secret-material-BBB',
  passphrase: 'okx-passphrase-material-CCC',
}

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    enabled: true,
    env: 'demo',
    dryRun: false,
    liveTrading: true,
    apiKeyRef: 'OKX_API_KEY',
    secretRef: 'OKX_SECRET_KEY',
    passphraseRef: 'OKX_PASSPHRASE',
    demoApiKeyRef: 'OKX_DEMO_API_KEY',
    demoSecretRef: 'OKX_DEMO_SECRET_KEY',
    demoPassphraseRef: 'OKX_DEMO_PASSPHRASE',
    ...overrides,
  }
}

/** 真实 TradeService 实例，只有 fetch 缝被契约化假交易所替换。 */
function makeService(venue: FakeOkxVenue, overrides: Partial<Config> = {}): OkxTradeService {
  return new OkxTradeService(new CordisContext() as never, {
    client: new OkxRestClient({ baseUrl: 'https://okx.test', fetchImpl: venue.fetchImpl, clockSync: false, clockOffsetMs: 0 }),
    config: baseConfig(overrides),
    getCredentials: async () => CREDENTIALS,
  })
}

/** 每次调用一个全新意图 id（用例之间互不干扰）。 */
let seq = 0
function nextIntentId(): string {
  seq += 1
  return `okx-intent-${seq}`
}

const MARKET = { symbol: 'BTC-USDT', side: 'buy' as const, type: 'market' as const, quantity: 0.01 }

async function errorOf(run: () => Promise<unknown>): Promise<{ code?: string; message?: string }> {
  return run().then(() => ({}), (error: unknown) => error as { code?: string; message?: string })
}

function intentFiles(): string[] {
  try {
    return readdirSync(join(home, 'order-intents')).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
}

describe('实盘下单的意图幂等（OKX）', () => {
  it('user 实盘下单没带 intentId：结构化拒绝且不触网', async () => {
    // Given 一个已获实盘授权的 OKX 服务与一个假交易所
    const venue = fakeOkxVenue()
    const trade = makeService(venue)
    // When 不带 intentId 直接下实盘单
    const failure = await errorOf(() => trade.placeOrder({ ...MARKET, dryRun: false }))
    // Then 拒绝（没有幂等锚就不许触达 venue），交易所一笔单都没看到
    expect(failure.code).toBe('TRADING_INTENT_REQUIRED')
    expect(venue.orders()).toHaveLength(0)
    expect(venue.requests()).toHaveLength(0)
  })

  it('user 用同一 intentId 重试同一笔单：只创建一个外部订单并回带同一回执', async () => {
    // Given 一笔已成功提交的实盘单
    const venue = fakeOkxVenue()
    const trade = makeService(venue)
    const intentId = nextIntentId()
    const first = await trade.placeOrder({ ...MARKET, dryRun: false, intentId })
    // When 调用方用同一 ID 与同一载荷重试
    const second = await trade.placeOrder({ ...MARKET, dryRun: false, intentId })
    // Then 交易所侧只有一笔单，两次拿到的是同一份回执
    expect(venue.orders()).toHaveLength(1)
    expect(venue.requests()).toHaveLength(1)
    expect(second).toEqual(first)
    expect(second.id).toBe('okx-venue-1')
  })

  it('user 遇到「venue 已建单但响应失败」后重试同 ID：不产生第二笔外部订单', async () => {
    // Given 一个「受理后断连」的假交易所（订单真的进了撮合，客户端只看到网络错误）
    const venue = fakeOkxVenue({ outcome: 'lost-response' })
    const trade = makeService(venue)
    const intentId = nextIntentId()
    // When 第一次提交失败、随后用同一 ID 重试
    const firstFailure = await errorOf(() => trade.placeOrder({ ...MARKET, dryRun: false, intentId }))
    const retryFailure = await errorOf(() => trade.placeOrder({ ...MARKET, dryRun: false, intentId }))
    // Then 第一次是网络错误、重试是明确的未知/在飞；venue 侧仍然只有那一笔单
    expect(firstFailure.code).toBe('TRADING_NETWORK')
    expect(retryFailure.code).toBe('TRADING_INTENT_UNKNOWN')
    expect(venue.orders()).toHaveLength(1)
    expect(venue.requests()).toHaveLength(1)
  })

  it('user 并发提交同一个 intentId：交易所只收到一笔', async () => {
    // Given 一笔尚未提交的意图与一个假交易所
    const venue = fakeOkxVenue()
    const trade = makeService(venue)
    const intentId = nextIntentId()
    // When 两个调用同时提交同一 ID 与同一载荷
    const outcomes = await Promise.all([
      trade.placeOrder({ ...MARKET, dryRun: false, intentId }).then((order) => order.id, (error: { code?: string }) => error.code ?? 'error'),
      trade.placeOrder({ ...MARKET, dryRun: false, intentId }).then((order) => order.id, (error: { code?: string }) => error.code ?? 'error'),
    ])
    // Then 交易所只有一笔真实订单、只收到一次下单请求；两个调用都只会看到
    //      「这一笔的回执」或「明确的未知/在飞」——绝不会出现第二笔
    expect(venue.orders()).toHaveLength(1)
    expect(venue.requests()).toHaveLength(1)
    expect(outcomes.filter((value) => value === 'okx-venue-1').length).toBeGreaterThanOrEqual(1)
    for (const value of outcomes) {
      expect(['okx-venue-1', 'TRADING_INTENT_UNKNOWN']).toContain(value)
    }
  })

  it('user 用同 ID 改载荷：冲突拒绝，交易所不会看到第二笔', async () => {
    // Given 一笔已提交的市价单意图
    const venue = fakeOkxVenue()
    const trade = makeService(venue)
    const intentId = nextIntentId()
    await trade.placeOrder({ ...MARKET, dryRun: false, intentId })
    // When 用同一 ID 下一笔改了数量的单
    const failure = await errorOf(() => trade.placeOrder({ ...MARKET, quantity: 0.02, dryRun: false, intentId }))
    // Then 冲突拒绝（不改参数、不当作新单），交易所仍然只有一笔
    expect(failure.code).toBe('TRADING_INTENT_CONFLICT')
    expect(venue.orders()).toHaveLength(1)
  })

  it('user 换一个交易服务实例重试已确认的 ID：读回同一回执且不再触网', async () => {
    // Given 一笔已确认的单，以及一个任何交易请求都会炸的新实例
    const venue = fakeOkxVenue()
    const intentId = nextIntentId()
    const first = await makeService(venue).placeOrder({ ...MARKET, dryRun: false, intentId })
    const restarted = fakeOkxVenue({ outcome: 'ack' })
    // When 新实例（模拟重启后的进程）用同一 ID 重试
    const replayed = await makeService(restarted).placeOrder({ ...MARKET, dryRun: false, intentId })
    // Then 回带磁盘上的同一回执，新实例没有向交易所发过任何下单请求
    expect(replayed).toEqual(first)
    expect(restarted.requests()).toHaveLength(0)
    expect(restarted.orders()).toHaveLength(0)
  })

  it('user 的意图台账目录写不下去：拒绝下单且不调用交易所', async () => {
    // Given trading home 下 order-intents 位置被一个普通文件占住（真实写盘失败）
    const blockedHome = mkdtempSync(join(tmpdir(), 'dsh-okx-order-intent-blocked-'))
    writeFileSync(join(blockedHome, 'order-intents'), 'not a directory')
    const venue = fakeOkxVenue()
    const trade = makeService(venue)
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = blockedHome
    // When 提交一笔实盘单
    const failure = await errorOf(() => trade.placeOrder({ ...MARKET, dryRun: false, intentId: nextIntentId() }))
    // Then 报台账写盘失败，交易所一笔单都没收到（没有持久记录就不发实盘单）
    expect(failure.code).toBe('TRADING_INTENT_STORE_FAILED')
    expect(venue.requests()).toHaveLength(0)
    expect(venue.orders()).toHaveLength(0)
    process.env.DSH_HOME = previousHome
    rmSync(blockedHome, { recursive: true, force: true })
  })

  it('user 的 venue 回执没有 orderId：不写 confirmed，重试仍是未知', async () => {
    // Given 一个「受理了但回执不带 ordId」的假交易所
    const venue = fakeOkxVenue({ outcome: 'no-ordId' })
    const trade = makeService(venue)
    const intentId = nextIntentId()
    // When 提交一次、再用同一 ID 重试
    const firstFailure = await errorOf(() => trade.placeOrder({ ...MARKET, dryRun: false, intentId }))
    const retryFailure = await errorOf(() => trade.placeOrder({ ...MARKET, dryRun: false, intentId }))
    // Then 第一次是交易所错误（不造 id）、重试是未知；venue 侧仍只有一笔
    expect(firstFailure.code).toBe('TRADING_EXCHANGE_ERROR')
    expect(retryFailure.code).toBe('TRADING_INTENT_UNKNOWN')
    expect(venue.orders()).toHaveLength(1)
    expect(venue.requests()).toHaveLength(1)
  })

  it('user 的实盘单带上按 OKX 契约派生的 clOrdId：确定性、长度字符集都合法且不进回执', async () => {
    // Given 一个会记账请求体的假交易所
    const venue = fakeOkxVenue()
    const trade = makeService(venue)
    const intentId = nextIntentId()
    // When 提交这笔实盘单
    const order = await trade.placeOrder({ ...MARKET, dryRun: false, intentId })
    // Then 请求体带 clOrdId（OKX 官方：字母数字 ≤32，确定性派生自 intentId），
    //      而回执里没有任何 venue client key（它永不进 DTO/响应）
    const body = venue.requests()[0] ?? {}
    expect(String(body.clOrdId)).toMatch(/^[0-9a-zA-Z]{1,32}$/)
    expect(body.clOrdId).toBe(deriveVenueClientKey(intentId, OKX_CLIENT_ORDER_ID_RULE))
    expect(JSON.stringify(order)).not.toContain(String(body.clOrdId))
  })

  it('user 的台账记录不含任何凭据：密钥/口令只出现在请求头里', async () => {
    // Given 一笔已确认的实盘单
    const venue = fakeOkxVenue()
    const intentId = nextIntentId()
    await makeService(venue).placeOrder({ ...MARKET, dryRun: false, intentId })
    // When 读出台账记录原文
    const files = intentFiles()
    const raw = files.map((name) => readFileSync(join(home, 'order-intents', name), 'utf8')).join('\n')
    // Then 记录里只有意图身份与 venue 回执，没有任何凭据材料
    expect(files.length).toBeGreaterThan(0)
    expect(raw).toContain(intentId)
    expect(raw).not.toContain(CREDENTIALS.key)
    expect(raw).not.toContain(CREDENTIALS.secret)
    expect(raw).not.toContain(CREDENTIALS.passphrase)
  })

  it('user 的实盘闸门仍然先于台账：未获授权时连记录都不落', async () => {
    // Given 一个没拿到人工签署授权的 OKX 配置
    const venue = fakeOkxVenue()
    const trade = makeService(venue, { liveTrading: false })
    const before = intentFiles().length
    // When 请求实盘下单
    const failure = await errorOf(() => trade.placeOrder({ ...MARKET, dryRun: false, intentId: nextIntentId() }))
    // Then 闸门先拒绝（且 liveTradingEnabled 的判定没有被绕过），台账没有新增记录
    expect(liveTradingEnabled(false)).toBe(false)
    expect(failure.code).toBe('TRADING_LIVE_TRADING_DISABLED')
    expect(intentFiles().length).toBe(before)
    expect(venue.requests()).toHaveLength(0)
  })

  it('user 的 dry-run 下单不要求 intentId，也不写台账', async () => {
    // Given 一个没有 intentId 的模拟请求
    const venue = fakeOkxVenue()
    const trade = makeService(venue, { dryRun: true })
    const before = intentFiles().length
    // When 走模拟路径
    const order = await trade.placeOrder({ ...MARKET })
    // Then 拿到 dryRun 回执、不触网、台账不增长
    expect(order.dryRun).toBe(true)
    expect(intentFiles().length).toBe(before)
    expect(venue.requests()).toHaveLength(0)
  })
})

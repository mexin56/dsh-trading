/**
 * 订单意图台账用例（离线；真实临时文件、真实 `transactStore` 跨进程锁，零 mock / 零等待）。
 *
 * 每个用例显式把 `$DSH_HOME` 指到自己的临时目录：台账写在哪由 home 契约决定，
 * 继承宿主环境（`~/.dsh`）会污染真实实例的数据，也会让断言失去意义。
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ORDER_INTENT_PROTOCOL_VERSION,
  ORDER_INTENTS_DIR_NAME,
  OrderIntentError,
  OrderIntentLedger,
  deriveVenueClientKey,
  type OrderIntentPayload,
  type OrderIntentReceipt,
} from '../src/order-intents.ts'

/** 用例的临时 home 与平面目录（每个用例一份，用完即删）。 */
let home = ''
let plane = ''
let savedHome: string | undefined
let savedPlane: string | undefined
const madeDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  madeDirs.push(dir)
  return dir
}

beforeEach(() => {
  savedHome = process.env.DSH_HOME
  savedPlane = process.env.DSH_TRADING_AUTHORITY_DIR
  home = tempDir('dsh-order-intents-home-')
  plane = tempDir('dsh-order-intents-plane-')
  process.env.DSH_HOME = home
  process.env.DSH_TRADING_AUTHORITY_DIR = plane
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  if (savedPlane === undefined) delete process.env.DSH_TRADING_AUTHORITY_DIR
  else process.env.DSH_TRADING_AUTHORITY_DIR = savedPlane
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 台账实例（作用域默认 okx/live/default；用例只在该默认不适用时覆盖）。 */
function ledger(scope: Partial<{ provider: string; environment: string; account: string }> = {}): OrderIntentLedger {
  return new OrderIntentLedger({
    provider: scope.provider ?? 'okx',
    environment: scope.environment ?? 'live',
    account: scope.account ?? 'default',
  })
}

const PAYLOAD: OrderIntentPayload = { symbol: 'BTC-USDT', side: 'buy', type: 'market', quantity: 0.01 }

function receipt(overrides: Partial<OrderIntentReceipt> = {}): OrderIntentReceipt {
  return {
    id: '3875693089022251008',
    symbol: 'BTC-USDT',
    side: 'buy',
    type: 'market',
    status: 'new',
    quantity: 0.01,
    timestamp: 1_760_000_000_000,
    ...overrides,
  }
}

/** 台账目录下的记录文件名（不存在时返回空数组）。 */
function recordFiles(dir = join(home, ORDER_INTENTS_DIR_NAME)): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  } catch {
    return []
  }
}

async function errorOf(run: () => Promise<unknown>): Promise<{ code?: string; message?: string }> {
  return run().then(() => ({}), (error: unknown) => error as { code?: string; message?: string })
}

describe('订单意图台账：同 ID 只下一单', () => {
  it('user 首次实盘提交：先落下 unknown 记录，才拿到触网许可', async () => {
    // Given 一个空的 trading home 与一个从未用过的 intentId
    const store = ledger()
    // When 调用方在触网前请求裁决
    const decision = await store.begin({ intentId: 'intent-1', payload: PAYLOAD })
    // Then 裁决是 submit，且磁盘上已经有一条 unknown 记录（记录先于网络写成立）
    expect(decision).toEqual({ action: 'submit' })
    const record = await store.read('intent-1')
    expect(record).toMatchObject({
      version: ORDER_INTENT_PROTOCOL_VERSION,
      intentId: 'intent-1',
      state: 'unknown',
      provider: 'okx',
      environment: 'live',
    })
  })

  it('user 拿到 venue 回执后重试同 ID：拿回同一份回执且不再提交一次', async () => {
    // Given 一笔已经拿到 venue 真实 orderId 的意图
    const first = ledger()
    await first.begin({ intentId: 'intent-2', payload: PAYLOAD })
    await first.confirm({ intentId: 'intent-2', payload: PAYLOAD, receipt: receipt() })
    // When 另一个台账实例（模拟重启后的新进程）用同一 ID 与同一载荷重试
    const restarted = ledger()
    const decision = await restarted.begin({ intentId: 'intent-2', payload: PAYLOAD })
    // Then 直接重放同一回执，且台账仍只有这一条记录（没有第二条意图）
    expect(decision).toEqual({ action: 'replay', receipt: receipt() })
    expect(recordFiles()).toHaveLength(1)
  })

  it('user 用同 ID 换载荷：冲突拒绝，且不覆盖原记录', async () => {
    // Given 一个已绑定 market 单的 intentId
    const store = ledger()
    await store.begin({ intentId: 'intent-3', payload: PAYLOAD })
    const before = readFileSync(join(home, ORDER_INTENTS_DIR_NAME, recordFiles()[0]!), 'utf8')
    // When 用同一 ID 提交一个改了数量的限价单
    const failure = await errorOf(() => store.begin({
      intentId: 'intent-3',
      payload: { ...PAYLOAD, type: 'limit', price: 60_000, quantity: 0.02 },
    }))
    // Then 结构化冲突（不改参数、不当作新单），磁盘记录逐字未变
    expect(failure.code).toBe('TRADING_INTENT_CONFLICT')
    const after = readFileSync(join(home, ORDER_INTENTS_DIR_NAME, recordFiles()[0]!), 'utf8')
    expect(after).toBe(before)
  })

  it('user 用同 ID 换 provider、环境或账户：一样是冲突拒绝', async () => {
    // Given 一个属于 okx/live/default 的意图
    await ledger().begin({ intentId: 'intent-4', payload: PAYLOAD })
    // When 分别用另一个 provider、另一个环境、另一个账户重放同一 ID
    const otherProvider = await errorOf(() => ledger({ provider: 'alpaca' }).begin({ intentId: 'intent-4', payload: PAYLOAD }))
    const otherEnvironment = await errorOf(() => ledger({ environment: 'demo' }).begin({ intentId: 'intent-4', payload: PAYLOAD }))
    const otherAccount = await errorOf(() => ledger({ account: 'U-999' }).begin({ intentId: 'intent-4', payload: PAYLOAD }))
    // Then 三种都是冲突（未知意图不会因为换了执行目标而被重发）
    expect([otherProvider.code, otherEnvironment.code, otherAccount.code])
      .toEqual(['TRADING_INTENT_CONFLICT', 'TRADING_INTENT_CONFLICT', 'TRADING_INTENT_CONFLICT'])
  })

  it('user 在结局未知时重试同 ID：明确告知未知/在飞，绝不重发', async () => {
    // Given 一笔已提交但还没拿到回执的意图（模拟请求超时/进程崩溃）
    const store = ledger()
    await store.begin({ intentId: 'intent-5', payload: PAYLOAD })
    // When 调用方立刻用同一 ID 与同一载荷重试
    const failure = await errorOf(() => store.begin({ intentId: 'intent-5', payload: PAYLOAD }))
    // Then 得到 TRADING_INTENT_UNKNOWN（不是 submit），台账里也没有回执
    expect(failure.code).toBe('TRADING_INTENT_UNKNOWN')
    expect((await store.read('intent-5'))?.receipt).toBeUndefined()
  })

  it('user 并发提交同 ID 两次：只有一个请求拿到触网许可', async () => {
    // Given 一个空台账与同一个 intentId
    const store = ledger()
    // When 两个调用同时进入裁决
    const [a, b] = await Promise.all([
      store.begin({ intentId: 'intent-6', payload: PAYLOAD }).then((d) => d.action, (e: { code?: string }) => e.code ?? 'error'),
      store.begin({ intentId: 'intent-6', payload: PAYLOAD }).then((d) => d.action, (e: { code?: string }) => e.code ?? 'error'),
    ])
    // Then 恰好一个是 submit、另一个被未知/在飞挡下，磁盘上仍只有一条记录
    expect([a, b].sort()).toEqual(['TRADING_INTENT_UNKNOWN', 'submit'])
    expect(recordFiles()).toHaveLength(1)
  })

  it('user 缺 intentId：结构化拒绝，且不落下任何记录', async () => {
    // Given 一个空台账
    const store = ledger()
    // When 实盘路径没有给 intentId 就请求裁决
    const failure = await errorOf(() => store.begin({ intentId: undefined, payload: PAYLOAD }))
    // Then 拒绝（TRADING_INTENT_REQUIRED），磁盘上没有记录
    expect(failure.code).toBe('TRADING_INTENT_REQUIRED')
    expect(recordFiles()).toHaveLength(0)
  })

  it('user 的台账目录写不下去：拒绝提交，且不产生记录', async () => {
    // Given trading home 下 order-intents 位置被一个普通文件占住（真实写盘失败）
    writeFileSync(join(home, ORDER_INTENTS_DIR_NAME), 'not a directory')
    const store = ledger()
    // When 请求裁决
    const failure = await errorOf(() => store.begin({ intentId: 'intent-7', payload: PAYLOAD }))
    // Then 报写盘失败（调用方据此不触网），且没有留下任何可用记录
    expect(failure.code).toBe('TRADING_INTENT_STORE_FAILED')
    expect(recordFiles()).toHaveLength(0)
  })

  it('user 的记录文件损坏：不当作没有记录，也不放行重发', async () => {
    // Given 一条已提交的意图，其记录文件在磁盘上被截断成坏 JSON
    const store = ledger()
    await store.begin({ intentId: 'intent-8', payload: PAYLOAD })
    const file = join(home, ORDER_INTENTS_DIR_NAME, recordFiles()[0]!)
    writeFileSync(file, '{ "version": 1, "intentId": "intent-8"')
    // When 调用方再次请求同一 ID 的裁决
    const failure = await errorOf(() => store.begin({ intentId: 'intent-8', payload: PAYLOAD }))
    // Then 明确未知（绝不把坏记录当成空台账而重发）
    expect(failure.code).toBe('TRADING_INTENT_UNKNOWN')
  })

  it('user 想确认一笔没有 venue orderId 的回执：拒绝写 confirmed', async () => {
    // Given 一条已提交的意图，而 venue 回执里没有真实订单 id
    const store = ledger()
    await store.begin({ intentId: 'intent-9', payload: PAYLOAD })
    // When 试图把空 id 的回执写进台账
    const failure = await errorOf(() => store.confirm({ intentId: 'intent-9', payload: PAYLOAD, receipt: receipt({ id: '  ' }) }))
    // Then 拒绝（没有 venue 句柄就不算成功），记录仍停在 unknown
    expect(failure.code).toBe('TRADING_EXCHANGE_ERROR')
    expect((await store.read('intent-9'))?.state).toBe('unknown')
  })

  it('user 用 venue 读到的回执对账：unknown 推进到 confirmed，之后重放同一回执', async () => {
    // Given 一条结局未知的意图，以及从 venue 查单读回来的真实订单
    const store = ledger()
    await store.begin({ intentId: 'intent-10', payload: PAYLOAD })
    // When 人工/读对账把 venue 的真实回执记进台账
    const reconciled = await store.reconcile({ intentId: 'intent-10', receipt: receipt({ id: 'V-10' }) })
    const decision = await ledger().begin({ intentId: 'intent-10', payload: PAYLOAD })
    // Then 记录变成 confirmed，后续同 ID 请求只会重放这份回执
    expect(reconciled.state).toBe('confirmed')
    expect(decision).toEqual({ action: 'replay', receipt: receipt({ id: 'V-10' }) })
  })

  it('user 想对账一条台账里没有的意图：拒绝凭空造记录', async () => {
    // Given 一个空台账
    const store = ledger()
    // When 用 venue 侧看到的订单去对账一个从未记录过的 intentId
    const failure = await errorOf(() => store.reconcile({ intentId: 'never-seen', receipt: receipt({ id: 'V-11' }) }))
    // Then 拒绝，且磁盘上仍然没有记录
    expect(failure.code).toBe('TRADING_INTENT_UNKNOWN')
    expect(recordFiles()).toHaveLength(0)
  })

  it('user 提交多笔不同意图：每笔一份文件，定位不随台账增长变慢', async () => {
    // Given 一个空台账
    const store = ledger()
    // When 依次提交三笔不同 intentId
    for (const id of ['intent-a', 'intent-b', 'intent-c']) {
      await store.begin({ intentId: id, payload: PAYLOAD })
    }
    // Then 每笔各一份 sha256(意图 id) 命名的文件（O(1) 定位，不整表增长）
    const expected = ['intent-a', 'intent-b', 'intent-c']
      .map((id) => createHash('sha256').update(id).digest('hex') + '.json')
      .sort()
    expect(recordFiles()).toEqual(expected)
  })

  it('user 轮换凭据后重试同 ID：身份不变，仍是同一份记录', async () => {
    // Given 一笔在飞意图，随后运营换掉了 API key（凭据轮换不是换账户）
    const store = ledger()
    await store.begin({ intentId: 'intent-12', payload: PAYLOAD })
    process.env.OKX_API_KEY = 'rotated-key-material'
    const rotated = ledger()
    // When 换密钥后用同一 ID 重试
    const failure = await errorOf(() => rotated.begin({ intentId: 'intent-12', payload: PAYLOAD }))
    // Then 仍是同一条记录（未知/在飞），不会被当成新意图重发
    expect(failure.code).toBe('TRADING_INTENT_UNKNOWN')
    expect(recordFiles()).toHaveLength(1)
  })

  it('user 的运营台账只写 trading home：人工授权平面一个文件都不多', async () => {
    // Given 一个显式配置的人工签署授权平面目录
    const store = ledger()
    // When 记录一笔完整意图（提交 + 回执）
    await store.begin({ intentId: 'intent-13', payload: PAYLOAD })
    await store.confirm({ intentId: 'intent-13', payload: PAYLOAD, receipt: receipt() })
    // Then 记录落在 trading home 下，授权平面目录保持为空
    expect(recordFiles()).toHaveLength(1)
    expect(readdirSync(plane)).toEqual([])
  })

  it('user 从 intentId 派生 venue client key：确定性且不超 venue 长度上限', () => {
    // Given 一条 OKX 规则（官方契约：字母数字、至多 32 字符）
    const rule = { prefix: 'dsht', maxLength: 32 }
    // When 用同一个 intentId 派生两次、再用另一个 intentId 派生一次
    const first = deriveVenueClientKey('intent-14', rule)
    const again = deriveVenueClientKey('intent-14', rule)
    const other = deriveVenueClientKey('intent-15', rule)
    // Then 同一意图恒得同一键、落在 venue 字符集与长度内，不同意图不撞键
    expect(first).toBe(again)
    expect(first).not.toBe(other)
    expect(first).toMatch(/^[0-9a-zA-Z]{1,32}$/)
  })

  it('user 关掉台账后重开：已确认的意图不回退成可提交', async () => {
    // Given 一笔已确认的意图
    await ledger().begin({ intentId: 'intent-16', payload: PAYLOAD })
    await ledger().confirm({ intentId: 'intent-16', payload: PAYLOAD, receipt: receipt({ id: 'V-16' }) })
    // When 重新实例化台账并再次请求同 ID
    const decision = await ledger().begin({ intentId: 'intent-16', payload: PAYLOAD })
    // Then 明确重放，绝不是 submit
    expect(decision.action).toBe('replay')
  })

  it('user 的作用域缺字段：结构化拒绝，不落记录', async () => {
    // When 用一份 provider 为空串的台账配置请求裁决
    const failure = await errorOf(async () => {
      const broken = new OrderIntentLedger({ provider: '  ', environment: 'live', account: 'default' })
      await broken.begin({ intentId: 'intent-17', payload: PAYLOAD })
    })
    // Then 拒绝（配置错误必须响亮），且不产生记录
    expect(failure.code).toBe('TRADING_INTENT_REQUIRED')
    expect(recordFiles()).toHaveLength(0)
  })

  it('user 的台账错误可被调用方按码分支：OrderIntentError 带 code', async () => {
    // Given 一个已确认的意图
    const store = ledger()
    await store.begin({ intentId: 'intent-18', payload: PAYLOAD })
    await store.confirm({ intentId: 'intent-18', payload: PAYLOAD, receipt: receipt() })
    // When 用不同载荷重放
    const failure = await errorOf(() => store.begin({ intentId: 'intent-18', payload: { ...PAYLOAD, quantity: 1 } }))
    // Then 抛的是带 code 的 OrderIntentError（连接器据此映射到 TradingServiceError）
    expect(failure).toBeInstanceOf(OrderIntentError)
  })
})

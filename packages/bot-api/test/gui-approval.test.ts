/**
 * GUI 实盘动作的官方逐动作审批用例（user 视角 BDD）。
 *
 * 被测缝：`POST/DELETE /trade/order` 的 GUI 实盘路径在触达交易所前，必须经宿主
 * `ctx.approval.request` 拿到**一次**授权（`allowed-once`）。本文件的依赖全部是
 * 真实件，不 mock：
 *   - 真实 cordis `Context`（@deepseek-ai/cordis 4.0.4）；
 *   - 真实 `ApprovalService`（@deepseek-ai/dsh-user-approval 0.2.0-rc.2）——
 *     审计对 `approval/asked` + `approval/decided` 落在请求 agent 的会话日志里，
 *     并且 `request()` 要求会话处于打开的一轮（turn-enclosed），所以夹具默认
 *     `turn/start`；
 *   - 真实 `Session`（@deepseek-ai/dsh-session 0.2.0-rc.2，`Session.create` 的
 *     原生事件日志即审计证据本身）。
 *
 * 唯一的边界替身是 Agent：官方 `ApprovalService.request` 只读 `req.agent.session`
 * （见 lib/index.js `const session = req.agent.session`），scoped 派发由
 * `scopeTarget(req.agent, req.agent)` 承载；真实 Agent（agent-loop 拥有）多出的
 * inbox/cancel/ctx 等成员不参与本缝。替身只提供 `{ id, session }`，并由两条断言
 * 核对契约：应答者收到的 agent 与注册表解析出的对象恒等、审计对确实落在该 session
 * 日志中。交易所边界（TradeService）是仓库既有的契约化替身写法（同 bridge.test.ts）。
 *
 * 失败面（省略即漏）：审批缺席 / 无会话上下文 / 会话串号 / 拒绝 / 取消 / 断连 /
 * 缺稳定意图，全部 fail-closed 到 `TRADING_APPROVAL_DENIED`，且交易所侧零动作。
 */
import { Context } from '@deepseek-ai/cordis'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { OrderRequest, TradeService } from '@dshtrading/api'
import { describe, expect, it } from 'vitest'
import { TradingBridge, dispatchBridgeRequest, errorPayload, type BridgeHost } from '../src/bridge.ts'
import { GUI_APPROVAL_DENIED, createGuiApprovalSeat, type GuiApprovalHost, type GuiApprovalSeat } from '../src/gui-approval.ts'

/** 官方审批结果封闭词表（@deepseek-ai/dsh-user-approval/lib/types/types.d.ts）。 */
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

interface AskRecord {
  readonly agent: unknown
  readonly toolName: string
  readonly reason: string | undefined
}

/** 真实会话：审批审计对必须 turn-enclosed，故夹具默认先开一轮。 */
function sessionWithOpenTurn(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  return session
}

interface GuiSeatFixture {
  readonly ctx: Context
  readonly session: Session
  readonly agent: { id: SessionId; session: Session }
  readonly asked: AskRecord[]
  readonly seat: GuiApprovalSeat
}

/**
 * 真实审批面夹具：真实 Context + 真实 ApprovalService + 真实 Session + 应答者。
 * @param options.mountApproval=false 模拟宿主未挂审批服务（headless）；
 * @param options.mountAnswerer=false 模拟无人在场的应答链（fail-closed）；
 * @param options.registry 控制 agents 注册表解析结果（缺席 / 串到别的会话）。
 */
function guiSeatFixture(options: {
  sessionId?: string
  /** false = 会话空闲（没有打开的一轮）：官方 request() 会抛错，必须同样 fail-closed。 */
  openTurn?: boolean
  mountApproval?: boolean
  mountAnswerer?: boolean
  registry?: 'live' | 'empty' | 'mismatched'
  answer?: (ask: AskRecord) => Promise<ApprovalOutcome>
} = {}): GuiSeatFixture {
  const sessionId = options.sessionId ?? 'session-gui-1'
  const ctx = new Context()
  const approval = new ApprovalService(ctx, { policy: 'ask' })
  const session = options.openTurn === false ? Session.create(SessionId(sessionId)) : sessionWithOpenTurn(sessionId)
  const agent = { id: session.id, session }
  const asked: AskRecord[] = []
  if (options.mountAnswerer !== false) {
    ctx.on('approval/request', (request: { agent: unknown; toolName: string; reason?: string }) => {
      const ask: AskRecord = { agent: request.agent, toolName: request.toolName, reason: request.reason }
      asked.push(ask)
      return options.answer === undefined ? Promise.resolve<ApprovalOutcome>('allowed-once') : options.answer(ask)
    })
  }
  const host: GuiApprovalHost = {
    approval: () => (options.mountApproval === false ? undefined : approval),
    agent: (id) => {
      if (options.registry === 'empty') return undefined
      if (options.registry === 'mismatched') return { id: SessionId('session-elsewhere'), session }
      return id === sessionId ? agent : undefined
    },
  }
  return { ctx, session, agent, asked, seat: createGuiApprovalSeat(host) }
}

interface RecordingTrade {
  readonly service: TradeService
  readonly placed: Array<OrderRequest & { intentId?: string }>
  readonly canceled: string[]
}

/** 交易所边界替身：只记录真实到达交易所的动作（观测点是订单/撤单状态，不是调用次数）。 */
function recordingTrade(): RecordingTrade {
  const placed: Array<OrderRequest & { intentId?: string }> = []
  const canceled: string[] = []
  const service: TradeService = {
    async placeOrder(request) {
      placed.push(request)
      return {
        id: 'ord-' + String(placed.length),
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        status: 'new',
        quantity: request.quantity,
        dryRun: request.dryRun ?? false,
        timestamp: 1,
      }
    },
    async cancelOrder(id) {
      canceled.push(id)
    },
    async getOrder(symbol, id) {
      return { id, symbol, side: 'buy', type: 'market', status: 'new', quantity: 1, dryRun: false, timestamp: 1 }
    },
    async getPositions() {
      return []
    },
  }
  return { service, placed, canceled }
}

function guiBridgeHost(seat: GuiApprovalSeat | undefined, trade: TradeService): BridgeHost {
  return {
    getMarketService: () => undefined,
    activeProvider: () => 'okx',
    getTradeService: market => (market === 'crypto' ? trade : undefined),
    ...(seat === undefined ? {} : { guiApproval: seat }),
  }
}

/** 会话日志里审批审计对的投影（durable log 观察，不是内部调用计数）。 */
function auditTrail(session: Session): Array<{ type: string; data: Record<string, unknown> }> {
  return session
    .snapshotEvents()
    .filter(event => event.type === 'approval/asked' || event.type === 'approval/decided')
    .map(event => ({ type: event.type, data: event.data as Record<string, unknown> }))
}

const LIVE_ORDER_BODY = {
  symbol: 'BTCUSDT-SWAP',
  side: 'buy',
  type: 'limit',
  quantity: 0.02,
  price: 42000,
  dryRun: false,
  intentId: 'intent-live-1',
  sessionId: 'session-gui-1',
}

const ORDER_QUERY = new URLSearchParams({ market: 'crypto' })

/**
 * 桥拒绝 → 前端实际看到的 payload 形状：路由层把非协议错误映射成
 * HTTP 200 + { ok:false, code, message }（bridge/index.ts 的 errorPayload 通路）。
 */
async function denialPayload(pending: Promise<{ status: number; payload: unknown }>): Promise<{ status?: number; ok?: boolean; code?: string; message?: string }> {
  try {
    const settled = await pending
    return { status: settled.status, ...(settled.payload as { ok?: boolean; code?: string; message?: string }) }
  } catch (error) {
    return { ok: false, ...errorPayload(error) }
  }
}

describe('GUI 实盘动作的逐动作审批（ctx.approval.request）', () => {
  it('user approving a live GUI order releases exactly that order with the exact parameters', async () => {
    // Given: 真实审批面（授权一次）+ 记录用交易所边界 + GUI 桥
    const fixture = guiSeatFixture()
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(fixture.seat, trade.service))

    // When: 用户在当前会话的行情面板提交一笔实盘限价单
    const { status, payload } = await dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY)

    // Then: 订单带完整参数与稳定意图到达交易所，且审批审计对落在此会话日志
    expect(status).toBe(200)
    expect(payload).toMatchObject({ ok: true, order: { symbol: 'BTCUSDT-SWAP', dryRun: false } })
    expect(trade.placed).toEqual([
      { symbol: 'BTCUSDT-SWAP', side: 'buy', type: 'limit', quantity: 0.02, price: 42000, dryRun: false, intentId: 'intent-live-1' },
    ])
    expect(auditTrail(fixture.session).map(entry => entry.type)).toEqual(['approval/asked', 'approval/decided'])
    expect(auditTrail(fixture.session)[1]!.data).toMatchObject({ outcome: 'allowed-once' })
  })

  it('user rejecting the approval keeps the exchange untouched and sees TRADING_APPROVAL_DENIED', async () => {
    // Given: 应答者明确拒绝
    const fixture = guiSeatFixture({ answer: async () => 'rejected' })
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(fixture.seat, trade.service))

    // When: 用户提交实盘单
    const payload = await denialPayload(dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY))

    // Then: 没有订单（也不伪造 dry-run 回执），拒绝被记进该会话审计
    expect(payload).toMatchObject({ ok: false, code: GUI_APPROVAL_DENIED })
    expect(trade.placed).toEqual([])
    expect(auditTrail(fixture.session).find(entry => entry.type === 'approval/decided')?.data).toMatchObject({ outcome: 'rejected' })
  })

  it('user whose HTTP request goes away while the approval is pending gets no order', async () => {
    // Given: 审批悬置未决，客户端连接随后断开（超时/关标签页）
    const fixture = guiSeatFixture({ answer: () => new Promise<ApprovalOutcome>(() => {}) })
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(fixture.seat, trade.service))
    const disconnect = new AbortController()

    // When: 请求带着连接信号发出，并在审批未决时被取消
    const pending = dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY, disconnect.signal)
    disconnect.abort()
    const payload = await denialPayload(pending)

    // Then: 明确拒绝，交易所零动作
    expect(payload).toMatchObject({ ok: false, code: GUI_APPROVAL_DENIED })
    expect(trade.placed).toEqual([])
  })

  it('user with no session context is denied and the other live sessions are never asked', async () => {
    // Given: 面板拿不到当前会话 id（或会话已不在宿主）
    const fixture = guiSeatFixture()
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(fixture.seat, trade.service))

    // When: 提交实盘单（无 sessionId / 未知 sessionId）
    const withoutSession = await denialPayload(dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, {
      ...LIVE_ORDER_BODY, sessionId: undefined,
    }))
    const unknownSession = await denialPayload(dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, {
      ...LIVE_ORDER_BODY, sessionId: 'session-from-another-window',
    }))

    // Then: 两次都明确拒绝，交易所零动作，且没有任何审批被问到别的会话
    expect(withoutSession).toMatchObject({ ok: false, code: GUI_APPROVAL_DENIED })
    expect(unknownSession).toMatchObject({ ok: false, code: GUI_APPROVAL_DENIED })
    expect(trade.placed).toEqual([])
    expect(auditTrail(fixture.session)).toEqual([])
    expect(fixture.asked).toEqual([])
  })

  it('user on a host without the approval service is denied rather than silently trading', async () => {
    // Given: 宿主未挂 ctx.approval（headless / 老部署）
    const fixture = guiSeatFixture({ mountApproval: false })
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(fixture.seat, trade.service))

    // When: 提交实盘单
    const payload = await denialPayload(dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY))

    // Then: 拒绝，交易所零动作
    expect(payload).toMatchObject({ ok: false, code: GUI_APPROVAL_DENIED })
    expect(trade.placed).toEqual([])
  })

  it('user on an idle session (no open turn) is denied rather than silently trading', async () => {
    // Given: 会话存在但当前没有打开的一轮（ApprovalService 的审计对必须 turn-enclosed，
    //        官方 request() 在空闲会话直接抛错）
    const fixture = guiSeatFixture({ openTurn: false })
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(fixture.seat, trade.service))

    // When: 用户提交实盘单
    const payload = await denialPayload(dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY))

    // Then: 明确拒绝、交易所零动作、日志里没有任何半截审计
    expect(payload).toMatchObject({ ok: false, code: GUI_APPROVAL_DENIED })
    expect(trade.placed).toEqual([])
    expect(auditTrail(fixture.session)).toEqual([])
  })

  it('user on a host with no answerer receives the fail-closed denial', async () => {
    // Given: 审批服务在场但应答链为空（无人在场）
    const fixture = guiSeatFixture({ mountAnswerer: false })
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(fixture.seat, trade.service))

    // When: 提交实盘单
    const payload = await denialPayload(dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY))

    // Then: 归属 unavailable 的 fail-closed 拒绝
    expect(payload).toMatchObject({ ok: false, code: GUI_APPROVAL_DENIED })
    expect(trade.placed).toEqual([])
    expect(auditTrail(fixture.session).find(entry => entry.type === 'approval/decided')?.data).toMatchObject({ outcome: 'unavailable' })
  })

  it('user is asked with the full normalized action snapshot bound to the asking agent and session', async () => {
    // Given: 真实审批面（应答者记录被问到的内容）
    const fixture = guiSeatFixture()
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(fixture.seat, trade.service))

    // When: 提交实盘限价单
    await dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY)

    // Then: 审批绑定实际 agent，且展示快照含完整 market/symbol/side/type/quantity/price/intentId
    expect(fixture.asked).toHaveLength(1)
    const ask = fixture.asked[0]!
    expect(ask.agent).toBe(fixture.agent)
    expect(ask.toolName).toBe('crypto_place_order')
    for (const field of [
      'market=crypto',
      'symbol=BTCUSDT-SWAP',
      'side=buy',
      'type=limit',
      'quantity=0.02',
      'price=42000',
      'intentId=intent-live-1',
      'sessionId=session-gui-1',
    ]) {
      expect(ask.reason).toContain(field)
    }
  })

  it('user approving once is asked again for the next action (a grant never carries over)', async () => {
    // Given: 授权一次的审批面
    const fixture = guiSeatFixture()
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(fixture.seat, trade.service))

    // When: 用户连做两笔实盘动作（同一会话、两个意图）
    await dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, LIVE_ORDER_BODY)
    await dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, { ...LIVE_ORDER_BODY, intentId: 'intent-live-2' })

    // Then: 两笔各自到达交易所，且审计对是两组（授权只覆盖它批准的那一次动作）
    expect(trade.placed.map(order => order.intentId)).toEqual(['intent-live-1', 'intent-live-2'])
    expect(auditTrail(fixture.session).map(entry => entry.type)).toEqual([
      'approval/asked', 'approval/decided', 'approval/asked', 'approval/decided',
    ])
  })

  it('user placing a live order without a stable intent is refused before any approval is asked', async () => {
    // Given: 真实审批面
    const fixture = guiSeatFixture()
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(fixture.seat, trade.service))

    // When: 提交缺少意图 id 的实盘单
    const rejected = await dispatchBridgeRequest(bridge, 'POST', '/trade/order', ORDER_QUERY, {
      ...LIVE_ORDER_BODY, intentId: undefined,
    }).catch((error: unknown) => error as { status?: number })

    // Then: 协议层 400，交易所零动作，也没有对无人认领的动作发起审批
    expect(rejected).toMatchObject({ status: 400 })
    expect(trade.placed).toEqual([])
    expect(auditTrail(fixture.session)).toEqual([])
  })

  it('user approving a GUI cancel cancels exactly that order', async () => {
    // Given: 真实审批面与一个已挂单
    const fixture = guiSeatFixture()
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(fixture.seat, trade.service))

    // When: 用户撤单
    const { payload } = await dispatchBridgeRequest(
      bridge, 'DELETE', '/trade/order',
      new URLSearchParams({ market: 'crypto', id: 'ord-1', symbol: 'BTCUSDT-SWAP', sessionId: 'session-gui-1', intentId: 'intent-cancel-1' }),
    )

    // Then: 撤单到达交易所，审批记录同样绑定该会话
    expect(payload).toEqual({ ok: true, canceled: true })
    expect(trade.canceled).toEqual(['ord-1'])
    expect(auditTrail(fixture.session).map(entry => entry.type)).toEqual(['approval/asked', 'approval/decided'])
    expect(fixture.asked[0]?.toolName).toBe('crypto_cancel_order')
  })

  it('user rejecting the cancel approval leaves the order live', async () => {
    // Given: 应答者拒绝撤单审批
    const fixture = guiSeatFixture({ answer: async () => 'rejected' })
    const trade = recordingTrade()
    const bridge = new TradingBridge(guiBridgeHost(fixture.seat, trade.service))

    // When: 用户撤单
    const payload = await denialPayload(dispatchBridgeRequest(
      bridge, 'DELETE', '/trade/order',
      new URLSearchParams({ market: 'crypto', id: 'ord-1', symbol: 'BTCUSDT-SWAP', sessionId: 'session-gui-1', intentId: 'intent-cancel-1' }),
    ))

    // Then: 明确拒绝，订单仍在交易所挂着
    expect(payload).toMatchObject({ ok: false, code: GUI_APPROVAL_DENIED })
    expect(trade.canceled).toEqual([])
  })
})

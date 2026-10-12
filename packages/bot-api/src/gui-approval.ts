/**
 * GUI 实盘动作的官方逐动作审批适配（宿主 `ctx.approval.request`）。
 *
 * 为什么需要这一层：GUI 交易台（`POST/DELETE /trade/order`，默认 `dryRun:false`）
 * 不经 base 的 `tools/pre-execute` 闸门——那条面只覆盖 agent 工具调用。用户裁决
 * 「保留 GUI 实盘，接入官方逐动作审批」后，GUI 的实盘路径必须自己把同一个官方审批
 * 缝接上：`ctx.approval.request({ agent, toolName, reason, signal })`，只认
 * `allowed-once`。本模块不自制 approve 布尔量、不自制 token、不缓存授权。
 *
 * 契约来源（0.2.0-rc.2 只读核对，本包不运行期 import，用结构化最小面）：
 *   - `@deepseek-ai/dsh-user-approval` `lib/types/index.d.ts`：`ApprovalService.request(req)`
 *     返回 `ApprovalOutcome`；`lib/types/types.d.ts` 的封闭词表 =
 *     `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，其中 `allowed-once`
 *     是**唯一**授权；`rejected`/`cancelled`/`unavailable` 一律 fail-closed。
 *   - `ApprovalRequest` 必填 `agent` 与 `toolName`，可选 `callId`/`reason`/`signal`；
 *     服务自动向**该 agent 的会话日志**追加 `approval/asked` + `approval/decided` 审计对，
 *     并把问题按 agent 作用域派发给应答者（客户端只答它拥有的 agent）。`request()` 要求
 *     会话处于打开的一轮（审计对必须 turn-enclosed），空闲会话直接抛错——本层把这个抛错
 *     也归到 `TRADING_APPROVAL_DENIED`（fail-closed，不退化成模拟）。
 *   - 会话空闲/无应答者/服务缺席都**不是**可以放行的理由：GUI 侧只有
 *     `TRADING_APPROVAL_DENIED` 一种出口，绝不伪造 dry-run 回执。
 *
 * 展示与绑定用同一个规范化快照：`market/symbol/side/type/quantity/price/intentId`
 * （撤单为 `market/orderId/symbol/intentId`）逐字段出现在 `reason` 里，用户批的就是
 * 屏幕上这一笔；agent 由 sessionId 解析并与 `agent.session.id` 复核，防止多窗口
 * 串会话误批。
 *
 * @module
 */

/** GUI 实盘动作被拒的唯一错误码（前端据此区分「审批没成」与「服务/凭证问题」）。 */
export const GUI_APPROVAL_DENIED = 'TRADING_APPROVAL_DENIED'

/**
 * 官方审批结果封闭词表（`@deepseek-ai/dsh-user-approval` 0.2.0-rc.2）。
 * `allowed-once` 是唯一授权值。
 */
export type GuiApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 宿主 `ctx.approval` 的最小结构面（真实实现 = `ApprovalService`）。 */
export interface ApprovalServiceLike {
  /** 一次性决策；实现细节见 @deepseek-ai/dsh-user-approval。 */
  request(req: {
    readonly agent: unknown
    readonly toolName: string
    readonly reason?: string
    readonly signal?: AbortSignal
  }): Promise<unknown>
}

/** 宿主 `agents` 服务的最小结构面：按 sessionId 取活跃 Agent（tasks/runner 同款）。 */
export interface GuiAgentRegistryLike {
  get(sessionId: string): unknown
}

/** 桥可注入的审批宿主面（`index.ts` 从 cordis ctx 惰性解析）。 */
export interface GuiApprovalHost {
  /** 宿主审批服务；未挂载（headless/老部署）返回 undefined。 */
  approval(): ApprovalServiceLike | undefined
  /** 按会话 id 解析当前活跃 Agent；无活跃会话返回 undefined。 */
  agent(sessionId: string): unknown
}

/** 规范化后的实盘下单动作（审批展示与绑定同源）。 */
export interface GuiPlaceOrderAction {
  readonly action: 'place-order'
  readonly market: string
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly type: 'market' | 'limit'
  readonly quantity: number
  readonly price?: number | undefined
  /** 本次逻辑提交的稳定意图 id（重试保持，成功或新意图轮换）。 */
  readonly intentId: string
  /** 发起动作的官方会话 id（审批绑定该会话的 agent）。 */
  readonly sessionId: string
}

/** 规范化后的实盘撤单动作。 */
export interface GuiCancelOrderAction {
  readonly action: 'cancel-order'
  readonly market: string
  readonly orderId: string
  readonly symbol?: string | undefined
  readonly intentId: string
  readonly sessionId: string
}

/** GUI 实盘动作（下单 / 撤单）：只有这两种进审批闸门。 */
export type GuiLiveAction = GuiPlaceOrderAction | GuiCancelOrderAction

/**
 * 审批工具名：与 base 闸门同一市场词汇（`<market>_place_order` /
 * `<market>_cancel_order`），审计里 GUI 动作与 agent 工具动作可同口径检索。
 */
export function guiLiveActionToolName(action: GuiLiveAction): string {
  return `${action.market}_${action.action === 'place-order' ? 'place_order' : 'cancel_order'}`
}

/**
 * 规范化参数快照（用户批的就是这一行）：字段顺序固定、缺省值显式化
 * （市价单显示 `price=none`，撤单显示 `orderId`），便于审计逐字比对。
 */
export function formatGuiLiveAction(action: GuiLiveAction): string {
  const head = `market=${action.market} action=${action.action}`
  const tail = `intentId=${action.intentId} sessionId=${action.sessionId}`
  if (action.action === 'cancel-order') {
    return `${head} orderId=${action.orderId} symbol=${action.symbol ?? 'none'} ${tail}`
  }
  return [
    head,
    `symbol=${action.symbol}`,
    `side=${action.side}`,
    `type=${action.type}`,
    `quantity=${String(action.quantity)}`,
    `price=${action.price === undefined ? 'none' : String(action.price)}`,
    tail,
  ].join(' ')
}

/** 审批被拒（缺席/无上下文/串会话/拒绝/取消/断连）：实盘路径唯一出口。 */
export class GuiApprovalDeniedError extends Error {
  /** 前端可判别的稳定错误码。 */
  readonly code = GUI_APPROVAL_DENIED
  constructor(reason: string) {
    super(`${GUI_APPROVAL_DENIED}: ${reason}`)
    this.name = 'GuiApprovalDeniedError'
  }
}

/** 逐动作审批座位：`authorize` 正常返回 = 拿到本次动作的一次性授权。 */
export interface GuiApprovalSeat {
  /**
   * 为一次具体动作取审批。
   * @param action - 规范化动作（展示 + 绑定同源）。
   * @param options.signal - HTTP 连接信号；断连/超时即取消审批且不得继续报单。
   * @returns 仅当官方结果为 `allowed-once` 且信号仍活着时 resolve。
   * @throws GuiApprovalDeniedError 其它一切情形（含服务缺席、无应答者、空闲会话）。
   */
  authorize(action: GuiLiveAction, options?: { readonly signal?: AbortSignal | undefined }): Promise<void>
}

/** Agent 上的会话读面（真实 Agent 由 agent-loop 拥有，这里只读它驱动的会话）。 */
function sessionIdOfAgent(agent: unknown): string | undefined {
  const session = (agent as { session?: { id?: unknown } } | null | undefined)?.session
  const id = session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 建审批座位：把桥的实盘动作接到宿主官方审批服务上。
 *
 * fail-closed 顺序（任一不满足即拒，且**不**触碰交易所）：
 *   1. 有会话上下文（sessionId 非空）——否则无处绑定审批；
 *   2. 连接未断（signal 未 abort）；
 *   3. 该会话有活跃 Agent，且 `agent.session.id` 与请求的会话一致（多窗口串会话防线）；
 *   4. 宿主挂了 `ctx.approval`；
 *   5. 官方结果为 `allowed-once`（rejected/cancelled/unavailable/异常一律拒）；
 *   6. 裁决返回时连接仍在。
 *
 * @param host - 宿主面（审批服务 + agents 注册表，皆惰性解析）。
 * @returns 审批座位。
 */
export function createGuiApprovalSeat(host: GuiApprovalHost): GuiApprovalSeat {
  // 显式标注的 never 返回函数：调用点之后 TS 才按「已排除」收窄（agent/approval 非空）。
  const deny: (reason: string) => never = (reason) => {
    throw new GuiApprovalDeniedError(reason)
  }
  return {
    async authorize(action, options) {
      const signal = options?.signal
      /**
       * 连接是否已断。每次调用实时读：直接比较属性会被 TS 控制流收窄成「恒 false」，
       * 而断连是异步事件，第二次读必须重新取值。
       */
      const disconnected = (): boolean => signal?.aborted === true
      if (action.sessionId === '') {
        deny('the trading panel sent no session id, so this action has no agent/session to bind the approval to')
      }
      if (disconnected()) {
        deny('the HTTP request was already gone before the approval ask')
      }
      const agent = host.agent(action.sessionId)
      if (agent === undefined) {
        deny(`no live agent for session ${action.sessionId}`)
      }
      const agentSessionId = sessionIdOfAgent(agent)
      if (agentSessionId === undefined) {
        deny(`the live agent for session ${action.sessionId} exposes no session log to audit against`)
      }
      if (agentSessionId !== action.sessionId) {
        deny(`agent/session mismatch: asked for ${action.sessionId} but the registry resolved ${agentSessionId}`)
      }
      const approval = host.approval()
      if (approval === undefined) {
        deny('the host approval service (ctx.approval) is not mounted')
      }
      let outcome: unknown
      try {
        outcome = await approval.request({
          agent,
          toolName: guiLiveActionToolName(action),
          reason: `GUI ${action.action} needs a one-shot user approval — ${formatGuiLiveAction(action)}`,
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (error) {
        deny(`the host approval ask produced no decision (${messageOf(error)})`)
      }
      if (outcome !== 'allowed-once') {
        deny(`approval outcome ${JSON.stringify(outcome)} is not a one-shot grant`)
      }
      if (disconnected()) {
        deny('the HTTP request went away while the approval was pending')
      }
    },
  }
}

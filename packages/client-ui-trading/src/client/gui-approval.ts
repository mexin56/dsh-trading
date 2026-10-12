/**
 * GUI 实盘提交身份与拒绝回执（客户端半）。
 *
 * 用户裁决「保留 GUI 实盘，接入官方逐动作审批」后的客户端契约：
 *   - **提交身份**：每个实盘动作带两样东西——官方当前会话 id（宿主据此解析 agent 并把
 *     审批绑到该会话）与本次逻辑提交的稳定意图 id（uuid）。未知结果/网络失败重试
 *     保持同一意图（宿主的 OrderRequest.intentId 据此把重试收敛成同一笔）；参数变化、
 *     成功之后、或用户主动发起新动作才换新意图。
 *   - **会话上下文**：从官方 client context 读出（QuotePane 的 `useSessions` +
 *     `currentSessionId`），逐层传到真实下单调用点。拿不到会话时**不自行放行、也不
 *     自行拒绝**：照旧把动作送交宿主，由审批面给出权威的 TRADING_APPROVAL_DENIED。
 *   - **回执诚实**：审批没成就是没成——UI 明确显示拒绝码，绝不显示成交，也不伪造
 *     dry-run 回执（dryRun:false 是原产品保留的实盘缺省，由 api.ts 固定发送）。
 *
 * 本模块不 import 宿主 SDK：客户端只有 `{ sessionId?, intentId }` 这一种身份词汇。
 *
 * @module
 */

import type { GuiOrderInput, GuiOrderResult } from './api.ts'
import type { MarketId } from './types.ts'

/** 宿主审批拒绝的稳定错误码（与 @dshtrading/bot-api 的 gui-approval 同词）。 */
export const GUI_APPROVAL_DENIED = 'TRADING_APPROVAL_DENIED'

/** 一次 GUI 实盘提交的身份：官方会话 id（审批绑定）+ 稳定意图 id。 */
export interface GuiOrderApprovalContext {
  /** 官方当前会话 id；缺席/空串 = 无审批上下文（宿主 fail-closed 拒绝）。 */
  readonly sessionId?: string | undefined
  /** 本次逻辑提交的稳定意图 id（uuid；重试保持，成功/新意图轮换）。 */
  readonly intentId: string
}

/**
 * GUI 实盘审批的会话读面：QuotePane 用官方 `useSessions` 解出当前主视图会话后
 * 以本面逐层传下去（MiddleStage → QuoteStage）。缺席 = 无审批上下文。
 */
export interface GuiApprovalContextProps {
  /** 读当前主视图会话 id；无会话返回 undefined。 */
  guiSessionId?: (() => string | undefined) | undefined
}

/** 一次提交的结局分类（决定意图 id 是否续用）。 */
export type GuiOrderOutcome = 'success' | 'rejected' | 'unknown'

/** UUID v4 形状的回退生成（非安全上下文/裸 jsdom 里 `crypto.randomUUID` 可能缺席）。 */
function fallbackIntentId(): string {
  const bytes = new Uint8Array(16)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256)
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'))
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-')
}

/** 生成一个新意图 id（优先官方 `crypto.randomUUID`）。 */
export function createOrderIntentId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return typeof uuid === 'string' ? uuid : fallbackIntentId()
}

/**
 * 动作关键指纹：把一次提交的业务参数写成一个可比较的串。只有指纹相同才可能是
 * 「同一笔的重试」——参数一变就是新意图，绝不拿旧意图去覆盖新动作。
 */
export function guiOrderActionKey(market: MarketId, input: GuiOrderInput): string {
  return [
    'place',
    market,
    input.symbol,
    input.side,
    input.type,
    String(input.quantity),
    input.price === undefined ? 'none' : String(input.price),
  ].join('|')
}

/** 撤单动作的指纹（市场 + 订单 id 定位同一笔撤单）。 */
export function guiCancelActionKey(market: MarketId, orderId: string): string {
  return ['cancel', market, orderId].join('|')
}

/**
 * 结果分类：
 *   - `success`：订单已落地（意图完成，下次换新）；
 *   - `rejected`：宿主给了业务错误码（动作已定论，下次换新）；
 *   - `unknown`：网络/网关失败、无码失败（结果未知，重试必须续用同一意图）。
 */
export function classifyGuiOrderResult(result: GuiOrderResult): GuiOrderOutcome {
  if (result.order !== undefined) return 'success'
  return result.code === undefined ? 'unknown' : 'rejected'
}

/** 意图追踪器：把「未决重试续用 / 定论后轮换」的规则收在一处。 */
export interface OrderIntentTracker {
  /** 取本次提交（指纹 key）应使用的意图 id。 */
  begin(key: string): string
  /** 记录本次提交的结局。 */
  settle(outcome: GuiOrderOutcome): void
}

/**
 * 建意图追踪器（一次面板生命周期一个）。
 * @param mint - 生成新意图 id 的函数（缺省 {@link createOrderIntentId}）。
 * @returns 追踪器：未决（unknown）且指纹未变的再次 begin 续用同一 id，其余情形换新。
 */
export function createOrderIntentTracker(mint: () => string = createOrderIntentId): OrderIntentTracker {
  let pending: { key: string; intentId: string } | undefined
  return {
    begin(key) {
      if (pending !== undefined && pending.key === key) return pending.intentId
      pending = { key, intentId: mint() }
      return pending.intentId
    },
    settle(outcome) {
      // unknown：提交身份仍悬着（同一笔可能已经在路上），保留给重试。
      if (outcome === 'unknown') return
      pending = undefined
    },
  }
}

export interface GuiOrderSubmission {
  readonly market: MarketId
  readonly input: GuiOrderInput
  /** 官方当前会话 id；undefined = 无会话（宿主 fail-closed 拒绝）。 */
  readonly sessionId: string | undefined
  readonly tracker: OrderIntentTracker
  /** 下单通路（真实调用点注入 `placeGuiOrder`；用例注入同一实现以驱动线上路径）。 */
  readonly place: (market: MarketId, input: GuiOrderInput, context: GuiOrderApprovalContext) => Promise<GuiOrderResult>
}

/**
 * 走一次 GUI 实盘下单的完整身份流程：取（或续用）意图 → 带会话提交 → 按结局轮换意图。
 * @param submission - 市场、参数、会话读值、追踪器与下单通路。
 * @returns 下单结果（原样透传，UI 据此显示成功或明确失败）。
 */
export async function submitGuiOrder(submission: GuiOrderSubmission): Promise<GuiOrderResult> {
  const { market, input, sessionId, tracker, place } = submission
  const intentId = tracker.begin(guiOrderActionKey(market, input))
  try {
    const result = await place(market, input, { ...(sessionId === undefined ? {} : { sessionId }), intentId })
    tracker.settle(classifyGuiOrderResult(result))
    return result
  } catch (error) {
    // 抛错 = 结果未知：保留未决意图，用户重试仍是同一笔。
    tracker.settle('unknown')
    throw error
  }
}

export interface GuiCancelSubmission {
  readonly market: MarketId
  readonly orderId: string
  readonly symbol: string | undefined
  readonly sessionId: string | undefined
  readonly tracker: OrderIntentTracker
  /** 撤单通路（真实调用点注入 `cancelGuiOrder`）。 */
  readonly cancel: (
    market: MarketId,
    orderId: string,
    symbol: string | undefined,
    context: GuiOrderApprovalContext,
  ) => Promise<boolean>
}

/**
 * 走一次 GUI 撤单的完整身份流程（与下单同门槛：同样带会话与稳定意图）。
 * @param submission - 市场、订单、会话读值、追踪器与撤单通路。
 * @returns 撤单是否成功（false 的归因只有宿主知道，故按未决处理以便重试续用意图）。
 */
export async function submitGuiCancel(submission: GuiCancelSubmission): Promise<boolean> {
  const { market, orderId, symbol, sessionId, tracker, cancel } = submission
  const intentId = tracker.begin(guiCancelActionKey(market, orderId))
  try {
    const canceled = await cancel(market, orderId, symbol, { ...(sessionId === undefined ? {} : { sessionId }), intentId })
    tracker.settle(canceled ? 'success' : 'unknown')
    return canceled
  } catch (error) {
    tracker.settle('unknown')
    throw error
  }
}

/**
 * 失败回执文案：宿主回带了稳定错误码（如 TRADING_APPROVAL_DENIED）时以错误码开头——
 * 审批没成必须一眼可辨，不能混在「参数被拒/服务未挂载」的通用文案里，
 * 更不能显示成成交或模拟回执。
 * @param generic - 无错误码时的通用失败文案（本地化词条）。
 * @param result - 下单结果。
 * @returns 展示用文案。
 */
export function guiOrderFailureText(generic: string, result: GuiOrderResult): string {
  const detail = result.error ?? ''
  if (result.code === undefined) return detail === '' ? generic : `${generic}: ${detail}`
  const rest = detail.startsWith(result.code) ? detail.slice(result.code.length).replace(/^:\s*/, '') : detail
  return rest === '' ? result.code : `${result.code}: ${rest}`
}

/**
 * 工具调用级结构化记录（D11 最小可观测面）。
 *
 * 为什么需要它：本仓此前的失败诊断只能靠人工拼接——宿主有自己的 session 事件，
 * 但「哪个工具、哪次调用（callId/rootCallId）、成功还是失败、失败的错误类别、
 * 耗时多久」在本仓没有任何结构化落点，自由文本 `console.error` 无法回答这四问。
 * 本模块挂在官方 `tools/post-execute` waterfall 上，把每次工具调用压成一行
 * JSON 追加写入 `<DSH_HOME>/logs/tool-calls.jsonl`。
 *
 * 边界（刻意保守）：
 *   - 只记工具名、调用标识、结果标志、错误类别与耗时；**不记参数与返回值**
 *     （参数可能含 API key、账户号、下单数量等敏感内容）。
 *   - 记录失败绝不影响工具调用本身；写不进去就打一行告警后放行（观测是旁路）。
 *   - 文件按大小轮转（保留一份 .1），避免长跑进程把 home 写满。
 *
 * @module @dshtrading/base/tool-call-log
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHomeDir } from '@dshtrading/dsh-home'

/** 单文件上限：超过就轮转到 `.1`（只留一代，够事后取证）。 */
export const TOOL_CALL_LOG_MAX_BYTES = 4 * 1024 * 1024

/** 一行调用记录的形状（字段名即对外契约，变更需改门禁基线）。 */
export interface ToolCallRecord {
  /** 记录时刻（毫秒）。 */
  at: number
  /** 工具名（模型面向词汇）。 */
  tool: string
  /** 本次调用标识（与调用方请求配对）。 */
  callId: string
  /** 所属根调用标识（同一轮多个调用可归并）。 */
  rootCallId: string
  /** 是否失败。 */
  isError: boolean
  /** 失败时的错误类别（成功为 null）。 */
  errorCode: string | null
  /**
   * 工具体执行耗时（毫秒）。
   *
   * 诚实边界：当前恒为 0——本仓只挂官方 \`tools/post-execute\`（工具已跑完），
   * 拿不到起点；精确耗时属宿主执行面。字段先固定下来，未来接入官方 timing
   * 只需填值而不用改记录契约。**不要把它读成「瞬时完成」**。
   */
  durationMs: number
}

/** 从结果里提取机器可读错误类别；没有结构化类别时为 null，不编造。 */
export function errorCodeOf(result: { isError: boolean; error?: { code?: unknown; name?: unknown } }): string | null {
  if (!result.isError) return null
  const code = result.error?.code
  if (typeof code === 'string' && code.length > 0) return code
  const name = result.error?.name
  return typeof name === 'string' && name.length > 0 ? name : 'UNKNOWN_ERROR'
}

/** 记录文件路径（可用 DSH_TOOL_CALL_LOG 覆盖，测试与部署都走这里）。 */
export function toolCallLogPath(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.DSH_TOOL_CALL_LOG
  if (explicit !== undefined && explicit.trim().length > 0) return explicit
  return join(dshHomeDir(env), 'logs', 'tool-calls.jsonl')
}

/**
 * 追加一条记录；轮转与目录创建都在这里。
 * @returns 实际写入的路径（失败也返回目标路径，调用方据返回值决定是否告警）。
 */
export function appendToolCallRecord(record: ToolCallRecord, filePath: string): string {
  mkdirSync(dirname(filePath), { recursive: true })
  try {
    if (statSync(filePath).size >= TOOL_CALL_LOG_MAX_BYTES) renameSync(filePath, filePath + '.1')
  } catch {
    // 文件不存在或轮转失败：继续按追加写，不阻断。
  }
  appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8')
  return filePath
}

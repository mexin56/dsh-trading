import type { TradingErrorCode } from '@dshtrading/api'

/** 本连接器的凭证提示（错误消息里必须给出可执行的配置路径 —— BYOK 铁律）。 */
export const TOKEN_HINT =
  '配置金十 MCP Token：设置中心 dshtrading.credentials.jin10.token，或环境变量 JIN10_MCP_TOKEN。'

/** 错误词汇对齐 @dshtrading/api（本包不做跨包 Error 类基座，与 connector-eastmoney 同款）。 */
export class Jin10Error extends Error {
  readonly code: TradingErrorCode

  constructor(code: TradingErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'Jin10Error'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/** MCP initialize 握手中可机器识别的契约违约种类。 */
export type Jin10McpContractViolationKind =
  | 'initialize_result_invalid'
  | 'unsupported_protocol_version'
  | 'missing_capability'

/** 结构化契约违约载荷：错误码之外，调用方可按 kind 分支处理而不必解析文案。 */
export interface Jin10McpContractViolation {
  readonly kind: Jin10McpContractViolationKind
  readonly method: string
  /** unsupported_protocol_version：客户端声明/支持的版本。 */
  readonly requestedVersion?: string
  readonly negotiatedVersion?: string
  readonly supportedVersions?: readonly string[]
  /** missing_capability：缺失的服务端能力与触发它的方法。 */
  readonly capability?: 'tools' | 'resources'
  readonly detail?: string
}

/**
 * MCP 协议契约违约（initialize 结果非法、协商版本不受支持、方法能力未声明）。
 * 错误码沿用统一词汇 TRADING_EXCHANGE_ERROR（本包对上游坏形状的既有口径），
 * 可分支信息放在 violation 上——不新造跨包错误码，也不把契约违约伪装成网络故障。
 */
export class Jin10McpContractError extends Jin10Error {
  readonly violation: Jin10McpContractViolation

  constructor(violation: Jin10McpContractViolation, message: string) {
    super('TRADING_EXCHANGE_ERROR', message)
    this.name = 'Jin10McpContractError'
    this.violation = Object.freeze({ ...violation })
  }
}

/**
 * 上游业务错误消息 → 错误码。
 * 限流文案必须单独识别（决定「今天别再试」的语义）；「不支持该品种」= 代码不在
 * quote://codes 名册内（本出口实测文案，2026-09-13），映射到 UNSUPPORTED_SYMBOL
 * 让工具层语义与市场工具族一致。
 */
export function codeForUpstreamMessage(message: string): TradingErrorCode {
  if (/上限|限流|频率|rate.?limit|too many/i.test(message)) return 'TRADING_RATE_LIMITED'
  if (/不支持该品种|unsupported (instrument|code|symbol)/i.test(message)) return 'TRADING_UNSUPPORTED_SYMBOL'
  return 'TRADING_EXCHANGE_ERROR'
}

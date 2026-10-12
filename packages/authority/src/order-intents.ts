/**
 * 订单意图台账（order-intent ledger）——实盘「同 ID 只下一单」的持久前提。
 *
 * 这是 **Node-only** 的独立入口（`@dshtrading/authority/order-intents`），与运行期
 * 验签入口（`.`，只读）分开：验签入口不 import 本模块，本模块也不 import 签署侧
 * （`./sign`）。台账是 **agent 自己的运营数据**，写在 trading home 下
 * （`<DSH_HOME>/order-intents/`），**绝不写人工持有的签名授权平面**
 * （`$DSH_TRADING_AUTHORITY_DIR`）——两处只有一个共同点：都在 agent 可写路径之外
 * 的那一份是授权，这里这份是「我发过什么」。
 *
 * 为什么需要它（资金正确性优先）：
 *   venue 的 client order key（OKX `clOrdId`、Alpaca `client_order_id`、IBKR `cOID`）
 *   只在**特定条件下**去重（OKX 仅约束未成交挂单、Alpaca 仅对活跃单回 422、IBKR 要求
 *   24h 内唯一），而且「请求超时/连接断开」与「venue 已建单但响应丢了」在客户端看起来
 *   一模一样。所以 exactly-once 不能建立在 client key 上，只能建立在一份**先落盘、
 *   后触网**的本地意图记录上：记录写不下去就不发；记录写了而结局未定就**永不自动重发**。
 *
 * 三态（本模块只写其中两态，第三种是「没有记录」）：
 *   - 无记录       → begin() 落一条 `unknown` 记录并返回 `submit`（调用方这时才可触网）；
 *   - `unknown`    → begin() 抛 `TRADING_INTENT_UNKNOWN`（在飞/未知），**不重发**；
 *   - `confirmed`  → begin() 返回记录里的同一份回执，**不重发**。
 *
 * 只有「venue 回执带真实非空 orderId」才会写 `confirmed`：`confirm()` 拒绝空 id，
 * 本模块任何路径都不会为让调用方好看而生成一个 id（`TRADING_EXCHANGE_ERROR`）。
 *
 * 冲突：同一 `intentId` 绑定的规范化载荷/provider/环境/账户是一个 SHA-256 指纹，
 * 指纹不同即 `TRADING_INTENT_CONFLICT`——**不自动改参数**、不当作新单。
 * 身份里**没有凭据**：轮换密钥不会让同一个未知意图看起来是新的（凭据轮换不是换账户）。
 *
 * 并发：记录文件按 `sha256(intentId)` 命名（O(1) 定位，不随台账增长变慢），
 * 读-改-写走 @dshtrading/dsh-home 的 `transactStore`（跨进程排他锁 + 锁内新鲜读 +
 * 原子写 + fsync）。同 ID 并发两次：先到者落 `unknown` 并提交，后到者读到 `unknown`
 * 即抛错——只有一个请求能越过网络写边界。
 *
 * 推进未知意图是**显式动作**：`reconcile()` 只接受 venue 侧读到的真实 orderId
 * （人工/读对账），本模块不提供「遗忘」接口，也不自动清理未知记录。
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHomeDir, SKIP_WRITE, transactStore } from '@dshtrading/dsh-home'

/** 台账目录名（挂在 trading home 下；与授权平面无关）。 */
export const ORDER_INTENTS_DIR_NAME = 'order-intents'
/** 记录协议版本（逐帧校验；换格式时旧记录必须被拒而不是被猜）。 */
export const ORDER_INTENT_PROTOCOL_VERSION = 1

/** 本模块的机器可读错误码（与 @dshtrading/api 的 TradingErrorCode 同名同义）。 */
export type OrderIntentErrorCode =
  | 'TRADING_INTENT_REQUIRED'
  | 'TRADING_INTENT_CONFLICT'
  | 'TRADING_INTENT_UNKNOWN'
  | 'TRADING_INTENT_STORE_FAILED'
  | 'TRADING_EXCHANGE_ERROR'

export class OrderIntentError extends Error {
  readonly code: OrderIntentErrorCode

  constructor(code: OrderIntentErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'OrderIntentError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * 意图身份的作用域：provider + 环境 + 账户三者与载荷一起进指纹。
 *
 * `account` 必须是**非密**账户定位（配置里的 accId/accountId，或插件确实没有账户
 * 字段时的稳定占位 `default`）。它**不得**是密钥/token/私钥：凭据会轮换，而轮换不是
 * 换账户——把凭据放进身份会让「同一个未知意图」在换密钥后变成一条新记录并被重发。
 * 同理，账户定位里也不要放能从凭据派生出来的东西。
 */
export interface OrderIntentScope {
  /** 连接器/provider slug（如 `okx`）。 */
  readonly provider: string
  /** 执行环境（`live` / `demo` / `REAL` / `SIMULATE` …）。 */
  readonly environment: string
  /** 非密账户定位（无账户字段的插件用 `default`）。 */
  readonly account: string
}

/** 参与冲突判定的规范化载荷：语义字段（不含任何凭据、不含 venue client key）。 */
export interface OrderIntentPayload {
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly type: 'limit' | 'market'
  readonly quantity: number
  readonly price?: number
  /** 连接器特有的、会改变发往 venue 的请求的字段（如 OKX 的 `tdMode`/`posSide`）。 */
  readonly extra?: Readonly<Record<string, string | number | boolean>>
}

/**
 * 落盘回执的状态词汇：与 @dshtrading/api 的 `OrderStatus` **同形**。
 *
 * 本模块不 import @dshtrading/api（那是纯类型契约包，而这里是运营数据的形状校验），
 * 所以在这里复述一次；**api 仍是该词汇的归属方**，改那边必须同步这里。
 */
export type OrderIntentStatus = 'new' | 'partially_filled' | 'filled' | 'canceled' | 'rejected' | 'expired'

/** 落盘回执形状校验用的取值集（与 OrderIntentStatus 同步）。 */
const ORDER_INTENT_STATUSES: readonly OrderIntentStatus[] = ['new', 'partially_filled', 'filled', 'canceled', 'rejected', 'expired']

/**
 * venue 回执（Order 的持久子集）。`id` 恒为 venue 侧真实订单 id——
 * 没有它就不是回执，本模块拒绝落库。
 */
export interface OrderIntentReceipt {
  readonly id: string
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly type: 'limit' | 'market'
  readonly status: OrderIntentStatus
  readonly price?: number
  readonly quantity: number
  readonly filledQuantity?: number
  readonly timestamp: number
}

/** 一条持久意图记录（一份文件 = 一个 intentId）。 */
export interface OrderIntentRecord {
  readonly version: number
  readonly intentId: string
  /** `unknown` = 已提交/在飞但结局未定；`confirmed` = 有 venue 回执。 */
  readonly state: 'unknown' | 'confirmed'
  /** 规范化载荷 + 作用域的 SHA-256（冲突判据）。 */
  readonly fingerprint: string
  readonly provider: string
  readonly environment: string
  readonly account: string
  readonly createdAt: string
  readonly updatedAt: string
  /** 仅 `confirmed` 有值。 */
  readonly receipt?: OrderIntentReceipt
}

/**
 * 提交前裁决：`submit` = 本次可以触网；`replay` = 已有回执，直接返回且不得触网。
 * 两种结果都回带**规范化后的 intentId**（已 trim）：调用方据此派生 venue client key
 * 与写回执，不需要自己再判一次「id 到底给没给」。
 */
export type OrderIntentDecision =
  | { readonly action: 'submit'; readonly intentId: string }
  | { readonly action: 'replay'; readonly intentId: string; readonly receipt: OrderIntentReceipt }

export interface OrderIntentLedgerOptions extends OrderIntentScope {
  /** 显式 home（缺省按 `$DSH_HOME` 解析；测试必须显式指到临时目录）。 */
  readonly homeDir?: string
  /** 等锁上限（毫秒），透传 `transactStore`。 */
  readonly timeoutMs?: number
}

/**
 * venue client order key 的派生规则。
 *
 * `maxLength` 是该 venue 官方契约里的硬上限，`prefix` 用于在 venue 侧一眼认出
 * 这是本仓派生出来的键。派生是**确定性**的（同一 intentId 恒得同一键），
 * 对账时可由 intentId 重算，因此本模块不需要持久化这个键（它也就不会出现在任何
 * DTO/响应里）。
 */
export interface VenueClientKeyRule {
  /** venue 允许的字符集内的前缀（本仓一律用 ASCII 十六进制 + 字母前缀）。 */
  readonly prefix: string
  /** venue 官方契约的长度上限（含前缀）。 */
  readonly maxLength: number
}

/** 从 intentId 派生 venue client order key：sha256 十六进制（天然落在字母数字集内）。 */
export function deriveVenueClientKey(intentId: string, rule: VenueClientKeyRule): string {
  const digest = createHash('sha256').update(intentId).digest('hex')
  const room = Math.max(0, rule.maxLength - rule.prefix.length)
  return (rule.prefix + digest.slice(0, room)).slice(0, rule.maxLength)
}

/** 规范化序列化（键序无关、undefined 丢弃）：指纹必须与 JSON 排版无关。 */
function canonicalize(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalize(item)).join(',') + ']'
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort()
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalize(record[key])).join(',') + '}'
}

function requireNonEmpty(label: string, value: string): string {
  const trimmed = value.trim()
  if (trimmed === '') {
    throw new OrderIntentError(
      'TRADING_INTENT_REQUIRED',
      `order intent ledger: ${label} must be a non-empty string (got ${JSON.stringify(value)})`,
    )
  }
  return trimmed
}

function isRecord(value: unknown): value is OrderIntentRecord {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (record.version !== ORDER_INTENT_PROTOCOL_VERSION) return false
  if (typeof record.intentId !== 'string' || record.intentId === '') return false
  if (record.state !== 'unknown' && record.state !== 'confirmed') return false
  if (typeof record.fingerprint !== 'string' || record.fingerprint === '') return false
  if (typeof record.provider !== 'string' || typeof record.environment !== 'string' || typeof record.account !== 'string') return false
  if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') return false
  if (record.state === 'confirmed' && !isReceipt(record.receipt)) return false
  if (record.receipt !== undefined && !isReceipt(record.receipt)) return false
  return true
}

function isReceipt(value: unknown): value is OrderIntentReceipt {
  if (value === null || typeof value !== 'object') return false
  const receipt = value as Record<string, unknown>
  return typeof receipt.id === 'string' && receipt.id.trim() !== ''
    && typeof receipt.symbol === 'string'
    && typeof receipt.quantity === 'number'
    && typeof receipt.timestamp === 'number'
    && typeof receipt.status === 'string'
    && (ORDER_INTENT_STATUSES as readonly string[]).includes(receipt.status)
}

/** api `Order` 的最小结构面（本包不依赖 @dshtrading/api，连接器传自己的 Order 即可）。 */
export interface OrderLike {
  readonly id: string
  readonly symbol: string
  readonly side: 'buy' | 'sell'
  readonly type: 'limit' | 'market'
  readonly status: OrderIntentStatus
  readonly price?: number
  readonly quantity: number
  readonly filledQuantity?: number
  readonly timestamp: number
}

/** api `Order` → 落盘回执（**只接受非空 id**；venue 没给句柄就不是成功）。 */
export function receiptFromOrder(order: OrderLike): OrderIntentReceipt {
  return {
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    status: order.status,
    ...(order.price !== undefined ? { price: order.price } : {}),
    quantity: order.quantity,
    ...(order.filledQuantity !== undefined ? { filledQuantity: order.filledQuantity } : {}),
    timestamp: order.timestamp,
  }
}

/**
 * 落盘回执 → api `Order` 的同形结构（状态词汇已在落盘时按 api 词汇校验过，
 * 因此这里的窄化是安全的），`dryRun` 恒为 false：能进台账的都是实盘单。
 */
export function orderFromReceipt(receipt: OrderIntentReceipt): OrderLike & { readonly dryRun: false } {
  return {
    id: receipt.id,
    symbol: receipt.symbol,
    side: receipt.side,
    type: receipt.type,
    status: receipt.status,
    ...(receipt.price !== undefined ? { price: receipt.price } : {}),
    quantity: receipt.quantity,
    ...(receipt.filledQuantity !== undefined ? { filledQuantity: receipt.filledQuantity } : {}),
    dryRun: false,
    timestamp: receipt.timestamp,
  }
}

/** 一份记录文件的内容：读盘形状与坏形降级口径（坏形 = 当作没有记录，绝不猜）。 */
function parseRecord(text: string): OrderIntentRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export class OrderIntentLedger {
  private readonly scope: OrderIntentScope
  private readonly options: OrderIntentLedgerOptions

  constructor(options: OrderIntentLedgerOptions) {
    this.scope = {
      provider: requireNonEmpty('provider', options.provider),
      environment: requireNonEmpty('environment', options.environment),
      account: requireNonEmpty('account', options.account),
    }
    this.options = options
  }

  /** 台账目录：显式 home 优先，否则按 `$DSH_HOME` 解析（与全仓 home 契约同源）。 */
  get directory(): string {
    return join(this.options.homeDir ?? dshHomeDir(), ORDER_INTENTS_DIR_NAME)
  }

  /** 某个 intentId 的记录文件（sha256 派生，O(1)；不含意图内容，也不含账户明文）。 */
  filePath(intentId: string): string {
    const digest = createHash('sha256').update(requireNonEmpty('intentId', intentId)).digest('hex')
    return join(this.directory, digest + '.json')
  }

  /** 规范化载荷 + 作用域的指纹（冲突判据；不含任何凭据/venue client key）。 */
  fingerprint(payload: OrderIntentPayload): string {
    return createHash('sha256').update(canonicalize({
      provider: this.scope.provider,
      environment: this.scope.environment,
      account: this.scope.account,
      payload,
    })).digest('hex')
  }

  /** 只读一条记录（对账/诊断用；坏形与缺失都返回 undefined）。 */
  async read(intentId: string): Promise<OrderIntentRecord | undefined> {
    return this.readFromDisk(this.filePath(intentId))
  }

  /**
   * 触网前裁决。返回值 `submit` 表示「本次已落下 unknown 记录，可以调用 venue」；
   * 抛错即**不得**调用 venue：
   *   - `TRADING_INTENT_REQUIRED` 缺 intentId；
   *   - `TRADING_INTENT_CONFLICT` 同 ID 不同载荷/provider/环境/账户；
   *   - `TRADING_INTENT_UNKNOWN` 同 ID 已有未定结局的记录（在飞/未知），不重发；
   *   - `TRADING_INTENT_STORE_FAILED` 记录写不下去（宁可不发）。
   */
  async begin(input: { readonly intentId: string | undefined; readonly payload: OrderIntentPayload }): Promise<OrderIntentDecision> {
    const intentId = requireNonEmpty('intentId', input.intentId ?? '')
    const fingerprint = this.fingerprint(input.payload)
    const file = this.filePath(intentId)
    let record: OrderIntentRecord | undefined
    try {
      record = await transactStore<OrderIntentRecord | undefined>(
        file,
        () => this.readFromDisk(file),
        (onDisk) => {
          if (onDisk === undefined) {
            const now = new Date().toISOString()
            return {
              version: ORDER_INTENT_PROTOCOL_VERSION,
              intentId,
              state: 'unknown' as const,
              fingerprint,
              provider: this.scope.provider,
              environment: this.scope.environment,
              account: this.scope.account,
              createdAt: now,
              updatedAt: now,
            }
          }
          if (onDisk.fingerprint !== fingerprint) throw conflictError(intentId)
          if (onDisk.state === 'confirmed' && onDisk.receipt !== undefined) return SKIP_WRITE
          throw new OrderIntentError(
            'TRADING_INTENT_UNKNOWN',
            `order intent ${intentId} was already submitted and its venue outcome is unresolved (no receipt recorded); `
              + 'not resubmitting — reconcile against the venue (read the order by its client key) and record the receipt before retrying',
          )
        },
        (value) => value,
        '[dsh-trading/order-intents] failed to atomic flush order intent to',
        this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {},
      )
    } catch (error) {
      if (error instanceof OrderIntentError) throw error
      throw new OrderIntentError(
        'TRADING_INTENT_STORE_FAILED',
        `order intent ${intentId} could not be recorded (${error instanceof Error ? error.message : String(error)}); `
          + 'no venue call was made — a live order is never sent without a durable intent record',
        error,
      )
    }
    if (record === undefined) {
      throw new OrderIntentError(
        'TRADING_INTENT_STORE_FAILED',
        `order intent ${intentId}: no durable record was created; no venue call may be made`,
      )
    }
    // 锁内写盘后的状态就是裁决：confirmed = 已有回执（重放），unknown = 本次刚落下、可触网。
    return record.state === 'confirmed' && record.receipt !== undefined
      ? { action: 'replay', intentId, receipt: record.receipt }
      : { action: 'submit', intentId }
  }

  /**
   * 记录 venue 回执。只接受**真实非空 orderId**：没有它就是没拿到 venue 句柄，
   * 本次仍停在 `unknown`（调用方应当把该情况当失败上报，而不是造一个 id）。
   */
  async confirm(input: {
    readonly intentId: string
    readonly payload: OrderIntentPayload
    readonly receipt: OrderIntentReceipt
  }): Promise<OrderIntentRecord> {
    const intentId = requireNonEmpty('intentId', input.intentId)
    const venueOrderId = requireVenueOrderId(input.receipt)
    const fingerprint = this.fingerprint(input.payload)
    const file = this.filePath(intentId)
    return this.write(file, intentId, (onDisk) => {
      if (onDisk === undefined) {
        throw new OrderIntentError(
          'TRADING_INTENT_STORE_FAILED',
          `order intent ${intentId}: no durable record found while recording venue receipt ${venueOrderId}; `
            + 'the venue order exists — do not resubmit, reconcile it manually',
        )
      }
      if (onDisk.fingerprint !== fingerprint) {
        throw conflictError(intentId)
      }
      if (onDisk.state === 'confirmed' && onDisk.receipt !== undefined) {
        if (onDisk.receipt.id !== venueOrderId) {
          throw new OrderIntentError(
            'TRADING_INTENT_CONFLICT',
            `order intent ${intentId} is already confirmed with venue order ${onDisk.receipt.id}; `
              + `refusing to overwrite it with ${venueOrderId}`,
          )
        }
        return SKIP_WRITE
      }
      return { ...onDisk, state: 'confirmed' as const, receipt: input.receipt, updatedAt: new Date().toISOString() }
    })
  }

  /**
   * 用 **venue 侧读到的**回执推进一条未定结局的意图（人工/读对账的唯一入口）。
   * 记录必须已存在（本模块不凭对账凭空造意图），回执必须带真实 orderId。
   */
  async reconcile(input: { readonly intentId: string; readonly receipt: OrderIntentReceipt }): Promise<OrderIntentRecord> {
    const intentId = requireNonEmpty('intentId', input.intentId)
    const venueOrderId = requireVenueOrderId(input.receipt)
    const file = this.filePath(intentId)
    return this.write(file, intentId, (onDisk) => {
      if (onDisk === undefined) {
        throw new OrderIntentError(
          'TRADING_INTENT_UNKNOWN',
          `order intent ${intentId} has no durable record; refusing to fabricate one from reconciliation `
            + `(venue order ${venueOrderId} needs an explicit operator decision outside the ledger)`,
        )
      }
      if (onDisk.state === 'confirmed' && onDisk.receipt !== undefined) {
        if (onDisk.receipt.id !== venueOrderId) {
          throw new OrderIntentError(
            'TRADING_INTENT_CONFLICT',
            `order intent ${intentId} is already confirmed with venue order ${onDisk.receipt.id}; `
              + `refusing to overwrite it with ${venueOrderId}`,
          )
        }
        return SKIP_WRITE
      }
      return { ...onDisk, state: 'confirmed' as const, receipt: input.receipt, updatedAt: new Date().toISOString() }
    })
  }

  private async write(
    file: string,
    intentId: string,
    mutate: (onDisk: OrderIntentRecord | undefined) => OrderIntentRecord | typeof SKIP_WRITE,
  ): Promise<OrderIntentRecord> {
    let outcome: OrderIntentRecord | undefined
    try {
      outcome = await transactStore<OrderIntentRecord | undefined>(
        file,
        () => this.readFromDisk(file),
        (onDisk) => mutate(onDisk),
        (value) => value,
        '[dsh-trading/order-intents] failed to atomic flush order intent to',
        this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {},
      )
    } catch (error) {
      // 拒绝语义（冲突/缺记录/缺 venue id）与写盘失败分开：前者是业务裁决，必须原样上报。
      if (error instanceof OrderIntentError) throw error
      throw new OrderIntentError(
        'TRADING_INTENT_STORE_FAILED',
        `order intent ${intentId} could not be written (${error instanceof Error ? error.message : String(error)})`,
        error,
      )
    }
    if (outcome === undefined) {
      throw new OrderIntentError('TRADING_INTENT_STORE_FAILED', `order intent ${intentId}: ledger returned no record`)
    }
    return outcome
  }

  /**
   * 读盘：**只有真的不存在**才算「没有记录」。文件在但读不出来（坏 JSON、坏形状、
   * 未来协议版本）一律 fail-closed 报「未知」——把坏记录当成没有记录，等于把
   * 「上一笔可能已经到 venue」静默遗忘，正好是重复下单的入口。
   */
  private async readFromDisk(file: string): Promise<OrderIntentRecord | undefined> {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined
      throw error
    }
    const record = parseRecord(text)
    if (record === undefined) {
      throw new OrderIntentError(
        'TRADING_INTENT_UNKNOWN',
        `order intent record ${file} exists but cannot be read as a protocol-v${ORDER_INTENT_PROTOCOL_VERSION} record; `
          + 'refusing to treat it as absent (a previous attempt may already have reached the venue) — reconcile or repair it before retrying',
      )
    }
    return record
  }
}

function conflictError(intentId: string): OrderIntentError {
  return new OrderIntentError(
    'TRADING_INTENT_CONFLICT',
    `order intent ${intentId} is already bound to a different request (payload/provider/environment/account fingerprint mismatch); `
      + 'refusing to submit a re-parameterised order under the same id — use a new intentId for a different order',
  )
}

/** venue 句柄纪律：回执必须带真实非空订单 id——本模块绝不代生成。 */
function requireVenueOrderId(receipt: OrderIntentReceipt): string {
  const id = typeof receipt.id === 'string' ? receipt.id.trim() : ''
  if (id === '') {
    throw new OrderIntentError(
      'TRADING_EXCHANGE_ERROR',
      'order intent ledger: refusing to record a confirmed intent without a real non-empty venue order id '
        + '(the venue did not hand back a handle — this is not a success)',
    )
  }
  return id
}

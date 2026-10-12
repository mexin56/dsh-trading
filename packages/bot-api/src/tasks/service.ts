/**
 * 右侧栏定时任务——Host 编排服务：cron tick、执行轮询、重启对账、动作应用。
 *
 * 节奏对齐 dsh-web dsh-task-board：30 秒调度 tick（错过触发点不补跑，从当前
 * 时刻取下一个匹配）、5 秒执行轮询（会话静默 + turn/end 侦查结算）、启动对账
 * （有会话 id 的运行中执行继续观察，无 id 的启动中断取消不重发）。所有定时器
 * 异常吞掉并记入 scheduler.error，绝不打断宿主进程。
 */
import { TasksLedger, TaskActionError, type AppliedAction } from './ledger.ts'
import {
  type TaskPermission,
  type TaskSkipReason,
  type TasksActionEnvelope,
  type TasksSnapshot,
} from '@dshtrading/api'
import { TasksRunner, SessionLaunchError, type AgentRegistryLike, type SessionCommandDispatcher, type SessionGateway } from './runner.ts'

/** 宿主工作区名册面（meta + runner 校验共用）。宿主 Workspace 实体的显示名
 *  在 title（创建时默认 basename(path)，必填）；name 留给别名面兜底。 */
export interface WorkspaceDirectoryLike {
  list(): readonly { id: string; name?: string; title?: string }[]
}

export interface TasksMeta {
  sessionDefaultPermission: TaskPermission
  workspaces: Array<{ id: string; name?: string }>
  agentPresets: Array<{ id: string }>
}

export interface TradingTasksServiceOptions {
  /** 账本文件路径（含 .lock 同目录）。 */
  ledgerPath: string
  /** 惰性解析宿主 typertGateway（每轮调用，服务晚激活也能接上）。 */
  gateway: () => SessionGateway | undefined
  /** 惰性解析宿主 commands 服务（权限斜杠命令）。 */
  commands?: () => SessionCommandDispatcher | undefined
  /** 惰性解析宿主 agents 服务（commands.execute 需要 Agent 首参）。 */
  agents?: () => AgentRegistryLike | undefined
  /** 惰性解析宿主 workspaceRegistry。 */
  workspaces?: () => WorkspaceDirectoryLike | undefined
  /** 账本每次提交后的失效信号回调（桥层接 SSE emit('tasks')）。 */
  onEvent?: () => void
  /** 会话默认权限（确认门基准）；缺省 workspace-write。 */
  sessionDefaultPermission?: TaskPermission
  /** 全局在飞执行容量上限（跨任务）；缺省 DEFAULT_MAX_INFLIGHT_EXECUTIONS。 */
  maxInflightExecutions?: number
  /**
   * 失联执行的收敛窗口：会话已空闲、完整历史扫描确认没有 turn/end 的执行，超过
   * 这个时长仍未结算即收敛为取消（永不重发 prompt）。仍在运行/待审批（宿主
   * status=running）的执行不受此窗口影响。
   */
  staleExecutionMs?: number
  /** 可注入时钟与节奏（测试）。 */
  now?: () => number
  tickMs?: number
  pollMs?: number
}

const TICK_MS = 30_000
const POLL_MS = 5_000

/** 失联执行收敛窗口缺省：1 小时（保守——宁可晚收敛，也不误杀慢启动的真实执行）。 */
export const DEFAULT_STALE_EXECUTION_MS = 60 * 60_000

/** TaskActionError 码 → 结构化跳过原因（非跳过类错误返回 undefined）。 */
function skipReasonFor(code: string): TaskSkipReason | undefined {
  if (code === 'TASKS_PERMISSION_PENDING') return 'permission-pending'
  if (code === 'TASKS_CAPACITY_EXCEEDED') return 'capacity'
  if (code === 'TASKS_ALREADY_RUNNING') return 'already-running'
  return undefined
}

/** 人类可读的错误消息。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class TradingTasksService {
  private readonly ledger: TasksLedger
  private readonly runner: TasksRunner
  private readonly options: TradingTasksServiceOptions
  private readonly tickMs: number
  private readonly pollMs: number
  private readonly staleExecutionMs: number
  /** 正在启动中的执行 id（同一执行不重复启动，重启也不盲发）。 */
  private readonly launching = new Set<string>()
  private timers: Array<ReturnType<typeof setInterval>> = []
  private tickInFlight = false
  private pollInFlight = false
  private disposed = false

  constructor(options: TradingTasksServiceOptions) {
    this.options = options
    this.tickMs = options.tickMs ?? TICK_MS
    this.pollMs = options.pollMs ?? POLL_MS
    this.staleExecutionMs = options.staleExecutionMs ?? DEFAULT_STALE_EXECUTION_MS
    // LedgerLockedError 直接上抛：桥层据此把任务面降级为 503（特性不挂，宿主照跑）。
    this.ledger = new TasksLedger(options.ledgerPath, {
      ...(options.sessionDefaultPermission === undefined ? {} : { sessionDefaultPermission: options.sessionDefaultPermission }),
      ...(options.maxInflightExecutions === undefined ? {} : { maxInflightExecutions: options.maxInflightExecutions }),
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    this.ledger.subscribe(() => { options.onEvent?.() })
    this.runner = new TasksRunner(
      options.gateway,
      options.commands ?? (() => undefined),
      options.workspaces as (() => WorkspaceDirectoryLike | undefined) | undefined ?? (() => undefined),
      options.agents ?? (() => undefined),
    )
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────

  /** 启动对账 + 定时器（幂等；dispose 后拒绝）。 */
  start(): void {
    if (this.disposed || this.timers.length > 0) return
    this.ledger.reconcileStartup()
    const tickTimer = setInterval(() => { void this.tick() }, this.tickMs)
    const pollTimer = setInterval(() => { void this.poll() }, this.pollMs)
    tickTimer.unref?.()
    pollTimer.unref?.()
    this.timers.push(tickTimer, pollTimer)
    void this.tick()
    void this.poll()
  }

  stop(): void {
    for (const timer of this.timers.splice(0)) clearInterval(timer)
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    this.ledger.dispose()
  }

  // ── 读面 ────────────────────────────────────────────────────────────────

  snapshot(): TasksSnapshot {
    return this.ledger.snapshot()
  }

  /** 元数据面：确认门基准 + 工作区名册 + agent 预设名册（UI 下拉用）。 */
  async meta(): Promise<TasksMeta> {
    const snapshot = this.ledger.snapshot()
    const directory = this.options.workspaces?.()
    const workspaces = directory === undefined
      ? []
      : directory.list().map(item => {
          const name = item.name ?? item.title
          return { id: item.id, ...(name === undefined ? {} : { name }) }
        })
    const gateway = this.options.gateway()
    const agentPresets: Array<{ id: string }> = []
    if (gateway !== undefined) {
      try {
        const response = await gateway.invoke({ namespace: 'agentPresets', method: 'list', args: {} }) as { presets?: readonly { id: string }[] }
        for (const preset of response.presets ?? []) agentPresets.push({ id: preset.id })
      } catch {
        // 预设名册不可用 → 空表（UI 只显示部署默认），不阻塞元数据面。
      }
    }
    return { sessionDefaultPermission: snapshot.sessionDefaultPermission, workspaces, agentPresets }
  }

  // ── 写面 ────────────────────────────────────────────────────────────────

  /** 应用一个动作信封（幂等）；run 动作返回后异步起跑。 */
  apply(envelope: TasksActionEnvelope): AppliedAction['snapshot'] {
    const applied = this.ledger.apply(envelope)
    if (applied.openedRun !== undefined) {
      void this.launchTask(applied.openedRun.taskId, applied.openedRun.executionId)
    }
    return applied.snapshot
  }

  // ── 内部：启动与轮询 ───────────────────────────────────────────────────

  /**
   * 异步起跑一条已开的执行：launch 落定绑定会话；失败结算 failed。
   *
   * 不盲发：同一执行只启动一次（并发调用经 launching 去重），已结算或已绑定
   * 会话的执行直接跳过；启动身份由执行 id 派生（runner 侧），所以即便真的重复
   * 触及 SDK 也只会采纳同一会话、同 requestId 的 prompt 也只受理一次。
   */
  private async launchTask(taskId: string, executionId: string): Promise<void> {
    if (this.launching.has(executionId)) return
    const existing = this.ledger.execution(taskId, executionId)
    if (existing === undefined || existing.endedAt !== undefined || existing.sessionId !== undefined) return
    const task = this.ledger.task(taskId)
    if (task === undefined) return
    this.launching.add(executionId)
    const runnerTask = {
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      ...(task.workspaceId === undefined ? {} : { workspaceId: task.workspaceId }),
      ...(task.agentPreset === undefined ? {} : { agentPreset: task.agentPreset }),
      ...(task.permission === undefined ? {} : { permission: task.permission }),
    }
    try {
      const sessionId = await this.runner.launch(runnerTask, executionId)
      this.ledger.attachSession(taskId, executionId, sessionId)
    } catch (error) {
      if (error instanceof SessionLaunchError) {
        // 会话已建但启动中途失败：绑上会话再结算，观察面能对上号。
        this.ledger.attachSession(taskId, executionId, error.sessionId)
      }
      this.ledger.settleRun(taskId, executionId, 'failed', errorMessage(error))
    } finally {
      this.launching.delete(executionId)
    }
  }

  /** 调度 tick：到期任务推进触发点并起跑；拒绝（并发/权限门）即跳过该触发点。 */
  private async tick(): Promise<void> {
    if (this.disposed || this.tickInFlight) return
    this.tickInFlight = true
    try {
      const now = this.options.now?.() ?? Date.now()
      for (const due of this.ledger.dueTasks(now)) {
        const task = this.ledger.task(due.taskId)
        if (task === undefined) continue
        // 先推进再尝试：错过不补跑，被跳过（并发执行/权限待确认）的触发点不滞留。
        this.ledger.advanceSchedule(due.taskId, due.nextRunAt, this.options.now?.() ?? Date.now())
        try {
          const opened = this.ledger.openRun(due.taskId, 'cron')
          void this.launchTask(opened.taskId, opened.executionId)
        } catch (error) {
          if (!(error instanceof TaskActionError)) throw error
          // 权限待确认 / 容量满 / 已有执行在跑：跳过该触发点（cron 不补跑的策略
          // 不变），但跳过必须留结构化原因——否则「到点没跑」在快照上无从解释。
          const reason = skipReasonFor(error.code)
          if (reason !== undefined) {
            this.ledger.recordScheduleSkip(due.taskId, due.nextRunAt, reason, this.options.now?.() ?? Date.now())
          }
        }
      }
      this.ledger.updateScheduler({ lastTickAt: this.options.now?.() ?? Date.now(), error: undefined })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[dsh-trading/tasks] schedule tick failed:', error)
      try {
        this.ledger.updateScheduler({ error: message })
      } catch {
        // 账本已不可写（锁丢失等）——只能打日志。
      }
    } finally {
      this.tickInFlight = false
    }
  }

  /**
   * 执行轮询：未结算执行侦查结局并结算。
   *
   * - 结算：会话消失判取消、按 SDK reason 分类的终局事件判正常/失败/取消。
   * - 仍在运行/待审批：宿主 `AgentStatus` 只有 idle/running，等待审批期间
   *   status 保持 running，因此这类执行永远不会因年龄被收敛。
   * - 失联收敛：会话空闲 + 完整历史扫描确认无 turn/end + 超过 staleExecutionMs
   *   → 结算为取消并写明原因（不重发 prompt）。
   * - 读取异常：在快照上留下 note，不静默永久 pending，也不据此判死。
   */
  private async poll(): Promise<void> {
    if (this.disposed || this.pollInFlight) return
    this.pollInFlight = true
    try {
      const opens = this.ledger.openExecutions()
      const now = this.options.now?.() ?? Date.now()
      const staleSeconds = String(Math.round(this.staleExecutionMs / 1000))
      for (const open of opens) {
        // 未绑定会话：launch 在途时交给 launchTask 结算；launch 已不在途却迟迟
        // 没有绑上会话（超过窗口）说明启动悬空，收敛为取消而不是永久 pending。
        if (open.sessionId === undefined) {
          if (!this.launching.has(open.executionId) && now - open.startedAt >= this.staleExecutionMs) {
            this.ledger.settleRun(
              open.taskId,
              open.executionId,
              'cancelled',
              'execution launch never attached a session within ' + staleSeconds + 's; converged as cancelled (prompt not resent)',
            )
          }
          continue
        }
        try {
          const inspection = await this.runner.inspect(open.sessionId, open.startedAt)
          if (inspection.outcome !== 'pending') {
            this.ledger.settleRun(
              open.taskId,
              open.executionId,
              inspection.outcome,
              inspection.outcome === 'succeeded' ? undefined : inspection.error,
            )
            continue
          }
          if (inspection.historyExhausted === true && now - open.startedAt >= this.staleExecutionMs) {
            this.ledger.settleRun(
              open.taskId,
              open.executionId,
              'cancelled',
              'execution session is idle and its complete history records no turn/end; converged as cancelled after '
                + staleSeconds + 's (prompt not resent)',
            )
            continue
          }
          this.ledger.noteInspection(open.taskId, open.executionId, inspection.diagnostic)
        } catch (error) {
          // 单个执行侦查失败不影响其他执行，下轮再试；原因留在快照上。
          this.ledger.noteInspection(open.taskId, open.executionId, 'inspection failed: ' + errorMessage(error))
        }
      }
      // 对账扫描备忘：已删除/已结算任务的会话 id 不在名册，清掉防泄漏。
      this.runner.pruneScanMemos(new Set(
        opens.map(open => open.sessionId).filter((id): id is string => id !== undefined),
      ))
    } finally {
      this.pollInFlight = false
    }
  }
}

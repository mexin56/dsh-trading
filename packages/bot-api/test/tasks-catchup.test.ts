/**
 * 宿主停机补跑缺口的执行面用例（契约网关/名册 fixture + 假时钟；零通用 mock、
 * 零真实等待）：
 *
 * - 名册三态：宿主 workspace 域启动窗口内 `list()` 抛错（`rebuildEntities()` 还
 *   没跑完，entities 为空而 durable order 已加载）是**名册不可知**，不是名册权威
 *   否定——不可知按有界重试后放行起跑（交给网关/宿主兜底），权威否定（名册可读
 *   且不含该 id）仍 fail-closed。
 * - 触发点补偿：名册不可知/网关未就绪导致的 cron 起跑失败不静默消费触发点；
 *   触发点保持到期、由后续 tick 自然重试，尝试次数有上界，用尽即落结构化
 *   lastSkip 原因。错过触发点不逐条补跑的既有语义不变。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TasksRunner, type WorkspaceRegistryLike } from '../src/tasks/runner.ts'
import { TradingTasksService } from '../src/tasks/service.ts'
import {
  createTasksAgentsFixture,
  createTasksCommandsFixture,
  createTasksGateway,
  type TasksGatewayFixture,
} from './tasks-fixture.ts'

const T0 = new Date(2026, 0, 1, 8, 59, 30).getTime()
const T1 = new Date(2026, 0, 1, 9, 0, 0).getTime()
const T2 = new Date(2026, 0, 2, 9, 0, 0).getTime()
/** 宿主 workspace 域启动窗口的文案：list() 按 durable order 逐条取实体，取不到即抛。 */
const WINDOW_ERROR = "workspace registry order references missing workspace 'ws-main'"
/** 每日 9:00：测试窗口内只到期一次（下一个匹配在次日），上界断言不被下一个触发点干扰。 */
const DAILY_AT_NINE = '0 9 * * *'

interface WindowFixture {
  fake: TasksGatewayFixture
  roster: WorkspaceRegistryLike
  /** 关闭宿主启动窗口：名册恢复可读、session/create 恢复可用。 */
  close: () => void
}

/** 宿主 workspace 域启动窗口的契约 fixture（窗口开着时名册抛错、建会话被拒）。 */
function createWindowFixture(): WindowFixture {
  const fake = createTasksGateway()
  let open = true
  const roster: WorkspaceRegistryLike = {
    list: (): readonly { id: string }[] => {
      if (open) throw new Error(WINDOW_ERROR)
      return [{ id: 'ws-main' }]
    },
  }
  fake.setCreateError(() => (open ? new Error(WINDOW_ERROR) : undefined))
  return { fake, roster, close: () => { open = false } }
}

/** 推进假时钟（步长 = runner 内联重试退避 2s），不做任何真实等待。 */
async function advanceSteps(steps: number): Promise<void> {
  for (let step = 0; step < steps; step += 1) await vi.advanceTimersByTimeAsync(2_000)
}

/** 推进假时钟直到条件成立（或步数用尽）。 */
async function driveUntil(ready: () => boolean, maxSteps = 60): Promise<void> {
  for (let step = 0; step < maxSteps && !ready(); step += 1) await vi.advanceTimersByTimeAsync(2_000)
}

/** 先挂好处理句柄再推进时钟：起跑在途时不产生未处理拒绝，落定后由断言判读。 */
function observe(promise: Promise<string>): { readonly settled: { value?: string; error?: unknown } } {
  const settled: { value?: string; error?: unknown } = {}
  void promise.then(value => { settled.value = value }, error => { settled.error = error })
  return { settled }
}

describe('TasksRunner 名册三态探针', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(T0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('用户 名册抛错时按有界重试放行起跑，不把暂不可知当权威否定', async () => {
    // Given 契约网关与一份落在宿主启动窗口内的名册（每次 list() 都抛错）
    const fake = createTasksGateway()
    let listCalls = 0
    const roster: WorkspaceRegistryLike = {
      list: (): readonly { id: string }[] => { listCalls += 1; throw new Error(WINDOW_ERROR) },
    }
    const runner = new TasksRunner(() => fake.gateway, () => undefined, () => roster, createTasksAgentsFixture)
    // When 启动一条钉住该工作区的执行（推进假时钟走完内联重试退避）
    const launched = observe(runner.launch({ id: 'task-window', title: '盘前分析', prompt: '生成日报', workspaceId: 'ws-main' }, 'exec-window'))
    await advanceSteps(6)
    // Then 名册不可知按上界（5 次）重试后放行，起跑照常建出会话
    expect(launched.settled.value).toBe('session-exec-window')
    expect(listCalls).toBe(5)
    expect(fake.createdSessionIds).toEqual(['session-exec-window'])
  })

  it('用户 名册服务缺席时同样按有界重试放行起跑', async () => {
    // Given 契约网关与一个始终解析不到名册服务的宿主面
    const fake = createTasksGateway()
    let resolverCalls = 0
    const runner = new TasksRunner(() => fake.gateway, () => undefined, () => { resolverCalls += 1; return undefined }, createTasksAgentsFixture)
    // When 启动一条钉住工作区的执行
    const launched = observe(runner.launch({ id: 'task-no-roster', title: '盘前分析', prompt: '生成日报', workspaceId: 'ws-main' }, 'exec-no-roster'))
    await advanceSteps(6)
    // Then 探针按上界重试后放行，不阻塞起跑
    expect(launched.settled.value).toBe('session-exec-no-roster')
    expect(resolverCalls).toBe(5)
  })

  it('用户 名册可用但不含钉住工作区时 fail-closed 拒绝起跑', async () => {
    // Given 一份可读但不含目标工作区的名册
    const fake = createTasksGateway()
    let listCalls = 0
    const roster: WorkspaceRegistryLike = {
      list: (): readonly { id: string }[] => { listCalls += 1; return [{ id: 'ws-other' }] },
    }
    const runner = new TasksRunner(() => fake.gateway, () => undefined, () => roster, createTasksAgentsFixture)
    // When 启动一条钉住缺失工作区的执行
    let failure: unknown
    try {
      await runner.launch({ id: 'task-missing', title: '盘前分析', prompt: '生成日报', workspaceId: 'ws-missing' }, 'exec-missing')
    } catch (error) {
      failure = error
    }
    // Then 权威否定立即拒绝（不重试、不建会话），文案与语义不变
    expect((failure as Error).message).toBe('workspace not found: ws-missing')
    expect(listCalls).toBe(1)
    expect(fake.createdSessionIds).toEqual([])
  })

  it('用户 名册不可用的分类按单次观察：缺席或抛错为不可知，可读即可知', () => {
    // Given 三种名册状态：服务缺席、list() 抛错、可读
    const fake = createTasksGateway()
    const absent = new TasksRunner(() => fake.gateway, () => undefined, () => undefined)
    const throwing = new TasksRunner(() => fake.gateway, () => undefined, () => ({ list: (): readonly { id: string }[] => { throw new Error(WINDOW_ERROR) } }))
    const readable = new TasksRunner(() => fake.gateway, () => undefined, () => ({ list: (): readonly { id: string }[] => [{ id: 'ws-main' }] }))
    // When 逐个请求「此刻名册是否不可知」
    // Then 只有可读的名册判可知
    expect(absent.workspaceRosterUnavailable()).toBe(true)
    expect(throwing.workspaceRosterUnavailable()).toBe(true)
    expect(readable.workspaceRosterUnavailable()).toBe(false)
  })
})

describe('TradingTasksService 触发点补偿', () => {
  let dir: string
  const services: TradingTasksService[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(T0))
    dir = mkdtempSync(join(tmpdir(), 'dshtrading-tasks-catchup-'))
  })

  afterEach(() => {
    for (const service of services.splice(0)) service.dispose()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeService(fake: TasksGatewayFixture, roster: WorkspaceRegistryLike, options: { tickMs?: number } = {}): TradingTasksService {
    const commands = createTasksCommandsFixture()
    const service = new TradingTasksService({
      ledgerPath: join(dir, 'ledger-v1.json'),
      gateway: () => fake.gateway,
      commands: () => commands.commands,
      agents: createTasksAgentsFixture,
      workspaces: () => roster,
      tickMs: options.tickMs ?? 30_000,
      pollMs: 500,
    })
    services.push(service)
    return service
  }

  function createTask(service: TradingTasksService, input: { id: string; workspaceId: string; cron?: string }): string {
    service.apply({
      requestId: 'create-' + input.id,
      action: {
        kind: 'create',
        id: input.id,
        input: {
          title: '定时任务 ' + input.id,
          prompt: '生成日报',
          workspaceId: input.workspaceId,
          ...(input.cron === undefined ? {} : { schedule: { enabled: true, cron: input.cron } }),
        },
      },
    } as never)
    return input.id
  }

  function taskOf(service: TradingTasksService, taskId: string) {
    return service.snapshot().tasks.find(task => task.id === taskId)
  }

  it('用户 名册不可知导致的起跑失败由后续 tick 重试，用尽上界即落结构化跳过原因', async () => {
    // Given 宿主窗口一直不关（名册抛错 + 建会话被拒）与一条钉住工作区的每日任务
    const window = createWindowFixture()
    const service = makeService(window.fake, window.roster, { tickMs: 5_000 })
    service.start()
    const taskId = createTask(service, { id: 't-window', workspaceId: 'ws-main', cron: DAILY_AT_NINE })
    // When 触发点 09:00:00 到期后推进假时钟直到补偿用尽
    await driveUntil(() => taskOf(service, taskId)?.schedule?.lastSkip !== undefined)
    // Then 同一触发点最多 3 次尝试（首试 + 2 次补偿），全部如实记失败，放弃时落结构化原因
    const task = taskOf(service, taskId)
    expect(task?.executions.length).toBe(3)
    expect(task?.executions.map(execution => execution.result)).toEqual(['failed', 'failed', 'failed'])
    expect(task?.schedule?.lastSkip).toMatchObject({ triggerPoint: T1, reason: 'registry-unavailable' })
    // 触发点已推进到下一个匹配（次日 9 点），不滞留
    expect(task?.schedule?.lastTriggeredAt).toBe(T1)
    expect(task?.schedule?.nextRunAt).toBe(T2)
    // 窗口内每次尝试都没建出会话
    expect(window.fake.createdSessionIds).toEqual([])
  })

  it('用户 名册窗口关闭后后续 tick 的补偿重试成功起跑并结算', async () => {
    // Given 宿主窗口内第一次起跑失败（30s tick 的产品节奏）
    const window = createWindowFixture()
    const service = makeService(window.fake, window.roster)
    service.start()
    const taskId = createTask(service, { id: 't-close', workspaceId: 'ws-main', cron: DAILY_AT_NINE })
    await driveUntil(() => taskOf(service, taskId)?.executions[0]?.endedAt !== undefined)
    // When 窗口关闭，后续 tick 重试同一触发点
    window.close()
    await driveUntil(() => taskOf(service, taskId)?.executions[1]?.sessionId !== undefined)
    const retrySessionId = taskOf(service, taskId)?.executions[1]?.sessionId
    expect(retrySessionId).toBeDefined()
    window.fake.finishTurn(retrySessionId ?? '', { kind: 'completed' })
    await driveUntil(() => taskOf(service, taskId)?.executions[1]?.result !== undefined)
    // Then 一次失败 + 一次成功补跑，重试跨了至少一个 tick，触发点仍只消费一次
    const task = taskOf(service, taskId)
    expect(task?.executions.length).toBe(2)
    expect(task?.executions.map(execution => execution.result)).toEqual(['failed', 'succeeded'])
    expect(task?.executions[0]?.error).toContain('workspace registry order references missing workspace')
    expect((task?.executions[1]?.startedAt ?? 0) - (task?.executions[0]?.startedAt ?? 0)).toBeGreaterThanOrEqual(30_000)
    expect(task?.schedule?.lastSkip).toBeUndefined()
    expect(task?.schedule?.lastTriggeredAt).toBe(T1)
    expect(task?.schedule?.nextRunAt).toBe(T2)
    expect(window.fake.createdSessionIds.length).toBe(1)
  })

  it('用户 名册可用但不含钉住工作区时 fail-closed 且不进入补偿', async () => {
    // Given 名册可读但不含钉住的工作区（权威否定，不是不可知）
    const fake = createTasksGateway()
    const roster: WorkspaceRegistryLike = { list: (): readonly { id: string }[] => [{ id: 'ws-other' }] }
    const service = makeService(fake, roster, { tickMs: 5_000 })
    service.start()
    const taskId = createTask(service, { id: 't-absent', workspaceId: 'ws-main', cron: DAILY_AT_NINE })
    // When 触发点到期后继续推进假时钟
    await driveUntil(() => taskOf(service, taskId)?.executions[0]?.endedAt !== undefined)
    await advanceSteps(3)
    // Then 权威否定即时失败且没有补偿重试
    const task = taskOf(service, taskId)
    expect(task?.executions.length).toBe(1)
    expect(task?.executions[0]?.result).toBe('failed')
    expect(task?.executions[0]?.error).toContain('workspace not found: ws-main')
    expect(task?.executions[0]?.sessionId).toBeUndefined()
    expect(task?.schedule?.lastSkip).toBeUndefined()
    expect(task?.schedule?.nextRunAt).toBe(T2)
    expect(task?.schedule?.lastTriggeredAt).toBe(T1)
    expect(fake.createdSessionIds).toEqual([])
  })

  it('用户 网关目标服务未就绪的起跑失败按同一上界补偿并用尽落网关原因', async () => {
    // Given 名册可读，但网关 session/create 报 service-unavailable（启动竞态的另一口径）
    const fake = createTasksGateway()
    fake.setCreateError(() => Object.assign(new Error('gateway target service is not active yet'), { code: 'service-unavailable' }))
    const roster: WorkspaceRegistryLike = { list: (): readonly { id: string }[] => [{ id: 'ws-main' }] }
    const service = makeService(fake, roster, { tickMs: 5_000 })
    service.start()
    const taskId = createTask(service, { id: 't-gateway', workspaceId: 'ws-main', cron: DAILY_AT_NINE })
    // When 触发点到期后推进假时钟直到补偿用尽
    await driveUntil(() => taskOf(service, taskId)?.schedule?.lastSkip !== undefined)
    // Then 同样 3 次尝试后收手，原因落在网关未就绪上
    const task = taskOf(service, taskId)
    expect(task?.executions.length).toBe(3)
    expect(task?.schedule?.lastSkip).toMatchObject({ triggerPoint: T1, reason: 'gateway-unavailable' })
    expect(task?.schedule?.nextRunAt).toBe(T2)
  })

  it('用户 改过排期后补偿计数从头开始（不继承旧触发点的尝试）', async () => {
    // Given 名册不可知导致的起跑失败停在补偿待重试，随后用户把排期改成每分钟
    const window = createWindowFixture()
    const service = makeService(window.fake, window.roster, { tickMs: 5_000 })
    service.start()
    const taskId = createTask(service, { id: 't-resched', workspaceId: 'ws-main', cron: DAILY_AT_NINE })
    await driveUntil(() => taskOf(service, taskId)?.executions[0]?.endedAt !== undefined)
    expect(taskOf(service, taskId)?.executions.length).toBe(1)
    // When 改排期（旧触发点的补偿状态作废）
    service.apply({ requestId: 'resched-1', action: { kind: 'set-schedule', taskId, patch: { cron: '* * * * *' } } } as never)
    const newTriggerPoint = taskOf(service, taskId)?.schedule?.nextRunAt
    expect(newTriggerPoint).toBeDefined()
    // Then 新触发点照样是 1 次首试 + 2 次补偿，不继承旧触发点的计数
    await driveUntil(() => taskOf(service, taskId)?.schedule?.lastSkip !== undefined, 90)
    const task = taskOf(service, taskId)
    expect(task?.executions.length).toBe(4)
    expect(task?.schedule?.lastSkip).toMatchObject({ triggerPoint: newTriggerPoint, reason: 'registry-unavailable' })
  })

  it('用户 启动途中删除任务后不再有它的执行与补偿状态', async () => {
    // Given 窗口开着、一条钉住工作区的每日任务，首次尝试已开跑（启动在途）
    const window = createWindowFixture()
    const service = makeService(window.fake, window.roster, { tickMs: 5_000 })
    service.start()
    const taskId = createTask(service, { id: 't-deleted', workspaceId: 'ws-main', cron: DAILY_AT_NINE })
    await driveUntil(() => (taskOf(service, taskId)?.executions.length ?? 0) >= 1)
    expect(taskOf(service, taskId)?.executions[0]?.endedAt).toBeUndefined()
    // When 启动还没落定时删掉任务，随后窗口内那次启动失败
    service.apply({ requestId: 'delete-1', action: { kind: 'delete', taskId } } as never)
    await advanceSteps(8)
    // Then 任务与执行都不再出现，也不会为它重开执行
    expect(taskOf(service, taskId)).toBeUndefined()
    expect(service.snapshot().tasks).toEqual([])
  })

  it('用户 手动运行失败不进入补偿（没有触发点可补）', async () => {
    // Given 窗口开着，一条只手动运行的任务钉住了工作区
    const window = createWindowFixture()
    const service = makeService(window.fake, window.roster, { tickMs: 5_000 })
    service.start()
    const taskId = createTask(service, { id: 't-manual', workspaceId: 'ws-main' })
    // When 手动运行一次并推进假时钟
    service.apply({ requestId: 'run-manual', action: { kind: 'run', taskId } } as never)
    await driveUntil(() => taskOf(service, taskId)?.executions[0]?.endedAt !== undefined)
    await advanceSteps(3)
    // Then 只留一次失败执行，没有补偿重试
    const task = taskOf(service, taskId)
    expect(task?.executions.length).toBe(1)
    expect(task?.executions[0]?.result).toBe('failed')
    expect(task?.schedule).toBeUndefined()
    expect(window.fake.createdSessionIds).toEqual([])
  })

  it('用户 名册抛错时元数据面降级为空表而不是抛错', async () => {
    // Given 宿主窗口开着（名册 list() 抛错）
    const window = createWindowFixture()
    const service = makeService(window.fake, window.roster)
    // When 读取元数据面
    const meta = await service.meta()
    // Then 工作区名册降级为空表，预设名册照常返回
    expect(meta.workspaces).toEqual([])
    expect(meta.agentPresets).toEqual([{ id: 'master' }, { id: 'preset-a' }])
  })
})

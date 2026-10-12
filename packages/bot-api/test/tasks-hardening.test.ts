/**
 * 定时任务执行面加固用例：SDK 启动身份按执行 id 派生（重启不盲发）、按当前 SDK
 * 的 turn/end reason 区分正常/失败/取消、失联执行的可配置收敛、读取异常留原因、
 * 全局在飞容量与跳过触发点的结构化记录。网关与命令面用契约 fixture 驱动，零通用
 * mock、零真实等待（vi.useFakeTimers 推进假时钟）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TasksRunner } from '../src/tasks/runner.ts'
import { TradingTasksService } from '../src/tasks/service.ts'
import {
  createTasksAgentsFixture,
  createTasksCommandsFixture,
  createTasksGateway,
  createTasksWorkspacesFixture,
  type TasksGatewayFixture,
} from './tasks-fixture.ts'

const T0 = new Date(2026, 0, 1, 9, 0, 30).getTime()

function inspectionOf(value: unknown): { outcome: string; error?: string; diagnostic?: string } {
  return value as { outcome: string; error?: string; diagnostic?: string }
}

function makeRunner(fake: TasksGatewayFixture): TasksRunner {
  const commands = createTasksCommandsFixture()
  return new TasksRunner(() => fake.gateway, () => commands.commands, createTasksWorkspacesFixture, createTasksAgentsFixture)
}

describe('TasksRunner 加固', () => {
  it('用户 同一执行重复启动时只创建一个会话且只受理一次 prompt', async () => {
    // Given 一个契约网关，以及由执行 id 派生的启动身份
    const fake = createTasksGateway()
    const commands = createTasksCommandsFixture()
    const runner = new TasksRunner(() => fake.gateway, () => commands.commands, createTasksWorkspacesFixture, createTasksAgentsFixture)
    const executionId = '2a1f4c3e-0000-4000-8000-000000000001'
    const task = { id: 'task-1', title: '盘前分析', prompt: '生成日报', permission: 'workspace-write' }
    // When 用同一执行 id 连续启动两次
    const first = await runner.launch(task, executionId)
    const second = await runner.launch(task, executionId)
    // Then 会话身份稳定由执行 id 派生、只建一次；prompt requestId 稳定且只被受理一次
    expect(first).toBe('session-' + executionId)
    expect(second).toBe(first)
    expect(fake.createdSessionIds).toEqual(['session-' + executionId])
    expect(fake.promptRequestIds).toEqual(['dshtrading-tasks-' + executionId])
    expect(commands.lines).toEqual(['/permission workspace-write', '/permission workspace-write'])
  })

  it('用户 依据 SDK 终止原因区分正常、失败、取消与异常终止', async () => {
    // Given 五个空闲会话，分别以 completed / error / aborted(user) / max-tokens / blocked 结束
    const fake = createTasksGateway()
    const runner = makeRunner(fake)
    fake.finishTurn('s-ok', { kind: 'completed' })
    fake.finishTurn('s-error', { kind: 'error', error: { message: 'provider timeout', code: 'LLM_TIMEOUT' } })
    fake.finishTurn('s-abort', { kind: 'aborted', reason: { kind: 'user' } })
    fake.finishTurn('s-max', { kind: 'max-tokens' })
    fake.finishTurn('s-blocked', { kind: 'blocked' })
    // When 逐个侦查结局
    const [ok, error, abort, max, blocked] = await Promise.all([
      runner.inspect('s-ok', 0),
      runner.inspect('s-error', 0),
      runner.inspect('s-abort', 0),
      runner.inspect('s-max', 0),
      runner.inspect('s-blocked', 0),
    ])
    // Then 只有 completed 判成功；aborted 判取消并带原因；其余异常终局一律判失败
    expect(inspectionOf(ok)).toEqual({ outcome: 'succeeded' })
    expect(inspectionOf(error).outcome).toBe('failed')
    expect(inspectionOf(error).error).toContain('provider timeout')
    expect(inspectionOf(abort).outcome).toBe('cancelled')
    expect(inspectionOf(abort).error).toContain('user')
    expect(inspectionOf(max).outcome).toBe('failed')
    expect(inspectionOf(blocked).outcome).toBe('failed')
  })

  it('用户 会话读取失败时侦查带出原因而不是假装完成', async () => {
    // Given 一个会话列表不可用的网关，和一个会话流不可用的空闲会话
    const fake = createTasksGateway()
    const runner = makeRunner(fake)
    fake.seedSession('s-follow')
    fake.setFollowError('s-follow', new Error('follow stream torn down'))
    // When 分别侦查
    const followBroken = inspectionOf(await runner.inspect('s-follow', 0))
    fake.setListError(new Error('gateway list unavailable'))
    const listBroken = inspectionOf(await runner.inspect('s-follow', 0))
    // Then 都是 pending，但各自带出可读原因
    expect(followBroken.outcome).toBe('pending')
    expect(followBroken.diagnostic).toContain('follow')
    expect(listBroken.outcome).toBe('pending')
    expect(listBroken.diagnostic).toContain('session list')
  })
})

describe('tasks fixture 契约核对', () => {
  it('用户 复用同一会话身份创建时网关采纳既有会话而不是新开', async () => {
    // Given 一个契约网关
    const fake = createTasksGateway()
    const create = (agentPreset: string): Promise<unknown> => fake.gateway.invoke({
      namespace: 'session', method: 'create', args: { request: { sessionId: 'session-x', agentPreset } },
    })
    // When 用同一 sessionId 同预设创建两次，再用不同预设创建一次
    const first = await create('master') as { sessionId: string }
    const second = await create('master') as { sessionId: string }
    let conflict: unknown
    try {
      await create('preset-a')
    } catch (error) {
      conflict = error
    }
    // Then 采纳同一会话（不新建），预设不一致按 SDK 语义报冲突
    expect(first.sessionId).toBe('session-x')
    expect(second.sessionId).toBe('session-x')
    expect(fake.createdSessionIds).toEqual(['session-x'])
    expect((conflict as { code?: string }).code).toBe('session/preset-conflict')
  })

  it('用户 重复的 prompt requestId 只被受理一次且会话摘要字段齐全', async () => {
    // Given 一个已创建的会话
    const fake = createTasksGateway()
    await fake.gateway.invoke({ namespace: 'session', method: 'create', args: { request: { sessionId: 'session-y' } } })
    const prompt = {
      namespace: 'session',
      method: 'prompt',
      args: { request: { sessionId: 'session-y', requestId: 'rid-1', mode: 'queue', content: [{ type: 'text', text: '跑一遍' }] } },
    }
    // When 用同一 requestId 发两次 prompt
    await fake.gateway.invoke(prompt)
    await fake.gateway.invoke(prompt)
    const listed = await fake.gateway.invoke({ namespace: 'session', method: 'list', args: { _request: {} } }) as { items: Array<Record<string, unknown>> }
    // Then message 只入队一次，摘要带齐 SessionSummary 必填字段
    expect(fake.promptRequestIds).toEqual(['rid-1'])
    expect(fake.sessions.get('session-y')?.promptTexts).toEqual(['跑一遍'])
    expect(Object.keys(listed.items[0]).sort()).toEqual(['agentAvailable', 'blank', 'running', 'sessionId', 'updatedAt'])
  })
})

describe('TradingTasksService 加固', () => {
  let dir: string
  const disposed: TradingTasksService[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(T0))
    dir = mkdtempSync(join(tmpdir(), 'dshtrading-tasks-hard-svc-'))
  })

  afterEach(() => {
    for (const service of disposed.splice(0)) service.dispose()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  function makeService(fake: TasksGatewayFixture, options: { maxInflightExecutions?: number; staleExecutionMs?: number } = {}): TradingTasksService {
    const commands = createTasksCommandsFixture()
    const service = new TradingTasksService({
      ledgerPath: join(dir, 'ledger-v1.json'),
      gateway: () => fake.gateway,
      commands: () => commands.commands,
      agents: createTasksAgentsFixture,
      workspaces: createTasksWorkspacesFixture,
      // 调度 tick 用产品缺省 30s：cron 用例推进 65s 只需两次 tick，避免空转上千次。
      tickMs: 30_000,
      pollMs: 500,
      ...(options.maxInflightExecutions === undefined ? {} : { maxInflightExecutions: options.maxInflightExecutions }),
      ...(options.staleExecutionMs === undefined ? {} : { staleExecutionMs: options.staleExecutionMs }),
    })
    disposed.push(service)
    return service
  }

  function createTask(service: TradingTasksService, input: { id: string; prompt: string; cron?: string; permission?: string }): string {
    service.apply({
      requestId: 'create-' + input.id,
      action: {
        kind: 'create',
        id: input.id,
        input: {
          title: '定时任务 ' + input.id,
          prompt: input.prompt,
          ...(input.cron === undefined ? {} : { schedule: { enabled: true, cron: input.cron } }),
          ...(input.permission === undefined ? {} : { permission: input.permission }),
        },
      },
    } as never)
    return input.id
  }

  function executionOf(service: TradingTasksService, taskId: string, index = 0): { sessionId?: string; endedAt?: number; result?: string; error?: string; note?: string } | undefined {
    return service.snapshot().tasks.find(task => task.id === taskId)?.executions[index] as never
  }

  it('用户 会话仍在运行时不会因超龄被结算或重发 prompt', async () => {
    // Given 一个手动任务已起跑，承载会话仍在运行
    const fake = createTasksGateway()
    const service = makeService(fake, { staleExecutionMs: 1_000 })
    service.start()
    const taskId = createTask(service, { id: 't-running', prompt: '长任务' })
    service.apply({ requestId: 'run-running', action: { kind: 'run', taskId } } as never)
    await vi.advanceTimersByTimeAsync(50)
    const sessionId = fake.createdSessionIds[0]
    expect(fake.sessions.get(sessionId)?.running).toBe(true)
    // When 假时钟推进远超收敛窗口
    await vi.advanceTimersByTimeAsync(2_000)
    // Then 执行仍未结算，也没有第二次 prompt
    const execution = executionOf(service, taskId)
    expect(execution?.endedAt).toBeUndefined()
    expect(execution?.result).toBeUndefined()
    expect(fake.promptRequestIds).toHaveLength(1)
  })

  it('用户 空闲且完整历史无 turn/end 的失联执行按窗口收敛为取消', async () => {
    // Given 一个已绑定会话的执行，会话静默且历史里没有任何 turn/end
    const fake = createTasksGateway()
    const service = makeService(fake, { staleExecutionMs: 1_000 })
    service.start()
    const taskId = createTask(service, { id: 't-lost', prompt: '失联任务' })
    service.apply({ requestId: 'run-lost', action: { kind: 'run', taskId } } as never)
    await vi.advanceTimersByTimeAsync(50)
    const sessionId = fake.createdSessionIds[0]
    fake.setRunning(sessionId, false)
    // When 时钟越过收敛窗口
    await vi.advanceTimersByTimeAsync(2_500)
    // Then 结算为取消并说明没有 turn/end，且不重发 prompt
    const execution = executionOf(service, taskId)
    expect(execution?.result).toBe('cancelled')
    expect(execution?.error).toMatch(/turn\/end/)
    expect(fake.promptRequestIds).toHaveLength(1)
  })

  it('用户 侦查读取失败时执行保留失败原因而不静默 pending', async () => {
    // Given 一个已起跑的执行，随后会话列表读取失败
    const fake = createTasksGateway()
    const service = makeService(fake, { staleExecutionMs: 1_000 })
    service.start()
    const taskId = createTask(service, { id: 't-readerr', prompt: '读失败' })
    service.apply({ requestId: 'run-readerr', action: { kind: 'run', taskId } } as never)
    await vi.advanceTimersByTimeAsync(50)
    fake.setListError(new Error('gateway list unavailable'))
    // When 时钟推进超过收敛窗口（读取失败不允许把执行判死）
    await vi.advanceTimersByTimeAsync(2_500)
    // Then 执行仍打开但快照上留着读取失败原因
    const execution = executionOf(service, taskId)
    expect(execution?.endedAt).toBeUndefined()
    expect(execution?.note).toContain('session list')
    expect(fake.promptRequestIds).toHaveLength(1)
  })

  it('用户 cron 触发时任务已在执行或权限待确认被跳过并记录原因', async () => {
    // Given 一个已在执行的任务和一个权限待确认的任务，两者都挂每分钟定时
    const fake = createTasksGateway()
    const service = makeService(fake, { maxInflightExecutions: 4 })
    service.start()
    const runningId = createTask(service, { id: 't-cron-running', prompt: '运行中', cron: '* * * * *' })
    const gatedId = createTask(service, { id: 't-cron-gated', prompt: '待确认', cron: '* * * * *', permission: 'danger-full-access' })
    service.apply({ requestId: 'run-cron-running', action: { kind: 'run', taskId: runningId } } as never)
    await vi.advanceTimersByTimeAsync(50)
    // When 推进到下一个触发点
    await vi.advanceTimersByTimeAsync(65_000)
    // Then 两个触发点各留下结构化原因，待确认任务没有起跑
    expect(service.snapshot().tasks.find(task => task.id === runningId)?.schedule?.lastSkip?.reason).toBe('already-running')
    expect(service.snapshot().tasks.find(task => task.id === gatedId)?.schedule?.lastSkip?.reason).toBe('permission-pending')
    expect(executionOf(service, runningId)?.endedAt).toBeUndefined()
    expect(service.snapshot().tasks.find(task => task.id === gatedId)?.executions).toHaveLength(0)
  })

  it('用户 全局容量满时 cron 触发被跳过、手动运行被拒绝', async () => {
    // Given 容量上限为 1，一个手动任务占满容量，另一个任务挂每分钟定时
    const fake = createTasksGateway()
    const service = makeService(fake, { maxInflightExecutions: 1 })
    service.start()
    const holderId = createTask(service, { id: 't-holder', prompt: '占容量' })
    const cronId = createTask(service, { id: 't-cron-cap', prompt: '到点', cron: '* * * * *' })
    const manualId = createTask(service, { id: 't-manual-cap', prompt: '手动' })
    service.apply({ requestId: 'run-holder', action: { kind: 'run', taskId: holderId } } as never)
    await vi.advanceTimersByTimeAsync(50)
    // When 推进到触发点，再对手动任务发起运行
    await vi.advanceTimersByTimeAsync(65_000)
    let thrown: unknown
    try {
      service.apply({ requestId: 'run-manual-cap', action: { kind: 'run', taskId: manualId } } as never)
    } catch (error) {
      thrown = error
    }
    // Then cron 触发点留下 capacity 记录，手动运行被明确拒绝且不新增执行
    expect(service.snapshot().tasks.find(task => task.id === cronId)?.schedule?.lastSkip?.reason).toBe('capacity')
    expect((thrown as { code?: string }).code).toBe('TASKS_CAPACITY_EXCEEDED')
    expect(service.snapshot().tasks.find(task => task.id === manualId)?.executions).toHaveLength(0)
    expect(fake.promptRequestIds).toHaveLength(1)
  })

  it('用户 宿主重启后不会为失联执行重新创建会话或重发 prompt', async () => {
    // Given 第一任宿主起跑了一条执行（会话已绑定、prompt 已受理），随后掉电
    const fake = createTasksGateway()
    const first = makeService(fake, { staleExecutionMs: 1_000 })
    first.start()
    const taskId = createTask(first, { id: 't-restart', prompt: '重启任务' })
    first.apply({ requestId: 'run-restart', action: { kind: 'run', taskId } } as never)
    await vi.advanceTimersByTimeAsync(50)
    const sessionId = fake.createdSessionIds[0]
    expect(fake.promptRequestIds).toHaveLength(1)
    fake.setRunning(sessionId, false)
    first.dispose()
    // When 新任宿主接管同一账本并对账
    const second = makeService(fake, { staleExecutionMs: 1_000 })
    second.start()
    await vi.advanceTimersByTimeAsync(2_500)
    // Then 不新建会话、不重发 prompt，失联执行收敛为取消
    const execution = executionOf(second, taskId)
    expect(execution?.sessionId).toBe(sessionId)
    expect(fake.createdSessionIds).toHaveLength(1)
    expect(fake.promptRequestIds).toHaveLength(1)
    expect(execution?.result).toBe('cancelled')
  })
})

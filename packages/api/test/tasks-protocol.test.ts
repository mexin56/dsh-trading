/**
 * 定时任务协议纯函数单测：全局在飞执行的计数判据与跳过原因词表的收窄。
 * 两者都是账本/服务侧闸门的判据来源，钉住它们的语义而非调用形状。
 */
import { describe, expect, it } from 'vitest'
import { countOpenExecutions, isTaskSkipReason, TASK_SKIP_REASONS, type TaskRecord } from '@dshtrading/api'

/** 造一条只关心执行结算状态的任务。 */
function taskWithExecutions(id: string, settled: boolean[]): TaskRecord {
  return {
    id,
    title: id,
    prompt: '跑',
    createdAt: 0,
    updatedAt: 0,
    executions: settled.map((done, index) => ({
      id: id + '-' + String(index),
      sessionId: undefined,
      startedAt: 0,
      endedAt: done ? 1 : undefined,
      result: done ? 'succeeded' : undefined,
      error: undefined,
      trigger: 'manual',
    })),
  }
}

describe('定时任务协议判据', () => {
  it('用户 统计全局在飞执行时只数未结算的执行', () => {
    // Given 两条任务，一条有在跑与已结算的执行，一条全部结算
    const tasks = [taskWithExecutions('a', [true, false, false]), taskWithExecutions('b', [true, true])]
    // When 统计在飞执行
    const inflight = countOpenExecutions(tasks)
    // Then 只有未结算的两条被计入，空任务计 0
    expect(inflight).toBe(2)
    expect(countOpenExecutions([])).toBe(0)
  })

  it('用户 跳过原因词表只接受权限门、容量与已有执行三种取值', () => {
    // Given 一份声明式词表
    // When 逐个校验已知与未知取值
    const known = TASK_SKIP_REASONS.filter(reason => isTaskSkipReason(reason))
    // Then 词表内全接受，词表外（含非字符串）一律拒绝
    expect(known).toEqual(['permission-pending', 'capacity', 'already-running'])
    expect(isTaskSkipReason('bogus')).toBe(false)
    expect(isTaskSkipReason(undefined)).toBe(false)
    expect(isTaskSkipReason(3)).toBe(false)
  })
})

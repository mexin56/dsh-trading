/**
 * writer lease 行为用例：真实 SQLite 侧文件、无替换件。断言只看「能否取得互斥」
 * 这一外部可见事实，不看内部语句。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tryAcquireHomeFileLeaseSync } from '../src/file-lease.ts'

describe('home file writer lease', () => {
  const dirs: string[] = []

  function makeTarget(name = 'data.json'): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-home-lease-'))
    dirs.push(dir)
    return join(dir, name)
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('用户 在同一数据文件上同时申请两把 writer lease 时第二把拿不到', () => {
    // Given 一个真实临时目录里的数据文件
    const target = makeTarget()
    // When 连续申请两把 lease
    const first = tryAcquireHomeFileLeaseSync(target)
    const second = tryAcquireHomeFileLeaseSync(target)
    // Then 第一把成功、第二把明确拿不到（互斥不靠时间窗判断）
    expect(first).toBeDefined()
    expect(second).toBeUndefined()
    // When 释放第一把后再次申请
    first?.dispose()
    const third = tryAcquireHomeFileLeaseSync(target)
    // Then 释放后可以重新取得互斥
    expect(third).toBeDefined()
    third?.dispose()
  })

  it('用户 释放 writer lease 后第二把立刻可用且侧文件保留', () => {
    // Given 一把已释放的 lease
    const target = makeTarget('ledger-v1.json')
    const first = tryAcquireHomeFileLeaseSync(target)
    first?.dispose()
    // When 另一个实例申请同一文件
    const second = tryAcquireHomeFileLeaseSync(target)
    // Then 它能取得互斥，且 lease 侧文件仍然存在（不得用删除侧文件冒充释放）
    expect(second).toBeDefined()
    expect(existsSync(target + '.writer-lease.sqlite')).toBe(true)
    second?.dispose()
  })
})

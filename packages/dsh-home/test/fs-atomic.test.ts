/** writeJsonAtomic 单测：正常落盘形状、目录自创建、失败清理 tmp 且旧文件保留，
 * 以及「目录 fsync 无法完成时必须明确失败」的耐久性边界。 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeJsonAtomic } from '../src/fs-atomic.ts'

/** 「目录不可读即无法 fsync」是 POSIX 权限语义；Windows 与 root 下不成立。 */
const CAN_DENY_DIR_READ = process.platform !== 'win32' && (process.getuid?.() ?? -1) !== 0

describe('writeJsonAtomic', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-home-atomic-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('正常写入：目录自创建 + 2 空格缩进 JSON + 无 tmp 残留', async () => {
    const file = join(dir, 'sub', 'data.json')
    await writeJsonAtomic(file, { a: 1, b: ['x'] }, '[test] failed to write')
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify({ a: 1, b: ['x'] }, null, 2))
    expect(readdirSync(join(dir, 'sub'))).toEqual(['data.json'])
  })

  it('重写覆盖旧内容（rename 原子替换语义）', async () => {
    const file = join(dir, 'data.json')
    writeFileSync(file, '{"old":true}', 'utf8')
    await writeJsonAtomic(file, { fresh: 1 }, '[test] failed to write')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ fresh: 1 })
  })

  it('目标父路径是文件 → throw 且不产生新文件', async () => {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a dir', 'utf8')
    const file = join(blocker, 'data.json')
    await expect(writeJsonAtomic(file, { a: 1 }, '[test] failed to write')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['blocker'])
  })

  it.skipIf(!CAN_DENY_DIR_READ)('用户遇到无法打开做目录 fsync 的目录时，写入明确失败而不是静默降级', async () => {
    // Given 一个可写可执行、但不可读（open(dir, 'r') 会被拒）的真实目录
    const blocked = join(dir, 'blocked')
    mkdirSync(blocked)
    const file = join(blocked, 'data.json')
    chmodSync(blocked, 0o300)
    try {
      // When 写入该目录下的文件
      const attempt = writeJsonAtomic(file, { a: 1 }, '[test] failed to write')
      // Then 无法确认 rename 的目录持久性时必须上抛，不能吞掉这次同步失败
      await expect(attempt).rejects.toThrow()
    } finally {
      chmodSync(blocked, 0o700)
    }
    // Then 没有 tmp 残留在目录里
    expect(readdirSync(blocked).filter(name => name.includes('.tmp.'))).toEqual([])
  })

  it.skipIf(!CAN_DENY_DIR_READ)('用户遇到不可写目录时，错误上抛、旧文件保留且无 tmp 残留', async () => {
    // Given 一个有旧内容的目录被改成只读加可执行
    const blocked = join(dir, 'readonly')
    mkdirSync(blocked)
    const file = join(blocked, 'data.json')
    writeFileSync(file, '{"old":true}', 'utf8')
    chmodSync(blocked, 0o500)
    try {
      // When 写入被拒绝
      await expect(writeJsonAtomic(file, { fresh: 1 }, '[test] failed to write')).rejects.toThrow()
    } finally {
      chmodSync(blocked, 0o700)
    }
    // Then 旧文件原样保留，且目录里只有它（tmp 已清理）
    expect(readFileSync(file, 'utf8')).toBe('{"old":true}')
    expect(readdirSync(blocked)).toEqual(['data.json'])
  })
})

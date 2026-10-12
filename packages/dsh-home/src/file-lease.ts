/**
 * 本地文件系统的 writer lease（SQLite 进程锁）。业务状态仍是 JSON，这个稳定
 * sidecar 只承载内核级互斥：持锁进程退出即自动释放，不依赖按路径 rename 冒充
 * CAS。Node >=22.19 内置 node:sqlite，无需新增依赖；运行时不提供该能力时
 * fail-closed 报明确错误，绝不退回「先检查后覆盖」的不安全路径。
 *
 * 只在可能有活实例时保留 `*.writer-lease.sqlite` 侧文件：删除它等于放弃互斥。
 */
import { chmodSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

export interface HomeFileLease {
  dispose(): void
}

interface SqliteDatabase {
  exec(sql: string): void
  close(): void
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase
}

const require = createRequire(import.meta.url)
let cachedSqlite: SqliteModule | undefined

function loadSqlite(): SqliteModule {
  if (cachedSqlite !== undefined) return cachedSqlite
  try {
    cachedSqlite = require('node:sqlite') as SqliteModule
    return cachedSqlite
  } catch (error) {
    throw new Error(
      'this runtime provides no node:sqlite writer lease; refusing to run the task ledger without kernel-level mutual exclusion: '
        + (error instanceof Error ? error.message : String(error)),
    )
  }
}

/** SQLITE_BUSY(5) / SQLITE_LOCKED(6)：另一个活实例正持有该文件的 writer lease。 */
function isBusy(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null
    ? (error as { errcode?: unknown }).errcode
    : undefined
  return typeof code === 'number' && (code & 0xff) === 5 || code === 6
}

/** 取得该数据文件的 writer lease；已被活实例持有时返回 undefined（明确失败）。 */
export function tryAcquireHomeFileLeaseSync(filePath: string): HomeFileLease | undefined {
  const leasePath = `${filePath}.writer-lease.sqlite`
  mkdirSync(dirname(leasePath), { recursive: true })
  const sqlite = loadSqlite()
  const database = new sqlite.DatabaseSync(leasePath)
  try {
    database.exec('PRAGMA busy_timeout = 0')
    database.exec('BEGIN IMMEDIATE')
  } catch (error) {
    database.close()
    if (isBusy(error)) return undefined
    throw error
  }
  try { chmodSync(leasePath, 0o600) } catch { /* 权限收紧失败不阻断互斥本身。 */ }
  let disposed = false
  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      try { database.exec('ROLLBACK') } finally { database.close() }
    },
  }
}

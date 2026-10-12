/**
 * home 数据文件的跨进程排他锁（2026-10-09 事故「多进程整表回写互相覆盖」的机制基座）。
 *
 * 本地文件系统由 Node 内置 SQLite 的进程锁持有临界区，获取/接管/释放均在
 * 同一内核排他边界内；业务状态仍是 JSON。持有进程退出自动释放内核租约，
 * owner 标记继续按可证明的进程死亡与心跳证据回收，不靠路径 rename 冒充 CAS。
 * 不支持跨机器共 home；writer-lease.sqlite 侧文件在可能有活实例时不得删除。
 *
 * owner 身份（2026-10-12 补强）：锁路径一旦出现就带有完整身份（pid + host + 每次
 * 获取唯一的 token），不经过「先创建空锁、再补写身份」的未知窗口。
 *
 * 回收判据不是「mtime 旧就抢」：只有 owner 在本机（host 相同）、其 pid **确认已不
 * 存在**、且 mtime 已过陈旧阈值，才允许回收。活着的 owner、别的机器的 owner、读不出
 * 身份的锁一律不回收（等锁明确超时）——宁可按明确错误失败，也绝不冒双写风险。
 *
 * 归属纪律：临界区内提交前（{@link HomeFileLock.assertOwned}）与释放时都按 token
 * 复核「这把锁现在是不是我的」。被回收/顶替的实例既不会再写盘，也不会删掉新
 * owner 的锁（按路径盲删会让互斥失效）。
 *
 * 语义：进入临界区前必得锁；拿不到时等待（缺省 5s），仍拿不到抛
 * {@link HomeFileLockTimeoutError}——「明确告知失败」这条出路，绝不静默按陈旧
 * 快照写盘。持锁期间的临界区应只包住「读盘 + 合并 + 原子写」这一小段。
 */
import { link, mkdir, open, readFile, rename, stat, unlink, utimes } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { tryAcquireHomeFileLeaseSync, type HomeFileLease } from './file-lease'

export interface HomeFileLockOptions {
  /** 等锁上限（毫秒）；超时抛错，不静默降级。 */
  readonly timeoutMs?: number
  /** 锁文件 mtime 超过该毫秒数视为可能陈旧；仍需 owner 已死才回收。 */
  readonly staleMs?: number
}

/** 锁文件记录的 owner 身份：pid + host + 每次获取唯一的 token + 获取时刻。 */
export interface HomeFileLockOwner {
  readonly pid: number
  readonly host: string
  readonly token: string
  readonly at: number
}

/** 等锁超时：本次调用按「明确失败」处理，磁盘上的数据保持持锁者的版本。 */
export class HomeFileLockTimeoutError extends Error {
  readonly lockPath: string
  readonly timeoutMs: number
  constructor(lockPath: string, timeoutMs: number) {
    super(`waiting for home file lock ${lockPath} timed out after ${timeoutMs}ms (another process holds it; this process wrote nothing)`)
    this.name = 'HomeFileLockTimeoutError'
    this.lockPath = lockPath
    this.timeoutMs = timeoutMs
  }
}

/** 提交前复核发现锁已不归本实例（被回收/顶替）：本次写入放弃，不覆盖新 owner。 */
export class HomeFileLockLostError extends Error {
  readonly lockPath: string
  constructor(lockPath: string) {
    super(`home file lock ${lockPath} is no longer owned by this process (it was reclaimed or replaced); this process wrote nothing`)
    this.name = 'HomeFileLockLostError'
    this.lockPath = lockPath
  }
}

/** 临界区句柄：进入后可在提交前复核归属。 */
export interface HomeFileLock {
  readonly owner: HomeFileLockOwner
  /** 复核此刻仍持有该锁（token 未变）；被顶替时抛 {@link HomeFileLockLostError}。 */
  assertOwned(): Promise<void>
}

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_STALE_MS = 30_000
const RETRY_MS = 15
/** 文件系统不支持硬链接时，退回 O_EXCL 创建 + 写身份的 errno。 */
const LINK_UNSUPPORTED_CODES = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EOPNOTSUPP', 'EXDEV'])

const delay = (ms: number): Promise<void> =>
  new Promise(resolve => { setTimeout(resolve, ms) })

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined
}

function randomToken(): string {
  return `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 读出锁的 owner 身份；锁不存在、内容不是合法身份 JSON 都返回 undefined（身份未知）。 */
async function readOwner(lockPath: string): Promise<HomeFileLockOwner | undefined> {
  let text: string
  try {
    text = await readFile(lockPath, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(text) as Partial<HomeFileLockOwner>
    if (
      typeof parsed?.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0
      && typeof parsed.host === 'string' && parsed.host.length > 0
      && typeof parsed.token === 'string' && parsed.token.length > 0
    ) {
      return {
        pid: parsed.pid,
        host: parsed.host,
        token: parsed.token,
        at: typeof parsed.at === 'number' ? parsed.at : 0,
      }
    }
  } catch {
    // 内容不是身份 JSON = 身份未知（回收侧 fail-closed）。
  }
  return undefined
}

/** 本机 pid 是否仍存在（EPERM = 存在但无权限，同样算活着）。 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
}

/**
 * 创建「带身份」的锁：先把完整身份写进唯一 staging 文件，再原子 link 到锁路径。
 * 锁路径一旦存在，内容就是完整身份——不存在「空锁 / 半截身份」的未知窗口，也就
 * 不会出现「未知 owner 永远无法回收」的死锁。返回 false 表示锁已被别人持有。
 */
async function createLockWithOwner(lockPath: string, owner: HomeFileLockOwner): Promise<boolean> {
  const stagingPath = `${lockPath}.owner-${owner.token}`
  const text = JSON.stringify(owner)
  const staging = await open(stagingPath, 'wx')
  try {
    await staging.writeFile(text, 'utf8')
  } finally {
    await staging.close()
  }
  try {
    await link(stagingPath, lockPath)
    return true
  } catch (error) {
    const code = errorCode(error)
    if (code === 'EEXIST') return false
    if (code === undefined || !LINK_UNSUPPORTED_CODES.has(code)) throw error
    // 文件系统不支持硬链接：退回 O_EXCL 创建 + 写身份（极小窗口内身份未知，回收侧 fail-closed）。
    try {
      const fallback = await open(lockPath, 'wx')
      try {
        await fallback.writeFile(text, 'utf8')
      } finally {
        await fallback.close().catch(() => {})
      }
      return true
    } catch (fallbackError) {
      if (errorCode(fallbackError) === 'EEXIST') return false
      throw fallbackError
    }
  } finally {
    await unlink(stagingPath).catch(() => {})
  }
}

/**
 * 陈旧锁回收：返回 true 表示可立刻重试拿锁（锁已不在，或已被本次回收）。
 *
 * 只有「本机 owner + pid 确认不存在 + mtime 超过陈旧阈值」才回收。抢占用 rename
 * 做原子裁决，抢到后复核 token：若抢到的是窗口里被重建的新锁（尤其是活着的
 * owner），用 link 原样放回（link 遇已存在不覆盖），绝不误删活锁。
 */
async function reclaimIfStale(lockPath: string, staleMs: number): Promise<boolean> {
  let ageMs: number
  try {
    ageMs = Date.now() - (await stat(lockPath)).mtimeMs
  } catch {
    return true
  }
  if (ageMs <= staleMs) return false
  const observed = await readOwner(lockPath)
  if (observed === undefined) return false
  if (observed.host !== hostname()) return false
  if (isProcessAlive(observed.pid)) return false
  const claimPath = `${lockPath}.stale-${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await rename(lockPath, claimPath)
  } catch {
    return true
  }
  const claimed = await readOwner(claimPath)
  const claimedIsObserved = claimed !== undefined && claimed.token === observed.token
  const claimedIsLiveHere = claimed !== undefined && claimed.host === hostname() && isProcessAlive(claimed.pid)
  if (!claimedIsObserved || claimedIsLiveHere) {
    // 窗口里锁被别人重建（或换上活 owner）：放回原位。link 遇 EEXIST 不覆盖，
    // 活锁因此绝不因本次回收被删；放不回也宁可留下抢到的这份，不删可疑的活锁。
    const restored = await link(claimPath, lockPath).then(() => true, () => false)
    if (restored || !claimedIsLiveHere) await unlink(claimPath).catch(() => {})
    return false
  }
  await unlink(claimPath).catch(() => {})
  console.warn(
    `[dsh-home] reclaimed stale home file lock ${lockPath} (owner pid ${observed.pid} on this host is gone; mtime older than ${staleMs}ms)`,
  )
  return true
}

/** 在跨进程锁内执行 work；无论成功失败都释放锁（进程崩溃时由陈旧阈值兜底）。 */
export async function withHomeFileLock<T>(
  filePath: string,
  work: (lock: HomeFileLock) => Promise<T>,
  options: HomeFileLockOptions = {},
): Promise<T> {
  const lockPath = `${filePath}.lock`
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  await mkdir(dirname(filePath), { recursive: true })
  const owner: HomeFileLockOwner = { pid: process.pid, host: hostname(), token: randomToken(), at: Date.now() }
  const deadline = Date.now() + timeoutMs
  let lease: HomeFileLease | undefined
  for (;;) {
    lease = tryAcquireHomeFileLeaseSync(filePath)
    if (lease !== undefined) {
      try {
        if (await createLockWithOwner(lockPath, owner)) break
        if (await reclaimIfStale(lockPath, staleMs) && await createLockWithOwner(lockPath, owner)) break
      } catch (error) { lease.dispose(); throw error }
      lease.dispose()
      lease = undefined
    }
    if (Date.now() >= deadline) throw new HomeFileLockTimeoutError(lockPath, timeoutMs)
    await delay(RETRY_MS)
  }

  const stillOurs = async (): Promise<boolean> => {
    const current = await readOwner(lockPath)
    return current !== undefined && current.token === owner.token
  }

  // 心跳：临界区比陈旧阈值长时刷新 mtime；只有锁仍归本实例才刷——被顶替后不再碰
  // 别人的锁。
  const heartbeatJobs = new Set<Promise<void>>()
  const heartbeat = setInterval(() => {
    const job = (async () => {
      if (!(await stillOurs())) return
      const now = new Date()
      await utimes(lockPath, now, now).catch(() => {})
    })()
    heartbeatJobs.add(job)
    void job.finally(() => { heartbeatJobs.delete(job) })
  }, Math.max(1_000, Math.floor(staleMs / 3)))
  heartbeat.unref?.()

  const lock: HomeFileLock = {
    owner,
    async assertOwned(): Promise<void> {
      if (!(await stillOurs())) throw new HomeFileLockLostError(lockPath)
    },
  }
  try {
    return await work(lock)
  } finally {
    clearInterval(heartbeat)
    await Promise.all(heartbeatJobs)
    try {
    // 释放按 token 归属判断：只删自己的锁，绝不删新 owner 的锁（否则互斥失效）。
    if (await stillOurs()) {
      await unlink(lockPath).catch(() => {})
    } else {
      console.warn(
        `[dsh-home] home file lock ${lockPath} was reclaimed or replaced while held by pid ${owner.pid}; leaving the current owner's lock in place`,
      )
    }
    } finally { lease.dispose() }
  }
}

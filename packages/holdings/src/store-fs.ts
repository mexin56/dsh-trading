/**
 * 文件持久化版统一资产台账 store（Node.js 宿主端专用）。
 *
 * 落 ~/.dsh/holdings/book.json，形状 `{ revision, staged, holdings }`（契约 §2）。
 * 写路径走 `@dshtrading/dsh-home` 的 {@link transactStore}——跨进程排他锁 + 锁内
 * 新鲜读盘 + 原子写（2026-10-09 多进程互相覆盖事故修复）；坏文件（JSON 损坏 /
 * 形状不符）打错误日志并回退空台账——读侧不崩宿主（knowledge-fs 同款纪律）。
 *
 * 读新鲜度（2026-10-12 补强）：readFromDisk 是**纯读**，缓存发布只发生在
 * transactStore 成功之后——写失败时本实例不会把未落盘的账发布进缓存；每次 load()
 * 先核对磁盘签名，另一个实例（桌面端/CLI）确认落盘的新持仓因此可见。
 */
import { readFile } from 'node:fs/promises'
import { createEmptyBook, createHoldingsStore } from './store-core.ts'
import { createStoreCache, transactStore } from '@dshtrading/dsh-home'
import type { HoldingsBook, HoldingsStore } from './types.ts'

const LOG_TAG = '[dsh-trading/holdings]'

export function createFileHoldingsStore(filePath: string): HoldingsStore {
  /** 纯粹的新鲜读盘（坏文件回退空台账并打日志）；供缓存与锁内重读共用，不发布缓存。 */
  async function readFromDisk(): Promise<HoldingsBook> {
    let content: string
    try {
      content = await readFile(filePath, 'utf8')
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.error(`${LOG_TAG} failed to read holdings book from ${filePath}; falling back to an empty book:`, err)
      }
      // ENOENT = 首启正常路径，静默起空台账。
      return createEmptyBook()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (err) {
      console.error(`${LOG_TAG} holdings book ${filePath} is not valid JSON; falling back to an empty book:`, err)
      return createEmptyBook()
    }
    const book = parsed as HoldingsBook
    if (
      typeof parsed !== 'object' || parsed === null
      || typeof book.revision !== 'number'
      || !Array.isArray(book.staged)
      || !Array.isArray(book.holdings)
    ) {
      console.error(`${LOG_TAG} holdings book ${filePath} has unexpected shape; falling back to an empty book`)
      return createEmptyBook()
    }
    return book
  }

  const cache = createStoreCache(filePath, readFromDisk)

  async function load(): Promise<HoldingsBook> {
    return cache.load()
  }

  /** 跨进程临界区：plan 在锁内新鲜读到的 book 上就地改；返回前已原子落盘。 */
  async function transact<T>(plan: (book: HoldingsBook) => T | Promise<T>): Promise<T> {
    let result: T | undefined
    const book = await transactStore(
      filePath,
      readFromDisk,
      async (fresh) => {
        result = await plan(fresh)
        return fresh
      },
      value => ({ revision: value.revision, staged: value.staged, holdings: value.holdings }),
      `${LOG_TAG} failed to atomic flush to`,
    )
    // 只有成功落盘才发布：写失败时缓存保持旧值（不提前 publish 未确认的账）。
    cache.replace(book)
    return result as T
  }

  return createHoldingsStore({ load, transact })
}

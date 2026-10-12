/**
 * 整表 JSON 的跨进程「锁内读 - 改 - 原子写」（2026-10-09 事故修复的共享入口），
 * 以及跨实例读新鲜度缓存 {@link createStoreCache}（2026-10-12 补强）。
 *
 * 背景：下列 store 都是「进程内内存缓存 + 整表回写」，两个宿主进程共用同一
 * DSH_HOME 时后写者用自己那份陈旧快照覆盖先写者（last-writer-wins，静默丢数据；
 * 实测抹掉 indicators/chart.json 的 symbolParams 与 hiddenScopes）。
 *
 * {@link transactStore} 是全仓唯一的跨进程临界区实现，各 store 只调它，不各自复制：
 * 1. 取该文件的跨进程排他锁（{@link withHomeFileLock}）；
 * 2. 锁内**新鲜重读磁盘**（readFromDisk，不是进临界区前的缓存）；
 * 3. mutate 在这份新鲜值上做本次修改并返回新的内存值；
 * 4. **提交前复核锁仍归本实例**（临界区较长时锁可能已被回收/顶替），再 tmp+rename
 *    原子写落盘，返回值即调用方应缓存的当前值。
 *
 * 「读 - 改」整体在锁内，所以两个进程各自的**新增、删除**都不丢：后到者是在先到者的
 * 结果上继续改，而不是用陈旧快照覆盖。这是「先读回并合并双方数据」的具体形态，
 * 而不是「拒绝第二实例写」——本机桌面端与 CLI 长期共用同一 home，拒绝写会让第二
 * 实例完全存不了设置。等锁超时抛 {@link HomeFileLockTimeoutError}，提交前发现锁被
 * 顶替抛 {@link HomeFileLockLostError}：两种都是明确失败，绝不静默按陈旧快照覆盖。
 *
 * 合并粒度是条目（行表按 id、嵌套表按各自键）：同一条目被两个进程同时改时，后写者
 * 在该条目上的整条值胜出（不做字段级三方合并，见 note 的 Residue）。
 *
 * 幂等 no-op（删除不存在的 id、重复写入同值）由调用方在 mutate 里返回
 * {@link SKIP_WRITE} 表达——此时不落盘（保持既有「无变化不重写」语义），返回值仍是
 * 锁内新鲜读到的值，调用方缓存照旧刷新。
 */
import { stat } from 'node:fs/promises'
import { withHomeFileLock, type HomeFileLockOptions } from './file-lock.ts'
import { writeJsonAtomic } from './fs-atomic.ts'

/** 合并入口的缺省等锁上限：比 store 内部调用更宽松，避免正常并发被误判超时。 */
const DEFAULT_TIMEOUT_MS = 10_000

/** mutate 返回它表示「本次无内容变化」：不落盘，但缓存仍取锁内新鲜值。 */
export const SKIP_WRITE: unique symbol = Symbol('dsh-home:skip-write')

/** {@link SKIP_WRITE} 的类型形态：写 mutate 签名时用它标注「可能无变化」。 */
export type SkipWrite = typeof SKIP_WRITE

export interface TransactStoreOptions {
  /** 等锁上限（毫秒）；超时抛 {@link HomeFileLockTimeoutError}。 */
  readonly timeoutMs?: number
  /** 陈旧锁回收阈值（毫秒）。 */
  readonly staleMs?: number
}

function lockOptionsOf(options: TransactStoreOptions): HomeFileLockOptions {
  return {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(options.staleMs !== undefined ? { staleMs: options.staleMs } : {}),
  }
}

/**
 * 在跨进程锁内读-改-写一份 JSON 表。
 *
 * @param filePath - 目标 JSON 文件
 * @param readFromDisk - **新鲜**读盘（不得回传内存缓存，也不得借它发布缓存）；由各
 *   store 提供 parse 感知的读取，使坏形/坏 JSON 的降级口径与自身 load() 一致
 * @param mutate - 在锁内新鲜值上做本次修改；返回新内存值，或 {@link SKIP_WRITE}
 *   表示无变化不落盘
 * @param serialize - 新内存值 → 落盘形状（数组、按 id 为键的对象、容器包裹皆可）
 * @param logPrefix - 失败日志前缀，与各 store 原 writeJsonAtomic 调用逐字一致
 * @returns 落盘后的当前值（SKIP_WRITE 时即锁内新鲜值）
 */
export async function transactStore<T>(
  filePath: string,
  readFromDisk: () => Promise<T>,
  mutate: (onDisk: T) => T | SkipWrite | Promise<T | SkipWrite>,
  serialize: (value: T) => unknown,
  logPrefix: string,
  options: TransactStoreOptions = {},
): Promise<T> {
  return withHomeFileLock(filePath, async (lock) => {
    const onDisk = await readFromDisk()
    const next = await mutate(onDisk)
    if (next === SKIP_WRITE) return onDisk
    // 提交前复核归属：拿锁后到落盘前可能已被回收/顶替，此时绝不能再写——否则是在
    // 「别人的锁」下覆盖别人已确认的数据。明确失败优于静默双写。
    await lock.assertOwned()
    await writeJsonAtomic(filePath, serialize(next), logPrefix)
    return next
  }, lockOptionsOf(options))
}

/**
 * 跨实例读新鲜度缓存：进程内内存缓存 + 每次读前核对磁盘签名。
 *
 * 为什么不能只 `if (cache !== null) return cache`（2026-10-12 补强）：整表 store 的
 * 缓存是「本实例上次读盘的值」，另一实例（桌面端/CLI）确认落盘的新行永远进不来，
 * list() 会一直返回陈旧快照。此缓存每次 load() 先 stat 目标文件，签名（dev/ino/
 * size/mtimeNs/ctimeNs）变了就重新读盘；因此「别人已确认的写」在下一次读取可见，
 * 缓存只省重复读，不会永久命中。
 *
 * 写失败的发布纪律：只有 {@link transactStore} 成功返回后才 replace()；写失败时缓存
 * 保持旧值，且 replace() 之后的下一次 load() 仍会核对磁盘签名——即使发布的值没真正
 * 落盘也会被磁盘纠正，不会出现「缓存里有、盘上没有」。
 */
export interface StoreCache<T> {
  /** 取当前新鲜值：磁盘签名未变时用缓存，变了（或被 replace/invalidate）则重新读盘。 */
  load(): Promise<T>
  /** 一次成功落盘后发布本次值；签名置为待核对，下次 load 仍以磁盘为准。 */
  replace(value: T): void
  /** 丢弃缓存，下次 load 必定重新读盘。 */
  invalidate(): void
}

/**
 * 磁盘签名：路径不存在为 'missing'。stat 的其他失败给出永不匹配的签名，强制本次
 * 重新读盘——读盘自身的错误/降级口径由各 store 的 readFromDisk 决定，这里不引入
 * 新的读语义。
 */
async function fileSignature(filePath: string): Promise<string> {
  try {
    const info = await stat(filePath, { bigint: true })
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return 'missing'
    return `unavailable:${Date.now()}:${Math.random()}`
  }
}

/**
 * 建一个「每次读前核对磁盘签名」的缓存。readFromDisk 必须是**纯读**（不发布缓存、
 * 不就地改缓存对象），这样写失败时未确认的值不会提前进入缓存。
 */
export function createStoreCache<T>(filePath: string, readFromDisk: () => Promise<T>): StoreCache<T> {
  let entry: { value: T; signature: string | undefined } | undefined
  return {
    async load(): Promise<T> {
      const signature = await fileSignature(filePath)
      if (entry !== undefined && entry.signature !== undefined && entry.signature === signature) return entry.value
      const value = await readFromDisk()
      // 签名取自读盘之前：读盘期间文件若又变了，存下的签名偏旧 → 下次仍会重读
      // （只多读一次，不会漏读）。
      entry = { value, signature }
      return value
    },
    replace(value: T): void {
      // 刻意只发布值、不发布签名：下次 load() 必须重新核对磁盘，避免把「发布时的
      // 瞬时签名」当成永久凭据（并发写会让它过期而不自知）。
      entry = { value, signature: undefined }
    },
    invalidate(): void {
      entry = undefined
    },
  }
}

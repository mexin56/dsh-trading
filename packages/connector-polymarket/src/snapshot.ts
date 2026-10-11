/**
 * 本地价格快照（证据 Q3 的裁决产物）：只为回答「这条概率自上次观察变了多少」。
 *
 * 为什么仍要本地快照（证据 Q3.1/Q3.2）：上游 `clob.polymarket.com/prices-history`
 * 虽然有服务端历史，但**只保留约 30 天**（显式 startTs/endTs 窗口 336h 可用、
 * 720h 报 `interval is too long`），且需要按 token 扇出。本地快照是「近期 tick」，
 * 与上游历史互补，不是替代。
 *
 * 存储位置（硬约束）：trading home 下，经 `@dshtrading/dsh-home` 的 `dshHomeDir()`
 * 解析——绝不写进包内或仓库数据。默认 `$DSH_HOME/polymarket/snapshots.json`。
 *
 * 体积（证据 Q3.5 实测 237.6 bytes/row）：本实现只存**每档的最新一次读数**
 * （不是 append-only 流水），所以文件大小与「会议数 × 档位数」成正比（约 10 条
 * 会议 × 5 档 × ~200B ≈ 10 KiB），与采样频率无关。这避开了 append-only 在
 * 1/分钟频率下 119 MiB/年/会议的量级。
 *
 * 跨进程：走 `transactStore`（全仓唯一临界区实现），两个宿主共用同一 home 时
 * 不会 last-writer-wins 静默丢数据。
 */
import { dshHomeDir, transactStore, SKIP_WRITE } from '@dshtrading/dsh-home'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PredictionMeeting } from '@dshtrading/api'

/** 快照文件相对 trading home 的路径（POSIX 分隔符，join 时再拆）。 */
export const SNAPSHOT_DIR = 'polymarket'
export const SNAPSHOT_FILE = 'snapshots.json'

/** 快照表版本（结构变更时递增，旧版按空表处理而不是崩）。 */
export const SNAPSHOT_VERSION = 1

/** 一条档位读数。 */
export interface SnapshotEntry {
  /** 该档最近一次观察到的隐含概率。 */
  readonly probability: number
  /** 观察时刻（ISO 8601 UTC）。 */
  readonly observedAt: string
}

/** 整张快照表：`eventId -> bucketKey -> entry`。 */
export interface SnapshotTable {
  readonly version: number
  readonly meetings: Record<string, Record<string, SnapshotEntry>>
}

export interface SnapshotStoreOptions {
  /** 文件绝对路径覆盖（测试注入临时目录用）。 */
  readonly filePath?: string
  /** 环境变量映射（缺省 process.env；测试固定 home 用）。 */
  readonly env?: Record<string, string | undefined>
}

/** 默认快照文件路径：`$DSH_HOME/polymarket/snapshots.json`。 */
export function defaultSnapshotPath(env: Record<string, string | undefined> = process.env): string {
  return join(dshHomeDir(env), SNAPSHOT_DIR, SNAPSHOT_FILE)
}

/** 空表（首次运行 / 结构版本不符 / 坏 JSON 的降级值——快照缺失不是错误）。 */
export function emptySnapshotTable(): SnapshotTable {
  return { version: SNAPSHOT_VERSION, meetings: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解析磁盘上的快照表。
 *
 * **降级语义**：快照是纯增益信息（有没有它都不影响概率正确性），所以坏形状一律
 * 降级为空表**不抛错**——与「上游取数失败必须响亮」刻意相反。取数失败会掩盖成
 * 「没有数据」，快照失败则只是少一个 Δ 标注，两者不可混为一谈。
 */
export function parseSnapshotTable(raw: unknown): SnapshotTable {
  if (!isRecord(raw) || raw.version !== SNAPSHOT_VERSION || !isRecord(raw.meetings)) return emptySnapshotTable()
  const meetings: Record<string, Record<string, SnapshotEntry>> = {}
  for (const [eventId, buckets] of Object.entries(raw.meetings)) {
    if (!isRecord(buckets)) continue
    const parsed: Record<string, SnapshotEntry> = {}
    for (const [key, entry] of Object.entries(buckets)) {
      if (!isRecord(entry)) continue
      const probability = entry.probability
      const observedAt = entry.observedAt
      if (typeof probability !== 'number' || !Number.isFinite(probability)) continue
      if (typeof observedAt !== 'string' || observedAt.trim() === '') continue
      parsed[key] = { probability, observedAt }
    }
    meetings[eventId] = parsed
  }
  return { version: SNAPSHOT_VERSION, meetings }
}

/**
 * 给每档补 `changeSincePrevious`（与**上一次**读数的差），然后写入本次读数。
 *
 * 关键纪律（对应验收「失败路径不产生空数据假象」）：
 * - 首次采样 = 无历史 → `changeSincePrevious` **缺省**，绝不填 0（0 是「确知没变」，
 *   与「不知道」是两件事）；
 * - 已结算档位同样写入（它们在页面上显示最终 0/1），但不再参与后续比较；
 * - 写盘失败**不阻断取数**（调用方拿到的是已经算好的 Δ）。
 */
export function applySnapshot(table: SnapshotTable, meetings: readonly PredictionMeeting[], observedAt: string): {
  readonly meetings: readonly PredictionMeeting[]
  readonly next: SnapshotTable
} {
  // 保留上一轮**本轮未返回**的会议：会议只是暂时不在候选集里（例如上游分页/系列
  // 调整），它的基线不该被当作「首次观察」丢掉——Δ 在决议临近时最有用。
  const nextMeetings: Record<string, Record<string, SnapshotEntry>> = { ...table.meetings }
  const annotated = meetings.map((meeting) => {
    const previous = table.meetings[meeting.id]
    const buckets = meeting.buckets.map((bucket) => {
      const before = previous?.[bucket.key]
      return before === undefined
        ? bucket
        : { ...bucket, changeSincePrevious: Number((bucket.probability - before.probability).toFixed(6)) }
    })
    nextMeetings[meeting.id] = Object.fromEntries(
      buckets.map((bucket) => [bucket.key, { probability: bucket.probability, observedAt }]),
    )
    return { ...meeting, buckets }
  })
  return { meetings: annotated, next: { version: SNAPSHOT_VERSION, meetings: nextMeetings } }
}

const LOG_PREFIX = '[dsh-trading/connector-polymarket] failed to atomic flush snapshots to'

/** 新鲜读盘（锁内调用；坏内容降级为空表，见 {@link parseSnapshotTable}）。 */
async function readTableFromDisk(filePath: string): Promise<SnapshotTable> {
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return emptySnapshotTable()
  }
  try {
    return parseSnapshotTable(JSON.parse(text))
  } catch {
    return emptySnapshotTable()
  }
}

/**
 * 快照表的持久化句柄。
 *
 * `annotate()` 是唯一业务入口：**在锁内**读旧表、算 Δ、写新表——三个动作在同一
 * 临界区里，两个宿主进程并发取数不会出现「A 读旧表、B 也读旧表、B 后写覆盖 A」。
 * 锁超时抛 HomeFileLockTimeoutError（响亮），不静默按陈旧值覆盖。
 */
export class SnapshotStore {
  private readonly filePath: string

  constructor(options: SnapshotStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultSnapshotPath(options.env ?? process.env)
  }

  path(): string {
    return this.filePath
  }

  /** 读当前表（只读；不改盘，锁内新鲜读）。 */
  async read(): Promise<SnapshotTable> {
    let table: SnapshotTable = emptySnapshotTable()
    await transactStore(
      this.filePath,
      () => readTableFromDisk(this.filePath),
      (onDisk) => { table = onDisk; return SKIP_WRITE },
      (value) => value,
      LOG_PREFIX,
    )
    return table
  }

  /**
   * 在锁内给本次会议补 Δ 并落盘下一次读数。
   *
   * 返回标注后的会议（调用方直接用它构造响应，Δ 一定与本次落盘同源）。
   */
  async annotate(meetings: readonly PredictionMeeting[], observedAt: string): Promise<readonly PredictionMeeting[]> {
    let annotated: readonly PredictionMeeting[] = meetings
    await transactStore(
      this.filePath,
      () => readTableFromDisk(this.filePath),
      (onDisk) => {
        const applied = applySnapshot(onDisk, meetings, observedAt)
        annotated = applied.meetings
        return applied.next
      },
      (value) => value,
      LOG_PREFIX,
    )
    return annotated
  }
}

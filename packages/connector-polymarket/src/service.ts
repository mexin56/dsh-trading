/**
 * 预测市场取数服务（host 平面 provide `tradingPredictionFeed`）。
 *
 * 与 @dshtrading/connector-jin10 的 macro-service.ts 同款形态与理由：GUI 面板走
 * `/dshtrading/api/prediction/*` 桥（node 半），桥只能经 cordis 服务拿到取数实现；
 * 面板面与将来的 agent 工具面共用同一个 PolymarketService 实例，避免两份取数
 * 逻辑漂移（禁止两套判据）。服务缺席（连接器未装/未启用）时桥报
 * TRADING_NOT_IMPLEMENTED，绝不把「没装数据源」伪装成「没有数据」。
 *
 * 形态选普通对象 + `ctx.reflect.provide`，理由见 macro-service.ts 头注。
 */
import type { PredictionFeed, PredictionFeedService, PredictionMeeting } from '@dshtrading/api'
import { FOMC_SERIES_ID, discoverFomcMeetings } from './discovery.js'
import type { GammaClient } from './gamma.js'
import type { SnapshotStore } from './snapshot.js'

export const TRADING_PREDICTION_FEED_KEY = 'tradingPredictionFeed'

/** 单次取数的候选上限（上游 limit 上限 100，证据 Q1.4）。 */
export const PREDICTION_EVENTS_LIMIT = 100

export interface PolymarketServiceOptions {
  readonly gamma: GammaClient
  /** 快照存储；缺省 = 不做 Δ 标注（服务仍可用）。 */
  readonly snapshots?: SnapshotStore | undefined
  /** 时钟注入（测试固定 fetchedAt 用；缺省 Date.now）。 */
  readonly now?: (() => number) | undefined
}

/**
 * 取数实现：**一次 GET 拿全量**（证据 Q2.3 的 v1 裁决理由）。
 *
 * `cacheBust` 的用途（证据 Q3.4）：`/events` 有 `max-age=300` CDN 缓存，同一请求
 * 5 分钟内只会拿到同一份副本。默认**不加**（面板轮询间隔离不开 5 分钟时缓存是
 * 有益的去重）；需要真实时值时可显式打开。
 */
export class PolymarketService {
  private readonly gamma: GammaClient
  private readonly snapshots: SnapshotStore | undefined
  private readonly now: () => number

  constructor(options: PolymarketServiceOptions) {
    this.gamma = options.gamma
    this.snapshots = options.snapshots
    this.now = options.now ?? Date.now
  }

  /**
   * FOMC 决议路径全量会议（含已结算；按 endDate 升序）。
   *
   * **失败必须响亮**：传输失败、HTTP 403（Cloudflare 1010 的 text/plain 体）、
   * 非 JSON 体、非数组体一律抛结构化错误——绝不返回 `{meetings: []}`。空数组
   * 只代表「上游确实返回了空集合」这一种真实语义。
   */
  async listFomcMeetings(options: { cacheBust?: boolean | undefined } = {}): Promise<PredictionFeed> {
    const query: Record<string, string> = { series_id: FOMC_SERIES_ID, limit: String(PREDICTION_EVENTS_LIMIT), closed: 'false' }
    if (options.cacheBust === true) query._cb = String(this.now())
    const response = await this.gamma.get('/events', query)
    const { meetings } = discoverFomcMeetings(response.body)
    const fetchedAt = new Date(this.now()).toISOString()
    return { fetchedAt, meetings: await this.annotate(meetings, fetchedAt) }
  }

  /**
   * Δ 标注：**快照失败不阻断取数**。
   *
   * 为什么与上游失败区别对待：上游失败时我们没有任何可信数据，必须响亮抛错；
   * 快照失败时概率本身依然完整正确，缺的只是「与上次差多少」这一项增益标注。
   * 此时若整块失败，会把一次磁盘/权限问题放大成整个面板黑屏。
   *
   * 但降级必须**可见**：log 到 stderr，并且返回的档位**不带** `changeSincePrevious`
   * （缺省 = 不知道），绝不填 0——0 表示「确知没变」，那是编造。
   */
  private async annotate(meetings: readonly PredictionMeeting[], observedAt: string): Promise<readonly PredictionMeeting[]> {
    if (this.snapshots === undefined) return meetings
    try {
      return await this.snapshots.annotate(meetings, observedAt)
    } catch (error) {
      console.error('[dsh-trading/connector-polymarket] snapshot annotation unavailable, continuing without Δ:', error)
      return meetings
    }
  }
}

/** host 平面服务面：桥与工具面共用的最小接口（@dshtrading/api 的 PredictionFeedService）。 */
export function createPolymarketPredictionFeed(service: PolymarketService): PredictionFeedService {
  return {
    /** 当前 FOMC 决议路径全部会议（含已结算）。 */
    async listFomcMeetings(): Promise<PredictionFeed> {
      return service.listFomcMeetings()
    },
  }
}

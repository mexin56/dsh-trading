/**
 * Polymarket 预测市场面板（右缘会话列容器的功能页签 6 号，2026-10-11）。
 *
 * 与定时任务/资产/快讯/宏观/文件同款模式：竖条第 6 个按钮激活时原位覆盖对话列
 * （五处互斥联动见 SessionRail，shell-pad.css 规则 16），状态由 SessionRail 写
 * body[data-dshtrading-prediction-open]。定位与宽度吃 frame 轨道变量
 * （polymarket-panel.module.css）。
 *
 * 数据面 = host 面 tradingPredictionFeed 服务（桥 /dshtrading/api/prediction/fomc，
 * P1 数据面卡已交付）。本面板**只读**：不提供任何下单/交易入口。
 *
 * 三处 owner 裁决（2026-10-11）：
 * - 显示概率取 bestAsk（与 Polymarket 网页逐值一致）；Δ 沿用宿主快照的 mid 基准，
 *   基准差异在标题行显式标注，不隐式换算（口径明细见 prediction-view.ts 头注）。
 * - 质量阈值：深度 < 100k USD 记「深度不足」、价差 > 0.02 记「价差过宽」。
 * - 事件对照：面板打开期间按轮询节拍留 (时间, 各档概率) 采样，把当周美国 CPI/PPI
 *   时点标在序列上，读「公布 → 概率跳变」；采样不足时明说采样不足。
 *
 * 两个源（预测市场 / 宏观日历）**各自记账**：任一失败只影响自己那块，绝不把
 * 失败画成「没有数据」。
 */
import { useEffect, useRef, useState } from 'react'
import {
  fetchMacroCalendar,
  fetchPredictionFomc,
  type ClientMacroCalendarEntry,
  type ClientPredictionResult,
} from './api.ts'
import type { MarketLocaleKey } from './contract.ts'
import {
  appendSample,
  formatDeltaPp,
  formatProbability,
  inflationEventsOf,
  largestMovementAround,
  meetingViewOf,
  visibleMeetingsOf,
  VISIBLE_MEETINGS,
  type MeetingView,
  type ProbabilitySample,
} from './prediction-view.ts'
import css from './polymarket-panel.module.css'

/** 轮询周期：概率是分钟级信息的连续量，1 分钟足够新且不侵蚀上游配额。 */
const POLL_MS = 60_000
/** 日历条目上限（与 MacroPanel 同值，整周实测已到 254 条）。 */
const CALENDAR_LIMIT = 400

type FeedState = 'loading' | 'ready' | 'error'

/** 可注入的数据缝（测试用真实函数替身，不引入 mock 工具）。 */
export interface PolymarketPanelDeps {
  fetchPrediction?: ((signal?: AbortSignal) => Promise<ClientPredictionResult>) | undefined
  fetchCalendar?: ((limit: number, signal?: AbortSignal) => Promise<ClientMacroCalendarEntry[] | null>) | undefined
  /** 时钟（采样时间轴用；缺省 Date.now）。 */
  now?: (() => number) | undefined
}

export type PolymarketPanelTranslate = (key: MarketLocaleKey) => string

export interface PolymarketPanelProps {
  t: PolymarketPanelTranslate
  /** 关闭面板（竖条按钮/头部 ×）。 */
  onClose(): void
  deps?: PolymarketPanelDeps | undefined
}

/** 档位方向（上游标签原义展示，方向只用于分组标题）。 */
function directionOf(changeBps: number | undefined): 'cut' | 'hold' | 'hike' | 'unknown' {
  if (changeBps === undefined) return 'unknown'
  if (changeBps < 0) return 'cut'
  if (changeBps > 0) return 'hike'
  return 'hold'
}

/** 方向 → 词典键。 */
function directionKeyOf(changeBps: number | undefined): MarketLocaleKey {
  const direction = directionOf(changeBps)
  if (direction === 'cut') return 'prediction.dir.cut'
  if (direction === 'hike') return 'prediction.dir.hike'
  if (direction === 'hold') return 'prediction.dir.hold'
  return 'prediction.dir.unknown'
}

/** 本地时刻短文本（MM-DD HH:mm）。 */
function shortTime(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function PolymarketPanel({ t, onClose, deps }: PolymarketPanelProps) {
  const fetchPrediction = deps?.fetchPrediction ?? fetchPredictionFomc
  const fetchCalendar = deps?.fetchCalendar ?? fetchMacroCalendar
  const now = deps?.now ?? Date.now

  const [meetings, setMeetings] = useState<readonly MeetingView[]>([])
  const [predictionState, setPredictionState] = useState<FeedState>('loading')
  const [predictionCode, setPredictionCode] = useState<string>('')
  const [fetchedAt, setFetchedAt] = useState<string>('')
  // 宏观日历独立记账（与 MacroPanel 同源：金十宏观日历）。
  const [events, setEvents] = useState<readonly { at: number; title: string }[]>([])
  const [calendarState, setCalendarState] = useState<FeedState>('loading')
  // 会话内采样：面板打开期间累积，「事件 → 概率变化」全靠它。
  const [samples, setSamples] = useState<readonly ProbabilitySample[]>([])
  // 采样游标用 ref：轮询闭包每次读最新值，不进依赖数组（避免重建定时器）。
  const samplesRef = useRef<readonly ProbabilitySample[]>([])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      // 两个源各自 await 各自记账：一个失败不影响另一个的展示。
      const [prediction, calendar] = await Promise.all([
        fetchPrediction().catch((): ClientPredictionResult => ({ status: 'error', code: 'TRADING_UNEXPECTED', message: 'fetcher threw' })),
        fetchCalendar(CALENDAR_LIMIT).catch(() => null),
      ])
      if (cancelled) return

      if (prediction.status === 'error') {
        setPredictionState('error')
        setPredictionCode(prediction.code)
      } else {
        const views = prediction.meetings.map(meetingViewOf)
        setMeetings(views)
        setFetchedAt(prediction.fetchedAt)
        setPredictionState('ready')
        // 采样记前几场会议（与展示的会议组同集）的各档显示概率——常驻面板不按
        // 全部会议数放大状态，只留 spike 判据可用的那几次。
        for (const meeting of visibleMeetingsOf(prediction.meetings)) {
          const values: Record<string, number> = {}
          for (const bucket of meetingViewOf(meeting).buckets) values[`${meeting.id}:${bucket.key}`] = bucket.probability
          samplesRef.current = appendSample(samplesRef.current, { at: now(), values })
        }
        setSamples(samplesRef.current)
      }

      if (calendar === null) {
        setCalendarState('error')
      } else {
        setEvents(inflationEventsOf(calendar))
        setCalendarState('ready')
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [fetchPrediction, fetchCalendar, now])

  // 会议组：下一次会议 + 后续至多 VISIBLE_MEETINGS-1 次（spike 判据里同批可用的
  // 后续会议；全量返回里更远的会议只作数据，不上屏）。
  const shown = meetings.filter((meeting) => !meeting.closed).slice(0, VISIBLE_MEETINGS)
  // 事件对照以第一场（最近的）会议的档位为观察对象；采样键含会议 id。
  const next = shown.length === 0 ? undefined : shown[0]
  const keys = next === undefined ? [] : next.buckets.map((bucket) => `${next.id}:${bucket.key}`)
  // 事件对照：只列采样时间窗覆盖到的事件（窗外的事件没有「之前/之后」两段可对照）。
  const newest = samples.length === 0 ? undefined : samples[samples.length - 1]!.at
  const oldest = samples.length === 0 ? undefined : samples[0]!.at
  const comparable = newest === undefined || oldest === undefined
    ? []
    : events.filter((event) => event.at >= oldest && event.at <= newest)

  return (
    <div className={css.panel} data-dshtrading-polymarket-panel="" role="panel" aria-label={t('stage.prediction')}>
      <header className={css.head}>
        <strong className={css.title}>{t('stage.prediction')}</strong>
        <span className={css.spacer} />
        <button type="button" className={css.closeBtn} aria-label={t('flash.close')} title={t('flash.close')} onClick={onClose}>×</button>
      </header>
      <div className={css.body}>
        {predictionState === 'error' ? (
          <p className={css.error} data-dshtrading-prediction-error={predictionCode}>
            {predictionCode === 'TRADING_NOT_IMPLEMENTED' ? t('prediction.errorNotInstalled') : t('prediction.error')}
          </p>
        ) : null}
        {predictionState === 'loading' ? <p className={css.empty}>{t('prediction.loading')}</p> : null}
        {predictionState === 'ready' && next === undefined ? (
          <p className={css.empty}>{t('prediction.noMeeting')}</p>
        ) : null}
        {predictionState === 'ready' ? shown.map((meeting, index) => (
          <div className={css.meeting} key={meeting.id} data-dshtrading-prediction-meeting={meeting.id}>
            <div className={css.meetingTitle}>{meeting.title}</div>
            <div className={css.meetingMeta}>
              {meeting.meetingWindow !== undefined ? <span>{meeting.meetingWindow}</span> : null}
              <span>{t('prediction.ends')} {shortTime(Date.parse(meeting.endDate))}</span>
              {/* 只对最近一场标口径基准：后续会议同一组口径，重复标注是噪音。 */}
              {index === 0 ? <span>{t('prediction.basisAsk')}</span> : null}
            </div>

            {/* 健康检查：概率和越界可见提示，绝不静默。 */}
            {meeting.sumHealth === 'off-band' ? (
              <p className={css.warn} data-dshtrading-prediction-sum={meeting.probabilitySum.toFixed(3)}>
                {t('prediction.sumOffBand')} {meeting.probabilitySum.toFixed(3)}
              </p>
            ) : null}
            {meeting.degraded.length > 0 ? (
              <p className={css.warn} data-dshtrading-prediction-degraded={meeting.degraded.join(',')}>
                {t('prediction.degraded')} {meeting.degraded.join(', ')}
              </p>
            ) : null}

            <div className={css.buckets}>
              {meeting.buckets.map((bucket) => {
                const delta = formatDeltaPp(bucket.delta)
                return (
                  <div className={css.bucket} key={bucket.key} data-dshtrading-bucket={`${meeting.id}:${bucket.key}`}>
                    <div className={css.bucketTop}>
                      <span className={css.bucketLabel}>{bucket.label}</span>
                      <span className={css.bucketProb}>{formatProbability(bucket.probability)}</span>
                      {/* 快照不足 → delta 缺省 → 整块不渲染（不是显示 0）。 */}
                      {delta !== undefined ? (
                        <span className={css.delta} data-sign={bucket.delta === undefined || bucket.delta === 0 ? 'flat' : bucket.delta > 0 ? 'up' : 'down'}>{delta}</span>
                      ) : null}
                    </div>
                    <div className={css.bar}>
                      <span className={css.barFill} style={{ width: `${Math.max(0, Math.min(1, bucket.probability)) * 100}%` }} />
                    </div>
                    <div className={css.bucketMeta}>
                      <span className={css.bucketDir}>{t(directionKeyOf(bucket.changeBps))}</span>
                      {bucket.marks.includes('thin-depth') ? (
                        <span className={css.mark} data-mark="thin-depth">{t('prediction.thinDepth')}</span>
                      ) : null}
                      {bucket.marks.includes('wide-spread') ? (
                        <span className={css.mark} data-mark="wide-spread">{t('prediction.wideSpread')}</span>
                      ) : null}
                      {bucket.closed ? <span className={css.mark}>{t('prediction.closed')}</span> : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )) : null}

        {/* 事件对照：宏观日历独立记账——这里失败只影响这一块。 */}
        <div className={css.events}>
          <div className={css.sectionTitle}>{t('prediction.eventsTitle')}</div>
          {calendarState === 'error' ? <p className={css.error}>{t('prediction.calendarError')}</p> : null}
          {calendarState === 'loading' ? <p className={css.empty}>{t('macro.loading')}</p> : null}
          {calendarState === 'ready' && comparable.length === 0 ? (
            <p className={css.empty}>{t('prediction.noComparable')}</p>
          ) : null}
          {calendarState === 'ready' ? comparable.map((event) => {
            const hit = largestMovementAround(samples, event.at, keys)
            return (
              <div className={css.eventRow} key={`${event.at}-${event.title}`} data-dshtrading-event={event.at}>
                <span className={css.eventTime}>{shortTime(event.at)}</span>
                <span className={css.eventTitle}>{event.title}</span>
                {hit === undefined ? (
                  <span className={css.eventPending}>{t('prediction.eventInsufficient')}</span>
                ) : (
                  <span className={css.eventDelta} data-dshtrading-event-delta={hit.key}>
                    {formatProbability(hit.movement.before)}
                    {' → '}
                    {formatProbability(hit.movement.after)}
                    {' '}
                    {formatDeltaPp(hit.movement.delta)}
                  </span>
                )}
              </div>
            )
          }) : null}
        </div>
        {fetchedAt !== '' ? <div className={css.fetchedAt}>{t('prediction.fetchedAt')} {shortTime(Date.parse(fetchedAt))}</div> : null}
      </div>
    </div>
  )
}

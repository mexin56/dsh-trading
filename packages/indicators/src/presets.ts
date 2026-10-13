/**
 * 预置指标（仿富途：主图 MA/EMA/BOLL，副图 MACD/RSI/KDJ；副图另有
 * 仅港股的「港股通持股比例」与仅 A 股的「主动买盘」两条外部序列指标）。
 * 全部是 definition 数据 + math.ts 纯函数的组合，无渲染逻辑；由指标插件
 * （client-ui-indicators）注册进 tradingIndicators 服务。
 */
import type { IndicatorDefinition, Kline } from './types.ts'
import { alignAuxToBars } from './aux.ts'
import { bollinger, ema, kdj, macd, rsi, sma } from './math.ts'

/** MA 线配色（富途系配色 + 扩展周期轮换调色板）。 */
export const MA_COLORS: Record<string, string> = {
  MA5: '#e6b800',
  MA10: '#4a90e2',
  MA20: '#c05fd8',
  MA30: '#2ba471',
  MA60: '#f97316',
  MA120: '#0ea5e9',
  MA250: '#8a8f99',
}

/** EMA 线配色。 */
export const EMA_COLORS: Record<string, string> = {
  EMA5: '#e6b800',
  EMA6: '#e6b800',
  EMA10: '#4a90e2',
  EMA12: '#ff9800',
  EMA20: '#c05fd8',
  EMA26: '#00bcd4',
  EMA30: '#2ba471',
  EMA50: '#2ba471',
  EMA60: '#f97316',
  EMA120: '#0ea5e9',
  EMA200: '#8a8f99',
  EMA250: '#8a8f99',
}

/** 均线 6 色备用调色板（富途黄/蓝/紫/绿/橙/青）。 */
const FALLBACK_PALETTE: readonly string[] = ['#e6b800', '#4a90e2', '#c05fd8', '#2ba471', '#f97316', '#0ea5e9']

function maColor(period: number, index: number): string {
  return MA_COLORS[`MA${period}`] ?? FALLBACK_PALETTE[index % FALLBACK_PALETTE.length] ?? '#8a8f99'
}

function emaColor(period: number, index: number): string {
  return EMA_COLORS[`EMA${period}`] ?? FALLBACK_PALETTE[index % FALLBACK_PALETTE.length] ?? '#8a8f99'
}

const closesOf = (bars: readonly Kline[]): number[] => bars.map(bar => bar.close)

/** 港股通持股比例副图消费的外部序列键（宿主按此键 prefetch 并按同名键注入）。 */
const HK_CONNECT_HOLDING_AUX_KEY = 'hk-connect-holding'

/** 主动买盘副图消费的外部序列键（与桥端点同名，宿主按此键 prefetch 并注入）。 */
const ACTIVE_BUY_AUX_KEY = 'cn-active-buy'

/** 一天的毫秒数（K 线交易日归一到 UTC 00:00 用）。 */
const MS_PER_DAY = 86_400_000

/**
 * K 线 → 交易日（UTC 00:00），供日频外部序列对齐。日线及更细周期取 openTime
 * 当日（本仓日频 openTime 即 UTC 00:00，与外部序列一字对齐）：这时不用 closeTime，
 * 它是当日 23:59:59.999，一旦 openTime 带盘中偏移（如 09:30）向下取整就会进位到
 * 次日、吃到未来一天的值。周 K/月 K 则取 closeTime 当日——周期末，从而对齐到区间内
 * 最新已知值，而不是周期起点的旧值。
 */
function klineTradingDay(bar: Kline): number {
  const closeTime = bar.closeTime
  const periodEnd = typeof closeTime === 'number' && Number.isFinite(closeTime) ? closeTime : bar.openTime
  const tradingDay = periodEnd - bar.openTime >= 2 * MS_PER_DAY ? periodEnd : bar.openTime
  return Math.floor(tradingDay / MS_PER_DAY) * MS_PER_DAY
}

/** 八个预置 definition（纯数据，注册时机归消费方）。 */
export function presetDefinitions(): IndicatorDefinition[] {
  return [
    {
      // MA：一组最多 6 条均线（周期可调，默认 5/10/20/30/60/120，0 表示隐藏）。
      id: 'ma',
      pane: 'main',
      title: 'MA',
      params: [
        { key: 'n1', label: '周期1', default: 5, min: 0, max: 250 },
        { key: 'n2', label: '周期2', default: 10, min: 0, max: 250 },
        { key: 'n3', label: '周期3', default: 20, min: 0, max: 250 },
        { key: 'n4', label: '周期4', default: 30, min: 0, max: 250 },
        { key: 'n5', label: '周期5', default: 60, min: 0, max: 250 },
        { key: 'n6', label: '周期6', default: 120, min: 0, max: 250 },
      ],
      compute(bars, params) {
        const closes = closesOf(bars)
        const periods = [params.n1, params.n2, params.n3, params.n4, params.n5, params.n6]
          .filter((period): period is number => typeof period === 'number' && Number.isFinite(period) && period > 0)
        return periods.map((period, index) => ({
          key: `MA${period}`,
          kind: 'line' as const,
          color: maColor(period, index),
          values: sma(closes, period),
        }))
      },
    },
    {
      // EMA：一组最多 6 条指数均线（周期可调，默认 5/10/20/30/60/120，0 表示隐藏）。
      id: 'ema',
      pane: 'main',
      title: 'EMA',
      params: [
        { key: 'n1', label: '周期1', default: 5, min: 0, max: 250 },
        { key: 'n2', label: '周期2', default: 10, min: 0, max: 250 },
        { key: 'n3', label: '周期3', default: 20, min: 0, max: 250 },
        { key: 'n4', label: '周期4', default: 30, min: 0, max: 250 },
        { key: 'n5', label: '周期5', default: 60, min: 0, max: 250 },
        { key: 'n6', label: '周期6', default: 120, min: 0, max: 250 },
      ],
      compute(bars, params) {
        const closes = closesOf(bars)
        const periods = [params.n1, params.n2, params.n3, params.n4, params.n5, params.n6]
          .filter((period): period is number => typeof period === 'number' && Number.isFinite(period) && period > 0)
        return periods.map((period, index) => ({
          key: `EMA${period}`,
          kind: 'line' as const,
          color: emaColor(period, index),
          values: ema(closes, period),
        }))
      },
    },
    {
      // BOLL：中轨 + 上下轨（20, ×2）。
      id: 'boll',
      pane: 'main',
      title: 'BOLL',
      params: [
        { key: 'n', label: '周期', default: 20, min: 2, max: 250 },
        { key: 'k', label: '倍数', default: 2, min: 1, max: 5 },
      ],
      compute(bars, params) {
        const { mid, upper, lower } = bollinger(closesOf(bars), params.n, params.k)
        return [
          { key: 'MID', kind: 'line', color: '#8a8f99', values: mid },
          { key: 'UP', kind: 'line', color: '#4a90e2', values: upper },
          { key: 'LOW', kind: 'line', color: '#4a90e2', values: lower },
        ]
      },
    },
    {
      // MACD：DIF/DEA 线 + 按符号红涨绿跌的柱（12,26,9）。
      id: 'macd',
      pane: 'sub',
      title: 'MACD',
      params: [
        { key: 'fast', label: '快线', default: 12, min: 2, max: 100 },
        { key: 'slow', label: '慢线', default: 26, min: 2, max: 200 },
        { key: 'signal', label: '信号', default: 9, min: 1, max: 60 },
      ],
      compute(bars, params) {
        const { dif, dea, hist } = macd(closesOf(bars), params.fast, params.slow, params.signal)
        return [
          { key: 'DIF', kind: 'line', color: '#e6b800', values: dif },
          { key: 'DEA', kind: 'line', color: '#4a90e2', values: dea },
          { key: 'HIST', kind: 'histogram', color: '#8a8f99', values: hist, histogramBySign: true },
        ]
      },
    },
    {
      // RSI（Wilder 平滑，14）。
      id: 'rsi',
      pane: 'sub',
      title: 'RSI',
      params: [{ key: 'n', label: '周期', default: 14, min: 2, max: 120 }],
      compute(bars, params) {
        return [{ key: `RSI${params.n}`, kind: 'line', color: '#c05fd8', values: rsi(closesOf(bars), params.n) }]
      },
    },
    {
      // KDJ（RSV 的 1/3 平滑，9）。
      id: 'kdj',
      pane: 'sub',
      title: 'KDJ',
      params: [{ key: 'n', label: '周期', default: 9, min: 1, max: 120 }],
      compute(bars, params) {
        const highs = bars.map(bar => bar.high)
        const lows = bars.map(bar => bar.low)
        const { k, d, j } = kdj(highs, lows, closesOf(bars), params.n)
        return [
          { key: 'K', kind: 'line', color: '#e6b800', values: k },
          { key: 'D', kind: 'line', color: '#4a90e2', values: d },
          { key: 'J', kind: 'line', color: '#c05fd8', values: j },
        ]
      },
    },
    {
      // 港股通持股比例（副图，仅港股；决策 7：日线及以上才适用，级别过滤归实例侧）：
      // 数据来自宿主预取的日频外部序列（aux 声明的键），无参数，单条 line。
      id: 'hk-connect-holding',
      pane: 'sub',
      title: '港股通持股比例',
      params: [],
      markets: ['hk'],
      // 决策 7 的默认适用范围只在这里声明一次：数据是日频序列，分钟级上会被前向
      // 填充成一整段平移直线，故新实例默认只勾 1d/1w/1M（GUI 挂载、indicator_activate
      // 与桥 PUT 三条创建路径共用本声明）。
      defaultApplyScope: { hk: { enabled: true, intervals: ['1d', '1w', '1M'] } },
      aux: [HK_CONNECT_HOLDING_AUX_KEY],
      compute() {
        // 声明了 aux 的指标由宿主走 computeAux（契约 §3 二选一）：旧宿主若误调
        // compute，返回空输出即「什么都不画」，绝不降级为一条贴底的零线。
        return []
      },
      computeAux(bars, _params, aux) {
        const points = aux[HK_CONNECT_HOLDING_AUX_KEY]
        // 无数据（未取到 / 标的不在港股通范围）→ 空输出：消费方据此隐藏该副图
        // pane（决策 3），空 ≠ 0。
        if (points === undefined || points.length === 0) return []
        const aligned = alignAuxToBars(bars, points, klineTradingDay)
        return [{
          key: 'HK_CONNECT_HOLDING',
          kind: 'line',
          color: '#7c5cff',
          // 非有限值（脏数据）按 warm-up 处理：曲线断开，不把 NaN 交给渲染层。
          values: aligned.map(value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)),
          precision: 2,
        }]
      },
    },
    {
      // 主动买盘（副图，仅 A 股）：数据来自宿主预取的日频外部序列（aux 声明的键），
      // 序列值语义 = 净主动买占当日总量百分比；无参数，两条输出（净买柱 + 买占线）。
      id: 'active-buy',
      pane: 'sub',
      title: '主动买盘',
      params: [],
      markets: ['cn'],
      description: '数据源：本地累积的腾讯盘口快照推断的内外盘（非交易所官方逐笔方向，涨跌停/对倒日失真）。'
        + '红柱为净主动买占当日总量百分比，蓝线为主动买占比 ((100 + 净买占比) / 2)。'
        + '当日柱为盘中累计到最新取数时刻，收盘后收敛为当日终值。',
      // 与港股通持股比例同款（决策 7）：数据是日频序列，分钟级上会被前向填充成一整段
      // 平移直线，故新实例默认只勾 1d/1w/1M（GUI 挂载、indicator_activate 与桥 PUT
      // 三条创建路径共用本声明）。
      defaultApplyScope: { cn: { enabled: true, intervals: ['1d', '1w', '1M'] } },
      aux: [ACTIVE_BUY_AUX_KEY],
      compute() {
        // 声明了 aux 的指标由宿主走 computeAux（契约 §3 二选一）：旧宿主若误调
        // compute，返回空输出即「什么都不画」，绝不降级为一条贴底的零线。
        return []
      },
      computeAux(bars, _params, aux) {
        const points = aux[ACTIVE_BUY_AUX_KEY]
        // 无数据（未取到 / 该标的无盘口推断记录）→ 空输出：消费方据此隐藏整个副图
        // pane（决策 3），空 ≠ 0。
        if (points === undefined || points.length === 0) return []
        const aligned = alignAuxToBars(bars, points, klineTradingDay)
        // 非有限值（脏数据）按 warm-up 处理：曲线断开，不把 NaN 交给渲染层。
        const net = aligned.map(value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined))
        return [
          {
            key: '净买',
            kind: 'histogram',
            histogramBySign: true,
            color: '#e64545',
            values: net,
            precision: 2,
          },
          {
            key: '买占',
            kind: 'line',
            color: '#3b82f6',
            // 口径恒等式：买占 = (100 + 净买占比) / 2。前提是「外盘 + 内盘 ≈ 当日总量」：
            // 总量 −（外盘+内盘）之差是**未归向成交**（集合竞价与价间成交计入总量却不计入
            // 内外盘），量级不固定——本数据集 5 标的实测最大 0.071%（517520 2026-09-18），
            // 单条报价行盘中可达 0.63%（600519 2026-10-13 10:09 实测）。故本式是**派生值**，
            // 与源记录里的 buySharePct 相差「残差 / 2」（本数据集 ≤0.036 个百分点）。只取一条
            // aux 序列（净买）而不注入两条，是有意的取舍：偏差比读图分辨率低一个量级。
            values: net.map(value => (value === undefined ? undefined : (100 + value) / 2)),
            precision: 2,
          },
        ]
      },
    },
  ]
}


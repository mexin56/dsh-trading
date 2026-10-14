/**
 * 公共：统计、目录、标的清单、节奏控制。
 *
 * 采样口径（Lead 2026-10-15 裁决 Option B，每源 ≤200 次上游请求）：
 *   时延 keep-alive 4 路径 × 20 = 80（其中「单标的报价」那 20 次与并发 c=1 轮**是同一批样本**）
 *   时延冷启动 2 代表路径 × 20      = 40
 *   并发 c=4/8/16 × 16             = 48（c=1 复用上面那 20 次）
 *   品种覆盖                        ≈ 9
 *   分钟 K 上限裸探针                = 6
 *   批量对单次对比 8 + 批量加长 4    = 12
 *   合计                           ≈ 195
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SPIKE_DIR = import.meta.dirname
export const RAW_DIR = join(SPIKE_DIR, 'raw')
export const OUT_DIR = join(SPIKE_DIR, 'out')

mkdirSync(RAW_DIR, { recursive: true })
mkdirSync(OUT_DIR, { recursive: true })

export interface Summary {
  readonly n: number
  readonly min: number
  readonly p50: number
  readonly p95: number
  readonly max: number
  readonly mean: number
}

/** 最近秩（nearest-rank）分位，输入为原始毫秒样本。 */
export function summarize(values: readonly number[]): Summary | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] as number
  return {
    n: sorted.length,
    min: sorted[0] as number,
    p50: at(50),
    p95: at(95),
    max: sorted[sorted.length - 1] as number,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  }
}

export function round(value: number | null | undefined, digits = 1): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const f = 10 ** digits
  return Math.round(value * f) / f
}

export function summarizeRound(values: readonly number[]): Summary | null {
  const s = summarize(values)
  if (s === null) return null
  return { n: s.n, min: round(s.min), p50: round(s.p50), p95: round(s.p95), max: round(s.max), mean: round(s.mean) }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function writeRaw(name: string, body: Buffer | string): string {
  const path = join(RAW_DIR, name)
  writeFileSync(path, body)
  return path
}

export function writeOut(name: string, value: unknown): string {
  const path = join(OUT_DIR, name)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  return path
}

/** 单标的报价路径的采样标的。 */
export const P1_SYMBOL = '600519.SH'

/** 批量报价 8 只（全真实 cn 标的，跨沪深主板/创业板/科创板）。 */
export const BATCH_8: readonly string[] = [
  '600519.SH', '000001.SZ', '300750.SZ', '688981.SH',
  '601318.SH', '000858.SZ', '600036.SH', '002594.SZ',
]

/** 批量加长用：600000..600099 共 100 只沪市主板。 */
export const BATCH_100: readonly string[] = Array.from({ length: 100 }, (_, i) => `${600000 + i}.SH`)

/** 品种覆盖抽样。 */
export const COVERAGE_CN: readonly string[] = [
  '600519.SH', // 沪市主板 贵州茅台
  '000001.SZ', // 深市主板 平安银行
  '300750.SZ', // 创业板 宁德时代
  '688981.SH', // 科创板 中芯国际
  '159869.SZ', // 深市 ETF 游戏ETF华夏
  '000001.SH', // 上证指数
  '000300.SH', // 沪深300
  '835185.BJ', // 北交所 贝特瑞
]
export const COVERAGE_HK = '00700.HK'

/** 请求节奏：相邻上游请求之间。 */
export const PACING_MS = 120
/** 并发轮次之间。 */
export const ROUND_GAP_MS = 3000

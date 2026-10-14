/**
 * 从 out/*.json 生成 EVIDENCE.md 里引用的表格（数字与 JSON 同源，避免手抄误差）。
 *
 * 复现：./node_modules/.bin/tsx spikes/impl-cn-datasource-bench/report.mts
 * 输出：out/TABLES.md（stdout 同时打印）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { OUT_DIR, round } from './common.mts'

const lines: string[] = []
const say = (s = ''): void => { lines.push(s) }

function read<T>(name: string): T | null {
  try { return JSON.parse(readFileSync(join(OUT_DIR, name), 'utf8')) as T } catch { return null }
}

function num(v: unknown): string {
  const n = typeof v === 'number' ? v : null
  return n === null ? '—' : String(round(n))
}

function stat(s: any): string {
  if (s === null || s === undefined) return '—'
  return `${num(s.p50)} / ${num(s.p95)} / ${num(s.min)} / ${num(s.max)}`
}

interface LatencyGroup {
  source: string; pathId: string; label: string; mode: string
  summary: any; rawFile: string | null; rawBytes: number; rawSha256: string | null
  firstSampleMs: number | null; steadyState: any
  sampleDetail: Array<{ ok: boolean; wallMs: number; status: number; error: string | null }>
}
interface ConcurrencyRound { source: string; concurrency: number; requests: number; summary: any; statusDist: Record<string, number>; wallMsTotal: number }
interface CoverageRow {
  source: string; market: string; input: string; requestsMade: number; status: number
  verdict: string; detail: string; rawLine: string | null; bytes: number; transportError: string | null
}
interface BoundRow {
  source: string; requested: string; status: number; rows: number | null; days: number | null
  firstBar: string | null; lastBar: string | null; upstreamCode: unknown; msg: unknown; bytes: number
}
interface BatchRow { source: string; kind: string; n: number; requests: number; wallMs: number; rowsReturned: number; bytes: number; status: number; detail: string }

const latency = read<{ groups: LatencyGroup[] }>('latency.json')
if (latency) {
  for (const mode of ['keep-alive', 'cold']) {
    say(`### 时延 · ${mode === 'keep-alive' ? '连接复用（keep-alive Agent）' : '冷启动（agent:false，每次新建连接）'}`)
    say()
    say('| 源 | 路径 | 有效/样本 | 失败 | wall p50/p95/min/max (ms) | 传输 p50/p95/min/max (ms) | DNS p50 | TCP p50 | TLS p50 | 连接 p50 | 服务端 p50 | 响应体 B | 复用次数 |')
    say('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for (const g of latency.groups.filter((x) => x.mode === mode)) {
      const s = g.summary
      say(`| ${g.source} | ${g.pathId} ${g.label} | ${s.ok}/${s.samples} | ${s.failed} | ${stat(s.wallMs)} | ${stat(s.httpMs)} | ${num(s.dnsMs?.p50)} | ${num(s.tcpMs?.p50)} | ${num(s.tlsMs?.p50)} | ${num(s.connMs?.p50)} | ${num(s.serverMs?.p50)} | ${num(s.bytes?.p50)} | ${s.reusedConnections} |`)
    }
    say()
    if (mode === 'keep-alive') {
      say('keep-alive 组首个样本即建立连接的那次（此后同连接复用）；下面是「去掉首个样本」的稳态视图：')
      say()
      say('| 源 | 路径 | 首样本 (ms) | 稳态 n | wall p50/p95/min/max (ms) |')
      say('|---|---|---|---|---|')
      for (const g of latency.groups.filter((x) => x.mode === 'keep-alive')) {
        say(`| ${g.source} | ${g.pathId} ${g.label} | ${num(g.firstSampleMs)} | ${g.steadyState?.n ?? '—'} | ${stat(g.steadyState)} |`)
      }
      say()
    }
  }
}

const concurrency = read<{ rounds: ConcurrencyRound[] }>('concurrency.json')
if (concurrency) {
  say('### 并发（同一路径：单标的报价 600519.SH）')
  say()
  say('| 源 | 在飞并发 | 请求数 | 成功 | 失败 | HTTP 状态分布 | 轮次墙钟 (ms) | wall p50/p95/min/max (ms) | 服务端 p50 (ms) | 连接 p50 (ms) |')
  say('|---|---|---|---|---|---|---|---|---|---|')
  for (const r of concurrency.rounds) {
    const s = r.summary
    say(`| ${r.source} | ${r.concurrency} | ${r.requests} | ${s.ok} | ${s.failed} | ${JSON.stringify(r.statusDist)} | ${num(r.wallMsTotal)} | ${stat(s.wallMs)} | ${num(s.serverMs?.p50)} | ${num(s.connMs?.p50)} |`)
  }
  say()
}

const coverage = read<{ rows: CoverageRow[] }>('coverage.json')
if (coverage) {
  say('### 品种覆盖（第 1 轮）')
  say()
  say('| 源 | 市场 | 输入 | 上游请求 | HTTP | 结论 | 解析结果 / 错误 |')
  say('|---|---|---|---|---|---|---|')
  for (const r of coverage.rows) {
    say(`| ${r.source} | ${r.market} | ${r.input} | ${r.requestsMade} | ${r.status} | ${r.verdict} | ${r.detail.replace(/\|/g, '\\|').slice(0, 150)} |`)
  }
  say()
}

const reprobe = read<{ rows: CoverageRow[]; note: string }>('reprobe.json')
if (reprobe) {
  say(`### 东财 push2 受限后收尾复测（${reprobe.note}）`)
  say()
  say('| 市场 | 输入 | 上游请求 | HTTP | 结论 | 解析结果 / 错误 |')
  say('|---|---|---|---|---|---|')
  for (const r of reprobe.rows) {
    say(`| ${r.market} | ${r.input} | ${r.requestsMade} | ${r.status} | ${r.verdict} | ${r.detail.replace(/\|/g, '\\|').slice(0, 150)} |`)
  }
  say()
}

const bounds = read<{ rows: BoundRow[] }>('bounds.json')
const bounds5m = read<{ rows: BoundRow[] }>('bounds5m.json')
if (bounds || bounds5m) {
  say('### 分钟 K 真实上限（裸 URL 探针，绕过实现里的 min(limit, 800) 夹取）')
  say()
  say('| 源 | 请求 | HTTP | 返回根数 | 覆盖交易日 | 首根 | 末根 | 上游 code | msg | 响应体 B | 备注 |')
  say('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of [...(bounds?.rows ?? []), ...(bounds5m?.rows ?? [])]) {
    say(`| ${r.source} | ${r.requested} | ${r.status} | ${r.rows ?? '—'} | ${r.days ?? '—'} | ${r.firstBar ?? '—'} | ${r.lastBar ?? '—'} | ${JSON.stringify(r.upstreamCode)} | ${JSON.stringify(r.msg)} | ${r.bytes} | ${(r as any).note ?? ''} |`)
  }
  say()
}

const batch = read<{ rows: BatchRow[] }>('batch.json')
if (batch) {
  say('### 一次请求 N 只 vs N 次单请求')
  say()
  say('| 源 | 形态 | N | 上游请求数 | 墙钟 (ms) | 返回行数 | 响应体 B | HTTP | 备注 |')
  say('|---|---|---|---|---|---|---|---|---|')
  for (const r of batch.rows) {
    say(`| ${r.source} | ${r.kind === 'batch' ? '一次请求 N 只' : 'N 次单请求'} | ${r.n} | ${r.requests} | ${num(r.wallMs)} | ${r.rowsReturned} | ${r.bytes} | ${r.status} | ${r.detail.replace(/\|/g, '\\|').slice(0, 90)} |`)
  }
  say()
}

writeFileSync(join(OUT_DIR, 'TABLES.md'), `${lines.join('\n')}\n`)
console.log(lines.join('\n'))

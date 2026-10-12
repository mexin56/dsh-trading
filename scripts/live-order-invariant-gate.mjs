#!/usr/bin/env node
/**
 * 实盘下单不变量门禁（live-order-invariant-gate）——跨包交易安全契约检查点。
 *
 * 为什么需要它：2026-10-12 的订单意图台账修复给每个**能真实下单**的连接器加了
 * `intentId` 与幂等台账，但「哪个连接器真的会把订单发到交易所」是随 bundle 行
 * 与实现共同演化的事实。若将来把一个未接台账的连接器接上真实下单路径，
 * GUI/agent 就能在没有去重键的情况下重复下单——这正是本次要消灭的形态，
 * 而此前没有任何机械检查。
 *
 * 判据（对象 = 已挂载的 `*_place_order`）：
 *   L1 已挂载且**具备真实下单路径**的连接器，其下单工具必须声明 `intentId`。
 *   L2 已挂载的下单工具必须声明 `dryRun`（默认模拟的显式出口）。
 *
 * 「具备真实下单路径」如何判定（不靠愿望，靠源码事实）：连接器源文件里存在
 * 真实下单调用（`client.placeOrder` / `deps.trade.placeOrder` 形态），且**不是**
 * 只返回 `TRADING_NOT_IMPLEMENTED` 的桩。仅数据面挂载、或实盘分支明确未实现的
 * 连接器不算——它们发不出订单，没有重复下单面。
 *
 * 用法：
 *   node scripts/live-order-invariant-gate.mjs            # 门禁：违规 → exit 1
 *   node scripts/live-order-invariant-gate.mjs --report   # 只打印现状表
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanToolSurface } from './tool-surface-inventory.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NL = String.fromCharCode(10)
const args = process.argv.slice(2)

/** 实盘下单工具名（撤单不需幂等键：连接器层已把重复撤单幂等化）。 */
export const LIVE_PLACE_PATTERN = /_place_order$/

/** 挂载平面：host/preset 可达；island 无人安装。 */
export function isMounted(plane) {
  return plane === 'host' || plane === 'preset'
}

/**
 * 源码是否含**真实下单**路径。
 * 判据是「调用了下游下单 API」，而不是「函数名叫 placeOrder」——后者会把桩也算进来。
 * 明确只返回 TRADING_NOT_IMPLEMENTED 的实现不算真实下单。
 */
export function hasRealOrderPath(source) {
  const callsDownstream = /(?:client|deps\.trade|trade)\s*\.\s*placeOrder\s*\(/.test(source)
  if (!callsDownstream) return false
  // 允许「有真实调用但同时有未实现分支」；只要存在真实调用即算。
  return true
}

/** 从盘点和源码读出每个已挂载下单工具的违规项。 */
export function liveOrderViolations(model, readSource = (rel) => readFileSync(join(ROOT, rel), 'utf8')) {
  const problems = []
  const planeByFile = new Map(model.injectionPoints.map((point) => [point.file, point.plane]))
  for (const tool of model.tools) {
    if (!LIVE_PLACE_PATTERN.test(tool.name)) continue
    if (!isMounted(planeByFile.get(tool.file))) continue
    const params = tool.params.map((param) => param.name)
    if (!params.includes('dryRun')) {
      problems.push('L2 已挂载的下单工具缺少 dryRun（没有显式模拟出口）：'
        + tool.package + '#' + tool.name + '（' + tool.file + '）')
    }
    let source = ''
    try { source = readSource(tool.file) } catch { /* 读不到源码时按下一条判据保守处理 */ }
    if (!hasRealOrderPath(source)) continue
    if (!params.includes('intentId')) {
      problems.push('L1 已挂载且具备真实下单路径的工具缺少 intentId（无幂等键，重复请求可能重复下单）：'
        + tool.package + '#' + tool.name + '（' + tool.file + '）')
    }
  }
  return problems
}

function main() {
  const unknown = args.filter((arg) => arg.startsWith('--') && arg !== '--report')
  if (unknown.length > 0) { process.stderr.write('[live-order] ✗ 未知参数：' + unknown.join('、') + NL); return 2 }
  const model = scanToolSurface(ROOT)
  const problems = liveOrderViolations(model)
  const checked = model.tools.filter((tool) => LIVE_PLACE_PATTERN.test(tool.name)).length
  process.stdout.write('[live-order] 检查 ' + String(checked) + ' 个下单工具：已挂载且具真实下单路径者必须带 intentId，所有已挂载者必须带 dryRun' + NL)
  if (args.includes('--report')) {
    for (const problem of problems) process.stdout.write('    · ' + problem + NL)
    return 0
  }
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write('[live-order] ✗ ' + problem + NL)
    process.stderr.write('[live-order] ✗ ' + String(problems.length) + ' 处实盘下单不变量被破坏' + NL)
    return 1
  }
  process.stdout.write('[live-order] ✓ 实盘下单不变量成立' + NL)
  return 0
}

import { realpathSync } from 'node:fs'
const invokedDirectly = process.argv[1] !== undefined
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (invokedDirectly) process.exit(main())

#!/usr/bin/env node
/**
 * 工具契约门禁（tool-contract-gate）——模型可见工具面的漂移检查点。
 *
 * 为什么需要它：工具名、必填参数与输出形状是**对模型的公共契约**。行 id 有
 * patch-id 门禁、HTTP 面有类型检查，唯独工具面此前只靠 tool-surface-inventory
 * 打印报告（无断言、无基线），改名/改必填/改输出形状可以静默进入发布，破坏
 * 既有提示词与已写好的调用。本门禁把现状固化成冻结清单，只在**显式更新**时接纳变化。
 *
 * 判据（每条都对应一种真实破坏）：
 *   T1 冻结面     —— 冻结清单里存在、当前缺失的工具（改名或删除）报红。
 *   T2 必填面     —— 同名工具的必填参数集合变化报红（模型据必填决定调用形状）。
 *   T3 参数类型   —— 同名同参的 type/enum 变化报红。
 *   T4 输出形状   —— output.form 变化报红。
 *   T5 未登记新增 —— 当前存在、清单里没有的工具报红（新增必须显式登记）。
 *
 * 动态名（如 `${market}_get_ticket`）按原样登记，不去猜展开后的市场名。
 *
 * 用法：
 *   node scripts/tool-contract-gate.mjs             # 门禁：违规 → exit 1
 *   node scripts/tool-contract-gate.mjs --report    # 只打印差异，不判红
 *   node scripts/tool-contract-gate.mjs --update    # 显式重写冻结清单
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanToolSurface } from './tool-surface-inventory.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FREEZE_FILE = join(ROOT, 'scripts', 'tool-contract-freeze.json')
const args = process.argv.slice(2)
const NL = String.fromCharCode(10)

/** 当前工具面 → 冻结形状。键为包名 + 工具名，避免不同包的动态名互相覆盖。 */
export function contractOf(model) {
  const out = {}
  for (const tool of model.tools) {
    const key = tool.package + '#' + tool.name
    out[key] = {
      file: tool.file,
      params: tool.params.map((param) => ({
        name: param.name,
        type: param.type,
        required: param.required,
        ...(param.enum ? { enum: true } : {}),
      })),
      outputForm: tool.output.form,
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** 比较冻结形状与当前形状，返回人类可读差异（空数组 = 无漂移）。 */
export function diffContract(frozen, current) {
  const problems = []
  for (const key of Object.keys(frozen)) {
    if (current[key] === undefined) { problems.push('T1 已登记的工具消失或改名：' + key); continue }
    const before = frozen[key]
    const after = current[key]
    const beforeRequired = before.params.filter((p) => p.required).map((p) => p.name).sort().join(',')
    const afterRequired = after.params.filter((p) => p.required).map((p) => p.name).sort().join(',')
    if (beforeRequired !== afterRequired) problems.push('T2 必填参数变化：' + key + '（' + beforeRequired + ' → ' + afterRequired + '）')
    for (const param of before.params) {
      const now = after.params.find((p) => p.name === param.name)
      if (now === undefined) { problems.push('T3 参数被移除：' + key + ' / ' + param.name); continue }
      if (now.type !== param.type) problems.push('T3 参数类型变化：' + key + ' / ' + param.name + '（' + param.type + ' → ' + now.type + '）')
      if (Boolean(now.enum) !== Boolean(param.enum)) problems.push('T3 参数枚举性变化：' + key + ' / ' + param.name)
    }
    if (before.outputForm !== after.outputForm) problems.push('T4 输出形状变化：' + key + '（' + String(before.outputForm) + ' → ' + String(after.outputForm) + '）')
  }
  for (const key of Object.keys(current)) {
    if (frozen[key] === undefined) problems.push('T5 出现未登记的工具：' + key)
  }
  return problems
}

function main() {
  const unknown = args.filter((arg) => arg.startsWith('--') && !['--report', '--update'].includes(arg))
  if (unknown.length > 0) { process.stderr.write('[tool-contract] ✗ 未知参数：' + unknown.join('、') + NL); return 2 }
  const current = contractOf(scanToolSurface(ROOT))
  const count = Object.keys(current).length
  if (args.includes('--update')) {
    writeFileSync(FREEZE_FILE, JSON.stringify(current, null, 2) + NL)
    process.stdout.write('[tool-contract] ✓ 已重写冻结清单：' + String(count) + ' 个工具 → ' + FREEZE_FILE.replace(ROOT, '') + NL)
    return 0
  }
  if (!existsSync(FREEZE_FILE)) {
    process.stderr.write('[tool-contract] ✗ 冻结清单不存在（首次运行请执行 --update 并在评审中确认变化）' + NL)
    return 1
  }
  const frozen = JSON.parse(readFileSync(FREEZE_FILE, 'utf8'))
  const problems = diffContract(frozen, current)
  const frozenCount = Object.keys(frozen).length
  process.stdout.write('[tool-contract] 冻结 ' + String(frozenCount) + ' 个工具、当前 ' + String(count) + ' 个' + NL)
  if (args.includes('--report')) {
    for (const problem of problems) process.stdout.write('    · ' + problem + NL)
    return 0
  }
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write('[tool-contract] ✗ ' + problem + NL)
    process.stderr.write('[tool-contract] ✗ ' + String(problems.length) + ' 处工具契约漂移（如为有意变更，请评审后执行 --update）' + NL)
    return 1
  }
  process.stdout.write('[tool-contract] ✓ 工具名、必填参数、参数类型与输出形状均未漂移' + NL)
  return 0
}

// 仅在作为入口执行时退出；被测试 import 时不得终止宿主进程。
import { realpathSync } from 'node:fs'
const invokedDirectly = process.argv[1] !== undefined
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (invokedDirectly) process.exit(main())


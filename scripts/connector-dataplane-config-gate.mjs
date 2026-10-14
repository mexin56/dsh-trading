#!/usr/bin/env node
/**
 * dataplane 入口 Config schema 结构门禁（pnpm connector-dataplane:check）。
 *
 * 为什么需要它：宿主 loader 只认**被加载的那个模块**自己导出的 Config 给 patch 行补
 * schema 默认值（cordis resolveConfig：模块无 Config → 行 config 原样传入，schema 默认
 * 值全丢）。2026-10-14 的存量缺陷就是这么来的——17 个连接器的数据面入口只
 * `import type { Config }`，行 config 少了默认值，其中 qmt/alpaca 两个下单面整行加载失败
 * （见 .agents/notes/implemented/bug-fix/2026-10-14-qmt-alpaca-dataplane-config-schema.md）。
 * 这类缺口静态可见、运行时只在启动日志里变成一句「N entries did not activate」，
 * 因此必须由门禁挡在提交前，而不是等宿主日志。
 *
 * 规则：
 *   R1 入口导出 —— packages/connector-<slug>/src/<sub>dataplane.ts 每个数据面入口必须重导出主行的
 *                 Config schema（`export { Config }` 或 `export { Config } from './…'`）；
 *                 默认值只有一个家（主行 schema），入口不再自带第二份缺省值对象。
 *   R2 行可达   —— patch 层里引用的每个 dataplane 子路径模块，其源码入口必须存在且满足 R1
 *                 （行引用了不存在的入口 = 死行；新连接器漏导出 = 复制旧债）。
 *
 * 范围：仓库内的 patch 层（packages/<pkg>/cordis.patch.yml + desktop 的 profile 种子；
 * desktop/dist 是构建产物副本，不进范围）。用户 home 里的 profile 层不参与——门禁结论
 * 必须与机器无关。
 *
 * 用法：
 *   node scripts/connector-dataplane-config-gate.mjs            # 门禁：违规 → exit 1
 *   node scripts/connector-dataplane-config-gate.mjs --report    # 只打印现状表，不判红
 *   node scripts/connector-dataplane-config-gate.mjs --root=DIR  # 指定仓库根（自测用）
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 入口必须命中一次：重导出主行的 Config schema（不带 from 或带 from 都算）。 */
const CONFIG_EXPORT_RE = /^export\s*\{[^}]*\bConfig\b[^}]*\}/m
/** 数据面入口文件名：dataplane.ts / futures-dataplane.ts / <sub>-dataplane.ts。 */
const ENTRY_FILE_RE = /dataplane\.ts$/
/** patch 行 name 里指向本仓包的形式：@dshtrading/<pkg>/<subpath>。 */
const PACKAGE_NAME_RE = /^@dshtrading\/([^/]+)\/(.+)$/

/** 数据面入口清单（packages/connector-*\/src/*dataplane.ts → 仓库相对路径）。 */
export function discoverEntries(root = ROOT) {
  const packagesDir = join(root, 'packages')
  if (!existsSync(packagesDir)) return []
  const entries = []
  for (const pkg of readdirSync(packagesDir).filter((name) => name.startsWith('connector-')).sort()) {
    const srcDir = join(packagesDir, pkg, 'src')
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) continue
    for (const file of readdirSync(srcDir).filter((name) => ENTRY_FILE_RE.test(name)).sort()) {
      const abs = join(srcDir, file)
      entries.push({ file: abs, rel: relative(root, abs).split(sep).join('/'), text: readFileSync(abs, 'utf8') })
    }
  }
  return entries
}

/** R1：单个入口文本的违规说明（合规返回 null）。 */
export function entryProblem(rel, text) {
  if (CONFIG_EXPORT_RE.test(text)) return null
  return `${rel}: 未重导出主行的 Config schema（缺 \`export { Config }\`）——loader 拿不到 schema，行 config 的默认值全部丢失`
}

/** patch 层文件清单（仓库内，含 desktop profile 种子；dist 是构建产物副本，排除）。 */
export function discoverPatchFiles(root = ROOT) {
  const files = []
  const packagesDir = join(root, 'packages')
  if (existsSync(packagesDir)) {
    for (const pkg of readdirSync(packagesDir).sort()) {
      const file = join(packagesDir, pkg, 'cordis.patch.yml')
      if (existsSync(file)) files.push(file)
    }
  }
  const desktopDir = join(root, 'desktop')
  if (existsSync(desktopDir)) {
    for (const entry of readdirSync(desktopDir).sort()) {
      if (entry === 'dist') continue
      const file = join(desktopDir, entry, 'runtime', 'profile-trading', 'cordis.patch.yml')
      if (existsSync(file)) files.push(file)
      const profileDir = join(desktopDir, entry)
      if (!statSync(profileDir).isDirectory()) continue
      for (const sub of readdirSync(profileDir).sort()) {
        const nested = join(profileDir, sub, 'cordis.patch.yml')
        if (existsSync(nested)) files.push(nested)
      }
    }
  }
  return files
}

/** 深度遍历 YAML 树，收集形如 { id, name: '@dshtrading/<pkg>/<sub>' } 的行。 */
function collectRows(node, out) {
  if (Array.isArray(node)) {
    for (const child of node) collectRows(child, out)
    return
  }
  if (node === null || typeof node !== 'object') return
  const name = typeof node.name === 'string' ? node.name : undefined
  if (name !== undefined && PACKAGE_NAME_RE.test(name)) {
    out.push({ id: typeof node.id === 'string' ? node.id : '(no-id)', name })
  }
  for (const value of Object.values(node)) collectRows(value, out)
}

/** 解析出的 patch 行里，指向本仓 dataplane 子路径入口的那些。 */
export function dataplaneReferences(root = ROOT) {
  const refs = []
  for (const file of discoverPatchFiles(root)) {
    const layer = relative(root, file).split(sep).join('/')
    let doc
    try {
      // patch 层里有 cordis 的 `!!js` 表达式标签：与本门禁无关，静默掉解析告警。
      doc = parse(readFileSync(file, 'utf8'), { logLevel: 'silent' })
    } catch (error) {
      refs.push({ layer, id: '(parse-error)', name: '(parse-error)', detail: `${layer}: YAML 解析失败：${error.message}` })
      continue
    }
    const rows = []
    collectRows(doc, rows)
    for (const row of rows) {
      const sub = PACKAGE_NAME_RE.exec(row.name)[2]
      if (!ENTRY_FILE_RE.test(`${sub}.ts`)) continue
      refs.push({ layer, id: row.id, name: row.name, sub })
    }
  }
  return refs
}

/** 包名 + 子路径 → 源码入口绝对路径（存在则返回，否则 null）。 */
export function sourceFileFor(name, root = ROOT) {
  const match = PACKAGE_NAME_RE.exec(name)
  if (match === null) return null
  for (const ext of ['ts', 'js']) {
    const candidate = join(root, 'packages', match[1], 'src', `${match[2]}.${ext}`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** R2：单个 patch 引用行的违规说明（合规返回 null）。 */
export function referenceProblem(reference, root = ROOT) {
  if (reference.detail !== undefined) return reference.detail
  const file = sourceFileFor(reference.name, root)
  if (file === null) {
    return `${reference.layer} 行 ${reference.id}（${reference.name}）：源码入口不存在（死行）`
  }
  const rel = relative(root, file).split(sep).join('/')
  return entryProblem(rel, readFileSync(file, 'utf8'))
}

/** 全量检查：返回 { entries, references, problems }。 */
export function check(root = ROOT) {
  const entries = discoverEntries(root)
  const references = dataplaneReferences(root)
  const problems = []
  for (const entry of entries) {
    const problem = entryProblem(entry.rel, entry.text)
    if (problem !== null) problems.push(problem)
  }
  for (const reference of references) {
    const problem = referenceProblem(reference, root)
    if (problem !== null) problems.push(problem)
  }
  return { entries, references, problems: [...new Set(problems)].sort() }
}

function main(argv) {
  const reportOnly = argv.includes('--report')
  const rootArg = argv.find((arg) => arg.startsWith('--root='))
  const root = rootArg === undefined ? ROOT : rootArg.slice('--root='.length)
  const { entries, references, problems } = check(root)

  if (reportOnly) {
    console.log(`[connector-dataplane] 数据面入口 ${entries.length} 个，patch 引用行 ${references.length} 条`)
    for (const entry of entries) {
      console.log(`  ${entryProblem(entry.rel, entry.text) === null ? '✓' : '✗'} ${entry.rel}`)
    }
    for (const reference of references) {
      const problem = referenceProblem(reference, root)
      console.log(`  ${problem === null ? '✓' : '✗'} ${reference.layer} ${reference.id} → ${reference.name}`)
    }
    return 0
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`[connector-dataplane] ✗ ${problem}`)
    console.error(`[connector-dataplane] ✗ ${problems.length} 条违规（数据面入口 ${entries.length} 个 / patch 引用行 ${references.length} 条）`)
    console.error('[connector-dataplane] 修法：入口 `export { Config }` 重导出主行 schema，见 docs/guides/connector-playbook.md §4.2')
    return 1
  }
  console.log(`[connector-dataplane] ✓ ${entries.length} 个数据面入口都导出 Config schema；patch 引用的 ${references.length} 条数据面行都可达`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    console.error('[connector-dataplane] 基础设施级失败（不是入口违规）：', error?.message ?? error)
    process.exit(2)
  }
}

#!/usr/bin/env node

/**
 * sync-skills.mjs
 *
 * 自动化将 .agents/skills/<skill-name>/SKILL.md 同步至对应的
 * packages/kit-<market>/assets/skills/<skill-name>.md 或 base。
 *
 * 保证开发时以 .agents/skills/ 为单一事实来源（SSOT），
 * 同时满足各 kit 包在 npm 发布分发时的静态资产打包需求。
 *
 * 路由规则：
 *   - 'trading-*' / 'indicator-*' / 'knowledge-*' -> 全部 market kit（crypto/us/cn/hk/futures/global）
 *   - 'crypto-*'                                  -> kit-crypto
 *   - 'us-*'                                      -> kit-us
 *   - 'cn-*'                                      -> kit-cn
 *   - 'hk-*'                                      -> kit-hk
 *   - 'futures-*'                                 -> kit-futures
 *   - 'global-*'                                  -> kit-global
 *   - 其它通用基础技能                             -> base
 */

import { readdir, readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const AGENTS_SKILLS_DIR = path.join(ROOT, '.agents', 'skills')

const MARKET_PACKAGES = {
  crypto: path.join(ROOT, 'packages', 'kit-crypto', 'assets', 'skills'),
  us: path.join(ROOT, 'packages', 'kit-us', 'assets', 'skills'),
  cn: path.join(ROOT, 'packages', 'kit-cn', 'assets', 'skills'),
  hk: path.join(ROOT, 'packages', 'kit-hk', 'assets', 'skills'),
  futures: path.join(ROOT, 'packages', 'kit-futures', 'assets', 'skills'),
  global: path.join(ROOT, 'packages', 'kit-global', 'assets', 'skills'),
  base: path.join(ROOT, 'packages', 'base', 'assets', 'skills'),
}

// 仅供维护者会话使用的技能，不随 npm 包分发
const DISTRIBUTION_EXCLUDED = new Set(['dsh-trading-release'])

/** 带资源目录（scripts/ / references/ / evals/）的技能：除扁平 md 外整目录随包分发。
 *  命中的技能把 `.agents/skills/<name>/` 原样拷进 base 资产（跳过 `.` 开头的条目）；
 *  未命中者行为不变，只有扁平文件——注册进技能面就会形成缺脚本的残废技能。 */
export const PORTABLE_SKILLS = new Set(['company-analysis', 'weekly-trading-plan', 'content-insight'])

/** 单条技能内容的可分发判定。
 *
 * 两类内容绝不允许写进包资产：Windows 侧无 symlink 时 git 把符号链接落成的纯路径
 * 指针文本，以及体量明显不足的损坏残片。2026-09-16 实证：这两类内容随一次冲突合并
 * 被写进 kit 资产，把 cn/us/hk 三份风控清单正文（22-23 行）覆盖成 0 行且长期无人
 * 察觉。损坏内容宁可让构建失败，也不静默分发。 */
export const MIN_SKILL_BYTES = 512
const PATH_POINTER = /^\s*\.{1,2}\/[^\n]*$/
export function distributableContentError(content) {
  if (PATH_POINTER.test(content.trim())) return '源文件是未解析的路径指针'
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes < MIN_SKILL_BYTES) return `源文件仅 ${bytes} 字节（低于 ${MIN_SKILL_BYTES}），疑似损坏`
  return null
}

function resolveTargetDirs(skillName) {
  if (
    skillName.startsWith('trading-') ||
    skillName.startsWith('indicator-') ||
    skillName.startsWith('knowledge-')
  ) {
    return [MARKET_PACKAGES.crypto, MARKET_PACKAGES.us, MARKET_PACKAGES.cn, MARKET_PACKAGES.hk, MARKET_PACKAGES.futures, MARKET_PACKAGES.global]
  }
  if (skillName.startsWith('crypto-')) return [MARKET_PACKAGES.crypto]
  if (skillName.startsWith('us-')) return [MARKET_PACKAGES.us]
  if (skillName.startsWith('cn-')) return [MARKET_PACKAGES.cn]
  if (skillName.startsWith('hk-')) return [MARKET_PACKAGES.hk]
  if (skillName.startsWith('futures-')) return [MARKET_PACKAGES.futures]
  if (skillName.startsWith('global-')) return [MARKET_PACKAGES.global]
  return [MARKET_PACKAGES.base]
}

async function main() {
  if (!existsSync(AGENTS_SKILLS_DIR)) {
    console.log(`[sync-skills] Directory ${AGENTS_SKILLS_DIR} does not exist, skipping.`)
    return
  }

  const entries = await readdir(AGENTS_SKILLS_DIR, { withFileTypes: true })
  const skillDirs = entries.filter((e) => e.isDirectory())

  let syncedCount = 0
  const refused = []

  for (const dir of skillDirs) {
    const skillName = dir.name
    const srcFile = path.join(AGENTS_SKILLS_DIR, skillName, 'SKILL.md')
    if (!existsSync(srcFile)) continue
    // 会话级运维技能（含发布授权语义）不进包分发资产
    if (DISTRIBUTION_EXCLUDED.has(skillName)) continue

    let content = await readFile(srcFile, 'utf8')
    // 兼容 Windows git 下未开启 symlink 导致的相对路径纯文本指针
    if (content.trim().startsWith('../') && content.trim().split('\n').length <= 2) {
      const realPath = path.resolve(path.dirname(srcFile), content.trim())
      if (existsSync(realPath)) {
        content = await readFile(realPath, 'utf8')
      }
    }

    // 指针/残片一律拒绝分发：解析失败时 content 仍是指针文本，绝不能落进包资产。
    const blocked = distributableContentError(content)
    if (blocked) {
      console.error(`[sync-skills] Refused ${skillName}: ${blocked}；请先修 .agents/skills/${skillName}/SKILL.md，不覆盖包资产`)
      refused.push(skillName)
      continue
    }

    // Skills that carry extra resources (references/templates/scripts) keep the flattened
    // compatibility asset AND distribute the complete portable directory.
    if (PORTABLE_SKILLS.has(skillName)) {
      await cp(path.join(AGENTS_SKILLS_DIR, skillName), path.join(MARKET_PACKAGES.base, skillName), {
        recursive: true,
        dereference: true,
        filter: (source) => !path.basename(source).startsWith('.'),
      })
    }

    const targetDirs = resolveTargetDirs(skillName)

    for (const targetDir of targetDirs) {
      const targetFile = path.join(targetDir, `${skillName}.md`)
      await mkdir(targetDir, { recursive: true })
      await writeFile(targetFile, content, 'utf8')
      console.log(`[sync-skills] Synced: ${skillName} -> ${path.relative(ROOT, targetFile)}`)
      syncedCount++
    }
  }

  if (refused.length) throw new Error(`refused ${refused.length} skill(s): ${refused.join(', ')}`)
  console.log(`[sync-skills] Successfully synced ${syncedCount} skill asset(s).`)
}

// 仅在被当作入口直接执行时跑 CLI；import 时导入纯函数供测试使用（同 i18n-audit）。
const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[sync-skills] Error:', err)
    process.exit(1)
  })
}

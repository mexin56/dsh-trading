/**
 * sync-skills 可分发判定单测（2026-09-16）。
 *
 * 门禁源自一次真实数据损失：cn/us/hk 三份风控清单正文被指针文本覆盖成 0 行，
 * 而 sync-skills 每次都把这份内容照抄进包资产，损失随发布面扩散。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { distributableContentError, MIN_SKILL_BYTES, PORTABLE_SKILLS } from './sync-skills.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('sync-skills 可分发判定', () => {
  it('admin 拒绝把符号链接落成的路径指针分发给包资产', () => {
    // Given 无 symlink 的 Windows checkout 会把符号链接落成单行相对路径文本
    const pointer = '../../../packages/kit-cn/assets/skills/cn-risk-checklist.md'
    // When 判定该内容能否分发
    const error = distributableContentError(pointer)
    // Then 拒绝，且原因指向指针
    expect(error).toContain('路径指针')
  })

  it('admin 区分损坏残片与真实技能正文', () => {
    // Given 一份低于下限的残片与一份正常长度的技能正文
    const fragment = '# 空壳\n'
    const real = `# 风控清单\n${'开仓前逐项核对。\n'.repeat(80)}`
    // When 分别判定
    const fragmentError = distributableContentError(fragment)
    const realError = distributableContentError(real)
    // Then 残片被拒并报出字节数，正文放行
    expect(fragmentError).toContain(String(Buffer.byteLength(fragment, 'utf8')))
    expect(Buffer.byteLength(real, 'utf8')).toBeGreaterThan(MIN_SKILL_BYTES)
    expect(realError).toBeNull()
  })
})

describe('sync-skills 带资源技能的目录分发', () => {
  it('admin 核对便携技能的包资产目录与 SSOT 资源目录逐文件一致', () => {
    // Given 登记进 PORTABLE_SKILLS 的技能在 SSOT 下带 scripts/references/evals 资源
    const portable = [...PORTABLE_SKILLS]
    // When 递归比对 SSOT 目录与包资产目录的文件清单（跳过 `.` 开头的条目）
    const files = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .flatMap((entry) => {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        return entry.isDirectory() ? files(join(dir, entry.name), relative) : [relative]
      })
      .sort()
    // Then 每个便携技能整目录随包分发，注册它才有可执行落点而不是残废技能
    expect(portable).toContain('content-insight')
    for (const skill of portable) {
      const source = join(ROOT, '.agents', 'skills', skill)
      const packaged = join(ROOT, 'packages', 'base', 'assets', 'skills', skill)
      expect(existsSync(packaged), `${skill} 未随包分发目录`).toBe(true)
      expect(files(packaged), skill).toEqual(files(source))
    }
  })
})

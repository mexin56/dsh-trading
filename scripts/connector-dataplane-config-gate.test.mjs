/**
 * connector-dataplane-config-gate.mjs 纯函数自测。
 *
 * 门禁是「dataplane 入口必须导出主行 Config schema」这条不变量的唯一执行点：它若坏成
 * 永远返回空列表，入口漏导出照样全绿而宿主只在启动日志里丢一句警告——所以每条规则都要
 * 有用例证明它**真的会红**，而不是只证明正常输入不报错。夹具是 mkdtemp 临时仓库树，
 * 无 mock、无等待（测试棘轮规则）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { check, dataplaneReferences, discoverEntries, entryProblem, sourceFileFor } from './connector-dataplane-config-gate.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const created = []

/** 造一棵临时仓库树：files 是 相对路径 → 内容。 */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'dataplane-gate-'))
  created.push(root)
  for (const [rel, body] of Object.entries(files)) {
    const target = join(root, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
  }
  return root
}

/** 合规入口：重导出主行 schema。 */
const GOOD_ENTRY = "import { Config, FakeService } from './index.js'\nexport { Config }\nexport function apply() { return FakeService }\n"
/** 违规入口：只 import type，没有导出面。 */
const BAD_ENTRY = "import type { Config } from './index.js'\nexport function apply(config: Config) { return config }\n"

afterEach(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
  created.length = 0
})

describe('connector-dataplane-config-gate', () => {
  it('管理员：入口只 import type 而未导出 Config 时 R1 判红', () => {
    // Given 一个只 import type 的 dataplane 入口
    // When 过 R1
    // Then 判红且指明缺 export { Config }
    const problem = entryProblem('packages/connector-fake/src/dataplane.ts', BAD_ENTRY)
    expect(problem).toContain('未重导出主行的 Config schema')
  })

  it('管理员：入口重导出主行 Config（带或不带 from）时 R1 放行', () => {
    // Given 两种合规写法
    // When 过 R1
    // Then 都放行
    expect(entryProblem('packages/connector-fake/src/dataplane.ts', GOOD_ENTRY)).toBeNull()
    expect(entryProblem('packages/connector-fake/src/dataplane.ts', "export { Config } from './index.js'\n")).toBeNull()
  })

  it('管理员：patch 行引用的 dataplane 模块源码缺失时 R2 判红（死行）', () => {
    // Given 一个引用 @dshtrading/connector-ghost/dataplane 的 patch 层，仓库里没有这个包
    const root = fixture({
      'packages/cn/cordis.patch.yml': "insert:\n  - id: dsh-trading-cn-dataplane-ghost\n    name: '@dshtrading/connector-ghost/dataplane'\n    config:\n      enabled: true\n",
    })
    // When 过全量检查
    // Then 判红并指明源码入口不存在
    expect(check(root).problems).toHaveLength(1)
    expect(check(root).problems[0]).toContain('源码入口不存在')
  })

  it('管理员：patch 行引用的入口存在但漏导出 Config 时 R2 判红', () => {
    // Given 一个存在但只 import type 的入口被 patch 行引用
    const root = fixture({
      'packages/connector-fake/src/dataplane.ts': BAD_ENTRY,
      'packages/cn/cordis.patch.yml': "insert:\n  - id: dsh-trading-cn-dataplane-fake\n    name: '@dshtrading/connector-fake/dataplane'\n",
    })
    // When 过全量检查
    // Then R1 与 R2 都命中同一条缺口（去重后仍只报一次该文件）
    expect(check(root).problems).toHaveLength(1)
    expect(check(root).problems[0]).toContain('未重导出主行的 Config schema')
  })

  it('管理员：合规夹具（入口导出 + patch 可达）全绿', () => {
    // Given 一个入口导出 Config、patch 行指向它的临时仓库树
    const root = fixture({
      'packages/connector-fake/src/dataplane.ts': GOOD_ENTRY,
      'packages/crypto/cordis.patch.yml': "insert:\n  - id: dsh-trading-crypto-dataplane-fake\n    name: '@dshtrading/connector-fake/dataplane'\n    config:\n      enabled: true\n",
    })
    // When 过全量检查
    // Then 无违规，且入口与引用两向都真的扫到了
    const result = check(root)
    expect(result.problems).toEqual([])
    expect(result.entries.map((entry) => entry.rel)).toEqual(['packages/connector-fake/src/dataplane.ts'])
    expect(result.references).toHaveLength(1)
  })

  it('管理员：非 dataplane 子路径行不进入检查范围', () => {
    // Given 一个引用 @dshtrading/strategies/plugin 的 patch 行（不是数据面入口）
    const root = fixture({
      'packages/base/cordis.patch.yml': "insert:\n  - id: dsh-trading-strategies\n    name: '@dshtrading/strategies/plugin'\n",
    })
    // When 扫引用行
    // Then 一条都不认领（门禁只判据数据面入口）
    expect(dataplaneReferences(root)).toEqual([])
  })

  it('管理员：本仓现状全绿（入口都导出 Config、patch 引用的入口都可达）', () => {
    // Given 仓库当前的 dataplane 入口与 patch 层
    // When 过全量检查
    // Then 无违规；入口清单非空（空清单说明扫描面坏了，而不是债清了）
    const result = check(REPO_ROOT)
    expect(result.problems).toEqual([])
    expect(result.entries.length).toBeGreaterThanOrEqual(20)
    expect(result.references.length).toBeGreaterThanOrEqual(20)
    expect(result.entries.every((entry) => entry.rel.endsWith('dataplane.ts'))).toBe(true)
  })

  it('管理员：包名到源码入口的子路径映射对得上包目录', () => {
    // Given 一个真实行的包名
    // When 解析源码入口
    // Then 映射到该包的 src 子路径文件；不存在的包返回 null
    expect(sourceFileFor('@dshtrading/connector-binance/dataplane', REPO_ROOT)).toContain('packages/connector-binance/src/dataplane.ts')
    expect(discoverEntries(REPO_ROOT).some((entry) => entry.rel.endsWith('connector-hithink/src/futures-dataplane.ts'))).toBe(true)
    expect(sourceFileFor('@dshtrading/connector-not-installed/dataplane', REPO_ROOT)).toBeNull()
  })
})

/**
 * 预置指标的一次性默认激活补种（2026-10-14，量比分档量能泛化的配套机制）。
 *
 * definition.defaultActive = true 的预置指标要在用户图上默认勾选：新工作区由补种
 * 直接激活，已有工作区也补种一次（否则「默认勾选」对存量用户不生效）。补种只能发生
 * 一次——用户在图上删掉之后不得复活，所以「补种过」这件事必须单独记账，账本落在
 * `$DSH_HOME/indicators/chart-seed.json`（与 chart.json 同级）。
 *
 * 账本不写进 chart.json 的理由：chart.json 是裸实例数组，桥的 PUT /chart/indicators
 * 与一次性迁移导入都走 replaceAll 整表覆盖——账本混在里面会被整表覆盖抹掉，于是补种
 * 再来一次、用户删掉的指标复活。
 *
 * 整个补种（读账本 → 读名册 → 激活 → 记账）在一次跨进程排他锁内完成（@dshtrading/dsh-home
 * 的 transactStore），桌面端与 CLI 同时启动也只种一次。Node 侧专用模块（与
 * chart-activations-fs.ts 同层），不进浏览器 barrel（index.ts）。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { SKIP_WRITE, dshHomeDir, transactStore } from '@dshtrading/dsh-home'
import { defaultActivationInstance, type ChartActivationStore } from './chart-activations.ts'
import { presetDefinitions } from './presets.ts'
import type { IndicatorDefinition } from './types.ts'

const LOG_PREFIX = '[dsh-trading/indicators] failed to atomic flush chart seed ledger to'

/** 账本落盘形状：`{ "seeded": ["vol-tier"] }`。 */
interface ChartSeedFile {
  seeded: string[]
}

/** 补种账本：记录「已经补种过」的指标 id（用户删掉之后靠它不复活）。 */
export interface ChartSeedLedger {
  /** 账本里已记录的 id（诊断与测试用）。 */
  list(): Promise<string[]>
  /**
   * 在跨进程临界区里跑一次补种：seed 拿到**锁内新鲜**账本，返回本次要记账的 id
   * （空数组 = 无变化，不落盘）；本方法返回实际记账的 id。
   */
  transact(seed: (recorded: ReadonlySet<string>) => Promise<readonly string[]>): Promise<string[]>
}

/** 默认账本路径：$DSH_HOME/indicators/chart-seed.json（与 chart.json 同级）。 */
export function defaultChartSeedPath(): string {
  return path.join(dshHomeDir(), 'indicators', 'chart-seed.json')
}

/**
 * 账本形状防御：只收对象里的 `seeded` 字符串数组，去空白、去空串、去重；坏 JSON /
 * 坏形按空账本降级（与同目录 chart.json 的读盘口径一致，错误记日志不抛）。
 */
function collectSeeded(raw: unknown): Set<string> {
  const out = new Set<string>()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  const seeded = (raw as { seeded?: unknown }).seeded
  if (!Array.isArray(seeded)) return out
  for (const item of seeded) {
    if (typeof item !== 'string') continue
    const id = item.trim()
    if (id !== '') out.add(id)
  }
  return out
}

/** 文件版补种账本（Node 宿主侧）。 */
export function createFileChartSeedLedger(filePath: string): ChartSeedLedger {
  /** 新鲜读盘；供 list 与锁内重读共用。 */
  async function readFromDisk(): Promise<Set<string>> {
    try {
      return collectSeeded(JSON.parse(await readFile(filePath, 'utf8')))
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') {
        console.error(`[dsh-trading/indicators] failed to read chart seed ledger from ${filePath}:`, err)
      }
      return new Set()
    }
  }

  return {
    async list() {
      return [...await readFromDisk()]
    },
    async transact(seed) {
      let recorded: string[] = []
      await transactStore<Set<string>>(
        filePath,
        readFromDisk,
        async (onDisk) => {
          const added: string[] = []
          for (const id of await seed(onDisk)) {
            const key = id.trim()
            if (key === '' || onDisk.has(key) || added.includes(key)) continue
            added.push(key)
          }
          if (added.length === 0) return SKIP_WRITE
          recorded = added
          const next = new Set(onDisk)
          for (const id of added) next.add(id)
          return next
        },
        table => ({ seeded: [...table] } satisfies ChartSeedFile),
        LOG_PREFIX,
      )
      return recorded
    },
  }
}

/**
 * 补种默认激活：definition 声明 defaultActive、名册里还没有、账本也没记过 → 用定义的
 * schema 默认参数激活一次并记账。返回本次记账的 id。
 *
 * 名册里已有该 id 时只记账、不重复激活（不动用户参数）：记账是为了让「用户自己加过
 * 又删掉」的默认勾选指标同样不复活。账本已记录的 id 永不补种，重复调用返回空数组。
 */
export async function seedDefaultActivations(
  store: ChartActivationStore,
  definitions: readonly IndicatorDefinition[],
  ledger: ChartSeedLedger = createFileChartSeedLedger(defaultChartSeedPath()),
): Promise<string[]> {
  const defaults = definitions.filter(definition => definition.defaultActive === true)
  if (defaults.length === 0) return []
  return ledger.transact(async (recorded) => {
    const roster = new Set((await store.list()).map(instance => instance.id))
    const seeded: string[] = []
    for (const definition of defaults) {
      // 同一次补种里重复出现的定义只处理一次（名册快照在本轮开始时就取定，激活不再回读）。
      if (recorded.has(definition.id) || seeded.includes(definition.id)) continue
      if (!roster.has(definition.id)) await store.activate(defaultActivationInstance(definition))
      seeded.push(definition.id)
    }
    return seeded
  })
}

/**
 * 宿主启动入口：用预置定义名册补种一次。plugin.ts 的 apply() 与 bot-api 的服务缺席
 * 兜底创建点共用这一条路径（账本路径也只有一个家）。
 */
export function seedDefaultChartActivations(
  store: ChartActivationStore,
  ledger: ChartSeedLedger = createFileChartSeedLedger(defaultChartSeedPath()),
): Promise<string[]> {
  return seedDefaultActivations(store, presetDefinitions(), ledger)
}

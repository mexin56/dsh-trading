/**
 * 默认勾选补种单测（真实文件 + 真实账本，零 mock）：一次性语义（首次种入、重复调用
 * 返回空）、用户删除后不复活、名册已有该 id 时不覆盖用户参数、账本已记不重复、
 * 参数取 definition 的 schema 默认、多条默认勾选一次种完、账本文件形状、跨实例并发只种一次。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { presetDefinitions, type IndicatorDefinition } from '../src/index.ts'
import { createFileChartActivationStore } from '../src/chart-activations-fs.ts'
import { createFileChartSeedLedger, seedDefaultActivations, seedDefaultChartActivations } from '../src/chart-seed.ts'

const tmpDirs: string[] = []
afterAll(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })
})

interface SeedWorkspace {
  chartPath: string
  seedPath: string
  store: ReturnType<typeof createFileChartActivationStore>
  ledger: ReturnType<typeof createFileChartSeedLedger>
}

/** 每个用例一套真实工作区文件（chart.json + chart-seed.json）。 */
async function workspace(): Promise<SeedWorkspace> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-chart-seed-'))
  tmpDirs.push(dir)
  const chartPath = path.join(dir, 'chart.json')
  const seedPath = path.join(dir, 'chart-seed.json')
  return {
    chartPath,
    seedPath,
    store: createFileChartActivationStore(chartPath),
    ledger: createFileChartSeedLedger(seedPath),
  }
}

async function ledgerOnDisk(seedPath: string): Promise<unknown> {
  return JSON.parse(await readFile(seedPath, 'utf8')) as unknown
}

describe('默认勾选补种', () => {
  it('用户首次启动宿主时，声明默认勾选的预置指标被种入名册并按 schema 默认参数落地', async () => {
    // Given 空工作区（空名册 + 不存在的账本）
    const { store, ledger } = await workspace()
    expect(await store.list()).toEqual([])
    expect(await ledger.list()).toEqual([])

    // When 宿主启动补种一次
    const seeded = await seedDefaultChartActivations(store, ledger)

    // Then 只有声明 defaultActive 的预置指标被种入，参数取 definition 默认值
    expect(seeded).toEqual(['vol', 'vol-tier'])
    expect(await store.list()).toEqual([{ id: 'vol', params: {} }, { id: 'vol-tier', params: { n: 4 } }])
    // Then 账本记下补种过的 id（顺序 = 预置名册顺序：成交量在量比分档量能之前）
    expect(await ledger.list()).toEqual(['vol', 'vol-tier'])
  })

  it('用户再次启动宿主时，补种不再发生且名册保持原样', async () => {
    // Given 已经补种过一次的工作区
    const { store, ledger } = await workspace()
    expect(await seedDefaultChartActivations(store, ledger)).toEqual(['vol', 'vol-tier'])

    // When 再补种一次
    const second = await seedDefaultChartActivations(store, ledger)

    // Then 返回空且名册不变（幂等）
    expect(second).toEqual([])
    expect(await store.list()).toEqual([{ id: 'vol', params: {} }, { id: 'vol-tier', params: { n: 4 } }])
    expect(await ledger.list()).toEqual(['vol', 'vol-tier'])
  })

  it('用户在图上删掉默认勾选的指标后，重启宿主不会把它复活', async () => {
    // Given 已补种过一次的工作区
    const { store, ledger } = await workspace()
    await seedDefaultChartActivations(store, ledger)

    // When 用户手动把两条默认勾选的指标都删掉
    expect(await store.deactivate('vol')).toBe(true)
    expect(await store.deactivate('vol-tier')).toBe(true)

    // Then 再次补种返回空、名册保持空（账本已记，删除是用户意图）
    expect(await seedDefaultChartActivations(store, ledger)).toEqual([])
    expect(await store.list()).toEqual([])
    expect(await ledger.list()).toEqual(['vol', 'vol-tier'])
  })

  it('用户自己先把该指标挂上图时，补种不覆盖其参数但记账，删除后同样不复活', async () => {
    // Given 用户已按自己的周期参数挂上同一 id
    const { store, ledger } = await workspace()
    await store.activate({ id: 'vol-tier', params: { n: 9 } })

    // When 宿主补种一次
    const seeded = await seedDefaultChartActivations(store, ledger)

    // Then 用户参数原样保留（不重复激活），但已记账（名册顺序 = 用户先挂的先在，补种的追加在后）
    expect(seeded).toEqual(['vol', 'vol-tier'])
    expect(await store.list()).toEqual([{ id: 'vol-tier', params: { n: 9 } }, { id: 'vol', params: {} }])
    expect(await ledger.list()).toEqual(['vol', 'vol-tier'])

    // Then 用户随后删掉它，重启也不复活（另一条未删的默认勾选指标仍在名册里）
    expect(await store.deactivate('vol-tier')).toBe(true)
    expect(await seedDefaultChartActivations(store, ledger)).toEqual([])
    expect(await store.list()).toEqual([{ id: 'vol', params: {} }])
  })

  it('用户查看账本文件时，它是 { seeded: [...] } 形状且与 chart.json 同级', async () => {
    // Given 补种过一次的工作区
    const { seedPath, store, ledger } = await workspace()

    // When 宿主补种
    await seedDefaultChartActivations(store, ledger)

    // Then 账本落盘形状冻结为 { seeded: [...] }（独立文件，不进 chart.json 整表覆盖）
    expect(await ledgerOnDisk(seedPath)).toEqual({ seeded: ['vol', 'vol-tier'] })
    expect(path.basename(seedPath)).toBe('chart-seed.json')
  })

  it('用户传入不含默认勾选声明的定义名册时，补种不动名册也不写账本', async () => {
    // Given 去掉 defaultActive 声明的预置名册
    const { seedPath, store, ledger } = await workspace()
    const definitions = presetDefinitions().filter(definition => definition.defaultActive !== true)
    expect(definitions.length).toBeGreaterThan(0)

    // When 补种一次
    const seeded = await seedDefaultActivations(store, definitions, ledger)

    // Then 什么都不种，账本文件根本没被创建
    expect(seeded).toEqual([])
    expect(await store.list()).toEqual([])
    expect(await readFile(seedPath, 'utf8').then(() => 'exists', () => 'missing')).toBe('missing')
  })

  it('用户升级到新增的默认勾选预置指标时，它按定义默认参数被种入一次', async () => {
    // Given 一个后续版本新增的默认勾选定义（参数默认 7）
    const { store, ledger } = await workspace()
    const definition: IndicatorDefinition = {
      id: 'demo-default',
      pane: 'sub',
      title: '演示默认勾选',
      params: [{ key: 'n', label: '周期', default: 7, min: 1, max: 9 }],
      defaultActive: true,
      compute: () => [],
    }

    // When 补种一次
    const seeded = await seedDefaultActivations(store, [definition], ledger)

    // Then 种入并按 schema 默认参数落地，重复调用返回空
    expect(seeded).toEqual(['demo-default'])
    expect(await store.list()).toEqual([{ id: 'demo-default', params: { n: 7 } }])
    expect(await seedDefaultActivations(store, [definition], ledger)).toEqual([])
  })

  it('用户的名册里同时有两条默认勾选定义时，两条都按各自默认参数被种入、账本记两条', async () => {
    // Given 两条默认勾选定义（一条带参数默认 7、一条无参数）
    const { store, ledger } = await workspace()
    const first: IndicatorDefinition = {
      id: 'demo-first',
      pane: 'sub',
      title: '演示一',
      params: [{ key: 'n', label: '周期', default: 7, min: 1, max: 9 }],
      defaultActive: true,
      compute: () => [],
    }
    const second: IndicatorDefinition = {
      id: 'demo-second',
      pane: 'sub',
      title: '演示二',
      params: [],
      defaultActive: true,
      compute: () => [],
    }

    // When 补种一次
    const seeded = await seedDefaultActivations(store, [first, second], ledger)

    // Then 两条都种入、各按自己的 schema 默认参数落地（顺序 = 名册顺序）
    expect(seeded).toEqual(['demo-first', 'demo-second'])
    expect(await store.list()).toEqual([{ id: 'demo-first', params: { n: 7 } }, { id: 'demo-second', params: {} }])
    // Then 账本记两条，重复调用不再补种
    expect(await ledger.list()).toEqual(['demo-first', 'demo-second'])
    expect(await seedDefaultActivations(store, [first, second], ledger)).toEqual([])
  })

  it('用户传入重复的同一条默认勾选定义时，它只被种一次、账本也只记一条', async () => {
    // Given 同一个定义在名册里出现两次
    const { store, ledger } = await workspace()
    const definition: IndicatorDefinition = {
      id: 'demo-default',
      pane: 'sub',
      title: '演示默认勾选',
      params: [{ key: 'n', label: '周期', default: 7, min: 1, max: 9 }],
      defaultActive: true,
      compute: () => [],
    }

    // When 补种一次
    const seeded = await seedDefaultActivations(store, [definition, definition], ledger)

    // Then 返回值与账本都只有一条
    expect(seeded).toEqual(['demo-default'])
    expect(await ledger.list()).toEqual(['demo-default'])
    expect(await store.list()).toEqual([{ id: 'demo-default', params: { n: 7 } }])
  })

  it('用户账本文件损坏时，补种按「没记过」处理并在补种后重写账本', async () => {
    // Given 一个坏 JSON 的账本文件
    const { seedPath, store, ledger } = await workspace()
    await writeFile(seedPath, '{ "seeded": [')

    // When 补种一次
    const seeded = await seedDefaultChartActivations(store, ledger)

    // Then 坏文件只降级为「没记过」（不抛错），补种照常发生且账本被重写为正确形状
    expect(seeded).toEqual(['vol', 'vol-tier'])
    expect(await ledgerOnDisk(seedPath)).toEqual({ seeded: ['vol', 'vol-tier'] })
  })

  it('用户账本里混入脏条目时，只认合法 id 且重复 id 不重复补种', async () => {
    // Given 账本里混入数字、空白串与重复 id，其中 vol-tier 已记过
    const { seedPath, store, ledger } = await workspace()
    await writeFile(seedPath, JSON.stringify({ seeded: [5, '  ', 'vol-tier', 'vol-tier'] }))

    // When 补种一次
    const seeded = await seedDefaultChartActivations(store, ledger)

    // Then 已记过的 id 不再补种、未记过的 vol 照常种入，读取只回合法 id
    expect(seeded).toEqual(['vol'])
    expect(await store.list()).toEqual([{ id: 'vol', params: {} }])
    expect(await ledger.list()).toEqual(['vol-tier', 'vol'])
  })

  it('用户同时开两个宿主实例（桌面端与 CLI）时，同一个指标只被种一次', async () => {
    // Given 同一份 chart.json 与同一本账本上的两个 store 实例
    const { chartPath, seedPath } = await workspace()
    const desktop = createFileChartActivationStore(chartPath)
    const cli = createFileChartActivationStore(chartPath)

    // When 两个实例同时补种
    const results = await Promise.all([
      seedDefaultChartActivations(desktop, createFileChartSeedLedger(seedPath)),
      seedDefaultChartActivations(cli, createFileChartSeedLedger(seedPath)),
    ])

    // Then 只有一侧真正记账，名册与账本都只有一份
    expect(results.flat()).toEqual(['vol', 'vol-tier'])
    expect(await ledgerOnDisk(seedPath)).toEqual({ seeded: ['vol', 'vol-tier'] })
    expect(await createFileChartActivationStore(chartPath).list())
      .toEqual([{ id: 'vol', params: {} }, { id: 'vol-tier', params: { n: 4 } }])
  })
})

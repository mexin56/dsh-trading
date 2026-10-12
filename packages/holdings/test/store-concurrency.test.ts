/**
 * 资产台账 file store 跨实例并发写（2026-10-09 事故同类）：桌面端与 CLI 各录入一条
 * 持仓时，双方都要留在盘上，且 revision 连续不回退。
 */
import { mkdirSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createFileHoldingsStore } from '../src/store-fs.ts'

const tmpDirs: string[] = []
afterAll(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })
})

async function freshFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-holdings-concurrency-'))
  tmpDirs.push(dir)
  return path.join(dir, 'book.json')
}

describe('资产台账 file store 跨实例并发写', () => {
  it('用户在第二个实例录入持仓时，第一个实例先录入的持仓不丢', async () => {
    // Given 两个实例都已读入同一份空台账
    const file = await freshFile()
    const desktop = createFileHoldingsStore(file)
    const cli = createFileHoldingsStore(file)
    expect((await desktop.snapshot()).holdings).toEqual([])
    expect((await cli.snapshot()).holdings).toEqual([])

    // When 桌面端先录入一条，CLI 再录入另一条
    await desktop.add({ market: 'us', symbol: 'AAPL', size: 10 })
    await cli.add({ market: 'hk', symbol: '00700.HK', size: 200 })

    // Then 磁盘两条都在，且 revision 为 2（没有用陈旧 revision 覆盖）
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as { revision: number; holdings: Array<{ symbol: string }> }
    expect(onDisk.holdings.map(h => h.symbol).sort()).toEqual(['00700.HK', 'AAPL'])
    expect(onDisk.revision).toBe(2)
  })

  it('用户两个实例都读过之后，桌面端新增的持仓对 CLI 的下一次读取可见', async () => {
    // Given 两个实例都已读入同一份空台账（CLI 的读缓存已建立）
    const file = await freshFile()
    const desktop = createFileHoldingsStore(file)
    const cli = createFileHoldingsStore(file)
    expect((await cli.snapshot()).holdings).toEqual([])

    // When 桌面端录入一条持仓
    await desktop.add({ market: 'us', symbol: 'AAPL', size: 10 })

    // Then CLI 的下一次读取看到它，revision 也对齐
    const seen = await cli.snapshot()
    expect(seen.holdings.map(h => h.symbol)).toEqual(['AAPL'])
    expect(seen.revision).toBe(1)
  })

  it('用户写盘失败时，本实例读取不会出现未落盘的持仓', async () => {
    // Given 目标路径其实是一个目录（真实的不合法落盘目标），实例读入空台账
    const file = await freshFile()
    mkdirSync(file)
    const store = createFileHoldingsStore(file)
    expect((await store.snapshot()).holdings).toEqual([])

    // When 用户录入一条持仓，但原子替换一个目录必然失败
    await expect(store.add({ market: 'us', symbol: 'AAPL', size: 10 })).rejects.toThrow()

    // Then 本实例读取仍是空台账（写失败不提前发布未落盘的值）
    const seen = await store.snapshot()
    expect(seen.holdings).toEqual([])
    expect(seen.revision).toBe(0)
  })
})

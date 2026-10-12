/**
 * 跨实例读新鲜度共享缓存（{@link createStoreCache}）单测：缓存不得永久命中——
 * 磁盘签名一变就重新读盘，别人已确认的写因此对下一次读取可见。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createStoreCache } from '../src/index.ts'

describe('createStoreCache', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-home-cache-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const listReader = (file: string) => async (): Promise<string[]> => {
    try { return JSON.parse(await readFile(file, 'utf8')) as string[] } catch { return [] }
  }

  it('用户缓存读盘后，另一实例落盘的新内容在下次读取时可见', async () => {
    // Given 一份已缓存（['a']）的真实文件
    const file = join(dir, 'list.json')
    writeFileSync(file, JSON.stringify(['a']), 'utf8')
    const cache = createStoreCache(file, listReader(file))
    expect(await cache.load()).toEqual(['a'])

    // When 另一个实例把磁盘内容改成 ['a', 'b']
    writeFileSync(file, JSON.stringify(['a', 'b']), 'utf8')

    // Then 下一次读取看到别人的新内容，而不是永久命中本实例缓存
    expect(await cache.load()).toEqual(['a', 'b'])
  })

  it('用户文件尚不存在时读取为空，文件随后出现也能看到', async () => {
    // Given 一个尚不存在的文件
    const file = join(dir, 'created-later.json')
    const cache = createStoreCache(file, listReader(file))

    // When 首次读取（空），随后另一实例创建并写入
    expect(await cache.load()).toEqual([])
    writeFileSync(file, JSON.stringify(['x']), 'utf8')

    // Then 下一次读取看到新文件内容
    expect(await cache.load()).toEqual(['x'])
  })

  it('用户一次成功落盘后发布本次值，下次读取仍以磁盘签名为准', async () => {
    // Given 缓存已装载 ['a']
    const file = join(dir, 'list.json')
    writeFileSync(file, JSON.stringify(['a']), 'utf8')
    const cache = createStoreCache(file, listReader(file))
    expect(await cache.load()).toEqual(['a'])

    // When 本次事务成功落盘 ['a', 'b'] 后发布该值
    writeFileSync(file, JSON.stringify(['a', 'b']), 'utf8')
    cache.replace(['a', 'b'])

    // Then 下次读取核对磁盘后返回落盘值（发布过的值不作永久凭据）
    expect(await cache.load()).toEqual(['a', 'b'])
  })

  it('用户本地写失败却误发布新值时，下次读取以磁盘已确认内容为准', async () => {
    // Given 缓存已装载 ['a']
    const file = join(dir, 'list.json')
    writeFileSync(file, JSON.stringify(['a']), 'utf8')
    const cache = createStoreCache(file, listReader(file))
    expect(await cache.load()).toEqual(['a'])

    // When 一次未落盘的写误调用了 replace(['a', 'b'])，而磁盘仍是 ['a']
    cache.replace(['a', 'b'])

    // Then 下次读取重新核对磁盘，返回已确认的 ['a']，未确认值不会留在缓存
    expect(await cache.load()).toEqual(['a'])
  })
})

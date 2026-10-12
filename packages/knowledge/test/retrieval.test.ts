import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createMemoryKnowledgeCardStore } from '../src/store-memory.ts'
import { createKnowledgeGetTool, createKnowledgeSearchTool } from '../src/tool.ts'
import { validateKnowledgeCard } from '../src/validate.ts'
import type { KnowledgeCard } from '../src/types.ts'

/**
 * 冻结检索 fixtures（5 张卡）：标签/标题权重、source 日期缺失、显式时效筛选、
 * 无命中、精确 get 引用五个断言面各由固定卡片承载，结果可复跑且不调用模型。
 */
async function loadFixture(): Promise<KnowledgeCard[]> {
  const raw = await readFile(new URL('./fixtures/retrieval-cards.json', import.meta.url), 'utf8')
  return JSON.parse(raw) as KnowledgeCard[]
}

async function retrievalHarness() {
  const cards = await loadFixture()
  const store = createMemoryKnowledgeCardStore(cards)
  return { store, search: createKnowledgeSearchTool(store), get: createKnowledgeGetTool(store) }
}

describe('知识检索的时效与相关度契约（冻结 fixture）', () => {
  it('user 看到检索 fixture 与知识卡片 schema 契约一致', async () => {
    // Given: 冻结的检索 fixture
    const cards = await loadFixture()
    // When: 逐张走结构校验
    const validations = cards.map((card) => validateKnowledgeCard(card))
    // Then: 每张都合法且 id 唯一，fixture 不是绕过 schema 的野生数据
    expect(validations.every((result) => result.ok)).toBe(true)
    expect(new Set(cards.map((card) => card.id)).size).toBe(cards.length)
    expect(cards).toHaveLength(5)
  })

  it('user 检索时标签命中排在标题命中之前，相关度压过更新时间', async () => {
    // Given: 一张标签命中但更旧的卡（kc_fix_fed_tag）与一张标题命中但更新的卡（kc_fix_fed_title）
    const { search } = await retrievalHarness()
    // When: 用户用「美联储」检索
    const result = String(await (search as any).execute({ query: '美联储' }))
    // Then: 标签命中的旧卡排在标题命中的新卡之前（时间只作同分兜底）
    const tagHit = result.indexOf('kc_fix_fed_tag')
    const titleHit = result.indexOf('kc_fix_fed_title')
    expect(tagHit).toBeGreaterThan(-1)
    expect(titleHit).toBeGreaterThan(-1)
    expect(tagHit).toBeLessThan(titleHit)
  })

  it('user 在每档 detail 都能看到更新时间与素材发布日期，缺失时明示未知', async () => {
    // Given: 一张无 source.publishedAt 的卡与一张有发布日期的卡
    const { search } = await retrievalHarness()
    // When: 用户分别用默认 summary 与 detail=full 检索
    const unknownSummary = String(await (search as any).execute({ query: '黄金' }))
    const unknownFull = String(await (search as any).execute({ query: '黄金', detail: 'full' }))
    const datedSummary = String(await (search as any).execute({ query: '半导体' }))
    // Then: 两档都给出更新时间与发布日期，缺失的发布日明示「未知」而不是留空
    expect(unknownSummary).toContain('更新 2026-09-10T00:00:00.000Z')
    expect(unknownSummary).toContain('发布 未知')
    expect(unknownFull).toContain('发布 未知')
    expect(datedSummary).toContain('更新 2026-07-16T00:00:00.000Z')
    expect(datedSummary).toContain('发布 2026-07-15')
  })

  it('user 用显式更新时间下限筛选时旧卡不出现，且库内卡片与可信度原样保留', async () => {
    // Given: 一张 2025 年的旧卡与四张 2026 年的卡
    const { store, search } = await retrievalHarness()
    const before = await store.list()
    // When: 用户用 updatedAfter=2026-01-01 检索
    const result = String(await (search as any).execute({ updatedAfter: '2026-01-01' }))
    // Then: 旧卡被筛掉，新卡仍在；库里卡片数量与旧卡可信度都没被时间筛选改变
    expect(result).toContain('kc_fix_no_pub')
    expect(result).not.toContain('kc_fix_stale')
    const after = await store.list()
    expect(after).toHaveLength(before.length)
    expect(after.find((card) => card.id === 'kc_fix_stale')?.credibility).toBe('low')
  })

  it('user 用显式发布日期下限筛选时没有发布日期的卡不被当成命中', async () => {
    // Given: 一张无 source.publishedAt 的卡与一张 2025 年的旧卡
    const { search } = await retrievalHarness()
    // When: 用户用 publishedAfter=2026-01-01 检索
    const result = String(await (search as any).execute({ publishedAfter: '2026-01-01' }))
    // Then: 未知发布日期与过期日期的卡都不出现，有日期的卡命中
    expect(result).toContain('kc_fix_unique')
    expect(result).not.toContain('kc_fix_no_pub')
    expect(result).not.toContain('kc_fix_stale')
  })

  it('user 提交非法时间筛选值时得到显式参数错误而不是空结果', async () => {
    // Given: 一个非法日期值
    const { search } = await retrievalHarness()
    // When: 用户用它检索
    const result = String(await (search as any).execute({ updatedAfter: 'not-a-date' }))
    // Then: 回报点名参数并说明不是合法日期，不伪装成「没有卡片」
    expect(result).toContain('updatedAfter')
    expect(result).toContain('不是合法日期')
    expect(result).not.toContain('未搜索到')
  })

  it('user 检索没有关键词命中时得到显式无结果提示', async () => {
    // Given: 一个库里不存在的关键词
    const { search } = await retrievalHarness()
    // When: 用户检索
    const result = String(await (search as any).execute({ query: '不存在的主题词' }))
    // Then: 显式说明无命中，而不是回空字符串或编造卡片
    expect(result).toContain('未搜索到')
    expect(result).not.toMatch(/- \[kc_/)
  })

  it('user 用检索结果里的 id 精确读取全文时不走模糊匹配', async () => {
    // Given: 一次命中的检索
    const { search, get } = await retrievalHarness()
    const found = String(await (search as any).execute({ query: '半导体' }))
    const idMatch = found.match(/- \[(kc_[A-Za-z0-9_]+)\]/)
    // When: 用户拿结果里的 id 精确读取
    const id = idMatch?.[1] ?? ''
    const detail = String(await (get as any).execute({ id }))
    // Then: 取回的就是那张卡（标题、核心论点、经验、边界、发布日期齐全），并保留未找到语义
    expect(id).toBe('kc_fix_unique')
    expect(detail).toContain('半导体设备国产化率')
    expect(detail).toContain('刻蚀与薄膜环节国产化率领先')
    expect(detail).toContain('跟踪招标数据先于收入确认')
    expect(detail).toContain('先进制程验证周期长')
    expect(detail).toContain('2026-07-15')
    expect(String(await (get as any).execute({ id: 'kc_fix_absent' }))).toContain('未找到卡片')
  })
})

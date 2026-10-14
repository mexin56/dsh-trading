/**
 * 自定义指标客户端加载的失败处理（2026-10-14 KDAS「自建指标不见了」）：
 * 桥类失败按注入的退避调度重试（不真等）、上限后停止排期、校验类失败立即
 * 可见且不重试、手动重试成功后清除失败态、桥就绪（EventSource `open`）触发重拉。
 */
import { describe, expect, it } from 'vitest'
import type { IndicatorDefinition, ValidationResult } from '@dshtrading/indicators'
import { createCustomIndicatorLoader } from '../src/client/indicator-load.ts'

/**
 * 手动调度替身（契约化 fake；测试棘轮禁通用 mock 工具，也不许真等）：记录每次
 * 排期的间隔，由用例决定何时触发——退避行为不靠等待观察。
 */
function createManualScheduler() {
  const queue: Array<{ delayMs: number; run: () => void; cancelled: boolean }> = []
  return {
    schedule: (delayMs: number, run: () => void): (() => void) => {
      const entry = { delayMs, run, cancelled: false }
      queue.push(entry)
      return () => { entry.cancelled = true }
    },
    /** 尚未触发且未被取消的排期间隔（注入缝的调用次数与间隔断言用）。 */
    pending(): number[] {
      return queue.filter(entry => !entry.cancelled).map(entry => entry.delayMs)
    },
    /** 触发最近一次未取消的排期；没有可触发的排期时返回 false（上限已到）。 */
    fire(): boolean {
      const index = queue.findIndex(entry => !entry.cancelled)
      if (index < 0) return false
      const entry = queue.splice(index, 1)[0]
      if (entry === undefined) return false
      entry.run()
      return true
    },
  }
}

const kdasDefinition: IndicatorDefinition = {
  id: 'kdas',
  title: 'KDAS',
  pane: 'main',
  params: [],
  compute: () => [],
}

const kdasValid: ValidationResult = {
  ok: true,
  definition: kdasDefinition,
  record: { id: 'kdas', title: 'KDAS', pane: 'main', params: [], computeSource: 'return []', createdAt: 0 },
}

describe('自定义指标加载的失败分类与退避重试（indicator-load）', () => {
  it('用户在桥首次不可用时打开页面，EventSource 就绪后自动重拉，自定义指标上榜且失败态清除', async () => {
    // Given 首次拉取失败、桥就绪后返回一条 KDAS 记录的桥
    const scheduled = createManualScheduler()
    const registered: string[] = []
    let calls = 0
    const loader = createCustomIndicatorLoader({
      fetchCustom: () => {
        calls += 1
        return calls === 1 ? Promise.reject(new Error('bridge 503')) : Promise.resolve([{ id: 'kdas' }])
      },
      validate: () => Promise.resolve(kdasValid),
      register: definition => { registered.push(definition.id) },
      retryDelaysMs: [1000, 2000],
      schedule: scheduled.schedule,
    })

    // When 首拉失败后桥就绪（EventSource open）
    await loader.load()
    const failed = loader.failure()
    loader.bridgeReady()
    await loader.load()

    // Then 失败是可重试类型，桥就绪触发了第二次拉取且 KDAS 上榜、失败态清除
    expect(failed).toEqual({ reason: 'bridge 503', retryable: true, attempts: 1, exhausted: false })
    expect(calls).toBe(2)
    expect(registered).toEqual(['kdas'])
    expect(loader.failure()).toBeNull()
  })

  it('用户在桥长时间不可用时经历 1s/2s 两次自动重试，退避用尽后停止排期', async () => {
    // Given 每次都失败、只给两段退避的桥
    const scheduled = createManualScheduler()
    const loader = createCustomIndicatorLoader({
      fetchCustom: () => Promise.reject(new Error('bridge down')),
      retryDelaysMs: [1000, 2000],
      schedule: scheduled.schedule,
    })

    // When 首拉失败后依次触发排期中的自动重试
    await loader.load()
    expect(scheduled.pending()).toEqual([1000])
    expect(scheduled.fire()).toBe(true)
    await loader.load()
    expect(scheduled.pending()).toEqual([2000])
    expect(scheduled.fire()).toBe(true)
    await loader.load()

    // Then 第三次失败后不再排期，失败态对用户可见且标记退避已用尽
    expect(scheduled.pending()).toEqual([])
    expect(scheduled.fire()).toBe(false)
    expect(loader.failure()).toEqual({ reason: 'bridge down', retryable: true, attempts: 3, exhausted: true })
  })

  it('用户在选择器点重试且桥已恢复时失败态立即清除，排期中的退避被取消', async () => {
    // Given 先失败一次、随后恢复并返回 KDAS 的桥
    const scheduled = createManualScheduler()
    const registered: string[] = []
    let calls = 0
    const loader = createCustomIndicatorLoader({
      fetchCustom: () => {
        calls += 1
        return calls === 1 ? Promise.reject(new Error('bridge 503')) : Promise.resolve([{ id: 'kdas' }])
      },
      validate: () => Promise.resolve(kdasValid),
      register: definition => { registered.push(definition.id) },
      retryDelaysMs: [1000, 2000],
      schedule: scheduled.schedule,
    })
    await loader.load()
    expect(loader.failure()).not.toBeNull()
    expect(scheduled.pending()).toEqual([1000])

    // When 点「重试」（reload：取消排期中的退避、重置连续失败计数、立即重拉）
    loader.reload()
    await loader.load()

    // Then 失败态清除、KDAS 上榜、被取消的退避不会自己触发
    expect(loader.failure()).toBeNull()
    expect(registered).toEqual(['kdas'])
    expect(scheduled.pending()).toEqual([])
    expect(scheduled.fire()).toBe(false)
  })

  it('用户的指标源码校验不通过时立即看到失败提示，且自动重试与桥就绪都不再打桥', async () => {
    // Given 桥可达但返回一条 computeSource 非法的定义
    const scheduled = createManualScheduler()
    const registered: string[] = []
    let calls = 0
    const loader = createCustomIndicatorLoader({
      fetchCustom: () => {
        calls += 1
        return Promise.resolve([{ id: 'broken' }])
      },
      validate: () => Promise.resolve({ ok: false, reason: 'computeSource 不是合法的函数体' }),
      register: definition => { registered.push(definition.id) },
      schedule: scheduled.schedule,
    })

    // When 首拉返回非法数据，随后桥就绪信号到达
    await loader.load()
    loader.bridgeReady()

    // Then 失败立即可见、不排期重试、桥就绪也不重拉、坏定义不登记
    expect(loader.failure()).toEqual({
      reason: 'computeSource 不是合法的函数体',
      retryable: false,
      attempts: 1,
      exhausted: false,
    })
    expect(scheduled.pending()).toEqual([])
    expect(scheduled.fire()).toBe(false)
    expect(calls).toBe(1)
    expect(registered).toEqual([])
  })

  it('用户自定义指标里混了一条坏定义时，好指标照常上榜且坏定义原因可见', async () => {
    // Given 一次返回两条、其中 broken 校验失败的桥
    const registered: string[] = []
    const loader = createCustomIndicatorLoader({
      fetchCustom: () => Promise.resolve([{ id: 'kdas' }, { id: 'broken' }]),
      validate: raw => Promise.resolve(
        (raw as { id: string }).id === 'broken'
          ? { ok: false, reason: '试算输出长度与 K 线不等长' }
          : kdasValid,
      ),
      register: definition => { registered.push(definition.id) },
    })

    // When 首拉完成
    await loader.load()

    // Then 好指标已登记，坏定义的原因作为可见失败态呈现
    expect(registered).toEqual(['kdas'])
    expect(loader.failure()).toEqual({
      reason: '试算输出长度与 K 线不等长',
      retryable: false,
      attempts: 1,
      exhausted: false,
    })
  })

  it('用户没有自定义指标时选择器不显示失败提示（空列表不等于桥失败）', async () => {
    // Given 桥可达且返回空列表
    const loader = createCustomIndicatorLoader({ fetchCustom: () => Promise.resolve([]) })

    // When 首拉完成
    await loader.load()

    // Then 无失败态
    expect(loader.failure()).toBeNull()
  })

  it('用户的校验器未预期抛出（受限环境的 Worker/Blob 构造失败）时看到可见失败态，load 不 reject 且照常排期退避', async () => {
    // Given 桥可达但校验器直接抛出（不是返回校验失败）
    const scheduled = createManualScheduler()
    const loader = createCustomIndicatorLoader({
      fetchCustom: () => Promise.resolve([{ id: 'kdas' }]),
      validate: () => { throw new Error('Worker 构造失败') },
      retryDelaysMs: [1000, 2000],
      schedule: scheduled.schedule,
    })

    // When 首拉进入校验（load 的调用侧是 fire-and-forget，绝不能 reject）
    await expect(loader.load()).resolves.toBeUndefined()

    // Then 抛出转成可重试的可见失败态，并按注入的调度缝排期下一次重试
    expect(loader.failure()).toEqual({ reason: 'Worker 构造失败', retryable: true, attempts: 1, exhausted: false })
    expect(scheduled.pending()).toEqual([1000])
  })

  it('用户的注册表登记抛出（通知链上的订阅者抛）时同样转成可见失败态与退避，不产生未处理 rejection', async () => {
    // Given 桥可达、校验通过但登记时注册表通知链抛出
    const scheduled = createManualScheduler()
    const loader = createCustomIndicatorLoader({
      fetchCustom: () => Promise.resolve([{ id: 'kdas' }]),
      validate: () => Promise.resolve(kdasValid),
      register: () => { throw new Error('注册表订阅者抛出') },
      retryDelaysMs: [1000, 2000],
      schedule: scheduled.schedule,
    })

    // When 首拉进入登记
    await expect(loader.load()).resolves.toBeUndefined()

    // Then 失败可见且已排期重试（与桥类失败同一套出口，不新造分类）
    expect(loader.failure()).toEqual({ reason: '注册表订阅者抛出', retryable: true, attempts: 1, exhausted: false })
    expect(scheduled.pending()).toEqual([1000])
  })

  it('用户的失败态订阅者抛出时其余订阅者照常收到通知，且加载器不因此抛出', async () => {
    // Given 桥不可达、且第一个订阅者在通知时抛出
    const loader = createCustomIndicatorLoader({ fetchCustom: () => Promise.reject(new Error('bridge 503')) })
    const notified: string[] = []
    loader.subscribe(() => { throw new Error('订阅者渲染抛出') })
    loader.subscribe(() => { notified.push('second') })

    // When 首拉失败触发失败态通知
    await expect(loader.load()).resolves.toBeUndefined()

    // Then 失败态已发布、第二个订阅者仍被通知（一个坏订阅者不阻断扇出，也不让 load reject）
    expect(loader.failure()?.reason).toBe('bridge 503')
    expect(notified).toEqual(['second'])
  })

  it('用户的桥先成功加载过，之后的每次重连 open 不重复打桥；而重连期间失败的加载仍能被下一次 open 自愈', async () => {
    // Given 桥先成功、随后在失效信号重拉时转为不可用
    const scheduled = createManualScheduler()
    let calls = 0
    let fail = false
    const loader = createCustomIndicatorLoader({
      fetchCustom: () => {
        calls += 1
        return fail ? Promise.reject(new Error('bridge 503')) : Promise.resolve([])
      },
      retryDelaysMs: [1000, 2000],
      schedule: scheduled.schedule,
    })
    await loader.load()

    // When 第一次重连 open（此前已成功、当前无失败）
    loader.bridgeReady()

    // Then 不重复打桥
    expect(calls).toBe(1)

    // When 此后一次失效信号重拉失败，紧接着下一次重连 open（此时桥已恢复）
    fail = true
    loader.reload()
    await loader.load()
    expect(loader.failure()?.retryable).toBe(true)
    const failedCalls = calls
    fail = false
    loader.bridgeReady()
    await loader.load()

    // Then 第二次 open 立即重拉（取消排期中的退避，不等它到点），失败态随之清除
    expect(scheduled.pending()).toEqual([])
    expect(calls).toBe(failedCalls + 1)
    expect(loader.failure()).toBeNull()
  })
})

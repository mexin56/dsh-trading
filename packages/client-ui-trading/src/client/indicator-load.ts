/**
 * 自定义指标客户端加载的失败处理：可注入退避重试 + 模块级可见失败态。
 *
 * 为什么要有这个模块（2026-10-14 KDAS「自建指标不见了」）：预置指标随包编译
 * 永远在，自定义指标只能靠「一次性 fetch → 浏览器端校验 → register」。旧写法把
 * fetch 失败 catch 成空数组、失败只 console.warn，而唯一的重拉入口是 SSE
 * `indicators` 失效信号——桥晚挂出来、连接被重置这类瞬时失败的代价是该会话
 * 永久缺自定义指标，且界面完全不可见（用户只能得出「指标丢了」的结论）。
 *
 * 失败分两类，处理方式必须不同：
 * - 桥/网络类失败（fetch reject）＝可重试：按退避间隔自动重试，间隔用尽即停止
 *   （不无限循环），之后只接受手动重试；
 * - 数据/校验类失败（computeSource 非法等）＝不可重试：立即进入可见失败态，但
 *   不自动重试——拿一份非法源码反复打桥不会变好，只会掩盖真实原因。
 *
 * 失败态是模块级可观测状态（customIndicatorLoader.failure/subscribe），指标
 * 选择器据它渲染一行提示 + 「重试」按钮；若放在 React 局部 state 里，SSE 通道
 * 与按钮就会各说各话。
 *
 * 退避调度是注入缝（照 @dshtrading/indicators 试算超时可注入的先例）：生产用
 * 默认 setTimeout，测试注入手动调度，不真等（测试棘轮禁 sleep）。
 */
import { validateCustomIndicatorAsync, type IndicatorDefinition, type ValidationResult } from '@dshtrading/indicators'
import { fetchCustomIndicators } from './api.ts'
import { indicators, markCustomIndicator } from './indicator-registry.ts'

/** 可见失败态（选择器提示行 + 重试按钮的唯一数据源）。 */
export interface IndicatorLoadFailure {
  /** 原始失败原因（桥类失败是 fetch 的错误文本；校验类失败是校验器给的中文原因）。 */
  reason: string
  /** true = 桥/网络类失败（退避自动重试 + 手动重试）；false = 数据/校验类失败（只可见，不重试）。 */
  retryable: boolean
  /** 本轮连续失败的尝试次数（1 = 首拉失败）；不可重试失败恒为 1。 */
  attempts: number
  /** 自动退避已用尽：此后只接受手动重试（「重试」按钮）。 */
  exhausted: boolean
}

/** 单项校验缝（默认浏览器端 Worker 熔断校验器）。 */
export type IndicatorValidator = (raw: unknown) => Promise<ValidationResult>

export interface CustomIndicatorLoadOptions {
  /** 拉取自定义指标；桥不可达/HTTP 非 2xx 必须 reject（空数组只表示「确实没有自定义指标」）。 */
  fetchCustom?: () => Promise<unknown[]>
  /** 单项校验；默认 validateCustomIndicatorAsync。 */
  validate?: IndicatorValidator
  /** 校验通过的登记；默认写本地注册表 + 标记自定义来源。 */
  register?: (definition: IndicatorDefinition) => void
  /** 退避调度缝：安排一次延迟执行并返回取消函数；默认 setTimeout。 */
  schedule?: (delayMs: number, run: () => void) => () => void
  /** 自动重试的退避间隔（毫秒）；数组长度即自动重试上限。 */
  retryDelaysMs?: readonly number[]
}

export interface CustomIndicatorLoader {
  /** 当前失败态；null = 无失败。未变化时返回同一引用（供 useSyncExternalStore）。 */
  failure(): IndicatorLoadFailure | null
  /** 订阅失败态变化；返回退订函数。 */
  subscribe(listener: () => void): () => void
  /** 首拉/显式加载；并发调用合流为同一次请求。 */
  load(): Promise<void>
  /** 外部重拉（SSE `indicators` 失效信号、选择器「重试」按钮）：取消排期中的退避、重置计数、立即重拉。 */
  reload(): void
  /** 桥就绪（EventSource `open`）：只在「从未成功」或当前是桥类失败时重拉。 */
  bridgeReady(): void
}

/**
 * 自动重试的退避间隔：1s / 2s / 4s —— 三次自动重试，第 4 次失败即停止排期
 * （上限写死在这里：桥长时间不可用时不该无限打桥，交回用户手动重试）。
 */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000]

const defaultSchedule = (delayMs: number, run: () => void): (() => void) => {
  const timer = setTimeout(run, delayMs)
  return () => { clearTimeout(timer) }
}

const defaultRegister = (definition: IndicatorDefinition): void => {
  indicators.register(definition)
  markCustomIndicator(definition.id)
}

const describeError = (error: unknown): string => {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}

/** 建一个加载器（纯工厂，不启动任何请求——由调用方决定首拉时机）。 */
export function createCustomIndicatorLoader(options: CustomIndicatorLoadOptions = {}): CustomIndicatorLoader {
  const fetchCustom = options.fetchCustom ?? fetchCustomIndicators
  const validate = options.validate ?? validateCustomIndicatorAsync
  const register = options.register ?? defaultRegister
  const schedule = options.schedule ?? defaultSchedule
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS

  let failure: IndicatorLoadFailure | null = null
  let inFlight: Promise<void> | null = null
  let cancelScheduled: (() => void) | null = null
  let attempts = 0
  let loadedOnce = false
  const listeners = new Set<() => void>()

  const publish = (next: IndicatorLoadFailure | null): void => {
    failure = next
    for (const listener of [...listeners]) {
      // 订阅者异常隔离：一个订阅者（React 渲染链）抛出不能让加载器自己抛——
      // load() 的调用侧全是 fire-and-forget，加载器抛出只会变成未处理 rejection。
      try {
        listener()
      } catch (error) {
        console.warn('[dsh-trading] indicator load-state subscriber threw:', error)
      }
    }
  }

  const cancelScheduledRetry = (): void => {
    if (cancelScheduled === null) return
    cancelScheduled()
    cancelScheduled = null
  }

  /** 桥类失败与未预期抛出的统一出口：可见失败态 + 退避排期（不新造错误分类）。 */
  const failRetryable = (error: unknown): void => {
    attempts += 1
    const exhausted = attempts > retryDelaysMs.length
    publish({ reason: describeError(error), retryable: true, attempts, exhausted })
    console.warn('[dsh-trading] custom indicator load failed (retryable):', error)
    if (exhausted) return
    // !exhausted 蕴含 attempts <= retryDelaysMs.length，索引必存在。
    const delayMs = retryDelaysMs[attempts - 1] as number
    cancelScheduled = schedule(delayMs, () => {
      cancelScheduled = null
      void load()
    })
  }

  /**
   * 一次「拉取 + 逐项校验 + 登记」。整段包 try/catch：除桥不可达外，validate /
   * register 的未预期抛出（受限环境里 Worker/Blob 构造同步抛、注册表通知链上的
   * 订阅者抛）也走同一套可见失败态 + 退避——漏掉它的话失败既不 publish（选择器
   * 那一行永远不出现）又会 reject，等于把「失败不可见」换个触发点。
   *
   * 契约：load() 永不 reject。调用侧全是 fire-and-forget（index.ts 的首拉与退避
   * 回调里的 void load()），reject 只会变成未处理的 promise rejection。
   * 不重入：并发由 load 的 inFlight 合流挡住。
   */
  const runOnce = async (): Promise<void> => {
    try {
      const records = await fetchCustom()
      // 数据/校验类失败：坏条目可见、好条目照常登记，但不排期重试（拿非法源码反复
      // 打桥不会变好；失败原因本身就是要展示给用户的自修线索）。
      let invalidReason: string | null = null
      for (const record of records) {
        const result = await validate(record)
        if (!result.ok) {
          invalidReason = result.reason
          continue
        }
        register(result.definition)
      }
      if (invalidReason !== null) {
        attempts = 0
        publish({ reason: invalidReason, retryable: false, attempts: 1, exhausted: false })
        console.warn('[dsh-trading] custom indicator validation failed (not retried):', invalidReason)
        return
      }
      attempts = 0
      loadedOnce = true
      publish(null)
    } catch (error) {
      failRetryable(error)
    }
  }

  const load = (): Promise<void> => {
    if (inFlight !== null) return inFlight
    // runOnce 自带全部捕获（含订阅者异常隔离），故这个 promise 永不 reject。
    const run = runOnce().finally(() => { inFlight = null })
    inFlight = run
    return run
  }

  const reload = (): void => {
    cancelScheduledRetry()
    attempts = 0
    void load()
  }

  return {
    failure: () => failure,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    load,
    reload,
    bridgeReady() {
      // 校验类失败不因「桥就绪」重拉（那正是「不重试」的语义）；已成功加载过且
      // 当前无失败 → 重连不值得再打一次桥。首次失败（桥还没挂出来）走 reload。
      if (failure !== null && !failure.retryable) return
      if (loadedOnce && failure === null) return
      if (inFlight !== null) return
      reload()
    },
  }
}

/**
 * 页面级单例：index.ts 的首拉/信号重拉与指标选择器的失败提示共用这一份状态。
 * 构造无副作用（不发请求），首个请求由 index.ts 的 load() 触发。
 */
export const customIndicatorLoader: CustomIndicatorLoader = createCustomIndicatorLoader()

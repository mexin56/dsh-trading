/**
 * 桥就绪通知面（api.ts）：EventSource `open`（首连与每次自动重连）要把「桥可达」
 * 告诉订阅者——加载期失败的自定义指标靠它自愈（2026-10-14 KDAS「自建指标不见了」）。
 *
 * jsdom 不实现 EventSource，这里手写一个契约化替身（不用通用 mock 工具）来触发
 * open 事件；顺带钉住桥端点 URL，防止通知面接错连接。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { subscribeTradingBridgeReady } from '../src/client/api.ts'

/** 浏览器 EventSource 的最小替身：只保留桥就绪通知面用到的部分。 */
class FakeEventSource {
  static readonly created: FakeEventSource[] = []
  private readonly listeners = new Map<string, Array<() => void>>()
  constructor(readonly url: string) { FakeEventSource.created.push(this) }
  addEventListener(type: string, handler: () => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }
  close(): void {}
  /** 模拟连接建立（生产里由浏览器在流就绪时触发）。 */
  open(): void {
    for (const handler of this.listeners.get('open') ?? []) handler()
  }
}

describe('桥就绪通知面（api.subscribeTradingBridgeReady）', () => {
  it('用户在桥连接建立时收到自定义指标重拉信号，退订后不再收到', () => {
    // Given 一个替代浏览器 EventSource 的替身与一个桥就绪订阅者
    ;(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource
    let ready = 0
    const unsubscribe = subscribeTradingBridgeReady(() => { ready += 1 })

    // When 桥连接建立（EventSource open）
    const source = FakeEventSource.created[0]
    expect(source?.url).toBe('/dshtrading/api/events')
    source?.open()

    // Then 订阅者被通知一次；退订后再建立连接不再通知
    expect(ready).toBe(1)
    unsubscribe()
    source?.open()
    expect(ready).toBe(1)
  })
})

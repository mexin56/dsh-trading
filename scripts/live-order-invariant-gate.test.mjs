/**
 * 实盘下单不变量门禁自测：用**注入的**工具盘点与源码验证判据，不依赖真实连接器。
 */
import { describe, expect, it } from 'vitest'
import { hasRealOrderPath, liveOrderViolations } from './live-order-invariant-gate.mjs'

function model(toolFile, plane = 'preset', params = ['symbol']) {
  return {
    injectionPoints: [{ file: toolFile, plane }],
    tools: [{ name: 'crypto_place_order', package: '@x/connector', file: toolFile, params: params.map((name) => ({ name })) }],
  }
}

const REAL_ORDER = 'const order = await this.client.placeOrder(creds, request)'
const STUB = 'throw new TradingServiceError("TRADING_NOT_IMPLEMENTED", "not implemented")'

describe('live order invariant gate', () => {
  it('用户 把未接台账的真实下单连接器挂载后门禁报红', () => {
    // Given 一个已挂载、有真实下单调用、但没有 intentId 的下单工具
    const violations = liveOrderViolations(model('a.ts', 'preset', ['symbol', 'dryRun']), () => REAL_ORDER)
    // When 检查不变量
    // Then 幂等键缺失被判红
    expect(violations.some((line) => line.startsWith('L1'))).toBe(true)
  })

  it('用户 已挂载但实盘未实现的桩连接器不会被误判为缺幂等键', () => {
    // Given 一个已挂载、但源码只有 NOT_IMPLEMENTED 桩的下单工具
    const violations = liveOrderViolations(model('stub.ts', 'preset', ['symbol', 'dryRun']), () => STUB)
    // When 检查
    // Then 它发不出订单，因此不因缺 intentId 报红
    expect(violations).toEqual([])
    expect(hasRealOrderPath(STUB)).toBe(false)
  })

  it('用户 下单工具缺少 dryRun 时门禁报红', () => {
    // Given 一个没有 dryRun 出口的已挂载下单工具
    const violations = liveOrderViolations(model('a.ts', 'preset', ['symbol', 'intentId']), () => REAL_ORDER)
    // When 检查
    // Then 显式模拟出口缺失被判红
    expect(violations.some((line) => line.startsWith('L2'))).toBe(true)
  })

  it('用户 未挂载的下单工具不参与不变量判定', () => {
    // Given 一个 island（无人安装）的下单工具
    const violations = liveOrderViolations(model('a.ts', 'island', ['symbol']), () => REAL_ORDER)
    // When 检查
    // Then 不可达的工具不产生违规
    expect(violations).toEqual([])
  })

  it('user 同时具备真实调用与未实现分支的连接器仍按真实下单判定', () => {
    // Given 源码里既有真实调用也有未实现分支（部分市场未实现是常见形态）
    const mixed = STUB + '\n' + REAL_ORDER
    // When 判定
    // Then 只要存在真实下单路径就按严格判据处理
    expect(hasRealOrderPath(mixed)).toBe(true)
  })
})

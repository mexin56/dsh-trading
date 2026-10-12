/**
 * 工具契约门禁自测：用**构造的**冻结形状验证每类漂移都会被判红。
 * 不读真实仓库工具面，因此不会因业务新增工具而变红。
 */
import { describe, expect, it } from 'vitest'
import { contractOf, diffContract } from './tool-contract-gate.mjs'

function tool(packageName, name, params, outputForm = 'string') {
  return {
    package: packageName,
    name,
    file: packageName + '/src/index.ts',
    params: params.map((param) => ({ name: param.name, type: param.type, required: param.required === true, enum: param.enum === true })),
    output: { form: outputForm },
  }
}

describe('tool contract freeze', () => {
  it('user 改名一个已登记工具时门禁报红', () => {
    // Given 冻结了 us_place_order，当前变成 us_submit_order
    const frozen = contractOf({ tools: [tool('@dshtrading/connector-alpaca', 'us_place_order', [{ name: 'symbol', type: 'string', required: true }])] })
    const current = contractOf({ tools: [tool('@dshtrading/connector-alpaca', 'us_submit_order', [{ name: 'symbol', type: 'string', required: true }])] })
    // When 比较冻结面
    const problems = diffContract(frozen, current)
    // Then 同时报「消失」与「未登记新增」，不能静默通过
    expect(problems.some((line) => line.startsWith('T1'))).toBe(true)
    expect(problems.some((line) => line.startsWith('T5'))).toBe(true)
  })

  it('user 把一个可选参数改成必填时门禁报红', () => {
    // Given 冻结时 intentId 是可选
    const frozen = contractOf({ tools: [tool('@dshtrading/connector-alpaca', 'us_place_order', [{ name: 'intentId', type: 'string', required: false }])] })
    const current = contractOf({ tools: [tool('@dshtrading/connector-alpaca', 'us_place_order', [{ name: 'intentId', type: 'string', required: true }])] })
    // When 比较
    const problems = diffContract(frozen, current)
    // Then 必填面变化被判红
    expect(problems.some((line) => line.startsWith('T2'))).toBe(true)
  })

  it('user 改变参数类型或输出形状时门禁报红', () => {
    // Given 冻结 quantity 是 number、输出是 string
    const frozen = contractOf({ tools: [tool('@dshtrading/connector-alpaca', 'us_place_order', [{ name: 'quantity', type: 'number', required: true }])] })
    // When 类型变成 string、输出形状变成 object
    const current = contractOf({ tools: [tool('@dshtrading/connector-alpaca', 'us_place_order', [{ name: 'quantity', type: 'string', required: true }], 'object')] })
    // Then 类型与输出各报一条
    const problems = diffContract(frozen, current)
    expect(problems.some((line) => line.startsWith('T3'))).toBe(true)
    expect(problems.some((line) => line.startsWith('T4'))).toBe(true)
  })

  it('user 未改动工具面时门禁通过', () => {
    // Given 冻结与当前完全一致
    const shape = { tools: [tool('@dshtrading/connector-alpaca', 'us_place_order', [{ name: 'symbol', type: 'string', required: true }])] }
    // When 比较同一形状的两次快照
    const problems = diffContract(contractOf(shape), contractOf(shape))
    // Then 无漂移
    expect(problems).toEqual([])
  })
})

/**
 * 工具调用结构化记录用例（D11）：真实临时文件、无替换件。
 * 断言只看落盘记录这一外部可见事实。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TOOL_CALL_LOG_MAX_BYTES, appendToolCallRecord, errorCodeOf } from '../src/tool-call-log.ts'

describe('tool call log', () => {
  const dirs: string[] = []

  function makeLog(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-trading-toollog-'))
    dirs.push(dir)
    return join(dir, 'tool-calls.jsonl')
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('用户 一次失败调用后能从记录里读到工具名、调用标识与错误类别', () => {
    // Given 一条失败调用的记录目标
    const target = makeLog()
    // When 追加一条失败记录
    appendToolCallRecord({
      at: 1700000000000, tool: 'crypto_place_order', callId: 'call-1', rootCallId: 'root-1',
      isError: true, errorCode: 'TRADING_INTENT_UNKNOWN', durationMs: 12,
    }, target)
    // Then 记录可读且四个诊断问题的答案都在字段里
    const line = JSON.parse(readFileSync(target, 'utf8').trim())
    expect(line.tool).toBe('crypto_place_order')
    expect(line.callId).toBe('call-1')
    expect(line.rootCallId).toBe('root-1')
    expect(line.isError).toBe(true)
    expect(line.errorCode).toBe('TRADING_INTENT_UNKNOWN')
  })

  it('用户 记录里不会出现调用参数或返回值（避免凭据与账户信息落盘）', () => {
    // Given 一条只含身份与结果的记录
    const target = makeLog()
    // When 写入并读回
    appendToolCallRecord({
      at: 1, tool: 'crypto_place_order', callId: 'c', rootCallId: 'r', isError: false, errorCode: null, durationMs: 0,
    }, target)
    // Then 字段集合固定，没有 arguments/values 这类载荷
    const keys = Object.keys(JSON.parse(readFileSync(target, 'utf8').trim())).sort()
    expect(keys).toEqual(['at', 'callId', 'durationMs', 'errorCode', 'isError', 'rootCallId', 'tool'])
  })

  it('用户 连续调用时记录逐行追加且顺序保持', () => {
    // Given 两次调用
    const target = makeLog()
    // When 顺序追加
    appendToolCallRecord({ at: 1, tool: 'a_get_ticker', callId: 'c1', rootCallId: 'r', isError: false, errorCode: null, durationMs: 0 }, target)
    appendToolCallRecord({ at: 2, tool: 'b_get_orderbook', callId: 'c2', rootCallId: 'r', isError: false, errorCode: null, durationMs: 0 }, target)
    // Then 两行都在且顺序与写入一致
    const rows = readFileSync(target, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(rows.map((r) => r.tool)).toEqual(['a_get_ticker', 'b_get_orderbook'])
  })

  it('用户 日志超过上限时轮转到 .1 且新记录仍可写', () => {
    // Given 一个已超过上限的日志文件
    const target = makeLog()
    appendToolCallRecord({ at: 1, tool: 'x', callId: 'c', rootCallId: 'r', isError: false, errorCode: null, durationMs: 0 }, target)
    const big = 'x'.repeat(TOOL_CALL_LOG_MAX_BYTES + 1)
    writeFileSync(target, big, 'utf8')
    // When 再写一条
    appendToolCallRecord({ at: 2, tool: 'after-rotate', callId: 'c2', rootCallId: 'r', isError: false, errorCode: null, durationMs: 0 }, target)
    // Then 轮转文件保留旧内容，新文件只含新记录
    expect(readFileSync(target + '.1', 'utf8').length).toBe(big.length)
    expect(JSON.parse(readFileSync(target, 'utf8').trim()).tool).toBe('after-rotate')
  })

  it('用户 结果没有结构化错误类别时记录为 UNKNOWN_ERROR 而不是编造代码', () => {
    // Given 一个 isError 但没有 code/name 的结果
    // When 提取错误类别
    const code = errorCodeOf({ isError: true, error: {} })
    // Then 明确标注未知，不伪造具体错误码
    expect(code).toBe('UNKNOWN_ERROR')
    // And 成功结果没有错误类别
    expect(errorCodeOf({ isError: false })).toBeNull()
  })
})

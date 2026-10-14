import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { startBridgeProcess } from './test-support/bridge-process.mjs'

const RUNNING = [
  "const net = require('node:net')",
  "process.on('SIGTERM', () => {})",
  "net.createServer().listen(0, '127.0.0.1', () => console.log('fixture running'))",
].join(';')

function expectExited(child) {
  expect(() => process.kill(child.pid, 0)).toThrow()
}

describe('桥测试进程生命周期（不要求 Python/SDK/OpenD）', () => {
  it('operator：桥启动超时返回错误前已回收不响应 SIGTERM 的子进程', async () => {
    // Given 真子进程不打印监听端口，且忽略 SIGTERM；假时钟控制启动上界
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const bridge = startBridgeProcess(process.execPath, ['-e', RUNNING], { timeoutMs: 1000 })
    const outcome = bridge.ready.catch((error) => error)
    try {
      await Promise.race([
        once(bridge.child.stdout, 'data'),
        outcome.then((error) => { throw error }),
      ])
      // When 到达启动上界，不等墙钟、不依赖测试 runner 的 hook 超时
      await vi.advanceTimersByTimeAsync(1000)
      const error = await outcome
      // Then 错误带启动日志，进程确已退出，启动计时器已清空
      expect(error.message).toContain('桥启动超时（1000ms）')
      expect(error.message).toContain('fixture running')
      expectExited(bridge.child)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await bridge.stop()
      vi.useRealTimers()
    }
  }, 30_000)

  it('operator：桥提前退出保留退出码与诊断输出且不遗留进程', async () => {
    // Given 真子进程报错后退出，尚未开始监听
    const bridge = startBridgeProcess(process.execPath, ['-e', "console.error('startup failed'); process.exit(7)"])
    try {
      // When 等待启动结果
      const error = await bridge.ready.catch((error) => error)
      // Then 退出码和输出都有，错误交付时进程已经退出
      expect(error.message).toContain('code=7')
      expect(error.message).toContain('startup failed')
      expectExited(bridge.child)
    } finally {
      await bridge.stop()
    }
  }, 40_000)

  it('operator：解释器不存在时结构化拒绝而不是未捕获 error', async () => {
    // Given 一个不存在的绝对解释器路径
    const missing = join(tmpdir(), 'missing-futu-python-' + randomUUID())
    const bridge = startBridgeProcess(missing, [])
    // When 等待启动结果，并调用可重复的清理入口
    const error = await bridge.ready.catch((error) => error)
    await bridge.stop()
    await bridge.stop()
    // Then spawn 错误被交付为可读诊断
    expect(error.message).toContain('桥启动失败')
    expect(error.message).toContain('ENOENT')
  }, 40_000)

  it('operator：桥就绪后回收等待退出并释放监听端口，重复清理安全', async () => {
    // Given 真回环服务打印内核分配的端口
    const source = [
      "const net = require('node:net')",
      'const server = net.createServer()',
      "server.listen(0, '127.0.0.1', () => console.log('listening on 127.0.0.1:' + server.address().port))",
    ].join(';')
    const bridge = startBridgeProcess(process.execPath, ['-e', source])
    try {
      // When 就绪后清理两次
      const port = await bridge.ready
      await bridge.stop()
      await bridge.stop()
      // Then 真进程退出、端口不再接受连接
      expect(port).toBeGreaterThan(0)
      expectExited(bridge.child)
      await expect(fetch('http://127.0.0.1:' + port, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
    } finally {
      await bridge.stop()
    }
  }, 40_000)
})

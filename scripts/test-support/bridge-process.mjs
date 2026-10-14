import { spawn, spawnSync } from 'node:child_process'

/** 测试专用：spawn 即交付所有权，ready 超时/失败必须先回收再拒绝。 */
export function startBridgeProcess(command, args, { env = process.env, timeoutMs = 30_000 } = {}) {
  const child = spawn(command, args, {
    env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log = []
  const closed = new Promise((resolve) => child.once('close', resolve))
  let stopping

  function stop() {
    stopping ??= (async () => {
      if (child.pid !== undefined) {
        // 测试不要求优雅停服；SDK 重连线程不能阻碍回收。只杀本次拥有的组/树。
        if (process.platform === 'win32') {
          const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000 })
          if (result.status !== 0 && child.exitCode === null && child.signalCode === null) {
            throw new Error('桥进程树回收失败：' + String(result.error ?? result.stderr))
          }
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch (error) {
            if (error.code !== 'ESRCH') throw error
          }
        }
      }
      let timer
      try {
        await Promise.race([
          closed,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('桥进程回收超时')), 5000)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    })()
    return stopping
  }

  const ready = new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => fail('桥启动超时（' + timeoutMs + 'ms）'), timeoutMs)
    function fail(message) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stop().then(
        () => reject(new Error(message + '，输出：' + log.join(''))),
        (error) => reject(new Error(message + '；回收失败：' + error.message + '，输出：' + log.join(''))),
      )
    }
    const onChunk = (chunk) => {
      log.push(chunk.toString('utf8'))
      const matched = /listening on 127\.0\.0\.1:(\d+)/.exec(log.join(''))
      if (matched !== null && !settled) {
        settled = true
        clearTimeout(timer)
        resolve(Number(matched[1]))
      }
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.once('error', (error) => fail('桥启动失败：' + error.message))
    child.once('close', (code, signal) => fail('桥提前退出（code=' + code + ', signal=' + signal + '）'))
  })
  return { child, log, ready, stop }
}

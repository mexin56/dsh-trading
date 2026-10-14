/**
 * 本 Spike 的 HTTP 传输层：node:https 直连，便于
 *   (1) 控制连接复用（keep-alive Agent vs `agent:false` 冷启动）；
 *   (2) 采集 socket 级时间线，把 DNS / TCP / TLS 与 TTFB 拆开；
 *   (3) 逐字落盘上游原始响应字节 + sha256 + HTTP 状态。
 *
 * 头策略（本探针自定，非连接器行为）：只发最小 `User-Agent: Mozilla/5.0`
 * 与 `Accept-Encoding` / `Accept`。**不发 Referer、不做浏览器伪装。**
 * `makeFetch` 把连接器传给 fetch 的 headers 一律丢弃，换成上面这套 ——
 * 因此东财连接器源码里的 Referer 不会出现在本探针发出的请求上。
 */
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'

export const USER_AGENT = 'Mozilla/5.0'

export interface SocketTiming {
  /** 请求开始 → DNS 解析完成（socket `lookup`）；复用连接为 null。 */
  readonly dnsMs: number | null
  /** DNS 完成 → TCP 连接建立（socket `connect`）；复用连接为 null。 */
  readonly tcpMs: number | null
  /** TCP 建立 → TLS 握手完成（socket `secureConnect`）；复用连接为 null。 */
  readonly tlsMs: number | null
  /** 请求开始 → 连接可用于发请求（复用连接记 0）。 */
  readonly connMs: number
  /** 连接可用 → 响应头到达（TTFB 的服务端段）。 */
  readonly serverMs: number
  /** 请求开始 → 响应头到达（整体 TTFB）。 */
  readonly ttfbMs: number
  /** 请求开始 → body 读完。 */
  readonly totalMs: number
  /** 该请求是否复用了既有 TLS 连接。 */
  readonly reused: boolean
}

export interface RawResponse {
  readonly url: string
  /** HTTP 状态码；网络失败为 0。 */
  readonly status: number
  readonly statusText: string
  readonly contentType: string | null
  readonly contentEncoding: string | null
  /** 线缆字节数（解压前）。 */
  readonly wireBytes: number
  /** 解压后字节数（解析器看到的长度）。 */
  readonly bodyBytes: number
  readonly sha256: string
  readonly body: Buffer
  readonly timing: SocketTiming
  /** 非 null 表示该次请求失败（超时 / 连接重置 / DNS 失败等）。 */
  readonly error: string | null
}

export interface CallRecord extends RawResponse {
  readonly startedAt: string
  readonly finishedAt: string
}

/** 判定「复用」用：第一次见到的 socket 视为新建。 */
const seenSockets = new WeakSet<object>()

function decodeBody(encoding: string | null, buf: Buffer): Buffer {
  const e = (encoding ?? '').toLowerCase()
  try {
    if (e.includes('br')) return brotliDecompressSync(buf)
    if (e.includes('gzip')) return gunzipSync(buf)
    if (e.includes('deflate')) return inflateSync(buf)
  } catch {
    return buf
  }
  return buf
}

export interface HttpGetOptions {
  /** keep-alive Agent，或 `false` 表示每次新建连接（冷启动）。 */
  readonly agent?: HttpsAgent | false
  readonly timeoutMs?: number
  readonly signal?: AbortSignal | null
}

export async function httpGet(url: string, options: HttpGetOptions = {}): Promise<CallRecord> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const start = performance.now()
  const startedAt = new Date().toISOString()

  return await new Promise<CallRecord>((resolve) => {
    let dnsDone: number | null = null
    let tcpDone: number | null = null
    let tlsDone: number | null = null
    let reused = false
    let responseAt: number | null = null
    let settled = false

    const chunks: Buffer[] = []
    let status = 0
    let statusText = ''
    let contentType: string | null = null
    let contentEncoding: string | null = null

    const finish = (error: string | null): void => {
      if (settled) return
      settled = true
      const end = performance.now()
      const wire = Buffer.concat(chunks)
      const body = decodeBody(contentEncoding, wire)
      const conn = tlsDone ?? tcpDone
      const connMs = reused ? 0 : (conn === null ? 0 : conn - start)
      const ttfbMs = (responseAt ?? end) - start
      resolve({
        url,
        status,
        statusText,
        contentType,
        contentEncoding,
        wireBytes: wire.byteLength,
        bodyBytes: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
        body,
        timing: {
          dnsMs: dnsDone === null ? null : dnsDone - start,
          tcpMs: dnsDone === null || tcpDone === null ? null : tcpDone - dnsDone,
          tlsMs: tcpDone === null || tlsDone === null ? null : tlsDone - tcpDone,
          connMs,
          serverMs: Math.max(0, ttfbMs - connMs),
          ttfbMs,
          totalMs: end - start,
          reused,
        },
        error,
        startedAt,
        finishedAt: new Date().toISOString(),
      })
    }

    let req: ReturnType<typeof httpsRequest>
    try {
      req = httpsRequest(url, {
        method: 'GET',
        agent: options.agent === false ? false : options.agent,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      })
    } catch (err) {
      statusText = 'request-construction-failed'
      finish(err instanceof Error ? err.message : String(err))
      return
    }

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`timeout after ${timeoutMs}ms`))
    })

    const onAbort = (): void => {
      const reason = options.signal?.reason
      req.destroy(reason instanceof Error ? reason : new Error('aborted'))
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    req.on('socket', (socket: object) => {
      const fresh = !seenSockets.has(socket)
      if (fresh) seenSockets.add(socket)
      reused = !fresh
      if (!fresh) return
      const s = socket as NodeJS.EventEmitter
      s.on('lookup', () => {
        if (dnsDone === null) dnsDone = performance.now()
      })
      s.on('connect', () => {
        if (tcpDone === null) tcpDone = performance.now()
      })
      s.on('secureConnect', () => {
        if (tlsDone === null) tlsDone = performance.now()
      })
    })

    req.on('response', (res) => {
      responseAt = performance.now()
      status = res.statusCode ?? 0
      statusText = res.statusMessage ?? ''
      const ct = res.headers['content-type']
      const ce = res.headers['content-encoding']
      contentType = typeof ct === 'string' ? ct : null
      contentEncoding = typeof ce === 'string' ? ce : null
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        if (options.signal) options.signal.removeEventListener('abort', onAbort)
        finish(null)
      })
      res.on('error', (err: Error) => {
        if (options.signal) options.signal.removeEventListener('abort', onAbort)
        finish(`response error: ${err.message}`)
      })
      res.on('aborted', () => {
        if (options.signal) options.signal.removeEventListener('abort', onAbort)
        finish('response aborted')
      })
    })

    req.on('error', (err: Error) => {
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
      finish(err.message)
    })

    req.end()
  })
}

/**
 * 连接器源码可消费的 `fetch` 替身：
 *   - 记录每一次上游调用的完整 RawResponse 到 jar（失败的也记）；
 *   - 丢弃连接器自带的 headers，改用本探针头部策略；
 *   - 失败时 reject（连接器按自己的错误码语义包装）。
 */
export function makeFetch(agent: HttpsAgent | false, jar: CallRecord[], timeoutMs = 15_000): typeof fetch {
  const impl = async (input: unknown, init?: { signal?: AbortSignal | null }): Promise<Response> => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input)
    const rec = await httpGet(url, { agent, signal: init?.signal ?? null, timeoutMs })
    jar.push(rec)
    if (rec.error !== null) throw new Error(rec.error)
    return {
      ok: rec.status >= 200 && rec.status < 300,
      status: rec.status,
      statusText: rec.statusText,
      headers: new Headers({ 'content-type': rec.contentType ?? '' }),
      async arrayBuffer(): Promise<ArrayBuffer> {
        return rec.body.buffer.slice(rec.body.byteOffset, rec.body.byteOffset + rec.body.byteLength) as ArrayBuffer
      },
      async json(): Promise<unknown> {
        return JSON.parse(rec.body.toString('utf8'))
      },
      async text(): Promise<string> {
        return rec.body.toString('utf8')
      },
    } as unknown as Response
  }
  return impl as unknown as typeof fetch
}

export function newAgent(maxSockets: number): HttpsAgent {
  return new HttpsAgent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets })
}

/**
 * 数据面行 loader 解析面单测（2026-10-14「dataplane 入口未导出 Config schema」同类债收敛）。
 *
 * 守卫的是**加载路径**，不是包内直调：patch 行只写 `enabled: true`，loader 只认
 * `lib/dataplane.js` 自己导出的 Config 补默认值（cordis resolveConfig）。缺它时行 config
 * 原样传入 → schema 默认值全丢 → apply 读到 undefined：行情服务读 config.apiKeyRef 时拿到 undefined，凭证解析落到自带兜底。
 *
 * 第二段（2026-10-15 凭据面收窄的收尾）：守卫**凭证来源**——设置中心
 * `dshtrading.credentials.polygon.apiKey` 优先、`apiKeyRef` 环境变量兜底，且解析惰性到每次请求
 * （settings 用户层加载晚于插件 apply，apply 期快照会落空）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig, type Context } from '@deepseek-ai/cordis'
import * as dataplane from '../src/dataplane.ts'
import {
  TRADING_US_MARKET_DATA_KEY,
  type Config as ConfigType,
} from '../src/index.ts'

interface Registration { market: string; provider: string; service: unknown }

/**
 * 形状合法的假 ctx：连接器对 router 包零依赖，故按鸭式消费面手搓注册表
 * （register 真实收集 + isolate 记录 realm 键），不引入通用 mock 工具。
 * `credential` 传 thunk（不是快照值），好让用例在 apply 之后改写设置中心凭证。
 */
function registryCtx(withTrade = true, credential?: () => Record<string, string> | undefined): {
  ctx: Context
  market: Registration[]
  trade: Registration[]
  isolated: string[]
} {
  const market: Registration[] = []
  const trade: Registration[] = []
  const isolated: string[] = []
  const marketRegistry = {
    register: (m: string, p: string, service: unknown) => {
      market.push({ market: m, provider: p, service })
      return () => {}
    },
  }
  const tradeRegistry = {
    register: (m: string, p: string, service: unknown) => {
      trade.push({ market: m, provider: p, service })
      return () => {}
    },
  }
  const ctx = {
    get: (key: string) => {
      if (key === 'tradingMarketDataRegistry') return marketRegistry
      if (key === 'tradingTradeRegistry' && withTrade) return tradeRegistry
      if (key === 'tradingMarketRouter' && credential !== undefined) {
        return { getCredential: (p: string) => (p === 'polygon' ? credential() : undefined) }
      }
      return undefined
    },
    isolate: (name: string) => {
      isolated.push(name)
      return { reflect: { provide: () => {} } }
    },
    effect: (fn: () => () => void) => { fn() },
    reflect: { provide: () => {} },
  } as unknown as Context
  return { ctx, market, trade, isolated }
}

/** loader.unwrapExports 语义：无 default 导出 → 模块命名空间自身即插件对象。 */
const plugin = (dataplane as unknown as { default?: unknown }).default ?? dataplane

describe('Polygon 连接器数据面行的 loader 解析面', () => {
  it('用户环境按子路径包名挂行时 dataplane 入口自己导出 apply 与 Config', () => {
    // Given: patch 行写 @dshtrading/connector-polygon/dataplane → loader 只读 lib/dataplane.js
    // When: 检查子入口导出面
    // Then: apply 与 Config 都在（缺 Config 时行 config 无 schema 可补默认值）
    expect(typeof dataplane.apply).toBe('function')
    expect(dataplane.Config).toBeDefined()
    expect(dataplane.inject).toEqual([])
  })

  it('用户 patch 行只写 `enabled: true` 时 loader 补全 schema 默认值', () => {
    // Given: us bundle 的行 config（`enabled: true`）
    // When: 按 cordis loader 语义解析行 config
    // Then: enabled 原样保留、apiKeyRef 取缺省名、dryRun 缺省 true
    const resolved = resolveConfig(plugin as never, { enabled: true }) as ConfigType
    expect(resolved.enabled).toBe(true)
    expect(resolved.apiKeyRef).toBe('POLYGON_API_KEY')
    expect(resolved.dryRun).toBe(true)
  })

  it('用户宿主挂载该行时 (us, polygon) 注册进行情注册表', () => {
    // Given: loader 解析后的行 config（真服务构造，不经假服务替身）
    // When: 挂载数据面行
    // Then: (us, polygon) 进行情注册表
    const resolved = resolveConfig(plugin as never, { enabled: true }) as ConfigType
    const { ctx, market, trade, isolated } = registryCtx()
    dataplane.apply(ctx, resolved)
    expect(market.map((r) => `${r.market}/${r.provider}`)).toEqual(['us/polygon'])
    expect(trade).toHaveLength(0)
    expect(isolated).toEqual([TRADING_US_MARKET_DATA_KEY])
  })

  it('用户手工构造 ctx 且不传 config 时按 schema 默认值挂载而不崩', () => {
    // Given: 单测/第三方宿主直接 apply 不传 config（loader 不参与补默认值）
    // When: 挂载数据面行
    // Then: 按 schema 默认值（enabled=true）注册行情服务
    const { ctx, market, trade } = registryCtx()
    expect(() => dataplane.apply(ctx)).not.toThrow()
    expect(market.map((r) => `${r.market}/${r.provider}`)).toEqual(['us/polygon'])
  })
})

/** 机器环境自带的 POLYGON_API_KEY 不得影响判定：用例内显式设值，收尾还原。 */
const originalApiKey = process.env.POLYGON_API_KEY
afterEach(() => {
  if (originalApiKey === undefined) delete process.env.POLYGON_API_KEY
  else process.env.POLYGON_API_KEY = originalApiKey
  delete process.env.POLYGON_CUSTOM_API_KEY
})

/**
 * 契约化传输替身：记录每次出网的 URL，回一份形状合法的 Polygon 上一交易日收盘聚合响应
 * （零 mock 工具，沿用包内 trade-gate.test.ts 的手写 stubFetch 手法）。
 * 须在 apply 之前装好——rest 客户端在构造期取 `globalThis.fetch`。
 */
function stubTransport(): { urls: string[]; restore: () => void } {
  const urls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: unknown) => {
    urls.push(String(input))
    return new Response(JSON.stringify({ ticker: 'AAPL', resultsCount: 1, results: [{ c: 1, v: 1, t: 1 }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  return { urls, restore: () => { globalThis.fetch = original } }
}

/** 经注册表里的**真服务**取一次报价；上游响应形状不是判据，判据是请求带没带设置中心那个 key。 */
async function fetchTicker(service: unknown): Promise<void> {
  const target = service as { getTicker(symbol: string): Promise<unknown> }
  await target.getTicker('AAPL').catch(() => undefined)
}

describe('Polygon 数据面行的凭证解析（与主入口同一份：设置中心优先、env 兜底、惰性）', () => {
  it('用户在设置页写入 Key 后，loader 路径下该 Key 生效且优先于环境变量', async () => {
    // Given: patch 行只写 enabled；设置页把 Key 写进 credentials.polygon.apiKey，同名环境变量另有不同值
    process.env.POLYGON_API_KEY = 'key-from-env'
    const transport = stubTransport()
    try {
      const { ctx, market } = registryCtx(true, () => ({ apiKey: 'key-from-settings' }))
      // When: 按 loader 语义解析行 config、挂载数据面行，并经注册表里的真服务取一次报价
      dataplane.apply(ctx, resolveConfig(plugin as never, { enabled: true }) as ConfigType)
      await fetchTicker(market[0].service)
      // Then: 出网 URL 的 apiKey 查询串带的是设置中心的 Key，不是同名环境变量
      expect(transport.urls).toHaveLength(1)
      expect(transport.urls[0]).toContain('apiKey=key-from-settings')
      expect(transport.urls[0]).not.toContain('key-from-env')
    } finally {
      transport.restore()
    }
  })

  it('用户未配置设置中心 Key 时，数据面行的凭证回落 apiKeyRef 指向的环境变量', async () => {
    // Given: 未配置 router 凭证，env 里只有 apiKeyRef 指向的自定义变量
    process.env.POLYGON_CUSTOM_API_KEY = 'key-from-custom-env'
    const transport = stubTransport()
    try {
      const { ctx, market } = registryCtx()
      // When: 行 config 换一个 apiKeyRef 后挂载并取一次报价
      dataplane.apply(ctx, resolveConfig(plugin as never, { enabled: true, apiKeyRef: 'POLYGON_CUSTOM_API_KEY' }) as ConfigType)
      await fetchTicker(market[0].service)
      // Then: 出网 URL 的 apiKey 查询串取自该环境变量
      expect(transport.urls).toHaveLength(1)
      expect(transport.urls[0]).toContain('apiKey=key-from-custom-env')
    } finally {
      transport.restore()
    }
  })

  it('用户在插件 apply 之后补上设置中心 Key，下一次请求即生效', async () => {
    // Given: 挂载时设置中心还没有凭证（settings 用户层加载晚于插件 apply），env 也没有
    delete process.env.POLYGON_API_KEY
    let credential: Record<string, string> | undefined
    const transport = stubTransport()
    try {
      const { ctx, market } = registryCtx(true, () => credential)
      dataplane.apply(ctx, resolveConfig(plugin as never, { enabled: true }) as ConfigType)
      // When: 首次请求无凭证，随后补上设置中心 Key 再取一次
      await fetchTicker(market[0].service)
      credential = { apiKey: 'key-settings-late' }
      await fetchTicker(market[0].service)
      // Then: 首次请求不带 apiKey 查询串、第二次带上补的 Key（apply 期没有落快照）
      expect(transport.urls).toHaveLength(2)
      expect(transport.urls[0]).not.toContain('apiKey=')
      expect(transport.urls[1]).toContain('apiKey=key-settings-late')
    } finally {
      transport.restore()
    }
  })
})

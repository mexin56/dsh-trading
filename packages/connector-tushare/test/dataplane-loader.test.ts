/**
 * 数据面行 loader 解析面单测（2026-10-14「dataplane 入口未导出 Config schema」同类债收敛）。
 *
 * 守卫的是**加载路径**，不是包内直调：patch 行只写 `enabled: true`，loader 只认
 * `lib/dataplane.js` 自己导出的 Config 补默认值（cordis resolveConfig）。缺它时行 config
 * 原样传入 → schema 默认值全丢 → apply 读到 undefined：行情服务读 config.tokenRef 时拿到 undefined，凭证解析落到自带兜底
 */
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig, type Context } from '@deepseek-ai/cordis'
import * as dataplane from '../src/dataplane.ts'
import {
  TRADING_CN_MARKET_DATA_KEY,
  type Config as ConfigType,
} from '../src/index.ts'

/** 机器环境自带的 TUSHARE_TOKEN 不得影响判定：用例内显式设值，收尾还原。 */
const originalToken = process.env.TUSHARE_TOKEN
afterEach(() => {
  if (originalToken === undefined) delete process.env.TUSHARE_TOKEN
  else process.env.TUSHARE_TOKEN = originalToken
  delete process.env.TUSHARE_CUSTOM_TOKEN
})

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
        return { getCredential: (p: string) => (p === 'tushare' ? credential() : undefined) }
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

/**
 * 契约化传输替身：记录每次出网请求体里的 token，回一份形状合法的 Tushare 响应
 * （零 mock 工具，沿用包内 trade-gate.test.ts 的手写 stubFetch 手法）。
 * 须在 apply 之前装好——rest 客户端在构造期取 `globalThis.fetch`。
 */
function stubTransport(): { tokens: Array<string | undefined>; restore: () => void } {
  const tokens: Array<string | undefined> = []
  const original = globalThis.fetch
  globalThis.fetch = (async (_input: unknown, init?: { body?: unknown }) => {
    tokens.push((JSON.parse(String(init?.body)) as { token?: string }).token)
    return new Response(JSON.stringify({
      code: 0,
      msg: null,
      data: {
        fields: ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol'],
        items: [['600519.SH', '20261014', 1, 1, 1, 1, 1]],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  return { tokens, restore: () => { globalThis.fetch = original } }
}

/** 经注册表里的**真服务**取一次日线：只有凭证解析到位，请求才会出网。 */
async function fetchKlines(service: unknown): Promise<void> {
  const target = service as { getKlines(symbol: string, interval: '1d', limit: number): Promise<unknown[]> }
  await target.getKlines('600519.SH', '1d', 1)
}

/** loader.unwrapExports 语义：无 default 导出 → 模块命名空间自身即插件对象。 */
const plugin = (dataplane as unknown as { default?: unknown }).default ?? dataplane

describe('Tushare 连接器数据面行的 loader 解析面', () => {
  it('用户环境按子路径包名挂行时 dataplane 入口自己导出 apply 与 Config', () => {
    // Given: patch 行写 @dshtrading/connector-tushare/dataplane → loader 只读 lib/dataplane.js
    // When: 检查子入口导出面
    // Then: apply 与 Config 都在（缺 Config 时行 config 无 schema 可补默认值）
    expect(typeof dataplane.apply).toBe('function')
    expect(dataplane.Config).toBeDefined()
    expect(dataplane.inject).toEqual([])
  })

  it('用户 patch 行只写 `enabled: true` 时 loader 补全 schema 默认值', () => {
    // Given: cn bundle 的行 config（`enabled: true`）
    // When: 按 cordis loader 语义解析行 config
    // Then: enabled 原样保留、tokenRef 取缺省名、dryRun 缺省 true
    const resolved = resolveConfig(plugin as never, { enabled: true }) as ConfigType
    expect(resolved.enabled).toBe(true)
    expect(resolved.tokenRef).toBe('TUSHARE_TOKEN')
    expect(resolved.dryRun).toBe(true)
  })

  it('用户宿主挂载该行时 (cn, tushare) 注册进行情注册表', () => {
    // Given: loader 解析后的行 config（真服务构造，不经假服务替身）
    // When: 挂载数据面行
    // Then: (cn, tushare) 进行情注册表
    const resolved = resolveConfig(plugin as never, { enabled: true }) as ConfigType
    const { ctx, market, trade, isolated } = registryCtx()
    dataplane.apply(ctx, resolved)
    expect(market.map((r) => `${r.market}/${r.provider}`)).toEqual(['cn/tushare'])
    expect(trade).toHaveLength(0)
    expect(isolated).toEqual([TRADING_CN_MARKET_DATA_KEY])
  })

  it('用户手工构造 ctx 且不传 config 时按 schema 默认值挂载而不崩', () => {
    // Given: 单测/第三方宿主直接 apply 不传 config（loader 不参与补默认值）
    // When: 挂载数据面行
    // Then: 按 schema 默认值（enabled=true）注册行情服务
    const { ctx, market, trade } = registryCtx()
    expect(() => dataplane.apply(ctx)).not.toThrow()
    expect(market.map((r) => `${r.market}/${r.provider}`)).toEqual(['cn/tushare'])
  })
})

describe('Tushare 数据面行的凭证解析（与主入口同一份：设置中心优先、env 兜底、惰性）', () => {
  it('用户在设置页写入 Token 后，loader 路径下该 Token 生效且优先于环境变量', async () => {
    // Given: patch 行只写 enabled；设置页把 Token 写进 credentials.tushare.token，env 另有不同值
    process.env.TUSHARE_TOKEN = 'tok-from-env'
    const transport = stubTransport()
    try {
      const { ctx, market } = registryCtx(true, () => ({ token: 'tok-from-settings' }))
      // When: 按 loader 语义解析行 config、挂载数据面行，并经注册表里的真服务取一次数
      dataplane.apply(ctx, resolveConfig(plugin as never, { enabled: true }) as ConfigType)
      await fetchKlines(market[0].service)
      // Then: 出网请求带的是设置中心的 Token
      expect(transport.tokens).toEqual(['tok-from-settings'])
    } finally {
      transport.restore()
    }
  })

  it('用户未配置设置中心凭证时，凭证回落 tokenRef 指向的环境变量', async () => {
    // Given: 未配置 router 凭证，env 里只有 tokenRef 指向的变量
    process.env.TUSHARE_CUSTOM_TOKEN = 'tok-from-custom-env'
    const transport = stubTransport()
    try {
      const { ctx, market } = registryCtx()
      // When: 行 config 换一个 tokenRef 后挂载并取数
      dataplane.apply(ctx, resolveConfig(plugin as never, { enabled: true, tokenRef: 'TUSHARE_CUSTOM_TOKEN' }) as ConfigType)
      await fetchKlines(market[0].service)
      // Then: 凭证取自该环境变量
      expect(transport.tokens).toEqual(['tok-from-custom-env'])
    } finally {
      transport.restore()
    }
  })

  it('用户在插件 apply 之后补上设置中心 Token，下一次请求即生效', async () => {
    // Given: 挂载时设置中心还没有凭证（settings 用户层加载晚于插件 apply）
    delete process.env.TUSHARE_TOKEN
    let credential: Record<string, string> | undefined
    const transport = stubTransport()
    try {
      const { ctx, market } = registryCtx(true, () => credential)
      dataplane.apply(ctx, resolveConfig(plugin as never, { enabled: true }) as ConfigType)
      // When: 首次请求无凭证（fail-closed 且不触网），随后补上设置中心 Token 再取一次
      await expect(fetchKlines(market[0].service)).rejects.toMatchObject({ code: 'TRADING_CREDENTIALS_MISSING' })
      credential = { token: 'tok-settings-late' }
      await fetchKlines(market[0].service)
      // Then: 只有第二次请求出网，带的是补上的 Token（无 apply 期快照）
      expect(transport.tokens).toEqual(['tok-settings-late'])
    } finally {
      transport.restore()
    }
  })
})

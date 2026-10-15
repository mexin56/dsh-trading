/**
 * 设置页凭据卡片字段 ⊆ 连接器真实消费面 的一致性守卫。
 *
 * 判据只有一个：连接器代码真的从设置字典里把那个键读出来，也就是
 * `tradingMarketRouter.getCredential('<provider>')?.<field>` 这条读点真的执行过。
 * 只读 env 的字段、或面板写了却无人读的字段，都是让用户以为配好了的纯承诺——两者的
 * 处置（撤字段 / 补消费点）与逐条对照见 src/client/trading-settings-controller.ts 的
 * `PROVIDER_CREDENTIAL_SPECS` 注释与
 * .agents/notes/implemented/simplification/2026-10-15-settings-credential-surface-narrowed.md。
 *
 * 手法照 test/provider-registration.test.ts 与 connector-jin10/test/plugin.test.ts 的体例：
 * 驱动**真**连接器模块，用鸭式 ctx 提供 router 读取面，credentials 记录是记录型 Proxy——
 * 每次属性读都记一笔（谁读了哪个键），值是指名道姓的哨兵。逐请求惰性解析的连接器
 * （okx/alpaca/tushare/jin10/hithink）用导出的解析函数或真服务方法触发；传输层是手写
 * Response 替身（与本包及 connector-tushare 的 dataplane-loader 用例同款，零 mock 工具）。
 *
 * 判据按**挂载路径**分别成立：同一连接器有「bundle 数据面行」与「preset 插件行」两条时，两条各
 * 挂载一次、各触发一次出网，并各自断言「面板字段被读 + 哨兵值进了这次请求」。只接一条路径的修
 * 复（2026-10-15 前 fmp/finnhub/polygon 的数据面行只读 env）在这里必红。
 * 单家 sourcing 的连接器（okx / alpaca / tushare / jin10 的数据面行与插件行共用同一个 resolve
 * 函数）仍只断言一次读出：它们的行级接线由各包自己的 dataplane loader 用例守，本表不重复挂载。
 */
import { describe, expect, it } from 'vitest'
import { resolveConfig, type Context } from '@deepseek-ai/cordis'
import * as okx from '@dshtrading/connector-okx'
import * as alpaca from '@dshtrading/connector-alpaca'
import * as fmp from '@dshtrading/connector-fmp'
import * as finnhub from '@dshtrading/connector-finnhub'
import * as polygon from '@dshtrading/connector-polygon'
import * as fmpDataplane from '@dshtrading/connector-fmp/dataplane'
import * as finnhubDataplane from '@dshtrading/connector-finnhub/dataplane'
import * as polygonDataplane from '@dshtrading/connector-polygon/dataplane'
import * as tushare from '@dshtrading/connector-tushare'
import * as longbridge from '@dshtrading/connector-longbridge'
import * as longbridgeDataplane from '@dshtrading/connector-longbridge/dataplane'
import * as tiger from '@dshtrading/connector-tiger'
import * as tigerDataplane from '@dshtrading/connector-tiger/dataplane'
import * as jin10Dataplane from '@dshtrading/connector-jin10/dataplane'
import * as hithinkDataplane from '@dshtrading/connector-hithink/dataplane'
import * as futuDataplane from '@dshtrading/connector-futu/dataplane'
import * as ibkrDataplane from '@dshtrading/connector-ibkr/dataplane'
import * as qmtDataplane from '@dshtrading/connector-qmt/dataplane'
import * as xyszDataplane from '@dshtrading/connector-xysz/dataplane'
import { PROVIDER_CREDENTIAL_SPECS, PROVIDER_LABELS } from '../src/client/trading-settings-controller.js'

/** 设置字典里某个键的哨兵值：读到了就能在断言里指名道姓。 */
function sentinel(provider: string, field: string): string {
  return `settings-${provider}-${field}`
}

/** 面板给某 provider 挂的凭据字段键（缺失 id 时空集合，让断言给出可读失败）。 */
function credentialKeys(provider: string): string[] {
  return (PROVIDER_CREDENTIAL_SPECS[provider] ?? []).map((field) => field.key)
}

interface CredentialProbe {
  /** 连接器真读过的键（每次属性读都记一笔）。 */
  readonly read: Set<string>
  /** 交给 router.getCredential 的记录：每个面板字段一个哨兵值。 */
  readonly record: Record<string, string>
}

/** 记录型 credentials 记录：读到的键进 read，值是指名道姓的哨兵。 */
function probeFor(provider: string, fields: readonly string[]): CredentialProbe {
  const read = new Set<string>()
  const values: Record<string, string> = {}
  for (const field of fields) values[field] = sentinel(provider, field)
  const record = new Proxy(values, {
    get: (target, key) => {
      if (typeof key === 'string') read.add(key)
      return Reflect.get(target, key)
    },
  })
  return { read, record }
}

interface Harness {
  ctx: Context
  /** 行情注册表收下的真服务实例。 */
  market: unknown[]
  /** 交易注册表收下的真服务实例。 */
  trade: unknown[]
  /** 插件行直接 provide 的根服务（Service 构造期经 ctx.reflect.provide 登记）。 */
  provided: Array<{ name: string; service: unknown }>
}

/**
 * 鸭式宿主 ctx：只提供连接器 apply / 解析函数真会旁查的那几个面
 * （tradingMarketRouter / 两个注册表 / isolate / effect / inject / tools），
 * 与 provider-registration.test.ts 同款，不引通用 mock 工具。
 * reflect.provide 记账：插件行（preset 面）把服务直接 provide 在根 ctx 上，
 * 那是除注册表之外取到真服务实例的唯一入口。
 */
function harness(provider: string, probe: CredentialProbe): Harness {
  const market: unknown[] = []
  const trade: unknown[] = []
  const provided: Array<{ name: string; service: unknown }> = []
  const provide = (name: string, service: unknown): void => { provided.push({ name, service }) }
  const registry = (rows: unknown[]) => ({
    register: (_market: string, _provider: string, service: unknown) => { rows.push(service); return () => {} },
  })
  const ctx: Record<string, unknown> = {}
  ctx.get = (key: string) => {
    if (key === 'tradingMarketRouter') {
      return {
        getCredential: (p: string) => (p === provider ? probe.record : undefined),
        activeProvider: () => provider,
        watch: () => () => {},
      }
    }
    if (key === 'tradingMarketDataRegistry') return registry(market)
    if (key === 'tradingTradeRegistry') return registry(trade)
    return undefined
  }
  ctx.isolate = () => ({ reflect: { provide }, get: ctx.get })
  ctx.effect = (fn: () => () => void) => { fn() }
  ctx.inject = (_deps: string[], cb: (scoped: unknown) => void) => { cb(ctx) }
  ctx.reflect = { provide }
  ctx.tools = { register: () => {}, get: () => undefined }
  return { ctx: ctx as unknown as Context, market, trade, provided }
}

/** loader.unwrapExports 语义：无 default 导出 → 模块命名空间自身即插件对象。 */
function pluginOf(mod: unknown): unknown {
  return (mod as { default?: unknown }).default ?? mod
}

/** loader 语义的行 config（补 schema 默认值的那一份）。 */
function rowConfig(mod: unknown): unknown {
  return resolveConfig(pluginOf(mod) as never, { enabled: true })
}

/** 驱动一个连接器模块的 apply 行（真插件对象 + 补全默认值的行 config）。 */
function mount(mod: unknown, ctx: Context): void {
  const plugin = pluginOf(mod) as { apply: (ctx: Context, config: unknown) => void }
  plugin.apply(ctx, rowConfig(mod))
}

interface RecordedRequest {
  url: string
  headers: Record<string, string>
}

/**
 * 契约化传输替身：记录每次出网的 URL 与请求头，回一份形状合法但内容为空的 JSON
 * （零 mock 工具，沿用手写替身手法；须在 apply 之前装好——rest 客户端构造期取 globalThis.fetch）。
 */
async function withStubTransport<T>(run: (requests: RecordedRequest[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  const requests: RecordedRequest[] = []
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    requests.push({ url: String(input), headers: init?.headers ?? {} })
    return new Response(JSON.stringify({ code: 0, msg: null, data: { fields: [], items: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  try {
    return await run(requests)
  } finally {
    globalThis.fetch = original
  }
}

/** 从已登记的真服务里取出行情服务（注册表里的，或插件行 provide 在根 ctx 上的）。 */
function marketDataOf(target: Harness): { getTicker(symbol: string): Promise<unknown> } {
  const candidates = [...target.market, ...target.provided.map((row) => row.service)]
  const service = candidates.find((candidate) => typeof (candidate as { getTicker?: unknown } | undefined)?.getTicker === 'function')
  if (service === undefined) throw new Error('连接器没有提供带 getTicker 的行情服务（apply 面接线变了？）')
  return service as { getTicker(symbol: string): Promise<unknown> }
}

/**
 * 触发一次出网。上游响应形状不是本用例的判据（服务可能在解析处抛结构化错误）——
 * 判据是请求本身带没带设置字典里那个哨兵值。
 */
async function requestOnce(service: { getTicker(symbol: string): Promise<unknown> }, symbol: string): Promise<void> {
  await service.getTicker(symbol).catch(() => undefined)
}

/** 有凭据卡片的 provider 全集：新增一条规格就必须同时补一条消费点用例。 */
const COVERED_PROVIDERS = [
  'alpaca', 'finnhub', 'fmp', 'hithink', 'jin10', 'longbridge', 'okx', 'polygon', 'tiger', 'tushare',
]

/** configField 提示指向的连接器模块（该字段必须真出现在它 resolved 的 Config 里）。 */
const CONFIG_MODULES: Record<string, unknown> = {
  futu: futuDataplane,
  ibkr: ibkrDataplane,
  qmt: qmtDataplane,
  xysz: xyszDataplane,
}

describe('设置页凭据卡片字段与连接器消费面一致', () => {
  it('用户打开加密设置时 okx 的三件凭证都从设置字典读出', async () => {
    // Given: 面板 okx 的三个字段在设置字典里各有一个哨兵值
    const fields = credentialKeys('okx')
    const probe = probeFor('okx', fields)
    const { ctx } = harness('okx', probe)
    // When: 驱动连接器真实的凭证解析（数据面与 preset 行共用同一个 resolveCredentials）
    const credentials = await okx.resolveCredentials(ctx, rowConfig(okx) as never)
    // Then: 每个面板键都被读过，哨兵值原样进到签名用的三件凭证里
    expect([...probe.read].sort()).toEqual([...fields].sort())
    expect(credentials).toEqual({
      key: sentinel('okx', 'apiKey'),
      secret: sentinel('okx', 'secretKey'),
      passphrase: sentinel('okx', 'passphrase'),
    })
  })

  it('用户打开美股 Alpaca 设置时 apiKey/secretKey 都从设置字典读出', async () => {
    // Given: 面板 alpaca 的两个字段在设置字典里各有一个哨兵值
    const fields = credentialKeys('alpaca')
    const probe = probeFor('alpaca', fields)
    const { ctx } = harness('alpaca', probe)
    // When: 驱动连接器真实的凭证解析（dataplane 的惰性闭包调的就是它）
    const refs = alpaca.credentialRefsFor(rowConfig(alpaca) as never, 'live')
    const credentials = await alpaca.resolveCredentials(ctx, refs, 'live')
    // Then: 面板键（含面板用的键名 secretKey）都被读过，哨兵值进到客户端要的两件凭证
    expect([...probe.read].sort()).toEqual([...fields].sort())
    expect(credentials).toEqual({ key: sentinel('alpaca', 'apiKey'), secret: sentinel('alpaca', 'secretKey') })
  })

  it('用户打开美股 FMP 设置时 apiKey 在数据面行与插件行都从设置字典读出并进到上游请求', async () => {
    // Given: 面板 fmp 的 apiKey 在设置字典里有一个哨兵值（两条挂载路径各一份记录）
    const fields = credentialKeys('fmp')
    const dataplaneProbe = probeFor('fmp', fields)
    const pluginProbe = probeFor('fmp', fields)
    const dataplaneHarness = harness('fmp', dataplaneProbe)
    const pluginHarness = harness('fmp', pluginProbe)
    // When: 分别挂载 us bundle 的数据面行与 preset 用的插件行，并各触发一次行情请求
    await withStubTransport(async (requests) => {
      mount(fmpDataplane, dataplaneHarness.ctx)
      mount(fmp, pluginHarness.ctx)
      await requestOnce(marketDataOf(dataplaneHarness), 'AAPL')
      await requestOnce(marketDataOf(pluginHarness), 'AAPL')
      // Then: 两条挂载路径**各自**都把面板键读出来，且各自的出网 URL 都带上哨兵值
      //       （任一路径退回只读 env 都在这里失败）
      expect([...dataplaneProbe.read].sort()).toEqual([...fields].sort())
      expect([...pluginProbe.read].sort()).toEqual([...fields].sort())
      expect(requests.filter((request) => request.url.includes(sentinel('fmp', 'apiKey')))).toHaveLength(2)
    })
  })

  it('用户打开美股 Finnhub 设置时 apiKey 在数据面行与插件行都从设置字典读出并进到上游请求', async () => {
    // Given: 面板 finnhub 的 apiKey 在设置字典里有一个哨兵值（两条挂载路径各一份记录）
    const fields = credentialKeys('finnhub')
    const dataplaneProbe = probeFor('finnhub', fields)
    const pluginProbe = probeFor('finnhub', fields)
    const dataplaneHarness = harness('finnhub', dataplaneProbe)
    const pluginHarness = harness('finnhub', pluginProbe)
    // When: 分别挂载 us bundle 的数据面行与 preset 用的插件行，并各触发一次行情请求
    await withStubTransport(async (requests) => {
      mount(finnhubDataplane, dataplaneHarness.ctx)
      mount(finnhub, pluginHarness.ctx)
      await requestOnce(marketDataOf(dataplaneHarness), 'AAPL')
      await requestOnce(marketDataOf(pluginHarness), 'AAPL')
      // Then: 两条挂载路径**各自**都把面板键读出来，且各自的出网 URL 都带上哨兵值
      expect([...dataplaneProbe.read].sort()).toEqual([...fields].sort())
      expect([...pluginProbe.read].sort()).toEqual([...fields].sort())
      expect(requests.filter((request) => request.url.includes(sentinel('finnhub', 'apiKey')))).toHaveLength(2)
    })
  })

  it('用户打开美股 Polygon 设置时 apiKey 在数据面行与插件行都从设置字典读出并进到上游请求', async () => {
    // Given: 面板 polygon 的 apiKey 在设置字典里有一个哨兵值（两条挂载路径各一份记录）
    const fields = credentialKeys('polygon')
    const dataplaneProbe = probeFor('polygon', fields)
    const pluginProbe = probeFor('polygon', fields)
    const dataplaneHarness = harness('polygon', dataplaneProbe)
    const pluginHarness = harness('polygon', pluginProbe)
    // When: 分别挂载 us bundle 的数据面行与 preset 用的插件行，并各触发一次行情请求
    await withStubTransport(async (requests) => {
      mount(polygonDataplane, dataplaneHarness.ctx)
      mount(polygon, pluginHarness.ctx)
      await requestOnce(marketDataOf(dataplaneHarness), 'AAPL')
      await requestOnce(marketDataOf(pluginHarness), 'AAPL')
      // Then: 两条挂载路径**各自**都把面板键读出来，且各自的出网 URL 都带上哨兵值
      expect([...dataplaneProbe.read].sort()).toEqual([...fields].sort())
      expect([...pluginProbe.read].sort()).toEqual([...fields].sort())
      expect(requests.filter((request) => request.url.includes(sentinel('polygon', 'apiKey')))).toHaveLength(2)
    })
  })

  it('用户打开 A 股 Tushare 设置时 token 从设置字典读出', () => {
    // Given: 面板 tushare 的 token 在设置字典里有一个哨兵值
    const fields = credentialKeys('tushare')
    const probe = probeFor('tushare', fields)
    const { ctx } = harness('tushare', probe)
    // When: 驱动连接器真实的凭证源（dataplane 构造的服务持有的就是它）
    const token = tushare.createTokenProvider(ctx, 'TUSHARE_TOKEN')()
    // Then: 面板键被读过，哨兵值原样作为 token 返回
    expect([...probe.read]).toEqual(fields)
    expect(token).toBe(sentinel('tushare', 'token'))
  })

  it('用户打开港股 Longbridge 设置时三件凭证在行情面与 preset 面都从设置字典读出', () => {
    // Given: 面板 longbridge 的三个字段在设置字典里各有一个哨兵值（两条挂载路径各一份记录）
    const fields = credentialKeys('longbridge')
    const dataplaneProbe = probeFor('longbridge', fields)
    const pluginProbe = probeFor('longbridge', fields)
    // When: 分别挂载 hk bundle 的数据面行与 preset 用的插件行
    const dataplaneHarness = harness('longbridge', dataplaneProbe)
    const pluginHarness = harness('longbridge', pluginProbe)
    mount(longbridgeDataplane, dataplaneHarness.ctx)
    mount(longbridge, pluginHarness.ctx)
    // Then: 两条挂载路径**各自**都把三个面板键读出来（任一路径退回只读 env 都在这里失败）；
    //       数据面行落注册表、插件行 provide 出带签名的交易服务
    expect([...dataplaneProbe.read].sort()).toEqual([...fields].sort())
    expect([...pluginProbe.read].sort()).toEqual([...fields].sort())
    expect(dataplaneHarness.market).toHaveLength(1)
    expect(pluginHarness.provided.filter((row) => typeof (row.service as { placeOrder?: unknown } | undefined)?.placeOrder === 'function')).toHaveLength(1)
  })

  it('用户打开港股 Tiger 设置时 RSA 私钥在行情面与 preset 面都从设置字典读出', () => {
    // Given: 面板 tiger 的 privateKey 在设置字典里有一个哨兵值（两条挂载路径各一份记录）
    const fields = credentialKeys('tiger')
    const dataplaneProbe = probeFor('tiger', fields)
    const pluginProbe = probeFor('tiger', fields)
    // When: 分别挂载 hk bundle 的数据面行与 preset 用的插件行
    const dataplaneHarness = harness('tiger', dataplaneProbe)
    const pluginHarness = harness('tiger', pluginProbe)
    mount(tigerDataplane, dataplaneHarness.ctx)
    mount(tiger, pluginHarness.ctx)
    // Then: 两条挂载路径**各自**都把 privateKey 读出来并交给客户端（RSA2 签名用）
    expect([...dataplaneProbe.read].sort()).toEqual([...fields].sort())
    expect([...pluginProbe.read].sort()).toEqual([...fields].sort())
    expect(dataplaneHarness.market).toHaveLength(1)
    expect(pluginHarness.provided.length).toBeGreaterThan(0)
  })

  it('用户打开全球品种设置时金十 token 从设置字典读出并进到 MCP 请求', async () => {
    // Given: 面板 jin10 的 token 在设置字典里有一个哨兵值
    const fields = credentialKeys('jin10')
    const probe = probeFor('jin10', fields)
    const target = harness('jin10', probe)
    // When: 挂载真连接器数据面行并触发一次行情请求（MCP 请求的 Authorization 头）
    await withStubTransport(async (requests) => {
      mount(jin10Dataplane, target.ctx)
      await requestOnce(marketDataOf(target), 'XAUUSD')
      // Then: 面板键被读过，且哨兵值出现在出网请求的 Authorization 头里
      expect([...probe.read].sort()).toEqual([...fields].sort())
      expect(requests.map((request) => String(request.headers.authorization)).join(' ')).toContain(sentinel('jin10', 'token'))
    })
  })

  it('用户打开 A 股同花顺设置时 apiKey 从设置字典读出并进到请求头', async () => {
    // Given: 面板 hithink 的 apiKey 在设置字典里有一个哨兵值
    const fields = credentialKeys('hithink')
    const probe = probeFor('hithink', fields)
    const target = harness('hithink', probe)
    // When: 挂载真连接器数据面行并触发一次行情请求
    await withStubTransport(async (requests) => {
      mount(hithinkDataplane, target.ctx)
      await requestOnce(marketDataOf(target), '600519.SH')
      // Then: 面板键被读过，且哨兵值出现在出网请求的 X-api-key 头里
      expect([...probe.read].sort()).toEqual([...fields].sort())
      expect(requests.map((request) => String(request.headers['X-api-key'])).join(' ')).toContain(sentinel('hithink', 'apiKey'))
    })
  })

  it('用户看到凭据卡片时每个挂凭据字段的 provider 都有消费点用例覆盖', () => {
    // Given: 面板规格表与用例覆盖表
    // When: 比对两边的 provider 集合
    // Then: 两边相等——新增挂凭据字段的 provider 必须同时补消费点与用例，否则面板又会出现纯承诺
    expect(Object.keys(PROVIDER_CREDENTIAL_SPECS).sort()).toEqual([...COVERED_PROVIDERS].sort())
    expect(COVERED_PROVIDERS.flatMap((provider) => credentialKeys(provider)).length).toBeGreaterThan(0)
  })

  it('用户看到 provider 卡片的环境变量提示时那个提示是环境变量名而不是配置项名', () => {
    // Given: PROVIDER_LABELS 全表里带 env 提示的条目
    const withEnv = PROVIDER_LABELS.filter((provider) => provider.env !== undefined)
    // When: 检查槽位取值形状（配置项名如 gatewayUrl 是小驼峰，与 env 名形状互斥）
    // Then: 每条都是合法的环境变量名形状（混合槽位会把配置项名漏进这个槽）
    expect(withEnv.length).toBeGreaterThan(0)
    expect(withEnv.filter((provider) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.env ?? '')).map((provider) => provider.id)).toEqual([])
  })

  it('用户看到 provider 卡片的配置项提示时那个字段真在连接器 Config 里', () => {
    // Given: PROVIDER_LABELS 全表里带 configField 提示的条目与它们各自的连接器模块
    const withField = PROVIDER_LABELS.filter((provider) => provider.configField !== undefined)
    // When: 按 loader 语义解析各连接器行的 config（schema 默认值来自该模块导出的 Config）
    const resolved = withField.map((provider) => ({
      id: provider.id,
      field: provider.configField,
      keys: Object.keys((CONFIG_MODULES[provider.id] === undefined ? {} : rowConfig(CONFIG_MODULES[provider.id])) as Record<string, unknown>),
    }))
    // Then: 每个提示的字段名都真出现在对应连接器 resolved 的 Config 键里（提示不能指向不存在的配置面）
    expect(withField.length).toBeGreaterThan(0)
    expect(resolved.filter((row) => !row.keys.includes(row.field ?? '')).map((row) => row.id)).toEqual([])
  })
})

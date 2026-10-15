/**
 * IBKR 账户读面的失败关闭语义：本包已有真实 ledger 读面（余额/持仓转发网关
 * `/portfolio/{acc}/ledger`、`/portfolio/{acc}/positions/0`），但缺「按 (symbol, id)
 * 取单」的网关端点与工具，而 `@dshtrading/api` 的 `TradeService.getOrder` 是**必选**方法
 * （packages/api/src/index.ts:839）——必须显式拒绝：返回空值、空数组或编造订单都会被
 * base 的账户工具与 GUI 桥读成「订单不存在」。非契约方法 `getOrders`（曾是恒返回空数组的
 * 本地伪读面）已删除。
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { IbkrTradeService, type Config } from '../src/index.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 真实网关的替身：只回放进程里声明的端点，并把请求 URL 记账给用例断言（非 mock 库）。 */
function stubFetch(routes: Array<{ match: string; body: unknown }>) {
  const urls: string[] = []
  const impl = (async (input: unknown) => {
    const url = String(input)
    urls.push(url)
    const route = routes.find((r) => url.includes(r.match))
    if (!route) throw new Error(`unexpected request: ${url}`)
    return jsonResponse(route.body)
  }) as typeof fetch
  return { impl, urls }
}

/** 缺省账户 U123 的网关回包：余额账本与美股持仓（形状同 test/template.test.ts 的锁定值）。 */
function ibkrTrade(overrides: Partial<Config> = {}) {
  const { impl, urls } = stubFetch([
    {
      match: '/portfolio/U123/ledger',
      body: { USD: { cashbalance: 45000.25, netliquidationvalue: 120000.5, currency: 'USD' } },
    },
    {
      match: '/portfolio/U123/positions/0',
      body: [{ ticker: 'NVDA', position: 50, avgPrice: 110.5, unrealizedPnl: 1500.0 }],
    },
  ])
  const config: Config = {
    enabled: true,
    env: 'demo',
    dryRun: true,
    liveTrading: false,
    accountId: 'U123',
    ...overrides,
  }
  // Service 基类需要活的 cordis context（test/trade-gate.test.ts 同款构造）。
  const trade = new IbkrTradeService(new CordisContext() as never, { accountId: 'U123', fetchImpl: impl, config })
  return { trade, urls }
}

describe('IbkrTradeService 账户读面（缺单笔订单端点 ⇒ 失败关闭）', () => {
  it('运营者按订单号查询 IBKR 订单：显式拒绝，不得声称订单不存在', async () => {
    // Given: 一个按契约装配、且具备真实网关 ledger 读面的 IBKR 交易服务
    const { trade } = ibkrTrade()
    // When: 消费方按 (symbol, orderId) 查询单笔订单
    // Then: 抛 TRADING_NOT_IMPLEMENTED，且文案写明「不可用」而不是「订单不存在」
    await expect(trade.getOrder('AAPL', 'ibkr-ord-777')).rejects.toMatchObject({
      code: 'TRADING_NOT_IMPLEMENTED',
    })
    await expect(trade.getOrder('AAPL', 'ibkr-ord-777')).rejects.toThrow(/NOT "order not found"/)
  })

  it('运营者调用非契约的 getOrders：方法已删除，不再用空数组冒充没有挂单', () => {
    // Given: 一个按契约装配的 IBKR 交易服务
    const { trade } = ibkrTrade()
    // When: 消费方探测旧的非契约方法
    const probe = trade as unknown as Record<string, unknown>
    // Then: getOrders 缺席——不是返回 []（[] 会被读成「确实没有挂单」）
    expect(probe.getOrders).toBeUndefined()
    expect('getOrders' in trade).toBe(false)
  })

  it('运营者读取挂单/成交/余额列表：可选方法缺席，消费方按可选方法缺席处理', () => {
    // Given: 一个按契约装配的 IBKR 交易服务
    const { trade } = ibkrTrade()
    // When: 消费方探测 TradeService 的可选读方法
    const probe = trade as unknown as Record<string, unknown>
    // Then: getBalances / listOpenOrders / listTradeFills 三者都缺席
    expect(probe.getBalances).toBeUndefined()
    expect(probe.listOpenOrders).toBeUndefined()
    expect(probe.listTradeFills).toBeUndefined()
    expect('getBalances' in trade).toBe(false)
    expect('listOpenOrders' in trade).toBe(false)
    expect('listTradeFills' in trade).toBe(false)
  })

  it('运营者读取余额与持仓：真实网关 ledger 转发不受本次改动影响', async () => {
    // Given: 一个按契约装配的 IBKR 交易服务（账户 U123）
    const { trade, urls } = ibkrTrade()
    // When: 消费方按契约请求账户余额与持仓
    const balance = await trade.getBalance()
    const positions = await trade.getPositions()
    // Then: 两次请求分别打到真实网关端点，返回值原样透出（未因补 getOrder 而改道）
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('/portfolio/U123/ledger')
    expect(urls[1]).toContain('/portfolio/U123/positions/0')
    expect(balance).toEqual({ currency: 'USD', available: 45000.25, total: 120000.5 })
    expect(positions).toEqual([{ symbol: 'NVDA', quantity: 50, entryPrice: 110.5, unrealizedPnl: 1500.0 }])
  })
})

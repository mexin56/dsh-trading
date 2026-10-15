/**
 * Futu 账户读面的失败关闭语义：本包只有资金一格真实读路径（`/api/trd/get-funds`），
 * 持仓与单笔订单没有私有账户读实现——这两格必须显式拒绝，不得用空数组或常量对象
 * 冒充交易所账户真值。base 的账户工具与 GUI 桥把同一注册面当「交易所账户真值」消费
 * （packages/base/src/market-tools.ts、packages/bot-api/src/bridge.ts），空数组会被读成
 * 「没有持仓」、常量对象会被读成「订单存在」；契约语义是 TRADING_NOT_IMPLEMENTED（不可用）。
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { FutuRestClient } from '../src/rest.js'
import { FutuTradeService, type Config } from '../src/index.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 桥的真形态回执（`/api/trd/get-funds`），只用于回归真实资金读路径。 */
function fundsFetch(): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input)
    if (!url.includes('/api/trd/get-funds')) throw new Error(`unexpected request: ${url}`)
    return jsonResponse({ retType: 0, data: { currency: 'HKD', cash: 200000, frozenCash: 50000, totalAssets: 500000 } })
  }) as typeof fetch
}

function futuTrade(overrides: Partial<Config> = {}, fetchImpl: typeof fetch = fundsFetch()): FutuTradeService {
  const config: Config = {
    enabled: true,
    gatewayUrl: 'http://futu.test',
    dryRun: true,
    liveTrading: false,
    unlockPwdRef: 'FUTU_UNLOCK_PWD',
    accId: 90000001,
    ...overrides,
  }
  return new FutuTradeService(new CordisContext() as never, {
    client: new FutuRestClient({ gatewayUrl: config.gatewayUrl, fetchImpl, accId: config.accId, market: 'hk' }),
    config,
  })
}

describe('FutuTradeService 账户读面（无持仓/单笔订单读实现 ⇒ 失败关闭）', () => {
  it('运营者读取 Futu 余额：可选方法缺席，消费方按「可选方法缺席」处理', () => {
    // Given: 一个按契约装配的 Futu 交易服务（无可选读方法实现）
    const trade = futuTrade()
    // When: 消费方探测可选读方法是否存在
    // Then: getBalances 缺席——不是把上游故障折成 [] 的假余额
    const probe = trade as unknown as Record<string, unknown>
    expect(probe.getBalances).toBeUndefined()
    expect('getBalances' in trade).toBe(false)
  })

  it('运营者读取 Futu 成交明细：可选方法缺席，不得用空数组冒充没有成交', () => {
    // Given: 一个按契约装配的 Futu 交易服务
    const trade = futuTrade()
    // When: 消费方探测可选读方法是否存在
    // Then: listTradeFills 缺席，消费方走「可选方法缺席」语义
    const probe = trade as unknown as Record<string, unknown>
    expect(probe.listTradeFills).toBeUndefined()
    expect('listTradeFills' in trade).toBe(false)
  })

  it('运营者读取 Futu 持仓：必需方法显式拒绝，不得返回空数组', async () => {
    // Given: 一个按契约装配的 Futu 交易服务
    const trade = futuTrade()
    // When: 消费方按 TradeService 契约请求持仓
    // Then: 抛 TRADING_NOT_IMPLEMENTED，且文案说明不可用不等于没有持仓
    await expect(trade.getPositions()).rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    await expect(trade.getPositions()).rejects.toThrow(/NOT "no positions"/)
  })

  it('运营者按订单号查询 Futu 订单：显式拒绝，不得编造状态为 new 的订单', async () => {
    // Given: 一个按契约装配的 Futu 交易服务
    const trade = futuTrade()
    // When: 消费方按 (symbol, orderId) 查询单笔订单
    // Then: 抛 TRADING_NOT_IMPLEMENTED，且文案说明不可用不等于订单不存在
    await expect(trade.getOrder('00700.HK', '9769893')).rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    await expect(trade.getOrder('00700.HK', '9769893')).rejects.toThrow(/NOT "order not found"/)
  })

  it('运营者读取 Futu 资金：唯一真实读路径不被误伤，仍返回 AccountBalance 契约形状', async () => {
    // Given: 桥对 /api/trd/get-funds 回一行真形态资金
    // When: 消费方按契约读取单一账户余额
    const balance = await futuTrade().getBalance()
    // Then: 返回 {asset,free,locked} 真值，而不是 TRADING_NOT_IMPLEMENTED
    expect(balance).toEqual({ asset: 'HKD', free: 200000, locked: 50000 })
  })
})

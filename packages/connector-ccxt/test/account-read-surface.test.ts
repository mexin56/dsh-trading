/**
 * CCXT 账户读面的失败关闭语义：本包没有签名私有账户读实现（也没有凭证字段），
 * 读面必须显式拒绝，不得用常量余额、空数组或编造订单冒充交易所账户真值——base 的
 * <market>_get_* 工具与 GUI 桥按「交易所账户真值」消费同一注册面
 * （packages/base/src/market-tools.ts、packages/bot-api/src/bridge.ts）。
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { CcxtTradeService, type Config } from '../src/index.js'

function ccxtTrade(overrides: Partial<Config> = {}): CcxtTradeService {
  const config: Config = {
    enabled: true,
    dryRun: true,
    liveTrading: false,
    defaultExchange: 'binance',
    ...overrides,
  }
  // Service 基类需要活的 cordis context（connector-okx trade.test.ts 同款构造）。
  return new CcxtTradeService(new CordisContext() as never, { exchange: 'binance', config })
}

describe('CcxtTradeService 账户读面（无签名实现 ⇒ 失败关闭）', () => {
  it('运营者读取 CCXT 余额：非契约的常量余额方法已缺席，不再回 100000 USDT', () => {
    // Given: 一个按契约装配的 CCXT 交易服务（无签名私有读实现、无凭证字段）
    const trade = ccxtTrade()
    // When: 消费方探测非契约的 getBalance 是否还存在
    // Then: 缺席——契约里的余额入口是可选 getBalances，消费方按「可选方法缺席」处理
    const probe = trade as unknown as Record<string, unknown>
    expect(typeof probe.getBalance !== 'function').toBe(true)
    expect(probe.getBalance).toBeUndefined()
    expect('getBalance' in trade).toBe(false)
  })

  it('运营者读取 CCXT 挂单与成交：可选方法缺席，不得用空数组冒充没有挂单', () => {
    // Given: 一个按契约装配的 CCXT 交易服务
    const trade = ccxtTrade()
    // When: 消费方探测可选读方法是否存在
    // Then: getBalances / listOpenOrders / listTradeFills 都缺席
    const probe = trade as unknown as Record<string, unknown>
    expect(probe.getBalances).toBeUndefined()
    expect(probe.listOpenOrders).toBeUndefined()
    expect(probe.listTradeFills).toBeUndefined()
    expect('getBalances' in trade).toBe(false)
    expect('listOpenOrders' in trade).toBe(false)
    expect('listTradeFills' in trade).toBe(false)
  })

  it('运营者读取 CCXT 持仓：必需方法显式拒绝，不得返回空数组', async () => {
    // Given: 一个按契约装配的 CCXT 交易服务
    const trade = ccxtTrade()
    // When: 消费方按 TradeService 契约请求持仓
    // Then: 抛 TRADING_NOT_IMPLEMENTED，且文案说明不可用不等于没有持仓
    await expect(trade.getPositions()).rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    await expect(trade.getPositions()).rejects.toThrow(/NOT "no positions"/)
  })

  it('运营者按订单号查询 CCXT 订单：显式拒绝，不得编造订单或恒回空数组', async () => {
    // Given: 一个按契约装配的 CCXT 交易服务
    const trade = ccxtTrade()
    // When: 消费方按 (symbol, orderId) 查询单笔订单
    // Then: 抛 TRADING_NOT_IMPLEMENTED，且文案说明不可用不等于订单不存在
    await expect(trade.getOrder('BTCUSDT', 'ord-1')).rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    await expect(trade.getOrder('BTCUSDT', 'ord-1')).rejects.toThrow(/NOT "order not found"/)
    // Then: 非契约的 getOrders 恒空数组入口也已缺席
    expect((trade as unknown as Record<string, unknown>).getOrders).toBeUndefined()
  })

  it('运营者以未授权配置撤单：三态闸门未被误伤，仍抛 TRADING_LIVE_TRADING_DISABLED', async () => {
    // Given: 一个缺省配置（dryRun=true、liveTrading=false）的 CCXT 交易服务
    const trade = ccxtTrade()
    // When: 直调服务缝撤单（绕过工具层的调用面）
    // Then: 与改动前一致——结构化拒绝，语义是实盘动作未获授权
    await expect(trade.cancelOrder('ord-1')).rejects.toMatchObject({ code: 'TRADING_LIVE_TRADING_DISABLED' })
  })
})

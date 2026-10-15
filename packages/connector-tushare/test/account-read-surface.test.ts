/**
 * Tushare 账户读面的失败关闭语义：Tushare 是行情数据服务，本连接器从来没有账户通道
 * （rest 层的 placeOrder / cancelOrder 只是本地合成回执），读面必须显式拒绝，不得用
 * 常量余额、空数组或编造订单冒充账户真值——base 的 <market>_get_* 工具与 GUI 桥按
 * 「账户真值」消费同一注册面（packages/base/src/market-tools.ts、packages/bot-api/src/bridge.ts）。
 * 同款裁决见 .agents/notes/implemented/simplification/2026-10-10-fabricated-trade-surface-fail-closed.md。
 */
import { Context as CordisContext } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { TushareTradeService, type Config } from '../src/index.js'

function tushareTrade(overrides: Partial<Config> = {}): TushareTradeService {
  const config: Config = {
    enabled: true,
    dryRun: true,
    liveTrading: false,
    tokenRef: 'TUSHARE_TOKEN',
    ...overrides,
  }
  return new TushareTradeService(new CordisContext() as never, { token: 't', config })
}

describe('TushareTradeService 账户读面（无账户通道 ⇒ 失败关闭）', () => {
  it('运营者读取 Tushare 余额：非契约方法缺席，不再有返回 1000000 CNY 的编造余额', () => {
    // Given: 一个按契约装配的 Tushare 交易服务（连接器没有账户通道）
    const trade = tushareTrade()
    // When: 消费方探测非契约读方法是否存在
    // Then: getBalance 缺席——不是返回常量 1000000 CNY 的假余额
    const probe = trade as unknown as Record<string, unknown>
    expect(probe.getBalance).toBeUndefined()
    expect(typeof (trade as unknown as { getBalance?: unknown }).getBalance).not.toBe('function')
  })

  it('运营者读取 Tushare 持仓：必需方法显式拒绝，不得返回空数组冒充没有持仓', async () => {
    // Given: 一个按契约装配的 Tushare 交易服务
    const trade = tushareTrade()
    // When: 消费方按 TradeService 契约请求持仓
    // Then: 抛 TRADING_NOT_IMPLEMENTED，且文案说明不可用不等于没有持仓
    await expect(trade.getPositions()).rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    await expect(trade.getPositions()).rejects.toThrow(/NOT "no positions"/)
  })

  it('运营者按订单号查询 Tushare 订单：显式拒绝，不得编造为已存在的订单', async () => {
    // Given: 一个按契约装配的 Tushare 交易服务
    const trade = tushareTrade()
    // When: 消费方按 (symbol, orderId) 查询单笔订单
    // Then: 抛 TRADING_NOT_IMPLEMENTED，且文案说明不可用不等于订单不存在
    await expect(trade.getOrder('600519.SH', 'ord-1')).rejects.toMatchObject({ code: 'TRADING_NOT_IMPLEMENTED' })
    await expect(trade.getOrder('600519.SH', 'ord-1')).rejects.toThrow(/NOT "order not found"/)
  })

  it('运营者读取 Tushare 挂单、成交与多币种余额：可选方法缺席，消费方按缺席语义处理', () => {
    // Given: 一个按契约装配的 Tushare 交易服务
    const trade = tushareTrade()
    // When: 消费方探测可选读方法是否存在
    // Then: getOrders / getBalances / listOpenOrders / listTradeFills 都缺席
    const probe = trade as unknown as Record<string, unknown>
    expect(probe.getOrders).toBeUndefined()
    expect(probe.getBalances).toBeUndefined()
    expect(probe.listOpenOrders).toBeUndefined()
    expect(probe.listTradeFills).toBeUndefined()
  })

  it('运营者在未授权实盘时撤单：三态闸门未被账户读面改动误伤', async () => {
    // Given: 缺省配置（dryRun=true、liveTrading=false）的 Tushare 交易服务
    const trade = tushareTrade()
    // When: 直调服务缝撤单（模拟动态包注入的调用面）
    // Then: 仍抛 TRADING_LIVE_TRADING_DISABLED——撤单门槛与下单闸门保持 fail-closed
    await expect(trade.cancelOrder('ord-1')).rejects.toMatchObject({ code: 'TRADING_LIVE_TRADING_DISABLED' })
  })
})

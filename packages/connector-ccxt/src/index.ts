/**
 * @dshtrading/connector-ccxt
 * CCXT 跨所加密通用连接器插件（提供 tradingCryptoMarketData 与多所聚合工具）。
 */

import { liveTradingEnabled } from '@dshtrading/authority'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import type {
  Disposable,
  Interval,
  Kline,
  MarketDataService,
  Order,
  OrderRequest,
  Position,
  Ticker,
  TradeService,
} from '@dshtrading/api'
import {
  CcxtRestClient,
  type CcxtRestOptions,
  INTERVAL_VOCABULARY,
  KLINE_EXCHANGES,
  SUPPORTED_EXCHANGES,
  TradingServiceError,
} from './rest.js'

export * from './rest.js'

export const name = 'dsh-trading-crypto-connector-ccxt'

export interface Config {
  enabled: boolean
  dryRun: boolean
  liveTrading: boolean
  defaultExchange: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否激活 CCXT 连接器'),
  dryRun: Schema.boolean().default(true).description('默认模拟下单'),
  liveTrading: Schema.boolean().default(false).description('是否允许实盘交易'),
  defaultExchange: Schema.string().default('binance').description(
    '默认首选交易所（开放 slug：任何所名都能填，但只有 binance/okx/bybit 有 ticker 直连分支、只有 binance 有 K 线分支，其余所名在请求前结构化拒绝 TRADING_NOT_IMPLEMENTED）',
  ),
})

export const TRADING_CRYPTO_MARKET_DATA_KEY = 'tradingCryptoMarketData'
export const TRADING_CRYPTO_TRADE_KEY = 'tradingCryptoTrade'

export class CcxtMarketDataService extends Service implements MarketDataService {
  private readonly client: CcxtRestClient

  constructor(
    ctx: Context,
    options: CcxtRestOptions = {},
    serviceName: string = TRADING_CRYPTO_MARKET_DATA_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new CcxtRestClient(options)
  }

  async getTicker(symbol: string, exchange?: string): Promise<Ticker> {
    return this.client.getTicker(symbol, exchange)
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100, exchange?: string): Promise<Kline[]> {
    return this.client.getKlines(symbol, interval, limit, exchange)
  }

  subscribeTicker(symbol: string, cb: (ticker: Ticker) => void, options?: { intervalMs?: number }): Disposable {
    const ms = Math.max(options?.intervalMs ?? 5_000, 1_000)
    const tick = (): void => {
      void this.getTicker(symbol).then(cb, () => {})
    }
    tick()
    const timer = setInterval(tick, ms)
    return { dispose: () => clearInterval(timer) }
  }
}

export class CcxtTradeService extends Service implements TradeService {
  private readonly client: CcxtRestClient
  /** 插件配置（服务缝闸门 P0：dryRun 强制模拟 / liveTrading 非权威镜像——实盘授权由 @dshtrading/authority 的人工签署平面裁定）。 */
  private readonly config: Config

  constructor(
    ctx: Context,
    options: CcxtRestOptions & { config: Config },
    serviceName: string = TRADING_CRYPTO_TRADE_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new CcxtRestClient(options)
    this.config = options.config
  }

  async placeOrder(order: OrderRequest): Promise<Order> {
    // 服务缝闸门（P0 · 铁律 #3 修订版 [S4]）：三态检查下推到服务实现内第一步——
    // 绕过工具层直调本服务（动态包宿主半等）同样 fail-closed；工具层闸门保留（双保险）。
    const requestedDryRun = order.dryRun ?? true
    if (!requestedDryRun && !liveTradingEnabled(this.config.liveTrading)) {
      throw new TradingServiceError(
        'TRADING_LIVE_TRADING_DISABLED',
        `CCXT TradeService.placeOrder rejected: the request asks for real execution (dryRun=${String(order.dryRun)}) `
          + 'but the signed live-trading authority does not grant real execution (see @dshtrading/authority) — keep dryRun=true for a simulated fill.',
      )
    }
    if (requestedDryRun || this.config.dryRun) {
      // 闸门 ②：本地模拟回执（工具层另有带市价参照的富回执）。
      return {
        id: `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        status: 'filled',
        ...(order.price !== undefined ? { price: order.price } : {}),
        quantity: order.quantity,
        dryRun: true,
        timestamp: Date.now(),
      }
    }
    // 闸门 ③：live（dryRun=false 且实盘已获授权）→ 真实下单。
    return this.client.placeOrder(undefined, order)
  }

  async cancelOrder(orderId: string): Promise<{ orderId: string; status: 'canceled' }> {
    // 服务缝闸门（P0）：撤单是会改变交易所/券商真实状态的实盘动作，与真实下单同门槛
    // （授权平面已授予且未强制模拟），防「经撤单接口绕过下单闸门」。
    if (!liveTradingEnabled(this.config.liveTrading) || this.config.dryRun) {
      throw new TradingServiceError(
        'TRADING_LIVE_TRADING_DISABLED',
        'CCXT TradeService.cancelOrder rejected at the service seam: cancel is a live action and requires a signed live-trading grant (see @dshtrading/authority) with dryRun=false.',
      )
    }
    return this.client.cancelOrder(undefined, orderId)
  }

  /**
   * 私有账户读面未实现（本包没有任何签名私有账户读路径）：必须显式拒绝。base 的账户工具
   * 与 GUI 桥把同一注册面当「交易所账户真值」消费——返回编造订单或空数组会被读成
   * 「订单存在」「没有持仓」，而契约语义是 TRADING_NOT_IMPLEMENTED（不可用）。可选方法
   * getBalances/listOpenOrders/listTradeFills 直接缺席，由消费方按「可选方法缺席」处理。
   */
  async getOrder(_symbol: string, _id: string): Promise<Order> {
    throw new TradingServiceError(
      'TRADING_NOT_IMPLEMENTED',
      'CCXT TradeService.getOrder is not implemented: this connector has no signed private-account read path. '
        + 'That means "not available", NOT "order not found".',
    )
  }

  async getPositions(): Promise<Position[]> {
    throw new TradingServiceError(
      'TRADING_NOT_IMPLEMENTED',
      'CCXT TradeService.getPositions is not implemented: this connector has no signed private-account read path. '
        + 'That means "not available", NOT "no positions".',
    )
  }
}

export const ROUTER_PROVIDER = 'ccxt'

export function routeAllows(ctx: Context, config: Config, market: string): boolean {
  if (!config.enabled) return false
  const router = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketRouter', false) as { activeProvider(m: string): string | undefined } | undefined
  if (router === undefined) return true
  return router.activeProvider(market) === ROUTER_PROVIDER
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (!routeAllows(ctx, config, 'crypto')) return

  const marketData = new CcxtMarketDataService(ctx, { exchange: config.defaultExchange })
  const trade = new CcxtTradeService(ctx, { exchange: config.defaultExchange , config })

  ctx.inject(['tools'], (ctx) => {
    const tools = ctx.tools as unknown as { register(d: unknown): void; get(n: string): unknown }
    const register = (t: ReturnType<typeof defineTool>) => {
      if (tools.get(t.name) === undefined) tools.register(t)
    }

    register(defineTool({
      name: 'crypto_get_ticker',
      description: 'Get the latest spot ticker from one of the three implemented direct branches (binance, okx, bybit). Any other CCXT exchange slug is rejected with TRADING_NOT_IMPLEMENTED before any network request.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'Crypto pair symbol, e.g. BTCUSDT or BTC/USDT' },
        exchange: { type: 'string', enum: SUPPORTED_EXCHANGES, default: 'binance', description: 'Exchange slug; only binance, okx and bybit have implemented ticker branches' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        return JSON.stringify(await marketData.getTicker(args.symbol, args.exchange))
      },
    }))

    register(defineTool({
      name: 'crypto_get_klines',
      description: 'Get recent spot klines from Binance: klines have a single implemented branch (binance). Any other CCXT exchange slug is rejected with TRADING_NOT_IMPLEMENTED before any network request.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'Crypto pair symbol, e.g. BTCUSDT' },
        interval: { type: 'string', enum: INTERVAL_VOCABULARY, default: '1d', description: 'Interval' },
        limit: { type: 'integer', default: 100, description: 'Limit' },
        exchange: { type: 'string', enum: KLINE_EXCHANGES, default: 'binance', description: 'Exchange slug; klines are implemented for binance only' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const klines = await marketData.getKlines(args.symbol, (args.interval ?? '1d') as Interval, args.limit, args.exchange)
        return JSON.stringify(klines)
      },
    }))
  })
}

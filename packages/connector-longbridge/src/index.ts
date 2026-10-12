/**
 * @dshtrading/connector-longbridge
 * 长桥 (Longbridge) 港股连接器插件（提供 tradingHkMarketData 与 hk_* 工具）。
 */

import { liveTradingEnabled } from '@dshtrading/authority'
import {
  OrderIntentLedger,
  deriveVenueClientKey,
  orderFromReceipt,
  receiptFromOrder,
  type OrderIntentPayload,
} from '@dshtrading/authority/order-intents'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import type {
  AccountBalance,
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
  LongbridgeRestClient,
  type LongbridgeRestOptions,
  INTERVAL_VOCABULARY,
  TradingServiceError,
} from './rest.js'

export * from './rest.js'

export const name = 'dsh-trading-hk-connector-longbridge'

export interface Config {
  enabled: boolean
  env: 'demo' | 'live'
  dryRun: boolean
  liveTrading: boolean
  appKeyRef: string
  appSecretRef: string
  accessTokenRef: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true).description('是否激活 Longbridge 连接器'),
  env: Schema.union(['demo', 'live'] as const).default('demo').description('运行环境'),
  dryRun: Schema.boolean().default(true).description('默认模拟下单'),
  liveTrading: Schema.boolean().default(false).description('是否允许实盘交易'),
  appKeyRef: Schema.string().default('LONGBRIDGE_APP_KEY').description('Longbridge App Key 环境变量名 (BYOK)'),
  appSecretRef: Schema.string().default('LONGBRIDGE_APP_SECRET').description('Longbridge App Secret 环境变量名'),
  accessTokenRef: Schema.string().default('LONGBRIDGE_ACCESS_TOKEN').description('Longbridge Access Token 环境变量名'),
})

export const TRADING_HK_MARKET_DATA_KEY = 'tradingHkMarketData'
export const TRADING_HK_TRADE_KEY = 'tradingHkTrade'

/**
 * Longbridge `submit_order` 的 `remark` 规则：官方 SDK/文档的下单参数里有 `remark`
 * （open.longbridge.com「Submit Order」：`submit_order(..., remark="Hello from Python SDK")`），
 * 但官方**没有**承诺按 remark 去重——它只是能带出去、能读回来的标签。
 * 因此 remark 只用于对账，不构成 venue 幂等；exactly-once 由本地意图台账保证。
 * 官方未给长度上限，取 32 保持短小。
 */
export const LONGBRIDGE_REMARK_RULE = { prefix: 'dsht', maxLength: 32 } as const

export class LongbridgeMarketDataService extends Service implements MarketDataService {
  private readonly client: LongbridgeRestClient

  constructor(
    ctx: Context,
    options: LongbridgeRestOptions = {},
    serviceName: string = TRADING_HK_MARKET_DATA_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new LongbridgeRestClient(options)
  }

  async getTicker(symbol: string): Promise<Ticker> {
    return this.client.getTicker(symbol)
  }

  async getKlines(symbol: string, interval: Interval = '1d', limit: number = 100): Promise<Kline[]> {
    return this.client.getKlines(symbol, interval, limit)
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

export class LongbridgeTradeService extends Service implements TradeService {
  private readonly client: LongbridgeRestClient
  /** 插件配置（服务缝闸门 P0：dryRun 强制模拟 / liveTrading 非权威镜像——实盘授权由 @dshtrading/authority 的人工签署平面裁定）。 */
  private readonly config: Config

  /** 订单意图台账（实盘幂等前提；写 agent 自己的 trading home，不写授权平面）。 */
  private readonly intents: OrderIntentLedger

  constructor(
    ctx: Context,
    options: LongbridgeRestOptions & { config: Config },
    serviceName: string = TRADING_HK_TRADE_KEY,
  ) {
    super(ctx, serviceName)
    this.client = new LongbridgeRestClient(options)
    this.config = options.config
    // 作用域含环境；Longbridge 的账户由 appKey/accessToken 决定（凭据不进身份，
    // 轮换 token 不会让未知意图看起来是新意图），账户定位用稳定占位。
    this.intents = new OrderIntentLedger({
      provider: 'longbridge',
      environment: options.config.env,
      account: 'default',
    })
  }

  async getBalance(): Promise<AccountBalance> {
    return this.client.getBalance()
  }

  async placeOrder(order: OrderRequest): Promise<Order> {
    // 服务缝闸门（P0 · 铁律 #3 修订版 [S4]）：三态检查下推到服务实现内第一步——
    // 绕过工具层直调本服务（动态包宿主半等）同样 fail-closed；工具层闸门保留（双保险）。
    const requestedDryRun = order.dryRun ?? true
    if (!requestedDryRun && !liveTradingEnabled(this.config.liveTrading)) {
      throw new TradingServiceError(
        'TRADING_LIVE_TRADING_DISABLED',
        `Longbridge TradeService.placeOrder rejected: the request asks for real execution (dryRun=${String(order.dryRun)}) `
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
    const payload: OrderIntentPayload = {
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      quantity: order.quantity,
      ...(order.price !== undefined ? { price: order.price } : {}),
    }
    // 持久意图台账：**先落盘、后触网**（remark 只作对账，不是 venue 幂等键）。
    const decision = await this.intents.begin({ intentId: order.intentId, payload })
    if (decision.action === 'replay') {
      // 回执里的 status 是 venue 原样串（连接器自己的映射口径），这里按 api 词汇收窄。
      return { ...orderFromReceipt(decision.receipt), status: decision.receipt.status as Order['status'] }
    }
    const remark = deriveVenueClientKey(decision.intentId, LONGBRIDGE_REMARK_RULE)
    const placed = await this.client.placeOrder(undefined, order, remark)
    // rest 层在缺 order_id 时抛错（不编 id），所以能走到这里的都是真实 venue 句柄。
    await this.intents.confirm({ intentId: decision.intentId, payload, receipt: receiptFromOrder(placed) })
    return placed
  }

  async cancelOrder(orderId: string): Promise<{ orderId: string; status: 'canceled' }> {
    // 服务缝闸门（P0）：撤单是会改变交易所/券商真实状态的实盘动作，与真实下单同门槛
    // （授权平面已授予且未强制模拟），防「经撤单接口绕过下单闸门」。
    if (!liveTradingEnabled(this.config.liveTrading) || this.config.dryRun) {
      throw new TradingServiceError(
        'TRADING_LIVE_TRADING_DISABLED',
        'Longbridge TradeService.cancelOrder rejected at the service seam: cancel is a live action and requires a signed live-trading grant (see @dshtrading/authority) with dryRun=false.',
      )
    }
    return this.client.cancelOrder(undefined, orderId)
  }

  async getPositions(): Promise<Position[]> {
    return this.client.getPositions()
  }

  async getOrders(): Promise<Order[]> {
    return []
  }
}

export const ROUTER_PROVIDER = 'longbridge'

export function routeAllows(ctx: Context, config: Config, market: string): boolean {
  if (!config.enabled) return false
  const router = (ctx as unknown as { get?: (key: string, strict?: boolean) => unknown }).get?.('tradingMarketRouter', false) as { activeProvider(m: string): string | undefined } | undefined
  if (router === undefined) return true
  return router.activeProvider(market) === ROUTER_PROVIDER
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  if (!routeAllows(ctx, config, 'hk')) return

  const appKey = process.env[config.appKeyRef]
  const appSecret = process.env[config.appSecretRef]
  const accessToken = process.env[config.accessTokenRef]
  const marketData = new LongbridgeMarketDataService(ctx, { appKey, appSecret, accessToken })
  const trade = new LongbridgeTradeService(ctx, { appKey, appSecret, accessToken , config })

  ctx.inject(['tools'], (ctx) => {
    const tools = ctx.tools as unknown as { register(d: unknown): void; get(n: string): unknown }
    const register = (t: ReturnType<typeof defineTool>) => {
      if (tools.get(t.name) === undefined) tools.register(t)
    }

    register(defineTool({
      name: 'hk_get_ticker',
      description: 'Get the latest trade price and quote for a HK stock via Longbridge API.',
      parameters: { symbol: { type: 'string', required: true, description: 'HK stock symbol, e.g. 00700.HK' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        return JSON.stringify(await marketData.getTicker(args.symbol))
      },
    }))

    register(defineTool({
      name: 'hk_get_klines',
      description: 'Get recent public klines for a HK stock via Longbridge API. Supports 1m/5m/15m/30m/1h/1d/1w/1M.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'HK stock symbol, e.g. 00700.HK' },
        interval: { type: 'string', enum: INTERVAL_VOCABULARY, default: '1d', description: 'Interval' },
        limit: { type: 'integer', default: 100, description: 'Limit' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const klines = await marketData.getKlines(args.symbol, (args.interval ?? '1d') as Interval, args.limit)
        return JSON.stringify(klines)
      },
    }))

    register(defineTool({
      name: 'hk_place_order',
      description: 'Place or simulate a HK stock order via Longbridge.',
      parameters: {
        symbol: { type: 'string', required: true, description: 'HK symbol, e.g. 00700.HK' },
        side: { type: 'string', enum: ['buy', 'sell'], required: true, description: 'Side' },
        type: { type: 'string', enum: ['market', 'limit'], required: true, description: 'Type' },
        quantity: { type: 'number', required: true, description: 'Quantity (shares)' },
        price: { type: 'number', description: 'Limit price' },
        dryRun: { type: 'boolean', default: true, description: 'Dry run' },
        intentId: {
          type: 'string',
          description:
            'Stable idempotency id, required when dryRun=false. Same id + same request returns the recorded receipt and never places a second order; a different payload/provider/environment/account under the same id is rejected (TRADING_INTENT_CONFLICT); an unresolved id stays blocked as unknown until reconciled.',
        },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        if (args.dryRun !== false) {
          let refPrice = args.price
          if (!refPrice || refPrice <= 0) {
            try {
              const t = await marketData.getTicker(args.symbol)
              refPrice = t.price
            } catch {
              refPrice = 0
            }
          }
          return JSON.stringify({
            id: `sim-lb-${Date.now()}`,
            symbol: toLongbridgeSymbol(args.symbol).canonical,
            side: args.side,
            type: args.type,
            status: 'filled',
            quantity: args.quantity,
            price: refPrice ?? 0,
            dryRun: true,
            timestamp: Date.now(),
          })
        }
        if (!liveTradingEnabled(config.liveTrading)) {
          return JSON.stringify({
            status: 'rejected',
            code: 'TRADING_LIVE_TRADING_DISABLED',
            message: 'Live trading is disabled on Longbridge plugin.',
          })
        }
        const order = await trade.placeOrder({
          symbol: args.symbol,
          side: args.side as 'buy' | 'sell',
          type: args.type as 'market' | 'limit',
          quantity: args.quantity,
          price: args.price,
          ...(typeof args.intentId === 'string' ? { intentId: args.intentId } : {}),
          dryRun: false,
        })
        return JSON.stringify(order)
      },
    }))

    register(defineTool({
      name: 'hk_cancel_order',
      description: 'Cancel a HK stock order on Longbridge by order ID; an already-terminal order is reported as such, not as an error.',
      parameters: { ordId: { type: 'string', required: true, description: 'Order ID' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args) {
        const res = await trade.cancelOrder(args.ordId)
        return JSON.stringify(res)
      },
    }))

    register(defineTool({
      name: 'hk_get_balance',
      description: 'Get HK account balance via Longbridge.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute() {
        const bal = await trade.getBalance()
        return JSON.stringify(bal)
      },
    }))
  })
}

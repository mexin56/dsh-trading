# Agent Note: 连接器伪账户读面改为失败关闭（保留占位服务与闸门）

Status: implemented

## Problem

若干连接器把自己注册进路由交易面（`tradingTradeRegistry`），却让账户读面返回编造值：常量余额（硬编码 100000 / 1000000）、恒空的持仓与挂单、编造的 `status: new` 订单。这些值经 base 的账户工具（`packages/base/src/market-tools.ts`）与 GUI 桥（`packages/bot-api/src/bridge.ts`）到达模型与用户，而工具文案把它们声明为「交易所账户真值（live）」，并写明「可选方法缺席 ⇒ TRADING_NOT_IMPLEMENTED，不是零余额/无持仓」。触发条件是设置页把对应市场的 provider 切成该连接器；`bridge.positions()` 直调 `getPositions()`，因此恒空数组会被读成「确实没有持仓」。

## Decision

读面统一按一个规则改：**契约必选方法失败关闭，非契约的伪造方法删除**。

规则（`packages/api/src/index.ts:834-845` 的 `TradeService`）：契约必选方法（`getOrder` / `getPositions`）必须以 `TRADING_NOT_IMPLEMENTED` 拒绝，文案写明「不可用 ≠ 不存在」；契约可选方法（`getBalances` / `listOpenOrders` / `listTradeFills`）与契约外方法一律**缺席**，由消费方既有的「可选方法缺席」路径处理（`bridge.balances` / `bridge.tradeFills` 已在方法缺席时抛 `TRADING_NOT_IMPLEMENTED`）。

首个实例（2026-10-10，Bybit）：

- `packages/connector-bybit/src/index.ts`：删可选方法 `getBalances`/`listOpenOrders`/`listTradeFills`；必需方法 `getOrder`/`getPositions` 抛 `TradingServiceError(TRADING_NOT_IMPLEMENTED)`；非契约方法 `getBalance`（转发硬编码常量）删除。
- `packages/connector-bybit/src/rest.ts`：删除硬编码 100000 的 `getBalance()`。

本次扩到其余四个连接器：

- `packages/connector-futu/src/index.ts`：`getPositions`/`getOrder` 抛 `TRADING_NOT_IMPLEMENTED`；删 `getBalances`（原本 `catch {}` 把上游故障折成 `[]`，使故障与空账户不可区分）与 `listTradeFills`。`getBalance` 与 `rest.getBalance` 保留——那是 `/api/trd/get-funds` 的真实读面。
- `packages/connector-ccxt/src/index.ts` 与 `src/rest.ts`：删两处 `getBalance`（恒回 `{currency:'USDT', available:100000, total:100000}`）；`getPositions` 抛 `TRADING_NOT_IMPLEMENTED`；删非契约 `getOrders`；补上此前缺席的契约必选方法 `getOrder`，同样失败关闭。
- `packages/connector-ibkr/src/index.ts`：补上此前缺席的 `getOrder`（失败关闭）；删非契约 `getOrders`。`getBalance`/`getPositions` 保留——那是 `/portfolio/{acc}/ledger` 与 `/portfolio/{acc}/positions/0` 的真实读面。
- `packages/connector-tushare/src/index.ts` 与 `src/rest.ts`：删两处 `getBalance`（恒回 `{currency:'CNY', available:1000000, total:1000000}`）；`getPositions` 抛 `TRADING_NOT_IMPLEMENTED`；删非契约 `getOrders`；补上 `getOrder`，同样失败关闭。

保留（两个实例相同）：数据面与交易面注册、`placeOrder`/`cancelOrder` 的本地模拟回执与三态闸门、服务键与类本身——占位服务的保留是[服务缝闸门](../feature/2026-09-01-service-seam-order-gate.md)的既有裁决（占位连接器的 TradeService 同样可被 inject 直调，必须同矩阵过闸）。

## Alternatives considered

- **连占位服务与注册一起删（接入手册的「仅行情」范式）**：与[服务缝闸门](../feature/2026-09-01-service-seam-order-gate.md)第 6/7 条「占位连接器的 TradeService 同样可被 inject 直调，必须同矩阵过闸」相抵，落选。
- **保留读面、只加「模拟」文案**：模型面对的是工具返回值而不是文档，同形回执靠文案区分不可靠，落选。
- **只清点名的位点、放过恒空数组**：拒绝——恒空数组与常量余额是同一缺陷类（缺失能力被冒充成空状态），且 `bridge.positions()` 把 `[]` 读成「无持仓」，落选。
- **补各家真实签名实现（Bybit v5 / CCXT 私有面 / Tushare 交易通道 / IBKR 单笔订单端点）**：属新功能（签名、限频、错误映射、模拟盘头、实盘授权路径），超出简化范围，本记录不妨碍日后重接。

## Consequences

- 五个包各有 `test/account-read-surface.test.ts`（bybit 于首个实例落地，其余四个本次新增），断言失败关闭路径（错误码 `TRADING_NOT_IMPLEMENTED` + 文案含 `NOT "order not found"` / `NOT "no positions"`）与可选方法缺席，并各留一条「真实路径 / 闸门未被误伤」的回归。
- 模型/GUI 侧：路由到这些连接器时，账户与订单读面给结构化 not-implemented，不再有常量余额、空数组或编造订单冒充账户状态；工具名与数量不变。
- 仍然存在的邻接缺口（本记录范围外，另行裁决）：ibkr 的 `getBalance`/`getPositions` 返回形状与 `AccountBalance`/`Position` 契约不一致；live 档（`dryRun=false` 且已获实盘授权）仍走本地 sim stub 回执。

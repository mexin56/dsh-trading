# Agent Note: TradingErrorCode 收录 TRADING_SYMBOL_NOT_FOUND

Status: implemented

## Problem

- `@dshtrading/api` 的统一错误词汇 `TradingErrorCode` 漏了 `TRADING_SYMBOL_NOT_FOUND`，而它已经被
  8 个连接器实际抛出：connector-akshare / eastmoney / finnhub / fmp / longbridge / polygon / tushare 的
  「上游答了但没有可用行」判空，加 connector-ccxt 的行级判空与 HTTP 404 / 400 `label=INVALID_*` 映射。
- 缺码的后果不是「码用不了」（运行时字符串照样抛），而是每个包都要自己造一个类型出口：ccxt 用包内
  `CcxtErrorCode = TradingErrorCode | 'TRADING_SYMBOL_NOT_FOUND'`；bybit 与 qmt 则在源码注释里记
  「该码不在词汇表里」，并因此把语义不同的场景也塞进 `TRADING_UNSUPPORTED_SYMBOL` /
  `TRADING_EXCHANGE_ERROR`，同时把同类类型债分散到多个包的 tsc 计数里。
- 该码与 `TRADING_UNSUPPORTED_SYMBOL` 是**互补语义**：前者 = 请求到达上游、上游说没有这个标的
  （404 / 400 `INVALID_*` / 200 但没有可用的行）；后者 = 本地就判定这个形态不支持（零请求）。
  少一个就会让消费方把「标的不存在」当基础设施抖动重试，或把本地拒绝读成上游故障。

## Decision

- `TradingErrorCode` 收录 `TRADING_SYMBOL_NOT_FOUND`，注释照 `TRADING_UPSTREAM_ERROR` 那条既有体例
  写清「已被 8 个连接器实际使用、此前只是漏进词汇表（类型层缺口）」，并写明它与
  `TRADING_UNSUPPORTED_SYMBOL` 的分界。**运行时错误码不变**（各连接器抛的字符串本来就是它）。
- `connector-ccxt` 的包内 `CcxtErrorCode` 下线，`TradingServiceError.code` 恢复为 `TradingErrorCode`；
  行级判空收敛到同一个 helper（`symbolNotFoundError(surface, exchange, symbol)`）。
- bybit 与 qmt 两处「该码不在词汇表里」的注释就地改写为语义理由（两处的取舍本身不变：永续查无此合约、
  主取价路径静默，都不是「上游说这个符号不存在」）；记录过同一事实的两份 note 就地保鲜
  （[bybit-ccxt 数据面](../feature/2026-10-08-crypto-perp-data-plane-bybit-ccxt.md) 与
  [东财港股](../feature/2026-09-08-eastmoney-hk-market.md)）。
- 消费方核查：全仓没有对 `TradingErrorCode` 的穷尽 switch（`grep -rn "TradingErrorCode" packages/*/src`
  的命中都是错误载体类型、错误码映射表与注释），加一个联合成员不产生新的 TS 破损；
  `scripts/typecheck-baseline.json` 不变（api 与 ccxt 的计数都不升）。
- changeset：`@dshtrading/api` 与 `@dshtrading/connector-ccxt` 各 patch（仓内 fixed cohort：
  全包统一版本）。

## Alternatives considered

- **继续用包内别名（ccxt 的 `CcxtErrorCode`）**：落选——别名只让一个包自洽，另外 7 个包继续各带同类
  tsc 债，bybit/qmt 的注释仍在传播「词汇表里没有」这个已经过时的事实。
- **改各连接器抛的码去绕开缺码**：落选——语义上它们是对的，缺的是类型层登记；改码会破坏消费方对
  8 个包既有运行时错误码的依赖。
- **新造一个更泛的 `TRADING_NOT_FOUND`**：落选——既有 8 个包抛的就是 `TRADING_SYMBOL_NOT_FOUND`，
  换名字等于同时改 8 个包的运行时行为与消费方分支。

## Consequences

- 消费方可以一次 `switch (code)` 覆盖「本地拒绝」与「上游查不到」两类，不必再靠字符串比较或注释约定。
- ccxt 包内不再有词汇表副本；bybit/qmt 的注释与两份 note 与词汇表一致（一个事实只有一个家：边界写在
  `packages/api/src/index.ts` 的联合定义里，别处只引用不重述）。
- 证据：`node scripts/typecheck-gate.mjs`（计数只降不升）、`pnpm --filter @dshtrading/api test`
  （3 文件 15 例）、`pnpm --filter @dshtrading/connector-ccxt test`（9 文件 55 例，其中 404 /
  400 `INVALID_*` / 空行 → 该码的用例在 `test/upstream-error-mapping.test.ts`）。

---
"@dshtrading/api": patch
"@dshtrading/connector-ccxt": patch
---

CCXT 连接器的 quote 表按所维护、K 线切到九所，并把 `TRADING_SYMBOL_NOT_FOUND` 补进 api 错误码词汇表：

- `@dshtrading/api`：`TradingErrorCode` 收录 `TRADING_SYMBOL_NOT_FOUND`（已被 8 个连接器实际使用，
  此前只是漏进词汇表；与 `TRADING_UNSUPPORTED_SYMBOL` 的分界写进注释），**运行时错误码不变**。
- `@dshtrading/connector-ccxt`：七条形态变换分支各有一份 quote 资产表（数据来源 = 该所公开挂牌端点
  普查），表外计价币仍零请求拒绝；K 线从单分支扩到九所（周期按所映射、行结构按所解析、输出升序、
  单请求根数按所裁剪），该所不支持的周期抛 `TRADING_UNSUPPORTED_INTERVAL` 且零请求；`exchange`
  只加在客户端方法与 `crypto_get_klines` 工具上，`MarketDataService.getKlines` 保持三形参；
  包内 `CcxtErrorCode` 下线。
- 真实网络证据（`spikes/impl-ccxt-exchange-expansion/`）：七份挂牌普查 + 九份 K 线 + 六份上游 400 原文，
  `run-probe.ts` 退出码 0、63/63 判据通过。

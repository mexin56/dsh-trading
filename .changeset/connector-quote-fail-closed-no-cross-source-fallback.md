---
"@dshtrading/connector-ibkr": patch
"@dshtrading/connector-tiger": patch
---

行情面删除静默跨源回落，改为 fail-closed：`getTicker` / `getKlines` 不再改打 Yahoo
（`query1.finance.yahoo.com`）或腾讯（`qt.gtimg.cn` / `web.ifzq.gtimg.cn`）。网关不可达抛
`TRADING_NETWORK`、HTTP 非 2xx 抛 `TRADING_UPSTREAM_ERROR`、回包无可用价格或形状不可识别抛
`TRADING_EXCHANGE_ERROR`——不再返回 `price: 0` / `NaN` 的伪行情；上游明确的空序列仍原样返回 `[]`。
两包 README 与 tiger 的 description 同步改写，新增 fail-closed 用例断言「零跨源出网」。

---
"@dshtrading/client-ui-settings": patch
"@dshtrading/connector-ccxt": patch
---

设置页与 CCXT 连接器的「声明面」收窄到实现事实：

- 设置页 provider 登记项按连接器 dataplane 的真实注册面改值（ibkr `['us']`、akshare `['cn']`、
  tiger `['hk']`；futu 行情面 hk+us 与实现一致）；futu 的 env 提示改指 Config 字段
  `gatewayUrl`（`FUTU_HOST` 从未被读取），`provider.envPrefix` 改中性措辞；bybit Secret 占位改
  `BYBIT_SECRET_KEY`（原先写 `BYBIT_API_SECRET`，与 schema 默认名不符）。
- `connector-ccxt` 的所名登记面 = 实现面：`SUPPORTED_EXCHANGES` 收窄为
  `binance/okx/bybit`，新增 `KLINE_EXCHANGES = ['binance']`；`getTicker` / `getKlines` 对未实现
  所名在任何网络请求之前抛 `TRADING_NOT_IMPLEMENTED`（此前 6 个所名静默落 Binance 兜底，选
  `kraken` 会拿到 Binance 报价），两个工具的 `exchange` 枚举与描述同步收窄。
- 新增设置页登记项一致性测试（用真 dataplane 模块断言登记项 = 注册面）与 CCXT 所名面
  fail-closed 用例（拒绝路径零请求 + 三所分支 + 枚举断言）。

# 腾讯报价批量取数 getTickers（2026-10-14）

## 结论

`packages/connector-tencent` 的报价端点**原生支持逗号列表**：一次 `GET /q=<wire,wire,…>` 取多只标的。
据此实现 `TencentRestClient.getTickers` 与 `TencentMarketDataService.getTickers`，自选栏每拍
「N 只标的 N 次请求」降为 **1 次**（cn / hk 实例各自）；实现不分片（调用方按 MAX_SYMBOLS 裁剪）。

本探针跑的是产品代码本体（`src/rest.ts`，node 类型剥离直跑），只把 `fetch` 包一层做计数与落盘——
「上游请求 1 次」是包装层实测的 URL 条数，不是推断。

## 上游事实（本次实测）

| 事实 | 证据 |
|---|---|
| `q=` 支持逗号列表，一次请求回多行 | `q=sh600519,sz000001,sz159869,sh000688,sz999999` → HTTP 200 / 2029 B / 5 入参回 **4** 行 |
| 未知代码在批量响应里**整行缺席**（不是短 body、不报错） | 上面的 `sz999999` 无对应 `v_*` 行；在线结果里该键跳过 |
| 单标的遇未知代码仍回短 body | `v_pv_none="1";` / `v_pv_none_match="1";`（字段数 1 < 35，既有语义不变） |
| **hk 指数 wire 大小写敏感** | `q=r_hkHSI` → `v_r_hkHSI="100~恒生指数~…"`；`q=r_hkhsi` → `v_pv_none_match="1";` |

最后一条是本次探针抓到的真回归：实现里若把 wire 统一小写再拼 URL，指数会静默变「未收录」。
修正后请求保留 wire 原大小写（`#quoteWireCode` 的输出原样进 URL），只有响应查表键小写归一
（`parseQuoteRows`），规范形 symbol 由调用方持有的 `sym` 还原（否则指数会变成 `hsi.HK`）。

## 原始字节落盘

复现命令（仓库根）：

```
node spikes/impl-tencent-quote-batch/r0-live-probe.mjs
```

| 文件 | 内容 | sha256 |
|---|---|---|
| `r0-raw-cn-batch.gbk` | 2029 B，4 行 `v_sh600519/v_sz000001/v_sz159869/v_sh000688` | `3cf2e361db734a8acb43e1f58f38f3549bed7d83ef50a686c94b476a5c69a07e` |
| `r0-raw-hk-batch.gbk` | 1241 B，3 行 `v_r_hk00700/v_r_hk02714/v_r_hkHSI` | `673acdfafc6c6e2665e853159a2ec27b34d76e75d5d7e921af8d89396928806a` |
| `r0-raw-cn-single.gbk` | 540 B，单标的 `v_sh600519` 回归对照 | `7e0b1336edf2643e36aaf68960878b880e697ae909f58013903e4096ec29a456` |
| `r0-stdout.txt` | 探针 stdout 全文（含逐只 wire→名称/价格与每阶段请求条数） | `ec7289e98db1bb471ddd3885d0a44d00bc0b4a9cd6d4daccea9b515e7d05a549` |
| `r0-result.json` | 机器可读小结（请求 URL、返回键、离线重放一致性） | `530e59423bffa69e487710111cf777b1997fa9151322fbbe289891951f6dafbb` |

`r0-live-probe.mjs` 第 5 阶段是**零网络离线重放**：把刚落盘的原始字节注入 fetch 重放同一条解析
路径，结果与在线逐键一致（cn/hk 均 `true`）——证据可在无网络环境下复跑。

## 探针 stdout（r0-stdout.txt 摘录）

```
== cn 批量 getTickers ==
  [fetch] https://qt.gtimg.cn/q=sh600519,sz000001,sz159869,sh000688,sz999999 → HTTP 200 2029 B sha256:3cf2e361db734a8a → r0-raw-cn-batch.gbk
  600519.SH   wire=sh600519   → 贵州茅台 1285.3 CNY ts=1791960152000 symbol=600519.SH
  000001.SZ   wire=sz000001   → 平安银行 11.5 CNY ts=1791960150000 symbol=000001.SZ
  159869.SZ   wire=sz159869   → 游戏ETF华夏 1.057 CNY ts=1791960150000 symbol=159869.SZ
  000688.SH   wire=sh000688   → 科创50 1384.41 CNY ts=1791960150000 symbol=000688.SH
  999999.SZ   wire=sz999999   → 跳过（未收录/无行）
  入参 5 个 / 返回 4 个 / 上游请求 1 次
== hk 批量 getTickers ==
  [fetch] https://qt.gtimg.cn/q=r_hk00700,r_hk02714,r_hkHSI → HTTP 200 1241 B sha256:673acdfafc6c6e26 → r0-raw-hk-batch.gbk
  00700.HK  wire=r_hk00700   → 腾讯控股 425.8 HKD ts=1791960151000 symbol=00700.HK
  02714.HK  wire=r_hk02714   → 牧原股份 35.2 HKD ts=1791960140000 symbol=02714.HK
  HSI       wire=r_hkHSI     → 恒生指数 24361.33 HKD ts=1791960153000 symbol=HSI.HK
  入参 3 个 / 返回 3 个 / 上游请求 1 次
== 单标的 getTicker 回归（重构后单/批量读数一致） ==
  [fetch] https://qt.gtimg.cn/q=sh600519 → HTTP 200 540 B sha256:7e0b1336edf2643e → r0-raw-cn-single.gbk
  getTicker('600519.SH') → 贵州茅台 1285.3 / 上游请求 1 次
  批量同标的          → 贵州茅台 1285.3 / 同一行(名称+规范形 symbol 一致)=true 价格跳动=0.00
== 空入参 == → {} / 上游请求 0 次
== 离线重放（注入落盘字节，零网络）==
  cn 与在线一致=true（离线注入 fetch 被调用 1 次，零真实网络）
  hk 与在线一致=true（离线注入 fetch 被调用 1 次，零真实网络）
```

## 契约逐条对照（packages/api `getTickers?`）

| 契约 | 实现 | 证据 |
|---|---|---|
| 一次请求取多只 | `#fetchQuoteRows` 拼 `q=<wire,…>` | 在线两阶段各 1 次请求 |
| 键 = 入参原字符串 | `byWire` 分组保留 `inputs` 原串 | 测试「键=入参原字符串」用例 |
| `Ticker.symbol` 仍规范形 | `#tickerFrom` 走 `toCanonicalTencentSymbol(sym)` | 批量结果 `symbol=600519.SH / 00700.HK / HSI.HK` |
| 只返回确实拿到的标的 | 行缺席 → `continue`；短行/时间读数坏 → `try/catch continue` | 在线 `999999.SZ` 跳过；测试两条跳过用例 |
| 整批失败抛出 | `#requestArrayBuffer` 的 TRADING_* 不被吞 | 测试 HTTP 500 用例（只打 1 次请求） |
| 调用方按 MAX_SYMBOLS 裁剪，实现不分片 | 无分片逻辑，`wires.join(',')` 一次发 | 5 入参 1 请求 |
| 空入参 | `symbols.length === 0` 直接 `{}`；全部不可规范化时 `byWire.size === 0` → `{}` | 探针「空入参 → {} / 上游请求 0 次」 |

## 复用而非另写解析器

单标的路径（`getTicker/getFundamentals/getOrderbook/getActiveBuySnapshot`）与批量共用：

- `parseQuoteRows`：整段 GBK 文本 → wire→字段数组（唯一一处行正则）；
- `#fetchQuoteRows`：唯一一处报价 URL 拼装 + GBK 解码；
- `#validateQuoteRow`：唯一一处「字段 ≥ 35 + 字段 30 行情时间」校验；
- `#tickerFrom`：唯一一处 `parseCnTicker`/`parseHkTicker` + 规范形出口。

## 测试与门禁

- `pnpm --filter @dshtrading/connector-tencent test`：5 文件 / **64 用例全绿**（新增 8 例批量用例，
  含多码单请求、未知码跳过（整行缺席 + 短行两种形态）、hk `r_hk` 前缀与 GBK 解码、指数 wire 大小写、
  空入参与全非法入参不发请求、整批 500 抛出、服务实例委派）。
- `pnpm --filter @dshtrading/connector-tencent build`：tsdown 通过（dts 生成即类型检查）。
- `pnpm test:audit`：通过，逐文件计数未上升（`packages/connector-tencent/test/market-data.test.ts`
  仍为 46；总量 199 / 0 / 1520 / 1519 / 0 与改动前一致）。

## 已知边界

- 未做分片与重试：单次请求的标的数由调用方裁剪（契约如此）；上游 5xx 直抛，不逐只重试。
- 批量路径不返回「哪个符号为什么失败」：契约规定调用方回落 `getTicker` 单取拿各符号的错误码，
  此处只保证「拿不到就不放进结果」。
- 桥侧接入不属本次改动范围（`packages/bot-api` 由另一路负责），但已就近核对接线兼容：桥的
  `fetchTickerOutcomes`（bridge.ts:817-844）按 `typeof service.getTickers === 'function'` 探测、
  对缺席键逐个回落 `getTicker`、整批抛错时全批记同一错误信封且不重试——与本实现的「缺行即缺席、
  整批失败抛出」逐条对上；`isBatchTicker` 只要求非空对象，本实现返回的是完整 `TencentTicker`。

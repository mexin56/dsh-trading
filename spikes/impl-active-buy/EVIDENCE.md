# cn 主动买盘快照（外盘/内盘）真实响应证据（`spikes/impl-active-buy/`）

- 抓取时间：2026-10-13 10:09（北京时间，A 股连续竞价时段）；出口 = 本机；无 key、无凭证。
- 数据源：腾讯公共行情端点 `GET https://qt.gtimg.cn/q=<wire>`（GBK 编码），与 `connector-tencent` 报价同一行，**零额外请求**。
- 脚本：`r3-parse.mjs` —— 把 curl 落盘的 GBK 原文喂回**产品代码本体** `packages/connector-tencent/src/rest.ts`（node 类型剥离直跑源文件），只有「取数时刻」为注入值。

## 复现命令

```bash
cd spikes/impl-active-buy
curl -sS -D r1-headers-sz002714.txt "https://qt.gtimg.cn/q=sz002714" -o r1-raw-sz002714.gbk
curl -sS "https://qt.gtimg.cn/q=sh600519" -o r2-raw-sh600519.gbk
curl -sS "https://qt.gtimg.cn/q=sz999999" -o r2-raw-unknown-sz999999.gbk   # 未知/退市代码
curl -sS "https://qt.gtimg.cn/q=r_hk00700" -o r2-raw-hk00700.gbk           # hk 对照（外/内盘位恒为 0）

# 离线重放解析（仓库根目录；默认只打印，不写工作区）
node spikes/impl-active-buy/r3-parse.mjs
# 需要刷新下面这份证据快照时才落盘（会改 replayedAt，属有意更新）
node spikes/impl-active-buy/r3-parse.mjs --write
```

响应头（`r1-headers-sz002714.txt`）：`HTTP/2 200`、`content-type: text/html; charset=GBK`、`cache-control: max-age=0`、`access-control-allow-origin: *`——**必须 GBK 解码**（UTF-8 解出中文乱码，与 `#fetchQuoteFields` 既定实现一致）。

## 原始响应落盘（GBK 原文，字节即证据）

原文只有 400–550 字节，故**全量保存**（未截断）；`r3-parse.mjs` 用 `TextDecoder('gbk')` 读出、与快照逐项对照。

| 文件 | 字节 | sha256 | 形态 |
|---|---|---|---|
| `r1-raw-sz002714.gbk` | 506 | `af8b67507b370918…36a9` | 88 字段，有读数 |
| `r2-raw-sh600519.gbk` | 540 | `cf923b457a758966…8a95` | 88 字段，有读数 |
| `r2-raw-unknown-sz999999.gbk` | 21 | `b00bd0cba55ccd1f…b6158` | `v_pv_none_match="1";`（未知代码） |
| `r2-raw-hk00700.gbk` | 436 | `e6438ba1020d6cc5…8bd5` | 78 字段，hk 布局，f7/f8 = 0 |

## 字段映射（cn 行，实测位号）

| 位号 | 语义 | sz002714@10:09 | sh600519@10:09 |
|---|---|---|---|
| 6 | 当日累计总量（手） | `121808` | `7154` |
| 7 | 外盘 = 主动买（手） | `54093` | `3758` |
| 8 | 内盘 = 主动卖（手） | `67703` | `3351` |
| 30 | 时间 `YYYYMMDDHHMMSS`（Asia/Shanghai） | `20261013100930` | `20261013100938` |
| 47 | 涨停价 | `45.96` | `1416.80` |
| 48 | 跌停价 | `37.60` | `1159.20` |

交叉校验：47/48 与昨收（f4）自洽——`41.78 × 1.1 = 45.958 → 45.96`、`41.78 × 0.9 = 37.602 → 37.60`；`1288.00 × 1.1 = 1416.80`、`1288.00 × 0.9 = 1159.20`。

hk 对照（`r2-raw-hk00700.gbk`）：f7 = f8 = `0`，且 f47/f48 = `1.26`/`658.700`（不是涨跌停价，港股无涨跌幅限制）——r_hk 行**没有**外盘/内盘字段，故 hk 侧不实现该能力（客户端直调按 `TRADING_NOT_IMPLEMENTED` 拒绝，服务层 hk 实例上方法本身缺席）。

## 解析对照（`r3-parse.mjs` 实测输出，落 `r3-parsed.json`）

```
=== sz002714 (506B, sha256:af8b67507b370918)
    字段映射: {"f6":"121808","f7":"54093","f8":"67703","f30":"20261013100930","f47":"45.96","f48":"37.60"}
    快照: {"symbol":"002714.SZ","date":"2026-10-13","time":"10:09:30","totalLots":121808,"outerLots":54093,
           "innerLots":67703,"buySharePct":44.41,"netSharePct":-11.17,"limitUp":45.96,"limitDown":37.6,
           "source":"qt.gtimg.cn","fetchedAt":"2026-10-13T10:09:35+08:00"}
    sumGap: 12 手 = 0.0099%
=== sh600519 (540B, sha256:cf923b457a758966)
    字段映射: {"f6":"7154","f7":"3758","f8":"3351","f30":"20261013100938","f47":"1416.80","f48":"1159.20"}
    快照: {"symbol":"600519.SH","date":"2026-10-13","time":"10:09:38","totalLots":7154,"outerLots":3758,
           "innerLots":3351,"buySharePct":52.53,"netSharePct":5.69,"limitUp":1416.8,"limitDown":1159.2,
           "source":"qt.gtimg.cn","fetchedAt":"2026-10-13T10:09:35+08:00"}
    sumGap: 45 手 = 0.629%
=== 未知代码 sz999999: {"raw":"v_pv_none_match=\"1\";","code":"TRADING_UNSUPPORTED_SYMBOL"}
=== hk r_hk00700: {"code":"TRADING_NOT_IMPLEMENTED", ...}
REAL-RESPONSE REPLAY PASS: 2 个真实行 + 2 条失败语义（GBK + 字段映射 + 占比 + sumGap 全部核对）
```

占比口径：`buySharePct = outer/total*100`、`netSharePct = (outer-inner)/total*100`，2 位小数。

## sumGap（未归向成交）实测——**不是固定量级**

`total - outer - inner` 实测：

| 读数 | total | outer+inner | gap | 占比 |
|---|---|---|---|---|
| 002714@09:53（任务书记录向量） | 91083 | 91078 | 5 手 | 0.0055% |
| 002714@10:09 | 121808 | 121796 | 12 手 | 0.0099% |
| 600519@10:09 | 7154 | 7109 | 45 手 | **0.6290%** |

- 残差解释：**未归向成交**——集合竞价与价间成交计入总量（f6 与 f37 一致，均为成交量），但既不算外盘也不算内盘。
- 因此「实测 < 0.1%」只对 002714 成立，**不是不变式**（600519 实测 0.629%）；产品代码**不据残差修正读数**，`snapshot.total/outer/inner` 原样等于 f6/f7/f8（`r3-parse.mjs` 逐字段断言）。占比一律以**当日总量**为分母（不以外盘+内盘为分母）。

## 结论

1. cn 报价行的 f6/f7/f8/f30/f47/f48 足以在零额外请求下给出「当日累计主动买盘快照」；hk 行的同位置无此语义（f7/f8 恒 0、f47/f48 非涨跌停价），故能力只在 cn 实例挂载。
2. 失败语义实测：未知代码短 body（`v_pv_none_match="1";`，1 字段 < 35）→ `TRADING_UNSUPPORTED_SYMBOL`；hk 直调 → `TRADING_NOT_IMPLEMENTED`。两者都**不**返回 0 读数。
3. 未验证项：`spikes/impl-cn-hk/REVIEW-LOG` 级别的长期跟踪（涨跌停一字板/对倒日的失真幅度）未做，需要后续按交易日采样；本 spike 只覆盖 2026-10-13 连续竞价时段两标的。

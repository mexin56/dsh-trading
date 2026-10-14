# 证据：银河星耀数智（AmazingData / tgw）能力面与门槛 + 腾讯/东财三方对照

- 调查日期：2026-10-14（Asia/Shanghai）
- 探针环境：本机（Darwin）。`127.0.0.1:8191` 无进程监听（`lsof -nP -iTCP:8191 -sTCP:LISTEN` 空），
  故 xysz 侧只能引用已提交证据 `spikes/impl-xysz/`（2026-09-28，13 项全过）。
- 边界：只新增本目录文件；未修改任何既有文件；未执行 git 命令。
- 抓取台账见文末 §7。

---

## 0. 一句话结论

xysz 上游（AmazingData）是一个**能力面明显宽于本仓适配面**的券商数据服务：上游覆盖股票/指数/
场内基金（ETF）/可转债/期权/港股通/中金所期货，K 线自 2013 年（期货自 2010-04、期权自 2015、
港股通自 2023），且**原生支持实时订阅**；但 `connector-xysz` 是 **A 股股票-only 的数据面切片**，
只暴露 10 个周期、只取 `EXTRA_STOCK_A` 名册、**未接订阅面**（走 REST 轮询）、且港股形态显式拒绝。
腾讯与东财是公开端点、无官方授权、有各自的静默降级与路径级失效。

---

## 1. 周期覆盖（三家）

### 1.1 结论表

dsh-trading 的规范周期全集是 **16 个**：`1m/3m/5m/15m/30m/1h/2h/4h/6h/8h/12h/1d/3d/1w/1M`
（`packages/api/src/index.ts:25-40`）。三家各取子集：

| 源 | 仓库代码里**真的映射了**的周期 | 出处 |
|---|---|---|
| 腾讯 cn | `5m` / `30m` / `1d` / `1w` / `1M`（共 5 个） | `packages/connector-tencent/src/rest.ts:150-156` |
| 东财 cn+hk | `1m` / `5m` / `15m` / `30m` / `1h` / `1d` / `1w` / `1M`（共 8 个，cn/hk 共用同一映射表） | `packages/connector-eastmoney/src/rest.ts:26-40` |
| xysz cn | 白名单 `1m/3m/5m/15m/30m/1h/2h/1d/1w/1M`（共 10 个） | `packages/connector-xysz/src/rest.ts:31`、`:34-41` |

注：腾讯的 `5m`/`30m` 是 `cn` 专属——`hk` 实例请求分钟周期一律抛
`TRADING_UNSUPPORTED_INTERVAL`（`packages/connector-tencent/src/rest.ts:836-839`），
故 hk 实际只有 `1d/1w/1M` 三个。

**关键区分**：腾讯与东财是**连接器自己做映射**（`INTERVAL_TO_TENCENT` / `mapIntervalToKlt`），
xysz **连接器不做任何映射**——只做白名单校验后把 `interval` 字符串**原样透传**给上游：

> `packages/connector-xysz/src/rest.ts:233`
> `const data = await this.requestJson<KlinePayload>('/api/v1/klines', { symbol: canonical, interval, limit })`

因此 xysz 的真实周期映射落在**本仓之外的 `xysz-api`**（`src/rest.ts:33` 注释称
「与 xysz-api 的 `_INTERVAL_TO_PERIOD` 一一对应」，但该服务源码不在本仓，见 §5「未找到证据」）。

### 1.2 上游 AmazingData 的权威周期枚举（PDF 手册）

`AmazingData开发手册.pdf` §4.1.7「数据周期 Period」（本地副本
`spikes/impl-xysz-capability-recon/raw/AmazingData-manual.txt`，对应 PDF 第 132 页）：

| 枚举值 | 含义 | 连接器是否暴露 |
|---|---|---|
| `Period.min1` | 1 分钟线 | 是（`1m`） |
| `Period.min3` | 3 分钟线 | 是（`3m`） |
| `Period.min5` | 5 分钟线 | 是（`5m`） |
| `Period.min10` | **10 分钟线** | **否**（白名单无 `10m`） |
| `Period.min15` | 15 分钟线 | 是（`15m`） |
| `Period.min30` | 30 分钟线 | 是（`30m`） |
| `Period.min60` | 60 分钟线 | 是（`1h`，命名对应） |
| `Period.min120` | 120 分钟线 | 是（`2h`，命名对应） |
| `Period.day` | 日线 | 是（`1d`） |
| `Period.week` | 周线 | 是（`1w`） |
| `Period.month` | 月线 | 是（`1M`） |
| `Period.season` | **季度线** | **否** |
| `Period.year` | **年线** | **否** |

⇒ 上游周期**多于**连接器白名单 3 项（`min10` / `season` / `year`）；连接器白名单**不超出**上游枚举。

### 1.3 已实证的周期（真的打过网络的）

| 源 | 已实证周期 | 证据 |
|---|---|---|
| xysz | `1d`(30 根)、`1m`(60 根)、`1w`(8 根)、`1M`(6 根) —— **共 4 个** | `spikes/impl-xysz/r3-verify-summary.json` |
| xysz | `3m/5m/15m/30m/1h/2h` —— **零实证** | 同上（summary 无这些项） |
| 腾讯 | `m1`(800 根)、`m5`、日/周/月 | `spikes/impl-five-day-1m-probe/EVIDENCE.md:27-52`、`spikes/impl-tencent-minute/EVIDENCE.md:13-21` |
| 东财 | `klt=1`(当日)、`klt=5`(1000 根)、`trends2 ndays=1/5`、日 K | `spikes/impl-five-day-1m-probe/EVIDENCE.md:64-88` |

⇒ **xysz 白名单里的 6 个周期（`3m/5m/15m/30m/1h/2h`）在本仓没有任何真实响应证据。**

---

## 2. 品种

### 2.1 A 股各板块

| 板块 | 腾讯 cn | 东财 cn | xysz cn |
|---|---|---|---|
| 主板（60/00） | 支持 | 支持 | 支持 |
| 创业板（300） | 支持（`0/3`→sz） | 支持（`0/3`→SZ） | 支持 |
| 科创板（688） | 支持（`6`→sh，注释明写「含科创板 688」） | 支持（`6`→SH） | 支持 |
| 北交所（4/8/92） | **不支持**（显式排除） | 形态映射支持 | 支持（`4/8`→BJ） |

出处：
- 腾讯：`packages/connector-tencent/src/rest.ts:60-61`——「6/9 开头→sh（沪，含科创板 688），
  5 开头→sh（沪市基金/ETF），0/3 开头→sz（深，含创业板 300；知名上海指数 000688/000300 等推断为 sh）。
  **4/8 开头（北交所）不在本切片支持范围**。」；`:87-91` 实现。
- 东财：`packages/connector-eastmoney/src/rest.ts:216-225`——`6/5/9/KNOWN_SH_INDICES`→SH，
  `0/3/1`→SZ，`8/4/92`→**BJ**；`:232` BJ 与 SZ 共用 `0.` secid 前缀。
  测试固化：`packages/connector-eastmoney/test/template.test.ts:34`（`832023.BJ` → `0.832023`）。
  **注意：该条只有单测固化，无真实网络响应证据。**
- xysz：`packages/connector-xysz/src/rest.ts:50-54`（`4|8`→BJ）、`:83-84`；
  Agent Note 记北交所 348 只：`.agents/notes/implemented/architecture/2026-09-28-xysz-amazingdata-cn-data-source.md:40`（「覆盖北交所 348 只」）。

### 2.2 ETF 与指数

**xysz 名册 5570 只 = 纯股票，不含 ETF、不含指数。**

| 事实 | 证据 |
|---|---|
| 连接器用 `security_type='EXTRA_STOCK_A'` 取名册 | `packages/connector-xysz/src/rest.ts:271` |
| 上游定义：`EXTRA_STOCK_A` = 「上交所 A 股、深交所 A 股和北交所的股票列表」 | AmazingData 手册 §4.1.1（`raw/AmazingData-manual.txt`） |
| 实测 5570 = SH 2320 + SZ 2902 + BJ 348 | Agent Note `…2026-09-28-xysz-amazingdata-cn-data-source.md:113`；`spikes/impl-xysz/r3-verify-summary.json`（`total: 5570`） |
| 上游**另有** `EXTRA_ETF`（沪深 ETF 列表）、`EXTRA_INDEX_A`（沪深北指数列表）等代码类型，连接器**未暴露** | 手册 §4.1.1 |

⇒ 「`cn_list_instruments` → A 股名册（沪深北 ~5570 只）」（`packages/connector-xysz/README.md:44`）
措辞准确；但**上游能取 ETF/指数，连接器取不到**。这与「数据详情」表里「场内基金」「指数」均有
Level-1 快照与 K 线、且支持实时订阅（`raw/amazing-ptradeapi-index.txt` §2）形成能力落差。

腾讯 cn 的 ETF/指数：`packages/connector-tencent/src/rest.ts:54`（`KNOWN_SH_INDICES` =
000688/000300/000016/000905/000852）、`:60`（5 开头→沪市基金/ETF）；
单测仅覆盖**符号归一**（`test/market-data.test.ts:139-143`），**无 cn 指数/ETF 的真实端点响应证据**。
东财 ETF：有真实响应 fixture + 实测注释（`test/template.test.ts:131-137`、`:320-322`、
`.agents/notes/implemented/feature/2026-09-08-eastmoney-hk-market.md:15-17`）。

### 2.3 港股与期货

| 市场 | 腾讯 | 东财 | xysz |
|---|---|---|---|
| 港股 | 支持（报价 + 日/周/月 K）；**分钟线不支持** | 支持（报价 + 1m trends2 + 5m + 日 K） | **连接器显式拒绝**；上游 SDK 支持港股通（2023 至今） |
| 期货 | 不支持 | 不支持 | **连接器不暴露**；上游支持中金所（2010-04 至今） |

出处：
- 腾讯 hk 分钟线：`packages/connector-tencent/src/rest.ts:823-824`（注释）、`:836-839`（抛
  `TRADING_UNSUPPORTED_INTERVAL`）；`.agents/notes/implemented/feature/2026-09-08-eastmoney-hk-market.md:29`。
- 腾讯 hk 日/周/月：`packages/connector-tencent/src/rest.ts:846`（`hkfqkline/get`）。
- 东财 hk：`.agents/notes/implemented/feature/2026-09-08-eastmoney-hk-market.md:13-23`；
  `spikes/impl-eastmoney-hk/`（4 个原始响应）。
- xysz 港股拒绝：`packages/connector-xysz/src/rest.ts:65-71`；实测
  `spikes/impl-xysz/r3-verify-summary.json` 第 13 项（`00700.HK` → `TRADING_UNSUPPORTED_SYMBOL`）。
- 上游能力（港股通 2023 至今 / 期货 2010-04 至今）：`raw/amazing-ptradeapi-index.txt`「2. 数据详情」表。
- 东财/腾讯期货：`grep -i "futures|期货"` 在 `packages/connector-eastmoney/src/index.ts` 与
  `packages/connector-tencent/src/index.ts` **零命中**。

---

## 3. 历史深度

### 3.1 xysz：官方文档称 A 股 K 线自 2013 年

| 声明位置 | 原文 |
|---|---|
| 连接器工具描述 | 「upstream serves the full A-share history **since 2013**」——`packages/connector-xysz/src/index.ts:154` |
| 连接器 README | 「K 线（…，**A 股全历史**）」——`packages/connector-xysz/README.md:42` |
| 连接器指南 | 「支持 1m~1M K 线（**A 股全历史自 2013**）」——`docs/guides/connectors-guide.md:17` |
| 上游官方文档 | 「股票 Level-1 快照、K 线数据 **2013 年至今**」——`raw/amazing-ptradeapi-index.txt` |

**实测深度**：`spikes/impl-xysz/r3-verify-summary.json` 的 `klines 1d` 只取了 **30 根**
（2026-06-15 → 2026-10-14 附近），未做深度探测。⇒ 「自 2013」有官方文档支持，
但**本仓无深度实测证据**；单请求上限亦未知（`spikes/impl-five-day-1m-probe/EVIDENCE.md:128-131`
明写「单请求上限未知」）。

### 3.2 东财日 K：`dktotal` 口径 = 该标的全部日 K 根数；可回溯至上市首日

本次实测（2026-10-14，`raw/eastmoney-day-lmt*.json`）：

| 请求 | 返回根数 | `dktotal` | 首根 | 末根 |
|---|---|---|---|---|
| `secid=1.600519&klt=101&fqt=1&lmt=100` | 100 | 6020 | 2026-05-19 | 2026-10-14 |
| `...&lmt=5000` | 5000 | 6020 | 2005-12-01 | 2026-10-14 |
| `...&lmt=20000` | **6020** | 6020 | **2001-08-27** | 2026-10-14 |

⇒ 东财日 K **无截断**：`lmt` 给足即返回 `dktotal` 根全量，600519 最早到 **2001-08-27**（贵州茅台
上市首日）。港股对照：`dktotal=5478`（`spikes/impl-eastmoney-hk/kline-1d-00700.raw.json`，00700 腾讯控股）。

`dktotal` 字段在连接器里**未被消费**（`packages/connector-eastmoney/src/rest.ts` 中零命中），
仅存在于原始响应。

### 3.3 腾讯：日 K 上限约 800 根（≈3.2 年），**超限静默降级到 641 根**

本次实测（2026-10-14，`raw/tencent-day-count*.json`，端点
`web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,<count>,qfq`）：

| `count` | 实际返回 | 首根 | 末根 |
|---|---|---|---|
| 800 | **801** | 2023-06-21 | 2026-10-14 |
| 801 | **641**（静默降级） | 2024-02-21 | 2026-10-14 |
| 900 / 1000 / 1200 / 1600 | 641（同上） | 2024-02-21 | 2026-10-14 |
| 2000 | 641（同上） | 2024-02-21 | 2026-10-14 |
| 5000 | 0（`code:0`、`data:[]`，**param error 语义**） | — | — |

⇒ 腾讯日 K 有效上限 **800 请求值 / 801 根返回**；超过即**静默降级**（HTTP 仍 200），
到 5000 才硬失败。响应**无 `dktotal` 之类总量字段**。
连接器侧另有硬 cap：`packages/connector-tencent/src/rest.ts:841` `Math.min(limit, 800)`
——即经 dsh-trading 走腾讯**永远拿不到超过 801 根日 K**（≈3.2 年）。

桥侧校验上限 `MAX_KLINE_LIMIT = 2500`（`packages/bot-api/src/bridge.ts:221`，`:852-853` 只校验不截断）。

---

## 4. 实时性

### 4.1 三家的订阅/轮询模型与最小间隔（以仓库常量为准）

| 源 | 模型 | 最小间隔 | 默认间隔 | 出处 |
|---|---|---|---|---|
| 腾讯 cn/hk | REST **轮询**（无推送面） | **250 ms** | 5000 ms | `packages/connector-tencent/src/index.ts:81-86`（注释「腾讯公共端点无推送面」）、`:147-156`（`:148` 取 max） |
| 东财 cn/hk | REST **轮询** | **1000 ms** | 5000 ms | `packages/connector-eastmoney/src/index.ts:88-95`（`:89` `Math.max(options?.intervalMs ?? 5_000, 1_000)`） |
| xysz cn | REST **轮询** | **1000 ms** | 5000 ms | `packages/connector-xysz/src/index.ts:63-64`（`SUBSCRIBE_MIN_MS = 1000` / `SUBSCRIBE_DEFAULT_MS = 5000`）、`:99-108` |

三家 `subscribeTicker` 失败都是**静默跳过、下一 tick 重试**（腾讯 `:150-151`、东财 `:91`、
xysz `:102-103`）。

### 4.2 xysz 是拉取还是订阅

**连接器侧是拉取（REST 轮询），不是上游订阅。**

- `.agents/notes/implemented/architecture/2026-09-28-xysz-amazingdata-cn-data-source.md:97-98`
  明写：「**准实时而非推送**：`subscribeTicker` 以 REST 轮询实现（默认 5s），不是上游推送订阅
  （SDK 的 `SubscribeData` 回调面未接入封装服务）。」
- 上游 AmazingData **原生支持**实时订阅：`SubscribeData.register(code_list, period)` +
  `onSnapshot` / `onSnapshotindex` / `OnKLine`（`raw/amazing-ptradeapi-index.txt` §3.5.3、
  §3.4.2.2）；文档「数据详情」表「是否支持实时订阅」一列对股票/指数/债券/场内基金/期权/港股通/期货
  **全部为「是」**。
- 上游订阅周期示例用 `Period.min1`（`raw/amazing-ptradeapi-index.txt`，§3.5.3.9 实时 K 线）。

⇒ 能力落差：**上游可推、封装服务未接、连接器只能轮询 1s 起**。

### 4.3 「SDK 调用串行化」对并发吞吐意味着什么

本仓能找到的**全部**相关文字（就这些，无更多）：

| 事实 | 出处 |
|---|---|
| 「`xysz-api` 承担登录单例与 SDK 调用串行化（见该服务 README）」 | `packages/connector-xysz/README.md:14` |
| 「进程内**登录单例** + SDK 调用锁串行化（避免并发登录竞态）；调用失败自动重登重试一次」 | Agent Note `…2026-09-28-xysz-amazingdata-cn-data-source.md:25` |
| 「登录是秒级且上游有 `UsedWeekFlow` 计数」 | 同上 `:66` |
| 「登录态是全局单点…下游账号被顶掉…需要 `POST /admin/relogin` 或重启单元；上游 `ForceLogout` 会出现在权限码里但 SDK 未自动处理」 | 同上 `:86-87` |
| 封装服务暴露面含 `/health`、`/admin/relogin`、`/api/v1/{calendar,instruments,klines,snapshot,ticker,orderbook,stock-basic,fundamentals}`；名册/日历 900s TTL 缓存 | 同上 `:26-28` |

**本仓未记录**：串行队列的**深度上限**、**排队超时**、**并发请求数上限**、吞吐量数字。
连接器侧唯一相关常量是单次请求超时 `timeoutMs` 默认 **60000 ms**
（`packages/connector-xysz/src/rest.ts:170`、`packages/connector-xysz/src/index.ts:51`）。

可推断（**属推断，非证据**）：串行化 + 单次调用 60s 超时意味着**同时发 N 个请求不能加速**，
只会排队；上游 SDK 无并发能力时吞吐上限 = 单次调用延迟的倒数。名册 28.5s 一类长调用会**阻塞整个队列**。

---

## 5. 授权与门槛

### 5.1 腾讯 / 东财：公开端点，无官方授权（仓库已写明）

| 事实 | 出处 |
|---|---|
| 「腾讯公共行情端点：公开、无 key、**无官方授权**；个人使用边界自负，以腾讯服务条款为准。本仓不缓存、不批量抓取、不再分发行情数据」 | `packages/connector-tencent/README.md:23-25` |
| 腾讯端点合规头注 | `packages/connector-tencent/src/rest.ts:21-22` |
| 铁律 #5 措辞：「Public endpoints... **no official authorization**... 不缓存不再分发」 | `docs/guides/replication.md:116` |
| 仓库级「Zero data re-distribution」条款 | `README.md:142` |
| 东财列为「免密公共行情／无需配置」 | `docs/guides/connectors-guide.md:11` |
| 东财限频敏感（2026-09-08 探测中 push2his API 路径整 IP 一度断开，约 20 分钟恢复） | `.agents/notes/implemented/feature/2026-09-08-eastmoney-hk-market.md:35` |

### 5.2 xysz：营业部开通 + 本机/局域网 sidecar

**门槛（公开资料可证）**：

| 事实 | 出处（URL + 抓取日期） |
|---|---|
| 「SDK 的账号、密码、ip 和端口号需**联系您的开户营业部申请开通权限之后获取**」 | <https://amazing.ptradeapi.com/index.html>（AmazingData API 文档 §3.5.1.1 登录），2026-10-14 |
| 「如需参考或使用本项目…**开通银河证券 AmazingData 权限**和获取技术支持」 | 同上，文档首屏 |
| 试用账户注册要求「**您是否为银河开户客户**」；非开户客户提示「请在中国银河证券开户完成之后再星耀数智服务平台注册试用账户」；试用账户带**权限到期日期** | <https://www.chinastock.com.cn/newsite/cgs-services/strategyTrade/geWuInstitution.html>，2026-10-14 |
| 银河官网口径：「SDK / 金融数据终端」两种服务形式；「集成数据的查询、推送、回放为一体的**高性能高并发 api**，支持 Python 和 C++」；业务联系邮箱 `xysz@chinastock.com.cn` | 同上 |
| 仓库侧：「联系中国银河证券营业部开通星耀数智权限」 | `docs/guides/connectors-guide.md:17` |
| 运行模式两档：`kColocationMode`（托管机房）/ `kInternetMode`（互联网） | <https://github.com/yfdu1989/tgw>，2026-10-14 |
| 上游登录需 `username/password/host/port`（`ad.login`） | Agent Note `…2026-09-28-xysz-amazingdata-cn-data-source.md:10-13`；实测 `spikes/impl-xysz/r3-health.raw.json`（`upstream: {host: 101.230.159.235, port: 8600}`，`loggedIn: true`，`sdkVersion: 1.1.9`） |

**是否限本机/局域网**：

- 连接器默认 `apiUrl = http://127.0.0.1:8191`，可选环境变量 `XYSZ_API_URL`
  （`packages/connector-xysz/src/rest.ts:100-104`、`:168`）。
- 封装服务部署在**局域网 Ubuntu 机器**并监听 `0.0.0.0:8191`
  （Agent Note `:21`、`:30`）；`:49-59` 记 ufw 默认只放行 `22/tcp` 与 `8190/tcp`，
  **8191 未放行**，实测 Mac 直连超时，当前走 SSH 隧道
  `ssh -f -N -L 127.0.0.1:8191:127.0.0.1:8191 local1`。
- 连接器头部注释同一口径：`packages/connector-xysz/src/index.ts:42`
  （「局域网 192.168.31.50:8191 或本机 SSH 隧道 127.0.0.1:8191」）。
- 服务**无鉴权**，只应存在于受信网络（Agent Note `:88-89`）。

⇒ 「是否限本机/局域网」的准确表述：**上游 SDK 不限本机**（`host/port` 由券商下发，
文档示例是互联网模式与托管机房模式二选一）；**本仓的 xysz-api 封装当前只在本机/局域网可达**
（ufw 未放行 + 无鉴权），这是部署约束而非上游限制。

### 5.3 费用与并发席位

- **费用：未找到公开证据。** AmazingData API 文档、银河官网星耀数智页、tgw 仓库 README
  均未公布价格/计费方式（全文检索「费用/付费/收费」在 AmazingData 文档中仅命中财务报表字段名，
  非产品定价）。
- **并发席位限制：未找到公开证据。** 银河官网只说「高性能高并发 api」；tgw README 只给
  运行模式与线程参数示例（`qtcp_channel_thread = 2`），未给账号级并发上限。
  仓库侧唯一相关线索是 Agent Note `:66` 提到的上游 `UsedWeekFlow` 计数
  （**周流量计数**存在，具体阈值未记录）与 `:87` 的 `ForceLogout`（登录态被顶）。

---

## 6. 稳定性与已知缺陷（本仓已记录）

| # | 缺陷 | 出处 | 现状 |
|---|---|---|---|
| 1 | 东财 `/api/qt/stock/get` 对任意 secid **传输层空回**（curl `(52) Empty reply from server`），push2 与 push2his 两域皆然；同刻同域同 UA 的 `ulist.np/get`/`trends2/get`/`kline/get` 正常 → 失败跟**路径**走，非网络故障 | `packages/connector-eastmoney/src/rest.ts:344-349`；`.agents/notes/implemented/feature/2026-09-08-eastmoney-hk-market.md:62-68`；`spikes/impl-eastmoney-quote-endpoint/EVIDENCE.md:17-29` | 已改用 `ulist.np/get` |
| 2 | 腾讯**港股无分钟线**（`hkMinute` 端点 `code:11 undefined method`；`kline/mkline` 对 `hk00700` 301→web3 空响应） | `packages/connector-tencent/src/rest.ts:823-824`、`:836-839`；`.agents/notes/implemented/feature/2026-09-08-eastmoney-hk-market.md:29`；`spikes/impl-five-day-1m-probe/EVIDENCE.md:34-36` | 结构性无解，已换东财 |
| 3 | 腾讯 **wire 大小写敏感**：`r_hkHSI` 有行、`r_hkhsi` 回 `v_pv_none_match="1"`（2026-10-14 实测） | `packages/connector-tencent/test/market-data.test.ts:339-347` | 请求 wire 保留原大小写 |
| 4 | 腾讯 **分钟线 5m/30m 端点一度被判「不可达」**，实为 host/参数形态错（须 `ifzq.gtimg.cn` 无 `www.`，`param=<wire>,m5,,<count>` 四段无 qfq） | `spikes/impl-tencent-minute/EVIDENCE.md:5-11`；`packages/connector-tencent/src/rest.ts:19` 仍留旧注释 | 已实现 |
| 5 | 腾讯日/分钟线**超限静默降级**：`count=801..2000` → 641 根（HTTP 200）；`count=5000` → `data:[]`；分钟线 `count>800` → 320 根 | `raw/tencent-day-count*.json`（本次）；`spikes/impl-five-day-1m-probe/EVIDENCE.md:41-49` | 连接器 `rest.ts:841` cap 800 掩盖了日 K 的降级 |
| 6 | 东财 `trends2` `ndays>1` 时**非当日 bar 开价恒为 0.00**（cn 964/1007、hk 1324/1367）；与腾讯 m1 逐根对齐 241/241 根 open 不一致 | `.agents/notes/implemented/feature/2026-09-08-eastmoney-hk-market.md:84-91`；`spikes/impl-five-day-1m-probe/EVIDENCE.md:76-113` | 已用「同日前一根 close」重建 + clamp（属派生值） |
| 7 | 东财 `kline/get` 的 `klt=1` **只有当日**，`lmt` 与 `end` 均被上游忽略；`trends2 ndays` 上限 5 | `spikes/impl-five-day-1m-probe/EVIDENCE.md:64-88`；`packages/connector-eastmoney/src/rest.ts:416-419` | 已改走 trends2 |
| 8 | 东财公共端**限频敏感**（探测中 push2his 路径整 IP 断开约 20 分钟） | `.agents/notes/implemented/feature/2026-09-08-eastmoney-hk-market.md:35` | 客户端 60s 轮询，批量探测需节制 |
| 9 | xysz 名册拉取 **28.5s**（5570 行），TTL 缓存后 0.007s | `spikes/impl-xysz/r3-verify-summary.json`（`latencyMs: 28506`）；Agent Note `:27-28`、`:77` | 封装服务侧 900s TTL 缓存 |
| 10 | xysz 单次调用延迟：`1d` K 线 103 ms、`1m` 328 ms、orderbook **2801 ms**、fundamentals 853 ms、health 34 ms | `spikes/impl-xysz/r3-verify-summary.json` | 串行队列下按最慢项阻塞 |
| 11 | 东财报价**价格缩放按行取**：若按市场级常数 ÷100 会把 cn ETF 读成 10 倍（游戏ETF华夏 1.059 → 10.59） | `.agents/notes/implemented/feature/2026-09-08-eastmoney-hk-market.md:15-17`；`packages/connector-eastmoney/test/template.test.ts:131-137` | 已改按行 `f1` |
| 12 | 腾讯 cn 实例的动态挂载方法 `getActiveBuySnapshot` **只在 cn 存在**，hk 实例必须缺席 | `packages/connector-tencent/src/index.ts:100-110` | 已按「方法是否存在」区分能力 |

---

## 7. 「声称 vs 代码实现/实证」不一致清单

| # | 声称 | 位置 | 实测/代码事实 | 性质 |
|---|---|---|---|---|
| A | 「分钟线端点（kline/mkline）本出口不可达，**未实现**（待验证）；支持 interval = **1d/1w/1M**」 | `packages/connector-tencent/README.md:21` | 代码**已实现** `5m`/`30m`（`rest.ts:150-156`、`:843-846`），且 2026-08-31 已实证可达（`spikes/impl-tencent-minute/EVIDENCE.md`）；`rest.ts:19` 同款旧注释仍在 | 文档滞后于代码 |
| B | 「周期词汇 `1m/3m/5m/15m/30m/1h/2h/1d/1w/1M` **映射**上游 AmazingData `Period`」 | Agent Note `…2026-09-28-xysz-amazingdata-cn-data-source.md:42`；`packages/connector-xysz/src/rest.ts:33` 注释称「与 xysz-api 的 `_INTERVAL_TO_PERIOD` 一一对应」 | 连接器**无任何映射代码**，`interval` 原样透传（`rest.ts:233`）；映射在**本仓之外**的 `xysz-api` | 声称的映射不可在本仓验证 |
| C | xysz 支持 10 个周期 | `packages/connector-xysz/README.md:42`、`:51-52`、`src/index.ts:154`、`docs/guides/connectors-guide.md:17` | 白名单确有 10 个（`rest.ts:31`），但**仅 4 个（1d/1m/1w/1M）有真实响应证据**；`3m/5m/15m/30m/1h/2h` 零实证 | 声称 > 实证 |
| D | 「上游覆盖 A 股**全部周期**」（`rest.ts:30` 注释） | `packages/connector-xysz/src/rest.ts:30` | 上游 Period 枚举共 13 项，连接器白名单仅 10 项；`min10`/`season`/`year` 未暴露（手册 §4.1.7） | 「全部周期」措辞过宽 |
| E | 「A 股**全历史**自 2013」 | `packages/connector-xysz/src/index.ts:154`、`docs/guides/connectors-guide.md:17` | 与上游官方文档一致（「2013 年至今」），但**本仓无深度实测**；单请求上限未知 | 有文档支持、无实测 |
| F | 「`cn_list_instruments` → A 股名册（沪深北 ~5570 只）」 | `packages/connector-xysz/README.md:44` | 属实（5570 = 2320+2902+348 股票）；但**不含 ETF/指数**，而上游有 `EXTRA_ETF`/`EXTRA_INDEX_A` | 表述准确，能力面落差需另注 |
| G | `connector-eastmoney/README.md` 整篇仍是脚手架模板（「本包是脚手架源，不是可安装的连接器」「7 个市场前缀工具」） | `packages/connector-eastmoney/README.md:1-34` | 实际已是 cn+hk 双市场真实连接器（`src/rest.ts:26-55`、`src/index.ts:88-95`、`spikes/impl-eastmoney-hk/`） | 文档完全未重写 |
| H | `spikes/impl-five-day-1m-probe/EVIDENCE.md:58` 记桥侧 `MAX_KLINE_LIMIT = 1000` | 该 spike | 当前源码为 **2500**（`packages/bot-api/src/bridge.ts:221`） | spike 记录已过时 |

---

## 8. 「未找到证据」清单

1. **`xysz-api` 源码与其 `_INTERVAL_TO_PERIOD` 映射表**——不在本仓，无法核验 10 个周期与上游
   `Period` 的一一对应关系。
2. **xysz 单请求 K 线根数上限**——`spikes/impl-five-day-1m-probe/EVIDENCE.md:128-131` 明标 unknown
   （不可达层 = 本地 sidecar）；本次 `127.0.0.1:8191` 亦无监听。
3. **xysz K 线深度实测**——无任何早于 2026-06 的取数证据；「自 2013」仅官方文档口径。
4. **`3m/5m/15m/30m/1h/2h` 在 xysz 上的真实响应**——13 项验证覆盖 1d/1m/1w/1M，其余零证据。
5. **xysz-api 串行队列的深度上限 / 排队超时 / 吞吐量**——仓库只有「串行化」四个字，
   无队列参数、无超时、无 QPS 数字。
6. **星耀数智/AmazingData 的费用与计费方式**——官方文档、银河官网、tgw 仓库均未公布。
7. **星耀数智/AmazingData 的账号级并发上限或席位限制**——未找到公开证据；
   仅知存在上游 `UsedWeekFlow` 周流量计数与 `ForceLogout` 顶号行为（Agent Note `:66`、`:87`），
   阈值未知。
8. **xysz 是否限本机/局域网（上游侧）**——上游 `host/port` 由券商下发，文档给出
   `kInternetMode` 与 `kColocationMode` 两档；**具体到本账号是否限源 IP 未找到证据**。
   本仓 xysz-api 的「本机/局域网」约束是**部署侧**（ufw 未放行 + 无鉴权），不是上游限制。
9. **腾讯 cn 指数（000300 等）与 ETF 的真实端点响应**——单测只固化符号归一
   （`packages/connector-tencent/test/market-data.test.ts:139-143`），无真实响应 fixture。
10. **东财北交所 secid 的真实响应**——`832023.BJ → 0.832023` 只有单测固化
    （`packages/connector-eastmoney/test/template.test.ts:34`），无网络证据。
11. **腾讯日 K 5000 以上是否还有别的降级档**——本次只探到 5000 硬失败。
12. **腾讯历史日 K 最早可到哪一年**——`count=800` 只回到 2023-06-21，上游无 `dktotal`
    类总量字段，且 >800 即降级到 641 根，**无法用该端点取更早历史**（= 结论本身，非缺口）。

---

## 9. 抓取台账（throttle 记录）

UA 一律最小 `Mozilla/5.0`，未伪造 Referer。

| 域名 | 次数 | 用途 |
|---|---|---|
| `amazing.ptradeapi.com` | 3 | `index.html`（409 KB 全站文档）、2 个 JS 资源（未含附录） |
| `raw.githubusercontent.com` | 4 | README×2（404）、PDF×2（1 成功，4.0 MB / 148 页） |
| `api.github.com` | 1 | tree 查询（403，未用） |
| `github.com` | 2 | 文档仓文件列表、`yfdu1989/tgw` README |
| `web.ifzq.gtimg.cn` | 8 | 腾讯日 K 深度探针（count=800/801/900/1000/1200/1600/2000/5000） |
| `push2his.eastmoney.com` | 2 | 东财日 K 深度探针（lmt=5000/20000） |
| `www.chinastock.com.cn` | 1 | 星耀数智服务页（开通/试用口径） |

原始落盘目录：`spikes/impl-xysz-capability-recon/raw/`（交付时只保留行情原始响应）。

**交付清理（Lead，2026-10-14）**：为免把第三方文档副本（版权归属未知、且单文件 4.1 MB）并入公开仓，
已从 `raw/` 删除下列本地副本；结论只依赖「URL + 抓取日期 + 章节号」，可按右列重取：

| 已删除文件 | 重新取法 |
|---|---|
| `AmazingData-manual.pdf` / `.txt`（148 页，§4.1.1 / §4.1.7 | `raw.githubusercontent.com` 文档仓 PDF，见本文件 §1.2 / §2.2 的引用 |
| `amazing-ptradeapi-index.html` / `.txt`、`app.js` | `https://amazing.ptradeapi.com/index.html`（§3.5.1.1 开通口径） |
| `chinastock-xingyao.html` | `https://www.chinastock.com.cn` 星耀数智服务页（开户/试用口径） |
| `gh-repo.html`、`tgw-readme.html` | `https://github.com/yfdu1989/tgw` README（kInternetMode/kColocationMode） |

---

## 10. 复现命令

```bash
# 腾讯日 K 深度（800 是有效上限，801 起静默降级到 641）
for c in 800 801 900 1200 2000 5000; do
  curl -sS -m 25 -A "Mozilla/5.0" \
    "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,$c,qfq" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);n=(d.get('data') or {}).get('sh600519') or {};k=n.get('qfqday') or [];print('$c',len(k),k[0][0] if k else None,k[-1][0] if k else None)"
done

# 东财日 K 全量（lmt 给足即返回 dktotal 根，600519 → 6020 根，首根 2001-08-27）
curl -sS -m 30 -A "Mozilla/5.0" \
  "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&klt=101&fqt=1&lmt=20000&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58" \
| python3 -c "import sys,json;d=json.load(sys.stdin)['data'];k=d['klines'];print(len(k),d['dktotal'],k[0].split(',')[0],k[-1].split(',')[0])"

# xysz：需 xysz-api 在跑（本机 8191 当前无监听）
node spikes/impl-xysz/r3-real-network-verify.mjs
```

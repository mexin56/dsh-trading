# Agent Note: connector-eastmoney 扩展港股面（hk 分钟线/ticker 实证打通）

Status: implemented

## Problem

港股行情长期只有腾讯公开端一个免密源，而腾讯公开端**港股分钟线全不支持**（TRADING_UNSUPPORTED_INTERVAL，replication.md 14 坑之一）——自选「走势」列对港股只能日 K 降级。用户切到 FUTU 本地网关想解分钟线，但 connector-futu 假定网关讲 HTTP（/api/qot/*），**原版 Futu OpenD 11111 端口是 TCP protobuf 协议、无 HTTP 面**（2026-09-08 实证：curl POST /api/qot/get-ticker 无响应）——futu 连接器对原生 OpenD 结构性不可用（ticker 也挂）。需要一条免密、今天就能工作的港股分钟线路径。

## Decision

照抄 connector-tencent「单包双市场」模式扩展 connector-eastmoney：

- **secid 映射**：`00700.HK` / `HK00700` / 裸 5 位数字 → `116.xxxxx`（A 股恒 6 位无歧义），toEastmoneySecid 返回值增 `market` 字段。
- **价格缩放按行取**：报价行自带 `f1` = 该标的的小数位数，报价值 = 上游整数 / 10^f1
  （2026-10-14 实测：cn 股票 f1=2、cn ETF 与 hk 均 f1=3；涨跌幅 f3/f170 两市场都是百分数
  ×100，与 f1 无关）。`eastmoneyPriceScale()` 的市场级常数（cn ×100 / hk ×1000）只作 f1
  缺失时的兜底——按市场取会把 cn ETF 读成 10 倍（游戏ETF华夏 1.059 元 → 10.59 元）。
  见文末 2026-10-14 Addendum。
- **cn/hk 的 1m 都走 trends2 分时端点**（push2his /api/qt/stock/trends2/get?secid=...&ndays=5，2026-10-14 起为五日窗口）：行格式同 kline/get（时间,开,收,高,低,量,额,均价），5 个交易日 ≈ cn 1205 / hk 1655 根；非交易日自然回落最近交易日，与客户端「最后一根 bar 的本地日」筛选语义自洽。kline/get 的 klt=1 只有当日（`lmt`/`end` 被上游忽略），故 cn 也走 trends2。
- **hk 5m/日 K 走 kline/get**（klt=5 已实证返回真实 bar；日 K klt=101 因触发限频未验证成功响应，但同端点同格式，解析器与 cn 共用）。
- **时间锚定**：trends2/kline 分钟时间是 UTC+8 墙钟——新增 utc8WallTimeToEpochMs 固定偏移换算（CN/HK 永久 UTC+8 无夏令时），与机器时区无关；cn 旧路径的机器本地解析保持不动（最小改动）。
- **注册分流**：Config 增 `market: cn|hk`（缺省 cn，存量 cn 行零变化）；index.ts 按 market 选服务键（tradingCnMarketData/tradingHkMarketData）与工具前缀（cn_get_*/hk_get_*）；dataplane.ts 按 config.market 注册 (market, 'eastmoney') 进注册表——GUI 热切换即时生效。
- **hk bundle 接线**：packages/hk 增 connector-eastmoney 依赖 + cordis.patch.yml 增 dataplane 行（config.market=hk）+ hk-trader preset 增 eastmoney 组行（isolate tradingHkMarketData）。设置 UI PROVIDER_LABELS 中 eastmoney 本已声明 markets:['cn','hk']，词汇层零改。
- **路由**：hk.provider=eastmoney 由用户设置决定；tencent/futu/longbridge/tiger 行并存、routeAllows 裁决，互斥语义不变。

## Alternatives considered

- **修 connector-futu 走 OpenD 原生 TCP protobuf**：协议重、需登录/解锁流，成本不成比例。后经官方 `futu-api` SDK 桥接方案落地（见 [2026-09-08-futu-openapi-http-bridge](2026-09-08-futu-openapi-http-bridge.md)），futu 连接器的 HTTP 契约由本地桥承载——futu 面已可用，作为 eastmoney 之外的港股源选项。
- **腾讯 hkMinute 端点**：实证已死（web.ifzq.gtimg.cn/appstock/app/hkMinute/get 返回 code:11 undefined method；kline/mkline 对 hk00700 301→web3 空响应）。腾讯港股分钟线缺口无解，只能换源。
- **hk 分钟线也走 kline/get klt=1**：未实证；trends2 是东财 App 分时同款端点、数据形态更贴合「当日走势」用途。选 trends2。

## Consequences

- 港股自选迷你走势从「日 K 降级」升级为**真日内分时**（1m trends2，固定时段轴 9:30–12:00+13:00–16:00 已在前序 f0feea9 落地）；港股 ticker/涨跌幅同样可由 eastmoney 供给（价格缩放已实证正确）。
- 东财公共端**限频敏感**：2026-09-08 探测中 push2his API 路径一度整 IP 断开（[000]），约 20 分钟后 push2 恢复、push2his 逐步恢复——客户端 60s 轮询对公共端温和，但批量探测需节制。
- trends2/5m/日 K/ticker 四类原始响应存 spikes/impl-eastmoney-hk/（日 K 于限频解除后 12:05 补验成功：rc=0、含 09-04/09-07 真实日线）；真机端到端已验：bridge 1m/5m/ticker 全通（1m 末 bar 与 ticker 价一致），自选列表港股行日内分时 + 固定时段轴渲染正确。
- futu 连接器的 OpenD HTTP 假设问题留作独立议题（要么找到对应 HTTP 网关包装器，要么重写为 TCP protobuf 或标注需第三方桥）。
- 测试：connector-eastmoney 11 个单测全绿（新增 hk secid 映射、×1000 缩放、trends2 解析、5m kline 路由四类用例，全部用真实响应值作 fixture）。

## Addendum (2026-09-08, 审查修正)
- `toEastmoneySecid(symbol, market)` 改为**市场感知**：hk 实例接受 `00700.HK` /
  `HK.00700` / `HK00700` / 裸 1-5 位（`700` → `116.00700`），CN 形态显式拒绝；
  cn 实例反之。此前形态解析与实例市场无关，`700` 会落 `secid=0.700`/`700.SZ`。
- kline/get 时间戳改用 `utc8WallTimeToEpochMs`（与 trends2 同锚），修掉 TZ≠UTC+8
  宿主上 1m 与 5m/日 K 相差 12h 的问题。详见
  [review fixes](../bug-fix/2026-09-08-review-fixes.md)。

## Addendum (2026-10-12, 港股通持股端点)

- hk 实例新增可选能力 `getSouthboundHoldings(symbol)`（东财数据中心
  `RPT_MUTUAL_STOCK_HOLDRANKS`，与 push2/push2his 不同域，需 `data.eastmoney.com`
  的 Referer）；cn 实例该方法完全缺席。空态与故障分离：非港股通标的的上游
  `code=9201`（"返回数据为空"）映射为空序列，其余业务码与 `pages>1` 抛错。
  详见 [港股通持股比例副图](2026-10-12-hk-connect-holding-indicator.md)。
- 本实例在**本机路由指向 tencent 时仍会被消费**（桥按能力跨 provider 在
  `registry.list('hk')` 里选中它）——这与本文原记的「hk.provider=eastmoney
  时才激活」的 `routeAllows` 门不冲突：`routeAllows` 管的是**行情服务**的注册，
  持股端点由桥按能力解析。

## Addendum (2026-10-14, 单标的报价端点失效 → 改用 ulist.np/get)

- `/api/qt/stock/get` 在 2026-10-14 对任意 secid 都是传输层空回（curl `(52) Empty reply
  from server`），push2 与 push2his 两个域都一样；同一时刻、同域、同 UA 的
  `ulist.np/get`、`trends2/get`、`kline/get` 全部正常——失败跟着**路径**走，不是网络故障。
  原始响应与逐只交叉验证见 spikes/impl-eastmoney-quote-endpoint/。
  `getTicker` 因此改打 `ulist.np/get?secids=<单个 secid>`，取值换到列表方言
  （f1/f2/f3/f5/f12/f13/f14/f18/f124：名称在 f14、昨收在 f18、行情时间在 f124）。修复前
  侧栏每只标的都拿不到 ticker，自选行价格显示 `—`、行名停在存进去的代码上。
- **未收录 secid 的契约**：批量端点对无效 secid 是「少返回行」而不是报错（只传无效 secid
  时 `data:null`），故「diff 里拿不到行」判 `TRADING_SYMBOL_NOT_FOUND`，与旧端点
  `data` 为空时的语义一致。
- 同一条已失效的 `stock/get` 仍被 `connector-akshare` 与 `connector-qmt`（本地网关离线
  回退）使用；本机路由不在它们上，故本次未一并验证与改动，留任务看板的跟进卡。
- 同一条 `ulist.np/get` 在批量场景一次传多 secid，承载 `MarketDataService.getTickers`（自选栏每拍
  1 次请求）：行→符号用响应行的 `f13`+`f12` 拼回 secid，不依赖返回顺序；取价仍按行 `f1`。
  契约与桥侧语义见 [批量报价能力](2026-10-14-batch-tickers-capability.md)。

## Addendum (2026-10-14, 五日 1m 窗口与开价重建)

- 1m 从「当日分时」扩为**最近 5 个交易日**（`ndays=5` 是上游上限，`ndays=10` → `rc:1`），
  cn 与 hk 共用同一条 trends2 路由；`limit` 仍按尾部截尾。5 个交易日满窗约
  cn 1205 / hk 1655 根（实测每交易日 cn 241 根、hk 331 根）。
- **上游开价列有缺陷**：`ndays>1` 时只有当日那一段带真实开价，历史交易日每根第 2 列恒为
  `0.00`（2026-10-14 实测 cn 964/1007、hk 1324/1367；probe 2026-10-13 为 241/241、331/331）。
  实现口径是**重建 + clamp**：候选值取同日前一根 close（每个交易日首根取该根自身 close——
  不引入上游未给出的跨日缺口；午后首根用的是午休前最后一根的 close，午休不移动价格），
  再夹进**当根** `[low, high]`（`low/high` 非有限值或 `low > high` 的坏行原样保留）；上游
  `open > 0` 的根不做任何改写。重建的 open 仍是**派生值**（非交易所开价），但自洽：
  clamp 前有 cn 242 根、hk 28 根越界（多数是最小变动价位量级，单根最大 cn 2.99 元，
  2026-10-09 09:31 分钟边界跳空），clamp 后越界 **0 根**，`low <= open <= high` 全量成立。
  close/volume 与腾讯 m1 逐根一致，high/low 有 ≤0.5 舍入差。
- 证据：`spikes/impl-five-day-1m-fetch/`（穿过 `EastmoneyRestClient` 源码的真实请求 + 逐字原始响应）
  与 `spikes/impl-five-day-1m-probe/`（上游能力普查 + 腾讯 m1 交叉验证）。
- 同批契约变更：雅虎 `getKlines` 增加 `limit` 形参并在 REST 层 `slice(-limit)`
  （1m `range=7d` 整窗 2730 根、覆盖 7 个会话）；桥 `MAX_KLINE_LIMIT` 1000 → 2500。
  客户端「五日」级别由同批的 `packages/client-ui-trading` 工作包消费（自选迷你走势仍按
  最后一根 bar 的本地日过滤：cn 241 根/日、hk 331 根/日都小于 1m 的 500 根取数上限，
  当日序列完整落在窗口内，行为不变）。


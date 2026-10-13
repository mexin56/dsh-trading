# Agent Note: A股主动买盘副图盘中实时化（宿主内置 aux 指标 + 桥端点，数据内嵌式退出）

Status: implemented

## Problem

用户报告：图表「主动买盘」副图在**盘中是空白**，当日值要等收盘后（15:05 采集任务跑完）才出现。

根因在数据通路而非渲染。该副图原本是一个**自定义指标** `active_buy_real`：`computeSource` 把 `snapshots.jsonl` 编译成源码里的 `DATA` 常量（由 `cowork/data/active-buy/build_indicator.py` 生成），只在每交易日 15:05 采集任务跑完 close 轮之后经 `indicator_author` 重投一次。当日 bar 在 15:05 之前没有任何日期键 → 空白。图本身有当日 bar（`QuoteStage.withTickerBar` 用 ticker 合并最后一根 K 线），所以缺口只在指标数据。

内嵌式这条通路另有三个硬边界，本次一并解决：

1. **自定义指标契约没有取数能力**：`IndicatorDefinition.compute` 是纯同步函数，自定义指标更是只有 `computeSource` 一个入口，所以外部数据只能编译进源码（`aux`/`computeAux` 缝当时只对内置 definition 生效）。
2. **源码上限 16KB**（`indicators/src/validate.ts` 的 `MAX_SOURCE_LENGTH`）：5 标的 × 120 交易日 ≈ 19.5KB，约再攒 100 个交易日重建就会失败、副图停更。
3. **每次更新都要起一个 agent 会话**，且落库是「整表 store + 进程内缓存」，多宿主共用同一 home 时曾互相覆盖（[cross-process-store-merge-write](../bug-fix/2026-10-09-cross-process-store-merge-write.md)）。

## Decision

**把「主动买盘」从「内嵌数据的自定义指标」改成「宿主内置指标 + 桥端点读本地数据集」**，四层各司其职，接口一次冻结：

1. **契约与连接器（可选能力）**：`@dshtrading/api` 新增 `ActiveBuySnapshot` 与 `MarketDataService.getActiveBuySnapshot?(symbol)`（紧邻 `getSouthboundHoldings?`，同族可选能力写法）。`connector-tencent` 的 **cn 实例**实现它——复用既有的 `#fetchQuoteFields` 报价行（`f6` 总量 / `f7` 外盘 / `f8` 内盘 / `f30` 时间戳 / `f47`/`f48` 涨跌停价），**零额外请求**；hk 实例**方法缺席**（类体声明会让两个市场实例都长出该能力，故按 `connector-eastmoney` 的 hk 港股通持股先例在构造函数内按市场条件挂载 + `declare`）。
2. **桥端点**：`GET /dshtrading/api/active-buy?market=cn&symbol=` 是**唯一**读这份数据集的地方，返回 `{ok, symbol, points[], live?}`。`points` 由文件按 `(symbol,date)` 归并而来（`phase==='close'` 优先，否则取 `time` 最晚，与已退役的 `build_indicator.py` 口径一字不差）、升序、最多 250 个交易日；当日 live 点在「上海今天、能力可用、且文件里今天没有该标的的行」三个条件同时成立时追加，并回填 `live.at`。**能力缺席 / 调用抛错 / 上游日期过期一律只返回文件历史**——不报 500、不补 0、不编值；非 cn 市场固定返回空序列。数据文件是 `<trading home>/active-buy/snapshots.jsonl`，`DSH_TRADING_ACTIVE_BUY_FILE` 可整体覆盖（测试与隔离演练用）。
3. **指标**：新增内置预设 `active-buy`（`pane: 'sub'`、`markets: ['cn']`、`aux: ['cn-active-buy']`、`defaultApplyScope` 只勾 `1d/1w/1M`，同 [hk-connect-holding](2026-10-12-hk-connect-holding-indicator.md) 的决策 7）。`computeAux` 出两条：「净买」柱 = aux 原值（`netSharePct`），「买占」线 = `(100 + 净买)/2`。空序列返回 `[]` → 副图整体隐藏（空 ≠ 0，同款纪律）。
4. **客户端**：按 `${market}:${symbol}` 首取一次（不依赖交易时段与标签可见性），并在 **cn 交易时段窗口内每 5 分钟**复取（窗口判据是纯函数 `isCnPollingWindow`：Asia/Shanghai 工作日 09:25–11:32 / 12:58–15:02）；复取失败或空序列**保留上一次真实序列**，不清空、不造值。竞态守卫改为**代际隔离**，覆盖 A→B→A 时旧应答不得覆盖新标的。副图标题的「盘中」徽标**由数据驱动**（本轮取数里该键确实拿到了 `phase==='live'` 的点），不用「当前是否交易时段」去猜——猜出来的徽标在节假日会说谎。
5. **数据集落点**：`snapshots.jsonl` 从 `cowork/data/active-buy/` 迁到 **trading home**（`~/.dsh-trading/active-buy/`，写入侧 `snapshot.py` 带「拒绝 `~/.dsh` 及路径别名」的 home 守卫）；采集脚本与 `symbols.txt` 留在研究工作区，cowork 侧只留脚本与说明。旧的三件退役产物（`build_indicator.py` / `indicator_source.js` / `indicator_meta.json`）在 cowork 仓留有基线提交，可回溯。
6. **旧指标退役**：自定义指标 `active_buy_real` 及其 5 份 per-symbol `sym` 绑定被内置预设取代——序列天然按标的分，不再需要「把数字代码当参数传」的错绑隐患。

## Alternatives considered

- **保留内嵌数据、把采集+重建频率提到盘中（不动仓库代码）**：最贴合现状、当天可用。否决——每 5 分钟一个 agent 会话只为刷一个读数，且 16KB 上限与「跨进程整表重建」两个结构问题原样留着；用户明确选了彻底方案。
- **给自定义指标契约加 `aux`/`computeAux`（保留内嵌历史 + 只注入当日 live 点）**：改动比新建内置预设大（要扩 `computeSource` 之外的第二个源码入口、校验、存储、桥与工具面），而且内嵌历史与 16KB 上限都留着。否决。
- **两个 aux 键（净买、买占 各一条序列）**：能让「买占」用源记录值而非派生值。否决——取数翻倍且要与「一轮 HTTP 复用」的缓存语义纠缠；而两者之差只有「未归向成交残差 / 2」（本数据集 5 标的实测 ≤0.036 个百分点，见 Consequences），比读图分辨率低一个量级，代价不值。
- **客户端直连 `qt.gtimg.cn`**：绕开桥与连接器。否决——跨域，且把上游契约散进浏览器半；本仓纪律是取数归连接器、浏览器半只消费宿主桥。
- **只认「当前路由服务」不跨 provider 解析**：桥本可只问 `registry.active('cn')`。否决——cn 有 tencent/qmt 两个候选，路由一旦切到 qmt，当日 live 点会**静默消失**，正是本次要修的症状。改用与 `southboundHoldings` 同款的「active 优先 → 按 provider 名排序扫注册项」三段式（registry 完全缺席时保留 `getMarketService` 的 legacy 路径）。
- **盘中不显示、只在收盘后立刻出**：等于维持用户抱怨的行为。否决。

## Consequences

- 用户可见：cn 标的挂上 `active-buy` 即可，**当日柱在盘中就有值**并每 5 分钟自刷，收盘后收敛为当日终值；交易时段窗口内该组副图标题显示「盘中」徽标（数据驱动）。未采集的标的仍然空白（不插值、不估算）。
- **口径与派生值**：aux 序列的值是 `netSharePct`（净主动买占当日总量 %）；「买占」线由恒等式 `(100 + 净买)/2` 现算，其前提是「外盘 + 内盘 ≈ 当日总量」——该差值是**未归向成交**（集合竞价与价间成交计入总量却不计入内外盘），量级不固定（本数据集 5 标的实测上限 0.071%，单条报价行盘中可达 0.63%），故买占与源记录 `buySharePct` 相差「残差 / 2」。这是**有意的单序列取舍**，注释与指标 description 都写明了前提；若将来出现残差量级更大的标的，出路是拆成两条 aux 序列。
- 契约面：`MarketDataService` 增加一个可选方法（additive，存量连接器零迁移）；`IndicatorDefinition` 增加可选 `description`，并在 `indicator_list`／`resolveIndicatorSpec` 透传——预置指标从此也能带口径说明（GUI 目前没有渲染它的位置，真实消费方是 agent 工具面与桥的 spec 面）。
- 工具面：`cn_get_indicators` 默认集合多出 `active-buy`，以「需要宿主行情副图数据（本工具面不可用）」一行呈现（与 `hk-connect-holding` 同款，不假装算出空序列）。
- 数据面：数据集单份住在 trading home，退出 cowork 工作区的 Syncthing/git 备份范围；写侧脚本的 home 守卫与门禁 `home-guard:check` 同源（测试用 `DSH_TRADING_ACTIVE_BUY_FILE` 整体覆盖 + 临时 `DSH_HOME`，故用 `home-guard-allow:` 显式豁免并写明理由）。
- 15:05 采集任务只剩「采集 + 记日志」：不再跑 `build_indicator.py`、不再调 `indicator_author`、不再重放 per-symbol 激活。
- 已知边界：`fetchedAt` 用带偏移的 ISO 渲染（不用 `toISOString`），读数不随宿主时区漂移；桥除 ENOENT 外的文件 IO 错误仍然传播（只把「缺文件」与「坏行」当降级）；同一条路径的 250 日截断意味着更早的历史不在图上（数据集本身 append-only，不截断）。

## Verification

- 门禁（`pnpm gates:all`，HEAD 现场复跑）：**15 通过 / 1 失败**；唯一红项 `tool-contract:check` 是**存量**矛盾——`packages/knowledge/src/tool.ts` 的 `*Json` 参数已声明为 `type: 'json'`（提交 `6d4c92d9`，issue #100），而冻结快照 `scripts/tool-contract-freeze.json` 仍记 `"type": "string"`（提交 `f20e3ff4` 引入该门禁）；本特性工作区未触碰这两处（`git status` 计数 0）。
- 包测试：`connector-tencent` 45 例、`bot-api` 240 例、`indicators` 115 例、`client-ui-trading` 427 例全绿；测试棘轮（`test:audit`）无新增债。
- 连接器真实证据：`spikes/impl-active-buy/` 存 4 份 curl 原始 GBK 响应 + `r3-parse.mjs`（把落盘字节喂回 `rest.ts` 本体重放，只有取数时刻是注入值）；数值向量 总量 91083 / 外盘 43668 / 内盘 47410 → 买占 47.94、净买 −4.11。
- 桥端到端：`dispatchBridgeRequest(GET, '/active-buy')` 实返 close/manual/live 三段 JSON；`live` 注入、今日已有行不注入、能力缺席降级、坏行跳过、非 cn 空序列、250 日截断各有判据；能力解析三条分支（active 优先 / qmt 无能力时取排序后 tencent / 全无能力只回历史）各有判据。
- 客户端：5 分钟窗口边界（09:24/09:25/11:32/12:58/15:02/周末）、复取失败不清空已有序列、A→B→A 在途旧应答丢弃、空序列隐藏副图、数据驱动徽标各有判据；`i18n:check` 绿（`indicator.live` 三处一致）。
- **未验证（如实标注）**：真实图表 canvas 布局（jsdom 挂不起 lightweight-charts）、宿主端到端取数与真实截图、响应式矩阵——留给部署后按 ui-screenshot-verify 手法补证。

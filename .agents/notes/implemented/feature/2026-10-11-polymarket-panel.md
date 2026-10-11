# Agent Note: Polymarket 预测市场面板（右缘竖条第 6 个页签）

Status: implemented

## Problem

数据面（[P1 数据面卡](2026-10-11-polymarket-prediction-data-plane.md)）已交付 FOMC 决议
档位与隐含概率，但面板本身没做，且 P1 把两处口径决策显式留给了本卡：

- **显示概率取哪个口径**：gamma `outcomePrices`（= mid，与 CLOB midpoint 实测 15/15 逐值
  相等）与网页显示值（= `bestAsk`）差半个 tick（December No change：mid 0.225 vs
  网页 0.23）。P1 同时下发 `probability`（mid）与 `bestBid`/`bestAsk`，口径选择留给展示层。
- **深度/价差阈值**：上游证据（`spikes/impl-polymarket/`）只给了实测分布
  （`liquidityNum` 87.9k–956k、spread 0.001–0.012），没有给「多低算噪声」的判据。

另有两处必须解决的面板问题：概率是连续量，「CPI/PPI 公布后市场改押注多少」这个核心价值
无法从单次取数读出（一次取数只有一个当前值）；以及上证指数式的「概率和」健康检查必须可见
而不能静默。

## Decision

（owner 2026-10-11 裁决三处，其余沿用仓内既有纪律。）

- **载体**：右缘竖条第 6 个互斥页签，自绘 380px `fixed` 面板
  （`PolymarketPanel.tsx` + `polymarket-panel.module.css`），定位与宽度照
  `macro-panel.module.css` 同款吃 frame 轨道变量（`--dshtrading-sidebar-w` /
  `--dshtrading-chat-user-w`），视觉随容器走（base 底、左缘 default 分隔线、无圆角无投影）。
  互斥联动接进既有五处（`holdingsOpen` / `filesOpen` / `toggleTasks` / `toggleFlash` /
  `toggleMacro` / `toggleHoldings` / `closeContainer`），并新增 `shell-pad.css` 规则 16
  隐去对话列内容。
- **显示概率取 `bestAsk`**（与 Polymarket 网页逐值一致，满足「与网页一致」的验收），
  **Δ 沿用宿主快照的 `changeSincePrevious`**（mid 基准）。两者基准差半个 tick 以内，
  故在最近一场会议标题下**显式标注两者口径**，不隐式换算、也不假装同源。
  `bestAsk` 缺省（结算后上游为 null）时回落 `probability` 并由 `probabilityBasisOf`
  如实标注基准。
- **质量阈值分两个独立标记**：深度 < 100,000 USD → 「深度不足」，价差 > 0.02 →
  「价差过宽」。不用一个词混掉两种坏质量。**缺字段不标记**——「上游没给」不是「不达标」。
  阈值落在实测分布的天然断点：December/January 尾部档位（84.9k–88.8k）会被标出，
  October 全档（354k–999k）不标，现场可复核。
- **上屏下一场 + 后续至多两场**（`VISIBLE_MEETINGS = 3`）。只看最近一场会看不到低深度形态：
  October 各档深度充足，真正的 90k 级薄档在 December/January——而那正是决策更远的押注。
- **事件对照 = 会话内采样时间轴**：面板打开期间按轮询节拍（60s）留
  `(时间, 各档概率)` 采样，把 `fetchMacroCalendar`（金十宏观日历，与 MacroPanel 同源）
  里的美国 CPI/PPI 时点叠上去，读跨事件位移最大的档位。
  实现为纯函数 `movementAround` / `largestMovementAround`（`prediction-view.ts`），
  可离线复算。**单侧缺失即返回 `undefined`**（面板显示「采样不足」），
  不拿单侧硬算、更不填 0。
- **两个源各自记账**：预测市场与宏观日历独立 `FeedState`，任一失败只影响自己那块
  （`TRADING_NOT_IMPLEMENTED` 与上游失败文案也分开），绝不把失败画成「没有数据」。
- **只读边界**：面板无任何下单/交易入口（用例断言仅一个关闭按钮、无 form/input）。
  取数走 `fetchPredictionFomc()`，不新增交易能力。
- **测试走注入缝**：面板接受 `deps: { fetchPrediction, fetchCalendar, now }`，测试传真实
  函数替身——**不使用 `vi.mock`**（测试卫生棘轮禁 mock，新文件带违规即红；既有
  `macro-panel.smoke` 等文件的 mock 属存量债，不进基线即为合规）。

## Alternatives considered

- **显示 mid（完全同源）**：level 与 Δ 单一基准、零口径标注；但验收要求「与 Polymarket
  网页一致」，网页显示的是 ask，抽查明差 0.005 会被判不一致——落选。
- **显示 ask + 面板自算 ask 基准的会话差分**：口径自洽，但放弃宿主快照 Δ，与任务书
  「变动相对本地快照」的原意偏离，且多一份客户端状态——落选。
- **深度与价差合成单一「深度不足」标记**：UI 更简，代价是把「没人挂单」与「点差太宽」
  两种不同的坏质量混成一个词——落选。
- **只标注深度、不管价差**：任务书明文要求价差达标项有可见出口——落选。
- **事件对照只列当周 CPI/PPI 时点 + 当前 Δ，不画时间轴**：实现小，但读不出「公布之后
  跳了多少」，对照关系靠人眼拼接，等于不交付本卡的核心价值——落选。
- **无常对照、只显示当前 Δ**：范围最小，事件标注整条不交付——落选。
- **面板自己算 (bestBid+bestAsk)/2 作为概率**：结算后 `bestBid=null` 而 `bestAsk` 残留
  0.001，自算得到 0.0005 这种无意义值（P1 已否决，本卡沿用不改）——落选。

## Consequences

- 面板打开即见下一次 FOMC 及其后两次会议的档位概率、方向、质量标记与变动；低深度市场被
  显式标注，概率和偏离可见，数据源失败出可操作提示。
- 现场抽查（2026-10-11，HEAD 见交付说明）：面板 15/15 档位的显示值与上游 `bestAsk`
  逐值相等（Oct 0.2/0.5/84.0/16.0/0.4，Dec 0.4/1.3/23.0/75.0/3.0，Jan
  0.8/2.8/66.0/32.0/2.0）；January `25 bps decrease` 与 `50+ bps increase`
  两档被标「深度不足」，与上游 `liquidityNum` 84,878 / 88,755 一致。
- 测试：新增 3 个测试文件 51 用例（纯判据 27 + 面板冒烟 17 + 互斥联动 13），
  零 mock / 零 sleep / BDD 命名，`test:audit` 无需新增基线豁免。
- **profile 刷新是本卡的前置观察**：P1 的连接器与桥路由落在 profile 上次刷新之后，
  未刷新时面板会显示 `TRADING_PROTOCOL`（桥不认识 `/prediction/fomc`）——这正是
  「失败不伪装成没有数据」的行为，但要用上真实数据必须先
  `DSH_HOME=~/.dsh-trading scripts/refresh-profile.sh trading-web`。
- 已知限制：深色模式未现场验证（截图只在浅色主题下取）；事件对照需要面板持续打开
  （采样是会话内状态，不落盘）；上游 `prices-history` 回填与 CLOB 盘口深度仍未做
  （与 P1 的未做项一致）。

# Agent Note: 工具面冻结门禁与实盘下单不变量门禁

Status: implemented

## Problem

agent-infra-review 在工具域（D9）取证出两处无机械检查的契约面，且两者都能静默进入发布：

1. **模型可见的工具面没有基线。** `scripts/tool-surface-inventory.mjs` 只打印报告（无断言、
   无基线对比），不进 CI。工具名、必填参数或输出形状被改名/改形状时，既有提示词与已写好的
   调用会静默失效，CI 全绿。行 id 有 `patch-id:check`、HTTP 面有类型检查，工具面此前是空的。
2. **实盘下单的幂等键没有不变量。** 2026-10-12 的订单意图台账给能真实下单的连接器加了
   `intentId`，但「哪些连接器真的会把订单发给交易所」是随 bundle 行与实现演化的事实；
   把一个未接台账的连接器接上真实下单路径，就能在没有去重键的情况下重复下单，而没有任何
   检查会红。

## Decision

新增两条静态门禁，都进 `gates-all.mjs` 的 GATES、`ci-wiring-check.mjs` 的 MUST_BE_WIRED
与 CI 的 static-gates：

- `scripts/tool-contract-gate.mjs`（`pnpm tool-contract:check`）：以
  `scripts/tool-contract-freeze.json` 为基线，按「包名#工具名」冻结**必填参数集合、
  参数类型/枚举性、输出形状**。规则 T1 消失或改名、T2 必填变化、T3 参数被移除或类型变化、
  T4 输出形状变化、T5 出现未登记工具——五条各自对应一种真实破坏。新增与改名**必须显式跑
  `--update`**，门禁不会自动接纳。动态名（如 `<market>_get_orderbook`）按原样登记，不去猜展开值。
- `scripts/live-order-invariant-gate.mjs`（`pnpm live-order:check`）：对所有 `*_place_order`，
  **已挂载（host/preset）者必须带 `dryRun`**；其中**具备真实下单路径**者还必须带 `intentId`。

「具备真实下单路径」的判据是源码事实而不是函数名：存在下游下单调用
（`client.placeOrder` / `deps.trade.placeOrder` 形态）才算。仅数据面挂载、或实盘分支明确
返回 `TRADING_NOT_IMPLEMENTED` 的桩连接器不算——它们发不出订单，没有重复下单面。这条区分
是实测倒逼的：首版按「已挂载」判，会把 binance 与 yahoo 误报为缺幂等键；查证后两者的实盘
分支都是显式未实现（`packages/connector-yahoo/src/index.ts` 的闸门 ③ 直接抛
`TRADING_NOT_IMPLEMENTED`，binance 同形），因此按「真实下单路径」判才既不漏也不误报。

两条门禁脚本都只在**作为入口执行**时 `process.exit`（被测试 import 时不得终止宿主进程，
这是首版让 `test:scripts` 挂掉的原因）。

## Alternatives considered

- **只把 tool-surface-inventory 接进 CI**：它没有断言面，接进去也只是多打印一份报告；
  漂移不会红等于没接。
- **对工具描述文本做相似度冻结**：描述是给人看也是给模型看的，措辞微调是正常维护；
  冻结必填/类型/输出形状才对应「调用会失败」的真实破坏。
- **把实盘不变量做成运行期断言**：运行期已经在下单了，事后发现没有意义；这是启动前就能
  静态判定的事实。
- **按「已挂载」判定实盘可达性**：会把只挂数据面的连接器判成可下单（实测误报两例）；
  可达性必须看实现里有没有真实下单调用。
- **让 `--update` 在 CI 里自动重写基线**：等于没有门禁；更新必须是人在评审中显式执行的动作。

## Consequences

- 工具面变更（尤其改名与必填调整）会在 PR 阶段变红，附带确切的差异描述；
  有意变更跑 `pnpm tool-contract:update` 并在评审中核对 diff。
- 新增能真实下单的连接器若忘记接 `intentId`，会在这里被拦下，而不是在盘中靠人发现重复成交。
- 冻结清单 `scripts/tool-contract-freeze.json` 是「现状快照」，不是设计意图；错误在变更时修正。
- 两条门禁都是只读静态扫描，零网络、零写入（除 `--update`），无运行期成本。

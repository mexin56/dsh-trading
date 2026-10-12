# Agent Note: 工具入参 JSON 声明的判定与修正（issue #100）

Status: implemented

## Problem

用户报「导入知识时偶尔报 knowledge_ingest 未调用」。实际是 `defineTool` 在 `execute` 之前跑参数校验，`knowledge_ingest` 的 7 个 `*Json` 参数声明为 `type: 'string'`，而 `execute` 的 `parseJsonArray` / `parseJsonObject` 明确同时接受数组与对象——模型按实现能力传结构化实参时被框架以 `ToolArgsError`（`INVALID_ARGS`，`"coreClaimsJson" must be a string`）直接拒掉，模型侧观察到的就是「工具没被调用」。

同一矛盾在 `holdings_stage.itemsJson` 上也存在（实现有 `Array.isArray(args.itemsJson)` 分支与「容忍模型直传结构化数组」注释，声明却仍是 `string`）。根因不是某个包写错，而是缺少一条可逐参数执行的判定准则。

## Decision

`type: 'json'` 是框架的作者侧节点，编译为无类型约束的 JSON 节点，与「实现接受 string / array / object 三种形态」同义。

判定准则（逐参数读实现代码）：

- 实现里出现 `Array.isArray(x)`、`typeof x === 'object'` 或 `JSON.parse` 容错分支 → 该参数声明必须是 `type: 'json'`。
- 实现只接受字符串、遇到非字符串则忽略或报错 → 保持 `type: 'string'`。改成 `json` 会让框架放行、实现静默丢弃实参（比现在的响亮拒绝更糟）。

按此准则扫全仓（`grep -rn "Json: {" packages/*/src`，共 17 个参数），改动 8 个：

| 文件 | 参数 | 实现接受非字符串的证据 | 改后 |
|---|---|---|---|
| `packages/knowledge/src/tool.ts:87,92,97,101,105,110,114` | `coreClaimsJson` / `factCheckJson` / `takeawaysJson` / `boundariesJson` / `tagsJson` / `tickersJson` / `relatedJson` | `parseJsonArray` 的 `Array.isArray(val)` 分支、`parseJsonObject` 的 `typeof val === 'object' && !Array.isArray(val)` 分支 | `json` |
| `packages/holdings/src/tool.ts:184` | `holdings_stage.itemsJson` | `if (Array.isArray(args.itemsJson)) rawItems = args.itemsJson`，注释「容忍模型直传结构化数组……双兼容」 | `json` |

判定为「看着像但不用改」的 8 个参数（实现只吃字符串）：`indicator_author.paramsJson`、`indicator_activate.paramsJson`、`strategy_author.paramsJson`、`strategy_backtest.paramsJson`、`screener_author.paramsJson` / `columnsJson`、`screener_run.paramsJson`、`tasks_update.patchJson`——它们的 `execute` 全部是 `typeof args.X === 'string'` 判断或直接 `JSON.parse(args.X)`，没有结构化分支。

范围：只改声明与随之失真的描述文案（改成「JSON array …（also accepted as a JSON string）」），`execute` 的 string / array / object 三形态语义不动。已经正确的 6 个 holdings 参数（`holdings_add.itemsJson`、`holdings_confirm.idsJson`/`editsJson`、`holdings_update.patchJson`、`holdings_discard.idsJson`、`holdings_remove.idsJson`）是本次改动的先例，不动。

## Verification & Gates

- `tool.parameters` 即 `defineTool` 编译后的参数 schema，`validateJsonSchemaValue(tool.parameters, args, '')` 就是 `defineTool` 内部的 `validate(args)`。对 17 个参数逐个打印数组 / 对象 / 字符串三种实参的判定：改前 8 个参数对数组与对象均 `REJECT: "…" must be a string`，改后全部 `PASS`（编译节点由 `{"type":"string"}` 变为 `{}`）；其余 8 个参数保持 `REJECT`。
- 回归用例锁定该行为：`packages/knowledge/test/tool.test.ts` 与 `packages/holdings/test/tool.test.ts` 各新增 1 例，先过框架参数校验再执行，断言校验零违规且结构化实参完整落库。既有用例直接调 `execute` 绕过框架校验，正是本缺陷能长期潜伏的原因。
- `pnpm --filter @dshtrading/knowledge test` 46/46、`pnpm --filter @dshtrading/holdings test` 78/78、两包 `build` 干净、`pnpm test:audit` 通过（两文件逐条计数 11/11 与 20/20 不变，无新增测试债）。

## Alternatives considered

- **把实现收窄成只接受字符串**：等于删掉已有的双兼容能力，模型传数组会退回「工具未调用」的原始症状，方向相反。
- **保留 `string` 声明，只在描述里重申「必须传 JSON 字符串」**：描述是软约束，模型仍会按 `Array<string>` 的直觉传数组；工具面已有多处在用 `json`，声明与实现对齐才是可判定的口径。
- **把 8 个「仅吃字符串」的参数一并改成 `json`**：框架会放行数组 / 对象，而实现只会静默忽略（`strategy_*`、`screener_*`、`indicator_*` 的 `typeof === 'string'` 判断落到缺省值）或返回错误串，把「响亮的拒绝」变成「静默的错误结果」。要让它们接受结构化实参得改各自 `execute`，属独立变更。
- **顺手把解析失败改成结构化错误**：与本缺陷无关的扩面改动，本次不做。

## Consequences

- 模型直传结构化实参的调用不再被框架拒掉；显式传 JSON 字符串的老写法与既有测试不受影响。
- 判定准则依赖「读实现」而非参数名，新增 `*Json` 参数时须按同一准则自检，否则会重新长出「声明与实现打架」的参数。
- 残余风险：上述 8 个仅吃字符串的参数，模型传结构化实参时仍会拿到 `INVALID_ARGS`（`strategy_author` 这类「传 `StrategyParamSpec[]`」的描述尤其容易被误读）。当前属响亮拒绝、非静默错误，是否让它们也接受结构化实参是独立决策。

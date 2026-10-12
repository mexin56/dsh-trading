# Agent Note: 工具调用级结构化记录（最小可观测面）

Status: implemented

## Problem

agent-infra-review 的 D11 取证结论是 M1：一次失败的实盘工具调用之后，本仓回答不了四个
基本问题——**哪个工具、哪次调用（callId / rootCallId）、成功还是失败、失败的错误类别
是什么**。宿主有自己的 session 事件流，但本仓侧只有自由文本 `console.error`，跨进程
排障只能靠人工拼接日志。交易场景下这个缺口的代价是可诊断性：一笔「下单返回未知」的
调用，事后既无法证明它真的被调用过，也无法说明它失败在哪一类。

## Decision

在 `@dshtrading/base` 挂官方 `tools/post-execute` waterfall 观测器，把每次工具调用压成
**一行 JSON** 追加写入 `<DSH_HOME>/logs/tool-calls.jsonl`。

- 记录字段固定为 `at / tool / callId / rootCallId / isError / errorCode / durationMs`
  （字段名即对外契约，由 `packages/base/test/tool-call-log.test.ts` 锁住）。
- **只记身份与结果，不记参数与返回值**：工具参数可能含 API key、账户号、下单数量，
  观测面不应成为新的凭据落点。
- 观测器**原样 `next()`**，绝不改写入结果——它是旁路，不是策略层；写盘失败只打一行
  告警后放行，绝不因为观测而让工具调用失败。
- 单文件 4MiB 上限，超过轮转为 `.1`（保留一代够事后取证）。
- 开关 `toolCallLog`（Config，缺省 true）；路径可用 `DSH_TOOL_CALL_LOG` 覆盖，
  测试与部署走同一入口。

**诚实边界**：`durationMs` 当前恒为 0。本仓只挂 `tools/post-execute`（工具已跑完），
拿不到起点，精确耗时属宿主执行面。字段先固定下来，未来接入官方 timing 只填值不改契约；
**不得把 0 读成「瞬时完成」**。

## Alternatives considered

- **自己包 `tools/execute` 统计耗时**：可以拿到起点，但那是宿主执行管线的核心缝，
  为一个旁路指标去包裹它，收益（一个数字）远小于风险（改坏了所有工具调用路径）。
  先固定字段、留待官方 timing。
- **在工具注册处逐个包 wrapper**：本仓 156 个 defineTool 分散在 40+ 包，逐包包装等于把
  同一个观测逻辑复制 156 份——正是 [atomic-json-write-consolidation](../simplification/2026-09-09-atomic-json-write-consolidation.md)
  已经付过学费的漂移形态。
- **引入 OTel / 分布式 tracing**：本仓是单进程单用户、无队列、无跨进程链路，
  一条结构化记录已能回答四问；全量 trace 是净成本（YAGNI）。
- **写进宿主 session 事件流**：事件面属宿主所有，插件不应往别人的持久日志里塞自定义事件。
- **记录工具参数以便复现**：参数含凭据与账户信息，且模型参数可以很长；记录它们会把
  本地 home 变成敏感数据副本，与「不内置密钥、不再分发数据」的边界冲突。

## Consequences

- 失败调用可事后回答四问：从任意一条记录即可定位工具与错误类别，配合 callId/rootCallId
  可把同一轮多个调用归并。
- 观测是旁路：任何写入异常都不影响工具调用本身，也不会改变审批结论。
- 每次工具调用多一次 appendFileSync；调用频率是模型回合级，代价可忽略。
- 记录文件是本地诊断产物，不随包分发、不上传，无新增网络面。
- 与 D12 的分工：本 Note 只提供**可诊断性**，不构成评估集；确定性验收另见验收脚本。

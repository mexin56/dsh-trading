# Agent Note: 知识库召回与证伪下架闭环——工具修口 + 分析流接线 + tag 清洗

Status: implemented

## Problem

知识库（packages/knowledge，215 卡）"只进不出"：检索是子串匹配 + 时间倒序 +
摘要级返回（搜到也读不到全文，无按 id 取回手段）；无任何删除/下架机制，被证伪
的观点会留在库里持续污染召回；212/215 卡 tags 被批量导入写入作者名与「2026H1」
时间段，标签过滤与图谱聚类失效。owner 2026-09-02 拍板：方案 A（工具修口）+
方案 B（分析 skill 召回接线）+ 新增证伪删除机制一并推进。

## Decision

1. **工具层**（packages/knowledge，PR 流交付）：
   - `knowledge_search`：有关键词时按字段命中相关度排序（tags > title >
     coreClaims > summary/author，同分 updatedAt 倒序）；新增 `detail: "full"`
     返回核心论点/事实核查/经验/边界全文；
   - 新增 `knowledge_get`：按 id 读单卡全文（id 来自 search 或分析引用标注）；
   - 新增 `knowledge_delete`（证伪下架）：删除卡片并自动清理其他卡片指向它的
     `related` 引用（防悬空），输出回显被删卡片论点留痕，emit knowledge 事件
     刷新 UI；
   - `knowledge_graph` 收敛为结构概要（卡片数/节点/边 + topClusters + 可信度
     分布），不再全量倾倒 node label。
2. **历史雷修复**（tsc 棘轮门禁抓获，tsdown 不查类型长期掩盖）：
   `plugin.ts` 的 `createKnowledgeIngestTool({ store, onWritten })` 把 options
   对象传进了 `store` 位置参数——该形态一旦构建上线 ingest 必崩；`knowledge_graph`
   的 `data.edges`（buildGraph 实际返回 `{ nodes, links }`）同源调用即崩。均修正，
   门禁 555 → 553。
3. **skill 层**（方案 B）：knowledge-curation 新增 §4 证伪下架 SOP（定位确认 →
   `knowledge_delete` 带 reason → 证伪结论记交易日志/可另立 manual 卡 → 同源
   反复证伪则提示整体降权）；company-analysis §2 证据收集与
   crypto-instrument-analysis 第零步接入 `knowledge_search` 召回（命中卡片归
   C/D 级线索、标注卡片 id、不替代原始披露与工具实测）。
4. **数据清洗**：`scripts/clean-knowledge-author-tags.mjs`（移除与
   source.author 同值的 tag 及 YYYYH1/Qn 时间段 tag；tags 清空兜底「未分类」；
   默认 dry-run，`--apply` 前自动备份）。dry-run 实测：212 卡 × 2 tag。
   **apply 必须在无 DSH 实例运行时执行**——file store 进程内缓存不失效，热写
   会被运行中实例的旧缓存在下次 save 时覆盖（本轮 trading-web 实例运行中，
   仅完成 dry-run，apply 留待实例关闭后执行）。

## 增补（2026-10-12）：检索结果的时间证据与显式时效筛选

review 指出 `knowledge_search` 返回只有标题/来源/可信度：`updatedAt` 与 `source.publishedAt` 都不出现，agent 无法据结果判断观点时效（会话守则要求核查 `updatedAt` 与素材发布时间），也缺少可按需收紧时效的检索入口。现补齐为可验证契约，不按年龄自动删卡、不改可信度：

- **时间证据对每档 detail 明示**：每条结果新增一行 `时间: 更新 <updatedAt> | 发布 <source.publishedAt>`；缺失或空值写「未知」，不留空位冒充有日期（`detail=summary` 与 `detail=full` 同款）。
- **显式时效筛选**：新增 `updatedAfter` / `publishedAfter`（ISO 日期或日期时间，含端点）。`updatedAfter` 比 `updatedAt`；`publishedAfter` 只比 `source.publishedAt`——**没有发布日期的卡不满足显式发布日期下限**（未知 ≠ 新鲜），`updatedAt` 解析不了同样不满足。非法日期值回报点名参数的显式错误，不伪装成「没有卡片」。
- **不越权**：默认无任何年龄过滤；筛选只影响单次结果集，库里卡片数量、`credibility` 与文件内容都不因查询改变（拒绝「按年龄删除所有知识 / 改变可信度」的做法）。
- **测试 fixture**：`packages/knowledge/test/fixtures/retrieval-cards.json` 5 张冻结卡（标签命中/标题命中、无发布日期、2025 旧卡、唯一主题卡），`test/retrieval.test.ts` 8 例覆盖 fixture schema 一致性、标签权重压过更新时间、两档 detail 的时间明示、两个显式筛选、非法值、无命中、按 id 精确 get；真实内存 store、零 mock、零 sleep、不调用模型，可复跑。

本页 Verification 之外的新证据：`pnpm exec vitest run --maxWorkers=1 --no-file-parallelism`（packages/knowledge）8 文件 / 53 例全绿。

## Alternatives considered

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## Consequences

- 新工具（get/delete）与 search 新参数对 agent 生效需刷新 profile 的 file:
  副本（重建包 + trading-web 重装插件）后新会话可见；
- 本地手动 `cards.json` 改写一律遵守「无实例运行」前提（先 pgrep dsh）；
- tsc 基线 553，留有 2 错误余量未下调（可用 `--update` 再收紧）；
- tag 清洗 apply 后，标签过滤与知识库图谱的聚类能力恢复（212 卡不再同簇）。

# Agent Note: cn 数据源横向对照与选型判据（腾讯 / 东财 / xysz）

Status: implemented

## Problem

cn 市场的三个 provider 各有明显短板，但短板分散在不同维度：腾讯免密、并发稳，却把日 K 卡在约 3.2 年；
东财日 K 能回溯到上市首日，却对突发并发极度敏感；xysz 上游能力最宽，但要营业部开通且以常驻 sidecar 为前置，
且它在本仓的适配面只是「A 股股票 + 轮询」。没有一次同口径的横向实测，就不存在可复用的选型判据——
下一个人只会凭印象挑源，然后各自踩一遍同样的坑。

## Decision

**cn 默认源维持腾讯；东财与 xysz 按「缺什么补什么」使用，不互为替代。**

判据（均为本出口实测，证据见 [spikes/impl-cn-datasource-bench](../../../../spikes/impl-cn-datasource-bench/EVIDENCE.md)
与 [spikes/impl-xysz-capability-recon](../../../../spikes/impl-xysz-capability-recon/EVIDENCE.md)）：

- **要并发刷新自选栏** → 腾讯。1/4/8/16 在飞零降级、197 次请求零失败；批量 `q=` 一次请求 100 只仍是 1 次上游请求
  （未收录码整行缺席、HTTP 200 不报错）。东财在 c=4 即触发「TCP+TLS 建连成功、服务端约 70 ms 后直接断连」的失效，
  且 2026-10-14 15:17 复测时 `push2.eastmoney.com` 的 `ulist.np/get` / `clist/get` / `stock/get` 三路径 ×2 全空回，
  同族 `push2his` 与 `qt.gtimg.cn` 均 200——失效面会从路径级扩到域级，持续 ≥12 分钟。
- **要长历史日 K** → 东财或 xysz。腾讯日 K 实测 `count=800` → 801 根（首 2023-06-21）、`count≥801` **静默降级到 641 根**
  （HTTP 仍 200）、`count=5000` → `param error`；连接器 `Math.min(limit, 800)` 把上限钉死。东财 `lmt` 给足返回
  `dktotal=6020` 根、首根 2001-08-27（上市首日）。
- **要 ETF / 指数 / 港股** → 腾讯或东财，xysz 取不到：它的名册走 `security_type=EXTRA_STOCK_A`（纯股票 5570 只，
  不含 ETF 与指数；上游另有 `EXTRA_ETF`/`EXTRA_INDEX_A` 未暴露），港股形态显式 fail-closed。
- **要券商口径全周期且已有银河权限** → xysz。上游 `Period` 枚举 13 项宽于本仓白名单 10 项，但白名单里
  `3m/5m/15m/30m/1h/2h` 六项零真实响应证据，且连接器不做映射（`interval` 原样透传，映射表在 xysz-api 侧）。
- **不要做的事**：拿东财跑突发并发；把腾讯当长历史源；把 xysz 当零门槛默认源。

同口径对照表、门槛/订阅模型与复现命令写在 [docs/guides/cn-data-source-comparison.md](../../../../docs/guides/cn-data-source-comparison.md)。

## Alternatives considered

- **把 cn 默认源切到东财（理由是日 K 全历史）**：否决。长历史是低频需求，报价是高频路径；把高频路径放到
  一个 c=4 就整域空回的端点上，会把自选栏和盘中读数一起拖垮。长历史按需切换 provider 即可。
- **把 xysz 设为默认源（理由是上游能力最宽）**：否决。它是**有门槛**源：营业部开通 + 常驻 sidecar（未启动即全量报错）
  + 无鉴权服务只能留在受信网络。默认源必须是零前置的那一个。
- **同时挂两个 cn provider 做冗余**：否决。路由是单 provider 互斥激活（见
  [market-data-registry-hot-switch](2026-08-30-market-data-registry-hot-switch.md)），且工具名会冲突；
  冗余应由「按需切换 + 降级重试」承担，不是双挂。
- **用 `lib/` 构建产物做探针**：否决。当时有并发会话在重建 `packages/connector-qmt/lib/*.js`，
  产物会在中途变化；探针一律 `tsx` 直跑 `src/*.ts`。
- **不记录本次实测，只写「三家都能用」**：否决。日 K 深度上限与并发代价是能直接决定选型的硬事实，
  不落记录就会重复踩。

## Consequences

- **东财相关结论是时点相关的**：本轮失效无法区分「针对本机 IP 的限流」与「东财侧故障」。客户端对东财的轮询
  应保持 ≥60 s 量级，批量探测要节制（2026-09-08 已有整 IP 断开约 20 分钟的先例）。
- **腾讯的 800 根上限是产品面约束**：任何「拉 5 年日 K」的用法在腾讯路由下都拿不到数据，且**不会报错**
  （超限静默降级），消费方只能靠能力面声明而不是靠报错发现。
- **xysz 的能力落差是结构性的**：上游覆盖 ETF/指数/港股通/期货与实时订阅，本仓只接了 A 股股票 + 轮询；
  扩面是后续工作，不是配置项。
- **横向对照有单一入口**：本 Note 拥有「选型判据」，数据表归 `docs/guides/cn-data-source-comparison.md`，
  逐源事实仍归各自 Owning Note（[xysz](2026-09-28-xysz-amazingdata-cn-data-source.md)、
  [公共源优先](../process/2026-08-29-public-data-source-first.md)、
  [批量报价能力](../feature/2026-10-14-batch-tickers-capability.md)）。

## Verification

- 时延/并发/批量/覆盖率：`./node_modules/.bin/tsx spikes/impl-cn-datasource-bench/bench.mts`，
  原始响应 44 份 + `MANIFEST.txt` 逐文件 sha256；表格由 `report.mts` 从 `out/*.json` 生成（非手抄）。
- 周期/深度/门槛：`spikes/impl-xysz-capability-recon/EVIDENCE.md`（腾讯与东财日 K 深度由 curl 复现命令给出）。
- xysz 链路：`node spikes/impl-xysz/r3-real-network-verify.mjs`（13 项全过，2026-09-28）。

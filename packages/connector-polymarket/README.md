# @dshtrading/connector-polymarket

Polymarket 预测市场连接器（**只读**公开 API，无密钥）。v1 只覆盖 **FOMC 决议路径**：
给出一场会议的各档位标签与隐含概率，供右侧栏预测市场面板使用。

判据与口径的唯一来源是 [spikes/impl-polymarket/EVIDENCE.md](../../spikes/impl-polymarket/EVIDENCE.md)
（P0 spike 裁决）。**不要另起一套猜法**——发现规则与概率口径都在那份证据里钉死了。

## 结构

- `src/gamma.ts` —— gamma HTTP 传输层。固定自有 UA（实测 200；`Python-urllib` 会触发
  Cloudflare 1010 → 403 且响应体是 text/plain）、显式超时、三层失败语义
  （传输 → `TRADING_NETWORK`；4xx/5xx → `TRADING_UPSTREAM_ERROR`；200 非 JSON → 契约破损）。
- `src/discovery.ts` —— 发现规则 L0..L5（`series_id=35` → `series[].id` 校验 → 标题正则
  → `negRisk` + 档位数 4..6 → 噪声排除 → 按 id 去重/`endDate` 升序）与档位归一化。
  纯函数，可离线复核历史证据。
- `src/snapshot.ts` —— 本地快照（存 trading home）。只回答「自上次观察变了多少」，
  缺失时 `changeSincePrevious` **缺省而不是 0**。
- `src/service.ts` —— 取数服务 + host 面服务对象（`tradingPredictionFeed`）。
- `src/plugin.ts` —— 插件入口。

## 只读边界（硬约束）

只访问 `gamma-api.polymarket.com/events` 读取面。**不触达任何下单/交易端点**，
不引入任何密钥。

## 数据落盘

快照写 trading home（经 `@dshtrading/dsh-home` 解析，
缺省 `$DSH_HOME/polymarket/snapshots.json`），绝不写进包内或仓库数据。

## 接线

跨市场信息源（FOMC 路径影响全部市场会话），故按 connector-jin10 先例由
`@dshtrading/base` bundle 认领：`packages/base/cordis.patch.yml` 的 insert 行 +
`packages/base/package.json` 的 dependencies。

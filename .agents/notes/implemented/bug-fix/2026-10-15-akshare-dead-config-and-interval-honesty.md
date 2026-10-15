# Agent Note: connector-akshare 的死配置与周期静默降级

Status: implemented

## Problem

`@dshtrading/connector-akshare` 包名与实现面脱节。2026-10-14 的 13 包 README 改写（commit
`a63a8b2c`）已把缺口记进 README，但没动源码，三处名不符实/静默降级留在运行面上：

- **`apiUrl` 是死配置**：`AKSHARE_API_URL`（schema 缺省 `http://127.0.0.1:8080`）没有任何请求消费者，
  `getTicker`/`getKlines`/`getSectorFundFlow` 全部硬编码 `push2`/`push2his` 东财公开端点。设置页还按它
  登记了 `env: 'AKSHARE_API_URL'` 与 `apiUrl` 凭据输入框——用户填了没有任何东西读。
- **周期静默降级**：`getKlines` 的 klt 映射只覆盖 5m/15m/30m/1h，命中 `INTERVAL_VOCABULARY` 的
  `1m`/`1d`/`1w`/`1M` 与词汇表外的一切（`3m`/`2h`/`3d`…）全部落 `klt=101`：用户要周线拿到日线且不报错。
  `closeTime` 一律 `openTime + 86400000 - 1`，分钟线与周/月线都按「当日 23:59:59.999」上报。
- **设置页登记宽于实现**：`markets: ['cn', 'hk']`，而本包只在 `cn` 注册（`src/dataplane.ts`），
  hk 是一次实现不了的承诺；显示名 `AkShare (宏观/另类量化)` 也在描述本包没有的宏观/另类数据面。

## Decision

1. **移除 `apiUrl`**（YAGNI：无消费者，也不接线到任何本地服务）。`Config` 只留 `enabled`；
   `AkshareRestOptions` 去掉 `apiUrl`，`AkshareRestClient` 不再读 `process.env.AKSHARE_API_URL`；
   `src/index.ts` 与 `src/dataplane.ts` 构造服务时不传该字段。设置页同步：`PROVIDER_LABELS` 的 akshare 行
   去掉 `env`，`PROVIDER_CREDENTIAL_SPECS.akshare` 整项删除，随之不再被引用的词典键
   `field.label.apiUrl` / `field.placeholder.akshareUrl` 一并删除（zh/en 两侧与键 union）。
   （这里的 `env` 是设置页登记里的环境变量提示，与
   [六个连接器移除无读取方的 env 三态配置](../simplification/2026-10-15-connector-dead-env-config-removal.md)
   的连接器 `Config.env` 三态字段不是同一件事。）
2. **klt 映射补全 + 表外周期显式拒绝**。`KLINES_INTERVAL_SPEC` 用一张表持有 klt 与单根时长：
   `5m/15m/30m/1h → 5/15/30/60`、`1d/1w/1M → 101/102/103`（klt 取值与同打 push2his `kline/get` 的
   `connector-eastmoney` 一致）。表外周期在**发请求前**由 `resolveKlinesInterval` 抛
   `TRADING_UNSUPPORTED_INTERVAL`（本仓既有语义，见 connector-xysz README「周期」段）。
   `1m` 同样在拒绝之列：`kline/get` 的 `klt=1` 只回当日、`lmt` 被上游忽略（connector-eastmoney 实测），
   本包没有 trends2 分时通道。导出 `SUPPORTED_KLINES_INTERVALS` 供工具描述如实标注真实子集
   （`cn_get_klines` 的 enum 仍是规范词汇表，与 tencent 同款做法）。
3. **`closeTime` 按周期**：`closeTime = openTime + stepMs - 1`（1d/1w/1M 为 24h/7d/30d）。
   周/月 K 的跨度因此 ≥ 2 天，`packages/indicators` 的 `klineTradingDay`/`klineCoverageRange`
   才会按周期末对齐；旧口径把周 K 当单日 K。
4. **设置页登记与文案如实化**：`markets: ['cn']`；显示名 zh `AkShare (东方财富公开端点)` /
   en `AkShare (Eastmoney public endpoints)`；README 与 `package.json` description 同口径只描述
   「东财公开端点实现」，不含未实现的 hk。包名不动。

不改动已实证的取价逻辑（按行 `f1` 除、`ulist.np/get` 路径）与既有错误映射。

## Alternatives considered

- **给 `apiUrl` 接线到某个本地 AkShare RPC 服务**：否决。本仓没有这样的服务（`AKSHARE_API_URL` 全仓只有
  本包自己读），落地要先发明服务与端点契约；而三条取数路径早已在东财公开端点可用，接一条没有消费者的
  本地桥只增加部署面。
- **`1m` 走 `klt=1`**：否决。上游只回当日（`lmt`/`end` 被忽略），`limit` 语义拿不到兑现，是另一种静默
  降级；显式抛 `TRADING_UNSUPPORTED_INTERVAL` 正好接上现成的自适应降级（`client-ui-trading/src/client/
  intraday-series.ts` 按该 code 退到更粗粒度）。
- **保留 `apiUrl` 字段并标 deprecated**：否决。死配置留在 schema 里就是设置页上一条永远不生效的输入框，
  填了不生效比没有更糟。
- **改包名**：否决。要动 bundle 依赖、patch 行、preset 行、路由 provider 词汇与用户 home 的 profile，
  成本远超本卡；用 README/description/设置页登记三处如实描述替代。

## Consequences

- 依赖 `1m` 的调用方（`cn_get_klines` 传 1m）从现在起拿 `TRADING_UNSUPPORTED_INTERVAL` 而不是「当日分钟线」；
  这是行为变更，功能上从「静默给错」变为「显式拒绝」。
- 老用户 settings.yaml 里残留的 `credentials.akshare.apiUrl` 不再有 UI 入口，也不再被读取；router 的
  `credentials` 是开放 dict，残留键不报错，无需迁移。
- `1w`/`1M` 的 102/103 与分钟线 klt 本次会话未能真网络复验（`push2his.eastmoney.com` 本机 curl 52
  空回），映射取自同端点的 connector-eastmoney；README 的「状态」段因此仍按未实证处理。

## Verification

- `packages/connector-akshare/test/template.test.ts` 新增 5 例：1w/1M 打 `klt=102`/`103`；5m 的
  `closeTime` 是 5 分钟末、1d 仍是一天末；周 K 跨度 7 天减 1 毫秒；`3m`/`2h`/`3d` 本地抛
  `TRADING_UNSUPPORTED_INTERVAL` 且零请求；`1m` 同理。旧的「词汇含 1m」断言改为「词汇表含 1m、
  可服务子集不含 1m」。
- `packages/connector-akshare/test/dataplane-loader.test.ts` 删掉 `apiUrl` 默认值断言，改为断言 loader
  解析出的行 config 键只有 `enabled`。
- `pnpm --filter @dshtrading/connector-akshare test`：2 文件 15 例全绿。
- `node scripts/i18n-audit.mjs --check`：5 命名空间 1059 zh 键 OK（删键后重建 `client-ui-settings` 与
  `dsh-i18n` 的 lib 产物，中心包漂移检查随之绿）。

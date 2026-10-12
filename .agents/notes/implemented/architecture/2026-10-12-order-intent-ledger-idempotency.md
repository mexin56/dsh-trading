# Agent Note: 订单意图台账——实盘下单的持久幂等锚（issue 43）

Status: implemented

## Problem

实盘下单在客户端看起来只有两种结局，实际有三种：**成功**、**明确失败**、以及「请求出去了但结局未知」
（超时、连接断开、进程崩溃、venue 已建单而响应丢了）。第三种在今天的代码里等于第一种的假象：
调用方拿不到回执就会重试，而 venue 侧的 client order key 并不能兜住这件事——

- OKX `clOrdId` 只要求**未成交挂单之间**唯一（成交/撤销即释放）；
- Alpaca `client_order_id` 只在订单**仍活跃**时拒绝重复（HTTP 422），终态后可复用；
- IBKR `cOID` 是「24 小时内唯一」，过期即失效；
- Futu `remark`、Longbridge `remark` 官方只定义为**下单备注**，不承诺任何去重；
- Tiger `user_mark` 与本仓现有 biz-content 键名尚未逐字对齐；QMT 打的是不在本仓的本地网关契约——
  两者都按「不猜字段」纪律**不发** client key。

也就是说：把幂等建立在 client key 上，等于把「钱只花一次」押在各家**没有承诺过的**语义上。
同时本仓还有一处反向风险：IBKR/Tiger/Alpaca 的 rest 层在回执缺 order id 时会**自己编一个**
（`ibkr-${Date.now()}` 之类），把「这单在不在 venue 上」变成一句假话，还让下游把它当真实句柄。

## Decision

**引入持久订单意图台账（order-intent ledger），把「同 ID 只下一单」从 venue 语义搬回本地磁盘。**

1. **契约（@dshtrading/api）**：`OrderRequest.intentId?: string`——实盘（`dryRun=false`）必填、
   dry-run 可缺省。错误词汇新增 `TRADING_INTENT_REQUIRED` / `TRADING_INTENT_CONFLICT` /
   `TRADING_INTENT_UNKNOWN` / `TRADING_INTENT_STORE_FAILED`。**venue client order key 与账户密钥
   都不进这个 DTO**：intentId 是调用方唯一传入、也是唯一读回的句柄。
2. **实现位置（@dshtrading/authority/order-intents）**：Node-only 独立入口，与运行期验签入口
   `.` 分开（验签入口仍不 import 它）。它写的是 **agent 自己的 trading home**
   （`<DSH_HOME>/order-intents/<sha256(intentId)>.json`，O(1) 定位、不随台账增长变慢），
   **绝不写人工持有的签名授权平面**（`$DSH_TRADING_AUTHORITY_DIR`）；读-改-写走
   @dshtrading/dsh-home 的 `transactStore`（跨进程排他锁 + 锁内新鲜读 + 原子写 + fsync）。
3. **三态语义**：无记录 → `begin()` 落一条 `unknown` 记录并返回 submit（**先落盘、后触网**）；
   已 `unknown` → `TRADING_INTENT_UNKNOWN`（在飞/未知），**永不自动重发**；
   已 `confirmed` → 返回同一份回执，**不重发**。只有 venue 回执带**真实非空订单 id** 才写 `confirmed`；
   `confirm()` 拒绝空 id，本模块任何路径都不代生成 id。
4. **冲突判据是指纹**：`sha256(provider + environment + account + 规范化载荷)`。同 ID 不同载荷、
   不同 provider、不同环境（demo/live、SIMULATE/REAL）、不同账户一律 `TRADING_INTENT_CONFLICT`，
   **不自动改参数**、不当作新单。**凭据不进身份**——轮换密钥不是换账户，不能让未知意图看起来是新意图。
   账户定位取配置里的**非密**字段（Futu accId、IBKR/Tiger/QMT accountId），没有就用稳定占位。
5. **失败一律 fail-closed**：台账写盘失败 → `TRADING_INTENT_STORE_FAILED` 且**不调用 venue**；
   记录文件存在但读不出来（坏 JSON / 坏形状 / 未来协议版本）→ 按 `TRADING_INTENT_UNKNOWN` 拒绝，
   **绝不把坏记录当成「没有记录」而重发**。推进未知意图的唯一入口是 `reconcile()`（人工/读对账，
   必须给 venue 侧读到的真实 orderId），本模块不提供「遗忘」接口。
6. **venue client key 是第二层防护**：由 `deriveVenueClientKey(intentId, rule)` 从 intentId 确定性派生
   （sha256 前缀，纯字母数字，长度不超官方上限），字段名与上限**逐家按官方契约核实**：OKX `clOrdId`（≤32）、
   Alpaca `client_order_id`（≤48）、IBKR `cOID`、Futu `remark`、Longbridge `remark`。
   remark 类字段在代码与文档里都只写「对账锚」，不得宣称 venue 幂等。Tiger/QMT 不发。
7. **七个连接器（OKX/Alpaca/Futu/IBKR/Tiger/Longbridge/QMT）** 的实盘路径统一为：
   闸门（签署授权）→ 本地参数校验 → 归一化 → `begin()` → 触网 → `confirm()`；
   replay 直接回带磁盘回执。dry-run 路径完全不碰台账。工具面新增 `intentId` 参数（英文描述、
   原工具名不变），`connector-template` 同步该规范供未来连接器继承。
8. **删除 synthetic id 兜底**：IBKR/Tiger/Alpaca 的 rest 层在回执缺订单 id 时改为抛
   `TRADING_EXCHANGE_ERROR`，台账停在 `unknown`（人工/读对账推进）。

## Alternatives considered

- **只靠 venue client key 做幂等**：放弃。各家只在特定窗口（未成交挂单 / 活跃订单 / 24h）去重，
  且「请求出去了但响应丢了」这个窗口里 client key 恰恰帮不上忙；Futu/QMT 的字段更是只作备注。
- **把台账做成整表 JSON**：放弃。整表读-改-写会让每次下单的成本随历史意图数增长，也会放大
  多实例回写冲突面；一意图一文件（sha256 命名）让定位与写入都是 O(1)。
- **把台账放进 vendored 的核心（tradectl）**：不可用。执行核在私有卫星仓
  （见 [自动交易平面切分](2026-10-03-auto-trading-plane-private-satellite-split.md)），
  主仓连接器必须能独立构建；台账因此落在主仓既有的 `@dshtrading/authority` 里做独立子路径，
  **运营数据与签名授权平面共包但不同目录、不同写权限语义**。
- **在 `begin()` 里写一个 `pending` 中间态**：放弃。任务口径就是「先写未知/在飞，再调用外部」；
  更细的三态会把「崩溃前到底发没发」变成需要推理的问题，而两态的保守答案（unknown → 不重发）永远是安全的。
- **`confirm()` 接受缺失 order id（回执先记下、索引后补）**：放弃。没有 venue 句柄就不是成功，
  记成 confirmed 会让后续重试路径回带一个假回执；宁可让它停在 unknown。
- **给 Tiger/QMT 加 `user_mark`/`order_remark`**：放弃（本次）。前者需要先把本连接器的 biz-content
  键名与官方模型逐字对齐，后者打的是不在本仓、也非官方的本地网关契约——两件都属于「猜字段」，
  而猜错的代价是订单字段被静默忽略、让人误以为有 venue 侧防护。

## Consequences

- 实盘下单多了一次本地原子写（p50 约 8ms 量级，见 dsh-home 的 fsync 实测），换到的是
  「同 ID 只下一单」不再依赖任何 venue 的未承诺语义。
- `$DSH_HOME/order-intents/` 是一份新的运营数据：它**不含凭据**（有用例断言），
  也**不进任何公开 DTO/响应**（用例断言回执里没有 venue client key）。
- 未知意图会**一直**停在 unknown，直到人工/读对账 `reconcile()` 推进——这是有意的：
  「自动遗忘未知意图」正是重复下单的入口。台账目录因此需要运维可见性（当前靠文件本身）。
- 已知边界（如实记录）：OKX/Alpaca/Longbridge 的配置里没有非密账户字段，账户定位用稳定占位
  `default`，环境（demo/live）承担账户区分；把同一实例的凭据换成**同环境的另一个账户**而未知意图
  尚在飞时，台账无法区分——但此时它仍然拒绝自动重发（最坏结果是保守地不重发，不是重复下单）。
- 既有实盘用例与工具调用方必须开始传 `intentId`：不传即 `TRADING_INTENT_REQUIRED`
  （dry-run 不受影响）。所有连接器用例改为显式指向临时 `DSH_HOME`，避免测试写进真实实例的台账。
- 连接器之间的复盘口径统一：venue 回执状态串**原样落盘**（api `OrderStatus` 是更窄的展示联合，
  Alpaca 的 accepted/pending_new 等本就在联合之外），回程由各连接器自己的映射收窄。
- 验证：authority 65 例（新增 19）、okx 126、alpaca 22、futu 41、ibkr 18、tiger 19、
  longbridge 19、qmt 17、template 8 全绿；每个连接器的 `test/fake-*-venue.ts` 逐条注明官方契约
  依据与本仓 spike 证据（okx `spikes/impl-okx/r5-order-loop-result.json`、futu
  `spikes/impl-futu-bridge/trd-place-order.json`）。
- 交叉链接：服务缝闸门见 [三态闸门下推](../feature/2026-09-01-service-seam-order-gate.md)（本次在其 live 分支前
  插入持久意图记录）；授权平面见
  [实盘授权状态平面](2026-10-01-live-trading-authority-plane.md)。

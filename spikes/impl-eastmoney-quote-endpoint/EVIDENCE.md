# Spike 证据：东财单标的报价端点失效，与报价行小数位数 f1 的取价含义

探针日期：2026-10-14 14:14（Asia/Shanghai 盘中，cn/hk 当日未收盘）。所有数字均为真实网络响应，
无桩、无缓存。起因：用户报「用东财数据源时左侧自选栏最新报价有问题」——截图里每行价格是 `—`、
名称回落成代码。

## 复现命令

```bash
cd /Users/zcl/code/dsh-trading
pnpm --filter @dshtrading/connector-eastmoney build    # 探针 import 构建产物 lib/rest.js（部署里跑的就是它）
node spikes/impl-eastmoney-quote-endpoint/p1-quote-endpoint-and-scale.mjs
```

原始响应落盘：`p1-quote-endpoint-and-scale.raw.json`。探针本身只做只读取数，不写业务状态。

## 1. `/api/qt/stock/get` 空回，同域其它路径正常

| 请求（同一时刻、同一 UA、同一台机器） | 结果 |
|---|---|
| push2 `/api/qt/stock/get?secid=0.001201&fields=f43,…` | 传输层空回：`UND_ERR_SOCKET`（curl 对照 `curl: (52) Empty reply from server`，http=000） |
| push2 `/api/qt/stock/get?secid=116.00700&…`（港股） | 同上 |
| push2his `/api/qt/stock/get?secid=0.001201&…`（换域同路径） | 同上 |
| push2 `/api/qt/ulist.np/get?secids=0.001201&fields=f2,f58,…` | HTTP 200，真实报价 JSON |
| push2his `/api/qt/stock/trends2/get?secid=0.001201&ndays=1` | HTTP 200，9269 B，`rc:0` |
| push2his `/api/qt/stock/kline/get?secid=0.001201&lmt=32` | HTTP 200，1573 B 真实日 K（探针里不带 `lmt` 时上游回 `rc:102`/`data:null`，是参数/限频，不是连接失败） |

失败跟着**路径**走，不跟着域或网络走：同一刻 push2 的批量报价与 push2his 的分钟序列都正常，
只有 `/api/qt/stock/get` 是空回（两个域都试过）。所以旧 `getTicker` 依赖的单标的报价端点在
2026-10-14 已不可用，这是「侧栏价格 `—`」的根因：桥对每个 symbol 拿不到 ticker →
`fmtPrice(undefined)` 画 `—`；名称回填分支（MarketSidebar 里 ticker.name 非占位才回灌）也永不触发，
行名就一直是当初存进去的代码。

## 2. 用户自选 7 行：改用 ulist.np/get 后逐只取价（构建产物实测）

| 行 | 东财 name | 东财 price | 东财 prevClose | 腾讯 qt.gtimg.cn price | 一致 |
|---|---|---|---|---|---|
| 002714.SZ | 牧原股份 | 40.96 | 40.90 | 40.96 | OK |
| 001201.SZ | 东瑞股份 | 14.13 | 14.33 | 14.13 | OK |
| 159869.SZ | 游戏ETF华夏 | 1.059 | 1.048 | 1.059 | OK |
| 513050.SH | 中概互联网ETF易方达 | 1.025 | 1.002 | 1.025 | OK |
| 517520.SH | 黄金股ETF永赢 | 1.834 | 1.875 | 1.834 | OK |
| 02714.HK | 牧原股份 | 35.40 | 35.44 | 35.400 | OK |
| 00700.HK | 腾讯控股 | 426.00 | 425.20 | 425.600 | OK（两源非同刻快照，差 0.09%） |

名称一列同时也证明了侧栏行名的来源：`f14` 直接给中文名，`001201.SZ` 那行的「东瑞股份」
修复后即可回填。

## 3. 报价值 = 上游整数 / 10^f1（`f1` = 该行声明的小数位数）

| 标的 | f1 | 上游 f2 | f2 / 10^f1 | 腾讯实际价 |
|---|---|---|---|---|
| 002714.SZ 牧原股份 | 2 | 4096 | 40.96 | 40.96 |
| 001201.SZ 东瑞股份 | 2 | 1413 | 14.13 | 14.13 |
| 159869.SZ 游戏ETF华夏 | 3 | 1059 | 1.059 | 1.059 |
| 513050.SH 中概互联网ETF易方达 | 3 | 1025 | 1.025 | 1.025 |
| 517520.SH 黄金股ETF永赢 | 3 | 1834 | 1.834 | 1.834 |
| 02714.HK 牧原股份 | 3 | 35400 | 35.40 | 35.400 |
| 00700.HK 腾讯控股 | 3 | 426000 | 426.00 | 425.600 |

**CN ETF 的 f1 是 3**：沿用此前的市场级常数（cn ÷100）会把游戏ETF华夏的 1.059 元读成 10.59 元，
差 10 倍。故取价必须按行的 10^f1，市场级 `eastmoneyPriceScale()` 只保留作 f1 缺失时的兜底。
涨跌幅 f3 两市场都是「百分数 ×100」（f3=105 → 1.05%），与 f1 无关。

## 4. 未收录 secid 的响应形态（not found 契约）

`secids=0.001201,0.999999` 的响应是 `data.total=1`、diff 里只有 001201——**无效 secid 是少返回行，
不报错**；只传无效 secid 时 `data:null`。故新实现把「diff 里拿不到行」判为
`TRADING_SYMBOL_NOT_FOUND`，与旧实现在 `data` 为空时抛 not found 的语义一致。

## 未覆盖

- 只在当前出口（本机）实测。旧端点空回是路径级现象，不是本机出口封锁的旁证是
  「同域其它路径同时正常」；但若某出口屏蔽了整个 push2 域，本次改动不解决那种情形（属另一层问题）。
- 侧栏 UI 的最终确认需要在**刷新过 profile 并以东财为 cn/hk 活跃 provider 的桌面壳**里做；
  本探针证明的是连接器取数层，UI 渲染路径未改动。

## 附. 批量报价 getTickers：自选 7 行压成 2 次请求（2026-10-14 追加上线后复测）

复现：

```bash
cd /Users/zcl/code/dsh-trading
pnpm --filter @dshtrading/connector-eastmoney build
node spikes/impl-eastmoney-quote-endpoint/p2-getTickers-batch.mjs
```

探针先包一层 `globalThis.fetch` 记录每次请求的 URL，再调构建产物 `lib/rest.js` 的
`EastmoneyRestClient.getTickers`：请求次数由**外层计数器**给出，不是靠返回值自证。

| 批量调用 | 入参 | 取到 | 上游请求次数 |
|---|---|---|---|
| cn 实例 | `002714.SZ / 001201.SZ / 159869.SZ / 513050.SH / 517520.SH` + `00700.HK`（港股形态，按契约跳过） | 5/5 | **1** |
| hk 实例 | `02714.HK / 00700.HK` | 2/2 | **1** |
| cn 实例 | `[]`（自选为空） | `{}` | **0** |

实际发出的两个 URL（探针输出原样）：

```
/api/qt/ulist.np/get?secids=0.002714,0.001201,0.159869,1.513050,1.517520&fields=f1,f2,f3,f5,f12,f13,f14,f18,f124
/api/qt/ulist.np/get?secids=116.02714,116.00700&fields=f1,f2,f3,f5,f12,f13,f14,f18,f124
```

逐只读数（探针输出，实时快照，与第 2 节 14:14 的快照有盘中跳动）：

```
cn 五只（002714.SZ/001201.SZ/159869.SZ/513050.SH/517520.SH）一次请求取全
  5/5 只取到，缺失 [无]
    002714.SZ   牧原股份  price=40.9  prevClose=40.9  chg=0%
    001201.SZ   东瑞股份  price=14.08  prevClose=14.33  chg=-1.74%
    159869.SZ   游戏ETF华夏  price=1.057  prevClose=1.048  chg=0.86%
    513050.SH   中概互联网ETF易方达  price=1.024  prevClose=1.002  chg=2.2%
    517520.SH   黄金股ETF永赢  price=1.828  prevClose=1.875  chg=-2.51%
  OK   cn 上游请求次数 = 1（期望 1）
  OK   cn 五只全部取到（缺失 0）
  OK   入参里的港股形态 00700.HK 按契约跳过（结果里不出现，整批仍成功）
  OK   cn ETF 行按 f1=3 取价（159869 游戏ETF华夏 price=1.057，市场级 ÷100 会得到 ~10.6）

hk 两只（02714.HK/00700.HK）一次请求取全
  2/2 只取到，缺失 [无]
    02714.HK    牧原股份  price=35.24  prevClose=35.44  chg=-0.56%
    00700.HK    腾讯控股  price=426.2  prevClose=425.2  chg=0.24%
  OK   hk 上游请求次数 = 1（期望 1）
  OK   hk 两只全部取到（缺失 0）

空入参（自选为空）
  OK   返回空表 {}
  OK   上游请求次数 = 0（期望 0）
```

本次探针坐实两件事：**按行 f1 取价在批量路径同样成立**（159869 那行 f1=3 → 1.057 元，而不是
吃市场级 ÷100 得到的 10.57）；**cn 实例入参里转不成 secid 的符号（`00700.HK`）被跳过而整批仍成功**，
它不出现在结果里，由调用方回落单取、保留自己的错误码。行→符号的映射不依赖响应顺序（用响应行的
`f13`+`f12` 拼回 secid 再对照请求表），该性质另由
`packages/connector-eastmoney/test/template.test.ts` 的「用户自选的写法与上游返回顺序无关地映射回
各自原字符串」用例以**倒序的响应行**覆盖；未收录 secid 的「只少一行、不造假」由
「用户自选里含未收录代码时只少那一只，整批不失败也不造假行」用例覆盖。

本节未覆盖：与第 2 节同源的限制——只在当前出口（本机）实测；对照的 7 次请求是改动前的基线口径，
未在本探针里重跑一遍旧路径做同时刻对照。

### 时延 · 连接复用（keep-alive Agent）

| 源 | 路径 | 有效/样本 | 失败 | wall p50/p95/min/max (ms) | 传输 p50/p95/min/max (ms) | DNS p50 | TCP p50 | TLS p50 | 连接 p50 | 服务端 p50 | 响应体 B | 复用次数 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tencent | P1 单标的报价 | 20/20 | 0 | 41.7 / 42.7 / 40.2 / 228.4 | 41.1 / 42.2 / 39.9 / 180.5 | 11.5 | 0.5 | 125.1 | 0 | 40.8 | 500 | 19 |
| tencent | P2 批量报价 8 只 | 20/20 | 0 | 41.7 / 55.3 / 40.5 / 166.4 | 41.2 / 54.8 / 40 / 165.7 | 1.7 | 0.5 | 121.6 | 0 | 40.5 | 3887 | 19 |
| tencent | P3 日 K 100 根 | 20/20 | 0 | 58.9 / 63.8 / 56.3 / 197 | 58.6 / 63.6 / 56 / 196.2 | 1.5 | 0.4 | 133.3 | 0 | 58.4 | 8894 | 19 |
| tencent | P4 分钟 K（腾讯 5m / 东财 1m） | 20/20 | 0 | 71.7 / 79.6 / 67.5 / 171.6 | 68.2 / 74.3 / 65.1 / 168.4 | 2.7 | 0.4 | 93 | 0 | 68 | 9264 | 19 |
| eastmoney | P1 单标的报价 | 20/20 | 0 | 40.5 / 45.4 / 39.7 / 133.1 | 40.1 / 45.2 / 39.4 / 129.4 | 2.5 | 1.2 | 84.9 | 0 | 39.9 | 213 | 19 |
| eastmoney | P2 批量报价 8 只 | 20/20 | 0 | 40.8 / 45.2 / 39.3 / 130.3 | 40.4 / 44.6 / 39 / 129.2 | 4.4 | 0.9 | 84.2 | 0 | 39.8 | 1005 | 19 |
| eastmoney | P3 日 K 100 根 | 20/20 | 0 | 50 / 51.1 / 47.8 / 156.4 | 49.5 / 50.7 / 47.4 / 155.5 | 2.2 | 0.9 | 98.5 | 0 | 48.6 | 7192 | 19 |
| eastmoney | P4 分钟 K（腾讯 5m / 东财 1m） | 20/20 | 0 | 52.4 / 89.6 / 45.2 / 204.3 | 50.1 / 82.5 / 44.2 / 196.7 | 3.4 | 0.9 | 96 | 0 | 48.3 | 87604 | 19 |

keep-alive 组首个样本即建立连接的那次（此后同连接复用）；下面是「去掉首个样本」的稳态视图：

| 源 | 路径 | 首样本 (ms) | 稳态 n | wall p50/p95/min/max (ms) |
|---|---|---|---|---|
| tencent | P1 单标的报价 | 228.4 | 19 | 41.7 / 42.7 / 40.2 / 42.7 |
| tencent | P2 批量报价 8 只 | 166.4 | 19 | 41.7 / 55.3 / 40.5 / 55.3 |
| tencent | P3 日 K 100 根 | 197 | 19 | 58.9 / 63.8 / 56.3 / 63.8 |
| tencent | P4 分钟 K（腾讯 5m / 东财 1m） | 171.6 | 19 | 71.7 / 79.6 / 67.5 / 79.6 |
| eastmoney | P1 单标的报价 | 133.1 | 19 | 40.5 / 45.4 / 39.7 / 45.4 |
| eastmoney | P2 批量报价 8 只 | 130.3 | 19 | 40.8 / 45.2 / 39.3 / 45.2 |
| eastmoney | P3 日 K 100 根 | 156.4 | 19 | 50 / 51.1 / 47.8 / 51.1 |
| eastmoney | P4 分钟 K（腾讯 5m / 东财 1m） | 204.3 | 19 | 52.4 / 89.6 / 45.2 / 89.6 |

### 时延 · 冷启动（agent:false，每次新建连接）

| 源 | 路径 | 有效/样本 | 失败 | wall p50/p95/min/max (ms) | 传输 p50/p95/min/max (ms) | DNS p50 | TCP p50 | TLS p50 | 连接 p50 | 服务端 p50 | 响应体 B | 复用次数 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tencent | P1 单标的报价 | 20/20 | 0 | 164.8 / 179.7 / 143.6 / 181.5 | 164.5 / 179.3 / 143.3 / 181.1 | 1.6 | 0.5 | 121.6 | 123.5 | 41.1 | 500 | 0 |
| tencent | P3 日 K 100 根 | 20/20 | 0 | 196.9 / 214 / 172.9 / 218.1 | 196.2 / 213.7 / 172.1 / 217.4 | 2.1 | 0.7 | 127.5 | 130 | 63.1 | 8894 | 0 |
| eastmoney | P1 单标的报价 | 20/20 | 0 | 153.4 / 168 / 121.5 / 175.9 | 153.3 / 167.7 / 121.4 / 175.6 | 2 | 0.6 | 86.8 | 89 | 70.8 | 213 | 0 |
| eastmoney | P3 日 K 100 根 | 20/20 | 0 | 147 / 161.5 / 130.1 / 163.4 | 146.7 / 161 / 129.9 / 162.8 | 2.4 | 0.8 | 94.1 | 98.2 | 48.3 | 7192 | 0 |

### 并发（同一路径：单标的报价 600519.SH）

| 源 | 在飞并发 | 请求数 | 成功 | 失败 | HTTP 状态分布 | 轮次墙钟 (ms) | wall p50/p95/min/max (ms) | 服务端 p50 (ms) | 连接 p50 (ms) |
|---|---|---|---|---|---|---|---|---|---|
| tencent | 1 | 20 | 20 | 0 | {"200":20} | 1016.1 | 41.7 / 42.7 / 40.2 / 228.4 | 40.8 | 0 |
| tencent | 4 | 16 | 16 | 0 | {"200":16} | 304.1 | 226.2 / 302.8 / 153 / 302.8 | 225.9 | 0 |
| tencent | 8 | 16 | 16 | 0 | {"200":16} | 238.5 | 192.1 / 233.7 / 160.3 / 233.7 | 43.8 | 0 |
| tencent | 16 | 16 | 16 | 0 | {"200":16} | 195.9 | 173.5 / 192.2 / 155.3 / 192.2 | 39.6 | 131.4 |
| eastmoney | 1 | 20 | 20 | 0 | {"200":20} | 911.6 | 40.5 / 45.4 / 39.7 / 133.1 | 39.9 | 0 |
| eastmoney | 4 | 16 | 0 | 16 | {"network-error":16} | 687.6 | — | 69.4 | 267.6 |
| eastmoney | 8 | 16 | 0 | 16 | {"network-error":16} | 348.8 | — | 70.1 | 101.1 |
| eastmoney | 16 | 16 | 0 | 16 | {"network-error":16} | 190.4 | — | 69.8 | 103 |

### 品种覆盖（第 1 轮）

| 源 | 市场 | 输入 | 上游请求 | HTTP | 结论 | 解析结果 / 错误 |
|---|---|---|---|---|---|---|
| tencent | cn | 600519.SH | 1 | 200 | 取到 | 贵州茅台 1286 CNY symbol=600519.SH |
| tencent | cn | 000001.SZ | 1 | 200 | 取到 | 平安银行 11.5 CNY symbol=000001.SZ |
| tencent | cn | 300750.SZ | 1 | 200 | 取到 | 宁德时代 280.12 CNY symbol=300750.SZ |
| tencent | cn | 688981.SH | 1 | 200 | 取到 | 中芯国际 102.55 CNY symbol=688981.SH |
| tencent | cn | 159869.SZ | 1 | 200 | 取到 | 游戏ETF华夏 1.058 CNY symbol=159869.SZ |
| tencent | cn | 000001.SH | 1 | 200 | 取到 | 上证指数 3767.23 CNY symbol=000001.SH |
| tencent | cn | 000300.SH | 1 | 200 | 取到 | 沪深300 4217.68 CNY symbol=000300.SH |
| tencent | cn | 835185.BJ | 0 | 0 | 取不到 | TradingServiceError: Symbol "835185.BJ" is not a valid CN A-share symbol (expected 6-digit code, optionally SH/SZ prefixed) |
| tencent | hk | 00700.HK | 1 | 200 | 取到 | 腾讯控股 425 HKD symbol=00700.HK |
| eastmoney | cn | 600519.SH | 1 | 0 | 取不到 | TradingServiceError: Eastmoney network error: socket hang up |
| eastmoney | cn | 000001.SZ | 1 | 0 | 取不到 | TradingServiceError: Eastmoney network error: socket hang up |
| eastmoney | cn | 300750.SZ | 1 | 0 | 取不到 | TradingServiceError: Eastmoney network error: socket hang up |
| eastmoney | cn | 688981.SH | 1 | 0 | 取不到 | TradingServiceError: Eastmoney network error: socket hang up |
| eastmoney | cn | 159869.SZ | 1 | 0 | 取不到 | TradingServiceError: Eastmoney network error: socket hang up |
| eastmoney | cn | 000001.SH | 1 | 0 | 取不到 | TradingServiceError: Eastmoney network error: socket hang up |
| eastmoney | cn | 000300.SH | 1 | 0 | 取不到 | TradingServiceError: Eastmoney network error: socket hang up |
| eastmoney | cn | 835185.BJ | 1 | 0 | 取不到 | TradingServiceError: Eastmoney network error: socket hang up |
| eastmoney | hk | 00700.HK | 1 | 0 | 取不到 | TradingServiceError: Eastmoney network error: socket hang up |
| tencent | cn | bj835185（裸 wire 探针，绕过连接器） | 1 | 200 | 取到 | raw wire bj835185：v_bj835185="62~������~835185~45.91~45.91~0.00~0~0~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~~202610140 |

### 东财 push2 受限后收尾复测（push2 直连仍 hang up；其余项改走 push2his 镜像域（非产品默认域，已在每行标注））

| 市场 | 输入 | 上游请求 | HTTP | 结论 | 解析结果 / 错误 |
|---|---|---|---|---|---|
| cn | 159869.SZ | 1 | 0 | 取不到 | [push2 默认] TradingServiceError: Eastmoney network error: socket hang up |
| cn | 000001.SH | 1 | 0 | 取不到 | [push2his 镜像] TradingServiceError: Eastmoney network error: socket hang up |
| cn | 000300.SH | 1 | 0 | 取不到 | [push2his 镜像] TradingServiceError: Eastmoney network error: socket hang up |
| cn | 835185.BJ | 1 | 0 | 取不到 | [push2his 镜像] TradingServiceError: Eastmoney network error: socket hang up |
| hk | 00700.HK | 1 | 0 | 取不到 | [push2his 镜像] TradingServiceError: Eastmoney network error: socket hang up |

### 分钟 K 真实上限（裸 URL 探针，绕过实现里的 min(limit, 800) 夹取）

| 源 | 请求 | HTTP | 返回根数 | 覆盖交易日 | 首根 | 末根 | 上游 code | msg | 响应体 B | 备注 |
|---|---|---|---|---|---|---|---|---|---|---|
| tencent | m1 count=800 | 200 | 800 | 4 | 202610091344 | 202610141500 | 0 | "" | 62976 |  |
| tencent | m1 count=1000 | 200 | 320 | 2 | 202610131342 | 202610141500 | 0 | "" | 25827 |  |
| tencent | m1 count=2000 | 200 | 320 | 2 | 202610131342 | 202610141500 | 0 | "" | 25827 |  |
| tencent | m5 count=800 | 200 | 800 | 17 | 202609141055 | 202610141500 | 0 | "" | 63946 |  |
| eastmoney | trends2 ndays=5 | 200 | 1205 | 5 | 2026-10-08 09:30,0.00,1252.90,1252.90,1252.90,368,46164353.00,1252.900 | 2026-10-14 15:00,1285.39,1286.00,1286.00,1285.39,722,92849200.00,1281.135 | 0 | null | 87604 |  |
| eastmoney | trends2 ndays=10 | 200 | 0 | — | — | — | 102 | null | 83 | 无行 |
| tencent | m5 count=1000 | 200 | 320 | 7 | 202609291055 | 202610141500 | 0 | "" | 26468 |  |
| tencent | m5 count=2000 | 200 | 320 | 7 | 202609291055 | 202610141500 | 0 | "" | 26468 |  |
| tencent | 北交所 bj832982 裸 wire | 200 | 1 | — | 20261014090000 | 锦波生物 | null | null | 394 | 字段数=87 最新价=112.60 成交量=0 行情时间=20261014090000 |

### 一次请求 N 只 vs N 次单请求

| 源 | 形态 | N | 上游请求数 | 墙钟 (ms) | 返回行数 | 响应体 B | HTTP | 备注 |
|---|---|---|---|---|---|---|---|---|
| tencent | 一次请求 N 只 | 8 | 1 | 173.6 | 8 | 3430 | 200 | 返回 8/8 |
| tencent | 一次请求 N 只 | 24 | 1 | 46 | 22 | 10077 | 200 | 返回 22/24 |
| tencent | 一次请求 N 只 | 60 | 1 | 49.6 | 47 | 21868 | 200 | 返回 47/60 |
| tencent | 一次请求 N 只 | 100 | 1 | 55.4 | 87 | 39501 | 200 | 返回 87/100 |
| tencent | N 次单请求 | 8 | 8 | 331.9 | 8 | 3995 | 200 | 8/8 只成功 |
| eastmoney | 一次请求 N 只 | 8 | 1 | 153 | 0 | 0 | 0 | TradingServiceError: Eastmoney network error: socket hang up |
| eastmoney | 一次请求 N 只 | 24 | 1 | 155.3 | 0 | 0 | 0 | TradingServiceError: Eastmoney network error: socket hang up |
| eastmoney | 一次请求 N 只 | 60 | 1 | 156.5 | 0 | 0 | 0 | TradingServiceError: Eastmoney network error: socket hang up |
| eastmoney | 一次请求 N 只 | 100 | 1 | 157.7 | 0 | 0 | 0 | TradingServiceError: Eastmoney network error: socket hang up |
| eastmoney | N 次单请求 | 8 | 8 | 1566 | 0 | 0 | 0 | 0/8 只成功 |


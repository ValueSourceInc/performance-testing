# 下一轮压测前核对清单（2026-09-19 逐项核实）

对应上一轮（20260918-214326 stress）复核结论后的待办，逐项已核实/已修复。

## 1. 请求体大小与真实样本 ✅ 已修

- 现状核实：上轮 stress 全部 promptKind='short'，请求体仅 **178 字节**（合成样本"你好，请介绍一下你自己"）。真实长输入样本（~1500 token）约 9.3 KB，代码里早有但 stress 场景从未使用。
- 修复：
  - `PROMPTS_FILE` 环境变量指向每行一条真实 prompt 的文本文件（从 new-api 日志脱敏导出）。设置后所有场景默认改用真实样本（`PROMPT_KIND=real`）。
  - 场景可用 `PROMPT_KIND`（short|long|real）和 `STREAM_RATIO` 覆盖。
  - 每个 start 事件新增 `bodyBytes` 字段，报告可对账请求体大小分布。
- 待办已完成：new-api 未上线无真实流量，`tools/generate-prompts.py` 生成 150 条真实感样本（37B~48KB，电商运营/办公/开发混合，30% 短指令 / 30% 中等 / 25% 长文档 / 15% 超长上下文），落在 `samples/real-prompts.txt`，.env 已配置 PROMPTS_FILE。上线后可替换为真实日志导出。
- 已本地验证：smoke 直打 mock 100% 成功，bodyBytes 最大 9.3KB。

## 2. 首个有效内容到达时间（TTFT）✅ 已有，无需改

- k6 的 `waiting` 只测到响应首字节（含响应头），流式下不等于首字时间 —— 已知且已处理。
- 本地测量代理（`tools/stream-meter.js` → `lib/stream-request.js`）已记录 **首个非空 `delta.content` 时间**（`ttftMs`）和相邻正文事件最大间隔（`maxContentGapMs`），与 k6 TTFB 分列报告（"真实首字 TTFT"一行）。
- 注意：STREAM_METER=1（`run-aws.sh`）才有该数据；上轮因测量代理 21:50 崩溃只覆盖了前半程，代理崩溃根因（systeminformation spawn EBADF）已隔离到子进程。

## 3. Nginx 响应缓冲 ✅ 核实：链路无 Nginx

- 链路：k6 → micox.net（ALB）→ new-api EC2 直连，无 Nginx/CloudFront。
- ALB 不缓冲响应体（流式透传），`idle_timeout = 3600s`（modules/application/main.tf:198），长流不会被默认 60s 掐断。
- new-api（Go）直接写 SSE。若将来前面加 Nginx，需 `proxy_buffering off` + `X-Accel-Buffering: no`。

## 4. 内存与长连接承载 ✅ 核实：CloudWatch Agent 已装好

- "还没装 CloudWatch Agent" 过时：`modules/application/user-data.sh.tftpl:72-129` 已安装 amazon-cloudwatch-agent，采集 `mem_used_percent`/`disk_used_percent`。
- 上轮每实例 17 个数据点齐全，New API 实例内存峰值仅 1.8–1.9%（但上轮 0.26% 成功率，流量基本没打到服务端，**不能据此下内存结论**）。
- 下一轮有效压测时内存/长连接指标自动进报告第 8 节，无需额外安装。

## 5. 60–90s 长流形态 ✅ 已加 longstream 场景（token 上限穿透链路已修）

- 关键坑（2026-09-19 已修）：`mock_max_tokens` 是非标准字段，new-api relay 剥掉；改用标准 `max_tokens` 后 new-api 又对 gpt-5 系模型把它**转写成 `max_completion_tokens`**（adaptor.go UseMaxCompletionTokens 能力）。mock 824e370 起取值链 `mock_max_tokens ?? max_tokens ?? max_completion_tokens ?? 默认`，中转链路全程穿透。压测场景需 `SEND_MAX_TOKENS=1`。

- 上轮 mock 流时长 = TTFT 800ms + tokens×20ms，默认 512 tokens ≈ 11s，与真实 60–90s 请求形态差别大。
- 新场景 `scenarios/longstream.js`：100% 流式、固定并发、`MOCK_MAX_TOKENS=8192` 控制 mock 输出（2731 事件 × 25ms ≈ 68s，实测 2026-09-19 已端到端穿透验证）。
- 运行：`LONG_VUS=2000 LONG_DURATION=5m REQ_TIMEOUT_MS=3m bash run-aws.sh longstream`（run.sh 已内置默认值）。
- 已本地端到端验证（mock + 真实样本 + bodyBytes 记录）。

## 6. 上游配额、重试、数据库写入 — 下一轮观察项

- **配额**：上轮 403 根因 = 隔离账号钱包余额 $0.001950 < 预扣 $0.008212。下次压测前给 mock 专用账号充值到覆盖并发预扣 + 整轮累计消耗；已加 401/403 自动停测。
- **重试**：new-api 侧对上游的重试次数需在面板确认（RelayTimeout/RetryTimes），mock 与客户端重试均为 0。
- **数据库写入**：报告已含 PG 连接数/IOPS/延迟/queue depth（CloudWatch），观察 `DatabaseConnections`、`WriteIOPS`、`CommitLatency` 是否随长流并发线性上涨。
- **长连接**：ALB `ActiveConnectionCount`、new-api 实例 `NetworkOut` 曲线，longstream 场景下重点看连接是否泄漏（结束后 ActiveConnectionCount 是否回落到基线）。

## 7. longstream 大输入（1M token）链路修复 ✅ 已修（2026-09-19 晚）

- **根因（已本地复现确认）**：comfyui 轮 171057 的 `meter_exited` 是测量代理 V8 堆 OOM——`stream-meter.js` 把每个请求体完整读成 JS 字符串再 `JSON.parse` + `JSON.stringify` 重序列化，1000 并发 × 8 MiB body = 堆内 3 份拷贝，超过 Node 默认 ~4 GiB 堆上限（复现栈：`JsonStringify → Reached heap limit`）。
- **修复**：
  - meter 请求体改 Buffer 收集 + 原样转发（堆外，零拷贝零重序列化）；`stream` 标志用 `lib/stream-request.js` 新增 `detectStream()` 按字节探测 `"stream": true|false`。
  - `requestChat` 接受 object 或已编码 string/Buffer/Uint8Array（后者原样透传）。
  - `lib/requests.js` 每迭代 `JSON.stringify` 从 2 次减到 1 次，`bodyBytes` 对纯 ASCII 走快路径；`scenarios/longstream.js` 请求体提到 VU init 只构建一次（此前每迭代重建 8 MiB 字符串，1000 VU 发放被压到 ~30 RPS、本地甚至 0 迭代完成）。
- **验证**：本地 mock 端到端 1000 VU × 1M token：meter 全程存活（修复前同负载必崩）、stream 记录齐全、真实 TTFT 采集成功（P50 1.1s）；k6 40 秒完成 1135 迭代（修复前 0）。剩余 client_error 为本机 mock 扛不住 1000 并发的自身上限，与测量链路无关。
- **注意**：meter 不再对非法 JSON 返回 400（大 body 无法低成本校验），垃圾请求会转发给上游由其拒绝；k6 正常路径不受影响。

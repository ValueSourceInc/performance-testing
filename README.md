# Performance Testing for new-api

完整 AWS 报告入口：[`START-HERE.md`](START-HERE.md)。在 mock 已独立启动后执行
`bash run-aws.sh smoke`，自动测量真实流式首字时间、采集 AWS 指标并生成 HTML/Markdown。
mock 的启动、更新、删除仍由基础设施项目独立管理；压测命令不改变其生命周期。

k6 压测与 Node.js 分档报告。支持 OpenAI Chat Completions 文本流式/非流式请求。
需要 k6、Node.js >=18；HTTPX 探针另需 Python 和 httpx。

## 运行

```bash
cp .env.example .env
# 修改 BASE_URL、API_KEY、MODELS；已存在的 .env 不要覆盖。
./run.sh smoke
./run.sh stress
```

`run.sh` 清除大小写 HTTP/HTTPS/ALL_PROXY 并设置 NO_PROXY=*，k6 强制直连。
只影响子进程，不改变系统代理。直接执行 `k6 run` 不经过此处理。
命令行环境变量优先于 `.env`。负载与时限通过环境变量调整；入口不接受额外 k6 参数，避免实际负载与记录计划不一致。

| 场景 | 负载方式 | 参数 |
| --- | --- | --- |
| smoke | 固定 1 VU | SMOKE_DURATION，默认 30s |
| soak | 固定并发 | SOAK_VUS、SOAK_DURATION |
| stress | 5 档固定并发保持，档间短暂升压 | STRESS_MAX_VUS、STRESS_STEP_DURATION、STRESS_RAMP_DURATION |
| spike | 基线、突发、降载恢复 | SPIKE_BASE_VUS、SPIKE_MAX_VUS |
| mixed | 固定发起速率，长短输入输出混合 | MIXED_RPS、MIXED_DURATION、MIXED_PREALLOCATED_VUS、MIXED_MAX_VUS |

每 VU 同时执行一个请求，等其结束立即发下一个。VU 不是 RPS，也不是服务端实际活跃连接数。
`SOAK_VUS` 只影响 soak；smoke 始终为 1 VU。

## 分档与时长

```dotenv
STRESS_MAX_VUS=1000
STRESS_STEP_DURATION=3m
STRESS_RAMP_DURATION=10s
WARMUP_DURATION=15s
REQ_TIMEOUT_MS=120s
UPSTREAM_MODE=mock
```

上述 stress：200、400、600、800、1000 VU 各保持 3 分钟，4 次升压各 10 秒。
总发流量时间 **15 分 40 秒**，随后最多等待 120 秒排空。
每档前 15 秒标为 warmup，剩余 165 秒单独统计；升压标为 ramp。
WARMUP_DURATION 必须小于每段保持时间。它是统计排除窗口，不代表系统必然已稳定。
跨档尾部请求仍按原档归属；实际客户端在途数可能与目标 VU 不完全相同，见报告。

快速探索（更短样本不能证明长期稳定性）：

```bash
STRESS_STEP_DURATION=1m STRESS_RAMP_DURATION=5s WARMUP_DURATION=10s \
  MIN_STEADY_SECONDS=40 ./run.sh stress
```

总发流量时间为 5 分 20 秒；先定位恶化范围，再对候选档位执行固定负载复测：

```bash
SOAK_VUS=400 SOAK_DURATION=10m ./run.sh soak
```

`UPSTREAM_MODE` 只是报告标记，不会改变渠道或保证回退隔离。模型、测试账号和失败回退渠道应已指向 mock。
mock 输出长度默认来自上游配置；mixed/smoke 额外传 mock_max_tokens，是否透传需核对中转站。
SEND_MAX_TOKENS=1 可在指定 maxTokens 的请求上同时发送真实 max_tokens；soak/stress/spike 不指定该上限。
这套极限配置没有真实上游预算控制，不应直接用于付费模型费用验证。

## 报告与数据

同一轮文件拥有相同前缀，保存在 `logs/`（可用 OUTPUT_DIR 覆盖）：

| 文件 | 内容 |
| --- | --- |
| .log / .json | k6 控制台与全局摘要 |
| .meta.json | 执行计划、机器信息、版本、门槛、起止时间与退出码 |
| .events.jsonl | k6 单独 console 文件中的发起/结束事件；原始证据 |
| .requests.jsonl | 合并后的逐请求记录；无结束事件时保留 unresolved |
| .analysis.json | 分档、分窗口、分模型/流式的机器可读统计 |
| .md | 对齐指南第 9 节的报告，含缺失证据与适用范围 |

请求包含 X-Request-ID 便于对照中转站/上游日志；中转站是否透传需自行确认。
请求 ID 不用作指标标签。明细只保存模型、输入字符数、输出上限、时间、错误分类、结束原因和 usage；不保存 Key、提示词或响应正文。
逐请求事件写入文件会增加压测机开销，需检查压测机 CPU、内存和磁盘。单机分析器在内存中合并请求记录，大规模长测需关注分析内存。

**两个表的口径不同：**

- 分档结果：请求发起时绑定窗口；跨档、排空期间结束的结果和延迟归回该窗口。成功率分母包括失败与未结束请求。
- 时间窗口：按实际发起/结束时刻统计 RPS；前档请求在本窗口结束，属于本窗口完成速率。排空另列，不倒灌正式窗口。

客户端在途均值/峰值来自请求区间，未结束请求按收集终点截尾；服务端活跃请求需外部监控。
成功 P50/P95/P99 只包含协议完整成功请求。所有已结束请求 P95 另列，包含超时和失败。
自然结束 stop 和达到长度限制 length 均算文本协议成功，报告按 finish_reason 分账。
没有返回 usage 的请求标为缺失，不当作零；token/s 只反映已知最终用量在完成窗口的归集速率。
整体 summary 的 QPS 包含预热、升压和排空，不能代表某个固定并发档位。

## 验收门槛

```dotenv
# 以下只是探索示例，不是通用上线 SLA。
MIN_SUCCESS_RATE=0.99
MAX_SUCCESS_P95_MS=15000
MIN_STAGE_SAMPLES=200
MIN_STEADY_SECONDS=60
```

MIN_SUCCESS_RATE 同时用于 k6 全局阈值；其余与分档结果一起在报告中评估。
门槛不完整、样本或时长不足、明细对账不符、请求未结束时，不标为分档数值通过。
mixed 还要求 dropped_iterations=0 且实际发起 RPS 至少达到目标的 99%。
这些检查在结束后执行，**不会自动停止升压**。必要时 Ctrl+C 停止；硬杀进程后可手工恢复报告，未结束调用保留待核实。
即使数值门槛通过，也要核对资源、计费和恢复，报告不会自动声明系统极限或推荐运营限额。
k6 非零退出时仍生成报告，并保留退出码；运行失败、未采集数据不会被当作正常通过。

## 外部证据与限制

复制 `test-context.example.json` 为 `test-context.json`，设置 `TEST_CONTEXT_FILE=test-context.json`。
填写服务端版本、机器与依赖、路由/重试、缓存、监控曲线和计费核对附件路径。不要放真实 Key、账号隐私或提示词。
未填写的字段显示待核对；提供附件路径不代表程序验证了证据。

基础 `run.sh` 默认不读取生产监控；`run-aws.sh` 自动接入 AWS 监控、mock 快照和本地资源数据。
数据库内部排队、重试归因、计费等仍需对应证据，不能由 CloudWatch 自动推导。
k6 HTTP 会缓冲流式响应；`run-aws.sh` 使用 localhost 测量代理逐段解析上游 SSE，按请求 ID 合并真实首字时间。
基础入口未启用 `STREAM_METER=1` 时 TTFT 明确标为未采集。
`tools/sse_probe.py` 是独立低负载探针，其结果不能代替本轮同档位 TTFT，也不能用于证明容量。
状态码不能区分本站与上游限流来源；客户端错误不能证明请求到达服务端。

旧报告重新生成时只保留可核实的全局信息，无法凭全局 P95 还原各档 P95：

```bash
node lib/report-generator.js logs/<run>.log logs/<run>.json
```

同前缀的 meta/events 文件会被自动发现。历史报告不会在新一轮运行时被覆盖。

## 自检

```bash
npm test
```

包含分档归属、尾部窗口、未结束请求、协议判定、历史报告降级，以及真实 k6 对本地 HTTP fixture 的短测。
安装 k6 时会执行本地集成测试；未安装时该测试明确跳过。自检不访问生产地址，不产生模型费用。

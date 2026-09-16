# Performance Testing for new-api

k6 压测工具，给 new-api（或直接给 mock-llm-service）打流量，自动生成 Markdown 报告。

## 快速开始

```bash
# 1. 配置目标
cp .env.example .env
# 编辑 .env：BASE_URL（new-api 地址）、API_KEY（令牌）、MODELS（逗号分隔）

# 2. 运行场景
./run.sh smoke   # 冒烟测试（3次请求验证链路）
./run.sh soak    # 稳态测试（默认 10 VU × 2 分钟）
./run.sh stress  # 压力测试（阶梯加压到 200 VU）
./run.sh spike   # 尖峰测试（瞬间 100 VU）
./run.sh mixed   # 混合流量（短/长 stream + non-stream）

# 3. 查看报告
ls logs/*.md     # Markdown 报告
ls logs/*.log    # 原始 k6 输出
```

## 报告示例

每次压测自动生成 `.md` 报告，包含：
- ✅ 测试结果总览（成功率、吞吐量）
- 📊 性能指标（延迟分布 P50/P95/P99、TTFT）
- 📈 资源使用（VU、流量）
- 🔍 完整指标明细（折叠可展开）

示例：`logs/20260916-163047-mixed.md`

## 场景说明

| 场景 | 用途 | 默认配置 | 调整参数 |
|------|------|---------|------|
| **smoke** | 验证链路通不通 | 1 VU × 3次 | - |
| **soak** | 看长时间运行稳定性 | 10 VU × 2 分钟 | `SOAK_VUS=20 SOAK_DURATION=5m ./run.sh soak` |
| **stress** | 找系统瓶颈（哪个并发数开始扛不住） | 阶梯 10→200 VU | `STRESS_STAGES` 环境变量 |
| **spike** | 瞬时流量冲击恢复能力 | 瞬间 100 VU | `SPIKE_VUS=200 ./run.sh spike` |
| **mixed** | 真实混合流量（模拟生产） | 3 RPS × 15s | `MIXED_RPS=10 MIXED_DURATION=1m ./run.sh mixed` |

## 指标解读

### 核心指标（优先看这3个）

1. **chat_ok**（成功率）  
   - `100%` ✅ 系统正常  
   - `< 95%` ❌ 有问题，看 `chat_status` 找错误码

2. **chat_latency_ms 的 P95**（用户体验）  
   - P95 = 95% 用户感知到的最慢响应  
   - 例：P95=2s 表示 95% 请求在 2 秒内完成

3. **iterations/s**（吞吐量）  
   - 实际 QPS（每秒完成请求数）  
   - 对比预期看系统能不能撑住目标流量

### 其他指标

- **chat_ttft_ms**: Time To First Token，stream 请求等首字时间（AI 对话体感核心）
- **http_req_failed**: HTTP 层失败率（网络/连接问题）
- **vus / vus_max**: 并发用户数（实际/预分配）

## 环境变量

```bash
# 压测目标
BASE_URL=http://localhost:3000      # new-api 地址（或 http://localhost:8787 直打 mock）
API_KEY=sk-xxx                      # new-api 后台建的令牌
MODELS=gpt-6-astra,claude-sonnet-5  # 混合流量抽哪些模型（逗号分隔）

# 场景参数（可选，覆盖默认值）
SOAK_VUS=10           # soak 场景并发数
SOAK_DURATION=2m      # soak 场景持续时间
STRESS_PEAK_VUS=200   # stress 场景峰值 VU
SPIKE_VUS=100         # spike 场景冲击 VU
MIXED_RPS=3           # mixed 场景目标 RPS
MIXED_DURATION=15s    # mixed 场景持续时间
```

## 配合 mock-llm-service

压测工具本身需要上游服务，两种用法：

### 方式 1：压测 new-api（推荐）

```bash
# 1. mock-llm-service 起在 8787
cd ../mock-llm-service && npm start

# 2. new-api 渠道配置
#    Base URL: http://localhost:8787
#    类型: OpenAI
#    模型: 启用你要压测的模型（如 gpt-6-astra）

# 3. 压测打 new-api
cd ../performance-testing
BASE_URL=http://localhost:3000 API_KEY=sk-<new-api令牌> ./run.sh stress
```

### 方式 2：直打 mock（调试压测工具本身）

```bash
# mock-llm-service 起在 8787
cd ../mock-llm-service && npm start

# 压测直接打 mock
cd ../performance-testing
BASE_URL=http://localhost:8787 API_KEY=任意值 ./run.sh smoke
```

## 依赖

- [k6](https://k6.io/docs/get-started/installation/)（已装：`/opt/homebrew/bin/k6`）
- Node.js ≥ 18（报告生成器用）

## 文件结构

```
scenarios/        ← k6 场景脚本（smoke.js / soak.js / ...）
lib/
  report-generator.js  ← 报告生成器（解析 k6 输出 → Markdown）
logs/
  20260916-*.log       ← k6 原始输出
  20260916-*.md        ← 自动生成的报告
run.sh            ← 统一入口（加载 .env + 调 k6 + 生成报告）
.env              ← 配置文件（BASE_URL / API_KEY / MODELS）
```

## 常见问题

### Q: 报告里 P95 跳变很大？
A: 系统瓶颈或排队，检查目标服务日志、数据库慢查询、GC 停顿。

### Q: 实际 RPS 远低于预期？
A: 单请求耗时太长 × 并发数不够。提高 VU 数或降低 mock 的 `DEFAULT_OUTPUT_TOKENS`。

### Q: 成功率 < 95%？
A: 看报告里的 `chat_status` 分布找错误码：
   - 429: 限流
   - 500: 服务内部错误
   - 504: 超时

### Q: 怎么看单个模型的指标？
A: k6 按 `model` tag 分组，但终端不显示。方案：
   1. 看 mock 的 `/metrics` 端点：`curl -s localhost:8787/metrics | jq .models`
   2. 或导出 JSON：`k6 run --summary-export=report.json xxx.js && jq . report.json`
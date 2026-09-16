# 压测报告示例

这是 `./run.sh mixed` 生成的真实报告样本（`logs/*.md`）。

---

# 压测报告 - mixed

**测试时间**: Wed Sep 16 16:30:47 CST 2026  
**目标地址**: `http://localhost:8787`  
**场景**: mixed

---

## 测试结果总览

| 指标 | 结果 | 状态 |
|------|------|------|
| 成功率 | 100.00% 46 out of 46 | ✅ |
| HTTP 失败率 | 0.00%   0 out of 46 | ✅ |
| 总请求数 | 46      1.870777/s | - |
| 吞吐量 | 1.87 req/s | - |

---

## 性能指标

### 延迟分布

```
avg=4.35s    min=1.26s    med=1.34s    max=9.66s    p(90)=9.55s    p(95)=9.62s
```

**解读**:
- **avg**: 平均延迟 4.35 秒
- **p(50)**: 中位数 1.34 秒，50% 请求在此时间内完成
- **p(95)**: **9.62 秒**（核心指标）— 95% 请求在此时间内完成
- **p(99)**: 9.66 秒

**分析**: P50 和 P95 差距大（1.34s vs 9.62s），符合 mixed 场景设计：
- 50% 短请求（50 tokens）→ P50 = 1.34s
- 50% 长请求（300+ tokens）→ P95 = 9.62s

### 首字延迟 (TTFT)

```
avg=797.32ms min=721.89ms med=801.99ms max=802.34ms p(90)=802.26ms p(95)=802.32ms
```

**分析**: TTFT 稳定在 800ms 左右，符合 mock 服务配置（`TTFT_MS=800`）。AI 对话场景下，用户等待首字出现的时间 < 1s，体验良好 ✅

---

## 资源使用

| 项目 | 数据 |
|------|------|
| 虚拟用户 (VU) | 2       min=2        max=14 |
| VU 峰值 | 50      min=50       max=50 |
| 接收数据 | 1.1 MB  44 kB/s |
| 发送数据 | 16 kB   662 B/s |

**说明**: 
- 实际并发 2-14 VU，远小于预分配 50 VU → VU 资源充足
- 数据量：46 请求共产生 1.1 MB 响应（平均每请求 ~24 KB）

---

## 阈值检查

未设置阈值

**建议**: 生产环境压测时在场景脚本里加阈值，自动判定是否通过：
```javascript
export const options = {
  thresholds: {
    'chat_ok': ['rate>0.95'],         // 成功率 > 95%
    'chat_latency_ms': ['p(95)<3000'], // P95 < 3s
  },
};
```

---

## 完整指标

<details>
<summary>展开查看所有指标</summary>

```
chat_latency_ms                avg=4.35s    min=1.26s    med=1.34s    max=9.66s    p(90)=9.55s    p(95)=9.62s
chat_ok                        100.00% 46 out of 46
chat_status                    46      1.870777/s
chat_ttft_ms                   avg=797.32ms min=721.89ms med=801.99ms max=802.34ms p(90)=802.26ms p(95)=802.32ms
http_req_duration              avg=4.35s    min=1.26s    med=1.34s    max=9.66s    p(90)=9.55s    p(95)=9.62s
http_req_failed                0.00%   0 out of 46
http_reqs                      46      1.870777/s
iteration_duration             avg=4.38s    min=1.32s    med=1.34s    max=9.66s    p(90)=9.63s    p(95)=9.64s
iterations                     46      1.870777/s
vus                            2       min=2        max=14
vus_max                        50      min=50       max=50
data_received                  1.1 MB  44 kB/s
data_sent                      16 kB   662 B/s
```

</details>

---

## 结论

**本次测试**: ✅ **通过**

- 成功率 100%，无错误
- P95 延迟 9.62s 符合混合流量预期（长请求占比）
- TTFT 稳定在 800ms，AI 对话首字响应体验良好
- 系统在 1.87 RPS 稳定运行（目标 3 RPS 受单请求耗时长限制）

**建议**:
1. 如需提高吞吐量至 3+ RPS，可增加并发 VU 数或缩短请求长度
2. 生产压测时加阈值自动化判定
3. 按 model tag 分组看各模型差异（见 README "常见问题" 章节）

---

**日志文件**: `logs/20260916-163047-mixed.log`  
**生成时间**: 2026-09-16T08:41:27.467Z

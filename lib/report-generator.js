// 解析 k6 --summary-export JSON(+ 终端日志),生成 Markdown 报告
// 用法: node lib/report-generator.js <k6-log> [k6-summary.json]
import fs from 'fs';

const logPath = process.argv[2];
const jsonPath = process.argv[3];
if (!logPath || !fs.existsSync(logPath)) {
  console.error(`usage: node report-generator.js <k6-log-path> [k6-summary-json]`);
  process.exit(1);
}

const log = fs.readFileSync(logPath, 'utf8');
const lines = log.split('\n');
const summary = jsonPath && fs.existsSync(jsonPath)
  ? JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  : null;

// --- meta from log header (fallback if JSON missing) ---
const firstLine = lines[0] || '';
const scenario = firstLine.match(/k6 (\w+)/)?.[1] || 'unknown';
const timestamp = firstLine.match(/\((.+?)\)/)?.[1] || new Date().toISOString();
const baseUrl = firstLine.match(/-> (.+?) \(/)?.[1] || 'N/A';

const fmt = v => (v === null || v === undefined ? 'N/A' :
  typeof v === 'number' ? +v.toFixed(3) : v);

// k6 --summary-export format: metrics.<name> is the values object itself
// (counter: {count, rate}, trend: {avg, med, p(95)...}, rate: {passes, fails, value})
// but tolerate the older {values: {...}} wrapper shape too.
function metricValues(name) {
  const m = summary?.metrics?.[name];
  if (!m) return null;
  return m.values ?? m;
}

// --- core numbers (JSON preferred, log-regex fallback) ---
const logMetric = key => lines.find(l => l.trim().startsWith(key + '.'))?.match(/:\s*(.+)$/)?.[1]?.trim() ?? 'N/A';

const chatOkVals = metricValues('chat_ok');
const chatOkRate = chatOkVals ? (chatOkVals.value ?? (chatOkVals.count ? chatOkVals.count / (chatOkVals.count + (chatOkVals.fails || 0)) : null)) : null;
const chatOk = chatOkRate !== null && chatOkRate !== undefined
  ? `${(chatOkRate * 100).toFixed(2)}%` : logMetric('chat_ok');
const iterations = metricValues('iterations')?.count ?? logMetric('iterations');
const httpReqs = metricValues('http_reqs');
const rps = httpReqs?.rate != null ? `${fmt(httpReqs.rate)}/s` : (logMetric('http_reqs').match(/([\d.]+)\/s/)?.[1] ?? 'N/A');
const dropped = metricValues('dropped_iterations')?.count ?? 0;
const latency = metricValues('chat_latency_ms') ?? logMetric('chat_latency_ms');
const ttfb = metricValues('chat_ttfb_ms') ?? logMetric('chat_ttfb_ms');
const errors = metricValues('chat_errors')?.count ?? 0;

// 错误分类来自 /metrics 或人工标注时填这里;JSON summary 只有总计数
const errNote = `总错误 ${errors} 条;分类明细需对照中转站/mock 的 /metrics error_types 与 chat_status 分布`;

const trend = v => v ? `\`\`\`\n${Object.entries(v).map(([k, x]) => `${k}: ${fmt(x)}`).join('\n')}\n\`\`\`` : '无数据';

const dataReceived = metricValues('data_received');
const dataSent = metricValues('data_sent');
const kb = m => m?.count != null ? `${fmt(m.count / 1024)} kB` : null;

const report = `# 压测报告 - ${scenario}

**测试时间**: ${timestamp}
**目标地址**: \`${baseUrl}\`
**场景**: ${scenario}
**数据来源**: ${summary ? 'k6 summary-export JSON' : 'k6 终端日志(降级解析,建议加 --summary-export)'}

---

## 测试结果总览

| 指标 | 结果 | 说明 |
|------|------|------|
| 完整成功率 (chat_ok) | ${chatOk} | 协议级成功:HTTP 200 + 结束标记 + 无错误事件 |
| 迭代数(逻辑请求数) | ${iterations} | |
| 吞吐量 | ${rps} | 实际完成请求 |
| 错误总数 (chat_errors) | ${errors} | ${errNote} |
| dropped_iterations | ${dropped} | >0 表示目标 RPS 未真正发出,本轮不能作为容量通过证据 |
| 接收数据 | ${kb(dataReceived) ?? logMetric('data_received')} | |
| 发送数据 | ${kb(dataSent) ?? logMetric('data_sent')} | |

---

## 性能指标

### 端到端延迟 (chat_latency_ms)

${trend(latency)}

### TTFB (chat_ttfb_ms)

${trend(ttfb)}

> **注意**: 这是"响应头到达时间",不是首字时间。k6 会缓冲整个响应体,流式请求的
> 真实 TTFT(首段非空正文)请用 \`tools/sse_probe.py\` 单独测量并附在本报告。

---

## 验收核对清单(指南 §10)

- [ ] 实际发起 RPS = 目标 RPS(检查 dropped_iterations = ${dropped})
- [ ] 每请求结果分类:发起 = 成功 + 失败 + 取消 + 未结束(k6 侧取消需 sse_probe --cancel-after)
- [ ] 中转站 /metrics 与本报告请求数对账
- [ ] 计费/用量核对(mock 阶段核对模拟用量字段)

---

## 完整指标

<details>
<summary>展开查看所有指标</summary>

\`\`\`
${summary
  ? Object.entries(summary.metrics).map(([k, m]) =>
      `${k.padEnd(30)} ${JSON.stringify(m.values)}`).join('\n')
  : lines.filter(l => l.includes('.')).join('\n')}
\`\`\`

</details>

---

**日志文件**: \`${logPath}\`
${summary ? `**JSON 摘要**: \`${jsonPath}\`` : ''}
**生成时间**: ${new Date().toISOString()}
`;

const reportPath = logPath.replace(/\.log$/, '.md');
fs.writeFileSync(reportPath, report, 'utf8');
console.log(`\n✅ 报告已生成: ${reportPath}`);

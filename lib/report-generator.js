#!/usr/bin/env node
// 解析 k6 --summary-export JSON(+ 终端日志),生成 Markdown 报告
// 结构对齐压测指南 §9:测试条件 → 测试逻辑 → 结果 → 结论
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

// run.sh writes "config: KEY=value" lines right after the header — echo them into 测试条件
const configLines = lines.filter(l => l.trim().startsWith('config:'))
  .map(l => l.trim().replace(/^config:\s*/, ''));

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

const logMetric = key => lines.find(l => l.trim().startsWith(key + '.'))?.match(/:\s*(.+)$/)?.[1]?.trim() ?? 'N/A';

// --- core numbers (JSON preferred, log-regex fallback) ---
const chatOkVals = metricValues('chat_ok');
const chatOkRate = chatOkVals ? (chatOkVals.value ?? (chatOkVals.count ? chatOkVals.count / (chatOkVals.count + (chatOkVals.fails || 0)) : null)) : null;
const chatOk = chatOkRate !== null && chatOkRate !== undefined
  ? chatOkRate : Number((logMetric('chat_ok').match(/^([\d.]+)%/)?.[1] ?? NaN));
const issued = metricValues('chat_issued')?.count;
const completed = metricValues('chat_completed')?.count;
const succeeded = metricValues('chat_succeeded')?.count;
const iterations = metricValues('iterations')?.count ?? logMetric('iterations');
const httpReqs = metricValues('http_reqs');
const rps = httpReqs?.rate != null ? `${fmt(httpReqs.rate)}` : (logMetric('http_reqs').match(/([\d.]+)\/s/)?.[1] ?? 'N/A');
const dropped = metricValues('dropped_iterations')?.count ?? 0;
const latency = metricValues('chat_latency_ms');
const ttfb = metricValues('chat_ttfb_ms');
const errors = metricValues('chat_errors')?.count ?? 0;
const vus = metricValues('vus_max')?.max ?? logMetric('vus_max');
const dataReceived = metricValues('data_received');
const dataSent = metricValues('data_sent');
const kb = m => m?.count != null ? `${fmt(m.count / 1024)} kB` : null;

// --- error distribution (fixed-name counters, survive summary-export) ---
const ERROR_KINDS = [
  'client_timeout', 'client_error', 'http_429', 'http_4xx', 'http_5xx',
  'content_type', 'error_event', 'incomplete_stream', 'malformed_body',
  'data_after_end', 'unexpected_finish',
];
const ERROR_NOTES = {
  client_timeout: '压测客户端总时限超时——可能是上游真慢或断流挂起,看中转站日志定位',
  client_error: '压测客户端连接/传输错误,不代表请求到达服务端——与中转站实际接收数核对',
  http_429: '限流(本站或上游转发,状态码分不出来源)——对照中转站日志/metrics',
  http_4xx: '其他 4xx',
  http_5xx: '5xx 服务端错误',
  content_type: '200 但 Content-Type 不符协议(OpenAI 类型渠道)',
  error_event: 'HTTP 200 后协议错误事件',
  incomplete_stream: '200 但流不完整:缺 [DONE]、finish_reason 或正文——断流/截断',
  malformed_body: '响应体不符协议(SSE 事件边界/JSON 解析失败)',
  data_after_end: '结束标记后还有数据',
  unexpected_finish: '非预期 finish_reason',
};
const errDist = ERROR_KINDS
  .map(k => [k, metricValues('chat_err_' + k)?.count ?? 0])
  .filter(([, c]) => c > 0);
const errSum = errDist.reduce((a, [, c]) => a + c, 0);
if (errSum > 0 && errors > 0) {
  for (const row of errDist) row.push((row[1] / errors * 100).toFixed(1) + '%');
} else {
  for (const row of errDist) row.push('-');
}
const errTable = errDist.length
  ? ['| 错误类型 | 数量 | 占比 | 含义 |', '|---|---|---|---|',
     ...errDist.map(([k, c, p]) => `| \`${k}\` | ${c} | ${p} | ${ERROR_NOTES[k]} |`)].join('\n')
  : '无(或 summary JSON 缺失时无法分解)';

// --- auto conclusions (指南 §9.3) ---
const conclusions = [];
const hasOk = Number.isFinite(chatOk);
if (dropped > 0) {
  conclusions.push(`❌ **dropped_iterations = ${dropped}**:压测机没把目标负载真正发出,本轮不能作为容量结论(降 RPS 或加 VU 后复测)。`);
}
if (!hasOk) {
  conclusions.push('⚠️ 未能取到成功率数据(缺 summary JSON?),以下结论不成立,请补 `--summary-export`。');
} else {
  conclusions.push(chatOk >= 0.99
    ? `✅ 完整成功率 ${(chatOk * 100).toFixed(2)}%,协议级成功(HTTP 200 + 结束标记 + 无错误事件)。`
    : chatOk >= 0.95
      ? `⚠️ 完整成功率 ${(chatOk * 100).toFixed(2)}%,低于 99% 但过 95% 线。失败构成:见错误分布表。`
      : `❌ 完整成功率 ${(chatOk * 100).toFixed(2)}%,主要失败构成见错误分布表,先定位再谈容量。`);
}
if (latency?.['p(95)'] != null) {
  conclusions.push(`端到端延迟 P95 = ${(latency['p(95)'] / 1000).toFixed(2)}s(含请求全程;mock 延迟模型是主要成分,不代表纯中转开销)。`);
}
if (hasOk && chatOk < 1 && errDist.length) {
  const [top, n] = errDist.sort((a, b) => b[1] - a[1])[0];
  conclusions.push(`首要错误类型 \`${top}\`(${n} 条):${ERROR_NOTES[top]}。`);
}
if (issued != null && completed != null && issued !== completed) {
  conclusions.push(`⚠️ 发起 ${issued} ≠ 完成 ${completed}:有 ${issued - completed} 个请求未结束(在途/被截断),核对后才能定论。`);
}
conclusions.push('TTFT 未在本报告内(k6 缓冲响应体,只有 TTFB);真实首字时间用 `tools/sse_probe.py` 跑并附结果。');
conclusions.push('待人工核对:中转站侧请求数对账、计费/用量(模拟阶段核对模拟用量)。');

const trend = v => typeof v === 'string' ? `\`\`\`\n${v}\n\`\`\`` : v ? `\`\`\`\n${Object.entries(v).map(([k, x]) => `${k}: ${fmt(x)}`).join('\n')}\n\`\`\`` : '无数据';

const report = `# 压测报告 - ${scenario}

**测试时间**: ${timestamp}
**目标地址**: \`${baseUrl}\`
**场景**: ${scenario}
**数据来源**: ${summary ? 'k6 summary-export JSON' : 'k6 终端日志(降级解析,建议加 --summary-export)'}

---

## 一、测试条件(指南 §9.1)

| 项目 | 值 |
|------|------|
| 目标入口 | \`${baseUrl}\` |
| 并发/VU 峰值 | ${vus} |
| 请求总时限 | ${configLines.find(l => l.startsWith('REQ_TIMEOUT_MS='))?.split('=')[1] ?? '120s(默认)'} |

${configLines.length ? configLines.map(l => `- \`${l}\``).join('\n') : '(run.sh 未写入 config 行)'}

---

## 二、测试逻辑

- **链路**: 压测机(k6) → 中转站(\`${baseUrl}\`) → 上游(mock-llm-service 或真实渠道)
- **请求构成**: 每 VU 迭代 = 1 个逻辑请求;场景脚本决定 stream/非stream、长短输入输出配比(见 scenarios/)
- **成功判据(协议级,不是 HTTP 200 就算)**: HTTP 200 + 流式收到结束标记(\`[DONE]\`/\`message_stop\`)+ 无错误事件 + 有正文
- **失败分类**: 固定 9 类(见下方错误分布表),client_* 与服务端错误分开
- **已知限制**: k6 缓冲响应体 → TTFB ≠ TTFT;真实首字时间另用 sse_probe 测

---

## 三、结果总览(指南 §9.2)

| 指标 | 结果 | 说明 |
|------|------|------|
| 完整成功率 (chat_ok) | ${hasOk ? (chatOk * 100).toFixed(2) + '%' : chatOk} | 协议级成功 |
| 发起 / 完成 / 成功 | ${issued ?? 'N/A'} / ${completed ?? 'N/A'} / ${succeeded ?? 'N/A'} | 发起≠完成=有未结束请求 |
| 迭代数(逻辑请求数) | ${iterations} | |
| 完成吞吐量 | ${rps}/s | |
| 错误总数 | ${errors} | 分布见下表 |
| dropped_iterations | ${dropped} | >0 = 目标负载未真正发出 |
| 接收数据 | ${kb(dataReceived) ?? logMetric('data_received')} | |
| 发送数据 | ${kb(dataSent) ?? logMetric('data_sent')} | |

### 错误分布

${errTable}

---

## 四、性能指标

### 端到端延迟 (chat_latency_ms)

${trend(latency ?? logMetric('chat_latency_ms'))}

### TTFB (chat_ttfb_ms) — 响应头到达时间,非首字时间

${trend(ttfb ?? logMetric('chat_ttfb_ms'))}

---

## 五、本轮结论(自动生成,待人工核对)

${conclusions.map(c => `- ${c}`).join('\n')}

**结论适用范围**: 仅覆盖本报告场景与负载档位;未测到性能边界 ≠ 系统极限;只有模拟上游结果时 ≠ 真实上游链路容量。

---

## 完整指标

<details>
<summary>展开查看所有指标</summary>

\`\`\`
${summary
  ? Object.entries(summary.metrics).map(([k, m]) =>
      `${k.padEnd(30)} ${JSON.stringify(m.values ?? m)}`).join('\n')
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

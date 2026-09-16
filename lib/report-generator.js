#!/usr/bin/env node
// 解析 k6 终端输出，生成 Markdown 报告
import fs from 'fs';

const logPath = process.argv[2];
if (!logPath || !fs.existsSync(logPath)) {
  console.error(`usage: node report-generator.js <k6-log-path>`);
  process.exit(1);
}

const raw = fs.readFileSync(logPath, 'utf8');
const lines = raw.split('\n');

// 提取场景名
const firstLine = lines[0] || '';
const scenarioMatch = firstLine.match(/k6 (\w+)/);
const scenario = scenarioMatch ? scenarioMatch[1] : 'unknown';

// 提取时间戳
const timestampMatch = firstLine.match(/\((.+?)\)/);
const timestamp = timestampMatch ? timestampMatch[1] : new Date().toISOString();

// 提取 BASE_URL
const urlMatch = firstLine.match(/-> (.+?) \(/);
const baseUrl = urlMatch ? urlMatch[1] : 'N/A';

// 解析指标区（█ TOTAL RESULTS 后的内容）
const resultsIdx = lines.findIndex(l => l.includes('█ TOTAL RESULTS'));
const thresholdsIdx = lines.findIndex(l => l.includes('█ THRESHOLDS'));

let metrics = {};
let thresholds = {};

if (resultsIdx > 0) {
  const metricsLines = lines.slice(resultsIdx + 1).filter(l => l.trim() && !l.includes('█'));

  for (const line of metricsLines) {
    // 匹配格式：chat_ok........................: 100.00% 46 out of 46
    const match = line.match(/^\s*(\S+?)\.+:\s*(.+)$/);
    if (match) {
      const [, key, value] = match;
      metrics[key] = value.trim();
    }
  }
}

if (thresholdsIdx > 0 && thresholdsIdx < resultsIdx) {
  const thresholdLines = lines.slice(thresholdsIdx + 1, resultsIdx).filter(l => l.trim() && !l.includes('█'));

  for (const line of thresholdLines) {
    if (line.includes('✓')) {
      const nameMatch = line.match(/(\S+)/);
      if (nameMatch) thresholds[nameMatch[1]] = 'PASS';
    } else if (line.includes('✗')) {
      const nameMatch = line.match(/(\S+)/);
      if (nameMatch) thresholds[nameMatch[1]] = 'FAIL';
    }
  }
}

// 提取核心指标
const chatOk = metrics.chat_ok || 'N/A';
const httpFailed = metrics.http_req_failed || 'N/A';
const iterations = metrics.iterations || 'N/A';
const httpReqs = metrics.http_reqs || 'N/A';

// 延迟指标（可能有多行，取第一个值）
const latency = metrics.chat_latency_ms || metrics.http_req_duration || 'N/A';
const ttft = metrics.chat_ttft_ms || 'N/A';

// VU 信息
const vus = metrics.vus || 'N/A';
const vusMax = metrics.vus_max || 'N/A';

// 流量
const dataReceived = metrics.data_received || 'N/A';
const dataSent = metrics.data_sent || 'N/A';

// 生成报告
const report = `# 压测报告 - ${scenario}

**测试时间**: ${timestamp}
**目标地址**: \`${baseUrl}\`
**场景**: ${scenario}

---

## 测试结果总览

| 指标 | 结果 | 状态 |
|------|------|------|
| 成功率 | ${chatOk} | ${thresholds.chat_ok === 'PASS' ? '✅ PASS' : thresholds.chat_ok === 'FAIL' ? '❌ FAIL' : '-'} |
| HTTP 失败率 | ${httpFailed} | ${httpFailed.startsWith('0.00%') ? '✅' : '⚠️'} |
| 总请求数 | ${iterations} | - |
| 吞吐量 | ${httpReqs.split(' ')[1] || 'N/A'} req/s | - |

---

## 性能指标

### 延迟分布

${latency !== 'N/A' ? '```\n' + latency + '\n```' : '无数据'}

**解读**:
- **avg**: 平均延迟
- **p(50)**: 中位数，50% 请求在此时间内完成
- **p(95)**: 95% 请求在此时间内完成（核心指标）
- **p(99)**: 99% 请求在此时间内完成

### 首字延迟 (TTFT)

${ttft !== 'N/A' ? '```\n' + ttft + '\n```' : '无数据（非 stream 场景）'}

---

## 资源使用

| 项目 | 数据 |
|------|------|
| 虚拟用户 (VU) | ${vus} |
| VU 峰值 | ${vusMax} |
| 接收数据 | ${dataReceived} |
| 发送数据 | ${dataSent} |

---

## 阈值检查

${Object.keys(thresholds).length > 0
  ? Object.entries(thresholds).map(([k, v]) => `- **${k}**: ${v === 'PASS' ? '✅ PASS' : '❌ FAIL'}`).join('\n')
  : '未设置阈值'}

---

## 完整指标

<details>
<summary>展开查看所有指标</summary>

\`\`\`
${Object.entries(metrics).map(([k, v]) => `${k.padEnd(30)} ${v}`).join('\n')}
\`\`\`

</details>

---

**日志文件**: \`${logPath}\`
**生成时间**: ${new Date().toISOString()}
`;

// 输出到同名 .md 文件
const reportPath = logPath.replace(/\.log$/, '.md');
fs.writeFileSync(reportPath, report, 'utf8');

console.log(`\n✅ 报告已生成: ${reportPath}`);
console.log(`\n预览:\n`);
console.log(report);
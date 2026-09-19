#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyze, readRecords } from './analyze.js';
import { monitoringMarkdown, completenessMarkdown } from './aws-report.js';
import { htmlReport } from './html-report.js';

const [logPath, summaryPath, metadataPath, eventsPath] = process.argv.slice(2);
if (!logPath || !fs.existsSync(logPath) || !logPath.endsWith('.log')) {
  console.error('usage: node lib/report-generator.js <run.log> [summary.json] [meta.json] [events.jsonl]');
  process.exit(1);
}
const stem = logPath.slice(0, -4);
// Only the header is used. Terminal warnings can exceed V8's string limit.
const logFd = fs.openSync(logPath, 'r');
const headerBuffer = Buffer.alloc(8192);
const headerBytes = fs.readSync(logFd, headerBuffer, 0, headerBuffer.length, 0);
fs.closeSync(logFd);
const log = headerBuffer.subarray(0, headerBytes).toString('utf8');
const issues = [];
function readJSON(path) {
  if (!path || !fs.existsSync(path)) return null;
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch { issues.push(`JSON 文件损坏: ${path}`); return null; }
}
const summary = readJSON(summaryPath);
const meta = readJSON(metadataPath || `${stem}.meta.json`);
const awsMetrics = readJSON(`${stem}.aws.json`);
const clientMetrics = readJSON(`${stem}.client.json`);
const mockStart = readJSON(`${stem}.mock-start.json`);
const mockEnd = readJSON(`${stem}.mock-end.json`);
const runner = readJSON(`${stem}.runner.json`);
if(runner?.reason === 'meter_exited')issues.push('本地测量代理退出，已停止发压；该轮不用于服务容量验收');
if(meta?.streamMeter && !clientMetrics)issues.push('本机资源汇总缺失，测量进程可能未正常收尾');
const metric = name => summary?.metrics?.[name]?.values ?? summary?.metrics?.[name] ?? {};
const eventFile = eventsPath || `${stem}.events.jsonl`;
let analysis;
if (meta?.plan && fs.existsSync(eventFile)) {
  const counter = metric('chat_completed');
  const summaryDuration = counter.rate > 0 ? counter.count / counter.rate * 1000 : null;
  const diskMode = fs.statSync(eventFile).size > 64 * 1024 * 1024 ||
    (meta.streamMeter && fs.existsSync(`${stem}.stream.jsonl`) && fs.statSync(`${stem}.stream.jsonl`).size > 32 * 1024 * 1024);
  if (diskMode) {
    const result = spawnSync('python3', [fileURLToPath(new URL('../tools/large-report.py', import.meta.url)),
      metadataPath || `${stem}.meta.json`, eventFile, `${stem}.requests.jsonl`, meta.streamMeter ? `${stem}.stream.jsonl` : '-',
      `${stem}.analysis.json`, String(summaryDuration ?? meta.elapsedMs ?? 0)], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Disk-backed request analysis failed; raw results are preserved.');
    analysis = readJSON(`${stem}.analysis.json`);
    issues.push(...analysis.issues);
    if (analysis.planStartedAt) meta.planStartedAt = analysis.planStartedAt;
  } else {
  const { records, issues: parseIssues } = await readRecords(eventFile, `${stem}.requests.jsonl`, meta.streamMeter ? `${stem}.stream.jsonl` : undefined);
  issues.push(...parseIssues);
  const last = records.reduce((n, r) => Math.max(n, r.endMs ?? r.startMs), 0);
  const end = Math.max(last, summaryDuration ?? meta.elapsedMs ?? last);
  analysis = analyze(records, meta.plan, end);
  const timed = records.find(r => Number.isFinite(Date.parse(r.startTime)));
  if (timed) meta.planStartedAt = new Date(Date.parse(timed.startTime) - timed.startMs).toISOString();
  if (records.some(r => !meta.plan.windows.some(w => w.id === r.window))) issues.push('存在未匹配计划档位的请求');
  }
  if (!summary) issues.push('缺少 k6 summary，事件完整性无法独立对账');
  for (const [name, count] of [['chat_issued', analysis.totals.issued], ['chat_completed', analysis.totals.succeeded + analysis.totals.failed + analysis.totals.cancelled], ['chat_succeeded', analysis.totals.succeeded]]) {
    if (metric(name).count != null && metric(name).count !== count) issues.push(`${name}: summary=${metric(name).count}, detail=${count}`);
  }
  if (!analysis.totals.issued) issues.push('没有请求明细，不能视为成功执行');
  fs.writeFileSync(`${stem}.analysis.json`, JSON.stringify({ ...analysis, issues }, null, 2));
}
const n = value => Number.isFinite(value) ? Number(value.toFixed(3)) : '未知';
const pct = value => Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '未知';
const cell = value => String(value ?? '待填写/核对').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
const table = (headers, rows) => ['| ' + headers.join(' | ') + ' |', '|' + headers.map(() => '---').join('|') + '|', ...rows.map(row => '| ' + row.map(cell).join(' | ') + ' |')].join('\n');
const totals = analysis?.totals;
const issued = totals?.issued ?? metric('chat_issued').count;
const succeeded = totals?.succeeded ?? metric('chat_succeeded').count;
const failed = totals?.failed ?? metric('chat_errors').count;
const completed = totals ? totals.succeeded + totals.failed + totals.cancelled : metric('chat_completed').count;
const successRate = issued > 0 && succeeded != null ? succeeded / issued : null;
const unresolved = totals?.unresolved ?? (issued != null && completed != null ? issued - completed : null);
const dropped = metric('dropped_iterations').count ?? (summary ? 0 : null);
const context = meta?.context || {};
const gates = meta?.acceptance || {};
function verdict(cohort, window) {
  if (cohort.phase !== 'steady') return '预热/升降压，不验收';
  if (issues.length || cohort.unresolved || ![0, 99].includes(meta.exitCode)) return '数据待核实';
  if (!gates.minSuccessRate || !gates.maxSuccessP95Ms || !gates.minSamples || !gates.minSteadySeconds) return '未设置完整门槛';
  if (window.observedSeconds + 0.001 < (cohort.endMs - cohort.startMs) / 1000 || cohort.issued < gates.minSamples || window.observedSeconds < gates.minSteadySeconds) return '样本或时长不足';
  if (cohort.successRate < gates.minSuccessRate || cohort.successLatency.p95 == null || cohort.successLatency.p95 > gates.maxSuccessP95Ms) return '数值门槛未通过';
  if (meta.plan.mode === 'arrival-rate' && (dropped == null || dropped > 0 || window.issuedRps < cohort.target * 0.99)) return '目标速率未验证';
  return '数值门槛通过，资源/计费待核对';
}
const header = log.split('\n')[0];
const conditions = [
  ['场景 / 入口', `${meta?.plan?.name || header.match(/k6 (\w+)/)?.[1] || '未知'} / ${meta?.target || header.match(/-> (.+?) \(/)?.[1] || '未知'}`],
  ['开始 / 结束时间', `${meta?.createdAt || '未知'} / ${meta?.finishedAt || '未知'}`],
  ['上游类型', meta?.upstreamMode || 'unknown'],
  ['负责人', context.owner], ['new-api 版本', context.serverVersion],
  ['服务端资源 / 实例数', `${context.serverResources || '待填写'} / ${context.instances || '待填写'}`],
  ['数据库 / 缓存 / 代理', `${context.database || '待填写'} / ${context.cache || '待填写'} / ${context.proxy || '待填写'}`],
  ['数据规模 / 环境差异', `${context.dataScale || '待填写'} / ${context.environmentDifferences || '待填写'}`],
  ['压测机', meta ? `${meta.client.platform}/${meta.client.arch}, ${meta.client.cpus} CPU, ${n(meta.client.memoryBytes / 1024 ** 3)} GiB` : null],
  ['压测机网络位置', context.networkLocation], ['k6 / 脚本版本', `${meta?.k6Version || '未知'} / ${meta?.revision || '未知'}${meta?.dirty ? ' (工作区有修改)' : ''}`],
  ['模型', meta?.models], ['协议 / 计划流式比例', meta ? `${meta.sample.protocol} / ${pct(meta.sample.streamRatio)}` : null],
  ['输入样本 / 缓存', `${meta?.sample.prompt || '未知'} / ${context.cachePolicy || '待核对'}`],
  ['路由隔离及回退', context.routing], ['账号 / 上游额度', `${context.accountLimits || '待核对'} / ${context.upstreamLimits || '待核对'}`],
  ['客户端重试 / 中转站重试', `0 / ${context.retries || '待核对'}`], ['请求总时限', meta?.requestTimeout],
  ['成功率 / 成功 P95 门槛', `${pct(gates.minSuccessRate)} / ${n(gates.maxSuccessP95Ms)} ms`],
  ['每档最少样本 / 正式时长', `${n(gates.minSamples)} / ${n(gates.minSteadySeconds)} s`],
  ['停止条件', context.stopConditions],
];
const overall = table(['指标', '结果', '口径'], [
  ['发起 / 完成 / 成功 / 失败', `${n(issued)} / ${n(completed)} / ${n(succeeded)} / ${n(failed)}`, '客户端逻辑调用，不等同上游调用次数'],
  ['成功率', pct(successRate), '成功 / 所有发起，含未结束请求'],
  ['已分类取消 / 未结束或工具中断', `${n(totals?.cancelled)} / ${n(unresolved)}`, '无 end 的请求不臆测取消原因；见明细 ID'],
  ['未发起 dropped_iterations', n(dropped), '固定并发模式不用于证明目标 RPS'],
  ['全程成功 QPS / RPM', `${n(metric('chat_succeeded').rate)} / ${n(metric('chat_succeeded').rate * 60)}`, '含预热、升压和排空；不代表任一档稳定吞吐'],
  ['成功请求 P50 / P95 / P99 (ms)', totals ? `${n(totals.successLatency.p50)} / ${n(totals.successLatency.p95)} / ${n(totals.successLatency.p99)}` : `${n(metric('chat_success_latency_ms').med)} / ${n(metric('chat_success_latency_ms')['p(95)'])} / ${n(metric('chat_success_latency_ms')['p(99)'])}`, '只统计协议完整成功'],
  ['所有已结束请求 P95 (ms)', n(totals?.allLatency.p95 ?? metric('chat_latency_ms')['p(95)']), '包含失败与超时'],
  ['成功请求 TTFB P95 (ms)', n(totals?.successTtfb.p95), 'k6 waiting：发送后到首响应字节，排除建连，不是真实首字时间'],
  ['真实首字 TTFT P50 / P95 / P99 (ms)', meta?.streamMeter ? `${n(totals?.successTtft.p50)} / ${n(totals?.successTtft.p95)} / ${n(totals?.successTtft.p99)}` : '未采集', '本地测量代理发起请求至首个非空正文，含连接；只统计完整成功流。不同于 k6 TTFB'],
  ['首字观测数 / 全部流式请求', `${n(totals?.ttftMeasured)} / ${n(totals?.streamCount)}`, '失败流收到的正文也计入观测数；失败前未收到正文不记为零'],
  ['每请求最大正文事件间隔 P95 (ms)', n(totals?.contentGaps.p95), '内容事件可含多个 token；不是逐 token 延迟，心跳不算正文'],
  ['VU 采样峰值 / 分配上限', `${n(metric('vus').max)} / ${n(metric('vus_max').max)}`, '均不是服务端实际活跃请求数'],
  ['接收 / 发送总字节', `${n(metric('data_received').count)} / ${n(metric('data_sent').count)}`, 'k6 全程网络指标'],
  ['接收 / 发送字节每秒', `${n(metric('data_received').rate)} / ${n(metric('data_sent').rate)}`, '含排空的全程平均'],
]);
const cohortRows = analysis?.cohorts.map((c, i) => [c.id, c.phase, n(c.issued), pct(c.successRate), c.failed, c.cancelled, c.unresolved,
  n(c.successLatency.p50), n(c.successLatency.p95), n(c.successLatency.p99), n(c.successTtft.p95), JSON.stringify(c.errors), verdict(c, analysis.activity[i])]) || [];
const windowRows = analysis?.activity.map(w => [w.id, meta.plan.mode === 'arrival-rate' ? `${w.target} RPS` : `${w.from}→${w.target} VU`, `${w.startMs / 1000}–${w.endMs / 1000}`, n(w.observedSeconds), n(w.issuedRps), n(w.completedRps), n(w.successRps), n(w.successRps * 60), `${n(w.averageInflight)} / ${w.peakInflight}`, `${n(w.inputTokensPerSecond)} / ${n(w.outputTokensPerSecond)}`, w.usageMissing]) || [];
const errors = totals?.errors || Object.fromEntries(Object.entries(summary?.metrics || {}).filter(([k]) => k.startsWith('chat_err_')).map(([k, v]) => [k.slice(9), (v.values ?? v).count]));
const output = `# 压测报告 - ${meta?.plan?.name || '历史汇总'}

**结论状态：待核实，不能仅据本报告宣称性能极限或运营容量达标。**

${analysis?.aggregation ? '大文件模式：逐行解析、磁盘关联；请求计数和窗口吞吐精确，分位数为有界直方图近似上界，误差不超过 0.1% × (1 + 数值)。原始数据保留；历史 HTTP 错误按实际状态码纠正，代理上游传输失败单列。' : ''}

${completenessMarkdown(awsMetrics, meta, clientMetrics, mockStart, mockEnd, analysis, issues)}

## 1. 本轮条件

${table(['项目', '值'], conditions)}

## 2. 全程结果

${overall}

错误分类：${JSON.stringify(errors)}。HTTP 429/5xx 来源需服务端日志定位。

脱敏拒绝原因：${JSON.stringify(analysis?.errorReasons || {})}。unknown 表示上游未提供可识别原因，不等同权限已验证。

${analysis?.errorDetails?.length ? table(['分类', 'k6 错误码', '数量', '首次出现 UTC', '最后出现 UTC'], analysis.errorDetails.map(e => [e.type, e.code ?? '未提供', e.count, e.firstAt ?? '未知', e.lastAt ?? '未知'])) : ''}

错误码和时间用于定位传输故障。错误集中在主动停止时刻可能与中断有关，但通用错误码不能单独证明取消原因；保留原始失败分类，不自动改为成功或取消。

## 3. 分档结果（按发起档位归属）

${analysis ? table(['档位 ID', '阶段', '发起', '成功率', '失败', '取消', '未结束/工具中断', '成功 P50 ms', '成功 P95 ms', '成功 P99 ms', 'TTFT', '错误分布', '数值验收'], cohortRows) : '缺少逐请求事件与执行计划，无法还原分档成功率和延迟；必须重新采集。'}

跨档完成或排空期间结束的请求，最终结果和延迟归回发起档位。warmup 为预热、ramp 为升降压、steady 为固定负载统计阶段；steady 标签不表示已证实系统处于稳态。

## 4. 时间窗口吞吐量与客户端在途数

${analysis ? table(['窗口 ID', '目标', '计划区间 s', '已观察 s', '发起 RPS', '完成 RPS', '成功 RPS', '成功 RPM', '客户端在途均值/峰值', '已知输入/输出 token/s', '完成请求用量缺失数'], windowRows) : '历史全局摘要无法还原逐窗口吞吐量。'}

完成速率按事件实际发生窗口计算，包含前档发起而在本窗口完成的请求；不能用某档最终成功总数除以档位时长冒充窗口完成 RPS。客户端在途数由逻辑调用区间计算；不是 TCP 连接数或服务端活跃数。未结束调用按收集终点截尾。

排空：${analysis ? `${n(analysis.drain.observedSeconds)} 秒，期间完成 ${analysis.drain.completed}，成功 ${analysis.drain.succeeded}` : '未知'}。排空完成事件不倒灌正式窗口。

## 5. 模型与流式分组

${analysis ? table(['发起窗口', '长度桶', '模型', 'stream', '发起', '成功率', '成功 P95 ms', '输入字符 P50/P95', '已知输出 token P50/P95', '结束原因', '错误分布'], analysis.groups.map(g => [g.window, g.bucket ?? '—', g.model, g.stream, g.issued, pct(g.successRate), n(g.successLatency.p95), `${n(g.inputChars.p50)}/${n(g.inputChars.p95)}`, `${n(g.outputTokenDistribution.p50)}/${n(g.outputTokenDistribution.p95)}`, JSON.stringify(g.finishReasons), JSON.stringify(g.errors)])) : '未采集分组明细。'}

## 6. 用量、资源与核对缺项

- 用量类型：${meta?.upstreamMode === 'mock' ? '模拟用量，不是真实模型 token 计数' : '提供方报告用量，需对账'}；已知 ${n(totals?.usageKnown)} 请求，缺失 ${n(totals?.usageMissing)} 请求。缺失不能视为零；窗口 token/s 仅是已知用量小计，按最终用量到达时刻归窗，不是逐 token 生成速率。
- 已知输入/输出 token 总量：${n(totals?.inputTokens)} / ${n(totals?.outputTokens)}。
- new-api、mock、压测机 CPU/内存/网络、服务端活跃请求、数据库与队列曲线：${cell(context.resourceEvidence)}。
- 上游实际调用次数、渠道切换及重试放大：待与请求 ID 对应日志核对。
- 计费与请求数对账证据：${cell(context.billingEvidence)}。
- 首字测量：${meta?.streamMeter ? `${stem}.stream.jsonl；本轮每个请求经 localhost 测量代理，结果按请求 ID 合并。` : `${cell(context.ttftEvidence)}。独立探针结果不代表本轮相同并发下的 TTFT。`}
- 异常、取消、降载恢复验证：${cell(context.recoveryEvidence)}。
- 实际请求 ID、时间、输入字符数、输出上限、结果、用量：${analysis ? `${stem}.requests.jsonl` : '未采集'}。不保存 API Key、提示词或响应正文。

## 7. 本轮结论与适用范围

- 完整成功率 ${pct(successRate)}；失败 ${n(failed)}；未结束或工具中断 ${n(unresolved)}。
- ${analysis ? `计划负载 ${meta.plan.durationMs / 1000} 秒，观察至 ${n(analysis.runEndMs / 1000)} 秒（含排空）。` : '历史摘要仅能说明整轮结果。'}
- 各档数值门槛结果见第 3 节。门槛未设置、样本不足、数据不一致或关键监控缺失时，不自动宣称通过。
- 最高已验证能力、建议运营限额：待结合固定负载复测、资源曲线、恢复和计费核对确认；最高配置 VU 不是性能极限。
- 延迟可能来自中转站、上游、数据库、代理或压测机，现有客户端指标不能直接归因。
- 模拟链路结果不代表真实上游容量；短时测试不证明长期稳定性。
- k6 退出码：${meta?.exitCode ?? '未知'}。阈值失败或提前停止仍保留报告。
- 执行器停止原因：${cell(runner?.reason || '未记录异常停止原因')}。
- 数据核对：${issues.length ? issues.map(cell).join('; ') : analysis ? '事件解析与可用 summary 计数一致；服务端对账仍待完成' : '缺少分档事件，待核实'}。

日志：${logPath}；摘要：${summaryPath || '未提供'}；机器可读分档汇总：${analysis ? `${stem}.analysis.json` : '无'}。

${monitoringMarkdown(awsMetrics, meta || {}, clientMetrics, mockStart, mockEnd)}
`;
fs.writeFileSync(`${stem}.md`, output);
fs.writeFileSync(`${stem}.html`, htmlReport(output, awsMetrics, meta));
console.log(`Report: ${stem}.md`);
console.log(`HTML report: ${stem}.html`);

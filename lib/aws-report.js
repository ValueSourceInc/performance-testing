export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cell = value => String(value ?? '未知').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
const num = value => Number.isFinite(value) ? Number(value.toFixed(3)) : '未知';
const table = (headers, rows) => ['| ' + headers.join(' | ') + ' |', '|' + headers.map(() => '---').join('|') + '|', ...rows.map(row => '| ' + row.map(cell).join(' | ') + ' |')].join('\n');

export function completenessMarkdown(aws, meta, client, before, after, analysis, issues = []) {
  const start = Date.parse(meta?.planStartedAt || meta?.createdAt), end = Date.parse(meta?.finishedAt);
  const groups = ['New API', 'Mock', 'PostgreSQL', 'Redis', 'ALB', 'NAT'];
  const rows = groups.map(group => {
    const metrics = (aws?.series || []).filter(m => m.group === group);
    const observed = metrics.filter(m => metricSummary(m, start, end).count > 0).length;
    return [group, !metrics.length ? '未采集/未发现资源' : `${observed}/${metrics.length} 条指标在测试窗口内有完整分钟数据`];
  });
  const finished = analysis && meta?.plan && analysis.runEndMs >= meta.plan.durationMs && [0, 99].includes(meta.exitCode);
  rows.unshift(['执行计划', finished ? '已跑完计划' : '未跑完或执行状态待核实，不用于容量验收'],
    ['请求对账', issues.length ? issues.join('；') : analysis ? `${analysis.totals.unresolved} 个未结束请求；与可用摘要计数一致` : '缺少请求明细']);
  rows.push(['真实首字 TTFT', analysis?.totals.ttftMeasured > 0 ? `${analysis.totals.ttftMeasured}/${analysis.totals.streamCount} 个流式请求观测到首字` : '未采集/无首字样本'],
    ['本机 CPU / 内存', client?.resources?.length ? `${client.resources.length} 个样本` : '未采集'],
    ['本机网络', client?.network?.some(s => s.interfaces?.length) ? `${client.network.length} 个采样记录` : '未采集'],
    ['mock 前后快照', before && after ? '已采集，版本及进程重启核对见第 8 节' : '缺失，无法补算历史计数差值']);
  return '## 报告完整性\n\n' + table(['检查项', '本轮证据'], rows) + '\n\n' +
    (aws?.errors?.length ? `采集错误：${aws.errors.map(cell).join('；')}。\n\n` : '') +
    '数据缺失不表示资源空闲；短测试可能没有完整分钟。错误类 CloudWatch 指标可能在无错误时不发布，逐项覆盖率见第 8 节。提前停止的未结束请求不等同服务端失败。\n\n';
}

// 关键指标白名单：非关键序列仍采集进 aws.json，但不进报告第 8 节表格和 HTML 图表。
const KEY_METRICS = {
  'New API': ['CPUUtilization Average', 'mem_used_percent Average', 'NetworkIn Sum', 'NetworkOut Sum', 'StatusCheckFailed Maximum'],
  'Mock': ['CPUUtilization Average', 'mem_used_percent Average', 'NetworkIn Sum', 'NetworkOut Sum', 'StatusCheckFailed Maximum'],
  'PostgreSQL': ['CPUUtilization Average', 'DatabaseConnections Maximum', 'ReadIOPS Average', 'WriteIOPS Average', 'ReadLatency Average', 'WriteLatency Average', 'DiskQueueDepth Maximum'],
  'Redis': ['EngineCPUUtilization Maximum', 'DatabaseMemoryUsagePercentage Maximum', 'CurrConnections Maximum', 'Evictions Sum', 'ReplicationLag Maximum'],
  'ALB': ['RequestCount Sum', 'TargetResponseTime Average', 'HTTPCode_ELB_5XX_Count Sum', 'HTTPCode_Target_5XX_Count Sum', 'TargetConnectionErrorCount Sum', 'ActiveConnectionCount Sum'],
  'NAT': ['PacketsDropCount Sum', 'ErrorPortAllocation Sum', 'ActiveConnectionCount Maximum'],
};
export function isKeyMetric(metric) {
  const patterns = KEY_METRICS[metric.group];
  return !patterns || patterns.includes(`${metric.metric} ${metric.statistic}`);
}
// 人类可读数值：字节换算 KiB/MiB、秒换毫秒、大数压成 K/M。
export function formatValue(value, unit) {
  if (!Number.isFinite(value)) return '未知';
  if (unit === 'Bytes' || unit === 'Bytes/Second') {
    const scale = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let v = value, i = 0;
    while (Math.abs(v) >= 1024 && i < scale.length - 1) { v /= 1024; i++; }
    return `${Number(v.toFixed(i === 0 ? 0 : 1))} ${scale[i]}${unit === 'Bytes/Second' ? '/s' : ''}`;
  }
  if (unit === 'Seconds') return `${Number((value * 1000).toFixed(1))} ms`;
  if (unit === 'Percent') return `${Number(value.toFixed(1))}%`;
  if (Math.abs(value) >= 1e6) return `${Number((value / 1e6).toFixed(2))}M`;
  if (Math.abs(value) >= 1e4) return `${Number((value / 1e3).toFixed(1))}K`;
  return Number(value.toFixed(0));
}

export function metricSummary(metric, start, end) {
  const period = metric.period * 1000;
  const values = metric.points.filter(([time, value]) => {
    const at = Date.parse(time);
    return Number.isFinite(value) && at >= start && at + period <= end;
  }).map(([, value]) => value);
  const sum = values.reduce((a, b) => a + b, 0);
  return { count: values.length, average: values.length ? sum / values.length : null,
    min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null,
    sum: values.length ? sum : null, expected: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor(end / period) - Math.ceil(start / period)) : 0 };
}

export function monitoringMarkdown(aws, meta, client, before, after) {
  let text = '## 8. AWS 资源与本地测量\n\n';
  if (!aws) text += 'AWS 指标未采集。使用 `bash run-aws.sh smoke` 接通自动采集。\n\n';
  else {
    const errors = aws.errors || [];
    text += `采集问题：${errors.length ? errors.map(cell).join('；') : '未报告 API 错误；仍需查看数据覆盖率'}。\n\n`;
    text += 'CloudWatch 原始粒度为 60 秒；仅使用完整落在统计窗口内的分钟。缺失不按零处理，短于一分钟的档位可能没有完整数据。下表最小/最大是各分钟统计值的最小/最大；不能据此还原秒级尖峰。\n\n';
    const start = Date.parse(meta.planStartedAt || meta.createdAt), end = Date.parse(meta.finishedAt);
    const series = (aws.series || []).filter(isKeyMetric);
    text += `下表只列关键指标（${series.length}/${aws.series.length} 条序列）；完整指标见 ${meta.runId}.aws.json。\n\n`;
    function rows(first, last) {
      return series.map(metric => {
        const s = metricSummary(metric, first, last);
        return [metric.group, metric.resource, metric.metric, metric.statistic, metric.unit,
          `${s.count}/${s.expected}`, formatValue(s.average, metric.unit), formatValue(s.min, metric.unit), formatValue(s.max, metric.unit),
          metric.statistic === 'Sum' ? formatValue(s.sum, metric.unit) : '不适用',
          metric.status === 'partial' ? '不完整' : !s.count ? '缺失/无完整分钟' : s.count < s.expected ? '缺失部分分钟' : '已采集'];
      });
    }
    const headers = ['组件', '资源', '指标', '分钟统计', '单位', '数据点/完整分钟', '均值', '最小', '最大', 'Sum 累计', '覆盖'];
    text += '### 测试全程（含排空）\n\n' + table(headers, rows(start, end)) + '\n\n';
    // 只给 steady 窗口出表；warmup/ramp 短于一个 CloudWatch 周期，表几乎全空且重复占版面。
    for (const window of meta.plan?.windows || []) {
      if (!window.id.endsWith('_steady')) continue;
      const last = Math.min(start + window.endMs, end);
      text += `### ${cell(window.id)}：${window.target} ${meta.plan.mode === 'arrival-rate' ? 'RPS' : 'VU'}\n\n`;
      text += table(headers, rows(start + window.startMs, last)) + '\n\n';
    }
    text += '### 前后基线\n\n';
    for (const [label, first, last] of [['测试前', Date.parse(aws.start), start], ['测试后恢复', end, Date.parse(aws.end)]]) {
      text += `#### ${label}\n\n` + table(headers, rows(first, last)) + '\n\n';
    }
  }
  text += '### mock 版本与计数对账\n\n';
  if (before && after) {
    const changed = before.release?.sha256 !== after.release?.sha256;
    text += `开始版本：${cell(before.release?.commit)}；结束版本：${cell(after.release?.commit)}；版本${changed ? '发生变化，结果不可直接比较' : '一致'}。\n\n`;
    text += `mock 参数：${cell(JSON.stringify(before.config))}。\n\n`;
    const rows = (after.workers || []).map(worker => {
      const first = before.workers.find(w => w.worker === worker.worker)?.metrics?.totals;
      const last = worker.metrics.totals;
      const oldProcess = before.processes?.find(p => p.worker === worker.worker);
      const newProcess = after.processes?.find(p => p.worker === worker.worker);
      const reset = !first || !oldProcess || !newProcess || oldProcess.pid !== newProcess.pid ||
        oldProcess.startedAt !== newProcess.startedAt || oldProcess.restarts !== newProcess.restarts ||
        last.requests < first.requests || last.output_tokens < first.output_tokens;
      return [worker.worker, reset ? '未知' : last.requests - first.requests, reset ? '未知' : last.errors - first.errors,
        reset ? '未知' : last.output_tokens - first.output_tokens, last.inflight, reset ? '计数重置/数据缺失' : '计数差值'];
    });
    text += table(['worker', '新增成功请求', '新增错误', '新增输出 token', '结束时在途', '口径'], rows) + '\n\n';
    text += 'mock 的 requests 字段仅统计成功请求，错误单独计数；完成总数需合并两者。调用数可能因 New API 重试、其他流量或缓存而不同于客户端请求数，差值不能单独证明原因。检测到 worker 重启时差值标为未知。worker 百分位不求和或平均。\n\n';
  } else text += '缺少开始或结束快照，无法自动对账。\n\n';
  text += '### 本地压测机与测量开销\n\n';
  const samples = client?.resources || [];
  const stats = key => samples.map(s => s[key]).filter(Number.isFinite);
  text += table(['指标', '样本数', '最大值'], [
    ['主机 CPU %', stats('hostCpuPercent').length, num(Math.max(...stats('hostCpuPercent')))],
    ['主机内存使用 %（含操作系统缓存）', stats('hostMemoryUsedPercent').length, num(Math.max(...stats('hostMemoryUsedPercent')))],
    ['测量进程 CPU %（100% 为一核）', stats('meterCpuPercentOneCore').length, num(Math.max(...stats('meterCpuPercentOneCore')))],
    ['测量进程 RSS bytes', stats('meterRssBytes').length, num(Math.max(...stats('meterRssBytes')))],
    ['测量进程每秒事件循环 P99 的最大值 ms', stats('eventLoopP99Ms').length, num(Math.max(...stats('eventLoopP99Ms')))],
  ]) + '\n\n';
  const interfaces = new Map();
  const networkErrors = (client?.network || []).filter(s => s.error);
  if(networkErrors.length)text += `网络采样异常：${networkErrors.length} 条；${cell(networkErrors[0].error)}。缺失时段不能按零流量解释。\n\n`;
  for (const sample of client?.network || []) for (const nic of sample.interfaces || []) {
    if (!interfaces.has(nic.name)) interfaces.set(nic.name, []);
    interfaces.get(nic.name).push(nic);
  }
  text += table(['本地接口', '样本数', '最大接收 bytes/s', '最大发送 bytes/s'], [...interfaces].map(([name, samples]) =>
    [name, samples.length, num(Math.max(...samples.map(n => n.rxBytesPerSecond).filter(n => Number.isFinite(n) && n >= 0))),
      num(Math.max(...samples.map(n => n.txBytesPerSecond).filter(n => Number.isFinite(n) && n >= 0)))])) + '\n\n';
  text += '本地接口每 5 秒采集，含其他应用、VPN 和回环流量，不能把各接口相加。无样本表示未采集，不表示零。k6 字节统计为客户端到本地代理的链路。测量代理增加本地转发和解析开销；CPU 或事件循环延迟过高时，首字时间和吞吐不能直接归因于服务端。\n';
  return text;
}

export function chartSvg(metric) {
  const points = metric.points.filter(([t, v]) => Number.isFinite(Date.parse(t)) && Number.isFinite(v));
  if (!points.length) return '<p class="missing">缺少数据</p>';
  const xs = points.map(([t]) => Date.parse(t)), ys = points.map(([, v]) => v);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const coordinates = points.map(([t, v]) => [40 + (Date.parse(t) - minX) / Math.max(maxX - minX, 1) * 660,
    140 - (v - minY) / Math.max(maxY - minY, 1) * 110]);
  // Break lines across missing buckets; do not imply observations in a gap.
  const segments = [[]];
  coordinates.forEach((p, i) => {
    if (i && xs[i] - xs[i - 1] > metric.period * 1500) segments.push([]);
    segments.at(-1).push(p.join(','));
  });
  return `<svg viewBox="0 0 740 185" role="img" aria-label="${escapeHtml(metric.metric)}">
    <text x="4" y="18">${escapeHtml(formatValue(maxY, metric.unit))}</text><text x="4" y="154">${escapeHtml(formatValue(minY, metric.unit))}</text>
    <path d="M40 25 V150 H710" fill="none" stroke="#ccd5d1"/>
    ${segments.map(segment => `<polyline points="${segment.join(' ')}" fill="none" stroke="#137b75" stroke-width="2"/>`).join('')}
    ${coordinates.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2" fill="#137b75"/>`).join('')}
    <text x="40" y="178">${escapeHtml(new Date(minX).toISOString().slice(11, 19))} UTC</text>
    <text x="570" y="178">${escapeHtml(new Date(maxX).toISOString().slice(11, 19))} UTC</text></svg>`;
}

import MarkdownIt from 'markdown-it';
import { chartSvg, escapeHtml, isKeyMetric } from './aws-report.js';

const figures = list => list.map(metric =>
  `<figure><figcaption>${escapeHtml(metric.metric)} <span>${escapeHtml(metric.statistic)} · ${escapeHtml(metric.unit)}</span></figcaption><p>${escapeHtml(metric.resource)}</p>${chartSvg(metric)}</figure>`).join('');

export function htmlReport(markdown, aws, meta) {
  const parser = new MarkdownIt({ html: false, linkify: false }).disable(['image', 'link']);
  const conditionsAt = markdown.indexOf('\n## 1. 本轮条件');
  const overview = conditionsAt >= 0 ? markdown.slice(0, conditionsAt) : '';
  const details = conditionsAt >= 0 ? markdown.slice(conditionsAt) : markdown;
  const rest = (aws?.series || []).filter(m => !isKeyMetric(m));
  const groupsOf = (series, filter) => [...new Set(series.filter(filter).map(s => s.group))]
    .map(group => `<details open><summary>${escapeHtml(group)}</summary><div class="charts">${figures(series.filter(m => m.group === group && filter(m)))}</div></details>`).join('');
  const charts = groupsOf(aws?.series || [], isKeyMetric) +
    (rest.length ? `<details><summary>其余指标（${rest.length} 条，默认折叠）</summary><div class="charts">${figures(rest)}</div></details>` : '');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;">
<title>New API 压测报告 ${escapeHtml(meta?.runId)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#f7f9f8;color:#202824;font:14px/1.65 system-ui,sans-serif;letter-spacing:0}main{max-width:1440px;margin:auto;padding:24px}h1{font-size:26px}h2{font-size:21px;margin-top:36px;border-top:1px solid #d9e0dc;padding-top:20px}h3{font-size:17px}h4{font-size:15px}p{overflow-wrap:anywhere}table{display:block;overflow:auto;border-collapse:collapse;max-width:100%;background:white;font-size:12px;margin:16px 0}td,th{padding:8px 10px;border:1px solid #dce3df;text-align:left;white-space:normal;min-width:80px}th{background:#e9f0ec}code{background:#edf0f3;padding:2px 4px}pre{overflow:auto;padding:16px;background:#edf0f3}summary{cursor:pointer;font-size:18px;font-weight:600;padding:14px 0;color:#24594c}.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:16px}figure{margin:0;padding:12px;border:1px solid #dde3df;border-radius:4px;background:white;min-width:0}figcaption{font-weight:600;overflow-wrap:anywhere}figcaption span{font-weight:400;color:#59665e;font-size:12px}figure p{font-size:12px;color:#59665e;margin:3px 0}svg{width:100%;height:auto;display:block;font-size:11px;fill:#43564c}.missing{color:#94612b}header{border-bottom:3px solid #137b75}.notice{color:#77521e;background:#fff5df;padding:12px;border-left:3px solid #c38b32}@media(max-width:600px){main{padding:12px}h1{font-size:22px}}@media print{body{background:white}main{max-width:none}table{font-size:9px}figure{break-inside:avoid}}
</style></head><body><main><header><h1>New API 压测报告</h1><p>${escapeHtml(meta?.runId)} · ${escapeHtml(meta?.createdAt)} → ${escapeHtml(meta?.finishedAt)}</p></header>
<p class="notice">容量结论需结合数据覆盖率、固定负载复测和恢复结果。分钟曲线不能证明不存在秒级尖峰。</p>
<section>${parser.render(overview)}</section>
<section><h2>AWS 资源曲线</h2>${charts || '<p>本轮没有 AWS 曲线，见采集错误和缺失说明。</p>'}</section>
<article>${parser.render(details)}</article></main></body></html>`;
}

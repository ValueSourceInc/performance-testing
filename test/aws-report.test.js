import test from 'node:test';
import assert from 'node:assert/strict';
import { metricSummary, monitoringMarkdown, completenessMarkdown, chartSvg } from '../lib/aws-report.js';

test('stage summary excludes buckets overlapping another stage and never makes missing data zero', () => {
  const metric = { period: 60, statistic: 'Average', unit: 'Percent', points: [
    ['2026-09-18T00:00:00Z', 99], ['2026-09-18T00:01:00Z', 20], ['2026-09-18T00:02:00Z', 40], ['2026-09-18T00:03:00Z', 99],
  ] };
  assert.deepEqual(metricSummary(metric, Date.parse('2026-09-18T00:00:30Z'), Date.parse('2026-09-18T00:03:30Z')),
    { count: 2, average: 30, min: 20, max: 40, sum: 60, expected: 2 });
  assert.equal(metricSummary(metric, Date.parse('2026-09-18T00:00:01Z'), Date.parse('2026-09-18T00:00:59Z')).average, null);
});

test('summary can include boundary buckets for short CloudWatch windows', () => {
  const metric = { period: 60, statistic: 'Average', unit: 'Percent', points: [
    ['2026-09-18T00:00:00Z', 10], ['2026-09-18T00:01:00Z', 20],
  ] };
  assert.equal(metricSummary(metric, Date.parse('2026-09-18T00:00:30Z'), Date.parse('2026-09-18T00:01:30Z'), { includePartial: true }).count, 2);
});

test('report exposes AWS errors and missing metrics instead of certifying complete monitoring', () => {
  const text = monitoringMarkdown({ errors: ['Redis access denied'], series: [{ group: 'Redis', resource: 'test', metric: 'CPU',
    statistic: 'Maximum', unit: 'Percent', period: 60, points: [], status: 'missing' }] }, { createdAt: '2026-09-18T00:00:00Z', finishedAt: '2026-09-18T00:03:00Z' });
  assert.match(text, /Redis access denied/);
  assert.match(text, /缺失/);
  assert.match(text, /未知/);
});

test('metric chart escapes resource labels', () => {
  const svg = chartSvg({ metric: '<script>bad</script>', resource: 'x', period: 60, points: [['2026-09-18T00:00:00Z', 1], ['2026-09-18T00:01:00Z', 2]] });
  assert(!svg.includes('<script>'));
  assert(svg.includes('polyline'));
});

test('empty or reversed windows cannot pick up boundary buckets', () => {
  const metric = { period: 60, points: [['2026-09-18T00:00:00Z', 99]] };
  const at = Date.parse('2026-09-18T00:00:30Z');
  for (const end of [at, at - 1]) {
    const s = metricSummary(metric, at, end, { includePartial: true });
    assert.equal(s.count, 0);
    assert.equal(s.expected, 0);
  }
});

test('stage report separates strict statistics from boundary reference values', () => {
  const metric = { group: 'ALB', resource: 'test', metric: 'RequestCount', statistic: 'Sum', unit: 'Count', period: 60,
    points: [['2026-09-18T00:00:00Z', 99], ['2026-09-18T00:01:00Z', 20], ['2026-09-18T00:02:00Z', 40], ['2026-09-18T00:03:00Z', 99]] };
  const text = monitoringMarkdown({ series: [metric] }, {
    planStartedAt: '2026-09-18T00:00:30Z', finishedAt: '2026-09-18T00:03:30Z',
    plan: { mode: 'concurrency', windows: [{ id: 'stress_1_steady', startMs: 0, endMs: 180000, target: 2000 }] },
  });
  const stage = text.split('### stress_1_steady')[1].split('### 前后基线')[0];
  assert.match(stage, /严格档内统计/);
  assert.match(stage, /2\/2 \| 30 \| 20 \| 40 \| 60/);
  assert.match(stage, /边界分钟参考/);
  assert.match(stage, /00:00:00/);
  assert.match(stage, /00:03:00/);
  assert.doesNotMatch(stage, /\| 258 \|/);
});


test('short stages retain unknown strict statistics and disclose boundary-only coverage', () => {
  const metric = { group: 'ALB', resource: 'test', metric: 'RequestCount', statistic: 'Sum', unit: 'Count', period: 60,
    points: [['2026-09-18T00:00:00Z', 99]] };
  const aws = { series: [metric] };
  const meta = { planStartedAt: '2026-09-18T00:00:10Z', finishedAt: '2026-09-18T00:00:40Z',
    plan: { mode: 'concurrency', windows: [{ id: 'mixed_steady', startMs: 0, endMs: 30000, target: 2000 }] } };
  const text = monitoringMarkdown(aws, meta);
  const stage = text.split('### mixed_steady')[1].split('### 前后基线')[0];
  assert.match(stage, /0\/0 \| 未知 \| 未知 \| 未知 \| 未知/);
  assert.match(stage.split('边界分钟参考')[1], /\| 99 \|/);
  assert.match(completenessMarkdown(aws, meta), /0\/1 条指标有严格窗口内完整分钟；1\/1 条有相交分钟/);
});

test('aligned adjacent windows do not share boundary buckets', () => {
  const metric = { period: 60, points: [['2026-09-18T00:00:00Z', 10], ['2026-09-18T00:01:00Z', 20]] };
  const start = Date.parse('2026-09-18T00:00:00Z');
  for (const includePartial of [false, true]) {
    assert.equal(metricSummary(metric, start, start + 60000, { includePartial }).sum, 10);
    assert.equal(metricSummary(metric, start + 60000, start + 120000, { includePartial }).sum, 20);
  }
});

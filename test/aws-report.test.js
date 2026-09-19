import test from 'node:test';
import assert from 'node:assert/strict';
import { metricSummary, monitoringMarkdown, chartSvg } from '../lib/aws-report.js';

test('stage summary excludes buckets overlapping another stage and never makes missing data zero', () => {
  const metric = { period: 60, statistic: 'Average', unit: 'Percent', points: [
    ['2026-09-18T00:00:00Z', 99], ['2026-09-18T00:01:00Z', 20], ['2026-09-18T00:02:00Z', 40], ['2026-09-18T00:03:00Z', 99],
  ] };
  assert.deepEqual(metricSummary(metric, Date.parse('2026-09-18T00:00:30Z'), Date.parse('2026-09-18T00:03:30Z')),
    { count: 2, average: 30, min: 20, max: 40, sum: 60, expected: 2 });
  assert.equal(metricSummary(metric, Date.parse('2026-09-18T00:00:01Z'), Date.parse('2026-09-18T00:00:59Z')).average, null);
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

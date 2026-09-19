import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('huge sparse terminal log cannot prevent summary report generation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huge-log-'));
  try {
    const stem = path.join(dir, 'run');
    fs.writeFileSync(stem + '.log', '=== k6 stress -> http://localhost (test) ===\n');
    fs.truncateSync(stem + '.log', 750 * 1024 * 1024);
    fs.writeFileSync(stem + '.json', '{"metrics":{}}');
    const r = spawnSync(process.execPath, ['lib/report-generator.js', stem + '.log', stem + '.json'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    assert(fs.existsSync(stem + '.html'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy reports never invent stage data or attribute latency to mock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-report-'));
  try {
    const log = path.join(dir, 'old.log'), json = path.join(dir, 'old.json');
    fs.writeFileSync(log, '=== k6 stress -> http://localhost (test) ===\n');
    fs.writeFileSync(json, JSON.stringify({ metrics: { chat_issued: { count: 10 }, chat_completed: { count: 10 }, chat_succeeded: { count: 9 }, chat_errors: { count: 1 }, chat_ok: { value: 0.9 }, chat_latency_ms: { 'p(95)': 55000 } } }));
    const r = spawnSync(process.execPath, ['lib/report-generator.js', log, json], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const report = fs.readFileSync(log.replace('.log', '.md'), 'utf8');
    assert.match(report, /缺少.*分档/);
    assert.doesNotMatch(report, /mock 延迟模型是主要成分/);
    assert.match(report, /待核实/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('AWS failure and missing stream data remain visible in portable HTML report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-report-'));
  try {
    const stem = path.join(dir, 'run');
    fs.writeFileSync(stem + '.log', '=== k6 smoke -> http://localhost (test) ===\n');
    fs.writeFileSync(stem + '.json', JSON.stringify({ metrics: {} }));
    fs.writeFileSync(stem + '.aws.json', JSON.stringify({ errors: ['CloudWatch access denied'], series: [{
      group: 'New API', resource: 'i-example', metric: 'CPUUtilization', statistic: 'Maximum', unit: 'Percent', period: 60,
      status: 'available', points: [['2026-09-18T00:00:00Z', 10], ['2026-09-18T00:01:00Z', 80]] }] }));
    fs.writeFileSync(stem + '.meta.json', JSON.stringify({ runId: 'fixture', createdAt: '2026-09-18T00:00:00Z', finishedAt: '2026-09-18T00:03:00Z',
      client: {}, sample: {}, context: { owner: '<script>alert(1)</script>' } }));
    const result = spawnSync(process.execPath, ['lib/report-generator.js', stem + '.log', stem + '.json'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const html = fs.readFileSync(stem + '.html', 'utf8');
    assert.match(html, /CloudWatch access denied/);
    assert.match(html, /polyline/);
    assert(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /未采集/);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /报告完整性/);
    assert(html.indexOf('报告完整性') < html.indexOf('AWS 资源曲线'), 'show completeness before the charts');
    assert.match(html, /PostgreSQL/);
    assert.match(html, /Redis/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

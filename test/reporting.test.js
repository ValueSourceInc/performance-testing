import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('stress recovery returns to the initial load and keeps its own observed window', async () => {
  const { buildPlan } = await import('../lib/load-plan.js');
  const p = buildPlan('stress', { STRESS_START_VUS: '200', STRESS_MAX_VUS: '1000', STRESS_STEP_DURATION: '3m',
    STRESS_RAMP_DURATION: '30s', WARMUP_DURATION: '15s', STRESS_RECOVERY_DURATION: '3m' });
  assert.equal(p.durationMs, 1230000);
  assert.equal(p.scenario.stages.at(-1).target, 200);
  assert.equal(p.windows.at(-1).id, 'recovered_steady');
  assert.equal(p.windows.at(-1).endMs - p.windows.at(-1).startMs, 165000);
  assert.equal(p.windows.at(-3).from, 1000);
  assert.equal(p.windows.at(-3).target, 200);
  assert.throws(() => buildPlan('stress', { WARMUP_DURATION: '15s', STRESS_RECOVERY_DURATION: '10s' }));
});

test('transport error diagnostics retain codes and time ranges without rewriting failures as cancellations', async () => {
  const { analyze } = await import('../lib/analyze.js');
  const records = [
    { result: 'fail', errorType: 'client_error', errorCode: 1633, endTime: '2026-09-18T12:49:53Z' },
    { result: 'fail', errorType: 'client_error', errorCode: 1000, endTime: '2026-09-18T12:51:39Z' },
    { result: 'fail', errorType: 'client_error', errorCode: 1000, endTime: '2026-09-18T12:51:39.900Z' },
  ];
  const a = analyze(records, { windows: [], durationMs: 1000 }, 1000);
  assert.equal(a.totals.failed, 3);
  assert.equal(a.totals.cancelled, 0);
  assert.deepEqual(a.errorDetails.find(e => e.code === 1000), { type: 'client_error', code: 1000,
    count: 2, firstAt: '2026-09-18T12:51:39.000Z', lastAt: '2026-09-18T12:51:39.900Z' });
});

test('stress has real holds, separate ramp windows and warmup', async () => {
  const { buildPlan } = await import('../lib/load-plan.js');
  const p = buildPlan('stress', { STRESS_START_VUS: '200', STRESS_MAX_VUS: '1000', STRESS_STEP_DURATION: '3m', STRESS_RAMP_DURATION: '10s', WARMUP_DURATION: '15s' });
  assert.equal(p.durationMs, 940000);
  assert.equal(p.windows[0].phase, 'warmup');
  assert.equal(p.windows[1].endMs, 180000);
  assert.equal(p.windows[2].phase, 'ramp');
  assert.equal(p.scenario.stages[0].target, 200);
  assert.equal(p.scenario.stages[1].duration, '10000ms');
  assert.equal(p.scenario.stages.at(-1).target, 1000);
  assert.throws(() => buildPlan('stress', { STRESS_MAX_VUS: '1.5' }));
  assert.throws(() => buildPlan('soak', { SOAK_DURATION: '10s', WARMUP_DURATION: '15s' }));
});

test('cohorts retain tails but window rates use actual event time', async () => {
  const { analyze } = await import('../lib/analyze.js');
  const windows = [
    { id: 'a', stage: 's1', phase: 'steady', startMs: 0, endMs: 1000, target: 1 },
    { id: 'b', stage: 's2', phase: 'steady', startMs: 1000, endMs: 2000, target: 2 },
  ];
  const records = [
    { id: '1', window: 'a', startMs: 100, endMs: 1200, result: 'ok', model: 'm', stream: true, totalMs: 1100, usage: { input: 5, output: 10 } },
    { id: '2', window: 'b', startMs: 1100, endMs: 2100, result: 'fail', errorType: 'client_timeout', model: 'm', stream: false, totalMs: 1000, usage: null },
    { id: '3', window: 'b', startMs: 1200, endMs: null, result: 'unresolved', model: 'm', stream: false, usage: null },
  ];
  const a = analyze(records, { windows, durationMs: 2000 }, 2200);
  assert.equal(a.cohorts[0].succeeded, 1);
  assert.equal(a.cohorts[0].successLatency.p95, 1100);
  assert.equal(a.cohorts[1].successLatency.p95, null);
  assert.equal(a.activity[0].successRps, 0);
  assert.equal(a.activity[1].successRps, 1);
  assert.equal(a.activity[1].issuedRps, 2);
  assert.equal(a.activity[1].peakInflight, 2);
  assert.equal(a.drain.completed, 1);
  assert.equal(a.totals.issued, 3);
  assert.equal(a.totals.unresolved, 1);
  assert.equal(a.totals.usageMissing, 2);
});

test('response usage reads structured SSE usage without mistaking content', async () => {
  const { responseUsage, responseDetails } = await import('../lib/usage.js');
  assert.deepEqual(responseUsage('data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":12}}\n\ndata: [DONE]\n\n', true), { input: 8, output: 12 });
  assert.equal(responseUsage('{"choices":[]}', false), null);
  assert.equal(responseUsage('{"usage":{"prompt_tokens":-1,"completion_tokens":3}}', false), null);
  assert.equal(responseDetails('{"choices":[{"finish_reason":"length"}]}', false).finishReason, 'length');
});

test('missing ends remain unresolved and truncated event files flag integrity errors', async () => {
  const { readRecords } = await import('../lib/analyze.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-events-'));
  try {
    const events = path.join(dir, 'events.jsonl');
    fs.writeFileSync(events, JSON.stringify({ level: 'info', msg: JSON.stringify({ schema: 1, kind: 'start', id: 'request-1', startMs: 12, window: 'a' }) }) + '\n{"broken":');
    const output = path.join(dir, 'requests.jsonl');
    const { records, issues } = await readRecords(events, output);
    assert.equal(records.length, 1);
    assert.equal(records[0].result, 'unresolved');
    assert.equal(records[0].usage, null);
    assert.equal(issues.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(output)).id, 'request-1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

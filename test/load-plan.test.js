import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, scenarioOptions } from '../lib/load-plan.js';

test('mixed runs fixed concurrency, independent of obsolete arrival-rate pool settings', () => {
  const p = buildPlan('mixed', { MIXED_RPS: '3', MIXED_PREALLOCATED_VUS: '2000', MIXED_MAX_VUS: '2000' });
  assert.equal(p.scenario.executor, 'constant-vus');
  assert.equal(p.scenario.vus, 2000);
  assert.equal(p.mode, 'concurrency');
  assert.equal(p.windows[0].target, 2000);
  assert.equal(scenarioOptions('mixed', {}).thresholds.dropped_iterations, undefined);
});

test('stress starts at 2000 and holds each level through 6000', () => {
  const p = buildPlan('stress', { STRESS_RECOVERY_DURATION: '2m' });
  assert.equal(p.scenario.startVUs, 2000);
  assert.deepEqual(p.windows.filter(w => w.phase === 'steady').map(w => w.target), [2000, 3000, 4000, 5000, 6000, 2000]);
  assert.throws(() => buildPlan('stress', { STRESS_START_VUS: '6001' }));
});

test('longstream runs fixed 2000 VUs without inheriting soak settings', () => {
  const p = buildPlan('longstream', { SOAK_VUS: '50' });
  assert.equal(p.scenario.executor, 'constant-vus');
  assert.equal(p.scenario.vus, 2000);
  assert.equal(p.windows[0].target, 2000);
});

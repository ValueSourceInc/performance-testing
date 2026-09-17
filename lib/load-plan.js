// Shared by k6 and Node so execution and reporting use identical windows.
export function durationMs(value) {
  const text = String(value);
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
  if (!parts.length || parts.map(p => p[0]).join('') !== text) throw new Error(`Invalid duration: ${text}`);
  const ms = parts.reduce((n, p) => n + Number(p[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 })[p[2]], 0);
  if (!Number.isFinite(ms) || ms < 0) throw new Error('Invalid duration');
  return ms;
}

function positive(value, fallback) {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Expected positive integer: ${value}`);
  return n;
}

export function buildPlan(name, env = {}) {
  const windows = [], stages = [];
  let at = 0;
  const timeout = env.REQ_TIMEOUT_MS || '120s';
  if (durationMs(timeout) <= 0) throw new Error('Request timeout must be positive');
  const warmup = durationMs(env.WARMUP_DURATION || '0s');
  function window(stage, phase, ms, from, target) {
    if (!ms) return;
    windows.push({ id: `${stage}_${phase}`, stage, phase, startMs: at, endMs: at + ms, from, target });
    at += ms;
  }
  function hold(stage, target, duration) {
    const ms = durationMs(duration);
    if (ms <= warmup) throw new Error('Hold duration must exceed WARMUP_DURATION');
    stages.push({ duration: `${ms}ms`, target });
    window(stage, 'warmup', warmup, target, target);
    window(stage, 'steady', ms - warmup, target, target);
  }
  function ramp(stage, from, target, duration) {
    const ms = durationMs(duration);
    if (!ms) return;
    stages.push({ duration: `${ms}ms`, target });
    window(stage, 'ramp', ms, from, target);
  }
  let scenario;
  if (name === 'stress') {
    const peak = positive(env.STRESS_MAX_VUS ?? env.STRESS_PEAK_VUS, 200);
    const targets = [...new Set(Array.from({ length: 5 }, (_, i) => Math.max(1, Math.round(peak * (i + 1) / 5))))];
    targets.forEach((target, i) => {
      const stage = `stress_${i + 1}`;
      if (i) ramp(stage, targets[i - 1], target, env.STRESS_RAMP_DURATION || '10s');
      hold(stage, target, env.STRESS_STEP_DURATION || '30s');
    });
    scenario = { executor: 'ramping-vus', startVUs: targets[0], stages, gracefulRampDown: timeout };
  } else if (name === 'spike') {
    const base = positive(env.SPIKE_BASE_VUS, 10), peak = positive(env.SPIKE_MAX_VUS ?? env.SPIKE_VUS, 200);
    hold('baseline', base, '1m');
    ramp('surge', base, peak, '10s');
    hold('peak', peak, '1m');
    ramp('recovery', peak, base, '30s');
    hold('recovered', base, '1m');
    scenario = { executor: 'ramping-vus', startVUs: base, stages, gracefulRampDown: timeout };
  } else if (name === 'mixed') {
    const rate = positive(env.MIXED_RPS, 20);
    const duration = env.MIXED_DURATION || '3m';
    hold('mixed', rate, duration);
    scenario = { executor: 'constant-arrival-rate', rate, timeUnit: '1s', duration,
      preAllocatedVUs: positive(env.MIXED_PREALLOCATED_VUS, Math.max(50, rate * 10)),
      maxVUs: positive(env.MIXED_MAX_VUS, Math.max(100, rate * 20)) };
    if (scenario.maxVUs < scenario.preAllocatedVUs) throw new Error('MIXED_MAX_VUS must cover preallocated VUs');
  } else if (name === 'smoke' || name === 'soak') {
    const vus = name === 'smoke' ? 1 : positive(env.SOAK_VUS, 20);
    const duration = name === 'smoke' ? env.SMOKE_DURATION || '30s' : env.SOAK_DURATION || '2m';
    hold(name, vus, duration);
    scenario = { executor: 'constant-vus', vus, duration };
  } else throw new Error(`Unknown scenario: ${name}`);
  scenario.gracefulStop = timeout;
  return { name, mode: name === 'mixed' ? 'arrival-rate' : 'concurrency', durationMs: at, windows, scenario };
}

export function windowAt(plan, ms) {
  return plan.windows.find(w => ms >= w.startMs && ms < w.endMs) || null;
}

export function scenarioOptions(name, env) {
  const thresholds = {};
  if (env.MIN_SUCCESS_RATE) {
    const rate = Number(env.MIN_SUCCESS_RATE);
    if (!(rate > 0 && rate <= 1)) throw new Error('MIN_SUCCESS_RATE must be in (0,1]');
    thresholds.chat_ok = [`rate>=${rate}`];
  }
  if (name === 'mixed') thresholds.dropped_iterations = ['count==0'];
  return { scenarios: { [name]: buildPlan(name, env).scenario }, thresholds,
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(95)', 'p(99)'] };
}

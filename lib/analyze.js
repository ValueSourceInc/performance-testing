import fs from 'node:fs';
import readline from 'node:readline';

export function percentiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = p => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

function summarize(records) {
  const ok = records.filter(r => r.result === 'ok');
  const failed = records.filter(r => r.result === 'fail');
  const cancelled = records.filter(r => r.result === 'cancelled');
  const errors = {}, finishReasons = {};
  for (const r of failed) errors[r.errorType || 'unknown'] = (errors[r.errorType || 'unknown'] || 0) + 1;
  for (const r of records) finishReasons[r.finishReason || 'unknown'] = (finishReasons[r.finishReason || 'unknown'] || 0) + 1;
  return { issued: records.length, succeeded: ok.length, failed: failed.length,
    cancelled: cancelled.length, unresolved: records.length - ok.length - failed.length - cancelled.length,
    successRate: records.length ? ok.length / records.length : null,
    successLatency: percentiles(ok.map(r => r.totalMs)), allLatency: percentiles(records.map(r => r.totalMs)),
    successTtfb: percentiles(ok.map(r => r.ttfbMs)), errors, finishReasons,
    inputChars: percentiles(records.map(r => r.inputChars)), outputTokenDistribution: percentiles(records.map(r => r.usage?.output)),
    usageKnown: records.filter(r => r.usage != null).length,
    usageMissing: records.filter(r => r.usage == null).length,
    inputTokens: records.reduce((n, r) => n + (r.usage?.input || 0), 0),
    outputTokens: records.reduce((n, r) => n + (r.usage?.output || 0), 0) };
}

function activity(records, window, runEndMs) {
  const endMs = Math.min(window.endMs, runEndMs);
  const seconds = Math.max(0, endMs - window.startMs) / 1000;
  const inside = t => Number.isFinite(t) && t >= window.startMs && t < endMs;
  const starts = records.filter(r => inside(r.startMs));
  const ends = records.filter(r => inside(r.endMs));
  const events = [];
  for (const r of records) {
    const start = Math.max(window.startMs, r.startMs);
    const end = Math.min(endMs, r.endMs ?? runEndMs);
    if (start < end) events.push([start, 1], [end, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0, peak = 0, area = 0, previous = window.startMs;
  for (const [time, delta] of events) {
    area += active * (time - previous);
    active += delta;
    peak = Math.max(peak, active);
    previous = time;
  }
  return { ...window, observedSeconds: seconds, issued: starts.length, completed: ends.length,
    succeeded: ends.filter(r => r.result === 'ok').length,
    issuedRps: seconds ? starts.length / seconds : null,
    completedRps: seconds ? ends.length / seconds : null,
    successRps: seconds ? ends.filter(r => r.result === 'ok').length / seconds : null,
    averageInflight: seconds ? area / (seconds * 1000) : null, peakInflight: peak,
    inputTokensPerSecond: seconds ? ends.reduce((n, r) => n + (r.usage?.input || 0), 0) / seconds : null,
    outputTokensPerSecond: seconds ? ends.reduce((n, r) => n + (r.usage?.output || 0), 0) / seconds : null,
    usageMissing: ends.filter(r => r.usage == null).length };
}

export function analyze(records, plan, runEndMs) {
  const groups = new Map();
  for (const r of records) {
    const key = JSON.stringify([r.window, r.model, r.stream]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return { totals: summarize(records),
    cohorts: plan.windows.map(w => ({ ...w, ...summarize(records.filter(r => r.window === w.id)) })),
    activity: plan.windows.map(w => activity(records, w, runEndMs)),
    drain: activity(records, { id: 'drain', startMs: plan.durationMs, endMs: Math.max(plan.durationMs, runEndMs) + 0.001 }, runEndMs + 0.001),
    groups: [...groups.values()].map(rs => ({ window: rs[0].window, model: rs[0].model, stream: rs[0].stream, ...summarize(rs) })),
    runEndMs, plannedDurationMs: plan.durationMs };
}

export async function readRecords(eventPath, requestPath) {
  const starts = new Map(), ends = new Map(), records = [], issues = [];
  let invalid = 0;
  for await (const line of readline.createInterface({ input: fs.createReadStream(eventPath), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    try {
      const outer = JSON.parse(line);
      const event = outer.msg ? JSON.parse(outer.msg) : outer;
      if (event.schema !== 1 || !['start', 'end'].includes(event.kind) || typeof event.id !== 'string') { invalid++; continue; }
      const map = event.kind === 'start' ? starts : ends;
      if (map.has(event.id)) issues.push(`duplicate ${event.kind}: ${event.id}`);
      map.set(event.id, event);
    } catch { invalid++; }
  }
  if (invalid) issues.push(`${invalid} malformed or unrecognized event lines`);
  const fd = fs.openSync(requestPath, 'w', 0o600);
  try {
    for (const [id, start] of starts) {
      const end = ends.get(id);
      const r = { ...start, ...end, id, result: end?.result || 'unresolved', endMs: end?.endMs ?? null, usage: end?.usage ?? null };
      delete r.kind;
      if (!Number.isFinite(r.startMs) || (end && (!Number.isFinite(r.endMs) || r.endMs < r.startMs))) {
        issues.push(`invalid timestamps: ${id}`); continue;
      }
      records.push(r);
      fs.writeSync(fd, JSON.stringify(r) + '\n');
      ends.delete(id);
    }
  } finally { fs.closeSync(fd); }
  if (ends.size) issues.push(`${ends.size} end events without start`);
  return { records, issues };
}

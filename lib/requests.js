// shared request executor: one round-trip per VU iteration
// measures: total latency, TTFB (headers only — k6 buffers the body, NOT true TTFT),
// status, protocol-complete success (end marker + no error event)
// true first-content TTFT for streams: use tools/sse_probe.py (k6 core HTTP cannot read SSE incrementally)
import http from 'k6/http';
import { Trend, Counter, Rate } from 'k6/metrics';
import { pickKey } from './config.js';

const latencyTrend = new Trend('chat_latency_ms', true);
const ttfbTrend = new Trend('chat_ttfb_ms', true);
const okRate = new Rate('chat_ok');
const errorCounter = new Counter('chat_errors');
const statusCounter = new Counter('chat_status');

export const REQ_TIMEOUT = __ENV.REQ_TIMEOUT_MS || '120s';

import { classify } from './protocol.js';
const issued = new Counter('chat_issued');
const completed = new Counter('chat_completed');
const succeeded = new Counter('chat_succeeded');

export function execChat(body, tags = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${pickKey()}`,
  };
  const url = `${__ENV.BASE_URL || 'http://localhost:8787'}/v1/chat/completions`;

  issued.add(1);
  const started = Date.now();
  const res = http.post(url, JSON.stringify(body), {
    headers,
    timeout: REQ_TIMEOUT,
    redirects: 0,
    tags: { name: 'chat', model: body.model, stream: String(!!body.stream), ...tags },
  });
  const total = Date.now() - started;

  const metricTags = { model: body.model, stream: String(!!body.stream), ...tags };
  statusCounter.add(1, { status: String(res.status), ...metricTags });
  const errorType = classify(res, !!body.stream);
  const ok = errorType === null;
  completed.add(1, metricTags);
  succeeded.add(ok ? 1 : 0, metricTags);
  okRate.add(ok, metricTags);
  if (!ok) errorCounter.add(1, { type: errorType, ...metricTags });

  latencyTrend.add(total, metricTags);
  const ttfb = res.timings?.waiting;
  if (Number.isFinite(ttfb)) ttfbTrend.add(ttfb, metricTags); // headers-only, see header comment
  return { ok, errorType, status: res.status, total };
}

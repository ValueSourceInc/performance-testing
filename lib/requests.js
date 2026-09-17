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

// classify a completed response into an error bucket, or null if complete success
// NOTE: 429/5xx cannot be attributed to 本站 vs 上游 by status alone; if the body
// carries the upstream provider's error shape, prefer tagging that at report time.
function classify(res, isStream) {
  if (res.status === 0) {
    if ((res.error || '').includes('timeout')) return 'client_timeout';
    return 'client_error';
  }
  if (res.status === 429) return 'http_429';
  if (res.status >= 500) return `http_${res.status}`;
  if (res.status !== 200) return `http_${res.status}`;

  const body = res.body || '';
  if (isStream) {
    if (/"error"\s*:/.test(body)) return 'error_event';
    if (!body.includes('[DONE]') && !body.includes('message_stop')) return 'no_end_marker';
    if (!/"content"\s*:\s*"[^"]/.test(body) && !/"text_delta"/.test(body)) return 'empty_body';
    return null; // protocol-complete
  }
  // non-stream
  if (/"error"\s*:/.test(body)) return 'error_event';
  if (!/"choices"/.test(body) && !/"content"\s*:/.test(body)) return 'malformed_body';
  return null;
}

export function execChat(body, tags = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${pickKey()}`,
  };
  const url = `${__ENV.BASE_URL || 'http://localhost:8787'}/v1/chat/completions`;

  const started = Date.now();
  const res = http.post(url, JSON.stringify(body), {
    headers,
    timeout: REQ_TIMEOUT,
    tags: { name: 'chat', model: body.model, stream: String(!!body.stream), ...tags },
  });
  const total = Date.now() - started;

  const metricTags = { model: body.model, stream: String(!!body.stream), ...tags };
  statusCounter.add(1, { status: String(res.status), ...metricTags });
  const errorType = classify(res, !!body.stream);
  const ok = errorType === null;
  okRate.add(ok);
  if (!ok) errorCounter.add(1, { type: errorType, ...metricTags });

  latencyTrend.add(total, metricTags);
  const ttfb = res.timings?.waiting;
  if (Number.isFinite(ttfb)) ttfbTrend.add(ttfb, metricTags); // headers-only, see header comment
  return { ok, errorType, status: res.status, total };
}

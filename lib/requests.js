// shared request executor: one round-trip per VU iteration
// measures: total latency, TTFT (stream first data byte), status, tokens
import http from 'k6/http';
import { Trend, Counter, Rate } from 'k6/metrics';

const latencyTrend = new Trend('chat_latency_ms', true);
const ttftTrend = new Trend('chat_ttft_ms', true);
const okRate = new Rate('chat_ok');
const statusCounter = new Counter('chat_status');

export function execChat(body, tags = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${__ENV.API_KEY || 'sk-mock'}`,
  };
  const url = `${__ENV.BASE_URL || 'http://localhost:8787'}/v1/chat/completions`;

  const started = Date.now();
  const res = http.post(url, JSON.stringify(body), {
    headers,
    tags: { name: 'chat', model: body.model, stream: String(!!body.stream), ...tags },
  });
  const total = Date.now() - started;

  const metricTags = { model: body.model, stream: String(!!body.stream), ...tags };
  statusCounter.add(1, { status: String(res.status), ...metricTags });
  const ok = res.status === 200;
  okRate.add(ok);

  if (ok) {
    latencyTrend.add(total, metricTags);
    if (body.stream) {
      // TTFT ≈ total minus tail gap; k6's streaming response arrives whole after
      // httpx buffering, so approximate with total of first-body read via duration
      // metric from k6 internals: use res.timings.waiting (TTFB from k6 itself)
      const ttfb = res.timings.waiting;
      if (Number.isFinite(ttfb)) ttftTrend.add(ttfb, metricTags);
    }
  }
  return { ok, status: res.status, total };
}

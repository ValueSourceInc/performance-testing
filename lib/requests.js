// shared request executor: one round-trip per VU iteration
// measures: total latency, TTFB (headers only — k6 buffers the body, NOT true TTFT),
// status, protocol-complete success (lib/protocol.js classify)
// true first-content TTFT for streams: use tools/sse_probe.py (k6 core HTTP cannot read SSE incrementally)
import http from 'k6/http';
import { Trend, Counter, Rate } from 'k6/metrics';
import { pickKey } from './config.js';
import { classify } from './protocol.js';
import exec from 'k6/execution';
import { buildPlan, windowAt } from './load-plan.js';
import { responseDetails } from './usage.js';
import { errorReason } from './error-reason.js';
import { sleep } from 'k6';

const latencyTrend = new Trend('chat_latency_ms', true);
const successLatency = new Trend('chat_success_latency_ms', true);
const ttfbTrend = new Trend('chat_ttfb_ms', true);
const okRate = new Rate('chat_ok');
const statusCounter = new Counter('chat_status');
// 指南 §5 对账公式: 发起 = 成功 + 失败 + 取消 + 未结束
const issued = new Counter('chat_issued');
const completed = new Counter('chat_completed');
const succeeded = new Counter('chat_succeeded');

// error buckets are a FIXED set so each survives k6 --summary-export (which drops
// tag breakdowns); protocol.classify output normalized into these via bucketize()
export const ERROR_KINDS = [
  'client_timeout',     // 压测客户端请求总时限超时(REQ_TIMEOUT_MS)
  'client_error',       // 压测客户端连接/传输错误(不代表到达了服务端)
  'http_429',           // 429(本站限流或上游转发,状态码分不出,对照中转站日志)
  'http_4xx',           // 其他 4xx
  'http_5xx',           // 5xx
  'content_type',       // 200 但 Content-Type 不符协议
  'error_event',        // HTTP 200 后协议错误事件
  'incomplete_stream',  // 200 但流未完整(缺 [DONE]/finish/正文)
  'malformed_body',     // 响应体不符协议
  'data_after_end',     // 结束标记后还有数据
  'unexpected_finish',  // 非预期 finish_reason
];
const errCounters = Object.fromEntries(ERROR_KINDS.map(k => [k, new Counter('chat_err_' + k)]));
const errorCounter = new Counter('chat_errors');

export const REQ_TIMEOUT = __ENV.REQ_TIMEOUT_MS || '120s';
const plans = {};
const record = event => console.log(JSON.stringify({ schema: 1, ...event }));

// normalize protocol.classify output (e.g. 'http_503') into the fixed bucket set
function bucketize(kind) {
  if (ERROR_KINDS.includes(kind)) return kind;
  const m = kind.match(/^http_(\d+)$/);
  if (!m) return 'malformed_body';
  if (m[1] === '429') return 'http_429';
  if (m[1].startsWith('5')) return 'http_5xx';
  return 'http_4xx';
}

export function execChat(body, tags = {}) {
  const name = exec.scenario.name;
  const plan = plans[name] || (plans[name] = buildPlan(name, __ENV));
  const id = `${__ENV.RUN_ID || 'manual'}-${name}-${exec.vu.idInTest}-${exec.vu.iterationInScenario}`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${pickKey()}`,
    'X-Request-ID': id,
  };
  const url = `${__ENV.BASE_URL || 'http://localhost:8787'}/v1/chat/completions`;

  const started = exec.instance.currentTestRunDuration;
  const window = windowAt(plan, started);
  const metricTags = { model: body.model, stream: String(!!body.stream), ...tags,
    window: window?.id || 'outside_plan', phase: window?.phase || 'unknown' };
  issued.add(1, metricTags);
  // 请求体字节数: 真实样本/长短 prompt 的流量与解析开销对账依据
  // k6 无 Buffer,手算 UTF-8 字节长度
  const utf8Bytes = s => { let n = 0; for (let i = 0; i < s.length; i++) { const c = s.codePointAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : (i++, 4); } return n; };
  const bodyBytes = utf8Bytes(JSON.stringify(body));
  record({ kind: 'start', id, window: metricTags.window, model: body.model, stream: !!body.stream,
    startMs: started, startTime: new Date().toISOString(), inputChars: body.messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0),
    bodyBytes, outputLimit: body.max_tokens ?? null, mockOutputLimit: body.mock_max_tokens ?? null, clientRetries: 0 });
  const res = http.post(url, JSON.stringify(body), {
    headers,
    timeout: REQ_TIMEOUT,
    redirects: 0, // 中转站入口不应重定向;跟随重定向会把 3xx 记成成功
    tags: { name: 'chat', ...metricTags },
  });
  const ended = exec.instance.currentTestRunDuration;
  const total = ended - started;

  statusCounter.add(1, { status: String(res.status), ...metricTags });
  const raw = classify(res, !!body.stream);
  const errorType = raw === null ? null : bucketize(raw);
  const ok = errorType === null;
  completed.add(1, metricTags);
  succeeded.add(ok ? 1 : 0, metricTags);
  okRate.add(ok, metricTags);
  if (!ok) {
    errorCounter.add(1);
    errCounters[errorType].add(1);
  }

  latencyTrend.add(total, metricTags);
  if (ok) successLatency.add(total, metricTags);
  const ttfb = res.timings?.waiting;
  if (res.status > 0 && Number.isFinite(ttfb)) ttfbTrend.add(ttfb, metricTags);
  record({ kind: 'end', id, endMs: ended, totalMs: total, endTime: new Date().toISOString(),
    result: ok ? 'ok' : 'fail', errorType, protocolError: raw, status: res.status, errorCode: res.error_code || null,
    errorReason: res.status >= 400 ? errorReason(res.body) : null,
    ttfbMs: res.status > 0 && Number.isFinite(ttfb) ? ttfb : null, ttftMs: null,
    ...responseDetails(res.body, !!body.stream) });
  if(res.status===401 || res.status===403) exec.test.abort(`HTTP ${res.status}: ${errorReason(res.body)}; fix test authorization/quota before retrying`);
  // Fast failures must not turn fixed concurrency into an unbounded retry storm.
  if(!ok) sleep(1);
  return { ok, errorType, status: res.status, total };
}

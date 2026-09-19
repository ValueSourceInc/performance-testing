import { createParser } from 'eventsource-parser';
import { classify } from './protocol.js';
import { responseDetails } from './usage.js';
import { errorReason } from './error-reason.js';

// Reads `"stream": true|false` straight out of an encoded body without
// decoding the whole payload into a heap string (longstream bodies are ~8 MiB).
export function detectStream(body) {
  const byte = i => typeof body === 'string' ? body.charCodeAt(i) : body[i];
  for (let i = body.indexOf('"stream"'); i !== -1; i = body.indexOf('"stream"', i + 8)) {
    let j = i + 8;
    while (j < body.length && /\s/.test(String.fromCharCode(byte(j)))) j++;
    if (byte(j) !== 0x3a /* : */) continue;
    while (++j < body.length && /\s/.test(String.fromCharCode(byte(j))));
    if (startsWithWord(body, j, 'true')) return true;
    if (startsWithWord(body, j, 'false')) return false;
  }
  return false;
}
function startsWithWord(body, start, word) {
  for (let k = 0; k < word.length; k++) {
    const c = typeof body === 'string' ? body.charCodeAt(start + k) : body[start + k];
    if (c !== word.charCodeAt(k)) return false;
  }
  return true;
}

// Timings include connection establishment. Content event gaps are not token gaps.
// `body` may be a plain object (serialized once here) or an already-encoded
// string/Uint8Array/Buffer forwarded byte-for-byte, so the meter never holds a
// large decoded copy in the JS heap.
export async function requestChat(base, key, body, id, timeoutMs, signal, observer = {}) {
  const rawBody = body != null && typeof body === 'object' && !(body instanceof Uint8Array);
  const payload = rawBody ? JSON.stringify(body) : body;
  const stream = rawBody ? !!body.stream : detectStream(body);
  const started = performance.now(), controller = new AbortController();
  let timedOut = false, bytes = 0, lastContent = null, done = false, content = false;
  const result = { result: 'fail', status: 0, errorType: null, ttftMs: null, ttfbMs: null,
    contentEvents: 0, maxContentGapMs: null, finishReason: null, usage: null, receivedBytes: 0 };
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const fail = type => { result.errorType ||= type; };
  function event({ data, event: type }) {
    if (type === 'error') { fail('error_event'); return; }
    if (!data) return;
    if (done) { fail('data_after_end'); return; }
    if (data === '[DONE]') { done = true; return; }
    try {
      const obj = JSON.parse(data);
      if (obj.error) { fail('error_event'); return; }
      if (!Array.isArray(obj.choices)) { fail('malformed_body'); return; }
      for (const choice of obj.choices) {
        if (typeof choice.delta?.content === 'string' && choice.delta.content.length) {
          const now = performance.now() - started;
          if (!content) result.ttftMs = now;
          else result.maxContentGapMs = Math.max(result.maxContentGapMs ?? 0, now - lastContent);
          lastContent = now;
          content = true;
          result.contentEvents++;
        }
        if (choice.finish_reason != null) {
          result.finishReason = choice.finish_reason;
          if (!['stop', 'length'].includes(choice.finish_reason)) fail('unexpected_finish');
        }
      }
      const usage = obj.usage;
      if (Number.isInteger(usage?.prompt_tokens) && usage.prompt_tokens >= 0 &&
          Number.isInteger(usage?.completion_tokens) && usage.completion_tokens >= 0) {
        result.usage = { input: usage.prompt_tokens, output: usage.completion_tokens };
      }
    } catch { fail('malformed_body'); }
  }
  try {
    const response = await fetch(base.replace(/\/$/, '') + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'X-Request-ID': id },
      body: payload, redirect: 'manual', signal: controller.signal,
    });
    result.status = response.status;
    result.ttfbMs = performance.now() - started;
    observer.onHeaders?.(response.status, response.headers.get('content-type'));
    if (response.status !== 200) {
      fail(response.status === 429 ? 'http_429' : response.status >= 500 ? 'http_5xx' : 'http_4xx');
      let raw='', size=0;
      const errorDecoder=new TextDecoder();
      if(response.body) for await(const chunk of response.body){
        size+=chunk.byteLength;
        if(size>16384)break;
        raw+=errorDecoder.decode(chunk,{stream:true});
      }
      raw+=errorDecoder.decode();
      result.errorReason=errorReason(raw);
      await observer.onChunk?.(new TextEncoder().encode(JSON.stringify({error:{code:result.errorReason}})));
    } else if (!(response.headers.get('content-type') || '').includes(stream ? 'text/event-stream' : 'application/json')) {
      fail('content_type');
      await response.body?.cancel();
    } else {
      const parser = createParser({ onEvent: event });
      const decoder = new TextDecoder();
      let raw = '';
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 64 * 1024 * 1024) { fail('response_too_large'); controller.abort(); break; }
        const text = decoder.decode(chunk, { stream: true });
        if (stream) parser.feed(text);
        else raw += text;
        await observer.onChunk?.(chunk);
      }
      if (stream) {
        parser.feed(decoder.decode());
        if (!done || !content || !result.finishReason) fail('incomplete_stream');
      } else {
        raw += decoder.decode();
        const error = classify({ status: 200, headers: { 'content-type': 'application/json' }, body: raw }, false);
        if (error) fail(error);
        Object.assign(result, responseDetails(raw, false));
      }
    }
  } catch {
    fail(timedOut ? 'client_timeout' : signal?.aborted ? 'client_cancel' : 'client_error');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
  result.totalMs = performance.now() - started;
  result.receivedBytes = bytes;
  result.completionGapMs = lastContent == null ? null : result.totalMs - lastContent;
  result.result = result.errorType === 'client_cancel' ? 'cancelled' : result.errorType ? 'fail' : 'ok';
  return result;
}

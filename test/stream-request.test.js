import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { requestChat } from '../lib/stream-request.js';
import { errorReason } from '../lib/error-reason.js';

test('production precharge failure maps to wallet quota without saving balance text', () => {
  assert.equal(errorReason(JSON.stringify({error:{message:'预扣费额度失败, 用户剩余额度: ＄0.001950, 需要预扣费额度: ＄0.008212'}})), 'insufficient_user_quota');
});

async function fixture(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('denied response records a safe reason and forwards no raw error text', async t => {
  const url=await fixture(t,(req,res)=>{
    res.writeHead(403,{'Content-Type':'application/json'});
    res.end(JSON.stringify({error:{code:'insufficient_user_quota',message:'用户额度不足 secret-should-not-appear'}}));
  });
  let forwarded='';
  const r=await requestChat(url,'secret',{stream:false},'denied',1000,undefined,{onChunk(chunk){forwarded+=Buffer.from(chunk).toString()}});
  assert.equal(r.errorReason,'insufficient_user_quota');
  assert.equal(r.errorType,'http_4xx');
  assert(!JSON.stringify(r).includes('secret-should-not-appear'));
  assert(!forwarded.includes('secret-should-not-appear'));
  assert.equal(JSON.parse(forwarded).error.code,'insufficient_user_quota');
});

test('TTFT ignores headers, empty deltas and heartbeats; handles split SSE frames', async t => {
  const url = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': ping\n\ndata: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n');
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"con');
      res.write('tent":"hello"},"finish_reason":null}]}\n\n');
      setTimeout(() => res.end('data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n'), 40);
    }, 80);
  });
  const result = await requestChat(url, 'not-recorded', { stream: true }, 'test', 2000);
  assert.equal(result.result, 'ok');
  assert(result.ttftMs >= 65, JSON.stringify(result));
  assert(result.ttftMs > result.ttfbMs);
  assert(result.maxContentGapMs >= 25);
  assert.equal(result.contentEvents, 2);
  assert.deepEqual(result.usage, { input: 3, output: 2 });
  assert(!JSON.stringify(result).includes('hello'));
});

test('heartbeats cannot evade total timeout or count as first content', async t => {
  const url = await fixture(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const timer = setInterval(() => res.write(': ping\n\n'), 10);
    res.on('close', () => clearInterval(timer));
  });
  const result = await requestChat(url, 'secret', { stream: true }, 'test', 100);
  assert.equal(result.errorType, 'client_timeout');
  assert.equal(result.ttftMs, null);
});

test('incomplete streams and data after DONE fail validation', async t => {
  for (const [tail, error] of [['', 'incomplete_stream'], ['data: [DONE]\n\ndata: {}\n\n', 'data_after_end']]) {
    const url = await fixture(t, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n' + tail);
    });
    assert.equal((await requestChat(url, 'secret', { stream: true }, 'test', 1000)).errorType, error);
  }
});

test('forwards a raw Buffer request body without serializing it again', async t => {
  const requestBody = Buffer.from('{"model":"fixture","stream":true,"messages":[]}');
  const url = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), requestBody);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const result = await requestChat(url, 'secret', requestBody, 'buffer-body', 1000);
  assert.equal(result.result, 'ok');
  assert.equal(result.contentEvents, 1);
});

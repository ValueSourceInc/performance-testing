import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// The meter must forward large bodies byte-for-byte and keep them out of the
// V8 heap (the comfyui longstream run died of heap OOM at ~1000 x 8 MiB).
test('stream-meter forwards a large body intact and records the stream flag', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meter-body-'));
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const received = Buffer.concat(chunks);
      fs.writeFileSync(path.join(dir, 'upstream-body.bin'), received);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const ready = path.join(dir, 'ready.json');
  const meter = spawn('node', ['tools/stream-meter.js', target, path.join(dir, 'out.stream.jsonl'), ready],
    { stdio: ['ignore', 'inherit', 'inherit'] });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise(r => setTimeout(r, 100));
    const url = JSON.parse(fs.readFileSync(ready)).url;
    const big = 'x'.repeat(4 * 1024 * 1024);
    const body = JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: big }] });
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer k', 'X-Request-ID': 'meter-test' },
      body,
    });
    assert.equal(res.status, 200);
    for await (const _ of res.body) { /* drain */ }
    // let the meter write its result line before shutdown
    await new Promise(r => setTimeout(r, 200));
    const received = fs.readFileSync(path.join(dir, 'upstream-body.bin'));
    assert.equal(received.toString(), body);
    const lines = fs.readFileSync(path.join(dir, 'out.stream.jsonl'), 'utf8').trim().split('\n');
    const record = JSON.parse(lines.at(-1));
    assert.equal(record.id, 'meter-test');
    assert.equal(record.stream, true);
    assert.equal(record.result, 'ok');
    assert.equal(record.finishReason, 'stop');
  } finally {
    meter.kill('SIGTERM');
    await once(meter, 'close').catch(() => {});
    upstream.closeAllConnections();
    upstream.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

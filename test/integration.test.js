import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

test('real k6 records staged local traffic, failures and tails and still reports threshold failure', { timeout: 30000 }, async t => {
  if (spawnSync('k6', ['version']).status !== 0) return t.skip('k6 not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-integration-'));
  let calls = 0;
  const ids = new Set();
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    ids.add(req.headers['x-request-id']);
    const call = ++calls;
    const fault = call % 4 === 0;
    if (call === 2) { res.destroy(); return; }
    await new Promise(resolve => setTimeout(resolve, call === 1 ? 2300 : 140));
    if (fault) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"local fixture"}}');
    } else if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"你好"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const child = spawn('bash', ['run.sh', 'stress'], {
    cwd: path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..'),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, OUTPUT_DIR: dir,
      BASE_URL: `http://127.0.0.1:${server.address().port}`, API_KEY: 'local-fixture-secret', API_KEYS: 'local-fixture-secret', MODELS: 'local-fixture-model',
      STRESS_MAX_VUS: '5', STRESS_STEP_DURATION: '500ms', STRESS_RAMP_DURATION: '100ms', WARMUP_DURATION: '100ms', REQ_TIMEOUT_MS: '2s',
      MIN_SUCCESS_RATE: '1', MAX_SUCCESS_P95_MS: '500', MIN_STAGE_SAMPLES: '1', MIN_STEADY_SECONDS: '0.1', UPSTREAM_MODE: 'mock',
      HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', http_proxy: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1' },
  });
  let output = '';
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });
  try {
    const [code] = await once(child, 'close');
    assert.equal(code, 99, output);
    const files = fs.readdirSync(dir);
    const analysisFile = files.find(f => f.endsWith('.analysis.json'));
    assert(analysisFile, output);
    const a = JSON.parse(fs.readFileSync(path.join(dir, analysisFile)));
    assert.equal(a.issues.length, 0, JSON.stringify(a.issues));
    assert.equal(a.totals.issued, calls);
    assert.equal(ids.size, calls);
    assert.equal(a.totals.unresolved, 0);
    assert(a.totals.failed > 0);
    assert(a.totals.errors.client_timeout > 0);
    assert(a.totals.errors.client_error > 0);
    assert(a.totals.succeeded > 0);
    assert(a.drain.completed > 0);
    assert.equal(a.cohorts.filter(c => c.phase === 'steady').length, 5);
    assert(a.cohorts.every(c => c.issued === c.succeeded + c.failed + c.cancelled + c.unresolved));
    const report = fs.readFileSync(path.join(dir, files.find(f => f.endsWith('.md'))), 'utf8');
    assert.match(report, /数值门槛未通过/);
    assert.match(report, /首字/);
    for (const file of files) assert(!fs.readFileSync(path.join(dir, file), 'utf8').includes('local-fixture-secret'), `secret leaked to ${file}`);
  } finally {
    child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

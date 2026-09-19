#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { startNetworkSampler } from '../lib/network-sampler.js';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { requestChat, detectStream } from '../lib/stream-request.js';
import { durationMs } from '../lib/load-plan.js';

const [target, output, readyFile] = process.argv.slice(2);
const url = new URL(target);
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) BASE_URL without credentials/query');
const timeout = durationMs(process.env.REQ_TIMEOUT_MS || '120s');
const fd = fs.openSync(output, 'w', 0o600);
const resources = [];
const network = [];
const networkSampler = startNetworkSampler(sample => network.push(sample));
const clientFile = output.replace(/\.stream\.jsonl$/, '.client.json');
function checkpoint() {
  fs.writeFileSync(clientFile + '.tmp', JSON.stringify({ resources, network,
    note: 'Host and per-interface counters include other applications. Network sampling runs in an isolated process.' }), { mode:0o600 });
  fs.renameSync(clientFile + '.tmp', clientFile);
}
const checkpointTimer = setInterval(checkpoint,5000);
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();
let cpu = process.cpuUsage(), previous = performance.now();
let host = os.cpus().map(c => c.times);
const sampler = setInterval(() => {
  const now = performance.now(), used = process.cpuUsage(cpu), current = os.cpus().map(c => c.times);
  let idle = 0, total = 0;
  current.forEach((times, i) => {
    if (!host[i]) return;
    idle += times.idle - host[i].idle;
    total += Object.keys(times).reduce((sum, key) => sum + times[key] - host[i][key], 0);
  });
  resources.push({ time: new Date().toISOString(), meterCpuPercentOneCore: (used.user + used.system) / ((now - previous) * 10),
    meterRssBytes: process.memoryUsage().rss, hostCpuPercent: total ? (1 - idle / total) * 100 : null,
    hostMemoryUsedPercent: (1 - os.freemem() / os.totalmem()) * 100,
    eventLoopP99Ms: eventLoop.percentile(99) / 1e6 });
  eventLoop.reset(); cpu = process.cpuUsage(); previous = now; host = current;
}, 1000);

const tasks = new Set();
const server = http.createServer((req, res) => {
  const task = handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(502); res.end(); })
    .finally(() => tasks.delete(task));
  tasks.add(task);
});

async function handle(req, res) {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  const id = req.headers['x-request-id'];
  if (typeof id !== 'string' || id.length > 200) { res.writeHead(400); res.end(); return; }
  // Bodies stay as Buffers (off-heap) and are forwarded byte-for-byte; the
  // JS heap only ever holds per-chunk slices, so 1000 x 8 MiB longstream
  // requests cannot exhaust the default ~4 GiB V8 heap.
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) { res.writeHead(413); res.end(); return; }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  const stream = detectStream(body);
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const key = (req.headers.authorization || '').replace(/^Bearer /, '');
  const startedAt = new Date().toISOString();
  const result = await requestChat(target, key, body, id, timeout, controller.signal, {
    onHeaders(status, type) { res.writeHead(status, { 'Content-Type': type || 'application/octet-stream' }); res.flushHeaders(); },
    async onChunk(chunk) {
      if (res.destroyed) { controller.abort(); return; }
      if (!res.write(chunk)) await new Promise(resolve => {
        const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
        res.once('drain', done); res.once('close', done);
      });
    },
  });
  if (!res.headersSent) res.writeHead(result.errorType === 'client_timeout' ? 504 : 502);
  res.end();
  fs.writeSync(fd, JSON.stringify({ id, startedAt, stream, ...result }) + '\n');
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await Promise.allSettled([...tasks]);
  clearInterval(sampler); clearInterval(checkpointTimer); networkSampler.stop(); eventLoop.disable(); fs.closeSync(fd);
  checkpoint();
  fs.unlinkSync(readyFile);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
// The parent lets k6 stop first, then sends SIGTERM to drain this meter.
// A terminal Ctrl+C reaches the entire process group; stopping here would
// truncate requests that k6 is still finishing.
process.on('SIGINT', () => {});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(readyFile, JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }), { mode: 0o600 }));

#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { durationMs } from '../lib/load-plan.js';

const [operation, metadata] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(metadata, 'utf8'));
const stem = metadata.replace(/\.meta\.json$/, '');
const bridge = path.resolve(process.env.MOCK_INFRA_DIR || '../new-api-aws-infra', 'scripts/mock-remote.py');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function remote(command, suffix, extra = []) {
  const child = spawn('python3', [bridge, command, '--run-id', meta.runId, '--output', stem + suffix, ...extra], { stdio: 'inherit' });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Monitoring ${command} failed (exit ${code})`)));
  });
}
async function collect() {
  let failure;
  try { await remote('end', '.mock-end.json'); } catch (error) { failure = error.message; }
  const recoverySeconds = 120, ingestionSeconds = 120;
  const end = new Date(Date.parse(meta.finishedAt) + recoverySeconds * 1000);
  const readyAt = end.getTime() + ingestionSeconds * 1000;
  while (Date.now() < readyAt) {
    console.log(`Waiting for recovery metrics and CloudWatch ingestion: ${Math.ceil((readyAt - Date.now()) / 1000)}s remaining`);
    await sleep(Math.min(30000, readyAt - Date.now()));
  }
  try {
    await remote('collect', '.aws.json', ['--start', new Date(Date.parse(meta.createdAt) - 120000).toISOString(), '--end', end.toISOString()]);
    const result = JSON.parse(fs.readFileSync(stem + '.aws.json', 'utf8'));
    result.runId = meta.runId;
    if (failure) result.errors.push(failure);
    fs.writeFileSync(stem + '.aws.json', JSON.stringify(result, null, 2));
  } finally {
    await remote('finish', '.monitor-finish.json');
  }
}
try {
  if (!fs.existsSync(bridge)) throw new Error('Missing infra checkout. Set MOCK_INFRA_DIR to new-api-aws-infra.');
  if (operation === 'begin') {
    await remote('begin', '.mock-start.json', ['--lease-seconds', String(Math.ceil((meta.plan.durationMs + durationMs(meta.requestTimeout)) / 1000) + 1800)]);
  } else if (operation === 'end') await collect();
  else if (operation === 'release') await remote('finish', '.monitor-finish.json');
  else throw new Error('Expected begin or end');
} catch (error) {
  const target = stem + '.aws.json';
  const existing = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : { schema: 1, runId: meta.runId, series: [], errors: [] };
  existing.errors.push(error.message);
  fs.writeFileSync(target, JSON.stringify(existing, null, 2), { mode: 0o600 });
  console.error(error.message);
  process.exitCode = 1;
}

import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildPlan } from '../lib/load-plan.js';

const [scenario, output] = process.argv.slice(2);
const plan = buildPlan(scenario, process.env);
const value = key => process.env[key] || null;
const number = key => {
  if (!value(key)) return null;
  const n = Number(value(key));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${key}`);
  return n;
};
const minSuccessRate = number('MIN_SUCCESS_RATE');
const longInputTokens = number('LONG_INPUT_TOKENS');
if (longInputTokens !== null && (!Number.isSafeInteger(longInputTokens) || longInputTokens > 1000000)) {
  throw new Error('LONG_INPUT_TOKENS must be an integer from 1 to 1000000');
}
const sizedInput = longInputTokens !== null && !['mixed', 'smoke'].includes(scenario);
const mixRaw = value('PROMPT_MIX');
const mixTokens = value('PROMPT_MIX_TOKENS');
const samplePrompt = mixRaw ? `synthetic length mix ${mixRaw} (short/mid/large/tail shares; ${mixTokens || '2000,32000,128000,1000000'} tokens per bucket)`
  : sizedInput ? `synthetic single user input: ${longInputTokens} text tokens (o200k_base/cl100k_base; excludes chat framing)`
  : scenario === 'mixed' ? 'short/long fixed synthetic samples'
  : value('PROMPT_KIND') || (value('PROMPTS_FILE') ? 'sampled prompts file' : 'short fixed synthetic sample');
if (minSuccessRate > 1) throw new Error('MIN_SUCCESS_RATE must be <= 1');
const target = new URL(value('BASE_URL') || 'http://localhost:8787');
target.username = ''; target.password = ''; target.search = ''; target.hash = '';
const git = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
const dirty = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
const version = spawnSync('k6', ['version'], { encoding: 'utf8' });
const context = process.env.TEST_CONTEXT_FILE ? JSON.parse(fs.readFileSync(process.env.TEST_CONTEXT_FILE, 'utf8')) : {};
const allowed = ['owner', 'serverVersion', 'serverResources', 'database', 'cache', 'proxy', 'instances', 'dataScale', 'environmentDifferences', 'networkLocation', 'routing', 'accountLimits', 'upstreamLimits', 'retries', 'cachePolicy', 'resourceEvidence', 'billingEvidence', 'recoveryEvidence', 'ttftEvidence', 'stopConditions'];
fs.writeFileSync(output, JSON.stringify({ schema: 1, runId: value('RUN_ID'), createdAt: new Date().toISOString(),
  streamMeter: process.env.STREAM_METER === '1', awsMonitoring: process.env.AWS_METRICS === '1',
  target: target.toString(), plan, revision: git.status === 0 ? git.stdout.trim() : null, dirty: !!dirty.stdout?.trim(),
  k6Version: version.status === 0 ? version.stdout.trim() : null,
  client: { platform: os.platform(), arch: os.arch(), cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memoryBytes: os.totalmem() },
  upstreamMode: value('UPSTREAM_MODE') || 'unknown', models: value('MODELS'), requestTimeout: value('REQ_TIMEOUT_MS') || '120s',
  sample: { protocol: 'OpenAI chat completions', streamRatio: scenario === 'longstream' ? 1 : scenario === 'mixed' ? 0.70 : 0.50,
    prompt: samplePrompt, inputTextTokens: sizedInput ? longInputTokens : null,
    inputTokenBasis: sizedInput ? 'o200k_base/cl100k_base synthetic content; excludes chat framing' : null,
    usage: 'provider reported; missing remains unknown', clientRetries: 0 },
  acceptance: { minSuccessRate, maxSuccessP95Ms: number('MAX_SUCCESS_P95_MS'), minSamples: number('MIN_STAGE_SAMPLES'), minSteadySeconds: number('MIN_STEADY_SECONDS') },
  context: Object.fromEntries(allowed.map(key => [key, context[key] ?? null])) }, null, 2), { mode: 0o600 });

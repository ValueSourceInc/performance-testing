// shared config for all k6 scenarios
// env vars: BASE_URL, API_KEY, API_KEYS (comma-separated, multi-account), MODELS, REQ_TIMEOUT_MS, TAG_PREFIX
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8787';

export const API_KEYS = (__ENV.API_KEYS || __ENV.API_KEY || 'sk-mock')
  .split(',').map(s => s.trim()).filter(Boolean);

if (API_KEYS.length === 0) throw new Error('API_KEYS must contain at least one key');

// multi-account: round-robin across keys so account isolation / shared-quota behavior is exercised
let keyCursor = 0;
export function pickKey() {
  return API_KEYS[keyCursor++ % API_KEYS.length];
}

export const MODELS = (__ENV.MODELS || 'gpt-6-astra,claude-sonnet-5')
  .split(',').map(s => s.trim()).filter(Boolean);

if (MODELS.length === 0) throw new Error('MODELS must contain at least one model');

export function pickModel() {
  return MODELS[Math.floor(Math.random() * MODELS.length)];
}

const LONG_PROMPT = '背景资料：' + '在一个遥远的山谷里有一座古老的图书馆，'.repeat(160);
// This synthetic unit is one token in o200k_base and cl100k_base (verified
// with js-tiktoken). Counts exclude chat framing and differ for other encodings.
const sizedInput = __ENV.LONG_INPUT_TOKENS;
const longInputTokens = sizedInput ? Number(sizedInput) : null;
if (sizedInput && (!Number.isSafeInteger(longInputTokens) || longInputTokens < 1 || longInputTokens > 1000000)) {
  throw new Error('LONG_INPUT_TOKENS must be an integer from 1 to 1000000');
}
let sizedPrompt;

// PROMPT_MIX: 长度混合占比,如 70/20/9/1(short/mid/large/tail,百分比,和≈100)。
// 现实流量里百万 token 是尾部事件而非常态;全量大输入并发会淹死上传带宽
// (2026-09-19 comfyui 轮:1000×8MiB 实际到货仅 ~5MiB/s,见 NEXT-RUN-CHECKLIST §7)。
// PROMPT_MIX_TOKENS: 四桶 token 规模,默认 2000,32000,128000,1000000(tail 默认取 LONG_INPUT_TOKENS)。
const mixRaw = __ENV.PROMPT_MIX;
const MIX_BUCKETS = ['short', 'mid', 'large', 'tail'];
const mixShares = mixRaw ? mixRaw.split('/').map(Number) : null;
if (mixShares && (mixShares.length !== 4 || mixShares.some(s => !Number.isFinite(s) || s < 0) || mixShares.every(s => s === 0)))
  throw new Error('PROMPT_MIX must be 4 shares like 70/20/9/1 (short/mid/large/tail)');
const mixTokensRaw = (__ENV.PROMPT_MIX_TOKENS || `2000,32000,128000,${longInputTokens || 1000000}`).split(',');
const mixTokens = mixTokensRaw.map(Number);
if (mixShares && (mixTokens.length !== 4 || mixTokens.some(t => !Number.isSafeInteger(t) || t < 1 || t > 1000000)))
  throw new Error('PROMPT_MIX_TOKENS must be 4 integers from 1 to 1000000');
const sizedCache = new Map();
const sizedText = tokens => { if (!sizedCache.has(tokens)) sizedCache.set(tokens, ' context'.repeat(tokens)); return sizedCache.get(tokens); };
export const MIX_ENABLED = !!mixShares;
export const MIX_PROMPTS = MIX_ENABLED ? MIX_BUCKETS.map((bucket, i) => ({ bucket, prompt: sizedText(mixTokens[i]) })) : null;
export function rollMixedIndex() {
  let roll = Math.random() * mixShares.reduce((a, b) => a + b, 0);
  for (let i = 0; i < mixShares.length; i++) { roll -= mixShares[i]; if (roll < 0) return i; }
  return mixShares.length - 1;
}

// 真实请求样本：PROMPTS_FILE 指向每行一条真实 prompt 文本（UTF-8，不含换行）。
// 请求体大小、解析开销、上行流量只有真实样本才能代表生产形态；short 合成样本仅 178 字节。
// k6 open() 只在 init 阶段可用,相对路径以 lib/ 为基准;PROMPTS_FILE 约定相对仓库根。
// 文件不存在时启动即报错，避免静默退回合成样本。
const promptFilePath = longInputTokens ? null : (__ENV.PROMPTS_FILE && !__ENV.PROMPTS_FILE.startsWith('/')
  ? `../${__ENV.PROMPTS_FILE}` : __ENV.PROMPTS_FILE);
const PROMPT_LINES = promptFilePath
  ? open(promptFilePath, 'r').split('\n').map(s => s.trim()).filter(Boolean)
  : null;
if (promptFilePath && !PROMPT_LINES.length) throw new Error(`PROMPTS_FILE has no non-empty lines: ${__ENV.PROMPTS_FILE}`);

export function pickPrompt(kind) {
  if (kind === 'sized') {
    if (!longInputTokens) throw new Error('sized prompt requires LONG_INPUT_TOKENS');
    return sizedPrompt ?? (sizedPrompt = ' context'.repeat(longInputTokens));
  }
  if (kind === 'long') return LONG_PROMPT;
  if (kind === 'short') return '你好，请介绍一下你自己';
  if (kind === 'real') {
    if (!PROMPT_LINES) throw new Error("promptKind 'real' requires PROMPTS_FILE (one real prompt per line)");
    return PROMPT_LINES[Math.floor(Math.random() * PROMPT_LINES.length)];
  }
  return Math.random() < 0.3 ? LONG_PROMPT : '你好，请介绍一下你自己';
}

// 场景默认 prompt 形态：PROMPT_KIND 显式指定，否则有真实样本就用 real
export function defaultPromptKind() {
  if (longInputTokens) return 'sized';
  if (__ENV.PROMPT_KIND) return __ENV.PROMPT_KIND;
  return PROMPT_LINES ? 'real' : 'short';
}

// build a chat request body (OpenAI format, what new-api accepts)
// SEND_MAX_TOKENS=1 时同时发真实 max_tokens(真实上游生效,控制输出长度与费用);
// mock_max_tokens 只有 mock 认,真实上游忽略未知字段
// maxTokens 未指定时取 MOCK_MAX_TOKENS(压 mock 时控制流时长)。
export function chatBody({ model, stream = false, prompt, promptKind, maxTokens, bucket } = {}) {
  const body = {
    model: model || pickModel(),
    stream,
    messages: [{ role: 'user', content: prompt ?? pickPrompt(promptKind) }],
  };
  if (stream) body.stream_options = { include_usage: true };
  const tokenLimit = maxTokens ?? (__ENV.MOCK_MAX_TOKENS ? Number(__ENV.MOCK_MAX_TOKENS) : undefined);
  if (tokenLimit !== undefined) {
    body.mock_max_tokens = tokenLimit;
    if (__ENV.SEND_MAX_TOKENS === '1') body.max_tokens = tokenLimit;
  }
  // 长度桶标记:不可枚举 → 不会进 JSON.stringify 请求体,仅供 execChat 记事件
  if (bucket) Object.defineProperty(body, 'promptBucket', { value: bucket, enumerable: false });
  return body;
}

export function chatHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${pickKey()}`,
  };
}

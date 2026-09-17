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

// request-prompt samples: short ~10 tokens, long ~1500 tokens (chars approx)
// long input exercises request-body parsing, header/join cost and upstream token quota accounting
const LONG_PROMPT = '背景资料：'.repeat(1) + '在一个遥远的山谷里有一座古老的图书馆，'.repeat(160);

export function pickPrompt(kind) {
  if (kind === 'long') return LONG_PROMPT;
  if (kind === 'short') return '你好，请介绍一下你自己';
  return Math.random() < 0.3 ? LONG_PROMPT : '你好，请介绍一下你自己';
}

// build a chat request body (OpenAI format, what new-api accepts)
// SEND_MAX_TOKENS=1 时同时发真实 max_tokens(真实上游生效,控制输出长度与费用);
// mock_max_tokens 只有 mock 认,真实上游忽略未知字段
export function chatBody({ model, stream = false, prompt, promptKind = 'short', maxTokens } = {}) {
  const body = {
    model: model || pickModel(),
    stream,
    messages: [{ role: 'user', content: prompt ?? pickPrompt(promptKind) }],
  };
  if (stream) body.stream_options = { include_usage: true };
  if (maxTokens !== undefined) {
    body.mock_max_tokens = maxTokens;
    if (__ENV.SEND_MAX_TOKENS === '1') body.max_tokens = maxTokens;
  }
  return body;
}

export function chatHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${pickKey()}`,
  };
}

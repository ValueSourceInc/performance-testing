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

// 真实请求样本：PROMPTS_FILE 指向每行一条真实 prompt 文本（UTF-8，不含换行）。
// 请求体大小、解析开销、上行流量只有真实样本才能代表生产形态；short 合成样本仅 178 字节。
// k6 open() 只在 init 阶段可用,相对路径以 lib/ 为基准;PROMPTS_FILE 约定相对仓库根。
// 文件不存在时启动即报错，避免静默退回合成样本。
const promptFilePath = __ENV.PROMPTS_FILE && !__ENV.PROMPTS_FILE.startsWith('/')
  ? `../${__ENV.PROMPTS_FILE}` : __ENV.PROMPTS_FILE;
const PROMPT_LINES = promptFilePath
  ? open(promptFilePath, 'r').split('\n').map(s => s.trim()).filter(Boolean)
  : null;
if (promptFilePath && !PROMPT_LINES.length) throw new Error(`PROMPTS_FILE has no non-empty lines: ${__ENV.PROMPTS_FILE}`);

export function pickPrompt(kind) {
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
  if (__ENV.PROMPT_KIND) return __ENV.PROMPT_KIND;
  return PROMPT_LINES ? 'real' : 'short';
}

// build a chat request body (OpenAI format, what new-api accepts)
// SEND_MAX_TOKENS=1 时同时发真实 max_tokens(真实上游生效,控制输出长度与费用);
// mock_max_tokens 只有 mock 认,真实上游忽略未知字段
// maxTokens 未指定时取 MOCK_MAX_TOKENS(压 mock 时控制流时长)。
export function chatBody({ model, stream = false, prompt, promptKind, maxTokens } = {}) {
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
  return body;
}

export function chatHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${pickKey()}`,
  };
}

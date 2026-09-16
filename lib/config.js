// shared config for all k6 scenarios
// env vars: BASE_URL, API_KEY, MODELS (comma-separated), TAG_PREFIX
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8787';
export const API_KEY = __ENV.API_KEY || 'sk-mock';

export const MODELS = (__ENV.MODELS || 'gpt-6-astra,claude-sonnet-5')
  .split(',').map(s => s.trim()).filter(Boolean);

export function pickModel() {
  return MODELS[Math.floor(Math.random() * MODELS.length)];
}

// build a chat request body (OpenAI format, what new-api accepts)
export function chatBody({ model, stream = false, prompt = '你好，请介绍一下你自己', maxTokens } = {}) {
  const body = {
    model: model || pickModel(),
    stream,
    messages: [{ role: 'user', content: prompt }],
  };
  if (maxTokens) body.mock_max_tokens = maxTokens; // mock service only; real upstream ignores unknown fields
  return body;
}

export function chatHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
  };
}
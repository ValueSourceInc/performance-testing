// mixed: realistic blend — stream/non-stream, long/short outputs, multiple models
// weights: 50% short stream, 20% long stream, 20% short non-stream, 10% long non-stream
import { chatBody, MODELS } from '../lib/config.js';
import { execChat } from '../lib/requests.js';

const duration = __ENV.MIXED_DURATION || '3m';
const targetRps = Number(__ENV.MIXED_RPS || 20);

export const options = {
  scenarios: {
    mixed: {
      executor: 'constant-arrival-rate',
      rate: targetRps,
      timeUnit: '1s',
      duration,
      preAllocatedVUs: Math.max(50, targetRps * 3),
      maxVUs: Math.max(100, targetRps * 6),
    },
  },
};

const SHORT = 64;
const LONG = 1024;

export default function () {
  const model = MODELS[Math.floor(Math.random() * MODELS.length)];
  const r = Math.random();
  let body;
  if (r < 0.5) body = chatBody({ model, stream: true, maxTokens: SHORT });
  else if (r < 0.7) body = chatBody({ model, stream: true, maxTokens: LONG });
  else if (r < 0.9) body = chatBody({ model, stream: false, maxTokens: SHORT });
  else body = chatBody({ model, stream: false, maxTokens: LONG });
  execChat(body);
}
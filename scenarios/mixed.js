// mixed: realistic blend — stream/non-stream, long/short outputs, long/short inputs, multiple models, multiple accounts
// weights: 40% short stream, 15% long stream, 15% long-input stream, 20% short non-stream, 10% long non-stream
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
      // VUs must cover avg-inflight = RPS × avg duration; too few => dropped_iterations,
      // which means the target rate was never actually issued — do not ignore that threshold
      preAllocatedVUs: Math.max(50, targetRps * 10),
      maxVUs: Math.max(100, targetRps * 20),
      gracefulStop: '90s',
    },
  },
  thresholds: {
    'chat_ok': ['rate>0.95'],
    'dropped_iterations': ['count<1'],
  },
};

const SHORT = 64;
const LONG = 1024;

export default function () {
  const model = MODELS[Math.floor(Math.random() * MODELS.length)];
  const r = Math.random();
  let body;
  if (r < 0.4) body = chatBody({ model, stream: true, maxTokens: SHORT });
  else if (r < 0.55) body = chatBody({ model, stream: true, maxTokens: LONG });
  else if (r < 0.7) body = chatBody({ model, stream: true, promptKind: 'long', maxTokens: SHORT });
  else if (r < 0.9) body = chatBody({ model, stream: false, maxTokens: SHORT });
  else body = chatBody({ model, stream: false, maxTokens: LONG });
  execChat(body);
}

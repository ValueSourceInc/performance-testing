// smoke: 1 VU, a few requests — verify protocol, auth, end markers, accounting before any load
import { chatBody } from '../lib/config.js';
import { execChat } from '../lib/requests.js';

export const options = {
  scenarios: {
    smoke: {
      executor: 'constant-vus',
      vus: 1,
      duration: __ENV.SMOKE_DURATION || '30s',
      gracefulStop: __ENV.REQ_TIMEOUT_MS || '120s',
    },
  },
  thresholds: {
    'chat_ok': ['rate>0.99'],
    'chat_errors': ['count<1'],
  },
};

export default function () {
  execChat(chatBody({ stream: Math.random() < 0.5, maxTokens: 32 }));
}

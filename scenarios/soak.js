// soak: steady concurrency for a sustained window, watch steady-state QPS + latency
// tune with: SOAK_VUS, SOAK_DURATION (e.g. "5m")
import { chatBody } from '../lib/config.js';
import { execChat } from '../lib/requests.js';

const vus = Number(__ENV.SOAK_VUS || 20);
const duration = __ENV.SOAK_DURATION || '2m';

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-vus',
      vus,
      duration,
      gracefulStop: '90s', // long streams need room to finish; truncated requests are NOT counted as completed
    },
  },
  thresholds: {
    'chat_ok': ['rate>0.95'],
    'dropped_iterations': ['count<1'],
  },
};

export default function () {
  execChat(chatBody({ stream: Math.random() < 0.5, promptKind: 'short' }));
}

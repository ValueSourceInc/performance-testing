// spike: low steady load, sudden burst to max, back down — tests recovery
// tune with: SPIKE_MAX_VUS, SPIKE_BASE_VUS
import { chatBody } from '../lib/config.js';
import { execChat } from '../lib/requests.js';

const baseVus = Number(__ENV.SPIKE_BASE_VUS || 10);
const maxVus = Number(__ENV.SPIKE_MAX_VUS || __ENV.SPIKE_VUS || 200);

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: baseVus,
      stages: [
        { duration: '1m', target: baseVus },   // steady state
        { duration: '10s', target: maxVus },   // burst
        { duration: '1m', target: maxVus },    // hold burst
        { duration: '30s', target: baseVus },  // recover
        { duration: '1m', target: baseVus },   // verify recovery
      ],
      gracefulRampDown: '90s',
      gracefulStop: '90s',
    },
  },
  thresholds: {
    'dropped_iterations': ['count<10'],
  },
};

export default function () {
  execChat(chatBody({ stream: Math.random() < 0.5, promptKind: 'short' }));
}

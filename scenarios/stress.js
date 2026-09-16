// stress: step up load to find the knee / breaking point
// tune with: STRESS_MAX_VUS, STRESS_STEP_DURATION
import { chatBody } from '../lib/config.js';
import { execChat } from '../lib/requests.js';

const maxVus = Number(__ENV.STRESS_MAX_VUS || 200);
const stepDuration = __ENV.STRESS_STEP_DURATION || '30s';
const steps = 5; // e.g. 20%..100% of maxVus

const stages = Array.from({ length: steps }, (_, i) => ({
  duration: stepDuration,
  target: Math.max(1, Math.round((maxVus * (i + 1)) / steps)),
}));

export const options = {
  scenarios: {
    stress: {
      executor: 'ramping-vus',
      startVUs: Math.max(1, Math.round(maxVus / steps)),
      stages,
      gracefulRampDown: '10s',
    },
  },
};

export default function () {
  execChat(chatBody({ stream: Math.random() < 0.5 }));
}
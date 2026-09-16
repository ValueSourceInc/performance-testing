// smoke: 1 VU, a few iterations, verify the chain works
import { chatBody } from '../lib/config.js';
import { execChat } from '../lib/requests.js';
import { check } from 'k6';

export const options = {
  vus: 1,
  iterations: 3,
  thresholds: {
    chat_ok: ['rate>0.99'],
  },
};

export default function () {
  const b = chatBody({ stream: false });
  const r = execChat(b);
  check(r, { 'status 200': x => x.status === 200 });
}
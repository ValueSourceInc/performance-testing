import { chatBody } from '../lib/config.js';
import { execChat } from '../lib/requests.js';
import { scenarioOptions } from '../lib/load-plan.js';

export const options = scenarioOptions('spike', __ENV);

export default function () {
  execChat(chatBody({ stream: Math.random() < 0.5, promptKind: 'short' }));
}

import { chatBody, defaultPromptKind } from '../lib/config.js';
import { execChat } from '../lib/requests.js';
import { scenarioOptions } from '../lib/load-plan.js';

export const options = scenarioOptions('soak', __ENV);

export default function () {
  // 流式比例与 prompt 形态可用 STREAM_RATIO / PROMPT_KIND 覆盖;PROMPTS_FILE 存在时默认用真实样本
  const streamRatio = __ENV.STREAM_RATIO ? Number(__ENV.STREAM_RATIO) : 0.5;
  execChat(chatBody({ stream: Math.random() < streamRatio, promptKind: defaultPromptKind() }));
}

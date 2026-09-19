// longstream: 真实长流形态 — 100% 流式、单请求 60–90s、长连接持续占用
// 与 stress 形态互补: 长流下并发连接数、内存驻留、SSE 代理链路才是被测对象
// mock 时长 = TTFT_MS + tokens × TOKEN_INTERVAL_MS;默认 3500 tokens × 20ms ≈ 70s
// REQ_TIMEOUT_MS 必须 > 流时长 + 网络余量(建议 3m)
import { chatBody, defaultPromptKind } from '../lib/config.js';
import { execChat } from '../lib/requests.js';
import { scenarioOptions } from '../lib/load-plan.js';

export const options = scenarioOptions('longstream', __ENV);

export default function () {
  execChat(chatBody({ stream: true, promptKind: defaultPromptKind() }));
}

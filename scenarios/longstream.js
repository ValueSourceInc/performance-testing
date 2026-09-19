// longstream: 真实长流形态 — 100% 流式、单请求 60–90s、长连接持续占用
// 与 stress 形态互补: 长流下并发连接数、内存驻留、SSE 代理链路才是被测对象
// 可选 LONG_INPUT_TOKENS 指定单次输入正文规模（最多 1,000,000，o200k/cl100k 口径）。
// MOCK_MAX_TOKENS 控制输出，两者相互独立；每个请求只有一条 user 消息。
// REQ_TIMEOUT_MS 必须 > 流时长 + 网络余量(建议 3m)
import { chatBody, defaultPromptKind, MIX_ENABLED, MIX_PROMPTS, rollMixedIndex } from '../lib/config.js';
import { execChat } from '../lib/requests.js';
import { scenarioOptions } from '../lib/load-plan.js';

export const options = scenarioOptions('longstream', __ENV);

// PROMPT_MIX 长度混合(推荐,如 70/20/9/1):真实流量里大上下文是尾部事件,
// 四桶按占比采样;每桶 body 每 VU 只构建一次(8MiB 级字符串构建+序列化是迭代最贵操作)。
// 未设置时保持旧行为:LONG_INPUT_TOKENS 单一固定规模。
const MIXED_BODIES = MIX_ENABLED ? MIX_PROMPTS.map(({ bucket, prompt }) => chatBody({ stream: true, prompt, bucket })) : null;
const BODY = MIXED_BODIES ? null : chatBody({ stream: true, promptKind: defaultPromptKind() });

export default function () {
  execChat(MIXED_BODIES ? MIXED_BODIES[rollMixedIndex()] : BODY);
}

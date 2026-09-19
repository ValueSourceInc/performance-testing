# 单次百万 token 输入压测

沿用 `longstream`，每次发送一条独立 user 消息。没有多轮对话、历史累积或新场景。

## 服务器运行

```bash
ssh comfyui
cd ~/projects/performance-testing
LONG_INPUT_TOKENS=1000000 LONG_VUS=1 LONG_DURATION=3m REQ_TIMEOUT_MS=3m bash run-aws.sh longstream
```

- `LONG_INPUT_TOKENS`：输入正文规模，整数 1–1000000。显式设置后优先于 `PROMPTS_FILE` 和 `PROMPT_KIND`，不读取原提示词文件；未设置时保持原有抽样方式。建议先单并发确认完整通过，再调整 `LONG_VUS`。
- `MOCK_MAX_TOKENS`：输出长度，和输入独立；上述命令继续采用现有 `.env` 的输出设置（当前为 8192）。
- 合成输入为重复的 ` context`。使用 js-tiktoken 1.0.21 实际核验，1,000,000 次重复在 `o200k_base`、`cl100k_base` 下均为 1,000,000 个正文 token，正文 8,000,000 字节；运行时不需要新增 tokenizer 依赖。
- 该数值不包括 messages 包装及输出。实际模型的总上下文限制必须容纳输入、输出和包装；其他 tokenizer 的计数不保证相同。Mock 返回的模拟用量不能替代此正文计数。
- 重复合成文本用来测大请求体的上传、转发及流式返回，不用于评估真实模型理解能力；重复前缀也可能触发真实上游缓存，不能据此推断真实业务的费用或吞吐。
- 百万级输入同时给压测机和服务端增加流量、解析及内存开销。报告中的 `inputChars`、`bodyBytes` 和输入条件可用于核对请求是否实际发出；413 等拒绝应作为结果保留，不自动缩小请求。
- 参数使用现有读取默认提示词的场景共用逻辑；`mixed` 自行选择提示词类别，不采用此输入覆盖。

## 下载报告到本地 Mac

等服务器提示报告生成结束（包括 AWS 指标等待）后，在 Mac 终端执行：

```bash
mkdir -p ~/Downloads/uxn/performance-testing/logs-from-comfyui
rsync -av --partial --progress \
  comfyui:~/projects/performance-testing/logs/ \
  ~/Downloads/uxn/performance-testing/logs-from-comfyui/
```

再次执行即可增量同步。每轮同名前缀的 `.html` 可直接在浏览器打开，`.md` 是文本报告，其余 JSON/JSONL/log 保留用于核对。复制到独立目录不会覆盖原本地压测日志。

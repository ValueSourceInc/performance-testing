function objectsFrom(body, stream) {
  return stream
    ? (body || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n').slice(0, -1)
      .map(event => event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n'))
      .filter(data => data && data !== '[DONE]').map(data => JSON.parse(data))
    : [JSON.parse(body)];
}

export function responseDetails(body, stream) {
  try {
    const objects = objectsFrom(body, stream);
    const finishReason = objects.flatMap(obj => obj.choices || []).map(c => c.finish_reason).filter(Boolean).pop() || null;
    const usage = objects.map(obj => obj.usage).filter(Boolean).pop();
    if (!usage || !Number.isInteger(usage.prompt_tokens) || usage.prompt_tokens < 0 ||
        !Number.isInteger(usage.completion_tokens) || usage.completion_tokens < 0) return { finishReason, usage: null };
    return { finishReason, usage: { input: usage.prompt_tokens, output: usage.completion_tokens } };
  } catch { return { finishReason: null, usage: null }; }
}

export function responseUsage(body, stream) {
  return responseDetails(body, stream).usage;
}

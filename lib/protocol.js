// Buffered OpenAI text completion validation; network chunks are not SSE events.
export function classify(res, stream) {
  if (res.error_code || res.status === 0) return /timeout/i.test(res.error || '') ? 'client_timeout' : 'client_error';
  if (res.status !== 200) return `http_${res.status}`;
  const type = Object.entries(res.headers || {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '';
  if (!type.includes(stream ? 'text/event-stream' : 'application/json')) return 'content_type';
  try {
    if (!stream) {
      const obj = JSON.parse(res.body);
      if (obj.error) return 'error_event';
      const c = obj.choices?.[0];
      return c && ['stop','length'].includes(c.finish_reason) && typeof c.message?.content === 'string' && c.message.content.length ? null : 'malformed_body';
    }
    let content = false, finish = false, done = false;
    // Discard unterminated last event per SSE framing rules.
    const events = (res.body || '').replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n\n');
    events.pop();
    for (const event of events) {
      const lines = event.split('\n');
      const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /,'')).join('\n');
      if (lines.some(l => /^event:\s*error$/.test(l))) return 'error_event';
      if (!data) continue;
      if (done) return 'data_after_end';
      if (data === '[DONE]') { done = true; continue; }
      const obj = JSON.parse(data);
      if (obj.error) return 'error_event';
      if (!Array.isArray(obj.choices)) return 'malformed_body';
      for (const c of obj.choices) {
        if (typeof c.delta?.content === 'string' && c.delta.content.length) content = true;
        if (c.finish_reason != null) {
          if (!['stop','length'].includes(c.finish_reason)) return 'unexpected_finish';
          finish = true;
        }
      }
    }
    return done && finish && content ? null : 'incomplete_stream';
  } catch { return 'malformed_body'; }
}

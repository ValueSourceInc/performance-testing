import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/protocol.js';
const response = body => ({status:200, headers:{'Content-Type':'text/event-stream'}, body});
test('text containing DONE is not a completion', () => {
 assert.notEqual(classify(response('data: {"choices":[{"delta":{"content":"[DONE]"}}]}\n\n'),true),null);
});
test('valid multiline SSE completes', () => {
 assert.equal(classify(response('data: {"choices":\ndata: [{"delta":{"content":"你好"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),true),null);
});
test('error event cannot complete', () => {
 assert.notEqual(classify(response('event: error\ndata: {"message":"bad"}\n\ndata: [DONE]\n\n'),true),null);
});
test('nonstream must be valid completion JSON', () => {
 assert.notEqual(classify({status:200,headers:{'Content-Type':'application/json'},body:'{"choices":[]}'},false),null);
});

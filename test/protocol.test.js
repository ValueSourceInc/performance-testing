import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/protocol.js';
const response = body => ({status:200, headers:{'Content-Type':'text/event-stream'}, body});
test('k6 HTTP error codes retain HTTP response classification', () => {
 assert.equal(classify({status:403,error_code:1403},false),'http_403');
 assert.equal(classify({status:429,error_code:1429},false),'http_429');
 assert.equal(classify({status:502,error_code:1502},false),'http_502');
 assert.equal(classify({status:200,error_code:1633,error:'stream error'},true),'client_error');
});
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

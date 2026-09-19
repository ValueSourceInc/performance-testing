import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

async function config(env) {
  globalThis.__ENV = env;
  return import(`../lib/config.js?test=${Math.random()}`);
}

test('sized input overrides samples, keeps one user message and leaves output independent', async () => {
  const c = await config({ LONG_INPUT_TOKENS:'1000000', PROMPTS_FILE:'missing-file.txt', PROMPT_KIND:'real', MOCK_MAX_TOKENS:'8192', SEND_MAX_TOKENS:'1' });
  const body=c.chatBody({ stream:true, promptKind:c.defaultPromptKind() });
  assert.equal(body.messages.length,1);
  assert.equal(body.messages[0].content,' context'.repeat(1000000));
  assert.equal(body.max_tokens,8192);
  assert.equal(body.mock_max_tokens,8192);
});

test('omitted sizing preserves original short/long behavior; invalid sizes fail', async () => {
  const c=await config({});
  assert.equal(c.defaultPromptKind(),'short');
  assert.match(c.pickPrompt('long'),/^背景资料：在一个遥远/);
  for(const value of ['0','-1','1000001','1.5','NaN']) await assert.rejects(config({LONG_INPUT_TOKENS:value}));
});

test('k6 sends the full million-token input through the meter and records accurate report conditions', {timeout:45000}, async t=>{
  if(spawnSync('k6',['version']).status!==0) return t.skip('k6 not installed');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'million-input-'));
  let calls=0;
  const observations=[];
  const server=http.createServer(async(req,res)=>{
    let raw='';
    for await(const part of req) raw+=part;
    const body=JSON.parse(raw);
    observations.push({ messages:body.messages.length, chars:body.messages[0].content.length, singleUnit:body.messages[0].content===' context'.repeat(1000000), output:body.max_tokens });
    calls++;
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const child=spawn('bash',['run.sh','longstream'],{env:{...process.env,
    BASE_URL:`http://127.0.0.1:${server.address().port}`,API_KEY:'fixture',API_KEYS:'fixture',MODELS:'fixture',
    OUTPUT_DIR:dir,AWS_METRICS:'0',STREAM_METER:'1',LONG_INPUT_TOKENS:'1000000',
    LONG_VUS:'1',LONG_DURATION:'1s',WARMUP_DURATION:'0s',REQ_TIMEOUT_MS:'10s',MOCK_MAX_TOKENS:'16',SEND_MAX_TOKENS:'1',
    MIN_SUCCESS_RATE:'1',MIN_STAGE_SAMPLES:'1',MIN_STEADY_SECONDS:'0.1',MAX_SUCCESS_P95_MS:'15000'}});
  let output=''; child.stdout.on('data',x=>output+=x); child.stderr.on('data',x=>output+=x);
  try {
    const [code]=await once(child,'close'); assert.equal(code,0,output); assert(calls>0,output);
    for(const x of observations) assert.deepEqual(x,{messages:1,chars:8000000,singleUnit:true,output:16});
    const files=fs.readdirSync(dir);
    const meta=JSON.parse(fs.readFileSync(path.join(dir,files.find(x=>x.endsWith('.meta.json')))));
    assert.equal(meta.sample.inputTextTokens,1000000);
    assert.equal(meta.sample.streamRatio,1);
    const report=fs.readFileSync(path.join(dir,files.find(x=>x.endsWith('.md'))),'utf8');
    assert.match(report,/1000000 text tokens/);
    const analysis=JSON.parse(fs.readFileSync(path.join(dir,files.find(x=>x.endsWith('.analysis.json')))));
    assert.equal(analysis.totals.issued,calls);
    assert.equal(analysis.totals.failed,0);
    assert.equal(analysis.issues.length,0);
  } finally { child.kill('SIGKILL'); server.closeAllConnections(); server.close(); fs.rmSync(dir,{recursive:true,force:true}); }
});

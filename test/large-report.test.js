import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('disk-backed report joins out-of-order events and preserves stage tails, errors and missing meters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-report-'));
  try {
    const stem = path.join(dir, 'run');
    const windows = [{ id:'a',phase:'steady',startMs:0,endMs:1000,target:2 },{ id:'b',phase:'steady',startMs:1000,endMs:2000,target:2 }];
    fs.writeFileSync(stem+'.meta.json',JSON.stringify({ plan:{windows,durationMs:2000},elapsedMs:2200,streamMeter:true }));
    const start=(id,window,startMs)=>({schema:1,kind:'start',id,window,startMs,startTime:new Date(1800000000000+startMs).toISOString(),model:'m',stream:true,inputChars:4});
    const end=(id,endMs,result,errorCode)=>({schema:1,kind:'end',id,endMs,totalMs:endMs-100,result,errorCode,errorType:result==='fail'?'client_error':null,status:errorCode===1403?403:200});
    fs.writeFileSync(stem+'.events.jsonl',[start('1','a',100),start('2','b',1100),end('2',1200,'fail',1403),end('1',1500,'ok'),start('3','b',1800)].map(JSON.stringify).join('\n'));
    fs.writeFileSync(stem+'.stream.jsonl',JSON.stringify({id:'1',ttftMs:100,result:'ok'})+'\n');
    const r=spawnSync('python3',['tools/large-report.py',stem+'.meta.json',stem+'.events.jsonl',stem+'.requests.jsonl',stem+'.stream.jsonl',stem+'.analysis.json','2200'],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
    const a=JSON.parse(fs.readFileSync(stem+'.analysis.json'));
    assert.equal(a.totals.issued,3);
    assert.equal(a.totals.succeeded,1);
    assert.equal(a.totals.failed,1);
    assert.equal(a.totals.unresolved,1);
    assert.equal(a.totals.errors.http_4xx,1);
    assert.equal(a.activity[0].completed,0);
    assert.equal(a.activity[1].completed,2);
    assert.equal(a.activity[1].peakInflight,2);
    assert.equal(a.cohorts[0].succeeded,1);
    assert.equal(a.totals.successTtft.count,1);
    assert(a.totals.successLatency.p95 >= 1400 && a.totals.successLatency.p95 <= 1401.401);
    assert(a.totals.successTtft.p95 >= 100 && a.totals.successTtft.p95 <= 100.101);
    assert(a.issues.some(s=>s.includes('2 missing stream')));
    assert.equal(fs.readFileSync(stem+'.requests.jsonl','utf8').trim().split('\n').length,3);
    assert.equal(a.planStartedAt,'2027-01-15T08:00:00.000Z');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('dead meter stops a child process and preserves its final log', {timeout:15000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'supervisor-'));
  const meter=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);
  const log=path.join(dir,'run.log');
  const child=spawn(process.execPath,['tools/run-supervised.js',String(meter.pid),log,process.execPath,'-e',
    'process.on("SIGINT",()=>{console.log("stopped safely");process.exit(105)});console.log("ready");setInterval(()=>{},1000)']);
  child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
  const closed=once(child,'close');
  try {
    await new Promise(r=>setTimeout(r,300));meter.kill('SIGKILL');
    const [code]=await closed;
    assert.equal(code,105);
    assert.match(fs.readFileSync(log,'utf8'),/stopped safely/);
    assert.match(fs.readFileSync(path.join(dir,'run.runner.json'),'utf8'),/meter_exited/);
  }finally{meter.kill('SIGKILL');child.kill('SIGKILL');fs.rmSync(dir,{recursive:true,force:true})}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('network sampler crash is reported without crashing the request process', async () => {
  const { startNetworkSampler } = await import('../lib/network-sampler.js');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'network-worker-'));
  const file=path.join(dir,'crash.cjs');
  fs.writeFileSync(file,'setTimeout(()=>{throw new Error("spawn EBADF")},10)');
  let sampler;
  try {
    const sample=await new Promise(resolve=>{sampler=startNetworkSampler(resolve,file)});
    assert.match(sample.error,/exited/);
    assert.equal(sample.interfaces,undefined);
  } finally {sampler?.stop();fs.rmSync(dir,{recursive:true,force:true})}
});

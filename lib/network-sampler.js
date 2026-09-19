import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function startNetworkSampler(onSample, file = fileURLToPath(new URL('../tools/network-worker.js', import.meta.url))) {
  let stopped = false, child;
  const failed = () => { if (!stopped) onSample({ time: new Date().toISOString(), error: 'Network sampler exited; network coverage is incomplete' }); };
  try {
    child = fork(file, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.on('message', onSample);
    child.on('error', failed);
    child.on('exit', failed);
  } catch { failed(); }
  return { stop() { stopped = true; child?.kill('SIGTERM'); } };
}

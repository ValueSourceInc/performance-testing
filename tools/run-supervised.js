#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const [meter, log, command, ...args] = process.argv.slice(2);
const fd=fs.openSync(log,'a',0o600);
let reason=null, stopping=false, deadline;
const child=spawn(command,args,{stdio:['ignore','pipe','pipe'],detached:true});
const statusFile=log.replace(/\.log$/,'.runner.json');
function stop(why) {
  if(stopping)return;
  stopping=true;reason=why;
  fs.writeFileSync(statusFile,JSON.stringify({reason,time:new Date().toISOString()}),{mode:0o600});
  child.kill('SIGINT');
  deadline=setTimeout(()=>child.kill('SIGKILL'),15000);
  deadline.unref();
}
let terminalOpen=true;
function output(source,chunk){
  fs.writeSync(fd,chunk);
  if(terminalOpen && !process.stdout.write(chunk))source.pause();
}
child.stdout.on('data',chunk=>output(child.stdout,chunk));child.stderr.on('data',chunk=>output(child.stderr,chunk));
process.stdout.on('drain',()=>{child.stdout.resume();child.stderr.resume()});
// A closed terminal pipe must not destroy the saved log or report.
process.stdout.on('error',()=>{terminalOpen=false;child.stdout.resume();child.stderr.resume()});
process.on('SIGINT',()=>stop('user_interrupt'));
process.on('SIGTERM',()=>stop('termination'));
const watcher=setInterval(()=>{
  if(!meter)return;
  try{process.kill(Number(meter),0)}catch{stop('meter_exited')}
},500);
child.on('error',()=>{reason='k6_start_failed'});
child.on('close',(code,signal)=>{
  clearInterval(watcher);clearTimeout(deadline);fs.closeSync(fd);
  fs.writeFileSync(statusFile,JSON.stringify({reason,exitCode:code,signal,time:new Date().toISOString()}),{mode:0o600});
  process.exitCode=reason==='meter_exited'?105:code??1;
});

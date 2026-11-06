// Actual Windows child handles, not EventEmitter/PID or native-engine proof.
import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {controlMediaWorkerChild} from '../media-worker-child-control.mjs';
async function observe(promise) {
  let timer;try{return await Promise.race([promise,new Promise((_,no)=>{timer=setTimeout(()=>no(new Error('SYNTHETIC_OBSERVATION_TIMEOUT')),15000);})]);}
  finally{clearTimeout(timer);}
}
for(const mode of ['stop','disconnect'])test(`real Windows child ${mode} drains held work and confirms OS/stdio termination`,{skip:process.platform!=='win32'},async()=>{
  const instanceId=randomUUID(),env={};
  for(const key of ['SYSTEMROOT','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/media-worker-control-child.mjs',import.meta.url)),instanceId],
    {env,shell:false,windowsHide:true,detached:false,stdio:['pipe','pipe','ignore','ipc']});
  const control=controlMediaWorkerChild(child,{instanceId}),started=Promise.withResolvers(),exited=Promise.withResolvers();
  child.stdin.on('error',()=>{});child.stdout.once('data',(bytes)=>started.resolve(bytes.toString('ascii')));
  child.once('exit',(code,signal)=>exited.resolve({code,signal}));
  child.once('error',()=>{if(!child.pid)exited.resolve({spawnFailed:true});});
  const streamClosed=Promise.all(child.stdio.filter(Boolean).map(stream=>new Promise(yes=>{if(stream.closed)yes();else stream.once('close',yes);})));
  const pending=control.waitForExit();let settled=false;
  pending.then(()=>{settled=true;},()=>{settled=true;});
  try {
    assert.equal(await observe(Promise.race([started.promise,exited.promise.then(()=>{throw new Error('SYNTHETIC_EARLY_EXIT');})])),'WORK_STARTED\n');
    if(mode==='stop'){const stop=control.requestStop();assert.equal(control.requestStop(),stop);assert.deepEqual(await observe(stop),{accepted:true});}
    else child.disconnect();
    await delay(25);assert.equal(settled,false);assert.equal(control.status().terminal,false);
    child.stdin.end('RELEASE\n');
    assert.deepEqual(await observe(exited.promise),{code:mode==='stop'?0:1,signal:null});await observe(streamClosed);
    if(mode==='stop')assert.deepEqual(await observe(pending),{exited:true,exitCode:0,drained:true});
    else await assert.rejects(observe(pending),{code:'MEDIA_WORKER_CONTROL_UNAVAILABLE'});
    assert.equal(control.status().terminal,true);assert.equal(control.status().stdioClosed,true);
    if(mode==='stop')assert.equal(control.status().closeObserved,true);
  } finally {
    if(!child.stdin.writableEnded)child.stdin.end('RELEASE\n');
    // Test observation timeout is never child termination. Independently
    // await this exact process/stdio; no kill, invented close or restart.
    await exited.promise;await streamClosed;
  }
});

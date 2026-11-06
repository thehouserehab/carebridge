import test from 'node:test';
import assert from 'node:assert/strict';
import {ChildProcess} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {observeNativeWorkerAdmission} from '../native-worker-admission.mjs';
import {syntheticWorkerAdmissionFrame} from '../windows-synthetic-worker-policy.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const denied={message:'NATIVE_WORKER_ADMISSION_FAILED'};
function fixture(mode='complete',milliseconds=30000){
  const child=new ChildProcess(),instanceId=randomUUID(),terminal=Promise.withResolvers();
  child.stdout=new PassThrough();
  const state={controlReady:false,terminal:false,stopRequested:false,failureCode:null};let requests=0;
  const control={status:()=>({...state}),requestStop:()=>{requests++;state.stopRequested=true;return Promise.resolve();},
    waitForExit:()=>terminal.promise};
  const observation=observeNativeWorkerAdmission(child,control,{instanceId,mode,observationMilliseconds:milliseconds});
  return {child,instanceId,terminal,state,observation,get requests(){return requests;},
    frame:Buffer.from(syntheticWorkerAdmissionFrame(instanceId)),
    async finish(){state.terminal=true;terminal.resolve();child.stdout.destroy();await tick();}};
}
test('bootstrap/control-ready alone never authorizes native browser start',async()=>{
  const f=fixture();let ready=false;f.observation.ready.then(()=>{ready=true;},()=>{});
  f.state.controlReady=true;f.child.emit('message',{});await tick();assert.equal(ready,false);
  for(const byte of f.frame)f.child.stdout.write(Uint8Array.of(byte));
  await f.observation.ready;assert.equal(f.observation.status().admitted,true);assert.equal(f.requests,0);
  await f.finish();assert.equal(f.child.stdout.listenerCount('data'),0);
});
test('admission frame must also match the owned control-ready state',async()=>{
  const f=fixture();f.child.stdout.write(f.frame);await tick();assert.equal(f.observation.status().admitted,false);
  f.state.controlReady=true;f.child.emit('message',{});await f.observation.ready;await f.finish();
});
test('worker failure rejects readiness before OS termination without inventing terminal evidence',async()=>{
  const f=fixture();f.state.controlReady=true;f.state.failureCode='MEDIA_WORKER_CONTROL_UNAVAILABLE';
  f.child.emit('message',{});await assert.rejects(f.observation.ready,denied);
  assert.equal(f.state.terminal,false);assert.equal(f.observation.status().admitted,false);await f.finish();
});
test('partial, foreign, extra and out of order frames fail without retaining arbitrary output',async()=>{
  for(const bytes of [Buffer.from('NATIVE_PREPARING\n'),Buffer.from('synthetic-private-text'),
    Buffer.from(syntheticWorkerAdmissionFrame(randomUUID()))]){
    const f=fixture();f.state.controlReady=true;f.child.stdout.write(bytes);
    await assert.rejects(f.observation.ready,denied);assert.equal(f.requests,1);
    assert.equal(JSON.stringify(f.observation.status()).includes('private'),false);await f.finish();
  }
  const f=fixture();f.state.controlReady=true;f.child.stdout.end(f.frame.subarray(0,8));
  await assert.rejects(f.observation.ready,denied);await f.finish();
});
test('held input marker is accepted once only after actual admission, including a coalesced chunk',async()=>{
  const f=fixture('hold-input');f.state.controlReady=true;
  f.child.stdout.write(Buffer.concat([f.frame,Buffer.from('NATIVE_PREPARING\n')]));
  await f.observation.ready;assert.equal(f.observation.status().preparing,true);
  f.child.stdout.write(Buffer.from('NATIVE_PREPARING\n'));assert.equal(f.observation.status().invalidOutput,true);
  assert.equal(f.requests,1);await f.finish();
});
test('complete mode rejects extra stdout even after a valid readiness signal',async()=>{
  const f=fixture();f.state.controlReady=true;f.child.stdout.write(f.frame);await f.observation.ready;
  f.child.stdout.write(Buffer.from('synthetic-extra'));
  assert.equal(f.observation.status().admitted,true);assert.equal(f.observation.status().invalidOutput,true);
  assert.equal(f.requests,1);assert.equal(f.state.terminal,false);await f.finish();
});
test('a failure immediately after readiness remains visible in control and cannot imply clean termination',async()=>{
  const f=fixture();f.state.controlReady=true;f.child.stdout.write(f.frame);
  f.state.failureCode='MEDIA_WORKER_CONTROL_UNAVAILABLE';f.child.emit('message',{});
  await f.observation.ready; // Historical admission only; never lifetime success.
  assert.equal(f.observation.status().admitted,true);assert.equal(f.state.failureCode,'MEDIA_WORKER_CONTROL_UNAVAILABLE');
  assert.equal(f.state.terminal,false);await f.finish();
});
test('deadline fails admission and requests only cooperative stop without settling the child lifetime',async()=>{
  const f=fixture('complete',5);await new Promise(resolve=>setTimeout(resolve,20));
  await assert.rejects(f.observation.ready,denied);assert.equal(f.observation.status().observationTimedOut,true);
  assert.equal(f.requests,1);assert.equal(f.state.terminal,false);
  f.state.controlReady=true;f.child.stdout.write(f.frame);assert.equal(f.observation.status().admitted,false);await f.finish();
});
test('disconnect and terminal failure end admission wait; all owned observation listeners are removed',async()=>{
  for(const event of ['disconnect','exit','terminal']){
    const f=fixture();
    if(event==='terminal')f.terminal.reject(new Error('synthetic-private-fault'));else f.child.emit(event);
    await assert.rejects(f.observation.ready,denied);await f.finish();
    for(const name of ['message','error','disconnect','exit','close'])assert.equal(f.child.listenerCount(name),0);
    assert.equal(f.child.stdout.listenerCount('data'),0);
  }
});

// Protocol/lifetime doubles only; real Windows child handles are tested on E.
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mediaWorkerControlMessage as message,parseMediaWorkerControlMessage as parse} from '../media-worker-control-protocol.mjs';
import {runMediaWorkerControlledProcess} from '../media-worker-controlled-process.mjs';
import {controlMediaWorkerChild} from '../media-worker-child-control.mjs';
const denied={code:'MEDIA_WORKER_CONTROL_UNAVAILABLE'},tick=() => new Promise((yes) => setImmediate(yes));
function target({sendError,backpressure=false,exitCode} = {}) {
  const process=new EventEmitter();Object.assign(process,{connected:true,channel:{},exitCode,sent:[],disconnects:0});
  process.send=(value,callback) => {process.sent.push(value);queueMicrotask(() => callback(sendError));return !backpressure;};
  process.disconnect=() => {process.disconnects++;process.connected=false;process.emit('disconnect');};return process;
}
function child({backpressure=false,sendError} = {}) {
  const process=new ChildProcess();Object.assign(process,{connected:true,exitCode:null,signalCode:null,sent:[]});
  process.send=(value,callback) => {process.sent.push(value);queueMicrotask(() => callback(sendError));return !backpressure;};return process;
}
const finish=(child,code=0,signal=null) => {child.exitCode=code;child.signalCode=signal;child.emit('exit',code,signal);child.emit('close',code,signal);};

test('wire format is frozen, bounded and rejects data/config/handles, wrong run or direction',() => {
  const id=randomUUID(),request=randomUUID(),valid=message(id,'stop',request);assert.ok(Object.isFrozen(valid));
  assert.deepEqual(parse(valid,id,'parent'),valid);
  for(const value of [null,[],{}, {...valid,body:'private'}, {...valid,schema:'1'}, {...valid,instanceId:randomUUID()},
    {...valid,requestId:null},{...valid,purpose:'other'},{...valid,kind:'config'}]) assert.throws(() => parse(value,id,'parent'),denied);
  assert.throws(() => parse(valid,id,'child'),denied);assert.throws(() => parse(valid,id,'parent',{}),denied);
  assert.throws(() => message(id,'control-ready',request),denied);assert.throws(() => message('not-a-run','drained'),denied);
});
test('child publishes control readiness, drains after an idempotent stop and disconnects only after its report',async () => {
  const id=randomUUID(),request=randomUUID(),process=target({backpressure:true}),release=Promise.withResolvers();let signal,done=false;
  const pending=runMediaWorkerControlledProcess(async (value) => {signal=value;await release.promise;return {stopped:true,processed:1};},
    {instanceId:id,targetProcess:process}).finally(() => {done=true;});
  await tick();assert.equal(process.sent[0].kind,'control-ready');assert.equal(signal.aborted,false);
  process.emit('message',message(id,'stop',request));process.emit('message',message(id,'stop',request));await tick();
  assert.equal(signal.aborted,true);assert.equal(done,false);assert.equal(process.disconnects,0);
  assert.deepEqual(process.sent.map((value) => value.kind),['control-ready','stop-accepted']);
  release.resolve();assert.deepEqual(await pending,{drained:true});
  assert.deepEqual(process.sent.map((value) => value.kind),['control-ready','stop-accepted','drained']);
  assert.equal(process.disconnects,1);assert.equal(process.listenerCount('message'),0);assert.equal(process.listenerCount('disconnect'),0);
  assert.equal(process.exitCode,undefined);assert.ok(process.sent.every((value) => Object.keys(value).length===5));
});
test('child waits for active work after channel loss and returns a fixed failure without a false drain',async () => {
  const id=randomUUID(),process=target(),release=Promise.withResolvers();let signal,done=false;
  const pending=runMediaWorkerControlledProcess(async (value) => {signal=value;await release.promise;return {stopped:true,processed:0};},
    {instanceId:id,targetProcess:process});const rejected=assert.rejects(pending,denied).then(() => {done=true;});
  await tick();process.connected=false;process.emit('disconnect');await tick();assert.equal(signal.aborted,true);assert.equal(done,false);
  release.resolve();await rejected;assert.equal(process.exitCode,1);assert.deepEqual(process.sent.map((value) => value.kind),['control-ready']);
});
test('malformed, stale-run, attached-handle and conflicting stop commands fail closed after draining',async () => {
  for(const mode of ['unknown','stale','handle','conflict']) {
    const id=randomUUID(),process=target(),release=Promise.withResolvers();let signal;
    const pending=runMediaWorkerControlledProcess(async (value) => {signal=value;await release.promise;return {stopped:true,processed:0};},
      {instanceId:id,targetProcess:process});const rejected=assert.rejects(pending,denied);await tick();
    if(mode==='conflict')process.emit('message',message(id,'stop',randomUUID()));
    const value=mode==='unknown'?{...message(id,'stop',randomUUID()),credentials:'never'}:message(mode==='stale'?randomUUID():id,'stop',randomUUID());
    process.emit('message',value,...(mode==='handle'?[{}]:[]));assert.equal(signal.aborted,true);release.resolve();await rejected;
    assert.equal(process.exitCode,1);assert.equal(process.sent.at(-1).kind,'failed');assert.equal(process.sent.some((value) => value.kind==='drained'),false);
  }
});
test('child work and send failures are redacted and preserve pre-existing process failure',async () => {
  for(const mode of ['work','send']) {
    const process=target({exitCode:7,...(mode==='send'?{sendError:new Error('private transport')}: {})});let invoked=false;
    await assert.rejects(runMediaWorkerControlledProcess(async () => {invoked=true;throw new Error('private clinical diagnostics');},
      {instanceId:randomUUID(),targetProcess:process}),(error) => error.code===denied.code && !error.cause && !JSON.stringify(error).includes('private'));
    assert.equal(process.exitCode,7);assert.equal(invoked,mode==='work');assert.equal(process.listenerCount('message'),0);
  }
});
test('child refuses foreign IPC owners and duplicate registration without interrupting existing work',async () => {
  const id=randomUUID(),process=target(),release=Promise.withResolvers();
  const pending=runMediaWorkerControlledProcess(async () => {await release.promise;return {stopped:true,processed:0};},{instanceId:id,targetProcess:process});
  await tick();await assert.rejects(runMediaWorkerControlledProcess(() => assert.fail('duplicate'),{instanceId:id,targetProcess:process}),denied);
  release.resolve();await pending;
  const foreign=target(),listener=()=>{};foreign.on('message',listener);
  await assert.rejects(runMediaWorkerControlledProcess(() => assert.fail('foreign'),{instanceId:id,targetProcess:foreign}),denied);
  assert.deepEqual(foreign.listeners('message'),[listener]);assert.equal(foreign.sent.length,0);
});
test('child input validation and partial registration have no work or stranded listener',async () => {
  for(const options of [null,{}, {instanceId:'bad'},{instanceId:randomUUID(),force:true},{instanceId:randomUUID(),targetProcess:{}},{instanceId:randomUUID(),targetProcess:null}])
    await assert.rejects(runMediaWorkerControlledProcess(() => assert.fail('invalid'),options),denied);
  const process=target(),original=process.on;process.on=function(name,listener){if(name==='disconnect')throw new Error('private registration');return original.call(this,name,listener);};
  await assert.rejects(runMediaWorkerControlledProcess(() => assert.fail('registration'),{instanceId:randomUUID(),targetProcess:process}),denied);
  assert.equal(process.listenerCount('message'),0);assert.equal(process.exitCode,1);
});
test('child seals terminal reporting against a late stop instead of queueing acceptance after drain',async () => {
  const id=randomUUID(),process=target(),reported=Promise.withResolvers();let complete;
  process.send=(value,callback)=>{process.sent.push(value);if(value.kind==='drained'){complete=callback;reported.resolve();}else queueMicrotask(()=>callback());return true;};
  const pending=runMediaWorkerControlledProcess(async()=>({stopped:true,processed:0}),{instanceId:id,targetProcess:process});
  const rejected=assert.rejects(pending,denied);await reported.promise;process.emit('message',message(id,'stop',randomUUID()));
  complete();await rejected;assert.deepEqual(process.sent.map(value=>value.kind),['control-ready','drained']);assert.equal(process.exitCode,1);
});
test('parent queues one stop before readiness and distinguishes acceptance, drain, exit and close',async () => {
  const id=randomUUID(),process=child({backpressure:true}),control=controlMediaWorkerChild(process,{instanceId:id});
  const first=control.requestStop();assert.equal(control.requestStop(),first);assert.equal(process.sent.length,0);
  process.emit('message',message(id,'control-ready'));const request=process.sent[0].requestId;
  let accepted=false,terminal=false;first.then(() => {accepted=true;});control.waitForExit().then(() => {terminal=true;});
  await tick();assert.equal(accepted,false);assert.equal(terminal,false);
  process.emit('message',message(id,'stop-accepted',request));assert.deepEqual(await first,{accepted:true});
  process.emit('message',message(id,'drained',request));process.connected=false;process.emit('disconnect');await tick();assert.equal(terminal,false);
  process.exitCode=0;process.emit('exit',0,null);assert.equal(control.status().terminal,false);
  process.emit('close',0,null);assert.deepEqual(await control.waitForExit(),{exited:true,exitCode:0,drained:true});
  assert.equal(control.status().terminal,true);assert.equal(process.sent.length,1);assert.equal(process.listenerCount('message'),0);
});
test('parent protocol fault requests only one cooperative stop and waits for actual terminal evidence',async () => {
  const id=randomUUID(),process=child(),control=controlMediaWorkerChild(process,{instanceId:id});let done=false;
  const rejected=assert.rejects(control.waitForExit(),denied).then(() => {done=true;});
  process.emit('message',{...message(id,'control-ready'),body:'private'});await tick();
  assert.equal(done,false);assert.equal(control.status().failureCode,denied.code);assert.equal(process.sent.length,1);
  process.emit('message',message(randomUUID(),'failed'));process.connected=false;process.emit('disconnect');await tick();assert.equal(done,false);
  finish(process,1);await rejected;assert.equal(process.sent.length,1);assert.equal(control.status().terminal,true);
  await assert.rejects(control.requestStop(),denied);
});
test('parent cannot promote drain without stop acceptance or a nonzero/missing exit to success',async () => {
  for(const mode of ['no-acceptance','nonzero','no-exit','no-drain','signal']) {
    const id=randomUUID(),process=child(),control=controlMediaWorkerChild(process,{instanceId:id});
    process.emit('message',message(id,'control-ready'));const stop=control.requestStop();stop.catch(()=>{});const request=process.sent[0].requestId;
    if(mode!=='no-acceptance')process.emit('message',message(id,'stop-accepted',request));
    if(mode!=='no-drain')process.emit('message',message(id,'drained',request));
    if(mode==='no-exit')process.emit('close',0,null);else finish(process,mode==='nonzero'?1:0,mode==='signal'?'SIGKILL':null);
    await assert.rejects(control.waitForExit(),denied);assert.equal(control.status().terminal,true);
  }
});
test('parent disconnect and send errors stay latched even if a later drain and exit look successful',async () => {
  for(const mode of ['disconnect','send']) {
    const id=randomUUID(),process=child(mode==='send'?{sendError:new Error('private send')}:{}),control=controlMediaWorkerChild(process,{instanceId:id});
    process.emit('message',message(id,'control-ready'));const stop=control.requestStop();const rejected=assert.rejects(stop,denied),request=process.sent[0].requestId;
    if(mode==='disconnect'){process.connected=false;process.emit('disconnect');}await tick();await rejected;
    process.emit('message',message(id,'stop-accepted',request));process.emit('message',message(id,'drained',request));finish(process);
    await assert.rejects(control.waitForExit(),denied);assert.equal(control.status().failureCode,denied.code);
  }
});
test('parent acceptance may precede a late send error but actual exit verdict still fails',async () => {
  const id=randomUUID(),process=child();let callback;process.send=(value,done)=>{process.sent.push(value);callback=done;return true;};
  const control=controlMediaWorkerChild(process,{instanceId:id});process.emit('message',message(id,'control-ready'));const stop=control.requestStop(),request=process.sent[0].requestId;
  process.emit('message',message(id,'stop-accepted',request));assert.deepEqual(await stop,{accepted:true});callback(new Error('private late send'));
  process.emit('message',message(id,'drained',request));finish(process);await assert.rejects(control.waitForExit(),denied);
});
test('parent waits for a pending send callback even after actual close so a late failure cannot become success',async () => {
  const id=randomUUID(),process=child();let callback,done=false;
  process.send=(value,complete)=>{process.sent.push(value);callback=complete;return false;};
  const control=controlMediaWorkerChild(process,{instanceId:id});process.emit('message',message(id,'control-ready'));
  const accepted=control.requestStop(),request=process.sent[0].requestId;process.emit('message',message(id,'stop-accepted',request));await accepted;
  process.emit('message',message(id,'drained',request));finish(process);
  const rejected=assert.rejects(control.waitForExit(),denied).then(()=>{done=true;});await tick();assert.equal(done,false);assert.equal(control.status().terminal,true);
  callback(new Error('private callback after close'));await rejected;assert.equal(control.status().failureCode,denied.code);
});
test('parent status snapshots are immutable and omit run IDs or data; it refuses foreign or terminal handles',async () => {
  const id=randomUUID(),process=child(),control=controlMediaWorkerChild(process,{instanceId:id}),before=control.status();
  assert.ok(Object.isFrozen(control)&&Object.isFrozen(before));assert(!JSON.stringify(before).includes(id));assert.equal(before.phase,'awaiting-control');
  assert.throws(()=>controlMediaWorkerChild(process,{instanceId:id}),denied);process.emit('message',message(id,'control-ready'));process.emit('message',message(id,'drained'));finish(process);
  await control.waitForExit();assert.equal(before.terminal,false);assert.equal(control.status().terminal,true);
  assert.throws(()=>controlMediaWorkerChild(process,{instanceId:id}),denied);
  const foreign=child();foreign.on('message',()=>{});assert.throws(()=>controlMediaWorkerChild(foreign,{instanceId:id}),denied);
  assert.throws(()=>controlMediaWorkerChild(new EventEmitter(),{instanceId:id}),denied);
});
test('parent channel already lost or spawn error waits for close instead of claiming a running child',async () => {
  const process=child();process.connected=false;const control=controlMediaWorkerChild(process,{instanceId:randomUUID()});
  process.emit('error',new Error('private native spawn'));let done=false;const rejected=assert.rejects(control.waitForExit(),denied).then(()=>{done=true;});
  await tick();assert.equal(done,false);process.emit('close',-1,null);await rejected;assert.equal(control.status().terminal,true);
});

test('failed parent disconnect may settle without Node close only after actual exit and every captured stream close',async () => {
  const process=child(),pipe=new EventEmitter();pipe.closed=false;process.stdio=[null,pipe,null,null];
  const control=controlMediaWorkerChild(process,{instanceId:randomUUID()});let done=false;
  const rejected=assert.rejects(control.waitForExit(),denied).then(()=>{done=true;});
  process.connected=false;process.channel=null;process.emit('disconnect');await tick();assert.equal(done,false);
  process.emit('exit',1,null);await tick();assert.equal(done,false);assert.equal(control.status().terminal,false);
  // Replacing the caller's array cannot hide a captured outstanding pipe.
  process.stdio=[];await tick();assert.equal(done,false);
  pipe.closed=true;pipe.emit('close');await rejected;
  assert.equal(control.status().terminal,true);assert.equal(control.status().closeObserved,false);
  assert.equal(control.status().stdioClosed,true);assert.equal(control.status().exitCode,1);
  assert.equal(pipe.listenerCount('close'),0);assert.equal(pipe.listenerCount('error'),0);
});

test('all closed streams without an OS exit or a failed channel cannot fabricate successful terminal evidence',async () => {
  for(const mode of ['no-exit','healthy']) {
    const process=child(),pipe=new EventEmitter();pipe.closed=false;process.stdio=[pipe];
    const id=randomUUID(),control=controlMediaWorkerChild(process,{instanceId:id});let done=false;
    const result=control.waitForExit().then(()=>{done=true;},()=>{done=true;});
    if(mode==='no-exit'){process.connected=false;process.channel=null;process.emit('disconnect');}
    else {process.emit('message',message(id,'control-ready'));process.emit('message',message(id,'drained'));process.emit('exit',0,null);}
    pipe.closed=true;pipe.emit('close');await tick();assert.equal(done,false);assert.equal(control.status().terminal,false);
    if(mode==='no-exit')process.emit('exit',1,null);else process.emit('close',0,null);
    await result;assert.equal(control.status().terminal,true);
  }
});

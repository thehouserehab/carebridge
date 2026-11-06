import test from 'node:test';
import assert from 'node:assert/strict';
import {ownSyntheticSession} from '../synthetic-session-lifetime.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const log=[],closed=Promise.withResolvers(),children={};let cleared=0;
  const seed={credentials:[{role:'therapist',email:'synthetic@test.test',password:'synthetic-only'}],forgetCredentials(){cleared++;}};
  const child=kind=>{const done=Promise.withResolvers();let terminal=false,stopRequested=false;
    const handle={close(){stopRequested=true;log.push(`${kind}:stop`);terminal=true;done.resolve();return done.promise;},
      status:()=>({ready:!stopRequested,terminal,stopRequested}),waitForExit:()=>done.promise,fail(){terminal=true;done.reject(Error('private'));}};
    children[kind]=handle;return handle;};
  const storage={seed,initialize:async()=>{log.push('storage:start');},closeConnections:async()=>{log.push('connections:close');},
    stopDatabase:async()=>{log.push('database:stop');},disposeSecrets:async()=>{log.push('secrets:dispose');},status:()=>({})};
  const plan={storage:()=>storage,media:async({onOwned})=>{const value={scanner:{status:async()=>({available:true})},close:async()=>{log.push('media:close');}};onOwned(value);return value;},
    worker:async({onOwned})=>{const result=child('worker');onOwned(result);return result;},
    api:async({onOwned})=>{const result=child('api');onOwned(result);return {origin:'http://127.0.0.1:12345',...result};}};
  return {log,children,storage,plan,seed,closed,cleared:()=>cleared};
}
test('ready requires actual scanner, worker admission and API then ordered actual cleanup',async()=>{
  const f=fixture(),session=ownSyntheticSession(f.plan);assert.equal(session.status().ready,false);
  assert.deepEqual(await session.ready,{origin:'http://127.0.0.1:12345'});assert.equal(session.status().ready,true);
  assert.equal(JSON.stringify(session).includes('synthetic-only'),false);
  const close=session.close();assert.equal(session.close(),close);assert.deepEqual(await close,{stopped:true,failed:false});
  assert.equal(session.status().phase,'stopped');assert.equal(session.credentials.length,0);
  assert(f.log.indexOf('api:stop')<f.log.indexOf('worker:stop'));
  assert(f.log.indexOf('worker:stop')<f.log.indexOf('connections:close'));
  assert(f.log.indexOf('database:stop')<f.log.indexOf('media:close'));
  assert(f.log.indexOf('media:close')<f.log.indexOf('secrets:dispose'));
});
test('stop before first allocation never starts storage or claims ready',async()=>{
  const f=fixture(),session=ownSyntheticSession(f.plan);const close=session.close();
  await assert.rejects(session.ready);await close;assert.deepEqual(f.log,[]);assert.equal(session.status().phase,'stopped');
});
test('stop during storage waits for same initializer and does not start engines',async()=>{
  const f=fixture(),gate=Promise.withResolvers();f.storage.initialize=()=>gate.promise;
  const session=ownSyntheticSession(f.plan);await tick();let done=false;const close=session.close().then(()=>{done=true;});
  await tick();assert.equal(done,false);assert.deepEqual(f.log,[]);gate.resolve();await assert.rejects(session.ready);await close;
  assert.deepEqual(f.log,['connections:close','database:stop','secrets:dispose']);
});
test('stop interrupts a registered worker admission before waiting on startup',async()=>{
  const f=fixture(),entered=Promise.withResolvers(),gate=Promise.withResolvers();
  f.plan.worker=async({onOwned})=>{const done=Promise.withResolvers();let terminal=false;
    const worker={status:()=>({ready:false,terminal}),waitForExit:()=>done.promise,close:async()=>{terminal=true;done.resolve();gate.reject(Error());}};
    onOwned(worker);entered.resolve();await gate.promise;};
  const session=ownSyntheticSession(f.plan);await entered.promise;await session.close();await assert.rejects(session.ready);
  assert.equal(session.status().phase,'stopped');assert.equal(f.children.api,undefined);
});
test('runtime worker loss closes the API and retains failed outcome',async()=>{
  const f=fixture(),session=ownSyntheticSession(f.plan);await session.ready;f.children.worker.fail();
  assert.deepEqual(await session.waitForStop(),{stopped:true,failed:true});assert(f.log.includes('api:stop'));
});
test('nonterminal child stop failure blocks DB/engine/key cleanup and allows same-handle recheck',async()=>{
  const f=fixture(),session=ownSyntheticSession(f.plan);await session.ready;const original=f.children.api.close;let actualTerminal=false;
  f.children.api.close=async()=>{if(!actualTerminal)throw Error();return original();};
  await assert.rejects(session.close());assert.equal(session.status().phase,'stop-unconfirmed');
  assert.equal(f.log.includes('database:stop'),false);assert.equal(f.log.includes('media:close'),false);
  actualTerminal=true;await session.close();assert.equal(session.status().phase,'stopped');
});
test('unavailable scanner never opens worker/API and cleans known owned storage',async()=>{
  const f=fixture();f.plan.media=async({onOwned})=>{const value={scanner:{status:async()=>({available:false})},close:async()=>{f.log.push('media:close');}};onOwned(value);return value;};
  const session=ownSyntheticSession(f.plan);await assert.rejects(session.ready);await session.close();
  assert.equal(f.children.worker,undefined);assert.equal(f.children.api,undefined);assert.equal(session.status().failed,true);
});
test('a worker fault during API admission cannot become session ready while termination is pending',async()=>{
  const f=fixture(),apiGate=Promise.withResolvers(),entered=Promise.withResolvers(),originalApi=f.plan.api;
  f.plan.api=async options=>{entered.resolve();await apiGate.promise;return originalApi(options);};
  const session=ownSyntheticSession(f.plan);await entered.promise;
  f.children.worker.status=()=>({ready:true,terminal:false,stopRequested:true,failureCode:'WORKER_FAILED'});
  // Its stop completes the same owned lifetime; ready must reject before it.
  const originalClose=f.children.worker.close;
  f.children.worker.close=async()=>{await originalClose();f.children.worker.status=()=>({ready:true,terminal:true});};
  apiGate.resolve();await assert.rejects(session.ready);await session.close();assert.equal(session.status().failed,true);
});
test('worker unavailability closes API promptly but waits for actual worker drain before DB cleanup',async()=>{
  const f=fixture(),notice=Promise.withResolvers(),drain=Promise.withResolvers(),original=f.plan.worker;
  f.plan.worker=async options=>{
    const value=await original({onOwned:()=>{}});
    value.waitForUnavailable=()=>notice.promise;
    const close=value.close;value.close=async()=>{await drain.promise;return close();};
    options.onOwned(value);return value;
  };
  const session=ownSyntheticSession(f.plan);await session.ready;notice.resolve({unavailable:true});await tick();
  assert(f.log.includes('api:stop'));assert.equal(f.log.includes('database:stop'),false);assert.equal(session.status().ready,false);
  drain.resolve();assert.deepEqual(await session.waitForStop(),{stopped:true,failed:true});assert(f.log.includes('secrets:dispose'));
});

// Model the two real observer contracts separately: the worker reports
// stopAccepted/drainReported, not the API observer's `stopped` field.
function strictTerminalFixture({workerTerminal={},apiTerminal={},rejectClose=null}={}){
  const f=fixture(),disposals=[];
  f.storage.disposeSecrets=async options=>{disposals.push(structuredClone(options));f.log.push('secrets:dispose');};
  const child=kind=>{
    const done=Promise.withResolvers();let terminal=false;
    const state=()=>({ready:true,terminal,stopRequested:terminal,closeObserved:terminal,stdioClosed:terminal,
      exitCode:terminal?0:null,signalCode:null,failureCode:null,spawnFailed:false,observationTimedOut:false,
      ...(kind==='worker'?{stopAccepted:terminal,drainReported:terminal}:{stopped:terminal}),
      ...(terminal?(kind==='worker'?workerTerminal:apiTerminal):{})});
    const handle={status:state,waitForExit:()=>done.promise,close:async()=>{
      f.log.push(`${kind}:stop`);terminal=true;done.resolve();
      if(rejectClose===kind)throw Error('synthetic-only failure');
    }};
    f.children[kind]=handle;return handle;
  };
  f.plan.worker=async({onOwned})=>{const value=child('worker');onOwned(value);return value;};
  f.plan.api=async({onOwned})=>{const value=child('api');onOwned(value);return {origin:'http://127.0.0.1:12345',...value};};
  return {...f,disposals};
}

test('clean retention uses the real worker drain shape without an API stopped field',async()=>{
  const f=strictTerminalFixture(),session=ownSyntheticSession(f.plan);await session.ready;
  assert.equal(Object.hasOwn(f.children.worker.status(),'stopped'),false);
  assert.deepEqual(await session.close(),{stopped:true,failed:false});
  assert.equal(Object.hasOwn(f.children.worker.status(),'stopped'),false);
  assert.equal(f.children.worker.status().drainReported,true);
  assert.deepEqual(f.disposals,[{clean:true}]);
  assert(f.log.indexOf('worker:stop')<f.log.indexOf('database:stop'));
  assert(f.log.indexOf('media:close')<f.log.indexOf('secrets:dispose'));
});

for(const [label,workerTerminal] of [
  ['missing drain',{drainReported:undefined}],
  ['unaccepted stop',{stopAccepted:false}],
  ['missing child close',{closeObserved:false}],
  ['missing closed stdio',{stdioClosed:undefined}],
  ['nonzero exit',{exitCode:1}],
  ['signal termination',{signalCode:'SIGTERM'}],
  ['reported failure',{failureCode:'WINDOWS_SYNTHETIC_WORKER_UNAVAILABLE'}],
  ['spawn failure',{spawnFailed:true}],
  ['observation timeout',{observationTimedOut:true}],
])test(`terminal worker with ${label} cannot certify clean retained storage`,async()=>{
  const f=strictTerminalFixture({workerTerminal}),session=ownSyntheticSession(f.plan);await session.ready;
  await session.close();assert.equal(session.status().phase,'stopped');
  assert.deepEqual(f.disposals,[{clean:false}]);
});

test('a failed child close cannot certify retention even if its final public evidence looks clean',async()=>{
  const f=strictTerminalFixture({rejectClose:'worker'}),session=ownSyntheticSession(f.plan);await session.ready;
  assert.deepEqual(await session.close(),{stopped:true,failed:true});
  assert.deepEqual(f.disposals,[{clean:false}]);
});

test('clean worker evidence never replaces the separate strict API stopped proof',async()=>{
  const f=strictTerminalFixture({apiTerminal:{stopped:undefined}}),session=ownSyntheticSession(f.plan);await session.ready;
  await session.close();assert.deepEqual(f.disposals,[{clean:false}]);
});

test('complete child drain after startup cancellation does not certify an ever-unready session',async()=>{
  const f=strictTerminalFixture(),gate=Promise.withResolvers(),entered=Promise.withResolvers(),launch=f.plan.api;
  f.plan.api=async options=>{const result=await launch(options);entered.resolve();await gate.promise;return result;};
  const session=ownSyntheticSession(f.plan);await entered.promise;
  const closing=session.close();await tick();assert.deepEqual(f.disposals,[]);
  gate.resolve();await assert.rejects(session.ready);
  assert.deepEqual(await closing,{stopped:true,failed:false});
  assert.equal(f.children.api.status().stopped,true);assert.equal(f.children.worker.status().drainReported,true);
  assert.deepEqual(f.disposals,[{clean:false}]);
});

test('legacy minimal lifecycle doubles remain insufficient for clean retention',async()=>{
  const f=fixture(),disposals=[];f.storage.disposeSecrets=async value=>{disposals.push(value);};
  const session=ownSyntheticSession(f.plan);await session.ready;await session.close();
  assert.deepEqual(disposals,[{clean:false}]);
});

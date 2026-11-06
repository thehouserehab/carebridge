// Driver/catalog/worker doubles only. Actual Windows/E/DPAPI/TLS queue work is
// a separate opt-in fixture; these tests prove ownership and race contracts.
import test,{mock,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {WindowsDatabaseCredentialStore} from '../windows-database-credential-store.mjs';
import {runWindowsMediaWorkerProcess} from '../windows-media-worker-process.mjs';
import {withMediaWorkerProcessLifetime} from '../media-worker-process.mjs';
import {MediaWorkQueueWorker} from '../media-work-queue-worker.mjs';
import {PrivateFileStore} from '../private-file-store.mjs';
import {LocalClamAvClient} from '../clamav-client.mjs';
import {serviceInput,serviceCatalog} from './database-service-fixtures.mjs';
afterEach(() => mock.restoreAll());
const denied = {code:'MEDIA_WORKER_UNAVAILABLE'};
const windowsOnly = {skip:process.platform !== 'win32'};
const tick = () => new Promise((yes) => setImmediate(yes));
function configuration() {
  const native = () => assert.fail('No native engine in lifecycle unit tests');
  return {database:{storage:{base:'E:\\CarebridgeBeta',powershell:'C:\\Tools\\pwsh.exe',syntheticRunId:randomUUID()},
    credentialId:randomUUID(),privileges:serviceInput(),endpoint:{host:'127.0.0.1',port:54321}},
  media:{store:new PrivateFileStore(join(tmpdir(),'carebridge-owned-worker-'+randomUUID())),
    scanner:new LocalClamAvClient({endpoint:{host:'127.0.0.1',port:65535},approvedEngineVersions:['1.4.6'],daemonTimeZone:'UTC'}),
    runtime:{identity:native,inspect:native,docker:native,exchange:native},engineIdentity:'synthetic-owned-worker',approvedImageId:'sha256:'+'a'.repeat(64)}};
}
async function fixture({load,start,end,kind='worker',query} = {}) {
  const catalog = serviceCatalog(); catalog.state.kind=kind;let catalogQuery;
  await catalog.database.transaction((tx) => {catalogQuery=tx.query;});
  const state = {loads:0,pools:[],buffers:[],starts:0,ended:0,queries:[]};
  mock.method(WindowsDatabaseCredentialStore.prototype,'load',async function(...args) {
    state.loads++;const bytes = load ? await load(state,args) : Buffer.alloc(64,65);state.buffers.push(bytes);return bytes;
  });
  mock.method(Pool.prototype,'connect',async function() {
    if (!state.pools.includes(this)) state.pools.push(this);
    await this.options.password();
    return Object.assign(new EventEmitter(),{release() {},query:async (sql,params) => {
      state.queries.push(sql);await query?.(state,sql);
      if (['BEGIN','COMMIT','ROLLBACK','SET TRANSACTION READ ONLY'].includes(sql)) return {rows:[]};
      return catalogQuery(sql,params);
    }});
  });
  mock.method(Pool.prototype,'end',async function() {state.ended++;await end?.(state);});
  mock.method(MediaWorkQueueWorker.prototype,'start',async function({signal}) {
    state.starts++;return start ? start(signal,state) : {stopped:true,processed:0};
  });
  return {state,catalog};
}

test('owned process validates all worker/DB settings before credentials, signals or engine IO',async () => {
  const {state}=await fixture(),target=new EventEmitter(),base=configuration();
  for (const value of [null,{}, {...base,force:true},{...base,database:{...base.database,kind:'runtime'}},
    {...base,database:{...base.database,password:'private'}},{...base,media:{...base.media,localTestMode:true}},
    {...base,media:{...base.media,worker:{}}},{...base,media:{...base.media,capacity:3}},
    {...base,media:{...base.media,pollMilliseconds:49}},{...base,media:{...base.media,runtime:{}}},
    {...base,media:{...base.media,scanner:{}}}])
    await assert.rejects(runWindowsMediaWorkerProcess(value,{targetProcess:target}),denied);
  assert.equal(state.loads,0);assert.equal(state.pools.length,0);assert.equal(target.eventNames().length,0);
});
test('explicit pre-aborted stop performs no credential, DB or worker work',async () => {
  const {state}=await fixture(),controller=new AbortController(),target=new EventEmitter();controller.abort();
  const result=await runWindowsMediaWorkerProcess(configuration(),{targetProcess:target,signal:controller.signal});
  assert.deepEqual(result,{stopped:true,processed:0});assert.ok(Object.isFrozen(result));
  assert.equal(state.loads,0);assert.equal(state.starts,0);assert.equal(state.ended,0);assert.equal(target.eventNames().length,0);
});
test('stop during secret startup waits for settlement, zeros bytes and closes without starting a poll',windowsOnly,async () => {
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),target=new EventEmitter();
  const {state}=await fixture({load:async () => {entered.resolve();await release.promise;return Buffer.alloc(64,65);}});
  let done=false;const pending=runWindowsMediaWorkerProcess(configuration(),{targetProcess:target}).finally(() => {done=true;});
  await entered.promise;target.emit('SIGTERM');target.emit('SIGINT');await tick();assert.equal(done,false);assert.equal(state.ended,0);
  release.resolve();assert.deepEqual(await pending,{stopped:true,processed:0});assert.equal(state.starts,0);assert.equal(state.ended,1);
  assert.ok(state.buffers.every((bytes) => bytes.every((byte) => byte===0)));assert.equal(target.eventNames().length,0);
});
test('complete configuration is captured before waiting for credentials',windowsOnly,async () => {
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),value=configuration();
  const expected=value.database.credentialId;
  const {state}=await fixture({load:async (_state,args) => {
    assert.equal(args[0],expected);assert.equal(args[1].roles.worker,'cb_worker');entered.resolve();await release.promise;return Buffer.alloc(64,65);
  }});
  const pending=runWindowsMediaWorkerProcess(value,{targetProcess:new EventEmitter()});await entered.promise;
  value.database.endpoint.host='192.0.2.1';value.database.privileges.roles.worker='other';value.database.credentialId=randomUUID();
  value.media.capacity=0;value.media.runtime={};value.media.engineIdentity='other';release.resolve();await pending;
  assert.equal(state.pools[0].options.user,'cb_worker');assert.equal(state.pools[0].options.host,'127.0.0.1');assert.equal(state.starts,1);
});
test('stop drains active work before pool close and holds process ownership until close completes',windowsOnly,async () => {
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),closing=Promise.withResolvers(),closeRelease=Promise.withResolvers();
  const target=new EventEmitter();let activeSignal,done=false;
  const {state}=await fixture({start:async (signal) => {activeSignal=signal;entered.resolve();await release.promise;return {stopped:true,processed:1};},
    end:async () => {closing.resolve();await closeRelease.promise;}});
  const pending=runWindowsMediaWorkerProcess(configuration(),{targetProcess:target}).finally(() => {done=true;});
  await entered.promise;target.emit('SIGINT');assert.equal(activeSignal.aborted,true);await tick();assert.equal(state.ended,0);assert.equal(done,false);
  await assert.rejects(runWindowsMediaWorkerProcess(configuration(),{targetProcess:target}),denied);
  release.resolve();await closing.promise;assert.equal(done,false);assert.equal(target.listenerCount('SIGTERM'),1);
  await assert.rejects(withMediaWorkerProcessLifetime(() => assert.fail('reserved'),{targetProcess:target}),denied);
  target.emit('SIGTERM');closeRelease.resolve();assert.deepEqual(await pending,{stopped:true,processed:1});
  assert.equal(state.ended,1);assert.equal(target.exitCode,undefined);assert.equal(target.eventNames().length,0);
});
test('worker fault coinciding with stop is redacted, not reported as graceful success, and closes once',windowsOnly,async () => {
  const controller=new AbortController(),target=new EventEmitter();target.exitCode=7;
  const {state}=await fixture({start:async () => {controller.abort();throw new Error('private child and engine diagnostics');}});
  await assert.rejects(runWindowsMediaWorkerProcess(configuration(),{targetProcess:target,signal:controller.signal}),
    (error) => error.code===denied.code && !error.cause && !JSON.stringify(error).includes('private'));
  assert.equal(target.exitCode,7);assert.equal(state.ended,1);assert.equal(target.eventNames().length,0);assert.equal(state.starts,1);
});
test('startup credential failure even after stop remains a failure with no worker/native execution',windowsOnly,async () => {
  const target=new EventEmitter(),{state}=await fixture({load:async () => {target.emit('SIGTERM');throw new Error('private DPAPI');}});
  await assert.rejects(runWindowsMediaWorkerProcess(configuration(),{targetProcess:target}),denied);
  assert.equal(target.exitCode,1);assert.equal(state.starts,0);assert.equal(state.ended,1);assert.equal(target.eventNames().length,0);
});
test('wrong actual DB purpose cannot start a worker and pool is closed',windowsOnly,async () => {
  const target=new EventEmitter(),{state}=await fixture({kind:'runtime'});
  await assert.rejects(runWindowsMediaWorkerProcess(configuration(),{targetProcess:target}),denied);
  assert.equal(state.starts,0);assert.equal(state.ended,1);assert.equal(target.exitCode,1);
});
test('stop during worker admission cannot enter queue work after its read-only startup',windowsOnly,async () => {
  const controller=new AbortController(),target=new EventEmitter();let admissions=0;
  const {state}=await fixture({query:async (_state,sql) => {
    if (sql.includes('FROM pg_catalog.pg_database d') && ++admissions===2) controller.abort();
  },start:async (signal) => {assert.equal(signal.aborted,true);return {stopped:true,processed:0};}});
  assert.deepEqual(await runWindowsMediaWorkerProcess(configuration(),{targetProcess:target,signal:controller.signal}),{stopped:true,processed:0});
  assert.equal(state.ended,1);assert.equal(target.exitCode,undefined);
});
test('pool close failure prevents success, uses a fixed error and never restarts',windowsOnly,async () => {
  const target=new EventEmitter(),{state}=await fixture({end:async () => {throw new Error('private pool close');}});
  await assert.rejects(runWindowsMediaWorkerProcess(configuration(),{targetProcess:target}),denied);
  assert.equal(state.ended,1);assert.equal(state.starts,1);assert.equal(target.exitCode,1);assert.equal(target.eventNames().length,0);
});
test('foreign handlers and malformed process options are refused without consuming credentials',async () => {
  const {state}=await fixture(),target=new EventEmitter(),foreign=() => {};target.on('SIGTERM',foreign);
  for (const options of [{targetProcess:target},{targetProcess:new EventEmitter(),signal:{}},{targetProcess:new EventEmitter(),force:true},null])
    await assert.rejects(runWindowsMediaWorkerProcess(configuration(),options),denied);
  assert.equal(state.loads,0);assert.deepEqual(target.listeners('SIGTERM'),[foreign]);assert.equal(target.exitCode,undefined);
});
test('partial registration failure cleans owned handlers before any credentials and preserves a failure exit',async () => {
  const {state}=await fixture(),target=new EventEmitter(),original=target.on;
  target.on=function(name,listener) {if(name==='SIGINT') throw new Error('private registration');return original.call(this,name,listener);};
  await assert.rejects(runWindowsMediaWorkerProcess(configuration(),{targetProcess:target}),denied);
  assert.equal(state.loads,0);assert.equal(target.eventNames().length,0);assert.equal(target.exitCode,1);
});
test('shared process lifetime accepts an explicit stop channel and never clears a pre-existing exit error',async () => {
  const target=new EventEmitter(),controller=new AbortController();target.exitCode=9;
  const result=await withMediaWorkerProcessLifetime(async (signal) => {controller.abort();assert.equal(signal.aborted,true);return 'stopped';},
    {targetProcess:target,signal:controller.signal});
  assert.equal(result,'stopped');assert.equal(target.exitCode,9);assert.equal(target.eventNames().length,0);
});

test('stage observation waits for DB close and captures its callback before credential startup',windowsOnly,async () => {
  const loading = Promise.withResolvers(),loadRelease = Promise.withResolvers(),closing = Promise.withResolvers(),closeRelease = Promise.withResolvers();
  const events = [],value = configuration(),target = new EventEmitter(); let done = false,changedCalls = 0;
  value.media.onStage = (event) => { events.push(event); return Promise.reject(new Error('PRIVATE OBSERVER')); };
  const {state} = await fixture({load:async () => { loading.resolve(); await loadRelease.promise; return Buffer.alloc(64,65); },
    end:async () => { closing.resolve(); await closeRelease.promise; }});
  const pending = runWindowsMediaWorkerProcess(value,{targetProcess:target}).finally(() => { done = true; });
  try {
    await loading.promise; assert.deepEqual(events,[{stage:'db-open',edge:'begin'}]);
    value.media.onStage = () => changedCalls++; loadRelease.resolve(); await closing.promise;
    assert.equal(done,false); assert.equal(target.listenerCount('SIGTERM'),1);
    assert.deepEqual(events,['db-open','worker-admission'].flatMap((stage) => [{stage,edge:'begin'},{stage,edge:'complete'}])
      .concat({stage:'db-close',edge:'begin'}));
    closeRelease.resolve(); assert.deepEqual(await pending,{stopped:true,processed:0});
    assert.deepEqual(events.at(-1),{stage:'db-close',edge:'complete'}); assert.equal(changedCalls,0);
    assert.equal(state.ended,1); assert.equal(target.eventNames().length,0);
    for (const event of events) { assert.ok(Object.isFrozen(event)); assert.deepEqual(Object.keys(event),['stage','edge']); }
  } finally { loadRelease.resolve(); closeRelease.resolve(); await pending; }
});

test('failed close emits a failed stage without replacing the established fixed process error',windowsOnly,async () => {
  const events = [],value = configuration(),target = new EventEmitter();
  value.media.onStage = (event) => { events.push(event); throw new Error('PRIVATE OBSERVER'); };
  const {state} = await fixture({end:async () => { throw new Error('PRIVATE CLOSE'); }});
  await assert.rejects(runWindowsMediaWorkerProcess(value,{targetProcess:target}),denied);
  assert.deepEqual(events.at(-1),{stage:'db-close',edge:'failed'});
  assert.equal(events.some((event) => event.stage === 'db-close' && event.edge === 'complete'),false);
  assert.equal(JSON.stringify(events).includes('PRIVATE'),false); assert.equal(state.ended,1); assert.equal(target.exitCode,1);
});

test('invalid observer configuration has no credentials or diagnostic side effects',async () => {
  const {state} = await fixture(),value = configuration(),target = new EventEmitter(); value.media.onStage = {};
  await assert.rejects(runWindowsMediaWorkerProcess(value,{targetProcess:target}),denied);
  assert.equal(state.loads,0); assert.equal(state.ended,0); assert.equal(target.eventNames().length,0);
});

test('database startup diagnostics are captured before await and stop before worker admission or polling',windowsOnly,async()=>{
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),events=[],value=configuration();
  let changed=0;value.media.onDatabaseStage=event=>{events.push(event);return Promise.reject(new Error('PRIVATE OBSERVER'));};
  const {state}=await fixture({load:async()=>{entered.resolve();await release.promise;return Buffer.alloc(64,65);}});
  const pending=runWindowsMediaWorkerProcess(value,{targetProcess:new EventEmitter()});
  await entered.promise;value.media.onDatabaseStage=()=>changed++;release.resolve();
  assert.deepEqual(await pending,{stopped:true,processed:0});
  assert.equal(changed,0);assert.equal(state.starts,1);assert(state.loads>=2);
  assert.equal(events.filter(event=>event.stage==='connection'&&event.edge==='begin').length,1);
  assert.equal(events.filter(event=>event.stage==='transaction'&&event.edge==='complete').length,1);
  assert.equal(events.filter(event=>event.stage==='privilege-check'&&event.edge==='complete').length,1);
  assert(events.every(event=>Object.isFrozen(event)&&Number.isSafeInteger(event.elapsedMs)));
  assert.equal(JSON.stringify(events).includes('PRIVATE'),false);
});

test('database startup diagnostics cannot hide credential failure or admit a worker',windowsOnly,async()=>{
  const events=[],value=configuration(),target=new EventEmitter();
  value.media.onDatabaseStage=event=>{events.push(event);throw new Error('PRIVATE OBSERVER');};
  const {state}=await fixture({load:async()=>{throw new Error('PRIVATE DPAPI');}});
  await assert.rejects(runWindowsMediaWorkerProcess(value,{targetProcess:target}),denied);
  assert.equal(state.starts,0);assert.equal(state.ended,1);
  assert(events.some(event=>event.stage==='connection'&&event.edge==='failed'));
  assert(!events.some(event=>event.stage==='privilege-check'));
  assert.equal(JSON.stringify(events).includes('PRIVATE'),false);
  const other=configuration();other.media.onDatabaseStage={};
  await assert.rejects(runWindowsMediaWorkerProcess(other,{targetProcess:new EventEmitter()}),denied);
});

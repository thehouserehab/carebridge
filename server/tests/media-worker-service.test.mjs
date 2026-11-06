import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {access} from 'node:fs/promises';
import {createMediaWorkerService} from '../media-worker-service.mjs';
import {MediaWorkQueueWorker} from '../media-work-queue-worker.mjs';
import {PrivateFileStore} from '../private-file-store.mjs';
import {LocalClamAvClient} from '../clamav-client.mjs';
import {serviceCatalog} from './database-service-fixtures.mjs';
const denied = {code:'MEDIA_WORKER_UNAVAILABLE'};
function fixture() {
  const f = serviceCatalog(),nativeCalls = [],root = join(tmpdir(),'carebridge-worker-composition-'+randomUUID());
  const native = async () => { nativeCalls.push('unexpected'); throw new Error('NO_NATIVE_EXECUTION_IN_CONSTRUCTION_TEST'); };
  const options = {database:f.database,privileges:structuredClone(f.input),store:new PrivateFileStore(root),
    scanner:new LocalClamAvClient({endpoint:{host:'127.0.0.1',port:65535},approvedEngineVersions:['1.4.6'],daemonTimeZone:'UTC'}),
    runtime:{docker:native,inspect:native,exchange:native,identity:native},engineIdentity:'synthetic-composition-engine',approvedImageId:'sha256:'+'a'.repeat(64)};
  return {...f,options,root,nativeCalls};
}
test('explicit composition admits the worker role but does not start, initialize files, register signals or call native engines',async () => {
  const f = fixture(),before = ['SIGTERM','SIGINT'].map((signal) => process.listenerCount(signal));
  const worker = await createMediaWorkerService(f.options);
  assert.ok(worker instanceof MediaWorkQueueWorker); assert.equal(worker.status.state,'new'); assert.equal(worker.status.loopRunning,false);
  assert.equal(f.state.transactions,1); assert.deepEqual(f.nativeCalls,[]);
  await assert.rejects(access(f.root),{code:'ENOENT'});
  assert.deepEqual(['SIGTERM','SIGINT'].map((signal) => process.listenerCount(signal)),before);
});
test('synthetic bypass, prebuilt journal/preparation, unknown options and incomplete inputs have no connection/native side effects',async () => {
  const f = fixture();
  for (const options of [null,{}, {...f.options,localTestMode:true},{...f.options,preparation:{}},{...f.options,journal:{}},{...f.options,force:true}])
    await assert.rejects(createMediaWorkerService(options),denied);
  assert.equal(f.state.transactions,0); assert.deepEqual(f.nativeCalls,[]);
});
test('invalid concrete dependencies and bounded settings fail before DB admission and never create a fallback',async () => {
  const f = fixture();
  for (const change of [{scanner:{}},{store:{}},{runtime:{}},{capacity:0},{capacity:3},{capacity:'2'},{pollMilliseconds:49},
    {pollMilliseconds:60001},{engineIdentity:'short'},{approvedImageId:'latest'}])
    await assert.rejects(createMediaWorkerService({...f.options,...change}),denied);
  assert.equal(f.state.transactions,0); assert.deepEqual(f.nativeCalls,[]);
});
test('app/owner connections or excessive grants cannot return a runnable service; private errors stay redacted',async () => {
  const f = fixture();
  for (const kind of ['runtime','owner','bootstrap','backup']) { f.state.kind = kind; await assert.rejects(createMediaWorkerService(f.options),denied); }
  f.state.kind = 'worker'; f.state.grantedBody = true; await assert.rejects(createMediaWorkerService(f.options),denied);
  f.state.grantedBody = false; f.state.before = () => { throw new Error('SYNTHETIC-PRIVATE-CREDENTIAL'); };
  await assert.rejects(createMediaWorkerService(f.options),denied); assert.deepEqual(f.nativeCalls,[]);
});
test('dependency/config mutation while startup is awaiting cannot switch the assembled DB purpose or relax limits',async () => {
  const f = fixture(),entered = Promise.withResolvers(),release = Promise.withResolvers();
  f.state.before = async () => { entered.resolve(); await release.promise; };
  const pending = createMediaWorkerService(f.options); await entered.promise;
  f.options.privileges.roles.worker = 'not_the_original_worker'; f.options.capacity = 0; f.options.runtime = {};
  release.resolve(); const worker = await pending;
  assert.ok(worker instanceof MediaWorkQueueWorker); assert.equal(worker.status.state,'new'); assert.deepEqual(f.nativeCalls,[]);
});

test('startup captures an optional observer and rejected observations cannot change admission',async () => {
  const f = fixture(),events = [],entered = Promise.withResolvers(),release = Promise.withResolvers(); let changedCalls = 0;
  f.options.onStage = (event) => { events.push(event); return Promise.reject(new Error('PRIVATE DIAGNOSTIC')); };
  f.state.before = async () => { entered.resolve(); await release.promise; };
  const pending = createMediaWorkerService(f.options); await entered.promise;
  assert.deepEqual(events,[{stage:'worker-admission',edge:'begin'}]);
  f.options.onStage = () => changedCalls++; release.resolve();
  const worker = await pending; assert.ok(worker instanceof MediaWorkQueueWorker);
  assert.deepEqual(events,[{stage:'worker-admission',edge:'begin'},{stage:'worker-admission',edge:'complete'}]);
  assert.deepEqual(f.nativeCalls,[]); assert.equal(f.state.transactions,1);
  assert.equal(changedCalls,0);
});

test('malformed observer fails before admission while failed admission emits no private details',async () => {
  const f = fixture(),events = [];
  await assert.rejects(createMediaWorkerService({...f.options,onStage:{}}),denied);
  assert.equal(f.state.transactions,0);
  f.state.before = () => { throw new Error('PRIVATE DATABASE CREDENTIAL'); };
  await assert.rejects(createMediaWorkerService({...f.options,onStage:(event) => { events.push(event); throw new Error('PRIVATE OBSERVER'); }}),denied);
  assert.deepEqual(events,[{stage:'worker-admission',edge:'begin'},{stage:'worker-admission',edge:'failed'}]);
  assert.equal(JSON.stringify(events).includes('PRIVATE'),false); assert.deepEqual(f.nativeCalls,[]);
});

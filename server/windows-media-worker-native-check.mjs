// Fresh synthetic E fixture only: real DPAPI/SCRAM/TLS/SQL/private bytes,
// deliberately fake scanner/decoder peers and a cooperative stop channel.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {runWindowsMediaWorkerProcess} from './windows-media-worker-process.mjs';
import {MediaUploads} from './media-uploads.mjs';
import {configureSyntheticMediaPolicy} from './media-resource-test-policy.mjs';
import {syntheticPng} from './image-metadata-test-fixtures.mjs';
import {fakePreparation,fakeClam,engine,image,hash} from './tests/media-preparation-fixtures.mjs';
import {nativeWorkerStderrObserver,nativeWorkerStageReporter,nativeDatabaseStageReporter} from './windows-native-worker-test-policy.mjs';
const ownedEngine = `${engine}-owned`;
const input = (row) => ({conversationId:row.conversationId,uploadId:row.id,expectedVersion:row.version});
const collect = async (stream) => {const chunks=[];for await (const chunk of stream) chunks.push(chunk);return Buffer.concat(chunks);};
async function bounded(promise) {
  let timer;try {return await Promise.race([promise,new Promise((_,no) => {timer=setTimeout(() => no(new Error('SYNTHETIC_WORKER_WAIT')),12000);})]);}
  finally {clearTimeout(timer);}
}
export async function exerciseOwnedWindowsWorker({owner,store,configuration,open,close,runtimeEntry,workerEntry,endpoint}) {
  let phase=401,clam,app,maintenance,pending,release,controller,failure,ownedWorkerObservation;
  let processState='not-started',decoderEntries=0;
  const observation=nativeWorkerStderrObserver();
  const feed=frame=>observation.feed(Buffer.from(frame));
  const onStage=nativeWorkerStageReporter(feed),onDatabaseStage=nativeDatabaseStageReporter(feed);
  const checks=[];
  try {
    const centerId='synthetic-role-center',conversationId='synthetic-role-room';
    const {rows:members}=await owner.transaction((tx) => tx.query('SELECT user_id FROM cb_memberships WHERE center_id=$1 AND role=$2',[centerId,'guardian']));
    assert.equal(members.length,1);const actor={centerId,userId:members[0].user_id};
    await owner.transaction((tx) => configureSyntheticMediaPolicy(tx,centerId));
    app=await open(runtimeEntry,endpoint);const uploads=new MediaUploads(app,store);
    const bytes=syntheticPng(),file={name:'synthetic-owned-worker.png',type:'image/png',size:bytes.length,sha256:hash(bytes)};
    const receive=async () => {
      const reserved=await uploads.reserve(actor,{conversationId,clientId:randomUUID(),file});
      return uploads.receive(actor,input(reserved),Readable.from([bytes],{objectMode:false}));
    };
    const row=async (id) => (await owner.transaction((tx) => tx.query('SELECT * FROM cb_media_uploads WHERE id=$1',[id]))).rows[0];
    const queue=async (id) => (await owner.transaction((tx) => tx.query('SELECT state,attempts FROM cb_media_work_queue WHERE upload_id=$1',[id]))).rows[0];
    const assertPoolsClosed=async () => assert.equal((await owner.transaction((tx) => tx.query(
      "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE usename=$1 AND datname=current_database()",
      [workerEntry.privileges.roles.worker]))).rows[0].count,0);
    const preserve=async (id) => {
      const current=await row(id),handle=await store.openVerified(current.object_key,file);
      assert.deepEqual(await collect(handle.createReadStream({autoClose:true})),bytes);return current;
    };
    clam=await fakeClam();const fake=fakePreparation(),exchange=fake.runtime.exchange.bind(fake.runtime);
    let entered,recoverStop;fake.runtime.identity=async () => ownedEngine;
    fake.runtime.exchange=async (...args) => {const result=await exchange(...args);decoderEntries++;entered.resolve();await release.promise;return result;};
    const docker=fake.runtime.docker.bind(fake.runtime);
    fake.runtime.docker=async (args,...rest) => {const result=await docker(args,...rest);if(args[0]==='rm') recoverStop?.abort();return result;};
    const {kind,...database}=configuration(workerEntry,endpoint);
    assert.equal(kind,'worker');const options={database,media:{store,scanner:clam.scanner,runtime:fake.runtime,
      engineIdentity:ownedEngine,approvedImageId:image,capacity:1,pollMilliseconds:50,onStage,onDatabaseStage}};
    const cleanCancelled=async (id) => {
      const current=await row(id);await uploads.cancel(actor,input({...current,conversationId}));
      maintenance=await open(workerEntry,endpoint);const result=await new MediaUploads(maintenance,store).cleanup();
      assert.equal(result.failed,0);await close(maintenance);maintenance=null;assert.equal((await row(id)).state,'deleted');
    };
    phase=4011;let received=await receive();entered=Promise.withResolvers();release=Promise.withResolvers();controller=new AbortController();
    const target=new EventEmitter();let settled=false;
    processState='pending';pending=runWindowsMediaWorkerProcess(options,{targetProcess:target,signal:controller.signal});
    const observed=pending.then(() => {settled=true;processState='resolved';},() => {settled=true;processState='rejected';});
    phase=4012;await bounded(entered.promise);controller.abort();target.emit('SIGTERM');await delay(30);assert.equal(settled,false);
    phase=4013;release.resolve();assert.deepEqual(await pending,{stopped:true,processed:1});await observed;pending=null;
    phase=4014;assert.equal(target.exitCode,undefined);assert.equal(target.eventNames().length,0);await assertPoolsClosed();
    phase=4015;
    assert.deepEqual(await queue(received.id),{state:'retry',attempts:1});assert.equal((await preserve(received.id)).state,'quarantined');
    assert.equal(fake.containers.size,0);assert.equal((await owner.transaction((tx) => tx.query(
      'SELECT count(*)::integer AS count FROM cb_decoder_jobs WHERE engine_id=$1 AND phase<>$2',[ownedEngine,'closed']))).rows[0].count,0);
    phase=4016;await cleanCancelled(received.id);
    checks.push('owned DPAPI/TLS worker drains an active synthetic decoder before closing its private PG pool; retry/quarantine retains exact source bytes and journal cleanup');

    phase=402;received=await receive();entered=Promise.withResolvers();release=Promise.withResolvers();controller=new AbortController();
    const faultTarget=new EventEmitter();
    processState='pending';pending=runWindowsMediaWorkerProcess(options,{targetProcess:faultTarget,signal:controller.signal});
    pending.then(()=>{processState='resolved';},()=>{processState='rejected';});
    const rejected=assert.rejects(pending,{code:'MEDIA_WORKER_UNAVAILABLE'});
    try {
      phase=4021;await bounded(entered.promise);
      // Explicit fixture-only permission fault. No trigger/schema change,
      // production grant repair or elapsed-time claim is hidden in this test.
      await owner.transaction((tx) => tx.exec(`REVOKE SELECT ON cb_decoder_jobs FROM ${workerEntry.privileges.roles.worker}`));
      phase=4022;controller.abort();release.resolve();await bounded(rejected);pending=null;
      assert.equal(faultTarget.exitCode,1);assert.equal(faultTarget.eventNames().length,0);await assertPoolsClosed();
      assert.equal((await preserve(received.id)).state,'inspecting');assert.deepEqual(await queue(received.id),{state:'running',attempts:1});
      assert.equal(fake.containers.size,1);phase=4023;
    } finally {
      await owner.transaction((tx) => tx.exec(`GRANT SELECT ON cb_decoder_jobs TO ${workerEntry.privileges.roles.worker}`));
    }
    const current=await row(received.id);await uploads.cancel(actor,input({...current,conversationId}));
    await owner.transaction((tx) => tx.query(
      "UPDATE cb_decoder_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE engine_id=$1 AND phase<>$2",[ownedEngine,'closed']));
    recoverStop=new AbortController();controller=recoverStop;const recoveryTarget=new EventEmitter();
    processState='pending';pending=runWindowsMediaWorkerProcess(options,{targetProcess:recoveryTarget,signal:recoverStop.signal});
    pending.then(()=>{processState='resolved';},()=>{processState='rejected';});
    phase=4024;assert.deepEqual(await bounded(pending),{stopped:true,processed:0});pending=null;
    assert.equal(recoveryTarget.exitCode,undefined);assert.equal(fake.containers.size,0);await assertPoolsClosed();
    assert.equal((await owner.transaction((tx) => tx.query('SELECT count(*)::integer AS count FROM cb_decoder_jobs WHERE engine_id=$1 AND phase<>$2',
      [ownedEngine,'closed']))).rows[0].count,0);
    phase=4025;await cleanCancelled(received.id);bytes.fill(0);
    checks.push('a permission fault racing stop fails closed with durable unresolved work; after explicit fixture repair/lease expiry a new owned instance recovers exact namespace then closes');
  } catch {
    failure=true;
    // Capture before cooperative cleanup changes the last stage. Reuse the
    // bounded finite protocol; never attach raw errors, keys, SQL or paths.
    ownedWorkerObservation=Object.freeze({processState,decoderEntries,stages:observation.snapshot()});
  }
  finally {
    controller?.abort();release?.resolve();if(pending) await pending.catch(() => {});
    for(const service of [maintenance,app]) if(service) try {await close(service);} catch {failure=true;}
    await clam?.close();
  }
  if(failure){const error=new Error('WINDOWS_MEDIA_WORKER_NATIVE_CHECK_FAILED');error.roleCheckPhase=phase;
    if(ownedWorkerObservation)error.ownedWorkerObservation=ownedWorkerObservation;throw error;}
  return checks;
}

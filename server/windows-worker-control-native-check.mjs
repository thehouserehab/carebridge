// Real Windows child/IPC/DPAPI/TLS/PG and E private bytes. Scanner/decoder are
// explicit peers in each child; no OS service, native AV or power-loss claim.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {controlMediaWorkerChild} from './media-worker-child-control.mjs';
import {MediaUploads} from './media-uploads.mjs';
import {syntheticPng} from './image-metadata-test-fixtures.mjs';
import {engine,hash} from './tests/media-preparation-fixtures.mjs';
const input=(row) => ({conversationId:row.conversationId,uploadId:row.id,expectedVersion:row.version});
async function observe(promise) {
  let timer;try {return await Promise.race([promise,new Promise((_,no) => {timer=setTimeout(()=>no(new Error('WORKER_CHILD_OBSERVATION_TIMEOUT')),15000);})]);}
  finally {clearTimeout(timer);}
}
export async function exerciseWindowsWorkerControl({owner,store,configuration,open,close,runtimeEntry,workerEntry,endpoint,environment}) {
  let phase=501,app,maintenance,pending,child,control,failure;const checks=[],owned=[];
  try {
    const centerId='synthetic-role-center',conversationId='synthetic-role-room';
    const members=await owner.transaction((tx) => tx.query('SELECT user_id FROM cb_memberships WHERE center_id=$1 AND role=$2',[centerId,'guardian']));
    assert.equal(members.rows.length,1);const actor={centerId,userId:members.rows[0].user_id};
    app=await open(runtimeEntry,endpoint);const uploads=new MediaUploads(app,store),bytes=syntheticPng();
    const file={name:'synthetic-worker-ipc.png',type:'image/png',size:bytes.length,sha256:hash(bytes)};
    const row=async(id)=>(await owner.transaction((tx)=>tx.query('SELECT * FROM cb_media_uploads WHERE id=$1',[id]))).rows[0];
    for(const mode of ['stop','disconnect']) {
      phase=mode==='stop'?5011:5021;
      const reserved=await uploads.reserve(actor,{conversationId,clientId:randomUUID(),file});
      const received=await uploads.receive(actor,input(reserved),Readable.from([bytes],{objectMode:false}));
      const instanceId=randomUUID(),ownedEngine=`${engine}-ipc-${instanceId}`,prepared=Promise.withResolvers();let marker='',badOutput=false,settled=false;
      child=spawn(process.execPath,[fileURLToPath(new URL('./windows-worker-control-native-child.mjs',import.meta.url)),instanceId],{
        cwd:store.root,env:{...environment,CAREBRIDGE_WORKER_IPC_TEST_CHILD:'synthetic-only'},shell:false,windowsHide:true,detached:false,
        serialization:'json',stdio:['pipe','pipe','ignore','ipc']});
      child.stdin.on('error',()=>{});control=controlMediaWorkerChild(child,{instanceId});
      const entry={child,control,mode};owned.push(entry);
      child.stdout.on('data',(data) => {marker+=data.toString('ascii');if(marker==='PREPARING\n')prepared.resolve();else if(marker.length>=10){badOutput=true;prepared.reject(new Error('WORKER_CHILD_MARKER'));}});
      pending=control.waitForExit();pending.then(()=>{settled=true;},()=>{settled=true;});
      const {kind,...database}=configuration(workerEntry,endpoint);assert.equal(kind,'worker');
      await new Promise((yes,no) => child.send({purpose:'synthetic-carebridge-worker-child',database,mediaRoot:store.root},(error)=>error?no(new Error('WORKER_CHILD_BOOTSTRAP')):yes()));
      phase=mode==='stop'?50121:50221;await observe(Promise.race([prepared.promise,pending.then(()=>{throw new Error('WORKER_CHILD_EARLY_EXIT');})]));
      phase=mode==='stop'?50122:50222;
      assert.equal(control.status().controlReady,true);assert.equal(control.status().terminal,false);assert.equal(badOutput,false);
      phase=mode==='stop'?50123:50223;if(mode==='stop') {
        const stop=control.requestStop();assert.equal(control.requestStop(),stop);assert.deepEqual(await observe(stop),{accepted:true});
        assert.equal(control.status().stopAccepted,true);
      } else {child.disconnect();}
      phase=mode==='stop'?50124:50224;await delay(40);assert.equal(settled,false);assert.equal(control.status().terminal,false);
      phase=mode==='stop'?50125:50225;
      assert.equal((await row(received.id)).state,'inspecting');
      phase=mode==='stop'?5013:5023;child.stdin.end('RELEASE\n');
      if(mode==='stop')assert.deepEqual(await observe(pending),{exited:true,exitCode:0,drained:true});
      else await assert.rejects(observe(pending),{code:'MEDIA_WORKER_CONTROL_UNAVAILABLE'});
      assert.equal(control.status().terminal,true);assert.equal(control.status().exitCode,mode==='stop'?0:1);assert.equal(control.status().signalCode,null);
      assert.equal(control.status().stdioClosed,true);if(mode==='stop')assert.equal(control.status().closeObserved,true);
      pending=null;const current=await row(received.id);assert.equal(current.state,'quarantined');
      const handle=await store.openVerified(current.object_key,file);try {assert.deepEqual(await handle.readFile(),bytes);} finally {await handle.close();}
      assert.deepEqual((await owner.transaction((tx)=>tx.query('SELECT state,attempts FROM cb_media_work_queue WHERE upload_id=$1',[received.id]))).rows[0],{state:'retry',attempts:1});
      assert.equal((await owner.transaction((tx)=>tx.query('SELECT count(*)::integer AS count FROM cb_decoder_jobs WHERE engine_id=$1 AND phase<>$2',[ownedEngine,'closed']))).rows[0].count,0);
      assert.equal((await owner.transaction((tx)=>tx.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE usename=$1 AND datname=current_database()",
        [workerEntry.privileges.roles.worker]))).rows[0].count,0);
      await uploads.cancel(actor,input({...current,conversationId}));maintenance=await open(workerEntry,endpoint);
      assert.equal((await new MediaUploads(maintenance,store).cleanup()).failed,0);await close(maintenance);maintenance=null;
      assert.equal((await row(received.id)).state,'deleted');
      checks.push(mode==='stop' ? 'a real Windows IPC child accepts one stop, remains alive through held work, drains DPAPI/TLS/PG/journal and exits zero with exact original bytes retained' :
        'loss of the real inherited parent channel aborts but waits for child drain and actual nonzero exit; private source/retry and closed decoder journal survive');
    }
    bytes.fill(0);
  } catch {failure=true;}
  finally {
    for(const {child:ownedChild,control:ownedControl} of owned) {
      if(!ownedControl.status().terminal) {
        ownedControl.requestStop().catch(()=>{});
        if(!ownedChild.stdin.writableEnded)ownedChild.stdin.end('RELEASE\n');
        // Observation timeout is never terminal. Continue awaiting the exact
        // handle; do not kill/restart it or delete a possibly live fixture.
        try {await ownedControl.waitForExit();} catch {if(!ownedControl.status().terminal)failure=true;}
      }
    }
    for(const service of [maintenance,app])if(service)try {await close(service);}catch{failure=true;}
  }
  if(failure){const error=new Error('WINDOWS_WORKER_CONTROL_NATIVE_CHECK_FAILED');error.roleCheckPhase=phase;
    error.workerControlObservation={childCount:owned.length,allChildrenTerminal:owned.every(({control})=>control.status().terminal),
      last:control ? control.status() : null};throw error;}
  return {checks,childCount:owned.length,allChildrenTerminal:owned.every(({control})=>control.status().terminal),
    terminalEvidence:owned.map(({mode,control})=>{const state=control.status();return {mode,exitCode:state.exitCode,
      closeObserved:state.closeObserved,stdioClosed:state.stdioClosed};})};
}

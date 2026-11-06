// Actual Windows child + E bytes + DPAPI/TLS/PG + durable journal + native
// ClamAV/FFmpeg, inside an already owned fresh synthetic fixture. Not a service.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {deflateSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {controlMediaWorkerChild} from './media-worker-child-control.mjs';
import {MediaUploads} from './media-uploads.mjs';
import {MediaAccess} from './media-access.mjs';
import {seedNativeApiTestFixture} from './native-api-seed-testfixture.mjs';
import {createWindowsNativeMediaTestFixture} from './windows-native-media-test-fixture.mjs';
import {syntheticPng,animatedPng,addPrivateMetadata,pngChunk,PRIVATE_MARKER} from './image-metadata-test-fixtures.mjs';
import {decoderReceipt,assertDecoderIsolation} from './decoder-container-policy.mjs';
import {nativeWorkerStderrObserver} from './windows-native-worker-test-policy.mjs';
import {launchWindowsNativeApiTest} from './windows-native-api-test-parent.mjs';
import {nativeApiTestHttp} from './windows-native-api-test-http.mjs';
import {exercisePreparedMediaBrowser} from '../tests/native-prepared-media-browser-helper.mjs';
import {observeNativeWorkerAdmission} from './native-worker-admission.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const stream=bytes=>Readable.from([bytes],{objectMode:false});
const input=row=>({conversationId:row.conversationId??row.conversation_id,uploadId:row.id,expectedVersion:row.version});
const collect=async source=>{const chunks=[];for await(const chunk of source)chunks.push(chunk);return Buffer.concat(chunks);};
async function observe(promise,milliseconds=30000){let timer;try{return await Promise.race([promise,new Promise((_,no)=>{
  timer=setTimeout(()=>no(new Error('NATIVE_WORKER_OBSERVATION_TIMEOUT')),milliseconds);
})]);}finally{clearTimeout(timer);}}

export async function exerciseWindowsNativeWorker({owner,store,configuration,open,close,runtimeEntry,workerEntry,endpoint,environment,observeWorkerConnections,browserRuntime,verifyBrowser=true}) {
  let phase=601,fixture,app,maintenance,api,http,failure,failureCategory=null,failureLine=null,fixtureCleanup=false,tlsObserved=false,
    apiCleanup=false,ownerStatisticsRestricted=null,lastQueueStates=[],centerId,conversationId,browser,browserOwned;
  const checks=[],children=[],credentials=[],preparedRecoverySamples=[];
  const query=(sql,args)=>owner.transaction(tx=>tx.query(sql,args));
  const row=async id=>(await query('SELECT * FROM cb_media_uploads WHERE id=$1',[id])).rows[0];
  const queue=async id=>(await query('SELECT state,attempts FROM cb_media_work_queue WHERE upload_id=$1',[id])).rows[0];
  const jobs=async()=>fixture?(await query('SELECT run,container_id,phase FROM cb_decoder_jobs WHERE engine_id=$1 AND image_id=$2 ORDER BY created_at,run',
    [fixture.engine,fixture.approvedImageId])).rows:[];
  async function observeTls(){const rows=await observeWorkerConnections();
    if(rows.length){assert.ok(rows.every(value=>value.usename===workerEntry.privileges.roles.worker&&value.ssl===true));tlsObserved=true;
      if(ownerStatisticsRestricted===null){const ordinary=(await query(`SELECT a.usename,s.ssl FROM pg_stat_activity a JOIN pg_stat_ssl s ON s.pid=a.pid
        WHERE a.usename=$1 AND a.datname=current_database() AND a.application_name='carebridge-worker'`,[workerEntry.privileges.roles.worker])).rows;
        ownerStatisticsRestricted=ordinary.length===0||ordinary.some(value=>value.ssl!==true);}}}
  async function closedPools(){assert.deepEqual(await observeWorkerConnections(),[]);}
  async function noNativeJobs(){for(const job of await jobs()){
    assert.equal(job.phase,'closed');assert.match(job.container_id,/^[a-f0-9]{64}$/);
    assert.equal(await fixture.runtime.docker(['ps','--all','--no-trunc','--filter',`id=${job.container_id}`,'--format','{{.ID}}']),'');
  }await fixture.noJobs();}
  function launch(mode){
    const instanceId=randomUUID(),child=spawn(process.execPath,[fileURLToPath(new URL('./windows-native-worker-test-child.mjs',import.meta.url)),instanceId],{
      cwd:store.root,env:{...environment,CAREBRIDGE_NATIVE_WORKER_TEST_CHILD:'synthetic-only'},shell:false,windowsHide:true,detached:false,
      serialization:'json',stdio:['pipe','pipe','pipe','ipc']});
    child.stdin.on('error',()=>{});const control=controlMediaWorkerChild(child,{instanceId}),pending=control.waitForExit();
    pending.catch(()=>{});const diagnostic=nativeWorkerStderrObserver();
    const admission=observeNativeWorkerAdmission(child,control,{instanceId,mode});
    const entry={child,control,pending,mode,badOutput:false,diagnostic,admission};children.push(entry);
    child.stderr.on('data',bytes=>{diagnostic.feed(bytes);if(diagnostic.snapshot().outputLimitExceeded){entry.badOutput=true;control.requestStop().catch(()=>{});}});
    entry.started=(async()=>{const {kind,...database}=configuration(workerEntry,endpoint);assert.equal(kind,'worker');
      await new Promise((yes,no)=>child.send({purpose:'synthetic-carebridge-native-worker',database,mediaRoot:store.root,mode,
        nativeMedia:{engineIdentity:fixture.engine,approvedImageId:fixture.approvedImageId,scannerEndpoint:fixture.bridge.endpoint}},error=>error?no(new Error('NATIVE_WORKER_BOOTSTRAP')):yes()));
      await admission.ready;})();
    return entry;
  }
  async function stop(entry,mode='stop'){
    if(mode==='stop'){const pending=entry.control.requestStop();assert.equal(entry.control.requestStop(),pending);assert.deepEqual(await observe(pending),{accepted:true});}
    else entry.child.disconnect();
    if(!entry.child.stdin.writableEnded)entry.child.stdin.end('RELEASE\n');
    if(mode==='stop')assert.deepEqual(await observe(entry.pending),{exited:true,exitCode:0,drained:true});
    else await assert.rejects(observe(entry.pending),{code:'MEDIA_WORKER_CONTROL_UNAVAILABLE'});
    const state=entry.control.status();assert.equal(state.terminal,true);assert.equal(state.stdioClosed,true);
    assert.equal(entry.badOutput,false);assert.equal(entry.admission.status().invalidOutput,false);
    assert.equal(state.exitCode,mode==='stop'?0:1);assert.equal(state.signalCode,null);if(mode==='stop')assert.equal(state.closeObserved,true);
    await closedPools();await noNativeJobs();
  }
  function publicJson(result,status=200){
    assert.equal(result.status,status);assert.equal(result.headers['cache-control'],'no-store');
    assert.equal(result.headers['x-content-type-options'],'nosniff');assert.equal(result.headers['access-control-allow-origin'],undefined);
    const serialized=JSON.stringify(result.json);
    for(const privateValue of [store.root,PRIVATE_MARKER,'object_key','candidate_key','sha256','preparation_id','evidence','"token"','"password"'])
      assert.equal(serialized.includes(privateValue),false);
    return result.json;
  }
  function denied(result,status=404,code='NOT_FOUND'){
    const value=publicJson(result,status);assert.equal(value.error,code);assert.deepEqual(Object.keys(value).sort(),['error','message']);
  }
  function transfer(result,file,state,replayed){
    const value=publicJson(result);assert.deepEqual(Object.keys(value).sort(),['mode','source','upload']);assert.equal(value.mode,'prepared-delivery');
    assert.deepEqual(value.source,{name:file.name,type:file.type,size:file.size});
    const upload=value.upload;assert.deepEqual(Object.keys(upload).sort(),['id','conversationId','name','type','size','state','version','failureCode','expiresAt','expired',
      ...(replayed===undefined?[]:['replayed'])].sort());
    assert.equal(upload.conversationId,conversationId);assert.equal(upload.state,state);assert.equal(upload.type,file.type);assert.equal(upload.name,file.name);
    assert(Number.isSafeInteger(upload.version)&&upload.version>0);if(replayed!==undefined)assert.equal(upload.replayed,replayed);return upload;
  }
  try {
    assert.equal(typeof verifyBrowser,'boolean');
    assert.equal(typeof observeWorkerConnections,'function');
    fixture=await createWindowsNativeMediaTestFixture();
    app=await open(runtimeEntry,endpoint);const uploads=new MediaUploads(app,store);
    const seeded=await seedNativeApiTestFixture({owner,runtime:app});
    ({centerId,conversationId}=seeded);const {manager,guardian,therapist}=seeded;credentials.push(...seeded.credentials);
    const {kind,...database}=configuration(runtimeEntry,endpoint);assert.equal(kind,'runtime');
    api=await launchWindowsNativeApiTest({database,mediaRoot:store.root,environment,screen:'prepared',onOwned:owned=>{api=owned;}});
    http=nativeApiTestHttp(api.origin);
    for(const credential of credentials){await http.login(credential);credential.password='';credential.email='';}
    const roomPath=`/api/local/centers/${centerId}/conversations/${conversationId}`;
    const uploadPath=id=>`${roomPath}/uploads${id?`/${id}`:''}`;
    const receiveHttp=async(bytes,type)=>{
      const file={name:'synthetic-native-file',type,size:bytes.length,sha256:hash(bytes)},clientId=randomUUID();
      const command={clientId,file};
      const reserved=transfer(await http.call(uploadPath(),{method:'POST',userId:guardian.userId,body:command}),file,'pending',false);
      const replay=transfer(await http.call(uploadPath(),{method:'POST',userId:guardian.userId,body:command}),file,'pending',true);
      assert.equal(replay.id,reserved.id);assert.equal(replay.version,reserved.version);
      const received=transfer(await http.call(`${uploadPath(reserved.id)}/content`,{method:'POST',userId:guardian.userId,bytes,
        headers:{'X-Carebridge-Upload-Version':String(reserved.version)}}),file,'quarantined');
      assert.equal(transfer(await http.call(uploadPath(received.id),{userId:guardian.userId}),file,'quarantined').id,received.id);
      denied(await http.call(uploadPath(received.id)),401,'AUTH_REQUIRED');
      denied(await http.call(uploadPath(received.id),{userId:therapist.userId}));
      denied(await http.call(uploadPath(received.id),{userId:guardian.userId,expectedAccount:therapist.userId}),401,'AUTH_REQUIRED');
      denied(await http.call(`${uploadPath(received.id)}/content`,{userId:guardian.userId}));
      assert.equal((await query('SELECT count(*)::integer AS count FROM cb_media_preparations WHERE upload_id=$1',[received.id])).rows[0].count,0);
      return {received,file,bytes,clientId};
    };
    const receive=async(bytes,type='image/png')=>{const file={name:'synthetic-native-file',type,size:bytes.length,sha256:hash(bytes)};
      const reserved=await uploads.reserve(guardian,{conversationId,clientId:randomUUID(),file});
      const received=await uploads.receive(guardian,input(reserved),stream(bytes));assert.equal(received.state,'quarantined');return {received,file,bytes};};
    phase=602;
    const samples=[['PNG',addPrivateMetadata(syntheticPng(),'image/png',6),'image/png',1],
      ['APNG',addPrivateMetadata(animatedPng(syntheticPng()),'image/png',6),'image/png',2],
      ['video',fixture.video.bytes,fixture.video.type,fixture.video.frames]];
    const received=[];for(const [name,bytes,type,frames]of samples)received.push({name,frames,...await receiveHttp(bytes,type)});
    const png=syntheticPng(),rows=Buffer.alloc(24*97,100);for(let y=0;y<24;y++)rows[y*97]=99;
    const invalidBytes=Buffer.concat([png.subarray(0,33),pngChunk('IDAT',deflateSync(rows)),pngChunk('IEND',Buffer.alloc(0))]);rows.fill(0);
    const invalid=await receive(invalidBytes),entry=launch('complete');await entry.started;
    phase=603;const deadline=Date.now()+180000;
    while(true){if(entry.control.status().terminal||entry.badOutput)throw new Error('NATIVE_WORKER_EARLY_EXIT');await observeTls();
      const states=await Promise.all([...received,invalid].map(value=>queue(value.received.id)));
      lastQueueStates=states.map(state=>({state:state.state,attempts:state.attempts}));
      if(states.every((state,index)=>state.state===(index===3?'retry':'completed')&&state.attempts===1))break;
      if(Date.now()>=deadline)throw new Error('NATIVE_WORKER_OUTCOME_TIMEOUT');await delay(100);
    }
    await stop(entry);assert.equal(tlsObserved,true);assert.equal((await jobs()).length,4);
    phase=604;
    for(const sample of received){const current=await row(sample.received.id);
      assert.equal(current.state,'ready');assert.notEqual(current.object_key,current.candidate_key);
      const {rows:proofs}=await query('SELECT evidence FROM cb_media_preparations WHERE upload_id=$1',[current.id]);assert.equal(proofs.length,1);
      const evidence=proofs[0].evidence;assert.equal(evidence.mediaAcceptanceReady,false);
      assert.equal(evidence.sourceScan.engineVersion,'1.4.6');assert.equal(evidence.derivativeScan.engineVersion,'1.4.6');
      assert.equal(evidence.sourceScan.databaseVersion,fixture.status.databaseVersion);assert.equal(evidence.sourceScan.verdict,'clean');assert.equal(evidence.derivativeScan.verdict,'clean');
      assert.equal(evidence.preparation.sourceDecode.engineVersion,'9.0.2');assert.equal(evidence.preparation.derivativeDecode.engineVersion,'9.0.2');
      assert.equal(evidence.preparation.sourceDecode.decodedVideoFrames,sample.frames);assert.equal(evidence.preparation.derivativeDecode.decodedVideoFrames,sample.frames);
      assert.equal(evidence.preparation.sourceTimelineSha256,evidence.preparation.derivativeTimelineSha256);
      const source=await store.openVerified(current.object_key,sample.file);try{assert.deepEqual(await source.readFile(),sample.bytes);}finally{await source.close();}
      const candidate=await collect((await uploads.open(guardian,{conversationId,uploadId:current.id})).stream);
      assert.equal(hash(candidate),current.prepared_sha256);assert.equal(candidate.length,current.prepared_size);assert.equal(candidate.includes(Buffer.from(PRIVATE_MARKER)),false);
      await assert.rejects(uploads.open(therapist,{conversationId,uploadId:current.id}),{code:'NOT_FOUND'});
      const ready=transfer(await http.call(uploadPath(current.id),{userId:guardian.userId}),sample.file,'ready');assert.equal(ready.size,candidate.length);
      const replay=transfer(await http.call(uploadPath(),{method:'POST',userId:guardian.userId,body:{clientId:sample.clientId,file:sample.file}}),sample.file,'ready',true);
      assert.equal(replay.id,current.id);assert.equal(replay.size,candidate.length);
      const command={clientId:randomUUID(),body:'가상 실제 검사 첨부',attachments:[{id:current.id}]};
      const message=publicJson(await http.call(`${roomPath}/messages`,{method:'POST',userId:guardian.userId,body:command}),201).message;
      const retry=publicJson(await http.call(`${roomPath}/messages`,{method:'POST',userId:guardian.userId,body:command}),201).message;
      assert.equal(retry.id,message.id);
      assert.equal((await query('SELECT count(*)::integer AS count FROM cb_messages WHERE center_id=$1 AND conversation_id=$2 AND client_id=$3',
        [centerId,conversationId,command.clientId])).rows[0].count,1);
      for(const projected of [message,retry,publicJson(await http.call(`${roomPath}/messages/${message.id}`,{userId:therapist.userId})).message])
        assert.deepEqual(projected.attachments,[{id:current.id,name:sample.file.name,type:sample.file.type,size:candidate.length}]);
      const contentPath=`${roomPath}/messages/${message.id}/attachments/${current.id}/content`;
      denied(await http.call(contentPath),401,'AUTH_REQUIRED');
      denied(await http.call(contentPath,{userId:guardian.userId,expectedAccount:therapist.userId}),401,'AUTH_REQUIRED');
      for(const headers of [{},{Range:'bytes=1-4'}]){
        const content=await http.call(contentPath,{userId:therapist.userId,headers});assert.equal(content.status,200);assert.deepEqual(content.buffer,candidate);
        assert.equal(content.headers['content-type'],sample.file.type);assert.equal(content.headers['content-length'],String(candidate.length));
        assert.equal(content.headers['accept-ranges'],'none');assert.equal(content.headers['cache-control'],'no-store');
        assert.equal(content.headers['cross-origin-resource-policy'],'same-origin');assert.equal(content.headers['x-content-type-options'],'nosniff');
        assert.equal(content.headers['referrer-policy'],'no-referrer');assert.match(content.headers['content-disposition'],/^attachment; filename="download\.(png|mp4|webm)"$/);
        for(const header of ['etag','last-modified','content-range','access-control-allow-origin'])assert.equal(content.headers[header],undefined);
        content.buffer.fill(0);
      }
      const access=new MediaAccess(app,store),request={conversationId,uploadId:current.id,source:{kind:'message',messageId:message.id}};
      assert.deepEqual(await collect((await access.open(therapist,request)).stream),candidate);await assert.rejects(access.open(manager,request),{code:'NOT_FOUND'});
      assert.equal(transfer(await http.call(uploadPath(current.id),{userId:guardian.userId}),sample.file,'bound').size,candidate.length);
      assert.equal((await row(current.id)).state,'bound');assert.deepEqual(await queue(current.id),{state:'completed',attempts:1});candidate.fill(0);
      // Bind recovery checks to these actually processed HTTP samples, not an
      // arbitrary preparation row or a protocol double from another fixture.
      if(sample.name==='PNG'||sample.name==='video')preparedRecoverySamples.push({uploadId:current.id,type:current.type,
        sourceKey:current.object_key,derivativeKey:current.candidate_key,sourceSize:current.size,derivativeSize:current.prepared_size,
        sourceSha256:current.sha256,derivativeSha256:current.prepared_sha256});
      checks.push(`separate runtime API child authenticates and HTTP reserves/receives ${sample.name}; DPAPI/TLS worker proves native source/candidate scans and closed durable job; HTTP status/retry/message binds once and authorized content returns only E candidate, with unauthenticated/account-mismatch refusal and center domain refusal`);
    }
    phase=605;const bad=await row(invalid.received.id);assert.equal(bad.state,'quarantined');assert.equal(bad.failure_code,'SCAN_INVALID');
    assert.equal((await query('SELECT count(*)::integer AS count FROM cb_media_preparations WHERE upload_id=$1',[bad.id])).rows[0].count,0);
    await assert.rejects(uploads.open(guardian,{conversationId,uploadId:bad.id}),{code:'UPLOAD_STATE'});
    const cleanCancelled=async(id)=>{const current=await row(id);await uploads.cancel(guardian,input(current));
      maintenance=await open(workerEntry,endpoint);assert.equal((await new MediaUploads(maintenance,store).cleanup()).failed,0);await close(maintenance);maintenance=null;
      assert.equal((await row(id)).state,'deleted');};
    await cleanCancelled(bad.id);invalidBytes.fill(0);
    checks.push('native-clean but invalid PNG pixels remain quarantined/retry without proof or preview; explicit cancellation fences E objects');
    for(const mode of ['stop','disconnect']){
      phase=mode==='stop'?606:607;const sample=await receive(syntheticPng()),before=new Set((await jobs()).map(job=>job.run)),held=launch('hold-input');await held.started;
      let running;const deadline=Date.now()+45000;
      while(!running){if(held.control.status().terminal||held.badOutput)throw new Error('NATIVE_HELD_EARLY_EXIT');
        await observeTls();for(const job of await jobs())if(!before.has(job.run)&&job.container_id){const receipt=decoderReceipt(job.container_id,job.run,'job');
          const actual=await fixture.runtime.inspect('container',job.container_id);if(actual.State.Running){assertDecoderIsolation(actual,receipt,fixture.approvedImageId,true);running=job;break;}}
        if(!running){if(Date.now()>=deadline)throw new Error('NATIVE_HELD_NOT_RUNNING');await delay(50);}}
      assert.equal((await row(sample.received.id)).state,'inspecting');await stop(held,mode);
      const stopped=await row(sample.received.id);assert.equal(stopped.state,'quarantined');assert.deepEqual(await queue(stopped.id),{state:'retry',attempts:1});
      const handle=await store.openVerified(stopped.object_key,sample.file);try{assert.deepEqual(await handle.readFile(),sample.bytes);}finally{await handle.close();}
      assert.equal((await query('SELECT count(*)::integer AS count FROM cb_media_preparations WHERE upload_id=$1',[stopped.id])).rows[0].count,0);
      await cleanCancelled(stopped.id);sample.bytes.fill(0);
      checks.push(mode==='stop'?'actual Running native decoder is interrupted by inherited IPC stop; exact container/journal drain and TLS pool close precede real zero exit; E source remains retryable':
        'loss of inherited channel during actual Running native decoder fails nonzero only after exact container/journal drain and TLS pool close; E source remains retryable');
    }
    phase=608;await noNativeJobs();assert.equal((await jobs()).length,6);assert.equal(checks.length,6);
    // A separate synthetic center avoids changing the original privilege
    // fixture or reusing already-bound HTTP samples as purported UI evidence.
    if(verifyBrowser){
    phase=609;
    const uiSeed=await seedNativeApiTestFixture({owner,runtime:app});credentials.push(...uiSeed.credentials);
    const uiSamples=[{name:'PNG',bytes:addPrivateMetadata(syntheticPng(),'image/png',6),type:'image/png',frames:1},
      {name:'video',bytes:Buffer.from(fixture.video.bytes),type:fixture.video.type,frames:fixture.video.frames}];
    const uiWorker=launch('complete');await uiWorker.started;
    try {
      browser=await exercisePreparedMediaBrowser({origin:api.origin,centerId:uiSeed.centerId,conversationId:uiSeed.conversationId,
        credentials:uiSeed.credentials,samples:uiSamples,browserRuntime,
        evidenceDirectory:fileURLToPath(new URL(`../test-results/native-prepared-${database.storage.syntheticRunId}/`,import.meta.url)),
        onOwned:owned=>{browserOwned=owned;}});
      assert.equal(browser.passed,true);assert.equal(browser.cleanup.contextsClosed,true);assert.equal(browser.cleanup.browserStopped,true);
      assert.deepEqual(browser.errors,[]);assert.deepEqual(browser.unexpectedRequests,[]);
      assert.equal(browser.deliveries.length,2);assert.equal(browser.contentEvidence.length,2);
      assert.equal(new Set(browser.deliveries.map(value=>value.uploadId)).size,2);
      assert.equal(new Set(browser.deliveries.map(value=>value.messageId)).size,2);
      for(const [index,delivery]of browser.deliveries.entries()){
        const sample=uiSamples[index],current=await row(delivery.uploadId);
        assert.equal(current.center_id,uiSeed.centerId);assert.equal(current.conversation_id,uiSeed.conversationId);
        assert.equal(current.owner_id,uiSeed.guardian.userId);assert.equal(current.state,'bound');
        assert.equal(current.bound_message_id,delivery.messageId);assert.equal(current.type,sample.type);assert.equal(delivery.type,sample.type);
        assert.equal(current.sha256,hash(sample.bytes));assert.equal(current.size,sample.bytes.length);
        assert.notEqual(current.object_key,current.candidate_key);
        const bindings=(await query(`SELECT message_id,upload_id FROM cb_message_attachments
          WHERE center_id=$1 AND conversation_id=$2 AND upload_id=$3`,[uiSeed.centerId,uiSeed.conversationId,current.id])).rows;
        assert.deepEqual(bindings,[{message_id:delivery.messageId,upload_id:current.id}]);
        const proofs=(await query('SELECT evidence FROM cb_media_preparations WHERE upload_id=$1',[current.id])).rows;
        assert.equal(proofs.length,1);const evidence=proofs[0].evidence;assert.equal(evidence.mediaAcceptanceReady,false);
        for(const scan of [evidence.sourceScan,evidence.derivativeScan]){
          assert.equal(scan.engineVersion,'1.4.6');assert.equal(scan.databaseVersion,fixture.status.databaseVersion);assert.equal(scan.verdict,'clean');}
        for(const decode of [evidence.preparation.sourceDecode,evidence.preparation.derivativeDecode]){
          assert.equal(decode.engineVersion,'9.0.2');assert.equal(decode.decodedVideoFrames,sample.frames);}
        assert.equal(evidence.preparation.sourceTimelineSha256,evidence.preparation.derivativeTimelineSha256);
        assert.deepEqual(await queue(current.id),{state:'completed',attempts:1});
        const source=await store.openVerified(current.object_key,{type:sample.type,size:sample.bytes.length,sha256:hash(sample.bytes)});
        try{assert.deepEqual(await source.readFile(),sample.bytes);}finally{await source.close();}
        const candidate=await collect((await new MediaAccess(app,store).open(uiSeed.therapist,
          {conversationId:uiSeed.conversationId,uploadId:current.id,source:{kind:'message',messageId:delivery.messageId}})).stream);
        try {
          assert.equal(hash(candidate),current.prepared_sha256);assert.equal(candidate.length,current.prepared_size);
          assert.equal(candidate.includes(Buffer.from(PRIVATE_MARKER)),false);
          const viewed=browser.contentEvidence.find(value=>value.uploadId===current.id&&value.messageId===delivery.messageId);
          assert.ok(viewed);assert.equal(viewed.type,sample.type);assert.equal(viewed.size,candidate.length);assert.equal(viewed.sha256,hash(candidate));
        }finally{candidate.fill(0);}
      }
      await stop(uiWorker);await noNativeJobs();assert.equal((await jobs()).length,8);
      checks.push('two independent same-machine browser sessions actually upload synthetic PNG/video, wait for real native approval, send once and render only authenticated candidate blobs; exact E evidence matches UI bytes and all owned browser processes stop');
      assert.equal(checks.length,7);
    }finally{uiSeed.forgetCredentials();for(const sample of uiSamples)sample.bytes.fill(0);}
    }
  } catch(error){failure=true;if(error?.diagnostic)failure=error.diagnostic;
    if(error?.browserObservation)browser=error.browserObservation;
    const categories=['NATIVE_WORKER_EARLY_EXIT','NATIVE_WORKER_OUTCOME_TIMEOUT','NATIVE_HELD_EARLY_EXIT','NATIVE_HELD_NOT_RUNNING','NATIVE_WORKER_OBSERVATION_TIMEOUT','NATIVE_WORKER_ADMISSION_FAILED'];
    failureCategory=categories.includes(error?.message)?error.message:error?.code==='ERR_ASSERTION'?'ASSERTION':'CHECK_UNAVAILABLE';
    failureLine=Number(/windows-native-worker-check\.mjs:(\d{1,4}):/.exec(error?.stack??'')?.[1])||null;}
  finally {
    // Browser ownership ends before closing the HTTP API it is exercising.
    // A close timeout or absent process is never substituted for its terminal
    // evidence; the helper lifetime retains and awaits actual disposal.
    if(browserOwned)try{await browserOwned.close();const state=browserOwned.status();
      assert.equal(state.contextsClosed,true);assert.equal(state.browserStopped,true);
    }catch{failure=true;}
    const browserStopped=!browserOwned||(browserOwned.status().contextsClosed&&browserOwned.status().browserStopped);
    // The API can own late opens after its HTTP caller disconnects. Its actual
    // listener/media drain and child terminal evidence precede fixture cleanup.
    if(browserStopped&&api)try{await api.close();const state=api.status();
      assert.equal(state.ready,true);assert.equal(state.stopped,true);assert.equal(state.terminal,true);
      assert.equal(state.closeObserved,true);assert.equal(state.stdioClosed,true);assert.equal(state.exitCode,0);assert.equal(state.signalCode,null);
      assert.equal(state.observationTimedOut,false);assert.equal(state.failureCode,null);apiCleanup=true;
    }catch{failure=true;}
    http?.forget();for(const credential of credentials){credential.password='';credential.email='';}credentials.length=0;
    for(const entry of children)if(browserStopped&&!entry.control.status().terminal){entry.control.requestStop().catch(()=>{});
      if(!entry.child.stdin.writableEnded)entry.child.stdin.end('RELEASE\n');
      // Timeout is only lost observation, never proof that the owned child
      // stopped. Do not kill/restart it or remove its possibly live fixture.
      try{await entry.pending;}catch{if(!entry.control.status().terminal)failure=true;}}
    const resourcesStopped=browserStopped&&(!api||api.status().terminal)&&children.every(entry=>entry.control.status().terminal);
    if(resourcesStopped){
      for(const service of [maintenance,app])if(service)try{await close(service);}catch{failure=true;}
      if(fixture)try{await fixture.close();fixtureCleanup=true;}catch{failure=true;}
    }else failure=true;
  }
  const observedStage=(entry,stage,edge)=>entry.diagnostic.snapshot().stageCounts.some(item=>item.stage===stage&&item[edge]>0);
  const stageObservationCoverage={
    lifecycle:children.length>0&&children.every(entry=>['db-open','worker-admission','db-close'].every(stage=>observedStage(entry,stage,'complete'))),
    preparation:['source-open','source-scan','source-reopen','isolated-preparation','candidate-validation','candidate-scan',
      'candidate-write','candidate-verify','settlement'].every(stage=>children.some(entry=>observedStage(entry,stage,'complete'))),
    processingBudgetPreserved:children.every(entry=>!entry.diagnostic.snapshot().stageLimits.work&&!entry.diagnostic.snapshot().stageLimits.lifecycle),
  };
  if(!Object.values(stageObservationCoverage).every(Boolean)){if(!failure)failureCategory='STAGE_OBSERVATION_INCOMPLETE';failure=true;}
  const observation={stageObservationCoverage,browserRequested:verifyBrowser,preparedRecoverySamples,
    childCount:children.length,allChildrenTerminal:children.every(entry=>entry.control.status().terminal)&&(!api||api.status().terminal)&&
    (!browserOwned||browserOwned.status().contextsClosed&&browserOwned.status().browserStopped),
    apiChild:api?{cleanup:apiCleanup,...api.status()}:null,
    browser:browser?{runId:browser.runId,passed:browser.passed===true,checks:browser.checks,screenshots:browser.screenshots,cleanup:browser.cleanup,
      cleanupObservationTimedOut:browser.cleanupObservationTimedOut,failure:browser.failure,
      errors:browser.errors,unexpectedRequests:browser.unexpectedRequests}:null,
    fixtureCleanup,tlsObserved,ownerStatisticsRestricted,failureCategory,failureLine,lastQueueStates,fixture:fixture?.diagnostics()??(typeof failure==='object'?failure:null),
    terminalEvidence:children.map(({mode,control,diagnostic,admission})=>({mode,...control.status(),admission:admission.status(),diagnostic:diagnostic.snapshot()}))};
  if(failure){const error=new Error('WINDOWS_NATIVE_WORKER_CHECK_FAILED');error.roleCheckPhase=phase;error.nativeMediaObservation=observation;throw error;}
  return {checks,...observation,scenarioCount:checks.length};
}

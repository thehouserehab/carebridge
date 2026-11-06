// A directly owned fresh synthetic E child only. Actual engine/AV bytes, not
// fake preparation. Inherited IPC controls the product process; stdin is only
// a test gate holding its real decoder input, never a production command.
import assert from 'node:assert/strict';
import {lstat,readFile} from 'node:fs/promises';
import {win32} from 'node:path';
import {Readable} from 'node:stream';
import {finished} from 'node:stream/promises';
import {windowsNativeWorkerBootstrap,nativeWorkerStageReporter,nativeDatabaseStageReporter} from './windows-native-worker-test-policy.mjs';
import {mediaWorkerControlId} from './media-worker-control-protocol.mjs';
import {runWindowsMediaWorkerControlledProcess} from './media-worker-controlled-process.mjs';
import {PrivateFileStore} from './private-file-store.mjs';
import {LocalClamAvClient} from './clamav-client.mjs';
import {localDockerTestRuntime} from './local-docker-test-runtime.mjs';
import {syntheticWorkerAdmissionReporter} from './windows-synthetic-worker-policy.mjs';
let gateInput='';const release=Promise.withResolvers();
process.stdin.on('error',()=>{});
process.stdin.on('data',data=>{
  gateInput+=data.toString('ascii');
  if(gateInput==='RELEASE\n')release.resolve();else if(gateInput.length>=8)release.reject(new Error('SYNTHETIC_GATE'));
});
process.stdin.on('end',()=>{if(gateInput!=='RELEASE\n')release.reject(new Error('SYNTHETIC_GATE'));});
release.promise.catch(()=>{});
process.once('message',async bootstrap=>{
  try {
    process.stderr.write('NATIVE_PHASE_1\n');
    assert.equal(process.platform,'win32');assert.equal(process.env.CAREBRIDGE_NATIVE_WORKER_TEST_CHILD,'synthetic-only');
    const instanceId=mediaWorkerControlId(process.argv[2]),input=windowsNativeWorkerBootstrap(bootstrap);
    for(const path of [input.root,input.mediaRoot]){const info=await lstat(path);assert.ok(info.isDirectory()&&!info.isSymbolicLink());}
    const receipt=JSON.parse(await readFile(win32.join(input.root,'.carebridge-check.json')));
    assert.deepEqual(receipt,{schema:1,purpose:'synthetic-native-e-postgres',runId:input.database.storage.syntheticRunId,root:input.root});
    process.stderr.write('NATIVE_PHASE_2\n');
    const runtime=await localDockerTestRuntime();assert.equal(await runtime.identity(),input.nativeMedia.engineIdentity);
    process.stderr.write('NATIVE_PHASE_3\n');
    const observed={...runtime,async exchange(id,packet,options) {
      if(input.mode!=='hold-input')return runtime.exchange(id,packet,options);
      let held=false;
      const gated=Readable.from((async function*(){
        for await(const bytes of packet){yield bytes;if(!held){held=true;process.stdout.write('NATIVE_PREPARING\n');await release.promise;}}
      })(),{objectMode:false});
      void finished(gated,{cleanup:true}).catch(()=>{});
      try{return await runtime.exchange(id,gated,options);}finally{gated.destroy();packet.destroy();}
    }};
    const scanner=new LocalClamAvClient({endpoint:input.nativeMedia.scannerEndpoint,approvedEngineVersions:['1.4.6'],daemonTimeZone:'UTC',maxConcurrent:1});
    process.stderr.write('NATIVE_PHASE_4\n');
    const reportStage=nativeWorkerStageReporter(frame=>process.stderr.write(frame));
    const reportAdmission=syntheticWorkerAdmissionReporter(instanceId,frame=>process.stdout.write(frame));
    await runWindowsMediaWorkerControlledProcess({database:input.database,media:{store:new PrivateFileStore(input.mediaRoot),scanner,runtime:observed,
      engineIdentity:input.nativeMedia.engineIdentity,approvedImageId:input.nativeMedia.approvedImageId,capacity:1,pollMilliseconds:50,
      onStage:event=>{reportStage(event);reportAdmission(event);},
      onDatabaseStage:nativeDatabaseStageReporter(frame=>process.stderr.write(frame))}},{instanceId});
    process.stderr.write('NATIVE_PHASE_5\n');
  } catch {process.stderr.write('NATIVE_CAUGHT\n');process.exitCode=1;}
  finally {process.stderr.write('NATIVE_PHASE_6\n');process.stdin.destroy();if(process.connected)process.disconnect();}
});

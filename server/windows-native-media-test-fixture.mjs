// Reusable, explicit synthetic fixture. No DB, E/user files, operating service,
// inbound external ports, global Docker changes, pulls or production approval.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {localDockerTestRuntime} from './local-docker-test-runtime.mjs';
import {startWindowsClamAvTestBridge} from './windows-clamav-test-bridge.mjs';
import {LocalClamAvClient} from './clamav-client.mjs';
import {IsolatedMediaDecoder} from './decoder-jobs.mjs';
import {MediaPreparation} from './media-preparation.mjs';
import {CLAMAV_TEST_IMAGE,NODE_TEST_IMAGE,RUN_LABEL,testResourceNames,resourceReceipt,volumeReceipt,
  assertVolumeOwner,assertContainerOwner,containerArguments,assertContainerIsolation} from './clamav-container-policy.mjs';
import {DECODER_RUN_LABEL,decoderResourceNames,decoderReceipt,decoderContainerArguments,assertDecoderOwner,assertDecoderIsolation} from './decoder-container-policy.mjs';
const directory=dirname(fileURLToPath(import.meta.url));

export function createWindowsNativeMediaTestFixture() { return createEnvironment(true); }
// Human-operated synthetic session: actual AV/decoder, no generated videos or
// automatic assertions against user input. No operating-service activation.
export function createWindowsSyntheticMediaEnvironment({signal,onOwned} = {}) {
  if(signal!==undefined&&!(signal instanceof AbortSignal)||onOwned!==undefined&&typeof onOwned!=='function')
    throw new Error('WINDOWS_NATIVE_MEDIA_FIXTURE_UNAVAILABLE');
  return createEnvironment(false,{signal,onOwned});
}
async function createEnvironment(includeSamples,{signal,onOwned} = {}) {
  const names=testResourceNames(randomUUID()),workerNames=decoderResourceNames(randomUUID()),encoderNames=decoderResourceNames(randomUUID());
  const artifacts=new Map(),receipts={},jobs=new Set();let runtime,engine,definitions,bridge,decoder,scanner,retain=false,closePromise,createCount=0;
  const diagnostics=()=>({runId:names.run,workerRunId:workerNames.run,encoderRunId:encoderNames.run});
  async function build(file,tag,label,run,target,offline=true) {
    retain=true;
    await runtime.docker(['build','--builder','desktop-linux','--pull=false','--load',...(offline?['--network=none']:[]),
      ...(target?['--target',target]:[]),'--label',`${label}=${run}`,'--tag',tag,'--file',join(directory,file),dirname(directory)],{timeout:900000});
    const value=await runtime.inspect('image',tag);assert.equal(value.Config.Labels[label],run);assert.equal(value.Os,'linux');assert.equal(value.Architecture,'amd64');
    artifacts.set(tag,{id:value.Id,label,run});retain=false;return value.Id;
  }
  async function avCreate(role,image) {
    retain=true;const id=await runtime.docker(containerArguments(names,role,image)),receipt=resourceReceipt(id,role,names.run);receipts[role]=receipt;
    assertContainerIsolation(await runtime.inspect('container',id),receipt,image);retain=false;return receipt;
  }
  async function noJobs() {
    assert.deepEqual(decoder?.retainedJobs()??[],[]);
    if(workerImageId)assert.equal(await runtime.docker(['ps','--all','--filter',`ancestor=${workerImageId}`,'--format','{{.ID}}']),'');
    for(const id of jobs)assert.equal(await runtime.docker(['ps','--all','--no-trunc','--filter',`id=${id}`,'--format','{{.ID}}']),'');
    jobs.clear();await bridge?.idle();assert.deepEqual(bridge?.retainedRelays()??[],[]);
  }
  function close() {
    if(closePromise)return closePromise;
    closePromise=(async()=>{
      // No normal cleanup if creation/termination or native ownership is
      // uncertain. Keep its exact fixture for diagnosis, never prune globally.
      await bridge?.close();if(retain)throw new Error('RETAIN');await noJobs();
      if(!runtime)return;
      assert.equal(await runtime.identity(),engine);
      if(generator) {
        const state=await runtime.inspect('container',generator.id);assertDecoderOwner(state,generator,encoderImageId);
        assert.equal(state.State.Running,false);await runtime.docker(['rm',generator.id]);generator=null;
      }
      for(const role of ['scanner','updater'])if(receipts[role]) {
        const receipt=receipts[role];let state=await runtime.inspect('container',receipt.id);assertContainerOwner(state,receipt,avImageId);
        if(state.State.Running){assert.equal(role,'scanner');await runtime.docker(['stop','--timeout','10',receipt.id],{timeout:20000});}
        state=await runtime.inspect('container',receipt.id);assertContainerOwner(state,receipt,avImageId);assert.equal(state.State.Running,false);
        await runtime.docker(['rm',receipt.id]);delete receipts[role];
      }
      if(definitions) {
        assertVolumeOwner(await runtime.inspect('volume',definitions.name),definitions);
        assert.equal(await runtime.docker(['ps','--all','--quiet','--filter',`volume=${definitions.name}`]),'');
        await runtime.docker(['volume','rm',definitions.name]);definitions=null;
      }
      for(const[tag,{id,label,run}]of artifacts) {
        const value=await runtime.inspect('image',tag);assert.equal(value.Id,id);assert.equal(value.Config.Labels[label],run);assert.deepEqual(value.RepoTags,[tag]);
        assert.equal(await runtime.docker(['ps','--all','--filter',`ancestor=${id}`,'--format','{{.ID}}']),'');await runtime.docker(['image','rm',tag]);artifacts.delete(tag);
      }
      return {closed:true};
    })();
    // Retain ownership facts after a transient observation failure. A later
    // explicit close re-observes them; uncertain creation still blocks cleanup.
    void closePromise.catch(()=>{closePromise=undefined;});return closePromise;
  }
  let avImageId,workerImageId,relayImageId,encoderImageId,generator;
  try {
    onOwned?.(Object.freeze({close,diagnostics}));signal?.throwIfAborted();
    assert.equal(process.platform,'win32');runtime=await localDockerTestRuntime();engine=await runtime.identity();await runtime.localBuilder();
    assert.ok(runtime.memoryBytes>=6*1024**3);await runtime.officialImage(CLAMAV_TEST_IMAGE);await runtime.officialImage(NODE_TEST_IMAGE);
    avImageId=await build('clamav-test.Dockerfile',names.engineImage,RUN_LABEL,names.run,'engine');
    signal?.throwIfAborted();
    relayImageId=await build('clamav-relay-test.Dockerfile',names.workerImage,RUN_LABEL,names.run);
    signal?.throwIfAborted();
    workerImageId=await build('decoder-job.Dockerfile',workerNames.image,DECODER_RUN_LABEL,workerNames.run,'worker',false);
    signal?.throwIfAborted();
    if(includeSamples)encoderImageId=await build('decoder-test.Dockerfile',encoderNames.image,DECODER_RUN_LABEL,encoderNames.run,'fixtures',false);
    assert.equal((await runtime.docker(['volume','ls','--format','{{.Name}}'])).split(/\r?\n/).includes(names.volume),false);
    retain=true;assert.equal(await runtime.docker(['volume','create','--driver','local','--label',`${RUN_LABEL}=${names.run}`,names.volume]),names.volume);
    definitions=volumeReceipt(await runtime.inspect('volume',names.volume),names.run);retain=false;
    const updater=await avCreate('updater',avImageId);retain=true;
    const update=await runtime.command(['start','--attach',updater.id],{timeout:600000});
    const updated=await runtime.inspect('container',updater.id);assertContainerIsolation(updated,updater,avImageId);
    assert.equal(updated.State.Status,'exited');retain=false;assert.equal(update.code,0);assert.equal(updated.State.ExitCode,0);assert.equal(updated.State.OOMKilled,false);
    signal?.throwIfAborted();
    const scannerReceipt=await avCreate('scanner',avImageId);await runtime.docker(['start',scannerReceipt.id]);
    assertContainerIsolation(await runtime.inspect('container',scannerReceipt.id),scannerReceipt,avImageId,{running:true});
    bridge=await startWindowsClamAvTestBridge({runtime,engineIdentity:engine,scannerReceipt,scannerImageId:avImageId,relayImageId});
    class CountingScanner extends LocalClamAvClient {calls=0;async scan(...args){this.calls++;return super.scan(...args);}}
    scanner=new CountingScanner({endpoint:bridge.endpoint,approvedEngineVersions:['1.4.6'],daemonTimeZone:'UTC',maxConcurrent:1});
    let status;const deadline=Date.now()+120000;
    while(Date.now()<deadline){signal?.throwIfAborted();try{status=await scanner.status();break;}catch{if(bridge.status().uncertain)throw new Error('RETAIN');await delay(500);}}
    assert.equal(status?.available,true);
    const observed={...runtime,async docker(args,options){const id=await runtime.docker(args,options);if(args[0]==='create'){jobs.add(id);createCount++;}return id;}};
    decoder=new IsolatedMediaDecoder({runtime:observed,engineIdentity:engine,approvedImageId:workerImageId});
    let video;
    if(includeSamples){
    // Public synthetic video generator only. No data from user paths or E.
    retain=true;const generatorId=await runtime.docker(decoderContainerArguments(encoderNames,encoderImageId));
    generator=decoderReceipt(generatorId,encoderNames.run);assertDecoderIsolation(await runtime.inspect('container',generator.id),generator,encoderImageId);
    const generated=await runtime.command(['start','--attach',generator.id],{timeout:120000});
    const stopped=await runtime.inspect('container',generator.id);assertDecoderIsolation(stopped,generator,encoderImageId);
    assert.equal(stopped.State.Status,'exited');retain=false;assert.equal(generated.code,0);assert.equal(stopped.State.ExitCode,0);assert.equal(stopped.State.OOMKilled,false);
    const payload=JSON.parse(generated.output);assert.equal(payload.protocol,'carebridge-synthetic-fixtures-v1');assert.equal(payload.fixtures.length,17);
    const selected=payload.fixtures.find(value=>value.name==='h264.mp4');assert.ok(selected);const {base64,...metadata}=selected;
    video={...metadata,bytes:Buffer.from(base64,'base64')};
    await runtime.docker(['rm',generator.id]);generator=null;
    }
    signal?.throwIfAborted();
    const pipeline=new MediaPreparation({scanner,preparer:decoder,maxConcurrent:1});await noJobs();
    return Object.freeze({runtime,engine,scanner,pipeline,decoder,bridge,...(includeSamples?{video}:{}),status,
      noJobs,close,diagnostics,approvedImageId:workerImageId,relayImageId,
      counts:()=>Object.freeze({decoderCreates:createCount,...bridge.status()})});
  } catch {
    let retained=false;try{await close();}catch{retained=true;}
    const error=new Error('WINDOWS_NATIVE_MEDIA_FIXTURE_UNAVAILABLE');error.diagnostic={...diagnostics(),retained};throw error;
  }
}

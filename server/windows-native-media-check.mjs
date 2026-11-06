// Opt-in synthetic Windows + actual offline ClamAV/FFmpeg rehearsal.
// Not a live-beta command. No DB/E data, external listener or file approval.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {Socket} from 'node:net';
import {deflateSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {createWindowsNativeMediaTestFixture} from './windows-native-media-test-fixture.mjs';
import {syntheticPng,animatedPng,addPrivateMetadata,pngChunk} from './image-metadata-test-fixtures.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const manifest=(bytes,type='image/png')=>({type,size:bytes.length,sha256:digest(bytes)});
const stream=bytes=>Readable.from([bytes],{objectMode:false});
let fixture,passed=0,complete=false,failed=false,phase=1;
async function scenario(name,work){await work();await fixture.noJobs();passed++;console.log(`PASS ${name}`);}
async function holdRelay() {
  const socket=new Socket();socket.on('error',()=>{});
  await new Promise((yes,no)=>{socket.once('connect',yes);socket.once('error',no);socket.connect(fixture.bridge.endpoint);});
  socket.write(Buffer.concat([Buffer.from('zINSTREAM\0'),Buffer.from([0,0,0,20])]));
  const deadline=Date.now()+15000;
  while(Date.now()<deadline) {
    for(const row of fixture.bridge.retainedRelays())if(row.id) {
      const value=await fixture.runtime.inspect('container',row.id);
      if(value.State.Running)return {socket,id:row.id};
    }
    await delay(20);
  }
  socket.destroy();throw new Error('RELAY_NOT_RUNNING');
}
try {
  assert.equal(process.argv.length,2);fixture=await createWindowsNativeMediaTestFixture();
  console.log(`Windows native media run: ${fixture.diagnostics().runId}`);
  await scenario('actual approved UTC scanner status through temporary Windows loopback with no published Docker port',async()=>{
    assert.equal(fixture.status.engineVersion,'1.4.6');assert.equal(fixture.status.mediaAcceptanceReady,false);
    console.log(`Engine: ClamAV 1.4.6; definitions ${fixture.status.databaseVersion}; UTC ${fixture.status.databaseUpdatedAt}`);
  });
  phase=2;
  for(const[name,bytes,type,frames]of [['PNG',addPrivateMetadata(syntheticPng(),'image/png',6),'image/png',1],
    ['APNG',addPrivateMetadata(animatedPng(syntheticPng()),'image/png',6),'image/png',2],
    ['video',fixture.video.bytes,fixture.video.type,fixture.video.frames]])
    await scenario(`Windows source and candidate native scans plus actual binary preparation ${name}`,async()=>{
      const before=Buffer.from(bytes),calls=fixture.scanner.calls;
      const result=await fixture.pipeline.prepare({...manifest(bytes,type),openSource:()=>stream(bytes)});
      assert.equal(result.status,'prepared');assert.equal(result.mediaAcceptanceReady,false);assert.equal(fixture.scanner.calls-calls,2);
      assert.deepEqual(bytes,before);assert.equal(result.report.source.sha256,digest(bytes));assert.equal(result.report.derivative.sha256,digest(result.bytes));
      assert.equal(result.report.preparation.sourceDecode.decodedVideoFrames,frames);assert.equal(result.report.preparation.derivativeDecode.decodedVideoFrames,frames);
      assert.equal(result.report.preparation.sourceTimelineSha256,result.report.preparation.derivativeTimelineSha256);
      assert.equal(result.bytes.includes(Buffer.from('SYNTHETIC_PRIVATE_IMAGE_METADATA')),false);result.bytes.fill(0);before.fill(0);
    });
  phase=3;
  await scenario('raw harmless anti-malware control is rejected before any decoder is created',async()=>{
    const bytes=Buffer.concat([Buffer.from('X5O!P%@AP[4'),Buffer.from([92]),Buffer.from('PZX54(P^)7CC)7}$'),Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')]);
    const before=fixture.counts().decoderCreates,result=await fixture.pipeline.prepare({...manifest(bytes),openSource:()=>stream(bytes)});
    assert.equal(result.status,'rejected');assert.equal(result.stage,'source');assert.equal(Object.hasOwn(result,'bytes'),false);assert.equal(fixture.counts().decoderCreates,before);bytes.fill(0);
  });
  phase=4;
  await scenario('clean native anti-malware scan cannot approve illegally filtered PNG pixels',async()=>{
    const png=syntheticPng(),rows=Buffer.alloc(24*97,100);for(let row=0;row<24;row++)rows[row*97]=99;
    const bytes=Buffer.concat([png.subarray(0,33),pngChunk('IDAT',deflateSync(rows)),pngChunk('IEND',Buffer.alloc(0))]);
    assert.equal((await fixture.scanner.scan({...manifest(bytes),stream:stream(bytes)})).verdict,'clean');
    await assert.rejects(fixture.pipeline.prepare({...manifest(bytes),openSource:()=>stream(bytes)}),{code:'SCAN_INVALID'});rows.fill(0);bytes.fill(0);
  });
  phase=5;
  await scenario('source hash mismatch cannot send a valid final scan marker or produce a candidate',async()=>{
    const bytes=syntheticPng();await assert.rejects(fixture.pipeline.prepare({...manifest(bytes),sha256:'0'.repeat(64),openSource:()=>stream(bytes)}),{code:'SCAN_INVALID'});
  });
  phase=6;
  await scenario('cancelled actual relay is independently terminated and removed before a fresh status succeeds',async()=>{
    const held=await holdRelay();held.socket.destroy();await fixture.bridge.idle();
    assert.equal(await fixture.runtime.docker(['ps','--all','--no-trunc','--filter',`id=${held.id}`,'--format','{{.ID}}']),'');
    assert.equal((await fixture.scanner.status()).available,true);
  });
  phase=7;
  await scenario('bridge close is idempotent and drains an actually running relay without stopping its scanner',async()=>{
    const held=await holdRelay();const first=fixture.bridge.close();assert.equal(fixture.bridge.close(),first);assert.deepEqual(await first,{closed:true});held.socket.destroy();
    assert.equal(await fixture.runtime.docker(['ps','--all','--no-trunc','--filter',`id=${held.id}`,'--format','{{.ID}}']),'');
    await assert.rejects(fixture.scanner.status(),{code:'SCAN_UNAVAILABLE'});assert.equal(fixture.bridge.status().uncertain,false);
  });
  assert.equal(passed,9);complete=true;console.log('Windows native media preparation: 9 scenarios passed.');
} catch(error) {
  failed=true;console.error(`WINDOWS_NATIVE_MEDIA_CHECK_FAILED_PHASE_${phase}`);
  if(error?.diagnostic)console.error(JSON.stringify(error.diagnostic));
  if(['SCAN_INVALID','SCAN_UNAVAILABLE'].includes(error?.code))console.error(error.code);
  const line=/windows-native-media-check\.mjs:(\d{1,4}):/.exec(error?.stack??'')?.[1];if(line)console.error(`WINDOWS_NATIVE_MEDIA_ASSERTION_LINE_${line}`);
} finally {
  try{await fixture?.close();if(complete)console.log('PASS exact owned relays decoder jobs scanner definitions and image tags removed');}
  catch{failed=true;console.error('WINDOWS_NATIVE_MEDIA_RETAINED');if(fixture)console.error(JSON.stringify(fixture.diagnostics()));}
  if(failed||!complete)process.exitCode=1;
}

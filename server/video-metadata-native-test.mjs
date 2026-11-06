// Offline synthetic encoder test, never loaded into the application or a
// production/minimal decoder job. No clinical media or private paths enter.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp,readFile,writeFile,readdir,unlink,rmdir,lstat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { LinuxMediaDecoder } from './media-decoder.mjs';
import { decoderArguments } from './media-decoder-policy.mjs';
import { open } from 'node:fs/promises';
import { prepareVideoDerivative } from './video-metadata.mjs';
import { VIDEO_PRIVATE_MARKER,mp4Find,webmWithSyntheticRoll } from './video-metadata-test-fixtures.mjs';
import { pngChunks } from './image-metadata-test-fixtures.mjs';
const root = '/opt/carebridge/ffmpeg/bin/',sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const decoder = new LinuxMediaDecoder({ approvedBinarySha256:'12b72afac0becf6cc5a2d71faf55b83f275f5e8c81083f8ab73df99ce830f681' });
let directory,passed = 0,failed = false;
async function command(binary,args,{ generator = false,limit = 2*1024*1024 } = {}) {
  return new Promise((resolve,reject) => {
    const child = spawn(root+binary,args,{ shell:false,env:{ PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC' },stdio:['ignore','pipe','pipe'] });
    let failed = false,size = 0; const chunks = [];
    const stop = () => { failed = true; child.kill('SIGKILL'); },timer = setTimeout(stop,30000);
    child.stdout.on('data',(bytes) => { size += bytes.length; if (size > limit) stop(); else if (!failed) chunks.push(bytes); });
    // The test encoder x265 writes fixed build/status diagnostics; discard
    // them. Decode/measurement warnings, in contrast, are always failures.
    if (generator) child.stderr.resume(); else child.stderr.on('data',stop);
    child.once('error',stop);
    child.once('close',(code,signal) => { clearTimeout(timer); if (failed || code !== 0 || signal) reject(new Error('VIDEO_NATIVE_COMMAND_FAILED')); else resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}
async function generate(name,{ type = 'video/mp4',video = 'libx264',audio,args = [],width = 32,height = 24,rawTrackTitle = false } = {}) {
  const webm = type === 'video/webm',path = `${directory}/${name}.${webm ? 'webm' : 'mp4'}`;
  const encoding = {
    libx264:['-preset','ultrafast','-pix_fmt','yuv420p'],libx265:['-preset','ultrafast','-x265-params','pools=none:frame-threads=1:wpp=0','-pix_fmt','yuv420p'],
    libvpx:['-deadline','realtime','-cpu-used','5'],'libvpx-vp9':['-deadline','realtime','-cpu-used','8'],'libaom-av1':['-cpu-used','8','-row-mt','0'],mpeg4:[],
  }[video];
  await command('ffmpeg',['-hide_banner','-v','error','-nostdin','-f','lavfi','-i',`testsrc2=s=${width}x${height}:r=2:d=2`,
    ...(audio ? ['-f','lavfi','-i','anullsrc=r=48000:cl=mono','-t','2'] : []),'-threads','1','-c:v',video,...encoding,
    ...(audio ? ['-c:a',audio] : []),'-metadata',`title=${VIDEO_PRIVATE_MARKER}`,'-metadata',`comment=${VIDEO_PRIVATE_MARKER}`,
    '-metadata','creation_time=2025-04-01T12:34:56Z','-metadata:s:v:0',`handler_name=${VIDEO_PRIVATE_MARKER}`,
    ...(webm || rawTrackTitle ? ['-metadata:s:v:0',`title=${VIDEO_PRIVATE_MARKER}`] : []),...args,'-f',webm ? 'webm' : 'mp4',path],{ generator:true });
  return { type,bytes:await readFile(path),audio:!!audio };
}
const input = (bytes,type) => ({ stream:Readable.from([bytes],{ objectMode:false }),type,size:bytes.length,sha256:sha(bytes) });
async function syntheticDecodeDiagnostic(bytes,type) {
  const path = `${directory}/diagnostic-${passed}.bin`; await writeFile(path,bytes,{ flag:'wx',mode:0o600 }); const handle = await open(path,'r');
  try { await new Promise((resolve) => {
    const child = spawn(root+'ffprobe',decoderArguments(type),{ shell:false,env:{ PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC' },stdio:['ignore','ignore','pipe',handle.fd] });
    let diagnostic = ''; const timer = setTimeout(() => child.kill('SIGKILL'),10000);
    child.stderr.on('data',(data) => { if (diagnostic.length < 4096) diagnostic += data.toString('utf8').slice(0,4096-diagnostic.length); });
    child.once('error',() => { clearTimeout(timer); resolve(); }); child.once('close',() => {
      clearTimeout(timer);
      for (const [pattern,label] of [[/overread/i,'OVERREAD'],[/not enough frames/i,'PROBE_FRAMES'],[/Could not find codec parameters/i,'CODEC_PARAMS'],
        [/dref/i,'DREF'],[/protocol|whitelist/i,'PROTOCOL'],[/SEI/i,'SEI'],[/Invalid NAL/i,'NAL'],[/unsupported/i,'UNSUPPORTED'],[/unknown/i,'UNKNOWN'],[/UDTA parsing failed retrying raw/,'UDTA_FALLBACK']])
        if (pattern.test(diagnostic)) console.log(`VIDEO_NATIVE_WARNING_${label}`);
      resolve();
    });
  }); } finally { await handle.close(); }
}
async function measure(bytes,prefix,hasAudio) {
  const path = `${directory}/${prefix}.bin`; await writeFile(path,bytes,{ flag:'wx',mode:0o600 });
  const common = ['-hide_banner','-v','error','-protocol_whitelist','file'];
  await command('ffmpeg',[...common,'-nostdin','-noautorotate','-i',path,'-map','0:v:0','-map_metadata','-1','-an',
    '-pix_fmt','rgba','-c:v','png','-threads','1','-fps_mode','passthrough','-f','image2',`${directory}/${prefix}-frame-%06d.png`]);
  const names = (await readdir(directory)).filter((name) => name.startsWith(prefix+'-frame-') && /-frame-\d{6}\.png$/.test(name)).sort(),pixels = [];
  for (const name of names) pixels.push(sha(Buffer.concat(pngChunks(await readFile(`${directory}/${name}`)).filter((c) => ['IHDR','IDAT'].includes(c.kind)).map((c) => c.data))));
  const document = JSON.parse(await command('ffprobe',[...common,'-show_frames','-show_streams','-show_entries',
    'frame=media_type,stream_index,width,height,best_effort_timestamp_time,duration_time,nb_samples:frame_tags=:frame_side_data=:stream=index,codec_type,codec_name,width,height,sample_rate,channels,sample_aspect_ratio,color_space,color_transfer,color_primaries:stream_tags=:stream_side_data=rotation','-of','json','-i',path]));
  assert.equal(pixels.length,4); assert.ok(document.frames.length >= pixels.length);
  const timing = document.frames.map(({ media_type,stream_index,width,height,best_effort_timestamp_time,duration_time,nb_samples }) =>
    ({ media_type,stream_index,width,height,best_effort_timestamp_time,duration_time,nb_samples }));
  const streams = document.streams.map(({ index,codec_type,codec_name,width,height,sample_rate,channels,sample_aspect_ratio,color_space,color_transfer,color_primaries,side_data_list }) =>
    ({ index,codec_type,codec_name,width,height,sample_rate,channels,sample_aspect_ratio,color_space,color_transfer,color_primaries,
      rotations:(side_data_list ?? []).filter((side) => side.rotation !== undefined).map((side) => side.rotation) }));
  let pcm = [];
  if (hasAudio) {
    const decodedPath = `${directory}/${prefix}-pcm.mka`;
    await command('ffmpeg',[...common,'-nostdin','-i',path,'-map','0:a:0','-map_metadata','-1','-vn','-c:a','pcm_s16le','-threads','1','-f','matroska',decodedPath]);
    const decoded = JSON.parse(await command('ffprobe',[...common,'-show_packets','-show_data_hash','sha256','-show_entries',
      'packet=pts_time,dts_time,duration_time,size,data_hash','-of','json','-i',decodedPath]));
    assert.ok(decoded.packets.length > 0); assert.ok(decoded.packets.every((packet) => /^SHA256:[a-f0-9]{64}$/.test(packet.data_hash))); pcm = decoded.packets;
  }
  return { pixels,timing,streams,pcm };
}
async function compare(fixture,prefix) {
  const source = fixture.bytes,snapshot = Buffer.from(source); let candidate;
  try { candidate = prepareVideoDerivative(source,fixture.type); } catch (error) { console.log('VIDEO_NATIVE_STAGE_PREPARE'); throw error; }
  assert.deepEqual(source,snapshot); assert.equal(source.includes(Buffer.from(VIDEO_PRIVATE_MARKER)),true);
  assert.equal(candidate.bytes.includes(Buffer.from(VIDEO_PRIVATE_MARKER)),false); assert.equal(candidate.bytes.length,source.length);
  assert.equal(candidate.mediaAcceptanceReady,false); const again = prepareVideoDerivative(candidate.bytes,fixture.type);
  assert.deepEqual(again.bytes,candidate.bytes); assert.equal(again.codedPayloadSha256,candidate.codedPayloadSha256); assert.equal(again.displayStateSha256,candidate.displayStateSha256);
  let before,after;
  try { before = await decoder.decode(input(source,fixture.type)); } catch (error) { console.log('VIDEO_NATIVE_STAGE_SOURCE_DECODE'); await syntheticDecodeDiagnostic(source,fixture.type); throw error; }
  try { after = await decoder.decode(input(candidate.bytes,fixture.type)); } catch (error) { console.log('VIDEO_NATIVE_STAGE_CANDIDATE_DECODE'); throw error; }
  const { sha256:sourceHash,...beforeDecode } = before,{ sha256:derivativeHash,...afterDecode } = after;
  assert.equal(sourceHash,candidate.source.sha256); assert.equal(derivativeHash,candidate.derivative.sha256);
  assert.deepEqual(beforeDecode,afterDecode); assert.equal(before.decodedVideoFrames,4); assert.equal(before.decodedAudioFrames > 0,fixture.audio);
  const original = await measure(source,prefix+'-original',fixture.audio),derivative = await measure(candidate.bytes,prefix+'-derivative',fixture.audio);
  assert.deepEqual(derivative,original); assert.deepEqual(candidate.source,{ size:source.length,sha256:sha(source) });
  assert.deepEqual(candidate.derivative,{ size:candidate.bytes.length,sha256:sha(candidate.bytes) }); return original;
}
async function scenario(name,run) {
  try { await run(); passed++; console.log(`PASS ${name}`); }
  catch (error) {
    console.log(`FAIL ${name}`); if (['SCAN_INVALID','SCAN_UNAVAILABLE'].includes(error?.code)) console.log(`VIDEO_NATIVE_${error.code}`);
    if (Number.isSafeInteger(error?.elementId) && error.elementId >= 0 && error.elementId <= 0xffffffff) console.log(`VIDEO_NATIVE_ELEMENT_ID_${error.elementId.toString(16).toUpperCase()}`);
    for (const [file,label] of [['mp4-metadata','MP4'],['webm-metadata','WEBM'],['media-decoder-policy','DECODE_POLICY'],['media-decoder','DECODER']]) {
      const pattern = new RegExp(file+'\\.mjs:(\\d{1,4}):\\d+','g');
      const lines = [...(error?.stack ?? '').matchAll(pattern)].map((match) => match[1]);
      for (const line of [...new Set(lines)].slice(0,6)) console.log(`VIDEO_NATIVE_${label}_LINE_${line}`);
    }
    if (error?.code === 'ERR_ASSERTION') { const line = /video-metadata-native-test\.mjs:(\d{1,4}):\d+/.exec(error.stack ?? '')?.[1]; if (line) console.log(`VIDEO_NATIVE_ASSERTION_LINE_${line}`); }
    throw error;
  }
}
try {
  assert.ok(process.getuid() !== 0);
  assert.equal(sha(await readFile(root+'ffmpeg')),'d038f0fec3f7ea8b8eec4e90e8dcce330a6f7fcb1f3595d1ecb61877d310ab90');
  directory = await mkdtemp('/tmp/carebridge-video-metadata-');
  const cases = [
    ['h264',{ video:'libx264' }],['hevc',{ video:'libx265',width:64,height:64 }],['av1-mp4',{ video:'libaom-av1' }],['mpeg4',{ video:'mpeg4' }],
    ['vp8',{ type:'video/webm',video:'libvpx' }],['vp9',{ type:'video/webm',video:'libvpx-vp9' }],['av1-webm',{ type:'video/webm',video:'libaom-av1' }],
    ['aac',{ audio:'aac' }],['mp3',{ audio:'libmp3lame' }],['alac',{ audio:'alac' }],
    ['opus',{ type:'video/webm',video:'libvpx',audio:'libopus' }],['vorbis',{ type:'video/webm',video:'libvpx',audio:'libvorbis' }],
    ['faststart',{ args:['-movflags','+faststart'] }],['fragmented',{ args:['-movflags','+frag_keyframe+empty_moov+default_base_moof'] }],
  ];
  for (const [name,options] of cases) await scenario(`all streams preserved ${name}`,async () => compare(await generate(name,options),name));
  await scenario('MP4 display rotation retained with exact coded pixels',async () => {
    const fixture = await generate('rotation'),box = mp4Find(fixture.bytes,['moov','trak','tkhd']),start = box.data+(fixture.bytes[box.data] ? 52 : 40);
    const matrix = [0,0x10000,0,-0x10000,0,0,0,0,0x40000000]; matrix.forEach((value,index) => fixture.bytes.writeInt32BE(value,start+index*4));
    const measured = await compare(fixture,'rotation'); assert.equal(Math.abs(measured.streams[0].rotations[0]),90);
  });
  await scenario('WebM unknown segment size preserves all decoded frames and timing',async () => {
    const fixture = await generate('live',{ type:'video/webm',video:'libvpx' }),start = fixture.bytes.indexOf(Buffer.from('18538067','hex'));
    assert.ok(start >= 0); assert.equal(fixture.bytes[start+4],1); fixture.bytes.fill(255,start+4,start+12); fixture.bytes[start+4] = 1;
    await compare(fixture,'live');
  });
  await scenario('WebM projection roll retained with exact coded pixels',async () => {
    const fixture = await generate('webm-roll',{ type:'video/webm',video:'libvpx' }); fixture.bytes = webmWithSyntheticRoll(fixture.bytes,90);
    const measured = await compare(fixture,'webm-roll'); assert.equal(Math.abs(measured.streams[0].rotations[0]),90);
  });
  await scenario('independent timing comparison detects a changed sample duration',async () => {
    const fixture = await generate('timing-control'),before = await measure(fixture.bytes,'control-before',false),changed = Buffer.from(fixture.bytes);
    const box = mp4Find(changed,['moov','trak','mdia','minf','stbl','stts']); assert.ok(changed.readUInt32BE(box.data+4) > 0);
    const duration = changed.readUInt32BE(box.data+12); assert.ok(duration >= 2 && duration%2 === 0);
    changed.writeUInt32BE(duration/2,box.data+12);
    const after = await measure(changed,'control-after',false); assert.deepEqual(after.pixels,before.pixels); assert.notDeepEqual(after.timing,before.timing);
  });
  await scenario('raw track title fallback never bypasses source decoder validation',async () => {
    const fixture = await generate('raw-title',{ rawTrackTitle:true });
    assert.equal(prepareVideoDerivative(fixture.bytes,fixture.type).mediaAcceptanceReady,false);
    await assert.rejects(decoder.decode(input(fixture.bytes,fixture.type)),{ code:'SCAN_INVALID',message:'SCAN_INVALID' });
  });
  assert.equal(passed,19); console.log(`Native video metadata: ${passed} scenarios passed.`);
} catch { failed = true; console.error('VIDEO_METADATA_NATIVE_FAILED'); }
finally {
  if (directory) try {
    const names = await readdir(directory); assert.ok(names.length < 500);
    for (const name of names) { assert.match(name,/^[a-z0-9.-]{1,80}$/); const path = `${directory}/${name}`,info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink()); await unlink(path); }
    await rmdir(directory);
  } catch { failed = true; console.error('VIDEO_METADATA_TEST_CLEANUP_FAILED'); }
  if (failed || passed !== 19) process.exitCode = 1;
}

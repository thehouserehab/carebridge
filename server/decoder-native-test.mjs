// Synthetic fixtures ONLY inside the separately verified offline container.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp,readFile,writeFile,open,unlink,rmdir,readdir,readlink,lstat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { LinuxMediaDecoder } from './media-decoder.mjs';
import { DECODE_LIMITS,decoderArguments } from './media-decoder-policy.mjs';
// Reviewed artifact from the verified 9.0.2 source build. Never approve whatever
// executable happens to be installed by hashing it at test startup.
const approvedBinarySha256 = '12b72afac0becf6cc5a2d71faf55b83f275f5e8c81083f8ab73df99ce830f681';
const decoder = new LinuxMediaDecoder({ approvedBinarySha256 });
let dir,passed = 0,failed = false,deniedObservations = 0; const paths = [];
const synthetic = {}, sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const file = (bytes,type,overrides = {}) => ({ stream:Readable.from([bytes],{ objectMode:false }),type,size:bytes.length,sha256:sha256(bytes),...overrides });
const input = (name,overrides) => file(synthetic[name].bytes,synthetic[name].type,overrides);
const expectCode = (code) => (error) => error?.code === code && error.message === code;
async function noScratch() { assert.equal((await readdir('/tmp')).filter((name) => name.startsWith('carebridge-decode-')).length,0); }
async function scenario(name,run) {
  try { await run(); await noScratch(); passed += 1; console.log(`PASS ${name}`); }
  catch (error) {
    console.log(`FAIL ${name}`);
    if (['SCAN_INVALID','SCAN_UNAVAILABLE'].includes(error?.code)) console.log(`DECODER_NATIVE_${error.code}`);
    if (/^DECODER_NATIVE_[A-Z_]{1,64}$/.test(error?.message ?? '')) console.log(error.message);
    if (['EACCES','EPERM','ENOENT','ESRCH','EINVAL','ENOTDIR','EIO'].includes(error?.code)) console.log(`DECODER_NATIVE_IO_${error.code}`);
    if (['TypeError','RangeError','SyntaxError'].includes(error?.name)) console.log(`DECODER_NATIVE_${error.name.toUpperCase()}`);
    if (error?.code === 'ERR_ASSERTION') {
      const line = /decoder-native-test\.mjs:(\d{1,4}):\d+/.exec(error.stack ?? '')?.[1];
      if (line) console.log(`DECODER_NATIVE_ASSERTION_LINE_${line}`);
    }
    throw error;
  }
}
async function generate(name,type,args) {
  const path = `${dir}/${name}`; paths.push(path);
  let diagnostic = '';
  try { await new Promise((resolve,reject) => {
    const child = spawn('/opt/carebridge/ffmpeg/bin/ffmpeg',
      ['-hide_banner','-v','error','-nostdin','-y',...args,path],{ shell:false,stdio:['ignore','ignore','pipe'],env:{ PATH:'/usr/bin:/bin',LANG:'C',TZ:'UTC' } });
    child.stderr.on('data',(bytes) => { if (diagnostic.length < 4096) diagnostic += bytes.toString('utf8').slice(0,4096-diagnostic.length); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); },30000);
    child.once('error',reject);
    child.once('close',(code,signal) => { clearTimeout(timer); if (code === 0 && !timedOut && !signal) resolve(); else reject(new Error('DECODER_NATIVE_FIXTURE_FAILED')); });
  }); } catch {
    console.log(`FAIL fixture generation ${name}`);
    const categories = [ [/wrapped_avframe/,'wrapped frame decoder missing'],[/pcm_u8/,'unsigned PCM decoder missing'],
      [/No such filter/,'fixture filter missing'],[/Unknown encoder/,'fixture encoder missing'],[/error while loading shared libraries|Error loading shared library/,'runtime library missing'] ];
    for (const [pattern,label] of categories) if (pattern.test(diagnostic)) console.log(`FAIL ${label}`);
    // Only a shared-library basename from this fixed synthetic command. Never
    // print arbitrary native stderr, source paths or user media diagnostics.
    const library = /Error loading shared library ([a-zA-Z0-9_.+-]{1,80}\.so(?:\.\d+)*):/.exec(diagnostic)?.[1];
    if (library) console.log(`FAIL required library ${library}`);
    throw new Error('DECODER_NATIVE_FIXTURE_FAILED');
  }
  synthetic[name] = { bytes:await readFile(path),type };
}
async function fixtureCodecs(name,expected) {
  // Read only the fixed synthetic fixture's stream codec names. Do not print
  // raw output or use this header check instead of the later full decode.
  const path = `${dir}/${name}`; assert.ok(paths.includes(path));
  const output = await new Promise((resolve,reject) => {
    const child = spawn('/opt/carebridge/ffmpeg/bin/ffprobe',
      ['-hide_banner','-v','error','-protocol_whitelist','file','-show_entries','stream=codec_name,codec_type','-of','json','-i',path],
      { shell:false,stdio:['ignore','pipe','pipe'],env:{ PATH:'/usr/bin:/bin',LANG:'C',TZ:'UTC' } });
    let bytes = 0,failed = false; const chunks = [];
    const stop = () => { failed = true; child.kill('SIGKILL'); }, timer = setTimeout(stop,5000);
    child.stdout.on('data',(data) => { bytes += data.length; if (bytes > 65536) stop(); else if (!failed) chunks.push(data); });
    child.stderr.on('data',stop); child.once('error',stop);
    child.once('close',(code,signal) => { clearTimeout(timer); if (failed || code !== 0 || signal) reject(new Error('DECODER_NATIVE_CODEC_FAILED')); else resolve(Buffer.concat(chunks).toString('utf8')); });
  });
  const document = JSON.parse(output);
  assert.deepEqual(document.streams.map((stream) => `${stream.codec_type}:${stream.codec_name}`).sort(),expected.toSorted());
}
const crc = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
};
function pngChunk(name,data) {
  const bytes = Buffer.alloc(data.length+12); bytes.writeUInt32BE(data.length); bytes.write(name,4,'ascii'); data.copy(bytes,8); bytes.writeUInt32BE(crc(bytes.subarray(4,-4)),bytes.length-4); return bytes;
}
function pngChunks(bytes) {
  const chunks = []; for (let at = 8; at < bytes.length;) { const size = bytes.readUInt32BE(at); chunks.push({ name:bytes.toString('ascii',at+4,at+8),data:bytes.subarray(at+8,at+8+size) }); at += size+12; } return chunks;
}
function animation(bytes,frameCount = 2) {
  const chunks = pngChunks(bytes), header = chunks.find((chunk) => chunk.name === 'IHDR').data;
  const control = Buffer.alloc(8); control.writeUInt32BE(frameCount); const frames = []; let sequence = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    const fc = Buffer.alloc(26); fc.writeUInt32BE(sequence++); header.subarray(0,8).copy(fc,4); fc.writeUInt16BE(1,20); fc.writeUInt16BE(2,22);
    frames.push(pngChunk('fcTL',fc));
    for (const chunk of chunks.filter((chunk) => chunk.name === 'IDAT')) {
      if (!frame) frames.push(pngChunk('IDAT',chunk.data));
      else { const data = Buffer.alloc(chunk.data.length+4); data.writeUInt32BE(sequence++); chunk.data.copy(data,4); frames.push(pngChunk('fdAT',data)); }
    }
  }
  return Buffer.concat([bytes.subarray(0,8),pngChunk('IHDR',header),pngChunk('acTL',control),...frames,pngChunk('IEND',Buffer.alloc(0))]);
}
function repeatedGif(frames,delayTicks = 2) {
  const base = Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b','hex');
  const control = Buffer.from([0x21,0xf9,4,0,0,0,0,0]); control.writeUInt16LE(delayTicks,4);
  const frame = Buffer.concat([control,base.subarray(19,-1)]);
  return Buffer.concat([base.subarray(0,19),...Array(frames).fill(frame),Buffer.from([0x3b])]);
}
async function selectedOutputVolume(bytes) {
  // Establish that this synthetic fixture really exceeds the selected JSON
  // budget; count/drain bytes only, never retain or emit the probe document.
  const path = `${dir}/output-control.gif`; paths.push(path);
  await writeFile(path,bytes,{ flag:'wx',mode:0o600 });
  const handle = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return await new Promise((resolve,reject) => {
    const child = spawn('/opt/carebridge/ffmpeg/bin/ffprobe',decoderArguments('image/gif'),
      { shell:false,stdio:['ignore','pipe','pipe',handle.fd],env:{ PATH:'/usr/bin:/bin',LANG:'C',TZ:'UTC' } });
    let size = 0,problem = null;
    const stop = (code) => { problem ??= code; child.kill('SIGKILL'); }, timer = setTimeout(() => stop('TIMEOUT'),30000);
    child.stdout.on('data',(chunk) => { size += chunk.length; if (size > DECODE_LIMITS.outputBytes*4) stop('SIZE'); });
    child.stderr.on('data',() => stop('STDERR')); child.once('error',() => stop('START'));
    child.once('close',(code,signal) => { clearTimeout(timer); if (problem || code !== 0 || signal) reject(new Error(`DECODER_NATIVE_OUTPUT_CONTROL_${problem ?? 'EXIT'}`)); else resolve(size); });
  }); } finally { await handle.close(); await unlink(path); }
}
async function nativePid() {
  for (const name of (await readdir('/proc')).filter((name) => /^\d+$/.test(name))) try {
    if ((await readFile(`/proc/${name}/comm`,'utf8')).trim() !== 'ffprobe') continue;
    const target = await readlink(`/proc/${name}/fd/3`);
    if (!target.startsWith('/tmp/carebridge-decode-') || !target.endsWith(' (deleted)')) continue;
    const flags = /^flags:\s+([0-7]+)$/m.exec(await readFile(`/proc/${name}/fdinfo/3`,'utf8'));
    // /proc observations are not atomic. A finishing process can close/reuse
    // fd 3 between reads; require the same target before judging its flags.
    if (await readlink(`/proc/${name}/fd/3`) !== target) continue;
    if (!flags) throw new Error('DECODER_NATIVE_FD_FLAGS_MISSING');
    if ((Number.parseInt(flags[1],8)&3) !== 0) throw new Error('DECODER_NATIVE_FD_NOT_READ_ONLY');
    return name;
  } catch (error) {
    // A /proc permission check can race exec/exit. This is an inconclusive
    // snapshot, not proof of unsafe fd flags or a reason to skip verification.
    // waitNativePid still requires a successful, stable read within its bound.
    if (error.code === 'EACCES') { deniedObservations += 1; continue; }
    if (!['ENOENT','ESRCH'].includes(error.code)) throw error;
  }
  return null;
}
async function waitNativePid(milliseconds) {
  const deadline = Date.now()+milliseconds;
  while (Date.now() < deadline) { const pid = await nativePid(); if (pid) return pid; await delay(1); }
  throw new Error('DECODER_NATIVE_PROCESS_NOT_OBSERVED');
}
async function accepted(name,frames = 1,width = 32,height = 24) {
  const report = await decoder.decode(input(name));
  assert.equal(report.engine,'ffmpeg'); assert.equal(report.engineVersion,'9.0.2'); assert.equal(report.mediaAcceptanceReady,false);
  assert.equal(report.sha256,sha256(synthetic[name].bytes)); assert.equal(report.checkedBytes,synthetic[name].bytes.length);
  assert.equal(report.decodedVideoFrames,frames); assert.equal(report.media.width,width); assert.equal(report.media.height,height);
  assert.equal(report.media.type,synthetic[name].type); assert.equal(Object.hasOwn(report,'verdict'),false); assert.equal(typeof decoder.inspect,'undefined');
  if (synthetic[name].type.startsWith('video/')) assert.ok(report.media.duration > 0 && report.media.duration <= 2.1);
  return report;
}
try {
  assert.ok(process.getuid() !== 0); dir = await mkdtemp('/tmp/carebridge-fixtures-');
  const still = ['-f','lavfi','-i','color=c=gray:s=32x24:r=2:d=2','-frames:v','1','-threads','1'];
  const moving = ['-f','lavfi','-i','testsrc2=s=32x24:r=2:d=2','-threads','1'];
  await generate('still.png','image/png',[...still,'-c:v','png','-pix_fmt','rgb24','-f','image2','-update','1']);
  await generate('still.jpg','image/jpeg',[...still,'-c:v','mjpeg','-f','image2','-update','1']);
  await generate('still.webp','image/webp',[...still,'-c:v','libwebp','-lossless','1','-f','webp']);
  await generate('animated.gif','image/gif',[...moving,'-c:v','gif','-loop','0','-f','gif']);
  await generate('animated.webp','image/webp',[...moving,'-c:v','libwebp_anim','-lossless','1','-loop','0','-f','webp']);
  await generate('movie.mp4','video/mp4',[...moving,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-f','mp4']);
  await generate('movie.webm','video/webm',[...moving,'-c:v','libvpx','-deadline','realtime','-cpu-used','5','-f','webm']);
  await generate('audio.mp4','video/mp4',['-f','lavfi','-i','testsrc2=s=32x24:r=2:d=2','-f','lavfi','-i','anullsrc=r=48000:cl=mono',
    '-t','2','-threads','1','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-f','mp4']);
  const videoFixtures = [
    { name:'hevc.mp4',type:'video/mp4',codec:'hevc',width:64,height:64,args:['-c:v','libx265','-preset','ultrafast','-x265-params','pools=none:frame-threads=1:wpp=0','-pix_fmt','yuv420p','-f','mp4'] },
    { name:'av1.mp4',type:'video/mp4',codec:'av1',args:['-c:v','libaom-av1','-cpu-used','8','-row-mt','0','-f','mp4'] },
    { name:'mpeg4.mp4',type:'video/mp4',codec:'mpeg4',args:['-c:v','mpeg4','-f','mp4'] },
    { name:'vp9.webm',type:'video/webm',codec:'vp9',args:['-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','8','-f','webm'] },
    { name:'av1.webm',type:'video/webm',codec:'av1',args:['-c:v','libaom-av1','-cpu-used','8','-row-mt','0','-f','webm'] },
  ];
  for (const fixture of videoFixtures) {
    await generate(fixture.name,fixture.type,['-f','lavfi','-i',`testsrc2=s=${fixture.width ?? 32}x${fixture.height ?? 24}:r=2:d=2`,'-threads','1',...fixture.args]);
    await fixtureCodecs(fixture.name,[`video:${fixture.codec}`]);
  }
  const audioFixtures = [
    { name:'mp3.mp4',type:'video/mp4',codec:'mp3',video:'h264',encoder:'libmp3lame' },
    { name:'alac.mp4',type:'video/mp4',codec:'alac',video:'h264',encoder:'alac' },
    { name:'opus.webm',type:'video/webm',codec:'opus',video:'vp8',encoder:'libopus' },
    { name:'vorbis.webm',type:'video/webm',codec:'vorbis',video:'vp8',encoder:'libvorbis' },
  ];
  for (const fixture of audioFixtures) {
    const mp4 = fixture.type === 'video/mp4';
    await generate(fixture.name,fixture.type,['-f','lavfi','-i','testsrc2=s=32x24:r=2:d=2','-f','lavfi','-i','anullsrc=r=48000:cl=mono',
      '-t','2','-threads','1','-c:v',mp4 ? 'libx264' : 'libvpx',...(mp4 ? ['-preset','ultrafast'] : ['-deadline','realtime']),
      '-pix_fmt','yuv420p','-c:a',fixture.encoder,'-f',mp4 ? 'mp4' : 'webm']);
    await fixtureCodecs(fixture.name,[`video:${fixture.video}`,`audio:${fixture.codec}`]);
  }
  await generate('large.png','image/png',['-f','lavfi','-i','color=c=gray:s=8000x4000:r=1:d=1','-frames:v','1','-threads','1','-c:v','png','-pix_fmt','rgb24','-f','image2','-update','1']);
  synthetic['animated.png'] = { type:'image/png',bytes:animation(synthetic['still.png'].bytes) };
  await scenario('JPEG decoded from read-only fd',() => accepted('still.jpg'));
  await scenario('PNG decoded from read-only fd',() => accepted('still.png'));
  await scenario('WebP still decoded from read-only fd',() => accepted('still.webp'));
  await scenario('GIF all animated frames decoded',() => accepted('animated.gif',4));
  await scenario('Animated WebP all frames decoded',() => accepted('animated.webp',4));
  await scenario('APNG all animated frames decoded',() => accepted('animated.png',2));
  await scenario('MP4 moov at end decoded with seekable fd',async () => {
    assert.ok(synthetic['movie.mp4'].bytes.indexOf('mdat') < synthetic['movie.mp4'].bytes.indexOf('moov')); await accepted('movie.mp4',4);
  });
  await scenario('WebM all video frames decoded',() => accepted('movie.webm',4));
  await scenario('MP4 audio and video fully decoded',async () => {
    const report = await accepted('audio.mp4',4); assert.ok(report.decodedAudioFrames > 80);
    console.log(`Engine: FFmpeg 9.0.2; video frames ${report.decodedVideoFrames}; audio frames ${report.decodedAudioFrames}`);
  });
  for (const fixture of videoFixtures) await scenario(`${fixture.codec.toUpperCase()} ${fixture.type.slice(6).toUpperCase()} all frames decoded`,
    () => accepted(fixture.name,4,fixture.width ?? 32,fixture.height ?? 24));
  for (const fixture of audioFixtures) await scenario(`${fixture.codec.toUpperCase()} audio fully decoded`,async () => {
    const report = await accepted(fixture.name,4); assert.ok(report.decodedAudioFrames > 1);
  });
  await scenario('Image exact 10 MiB stream hash and decode',async () => {
    const base = synthetic['still.png'].bytes, size = 10*1024*1024;
    const padding = pngChunk('fiLL',Buffer.alloc(size-base.length-12));
    synthetic['limit.png'] = { type:'image/png',bytes:Buffer.concat([base.subarray(0,-12),padding,base.subarray(-12)]) };
    assert.equal(synthetic['limit.png'].bytes.length,size); await accepted('limit.png'); delete synthetic['limit.png'];
  });
  await scenario('Video exact 50 MiB stream hash and decode',async () => {
    const base = synthetic['movie.mp4'].bytes, size = 50*1024*1024, padding = Buffer.alloc(size-base.length);
    padding.writeUInt32BE(padding.length); padding.write('free',4,'ascii');
    synthetic['limit.mp4'] = { type:'video/mp4',bytes:Buffer.concat([base,padding]) };
    assert.equal(synthetic['limit.mp4'].bytes.length,size); await accepted('limit.mp4',4); delete synthetic['limit.mp4'];
  });
  await scenario('Declared image and video above size limit refused before reads',async () => {
    for (const [name,size] of [['still.png',10*1024*1024+1],['movie.mp4',50*1024*1024+1]]) {
      let read = false; const stream = new Readable({ read() { read = true; } });
      await assert.rejects(decoder.decode(input(name,{ stream,size })),expectCode('SCAN_INVALID')); assert.equal(read,false); assert.equal(stream.destroyed,true);
    }
  });
  await scenario('Single and multiple GIF frame playback above 600 seconds refused',async () => {
    for (const frames of [1,2]) await assert.rejects(decoder.decode(file(repeatedGif(frames,65535),'image/gif')),expectCode('SCAN_INVALID'));
  });
  await scenario('Late video packet corruption rejected',async () => {
    const bytes = Buffer.from(synthetic['movie.mp4'].bytes), at = bytes.indexOf('mdat');
    const end = at-4+bytes.readUInt32BE(at-4); bytes.fill(0,end-16,end);
    await assert.rejects(decoder.decode(file(bytes,'video/mp4')),expectCode('SCAN_INVALID'));
  });
  await scenario('Truncated image containers rejected',async () => {
    for (const name of ['still.png','still.jpg','still.webp','animated.gif']) {
      await assert.rejects(decoder.decode(file(synthetic[name].bytes.subarray(0,-8),synthetic[name].type)),expectCode('SCAN_INVALID'));
    }
  });
  await scenario('Truncated MP4 and WebM rejected',async () => {
    for (const name of ['movie.mp4','movie.webm']) await assert.rejects(decoder.decode(file(synthetic[name].bytes.subarray(0,-16),synthetic[name].type)),expectCode('SCAN_INVALID'));
  });
  await scenario('Declared MIME mismatch rejected',() => assert.rejects(decoder.decode(input('still.png',{ type:'image/jpeg' })),expectCode('SCAN_INVALID')));
  await scenario('Full content hash mismatch rejected',() => assert.rejects(decoder.decode(input('still.png',{ sha256:'0'.repeat(64) })),expectCode('SCAN_INVALID')));
  await scenario('Declared byte size mismatch rejected',() => assert.rejects(decoder.decode(input('still.png',{ size:synthetic['still.png'].bytes.length+1 })),expectCode('SCAN_INVALID')));
  await scenario('Caller URL or path field rejected',() => assert.rejects(decoder.decode(input('still.png',{ url:'https://example.invalid/synthetic' })),expectCode('SCAN_INVALID')));
  await scenario('Oversized decoded dimensions rejected',async () => {
    const chunks = pngChunks(synthetic['still.png'].bytes); chunks[0].data = Buffer.from(chunks[0].data); chunks[0].data.writeUInt32BE(8193);
    const bytes = Buffer.concat([synthetic['still.png'].bytes.subarray(0,8),...chunks.map((chunk) => pngChunk(chunk.name,chunk.data))]);
    await assert.rejects(decoder.decode(file(bytes,'image/png')),expectCode('SCAN_INVALID'));
  });
  await scenario('Private text metadata omitted from result',async () => {
    const chunks = pngChunks(synthetic['still.png'].bytes), marker = 'SYNTHETIC_PRIVATE_SENTINEL';
    const bytes = Buffer.concat([synthetic['still.png'].bytes.subarray(0,8),pngChunk(chunks[0].name,chunks[0].data),
      pngChunk('tEXt',Buffer.from(`comment\0${marker}`)),...chunks.slice(1).map((chunk) => pngChunk(chunk.name,chunk.data))]);
    const report = await decoder.decode(file(bytes,'image/png')); assert.equal(JSON.stringify(report).includes(marker),false);
    assert.deepEqual(Object.keys(report.media).sort(),['height','type','width']);
  });
  await scenario('Concurrent job refused and active cancellation cleaned',async () => {
    let started; const begin = new Promise((resolve) => { started = resolve; });
    const stream = new Readable({ read() { started(); } }), controller = new AbortController();
    const pending = decoder.decode(input('still.png',{ stream }),{ signal:controller.signal });
    const rejected = assert.rejects(pending,expectCode('SCAN_UNAVAILABLE'));
    try {
      await Promise.race([begin,delay(3000).then(() => { throw new Error('DECODER_NATIVE_START_TIMEOUT'); })]);
      await assert.rejects(decoder.decode(input('still.png')),expectCode('SCAN_UNAVAILABLE'));
    } finally { controller.abort(new Error('SYNTHETIC_PRIVATE_ABORT')); await rejected; }
    assert.equal(stream.destroyed,true); await accepted('still.png');
  });
  await scenario('Active native process cancelled and reaped before reuse',async () => {
    const controller = new AbortController(), pending = decoder.decode(input('large.png'),{ signal:controller.signal });
    const rejected = assert.rejects(pending,expectCode('SCAN_UNAVAILABLE')); let pid;
    try {
      pid = await waitNativePid(5000);
    } finally { controller.abort(); await rejected; }
    await assert.rejects(lstat(`/proc/${pid}`),{ code:'ENOENT' }); await accepted('still.png');
  });
  await scenario('Whole operation timeout cleaned and decoder recovers',async () => {
    const bounded = new LinuxMediaDecoder({ approvedBinarySha256,timeoutMilliseconds:250 });
    const stream = new Readable({ read() {} });
    await assert.rejects(bounded.decode(input('still.png',{ stream })),expectCode('SCAN_UNAVAILABLE')); assert.equal(stream.destroyed,true);
    await accepted('still.png');
  });
  await scenario('Large frame JSON output bounded native child reaped and recovers',async () => {
    const control = await decoder.decode(file(repeatedGif(3),'image/gif'));
    if (control.decodedVideoFrames !== 3) throw new Error('DECODER_NATIVE_OUTPUT_CONTROL_FRAME_COUNT');
    // Below the 144k frame and 10 MiB input limits, but full selected JSON is
    // larger than 16 MiB. This is not a high-resolution/complexity benchmark.
    assert.ok(100000 < DECODE_LIMITS.frames);
    const bytes = repeatedGif(100000);
    if (await selectedOutputVolume(bytes) <= DECODE_LIMITS.outputBytes) throw new Error('DECODER_NATIVE_OUTPUT_VOLUME_TOO_SMALL');
    const started = Date.now(); let pid;
    const pending = decoder.decode(file(bytes,'image/gif'));
    const rejected = pending.then(() => { throw new Error('DECODER_NATIVE_OUTPUT_WRONGLY_ACCEPTED'); },(error) => {
      if (error?.code !== 'SCAN_UNAVAILABLE' || error.message !== 'SCAN_UNAVAILABLE') {
        if (error?.code === 'SCAN_INVALID') throw new Error('DECODER_NATIVE_OUTPUT_INVALID_NOT_BOUNDED');
        throw new Error('DECODER_NATIVE_OUTPUT_UNEXPECTED_ERROR');
      }
    });
    try { pid = await waitNativePid(5000); } finally { await rejected; }
    if (Date.now()-started >= 45000) throw new Error('DECODER_NATIVE_OUTPUT_TOO_SLOW');
    try { await lstat(`/proc/${pid}`); throw new Error('DECODER_NATIVE_OUTPUT_CHILD_NOT_REAPED'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await accepted('still.png');
  });
  await scenario('Active native deadline kills and reaps child before recovery',async () => {
    // Raster validation now precedes native launch. Do not confuse its budget
    // expiry with killing a native process or depend on machine decode speed.
    // First prove a real valid file, then SIGSTOP only the actual owned child
    // observed by its private unlinked read-only fd. The production deadline
    // must SIGKILL and reap that stopped process before the next decode.
    const bytes = synthetic['large.png'].bytes;
    const control = await decoder.decode(file(bytes,'image/png')); assert.equal(control.decodedVideoFrames,1);
    assert.equal(control.media.width,8000); assert.equal(control.media.height,4000);
    const bounded = new LinuxMediaDecoder({ approvedBinarySha256,timeoutMilliseconds:5000 });
    const started = Date.now();
    const pending = bounded.decode(file(bytes,'image/png')), rejected = assert.rejects(pending,expectCode('SCAN_UNAVAILABLE')); let pid;
    try { pid = await waitNativePid(4500); process.kill(Number(pid),'SIGSTOP'); } finally { await rejected; }
    if (Date.now()-started < 4950) throw new Error('DECODER_NATIVE_DEADLINE_PREMATURE');
    if (Date.now()-started >= 9000) throw new Error('DECODER_NATIVE_DEADLINE_TOO_SLOW');
    await assert.rejects(lstat(`/proc/${pid}`),{ code:'ENOENT' }); await accepted('still.png');
  });
  await scenario('Unapproved executable digest refused',async () => {
    const unapproved = new LinuxMediaDecoder({ approvedBinarySha256:'0'.repeat(64) });
    await assert.rejects(unapproved.decode(input('still.png')),expectCode('SCAN_UNAVAILABLE'));
  });
  await scenario('All owned scratch files absent after success and failure',async () => { await delay(5); await noScratch(); });
  assert.equal(passed,38);
  if (deniedObservations) console.log('PASS Transient proc access denial retried with actual fd verification');
} catch { failed = true; console.log('DECODER_NATIVE_FAILED'); }
finally {
  try { for (const path of paths) try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } if (dir) await rmdir(dir); await noScratch(); }
  catch { failed = true; console.log('DECODER_NATIVE_CLEANUP_FAILED'); }
  if (failed) process.exitCode = 1; else console.log(`Native decoder integration: ${passed} scenarios passed.`);
}

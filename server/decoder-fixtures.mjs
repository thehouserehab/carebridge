// Explicit synthetic exporter in the offline TEST encoder image, never in a
// decoding job or application. Only fixed public test patterns are generated.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp,readFile,unlink,rmdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
let dir; const paths = [],fixtures = [];
async function command(binary,args,limit = 65536) {
  return new Promise((resolve,reject) => {
    const child = spawn(binary,args,{ shell:false,stdio:['ignore','pipe','pipe'],env:{ PATH:'/usr/bin:/bin',LANG:'C',TZ:'UTC' } });
    let failed = false,size = 0; const chunks = [];
    const stop = () => { failed = true; child.kill('SIGKILL'); },timer = setTimeout(stop,30000);
    child.stdout.on('data',(bytes) => { size += bytes.length; if (size > limit) stop(); else if (!failed) chunks.push(bytes); });
    // x265 emits harmless build/encoding status; discard all stderr. A
    // nonzero exit still fails. No arbitrary native diagnostics are emitted.
    child.stderr.resume(); child.once('error',stop);
    child.once('close',(code,signal) => { clearTimeout(timer); if (failed || code !== 0 || signal) reject(new Error('SYNTHETIC_FIXTURE_FAILED')); else resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}
async function generate(name,type,codecs,args,width = 32,height = 24,frames = 4) {
  const path = `${dir}/${name}`; paths.push(path);
  await command('/opt/carebridge/ffmpeg/bin/ffmpeg',['-hide_banner','-v','error','-nostdin','-y',...args,path]);
  const document = JSON.parse(await command('/opt/carebridge/ffmpeg/bin/ffprobe',
    ['-hide_banner','-v','error','-show_entries','stream=codec_name,codec_type','-of','json','-i',path]));
  assert.deepEqual(document.streams.map((stream) => `${stream.codec_type}:${stream.codec_name}`).sort(),codecs.toSorted());
  const bytes = await readFile(path); assert.ok(bytes.length > 0 && bytes.length < 150000);
  fixtures.push({ name,type,width,height,frames,codecs,base64:bytes.toString('base64') });
}
try {
  assert.ok(process.getuid() !== 0);
  for (const [binary,approved] of [['ffprobe','12b72afac0becf6cc5a2d71faf55b83f275f5e8c81083f8ab73df99ce830f681'],
    ['ffmpeg','d038f0fec3f7ea8b8eec4e90e8dcce330a6f7fcb1f3595d1ecb61877d310ab90']]) {
    assert.equal(createHash('sha256').update(await readFile(`/opt/carebridge/ffmpeg/bin/${binary}`)).digest('hex'),approved);
  }
  dir = await mkdtemp('/tmp/carebridge-synthetic-');
  const still = ['-f','lavfi','-i','color=c=gray:s=32x24:r=2:d=2','-frames:v','1','-threads','1'];
  const moving = ['-f','lavfi','-i','testsrc2=s=32x24:r=2:d=2','-threads','1'];
  await generate('still.png','image/png',['video:png'],[...still,'-c:v','png','-pix_fmt','rgb24','-f','image2','-update','1'],32,24,1);
  await generate('still.jpg','image/jpeg',['video:mjpeg'],[...still,'-c:v','mjpeg','-f','image2','-update','1'],32,24,1);
  await generate('still.webp','image/webp',['video:webp'],[...still,'-c:v','libwebp','-lossless','1','-f','webp'],32,24,1);
  await generate('animated.gif','image/gif',['video:gif'],[...moving,'-c:v','gif','-loop','0','-f','gif']);
  await generate('animated.webp','image/webp',['video:webp_anim'],[...moving,'-c:v','libwebp_anim','-lossless','1','-loop','0','-f','webp']);
  const video = [
    ['h264.mp4','video/mp4','h264',['-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-f','mp4']],
    ['vp8.webm','video/webm','vp8',['-c:v','libvpx','-deadline','realtime','-cpu-used','5','-f','webm']],
    ['hevc.mp4','video/mp4','hevc',['-c:v','libx265','-preset','ultrafast','-x265-params','pools=none:frame-threads=1:wpp=0','-pix_fmt','yuv420p','-f','mp4'],64,64],
    ['av1.mp4','video/mp4','av1',['-c:v','libaom-av1','-cpu-used','8','-row-mt','0','-f','mp4']],
    ['mpeg4.mp4','video/mp4','mpeg4',['-c:v','mpeg4','-f','mp4']],
    ['vp9.webm','video/webm','vp9',['-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','8','-f','webm']],
    ['av1.webm','video/webm','av1',['-c:v','libaom-av1','-cpu-used','8','-row-mt','0','-f','webm']],
  ];
  for (const [name,type,codec,args,width = 32,height = 24] of video) await generate(name,type,[`video:${codec}`],
    ['-f','lavfi','-i',`testsrc2=s=${width}x${height}:r=2:d=2`,'-threads','1',...args],width,height);
  for (const [name,type,audio,encoder] of [ ['aac.mp4','video/mp4','aac','aac'],['mp3.mp4','video/mp4','mp3','libmp3lame'],
    ['alac.mp4','video/mp4','alac','alac'],['opus.webm','video/webm','opus','libopus'],['vorbis.webm','video/webm','vorbis','libvorbis'] ]) {
    const webm = type === 'video/webm';
    await generate(name,type,[`video:${webm ? 'vp8' : 'h264'}`,`audio:${audio}`],
      ['-f','lavfi','-i','testsrc2=s=32x24:r=2:d=2','-f','lavfi','-i','anullsrc=r=48000:cl=mono','-t','2','-threads','1',
        '-c:v',webm ? 'libvpx' : 'libx264',...(webm ? ['-deadline','realtime','-cpu-used','5'] : ['-preset','ultrafast','-pix_fmt','yuv420p']),'-c:a',encoder,'-f',webm ? 'webm' : 'mp4']);
  }
  assert.equal(fixtures.length,17);
} catch { process.stderr.write('SYNTHETIC_FIXTURE_FAILED\n'); process.exitCode = 1; }
finally {
  for (const path of paths) try { await unlink(path); } catch { process.exitCode = 1; }
  if (dir) try { await rmdir(dir); } catch { process.exitCode = 1; }
}
if (!process.exitCode) process.stdout.write(JSON.stringify({ protocol:'carebridge-synthetic-fixtures-v1',fixtures })+'\n');

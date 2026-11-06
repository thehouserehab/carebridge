import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { DECODER_VERSION,DECODE_LIMITS,decoderArguments,decodedMediaReport } from '../media-decoder-policy.mjs';
import { validateMediaContainer } from '../media-container-validation.mjs';
import { LinuxMediaDecoder } from '../media-decoder.mjs';
const refused = (run) => assert.throws(run,{ code:'SCAN_INVALID',message:'SCAN_INVALID' });
const video = () => ({ format:{ format_name:'mov,mp4,m4a,3gp,3g2,mj2',duration:'999999',tags:{ private:'SYNTHETIC_SECRET' } },
  streams:[{ index:0,codec_type:'video',codec_name:'h264',width:32,height:24,nb_frames:'2',nb_read_frames:'2',tags:{ private:'SYNTHETIC_SECRET' } }],
  frames:[0,1].map((index) => ({ media_type:'video',stream_index:0,width:32,height:24,best_effort_timestamp_time:String(index),duration_time:'1' })) });
const image = () => { const doc = video(); doc.format.format_name = 'png_pipe'; doc.streams[0].codec_name = 'png'; return doc; };
const report = (doc) => decodedMediaReport(doc,'video/mp4');
test('decoder cannot be constructed on Windows or as Linux root',() => {
  if (process.platform !== 'linux' || process.getuid() === 0) assert.throws(() => new LinuxMediaDecoder({ approvedBinarySha256:'a'.repeat(64) }),TypeError);
});
test('decode arguments accept only MIME allowlist, fixed fd and no network protocol',() => {
  assert.equal(DECODER_VERSION,'9.0.2');
  for (const type of ['image/jpeg','image/png','image/gif','image/webp','video/mp4','video/webm']) {
    const args = decoderArguments(type);
    assert.equal(args.at(-1),'fd:'); assert.equal(args[args.indexOf('-fd')+1],'3');
    assert.equal(args[args.indexOf('-protocol_whitelist')+1],'fd'); assert.equal(args[args.indexOf('-v')+1],'warning');
    for (const limit of ['-read_intervals','-frames','-t','-select_streams']) assert.equal(args.includes(limit),false);
    assert.ok(args.includes('-show_frames')); assert.ok(args.includes('-count_frames')); assert.ok(args.includes('-max_pixels'));
    assert.ok(args.includes('explode')); assert.equal(args.some((arg) => /https?:|\/tmp\//.test(arg)),false);
  }
  for (const type of [null,'','video/quicktime','file:///private','constructor','image/png;cmd']) refused(() => decoderArguments(type));
});
test('measured duration and sanitized dimensions omit header duration and metadata',() => {
  assert.deepEqual(report(video()),{ media:{ type:'video/mp4',width:32,height:24,duration:2 },decodedVideoFrames:2,decodedAudioFrames:0 });
  const output = decodedMediaReport(image(),'image/png',2);
  assert.equal(Object.hasOwn(output.media,'duration'),false); assert.equal(JSON.stringify(output).includes('SYNTHETIC_SECRET'),false);
});
test('no frames, missing format, unknown codec and mismatched MIME are invalid',() => {
  for (const change of [null,{}, { ...video(),frames:[] },{ ...video(),frames:null },{ ...video(),format:{ format_name:'matroska,webm' } }]) refused(() => report(change));
  for (const codec of ['h264,http://remote','rawvideo','webp','unknown']) { const doc = video(); doc.streams[0].codec_name = codec; refused(() => report(doc)); }
  refused(() => decodedMediaReport(video(),'image/png')); refused(() => decodedMediaReport(video(),'constructor'));
});
test('exactly one video and at most one audio stream, no hidden subtitle stream',() => {
  for (const stream of [{ ...video().streams[0],index:1 },{ index:1,codec_type:'subtitle',codec_name:'text' },{ index:0,codec_type:'audio',codec_name:'aac' }]) {
    const doc = video(); doc.streams.push(stream); refused(() => report(doc));
  }
  const doc = video(); doc.streams = []; refused(() => report(doc));
});
test('every frame must reference a known correctly typed stream',() => {
  for (const change of [{ stream_index:8 },{ media_type:'audio' },{ stream_index:'0' },{ media_type:'subtitle' }]) {
    const doc = video(); Object.assign(doc.frames[1],change); refused(() => report(doc));
  }
});
test('every decoded frame dimension and canvas size are bounded',() => {
  for (const [width,height] of [[0,24],[8193,24],[8192,8192],[32.5,24],[32,0],[33,24]]) {
    const doc = video(); Object.assign(doc.frames[1],{ width,height }); refused(() => report(doc));
  }
  const doc = video(); doc.streams[0].width = 8193; refused(() => report(doc));
  const bound = video(); bound.streams[0].width = 8192; for (const frame of bound.frames) frame.width = 8192; assert.equal(report(bound).media.width,8192);
});
test('decoded pixel work is bounded independently from frame dimension',() => {
  const doc = video(); Object.assign(doc.streams[0],{ width:8000,height:5000,nb_read_frames:'501',nb_frames:'501' });
  doc.frames = Array.from({ length:501 },(_,index) => ({ media_type:'video',stream_index:0,width:8000,height:5000,best_effort_timestamp_time:String(index/2),duration_time:'0.5' }));
  refused(() => report(doc)); doc.frames.pop(); doc.streams[0].nb_frames = doc.streams[0].nb_read_frames = '500'; assert.equal(report(doc).decodedVideoFrames,500);
});
test('too many decoded frames are refused before traversal',() => {
  const doc = video(); doc.frames = Array(DECODE_LIMITS.frames+1); refused(() => report(doc));
});
test('decoded frame count must match each stream and container controls',() => {
  for (const change of [{ nb_frames:'3' },{ nb_read_frames:'1' },{ nb_read_frames:'N/A' },{ nb_read_frames:'02' }]) {
    const doc = video(); Object.assign(doc.streams[0],change); refused(() => report(doc));
  }
  refused(() => decodedMediaReport(image(),'image/png',3));
  const doc = video(); doc.streams[0].nb_frames = 'N/A'; assert.equal(report(doc).decodedVideoFrames,2);
});
test('decimal timestamps, positive duration and monotonic per-stream order required',() => {
  for (const change of [{ best_effort_timestamp_time:'NaN' },{ best_effort_timestamp_time:'1e3' },{ best_effort_timestamp_time:1 },
    { best_effort_timestamp_time:'-1' },{ duration_time:'0' },{ duration_time:'-1' },{ duration_time:'Infinity' }]) {
    const doc = video(); Object.assign(doc.frames[1],change); refused(() => report(doc));
  }
  const doc = video(); doc.frames[0].best_effort_timestamp_time = '-2'; doc.frames[1].best_effort_timestamp_time = '-1'; assert.equal(report(doc).media.duration,2);
});
test('duration 600 seconds is accepted but duration beyond 600 is refused',() => {
  const doc = video(); doc.frames[1].best_effort_timestamp_time = '599'; assert.equal(report(doc).media.duration,600);
  doc.frames[1].duration_time = '1.001'; refused(() => report(doc));
});
test('GIF APNG and animated WebP also require measured bounded playback',() => {
  for (const [type,format,codec] of [['image/gif','gif','gif'],['image/png','apng','apng'],['image/webp','webp_anim','webp_anim']]) {
    const doc = image(); doc.format.format_name = format; doc.streams[0].codec_name = codec;
    doc.frames[1].best_effort_timestamp_time = '599';
    const output = decodedMediaReport(doc,type,2);
    assert.equal(output.decodedVideoFrames,2); assert.equal(Object.hasOwn(output.media,'duration'),false);
    for (const change of [{ duration_time:'1.001' },{ duration_time:'0' },{ best_effort_timestamp_time:'N/A' },{ best_effort_timestamp_time:'-1' }]) {
      const bad = structuredClone(doc); Object.assign(bad.frames[1],change); refused(() => decodedMediaReport(bad,type,2));
    }
    delete doc.frames[0].best_effort_timestamp_time; refused(() => decodedMediaReport(doc,type,2));
  }
});
test('single-frame animation cannot bypass playback budget while static images need no times',() => {
  const doc = image(); doc.frames.length = 1; doc.streams[0].nb_frames = doc.streams[0].nb_read_frames = '1';
  doc.format.format_name = 'gif'; doc.streams[0].codec_name = 'gif'; doc.frames[0].duration_time = '600.001';
  refused(() => decodedMediaReport(doc,'image/gif',1));
  doc.frames[0].duration_time = '600'; assert.equal(decodedMediaReport(doc,'image/gif',1).decodedVideoFrames,1);
  for (const [type,format,codec] of [['image/png','png_pipe','png'],['image/jpeg','jpeg_pipe','mjpeg'],['image/webp','webp_pipe','webp']]) {
    doc.format.format_name = format; doc.streams[0].codec_name = codec;
    delete doc.frames[0].best_effort_timestamp_time; delete doc.frames[0].duration_time;
    assert.equal(decodedMediaReport(doc,type,1).decodedVideoFrames,1);
  }
});
test('audio must be fully decoded and is timed using actual samples',() => {
  const doc = video(); doc.streams.push({ index:1,codec_type:'audio',codec_name:'aac',sample_rate:'48000',nb_read_frames:'1',nb_frames:'999' });
  doc.frames.push({ stream_index:1,media_type:'audio',nb_samples:1024,best_effort_timestamp_time:'0',duration_time:'999' });
  assert.equal(report(doc).decodedAudioFrames,1); // packet/header count is not audio decoded frame count
  for (const sample of [0,65537,'1024']) { const bad = structuredClone(doc); bad.frames.at(-1).nb_samples = sample; refused(() => report(bad)); }
  for (const rate of ['0','8000x','192001']) { const bad = structuredClone(doc); bad.streams[1].sample_rate = rate; refused(() => report(bad)); }
  const bad = structuredClone(doc); bad.streams[1].nb_read_frames = '2'; refused(() => report(bad));
});

const signature = Buffer.from([137,80,78,71,13,10,26,10]);
function crc(bytes) { let value = 0xffffffff; for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; }
function chunk(name,data) { const bytes = Buffer.alloc(data.length+12); bytes.writeUInt32BE(data.length); bytes.write(name,4,'ascii'); data.copy(bytes,8); bytes.writeUInt32BE(crc(bytes.subarray(4,-4)),bytes.length-4); return bytes; }
function png(width = 1) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(1,4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([signature,chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.alloc(1+width*3))),chunk('IEND',Buffer.alloc(0))]);
}
test('PNG complete chunk boundaries CRC and IEND are required',() => {
  const bytes = png(); assert.equal(validateMediaContainer(bytes,'image/png'),1);
  for (const bad of [bytes.subarray(0,-12),bytes.subarray(0,-1),Buffer.concat([bytes,Buffer.from([1])])]) refused(() => validateMediaContainer(bad,'image/png'));
  const corrupt = Buffer.from(bytes); corrupt[29] ^= 1; refused(() => validateMediaContainer(corrupt,'image/png'));
  refused(() => validateMediaContainer(png(8193),'image/png')); assert.equal(validateMediaContainer(png(8192),'image/png'),1);
});
test('APNG declared frame controls must be complete and precede IDAT',() => {
  const base = png(), control = Buffer.alloc(8); control.writeUInt32BE(2);
  const fc = Buffer.alloc(26);
  const mismatch = Buffer.concat([base.subarray(0,33),chunk('acTL',control),chunk('fcTL',fc),base.subarray(33)]);
  refused(() => validateMediaContainer(mismatch,'image/png'));
  const absent = Buffer.concat([base.subarray(0,33),chunk('acTL',control),base.subarray(33)]); refused(() => validateMediaContainer(absent,'image/png'));
});
test('GIF traversal requires full subblocks image count and exact final trailer',() => {
  const bytes = Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b','hex');
  assert.equal(validateMediaContainer(bytes,'image/gif'),1);
  for (const bad of [bytes.subarray(0,-1),Buffer.concat([bytes,Buffer.from([0])]),bytes.subarray(0,20)]) refused(() => validateMediaContainer(bad,'image/gif'));
});
test('WebP RIFF length padding and exactly one still or bounded animation are required',() => {
  function webp(parts) { const body = Buffer.concat(parts); const header = Buffer.alloc(12); header.write('RIFF'); header.writeUInt32LE(body.length+4,4); header.write('WEBP',8); return Buffer.concat([header,body]); }
  function part(kind,size) { const bytes = Buffer.alloc(8+size+(size&1)); bytes.write(kind); bytes.writeUInt32LE(size,4); return bytes; }
  const still = webp([part('VP8L',5)]); assert.equal(validateMediaContainer(still,'image/webp'),1);
  assert.equal(validateMediaContainer(webp([part('ANMF',16),part('ANMF',16)]),'image/webp'),2);
  for (const bad of [still.subarray(0,-1),webp([]),webp([part('VP8L',5),part('ANMF',16)]),webp([part('ANMF',15)])]) refused(() => validateMediaContainer(bad,'image/webp'));
});
test('WebM requires a bounded EBML header with webm doctype not matroska',() => {
  const good = Buffer.from('1a45dfa3874282847765626d','hex'); assert.equal(validateMediaContainer(good,'video/webm'),null);
  for (const bad of [good.subarray(0,-1),Buffer.from('1a45dfa38b4282886d6174726f736b61','hex'),Buffer.from('1a45dfa300','hex')]) refused(() => validateMediaContainer(bad,'video/webm'));
});
test('MP4 atoms require complete moov mdat and correctly sized extended headers',() => {
  const atom = (kind,data = Buffer.alloc(0)) => { const bytes = Buffer.alloc(8+data.length); bytes.writeUInt32BE(bytes.length); bytes.write(kind,4); data.copy(bytes,8); return bytes; };
  const type = atom('ftyp',Buffer.from('isom0000')); const good = Buffer.concat([type,atom('mdat'),atom('moov')]);
  assert.equal(validateMediaContainer(good,'video/mp4'),null);
  const wide = Buffer.alloc(16); wide.writeUInt32BE(1); wide.write('free',4); wide.writeBigUInt64BE(8n,8);
  for (const bad of [good.subarray(0,-1),Buffer.concat([type,atom('mdat')]),Buffer.concat([good,atom('moov')]),Buffer.concat([good,wide])]) refused(() => validateMediaContainer(bad,'video/mp4'));
});
test('JPEG exact last marker and a single decoded frame are required',() => {
  assert.equal(validateMediaContainer(Buffer.from([255,216,255,217]),'image/jpeg'),1);
  refused(() => validateMediaContainer(Buffer.from([255,216,255,217,0]),'image/jpeg'));
  refused(() => validateMediaContainer(new Uint8Array([255,216,255,217]),'image/jpeg'));
});

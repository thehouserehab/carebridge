import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { validateWebChatMedia } from '../web-chat-media-validation.mjs';
import { prototypeMediaFiles } from '../prototype-media-assets.mjs';
import { WEB_CHAT_MEDIA_MAX_BYTES } from '../../src/shared-chat-media-policy.js';
import { mp4Find, mp4Box, mp4Full } from '../video-metadata-test-fixtures.mjs';
import { animatedPng, syntheticJpeg } from '../image-metadata-test-fixtures.mjs';

const files = prototypeMediaFiles(), png = files.find(f => f.type === 'image/png'), mp4 = files.find(f => f.type === 'video/mp4');
const invalid = (bytes, type) => assert.rejects(() => validateWebChatMedia(bytes, type), { code: 'INVALID_MEDIA', message: 'INVALID_MEDIA' });
const trackPath = ['moov', 'trak', 'mdia'], tablePath = [...trackPath, 'minf', 'stbl'];
const mutateVideo = change => { const bytes = Buffer.from(mp4.bytes); change(bytes); return bytes; };
const createImage = format => sharp({ create: { width: 80, height: 60, channels: 3, background: '#4b75ce' } }).toFormat(format).toBuffer();

test('known self-generated PNG and playable H264 fixture pass without changing bytes or claiming malware approval', async () => {
  for (const file of files) {
    const copy = Buffer.from(file.bytes), result = await validateWebChatMedia(file.bytes, file.type);
    assert.deepEqual(result, { type: file.type, size: file.bytes.length, sha256: file.sha256,
      width: file.width, height: file.height, ...(file.duration === undefined ? {} : { duration: file.duration }) });
    assert.deepEqual(file.bytes, copy); assert.equal(Object.hasOwn(result, 'verdict'), false);
    assert.equal(Object.hasOwn(result, 'mediaAcceptanceReady'), false);
  }
});

test('actual generated PNG JPEG and WebP pixels fully decode and return only measured metadata', async () => {
  for (const format of ['png', 'jpeg', 'webp']) {
    const bytes = await createImage(format), result = await validateWebChatMedia(bytes, `image/${format}`);
    assert.equal(result.width, 80); assert.equal(result.height, 60);
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(Object.keys(result).sort(), ['height', 'sha256', 'size', 'type', 'width']);
  }
});

test('size type and signature mismatches fail before format processing', async () => {
  for (const bytes of [null, '', new Uint8Array(png.bytes), Buffer.alloc(0), Buffer.alloc(WEB_CHAT_MEDIA_MAX_BYTES + 1)]) await invalid(bytes, 'image/png');
  for (const type of ['image/svg+xml', 'text/html', 'video/webm', 'image/gif', 'constructor', null, {}]) await invalid(png.bytes, type);
  await invalid(png.bytes, 'image/jpeg'); await invalid(mp4.bytes, 'image/png');
  await invalid(Buffer.from('<svg onload="alert(1)"/>'), 'image/png');
  await invalid(Buffer.from('<html>synthetic invalid media</html>'), 'video/mp4');
});

test('truncated and appended images or corrupt PNG CRC fail closed', async () => {
  for (const format of ['png', 'jpeg', 'webp']) {
    const bytes = await createImage(format);
    await invalid(bytes.subarray(0, Math.floor(bytes.length * 0.65)), `image/${format}`);
    await invalid(Buffer.concat([bytes, Buffer.from('<script>synthetic</script>')]), `image/${format}`);
  }
  const damaged = Buffer.from(png.bytes); damaged[45] ^= 1; await invalid(damaged, 'image/png');
});

test('header-like JPEG with undecodable compressed content cannot pass on markers alone', async () => {
  await invalid(syntheticJpeg(), 'image/jpeg');
});

test('animated PNG and excessive raster dimensions/pixels are rejected before sharing', async () => {
  await invalid(animatedPng(png.bytes), 'image/png');
  const oversized = await sharp({ create: { width: 4100, height: 4000, channels: 3, background: '#eeeeee' } }).png().toBuffer();
  assert.ok(oversized.length < WEB_CHAT_MEDIA_MAX_BYTES); await invalid(oversized, 'image/png');
  const veryWide = await sharp({ create: { width: 8193, height: 1, channels: 3, background: '#eeeeee' } }).png().toBuffer();
  await invalid(veryWide, 'image/png');
});

test('MP4 corrupt lengths truncated and unknown appended boxes are rejected', async () => {
  await invalid(mp4.bytes.subarray(0, -1), 'video/mp4');
  await invalid(Buffer.concat([mp4.bytes, mp4Box('evil', Buffer.from('synthetic'))]), 'video/mp4');
  await invalid(mutateVideo(b => b.writeUInt32BE(0xffffffff, mp4Find(b, ['moov']).at)), 'video/mp4');
});

test('MP4 external data references and unsupported codec/config signatures are rejected', async () => {
  await invalid(mutateVideo(b => { const box = mp4Find(b, [...trackPath, 'minf', 'dinf', 'dref']); b.fill(0, box.data + 16, box.data + 20); }), 'video/mp4');
  await invalid(mutateVideo(b => { const stsd = mp4Find(b, [...tablePath, 'stsd']); b.write('hvc1', stsd.data + 12, 'ascii'); }), 'video/mp4');
  await invalid(mutateVideo(b => { const at = b.indexOf(Buffer.from('avcC')) + 4; b[at] = 0; }), 'video/mp4');
  await invalid(mutateVideo(b => { const at = b.indexOf(Buffer.from('avcC')) + 4; b[at + 8] = 0x68; }), 'video/mp4');
});

test('MP4 declared duration and raster cannot exceed the bounded prototype subset', async () => {
  await invalid(mutateVideo(b => { const box = mp4Find(b, [...trackPath, 'mdhd']); b.writeUInt32BE(0, box.data + 12); }), 'video/mp4');
  await invalid(mutateVideo(b => { const box = mp4Find(b, [...trackPath, 'mdhd']); b.writeUInt32BE(1, box.data + 12); }), 'video/mp4');
  await invalid(mutateVideo(b => { const box = mp4Find(b, [...tablePath, 'stsd']); b.writeUInt16BE(8193, box.data + 8 + 8 + 24); }), 'video/mp4');
});

test('MP4 sample offsets sizes counts and timing must reference complete internal media samples', async () => {
  await invalid(mutateVideo(b => { const box = mp4Find(b, [...tablePath, 'stco']); b.writeUInt32BE(b.length - 1, box.data + 8); }), 'video/mp4');
  await invalid(mutateVideo(b => { const box = mp4Find(b, [...tablePath, 'stsz']); b.writeUInt32BE(0xffffffff, box.data + 12); }), 'video/mp4');
  await invalid(mutateVideo(b => { const box = mp4Find(b, [...tablePath, 'stsc']); b.writeUInt32BE(2, box.data + 8); }), 'video/mp4');
  await invalid(mutateVideo(b => { const box = mp4Find(b, [...tablePath, 'stsc']); b.writeUInt32BE(2, box.data + 16); }), 'video/mp4');
  await invalid(mutateVideo(b => { const box = mp4Find(b, [...tablePath, 'stts']); b.writeUInt32BE(1, box.data + 12); }), 'video/mp4');
});

test('MP4 H264 NAL lengths and forbidden-bit changes fail without invoking an external decoder', async () => {
  await invalid(mutateVideo(b => { const box = mp4Find(b, ['mdat']); b.writeUInt32BE(0xffffffff, box.data); }), 'video/mp4');
  await invalid(mutateVideo(b => { const box = mp4Find(b, ['mdat']); b[box.data + 4] |= 128; }), 'video/mp4');
});

// An isolated AAC descriptor/sample-table fixture, not a claim of AAC decoding.
function withStructuralAudio({ objectType = 0x40 } = {}) {
  const original = mp4.bytes, movie = mp4Find(original, ['moov']), track = mp4Find(original, ['moov', 'trak']);
  const tkhd = mp4Find(original, ['moov', 'trak', 'tkhd']), mdhd = mp4Find(original, [...trackPath, 'mdhd']);
  const audioTime = Buffer.from(original.subarray(mdhd.data, mdhd.end)); audioTime.writeUInt32BE(48000, 12); audioTime.writeUInt32BE(96000, 16);
  const handler = mp4Full(24); handler.write('soun', 8);
  const desc = (kind, body) => Buffer.concat([Buffer.from([kind, body.length]), body]);
  const decoder = Buffer.alloc(13); decoder[0] = objectType; decoder[1] = 0x15;
  const esds = Buffer.concat([mp4Full(4), desc(3, Buffer.concat([Buffer.from([0, 2, 0]),
    desc(4, Buffer.concat([decoder, desc(5, Buffer.from([0x11, 0x90]))])), desc(6, Buffer.from([2]))]))]);
  const sample = Buffer.alloc(28); sample.writeUInt16BE(1, 6); sample.writeUInt16BE(2, 16); sample.writeUInt16BE(16, 18); sample.writeUInt32BE(48000 * 65536, 24);
  const description = mp4Full(8); description.writeUInt32BE(1, 4);
  const stts = mp4Full(16); stts.writeUInt32BE(1, 4); stts.writeUInt32BE(1, 8); stts.writeUInt32BE(96000, 12);
  const stsc = mp4Full(20); [1, 1, 1, 1].forEach((n, i) => stsc.writeUInt32BE(n, 4 + i * 4));
  const stsz = mp4Full(16); stsz.writeUInt32BE(1, 8); stsz.writeUInt32BE(2, 12);
  const stco = mp4Full(12); stco.writeUInt32BE(1, 4); stco.writeUInt32BE(movie.at + 8, 8);
  const dinf = mp4Find(original, [...trackPath, 'minf', 'dinf']);
  const table = mp4Box('stbl', Buffer.concat([mp4Box('stsd', Buffer.concat([description, mp4Box('mp4a', Buffer.concat([sample, mp4Box('esds', esds)]))])),
    mp4Box('stts', stts), mp4Box('stsc', stsc), mp4Box('stsz', stsz), mp4Box('stco', stco)]));
  const audio = mp4Box('trak', Buffer.concat([mp4Box('tkhd', original.subarray(tkhd.data, tkhd.end)), mp4Box('mdia', Buffer.concat([
    mp4Box('mdhd', audioTime), mp4Box('hdlr', handler), mp4Box('minf', Buffer.concat([mp4Box('smhd', mp4Full(8)), original.subarray(dinf.at, dinf.end), table]))]))]));
  assert.ok(track.at < movie.end);
  return Buffer.concat([original.subarray(0, movie.at), mp4Box('mdat', Buffer.from([0, 0])), mp4Box('moov', Buffer.concat([original.subarray(movie.data, movie.end), audio]))]);
}

test('optional AAC-LC descriptor accepted structurally and a non-AAC object type rejected', async () => {
  const result = await validateWebChatMedia(withStructuralAudio(), 'video/mp4');
  assert.equal(result.duration, 2); assert.equal(result.width, 32);
  await invalid(withStructuralAudio({ objectType: 0x69 }), 'video/mp4');
});

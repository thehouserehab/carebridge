// Runs ONLY inside the isolated synthetic worker. No user files, paths or API.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import { LocalClamAvClient } from './clamav-client.mjs';

const clientOptions = { endpoint:{ host:'127.0.0.1',port:3310 },approvedEngineVersions:['1.4.6'],daemonTimeZone:'UTC' };
const client = new LocalClamAvClient(clientOptions);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const file = (bytes,extra = {}) => ({ stream:Readable.from([bytes],{ objectMode:false }),type:'image/png',size:bytes.length,sha256:hash(bytes),...extra });
const crcTable = Array.from({ length:256 },(_,index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function pngChunk(type,data) {
  const name = Buffer.from(type,'ascii'), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name,data])));
  return Buffer.concat([size,name,data,crc]);
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1,0); ihdr.writeUInt32BE(1,4); ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',ihdr),
  pngChunk('IDAT',deflateSync(Buffer.from([0,64,128,192]))),pngChunk('IEND',Buffer.alloc(0))]);

// Bounded valid ZIP: 1001 tiny stored files, ~100KB total, only 4004 payload
// bytes. Tests MaxFiles skip-as-clean, NOT a zip bomb or valid media decoder.
function archiveWithFiles(count) {
  const locals = [], directory = [], data = Buffer.from([1,2,3,4]); let offset = 0;
  for (let index = 0; index < count; index++) {
    const name = Buffer.from(`entry${String(index).padStart(4,'0')}`,'ascii'), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20,4); local.writeUInt32LE(crc32(data),14);
    local.writeUInt32LE(data.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(name.length,26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6);
    central.writeUInt32LE(crc32(data),16); central.writeUInt32LE(data.length,20); central.writeUInt32LE(data.length,24);
    central.writeUInt16LE(name.length,28); central.writeUInt32LE(offset,42);
    locals.push(local,name,data); directory.push(central,name); offset += local.length+name.length+data.length;
  }
  const entries = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(count,8); end.writeUInt16LE(count,10); end.writeUInt32LE(entries.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,entries,end]);
}
function assertReport(report,bytes,verdict) {
  assert.equal(report.verdict,verdict); assert.equal(report.checkedBytes,bytes.length);
  assert.equal(report.sha256,hash(bytes)); assert.equal(report.engineVersion,'1.4.6');
  assert.equal(report.mediaAcceptanceReady,false);
  assert.deepEqual(Object.keys(report).sort(),['engine','engineVersion','databaseVersion','databaseUpdatedAt','verdict','checkedBytes','sha256','mediaAcceptanceReady'].sort());
}
const cases = [];
const scenario = (name,run) => cases.push({ name,run });
scenario('fresh approved engine responds but cannot approve media',async () => {
  const status = await client.status(); assert.equal(status.engineVersion,'1.4.6'); assert.equal(status.available,true);
  assert.equal(status.mediaAcceptanceReady,false); assert.equal(typeof client.inspect,'undefined');
  console.log(`Engine: ClamAV ${status.engineVersion}; definitions ${status.databaseVersion}; UTC ${status.databaseUpdatedAt}`);
});
scenario('synthetic one pixel PNG clean with exact size and hash',async () => assertReport(await client.scan(file(png)),png,'clean'));
scenario('harmless EICAR bytes rejected without detection details',async () => {
  // Standard harmless test bytes assembled only in this container's memory;
  // never download/write/execute a test file on Windows or disable antivirus.
  const bytes = Buffer.concat([Buffer.from('X5O!P%@AP[4','ascii'),Buffer.from([92]),
    Buffer.from('PZX54(P^)7CC)7}$','ascii'),Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*','ascii')]);
  assert.equal(bytes.length,68); assertReport(await client.scan(file(bytes)),bytes,'rejected');
});
scenario('two simultaneous streams produce independent clean reports',async () => {
  const second = Buffer.concat([png.subarray(0,33),pngChunk('IDAT',deflateSync(Buffer.from([0,64,128,193]))),pngChunk('IEND',Buffer.alloc(0))]);
  assert.notEqual(hash(png),hash(second));
  const results = await Promise.all([client.scan(file(png)),client.scan(file(second))]);
  assertReport(results[0],png,'clean'); assertReport(results[1],second,'clean');
});
scenario('incorrect hash fails closed and destroys its source',async () => {
  const input = file(png,{ sha256:'0'.repeat(64) });
  await assert.rejects(client.scan(input),{ message:'SCAN_INVALID' }); assert.equal(input.stream.destroyed,true);
});
scenario('short stream fails closed and destroys its source',async () => {
  const input = file(png,{ size:png.length+1 });
  await assert.rejects(client.scan(input),{ message:'SCAN_INVALID' }); assert.equal(input.stream.destroyed,true);
});
scenario('daemon archive file count limit cannot become clean',async () => {
  const control = archiveWithFiles(999), boundary = archiveWithFiles(1000), bytes = archiveWithFiles(1001); assert.ok(bytes.length < 128*1024);
  assertReport(await client.scan(file(control)),control,'clean');
  assertReport(await client.scan(file(boundary)),boundary,'rejected');
  assertReport(await client.scan(file(bytes)),bytes,'rejected');
  console.log('Archive file boundary: 999 clean; 1000 rejected; 1001 rejected');
});
scenario('exact ten MiB synthetic byte stream is completely scanned',async () => {
  // Anti-malware wire/size fixture, not proof of PNG decoding/acceptance.
  const bytes = Buffer.alloc(10*1024*1024,7); assertReport(await client.scan(file(bytes)),bytes,'clean');
});
scenario('over ten MiB image metadata is rejected before transfer',async () => {
  const input = file(png,{ size:10*1024*1024+1 });
  await assert.rejects(client.scan(input),{ message:'SCAN_INVALID' }); assert.equal(input.stream.destroyed,true);
});
scenario('exact fifty MiB synthetic video bytes are completely scanned',async () => {
  // A byte-limit wire fixture, NOT an MP4 decode/format acceptance result.
  const bytes = Buffer.alloc(50*1024*1024,7);
  assertReport(await client.scan(file(bytes,{ type:'video/mp4' })),bytes,'clean');
});
scenario('over fifty MiB video metadata is rejected before transfer',async () => {
  const input = file(png,{ type:'video/mp4',size:50*1024*1024+1 });
  await assert.rejects(client.scan(input),{ message:'SCAN_INVALID' }); assert.equal(input.stream.destroyed,true);
});
scenario('closed loopback endpoint fails with a generic code',async () => {
  const unavailable = new LocalClamAvClient({ ...clientOptions,endpoint:{ host:'127.0.0.1',port:3311 } });
  await assert.rejects(unavailable.status(),{ message:'SCAN_UNAVAILABLE' });
});
scenario('cancelled stalled stream closes and daemon stays available',async () => {
  const controller = new AbortController(); let pushed = false, timer;
  const stream = new Readable({ read() {
    if (!pushed) { pushed = true; this.push(png.subarray(0,8)); timer = setTimeout(() => controller.abort(),200); }
  } });
  try { await assert.rejects(client.scan(file(png,{ stream }),{ signal:controller.signal }),{ message:'SCAN_UNAVAILABLE' }); }
  finally { clearTimeout(timer); stream.destroy(); }
  assert.equal(pushed,true); assert.equal(stream.destroyed,true); assert.equal((await client.status()).available,true);
});

try {
  const deadline = Date.now()+180000; let ready = false;
  while (Date.now() < deadline) {
    try { await client.status(); ready = true; break; } catch { await delay(1000); }
  }
  if (!ready) throw new Error('CLAMAV_NATIVE_NOT_READY');
  for (const entry of cases) {
    try { await entry.run(); console.log(`PASS ${entry.name}`); }
    catch { console.log(`FAIL ${entry.name}`); throw new Error('CLAMAV_NATIVE_CASE_FAILED'); }
  }
  console.log('Native ClamAV integration: 13 scenarios passed.');
} catch (error) {
  console.error(error?.message === 'CLAMAV_NATIVE_NOT_READY' ? 'CLAMAV_NATIVE_NOT_READY' : 'CLAMAV_NATIVE_CASE_FAILED');
  process.exitCode = 1;
}

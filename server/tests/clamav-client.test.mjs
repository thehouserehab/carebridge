import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalClamAvClient } from '../clamav-client.mjs';
import { MediaUploads } from '../media-uploads.mjs';
import { RepositoryError } from '../errors.mjs';
import { MEDIA_LIMITS } from '../../src/media-policy.js';

// This is a wire-protocol test double, NOT ClamAV or evidence of malware
// detection/normal media decoding. Fixtures contain no personal/clinical data.
const NOW = Date.UTC(2026,9,2,3,0,0);
const VERSION = 'ClamAV 1.4.3/30001/Fri Oct  2 01:00:00 2026';
const COMMANDS = 'PING VERSION VERSIONCOMMANDS INSTREAM';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const code = (expected) => (error) => error instanceof RepositoryError && error.code === expected && error.message === expected;
const bytes = Buffer.from('generated protocol fixture, not a photo');
const input = (data = bytes,extra = {}) => ({ stream:Readable.from([data],{ objectMode:false }),
  type:'image/png',size:data.length,sha256:digest(data),...extra });
const defaults = (endpoint,extra = {}) => ({ endpoint,approvedEngineVersions:['1.4.3'],daemonTimeZone:'UTC',
  now:() => NOW,timeoutMilliseconds:3000,connectTimeoutMilliseconds:500,...extra });
const finish = (socket,reply) => socket.end(Buffer.from(`${reply}\0`,'ascii'));

async function daemon(t, { version = VERSION, commands = COMMANDS, onCommand = null, onChunk = null, onScan = null } = {}) {
  const sockets = new Set(), requests = [], scans = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error',() => {});
    socket.once('close',() => sockets.delete(socket));
    let pending = Buffer.alloc(0), command = null, parts = [], lengths = [], ended = false;
    socket.on('data',(chunk) => {
      if (ended) return;
      pending = Buffer.concat([pending,chunk]);
      if (!command) {
        const end = pending.indexOf(0);
        if (end < 0) return;
        command = pending.subarray(0,end).toString('ascii');
        pending = pending.subarray(end + 1);
        requests.push(command);
        if (onCommand?.({ socket,command,requests }) === true) { ended = true; return; }
        if (command === 'zPING') { ended = true; finish(socket,'PONG'); return; }
        if (command === 'zVERSIONCOMMANDS') { ended = true; finish(socket,`${version}| COMMANDS: ${commands}`); return; }
        if (command === 'zVERSION') { ended = true; finish(socket,version); return; }
        assert.equal(command,'zINSTREAM');
      }
      while (pending.length >= 4) {
        const length = pending.readUInt32BE(0);
        if (pending.length < 4 + length) return;
        const data = Buffer.from(pending.subarray(4,4 + length));
        pending = pending.subarray(4 + length);
        if (length === 0) {
          ended = true;
          const scan = { bytes:Buffer.concat(parts),lengths,remaining:Buffer.from(pending) };
          scans.push(scan);
          if (onScan) onScan({ socket,scan,requests });
          else finish(socket,'stream: OK');
          return;
        }
        lengths.push(length); parts.push(data);
        if (onChunk?.({ socket,data,length,requests }) === true) { ended = true; return; }
      }
    });
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { endpoint:{ host:'127.0.0.1',port:server.address().port },requests,scans,sockets };
}

test('requires explicit local endpoint, approved releases, UTC and bounded operator configuration',() => {
  const good = defaults({ host:'127.0.0.1',port:3310 });
  for (const endpoint of [null,{}, { host:'localhost',port:3310 },{ host:'0.0.0.0',port:3310 },
    { host:'192.0.2.1',port:3310 },{ host:'::ffff:127.0.0.1',port:3310 },{ host:'127.0.0.1',port:0 },
    { host:'127.0.0.1',port:3310,path:'/tmp/daemon.sock' }])
    assert.throws(() => new LocalClamAvClient({ ...good,endpoint }),TypeError);
  for (const approvedEngineVersions of [undefined,[],['latest'],['1.4.3-dev'],Array(9).fill('1.4.3')])
    assert.throws(() => new LocalClamAvClient({ ...good,approvedEngineVersions }),TypeError);
  for (const extra of [{ daemonTimeZone:undefined },{ daemonTimeZone:'Asia/Seoul' },{ maxConcurrent:0 },
    { maxConcurrent:5 },{ timeoutMilliseconds:120001 },{ connectTimeoutMilliseconds:5001 },
    { maxDatabaseAgeMilliseconds:49 * 3600000 },{ now:null }])
    assert.throws(() => new LocalClamAvClient({ ...good,...extra }),TypeError);
  assert.doesNotThrow(() => new LocalClamAvClient(defaults({ host:'::1',port:3310 })));
});

test('status verifies daemon response, loaded signatures and capabilities but never marks media acceptance ready',{ timeout:5000 },async (t) => {
  const fake = await daemon(t), client = new LocalClamAvClient(defaults(fake.endpoint));
  assert.deepEqual(await client.status(),{ engine:'clamav',engineVersion:'1.4.3',databaseVersion:30001,
    databaseUpdatedAt:'2026-10-02T01:00:00.000Z',available:true,mediaAcceptanceReady:false });
  assert.deepEqual(fake.requests,['zPING','zVERSIONCOMMANDS']);
  assert.equal(client.inspect,undefined);
  assert.throws(() => new MediaUploads({ transaction() {} },{ write() {},openVerified() {},remove() {} },{ scanner:client }),TypeError);
});

test('streams exact bytes in bounded network-order chunks with zero terminator and verifies version again',{ timeout:5000 },async (t) => {
  const fake = await daemon(t), client = new LocalClamAvClient(defaults(fake.endpoint));
  const data = Buffer.alloc(3 * 65536 + 7,37), file = input(data);
  const report = await client.scan(file);
  assert.equal(report.verdict,'clean');
  assert.equal(report.mediaAcceptanceReady,false);
  assert.equal(report.checkedBytes,data.length);
  assert.equal(report.sha256,digest(data));
  assert.equal(report.engineVersion,'1.4.3');
  assert.equal(report.media,undefined);
  assert.equal(report.policyVersion,undefined);
  assert.deepEqual(fake.scans[0].bytes,data);
  assert.deepEqual(fake.scans[0].lengths,[65536,65536,65536,7]);
  assert.equal(fake.scans[0].remaining.length,0);
  assert.deepEqual(fake.requests,['zPING','zVERSIONCOMMANDS','zINSTREAM','zVERSION']);
  assert.equal(file.stream.destroyed,true);
});

test('a FOUND reply is rejection without leaking raw detection names or source metadata',{ timeout:5000 },async (t) => {
  const fake = await daemon(t,{ onScan:({ socket }) => finish(socket,'stream: PRIVATE-DETECTION-SENTINEL FOUND') });
  const report = await new LocalClamAvClient(defaults(fake.endpoint)).scan(input());
  assert.equal(report.verdict,'rejected');
  assert.equal(report.mediaAcceptanceReady,false);
  assert.equal(JSON.stringify(report).includes('PRIVATE-DETECTION-SENTINEL'),false);
});

test('rejects invalid manifests and object/text/already consumed streams before connecting',{ timeout:5000 },async (t) => {
  const fake = await daemon(t), client = new LocalClamAvClient(defaults(fake.endpoint));
  for (const extra of [{ size:0 },{ size:MEDIA_LIMITS.image + 1 },{ type:'image/heic' },{ sha256:'NOT-A-HASH' },
    { name:'PRIVATE-FILENAME' },{ endpoint:{ host:'192.0.2.1',port:3310 } },
    { stream:Readable.from([bytes]) },{ stream:Readable.from([bytes],{ objectMode:false,encoding:'utf8' }) }]) {
    const file = input(bytes,extra);
    await assert.rejects(client.scan(file),code('SCAN_INVALID'));
    assert.equal(file.stream.destroyed,true);
  }
  const closed = input(); closed.stream.destroy();
  await assert.rejects(client.scan(closed),code('SCAN_INVALID'));
  assert.equal(fake.requests.length,0);
});

test('short, excessive and hash-mismatched streams never send the final scan marker',{ timeout:5000 },async (t) => {
  const fake = await daemon(t), client = new LocalClamAvClient(defaults(fake.endpoint));
  for (const extra of [{ size:bytes.length - 1 },{ size:bytes.length + 1 },{ sha256:'0'.repeat(64) }]) {
    const file = input(bytes,extra);
    await assert.rejects(client.scan(file),code('SCAN_INVALID'));
    assert.equal(file.stream.destroyed,true);
  }
  assert.equal(fake.scans.length,0);
  assert.equal(fake.requests.filter((command) => command === 'zVERSION').length,0);
});

test('rejects unapproved engine, missing/stale/future or malformed loaded database dates before sending bytes',{ timeout:5000 },async (t) => {
  for (const version of ['ClamAV 1.4.2/30001/Fri Oct  2 01:00:00 2026','ClamAV 1.4.3',
    'ClamAV 1.4.3/30001/Tue Sep 29 01:00:00 2026','ClamAV 1.4.3/30001/Fri Oct  2 03:05:01 2026',
    'ClamAV 1.4.3/30001/Thu Oct  2 01:00:00 2026','ClamAV 1.4.3/30001/Mon Feb 30 01:00:00 2026',
    'ClamAV 1.4.3/30001/Fri Oct  2 25:00:00 2026','ClamAV 1.4.3/0/Fri Oct  2 01:00:00 2026',
    'ClamAV 1.4.3/4294967296/Fri Oct  2 01:00:00 2026']) {
    const fake = await daemon(t,{ version });
    const file = input();
    await assert.rejects(new LocalClamAvClient(defaults(fake.endpoint)).scan(file),code('SCAN_UNAVAILABLE'));
    assert.equal(fake.scans.length,0);
    assert.equal(fake.requests.includes('zINSTREAM'),false);
    assert.equal(file.stream.destroyed,true);
  }
});

test('signature-age and future-skew boundaries are explicit and the host timezone does not control UTC parsing',{ timeout:5000 },async (t) => {
  for (const version of ['ClamAV 1.4.3/30001/Wed Sep 30 03:00:00 2026','ClamAV 1.4.3/30001/Fri Oct  2 03:05:00 2026']) {
    const fake = await daemon(t,{ version });
    const report = await new LocalClamAvClient(defaults(fake.endpoint)).status();
    assert.equal(report.available,true);
  }
  const stale = await daemon(t,{ version:'ClamAV 1.4.3/30001/Wed Sep 30 02:59:59 2026' });
  await assert.rejects(new LocalClamAvClient(defaults(stale.endpoint)).status(),code('SCAN_UNAVAILABLE'));
  const fresh = await daemon(t);
  await assert.rejects(new LocalClamAvClient(defaults(fresh.endpoint,{ maxDatabaseAgeMilliseconds:3600000 })).status(),code('SCAN_UNAVAILABLE'));
});

test('missing/invalid advertised capabilities, daemon errors and wrong PING fail closed',{ timeout:5000 },async (t) => {
  for (const commands of ['PING VERSION','PING VERSION INSTREAM PRIVATE_COMMAND','PING VERSION instream']) {
    const fake = await daemon(t,{ commands });
    await assert.rejects(new LocalClamAvClient(defaults(fake.endpoint)).status(),code('SCAN_UNAVAILABLE'));
  }
  for (const reply of ['PONG extra','COMMAND UNAVAILABLE','PRIVATE-ENGINE-ERROR']) {
    const fake = await daemon(t,{ onCommand:({ command,socket }) => {
      if (command !== 'zPING') return false;
      finish(socket,reply); return true;
    } });
    await assert.rejects(new LocalClamAvClient(defaults(fake.endpoint)).status(),code('SCAN_UNAVAILABLE'));
  }
});

test('fragmented command responses and delayed fragmented scan replies are accepted only after EOF',{ timeout:5000 },async (t) => {
  const tasks = [];
  const fake = await daemon(t,{ onCommand:({ command,socket }) => {
    if (command !== 'zPING') return false;
    socket.write('PO');
    tasks.push(delay(5).then(() => socket.end(Buffer.from('NG\0','ascii'))));
    return true;
  },onScan:({ socket }) => {
    socket.write('stream: ');
    tasks.push(delay(5).then(() => socket.write('OK')));
    tasks.push(delay(10).then(() => socket.end(Buffer.from([0]))));
  } });
  assert.equal((await new LocalClamAvClient(defaults(fake.endpoint)).scan(input())).verdict,'clean');
  await Promise.all(tasks);
});

test('scan errors, ambiguous records, paths, unterminated and non-ASCII responses cannot become clean',{ timeout:5000 },async (t) => {
  for (const reply of ['INSTREAM size limit exceeded. ERROR\0','stream: PRIVATE-DAEMON-DETAIL ERROR\0',
    '/private/path: OK\0','stream: OK\0stream: fake FOUND\0','stream: OK\n','stream: OK',
    'stream: OK\0garbage','stream: \xff FOUND\0']) {
    const fake = await daemon(t,{ onScan:({ socket }) => socket.end(Buffer.from(reply,'latin1')) });
    const file = input();
    await assert.rejects(new LocalClamAvClient(defaults(fake.endpoint)).scan(file),code('SCAN_UNAVAILABLE'));
    assert.equal(file.stream.destroyed,true);
  }
});

test('a delayed second record is rejected rather than trusting the first clean terminator',{ timeout:5000 },async (t) => {
  let sending;
  const fake = await daemon(t,{ onScan:({ socket }) => {
    socket.write(Buffer.from('stream: OK\0','ascii'));
    sending = delay(10).then(() => socket.end(Buffer.from('stream: fake FOUND\0','ascii')));
  } });
  await assert.rejects(new LocalClamAvClient(defaults(fake.endpoint)).scan(input()),code('SCAN_UNAVAILABLE'));
  await sending;
});

test('oversized responses are bounded and rejected without waiting for EOF',{ timeout:5000 },async (t) => {
  const fake = await daemon(t,{ onScan:({ socket }) => socket.write(Buffer.alloc(5000,65)) });
  await assert.rejects(new LocalClamAvClient(defaults(fake.endpoint)).scan(input()),code('SCAN_UNAVAILABLE'));
});

test('early clean and early rejection never approve an incomplete source',{ timeout:5000 },async (t) => {
  for (const reply of ['stream: OK','stream: Fake FOUND']) {
    const fake = await daemon(t,{ onChunk:({ socket }) => { finish(socket,reply); return true; } });
    const stream = new Readable({ read() { this.push(bytes); this._read = () => {}; } });
    const file = input(bytes,{ stream,size:bytes.length + 1 });
    await assert.rejects(new LocalClamAvClient(defaults(fake.endpoint)).scan(file),code('SCAN_UNAVAILABLE'));
    assert.equal(stream.destroyed,true);
    assert.equal(fake.scans.length,0);
  }
});

test('a loaded-database or approved-engine change during inspection invalidates the result',{ timeout:5000 },async (t) => {
  for (const version of ['ClamAV 1.4.3/30002/Fri Oct  2 01:01:00 2026','ClamAV 1.4.4/30001/Fri Oct  2 01:00:00 2026']) {
    const fake = await daemon(t,{ onCommand:({ command,socket }) => {
      if (command !== 'zVERSION') return false;
      finish(socket,version); return true;
    } });
    await assert.rejects(new LocalClamAvClient(defaults(fake.endpoint,{ approvedEngineVersions:['1.4.3','1.4.4'] })).scan(input()),code('SCAN_UNAVAILABLE'));
    assert.equal(fake.scans.length,1);
  }
});

test('post-scan unavailable/stale status and invalid operator clock invalidate an apparent clean reply',{ timeout:5000 },async (t) => {
  for (const reply of ['COMMAND UNAVAILABLE','ClamAV 1.4.3/30001/Tue Sep 29 01:00:00 2026']) {
    const fake = await daemon(t,{ onCommand:({ command,socket }) => {
      if (command !== 'zVERSION') return false;
      finish(socket,reply); return true;
    } });
    await assert.rejects(new LocalClamAvClient(defaults(fake.endpoint)).scan(input()),code('SCAN_UNAVAILABLE'));
  }
  const fake = await daemon(t);
  await assert.rejects(new LocalClamAvClient(defaults(fake.endpoint,{ now:() => NaN })).status(),code('SCAN_UNAVAILABLE'));
});

test('source IO errors during preflight or streaming are redacted and resources are closed',{ timeout:5000 },async (t) => {
  const fake = await daemon(t), client = new LocalClamAvClient(defaults(fake.endpoint));
  const early = input();
  const job = client.scan(early);
  early.stream.destroy(new Error('PRIVATE-SOURCE-PATH'));
  await assert.rejects(job,code('SCAN_UNAVAILABLE'));
  const stream = new Readable({ read() { this.destroy(new Error('PRIVATE-SOURCE-ERROR')); } });
  await assert.rejects(client.scan(input(bytes,{ stream })),code('SCAN_UNAVAILABLE'));
  assert.equal(stream.destroyed,true);
  assert.equal(fake.scans.length,0);
});

test('whole-job timeout bounds stalled source and silent daemon, and releases the concurrency slot',{ timeout:5000 },async (t) => {
  const fake = await daemon(t), client = new LocalClamAvClient(defaults(fake.endpoint,{ timeoutMilliseconds:300,connectTimeoutMilliseconds:300,maxConcurrent:1 }));
  const stream = new Readable({ read() {} });
  await assert.rejects(client.scan(input(bytes,{ stream })),code('SCAN_UNAVAILABLE'));
  assert.equal(stream.destroyed,true);
  assert.equal((await client.status()).available,true);
  const silent = await daemon(t,{ onScan:() => {} });
  await assert.rejects(new LocalClamAvClient(defaults(silent.endpoint,{ timeoutMilliseconds:300,connectTimeoutMilliseconds:300 })).scan(input()),code('SCAN_UNAVAILABLE'));
});

test('external cancellation works during preflight and streaming without exposing abort reasons',{ timeout:5000 },async (t) => {
  const fake = await daemon(t,{ onCommand:({ command }) => command === 'zPING' });
  const abort = new AbortController(), file = input();
  const job = new LocalClamAvClient(defaults(fake.endpoint)).scan(file,{ signal:abort.signal });
  abort.abort(new Error('PRIVATE-ABORT-DETAIL'));
  await assert.rejects(job,code('SCAN_UNAVAILABLE'));
  assert.equal(file.stream.destroyed,true);
  const streaming = await daemon(t), controller = new AbortController();
  const stream = new Readable({ read() { controller.abort('PRIVATE-STREAM-DETAIL'); } });
  await assert.rejects(new LocalClamAvClient(defaults(streaming.endpoint)).scan(input(bytes,{ stream }),{ signal:controller.signal }),code('SCAN_UNAVAILABLE'));
  assert.equal(stream.destroyed,true);
});

test('already aborted/invalid signals fail before opening sockets and destroy accepted input streams',{ timeout:5000 },async (t) => {
  const fake = await daemon(t), client = new LocalClamAvClient(defaults(fake.endpoint));
  for (const signal of [AbortSignal.abort('PRIVATE-REASON'),{}]) {
    const file = input();
    await assert.rejects(client.scan(file,{ signal }),code('SCAN_UNAVAILABLE'));
    assert.equal(file.stream.destroyed,true);
  }
  assert.equal(fake.requests.length,0);
});

test('concurrency is bounded without an unbounded wait queue',{ timeout:5000 },async (t) => {
  const fake = await daemon(t,{ onCommand:({ command }) => command === 'zPING' });
  const client = new LocalClamAvClient(defaults(fake.endpoint,{ maxConcurrent:1 })), controller = new AbortController();
  const first = client.status({ signal:controller.signal });
  const rejected = input();
  await assert.rejects(client.scan(rejected),code('SCAN_UNAVAILABLE'));
  assert.equal(rejected.stream.destroyed,true);
  controller.abort();
  await assert.rejects(first,code('SCAN_UNAVAILABLE'));
});

test('slow readers apply backpressure while still receiving the exact entire input',{ timeout:5000 },async (t) => {
  let resumed;
  const fake = await daemon(t,{ onCommand:({ command,socket }) => {
    if (command === 'zINSTREAM') {
      socket.pause(); resumed = delay(30).then(() => socket.resume());
    }
    return false;
  } });
  const data = Buffer.alloc(2 * 1024 * 1024,73), file = input(data);
  const report = await new LocalClamAvClient(defaults(fake.endpoint)).scan(file);
  assert.equal(report.verdict,'clean');
  assert.deepEqual(fake.scans[0].bytes,data);
  assert.ok(fake.scans[0].lengths.every((length) => length <= 65536));
  await resumed;
});

test('transport disconnect/refused connection are generic and do not leave open source streams',{ timeout:5000 },async (t) => {
  const fake = await daemon(t,{ onScan:({ socket }) => socket.destroy() });
  const file = input();
  await assert.rejects(new LocalClamAvClient(defaults(fake.endpoint)).scan(file),code('SCAN_UNAVAILABLE'));
  assert.equal(file.stream.destroyed,true);
  const unused = createServer();
  await new Promise((resolve) => unused.listen(0,'127.0.0.1',resolve));
  const endpoint = { host:'127.0.0.1',port:unused.address().port };
  await new Promise((resolve) => unused.close(resolve));
  const refused = input();
  await assert.rejects(new LocalClamAvClient(defaults(endpoint)).scan(refused),code('SCAN_UNAVAILABLE'));
  assert.equal(refused.stream.destroyed,true);
});

test('operator endpoints and approved versions are copied rather than retaining mutable caller configuration',{ timeout:5000 },async (t) => {
  const fake = await daemon(t), config = defaults({ ...fake.endpoint });
  const client = new LocalClamAvClient(config);
  config.endpoint.host = '192.0.2.1'; config.endpoint.port = 1;
  config.approvedEngineVersions.splice(0,1,'0.0.0');
  assert.equal((await client.status()).engineVersion,'1.4.3');
});

test('signatures aging out during inspection invalidate even an unchanged final version',{ timeout:5000 },async (t) => {
  let current = NOW;
  const fake = await daemon(t,{ onScan:({ socket }) => {
    current += 47 * 3600000; finish(socket,'stream: OK');
  } });
  await assert.rejects(new LocalClamAvClient(defaults(fake.endpoint,{ now:() => current })).scan(input()),code('SCAN_UNAVAILABLE'));
});

test('parallel jobs use independent sockets, hashes and verdicts',{ timeout:5000 },async (t) => {
  const infected = Buffer.from('synthetic rejected protocol fixture');
  const fake = await daemon(t,{ onScan:({ socket,scan }) => {
    finish(socket,scan.bytes.equals(infected) ? 'stream: Fake FOUND' : 'stream: OK');
  } });
  const client = new LocalClamAvClient(defaults(fake.endpoint,{ maxConcurrent:2 }));
  const [clean,rejected] = await Promise.all([client.scan(input()),client.scan(input(infected))]);
  assert.equal(clean.verdict,'clean'); assert.equal(clean.sha256,digest(bytes));
  assert.equal(rejected.verdict,'rejected'); assert.equal(rejected.sha256,digest(infected));
  assert.equal(fake.scans.length,2);
  assert.equal(fake.requests.filter((command) => command === 'zVERSION').length,2);
});

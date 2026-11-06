import assert from 'node:assert/strict';
import { test,before,beforeEach,after } from 'node:test';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrate.mjs';
import { DecoderJobJournal } from '../decoder-journal.mjs';
import { IsolatedMediaDecoder } from '../decoder-jobs.mjs';
import { RepositoryError } from '../errors.mjs';
import { decoderJobSource,decoderJobHeader,parseDecoderJobHeader,decoderJobReport,DECODER_JOB_PROTOCOL } from '../decoder-job-protocol.mjs';
import { DECODER_JOB_LABEL,decoderResourceNames,decoderReceipt,decoderContainerArguments,assertDecoderIsolation,DECODER_NODE_IMAGE } from '../decoder-container-policy.mjs';

// Contract double ONLY: these bytes/reports are not evidence of native decode.
const bytes = Buffer.from('synthetic protocol bytes'),run = '12345678-1234-4234-8234-123456789abc';
const image = `sha256:${'a'.repeat(64)}`,engine = 'synthetic-local-engine-0001';
const hash = (data) => createHash('sha256').update(data).digest('hex');
const manifest = { type:'image/png',size:bytes.length,sha256:hash(bytes) };
const input = (changes = {}) => ({ stream:Readable.from([bytes],{ objectMode:false }),...manifest,...changes });
const code = (expected) => (error) => error instanceof RepositoryError && error.code === expected && error.message === expected;
const report = (file = manifest) => ({ engine:'ffmpeg',engineVersion:'9.0.2',media:{ type:file.type,width:32,height:24,...(file.type.startsWith('video/') ? { duration:2 } : {}) },
  decodedVideoFrames:1,decodedAudioFrames:0,checkedBytes:file.size,sha256:file.sha256,mediaAcceptanceReady:false });
const envelope = (id = run,file = manifest,changes = {}) => JSON.stringify({ protocol:DECODER_JOB_PROTOCOL,id,report:report(file),...changes });
function state(id,names) {
  return { Id:id,Name:`/${names.worker}`,Image:image,State:{ Running:false,Status:'created',ExitCode:0,OOMKilled:false },
    Config:{ User:'node',Env:['TZ=UTC'],Labels:{ [DECODER_JOB_LABEL]:names.run },OpenStdin:true,Tty:false,
      Entrypoint:['/usr/local/bin/node'],Cmd:['/app/server/decoder-job-worker.mjs'] },
    HostConfig:{ ReadonlyRootfs:true,Privileged:false,NetworkMode:'none',PidMode:'',IpcMode:'private',UTSMode:'',
      Memory:1024**3,MemorySwap:1024**3,NanoCpus:1e9,PidsLimit:128,LogConfig:{ Type:'none' },RestartPolicy:{ Name:'no' },
      Ulimits:[{ Name:'nofile',Soft:1024,Hard:1024 }],
      CapDrop:['ALL'],CapAdd:null,SecurityOpt:['no-new-privileges'],Binds:null,VolumesFrom:null,Devices:[],DeviceRequests:[],Mounts:[],PortBindings:{},
      Tmpfs:{ '/tmp':'rw,noexec,nosuid,nodev,size=256m,mode=1777' } },Mounts:[],
    NetworkSettings:{ Networks:{ none:{ IPAddress:'',Gateway:'',GlobalIPv6Address:'',IPv6Gateway:'' } },Ports:{} } };
}
function fake(options = {}) {
  const containers = new Map(),calls = [],packets = []; let sequence = 0;
  const runtime = {
    async identity() { return options.engine?.() ?? engine; },
    async inspect(kind,id) {
      calls.push(['inspect',kind,id]);
      if (kind === 'image') return { Id:image,Os:'linux',Architecture:'amd64',Config:{ User:'node',...options.imageConfig } };
      const value = containers.get(id) ?? [...containers.values()].find((value) => value.Name === `/${id}`);
      if (!value) throw new Error('PRIVATE DRIVER DIAGNOSTIC'); return structuredClone(value);
    },
    async docker(args) {
      calls.push(args);
      if (args[0] === 'ps') {
        const filter = args[args.indexOf('--filter')+1];
        if (filter.startsWith('id=')) return containers.has(filter.slice(3)) ? filter.slice(3) : '';
        return options.collision ? 'short' : '';
      }
      if (args[0] === 'create') {
        const name = args[args.indexOf('--name')+1],label = args[args.indexOf('--label')+1];
        const names = decoderResourceNames(label.split('=')[1],'job'); assert.equal(name,names.worker);
        const id = (++sequence).toString(16).padStart(64,'0'),value = state(id,names); options.created?.(value);
        if (!options.createAbsent) containers.set(id,value);
        if (options.createThrows) throw new Error('PRIVATE CREATE DIAGNOSTIC'); return id;
      }
      const value = containers.get(args.at(-1)); if (!value) throw new Error('PRIVATE DRIVER DIAGNOSTIC');
      if (args[0] === 'kill') { if (options.kill) return options.kill(value); value.State.Running = false; value.State.Status = 'exited'; return value.Id; }
      if (args[0] === 'rm') {
        if (options.rmFails) throw new Error('PRIVATE CLEANUP DIAGNOSTIC'); assert.equal(value.State.Running,false);
        containers.delete(value.Id); return value.Id;
      }
      throw new Error('UNEXPECTED DRIVER COMMAND');
    },
    async exchange(id,packet,{ signal,onFailure,outputLimit }) {
      assert.equal(outputLimit,4096); const value = containers.get(id); value.State.Running = true; value.State.Status = 'running';
      const started = () => options.started?.(value); started();
      if (options.stall) {
        await new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort',resolve,{ once:true }); });
        onFailure(); throw new RepositoryError('SCAN_UNAVAILABLE');
      }
      let chunks = [];
      try { for await (const part of packet) chunks.push(part); }
      catch (error) { onFailure(); throw error; }
      const payload = Buffer.concat(chunks),length = payload.readUInt32BE(0);
      const header = parseDecoderJobHeader(payload.subarray(4,4+length));
      const body = payload.subarray(4+length); assert.equal(body.length,header.size); assert.equal(hash(body),header.sha256); packets.push({ header,body });
      value.State.Running = false; value.State.Status = 'exited'; value.State.ExitCode = options.workerError ? 1 : 0;
      options.exited?.(value);
      return { code:options.transportCode ?? 0,output:options.output?.(header) ?? (options.workerError ?
        JSON.stringify({ protocol:DECODER_JOB_PROTOCOL,id:header.id,error:options.workerError }) : envelope(header.id,{ type:header.type,size:header.size,sha256:header.sha256 })) };
    },
  };
  return { runtime,containers,calls,packets,options,decoder:new IsolatedMediaDecoder({ runtime,approvedImageId:image,engineIdentity:engine,...options.config }) };
}
test('job protocol uses an exact bounded length-prefixed manifest, not names or paths',() => {
  const header = decoderJobHeader(run,manifest); assert.equal(header.readUInt32BE(0),header.length-4);
  assert.deepEqual(parseDecoderJobHeader(header.subarray(4)),{ id:run,...manifest }); assert.ok(header.length < 1028);
  assert.ok(Object.isFrozen(decoderJobSource(input())));
  for (const changes of [{ path:'/private' },{ url:'https://example.invalid' },{ filename:'private.png' },{ actor:'private' },
    { size:0 },{ size:10485761 },{ sha256:'short' },{ type:'text/plain' },{ stream:Readable.from([bytes]) }]) assert.throws(() => decoderJobSource(input(changes)),code('SCAN_INVALID'));
  const video = { ...manifest,type:'video/mp4',size:50*1024*1024 }; decoderJobHeader(run,video);
  assert.throws(() => decoderJobHeader(run,{ ...video,size:video.size+1 }),code('SCAN_INVALID'));
});
test('invalid header bytes fields IDs Unicode or protocol cannot introduce other job information',() => {
  for (const value of [null,[],{}, { protocol:DECODER_JOB_PROTOCOL,id:run,...manifest,path:'/private' },
    { protocol:'future',id:run,...manifest },{ protocol:DECODER_JOB_PROTOCOL,id:'existing',...manifest }]) {
    assert.throws(() => parseDecoderJobHeader(Buffer.from(JSON.stringify(value))),code('SCAN_INVALID'));
  }
  for (const value of [Buffer.alloc(0),Buffer.alloc(1025),Buffer.from([0xff]),Buffer.from('{')]) assert.throws(() => parseDecoderJobHeader(value),code('SCAN_INVALID'));
});
test('worker report must match exact nonce source engine shape and decode budgets',() => {
  assert.deepEqual(decoderJobReport(envelope(),run,manifest,0),report());
  for (const changes of [{ engine:'other' },{ engineVersion:'latest' },{ mediaAcceptanceReady:true },{ checkedBytes:1 },{ sha256:'0'.repeat(64) },
    { decodedAudioFrames:1 },{ decodedVideoFrames:0 },{ decodedVideoFrames:144001 },{ privateMetadata:'not allowed' },
    { media:{ type:'image/png',width:8193,height:1 } },{ media:{ type:'image/png',width:8000,height:8000 } },
    { media:{ type:'image/png',width:8000,height:4000 },decodedVideoFrames:1000 },{ media:{ type:'image/png',width:1,height:1,duration:1 } }]) {
    assert.throws(() => decoderJobReport(envelope(run,manifest,{ report:{ ...report(),...changes } }),run,manifest,0),code('SCAN_UNAVAILABLE'));
  }
  for (const output of [envelope('22345678-1234-4234-8234-123456789abc'),envelope(run,manifest,{ path:'/private' }),'not JSON','x'.repeat(4097)])
    assert.throws(() => decoderJobReport(output,run,manifest,0),code('SCAN_UNAVAILABLE'));
  for (const exit of [1,null,-1,256]) assert.throws(() => decoderJobReport(envelope(),run,manifest,exit),code('SCAN_UNAVAILABLE'));
});
test('video reports require measured positive duration and bounded audio frames',() => {
  const video = { ...manifest,type:'video/webm' }; decoderJobReport(envelope(run,video),run,video,0);
  for (const duration of [0,-1,601,'2',null]) assert.throws(() => decoderJobReport(envelope(run,video,{ report:{ ...report(video),media:{ type:video.type,width:32,height:24,duration } } }),run,video,0),code('SCAN_UNAVAILABLE'));
});
test('only fixed worker errors with actual nonzero exit are exposed',() => {
  for (const error of ['SCAN_INVALID','SCAN_UNAVAILABLE']) {
    assert.throws(() => decoderJobReport(JSON.stringify({ protocol:DECODER_JOB_PROTOCOL,id:run,error }),run,manifest,1),code(error));
    assert.throws(() => decoderJobReport(JSON.stringify({ protocol:DECODER_JOB_PROTOCOL,id:run,error }),run,manifest,0),code('SCAN_UNAVAILABLE'));
  }
  assert.throws(() => decoderJobReport(JSON.stringify({ protocol:DECODER_JOB_PROTOCOL,id:run,error:'PRIVATE PATH' }),run,manifest,1),code('SCAN_UNAVAILABLE'));
});
test('each file gets a fresh verified namespace and matching own cleanup receipt',async () => {
  const f = fake(); await f.decoder.decode(input()); await f.decoder.decode(input());
  assert.equal(f.packets.length,2); assert.notEqual(f.packets[0].header.id,f.packets[1].header.id);
  assert.equal(f.containers.size,0); assert.deepEqual(f.decoder.retainedJobs(),[]);
  for (const create of f.calls.filter((call) => call[0] === 'create')) {
    assert.ok(create.includes('--interactive')); assert.ok(create.includes('--network=none')); assert.ok(create.includes(image));
    assert.equal(create.some((arg) => /--mount|--volume|--publish|docker.sock/.test(arg)),false);
  }
  assert.equal(f.calls.filter((call) => call[0] === 'rm').length,2); assert.equal(f.calls.some((call) => call[0] === 'kill'),false);
  assert.equal(typeof f.decoder.inspect,'undefined');
});
test('bad source aborted signal or name collision cannot create a container',async () => {
  for (const changes of [{ filename:'private' },{ size:0 },{ sha256:'bad' }]) {
    const f = fake(); await assert.rejects(f.decoder.decode(input(changes)),code('SCAN_INVALID')); assert.equal(f.calls.length,0);
  }
  const f = fake(),abort = new AbortController(); abort.abort('PRIVATE');
  await assert.rejects(f.decoder.decode(input(),{ signal:abort.signal }),code('SCAN_UNAVAILABLE')); assert.equal(f.calls.length,0);
  const collided = fake({ collision:true }); await assert.rejects(collided.decoder.decode(input()),code('SCAN_UNAVAILABLE'));
  assert.equal(collided.calls.some((call) => call[0] === 'create'),false);
});
test('root volume or port image configuration cannot create or receive payload',async () => {
  for (const imageConfig of [{ User:'root' },{ Volumes:{ '/private':{} } },{ ExposedPorts:{ '8080/tcp':{} } }]) {
    const f = fake({ imageConfig }); await assert.rejects(f.decoder.decode(input()),code('SCAN_UNAVAILABLE'));
    assert.equal(f.containers.size,0); assert.equal(f.packets.length,0);
  }
});
test('created isolation must be verified before source is read and own job is removed',async () => {
  let reads = 0; const stream = new Readable({ read() { reads++; this.push(bytes); this.push(null); } });
  const f = fake({ created(value) { value.Config.OpenStdin = false; } });
  await assert.rejects(f.decoder.decode(input({ stream })),code('SCAN_UNAVAILABLE')); assert.equal(reads,0); assert.equal(f.containers.size,0);
});
test('size hash stream errors and private messages never produce a successful report',async () => {
  for (const changes of [{ size:bytes.length-1 },{ size:bytes.length+1 },{ sha256:'0'.repeat(64) },
    { stream:new Readable({ read() { this.destroy(new Error('PRIVATE HEALTH AND PATH')); } }) }]) {
    const f = fake(); await assert.rejects(f.decoder.decode(input(changes)),code(changes.stream ? 'SCAN_UNAVAILABLE' : 'SCAN_INVALID'));
    assert.equal(f.containers.size,0); assert.equal(f.calls.filter((call) => call[0] === 'kill').length,1);
    assert.deepEqual(f.decoder.retainedJobs(),[]);
  }
});
test('failed kill acknowledgement is resolved only by same-engine owned terminal evidence',async () => {
  const controller = new AbortController(),f = fake({ stall:true,started() { controller.abort(); },kill(value) {
    value.State.Running = false; value.State.Status = 'exited'; throw new Error('PRIVATE ALREADY STOPPED DIAGNOSTIC');
  } });
  await assert.rejects(f.decoder.decode(input(),{ signal:controller.signal }),code('SCAN_UNAVAILABLE'));
  assert.equal(f.containers.size,0); assert.deepEqual(f.decoder.retainedJobs(),[]); assert.equal(f.calls.filter((c) => c[0] === 'rm').length,1);
  f.options.stall = false; f.options.started = undefined; f.options.kill = undefined;
  await f.decoder.decode(input()); assert.equal(f.containers.size,0);
});
test('failed kill with a live worker remains latched until explicit verified recovery',async () => {
  const controller = new AbortController(),f = fake({ stall:true,started() { controller.abort(); },kill() { throw new Error('PRIVATE KILL FAILURE'); } });
  await assert.rejects(f.decoder.decode(input(),{ signal:controller.signal }),code('SCAN_UNAVAILABLE'));
  assert.equal(f.decoder.retainedJobs().length,1); assert.equal(f.calls.some((c) => c[0] === 'rm'),false);
  await assert.rejects(f.decoder.decode(input()),code('SCAN_UNAVAILABLE')); assert.equal(f.calls.filter((c) => c[0] === 'create').length,1);
  f.options.kill = undefined; await f.decoder.recoverRetained(); assert.equal(f.containers.size,0); assert.deepEqual(f.decoder.retainedJobs(),[]);
});
test('failed kill cannot resolve a race using changed container ownership',async () => {
  const controller = new AbortController(),f = fake({ stall:true,started() { controller.abort(); },kill(value) {
    value.State.Running = false; value.State.Status = 'exited'; value.Name = '/unrelated-worker'; throw new Error('PRIVATE KILL FAILURE');
  } });
  await assert.rejects(f.decoder.decode(input(),{ signal:controller.signal }),code('SCAN_UNAVAILABLE'));
  assert.equal(f.decoder.retainedJobs().length,1); assert.equal(f.calls.some((c) => c[0] === 'rm'),false);
});
test('failed kill cannot resolve a race using terminal state from another engine',async () => {
  const controller = new AbortController(); let current = engine;
  const f = fake({ stall:true,engine:() => current,started() { controller.abort(); },kill(value) {
    value.State.Running = false; value.State.Status = 'exited'; current = 'synthetic-different-engine-0002'; throw new Error('PRIVATE KILL FAILURE');
  } });
  await assert.rejects(f.decoder.decode(input(),{ signal:controller.signal }),code('SCAN_UNAVAILABLE'));
  assert.equal(f.decoder.retainedJobs().length,1); assert.equal(f.calls.some((c) => c[0] === 'rm'),false);
});
test('worker invalid file failure is distinct from CLI failure OOM or unsafe final state',async () => {
  const f = fake({ workerError:'SCAN_INVALID' }); await assert.rejects(f.decoder.decode(input()),code('SCAN_INVALID')); assert.equal(f.containers.size,0);
  const propagated = fake({ workerError:'SCAN_INVALID',transportCode:1 }); await assert.rejects(propagated.decoder.decode(input()),code('SCAN_INVALID')); assert.equal(propagated.containers.size,0);
  for (const options of [{ transportCode:1 },{ exited(value) { value.State.OOMKilled = true; } },
    { exited(value) { value.HostConfig.NetworkMode = 'bridge'; } },{ output() { return 'private diagnostic'; } }]) {
    const rejected = fake(options); await assert.rejects(rejected.decoder.decode(input()),code('SCAN_UNAVAILABLE')); assert.equal(rejected.containers.size,0);
  }
});
test('a claimed early success before full source EOF hash is verified cannot be accepted',async () => {
  const f = fake(),runtime = { ...f.runtime,async exchange(id) {
    const value = f.containers.get(id); value.State.Status = 'exited';
    return { code:0,output:envelope(value.Config.Labels[DECODER_JOB_LABEL]) };
  } };
  const isolated = new IsolatedMediaDecoder({ runtime,approvedImageId:image,engineIdentity:engine });
  await assert.rejects(isolated.decode(input()),code('SCAN_UNAVAILABLE')); assert.equal(f.containers.size,0);
});
test('active cancel kills only a verified owned full ID and permits next successful job',async () => {
  const controller = new AbortController(),f = fake({ stall:true,started() { controller.abort('PRIVATE REASON'); } });
  const source = input(); await assert.rejects(f.decoder.decode(source,{ signal:controller.signal }),code('SCAN_UNAVAILABLE'));
  assert.ok(source.stream.destroyed); assert.equal(f.containers.size,0);
  const kill = f.calls.find((call) => call[0] === 'kill'); assert.deepEqual(kill.slice(0,3),['kill','--signal','KILL']); assert.match(kill.at(-1),/^[a-f0-9]{64}$/);
  f.options.stall = false; f.options.started = undefined; await f.decoder.decode(input());
});
test('whole-job deadline closes stalled input and proves container ended before removal',async () => {
  const f = fake({ stall:true,config:{ timeoutMilliseconds:50 } }),stream = new Readable({ read() {} });
  await assert.rejects(f.decoder.decode(input({ stream })),code('SCAN_UNAVAILABLE')); assert.ok(stream.destroyed); assert.equal(f.containers.size,0);
});

test('an unread plain source stopped before any engine work cannot emit an unhandled error',async () => {
  const f = fake(),controller = new AbortController(); controller.abort();
  const stream = new Readable({ read() {} });
  await assert.rejects(f.decoder.decode(input({ stream }),{ signal:controller.signal }),code('SCAN_UNAVAILABLE'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stream.destroyed,true); assert.equal(stream.listenerCount('error'),0); assert.equal(stream.listenerCount('close'),0);
  assert.equal(f.calls.length,0);
});
test('bounded concurrency has no queue and never mixes separate job manifests',async () => {
  const controllers = [new AbortController(),new AbortController()]; let start;
  const started = new Promise((resolve) => { start = resolve; }); let active = 0;
  const f = fake({ stall:true,started() { if (++active === 2) start(); } });
  const tasks = controllers.map((controller) => assert.rejects(f.decoder.decode(input(),{ signal:controller.signal }),code('SCAN_UNAVAILABLE')));
  await started; await assert.rejects(f.decoder.decode(input()),code('SCAN_UNAVAILABLE')); assert.equal(f.containers.size,2);
  controllers.forEach((controller) => controller.abort()); await Promise.all(tasks); assert.equal(f.containers.size,0);
});
test('failed removal overrides successful decode latches closed and can recover exact owned receipt',async () => {
  const f = fake({ rmFails:true }); await assert.rejects(f.decoder.decode(input()),code('SCAN_UNAVAILABLE'));
  const [retained] = f.decoder.retainedJobs(); assert.match(retained.id,/^[a-f0-9]{64}$/); assert.equal(Object.keys(retained).length,3);
  const creates = f.calls.filter((call) => call[0] === 'create').length;
  await assert.rejects(f.decoder.decode(input()),code('SCAN_UNAVAILABLE')); assert.equal(f.calls.filter((call) => call[0] === 'create').length,creates);
  f.options.rmFails = false; await f.decoder.recoverRetained(); assert.equal(f.containers.size,0); await f.decoder.decode(input());
});
test('uncertain creation recovers matching UUID container but absent request remains latched',async () => {
  const known = fake({ createThrows:true }); await assert.rejects(known.decoder.decode(input()),code('SCAN_UNAVAILABLE')); assert.equal(known.containers.size,0);
  assert.deepEqual(known.decoder.retainedJobs(),[]);
  const absent = fake({ createThrows:true,createAbsent:true }); await assert.rejects(absent.decoder.decode(input()),code('SCAN_UNAVAILABLE'));
  assert.equal(absent.decoder.retainedJobs()[0].id,null); await assert.rejects(absent.decoder.recoverRetained(),code('SCAN_UNAVAILABLE'));
  await assert.rejects(absent.decoder.decode(input()),code('SCAN_UNAVAILABLE')); assert.equal(absent.packets.length,0);
});
test('changed engine or ownership prevents both cleanup mutation and new payload',async () => {
  for (const mutate of [(value) => { value.Config.Labels = {}; },(value) => { value.Image = `sha256:${'f'.repeat(64)}`; }]) {
    const f = fake({ created:mutate }); await assert.rejects(f.decoder.decode(input()),code('SCAN_UNAVAILABLE'));
    assert.equal(f.calls.some((call) => ['kill','rm'].includes(call[0])),false); assert.equal(f.decoder.retainedJobs().length,1);
  }
  let changed = false; const f = fake({ engine:() => changed ? 'another-local-engine-0001' : engine,exited() { changed = true; } });
  await assert.rejects(f.decoder.decode(input()),code('SCAN_UNAVAILABLE')); assert.equal(f.calls.some((call) => call[0] === 'rm'),false);
  await assert.rejects(f.decoder.recoverRetained(),code('SCAN_UNAVAILABLE')); changed = false; await f.decoder.recoverRetained(); assert.equal(f.containers.size,0);
});
test('job command purpose input and output stay distinct from synthetic integration containers',() => {
  const names = decoderResourceNames(run,'job'),receipt = decoderReceipt('b'.repeat(64),run,'job'),container = state(receipt.id,names);
  assertDecoderIsolation(container,receipt,image); assert.ok(decoderContainerArguments(names,image,'job').includes(`${DECODER_JOB_LABEL}=${run}`));
  for (const mutate of [(value) => { value.Config.Tty = true; },(value) => { value.Config.Cmd = ['other']; },
    (value) => { value.Config.Entrypoint = ['sh']; },(value) => { value.Config.OpenStdin = false; }]) {
    const altered = structuredClone(container); mutate(altered); assert.throws(() => assertDecoderIsolation(altered,receipt,image),{ message:'DECODER_CONTAINER_SAFETY' });
  }
  assert.throws(() => decoderContainerArguments(names,image),{ message:'DECODER_CONTAINER_SAFETY' });
  assert.throws(() => decoderResourceNames(run,'arbitrary'),{ message:'DECODER_CONTAINER_SAFETY' });
});
test('worker build deny-all context excludes private data encoders file pipe and network protocol',async () => {
  const dockerfile = await readFile(new URL('../decoder-job.Dockerfile',import.meta.url),'utf8');
  assert.ok(dockerfile.includes(`FROM ${DECODER_NODE_IMAGE} AS compiled`));
  for (const required of ['--disable-network','--disable-autodetect','--disable-everything','--disable-ffmpeg','--enable-protocol=fd','COPYING.LGPLv2.1']) assert.ok(dockerfile.includes(required));
  assert.equal(/--enable-encoder|--enable-gpl|--enable-protocol=.*file|COPY\s+\.\s|ADD\s|curl\s|wget\s/.test(dockerfile),false);
  const rules = (await readFile(new URL('../decoder-job.Dockerfile.dockerignore',import.meta.url),'utf8')).split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(rules,['**','!package.json','!src/','!src/media-policy.js','!server/','!server/errors.mjs','!server/media-decoder-policy.mjs',
    '!server/media-container-validation.mjs','!server/media-decoder.mjs','!server/decoder-job-protocol.mjs','!server/decoder-job-worker.mjs',
    '!server/media-preparation-protocol.mjs','!server/media-preparation-policy.mjs','!server/media-preparation-worker.mjs',
    '!server/image-metadata.mjs','!server/icc-profile.mjs','!server/video-metadata.mjs','!server/mp4-metadata.mjs','!server/webm-metadata.mjs',
    '!test-results/','!test-results/runtime-build/','!test-results/runtime-build/ffmpeg-9.0.2/',
    '!test-results/runtime-build/ffmpeg-9.0.2/ffmpeg-9.0.2.tar.xz','!test-results/runtime-build/ffmpeg-9.0.2/ffmpeg-9.0.2.tar.xz.asc','!test-results/runtime-build/ffmpeg-9.0.2/ffmpeg-devel.asc']);
});
test('configuration only accepts approved immutable runtime and finite resource bounds',() => {
  const f = fake(); for (const change of [{ approvedImageId:'latest' },{ engineIdentity:'host' },{ maxConcurrent:3 },{ maxConcurrent:0 },
    { timeoutMilliseconds:120001 },{ timeoutMilliseconds:0 },{ runtime:{} }]) assert.throws(() => new IsolatedMediaDecoder({ runtime:f.runtime,approvedImageId:image,engineIdentity:engine,...change }),TypeError);
});

let db;
before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
beforeEach(async () => { await db.exec('TRUNCATE cb_decoder_jobs,cb_decoder_engines'); });
const journal = (database = db) => new DecoderJobJournal(database,{ engineIdentity:engine,approvedImageId:image });
const isolated = (runtime,store) => new IsolatedMediaDecoder({ runtime,approvedImageId:image,engineIdentity:engine,journal:store });
const expire = (run) => db.query("UPDATE cb_decoder_jobs SET lease_until = clock_timestamp()-interval '1 second' WHERE run = $1",[run]);
const rows = () => db.query('SELECT * FROM cb_decoder_jobs');
test('journal persists creation authorization and full receipt before any source exchange',async () => {
  const f = fake(),store = journal(),runtime = { ...f.runtime,
    async docker(args,options) {
      if (args[0] === 'create') { const [row] = (await rows()).rows; assert.equal(row.phase,'creating'); assert.equal(row.container_id,null); }
      return f.runtime.docker(args,options);
    },async exchange(id,...args) {
      const [row] = (await rows()).rows; assert.equal(row.phase,'attached'); assert.equal(row.container_id,id);
      return f.runtime.exchange(id,...args);
    } };
  const decoder = isolated(runtime,store); await decoder.decode(input());
  const [row] = (await rows()).rows; assert.equal(row.phase,'closed'); assert.equal(row.generation,2); assert.equal(row.requires_recovery,false);
  assert.equal(f.containers.size,0); assert.deepEqual(decoder.retainedJobs(),[]);
});
test('replacement instance restores failed cleanup from DB rather than old memory',async () => {
  const f = fake({ rmFails:true }),old = isolated(f.runtime,journal()); await assert.rejects(old.decode(input()),code('SCAN_UNAVAILABLE'));
  const [row] = (await rows()).rows; assert.equal(row.phase,'attached'); assert.equal(row.requires_recovery,true);
  const replacement = isolated(f.runtime,journal()); await assert.rejects(replacement.decode(input()),code('SCAN_UNAVAILABLE'));
  await expire(row.run); f.options.rmFails = false; await replacement.recoverRetained(); assert.equal(f.containers.size,0);
  assert.equal((await rows()).rows[0].phase,'closed'); await old.recoverRetained(); await old.decode(input());
});
test('restart recovers creating receipt by exact UUID ownership without reading any file',async () => {
  const f = fake(),store = journal(); let lease = await store.reserve(run); lease = await store.creating(lease);
  const names = decoderResourceNames(run,'job'); await f.runtime.docker(decoderContainerArguments(names,image,'job'));
  await expire(run); const replacement = isolated(f.runtime,journal()); await replacement.recoverRetained();
  assert.equal(f.containers.size,0); assert.equal(f.packets.length,0); assert.equal((await rows()).rows[0].phase,'closed');
});
test('uncertain creating receipt with no observed container remains blocked after restart',async () => {
  const f = fake(),store = journal(); await store.creating(await store.reserve(run)); await expire(run);
  const replacement = isolated(f.runtime,journal()); await assert.rejects(replacement.recoverRetained(),code('SCAN_UNAVAILABLE'));
  await assert.rejects(replacement.decode(input()),code('SCAN_UNAVAILABLE')); await assert.rejects(journal().reserve('22345678-1234-4234-8234-123456789abc'),code('SCAN_UNAVAILABLE'));
  assert.equal(f.calls.some((call) => ['create','kill','rm'].includes(call[0])),false); assert.equal((await rows()).rows[0].phase,'creating');
});
test('reserved-before-create intent can be closed after restart even when engine is unavailable',async () => {
  const f = fake(),store = journal(); await store.reserve(run); await expire(run);
  const runtime = { ...f.runtime,async identity() { throw new Error('PRIVATE ENGINE DETAIL'); } };
  await isolated(runtime,journal()).recoverRetained(); assert.equal((await rows()).rows[0].phase,'closed'); assert.equal(f.calls.length,0);
});
test('lost removal response is resolved only by acknowledged full ID absence on same engine',async () => {
  const f = fake(); let lost = true;
  const runtime = { ...f.runtime,async docker(args,options) {
    const value = await f.runtime.docker(args,options); if (args[0] === 'rm' && lost) { lost = false; throw new Error('PRIVATE ACKNOWLEDGEMENT'); } return value;
  } };
  const old = isolated(runtime,journal()); await assert.rejects(old.decode(input()),code('SCAN_UNAVAILABLE')); assert.equal(f.containers.size,0);
  const [row] = (await rows()).rows; assert.equal(row.phase,'attached'); await expire(row.run);
  const replacement = isolated(runtime,journal()); await replacement.recoverRetained(); assert.equal((await rows()).rows[0].phase,'closed');
  assert.equal(f.calls.filter((call) => call[0] === 'rm').length,1);
});
test('a fenced old coordinator cannot return a late report or delete under the new lease',async () => {
  const f = fake(),newStore = journal();
  const runtime = { ...f.runtime,async exchange(id,...args) {
    const result = await f.runtime.exchange(id,...args),[row] = (await rows()).rows; await expire(row.run); await newStore.take(row.run); return result;
  } };
  const old = isolated(runtime,journal()); await assert.rejects(old.decode(input()),code('SCAN_UNAVAILABLE'));
  assert.equal(f.calls.some((call) => call[0] === 'rm'),false); await isolated(f.runtime,newStore).recoverRetained(); assert.equal(f.containers.size,0);
});
test('lost reserve acknowledgement cannot issue a container create and recovers its unstarted intent',async () => {
  const f = fake(); let lost = true;
  const database = { async transaction(work) { const result = await db.transaction(work); if (lost) { lost = false; throw new Error('PRIVATE COMMIT'); } return result; } };
  const decoder = isolated(f.runtime,journal(database)); await assert.rejects(decoder.decode(input()),code('SCAN_UNAVAILABLE'));
  assert.equal(f.calls.some((call) => call[0] === 'create'),false); assert.equal((await rows()).rows[0].phase,'closed'); assert.deepEqual(decoder.retainedJobs(),[]);
});
test('failed or malformed exact ID listing cannot be interpreted as removed-container evidence',async () => {
  const f = fake(),store = journal(); let malformed = true;
  const runtime = { ...f.runtime,async docker(args,options) {
    if (args[0] === 'ps' && args.includes('--no-trunc') && malformed) return 'unconfirmed-short-id';
    return f.runtime.docker(args,options);
  } };
  const decoder = isolated(runtime,store); await assert.rejects(decoder.decode(input()),code('SCAN_UNAVAILABLE'));
  assert.equal(f.containers.size,1); assert.equal(f.calls.some((call) => call[0] === 'rm'),false); assert.equal((await rows()).rows[0].phase,'attached');
  malformed = false; await decoder.recoverRetained(); assert.equal(f.containers.size,0);
});
test('periodic heartbeat loss closes a stalled source and fences old cleanup',{ timeout:15000 },async () => {
  let enter; const entered = new Promise((resolve) => { enter = resolve; });
  const f = fake({ stall:true,started:enter }),currentStore = journal(),replacementStore = journal(),decoder = isolated(f.runtime,currentStore);
  const stream = new Readable({ read() {} });
  const pending = assert.rejects(decoder.decode(input({ stream })),code('SCAN_UNAVAILABLE'));
  await entered; const [row] = (await rows()).rows;
  await expire(row.run); await replacementStore.take(row.run);
  // Real 10-second periodic callback, not a fake timer or the 120-second job
  // deadline. The old owner's failed heartbeat must close its pending source.
  await pending; assert.equal(stream.destroyed,true); assert.equal(f.calls.some((call) => call[0] === 'rm'),false);
  await isolated(f.runtime,replacementStore).recoverRetained(); assert.equal(f.containers.size,0); assert.equal((await rows()).rows[0].phase,'closed');
});

// Contract doubles only. No native decoder/anti-malware proof is fabricated
// outside these tests. Real per-file validation is a separate Docker command.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { IsolatedMediaDecoder } from '../decoder-jobs.mjs';
import { LocalClamAvClient } from '../clamav-client.mjs';
import { parsePreparationJobHeader,preparationJobOutput,PREPARATION_OUTPUT_LIMIT } from '../media-preparation-protocol.mjs';
import { decoderResourceNames,DECODER_JOB_LABEL } from '../decoder-container-policy.mjs';
import { prepareImageDerivative } from '../image-metadata.mjs';
import { prepareVideoDerivative } from '../video-metadata.mjs';
import { RepositoryError } from '../errors.mjs';
export const run = '12345678-1234-4234-8234-123456789abc';
export const image = `sha256:${'a'.repeat(64)}`,engine = 'synthetic-preparation-engine-0001';
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const manifest = (bytes,type = 'image/png') => ({ type,size:bytes.length,sha256:hash(bytes) });
export const stream = (bytes) => Readable.from([bytes],{ objectMode:false });
export function reportFor(source,type = 'image/png') {
  const prepared = (type.startsWith('image/') ? prepareImageDerivative : prepareVideoDerivative)(source,type);
  const count = type.startsWith('image/') ? prepared.containerFrames : 1;
  const proof = (value) => ({ engine:'ffmpeg',engineVersion:'9.0.2',media:{ type,width:1,height:1,...(type.startsWith('video/') ? { duration:2 } : {}) },
    decodedVideoFrames:count,decodedAudioFrames:0,checkedBytes:value.size,sha256:value.sha256,mediaAcceptanceReady:false });
  const sourceManifest = manifest(source,type),derivative = manifest(prepared.bytes,type);
  return { bytes:prepared.bytes,report:{ source:sourceManifest,derivative,sourceDecode:proof(sourceManifest),derivativeDecode:proof(derivative),
    sourceTimelineSha256:'c'.repeat(64),derivativeTimelineSha256:'c'.repeat(64),metadata:type.startsWith('image/') ? {
      policyVersion:prepared.policyVersion,orientation:prepared.orientation,containerFrames:prepared.containerFrames,iccProfilePolicy:prepared.iccProfilePolicy,
    } : { policyVersion:prepared.policyVersion,containerMediaUnits:prepared.containerMediaUnits,codedPayloadSha256:prepared.codedPayloadSha256,
      displayStateSha256:prepared.displayStateSha256 },mediaAcceptanceReady:false } };
}
function container(id,names) {
  return { Id:id,Name:`/${names.worker}`,Image:image,State:{ Running:false,Status:'created',ExitCode:0,OOMKilled:false },
    Config:{ User:'node',Env:['TZ=UTC'],Labels:{ [DECODER_JOB_LABEL]:names.run },OpenStdin:true,Tty:false,
      Entrypoint:['/usr/local/bin/node'],Cmd:['/app/server/decoder-job-worker.mjs'] },
    HostConfig:{ ReadonlyRootfs:true,Privileged:false,NetworkMode:'none',PidMode:'',IpcMode:'private',UTSMode:'',
      Memory:1024**3,MemorySwap:1024**3,NanoCpus:1e9,PidsLimit:128,LogConfig:{ Type:'none' },RestartPolicy:{ Name:'no' },
      Ulimits:[{ Name:'nofile',Soft:1024,Hard:1024 }],CapDrop:['ALL'],CapAdd:null,SecurityOpt:['no-new-privileges'],
      Binds:null,VolumesFrom:null,Devices:[],DeviceRequests:[],Mounts:[],PortBindings:{},Tmpfs:{ '/tmp':'rw,noexec,nosuid,nodev,size=256m,mode=1777' } },
    Mounts:[],NetworkSettings:{ Networks:{ none:{ IPAddress:'',Gateway:'',GlobalIPv6Address:'',IPv6Gateway:'' } },Ports:{} } };
}
export function fakePreparation(options = {}) {
  const containers = new Map(),calls = []; let sequence = 0;
  const runtime = {
    async identity() { return engine; },
    async inspect(kind,id) {
      if (kind === 'image') return { Id:image,Os:'linux',Architecture:'amd64',Config:{ User:'node' } };
      const value = containers.get(id) ?? [...containers.values()].find((value) => value.Name === `/${id}`);
      if (!value) throw new Error('PRIVATE IO'); return structuredClone(value);
    },
    async docker(args) {
      calls.push(args);
      if (args[0] === 'ps') { const f = args[args.indexOf('--filter')+1]; return f.startsWith('id=') && containers.has(f.slice(3)) ? f.slice(3) : ''; }
      if (args[0] === 'create') {
        const label = args[args.indexOf('--label')+1],names = decoderResourceNames(label.split('=')[1],'job'),id = (++sequence).toString(16).padStart(64,'0');
        containers.set(id,container(id,names)); return id;
      }
      const value = containers.get(args.at(-1)); assert.ok(value);
      if (args[0] === 'kill') { value.State.Running = false; value.State.Status = 'exited'; return value.Id; }
      if (args[0] === 'rm') { if (options.rmFails) throw new Error('PRIVATE CLEANUP'); assert.equal(value.State.Running,false); containers.delete(value.Id); return value.Id; }
      throw new Error('UNEXPECTED TEST COMMAND');
    },
    async exchange(id,packet,{ signal,outputLimit }) {
      assert.equal(outputLimit,PREPARATION_OUTPUT_LIMIT); const value = containers.get(id); value.State.Running = true; value.State.Status = 'running';
      options.started?.(); const chunks = []; for await (const chunk of packet) chunks.push(chunk);
      if (options.stall) await new Promise((yes,no) => { if (signal.aborted) no(new RepositoryError('SCAN_UNAVAILABLE')); else signal.addEventListener('abort',() => no(new RepositoryError('SCAN_UNAVAILABLE')),{ once:true }); });
      const bytes = Buffer.concat(chunks),length = bytes.readUInt32BE(),header = parsePreparationJobHeader(bytes.subarray(4,length+4));
      const prepared = reportFor(bytes.subarray(length+4),header.type); options.beforeReturn?.(prepared);
      const output = preparationJobOutput(header.id,prepared.report,prepared.bytes);
      value.State.Running = false; value.State.Status = 'exited';
      return { code:0,output:options.output?.(output) ?? output };
    },
  };
  return { runtime,calls,containers,options,preparer:new IsolatedMediaDecoder({ runtime,approvedImageId:image,engineIdentity:engine,...options.config }) };
}
export async function fakeClam(options = {}) {
  const sockets = new Set(),scans = []; let databaseVersion = 28150;
  const stamp = Date.UTC(2026,9,5,0,0,0),version = () => `ClamAV 1.4.6/${databaseVersion}/Mon Oct  5 00:00:00 2026`;
  const server = createServer((socket) => {
    sockets.add(socket); socket.once('close',() => sockets.delete(socket)); socket.on('error',() => {});
    let pending = Buffer.alloc(0),command = null,count = 0; const chunks = [];
    socket.on('data',(bytes) => {
      pending = Buffer.concat([pending,bytes]);
      if (command === null) {
        const end = pending.indexOf(0); if (end < 0) return;
        command = pending.subarray(0,end).toString('ascii'); pending = pending.subarray(end+1);
        if (command === 'zPING') { socket.end('PONG\0'); return; }
        if (command === 'zVERSIONCOMMANDS') { socket.end(version()+'| COMMANDS: PING VERSION INSTREAM\0'); return; }
        if (command === 'zVERSION') { socket.end(version()+'\0'); return; }
        if (command !== 'zINSTREAM') { socket.destroy(); return; }
      }
      while (pending.length >= 4) {
        const size = pending.readUInt32BE(); if (size > 65536 || count+size > 50*1024*1024) { socket.destroy(); return; }
        if (pending.length < size+4) return;
        if (!size) {
          scans.push(Buffer.concat(chunks)); const rejected = options.rejectAt === scans.length;
          options.scanned?.(scans.length); socket.end(rejected ? 'stream: SYNTHETIC FOUND\0' : 'stream: OK\0'); return;
        }
        count += size; chunks.push(Buffer.from(pending.subarray(4,4+size))); pending = pending.subarray(size+4);
      }
    });
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const scanner = new LocalClamAvClient({ endpoint:{ host:'127.0.0.1',port:server.address().port },approvedEngineVersions:['1.4.6'],daemonTimeZone:'UTC',now:() => stamp+1000 });
  return { scanner,scans,changeDatabase() { databaseVersion++; },async close() { for (const socket of sockets) socket.destroy(); server.close(); await once(server,'close'); } };
}

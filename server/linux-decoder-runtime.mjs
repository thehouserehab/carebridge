import { createHash } from 'node:crypto';
import { open,lstat,realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { posix } from 'node:path';
import { decoderCliTransport } from './decoder-cli-transport.mjs';
import { decoderContainerArguments,decoderResourceNames,decoderReceipt,assertDecoderOwner,assertDecoderIsolation,DECODER_JOB_LABEL } from './decoder-container-policy.mjs';
import { RepositoryError } from './errors.mjs';

const unavailable = () => new RepositoryError('SCAN_UNAVAILABLE');
const fullId = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const equal = (a,b) => Array.isArray(a) && a.length === b.length && a.every((value,index) => value === b[index]);
const nameRun = (name) => {
  if (typeof name !== 'string' || !/^carebridge-decode-job-[a-f0-9]{32}$/.test(name)) throw unavailable();
  const hex = name.slice(-32),run = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  try { if (decoderResourceNames(run,'job').worker !== name) throw unavailable(); } catch { throw unavailable(); } return run;
};
export function linuxDecoderConfiguration(value) {
  const keys = ['cliPath','cliSha256','socketPath','socketOwnerUid','engineIdentity','approvedImageId'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(value,key)) ||
      !['/usr/local/bin/docker','/usr/bin/docker','/opt/carebridge/bin/docker'].includes(value.cliPath) ||
      typeof value.cliSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.cliSha256) ||
      !['/run/docker.sock','/run/carebridge-engine/docker.sock'].includes(value.socketPath) ||
      !Number.isSafeInteger(value.socketOwnerUid) || value.socketOwnerUid < 0 || value.socketOwnerUid > 2147483647 ||
      typeof value.engineIdentity !== 'string' || !/^[a-zA-Z0-9:_-]{12,80}$/.test(value.engineIdentity) ||
      typeof value.approvedImageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.approvedImageId))
    throw new TypeError('Explicit approved local Linux worker configuration is required.');
  return Object.freeze({ ...value });
}
export function linuxDecoderCommand(args,image) {
  if (!Array.isArray(args) || !args.every((value) => typeof value === 'string') || !/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw unavailable();
  if (equal(args,['info','--format','{{json .}}'])) return 'identity';
  if (equal(args,['image','inspect',image])) return 'image';
  if (args.length === 3 && args[0] === 'container' && args[1] === 'inspect') {
    if (!fullId(args[2])) nameRun(args[2]); return 'container';
  }
  if (args[0] === 'create') {
    const label = args[args.indexOf('--label')+1];
    if (typeof label !== 'string' || !label.startsWith(`${DECODER_JOB_LABEL}=`)) throw unavailable();
    let names; try { names = decoderResourceNames(label.slice(DECODER_JOB_LABEL.length+1),'job'); } catch { throw unavailable(); }
    if (!equal(args,decoderContainerArguments(names,image,'job'))) throw unavailable(); return 'create';
  }
  if (args.length === 6 && equal(args.slice(0,3),['ps','--all','--filter']) && equal(args.slice(4),['--format','{{.ID}}'])) {
    if (!args[3].startsWith('name=^/') || !args[3].endsWith('$')) throw unavailable(); nameRun(args[3].slice(7,-1)); return 'names';
  }
  if (args.length === 7 && equal(args.slice(0,4),['ps','--all','--no-trunc','--filter']) &&
      /^id=[a-f0-9]{64}$/.test(args[4]) && equal(args.slice(5),['--format','{{.ID}}'])) return 'ids';
  if (args.length === 4 && equal(args.slice(0,3),['kill','--signal','KILL']) && fullId(args[3])) return 'kill';
  if (args.length === 2 && args[0] === 'rm' && fullId(args[1])) return 'remove';
  if (args.length === 4 && equal(args.slice(0,3),['start','--attach','--interactive']) && fullId(args[3])) return 'exchange';
  throw unavailable(); // No build/pull/exec/copy/logs/prune/image/volume/network operations.
}

// Trusted worker-service adapter. Never import or instantiate in a web/API
// process. The engine socket is powerful even when its mount is read-only;
// deployment MUST place this service on a dedicated controlled worker host.
export async function linuxDecoderRuntime(configuration) {
  const config = linuxDecoderConfiguration(configuration);
  if (process.platform !== 'linux') throw unavailable();
  const environment = Object.freeze({ PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/nonexistent',DOCKER_CONFIG:'/nonexistent',LANG:'C.UTF-8',TZ:'UTC' });
  let approvedFile,approvedSocket;
  async function parentCheck(path) {
    for (let parent = posix.dirname(path); parent !== '/'; parent = posix.dirname(parent)) {
      const value = await lstat(parent);
      if (!value.isDirectory() || value.uid !== 0 || value.mode & 0o022) throw unavailable();
    }
  }
  async function trustedPaths(initial = false) {
    try {
      if (await realpath(config.cliPath) !== config.cliPath || await realpath(config.socketPath) !== config.socketPath) throw unavailable();
      await parentCheck(config.cliPath); await parentCheck(config.socketPath);
      const file = await lstat(config.cliPath),socket = await lstat(config.socketPath);
      if (!file.isFile() || file.uid !== 0 || file.mode & 0o022 || !(file.mode & 0o111) || file.size < 1 || file.size > 64*1024*1024 ||
          !socket.isSocket() || socket.uid !== config.socketOwnerUid || socket.mode & 0o002) throw unavailable();
      const signature = (entry) => `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeMs}:${entry.mode}:${entry.uid}:${entry.gid}`;
      if (initial) {
        const handle = await open(config.cliPath,constants.O_RDONLY|constants.O_NOFOLLOW);
        try {
          if (signature(await handle.stat()) !== signature(file)) throw unavailable();
          const digest = createHash('sha256');
          for await (const bytes of handle.createReadStream({ autoClose:false })) digest.update(bytes);
          if (digest.digest('hex') !== config.cliSha256 || signature(await handle.stat()) !== signature(file)) throw unavailable();
        } finally { await handle.close(); }
        approvedFile = signature(file); approvedSocket = signature(socket);
      } else if (approvedFile !== signature(file) || approvedSocket !== signature(socket)) throw unavailable();
    } catch { throw unavailable(); }
  }
  await trustedPaths(true);
  const transport = decoderCliTransport(async (args) => {
    linuxDecoderCommand(args,config.approvedImageId); await trustedPaths();
    return { file:config.cliPath,args:['--host',`unix://${config.socketPath}`,...args],environment };
  });
  const json = (output) => { try { return JSON.parse(output); } catch { throw unavailable(); } };
  async function identity() {
    const value = json(await transport.command(['info','--format','{{json .}}']));
    if (value.ID !== config.engineIdentity || value.OSType !== 'linux' || value.Architecture !== 'x86_64') throw unavailable();
    return value.ID;
  }
  async function inspect(kind,id) {
    const values = json(await transport.command([kind,'inspect',id]));
    if (!Array.isArray(values) || values.length !== 1) throw unavailable(); return values[0];
  }
  async function owner(id,isolation = false) {
    try {
      const value = await inspect('container',id),receipt = decoderReceipt(id,value.Config?.Labels?.[DECODER_JOB_LABEL],'job');
      assertDecoderOwner(value,receipt,config.approvedImageId); if (isolation) assertDecoderIsolation(value,receipt,config.approvedImageId);
      return value;
    } catch { throw unavailable(); }
  }
  async function docker(args,options) {
    const purpose = linuxDecoderCommand(args,config.approvedImageId);
    if (['identity','image','container','exchange'].includes(purpose)) throw unavailable();
    await identity();
    if (purpose === 'kill' || purpose === 'remove') await owner(args.at(-1));
    return transport.command(args,options);
  }
  async function exchange(id,packet,options) {
    if (!fullId(id)) throw unavailable();
    await identity(); const value = await owner(id,true);
    if (value.State.Status !== 'created') throw unavailable();
    return transport.exchange(['start','--attach','--interactive',id],packet,options);
  }
  await identity();
  const image = await inspect('image',config.approvedImageId);
  if (image.Id !== config.approvedImageId || image.Os !== 'linux' || image.Architecture !== 'amd64' || image.Config?.User !== 'node' ||
      Object.keys(image.Config.Volumes ?? {}).length || Object.keys(image.Config.ExposedPorts ?? {}).length) throw unavailable();
  return Object.freeze({ identity,inspect,docker,exchange });
}

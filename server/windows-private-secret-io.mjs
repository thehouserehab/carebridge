// Shared bounded IO only. Cryptographic purposes, envelopes, native providers
// and error contracts stay in the two purpose-specific stores. No HTTP/export.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { win32 } from 'node:path';
import { TextDecoder } from 'node:util';
import { beginWindowsDatabaseStage } from './windows-database-observation.mjs';

const LIMIT = 16384;
const fail = () => { throw new Error('WINDOWS_PRIVATE_SECRET_UNAVAILABLE'); };
const sameFile = (a,b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
export function privateSecretWindowsPath(value, drive) {
  if (typeof value !== 'string' || !/^[a-z]:[\\/][^\x00-\x1f\x7f]+$/i.test(value) ||
      /[:*?"<>|]/.test(value.slice(2)) || (drive && value[0].toUpperCase() !== drive) ||
      value.slice(3).split(/[\\/]/).some((part) => !part || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) fail();
  return value[0].toUpperCase() + win32.resolve(value).slice(1);
}
export function privateSecretEnvironment(environment, powershell) {
  const result = {};
  for (const name of ['SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA']) {
    const entry = Object.keys(environment).find((key) => key.toUpperCase() === name);
    if (entry !== undefined) result[name] = environment[entry];
  }
  if (typeof result.SYSTEMROOT !== 'string') fail();
  const systemRoot = privateSecretWindowsPath(result.SYSTEMROOT);
  result.PATH = `${win32.dirname(privateSecretWindowsPath(powershell))};${win32.join(systemRoot,'System32')};${systemRoot}`;
  return result;
}
export function encodePrivateSecretFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 2 || payload.length > LIMIT) { payload.fill(0); fail(); }
  const header = Buffer.alloc(4); header.writeUInt32BE(payload.length);
  const frame = Buffer.concat([header,payload]); payload.fill(0); return frame;
}
export function decodePrivateSecretFrame(frame) {
  try {
    if (!Buffer.isBuffer(frame) || frame.length < 6 || frame.length > LIMIT + 4 || frame.readUInt32BE(0) !== frame.length - 4) fail();
    const json = new TextDecoder('utf-8',{fatal:true}).decode(frame.subarray(4)), value = JSON.parse(json);
    if (JSON.stringify(value) !== json || !value || Array.isArray(value) || typeof value !== 'object') fail();
    return value;
  } catch { fail(); }
}
export async function invokeWindowsSecretProvider(options, request, provider, validate) {
  const input = encodePrivateSecretFrame(request), chunks = []; let size = 0, invalid = false;
  try {
    return await new Promise((resolve,reject) => {
      const child = spawn(options.powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',provider],{
        shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],
        env:privateSecretEnvironment(process.env,options.powershell),cwd:win32.dirname(provider),
      });
      const timer = setTimeout(() => { invalid = true; child.kill(); },20000);
      child.on('error',() => { invalid = true; }); child.stdin.on('error',() => { invalid = true; });
      child.stdout.on('data',(bytes) => {
        size += bytes.length;
        if (size > LIMIT + 4) { invalid = true; bytes.fill(0); child.kill(); }
        else chunks.push(bytes);
      });
      child.stderr.on('data',(bytes) => { invalid = true; bytes.fill(0); child.kill(); });
      child.on('close',(code) => {
        clearTimeout(timer); let frame;
        try {
          if (invalid || code !== 0) fail();
          frame = Buffer.concat(chunks); resolve(validate(decodePrivateSecretFrame(frame)));
        } catch { reject(new Error('WINDOWS_PRIVATE_SECRET_UNAVAILABLE')); }
        finally { frame?.fill(0); for (const chunk of chunks) chunk.fill(0); }
      });
      child.stdin.end(input);
    });
  } catch { fail(); }
  finally { input.fill(0); for (const chunk of chunks) chunk.fill(0); }
}
async function directoryChain(directory) {
  for (let part = directory;; part = win32.dirname(part)) {
    const info = await lstat(part);
    if (!info.isDirectory() || info.isSymbolicLink()) fail();
    if (win32.dirname(part) === part) break;
  }
  if ((await realpath(directory)).toLowerCase() !== directory.toLowerCase()) fail();
}
async function regularPrivateFile(path, maximum = LIMIT) {
  const info = await lstat(path,{bigint:true});
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size < 2n || info.size > BigInt(maximum)) fail();
  return info;
}
async function directoryReceipts(options, receiptName) {
  await directoryChain(options.root);
  await regularPrivateFile(win32.join(options.privateRoot,'.carebridge-storage-owner.json'),8192);
  await regularPrivateFile(win32.join(options.root,receiptName),8192);
}
function envelopePath(options,id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) fail();
  return win32.join(options.root,`${id}.dpapi`);
}
export async function persistPrivateEnvelope(options,id,envelope,receiptName,check) {
  let handle, encoded;
  try {
    await directoryReceipts(options,receiptName);
    encoded = Buffer.from(JSON.stringify(envelope)); if (encoded.length > LIMIT) fail();
    const path = envelopePath(options,id);
    handle = await open(path,constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),0o600);
    let offset = 0;
    while (offset < encoded.length) {
      const {bytesWritten} = await handle.write(encoded,offset,encoded.length-offset);
      if (!bytesWritten) fail(); offset += bytesWritten;
    }
    await handle.sync(); const initial = await handle.stat({bigint:true});
    if (!sameFile(initial,await regularPrivateFile(path))) fail();
    await check();
    if (!sameFile(initial,await handle.stat({bigint:true})) || !sameFile(initial,await regularPrivateFile(path))) fail();
  } finally {
    encoded?.fill(0); await handle?.close().catch(() => {});
    // Never erase/reset possibly committed ciphertext after uncertain IO.
  }
}
export async function readPrivateEnvelope(options,id,receiptName,consume,{onStage} = {}) {
  let handle, bytes, result;
  const finishRead=beginWindowsDatabaseStage(onStage,'credential-read');let finishRecheck;
  try {
    await directoryReceipts(options,receiptName);
    const path = envelopePath(options,id), observed = await regularPrivateFile(path);
    handle = await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const initial = await handle.stat({bigint:true}); if (!sameFile(observed,initial)) fail();
    bytes = Buffer.alloc(Number(initial.size)); let offset = 0;
    while (offset < bytes.length) {
      const {bytesRead} = await handle.read(bytes,offset,bytes.length-offset,offset);
      if (!bytesRead) fail(); offset += bytesRead;
    }
    const json = new TextDecoder('utf-8',{fatal:true}).decode(bytes), envelope = JSON.parse(json);
    if (JSON.stringify(envelope) !== json) fail();
    finishRead('complete');
    result = await consume(envelope);
    finishRecheck=beginWindowsDatabaseStage(onStage,'credential-recheck');
    if (!sameFile(initial,await handle.stat({bigint:true})) || !sameFile(initial,await regularPrivateFile(path))) fail();
    finishRecheck('complete');
    return result;
  } catch { finishRead('failed');finishRecheck?.('failed');if (Buffer.isBuffer(result)) result.fill(0); fail(); }
  finally { bytes?.fill(0); await handle?.close().catch(() => {}); }
}

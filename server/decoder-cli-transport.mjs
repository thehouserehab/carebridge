import { spawn } from 'node:child_process';
import { Readable,Transform } from 'node:stream';
import { pipeline,finished } from 'node:stream/promises';
import { MEDIA_LIMITS } from '../src/media-policy.js';
import { JOB_HEADER_LIMIT,JOB_OUTPUT_LIMIT } from './decoder-job-protocol.mjs';
import { RepositoryError } from './errors.mjs';
import { PREPARATION_OUTPUT_LIMIT } from './media-preparation-policy.mjs';

const unavailable = () => new RepositoryError('SCAN_UNAVAILABLE');
const privateError = (error) => error instanceof RepositoryError && error.code === 'SCAN_INVALID' ? new RepositoryError('SCAN_INVALID') : unavailable();
// Internal pipe primitive. The launch callback MUST be trusted configuration
// that pins executable, endpoint, command allowlist and a minimal environment.
// It is not a general launcher, HTTP handler, or user-configurable transport.
export function decoderCliTransport(launch) {
  if (typeof launch !== 'function') throw new TypeError('A trusted launch policy is required.');
  async function childFor(args,interactive) {
    const target = await launch(args);
    if (!target || typeof target.file !== 'string' || !Array.isArray(target.args) || !target.environment ||
        !target.args.every((value) => typeof value === 'string')) throw unavailable();
    return spawn(target.file,target.args,{ env:target.environment,shell:false,windowsHide:true,
      stdio:[interactive ? 'pipe' : 'ignore','pipe','pipe'] });
  }
  async function command(args,{ timeout = 15000 } = {}) {
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 15000) throw unavailable();
    let child; try { child = await childFor(args,false); } catch { throw unavailable(); }
    return new Promise((resolve,reject) => {
      let problem = false,size = 0; const chunks = [];
      const stop = () => { problem = true; child.kill('SIGKILL'); };
      const timer = setTimeout(stop,timeout);
      child.stdout.on('data',(bytes) => {
        size += bytes.length; if (size > 1024*1024) stop(); else if (!problem) chunks.push(bytes);
      });
      child.stdout.on('error',stop); child.stderr.on('error',stop); child.stderr.resume();
      child.once('error',stop);
      child.once('close',(code) => {
        clearTimeout(timer);
        if (problem || code !== 0) { reject(unavailable()); return; }
        try { resolve(new TextDecoder('utf-8',{ fatal:true }).decode(Buffer.concat(chunks)).trim()); }
        catch { reject(unavailable()); }
      });
    });
  }
  async function exchange(args,packet,{ signal,outputLimit,onFailure } = {}) {
    if (!(packet instanceof Readable) || packet.destroyed || packet.readableObjectMode || packet.readableEncoding ||
        !(signal instanceof AbortSignal) || ![JOB_OUTPUT_LIMIT,PREPARATION_OUTPUT_LIMIT].includes(outputLimit) ||
        onFailure !== undefined && typeof onFailure !== 'function') throw unavailable();
    void finished(packet,{ cleanup:true }).catch(() => {});
    if (signal.aborted) { packet.destroy(); throw unavailable(); }
    let child;
    try { child = await childFor(args,true); } catch { packet.destroy(); throw unavailable(); }
    let problem = null,outputBytes = 0,inputBytes = 0; const chunks = [];
    const stop = (error) => {
      if (problem) return;
      problem = privateError(error);
      try { onFailure?.(); } catch { /* The pipe must stop even if a callback fails. */ }
      packet.destroy(problem); child.stdin.destroy(); child.kill('SIGKILL');
    };
    const abort = () => stop(unavailable()),timer = setTimeout(abort,120000);
    const bounded = new Transform({ transform(bytes,encoding,callback) {
      inputBytes += bytes.length;
      callback(inputBytes > MEDIA_LIMITS.video+JOB_HEADER_LIMIT+4 ? unavailable() : null,bytes);
    } });
    signal.addEventListener('abort',abort,{ once:true });
    child.stdout.on('data',(bytes) => {
      outputBytes += bytes.length; if (outputBytes > outputLimit) abort(); else if (!problem) chunks.push(bytes);
    });
    child.stdout.on('error',abort); child.stderr.on('error',abort); child.stderr.on('data',abort); child.once('error',abort);
    const closed = new Promise((resolve) => child.once('close',(code) => resolve(code)));
    const writing = pipeline(packet,bounded,child.stdin).catch(stop);
    if (signal.aborted) abort();
    try {
      const code = await closed; await writing;
      if (problem || signal.aborted || !Number.isSafeInteger(code) || code < 0 || code > 255) throw problem ?? unavailable();
      let output; try { const bytes = Buffer.concat(chunks); output = outputLimit === PREPARATION_OUTPUT_LIMIT ? bytes : new TextDecoder('utf-8',{ fatal:true }).decode(bytes).trim(); } catch { throw unavailable(); }
      // A nonzero worker exit is only evidence when the coordinator separately
      // corroborates actual container state and the exact bounded protocol.
      return { code,output };
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort',abort);
      for (const bytes of chunks) bytes.fill(0); // hygiene, not secure erasure
    }
  }
  return Object.freeze({ command,exchange });
}

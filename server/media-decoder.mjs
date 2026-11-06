import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp,open,unlink,rmdir,lstat,realpath,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { MEDIA_TYPES,MEDIA_LIMITS } from '../src/media-policy.js';
import { RepositoryError,fail } from './errors.mjs';
import { DECODER_VERSION,PROBE_PATH,DECODE_LIMITS,decoderArguments,decodedMediaReport } from './media-decoder-policy.mjs';
import { validateMediaContainer } from './media-container-validation.mjs';

const unavailable = () => new RepositoryError('SCAN_UNAVAILABLE');
function inputValid(file) {
  if (!file || Object.keys(file).some((key) => !['stream','type','size','sha256'].includes(key)) ||
      !(file.stream instanceof Readable) || file.stream.readableObjectMode || file.stream.readableEncoding ||
      file.stream.destroyed || file.stream.readableEnded || !MEDIA_TYPES.includes(file.type) ||
      !Number.isSafeInteger(file.size) || file.size < 1 ||
      file.size > (file.type.startsWith('image/') ? MEDIA_LIMITS.image : MEDIA_LIMITS.video) ||
      typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('SCAN_INVALID');
}
function runProbe(args,signal,fd = null,limit = DECODE_LIMITS.outputBytes) {
  if (signal.aborted) return Promise.reject(unavailable());
  return new Promise((resolve,reject) => {
    const child = spawn(PROBE_PATH,args,{ shell:false,
      env:{ PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',TZ:'UTC' },
      stdio:['ignore','pipe','pipe',...(fd === null ? [] : [fd])] });
    let size = 0,problem = null; const chunks = [];
    const stop = (error) => { problem ??= error; child.kill('SIGKILL'); };
    const abort = () => stop(unavailable());
    signal.addEventListener('abort',abort,{ once:true });
    child.stdout.on('data',(bytes) => {
      size += bytes.length;
      if (size > limit) stop(unavailable()); else if (!problem) chunks.push(bytes);
    });
    // Warning/error output may include private metadata. Never keep/forward
    // it. A truncated/partial decode is never a successful report.
    child.stderr.on('data',() => stop(fd === null ? unavailable() : new RepositoryError('SCAN_INVALID')));
    child.once('error',() => { problem = unavailable(); });
    child.once('close',(code,termination) => {
      signal.removeEventListener('abort',abort);
      if (problem || signal.aborted || termination || code !== 0) reject(problem ?? unavailable());
      else resolve(Buffer.concat(chunks,size).toString('utf8'));
    });
    if (signal.aborted) abort();
  });
}

// Decode-only building block, NOT a MediaUploads scanner (no inspect/verdict).
// Must be invoked inside a separately enforced per-job offline Linux sandbox.
// This declaration cannot attest network/cgroup/mount or host isolation itself.
export class LinuxMediaDecoder {
  #digest; #timeout; #active = false;
  constructor({ approvedBinarySha256,timeoutMilliseconds = 90000 } = {}) {
    if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() === 0)
      throw new TypeError('A non-root Linux decoding worker is required.');
    if (typeof approvedBinarySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(approvedBinarySha256) ||
        !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 50 || timeoutMilliseconds > 120000)
      throw new TypeError('Approved decoder binary and bounded duration are required.');
    this.#digest = approvedBinarySha256; this.#timeout = timeoutMilliseconds;
  }
  async #engine(signal) {
    const info = await lstat(PROBE_PATH);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) ||
        await realpath(PROBE_PATH) !== PROBE_PATH || info.size > 64*1024*1024) throw unavailable();
    const digest = createHash('sha256').update(await readFile(PROBE_PATH)).digest('hex');
    if (digest !== this.#digest) throw unavailable();
    const output = await runProbe(['-hide_banner','-v','error','-version'],signal,null,64*1024);
    if (!output.split('\n')[0].startsWith(`ffprobe version ${DECODER_VERSION} Copyright `)) throw unavailable();
    return { engine:'ffmpeg',engineVersion:DECODER_VERSION };
  }
  async decode(file,{ signal,timelineEvidence = false } = {}) {
    const stream = file?.stream instanceof Readable ? file.stream : null;
    const capture = () => {}; stream?.on('error',capture);
    let controller,timer,deadline,dir,path,writable,reader,ownsSlot = false,createdFile = false,registeredSignal = false,report,problem;
    const abort = () => controller?.abort();
    const closeInput = () => stream?.destroy(unavailable());
    try {
      inputValid(file);
      if (typeof timelineEvidence !== 'boolean') fail('SCAN_INVALID');
      if (this.#active || signal !== undefined && !(signal instanceof AbortSignal)) throw unavailable();
      this.#active = true; ownsSlot = true; controller = new AbortController();
      deadline = performance.now()+this.#timeout;
      const checkpoint = () => { if (controller.signal.aborted || performance.now() >= deadline) { abort(); throw unavailable(); } };
      signal?.addEventListener('abort',abort,{ once:true });
      registeredSignal = signal !== undefined;
      controller.signal.addEventListener('abort',closeInput,{ once:true });
      timer = setTimeout(abort,this.#timeout); if (signal?.aborted) abort();
      const engine = await this.#engine(controller.signal);
      if (controller.signal.aborted || stream.errored) throw unavailable();
      dir = await mkdtemp('/tmp/carebridge-decode-');
      const directory = await lstat(dir);
      if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077) || await realpath(dir) !== dir) throw unavailable();
      path = `${dir}/input.bin`;
      writable = await open(path,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
      createdFile = true;
      const digest = createHash('sha256'); let count = 0;
      for await (const chunk of stream) {
        if (!(chunk instanceof Uint8Array) || count+chunk.byteLength > file.size) fail('SCAN_INVALID');
        for (let at = 0; at < chunk.byteLength; at += 65536) {
          if (controller.signal.aborted) throw unavailable();
          const bytes = Buffer.from(chunk.subarray(at,Math.min(at+65536,chunk.byteLength)));
          digest.update(bytes); count += bytes.length;
          let written = 0;
          while (written < bytes.length) {
            const result = await writable.write(bytes,written,bytes.length-written);
            if (!result.bytesWritten) throw unavailable(); written += result.bytesWritten;
          }
        }
      }
      if (count !== file.size || digest.digest('hex') !== file.sha256) fail('SCAN_INVALID');
      await writable.close(); writable = undefined;
      reader = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await reader.stat(); if (!info.isFile() || info.size !== file.size || info.uid !== process.getuid()) throw unavailable();
      const bytes = Buffer.alloc(file.size); let read = 0,expectedFrames;
      try {
        // Explicit positions preserve the shared fd offset at 0 for ffprobe.
        while (read < bytes.length) {
          const result = await reader.read(bytes,read,bytes.length-read,read);
          if (!result.bytesRead || controller.signal.aborted) throw unavailable(); read += result.bytesRead;
        }
        if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) fail('SCAN_INVALID');
        expectedFrames = validateMediaContainer(bytes,file.type,{ checkpoint });
        checkpoint(); // Never launch native work after an overdue sync check.
      } finally { bytes.fill(0); } // Hygiene, not proof of secure memory erasure.
      // No path remains for a decoder to reopen, replace or access another job.
      // The inherited fd is read-only and seekable, including moov-at-end MP4.
      await unlink(path); createdFile = false; path = undefined; await rmdir(dir); dir = undefined;
      const output = await runProbe(decoderArguments(file.type),controller.signal,reader.fd);
      let document; try { document = JSON.parse(output); } catch { throw unavailable(); }
      const decoded = decodedMediaReport(document,file.type,expectedFrames,{ timelineEvidence });
      const after = await this.#engine(controller.signal);
      if (JSON.stringify(engine) !== JSON.stringify(after) || controller.signal.aborted) throw unavailable();
      report = { ...engine,...decoded,checkedBytes:file.size,sha256:file.sha256,mediaAcceptanceReady:false };
    } catch (error) {
      problem = error instanceof RepositoryError ? error : unavailable();
    } finally {
      clearTimeout(timer); if (registeredSignal) signal.removeEventListener('abort',abort);
      controller?.signal.removeEventListener('abort',closeInput); stream?.destroy();
      for (const handle of [writable,reader]) try { await handle?.close(); } catch { problem = unavailable(); }
      try { if (createdFile && path) await unlink(path); } catch { problem = unavailable(); }
      try { if (dir) await rmdir(dir); } catch { problem = unavailable(); } // No recursive deletion, never success after failure.
      if (stream?.closed) stream.removeListener('error',capture);
      else stream?.once('close',() => stream.removeListener('error',capture));
      if (ownsSlot) this.#active = false;
    }
    if (problem) throw problem; return report;
  }
}

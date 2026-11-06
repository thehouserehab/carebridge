import { randomUUID,createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { LocalClamAvClient } from './clamav-client.mjs';
import { IsolatedMediaDecoder } from './decoder-jobs.mjs';
import { decoderJobManifest,decoderJobSource } from './decoder-job-protocol.mjs';
import { validatePreparationReport } from './media-preparation-protocol.mjs';
import { RepositoryError,fail } from './errors.mjs';
import { scanEvidence,sameScanEngine } from './media-preparation-evidence.mjs';
import { captureMediaWorkerObserver,observeMediaStage } from './media-worker-observation.mjs';
const exact = (value,keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value,key));
const unavailable = () => new RepositoryError('SCAN_UNAVAILABLE');
function observe(stream) { if (stream instanceof Readable) void finished(stream,{ cleanup:true }).catch(() => {}); }
async function openSource(open,manifest,signal) {
  signal.throwIfAborted(); let cancelled = false,listener;
  const pending = Promise.resolve().then(() => open({ signal }));
  void pending.then((stream) => { observe(stream); if (cancelled) stream?.destroy?.(); },() => {});
  const aborted = new Promise((yes,no) => { listener = () => { cancelled = true; no(unavailable()); }; signal.addEventListener('abort',listener,{ once:true }); });
  let stream;
  try {
    if (signal.aborted) listener(); stream = await Promise.race([pending,aborted]);
    signal.throwIfAborted(); decoderJobSource({ stream,...manifest }); return stream;
  } catch (error) { cancelled = true; stream?.destroy?.(); throw error; }
  finally { signal.removeEventListener('abort',listener); }
}

// Trusted orchestration service ONLY, not a scanner.inspect or HTTP handler.
// MediaUploads can explicitly inject it through its preparation option.
// Source factories are server-owned private reads, never request code.
// A prepared candidate is still unpersisted/unapproved and cannot be served.
export class MediaPreparation {
  #scanner; #preparer; #timeout; #limit; #onStage; #active = 0;
  constructor({ scanner,preparer,timeoutMilliseconds = 240000,maxConcurrent = 2,onStage = null } = {}) {
    if (!(scanner instanceof LocalClamAvClient) || !(preparer instanceof IsolatedMediaDecoder) ||
        !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 50 || timeoutMilliseconds > 360000 ||
        !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2)
      throw new TypeError('Explicit local anti-malware and isolated preparation services with bounded limits are required.');
    this.#scanner = scanner; this.#preparer = preparer; this.#timeout = timeoutMilliseconds; this.#limit = maxConcurrent;
    this.#onStage = captureMediaWorkerObserver(onStage);
  }
  async prepare(file,{ signal } = {}) {
    let controller,timer,stream,candidate,result,ownsSlot = false,registered = false;
    const abort = () => { controller?.abort(); stream?.destroy(unavailable()); };
    try {
      if (!exact(file,['type','size','sha256','openSource']) || typeof file.openSource !== 'function') fail('SCAN_INVALID');
      const manifest = decoderJobManifest({ type:file.type,size:file.size,sha256:file.sha256 });
      if (signal !== undefined && !(signal instanceof AbortSignal) || signal?.aborted || this.#active >= this.#limit) throw unavailable();
      this.#active += 1; ownsSlot = true; controller = new AbortController(); timer = setTimeout(abort,this.#timeout);
      if (signal) { signal.addEventListener('abort',abort,{ once:true }); registered = true; if (signal.aborted) abort(); }
      const check = () => { if (controller.signal.aborted) throw unavailable(); };
      stream = await observeMediaStage(this.#onStage,'source-open',() => openSource(file.openSource,manifest,controller.signal));
      const sourceScan = await observeMediaStage(this.#onStage,'source-scan',async () => {
        const scan = scanEvidence(await this.#scanner.scan({ ...manifest,stream },{ signal:controller.signal }),manifest); check(); return scan;
      });
      if (sourceScan.verdict === 'rejected') {
        result = { status:'rejected',stage:'source',source:manifest,sourceScan,mediaAcceptanceReady:false }; return result;
      }
      stream = await observeMediaStage(this.#onStage,'source-reopen',() => openSource(file.openSource,manifest,controller.signal));
      const prepared = await observeMediaStage(this.#onStage,'isolated-preparation',() => this.#preparer.prepare({ ...manifest,stream },{ signal:controller.signal })); candidate = prepared?.bytes; check();
      const preparation = await observeMediaStage(this.#onStage,'candidate-validation',() => {
        const report = validatePreparationReport(prepared?.report,randomUUID(),manifest);
        if (!Buffer.isBuffer(candidate) || candidate.length !== report.derivative.size ||
            createHash('sha256').update(candidate).digest('hex') !== report.derivative.sha256) throw unavailable();
        return report;
      });
      // The isolated coordinator independently validated these bytes; the
      // scanner verifies the same candidate manifest and EOF once again.
      stream = Readable.from([candidate],{ objectMode:false }); observe(stream);
      const derivativeScan = await observeMediaStage(this.#onStage,'candidate-scan',async () => {
        const scan = scanEvidence(await this.#scanner.scan({ ...preparation.derivative,stream },{ signal:controller.signal }),preparation.derivative); check();
        if (!sameScanEngine(sourceScan,scan)) throw unavailable(); return scan;
      });
      if (derivativeScan.verdict === 'rejected') {
        result = { status:'rejected',stage:'derivative',source:manifest,sourceScan,derivativeScan,mediaAcceptanceReady:false }; return result;
      }
      result = { status:'prepared',bytes:candidate,report:{ source:manifest,derivative:preparation.derivative,
        sourceScan,derivativeScan,preparation,mediaAcceptanceReady:false },mediaAcceptanceReady:false };
      return result;
    } catch (error) {
      fail(error instanceof RepositoryError && error.code === 'SCAN_INVALID' ? 'SCAN_INVALID' : 'SCAN_UNAVAILABLE');
    } finally {
      clearTimeout(timer); if (registered) signal.removeEventListener('abort',abort);
      stream?.destroy(); if (result?.status !== 'prepared') candidate?.fill(0);
      // No early Promise.race around engine work: a slot stays occupied until
      // the isolated coordinator has proven termination/cleanup or latched it.
      if (ownsSlot) this.#active -= 1;
    }
  }
  async recoverRetained() {
    if (this.#active) throw unavailable();
    try { await this.#preparer.recoverRetained(); } catch { throw unavailable(); }
  }
  hasDurableJournal() { return this.#preparer.hasDurableJournal(); }
}

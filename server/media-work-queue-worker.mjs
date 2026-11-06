import { setTimeout as wait } from 'node:timers/promises';
import { MediaUploads } from './media-uploads.mjs';
import { MediaPreparation } from './media-preparation.mjs';
import { RepositoryError } from './errors.mjs';
import { captureMediaWorkerObserver,observeMediaStage } from './media-worker-observation.mjs';
const unavailable = () => new RepositoryError('MEDIA_WORKER_UNAVAILABLE');
function validSignal(signal) { if (signal !== undefined && !(signal instanceof AbortSignal)) throw unavailable(); }
// Only a checkpoint with no outstanding preparation/settlement is a clean
// interruption. An unrelated error coinciding with abort is still a failure.
class Interrupted extends Error {}
const now = () => new Date().toISOString();

// Explicit trusted background service. Construction does not start a loop,
// read .env, log file/user data, issue HTTP requests or create infrastructure.
// A separate process needs its own pipeline + shared DecoderJobJournal.
export class MediaWorkQueueWorker {
  #uploads; #interval; #onStage; #busy = false; #loop = false;
  #status = { state:'new',phase:null,completedPolls:0,processed:0,lastOutcome:null,
    cleanupFailures:0,startedAt:null,lastPollCompletedAt:null,stoppedAt:null,failureCode:null };
  constructor(uploads,{ pollMilliseconds = 1000,localTestMode = false,onStage = null } = {}) {
    if (!(uploads instanceof MediaUploads) || !(uploads.preparation instanceof MediaPreparation) ||
        typeof localTestMode !== 'boolean' || !localTestMode && !uploads.preparation.hasDurableJournal() ||
        !Number.isSafeInteger(pollMilliseconds) || pollMilliseconds < 50 || pollMilliseconds > 60000)
      throw new TypeError('Configured uploads, a durable decoder journal and bounded polling are required; synthetic tests must be explicit.');
    this.#uploads = uploads; this.#interval = pollMilliseconds;
    this.#onStage = captureMediaWorkerObserver(onStage);
  }
  // Process-local observation only: not a durable heartbeat, fleet health,
  // operating approval or a promise that pending work will be delivered.
  get status() { return Object.freeze({ ...this.#status,loopRunning:this.#loop,inFlight:this.#busy }); }
  #begin() {
    this.#status.state = 'running'; this.#status.phase = null; this.#status.failureCode = null;
    this.#status.startedAt ??= now(); this.#status.stoppedAt = null;
  }
  #stop() { this.#status.state = 'stopped'; this.#status.phase = null; this.#status.stoppedAt = now(); }
  #fail() { this.#status.state = 'failed'; this.#status.failureCode = 'MEDIA_WORKER_UNAVAILABLE'; this.#status.stoppedAt = now(); }
  #observeAbort(signal) {
    const abort = () => { this.#status.state = 'stopping'; };
    signal?.addEventListener('abort',abort,{ once:true });
    if (signal?.aborted) abort();
    return () => signal?.removeEventListener('abort',abort);
  }
  async #poll(signal) {
    this.#busy = true;
    try {
      // Resolve retained namespaces BEFORE consuming another upload attempt.
      // An uncertain create/cleanup stays latched and blocks this poll.
      this.#status.phase = 'recovering'; await observeMediaStage(this.#onStage,'retained-recovery',() => this.#uploads.preparation.recoverRetained());
      if (signal?.aborted) throw new Interrupted();
      this.#status.phase = 'cleanup';
      const cleanup = await observeMediaStage(this.#onStage,'object-cleanup',() => this.#uploads.cleanup()); this.#status.cleanupFailures = cleanup.failed;
      if (signal?.aborted) throw new Interrupted();
      this.#status.phase = 'inspection'; let result,failed = false;
      try { result = await this.#uploads.inspectNext({ signal }); } catch { failed = true; }
      // A cancelled/quarantined upload is not proof that the decoder namespace
      // was removed. Verify retained work AFTER the awaited settlement too.
      this.#status.phase = 'verification'; await observeMediaStage(this.#onStage,'retained-recovery',() => this.#uploads.preparation.recoverRetained());
      if (failed) { this.#status.phase = 'inspection'; throw unavailable(); }
      this.#status.completedPolls++; this.#status.lastPollCompletedAt = now();
      if (result.status === 'processed') {
        this.#status.processed++; this.#status.lastOutcome = result.upload.state;
      }
      this.#status.phase = 'idle'; return result;
    }
    finally { this.#busy = false; }
  }
  async runOne({ signal } = {}) {
    validSignal(signal); if (this.#busy || this.#loop || signal?.aborted) throw unavailable();
    this.#begin(); const unobserve = this.#observeAbort(signal);
    try { const result = await this.#poll(signal); this.#stop(); return result; }
    catch (error) { if (error instanceof Interrupted) this.#stop(); else this.#fail(); throw unavailable(); }
    finally { unobserve(); }
  }
  async start({ signal } = {}) {
    validSignal(signal); if (!signal || this.#loop || this.#busy) throw unavailable();
    this.#loop = true; this.#begin(); const unobserve = this.#observeAbort(signal); let processed = 0;
    try {
      while (!signal.aborted) {
        const result = await this.#poll(signal);
        if (result.status === 'processed') processed++;
        else try { await wait(this.#interval,undefined,{ signal }); }
        catch (error) { if (!signal.aborted || error?.code !== 'ABORT_ERR') throw error; }
      }
      this.#stop(); return { stopped:true,processed };
    } catch (error) {
      if (error instanceof Interrupted) { this.#stop(); return { stopped:true,processed }; }
      this.#fail(); throw unavailable();
    } finally { unobserve(); this.#loop = false; }
  }
}

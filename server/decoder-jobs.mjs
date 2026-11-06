import { randomUUID,createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { RepositoryError,fail } from './errors.mjs';
import { decoderJobSource,decoderJobHeader,decoderJobReport,JOB_OUTPUT_LIMIT } from './decoder-job-protocol.mjs';
import { decoderResourceNames,decoderReceipt,decoderContainerArguments,assertDecoderOwner,assertDecoderIsolation } from './decoder-container-policy.mjs';
import { DecoderJobJournal } from './decoder-journal.mjs';
import { preparationJobHeader,preparationJobReport,PREPARATION_OUTPUT_LIMIT } from './media-preparation-protocol.mjs';

const unavailable = () => new RepositoryError('SCAN_UNAVAILABLE');
// Internal worker-service component, NOT an HTTP handler or upload inspector.
// The runtime is an operator-owned local engine adapter, never a request value.
// Do not give the application/web service access to the container engine.
// journal:null preserves explicit synthetic/local tests only. It has no global
// limit or restart persistence and must not be treated as an operating service.
export class IsolatedMediaDecoder {
  #runtime; #image; #engine; #limit; #timeout; #journal; #active = 0; #retained = new Map();
  constructor({ runtime,approvedImageId,engineIdentity,maxConcurrent = 2,timeoutMilliseconds = 120000,journal = null } = {}) {
    if (!['docker','inspect','exchange','identity'].every((key) => typeof runtime?.[key] === 'function') ||
        !/^sha256:[a-f0-9]{64}$/.test(approvedImageId ?? '') || !/^[a-zA-Z0-9:_-]{12,80}$/.test(engineIdentity ?? '') ||
        !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2 ||
        !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 50 || timeoutMilliseconds > 120000 ||
        journal !== null && (!(journal instanceof DecoderJobJournal) || !journal.matches(engineIdentity,approvedImageId,maxConcurrent)))
      throw new TypeError('An approved local worker runtime, immutable image and bounded job configuration are required.');
    this.#runtime = Object.freeze(Object.fromEntries(['docker','inspect','exchange','identity'].map((key) => [key,runtime[key].bind(runtime)])));
    this.#image = approvedImageId; this.#engine = engineIdentity; this.#limit = maxConcurrent; this.#timeout = timeoutMilliseconds; this.#journal = journal;
  }
  retainedJobs() { return [...this.#retained.values()].map(({ names,receipt }) => Object.freeze({ run:names.run,name:names.worker,id:receipt?.id ?? null })); }
  hasDurableJournal() { return this.#journal instanceof DecoderJobJournal; }
  async #engineCheck() { if (await this.#runtime.identity() !== this.#engine) throw unavailable(); }
  async #cleanup(intent) {
    if (this.#journal) {
      if (!(await this.#journal.lookup(intent.names.run))) {
        if (intent.createAttempted || intent.receipt) throw unavailable();
        this.#retained.delete(intent.names.run); return;
      }
      intent.lease = await this.#journal.take(intent.names.run);
      if (intent.lease.phase === 'closed' || intent.lease.phase === 'reserved') {
        if (intent.lease.phase === 'reserved') await this.#journal.close(intent.lease);
        this.#retained.delete(intent.names.run); return;
      }
      if (intent.lease.containerId) intent.receipt = decoderReceipt(intent.lease.containerId,intent.names.run,'job');
    }
    await this.#engineCheck();
    if (this.#journal && intent.lease.phase === 'attached') {
      // Known, acknowledged full IDs cannot be recreated by a delayed start.
      // A successful exact-ID listing on the SAME engine can resolve a lost
      // removal acknowledgement. Failed inspection is NOT absence evidence.
      const found = (await this.#runtime.docker(['ps','--all','--no-trunc','--filter',`id=${intent.receipt.id}`,'--format','{{.ID}}'])).trim();
      await this.#engineCheck();
      if (!found) {
        await this.#journal.close(intent.lease); this.#retained.delete(intent.names.run); return;
      }
      if (found !== intent.receipt.id) throw unavailable();
    }
    if (!intent.receipt) {
      const state = await this.#runtime.inspect('container',intent.names.worker);
      intent.receipt = decoderReceipt(state.Id,intent.names.run,'job'); assertDecoderOwner(state,intent.receipt,this.#image);
    }
    const receipt = intent.receipt, deadline = Date.now()+15000;
    let state = await this.#runtime.inspect('container',receipt.id); assertDecoderOwner(state,receipt,this.#image);
    // A creating receipt becomes attached only after independent ownership
    // verification. A missing unknown create remains unresolved, never closed.
    if (this.#journal) intent.lease = await this.#journal.attach(intent.lease,receipt.id);
    if (state.State.Running) {
      await this.#engineCheck();
      try { await this.#runtime.docker(['kill','--signal','KILL',receipt.id],{ timeout:5000 }); }
      catch {
        // The worker can finish between inspection and kill. A failed kill
        // acknowledgement is not success, nor proof of a live process. Only
        // independently confirmed terminal state of this exact owned ID on
        // the same engine may resolve the race. Uncertain/live stays latched.
        await this.#engineCheck(); state = await this.#runtime.inspect('container',receipt.id); assertDecoderOwner(state,receipt,this.#image);
        if (state.State.Running || !['exited','dead'].includes(state.State.Status)) throw unavailable();
      }
    }
    while (state.State.Running && Date.now() < deadline) {
      await delay(20); state = await this.#runtime.inspect('container',receipt.id); assertDecoderOwner(state,receipt,this.#image);
    }
    if (state.State.Running || !['created','exited','dead'].includes(state.State.Status)) throw unavailable();
    await this.#engineCheck();
    await this.#runtime.docker(['rm',receipt.id],{ timeout:5000 }); // No force, volume/image removal or guessed target.
    if (this.#journal) await this.#journal.close(intent.lease);
    this.#retained.delete(intent.names.run);
  }
  async recoverRetained() {
    // Operator-only recovery. An unconfirmed create with no discoverable
    // container remains latched; absence alone cannot prove the request ended.
    if (this.#active) throw unavailable();
    if (this.#journal) for (const lease of await this.#journal.recoverable()) {
      if (!this.#retained.has(lease.run)) this.#retained.set(lease.run,{ names:decoderResourceNames(lease.run,'job'),receipt:null,active:false,createAttempted:lease.phase !== 'reserved' });
    }
    for (const intent of [...this.#retained.values()]) try { await this.#cleanup(intent); } catch { throw unavailable(); }
  }
  async decode(file,options = {}) { return this.#job(file,options,false); }
  async prepare(file,options = {}) { return this.#job(file,options,true); }
  async #job(file,{ signal } = {},preparation) {
    const source = file?.stream instanceof Readable ? file.stream : null,capture = () => {};
    // destroyed/closed may be true before a queued error event is emitted.
    // Keep observation until actual end/error/close, including unread sources
    // stopped by a lost lease. Never expose their private IO diagnostics.
    if (source) void finished(source,{ cleanup:true }).catch(() => {});
    let intent,controller,timer,heartbeatTimer,heartbeat,packet,report,problem,transportOutput,ownsSlot = false,registered = false,verifiedInput = false;
    const abort = () => { controller?.abort(); source?.destroy(unavailable()); packet?.destroy(unavailable()); };
    try {
      const manifest = decoderJobSource(file);
      if (signal !== undefined && !(signal instanceof AbortSignal) || this.#active >= this.#limit ||
          [...this.#retained.values()].some((job) => !job.active)) throw unavailable();
      this.#active += 1; ownsSlot = true; controller = new AbortController(); timer = setTimeout(abort,this.#timeout);
      if (signal) { signal.addEventListener('abort',abort,{ once:true }); registered = true; if (signal.aborted) abort(); }
      const check = () => { if (controller.signal.aborted) throw unavailable(); };
      await this.#engineCheck(); check();
      const image = await this.#runtime.inspect('image',this.#image);
      if (image.Id !== this.#image || image.Os !== 'linux' || image.Architecture !== 'amd64' || image.Config?.User !== 'node' ||
          Object.keys(image.Config.Volumes ?? {}).length || Object.keys(image.Config.ExposedPorts ?? {}).length) throw unavailable();
      const names = decoderResourceNames(randomUUID(),'job');
      if ((await this.#runtime.docker(['ps','--all','--filter',`name=^/${names.worker}$`,'--format','{{.ID}}'])).trim()) throw unavailable();
      check(); intent = { names,receipt:null,active:true,createAttempted:false }; this.#retained.set(names.run,intent);
      if (this.#journal) {
        intent.lease = await this.#journal.reserve(names.run); check();
        intent.lease = await this.#journal.creating(intent.lease); check();
        heartbeatTimer = setInterval(() => {
          if (heartbeat) return;
          heartbeat = this.#journal.heartbeat(intent.lease).catch(abort).finally(() => { heartbeat = null; });
        },10000);
      }
      // Exactly one create attempt per persisted run. Never retry a possibly
      // issued create on observation timeout or lost response.
      intent.createAttempted = true;
      const id = await this.#runtime.docker(decoderContainerArguments(names,this.#image,'job'),{ timeout:15000 });
      intent.receipt = decoderReceipt(id,names.run,'job');
      const created = await this.#runtime.inspect('container',id); assertDecoderIsolation(created,intent.receipt,this.#image);
      if (created.State.Status !== 'created') throw unavailable(); check();
      if (this.#journal) { intent.lease = await this.#journal.attach(intent.lease,id); check(); }
      packet = Readable.from((async function* () {
        yield (preparation ? preparationJobHeader : decoderJobHeader)(names.run,manifest);
        let size = 0; const digest = createHash('sha256');
        try {
          for await (const chunk of source) {
            if (!(chunk instanceof Uint8Array) || size+chunk.length > manifest.size) fail('SCAN_INVALID');
            for (let at = 0; at < chunk.length; at += 65536) {
              check(); const bytes = Buffer.from(chunk.subarray(at,Math.min(at+65536,chunk.length))); size += bytes.length; digest.update(bytes); yield bytes;
            }
          }
          if (size !== manifest.size || digest.digest('hex') !== manifest.sha256) fail('SCAN_INVALID');
          verifiedInput = true;
        } catch (error) { throw error instanceof RepositoryError ? error : unavailable(); }
      })(),{ objectMode:false });
      packet.on('error',capture);
      await this.#engineCheck(); check();
      const result = await this.#runtime.exchange(id,packet,{ signal:controller.signal,outputLimit:preparation ? PREPARATION_OUTPUT_LIMIT : JOB_OUTPUT_LIMIT,onFailure:abort });
      transportOutput = result.output;
      check(); if (!verifiedInput) throw unavailable(); await this.#engineCheck();
      if (this.#journal) { await this.#journal.heartbeat(intent.lease); check(); }
      const state = await this.#runtime.inspect('container',id); assertDecoderIsolation(state,intent.receipt,this.#image);
      // Docker attach may propagate the worker's nonzero exit. Only a
      // corroborated terminal worker state and exact protocol error are usable;
      // transport failure must still never turn into a successful report.
      if (!Number.isSafeInteger(result.code) || result.code !== 0 && result.code !== state.State.ExitCode ||
          state.State.Status !== 'exited' || state.State.OOMKilled) throw unavailable();
      report = (preparation ? preparationJobReport : decoderJobReport)(result.output,names.run,manifest,state.State.ExitCode);
    } catch (error) {
      problem = error instanceof RepositoryError && ['SCAN_INVALID','SCAN_UNAVAILABLE'].includes(error.code) ? error : unavailable();
    } finally {
      clearTimeout(timer); clearInterval(heartbeatTimer); if (heartbeat) await heartbeat;
      if (controller?.signal.aborted && !problem) problem = unavailable();
      if (registered) signal.removeEventListener('abort',abort);
      source?.destroy(); packet?.destroy();
      if (intent) try { await this.#cleanup(intent); } catch { intent.active = false; problem = unavailable(); } // Never return success after failed cleanup.
      if (preparation) { if (Buffer.isBuffer(transportOutput)) transportOutput.fill(0); if (problem) report?.bytes?.fill(0); }
      if (ownsSlot) this.#active -= 1;
    }
    if (problem) throw problem; return report;
  }
}

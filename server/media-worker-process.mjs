import { MediaWorkQueueWorker } from './media-work-queue-worker.mjs';
import { RepositoryError } from './errors.mjs';
const unavailable = () => new RepositoryError('MEDIA_WORKER_UNAVAILABLE');
const signals = ['SIGTERM','SIGINT'];
const activeTargets = new WeakSet();

// Opt-in composition for a dedicated trusted process, not an auto-start CLI.
// The caller owns startup validation, credentials and the DB/store lifetimes.
// Never call process.exit(), race a drain against a timer, or restart a fault.
export async function withMediaWorkerProcessLifetime(work,options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some((key) => !['targetProcess','signal'].includes(key))) throw unavailable();
  const {targetProcess = process,signal} = options;
  if (typeof work !== 'function' || signal !== undefined && !(signal instanceof AbortSignal) || !targetProcess ||
      typeof targetProcess.on !== 'function' || typeof targetProcess.removeListener !== 'function' ||
      typeof targetProcess.listenerCount !== 'function' || activeTargets.has(targetProcess) ||
      signals.some((name) => targetProcess.listenerCount(name))) throw unavailable();
  const controller = new AbortController(),registered = [];
  const stop = () => controller.abort(); activeTargets.add(targetProcess);
  try {
    signal?.addEventListener('abort',stop,{once:true});
    if (signal?.aborted) stop();
    for (const signal of signals) { targetProcess.on(signal,stop); registered.push(signal); }
    return await work(controller.signal);
  } catch {
    if (targetProcess.exitCode === undefined || targetProcess.exitCode === null || targetProcess.exitCode === 0) targetProcess.exitCode = 1;
    throw unavailable();
  } finally {
    for (const signal of registered) targetProcess.removeListener(signal,stop);
    signal?.removeEventListener('abort',stop);
    activeTargets.delete(targetProcess);
  }
}

export async function runMediaWorkerProcess(worker,options = {}) {
  if (!(worker instanceof MediaWorkQueueWorker) || worker.status.loopRunning || worker.status.inFlight) throw unavailable();
  return withMediaWorkerProcessLifetime((signal) => worker.start({signal}),options);
}

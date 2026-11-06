import {databaseForService} from './database-privileges.mjs';
import {DecoderJobJournal} from './decoder-journal.mjs';
import {IsolatedMediaDecoder} from './decoder-jobs.mjs';
import {LocalClamAvClient} from './clamav-client.mjs';
import {MediaPreparation} from './media-preparation.mjs';
import {MediaUploads} from './media-uploads.mjs';
import {PrivateFileStore} from './private-file-store.mjs';
import {MediaWorkQueueWorker} from './media-work-queue-worker.mjs';
import {RepositoryError} from './errors.mjs';
import {captureMediaWorkerObserver,observeMediaStage} from './media-worker-observation.mjs';
const unavailable = () => new RepositoryError('MEDIA_WORKER_UNAVAILABLE');

// Explicit internal composition only. No env/credentials, infrastructure,
// signals, loops or native engine calls on import/construction. No synthetic
// bypass, caller-selected preparation/journal or fallback to the app role.
// The trusted caller owns the raw DB pool, store ACLs and runtime adapter.
export function prepareMediaWorkerService(options) {
  try {
    const required = ['database','privileges','store','scanner','runtime','engineIdentity','approvedImageId'];
    const allowed = [...required,'capacity','pollMilliseconds','onStage'];
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        required.some((key) => !Object.hasOwn(options,key)) || Object.keys(options).some((key) => !allowed.includes(key))) throw unavailable();
    // Capture all dependencies/options before the first await. Concrete
    // adapters remain trusted process-owned objects, not request input.
    const {database,privileges,store,scanner,runtime,engineIdentity,approvedImageId,capacity = 2,pollMilliseconds = 1000,onStage:observer} = options;
    const onStage = captureMediaWorkerObserver(observer);
    if (!(store instanceof PrivateFileStore) || !(scanner instanceof LocalClamAvClient)) throw unavailable();
    const guarded = databaseForService(database,privileges,'worker');
    const journal = new DecoderJobJournal(guarded,{engineIdentity,approvedImageId,capacity});
    const preparer = new IsolatedMediaDecoder({runtime,engineIdentity,approvedImageId,maxConcurrent:capacity,journal});
    const preparation = new MediaPreparation({scanner,preparer,maxConcurrent:capacity,onStage});
    const worker = new MediaWorkQueueWorker(new MediaUploads(guarded,store,{preparation,onStage}),{pollMilliseconds,onStage});
    // Read-only startup admission. Later transactions repeat the same policy
    // checks; startup never claims a job, initializes a store or scans a file.
    return Object.freeze({worker,admit:() => observeMediaStage(onStage,'worker-admission',() => guarded.transaction(async () => {}))});
  } catch { throw unavailable(); }
}

// Two-phase preparation lets an owned process validate/capture its complete
// worker before opening credentials. The late-bound internal DB port must be
// populated before admission; neither phase starts a loop or claims an upload.
export async function createMediaWorkerService(options) {
  try {
    const prepared = prepareMediaWorkerService(options);
    await prepared.admit();
    return prepared.worker;
  } catch { throw unavailable(); }
}

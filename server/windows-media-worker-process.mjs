// Explicit trusted process composition. Not a CLI, Windows SCM adapter,
// account provisioner, native-engine installer, supervisor or API endpoint.
import {windowsDatabaseServiceOptions,openWindowsDatabaseService} from './windows-database-service.mjs';
import {prepareMediaWorkerService} from './media-worker-service.mjs';
import {withMediaWorkerProcessLifetime} from './media-worker-process.mjs';
import {RepositoryError} from './errors.mjs';
import {captureMediaWorkerObserver,observeMediaStage} from './media-worker-observation.mjs';
const unavailable = () => new RepositoryError('MEDIA_WORKER_UNAVAILABLE');
const exact = (value,keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value,key));

export async function runWindowsMediaWorkerProcess(input,processOptions = {}) {
  let database;
  try {
    if (!exact(input,['database','media']) || !exact(input.database,['storage','credentialId','privileges','endpoint']) ||
        !input.media || typeof input.media !== 'object' || Array.isArray(input.media) ||
        Object.keys(input.media).some((key) => !['store','scanner','runtime','engineIdentity','approvedImageId','capacity','pollMilliseconds','onStage','onDatabaseStage'].includes(key))) throw unavailable();
    // Validate and snapshot before the first await. No caller can select the
    // owner/app role, pool/store provider, fallback, prebuilt worker or bypass.
    const parsed = windowsDatabaseServiceOptions({...input.database,kind:'worker'});
    const media = {...input.media},onStage = captureMediaWorkerObserver(media.onStage);
    const onDatabaseStage=captureMediaWorkerObserver(media.onDatabaseStage);
    delete media.onDatabaseStage; // DB startup observations are not media approval.
    const endpoint = Object.freeze({host:parsed.connection.host,port:parsed.connection.port,
      ...(parsed.connection.ssl === false ? {transport:'synthetic-loopback'} :
        parsed.connection.ssl.ca === undefined ? {} : {ca:parsed.connection.ssl.ca})});
    const connection = Object.freeze({storage:parsed.storage,credentialId:parsed.credentialId,
      privileges:parsed.privileges,kind:'worker',endpoint});
    const port = Object.freeze({transaction:(work) => {
      if (!database) throw unavailable();
      return database.transaction(work);
    }});
    const prepared = prepareMediaWorkerService({...media,onStage,database:port,privileges:parsed.privileges});
    return await withMediaWorkerProcessLifetime(async (signal) => {
      if (signal.aborted) return Object.freeze({stopped:true,processed:0});
      try {
        let observingStartup=true;
        try {
          database = await observeMediaStage(onStage,'db-open',() => openWindowsDatabaseService(connection,
            onDatabaseStage?{onStage:event=>{if(observingStartup)return onDatabaseStage(event);}}:undefined));
        } finally {observingStartup=false;}
        // A stop during DPAPI/DB startup waits for that owned operation, then
        // closes it without admitting/starting a queue poll or native engine.
        if (signal.aborted) return Object.freeze({stopped:true,processed:0});
        await prepared.admit();
        return Object.freeze(await prepared.worker.start({signal}));
      } finally {
        // Listener/target ownership remains held through drain and pool close.
        // Never race close against a timer, force exit, retry or erase a fault.
        if (database) await observeMediaStage(onStage,'db-close',() => database.close());
      }
    },processOptions);
  } catch {throw unavailable();}
}

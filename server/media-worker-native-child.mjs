// Explicit synthetic native process test only. Real PG and private file IO;
// preparation is a controlled gate, NEVER claimed as native AV/decoder proof.
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve,relative,isAbsolute } from 'node:path';
import { databaseFromPool } from './database.mjs';
import { quotedTestDatabase } from './postgres-test-harness.mjs';
import { MediaUploads } from './media-uploads.mjs';
import { PrivateFileStore } from './private-file-store.mjs';
import { MediaPreparation } from './media-preparation.mjs';
import { LocalClamAvClient } from './clamav-client.mjs';
import { IsolatedMediaDecoder } from './decoder-jobs.mjs';
import { MediaWorkQueueWorker } from './media-work-queue-worker.mjs';
import { runMediaWorkerProcess } from './media-worker-process.mjs';
const release = Promise.withResolvers(); let db,worker,timer,observe;
const notify = (state) => process.send?.({ state,...(worker ? { status:worker.status } : {}) });
class HeldSyntheticPreparation extends MediaPreparation {
  constructor() {
    const forbidden = async () => { throw new Error('SYNTHETIC_TEST_NO_ENGINE'); };
    super({ scanner:new LocalClamAvClient({ endpoint:{ host:'127.0.0.1',port:65535 },approvedEngineVersions:['1.4.6'],daemonTimeZone:'UTC' }),
      preparer:new IsolatedMediaDecoder({ runtime:{ identity:forbidden,inspect:forbidden,docker:forbidden,exchange:forbidden },
        approvedImageId:`sha256:${'a'.repeat(64)}`,engineIdentity:'synthetic-lifecycle-engine-0001' }) });
  }
  async recoverRetained() {} // Declared synthetic gate: no native namespace.
  async prepare(file,{ signal } = {}) {
    const stream = await file.openSource({ signal }),chunks = [];
    try {
      for await (const chunk of stream) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('TEST_SOURCE');
      notify('preparing'); await release.promise; signal.throwIfAborted(); throw new Error('TEST_REQUIRES_ABORT');
    } finally { stream.destroy(); for (const chunk of chunks) chunk.fill(0); }
  }
}
process.on('message',(message) => { if (message?.state === 'release') release.resolve(); });
process.once('message',async (message) => {
  try {
    if (process.platform !== 'linux' || process.env.CAREBRIDGE_WORKER_TEST_CHILD !== 'synthetic-only' || !process.send ||
        Object.keys(message ?? {}).sort().join(',') !== 'config,database,mode,root' || !['idle','held'].includes(message.mode)) throw new Error('TEST_SCOPE');
    quotedTestDatabase(message.database);
    const root = resolve(message.root),rel = relative(resolve(tmpdir()),root);
    if (isAbsolute(rel) || !/^carebridge-worker-native-[A-Za-z0-9]{6}$/.test(rel)) throw new Error('TEST_ROOT');
    db = databaseFromPool(new Pool({ ...message.config,database:message.database,max:1 }));
    worker = new MediaWorkQueueWorker(new MediaUploads(db,new PrivateFileStore(root),{ preparation:new HeldSyntheticPreparation(),
      leaseMilliseconds:4000,operationTimeoutMilliseconds:3000 }),{ localTestMode:true,pollMilliseconds:50 });
    const pending = runMediaWorkerProcess(worker);
    // Observe AFTER the runner's own stop listener has updated its state.
    observe = () => notify('stopping'); process.on('SIGTERM',observe); process.on('SIGINT',observe);
    if (message.mode === 'idle') timer = setInterval(() => {
      if (worker.status.phase === 'idle') { clearInterval(timer); notify('idle'); }
    },5);
    notify('started'); await pending; notify('stopped');
  } catch {
    process.exitCode = 1; notify('failed');
  } finally {
    clearInterval(timer); if (observe) { process.removeListener('SIGTERM',observe); process.removeListener('SIGINT',observe); }
    try { await db?.close(); } catch { process.exitCode = 1; }
    process.disconnect?.(); // Natural exit only, after the awaited pool close.
  }
});

// Synthetic native test child ONLY. No scanner, file input, API or operating DB.
import { Pool } from 'pg';
import { databaseFromPool } from './database.mjs';
import { MediaUploads } from './media-uploads.mjs';
import { quotedTestDatabase } from './postgres-test-harness.mjs';
let db;
const noIO = { async write() { throw new Error('NO_TEST_FILE_IO'); },async openVerified() { throw new Error('NO_TEST_FILE_IO'); },async remove() { throw new Error('NO_TEST_FILE_IO'); } };
process.once('message',async (message) => {
  try {
    if (process.platform !== 'linux' || process.env.CAREBRIDGE_QUEUE_TEST_CHILD !== 'synthetic-only' ||
        !process.send || !message || Object.keys(message).sort().join(',') !== 'config,database') throw new Error('TEST_SCOPE');
    quotedTestDatabase(message.database);
    db = databaseFromPool(new Pool({ ...message.config,database:message.database,max:1 }));
    const claim = await new MediaUploads(db,noIO,{ leaseMilliseconds:1500,operationTimeoutMilliseconds:1000 }).claimNextInspection();
    if (!claim) throw new Error('TEST_CLAIM');
    // Never serialize the claim, user IDs, object keys or DB credentials.
    process.send({ state:'claimed' });
    // Deliberately held until this exact test-owned child is SIGKILLed.
    setInterval(() => {},1000);
  } catch {
    process.send?.({ state:'failed' }); await db?.close(); process.exitCode = 1; process.disconnect?.();
  }
});

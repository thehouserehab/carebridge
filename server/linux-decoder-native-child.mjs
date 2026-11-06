import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { DecoderJobJournal } from './decoder-journal.mjs';
import { IsolatedMediaDecoder } from './decoder-jobs.mjs';
import { testDatabase,testRuntime,syntheticInput } from './linux-decoder-test-fixtures.mjs';
// Deliberately killed child of the explicit synthetic integration controller.
// No input files/accounts, socket configuration or database URLs from callers.
let db;
try {
  if (process.env.CAREBRIDGE_LINUX_TEST_CHILD !== 'crash-after-attached' || process.platform !== 'linux') throw new Error('CONFIGURATION');
  db = testDatabase(process.env.CAREBRIDGE_LINUX_TEST_DATABASE);
  const runtime = await testRuntime(),journal = new DecoderJobJournal(db,{ engineIdentity:process.env.CAREBRIDGE_LINUX_TEST_ENGINE,approvedImageId:process.env.CAREBRIDGE_LINUX_TEST_IMAGE });
  const observed = { ...runtime,async exchange(id,packet,options) {
    const pending = runtime.exchange(id,packet,options),settled = pending.then((value) => ({ value }),(error) => ({ error }));
    const deadline = Date.now()+15000; let running = false;
    while (Date.now() < deadline) { if ((await runtime.inspect('container',id)).State.Running) { running = true; break; } await delay(50); }
    if (!running) throw new Error('NOT_RUNNING');
    const { rows } = await db.transaction((tx) => tx.query("SELECT run,container_id FROM cb_decoder_jobs WHERE phase = 'attached' AND container_id = $1",[id]));
    if (rows.length !== 1) throw new Error('NOT_ATTACHED');
    console.log(JSON.stringify({ run:rows[0].run,id:rows[0].container_id }));
    const result = await settled; if (result.error) throw result.error; return result.value;
  } };
  await new IsolatedMediaDecoder({ runtime:observed,approvedImageId:process.env.CAREBRIDGE_LINUX_TEST_IMAGE,
    engineIdentity:process.env.CAREBRIDGE_LINUX_TEST_ENGINE,journal }).decode(syntheticInput(undefined,{ stream:new Readable({ read() {} }) }));
  throw new Error('NOT_KILLED');
} catch { console.error('LINUX_DECODER_TEST_CHILD_FAILED'); process.exitCode = 1; }
finally { await db?.close(); }

// Actual SIGTERM/SIGINT, real PG and synthetic bytes on private Linux tmpfs.
// No native AV/decoder, power-loss, operating disk or production supervisor claim.
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { mkdtemp,rm,readFile,lstat,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,relative,isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { syntheticPng } from './image-metadata-test-fixtures.mjs';
import { PrivateFileStore } from './private-file-store.mjs';
import { MediaUploads } from './media-uploads.mjs';
const bytes = syntheticPng(),file = { name:'synthetic-process.png',type:'image/png',size:bytes.length,
  sha256:createHash('sha256').update(bytes).digest('hex') };
export function addMediaWorkerNativeCases(check,databaseA,databaseB,fixture,{ config,databaseName }) {
  const ownedChildren = new Map();
  const query = (sql,args) => databaseB.transaction((tx) => tx.query(sql,args));
  const rowFor = async (id) => (await query('SELECT * FROM cb_media_uploads WHERE id = $1',[id])).rows[0];
  const jobFor = async (id) => (await query('SELECT * FROM cb_media_work_queue WHERE upload_id = $1',[id])).rows[0];
  async function withRoot(work) {
    const root = await mkdtemp(join(tmpdir(),'carebridge-worker-native-'));
    try { await work(root); }
    finally {
      // An observation timeout is not terminal evidence. Preserve this exact
      // test root if any child could still be reading/writing it.
      if ((ownedChildren.get(root) ?? []).some((child) => !child.terminal)) throw new Error('SYNTHETIC_STORAGE_RETAINED');
      const rel = relative(resolve(tmpdir()),resolve(root));
      assert(!isAbsolute(rel) && /^carebridge-worker-native-[A-Za-z0-9]{6}$/.test(rel));
      assert.equal((await lstat(root)).isSymbolicLink(),false); assert.equal(await realpath(root),resolve(root));
      await rm(root,{ recursive:true,force:true });
      ownedChildren.delete(root);
    }
  }
  async function stage(root,label) {
    const f = await fixture(label),service = new MediaUploads(databaseA,new PrivateFileStore(root));
    const row = await service.reserve(f.guardian,{ conversationId:f.roomId,clientId:randomUUID(),file });
    const received = await service.receive(f.guardian,{ conversationId:f.roomId,uploadId:row.id,expectedVersion:row.version },Readable.from([bytes],{ objectMode:false }));
    return { f,service,row:received };
  }
  function childFor(root,mode) {
    const notices = [],closed = Promise.withResolvers(); let terminal,fault;
    const child = fork(new URL('./media-worker-native-child.mjs',import.meta.url),[],{
      env:{ CAREBRIDGE_WORKER_TEST_CHILD:'synthetic-only' },stdio:['ignore','pipe','pipe','ipc'] });
    child.stdout.resume(); child.stderr.resume(); child.on('error',() => { fault = true; });
    child.once('close',(code,signal) => { terminal = { code,signal }; closed.resolve(terminal); });
    child.on('message',(message) => { if (notices.length < 20) notices.push(message); else fault = true; });
    child.send({ config,database:databaseName,root,mode });
    async function boundedClose() {
      const controller = new AbortController(),timeout = Symbol();
      try {
        const result = await Promise.race([closed.promise,delay(6000,timeout,{ signal:controller.signal })]);
        if (result === timeout) throw new Error('SYNTHETIC_CHILD_TIMEOUT'); return result;
      } finally { controller.abort(); }
    }
    const owned = {
      child,get terminal() { return terminal; },
      async notice(state) {
        const deadline = Date.now()+6000;
        while (true) {
          const message = notices.find((value) => value?.state === state); if (message) return message;
          if (fault || terminal || Date.now() > deadline) throw new Error('SYNTHETIC_CHILD_STATE'); await delay(10);
        }
      },
      closed:boundedClose,
      async cleanup() {
        if (!terminal) {
          try { if (child.connected) child.send({ state:'release' }); } catch { /* Still await authoritative terminal evidence. */ }
          child.kill('SIGTERM');
          try { await boundedClose(); } catch {
            // Only this exact child created here, never a PID from input.
            child.kill('SIGKILL'); await boundedClose(); throw new Error('SYNTHETIC_CHILD_FORCED_CLEANUP');
          }
        }
      },
    };
    ownedChildren.set(root,[...(ownedChildren.get(root) ?? []),owned]); return owned;
  }
  check('actual idle worker SIGINT drains and exits zero without a file attempt',async () => withRoot(async (root) => {
    const child = childFor(root,'idle');
    try {
      const idle = await child.notice('idle'); assert.equal(idle.status.inFlight,false); assert.equal(idle.status.processed,0);
      assert.equal(child.child.kill('SIGINT'),true); const stopped = await child.notice('stopped');
      assert.equal(stopped.status.state,'stopped'); assert.equal(stopped.status.loopRunning,false);
      assert.deepEqual(await child.closed(),{ code:0,signal:null });
    } finally { await child.cleanup(); }
  }));
  check('actual active worker SIGTERM waits for settlement and preserves retryable source bytes',async () => withRoot(async (root) => {
    const staged = await stage(root,'workerdrain'),child = childFor(root,'held');
    try {
      const entered = await child.notice('preparing'); assert.equal(entered.status.inFlight,true);
      assert.equal(child.child.kill('SIGTERM'),true); const stopping = await child.notice('stopping');
      assert.equal(stopping.status.state,'stopping'); await delay(40); assert.equal(child.terminal,undefined);
      assert.equal((await rowFor(staged.row.id)).state,'inspecting'); assert.equal((await jobFor(staged.row.id)).state,'running');
      child.child.send({ state:'release' }); const stopped = await child.notice('stopped');
      assert.equal(stopped.status.lastOutcome,'quarantined'); assert.equal(stopped.status.completedPolls,1);
      assert.deepEqual(await child.closed(),{ code:0,signal:null });
      const row = await rowFor(staged.row.id); assert.equal(row.state,'quarantined'); assert.equal((await jobFor(row.id)).state,'retry');
      assert.deepEqual(await readFile(join(root,`${row.object_key}.blob`)),bytes);
      await staged.service.cancel(staged.f.guardian,{ conversationId:staged.f.roomId,uploadId:row.id,expectedVersion:row.version });
      await staged.service.cleanup();
    } finally { await child.cleanup(); }
  }));
  check('actual active stop with settlement fault exits nonzero and a new instance fences its expired lease',async () => withRoot(async (root) => {
    const staged = await stage(root,'workerfault'),child = childFor(root,'held'); let trigger = false,claimed;
    try {
      await child.notice('preparing'); claimed = await rowFor(staged.row.id);
      await databaseA.transaction((tx) => tx.exec(`CREATE FUNCTION cb_native_worker_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.state = 'retry' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END; $$;
        CREATE TRIGGER cb_native_worker_fault BEFORE UPDATE ON cb_media_work_queue FOR EACH ROW EXECUTE FUNCTION cb_native_worker_fault();`)); trigger = true;
      assert.equal(child.child.kill('SIGTERM'),true); await child.notice('stopping'); child.child.send({ state:'release' });
      const failed = await child.notice('failed'); assert.equal(failed.status.state,'failed');
      assert.equal(failed.status.failureCode,'MEDIA_WORKER_UNAVAILABLE'); assert.equal(failed.status.phase,'inspection');
      assert.equal(failed.status.completedPolls,0); assert.deepEqual(await child.closed(),{ code:1,signal:null });
      assert.equal((await rowFor(staged.row.id)).state,'inspecting'); assert.equal((await jobFor(staged.row.id)).state,'running');
    } finally {
      await child.cleanup();
      if (trigger) await databaseA.transaction((tx) => tx.exec('DROP TRIGGER cb_native_worker_fault ON cb_media_work_queue; DROP FUNCTION cb_native_worker_fault();'));
    }
    await delay(Math.max(0,new Date(claimed.lease_until).getTime()-Date.now()+40));
    const resumed = new MediaUploads(databaseB,new PrivateFileStore(root)); await resumed.cleanup();
    const job = await jobFor(staged.row.id),row = await rowFor(staged.row.id); assert.equal(job.state,'retry');
    assert.equal(row.state,'quarantined'); assert.equal((await lstat(join(root,`${claimed.candidate_key}.blocked`))).isFile(),true);
    assert.deepEqual(await readFile(join(root,`${row.object_key}.blob`)),bytes);
    await assert.rejects(resumed.settle(staged.f.guardian,staged.f.roomId,claimed,{ state:'quarantined' }),{ code:'UPLOAD_CONFLICT' });
    await resumed.cancel(staged.f.guardian,{ conversationId:staged.f.roomId,uploadId:row.id,expectedVersion:row.version }); await resumed.cleanup();
  }));
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { migrate } from './migrate.mjs';
import { DecoderJobJournal } from './decoder-journal.mjs';
import { IsolatedMediaDecoder } from './decoder-jobs.mjs';
import { testDatabaseOptions,testDatabase,testRuntime,syntheticInput } from './linux-decoder-test-fixtures.mjs';
// Real Linux + native PG + actual per-file namespaces. Synthetic PNG ONLY.
let admin,db,candidate,child,passed = 0,complete = false;
const unavailable = (error) => error?.code === 'SCAN_UNAVAILABLE' && error.message === error.code;
const invalid = (error) => error?.code === 'SCAN_INVALID' && error.message === error.code;
async function scenario(name,work) { try { await work(); passed++; console.log(`PASS ${name}`); } catch (error) { console.log(`FAIL ${name}`); throw error; } }
try {
  if (process.platform !== 'linux' || process.version !== 'v24.15.0') throw new Error('CONFIGURATION');
  admin = new Pool(testDatabaseOptions('postgres')); admin.on('error',() => {});
  const ready = Date.now()+45000;
  while (true) { try { await admin.query('SELECT 1'); break; } catch { if (Date.now() >= ready) throw new Error('NOT_READY'); await delay(250); } }
  assert.equal((await admin.query("SELECT current_setting('server_version') AS version")).rows[0].version,'18.6');
  candidate = `carebridge_it_${randomUUID().replaceAll('-','')}`;
  // This fresh RAM-only instance is owned by the test harness; no adoption of
  // any operating DB. Identifier is generated internally, never supplied.
  await admin.query(`CREATE DATABASE "${candidate}" TEMPLATE template0`);
  db = testDatabase(candidate); await migrate(db);
  const query = (sql,params) => db.transaction((tx) => tx.query(sql,params));
  const runtime = await testRuntime(),engine = process.env.CAREBRIDGE_LINUX_TEST_ENGINE,image = process.env.CAREBRIDGE_LINUX_TEST_IMAGE;
  const store = () => new DecoderJobJournal(db,{ engineIdentity:engine,approvedImageId:image });
  const decoder = (journal = store(),adapter = runtime) => new IsolatedMediaDecoder({ runtime:adapter,engineIdentity:engine,approvedImageId:image,journal });
  const receipts = () => query('SELECT run,phase,container_id,lease_until,owner_id,generation FROM cb_decoder_jobs ORDER BY created_at');
  async function closed() {
    for (const row of (await receipts()).rows) {
      assert.equal(row.phase,'closed');
      if (row.container_id) assert.equal(await runtime.docker(['ps','--all','--no-trunc','--filter',`id=${row.container_id}`,'--format','{{.ID}}']),'');
    }
  }
  await scenario('fixed local Linux endpoint ignores ambient remote context and rejects unapproved CLI',async () => {
    process.env.DOCKER_HOST = 'tcp://remote.invalid:2375'; process.env.DOCKER_CONTEXT = 'remote'; process.env.DOCKER_CONFIG = '/private';
    assert.equal(await runtime.identity(),engine); await assert.rejects(testRuntime({ cliSha256:'0'.repeat(64) }),unavailable);
  });
  await scenario('native decode and persisted receipt complete together without a file approval',async () => {
    const report = await decoder().decode(syntheticInput()); assert.equal(report.media.width,32); assert.equal(report.media.height,24);
    assert.equal(report.mediaAcceptanceReady,false); assert.equal(Object.hasOwn(report,'verdict'),false); await closed();
  });
  await scenario('native MIME mismatch is rejected and its actual namespace and DB receipt close',async () => {
    await assert.rejects(decoder().decode(syntheticInput(undefined,{ type:'image/jpeg' })),invalid); await closed();
  });
  await scenario('two owners share global capacity and actual cancellation removes only their namespaces',async () => {
    let arrivals = 0; const started = Promise.withResolvers(); const controllers = [new AbortController(),new AbortController()];
    const observed = { ...runtime,async exchange(id,packet,options) {
      const pending = runtime.exchange(id,packet,options),settled = pending.then((value) => ({ value }),(error) => ({ error }));
      const deadline = Date.now()+15000;
      while (Date.now() < deadline) { if ((await runtime.inspect('container',id)).State.Running) { if (++arrivals === 2) started.resolve(); break; } await delay(50); }
      const result = await settled; if (result.error) throw result.error; return result.value;
    } };
    const tasks = controllers.map((controller) => assert.rejects(decoder(store(),observed).decode(syntheticInput(undefined,{ stream:new Readable({ read() {} }) }),{ signal:controller.signal }),unavailable));
    const timer = setTimeout(() => started.reject(new Error('NOT_STARTED')),20000);
    try {
      await started.promise; const count = (await receipts()).rows.length;
      await assert.rejects(decoder().decode(syntheticInput()),unavailable); assert.equal((await receipts()).rows.length,count);
    } finally { clearTimeout(timer); controllers.forEach((controller) => controller.abort()); await Promise.all(tasks); }
    await closed();
  });
  await scenario('engine adapter cannot stop or remove this tests different-image database container',async () => {
    const id = process.env.CAREBRIDGE_LINUX_TEST_DATABASE_ID; assert.match(id,/^[a-f0-9]{64}$/);
    await assert.rejects(runtime.docker(['kill','--signal','KILL',id]),unavailable); await assert.rejects(runtime.docker(['rm',id]),unavailable);
    assert.equal((await admin.query('SELECT 1 AS healthy')).rows[0].healthy,1);
  });
  let abandoned;
  await scenario('actual SIGKILL loses process memory but cannot steal a still valid persisted lease',async () => {
    child = spawn(process.execPath,['linux-decoder-native-child.mjs'],{ env:{ ...process.env,CAREBRIDGE_LINUX_TEST_CHILD:'crash-after-attached',
      CAREBRIDGE_LINUX_TEST_DATABASE:candidate },stdio:['ignore','pipe','pipe'] });
    const closedChild = new Promise((resolve) => child.once('close',(code,signal) => resolve({ code,signal })));
    const ready = Promise.withResolvers(); let output = '';
    child.stdout.on('data',(bytes) => {
      output += bytes.toString('utf8'); if (output.length > 4096) { ready.reject(new Error('OVERSIZE')); return; }
      if (output.includes('\n')) { try { ready.resolve(JSON.parse(output.trim())); } catch { ready.reject(new Error('INVALID')); } }
    });
    child.stderr.resume(); child.once('error',() => ready.reject(new Error('CHILD')));
    child.once('close',() => ready.reject(new Error('EARLY_EXIT')));
    const timer = setTimeout(() => ready.reject(new Error('NOT_READY')),45000);
    try { abandoned = await ready.promise; } finally { clearTimeout(timer); }
    assert.deepEqual(Object.keys(abandoned).sort(),['id','run']); assert.match(abandoned.id,/^[a-f0-9]{64}$/);
    const before = (await query('SELECT * FROM cb_decoder_jobs WHERE run = $1',[abandoned.run])).rows[0];
    assert.equal(before.phase,'attached'); assert.equal(before.container_id,abandoned.id);
    assert.equal(child.kill('SIGKILL'),true); const outcome = await closedChild; assert.equal(outcome.signal,'SIGKILL'); child = null;
    await assert.rejects(store().take(abandoned.run),unavailable);
    await decoder().recoverRetained(); assert.equal((await query('SELECT phase FROM cb_decoder_jobs WHERE run = $1',[abandoned.run])).rows[0].phase,'attached');
  });
  await scenario('natural DB lease expiry permits new-instance recovery of the exact actual container',async () => {
    const deadline = Date.now()+210000; let announced = false;
    while (true) {
      const { rows } = await query('SELECT lease_until <= clock_timestamp() AS expired FROM cb_decoder_jobs WHERE run = $1',[abandoned.run]);
      if (rows[0].expired) break; if (Date.now() >= deadline) throw new Error('LEASE_NOT_EXPIRED');
      if (!announced) { console.log('WAIT natural persisted lease expiry, no SQL clock fixture or restarted request'); announced = true; }
      await delay(1000);
    }
    await decoder().recoverRetained(); await closed();
  });
  await scenario('after crash recovery a new valid file decodes once with no old namespace reuse',async () => {
    const count = (await receipts()).rows.length; await decoder().decode(syntheticInput());
    const rows = (await receipts()).rows; assert.equal(rows.length,count+1); assert.notEqual(rows.at(-1).container_id,abandoned.id); await closed();
  });
  assert.equal(passed,8); await db.close(); db = null;
  await admin.query(`DROP DATABASE "${candidate}"`); candidate = null;
  console.log('PASS temporary combined-test database removed'); complete = true;
  console.log(`Native Linux decoder with journal: ${passed} scenarios passed.`);
} catch (error) {
  console.error('LINUX_DECODER_NATIVE_TEST_FAILED');
  if (error.code === 'ERR_ASSERTION') { const line = /linux-decoder-native-test\.mjs:(\d{1,4}):\d+/.exec(error.stack ?? '')?.[1]; if (line) console.error(`LINUX_DECODER_ASSERTION_LINE_${line}`); }
} finally {
  if (child) child.kill('SIGKILL');
  try { await db?.close(); await admin?.end(); } catch { complete = false; }
  // Failed/unknown outcomes retain the DB and owned resources for inspection.
  // The parent harness must not stop the DB or prune unobserved namespaces.
  if (!complete || candidate) process.exitCode = 1;
}

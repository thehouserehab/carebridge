// Explicit SYNTHETIC recovery suite. No production URL, API, mail, user files,
// automatic worker start, role provisioning or operating cutover is supported.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Pool } from 'pg';
import { databaseFromPool } from './database.mjs';
import { migrate } from './migrate.mjs';
import { Conversations } from './conversations.mjs';
import { Records } from './records.mjs';
import { Auth } from './auth.mjs';
import { DecoderJobJournal } from './decoder-journal.mjs';
import { nextMediaWork } from './media-work-queue.mjs';
import { quarantineRestoredDatabase } from './recovery-quarantine.mjs';
import { PrivateFileStore } from './private-file-store.mjs';
import { servingFile } from './media-serving.mjs';
import { syntheticPng, addPrivateMetadata } from './image-metadata-test-fixtures.mjs';
import { evidenceForManifest, sealFixture } from './media-storage-test-evidence.mjs';
import { configureSyntheticMediaPolicy } from './media-resource-test-policy.mjs';
import { createRecoveryBundle, openRecoveryBundle } from './recovery-bundle.mjs';
import { recoveryMigrationManifest, assertRecoveryMigrations, assertRecoveryReviewRows, assertRecoveryRecipientRows,
  compareRecoveryFingerprint as compareFingerprint } from './recovery-native-contract.mjs';
import { seedRecoveryRecipientFixture, verifyRecoveryRecipientFixture,
  verifyQuarantinedRecoveryRecipientFixture } from './recovery-recipient-native-check.mjs';
import { createDisposableDatabase, disposableDatabaseName, dropDisposableDatabase, postgresTestOptions } from './postgres-test-harness.mjs';

let admin, source, restored, incomplete, sourceLease, targetLease, incompleteLease, root, rootIdentity, key, reader, failed = false;
const bytesHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileManifest = (bytes) => ({ type: 'image/png', size: bytes.length, sha256: bytesHash(bytes) });
const collect = async (stream) => { const parts = []; for await (const part of stream) parts.push(Buffer.from(part)); return Buffer.concat(parts); };
const entry = (name, data) => ({ name, open: async function* () { yield data; } });
const report = (name) => console.log(`PASS ${name}`);
function childProcess(command, args, config, database, input = false) {
  // No ambient PG settings, secrets in argv, shell, SQL stdout or driver logs.
  const child = spawn(`/usr/local/bin/${command}`, args, { shell: false, timeout: 45000,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LD_LIBRARY_PATH: '/opt/pg/lib', TZ: 'UTC', PGHOST: config.host, PGPORT: String(config.port),
      PGUSER: config.user, PGPASSWORD: config.password, PGDATABASE: database, PGSSLMODE: 'disable',
      PGOPTIONS: '-c statement_timeout=30000 -c lock_timeout=5000 -c search_path=public,pg_catalog' },
    stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  const done = new Promise((yes, no) => {
    child.once('error', () => no(new Error('RECOVERY_NATIVE_PROCESS')));
    child.once('close', (code) => code === 0 ? yes() : no(new Error('RECOVERY_NATIVE_PROCESS')));
  });
  done.catch(() => {}); // Failure is awaited, never left as an unhandled event.
  return { child, done };
}
async function* dump(config, name) {
  const { child, done } = childProcess('pg_dump', ['--format=custom', '--no-password', '--lock-wait-timeout=5s'], config, name);
  try { for await (const chunk of child.stdout) yield chunk; await done; }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill(); await done.catch(() => {}); }
}
async function restore(config, name, bytes) {
  const { child, done } = childProcess('pg_restore', ['--dbname', name, '--no-password', '--single-transaction'], config, name, true);
  child.stdout.resume();
  try { await pipeline(Readable.from(bytes), child.stdin); await done; }
  catch { throw new Error('RECOVERY_NATIVE_PROCESS'); }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill(); await done.catch(() => {}); }
}
async function fingerprint(db) {
  return db.transaction(async (tx) => {
    const tables = (await tx.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    const data = [];
    for (const { tablename } of tables) {
      assert.match(tablename, /^cb_[a-z_]+$/);
      const row = (await tx.query(`SELECT count(*)::int AS count, md5(COALESCE(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY to_jsonb(t)::text),'')) AS hash FROM "${tablename}" t`)).rows[0];
      data.push({ name: tablename, ...row });
    }
    const schema = (await tx.query(`SELECT c.relname, c.relkind, r.rolname AS owner,
      (SELECT jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),
        'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
        'privilege',a.privilege_type,'grantable',a.is_grantable)
        ORDER BY pg_get_userbyid(a.grantee),a.privilege_type,pg_get_userbyid(a.grantor),a.is_grantable)
        FROM aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a) AS effective_acl
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner
      WHERE n.nspname='public' AND c.relkind IN ('r','S') ORDER BY c.relname`)).rows;
    const columns = (await tx.query(`SELECT c.relname,a.attname,a.attnotnull,a.attidentity,a.attgenerated,
      format_type(a.atttypid,a.atttypmod) AS type,pg_get_expr(d.adbin,d.adrelid) AS default_expression
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY c.relname,a.attnum`)).rows;
    const triggers = (await tx.query(`SELECT c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`)).rows;
    // PostgreSQL regenerates internal FK trigger names from local OIDs during
    // restore. Compare their actual constraint bindings/enablement, not OIDs.
    const internalTriggers = (await tx.query(`SELECT r.relname,c.conname,t.tgenabled,t.tgdeferrable,t.tginitdeferred,count(*)::int AS count
      FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_constraint c ON c.oid=t.tgconstraint
      JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='public' AND t.tgisinternal
      GROUP BY r.relname,c.conname,t.tgenabled,t.tgdeferrable,t.tginitdeferred
      ORDER BY r.relname,c.conname,t.tgenabled,t.tgdeferrable,t.tginitdeferred`)).rows;
    const functions = (await tx.query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS arguments,
      p.proacl,r.rolname AS owner,pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
      WHERE n.nspname='public' ORDER BY p.proname,arguments`)).rows;
    const constraints = (await tx.query(`SELECT r.relname,c.contype,
      CASE WHEN c.contype='n' THEN NULL ELSE c.conname END AS name,
      c.conenforced,c.convalidated,c.condeferrable,c.condeferred,c.connoinherit,pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=c.connamespace
      WHERE n.nspname='public' ORDER BY r.relname,c.contype,name,definition`)).rows;
    // BETWEEN builds a nested AND tree, while reparsing pg_dump's equivalent
    // CHECK can flatten that tree. Canonicalize with POSTGRESQL'S OWN parser,
    // not a regex that could erase real predicate differences. These empty
    // transaction-local probes never touch original constraints or records.
    for (const constraint of constraints.filter((c) => c.contype === 'c')) {
      assert.match(constraint.relname, /^cb_[a-z_]+$/);
      await tx.query(`CREATE TEMP TABLE recovery_constraint_probe (LIKE public."${constraint.relname}") ON COMMIT DROP`);
      await tx.query(`ALTER TABLE pg_temp.recovery_constraint_probe ADD CONSTRAINT recovery_check ${constraint.definition}`);
      constraint.definition = (await tx.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid='pg_temp.recovery_constraint_probe'::regclass AND conname='recovery_check'`)).rows[0].definition;
      await tx.query('DROP TABLE pg_temp.recovery_constraint_probe');
    }
    return { data, schema, columns, triggers, internalTriggers, functions, constraints };
  });
}
async function migrationLedger(db) {
  return (await db.transaction(tx => tx.query('SELECT name,checksum FROM cb_schema_migrations ORDER BY name COLLATE "C"'))).rows;
}

try {
  const config = postgresTestOptions({ url: process.env.CAREBRIDGE_POSTGRES_TEST_URL, confirmation: process.env.CAREBRIDGE_POSTGRES_TEST_CONFIRM });
  if (process.platform !== 'linux' || process.version !== 'v24.15.0') throw new Error('RECOVERY_NATIVE_CONFIGURATION');
  // Reject missing/extra/renamed SQL before allocating any disposable DB.
  const migrationDirectory = new URL('./migrations/', import.meta.url);
  const expectedMigrations = recoveryMigrationManifest(await Promise.all(
    (await readdir(migrationDirectory)).filter(name => name.endsWith('.sql')).map(async name =>
      ({ name, content: await readFile(new URL(name, migrationDirectory)) }))));
  admin = new Pool({ ...config, max: 1 }); admin.on('error', () => {});
  sourceLease = await createDisposableDatabase(admin, disposableDatabaseName());
  targetLease = await createDisposableDatabase(admin, disposableDatabaseName());
  incompleteLease = await createDisposableDatabase(admin, disposableDatabaseName());
  source = databaseFromPool(new Pool({ ...config, database: sourceLease.name }));
  restored = databaseFromPool(new Pool({ ...config, database: targetLease.name }));
  incomplete = databaseFromPool(new Pool({ ...config, database: incompleteLease.name }));
  for (const command of ['pg_dump', 'pg_restore']) {
    const { child, done } = childProcess(command, ['--version'], config, sourceLease.name);
    const version = (await collect(child.stdout)).toString('utf8'); await done; assert.match(version, /\(PostgreSQL\) 18\.6\b/);
  }
  await migrate(source); assert.deepEqual(await migrate(source), []);
  assertRecoveryMigrations(await migrationLedger(source), expectedMigrations);
  report('fresh owned databases and native PG 18.6 tools match every reviewed migration name and checksum');

  root = await mkdtemp(join(tmpdir(), 'carebridge-recovery-native-')); rootIdentity = await lstat(root);
  for (const dir of ['source', 'restored', 'backups']) await mkdir(join(root, dir), { mode: 0o700 });
  const sourceStore = new PrivateFileStore(join(root, 'source')), targetStore = new PrivateFileStore(join(root, 'restored'));
  const therapist = { centerId: 'synthetic-recovery-center', userId: 'synthetic-recovery-therapist' };
  const guardian = { centerId: therapist.centerId, userId: 'synthetic-recovery-guardian' };
  const manager = { centerId: therapist.centerId, userId: 'synthetic-recovery-manager' };
  const room = 'synthetic-recovery-room', goal = 'synthetic-recovery-goal', recordId = 'synthetic-recovery-record';
  await source.transaction(async (tx) => {
    await tx.query('INSERT INTO cb_centers VALUES ($1)', [therapist.centerId]);
    await configureSyntheticMediaPolicy(tx, therapist.centerId);
    for (const [actor, role] of [[therapist, 'therapist'], [guardian, 'guardian'], [manager, 'center']]) {
      await tx.query('INSERT INTO cb_users(id,active) VALUES ($1,true)', [actor.userId]);
      await tx.query('INSERT INTO cb_memberships VALUES ($1,$2,$3,true)', [actor.centerId, actor.userId, role]);
    }
    await tx.query('INSERT INTO cb_children VALUES ($1,$2)', [therapist.centerId, 'synthetic-recovery-child']);
    await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)', [therapist.centerId, room, 'synthetic-recovery-child']);
    for (const [actor, role] of [[therapist, 'therapist'], [guardian, 'guardian']])
      await tx.query('INSERT INTO cb_participants VALUES ($1,$2,$3,$4,true,1)', [actor.centerId, room, actor.userId, role]);
    await tx.query("INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ($1,$2,$3,'Synthetic goal','active')", [therapist.centerId, room, goal]);
    await tx.query('GRANT USAGE ON SCHEMA public TO carebridge_recovery_app');
    await tx.query('GRANT SELECT,INSERT,UPDATE ON public.cb_users TO carebridge_recovery_app');
  });
  const authOptions = { password:{ N:1024,r:8,p:1,maxmem:32*1024**2 } }; // Synthetic fixture cost only.
  const password = randomBytes(32).toString('hex'), sourceAuth = new Auth(source,authOptions);
  for (const [actor,role] of [[therapist,'therapist'],[guardian,'guardian'],[manager,'manager']])
    await sourceAuth.provisionAccount({ userId:actor.userId,email:`${role}.synthetic-recovery@example.invalid`,password });
  const oldSession = await sourceAuth.login({ email:'guardian.synthetic-recovery@example.invalid',password });
  const managerSession=await sourceAuth.login({email:'manager.synthetic-recovery@example.invalid',password});
  const changedPassword=randomBytes(32).toString('hex');
  await sourceAuth.changePassword(managerSession.token,{currentPassword:password,newPassword:changedPassword});
  await sourceAuth.login({email:'manager.synthetic-recovery@example.invalid',password:changedPassword});
  assert.equal(await sourceAuth.revokeAll(manager.userId),1);
  assert.deepEqual((await source.transaction(tx => tx.query(`SELECT action,revoked_sessions FROM cb_account_security_events
    WHERE user_id=$1 ORDER BY occurred_at,id`,[manager.userId]))).rows,
    [{action:'password.changed',revoked_sessions:1},{action:'sessions.revoked',revoked_sessions:1}]);
  const oldInvitation = await sourceAuth.createInvitation(manager,{ centerId:manager.centerId,email:'pending.synthetic-recovery@example.invalid',role:'guardian' });
  const journalOptions = { engineIdentity:'synthetic-recovery-engine',approvedImageId:`sha256:${'8'.repeat(64)}`,ownerId:randomUUID(),capacity:2 };
  const oldJournal = new DecoderJobJournal(source,journalOptions), oldJob = await oldJournal.creating(await oldJournal.reserve(randomUUID()));
  const candidateBytes = syntheticPng(), sourceBytes = addPrivateMetadata(candidateBytes, 'image/png');
  const original = fileManifest(sourceBytes), candidate = fileManifest(candidateBytes);
  const uploadId = randomUUID(), sourceKey = randomUUID(), candidateKey = randomUUID(), blockedKey = randomUUID(), deleteUploadId = randomUUID();
  const queuedId = randomUUID(), queuedKey = randomUUID();
  const uploads = await source.transaction(async (tx) => {
    const stage = async (id, objectKey, derivativeKey,queueOnly = false) => {
      const sequence = (await tx.query('UPDATE cb_conversations SET last_sequence=last_sequence+1 WHERE id=$1 RETURNING last_sequence', [room])).rows[0].last_sequence;
      await tx.query(`INSERT INTO cb_media_uploads(center_id,conversation_id,id,owner_id,client_id,request_hash,name,type,size,sha256,created_sequence,expires_at)
        VALUES ($1,$2,$3,$4,$3,repeat('b',64),'synthetic.png',$5,$6,$7,$8,clock_timestamp()+interval '1 hour')`,
      [therapist.centerId, room, id, guardian.userId, original.type, original.size, original.sha256, sequence]);
      for (const object of [objectKey, derivativeKey].filter(Boolean))
        await tx.query('INSERT INTO cb_media_objects(key,center_id,conversation_id,upload_id) VALUES ($1,$2,$3,$4)', [object, therapist.centerId, room, id]);
      await tx.query("UPDATE cb_media_uploads SET state='receiving',version=2,object_key=$2,lease_id=$3,lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$1", [id, objectKey, randomUUID()]);
      await tx.query("UPDATE cb_media_uploads SET state='quarantined',version=3,lease_id=NULL,lease_until=NULL WHERE id=$1", [id]);
      if (queueOnly) return;
      if (!derivativeKey) {
        await tx.query("UPDATE cb_media_uploads SET state='delete_pending',version=4 WHERE id=$1", [id]);
        await tx.query("UPDATE cb_media_objects SET state='delete_pending' WHERE key=$1", [objectKey]);
        await tx.query("UPDATE cb_media_objects SET state='deleted' WHERE key=$1", [objectKey]);
        await tx.query("UPDATE cb_media_uploads SET state='deleted',version=5 WHERE id=$1", [id]); return;
      }
      const row = (await tx.query("UPDATE cb_media_uploads SET state='inspecting',version=4,candidate_key=$2,lease_id=$3,lease_until=clock_timestamp()+interval '30 seconds' WHERE id=$1 RETURNING *", [id, derivativeKey, randomUUID()])).rows[0];
      return sealFixture(tx, row, evidenceForManifest(original, candidate)); // Synthetic SQL proof, NOT native AV/decode approval.
    };
    const prepared = await stage(uploadId, sourceKey, candidateKey); await stage(deleteUploadId, blockedKey);
    await stage(queuedId,queuedKey,null,true); return prepared;
  });
  await sourceStore.write(sourceKey, Readable.from([sourceBytes]), original);
  await sourceStore.write(candidateKey, Readable.from([candidateBytes]), candidate);
  await sourceStore.write(queuedKey, Readable.from([sourceBytes]), original);
  await sourceStore.remove(blockedKey);
  const chat = new Conversations(source), records = new Records(source);
  const reviewedMessage = await chat.sendText(guardian, { conversationId: room, clientId: 'synthetic-recovery-review-source',
    body: 'Synthetic original review source' });
  const reviewTarget = { conversationId: room, messageId: reviewedMessage.id };
  const firstReviewRequest = { ...reviewTarget, clientId: 'synthetic-recovery-review-0001',
    expectedRevision: 1, expectedReviewVersion: 0, note: 'SYNTHETIC-PRIVATE-REVIEW-ONE' };
  const firstReviewReceipt = await chat.textReviewSave(therapist, firstReviewRequest);
  assert.deepEqual(firstReviewReceipt, { messageId: reviewedMessage.id, revision: 1, reviewVersion: 1, operation: 'review', replayed: false });
  await chat.editText(guardian, { ...reviewTarget, clientId: 'synthetic-recovery-review-edit', expectedRevision: 1,
    body: 'Synthetic revised review source' });
  const secondReviewReceipt = await chat.textReviewSave(therapist, { ...firstReviewRequest, clientId: 'synthetic-recovery-review-0002',
    expectedRevision: 2, expectedReviewVersion: 1, note: 'SYNTHETIC-PRIVATE-REVIEW-TWO' });
  assert.deepEqual(secondReviewReceipt, { messageId: reviewedMessage.id, revision: 2, reviewVersion: 2, operation: 'review', replayed: false });
  const beforeReview = await chat.textReview(therapist, reviewTarget);
  assert.deepEqual(beforeReview, { ...reviewTarget, revision: 2, reviewVersion: 2, reviewedRevision: 2,
    note: 'SYNTHETIC-PRIVATE-REVIEW-TWO', body: 'Synthetic revised review source', attachmentCount: 0 });
  const photo = await chat.sendText(guardian, { conversationId: room, clientId: 'synthetic-recovery-photo-0001', body: 'Synthetic family news', attachments: [{ id: uploadId }] });
  const content = { date: '2026-10-01', goalId: goal, performed: 'Synthetic activity', response: 'Synthetic observation', nextPlan: 'Synthetic next plan',
    summary: 'Synthetic guardian summary', privateNote: 'SYNTHETIC-PRIVATE-CLINICAL-NOTE', referenceMessageIds: [photo.id],
    assessments: [{ tool: 'Synthetic observation', item: 'Attempts', value: 0, unit: 'count', context: 'Same conditions' },
      { tool: 'Synthetic observation', item: 'Duration', value: 3, unit: 'minute', context: 'Different conditions' }] };
  await records.save(therapist, { conversationId: room, recordId, clientId: 'synthetic-recovery-save-0001', expectedRevision: 0, content });
  const publish = async (clientId) => {
    const preview = await records.preview(therapist, { conversationId: room, recordId });
    return records.publish(therapist, { conversationId: room, recordId, clientId, expectedRevision: preview.recordRevision,
      expectedRelationshipsVersion: preview.relationshipsVersion, recipientIds: preview.recipientIds });
  };
  const first = await publish('synthetic-recovery-publish-0001');
  const reply = await chat.sendText(guardian, { conversationId: room, clientId: 'synthetic-recovery-reply-0001', body: 'Synthetic independent reply', replyTo: first.messageId });
  await records.save(therapist, { conversationId: room, recordId, clientId: 'synthetic-recovery-save-0002', expectedRevision: 1, content: { ...content, summary: 'New synthetic summary' } });
  const second = await publish('synthetic-recovery-publish-0002'); await chat.withdraw(therapist, { conversationId: room, messageId: second.messageId });
  const draftId = 'synthetic-recovery-draft';
  await records.save(therapist,{ conversationId:room,recordId:draftId,clientId:'synthetic-recovery-draft-0001',expectedRevision:0,
    content:{ date:'2026-10-07',goalId:goal,status:'draft',assessments:[{ ...content.assessments[0],value:null },{ tool:'Synthetic partial tool' }],
      observation:{ status:'',task:'Synthetic unfinished task' },activity:{ title:'Synthetic unfinished activity' } } });
  const beforeDraft = await records.get(therapist,{ conversationId:room,recordId:draftId });
  assert.equal(beforeDraft.assessments[0].value,null);
  const beforeRecord = await records.get(therapist, { conversationId: room, recordId });
  const beforeChat = await chat.list(guardian, { conversationId: room });
  const recipientFixture = await seedRecoveryRecipientFixture(source);
  await verifyRecoveryRecipientFixture({ owner:source,fixture:recipientFixture,fingerprint });
  const dbBefore = await fingerprint(source);
  assertRecoveryMigrations(await migrationLedger(source), expectedMigrations);
  assert.equal(dbBefore.data.find((t) => t.name === 'cb_schema_migrations').count, expectedMigrations.length);
  assertRecoveryReviewRows(dbBefore.data);
  assertRecoveryRecipientRows(dbBefore.data);
  assert.equal(dbBefore.data.find((t) => t.name === 'cb_account_security_events').count, 2);
  report('synthetic clinical revisions zero measurements references reshares withdrawal and recipient identity seeded without weakened triggers');

  const inventory = [{ name: `${sourceKey}.blob`, manifest: original }, { name: `${candidateKey}.blob`, manifest: candidate },
    { name: `${queuedKey}.blob`,manifest:original },{ name: `${blockedKey}.blocked`, manifest: null }];
  assert.deepEqual((await readdir(sourceStore.root)).sort(), inventory.map((i) => i.name).sort());
  // This suite has ONE writer: after dbBefore no source mutations, worker,
  // cleanup, auth server or live IO exists. No boolean asserts operating quiescence.
  const snapshot = { version: 1, quiescence: 'single-process-synthetic', database: dbBefore, inventory, operatingCutoverApproved: false };
  const entries = [entry('snapshot.json', Buffer.from(JSON.stringify(snapshot))), { name: 'database.pgcustom', open: () => dump(config, sourceLease.name) }];
  for (const item of inventory) entries.push({ name: item.name, open: async function* () {
    const handle = item.manifest ? await sourceStore.openVerified(item.name.slice(0, -5), item.manifest) : await open(join(sourceStore.root, item.name), 'r');
    try {
      const buffer = Buffer.alloc(65536); let position = 0;
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break; position += bytesRead; yield Buffer.from(buffer.subarray(0, bytesRead));
      }
    } finally { await handle.close(); }
  } });
  key = randomBytes(32); const options = { directory: join(root, 'backups'), runId: randomUUID(), key };
  await createRecoveryBundle({ ...options, entries }); reader = await openRecoveryBundle(options);
  assert.deepEqual(JSON.parse((await collect(reader.stream('snapshot.json'))).toString('utf8')), snapshot);
  assert.equal((await readFile(join(options.directory, `${options.runId}.cbb`))).includes(Buffer.from('SYNTHETIC-PRIVATE-CLINICAL-NOTE')), false);
  compareFingerprint(await fingerprint(source), dbBefore);
  report('native custom dump and original candidate deletion fence encrypted together without plaintext temporary SQL');

  await restore(config, targetLease.name, reader.stream('database.pgcustom'));
  console.log('RECOVERY_NATIVE_SQL_RESTORED');
  compareFingerprint(await fingerprint(restored), dbBefore); assert.deepEqual(await migrate(restored), []);
  assertRecoveryMigrations(await migrationLedger(restored), expectedMigrations);
  console.log('RECOVERY_NATIVE_SCHEMA_COMPARED');
  for (const item of inventory) {
    if (item.manifest) await targetStore.write(item.name.slice(0, -5), Readable.from(reader.stream(item.name)), item.manifest);
    else await targetStore.remove(item.name.slice(0, -8));
  }
  console.log('RECOVERY_NATIVE_FILES_RESTORED');
  assert.deepEqual((await readdir(targetStore.root)).sort(), inventory.map((i) => i.name).sort());
  for (const item of inventory.filter((i) => i.manifest)) {
    const handle = await targetStore.openVerified(item.name.slice(0, -5), item.manifest);
    try { assert.deepEqual(await handle.readFile(), item.manifest === original ? sourceBytes : candidateBytes); } finally { await handle.close(); }
  }
  await assert.rejects(targetStore.write(blockedKey, Readable.from([sourceBytes]), original), { code: 'STORAGE_UNAVAILABLE' });
  assert.equal(servingFile(uploads).object_key, candidateKey);
  report('new isolated database restores all rows schema constraints triggers ownership and exact private object bytes');

  const restoredRecords = new Records(restored), restoredChat = new Conversations(restored);
  assert.deepEqual(await restoredChat.textReview(therapist, reviewTarget), beforeReview);
  // An old receipt acknowledges v1 without rolling the newer private note back.
  assert.deepEqual(await restoredChat.textReviewSave(therapist, firstReviewRequest), { ...firstReviewReceipt, replayed: true });
  assert.deepEqual(await restoredChat.textReview(therapist, reviewTarget), beforeReview);
  compareFingerprint(await fingerprint(restored), dbBefore); // Includes receipt bytes, audit and room revision.
  await assert.rejects(restoredChat.textReview(guardian, reviewTarget), { code: 'FORBIDDEN' });
  await assert.rejects(restoredChat.textReview(manager, reviewTarget), { code: 'NOT_FOUND' });
  assert.deepEqual(await restoredRecords.get(therapist, { conversationId: room, recordId }), beforeRecord);
  assert.deepEqual(await restoredRecords.get(therapist,{ conversationId:room,recordId:draftId }),beforeDraft);
  await assert.rejects(restoredRecords.preview(therapist,{ conversationId:room,recordId:draftId }),{ code:'RECORD_NOT_SHAREABLE' });
  assert.deepEqual(await restoredChat.list(guardian, { conversationId: room }), beforeChat);
  await assert.rejects(restoredRecords.get(guardian, { conversationId: room, recordId }), { code: 'FORBIDDEN' });
  await assert.rejects(restoredChat.list(manager, { conversationId: room }), { code: 'NOT_FOUND' });
  assert.equal(JSON.stringify(beforeChat).includes('SYNTHETIC-PRIVATE-CLINICAL-NOTE'), false);
  assert.doesNotMatch(JSON.stringify(beforeChat), /SYNTHETIC-PRIVATE-REVIEW|reviewVersion|reviewedRevision/);
  assert.equal(beforeChat.messages.some((m) => m.id === reply.id && m.body === 'Synthetic independent reply'), true);
  await assert.rejects(restored.transaction((tx) => tx.query("UPDATE cb_record_revisions SET private_note='changed'")), { code: '23514' });
  await assert.rejects(restored.transaction((tx) => tx.query('DELETE FROM cb_media_preparations')), { code: '23514' });
  await verifyRecoveryRecipientFixture({ owner:restored,fixture:recipientFixture,fingerprint });
  report('restored services preserve clinical privacy immutable history original reply links and withdrawal display');

  // Test the verifier itself. These deliberate weakening attempts occur ONLY
  // in the freshly created disposable restore target, never in the source.
  const profileCheck = dbBefore.constraints.find((c) => c.name === 'cb_child_profiles_name_check');
  assert.ok(profileCheck);
  await restored.transaction(async (tx) => {
    await tx.query('ALTER TABLE cb_child_profiles DROP CONSTRAINT cb_child_profiles_name_check');
    await tx.query('ALTER TABLE cb_child_profiles ADD CONSTRAINT cb_child_profiles_name_check CHECK (length(name) <= 300)');
  });
  await assert.rejects(async () => compareFingerprint(await fingerprint(restored), dbBefore), { message: 'RECOVERY_NATIVE_CONSTRAINT_C' });
  await restored.transaction(async (tx) => {
    await tx.query('ALTER TABLE cb_child_profiles DROP CONSTRAINT cb_child_profiles_name_check');
    await tx.query(`ALTER TABLE cb_child_profiles ADD CONSTRAINT cb_child_profiles_name_check ${profileCheck.definition}`);
    await tx.query('GRANT SELECT ON cb_record_revisions TO PUBLIC');
  });
  await assert.rejects(async () => compareFingerprint(await fingerprint(restored), dbBefore), { message: 'RECOVERY_NATIVE_SCHEMA_EFFECTIVE_ACL' });
  await restored.transaction(async (tx) => {
    await tx.query('REVOKE ALL ON cb_record_revisions FROM PUBLIC');
    await tx.query('ALTER TABLE cb_record_revisions ALTER COLUMN private_note DROP NOT NULL');
  });
  await assert.rejects(async () => compareFingerprint(await fingerprint(restored), dbBefore), { message: 'RECOVERY_NATIVE_COMPARE_COLUMNS' });
  await restored.transaction((tx) => tx.query('ALTER TABLE cb_record_revisions ALTER COLUMN private_note SET NOT NULL'));
  compareFingerprint(await fingerprint(restored), dbBefore);
  compareFingerprint(await fingerprint(source), dbBefore);
  report('recovery verifier rejects weakened CHECK public clinical grants and removed NOT NULL without changing source');

  const serving = servingFile(uploads), candidatePath = join(targetStore.root, `${candidateKey}.blob`);
  await writeFile(candidatePath, Buffer.from('SYNTHETIC-CORRUPT-CANDIDATE'));
  await assert.rejects(targetStore.openVerified(serving.object_key, serving), { code: 'CONTENT_UNAVAILABLE' });
  const originalHandle = await targetStore.openVerified(sourceKey, original); await originalHandle.close();
  report('restored serving candidate corruption fails closed and healthy original never becomes serving fallback');

  const corruptOptions = { ...options, runId: randomUUID() };
  const authenticDump = await collect(reader.stream('database.pgcustom'));
  assert.ok(authenticDump.length > 1024);
  await createRecoveryBundle({ ...corruptOptions, entries: [entry('snapshot.json', Buffer.from('{}')),
    entry('database.pgcustom', authenticDump.subarray(0, authenticDump.length - 256))] });
  const corruptReader = await openRecoveryBundle(corruptOptions);
  try { await assert.rejects(restore(config, incompleteLease.name, corruptReader.stream('database.pgcustom')), { message: 'RECOVERY_NATIVE_PROCESS' }); }
  finally { await corruptReader.close(); }
  assert.equal((await incomplete.transaction((tx) => tx.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'"))).rows[0].count, 0);
  compareFingerprint(await fingerprint(source), dbBefore);
  report('native failed restore leaves fresh target empty source unchanged and no operating cutover');

  const archivePath = join(options.directory, `${options.runId}.cbb`), archive = await readFile(archivePath);
  await reader.close(); reader = undefined; archive[70] ^= 1; await writeFile(archivePath, archive);
  await assert.rejects(openRecoveryBundle(options), { message: 'RECOVERY_BUNDLE_UNAVAILABLE' });
  compareFingerprint(await fingerprint(source), dbBefore);
  report('tampered completed bundle is rejected before any SQL or private file restore begins');
  // Demonstrate the actual rollback hazard AFTER the original nine preservation
  // checks. Only synthetic source auth state is now changed, deliberately.
  await sourceAuth.logout(oldSession.token);
  await sourceAuth.revokeInvitation(manager,{ centerId:manager.centerId,invitationId:oldInvitation.id });
  await source.transaction((tx) => tx.query('UPDATE cb_users SET active=false WHERE id=$1',[guardian.userId]));
  const latestSource = await fingerprint(source), restoredAuth = new Auth(restored,authOptions);
  assert.equal(await sourceAuth.authenticate(oldSession.token),null);
  assert.equal((await restoredAuth.authenticate(oldSession.token)).userId,guardian.userId);
  const targetSession = await restoredAuth.login({ email:'guardian.synthetic-recovery@example.invalid',password });
  const quarantineRequest = { operationId:randomUUID(),bundleId:options.runId,sourceReceipt:sourceLease,targetReceipt:targetLease,confirmTarget:targetLease.name };
  await assert.rejects(quarantineRestoredDatabase(source,quarantineRequest),{ code:'RECOVERY_QUARANTINE_TARGET_MISMATCH' });
  await assert.rejects(quarantineRestoredDatabase(restored,{ ...quarantineRequest,targetReceipt:{ ...targetLease,oid:targetLease.oid+1 } }),{ code:'RECOVERY_QUARANTINE_TARGET_MISMATCH' });
  await assert.rejects(restored.transaction(async (tx) => {
    await tx.query('SET LOCAL ROLE carebridge_recovery_app');
    return quarantineRestoredDatabase({ transaction:(work) => work(tx) },quarantineRequest);
  }),{ code:'RECOVERY_QUARANTINE_TARGET_MISMATCH' });
  report('old restored credentials remain valid after synthetic source revocation and wrong targets or runtime roles are refused');

  const beforeQuarantine = await fingerprint(restored);
  const activeUsersBeforeQuarantine = (await restored.transaction(tx => tx.query(
    'SELECT count(*)::integer AS count FROM public.cb_users WHERE active'))).rows[0].count;
  assert.equal(activeUsersBeforeQuarantine,6);
  const interrupted = { transaction:(work) => restored.transaction((tx) => work({ query:(sql,params) => {
    if (sql.startsWith('INSERT INTO public.cb_recovery_quarantine')) throw new Error('synthetic interruption');
    return tx.query(sql,params);
  } })) };
  await assert.rejects(quarantineRestoredDatabase(interrupted,quarantineRequest),{ code:'RECOVERY_QUARANTINE_UNAVAILABLE' });
  compareFingerprint(await fingerprint(restored),beforeQuarantine);
  report('actual quarantine interruption rolls back disabled users sessions invitations and receipt together');

  let attempts = 0;
  const lostCommit = { async transaction(work) { attempts++; await restored.transaction(work); throw new Error('synthetic lost acknowledgement'); } };
  await assert.rejects(quarantineRestoredDatabase(lostCommit,quarantineRequest),{ code:'RECOVERY_QUARANTINE_UNAVAILABLE' });
  assert.equal(attempts,1);
  const quarantineReceipt = await quarantineRestoredDatabase(restored,quarantineRequest);
  assert.equal(quarantineReceipt.replayed,true); assert.equal(quarantineReceipt.disabledUsers,activeUsersBeforeQuarantine);
  assert.equal(quarantineReceipt.revokedSessions,2); assert.equal(quarantineReceipt.revokedInvitations,1);
  await assert.rejects(quarantineRestoredDatabase(restored,{ ...quarantineRequest,bundleId:randomUUID() }),{ code:'RECOVERY_QUARANTINE_CONFLICT' });
  assert.equal(await restoredAuth.authenticate(oldSession.token),null);
  assert.equal(await restoredAuth.authenticate(targetSession.token),null);
  await assert.rejects(restoredAuth.acceptInvitation({ token:oldInvitation.token,password }),{ code:'INVITATION_INVALID' });
  report('unknown commit is never retried and explicit receipt replay confirms old sessions and pending invitations closed');

  const preservedTables = ['cb_account_security_events','cb_records','cb_record_revisions','cb_messages','cb_participants','cb_media_objects',
    'cb_media_uploads','cb_media_preparations','cb_media_work_queue','cb_decoder_jobs','cb_decoder_engines',
    'cb_message_reviews','cb_message_review_requests','cb_message_text_heads','cb_message_text_revisions',
    'cb_care_recipient_links','cb_primary_communicators','cb_primary_communicator_requests'];
  const expectedPreserved = beforeQuarantine.data.filter((row) => preservedTables.includes(row.name));
  const restoredJournal = new DecoderJobJournal(restored,journalOptions);
  for (const work of [() => restoredJournal.heartbeat(oldJob),() => restoredJournal.take(oldJob.run),
    () => restoredJournal.reserve(randomUUID()),() => restoredJournal.attach(oldJob,'a'.repeat(64))])
    await assert.rejects(work(),{ code:'SCAN_UNAVAILABLE' });
  assert.equal(await restored.transaction(nextMediaWork),null);
  for (const sql of ["UPDATE cb_media_uploads SET state='inspecting',version=version+1 WHERE id=$1",
    "UPDATE cb_media_work_queue SET state='running',attempts=attempts+1 WHERE upload_id=$1",
    'UPDATE cb_media_preparations SET derivative_size=derivative_size',
    'UPDATE cb_recovery_quarantine SET disabled_users=0','DELETE FROM cb_recovery_quarantine',
    'TRUNCATE cb_recovery_quarantine','TRUNCATE cb_users CASCADE'])
    await assert.rejects(restored.transaction((tx) => tx.query(sql,sql.includes('$1') ? [queuedId] : undefined)),{ code:'23514' });
  // These changes satisfy the ordinary 022 rules. Only quarantine should block
  // them; testing already-illegal receipt UPDATE alone would be a false proof.
  await assert.rejects(restored.transaction(tx => tx.query(`UPDATE cb_message_reviews
    SET review_version=review_version+1 WHERE message_id=$1`, [reviewedMessage.id])), { code: '23514' });
  await assert.rejects(restored.transaction(tx => tx.query(`INSERT INTO cb_message_review_requests
    (center_id,conversation_id,actor_id,client_id,request_hash,message_id,message_revision,review_version)
    SELECT center_id,conversation_id,reviewer_id,'synthetic-quarantine-review',repeat('c',64),message_id,message_revision,review_version
    FROM cb_message_reviews WHERE message_id=$1`, [reviewedMessage.id])), { code: '23514' });
  for (const table of ['cb_message_reviews', 'cb_message_review_requests'])
    await assert.rejects(restored.transaction(tx => tx.query(`TRUNCATE ${table}`)), { code: '23514' });
  const preservedAfter = (await fingerprint(restored)).data.filter((row) => preservedTables.includes(row.name));
  assert.deepEqual(preservedAfter,expectedPreserved);
  await verifyQuarantinedRecoveryRecipientFixture({ owner:restored,fixture:recipientFixture,fingerprint });
  report('old journal queue upload and proof mutations are fenced without resetting attempts generations or clinical history');

  await restored.close(); restored = databaseFromPool(new Pool({ ...config,database:targetLease.name }));
  const reconnectAuth = new Auth(restored,authOptions);
  assert.equal(await reconnectAuth.authenticate(oldSession.token),null);
  await assert.rejects(reconnectAuth.login({ email:'guardian.synthetic-recovery@example.invalid',password }),{ code:'AUTH_INVALID' });
  await assert.rejects(new Conversations(restored).list(guardian,{ conversationId:room }),{ code:'NOT_FOUND' });
  await assert.rejects(new Records(restored).get(therapist,{ conversationId:room,recordId }),{ code:'NOT_FOUND' });
  await assert.rejects(restored.transaction(async (tx) => {
    await tx.query('SET LOCAL ROLE carebridge_recovery_app');
    // No SELECT/EXECUTE rights to the real gate. A look-alike temporary table
    // must not mask the trigger-only, fully qualified SECURITY DEFINER lookup.
    await tx.query('CREATE TEMP TABLE cb_recovery_quarantine(singleton boolean)');
    await tx.query("SET LOCAL search_path=pg_temp,public,pg_catalog");
    await tx.query('UPDATE public.cb_users SET active=true WHERE id=$1',[guardian.userId]);
  }),{ code:'23514' });
  const gateRights = await restored.transaction((tx) => tx.query(`SELECT has_table_privilege('carebridge_recovery_app','public.cb_recovery_quarantine','SELECT') AS read_gate,
    has_function_privilege('carebridge_recovery_app','public.cb_recovery_write_guard()','EXECUTE') AS call_guard`));
  assert.deepEqual(gateRights.rows[0],{ read_gate:false,call_guard:false });
  await verifyQuarantinedRecoveryRecipientFixture({ owner:restored,fixture:recipientFixture,fingerprint });
  compareFingerprint(await fingerprint(source),latestSource);
  report('reconnected services remain closed and restricted runtime temp shadowing cannot reactivate restored users');
  console.log('Native recovery integration: 14 scenarios passed.');
} catch (error) {
  failed = true; console.error('RECOVERY_NATIVE_FAILED');
  if (error?.code === 'ERR_ASSERTION') {
    const line=error.stack?.match(/recovery-native-test\.mjs:(\d{1,5}):\d+/)?.[1];
    if (line) console.error(`RECOVERY_NATIVE_ASSERTION_LINE_${line}`); // No actual/expected values or secrets.
  }
  if (/^RECOVERY_NATIVE_(COMPARE|SCHEMA|CONSTRAINT)_[A-Z_]{1,20}$/.test(error?.message ?? '')) console.error(error.message);
  if (/^[A-Z0-9]{5}$/.test(error?.code ?? '')) console.error(`RECOVERY_NATIVE_SQLSTATE_${error.code}`);
}
finally {
  try { await reader?.close(); } catch { failed = true; }
  key?.fill(0);
  const closed = await Promise.allSettled([source?.close(), restored?.close(), incomplete?.close()]);
  try {
    if (closed.some((r) => r.status === 'rejected')) throw new Error('RECOVERY_NATIVE_CLEANUP');
    for (const lease of [sourceLease, targetLease, incompleteLease].filter(Boolean)) await dropDisposableDatabase(admin, lease);
    if (root) {
      const actual = await lstat(root);
      if (resolve(root) !== root || !root.startsWith(join(tmpdir(), 'carebridge-recovery-native-')) ||
          actual.isSymbolicLink() || actual.ino !== rootIdentity.ino || actual.dev !== rootIdentity.dev) throw new Error('RECOVERY_NATIVE_CLEANUP');
      await rm(root, { recursive: true });
    }
  } catch { failed = true; console.error('RECOVERY_NATIVE_CLEANUP_FAILED'); }
  try { await admin?.end(); } catch { failed = true; }
  if (failed) process.exitCode = 1;
}

// Fresh synthetic Windows/E SQL fixture ONLY. Scanner/decoder protocol peers
// are deliberate doubles, NOT native AV/decoder or operating acceptance.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {DecoderJobJournal} from './decoder-journal.mjs';
import {MediaUploads} from './media-uploads.mjs';
import {createMediaWorkerService} from './media-worker-service.mjs';
import {databaseForService} from './database-privileges.mjs';
import {MediaAccess} from './media-access.mjs';
import {Conversations} from './conversations.mjs';
import {Relationships} from './relationships.mjs';
import {configureSyntheticMediaPolicy} from './media-resource-test-policy.mjs';
import {syntheticPng} from './image-metadata-test-fixtures.mjs';
import {candidate,hash,collect} from './tests/media-storage-fixtures.mjs';
import {fakePreparation,fakeClam,engine,image} from './tests/media-preparation-fixtures.mjs';
import {SYNTHETIC_DB_ROLES,syntheticPrivilegeInput} from './database-privileges-native-check.mjs';

const denied = (db,sql,params) => assert.rejects(db.transaction((tx) => tx.query(sql,params)),{code:'42501'});
const input = (row) => ({conversationId:row.conversationId,uploadId:row.id,expectedVersion:row.version});
export async function exerciseWorkerDatabasePrivileges({owner,runtime,worker,store}) {
  let phase = 101,clam; const checks = [];
  try {
    const privileges = await syntheticPrivilegeInput(owner),workerDatabase = databaseForService(worker,privileges,'worker');
    const centerId = 'synthetic-role-center',conversationId = 'synthetic-role-room';
    const {rows:members} = await owner.transaction((tx) => tx.query('SELECT user_id,role FROM cb_memberships WHERE center_id=$1',[centerId]));
    const actor = (role) => {
      const matches = members.filter((row) => row.role === role); assert.equal(matches.length,1);
      return {centerId,userId:matches[0].user_id};
    };
    const guardian = actor('guardian'),therapist = actor('therapist'),manager = actor('center');
    await owner.transaction((tx) => configureSyntheticMediaPolicy(tx,centerId));
    const config = {engineIdentity:'synthetic-role-worker-engine',approvedImageId:'sha256:'+'b'.repeat(64)};
    const journal = new DecoderJobJournal(workerDatabase,config),run = randomUUID();
    await journal.reserve(run); const taken = await journal.take(run); await journal.close(taken);
    assert.equal((await journal.lookup(run)).phase,'closed');
    await assert.rejects(new DecoderJobJournal(runtime,config).reserve(randomUUID()),{code:'SCAN_UNAVAILABLE'});
    await denied(runtime,'SELECT * FROM cb_decoder_jobs'); await denied(runtime,'SELECT * FROM cb_decoder_engines');
    await denied(runtime,'INSERT INTO cb_media_preparations SELECT * FROM cb_media_preparations WHERE false');
    await denied(runtime,"SELECT cb_media_clean_scan(NULL::jsonb,0,''::text)");
    checks.push('worker-only journal reserve/recovery/close succeeds; app cannot access journal or create approval evidence');

    phase = 102;
    const bytes = syntheticPng(),file = {name:'synthetic-role-worker.png',type:'image/png',size:bytes.length,sha256:hash(bytes)};
    const expected = candidate(bytes).bytes,uploads = new MediaUploads(runtime,store); let number = 0;
    const receive = async () => {
      const pending = await uploads.reserve(guardian,{conversationId,clientId:`synthetic-worker-upload-${++number}`,file});
      const received = await uploads.receive(guardian,input(pending),Readable.from([bytes],{objectMode:false}));
      assert.equal(received.state,'quarantined'); return received;
    };
    const fake = fakePreparation(); clam = await fakeClam();
    const composition = {privileges,store,scanner:clam.scanner,runtime:fake.runtime,
      engineIdentity:engine,approvedImageId:image,capacity:1,pollMilliseconds:50};
    for (const database of [owner,runtime])
      await assert.rejects(createMediaWorkerService({...composition,database}),{code:'MEDIA_WORKER_UNAVAILABLE'});
    assert.equal(fake.calls.length,0); assert.equal(clam.scans.length,0);
    const coordinator = await createMediaWorkerService({...composition,database:worker});
    assert.equal(coordinator.status.state,'new'); assert.equal(fake.calls.length,0); assert.equal(clam.scans.length,0);
    const service = new MediaUploads(workerDatabase,store);
    const received = await receive(),result = await coordinator.runOne();
    assert.equal(result.status,'processed'); assert.equal(result.upload.id,received.id); assert.equal(result.upload.state,'ready');
    assert.equal(fake.calls.filter((args) => args[0] === 'create').length,1); assert.equal(fake.containers.size,0);
    assert.deepEqual(clam.scans,[bytes,expected]);
    const {rows:jobs} = await workerDatabase.transaction((tx) => tx.query('SELECT phase FROM cb_decoder_jobs WHERE engine_id=$1',[engine]));
    assert.deepEqual(jobs,[{phase:'closed'}]);
    const message = await new Conversations(runtime).sendText(guardian,{conversationId,clientId:'synthetic-worker-bound-01',body:'가상 권한 검증 첨부',attachments:[{id:received.id}]});
    const opened = await new MediaAccess(runtime,store).open(therapist,{conversationId,uploadId:received.id,source:{kind:'message',messageId:message.id}});
    assert.deepEqual(await collect(opened.stream),expected);
    const bound = (await owner.transaction((tx) => tx.query('SELECT state,object_key,candidate_key FROM cb_media_uploads WHERE id=$1',[received.id]))).rows[0];
    assert.equal(bound.state,'bound'); await service.cleanup();
    for (const [key,manifest] of [[bound.object_key,file],[bound.candidate_key,{type:file.type,size:expected.length,sha256:hash(expected)}]]) {
      const handle = await store.openVerified(key,manifest); await handle.close();
    }
    checks.push('guarded worker composition completes synthetic scanner/decoder protocol with durable journal; app binds/reads exact derivative and bound files survive cleanup');

    phase = 103;
    const missing = new MediaUploads(workerDatabase,store),queued = await receive(),unavailable = await missing.inspectNext();
    assert.equal(unavailable.status,'processed'); assert.equal(unavailable.upload.id,queued.id);
    assert.equal(unavailable.upload.state,'quarantined'); assert.equal(unavailable.upload.failureCode,'SCAN_UNAVAILABLE');
    const job = (await owner.transaction((tx) => tx.query('SELECT state,attempts FROM cb_media_work_queue WHERE upload_id=$1',[queued.id]))).rows[0];
    assert.deepEqual(job,{state:'retry',attempts:1});
    await uploads.cancel(guardian,input(unavailable.upload)); const removed = await missing.cleanup();
    assert.equal(removed.failed,0); assert.ok(removed.removed >= 2);
    assert.equal((await owner.transaction((tx) => tx.query('SELECT state FROM cb_media_uploads WHERE id=$1',[queued.id]))).rows[0].state,'deleted');
    const disconnected = await receive(),relations = new Relationships(runtime),before = await relations.get(manager,{conversationId});
    await relations.replace(manager,{conversationId,clientId:'synthetic-worker-disconnect-01',expectedVersion:before.version,historyConfirmed:true,
      therapist:{userId:therapist.userId,history:'all'},guardians:[]});
    assert.equal(await missing.claimNextInspection(),null);
    assert.deepEqual((await owner.transaction((tx) => tx.query('SELECT state,attempts FROM cb_media_work_queue WHERE upload_id=$1',[disconnected.id]))).rows[0],{state:'queued',attempts:0});
    assert.equal((await owner.transaction((tx) => tx.query('SELECT count(*)::integer AS count FROM cb_media_preparations WHERE upload_id=$1',[disconnected.id]))).rows[0].count,0);
    checks.push('missing preparation stays quarantined/retry, cancellation cleans owned candidates, and disconnected owner cannot consume an inspection attempt');

    phase = 104;
    for (const table of ['cb_account_security_events','cb_auth_accounts','cb_auth_sessions','cb_auth_invitations','cb_auth_audit_events','cb_center_bootstraps',
      'cb_schema_migrations','cb_recovery_quarantine','cb_messages','cb_record_revisions','cb_record_assessments','cb_feedback_revisions',
      'cb_message_reviews','cb_feedback_reviews','cb_child_profiles','cb_child_family_plans','cb_member_profiles','cb_media_work_reviews'])
      await denied(worker,`SELECT * FROM public.${table}`);
    for (const sql of [
      'SELECT last_sequence FROM cb_conversations',
      'INSERT INTO cb_media_uploads SELECT * FROM cb_media_uploads WHERE false',
      'UPDATE cb_media_uploads SET name=name WHERE false','UPDATE cb_media_uploads SET sha256=sha256 WHERE false',
      'UPDATE cb_media_uploads SET bound_message_id=bound_message_id WHERE false',
      'UPDATE cb_media_uploads SET expires_at=expires_at WHERE false',
      'UPDATE cb_media_work_queue SET approved_retries=approved_retries WHERE false',
      'UPDATE cb_media_resource_limits SET storage_bytes=storage_bytes WHERE false',
      'UPDATE cb_participants SET active=active WHERE false','UPDATE cb_memberships SET role=role WHERE false',
      'UPDATE cb_users SET active=active WHERE false','UPDATE cb_conversations SET last_sequence=last_sequence WHERE false',
      'UPDATE cb_media_preparations SET evidence=evidence WHERE false','DELETE FROM cb_media_events WHERE false',
      "SELECT nextval('cb_audit_events_id_seq')","SELECT cb_valid_draft_assessments('[]'::jsonb)",
      'CREATE TABLE public.cb_worker_denied(id integer)','CREATE TEMP TABLE cb_worker_denied(id integer)',
      'TRUNCATE cb_media_objects',`SET ROLE ${SYNTHETIC_DB_ROLES.owner}`,`SET ROLE ${SYNTHETIC_DB_ROLES.runtime}`,
      "COPY (SELECT 1) TO PROGRAM 'carebridge-never-execute'","SELECT pg_read_file('carebridge-never-read')",
    ]) await denied(worker,sql);
    checks.push('worker cannot read credentials/sessions/messages/clinical content or change manifests/bindings/retry approvals/resource budgets/relationships/schema/roles/OS');
    expected.fill(0); bytes.fill(0); return checks;
  } catch {
    const error = new Error('DATABASE_WORKER_PRIVILEGE_NATIVE_CHECK_FAILED'); error.roleCheckPhase = phase; throw error;
  } finally { await clam?.close(); }
}

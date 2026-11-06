// Called only by the fresh Windows/E fixture. Generated synthetic credentials
// and already-owned DB objects only; not an operating provision/start command.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Auth} from './auth.mjs';
import {Children} from './profiles.mjs';
import {Relationships} from './relationships.mjs';
import {Conversations} from './conversations.mjs';
import {Records} from './records.mjs';
import {migrate} from './migrate.mjs';
import {configureDatabasePrivileges,verifyDatabasePrivileges} from './database-privileges.mjs';
import {DATABASE_TABLES,databasePrivilegePlan} from './database-privilege-policy.mjs';

export const SYNTHETIC_DB_ROLES = Object.freeze({owner:'carebridge_fixture_owner',runtime:'carebridge_fixture_runtime',
  bootstrap:'carebridge_fixture_bootstrap',backup:'carebridge_fixture_backup',worker:'carebridge_fixture_worker'});
export async function syntheticPrivilegeInput(owner) {
  const {rows} = await owner.transaction((tx) => tx.query(`SELECT datname,oid::bigint AS oid,datdba::bigint AS owner_oid
    FROM pg_catalog.pg_database WHERE datname=current_database()`));
  return {roles:SYNTHETIC_DB_ROLES,target:{name:rows[0].datname,confirm:rows[0].datname,oid:Number(rows[0].oid),ownerOid:Number(rows[0].owner_oid)}};
}
// A non-CREATE pg_restore does not apply the database's own ACL. This fixture
// deliberately restores as the non-superuser owner into an already-created DB;
// reapply ONLY the reviewed DB connection boundary, not missing object grants.
// Object/column/function/default ACL preservation must pass verification as-is.
export async function restoreSyntheticDatabaseConnectionPrivileges(owner) {
  const input = await syntheticPrivilegeInput(owner), plan = databasePrivilegePlan(input);
  const statements = plan.statements.filter((sql) => /^(REVOKE ALL|GRANT CONNECT) ON DATABASE /.test(sql));
  assert.equal(statements.length,5);
  await owner.transaction(async (tx) => {
    const {rows} = await tx.query(`SELECT has_database_privilege($1,current_database(),'CONNECT') AS connect,
      has_database_privilege($1,current_database(),'TEMPORARY') AS temporary`,[SYNTHETIC_DB_ROLES.runtime]);
    assert.equal(rows[0].connect,true); assert.equal(rows[0].temporary,true);
    for (const sql of statements) await tx.exec(sql);
  });
}
const sqlDenied = (db,sql,params) => assert.rejects(db.transaction((tx) => tx.query(sql,params)),{code:'42501'});
const policyDenied = (work) => assert.rejects(work,{message:'DATABASE_PRIVILEGES_UNAVAILABLE'});
export async function exerciseDatabasePrivileges({owner,runtime,bootstrap,backup,worker,admin,observerConnect}) {
  const checks = [], input = await syntheticPrivilegeInput(owner); let phase = 1;
  try {
    const applied = await configureDatabasePrivileges(owner,input);
    assert.deepEqual(applied,{applied:true,policyVersion:7,roleCount:5,tableCount:66,functionCount:57});
    assert.deepEqual(await configureDatabasePrivileges(owner,input),applied);
    assert.equal((await verifyDatabasePrivileges(owner,input)).verified,true);
    checks.push('non-superuser direct owner applies/replays reviewed grants; all role/table/column/function/sequence capabilities verified');
    phase = 2;
    const centerId = 'synthetic-role-center', password = 'synthetic-role-password-'+randomUUID();
    const bootstrapInput = {operationId:randomUUID(),centerId,confirmNewCenter:centerId,email:'synthetic.manager@example.com',password};
    const operatorAuth = new Auth(bootstrap), manager = await operatorAuth.bootstrapNewCenter(bootstrapInput);
    const before = (await owner.transaction((tx) => tx.query('SELECT to_jsonb(a) AS account FROM cb_auth_accounts a WHERE user_id=$1',[manager.userId]))).rows;
    const replay = await operatorAuth.bootstrapNewCenter(bootstrapInput);
    assert.equal(replay.userId,manager.userId); assert.equal(replay.replayed,true);
    assert.deepEqual((await owner.transaction((tx) => tx.query('SELECT to_jsonb(a) AS account FROM cb_auth_accounts a WHERE user_id=$1',[manager.userId]))).rows,before);
    checks.push('separate bootstrap role creates one synthetic manager/center and replays without changing credentials');
    phase = 3;
    const auth = new Auth(runtime), session = await auth.login({email:bootstrapInput.email,password});
    const members = {};
    for (const role of ['guardian','therapist']) {
      const invitation = await auth.createInvitation(session.user,{centerId,email:`synthetic.${role}@example.com`,role});
      const accepted = await auth.acceptInvitation({token:invitation.token,password}); members[role] = accepted.user;
    }
    const actor = {centerId,userId:manager.userId}, conversationId = 'synthetic-role-room';
    await new Children(runtime).register(actor,{childId:'synthetic-role-child',conversationId,clientId:'synthetic-role-register-01',
      content:{name:'가상 권한 검증 아동',age:3,ageAsOf:'2026-10-07'}});
    const relation = new Relationships(runtime), initial = await relation.get(actor,{conversationId});
    await relation.replace(actor,{conversationId,clientId:'synthetic-role-participants-01',expectedVersion:initial.version,historyConfirmed:true,pastHistoryConfirmed:true,
      therapist:{userId:members.therapist.userId,history:'all'},guardians:[{userId:members.guardian.userId,history:'all'}]});
    const chat = new Conversations(runtime);
    const guardianActor={centerId,userId:members.guardian.userId},therapistActor={centerId,userId:members.therapist.userId};
    const sent=await chat.sendText(guardianActor,{conversationId,clientId:'synthetic-role-news-0001',body:'가상 권한 검증 소식'});
    assert.equal((await chat.get(guardianActor,{conversationId,messageId:sent.id})).read,false);
    await chat.markRead(therapistActor,{conversationId,messageId:sent.id});
    assert.equal((await chat.get(guardianActor,{conversationId,messageId:sent.id})).read,true);
    assert.ok((await chat.list({centerId,userId:members.therapist.userId},{conversationId})).messages.length > 0);
    await assert.rejects(chat.list(actor,{conversationId}),{code:'NOT_FOUND'});
    await owner.transaction(tx=>tx.query(`INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ($1,$2,'synthetic-source-goal','가상 목표','active')`,[centerId,conversationId]));
    const clinical=new Records(runtime);await clinical.save(therapistActor,{conversationId,recordId:'synthetic-source-record',clientId:randomUUID(),expectedRevision:0,
      content:{date:'2026-10-08',goalId:'synthetic-source-goal',performed:'가상 관찰',referenceMessageIds:[sent.id],referenceTextRevisions:[{messageId:sent.id,revision:1}]}});
    await chat.editText(guardianActor,{conversationId,messageId:sent.id,clientId:randomUUID(),expectedRevision:1,body:'가상 수정 소식'});
    await chat.deleteText(guardianActor,{conversationId,messageId:sent.id,clientId:randomUUID(),expectedRevision:2,scope:'all',confirmed:true});
    await chat.deleteText(therapistActor,{conversationId,messageId:sent.id,clientId:randomUUID(),scope:'self',confirmed:true});
    assert.equal((await clinical.get(therapistActor,{conversationId,recordId:'synthetic-source-record'})).referenceSources[0].body,'가상 권한 검증 소식');
    for(const table of ['cb_message_text_revisions','cb_message_hides','cb_message_reply_versions','cb_message_change_requests','cb_record_text_sources']){
      await sqlDenied(runtime,`UPDATE ${table} SET center_id=center_id WHERE false`);
      await sqlDenied(runtime,`DELETE FROM ${table} WHERE false`);
      for(const service of [bootstrap,worker])await sqlDenied(service,`SELECT * FROM ${table}`);
    }
    await sqlDenied(runtime,'UPDATE cb_message_text_heads SET message_id=message_id WHERE false');
    const guardianSession = await auth.login({email:'synthetic.guardian@example.com',password}), changedPassword = password+'-changed';
    assert.deepEqual(await auth.changePassword(guardianSession.token,{currentPassword:password,newPassword:changedPassword}),
      {passwordChanged:true,reauthenticate:true});
    assert.equal(await auth.authenticate(guardianSession.token),null);
    const changedSession = await auth.login({email:'synthetic.guardian@example.com',password:changedPassword});
    assert.equal(await auth.revokeAll(changedSession.user.userId),1);
    assert.equal(await auth.revokeAll(changedSession.user.userId),0);
    const events = await owner.transaction((tx) => tx.query(`SELECT action,revoked_sessions FROM cb_account_security_events
      WHERE user_id=$1 ORDER BY occurred_at,id`,[members.guardian.userId]));
    assert.deepEqual(events.rows,[{action:'password.changed',revoked_sessions:2},{action:'sessions.revoked',revoked_sessions:1}]);
    for (const sql of ['SELECT * FROM cb_account_security_events','UPDATE cb_account_security_events SET user_id=user_id WHERE false',
      'DELETE FROM cb_account_security_events WHERE false','TRUNCATE cb_account_security_events']) await sqlDenied(runtime,sql);
    const otherSessions = await owner.transaction((tx) => tx.query(`SELECT token_hash,user_id,revoked_at FROM cb_auth_sessions
      WHERE user_id<>$1 ORDER BY token_hash`,[members.guardian.userId]));
    const recovery = await auth.preparePasswordRecovery({email:'synthetic.guardian@example.com'});
    assert.ok(recovery);
    assert.equal(recovery.email,'synthetic.guardian@example.com');
    assert.deepEqual(Object.keys(recovery),['expiresAt']);
    const recoveredPassword = changedPassword+'-recovered';
    assert.deepEqual(await auth.completePasswordRecovery({token:recovery.token,newPassword:recoveredPassword,confirmation:recoveredPassword}),
      {passwordChanged:true,reauthenticate:true});
    const recoveryEvents = await owner.transaction((tx) => tx.query(`SELECT action,revoked_sessions FROM cb_account_security_events
      WHERE user_id=$1 AND action='password.recovered'`,[members.guardian.userId]));
    assert.deepEqual(recoveryEvents.rows,[{action:'password.recovered',revoked_sessions:0}]);
    await assert.rejects(auth.login({email:'synthetic.guardian@example.com',password:changedPassword}),{code:'AUTH_INVALID'});
    const recoveredSession = await auth.login({email:'synthetic.guardian@example.com',password:recoveredPassword});
    assert.equal(recoveredSession.user.userId,members.guardian.userId);
    assert.equal((await auth.authenticate(recoveredSession.token)).userId,members.guardian.userId);
    assert.equal((await auth.authenticate(session.token)).userId,manager.userId);
    assert.deepEqual((await owner.transaction((tx) => tx.query(`SELECT token_hash,user_id,revoked_at FROM cb_auth_sessions
      WHERE user_id<>$1 ORDER BY token_hash`,[members.guardian.userId]))).rows,otherSessions.rows);
    for (const column of ['consumed_at','revoked_at']) {
      const tokenHash = createHash('sha256').update(randomUUID()).digest('hex');
      await runtime.transaction(async (tx) => {
        await tx.query(`INSERT INTO cb_auth_password_resets(token_hash,user_id,expires_at)
          VALUES ($1,$2,clock_timestamp()+interval '5 minutes')`,[tokenHash,members.guardian.userId]);
        const {rows} = await tx.query(`UPDATE cb_auth_password_resets SET ${column}=clock_timestamp()
          WHERE token_hash=$1 RETURNING ${column} IS NOT NULL AS closed`,[tokenHash]);
        assert.deepEqual(rows,[{closed:true}]);
      });
    }
    for (const column of ['token_hash','user_id','created_at','expires_at'])
      await sqlDenied(runtime,`UPDATE cb_auth_password_resets SET ${column}=${column} WHERE false`);
    for (const sql of ['DELETE FROM cb_auth_password_resets WHERE false','TRUNCATE cb_auth_password_resets'])
      await sqlDenied(runtime,sql);
    for (const service of [bootstrap,worker]) await sqlDenied(service,'SELECT * FROM cb_auth_password_resets');
    checks.push('non-owner runtime preserves clinical history and other users sessions; password recovery reauthenticates with retained zero-session event and restricted reset columns');
    phase = 4;
    await assert.rejects(auth.bootstrapNewCenter({...bootstrapInput,centerId:'synthetic-denied-center',confirmNewCenter:'synthetic-denied-center'}),{code:'BOOTSTRAP_FORBIDDEN'});
    for (const table of ['cb_center_bootstraps','cb_recovery_quarantine','cb_schema_migrations','cb_decoder_engines','cb_decoder_jobs']) await sqlDenied(runtime,`SELECT * FROM public.${table}`);
    for (const sql of ["CREATE TABLE public.cb_policy_denied(id integer)","CREATE TEMP TABLE cb_policy_denied(id integer)",
      "ALTER TABLE cb_messages ADD COLUMN synthetic_denied text","ALTER TABLE cb_messages DISABLE TRIGGER ALL",
      "TRUNCATE cb_messages","DELETE FROM cb_audit_events WHERE false",`SET ROLE ${SYNTHETIC_DB_ROLES.owner}`,
      "CREATE ROLE cb_policy_denied","COPY (SELECT 1) TO PROGRAM 'carebridge-never-execute'",
      "SELECT pg_read_file('carebridge-never-read')"]) await sqlDenied(runtime,sql);
    await assert.rejects(migrate(runtime),{code:'42501'});
    checks.push('runtime cannot bootstrap/read operator tables/migrate/DDL/temp/truncate/erase audit/escalate role/run OS commands/read server files');
    phase = 5;
    for (const sql of ['SELECT * FROM cb_account_security_events','SELECT * FROM cb_messages','SELECT * FROM cb_record_revisions','SELECT * FROM cb_auth_sessions',
      'SELECT * FROM cb_auth_invitations','UPDATE cb_auth_accounts SET password_hash=password_hash WHERE false',
      'UPDATE cb_users SET active=active WHERE false','UPDATE cb_memberships SET role=role WHERE false']) await sqlDenied(bootstrap,sql);
    for (const table of DATABASE_TABLES) await backup.transaction((tx) => tx.query(`SELECT count(*) FROM public.${table}`));
    for (const sql of ['UPDATE cb_users SET active=active WHERE false','INSERT INTO cb_centers SELECT id FROM cb_centers WHERE false',
      'TRUNCATE cb_messages','INSERT INTO cb_account_security_events SELECT * FROM cb_account_security_events WHERE false',
      "SELECT nextval('cb_audit_events_id_seq')","SELECT cb_media_lock_resources('synthetic-role-center')"]) await sqlDenied(backup,sql);
    checks.push('bootstrap cannot read clinical session or security event data or change credentials, backup reads all 66 reviewed tables without write or helper access');
    phase = 6;
    await assert.rejects(observerConnect(),{code:'42501'});
    await owner.transaction(async (tx) => {
      await tx.exec('CREATE TABLE public.cb_policy_future_probe(id integer)');
      await tx.exec('CREATE FUNCTION public.cb_policy_future_probe() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$');
    });
    try {
      for (const db of [runtime,bootstrap,backup,worker]) {
        await sqlDenied(db,'SELECT * FROM cb_policy_future_probe'); await sqlDenied(db,'SELECT cb_policy_future_probe()');
      }
      await policyDenied(verifyDatabasePrivileges(owner,input));
    } finally { await owner.transaction((tx) => tx.exec('DROP FUNCTION public.cb_policy_future_probe(); DROP TABLE public.cb_policy_future_probe')); }
    checks.push('PUBLIC cannot connect; future table/function grants remain closed and unreviewed schema is refused');
    phase = 7;
    await policyDenied(configureDatabasePrivileges(owner,{...input,target:{...input.target,oid:input.target.oid+1}}));
    await owner.transaction((tx) => tx.exec(`GRANT TRUNCATE ON public.cb_messages TO ${SYNTHETIC_DB_ROLES.runtime}`));
    try {
      await policyDenied(configureDatabasePrivileges(owner,input));
      const {rows} = await owner.transaction((tx) => tx.query('SELECT has_table_privilege($1,\'public.cb_messages\',\'TRUNCATE\') AS allowed',[SYNTHETIC_DB_ROLES.runtime]));
      assert.equal(rows[0].allowed,true); // No automatic adoption/repair.
    } finally { await owner.transaction((tx) => tx.exec(`REVOKE TRUNCATE ON public.cb_messages FROM ${SYNTHETIC_DB_ROLES.runtime}`)); }
    await admin.query(`GRANT ${SYNTHETIC_DB_ROLES.owner} TO ${SYNTHETIC_DB_ROLES.runtime}`);
    try { await policyDenied(configureDatabasePrivileges(owner,input)); }
    finally { await admin.query(`REVOKE ${SYNTHETIC_DB_ROLES.owner} FROM ${SYNTHETIC_DB_ROLES.runtime}`); }
    await sqlDenied(runtime,`SET ROLE ${SYNTHETIC_DB_ROLES.owner}`);
    checks.push('wrong target OID, excess table privilege and NOINHERIT-but-SET-ROLE membership are refused without automatic repair');
    phase = 8;
    for (const sql of [`GRANT SELECT (operation_id) ON public.cb_center_bootstraps TO ${SYNTHETIC_DB_ROLES.runtime}`,
      `GRANT UPDATE (password_hash) ON public.cb_auth_accounts TO ${SYNTHETIC_DB_ROLES.bootstrap}`,
      `GRANT SELECT (body) ON public.cb_messages TO ${SYNTHETIC_DB_ROLES.worker}`,
      `GRANT SELECT ON public.cb_decoder_jobs TO ${SYNTHETIC_DB_ROLES.runtime}`,
      `GRANT INSERT ON public.cb_media_preparations TO ${SYNTHETIC_DB_ROLES.runtime}`,
      `GRANT SELECT ON public.cb_messages TO ${SYNTHETIC_DB_ROLES.backup} WITH GRANT OPTION`]) {
      await owner.transaction((tx) => tx.exec(sql));
      try { await policyDenied(verifyDatabasePrivileges(owner,input)); await policyDenied(configureDatabasePrivileges(owner,input)); }
      finally { await owner.transaction((tx) => tx.exec(sql.replace(/^GRANT /,'REVOKE ').replace(/ TO /,' FROM ').replace(' WITH GRANT OPTION',''))); }
    }
    // Revoking the intentional grant-option test also removed the ordinary
    // SELECT grant on that one table. Add only reviewed missing access again.
    await configureDatabasePrivileges(owner,input); await verifyDatabasePrivileges(owner,input);
    await owner.transaction((tx) => tx.exec('ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC'));
    try { await policyDenied(verifyDatabasePrivileges(owner,input)); }
    finally { await owner.transaction((tx) => tx.exec('ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM PUBLIC')); }
    await verifyDatabasePrivileges(owner,input);
    checks.push('hidden column grants, onward grant options and reopened future function defaults are detected; reviewed missing access can be explicitly restored');
    return checks;
  } catch {
    const error = new Error('DATABASE_PRIVILEGE_NATIVE_CHECK_FAILED'); error.roleCheckPhase = phase; throw error;
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import { DATABASE_TABLES,DATABASE_FUNCTIONS,DATABASE_SEQUENCES,RUNTIME_HELPERS,RUNTIME_HELPER_RESULTS,databasePrivilegePlan,
  DATABASE_ROLE_KINDS,DATABASE_SERVICE_ROLE_KINDS,DATABASE_PRIVILEGE_POLICY_VERSION,
  expectedTablePrivileges,expectedUpdateColumns,expectedColumnPrivileges,expectedFunctionExecution } from '../database-privilege-policy.mjs';
import {configureDatabasePrivileges,verifyDatabasePrivileges,databaseForService} from '../database-privileges.mjs';

const input = () => ({roles:{owner:'cb_owner',runtime:'cb_runtime',bootstrap:'cb_bootstrap',backup:'cb_backup',worker:'cb_worker'},
  target:{name:'cb_synthetic',oid:12345,ownerOid:12346,confirm:'cb_synthetic'}});
const fails = (callback) => assert.throws(callback,{message:'DATABASE_PRIVILEGE_POLICY_UNAVAILABLE'});
test('reviewed inventory exactly matches 001-023 table, function and identity-sequence declarations',async () => {
  const tables = new Set(['cb_schema_migrations']), functions = new Set(), sequences = new Set();
  const files = (await readdir(new URL('../migrations/',import.meta.url))).filter((name) => name.endsWith('.sql'));
  assert.equal(files.length,23);
  for (const name of files) {
    const sql = await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');
    for (const match of sql.matchAll(/CREATE TABLE (?:public\.)?(cb_[a-z_]+)/g)) tables.add(match[1]);
    for (const match of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?(cb_[a-z_]+)/g)) functions.add(match[1]);
    for (const match of sql.matchAll(/CREATE TABLE (cb_[a-z_]+)\s*\(\s*id bigint GENERATED ALWAYS AS IDENTITY/g)) sequences.add(match[1]+'_id_seq');
  }
  assert.deepEqual([...tables].sort(),DATABASE_TABLES); assert.equal(tables.size,66);
  assert.deepEqual([...functions].sort(),DATABASE_FUNCTIONS); assert.equal(functions.size,57);
  assert.deepEqual([...sequences].sort(),DATABASE_SEQUENCES);
});
test('operator plan has five separate immutable names and an explicitly confirmed DB/OID identity',() => {
  const requested = input(), plan = databasePrivilegePlan(requested); requested.roles.runtime = 'different';
  assert.equal(plan.roles.runtime,'cb_runtime'); assert.ok(Object.isFrozen(plan.roles)); assert.ok(Object.isFrozen(plan.target)); assert.ok(Object.isFrozen(plan.statements));
  for (const invalid of [null,{}, {...input(),force:true},{...input(),target:{...input().target,confirm:'other'}},
    {...input(),roles:{...input().roles,backup:'cb_runtime'}},{...input(),roles:{...input().roles,admin:'extra'}}]) fails(() => databasePrivilegePlan(invalid));
});
test('role/database names cannot inject quoted SQL, reserved groups, network paths or unbounded identifiers',() => {
  for (const value of ['postgres','public','pg_read_all_data','Owner','cb;DROP ROLE x','cb"runtime','cb runtime','cb\nruntime','a'.repeat(64),'']) {
    const request = input(); request.roles.runtime = value; fails(() => databasePrivilegePlan(request));
    request.roles.runtime = 'cb_runtime'; request.target.name = request.target.confirm = value; fails(() => databasePrivilegePlan(request));
  }
});
test('target OIDs are positive uint32 values, not coercible strings, NaN or caller-selected fallback targets',() => {
  for (const oid of [null,'12345',0,-1,1.1,NaN,4294967296]) {
    for (const field of ['oid','ownerOid']) { const request = input(); request.target[field] = oid; fails(() => databasePrivilegePlan(request)); }
  }
});
test('ordinary runtime cannot read/write operator receipts, migration ledger, or insert centers',() => {
  for (const table of ['cb_center_bootstraps','cb_recovery_quarantine','cb_schema_migrations']) assert.deepEqual(expectedTablePrivileges('runtime',table),[]);
  assert.deepEqual(expectedTablePrivileges('runtime','cb_centers'),['SELECT']);
  assert.deepEqual(expectedUpdateColumns('runtime','cb_centers'),['schedule_version']);
});
test('normal SQL grants cannot truncate, delete retained history, add triggers or grant references/maintenance',() => {
  for (const table of DATABASE_TABLES) for (const privilege of ['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) assert.ok(!expectedTablePrivileges('runtime',table).includes(privilege));
  assert.deepEqual(DATABASE_TABLES.filter((table) => expectedTablePrivileges('runtime',table).includes('DELETE')),['cb_read_states']);
  assert.deepEqual(expectedTablePrivileges('runtime','cb_audit_events'),['INSERT']);
});

test('message histories pins hides and receipts are append-only; only the head revision column can advance',() => {
  const tables=['cb_message_text_heads','cb_message_text_revisions','cb_message_reply_versions',
    'cb_message_hides','cb_message_change_requests','cb_record_text_sources'];
  for(const table of tables){
    assert.deepEqual(expectedTablePrivileges('runtime',table),['SELECT','INSERT']);
    assert.deepEqual(expectedUpdateColumns('runtime',table),table==='cb_message_text_heads' ? ['current_revision'] : []);
    assert.deepEqual(expectedTablePrivileges('backup',table),['SELECT']);
    for(const kind of ['bootstrap','worker']){
      assert.deepEqual(expectedTablePrivileges(kind,table),[]);
      for(const permission of ['SELECT','INSERT','UPDATE','REFERENCES'])assert.deepEqual(expectedColumnPrivileges(kind,table,permission),[]);
    }
  }
  for(const fn of ['cb_message_text_revision_guard','cb_message_text_head_guard','cb_require_message_text_head',
    'cb_message_text_reference_guard','cb_require_text_reference','cb_message_hide_guard','cb_message_text_capture'])
    for(const kind of ['runtime','bootstrap','worker','backup'])assert.equal(expectedFunctionExecution(kind,fn),false);
});

test('022 private review heads can advance but their historical receipts stay append-only with no worker or bootstrap access',() => {
  const heads='cb_message_reviews',receipts='cb_message_review_requests';
  assert.ok(DATABASE_TABLES.includes(heads));assert.ok(DATABASE_TABLES.includes(receipts));
  assert.deepEqual(expectedTablePrivileges('runtime',heads),['SELECT','INSERT','UPDATE']);
  assert.deepEqual(expectedTablePrivileges('runtime',receipts),['SELECT','INSERT']);
  for(const table of [heads,receipts]){
    assert.deepEqual(expectedTablePrivileges('backup',table),['SELECT']);
    // No additional column grants can bypass the table-level restrictions.
    for(const kind of ['runtime','backup','bootstrap','worker'])for(const permission of ['SELECT','INSERT','UPDATE','REFERENCES'])
      assert.deepEqual(expectedColumnPrivileges(kind,table,permission),[]);
    for(const kind of ['bootstrap','worker'])assert.deepEqual(expectedTablePrivileges(kind,table),[]);
  }
  for(const kind of ['runtime','bootstrap','worker','backup'])
    assert.equal(expectedFunctionExecution(kind,'cb_message_review_guard'),false);
  const statements=databasePrivilegePlan(input()).statements;
  assert.ok(statements.includes(`GRANT SELECT,INSERT,UPDATE ON TABLE public.${heads} TO "cb_runtime"`));
  assert.ok(statements.includes(`GRANT SELECT,INSERT ON TABLE public.${receipts} TO "cb_runtime"`));
  for(const table of [heads,receipts]){
    assert.ok(statements.includes(`GRANT SELECT ON TABLE public.${table} TO "cb_backup"`));
    const grants=statements.filter(sql=>sql.startsWith('GRANT ')&&sql.includes(`ON TABLE public.${table} `));
    assert.equal(grants.length,2);
    assert.ok(!grants.some(sql=>/DELETE|TRUNCATE|REFERENCES|TRIGGER|MAINTAIN|WITH GRANT OPTION/.test(sql)));
  }
  assert.ok(!statements.some(sql=>sql.startsWith('GRANT ')&&sql.includes('cb_message_review_guard')));
});
test('bootstrap can only create/read core identities and receipt, plus insert the triggered default media policy',() => {
  for (const table of ['cb_messages','cb_record_revisions','cb_auth_sessions','cb_auth_invitations','cb_recovery_quarantine']) assert.deepEqual(expectedTablePrivileges('bootstrap',table),[]);
  assert.deepEqual(expectedTablePrivileges('bootstrap','cb_center_bootstraps'),['SELECT','INSERT']);
  assert.deepEqual(expectedTablePrivileges('bootstrap','cb_media_resource_limits'),['INSERT']);
  assert.deepEqual(expectedUpdateColumns('bootstrap','cb_auth_accounts'),['user_id']);
});

test('023 recipient identity and receipts are append-only, contact heads can update and no new worker grants are added',() => {
  const appendOnly = ['cb_care_recipient_links','cb_primary_communicator_requests'];
  const tables = [...appendOnly,'cb_primary_communicators'];
  for (const table of appendOnly) assert.deepEqual(expectedTablePrivileges('runtime',table),['SELECT','INSERT']);
  assert.deepEqual(expectedTablePrivileges('runtime','cb_primary_communicators'),['SELECT','INSERT','UPDATE']);
  for (const table of tables) {
    assert.deepEqual(expectedTablePrivileges('backup',table),['SELECT']);
    for (const kind of ['bootstrap','worker']) assert.deepEqual(expectedTablePrivileges(kind,table),[]);
    for (const kind of DATABASE_SERVICE_ROLE_KINDS) for (const permission of ['SELECT','INSERT','UPDATE','REFERENCES'])
      assert.deepEqual(expectedColumnPrivileges(kind,table,permission),[]);
  }
  for (const fn of ['cb_care_recipient_participant_guard','cb_care_recipient_link_guard',
    'cb_primary_communicator_guard','cb_communication_qualification_generation'])
    for (const kind of DATABASE_SERVICE_ROLE_KINDS) assert.equal(expectedFunctionExecution(kind,fn),false);
  for (const table of ['cb_users','cb_memberships'])
    assert.ok(!expectedUpdateColumns('runtime',table).includes('communication_generation'));
});
test('backup has SELECT only on reviewed tables and cannot bypass sequence state or function restrictions',() => {
  for (const table of DATABASE_TABLES) assert.deepEqual(expectedTablePrivileges('backup',table),['SELECT']);
  const sql = databasePrivilegePlan(input()).statements.join('\n');
  assert.match(sql,/GRANT SELECT ON SEQUENCE .* TO "cb_backup"/);
  assert.ok(!/GRANT EXECUTE .*"cb_backup"/.test(sql));
  assert.ok(!/GRANT (?:USAGE|UPDATE).*SEQUENCE.*"cb_backup"/.test(sql));
});
test('five reviewed invoker signatures have separate app/worker access; trigger-only definer is never directly granted',() => {
  assert.equal(Object.keys(RUNTIME_HELPERS).length,5);
  assert.deepEqual(Object.keys(RUNTIME_HELPERS).sort(),Object.keys(RUNTIME_HELPER_RESULTS).sort());
  assert.equal(RUNTIME_HELPER_RESULTS.cb_media_resource_usage,'TABLE(reserved_bytes bigint, pending_count bigint)');
  const sql = databasePrivilegePlan(input()).statements.join('\n');
  assert.equal((sql.match(/GRANT EXECUTE/g)||[]).length,7);
  assert.ok(!/GRANT.*cb_recovery_write_guard/.test(sql));
  assert.match(sql,/REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC/);
});
test('global and schema-local default public privileges are removed without granting on future tables',() => {
  const sql = databasePrivilegePlan(input()).statements.join('\n');
  assert.match(sql,/ALTER DEFAULT PRIVILEGES FOR ROLE "cb_owner" REVOKE ALL ON FUNCTIONS FROM PUBLIC/);
  assert.match(sql,/ALTER DEFAULT PRIVILEGES FOR ROLE "cb_owner" IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC/);
  // Password-recovery identifiers are not SQL PASSWORD clauses.
  assert.ok(!/GRANT .*ALL TABLES|GRANT .*ALL FUNCTIONS|WITH GRANT OPTION|CREATE ROLE|ALTER ROLE|\bPASSWORD\b|SET ROLE/i.test(sql));
});
test('unknown future objects and role classes require explicit policy review',() => {
  fails(() => expectedTablePrivileges('runtime','cb_future')); fails(() => expectedTablePrivileges('tenant','cb_messages'));
  const values = expectedTablePrivileges('runtime','cb_messages'); values.push('TRUNCATE');
  assert.ok(!expectedTablePrivileges('runtime','cb_messages').includes('TRUNCATE'));
});
test('worker reads only media/journal tables and explicit relationship columns, never authentication or clinical content',() => {
  assert.deepEqual(DATABASE_TABLES.filter((table) => expectedTablePrivileges('worker',table).includes('SELECT')),
    ['cb_decoder_engines','cb_decoder_jobs','cb_media_objects','cb_media_preparations','cb_media_resource_limits','cb_media_uploads','cb_media_work_queue']);
  for (const table of ['cb_auth_accounts','cb_auth_sessions','cb_auth_invitations','cb_messages','cb_record_revisions','cb_child_profiles','cb_media_work_reviews']) {
    assert.deepEqual(expectedTablePrivileges('worker',table),[]);
    assert.deepEqual(expectedColumnPrivileges('worker',table,'SELECT'),[]);
  }
  assert.deepEqual(expectedColumnPrivileges('worker','cb_users','SELECT'),['id','active']);
  assert.deepEqual(expectedColumnPrivileges('worker','cb_conversations','SELECT'),['center_id','id','child_id','revision']);
  const columns = expectedColumnPrivileges('worker','cb_users','SELECT'); columns.push('future_secret');
  assert.ok(!expectedColumnPrivileges('worker','cb_users','SELECT').includes('future_secret'));
});
test('worker can insert only its objects/evidence/events/journal and never delete/truncate or advance audit sequences',() => {
  assert.deepEqual(DATABASE_TABLES.filter((table) => expectedTablePrivileges('worker',table).includes('INSERT')),
    ['cb_decoder_engines','cb_decoder_jobs','cb_media_events','cb_media_objects','cb_media_preparations']);
  for (const table of DATABASE_TABLES) for (const privilege of ['UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES','MAINTAIN'])
    assert.ok(!expectedTablePrivileges('worker',table).includes(privilege));
  const statements = databasePrivilegePlan(input()).statements.filter((sql) => sql.endsWith('TO "cb_worker"'));
  assert.ok(!statements.some((sql) => /ON SEQUENCE/.test(sql)));
  assert.ok(!statements.some((sql) => /GRANT SELECT ON TABLE public.cb_(?:users|memberships|participants|conversations) /.test(sql)));
});
test('worker updates explicit transition/lease columns without manifest, binding, retry-approval or resource-policy changes',() => {
  const uploads = expectedUpdateColumns('worker','cb_media_uploads');
  for (const column of ['name','type','size','sha256','expires_at','preparation_required','owner_id','bound_message_id','bound_record_id','bound_feedback_id']) assert.ok(!uploads.includes(column));
  assert.deepEqual(expectedUpdateColumns('worker','cb_media_resource_limits'),['center_id']);
  assert.deepEqual(expectedUpdateColumns('worker','cb_media_work_queue'),['state','attempts','upload_version','lease_id','lease_until']);
  assert.deepEqual(expectedUpdateColumns('worker','cb_media_objects'),['state']);
  assert.ok(!expectedUpdateColumns('worker','cb_decoder_jobs').includes('engine_id'));
  fails(() => expectedUpdateColumns('worker','cb_future'));
  fails(() => expectedColumnPrivileges('worker','cb_users','DELETE'));
});
test('application loses journal and approval-evidence creation while worker has no ordinary app helper execution',() => {
  for (const table of ['cb_decoder_engines','cb_decoder_jobs']) {
    assert.deepEqual(expectedTablePrivileges('runtime',table),[]); assert.deepEqual(expectedUpdateColumns('runtime',table),[]);
  }
  assert.deepEqual(expectedTablePrivileges('runtime','cb_media_preparations'),['SELECT']);
  assert.equal(expectedFunctionExecution('runtime','cb_media_clean_scan'),false);
  assert.equal(expectedFunctionExecution('worker','cb_media_clean_scan'),true);
  for (const fn of ['cb_assert_room_schedule','cb_valid_draft_assessments','cb_recovery_write_guard']) assert.equal(expectedFunctionExecution('worker',fn),false);
  fails(() => expectedFunctionExecution('worker','cb_future'));
});
test('policy version 7 retains an explicit independent worker and never falls back to the application connection',async () => {
  assert.equal(DATABASE_PRIVILEGE_POLICY_VERSION,7); assert.equal(DATABASE_ROLE_KINDS.length,5); assert.equal(DATABASE_SERVICE_ROLE_KINDS.length,4);
  assert.ok(Object.isFrozen(DATABASE_ROLE_KINDS)); assert.ok(Object.isFrozen(DATABASE_SERVICE_ROLE_KINDS));
  const legacy = input(); delete legacy.roles.worker; fails(() => databasePrivilegePlan(legacy));
  const duplicate = input(); duplicate.roles.worker = duplicate.roles.runtime; fails(() => databasePrivilegePlan(duplicate));
  let entered = false;
  await assert.rejects(configureDatabasePrivileges({transaction:() => { entered = true; }},legacy),{message:'DATABASE_PRIVILEGES_UNAVAILABLE'});
  assert.equal(entered,false);
});

test('account security events have insert-only app access, backup read and no bootstrap or worker access',() => {
  assert.deepEqual(expectedTablePrivileges('runtime','cb_account_security_events'),['INSERT']);
  assert.deepEqual(expectedTablePrivileges('backup','cb_account_security_events'),['SELECT']);
  for (const kind of ['bootstrap','worker']) {
    assert.deepEqual(expectedTablePrivileges(kind,'cb_account_security_events'),[]);
    for (const permission of ['SELECT','INSERT','UPDATE','REFERENCES'])
      assert.deepEqual(expectedColumnPrivileges(kind,'cb_account_security_events',permission),[]);
  }
  for (const kind of ['runtime','bootstrap','backup','worker']) assert.equal(expectedFunctionExecution(kind,'cb_account_security_event_guard'),false);
});
test('password recovery grants runtime read/insert and only consumption/revocation updates, never token or identity changes',() => {
  const table = 'cb_auth_password_resets';
  assert.deepEqual(expectedTablePrivileges('runtime',table),['SELECT','INSERT']);
  assert.deepEqual(expectedUpdateColumns('runtime',table),['consumed_at','revoked_at']);
  assert.deepEqual(expectedTablePrivileges('backup',table),['SELECT']);
  assert.deepEqual(expectedUpdateColumns('backup',table),[]);
  for (const kind of ['bootstrap','worker']) {
    assert.deepEqual(expectedTablePrivileges(kind,table),[]);
    for (const permission of ['SELECT','INSERT','UPDATE','REFERENCES'])
      assert.deepEqual(expectedColumnPrivileges(kind,table,permission),[]);
  }
  for (const name of ['cb_password_reset_guard','cb_password_reset_invalidate'])
    for (const kind of ['runtime','bootstrap','backup','worker']) assert.equal(expectedFunctionExecution(kind,name),false);
  const sql = databasePrivilegePlan(input()).statements.join('\n');
  assert.match(sql,/GRANT SELECT,INSERT ON TABLE public\.cb_auth_password_resets TO "cb_runtime"/);
  assert.match(sql,/GRANT UPDATE \(consumed_at,revoked_at\) ON TABLE public\.cb_auth_password_resets TO "cb_runtime"/);
  assert.ok(!/GRANT UPDATE ON TABLE public\.cb_auth_password_resets/.test(sql));
});
test('another database owned by the five roles refuses verify, configure and service work at catalog preflight',async () => {
  const requested=input(),roleNames=Object.values(requested.roles);
  const roles=roleNames.map((rolname,index)=>({rolname,oid:String(requested.target.ownerOid+index),
    rolsuper:false,rolinherit:false,rolcreaterole:false,rolcreatedb:false,rolcanlogin:true,
    rolreplication:false,rolbypassrls:false,rolconfig:null}));
  const roleIds=roles.map(role=>Number(role.oid));
  const normalized=sql=>sql.replace(/\s+/g,' ').trim();
  for(const operation of ['verify','configure',...DATABASE_SERVICE_ROLE_KINDS]){
    const connectedKind=['verify','configure'].includes(operation)?'owner':operation;
    const target={datname:requested.target.name,oid:String(requested.target.oid),
      owner_oid:String(requested.target.ownerOid),current_role:requested.roles[connectedKind],
      session_role:requested.roles[connectedKind],version:180006};
    // All prior identity/role checks are valid. Only the final ownership
    // catalog result refuses admission; schema/grant inspection is not lent.
    const script=[
      {sql:'SET LOCAL search_path=pg_catalog,public,pg_temp',rows:[]},
      ...(operation==='configure'?[{sql:'SELECT pg_advisory_xact_lock(724381905)',rows:[]}]:[]),
      {sql:`SELECT d.datname,d.oid::bigint AS oid,d.datdba::bigint AS owner_oid,
        current_user AS current_role,session_user AS session_role,current_setting('server_version_num')::integer AS version
        FROM pg_catalog.pg_database d WHERE d.datname=current_database() AND NOT d.datistemplate`,rows:[target]},
      {sql:`SELECT rolname,oid::bigint AS oid,rolsuper,rolinherit,rolcreaterole,
        rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconfig FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])`,
      params:[roleNames],rows:roles},
      {sql:'SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid=ANY($1::oid[]) OR member=ANY($1::oid[])',params:[roleIds],rows:[]},
      {sql:'SELECT 1 FROM pg_catalog.pg_database WHERE datdba=ANY($1::oid[]) AND oid<>$2::oid',
        params:[roleIds,requested.target.oid],rows:[{'?column?':1}]},
    ];
    const calls=[];let transactions=0,workEntered=false;
    const database={async transaction(work){
      transactions++;
      return work({async query(sql,params){
        const index=calls.length;calls.push({sql:normalized(sql),params});
        if(index>=script.length)throw new Error('SYNTHETIC_UNEXPECTED_POST_PREFLIGHT_QUERY');
        return {rows:script[index].rows};
      },async exec(sql){calls.push({exec:sql});throw new Error('SYNTHETIC_UNEXPECTED_GRANT_WRITE');}});
    }};
    const action=operation==='verify'?verifyDatabasePrivileges(database,requested):
      operation==='configure'?configureDatabasePrivileges(database,requested):
        databaseForService(database,requested,operation).transaction(async()=>{workEntered=true;});
    await assert.rejects(action,{message:'DATABASE_PRIVILEGES_UNAVAILABLE'});
    assert.equal(transactions,1,operation);assert.equal(workEntered,false,operation);
    // Compare outside the redacting production catch: a swallowed fake-query
    // assertion must not masquerade as the intended ownership refusal.
    assert.deepEqual(calls,script.map(({sql,params})=>({sql:normalized(sql),params})),operation);
    assert.ok(calls.every(call=>!('exec'in call)&&/^(?:SELECT |SET LOCAL )/.test(call.sql)),operation);
  }
});

test('invalid input fails before DB access; private preflight/connection details are never exposed',async () => {
  let entered = false;
  const database = {transaction:async () => { entered = true; throw new Error('SYNTHETIC-PRIVATE-DB-DETAIL'); }};
  for (const action of [configureDatabasePrivileges,verifyDatabasePrivileges]) {
    await assert.rejects(action(database,null),{message:'DATABASE_PRIVILEGES_UNAVAILABLE'}); assert.equal(entered,false);
    await assert.rejects(action(database,input()),{message:'DATABASE_PRIVILEGES_UNAVAILABLE'}); entered = false;
  }
});

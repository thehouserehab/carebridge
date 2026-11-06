// Explicit synthetic Windows/E persistence rehearsal. Not a beta start command,
// operating backup scheduler, actual-account provisioner or HTTP/API endpoint.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, unlink, writeFile, readdir, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { databaseFromPool } from './database.mjs';
import { migrate } from './migrate.mjs';
import { Conversations } from './conversations.mjs';
import { Records } from './records.mjs';
import { MediaUploads } from './media-uploads.mjs';
import { PrivateFileStore } from './private-file-store.mjs';
import { createRecoveryBundle, openRecoveryBundle } from './recovery-bundle.mjs';
import { recoveryMigrationManifest,assertRecoveryMigrations } from './recovery-native-contract.mjs';
import { seedRecoveryReviewFixture,verifyRecoveryReviewFixture,verifyQuarantinedRecoveryReviewFixture } from './recovery-review-native-check.mjs';
import { seedRecoveryRecipientFixture,verifyRecoveryRecipientFixture } from './recovery-recipient-native-check.mjs';
import {capturePreparedRecoverySamples} from './recovery-prepared-native-check.mjs';
import { configureSyntheticMediaPolicy } from './media-resource-test-policy.mjs';
import { SYNTHETIC_DB_ROLES,exerciseDatabasePrivileges,syntheticPrivilegeInput,restoreSyntheticDatabaseConnectionPrivileges } from './database-privileges-native-check.mjs';
import { verifyDatabasePrivileges } from './database-privileges.mjs';
import { exerciseWorkerDatabasePrivileges } from './database-worker-privileges-native-check.mjs';
import { captureSyntheticMedia } from './windows-postgres-media-fixture.mjs';
import { exerciseServiceDatabasePrivileges } from './database-service-privileges-native-check.mjs';
import { exerciseCredentialDatabaseService } from './database-credential-service-native-check.mjs';
import {addMessageLifecycleNativeCases,messageLifecycleNativeFixture} from './message-lifecycle-native-tests.mjs';
import {addAuthPasswordRecoveryNativeCases,PASSWORD_RECOVERY_NATIVE_CASE_COUNT} from './auth-password-recovery-native-tests.mjs';
import {seedRecoveryStateComparison,exerciseRecoveryStateComparison} from './recovery-state-native-check.mjs';
import { windowsPostgresCheckOptions, postgresCheckPaths, windowsPostgresEnvironment,
  PORTABLE_POSTGRES_VERSION, PORTABLE_POSTGRES_SHA256 } from './windows-postgres-policy.mjs';
import { messageBrowserOptions } from '../tests/message-browser-policy.mjs';
import { createSyntheticPostgresRuntime,freshFile,regularDirectoryChain } from './windows-synthetic-postgres-runtime.mjs';

const runId = randomUUID(), checks = [], databases = new Set();
let native,pool,initializeCluster,startCluster,stopCluster,clusters = [];
let roleCheck=false,nativeMediaCheck=false,recoveryStateCheck=false;
const resultDirectory = fileURLToPath(new URL('../test-results/',import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const collect = async (stream) => { const parts = []; for await (const part of stream) parts.push(Buffer.from(part)); return Buffer.concat(parts); };
let options, paths, environment, browserRuntime, stage = 'preflight', failure = null, bundleKey, reader,mediaInventory = null;
let tlsInventory=null,credentialService=null,sourceMediaReceipt=null,expectedMigrations=null,reviewChecks=null;
const recipientChecks={seeded:false,sourceRestart:false,restored:false,restoredRestart:false};
let sourceManifest=null,sourceUnchanged=false;
let preparedRecoverySamples=null,preparedFaultSamples=null,recoveryStateEvidence=null;
const pass = (label) => { checks.push(label); console.log(`PASS ${label}`); };
async function mediaRootReceipt(path) {
  await regularDirectoryChain(path);
  const info=await lstat(path,{bigint:true});
  assert.ok(info.isDirectory()&&!info.isSymbolicLink());
  // Identity of this fresh fixture directory, NOT an OS ownership/ACL proof.
  return Object.freeze({path,dev:info.dev.toString(),ino:info.ino.toString()});
}
function database(config) { const value = databaseFromPool(pool(config)); databases.add(value); return value; }
async function closeDatabase(db) { if (db) { await db.close(); databases.delete(db); } }
async function closeDatabases() { for (const db of [...databases]) await closeDatabase(db); }
async function verifyRecoveryMigrationLedger(db) {
  const {rows}=await db.transaction(tx=>tx.query('SELECT name,checksum FROM public.cb_schema_migrations ORDER BY name'));
  assertRecoveryMigrations(rows,expectedMigrations);
}
async function recoverySourceManifest() {
  const repository=new URL('../',import.meta.url);
  // Code/SQL only: never .env, credentials, runtime state, media or results.
  // Broad source folders also capture helpers imported transitively by this
  // rehearsal. This is code identity, not verification of every captured file.
  const groups=[['server/',/\.mjs$/],['server/migrations/',/\.sql$/],['server/tests/',/\.ps1$/],
    ['src/',/\.js$/],['local-api/',/\.(?:js|css|html)$/],['tests/',/\.mjs$/],['scripts/',/\.(?:mjs|ps1)$/]];
  const names=['package.json','package-lock.json','server/package.json','server/package-lock.json'];
  for(const [directory,pattern]of groups)for(const name of await readdir(new URL(directory,repository)))
    if(pattern.test(name))names.push(directory+name);
  const files=[];
  for(const name of names.sort()){
    const file=new URL(name,repository),info=await lstat(file);
    assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size<=4*1024*1024);
    files.push({name,sha256:hash(await readFile(file))});
  }
  return {version:1,sha256:hash(Buffer.from(JSON.stringify(files))),files};
}
async function prepareSyntheticTls() {
  const result=JSON.parse(await native(options.powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',
    fileURLToPath(new URL('./tests/windows-postgres-tls-fixture.ps1',import.meta.url)),'-Base',options.base,'-RunId',runId]));
  assert.deepEqual(result,{schema:1,purpose:'synthetic-postgres-tls',created:true});
  const root=join(paths.root,'tls');await regularDirectoryChain(root);
  assert.deepEqual((await readdir(root)).sort(),['.carebridge-tls-fixture.json','good.crt','good.key','wrong.crt','wrong.key'].sort());
  const files=[];const certificates={};
  for(const name of ['.carebridge-tls-fixture.json','good.crt','good.key','wrong.crt','wrong.key']) {
    const path=join(root,name),info=await lstat(path);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.size<=16384);
    const bytes=await readFile(path);try{files.push({path,sha256:hash(bytes)});if(name.endsWith('.crt'))certificates[name.split('.')[0]]=bytes.toString('ascii');}finally{bytes.fill(0);}
  }
  tlsInventory={root,files,cleanup:false};return certificates;
}
async function selectSyntheticTlsIdentity(cluster,identity) {
  assert.ok(['good','wrong'].includes(identity));
  const admin=pool({...cluster.config,user:'carebridge_fixture_admin',password:cluster.adminPassword,database:'postgres'});admin.on('error',() => {});
  try {
    await admin.query("ALTER SYSTEM SET ssl='on'");
    await admin.query(`ALTER SYSTEM SET ssl_cert_file='../tls/${identity}.crt'`);
    await admin.query(`ALTER SYSTEM SET ssl_key_file='../tls/${identity}.key'`);
    await admin.query("ALTER SYSTEM SET ssl_min_protocol_version='TLSv1.2'");
  } finally {await admin.end();}
  await closeDatabases();await stopCluster(cluster);await startCluster(cluster);
}
async function cleanupSyntheticTls() {
  if(!tlsInventory)return;
  assert.ok(!failure && clusters.every((cluster) => !cluster.child));
  assert.equal(tlsInventory.root,join(paths.root,'tls'));await regularDirectoryChain(tlsInventory.root);
  assert.deepEqual((await readdir(tlsInventory.root)).sort(),tlsInventory.files.map(({path}) => path.slice(tlsInventory.root.length+1)).sort());
  const receipt=JSON.parse(await readFile(join(tlsInventory.root,'.carebridge-tls-fixture.json')));
  assert.equal(receipt.schema,1);assert.equal(receipt.root,tlsInventory.root);assert.equal(receipt.runId,runId);assert.equal(receipt.purpose,'synthetic-postgres-tls');
  for(const {path,sha256} of tlsInventory.files) {
    const info=await lstat(path);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1);
    const bytes=await readFile(path);try{assert.equal(hash(bytes),sha256);}finally{bytes.fill(0);}
  }
  // Only this run's sealed certificate/key/receipt files and empty TLS dir.
  for(const {path} of tlsInventory.files)await unlink(path);await rmdir(tlsInventory.root);tlsInventory.cleanup=true;
}
async function fingerprint(db) {
  return db.transaction(async (tx) => {
    const names = (await tx.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    const data = [];
    for (const { tablename } of names) {
      assert.match(tablename,/^cb_[a-z_]+$/);
      const rows = (await tx.query(`SELECT to_jsonb(t)::text AS row FROM public."${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
      data.push({ table:tablename,count:rows.length,sha256:hash(Buffer.from(JSON.stringify(rows))) });
    }
    const columns = (await tx.query(`SELECT table_name,column_name,data_type,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`)).rows;
    const triggers = (await tx.query(`SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`)).rows;
    return { data,columns,triggers };
  });
}
async function seed(db,store,setupDb = db,{reviewCheck=false} = {}) {
  const therapist = { centerId:'synthetic-e-center',userId:'synthetic-e-therapist' };
  const guardian = { centerId:therapist.centerId,userId:'synthetic-e-guardian' };
  const manager = { centerId:therapist.centerId,userId:'synthetic-e-manager' };
  const room = 'synthetic-e-room', goal = 'synthetic-e-goal';
  await setupDb.transaction(async (tx) => {
    await tx.query('INSERT INTO cb_centers VALUES ($1)',[therapist.centerId]);
    await configureSyntheticMediaPolicy(tx,therapist.centerId);
    for (const [actor,role] of [[therapist,'therapist'],[guardian,'guardian'],...(reviewCheck?[[manager,'center']]:[])]) {
      await tx.query('INSERT INTO cb_users(id,active) VALUES ($1,true)',[actor.userId]);
      await tx.query('INSERT INTO cb_memberships VALUES ($1,$2,$3,true)',[actor.centerId,actor.userId,role]);
    }
    await tx.query('INSERT INTO cb_children VALUES ($1,$2)',[therapist.centerId,'synthetic-e-child']);
    await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)',[therapist.centerId,room,'synthetic-e-child']);
    for (const [actor,role] of [[therapist,'therapist'],[guardian,'guardian']])
      await tx.query('INSERT INTO cb_participants VALUES ($1,$2,$3,$4,true,1)',[actor.centerId,room,actor.userId,role]);
    await tx.query("INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ($1,$2,$3,'가상 목표','active')",[therapist.centerId,room,goal]);
  });
  const chat = new Conversations(db), records = new Records(db);
  const sendInput = { conversationId:room,clientId:'synthetic-e-news-0001',body:'가상 가정 소식' };
  const message = await chat.sendText(guardian,sendInput);
  await chat.markRead(therapist,{ conversationId:room,messageId:message.id });
  const content = { date:'2026-10-07',goalId:goal,performed:'가상 활동',response:'가상 반응',nextPlan:'가상 다음 계획',
    summary:'가상 보호자 요약',privateNote:'SYNTHETIC-PRIVATE-E-NOTE',referenceMessageIds:[message.id],
    assessments:[{ tool:'가상 관찰',item:'횟수',value:0,unit:'회',context:'가상 동일 조건' },
      { tool:'가상 관찰',item:'시간',value:3,unit:'분',context:'가상 다른 조건' }] };
  await records.save(therapist,{ conversationId:room,recordId:'synthetic-e-record',clientId:'synthetic-e-record-0001',expectedRevision:0,content });
  const preview = await records.preview(therapist,{ conversationId:room,recordId:'synthetic-e-record' });
  const publication = await records.publish(therapist,{ conversationId:room,recordId:'synthetic-e-record',clientId:'synthetic-e-publish-0001',
    expectedRevision:preview.recordRevision,expectedRelationshipsVersion:preview.relationshipsVersion,recipientIds:preview.recipientIds });
  await chat.sendText(guardian,{ conversationId:room,clientId:'synthetic-e-reply-0001',body:'가상 공유 답변',replyTo:publication.messageId });
  await chat.withdraw(therapist,{ conversationId:room,messageId:publication.messageId });
  await records.save(therapist,{ conversationId:room,recordId:'synthetic-e-draft',clientId:'synthetic-e-draft-0001',expectedRevision:0,
    content:{ date:content.date,goalId:goal,status:'draft',assessments:[{ ...content.assessments[0],value:null },{ tool:'가상 미완료 평가' }] } });
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=','base64');
  const manifest = { name:'synthetic.png',type:'image/png',size:bytes.length,sha256:hash(bytes) };
  const uploads = new MediaUploads(db,store), reserved = await uploads.reserve(guardian,{ conversationId:room,clientId:'synthetic-e-upload-0001',file:manifest });
  const received = await uploads.receive(guardian,{ conversationId:room,uploadId:reserved.id,expectedVersion:reserved.version },Readable.from([bytes]));
  assert.equal(received.state,'quarantined'); // No fake malware/decode approval.
  const object = (await db.transaction((tx) => tx.query('SELECT object_key FROM cb_media_uploads WHERE id=$1',[reserved.id]))).rows[0].object_key;
  const blocked = randomUUID(); await store.remove(blocked);
  const review = reviewCheck ? await seedRecoveryReviewFixture(chat,{therapist,guardian,manager,conversationId:room},setupDb) : null;
  const recipient = await seedRecoveryRecipientFixture(setupDb);
  return { therapist,guardian,room,sendInput,message,bytes,manifest,object,blocked,review,recipient,
    record:await records.get(therapist,{ conversationId:room,recordId:'synthetic-e-record' }),
    draft:await records.get(therapist,{ conversationId:room,recordId:'synthetic-e-draft' }),
    chat:await chat.list(guardian,{ conversationId:room }) };
}
async function verifyServices(db,fixture,owner = db) {
  const records = new Records(db), chat = new Conversations(db);
  assert.deepEqual(await records.get(fixture.therapist,{ conversationId:fixture.room,recordId:'synthetic-e-record' }),fixture.record);
  assert.deepEqual(await records.get(fixture.therapist,{ conversationId:fixture.room,recordId:'synthetic-e-draft' }),fixture.draft);
  assert.deepEqual(await chat.list(fixture.guardian,{ conversationId:fixture.room }),fixture.chat);
  assert.equal(fixture.record.assessments[0].value,0); assert.equal(fixture.draft.assessments[0].value,null);
  assert.ok(!JSON.stringify(fixture.chat).includes('SYNTHETIC-PRIVATE-E-NOTE'));
  await assert.rejects(records.get(fixture.guardian,{ conversationId:fixture.room,recordId:'synthetic-e-record' }),{ code:'FORBIDDEN' });
  await assert.rejects(records.preview(fixture.therapist,{ conversationId:fixture.room,recordId:'synthetic-e-draft' }),{ code:'RECORD_NOT_SHAREABLE' });
  await assert.rejects(db.transaction((tx) => tx.query("UPDATE cb_record_revisions SET private_note='synthetic changed' WHERE record_id='synthetic-e-record'")),{ code:'23514' });
  if(fixture.review)await verifyRecoveryReviewFixture({chat,owner,fingerprint,fixture:fixture.review});
  // Owner-side fixture verification complements, never replaces, the separate
  // runtime privilege checks above and in the role admission rehearsal.
  await verifyRecoveryRecipientFixture({owner,fixture:fixture.recipient,fingerprint});
}
async function readObject(store,key,manifest) {
  const handle = await store.openVerified(key,manifest);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

try {
  assert.equal(process.platform,'win32');({options,roleCheck,nativeMediaCheck,recoveryStateCheck}=windowsPostgresCheckOptions(process.argv.slice(2)));
  // Existing role mode is unchanged. The opt-in combined mode adds the same
  // nonempty 022 fixture and source identity to native HTTP/media recovery.
  if(roleCheck&&(!nativeMediaCheck||recoveryStateCheck))reviewChecks={seeded:false,sourceRestart:false,restored:false,restoredRestart:false};
  if(nativeMediaCheck&&recoveryStateCheck)Object.assign(reviewChecks,{stateRestored:false,quarantined:false});
  if(recoveryStateCheck)Object.assign(recipientChecks,{stateRestored:false,quarantined:false});
  const migrationDirectory=new URL('./migrations/',import.meta.url);
  expectedMigrations=recoveryMigrationManifest(await Promise.all((await readdir(migrationDirectory)).filter(name=>name.endsWith('.sql'))
    .map(async name=>({name,content:await readFile(new URL(name,migrationDirectory))}))));
  if(reviewChecks)sourceManifest=await recoverySourceManifest();
  if(nativeMediaCheck&&!recoveryStateCheck){browserRuntime=messageBrowserOptions(['--confirm-synthetic-local']);
    for(const path of [browserRuntime.module,browserRuntime.executable])assert.ok((await lstat(path)).isFile());}
  paths = postgresCheckPaths(options.privateRoot,runId); environment = windowsPostgresEnvironment(process.env,options.bin);
  ({native,pool,initializeCluster,startCluster,stopCluster,clusters} = createSyntheticPostgresRuntime({options,root:paths.root,environment,
    roles:roleCheck ? [...Object.values(SYNTHETIC_DB_ROLES).filter((name) => name !== SYNTHETIC_DB_ROLES.owner),'carebridge_fixture_observer'] : []}));
  const preparation = JSON.parse(await native(options.powershell,['-NoProfile','-NonInteractive','-File',
    fileURLToPath(new URL('../scripts/prepare-beta-postgres.ps1',import.meta.url)),'-Base',options.base,'-ConfirmPortableRuntime','-VerifyOnly']));
  assert.equal(preparation.prepared,true); assert.equal(preparation.reused,true);
  assert.equal(preparation.version,PORTABLE_POSTGRES_VERSION); assert.equal(preparation.archiveSha256,PORTABLE_POSTGRES_SHA256);
  assert.equal(resolve(preparation.bin).toLowerCase(),resolve(options.bin).toLowerCase());
  await regularDirectoryChain(join(options.privateRoot,'checks'));
  await mkdir(paths.root); // No recursive creation/adoption; E private root must exist.
  await freshFile(join(paths.root,'.carebridge-check.json'),JSON.stringify({ schema:1,purpose:'synthetic-native-e-postgres',runId,root:paths.root }));
  for (const path of [paths.sourceMedia,paths.restoredMedia,paths.bundles,paths.restoreInput]) {
    await mkdir(path);
    if(recoveryStateCheck&&path===paths.sourceMedia)sourceMediaReceipt=await mediaRootReceipt(path);
  }
  for (const name of ['postgres','initdb','pg_ctl','pg_dump','pg_restore'])
    assert.match(await native(join(options.bin,`${name}.exe`),['--version'],{ cwd:paths.root }),/\(PostgreSQL\) 18\.6\b/);
  pass('pinned official Windows runtime verified; fresh protected E-only check paths');

  stage = 'source-init'; const sourceCluster = await initializeCluster(paths.source);
  // Retain the original strict 28P01 check; socket failure is not proof of an
  // authentication-policy rejection. Report only a bounded generic category.
  const badPassword = pool({ ...sourceCluster.config,password:randomBytes(32).toString('hex') }); badPassword.on('error',() => {});
  try {
    let outcome='ACCEPTED';const began=Date.now();
    try{await badPassword.query('SELECT 1');}catch(error){outcome=/^[A-Z0-9]{5}$/.test(error?.code??'')?error.code:
      /timeout/i.test(error?.message??'')?'CONNECTION_TIMEOUT':/SCRAM|SASL/i.test(error?.message??'')?'SCRAM_ERROR':
        /Connection terminated unexpectedly|Connection closed unexpectedly/i.test(error?.message??'')?'CONNECTION_CLOSED':
          ['ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT'].includes(error?.code)?error.code:'CONNECTION_ERROR';}
    if(outcome!=='28P01')throw Object.assign(new Error('WINDOWS_POSTGRES_AUTH_CHECK'),{wrongPasswordObservation:{outcome,elapsedMs:Date.now()-began}});
  } finally { await badPassword.end(); }
  let source = database(sourceCluster.config);
  const privilege = (await source.transaction((tx) => tx.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user'))).rows[0];
  assert.ok(Object.values(privilege).every((value) => value === false));
  pass('PGDATA actually on E; loopback-only SCRAM rejects wrong password; checksums and durable WAL settings on');
  stage = 'schema'; const migrations = await migrate(source); assert.deepEqual(migrations,expectedMigrations.map(row=>row.name));
  assert.deepEqual(await migrate(source),[]);await verifyRecoveryMigrationLedger(source);
  pass('immutable migrations 001-023 applied by a non-superuser owner and idempotent rerun');

  const asRole = (cluster,kind) => database({...cluster.config,user:SYNTHETIC_DB_ROLES[kind],password:cluster.roles[SYNTHETIC_DB_ROLES[kind]]});
  let sourceRuntime = roleCheck ? asRole(sourceCluster,'runtime') : source;
  if (roleCheck) {
    stage = 'role-source';
    const admin = pool({...sourceCluster.config,user:'carebridge_fixture_admin',password:sourceCluster.adminPassword,database:'postgres'});
    admin.on('error',() => {});
    try {
      const roleChecks = await exerciseDatabasePrivileges({owner:source,runtime:sourceRuntime,
        bootstrap:asRole(sourceCluster,'bootstrap'),backup:asRole(sourceCluster,'backup'),worker:asRole(sourceCluster,'worker'),admin,
        observerConnect:async () => {
          const observer = pool({...sourceCluster.config,user:'carebridge_fixture_observer',password:sourceCluster.roles.carebridge_fixture_observer});
          observer.on('error',() => {}); try { await observer.query('SELECT 1'); } finally { await observer.end(); }
        }});
      assert.equal(roleChecks.length,8); for (const label of roleChecks) pass(label);
      stage = 'role-service-admission';
      const serviceChecks = await exerciseServiceDatabasePrivileges({owner:source,runtime:sourceRuntime,
        bootstrap:asRole(sourceCluster,'bootstrap'),backup:asRole(sourceCluster,'backup'),worker:asRole(sourceCluster,'worker'),admin});
      assert.equal(serviceChecks.length,2); for (const label of serviceChecks) pass(label);
    } finally { await admin.end(); }
    stage='credential-tls-prepare';const certificates=await prepareSyntheticTls();
    await selectSyntheticTlsIdentity(sourceCluster,'good');source=database(sourceCluster.config);
    stage='credential-service';
    // The ordinary owner cannot inspect all cross-role TLS statistics. Use
    // the existing synthetic admin ONLY in this parent-side read-only probe;
    // never grant monitoring access or pass an admin port to a worker child.
    let nativeObserver;
    const proof=await exerciseCredentialDatabaseService({owner:source,
      storage:{base:options.base,powershell:options.powershell,syntheticRunId:runId},port:sourceCluster.port,rolePasswords:sourceCluster.roles,
      mediaStore:new PrivateFileStore(paths.sourceMedia),
      freshOwner:() => database(sourceCluster.config),
      workerEnvironment:environment,
      nativeMediaCheck,browserRuntime,nativeBrowserCheck:!recoveryStateCheck,
      observeWorkerConnections:nativeMediaCheck ? async () => {
        nativeObserver??=database({...sourceCluster.config,user:'carebridge_fixture_admin',password:sourceCluster.adminPassword});
        return nativeObserver.transaction(async tx => {
          await tx.query('SET TRANSACTION READ ONLY');
          return (await tx.query(`SELECT a.usename,s.ssl FROM pg_stat_activity a JOIN pg_stat_ssl s ON s.pid=a.pid
            WHERE a.usename=$1 AND a.datname=current_database() AND a.application_name='carebridge-worker'`,
            [SYNTHETIC_DB_ROLES.worker])).rows;
        });
      } : undefined,
      certificate:certificates.good,wrongCertificate:certificates.wrong,
      selectTlsIdentity:(identity) => selectSyntheticTlsIdentity(sourceCluster,identity),
      freshProcess:async(code,configuration) => {
        const output=await native(process.execPath,['--input-type=module','-e',code,JSON.stringify(configuration)],{cwd:paths.root,
          env:{...environment,PGHOST:'192.0.2.1',PGPORT:'1',PGUSER:'postgres',PGPASSWORD:'synthetic-do-not-use-environment',
            PGDATABASE:'wrong_db',PGSSLMODE:'no-verify',PGSSLNEGOTIATION:'direct',PGOPTIONS:'-c search_path=pg_temp',
            PGCLIENT_ENCODING:'LATIN1',PGREPLICATION:'true'}});
        assert.equal(output,'CREDENTIAL_TLS_READ_OK');
      }});
    assert.equal(proof.checks.length,nativeMediaCheck?(recoveryStateCheck?15:16):9);assert.equal(proof.cleanup,true);
    credentialService={scenarioCount:proof.checks.length,credentialCount:proof.credentialCount,cleanup:proof.cleanup,ownedWorkerScenarios:2,
      workerControl:proof.workerControl,nativeMedia:proof.nativeMedia};
    for(const label of proof.checks)pass(label);
    source=database(sourceCluster.config);sourceRuntime=asRole(sourceCluster,'runtime');
    stage = 'role-worker-source';
    const workerChecks = await exerciseWorkerDatabasePrivileges({owner:source,runtime:sourceRuntime,
      worker:asRole(sourceCluster,'worker'),store:new PrivateFileStore(paths.sourceMedia)});
    assert.equal(workerChecks.length,4); for (const label of workerChecks) pass(label);
    stage='message-native';const messageCases=[];
    addMessageLifecycleNativeCases((label,work)=>messageCases.push({label,work}),sourceRuntime,asRole(sourceCluster,'runtime'),
      label=>messageLifecycleNativeFixture(source,label),{countEditEvents:(centerId,roomId)=>source.transaction(async tx=>{
        await tx.query('SET TRANSACTION READ ONLY');
        return (await tx.query(`SELECT count(*)::integer AS n FROM cb_audit_events
          WHERE center_id=$1 AND conversation_id=$2 AND action='message.edited'`,[centerId,roomId])).rows[0].n;
      })});
    assert.equal(messageCases.length,6);
    for(const {label,work}of messageCases){await work();pass(label);}
    stage='password-recovery-native';const recoveryCases=[];
    addAuthPasswordRecoveryNativeCases((label,work)=>recoveryCases.push({label,work}),sourceRuntime,asRole(sourceCluster,'runtime'),
      {owner:source,observer:database(sourceCluster.config)});
    assert.equal(recoveryCases.length,PASSWORD_RECOVERY_NATIVE_CASE_COUNT);
    for(const {label,work}of recoveryCases){await work();pass(label);}
  }
  stage = 'seed'; const sourceStore = new PrivateFileStore(paths.sourceMedia), fixture = await seed(sourceRuntime,sourceStore,source,{reviewCheck:reviewChecks!==null});
  const recoveryFixture=recoveryStateCheck?await seedRecoveryStateComparison(source):null;
  await verifyServices(sourceRuntime,fixture,source);if(reviewChecks)reviewChecks.seeded=true;
  recipientChecks.seeded=true;
  const before = await fingerprint(source);
  pass('synthetic Korean records, replies, withdrawal, read states, zero/missing assessments and quarantined PNG saved');
  await closeDatabases(); await stopCluster(sourceCluster);
  stage = 'restart'; await startCluster(sourceCluster); source = database(sourceCluster.config);
  assert.deepEqual(await fingerprint(source),before); assert.deepEqual(await migrate(source),[]);await verifyRecoveryMigrationLedger(source);
  sourceRuntime = roleCheck ? asRole(sourceCluster,'runtime') : source;
  await verifyServices(sourceRuntime,fixture,source);if(reviewChecks)reviewChecks.sourceRestart=true;
  recipientChecks.sourceRestart=true;
  if (roleCheck) await verifyDatabasePrivileges(source,await syntheticPrivilegeInput(source));
  assert.deepEqual(await readObject(new PrivateFileStore(paths.sourceMedia),fixture.object,fixture.manifest),fixture.bytes);
  assert.equal((await new Conversations(sourceRuntime).sendText(fixture.guardian,fixture.sendInput)).id,fixture.message.id);
  assert.deepEqual(await fingerprint(source),before); // Same client ID replays; no extra event/sequence.
  pass('different postmaster process rereads identical E data and bytes; retry remains exactly once');

  stage = 'bundle'; const mediaFiles = await captureSyntheticMedia(source,sourceStore);
  if(nativeMediaCheck&&recoveryStateCheck){
    preparedRecoverySamples=credentialService.nativeMedia.preparedRecoverySamples;
    preparedFaultSamples=await capturePreparedRecoverySamples(source,preparedRecoverySamples,mediaFiles);
  }
  await closeDatabases();
  mediaInventory = {files:mediaFiles.length,blobs:mediaFiles.filter((file) => file.manifest).length,fences:mediaFiles.filter((file) => !file.manifest).length};
  const dumpEnvironment = { ...environment,PGHOST:'127.0.0.1',PGPORT:String(sourceCluster.port),
    PGUSER:roleCheck ? SYNTHETIC_DB_ROLES.backup : sourceCluster.config.user,
    PGPASSWORD:roleCheck ? sourceCluster.roles[SYNTHETIC_DB_ROLES.backup] : sourceCluster.password,PGDATABASE:sourceCluster.config.database,PGSSLMODE:'disable',
    PGOPTIONS:'-c statement_timeout=30000 -c lock_timeout=5000 -c search_path=public,pg_catalog' };
  const dumpPath = join(paths.root,'database.pgcustom');
  await assert.rejects(lstat(dumpPath),{ code:'ENOENT' });
  await native(join(options.bin,'pg_dump.exe'),['--format=custom','--no-password','--lock-wait-timeout=5s','--file',dumpPath],{ cwd:paths.root,env:dumpEnvironment });
  const dumped = await readFile(dumpPath); assert.ok(dumped.length > 0);
  const snapshot = Buffer.from(JSON.stringify({ version:2,runId,quiescence:'single-synthetic-writer-no-API',database:before,migrations:expectedMigrations,
    media:{ key:fixture.object,manifest:fixture.manifest,blocked:fixture.blocked,
      files:mediaFiles.map(({name,manifest,data}) => ({name,manifest,size:data.length,sha256:hash(data)})) },
    preparedRecoverySamples,operatingCutoverApproved:false }));
  bundleKey = randomBytes(32);
  const entry = (name,data) => ({ name,open:async function* () { yield data; } });
  const bundleOptions = { directory:paths.bundles,runId,key:bundleKey };
  await createRecoveryBundle({ ...bundleOptions,entries:[entry('snapshot.json',snapshot),entry('database.pgcustom',dumped),
    ...mediaFiles.map(({name,data}) => entry(name,data))] });
  await assert.rejects(openRecoveryBundle({ ...bundleOptions,key:randomBytes(32) }),{ message:'RECOVERY_BUNDLE_UNAVAILABLE' });
  reader = await openRecoveryBundle(bundleOptions);
  assert.deepEqual(await collect(reader.stream('snapshot.json')),snapshot);
  assert.deepEqual(await collect(reader.stream('database.pgcustom')),dumped);
  pass('quiesced native dump and PNG/fence authenticated in encrypted bundle; wrong key rejected');

  if(recoveryStateCheck){
    // Additional SAME-cluster owned restore for the terminal quarantine's
    // current supported scope. The ordinary separate-cluster byte restoration
    // below remains unchanged and is NOT claimed to have been quarantined.
    stage='recovery-state-create';
    await mkdir(paths.stateMedia); // Dedicated fresh files for this SAME-cluster restore only.
    const targetMediaReceipt=await mediaRootReceipt(paths.stateMedia);
    await freshFile(join(paths.root,'.carebridge-state-media.json'),JSON.stringify({schema:1,
      purpose:'synthetic-recovery-state-media',runId,source:sourceMediaReceipt,target:targetMediaReceipt}));
    const name=`carebridge_state_${runId.replaceAll('-','')}`;
    assert.match(name,/^carebridge_state_[a-f0-9]{32}$/);
    const admin=pool({...sourceCluster.config,user:'carebridge_fixture_admin',password:sourceCluster.adminPassword,database:'postgres'});
    admin.on('error',()=>{});let sourceReceipt,targetReceipt;
    try{
      await admin.query(`CREATE DATABASE "${name}" OWNER carebridge_fixture_owner TEMPLATE template0`);
      const receipts=(await admin.query('SELECT datname,oid::bigint AS oid,datdba::bigint AS owner_oid FROM pg_catalog.pg_database WHERE datname IN ($1,$2)',
        [sourceCluster.config.database,name])).rows;
      const creation=databaseName=>{const row=receipts.find(value=>value.datname===databaseName);assert.ok(row);
        return {name:databaseName,oid:Number(row.oid),ownerOid:Number(row.owner_oid)};};
      sourceReceipt=creation(sourceCluster.config.database);targetReceipt=creation(name);
    }finally{await admin.end();}
    const stateDump=join(paths.restoreInput,'state.pgcustom');
    await freshFile(stateDump,await collect(reader.stream('database.pgcustom')));
    stage='recovery-state-restore';
    await native(join(options.bin,'pg_restore.exe'),['--dbname',name,'--no-password','--single-transaction',stateDump],{
      cwd:paths.root,env:{...dumpEnvironment,PGDATABASE:name,
        PGUSER:sourceCluster.config.user,PGPASSWORD:sourceCluster.password}});
    source=database(sourceCluster.config);
    const stateTarget=database({...sourceCluster.config,database:name});
    stage='recovery-state-fingerprint';
    assert.deepEqual(await fingerprint(stateTarget),before);await verifyRecoveryMigrationLedger(stateTarget);
    if(roleCheck){
      stage='recovery-state-role-boundary';
      // A database's CONNECT/TEMP ACL is not in this database-only dump.
      // Reapply that boundary only; never repair restored object privileges.
      await restoreSyntheticDatabaseConnectionPrivileges(stateTarget);
      // This temporary SAME-cluster topology deliberately violates service
      // admission's one-DB-per-role boundary. Prove the exact two owned DBs,
      // then require both admission attempts to fail; do not weaken the policy.
      // The separate-cluster restore below must still pass full verification.
      const ownedDatabases=(await source.transaction(tx=>tx.query(`SELECT datname,oid::bigint AS oid,datdba::bigint AS owner_oid
        FROM pg_catalog.pg_database WHERE datdba=$1::oid ORDER BY datname`,[sourceReceipt.ownerOid]))).rows;
      assert.deepEqual(ownedDatabases.map(row=>({name:row.datname,oid:Number(row.oid),ownerOid:Number(row.owner_oid)})),
        [sourceReceipt,targetReceipt].sort((a,b)=>a.name.localeCompare(b.name)));
      for(const candidate of [source,stateTarget])await assert.rejects(
        verifyDatabasePrivileges(candidate,await syntheticPrivilegeInput(candidate)),{message:'DATABASE_PRIVILEGES_UNAVAILABLE'});
      pass('same-cluster source and restore service admission refuses the exact shared-owner pair; no role policy relaxed');
      stage='recovery-state-synthetic-content';
      // Direct fixture-only role checks are NOT service admission or API start.
      const stateRuntime=database({...sourceCluster.config,database:name,
        user:SYNTHETIC_DB_ROLES.runtime,password:sourceCluster.roles[SYNTHETIC_DB_ROLES.runtime]});
      await verifyServices(stateRuntime,fixture,stateTarget);reviewChecks.stateRestored=true;
      await closeDatabase(stateRuntime);
    }else await verifyRecoveryRecipientFixture({owner:stateTarget,fixture:fixture.recipient,fingerprint});
    recipientChecks.stateRestored=true;
    stage='recovery-state-media';
    const stateStore=new PrivateFileStore(paths.stateMedia);
    for(const file of mediaFiles){
      const restoredBytes=await collect(reader.stream(file.name));assert.deepEqual(restoredBytes,file.data);
      if(file.manifest)await stateStore.write(file.name.slice(0,36),Readable.from([restoredBytes]),file.manifest);
      else {assert.equal(restoredBytes.length,0);await stateStore.remove(file.name.slice(0,36));}
    }
    if(preparedRecoverySamples){
      const stateFiles=await captureSyntheticMedia(stateTarget,stateStore);
      const restoredSamples=await capturePreparedRecoverySamples(stateTarget,preparedRecoverySamples,stateFiles);
      assert.deepEqual(restoredSamples,preparedFaultSamples);
      for(const sample of restoredSamples)sample.bytes.fill(0);
    }
    stage='recovery-state-compare';
    const stateChecks=await exerciseRecoveryStateComparison({source,sourcePeer:database(sourceCluster.config),target:stateTarget,
      input:{operationId:randomUUID(),bundleId:runId,sourceReceipt,targetReceipt,confirmTarget:name},fixture:recoveryFixture,fingerprint,
      recipientFixture:fixture.recipient,
      mediaObject:fixture.object,media:{roots:{source:sourceMediaReceipt,target:targetMediaReceipt},object:fixture.object,
        blocked:fixture.blocked,bytes:fixture.bytes,...(preparedFaultSamples?{prepared:preparedFaultSamples}:{})},
      ...(preparedFaultSamples?{onQuarantined:async target=>{
        await verifyQuarantinedRecoveryReviewFixture({owner:target,fingerprint,fixture:fixture.review});
        reviewChecks.quarantined=true;
      }}:{}),onPass:pass});
    assert.equal(stateChecks.length,preparedFaultSamples?23:18);
    recipientChecks.quarantined=true;
    recoveryStateEvidence={scope:'same-cluster-owned-restore',scenarioCount:stateChecks.length,
      preparedSamplesChecked:preparedRecoverySamples?.length??0,sourcePostBackupMutationsExercised:true,
      sameClusterServiceAdmissionDenied:roleCheck?true:null,sameClusterServiceRoleActivation:false,
      serviceReleaseAllowed:false,filesystemWriterQuiescenceVerified:false};
    await closeDatabases();
  }

  stage = 'restore-init'; await stopCluster(sourceCluster);
  const restoredCluster = await initializeCluster(paths.restored);
  assert.notEqual(sourceCluster.port,restoredCluster.port); assert.notEqual(sourceCluster.password,restoredCluster.password);
  stage = 'restore'; const restorePath = join(paths.restoreInput,'database.pgcustom');
  await freshFile(restorePath,await collect(reader.stream('database.pgcustom')));
  await native(join(options.bin,'pg_restore.exe'),['--dbname',restoredCluster.config.database,'--no-password','--single-transaction',restorePath],{
    cwd:paths.root,env:{ ...dumpEnvironment,PGPORT:String(restoredCluster.port),PGUSER:restoredCluster.config.user,PGPASSWORD:restoredCluster.password } });
  const targetStore = new PrivateFileStore(paths.restoredMedia);
  for (const file of mediaFiles) {
    const restoredBytes = await collect(reader.stream(file.name)); assert.deepEqual(restoredBytes,file.data);
    if (file.manifest) await targetStore.write(file.name.slice(0,36),Readable.from([restoredBytes]),file.manifest);
    else { assert.equal(restoredBytes.length,0); await targetStore.remove(file.name.slice(0,36)); }
  }
  await reader.close(); reader = null;
  let restored = database(restoredCluster.config);
  assert.deepEqual(await fingerprint(restored),before); assert.deepEqual(await migrate(restored),[]);await verifyRecoveryMigrationLedger(restored);
  assert.deepEqual(await readObject(targetStore,fixture.object,fixture.manifest),fixture.bytes);
  for (const file of mediaFiles) if (file.manifest) assert.deepEqual(await readObject(targetStore,file.name.slice(0,36),file.manifest),file.data);
  await assert.rejects(targetStore.write(fixture.blocked,Readable.from([fixture.bytes]),fixture.manifest),{ code:'STORAGE_UNAVAILABLE' });
  pass('fresh separate E cluster restores all table fingerprints, columns, triggers, migrations and byte/fence hashes');
  let restoredRuntime = roleCheck ? asRole(restoredCluster,'runtime') : restored;
  await verifyServices(restoredRuntime,fixture,restored);if(reviewChecks)reviewChecks.restored=true;
  recipientChecks.restored=true;
  pass('restored private clinical data stays forbidden to guardian; sealed revisions and unfinished drafts protected');
  if (roleCheck) {
    stage = 'restore-database-acl';
    await restoreSyntheticDatabaseConnectionPrivileges(restored);
    stage = 'restore-role-verification';
    await verifyDatabasePrivileges(restored,await syntheticPrivilegeInput(restored));
    await assert.rejects(migrate(restoredRuntime),{code:'42501'});
    await asRole(restoredCluster,'worker').transaction((tx) => tx.query('SELECT phase FROM cb_decoder_jobs'));
    pass('backup-only native dump preserves five-role object/column/function/default grants; explicit DB connection boundary reapplied with independent role passwords');
  }
  stage = 'restore-restart';
  await closeDatabases(); await stopCluster(restoredCluster); await startCluster(restoredCluster);
  restored = database(restoredCluster.config); assert.deepEqual(await fingerprint(restored),before);await verifyRecoveryMigrationLedger(restored);
  restoredRuntime = roleCheck ? asRole(restoredCluster,'runtime') : restored;
  await verifyServices(restoredRuntime,fixture,restored);if(reviewChecks)reviewChecks.restoredRestart=true;
  recipientChecks.restoredRestart=true;
  if (roleCheck) {
    await verifyDatabasePrivileges(restored,await syntheticPrivilegeInput(restored));
    pass('restored role separation survives its own process restart; application role still cannot change schema');
  }
  await closeDatabases(); await stopCluster(restoredCluster);
  pass('restored cluster survives its own independent postmaster restart without changing source');
  stage = 'complete';
} catch (error) {
  failure = { stage,code:/^WINDOWS_POSTGRES_[A-Z_]+$/.test(error.message ?? '') ? error.message : 'WINDOWS_POSTGRES_CHECK_FAILED',
    ...(Number.isInteger(error.roleCheckPhase) ? {rolePhase:error.roleCheckPhase} : {}),
    ...(error.workerControlObservation ? {workerControlObservation:error.workerControlObservation} : {}),
    ...(error.ownedWorkerObservation ? {ownedWorkerObservation:error.ownedWorkerObservation} : {}),
    ...(error.nativeMediaObservation ? {nativeMediaObservation:error.nativeMediaObservation} : {}),
    ...(error.recoveryStateObservation ? {recoveryStateObservation:error.recoveryStateObservation} : {}),
    ...(error.wrongPasswordObservation ? {wrongPasswordObservation:error.wrongPasswordObservation} : {}),
    ...(/^[A-Z0-9]{5}$/.test(error?.code??'')?{sqlstate:error.code}:{}),
    ...(['DATABASE_PRIVILEGES_UNAVAILABLE','DATABASE_PRIVILEGE_POLICY_UNAVAILABLE'].includes(error?.message)?{policyCode:error.message}:{}),
    ...(error?.code==='ERR_ASSERTION'?{assertionLine:Number(error.stack?.match(/windows-postgres-check\.mjs:(\d+):\d+/)?.[1])||null}:{}),
    ...(Number.isInteger(error.exitCode) ? { exitCode:error.exitCode,category:error.category } : {}) };
  console.error(failure.code); console.error(`Synthetic check stage: ${stage}`); process.exitCode = 1;
} finally {
  try { await reader?.close(); await closeDatabases(); for (const cluster of [...clusters].reverse()) await stopCluster(cluster); }
  catch { failure ??= { stage:'stop',code:'WINDOWS_POSTGRES_STOP_UNCONFIRMED' }; process.exitCode = 1; }
  if(tlsInventory && !failure)try{await cleanupSyntheticTls();}catch{failure={stage:'tls-cleanup',code:'WINDOWS_POSTGRES_TLS_CLEANUP_UNCONFIRMED'};process.exitCode=1;}
  bundleKey?.fill(0);
  for(const sample of preparedFaultSamples??[])sample.bytes.fill(0);
  // Owned synthetic databases/media/bundle remain OFFLINE as diagnostic proof.
  // No recursive deletion, no operating role recovery/activation. Generated
  // Plaintext passwords and bundle key are not retained in files/logs; password
  // verifiers remain in these synthetic DBs, not operating credentials.
  for (const cluster of clusters) { cluster.adminPassword = null; cluster.password = null; cluster.config.password = null;
    for (const name of Object.keys(cluster.roles)) cluster.roles[name] = null; }
  if(sourceManifest)try{
    assert.deepEqual(await recoverySourceManifest(),sourceManifest);sourceUnchanged=true;
  }catch{failure??={stage:'source-verification',code:'WINDOWS_POSTGRES_SOURCE_CHANGED'};process.exitCode=1;}
  const result = { runId,at:new Date().toISOString(),passed:!failure && stage === 'complete' && checks.length === (nativeMediaCheck?(recoveryStateCheck?78:55):roleCheck?48:recoveryStateCheck?27:9) &&
    (!reviewChecks || sourceUnchanged && Object.values(reviewChecks).every(value=>value===true)) &&
    Object.values(recipientChecks).every(value=>value===true) &&
    (!roleCheck || credentialService?.cleanup && tlsInventory?.cleanup && credentialService.workerControl?.allChildrenTerminal) &&
    (!nativeMediaCheck || credentialService?.nativeMedia?.fixtureCleanup && credentialService.nativeMedia.allChildrenTerminal &&
      (recoveryStateCheck ? credentialService.nativeMedia.browserRequested===false&&credentialService.nativeMedia.browser===null&&
        recoveryStateEvidence?.preparedSamplesChecked===2 :
        credentialService.nativeMedia.browser?.passed && credentialService.nativeMedia.browser?.cleanup?.browserStopped &&
        credentialService.nativeMedia.browser?.cleanup?.contextsClosed)),roleCheck,nativeMediaCheck,recoveryStateCheck,
    scenarioCount:checks.length,checks,mediaInventory,credentialService,reviewChecks,recipientChecks,recoveryStateEvidence,preparedRecoverySamples,migrationManifest:expectedMigrations,
    sourceManifest,sourceUnchanged:sourceManifest?sourceUnchanged:null,
    tlsFixtureCleanup:tlsInventory?.cleanup ?? null,retainedSyntheticRoot:paths?.root ?? null,
    sourceStopped:clusters.length > 0 && !clusters[0].child,restoredStopped:clusters.length === 2 && !clusters[1].child,
    runtimeVersion:PORTABLE_POSTGRES_VERSION,
    nodeRuntime:{node:process.versions.node,v8:process.versions.v8,uv:process.versions.uv,platform:process.platform,arch:process.arch},failure,
    limitations:['Synthetic fresh E clusters only; no real child data or browser-data migration',
      'Same-disk restoration is not independent backup, disk encryption or power-loss verification',
      'Portable unsigned vendor binaries verified by vendor checksum; no Windows protection bypass',
      'Synthetic DPAPI/DB/TLS verification is not operating credential issuance, RLS/tenant SQL isolation or Windows service-account verification',
      nativeMediaCheck ? 'Requests actual native ClamAV/FFmpeg through synthetic Windows IPC/E/DPAPI/TLS/PG workers; only a passed result proves the scoped check, never operating AV approval or a Windows service' :
        'Worker SQL/E composition uses synthetic scanner/decoder protocol peers, not native AV/decoder acceptance or an operating worker service',
      'No operating secret recovery, separate service account, quarantine/cutover, operating TLS/HBA, external access or API activation',
      recoveryStateCheck?'Requested same-cluster terminal quarantine and latest DB/media comparison; only a passed result proves these scoped checks, never release, operating deletion or cutover':
        'No recovery-state comparison or quarantine activation requested in this run',
      ...(recoveryStateCheck?[nativeMediaCheck?
        'Combined recovery uses native HTTP PNG/video samples; browser/iPhone UI is not requested or newly verified. The separate-cluster snapshot restore is not the quarantined target':
        'External-file checks use fresh synthetic original PNG/fences, not candidate/preparation native-engine integration',
        'Post-backup source edits/deletion intents are intentional synthetic fault cases, not an unchanged-source-data guarantee',
        'Captured root dev/ino is fixture directory identity, not OS ownership or ACL proof; SQL locks do not verify filesystem writer quiescence']:[]),
      'Synthetic TLS keys are removed after confirmed cluster stops; retained source cluster is diagnostic, not restartable operating backup',
      'Cleanup is proven only by explicit result fields; failed runs can retain synthetic TLS keys and DPAPI-encrypted test credentials, never an operating backup'] };
  await mkdir(resultDirectory,{ recursive:true });
  const resultBytes=`${JSON.stringify(result,null,2)}\n`;
  if(nativeMediaCheck&&recoveryStateCheck){
    await freshFile(join(resultDirectory,`native-recovery-${runId}-results.json`),resultBytes);
  }else if(roleCheck&&!nativeMediaCheck){
    // The UUID result is authoritative for this run. Never overwrite the prior
    // unversioned result; an absent legacy summary may be created exclusively.
    await freshFile(join(resultDirectory,`database-privileges-${runId}-results.json`),resultBytes);
    try{await freshFile(join(resultDirectory,'database-privileges-results.json'),resultBytes);}
    catch(error){if(error?.code!=='EEXIST')throw error;}
  }else{
    if(nativeMediaCheck)await freshFile(join(resultDirectory,`windows-native-worker-${runId}-results.json`),resultBytes);
    if(recoveryStateCheck)await freshFile(join(resultDirectory,`recovery-state-${runId}-results.json`),resultBytes);
    await writeFile(join(resultDirectory,nativeMediaCheck ? 'windows-native-worker-results.json' : recoveryStateCheck?'recovery-state-results.json':'windows-postgres-results.json'),resultBytes);
  }
  console.log(JSON.stringify(result,null,2));
  if (!result.passed) process.exitCode = 1;
}

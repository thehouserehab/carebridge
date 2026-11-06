// Fresh, synthetic-only E session. Existing check/session roots are never
// adopted; successful close leaves offline data but removes this run's keys.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {windowsPostgresOptions,postgresCheckPaths,windowsPostgresEnvironment,PORTABLE_POSTGRES_VERSION,PORTABLE_POSTGRES_SHA256} from './windows-postgres-policy.mjs';
import {createSyntheticPostgresRuntime} from './windows-synthetic-postgres-runtime.mjs';
import {databaseFromPool} from './database.mjs';
import {migrate} from './migrate.mjs';
import {configureDatabasePrivileges,verifyDatabasePrivileges} from './database-privileges.mjs';
import {SYNTHETIC_DB_ROLES,syntheticPrivilegeInput} from './database-privileges-native-check.mjs';
import {WindowsDatabaseCredentialStore} from './windows-database-credential-store.mjs';
import {databaseCredentialOptions} from './windows-database-credential-policy.mjs';
import {openWindowsDatabaseService} from './windows-database-service.mjs';
import {seedNativeInteractiveFixture} from './native-interactive-seed.mjs';
import {createSyntheticSecretCleanup} from './synthetic-secret-cleanup.mjs';
import {WindowsSyntheticSessionVault} from './windows-synthetic-session-vault.mjs';
import {retainedPurpose,retainedReceiptName,closedReceiptName,retainedFile,retainedJson,consumeClosedReceipt,
  retentionReceipt,validateRetentionReceipt,retainedSeed,restoreRetainedSeed,schemaManifest,captureRetentionFiles,
  validateRetainedPayload,writeClosedReceipt} from './synthetic-session-retention.mjs';
const unavailable=()=>new Error('WINDOWS_SYNTHETIC_STORAGE_UNAVAILABLE');

export function createWindowsSyntheticStorage(args,selection={mode:'ephemeral',sessionId:null}) {
  if(process.platform!=='win32')throw unavailable();
  if(!['ephemeral','create-resumable','resume'].includes(selection.mode)||selection.mode!=='resume'&&selection.sessionId!==null)throw unavailable();
  const mode=selection.mode,retaining=mode!=='ephemeral';
  const options=windowsPostgresOptions(args),runId=mode==='resume'?selection.sessionId:randomUUID(),paths=postgresCheckPaths(options.privateRoot,runId);
  const environment=windowsPostgresEnvironment(process.env,options.bin);
  const storage=Object.freeze({base:options.base,powershell:options.powershell,syntheticRunId:runId});
  const credentialOptions=databaseCredentialOptions(storage),credentialStore=new WindowsDatabaseCredentialStore(storage);
  const pg=createSyntheticPostgresRuntime({options,root:paths.root,environment,
    roles:Object.values(SYNTHETIC_DB_ROLES).filter(role=>role!==SYNTHETIC_DB_ROLES.owner)});
  const databases=new Set(),credentials=new Map();
  const lockPath=join(options.privateRoot,'checks','.carebridge-interactive-session.json');
  const tlsRoot=join(paths.root,'tls');
  const secrets=createSyntheticSecretCleanup({roots:retaining?[tlsRoot]:[tlsRoot,credentialOptions.root],lockPath,
    regularDirectoryChain:pg.regularDirectoryChain,hasPendingSecrets:()=>pg.hasPendingSecrets(),
    ...(retaining?{beforeRelease:certifyRetainedStop}:{})});
  const vault=retaining?new WindowsSyntheticSessionVault(storage):null;
  let cluster,privileges,certificate,seed,stage='not-started',initialized=false,started=false,stopped=false,secretsDisposed=false;
  let receipt,payload,cleanStop=false,secretsRetained=false,resumable=false,finalized=false;
  const database=config=>{const db=databaseFromPool(pg.pool(config));databases.add(db);return db;};
  async function closeConnections(){for(const db of [...databases]){await db.close();databases.delete(db);}}
  async function initialize(signal){
    if(started)throw unavailable();started=true;const check=()=>signal?.throwIfAborted();check();
    stage='runtime-verify';const prepared=JSON.parse(await pg.native(options.powershell,['-NoProfile','-NonInteractive','-File',
      fileURLToPath(new URL('../scripts/prepare-beta-postgres.ps1',import.meta.url)),'-Base',options.base,'-ConfirmPortableRuntime','-VerifyOnly']));
    assert.equal(prepared.prepared,true);assert.equal(prepared.reused,true);
    assert.equal(prepared.version,PORTABLE_POSTGRES_VERSION);assert.equal(prepared.archiveSha256,PORTABLE_POSTGRES_SHA256);
    assert.equal(resolve(prepared.bin).toLowerCase(),resolve(options.bin).toLowerCase());check();
    stage='lock';await pg.regularDirectoryChain(join(options.privateRoot,'checks'));
    // Existing/uncertain locks are never removed by a new invocation.
    const lockBytes=Buffer.from(JSON.stringify({schema:1,purpose:'synthetic-e-interactive',runId,pid:process.pid}));
    try{await secrets.acquireLock(lockBytes);}finally{lockBytes.fill(0);}check();
    if(mode==='resume'){await resume(check);return;}
    await mkdir(paths.root);await pg.freshFile(join(paths.root,'.carebridge-check.json'),JSON.stringify({schema:1,purpose:'synthetic-native-e-postgres',runId,root:paths.root}));
    await mkdir(paths.sourceMedia);check();
    stage='cluster';for(const name of ['postgres','initdb','pg_ctl'])assert.match(await pg.native(join(options.bin,`${name}.exe`),['--version'],{cwd:paths.root}),/\(PostgreSQL\) 18\.6\b/);
    check();cluster=await pg.initializeCluster(paths.source);check();
    stage='migration';let owner=database(cluster.config);await migrate(owner);privileges=await syntheticPrivilegeInput(owner);
    await configureDatabasePrivileges(owner,privileges);assert.equal((await verifyDatabasePrivileges(owner,privileges)).verified,true);check();
    stage='tls';const tls=JSON.parse(await pg.native(options.powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',
      fileURLToPath(new URL('./tests/windows-postgres-tls-fixture.ps1',import.meta.url)),'-Base',options.base,'-RunId',runId]));
    assert.deepEqual(tls,{schema:1,purpose:'synthetic-postgres-tls',created:true});
    await secrets.inventory(tlsRoot,['.carebridge-tls-fixture.json','good.crt','good.key','wrong.crt','wrong.key']);
    certificate=await readFile(join(tlsRoot,'good.crt'),'ascii');check();
    const admin=pg.pool({...cluster.config,user:'carebridge_fixture_admin',password:cluster.adminPassword,database:'postgres'});
    admin.on('error',()=>{});
    try{await admin.query("ALTER SYSTEM SET ssl='on'");await admin.query("ALTER SYSTEM SET ssl_cert_file='../tls/good.crt'");
      await admin.query("ALTER SYSTEM SET ssl_key_file='../tls/good.key'");await admin.query("ALTER SYSTEM SET ssl_min_protocol_version='TLSv1.2'");}
    finally{await admin.end();}
    await closeConnections();await pg.stopCluster(cluster);check();await pg.startCluster(cluster);check();owner=database(cluster.config);
    stage='credentials';for(const kind of ['runtime','worker']){
      const id=randomUUID(),bytes=Buffer.from(cluster.roles[SYNTHETIC_DB_ROLES[kind]],'ascii');
      try{await credentialStore.store(id,privileges,kind,bytes);credentials.set(kind,id);}finally{bytes.fill(0);}check();
    }
    if(!retaining)await secrets.inventory(credentialOptions.root,['.carebridge-database-credentials.json',...[...credentials.values()].map(id=>`${id}.dpapi`)]);
    const runtime=await openWindowsDatabaseService({...configuration('runtime'),kind:'runtime'});databases.add(runtime);
    stage='seed';seed=await seedNativeInteractiveFixture({owner,runtime});check();await closeConnections();
    if(retaining){stage='protect-session';await protectSession();check();}
    initialized=true;stage='ready';
  }
  async function checkStorageAcl(){
    const result=JSON.parse(await pg.native(options.powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',
      fileURLToPath(new URL('../scripts/check-synthetic-session-storage.ps1',import.meta.url)),'-Base',options.base,'-RunId',runId]));
    assert.deepEqual(result,{verified:true});
  }
  async function protectSession(){
    const vaultId=randomUUID();receipt=retentionReceipt(runId,vaultId);
    // System identifier is captured from our direct ready child, not a port
    // or an unauthenticated receipt. No owner password is retained.
    const admin=database({...cluster.config,user:'carebridge_fixture_admin',password:cluster.adminPassword});
    const {rows}=await admin.transaction(tx=>tx.query('SELECT system_identifier::text AS id FROM pg_control_system()'));
    await closeConnections();
    const key=await retainedFile(join(tlsRoot,'good.key'),4096),tlsReceipt=await retainedFile(join(tlsRoot,'.carebridge-tls-fixture.json'),4096);
    try{
      payload={schema:1,purpose:retainedPurpose,sessionId:runId,root:paths.root,vaultId,adminPassword:cluster.adminPassword,
        port:cluster.port,systemIdentifier:rows[0].id,privileges,credentialIds:Object.fromEntries(credentials),seed:retainedSeed(seed),
        tls:{certificate,privateKey:key.bytes.toString('ascii'),receipt:tlsReceipt.bytes.toString('utf8')},
        evidence:await captureRetentionFiles(paths.root,credentialOptions.root,Object.fromEntries(credentials)),schemaHash:(await schemaManifest()).sha256};
      validateRetainedPayload(payload,{sessionId:runId,root:paths.root,vaultId});
      await checkStorageAcl();const bytes=Buffer.from(JSON.stringify(payload));
      try{await vault.store(vaultId,bytes);}finally{bytes.fill(0);}
      await pg.freshFile(join(paths.root,retainedReceiptName),JSON.stringify(receipt));secretsRetained=true;
    }finally{key.bytes.fill(0);tlsReceipt.bytes.fill(0);}
  }
  async function resume(check){
    stage='resume-admission';await pg.regularDirectoryChain(paths.root);await checkStorageAcl();
    receipt=validateRetentionReceipt((await retainedJson(join(paths.root,retainedReceiptName))).value,runId);
    const closed=await retainedJson(join(paths.root,closedReceiptName));assert.deepEqual(closed.value,{...receipt,closed:true});
    const bytes=await vault.load(receipt.vaultId);
    try{payload=validateRetainedPayload(JSON.parse(bytes.toString('utf8')),{sessionId:runId,root:paths.root,vaultId:receipt.vaultId});}
    finally{bytes.fill(0);}
    assert.deepEqual(await captureRetentionFiles(paths.root,credentialOptions.root,payload.credentialIds),payload.evidence);
    const schema=await schemaManifest();assert.equal(schema.sha256,payload.schemaHash);
    await assert.rejects(lstat(tlsRoot),{code:'ENOENT'});check();
    cluster=await pg.registerRetainedCluster({directory:paths.source,adminPassword:payload.adminPassword,port:payload.port,systemIdentifier:payload.systemIdentifier});
    // A consumed close receipt cannot be reused after a crash or partial start.
    await consumeClosedReceipt(join(paths.root,closedReceiptName),closed.seal);secretsRetained=true;check();
    await mkdir(tlsRoot);
    for(const [name,value]of [['good.crt',payload.tls.certificate],['good.key',payload.tls.privateKey],['.carebridge-tls-fixture.json',payload.tls.receipt]])
      await pg.freshFile(join(tlsRoot,name),value);
    await secrets.inventory(tlsRoot,['good.crt','good.key','.carebridge-tls-fixture.json']);await checkStorageAcl();check();
    certificate=payload.tls.certificate;privileges=payload.privileges;
    for(const kind of ['runtime','worker'])credentials.set(kind,payload.credentialIds[kind]);
    stage='resume-cluster';await pg.startCluster(cluster);check();
    // Read-only verification: never migrate, seed, grant privileges or issue
    // accounts on resume. Service admission performs its own privilege check.
    const admin=database({...cluster.config,user:'carebridge_fixture_admin',password:cluster.adminPassword});
    const result=await admin.transaction(tx=>tx.query('SELECT name,checksum FROM cb_schema_migrations ORDER BY name'));
    assert.deepEqual(result.rows,schema.rows);await closeConnections();
    const runtime=await openWindowsDatabaseService({...configuration('runtime'),kind:'runtime'});databases.add(runtime);
    await runtime.transaction(tx=>tx.query('SELECT 1'));await closeConnections();check();
    seed=restoreRetainedSeed(payload.seed);initialized=true;stage='ready';
  }
  async function certifyRetainedStop(){
    if(!cleanStop||!initialized||!secretsRetained||resumable)return;
    const offline=await pg.inspectStoppedCluster(cluster);assert.equal(offline.systemIdentifier,payload.systemIdentifier);
    assert.deepEqual(await captureRetentionFiles(paths.root,credentialOptions.root,payload.credentialIds),payload.evidence);
    await writeClosedReceipt(paths.root,receipt);resumable=true;
  }
  function configuration(kind){
    if(!['runtime','worker'].includes(kind)||!credentials.has(kind)||!cluster||!certificate)throw unavailable();
    return Object.freeze({storage,credentialId:credentials.get(kind),privileges,
      endpoint:Object.freeze({host:'127.0.0.1',port:cluster.port,ca:certificate})});
  }
  async function stopDatabase(){
    if(databases.size)throw unavailable();
    for(const owned of pg.clusters)await pg.stopCluster(owned);
    stopped=true;
  }
  async function disposeSecrets({clean=false}={}){
    if(finalized)return;
    if(!stopped||pg.clusters.some(item=>item.child)||pg.hasPendingSecrets())throw unavailable();seed?.forgetCredentials();
    cleanStop=clean;
    await secrets.dispose();
    for(const owned of pg.clusters){owned.adminPassword=null;owned.password=null;owned.config.password=null;for(const key of Object.keys(owned.roles))owned.roles[key]=null;}
    payload=null;secretsDisposed=!retaining;finalized=true;
  }
  return Object.freeze({initialize,configuration,closeConnections,stopDatabase,disposeSecrets,environment,
    mediaRoot:paths.sourceMedia,root:paths.root,runId,get seed(){return seed;},
    status:()=>Object.freeze({runId,stage,initialized,databaseStopped:stopped,secretsDisposed,
      ...(retaining?{mode,secretsRetained,resumable}:{})})});
}

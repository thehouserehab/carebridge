// Fresh owned E fixture only. Actual DPAPI -> pg -> same-connection guard.
// No operating credentials, HTTP, external endpoint or trust-store mutation.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {lstat,readFile,readdir,unlink,rmdir} from 'node:fs/promises';
import {win32} from 'node:path';
import {Pool} from 'pg';
import {WindowsDatabaseCredentialStore} from './windows-database-credential-store.mjs';
import {databaseCredentialOptions} from './windows-database-credential-policy.mjs';
import {openWindowsDatabaseService,windowsDatabaseServiceOptions} from './windows-database-service.mjs';
import {syntheticPrivilegeInput,SYNTHETIC_DB_ROLES} from './database-privileges-native-check.mjs';
import {exerciseOwnedWindowsWorker} from './windows-media-worker-native-check.mjs';
import {exerciseWindowsWorkerControl} from './windows-worker-control-native-check.mjs';
import {exerciseWindowsNativeWorker} from './windows-native-worker-check.mjs';

const denied=(promise) => assert.rejects(promise,{message:'DATABASE_SERVICE_UNAVAILABLE'});
const digest=(bytes) => createHash('sha256').update(bytes).digest('hex');
export async function exerciseCredentialDatabaseService({owner,storage,port,rolePasswords,certificate,wrongCertificate,selectTlsIdentity,freshProcess,mediaStore,freshOwner,workerEnvironment,nativeMediaCheck=false,nativeBrowserCheck=true,observeWorkerConnections,browserRuntime}) {
  const options=databaseCredentialOptions(storage),store=new WindowsDatabaseCredentialStore(storage),entries=[],services=new Set(),checks=[];
  let phase=301,cleanup=false,failure,workerControl,workerControlObservation,nativeMedia,nativeMediaObservation,ownedWorkerObservation;
  const plan=await syntheticPrivilegeInput(owner);
  const configuration=(entry,endpoint={host:'127.0.0.1',port,transport:'synthetic-loopback'}) => ({
    storage,credentialId:entry.id,privileges:entry.privileges,kind:entry.kind,endpoint});
  const save=async(kind,privileges=plan,secret=rolePasswords[SYNTHETIC_DB_ROLES[kind]]) => {
    const entry={id:randomUUID(),kind,privileges};entries.push(entry);const bytes=Buffer.from(secret,'ascii');
    try {await store.store(entry.id,privileges,kind,bytes);} finally {bytes.fill(0);}
    entry.path=win32.join(options.root,`${entry.id}.dpapi`);const ciphertext=await readFile(entry.path);
    try{assert.ok(!ciphertext.includes(secret)&&!ciphertext.includes(Buffer.from(secret).toString('base64')));entry.sha256=digest(ciphertext);}finally{ciphertext.fill(0);}
    return entry;
  };
  const open=async(entry,endpoint) => {const service=await openWindowsDatabaseService(configuration(entry,endpoint));services.add(service);return service;};
  const close=async(service) => {await service.close();services.delete(service);};
  const certificateRefusal=async(entry,endpoint,expectedCodes) => {
    const {connection}=windowsDatabaseServiceOptions(configuration(entry,endpoint));let secretRequested=false;
    const probe=new Pool({...connection,password:() => {secretRequested=true;throw new Error('No secret before certificate admission');}});
    probe.on('error',() => {});
    try {await assert.rejects(probe.query('SELECT 1'),(error) => expectedCodes.includes(error.code));}
    finally {await probe.end();}
    assert.equal(secretRequested,false); // Failure occurred before password retrieval.
  };
  try {
    assert.equal(typeof nativeMediaCheck,'boolean');
    assert.equal(typeof nativeBrowserCheck,'boolean');
    assert.ok(options.syntheticRunId);await assert.rejects(lstat(options.root),{code:'ENOENT'});
    for(const kind of ['runtime','bootstrap','backup','worker']) {
      const entry=await save(kind),service=await open(entry);
      const actual=await service.transaction(async(tx) => (await tx.query(`SELECT current_user AS role,session_user AS session,
        current_database() AS database,(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS ssl`)).rows[0]);
      assert.deepEqual(actual,{role:SYNTHETIC_DB_ROLES[kind],session:SYNTHETIC_DB_ROLES[kind],database:plan.target.name,ssl:false});await close(service);
    }
    checks.push('four fresh role pools authenticate with DPAPI-recovered passwords through actual SCRAM and same-connection role/DB/grant guards');
    phase=302;
    const readerCode=`
      import {openWindowsDatabaseService} from ${JSON.stringify(new URL('./windows-database-service.mjs',import.meta.url).href)};
      const {storage,endpoint,entries}=JSON.parse(process.argv[1]);let service;
      try {for(const entry of entries){service=await openWindowsDatabaseService({storage,endpoint,...entry});
        const actual=await service.transaction(async(tx)=>(await tx.query('SELECT current_user AS role,session_user AS session,(SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS ssl')).rows[0]);
        if(actual.role!==entry.privileges.roles[entry.kind]||actual.session!==actual.role||actual.ssl!==true)throw new Error('Mismatch');
        await service.close();service=null;}process.stdout.write('CREDENTIAL_TLS_READ_OK');}
      catch {process.stderr.write('CREDENTIAL_TLS_READ_FAILED');process.exitCode=1;}
      finally {await service?.close().catch(()=>{});}
    `;
    await freshProcess(readerCode,{storage,endpoint:{host:'127.0.0.1',port,ca:certificate},
      entries:entries.map(({id,kind,privileges}) => ({credentialId:id,kind,privileges}))});
    checks.push('a fresh process recovers all four persisted credentials and verifies TLS/identity/grants despite poisoned PG environment defaults');
    phase=303;const worker=entries.find((entry) => entry.kind==='worker');
    const wrong=await save('worker',plan,randomBytes(32).toString('hex'));await denied(open(wrong));
    await denied(openWindowsDatabaseService({...configuration(worker),kind:'runtime'}));
    for(const field of ['oid','ownerOid']) {
      const changed={roles:plan.roles,target:{...plan.target,[field]:plan.target[field]+1}};
      const entry=await save('worker',changed);await denied(open(entry));
    }
    const swapped={roles:{...plan.roles,worker:plan.roles.runtime,runtime:plan.roles.worker},target:plan.target};
    const impersonated=await save('worker',swapped,rolePasswords[plan.roles.runtime]);await denied(open(impersonated));
    checks.push('wrong encrypted password, credential purpose, actual target OIDs and relabelled app-as-worker plan fail closed without fallback');
    phase=304;
    const caErrors=['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE'];
    await certificateRefusal(worker,{host:'127.0.0.1',port},caErrors);
    await certificateRefusal(worker,{host:'127.0.0.1',port,ca:wrongCertificate},caErrors);
    await denied(open(worker,{host:'127.0.0.1',port}));
    await denied(open(worker,{host:'127.0.0.1',port,ca:wrongCertificate}));
    checks.push('TLS without a trusted CA or with the wrong CA refuses startup instead of downgrading to plaintext');
    phase=305;await selectTlsIdentity('wrong');
    try{
      await certificateRefusal(worker,{host:'127.0.0.1',port,ca:wrongCertificate},['ERR_TLS_CERT_ALTNAME_INVALID']);
      await denied(open(worker,{host:'127.0.0.1',port,ca:wrongCertificate}));
    }
    finally{await selectTlsIdentity('good');}
    const service=await open(worker,{host:'127.0.0.1',port,ca:certificate});
    assert.equal(await service.transaction(async(tx) => (await tx.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0].ssl),true);
    const first=service.close();assert.equal(service.close(),first);await first;services.delete(service);
    await denied(service.transaction(() => assert.fail('closed service must not admit work')));
    checks.push('a trusted certificate for the wrong IP is refused; restoring the correct certificate admits encrypted work and close is terminal/idempotent');
    phase=306;
    // TLS identity switches close all fixture pools. Do not reuse the stale
    // owner argument from before those confirmed cluster restarts.
    const workerChecks=await exerciseOwnedWindowsWorker({owner:await freshOwner(),store:mediaStore,configuration,open,close,
      runtimeEntry:entries.find((entry) => entry.kind==='runtime'),workerEntry:worker,endpoint:{host:'127.0.0.1',port,ca:certificate}});
    assert.equal(workerChecks.length,2);checks.push(...workerChecks);
    phase=307;
    workerControl=await exerciseWindowsWorkerControl({owner:await freshOwner(),store:mediaStore,configuration,open,close,
      runtimeEntry:entries.find((entry) => entry.kind==='runtime'),workerEntry:worker,endpoint:{host:'127.0.0.1',port,ca:certificate},environment:workerEnvironment});
    assert.equal(workerControl.checks.length,2);assert.equal(workerControl.allChildrenTerminal,true);checks.push(...workerControl.checks);
    if(nativeMediaCheck){
      assert.equal(typeof observeWorkerConnections,'function');
      phase=308;nativeMedia=await exerciseWindowsNativeWorker({owner:await freshOwner(),store:mediaStore,configuration,open,close,
        runtimeEntry:entries.find(entry=>entry.kind==='runtime'),workerEntry:worker,endpoint:{host:'127.0.0.1',port,ca:certificate},environment:workerEnvironment,observeWorkerConnections,browserRuntime,verifyBrowser:nativeBrowserCheck});
      assert.equal(nativeMedia.scenarioCount,nativeBrowserCheck?7:6);assert.equal(nativeMedia.allChildrenTerminal,true);assert.equal(nativeMedia.fixtureCleanup,true);
      assert.equal(nativeMedia.browserRequested,nativeBrowserCheck);
      if(nativeBrowserCheck){
        assert.equal(nativeMedia.browser?.passed,true);assert.equal(nativeMedia.browser?.cleanup?.browserStopped,true);
        assert.equal(nativeMedia.browser?.cleanup?.contextsClosed,true);
      }else assert.equal(nativeMedia.browser,null); // Recovery-only HTTP evidence is never UI success.
      checks.push(...nativeMedia.checks);
    }
  } catch(error) {failure=true;if(Number.isInteger(error.roleCheckPhase)) phase=error.roleCheckPhase;workerControlObservation=error.workerControlObservation;
    nativeMediaObservation=error.nativeMediaObservation;ownedWorkerObservation=error.ownedWorkerObservation;}
  finally {
    for(const service of services)try{await service.close();}catch{failure=true;}
    try {
      if(failure)throw new Error('Retain uncertain owned fixture');
      assert.equal(options.root,win32.join(options.privateRoot,'checks',`credential-check-${options.syntheticRunId}`));
      const info=await lstat(options.root);assert.ok(info.isDirectory()&&!info.isSymbolicLink());
      const receiptName='.carebridge-database-credentials.json';
      assert.deepEqual((await readdir(options.root)).sort(),[receiptName,...entries.map(({id}) => `${id}.dpapi`)].sort());
      const receipt=JSON.parse(await readFile(win32.join(options.root,receiptName)));
      assert.equal(receipt.schema,1);assert.equal(receipt.root,options.root);assert.equal(receipt.purpose,'carebridge-windows-database-credentials');
      for(const entry of entries) {
        const file=await lstat(entry.path);assert.ok(file.isFile()&&!file.isSymbolicLink()&&file.nlink===1);
        const ciphertext=await readFile(entry.path);try{assert.equal(digest(ciphertext),entry.sha256);}finally{ciphertext.fill(0);}
      }
      const receiptInfo=await lstat(win32.join(options.root,receiptName));assert.ok(receiptInfo.isFile()&&!receiptInfo.isSymbolicLink()&&receiptInfo.nlink===1);
      // Known exact synthetic ciphertext files and empty UUID root only.
      for(const entry of entries)await unlink(entry.path);await unlink(win32.join(options.root,receiptName));await rmdir(options.root);cleanup=true;
    } catch {failure=true;}
  }
  if(failure){const error=new Error('DATABASE_CREDENTIAL_SERVICE_NATIVE_CHECK_FAILED');error.roleCheckPhase=phase;
    if(workerControlObservation)error.workerControlObservation=workerControlObservation;
    if(ownedWorkerObservation)error.ownedWorkerObservation=ownedWorkerObservation;
    if(nativeMediaObservation)error.nativeMediaObservation=nativeMediaObservation;throw error;}
  return {checks,cleanup,credentialCount:entries.length,workerControl:{childCount:workerControl.childCount,allChildrenTerminal:workerControl.allChildrenTerminal,
    scenarioCount:workerControl.checks.length,terminalEvidence:workerControl.terminalEvidence},nativeMedia:nativeMedia??null};
}

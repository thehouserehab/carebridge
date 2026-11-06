// Source composition checks only; not evidence of native SQL/media success.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {posix} from 'node:path';
const source=name=>readFile(new URL(`../${name}`,import.meta.url),'utf8');

test('combined restore uses backup for dump and fixture owner for restore without repairing object grants',async()=>{
  const runner=await source('windows-postgres-check.mjs');
  assert.match(runner,/PGUSER:roleCheck \? SYNTHETIC_DB_ROLES\.backup : sourceCluster\.config\.user/);
  assert.match(runner,/env:\{\.\.\.dumpEnvironment,PGDATABASE:name,\s*PGUSER:sourceCluster\.config\.user,PGPASSWORD:sourceCluster\.password\}/);
  assert.match(runner,/await restoreSyntheticDatabaseConnectionPrivileges\(stateTarget\)/);
  assert.match(runner,/FROM pg_catalog\.pg_database WHERE datdba=\$1::oid ORDER BY datname/);
  assert.match(runner,/\[sourceReceipt,targetReceipt\]\.sort/);
  assert.match(runner,/for\(const candidate of \[source,stateTarget\]\)await assert\.rejects\(\s*verifyDatabasePrivileges\(candidate,await syntheticPrivilegeInput\(candidate\)\),\{message:'DATABASE_PRIVILEGES_UNAVAILABLE'\}\)/);
  assert.match(runner,/await verifyDatabasePrivileges\(restored,await syntheticPrivilegeInput\(restored\)\)/);
  assert.match(runner,/sameClusterServiceAdmissionDenied:roleCheck\?true:null,sameClusterServiceRoleActivation:false/);
  assert.doesNotMatch(runner,/configureDatabasePrivileges\(stateTarget/);
  assert.ok(runner.indexOf('await verifyServices(stateRuntime,fixture,stateTarget)')<runner.indexOf("stage='recovery-state-compare'"));
});
test('native recovery binds the same processed manifests to source and state restore and preserves old result files',async()=>{
  const runner=await source('windows-postgres-check.mjs'),state=await source('recovery-state-native-check.mjs');
  assert.match(runner,/preparedRecoverySamples=credentialService\.nativeMedia\.preparedRecoverySamples/);
  assert.match(runner,/capturePreparedRecoverySamples\(source,preparedRecoverySamples,mediaFiles\)/);
  assert.match(runner,/capturePreparedRecoverySamples\(stateTarget,preparedRecoverySamples,stateFiles\)/);
  assert.match(runner,/verifyQuarantinedRecoveryReviewFixture\(\{owner:target,fingerprint,fixture:fixture\.review\}\)/);
  assert.match(runner,/stateChecks\.length,preparedFaultSamples\?23:18/);
  assert.match(runner,/recoveryStateCheck\?78:55/);
  assert.match(runner,/if\(nativeMediaCheck&&recoveryStateCheck\)\{\s*await freshFile\(join\(resultDirectory,`native-recovery-\$\{runId\}-results\.json`\),resultBytes\)/);
  assert.ok(state.indexOf('exercisePreparedRecoveryFaults({')<state.indexOf('post-backup text edit'));
  assert.match(runner,/serviceReleaseAllowed:false,filesystemWriterQuiescenceVerified:false/);
});
test('recovery-only HTTP evidence cannot claim a new browser run or weaken existing native-browser checks',async()=>{
  const runner=await source('windows-postgres-check.mjs'),credentials=await source('database-credential-service-native-check.mjs');
  const worker=await source('windows-native-worker-check.mjs');
  assert.match(runner,/if\(nativeMediaCheck&&!recoveryStateCheck\)\{browserRuntime=messageBrowserOptions/);
  assert.match(runner,/nativeBrowserCheck:!recoveryStateCheck/);
  assert.match(credentials,/nativeBrowserCheck=true/);
  assert.match(credentials,/scenarioCount,nativeBrowserCheck\?7:6/);
  assert.match(credentials,/else assert\.equal\(nativeMedia\.browser,null\)/);
  assert.match(worker,/verifyBrowser=true/);
  assert.match(worker,/if\(verifyBrowser\)\{\s*phase=609/);
  assert.match(worker,/browserRequested:verifyBrowser,preparedRecoverySamples/);
  assert.match(worker,/if\(sample\.name==='PNG'\|\|sample\.name==='video'\)preparedRecoverySamples\.push/);
});

function position(text,fragment){
  const index=text.indexOf(fragment);assert.notEqual(index,-1,`Missing reviewed wiring: ${fragment}`);return index;
}

test('Linux recovery seeds nonempty 023 state before its snapshot and verifies service replay without adding scenarios',async()=>{
  const runner=await source('recovery-native-test.mjs');
  const seeded=position(runner,'const recipientFixture = await seedRecoveryRecipientFixture(source);');
  const verified=position(runner,'await verifyRecoveryRecipientFixture({ owner:source,fixture:recipientFixture,fingerprint });');
  const snapshot=position(runner,'const dbBefore = await fingerprint(source);');
  assert.ok(seeded<verified&&verified<snapshot);
  assert.ok(snapshot<position(runner,'assertRecoveryRecipientRows(dbBefore.data);'));
  const restored=position(runner,'await verifyRecoveryRecipientFixture({ owner:restored,fixture:recipientFixture,fingerprint });');
  assert.ok(position(runner,"console.log('RECOVERY_NATIVE_SQL_RESTORED');")<restored);
  assert.ok(restored<position(runner,"report('restored services preserve clinical privacy immutable history original reply links and withdrawal display');"));
  assert.match(runner,/assertRecoveryReviewRows\(dbBefore\.data\)/);
  assert.match(runner,/cb_account_security_events'\)\.count, 2/);
  assert.equal((runner.match(/^\s*report\('/gm)??[]).length,14);
  assert.match(runner,/Native recovery integration: 14 scenarios passed\./);
  // This remains a deliberately offline, single-writer synthetic snapshot.
  assert.match(runner,/This suite has ONE writer/);
  assert.match(runner,/operatingCutoverApproved: false/);
});

test('Linux quarantine checks six active identities, retained 023 rows and reconnect denial with no receipt weakening',async()=>{
  const runner=await source('recovery-native-test.mjs');
  const count=position(runner,'const activeUsersBeforeQuarantine =');
  assert.match(runner,/SELECT count\(\*\)::integer AS count FROM public\.cb_users WHERE active/);
  assert.match(runner,/assert\.equal\(activeUsersBeforeQuarantine,6\)/);
  assert.match(runner,/assert\.equal\(quarantineReceipt\.disabledUsers,activeUsersBeforeQuarantine\)/);
  assert.match(runner,/assert\.equal\(quarantineReceipt\.revokedSessions,2\)/);
  assert.match(runner,/assert\.equal\(quarantineReceipt\.revokedInvitations,1\)/);
  assert.ok(count<position(runner,'const interrupted ='));
  const preserved=runner.slice(position(runner,'const preservedTables ='),position(runner,'const expectedPreserved ='));
  for(const table of ['cb_care_recipient_links','cb_primary_communicators','cb_primary_communicator_requests'])
    assert.ok(preserved.includes(`'${table}'`));
  const call='await verifyQuarantinedRecoveryRecipientFixture({ owner:restored,fixture:recipientFixture,fingerprint });';
  const first=position(runner,call),last=runner.lastIndexOf(call);
  assert.notEqual(first,last);assert.equal(runner.split(call).length-1,2);
  const reconnect=position(runner,'await restored.close(); restored = databaseFromPool');
  assert.ok(position(runner,'assert.deepEqual(preservedAfter,expectedPreserved);')<first&&first<reconnect&&reconnect<last);
  assert.ok(last<position(runner,"report('reconnected services remain closed and restricted runtime temp shadowing cannot reactivate restored users');"));
});

test('Windows owner-side recipient checks are unconditional and evidence flags follow successful verification',async()=>{
  const runner=await source('windows-postgres-check.mjs');
  assert.match(runner,/const recipient = await seedRecoveryRecipientFixture\(setupDb\)/);
  assert.match(runner,/blocked,review,recipient,/);
  assert.match(runner,/await verifyRecoveryRecipientFixture\(\{owner,fixture:fixture\.recipient,fingerprint\}\)/);
  for(const [flag,connection,runtime]of [['seeded','source','sourceRuntime'],['sourceRestart','source','sourceRuntime'],
    ['restored','restored','restoredRuntime'],['restoredRestart','restored','restoredRuntime']]){
    const sequence=`await verifyServices(${runtime},fixture,${connection});if(reviewChecks)reviewChecks.${flag}=true;\n  recipientChecks.${flag}=true;`;
    assert.ok(runner.replaceAll('\r\n','\n').includes(sequence));
  }
  assert.match(runner,/else await verifyRecoveryRecipientFixture\(\{owner:stateTarget,fixture:fixture\.recipient,fingerprint\}\);\s*recipientChecks\.stateRestored=true/);
  assert.match(runner,/recipientFixture:fixture\.recipient/);
  assert.match(runner,/assert\.equal\(stateChecks\.length,preparedFaultSamples\?23:18\);\s*recipientChecks\.quarantined=true/);
  assert.match(runner,/Object\.values\(recipientChecks\)\.every\(value=>value===true\)/);
  assert.match(runner,/reviewChecks,recipientChecks,recoveryStateEvidence/);
  assert.match(runner,/checks\.length === \(nativeMediaCheck\?\(recoveryStateCheck\?78:55\):roleCheck\?48:recoveryStateCheck\?27:9\)/);
});

test('recipient quarantine verification stays inside the existing 65-table milestone in every recovery-state mode',async()=>{
  const state=await source('recovery-state-native-check.mjs'),runner=await source('windows-postgres-check.mjs');
  assert.match(state,/assert\.ok\(recipientFixture\)/);
  const milestone=position(state,"await check('all 65 native data tables and recipient identity match");
  const optionalReview=position(state,"if(onQuarantined)await check('022 private review");
  const block=state.slice(milestone,optionalReview);
  assert.match(block,/assert\.equal\(result\.comparedTables,65\)/);
  assert.match(block,/await verifyQuarantinedRecoveryRecipientFixture\(\{owner:target,fixture:recipientFixture,fingerprint\}\)/);
  assert.equal((state.match(/await verifyQuarantinedRecoveryRecipientFixture\(/g)??[]).length,1);
  assert.match(runner,/\.\.\.\(preparedFaultSamples\?\{onQuarantined:async target=>/);
  assert.match(state,/serviceReleaseAllowed,false/);
});

test('recovery Docker exactly packages every recipient-helper relative import without broadening its private build context',async()=>{
  const repository=new URL('../../',import.meta.url),helper='server/recovery-recipient-native-check.mjs';
  const closure=new Set();
  async function walk(name){
    if(closure.has(name))return;
    assert.match(name,/^(server|src)\/[a-z-]+\.(mjs|js)$/);closure.add(name);
    const content=await readFile(new URL(name,repository),'utf8');
    for(const match of content.matchAll(/^\s*import\s+(?:[^;"']*?\s+from\s*)?["'](\.[^"']+)["']/gm))
      await walk(posix.normalize(posix.join(posix.dirname(name),match[1])));
  }
  await walk(helper);
  for(const name of ['care-recipient-links','primary-communicators','relationships','schedule-gate','conversations'])
    assert.ok(closure.has(`server/${name}.mjs`));
  const docker=await source('recovery-test.Dockerfile');
  const allowlist=(await source('recovery-test.Dockerfile.dockerignore')).split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
  assert.equal(allowlist[0],'**');assert.match(docker,/^WORKDIR \/app\/server$/m);
  assert.match(docker,/^USER node$/m);assert.doesNotMatch(docker,/^RUN\s+(npm|curl|wget)\b/m);
  assert.doesNotMatch(docker,/^COPY\s+(?:src\/\s|server\/\s|\.\s)/m);
  for(const broad of ['!src/**','!src/*','!server/**','!server/*','!.env','!.env*','!private/','!private/**'])
    assert.ok(!allowlist.includes(broad));
  const copies=new Map();
  for(const line of docker.split(/\r?\n/).filter(line=>line.startsWith('COPY ')&&!line.startsWith('COPY --from='))){
    assert.ok(!line.includes('\\')&&!line.includes('['),'Review new Docker COPY syntax explicitly');
    const parts=line.split(/\s+/).slice(1),destination=parts.pop();
    for(const name of parts){
      if(name.endsWith('/'))continue;
      const target=destination.endsWith('/')?posix.join(destination,posix.basename(name)):destination;
      assert.ok(!copies.has(name),`Duplicate Docker COPY for ${name}`);
      copies.set(name,posix.resolve('/app/server',target));
    }
  }
  for(const name of closure){
    assert.equal(allowlist.filter(line=>line===`!${name}`).length,1,`Missing or duplicate exact build inclusion for ${name}`);
    assert.equal(copies.get(name),`/app/${name}`,`Missing or misplaced relative dependency ${name}`);
  }
});

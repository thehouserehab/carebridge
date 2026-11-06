import test from 'node:test';
import assert from 'node:assert/strict';
import {rootCertificates} from 'node:tls';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {windowsNativeWorkerBootstrap,nativeWorkerStderrObserver,nativeWorkerStageReporter,nativeDatabaseStageReporter} from '../windows-native-worker-test-policy.mjs';
import {WINDOWS_DATABASE_STAGES} from '../windows-database-observation.mjs';
import {MEDIA_WORKER_STAGE_NAMES} from '../media-worker-observation.mjs';
import {windowsPostgresCheckOptions} from '../windows-postgres-policy.mjs';
const run=randomUUID();
const fixture=()=>({purpose:'synthetic-carebridge-native-worker',mode:'complete',
  database:{storage:{base:'E:\\CarebridgeBeta',powershell:'C:\\Tools\\pwsh.exe',syntheticRunId:run},credentialId:randomUUID(),
    privileges:{roles:{owner:'cb_owner',runtime:'cb_app',bootstrap:'cb_bootstrap',backup:'cb_backup',worker:'cb_worker'},
      target:{name:'cb_beta',oid:16384,ownerOid:16385,confirm:'cb_beta'}},endpoint:{host:'127.0.0.1',port:54321,ca:rootCertificates[0]}},
  mediaRoot:`E:\\CarebridgeBeta\\private\\checks\\postgres-check-${run}\\source-media`,
  nativeMedia:{engineIdentity:'synthetic-native-engine',approvedImageId:'sha256:'+'a'.repeat(64),scannerEndpoint:{host:'127.0.0.1',port:54322}}});
const denied={message:'WINDOWS_NATIVE_WORKER_TEST_UNAVAILABLE'};
const baseDiagnostic=value=>({phase:value.phase,category:value.category,outputLimitExceeded:value.outputLimitExceeded});
test('synthetic native worker captures worker-only TLS/E/image/loopback configuration with no secret or command',()=>{
  const input=fixture(),value=windowsNativeWorkerBootstrap(input);input.database.storage.base='E:\\Other';input.nativeMedia.scannerEndpoint.port=1;
  assert.equal(value.database.storage.base,'E:\\CarebridgeBeta');assert.equal(value.nativeMedia.scannerEndpoint.port,54322);
  assert.ok(Object.isFrozen(value)&&Object.isFrozen(value.database)&&Object.isFrozen(value.database.endpoint)&&Object.isFrozen(value.nativeMedia.scannerEndpoint));
  assert.equal(Object.hasOwn(value.database,'password'),false);assert.equal(Object.hasOwn(value.nativeMedia,'command'),false);
});
test('native worker bootstrap requires the exact fresh synthetic E root and inherited-fixture purpose',()=>{
  for(const change of [v=>{v.purpose='production';},v=>{v.mode='activate';},v=>{v.database.password='synthetic';},
    v=>{delete v.database.storage.syntheticRunId;},v=>{v.mediaRoot='E:\\CarebridgeBeta\\private\\media';},
    v=>{v.mediaRoot+='\\..\\source-media';},v=>{v.extra=true;},v=>{v.database.kind='owner';},v=>{v.nativeMedia.command=['run'];}]){
    const value=fixture();change(value);assert.throws(()=>windowsNativeWorkerBootstrap(value),denied);
  }
});
test('native worker fixture never accepts missing CA, plaintext TLS bypass, remote/DNS scanner or mutable image',()=>{
  for(const change of [v=>{delete v.database.endpoint.ca;},v=>{v.database.endpoint={host:'127.0.0.1',port:54321,transport:'synthetic-loopback'};},
    v=>{v.database.endpoint.ca='invalid';},v=>{v.nativeMedia.scannerEndpoint.host='localhost';},v=>{v.nativeMedia.scannerEndpoint.host='192.0.2.1';},
    v=>{v.nativeMedia.scannerEndpoint.port='3310';},v=>{v.nativeMedia.scannerEndpoint.port=0;},v=>{v.nativeMedia.scannerEndpoint.port=65536;},
    v=>{v.nativeMedia.scannerEndpoint.path='/private';},v=>{v.nativeMedia.approvedImageId='latest';},v=>{v.nativeMedia.engineIdentity='short';}]){
    const value=fixture();change(value);assert.throws(()=>windowsNativeWorkerBootstrap(value),denied);
  }
  const value=fixture();value.mode='hold-input';assert.equal(windowsNativeWorkerBootstrap(value).mode,'hold-input');
});
test('native E command is opt-in, implies separated roles and cannot adopt a cluster or combine activation flags',()=>{
  const args=['--base','E:\\CarebridgeBeta','--powershell','C:\\Tools\\pwsh.exe','--confirm-synthetic-e-drive'];
  assert.deepEqual(windowsPostgresCheckOptions(args),{options:windowsPostgresCheckOptions(args).options,roleCheck:false,nativeMediaCheck:false,recoveryStateCheck:false});
  assert.equal(windowsPostgresCheckOptions(['--verify-role-privileges',...args]).nativeMediaCheck,false);
  const value=windowsPostgresCheckOptions(['--verify-native-media',...args]);assert.equal(value.nativeMediaCheck,true);assert.equal(value.roleCheck,true);
  const recovery=windowsPostgresCheckOptions(['--verify-recovery-state',...args]);assert.equal(recovery.recoveryStateCheck,true);assert.equal(recovery.roleCheck,false);
  assert.throws(()=>windowsPostgresCheckOptions(['--verify-recovery-state','--verify-role-privileges',...args]),{message:'WINDOWS_POSTGRES_CONFIGURATION'});
  for(const invalid of [null,[],['--verify-native-media',...args,'--activate'],['--verify-native-media','--verify-role-privileges',...args],
    ['--verify-native-media',...args.slice(0,4)],['--verify-native-media','--cluster','E:\\Existing',...args]])
    assert.throws(()=>windowsPostgresCheckOptions(invalid),{message:'WINDOWS_POSTGRES_CONFIGURATION'});
});
test('native child diagnostics accept fragmented finite phases but never retain or return private native text',()=>{
  const observer=nativeWorkerStderrObserver();observer.feed(Buffer.from('NATIVE_PHA'));observer.feed(Buffer.from('SE_4\nprivate synthetic path and SQL\n'));
  assert.deepEqual(baseDiagnostic(observer.snapshot()),{phase:4,category:null,outputLimitExceeded:false});
  observer.feed(Buffer.from('Assertion failed: private synthetic details\n'));assert.equal(observer.snapshot().category,'NATIVE_ASSERTION');
  assert.equal(JSON.stringify(observer.snapshot()).includes('private'),false);assert.throws(()=>observer.feed('text'),denied);
  const fatal=nativeWorkerStderrObserver();fatal.feed(Buffer.from('FATAL ER'));fatal.feed(Buffer.from('ROR: private unterminated detail'));
  assert.equal(fatal.snapshot().category,'NATIVE_FATAL');assert.equal(JSON.stringify(fatal.snapshot()).includes('private'),false);
});
test('native diagnostic output budget latches and cannot be cleared by a later phase or fabricated success marker',()=>{
  const observer=nativeWorkerStderrObserver();observer.feed(Buffer.alloc(16385,65));observer.feed(Buffer.from('NATIVE_PHASE_6\n'));
  assert.deepEqual(baseDiagnostic(observer.snapshot()),{phase:0,category:'OUTPUT_LIMIT',outputLimitExceeded:true});
  const caught=nativeWorkerStderrObserver();caught.feed(Buffer.from('NATIVE_CAUGHT\n'));assert.equal(caught.snapshot().category,'CAUGHT');
});

test('native stage protocol accepts only complete finite frames and never duplicates a fragmented observation',()=>{
  const observer=nativeWorkerStderrObserver(),report=nativeWorkerStageReporter(frame=>{
    for(const byte of Buffer.from(frame))observer.feed(Uint8Array.of(byte));
  });
  for(const stage of MEDIA_WORKER_STAGE_NAMES)for(const edge of ['begin','complete','failed'])report(Object.freeze({stage,edge}));
  const value=observer.snapshot();assert.equal(value.stageProtocol,1);assert.equal(value.stageEventCount,45);
  assert.equal(value.stageHistory.length,32);assert.equal(value.stageHistory[0].sequence,14);
  assert.deepEqual(value.lastStage,{sequence:45,stage:'db-close',edge:'failed'});
  assert.ok(value.stageCounts.every(item=>item.begin===1&&item.complete===1&&item.failed===1));
  assert.ok(Object.isFrozen(value)&&Object.isFrozen(value.stageHistory)&&Object.isFrozen(value.stageCounts[0]));
  observer.feed(Buffer.from('NS1:01:B'));assert.equal(observer.snapshot().stageEventCount,45);
  observer.feed(Buffer.from('\n'));assert.equal(observer.snapshot().stageEventCount,46);
  assert.equal(value.stageEventCount,45);assert.equal(value.stageCounts[0].begin,1);
});

test('invalid stage frames, accessors and oversized lines cannot inject observations or private data',()=>{
  const observer=nativeWorkerStderrObserver(),report=nativeWorkerStageReporter(frame=>observer.feed(Buffer.from(frame)));
  let getterCalls=0;
  for(const event of [null,{stage:'private',edge:'begin'},{stage:'db-open',edge:'toString'},
    {stage:'db-open',edge:'begin',secret:'synthetic'},
    {get stage(){getterCalls++;return 'db-open';},edge:'begin'}])report(event);
  observer.feed(Buffer.from('NS1:00:B\nNS1:16:B\nNS2:01:B\nNS1:01:X\nprefix NS1:01:B\n'));
  observer.feed(Buffer.from('x'.repeat(300)+'NS1:01:B\nprivate-file-name-and-token\n'));
  assert.equal(getterCalls,0);assert.equal(observer.snapshot().stageEventCount,0);
  assert.equal(JSON.stringify(observer.snapshot()).includes('private-file-name'),false);
  observer.feed(Buffer.from('NS1:01:B\r\n'));assert.equal(observer.snapshot().stageEventCount,1);
  assert.doesNotThrow(()=>nativeWorkerStageReporter(()=>{throw Error('private');})({stage:'db-open',edge:'begin'}));
});

test('idle observation budgets reserve processing and lifecycle capacity without weakening the stderr limit',()=>{
  const frames=[],observer=nativeWorkerStderrObserver(),report=nativeWorkerStageReporter(frame=>frames.push(frame));
  for(let i=0;i<5000;i++)report({stage:'queue-claim',edge:'begin'});
  report({stage:'source-open',edge:'begin'});report({stage:'db-close',edge:'complete'});
  for(let i=0;i<5000;i++)report({stage:'source-open',edge:'begin'});
  for(let i=0;i<5000;i++)report({stage:'db-open',edge:'begin'});
  const bytes=Buffer.from(frames.join(''));assert.ok(bytes.length<16384);observer.feed(bytes);
  const value=observer.snapshot();assert.equal(value.outputLimitExceeded,false);assert.equal(value.stageEventCount,1168);
  assert.deepEqual(value.stageLimits,{polling:true,work:true,lifecycle:true});
  assert.equal(frames.filter(frame=>frame==='NL1:P\n').length,1);
  assert.equal(value.stageCounts.find(item=>item.stage==='db-close').complete,1);
  assert.equal(value.stageCounts.find(item=>item.stage==='source-open').begin,1024);
});

test('native browser milestone is explicitly wired into scenario counts and final cleanup admission',async()=>{
  // Static packaging contract only: this test does not claim actual browser,
  // Windows DB, antivirus, decoder, E byte delivery or process-stop proof.
  const [native,credential,runner]=await Promise.all(['windows-native-worker-check.mjs',
    'database-credential-service-native-check.mjs','windows-postgres-check.mjs'].map(name=>readFile(new URL(`../${name}`,import.meta.url),'utf8')));
  assert.match(native,/exercisePreparedMediaBrowser\(/);
  assert.match(native,/launchWindowsNativeApiTest\(\{[^\n]+screen:'prepared'/);
  assert.match(native,/const uiSeed=await seedNativeApiTestFixture\(/);
  assert.match(native,/assert\.equal\(checks\.length,7\)/);
  assert.match(native,/assert\.equal\(\(await jobs\(\)\)\.length,8\)/);
  assert.match(native,/const resourcesStopped=browserStopped&&/);
  assert.match(native,/assert\.equal\(viewed\.sha256,hash\(candidate\)\)/);
  // Recovery-state runs intentionally omit the browser case (six instead of
  // seven); ordinary native-media runs still require actual browser success.
  assert.match(credential,/assert\.equal\(nativeMedia\.scenarioCount,nativeBrowserCheck\?7:6\)/);
  assert.match(credential,/assert\.equal\(nativeMedia\.browserRequested,nativeBrowserCheck\)/);
  assert.match(credential,/if\(nativeBrowserCheck\)\{\s*assert\.equal\(nativeMedia\.browser\?\.passed,true\)/);
  assert.match(credential,/assert\.equal\(nativeMedia\.browser\?\.passed,true\)/);
  assert.match(credential,/else assert\.equal\(nativeMedia\.browser,null\)/);
  assert.match(runner,/nativeBrowserCheck:!recoveryStateCheck/);
  assert.match(runner,/assert\.equal\(proof\.checks\.length,nativeMediaCheck\?\(recoveryStateCheck\?15:16\):9\)/);
  assert.match(runner,/checks\.length === \(nativeMediaCheck\?\(recoveryStateCheck\?78:55\):roleCheck\?48:recoveryStateCheck\?27:9\)/);
  assert.match(runner,/recoveryStateCheck \? credentialService\.nativeMedia\.browserRequested===false&&credentialService\.nativeMedia\.browser===null/);
  assert.match(runner,/credentialService\.nativeMedia\.browser\?\.cleanup\?\.browserStopped/);
  assert.match(runner,/credentialService\.nativeMedia\.browser\?\.cleanup\?\.contextsClosed/);
  assert(runner.indexOf('browserRuntime=messageBrowserOptions')<runner.indexOf('await mkdir(paths.root)'));
});

test('separate database diagnostic protocol captures fixed boundaries and elapsed times without worker approval',()=>{
  const observer=nativeWorkerStderrObserver(),report=nativeDatabaseStageReporter(frame=>{
    for(const byte of Buffer.from(frame))observer.feed(Uint8Array.of(byte));
  });
  for(const stage of WINDOWS_DATABASE_STAGES)for(const edge of ['begin','complete','failed'])report({stage,edge,elapsedMs:42});
  const value=observer.snapshot();
  assert.equal(value.databaseProtocol,1);assert.equal(value.databaseEventCount,WINDOWS_DATABASE_STAGES.length*3);
  assert.equal(value.stageEventCount,0);assert.equal(value.phase,0);
  assert(value.databaseCounts.every(item=>item.begin===1&&item.complete===1&&item.failed===1));
  assert(value.databaseHistory.every(item=>item.elapsedMs===42&&Object.isFrozen(item)));
  assert(Object.isFrozen(value.databaseHistory));assert(Object.isFrozen(value.databaseCounts[0]));
  observer.feed(Buffer.from('ND1:01:F:88'));assert.equal(observer.snapshot().databaseEventCount,value.databaseEventCount);
  observer.feed(Buffer.from('\n'));assert.equal(observer.snapshot().databaseEventCount,value.databaseEventCount+1);
});

test('database diagnostics reject private properties, accessors, invalid times and malformed frames',()=>{
  const observer=nativeWorkerStderrObserver(),report=nativeDatabaseStageReporter(frame=>observer.feed(Buffer.from(frame)));
  let getters=0;const base={stage:WINDOWS_DATABASE_STAGES[0],edge:'begin',elapsedMs:0};
  for(const event of [null,{...base,private:'synthetic'}, {...base,stage:'private'},
    {...base,edge:'toString'}, {...base,elapsedMs:-1}, {...base,elapsedMs:1.1}, {...base,elapsedMs:1e9},
    {...base,get elapsedMs(){getters++;return 1;}}])report(event);
  observer.feed(Buffer.from('ND1:00:B:1\nND1:99:B:1\nND1:01:B:01\nND1:01:B:-1\nND2:01:B:1\nND1:01:B:1 private\n'));
  assert.equal(getters,0);assert.equal(observer.snapshot().databaseEventCount,0);
  assert.equal(JSON.stringify(observer.snapshot()).includes('private'),false);
});

test('database event budget is bounded independently of polling and lifecycle diagnostics',()=>{
  const frames=[],observer=nativeWorkerStderrObserver(),report=nativeDatabaseStageReporter(frame=>frames.push(frame));
  for(let i=0;i<1000;i++)report({stage:WINDOWS_DATABASE_STAGES[0],edge:'begin',elapsedMs:999999999});
  assert.equal(frames.filter(frame=>frame==='NDL1\n').length,1);
  observer.feed(Buffer.from(frames.join('')));
  const value=observer.snapshot();assert.equal(value.databaseEventCount,128);
  assert.equal(value.databaseHistory.length,64);assert.equal(value.databaseLimit,true);
  assert.equal(value.outputLimitExceeded,false);assert.equal(value.stageEventCount,0);
  assert.equal(value.stageLimits.lifecycle,false);
});

test('owned worker rehearsal carries bounded pre-cleanup observations without changing the stop test',async()=>{
  // Static wiring evidence, not a native worker execution or timing result.
  const [owned,credential,runner]=await Promise.all(['windows-media-worker-native-check.mjs',
    'database-credential-service-native-check.mjs','windows-postgres-check.mjs'].map(name=>readFile(new URL(`../${name}`,import.meta.url),'utf8')));
  assert.match(owned,/nativeWorkerStderrObserver\(\)/);
  assert.match(owned,/nativeWorkerStageReporter\(feed\),onDatabaseStage=nativeDatabaseStageReporter\(feed\)/);
  assert.match(owned,/pollMilliseconds:50,onStage,onDatabaseStage/);
  assert.match(owned,/Object\.freeze\(\{processState,decoderEntries,stages:observation\.snapshot\(\)\}\)/);
  assert(owned.indexOf('ownedWorkerObservation=Object.freeze')<owned.indexOf('controller?.abort()'));
  assert.match(owned,/12000/);
  assert.match(owned,/phase=4012;await bounded\(entered\.promise\);controller\.abort\(\);target\.emit\('SIGTERM'\);await delay\(30\);assert\.equal\(settled,false\)/);
  assert.match(owned,/error\.ownedWorkerObservation=ownedWorkerObservation/);
  assert.match(credential,/ownedWorkerObservation=error\.ownedWorkerObservation/);
  assert.match(credential,/error\.ownedWorkerObservation=ownedWorkerObservation/);
  assert.match(runner,/error\.ownedWorkerObservation \? \{ownedWorkerObservation:error\.ownedWorkerObservation\} : \{\}/);
});

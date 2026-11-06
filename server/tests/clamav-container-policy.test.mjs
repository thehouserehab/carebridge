import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { CLAMAV_TEST_IMAGE,CLAMAV_TEST_VERSION,NODE_TEST_IMAGE,RUN_LABEL,testResourceNames,resourceReceipt,
  volumeReceipt,assertVolumeOwner,assertContainerOwner,containerArguments,assertContainerIsolation } from '../clamav-container-policy.mjs';
const names = testResourceNames('12345678-1234-4234-8234-123456789abc'), imageId = `sha256:${'a'.repeat(64)}`;
const receipts = Object.fromEntries(['updater','scanner','worker'].map((role,index) => [role,resourceReceipt(String(index+1).repeat(64),role,names.run)]));
const volume = () => ({ Name:names.volume,CreatedAt:'2026-10-04T00:00:00Z',Driver:'local',Scope:'local',Options:null,Labels:{ [RUN_LABEL]:names.run } });
const fixture = (role = 'scanner',running = false) => ({
  Id:receipts[role].id,Name:`/${names[role]}`,Image:imageId,
  Config:{ User:role === 'worker' ? 'node' : 'clamav',Env:['TZ=UTC'],Labels:{ [RUN_LABEL]:names.run } },State:{ Running:running },
  HostConfig:{ ReadonlyRootfs:true,Privileged:false,NetworkMode:role === 'updater' ? 'bridge' : role === 'scanner' ? 'none' : `container:${receipts.scanner.id}`,
    PidMode:'',IpcMode:'private',UTSMode:'',RestartPolicy:{ Name:'no' },LogConfig:{ Type:'none' },
    Memory:({ updater:3072,scanner:4096,worker:256 })[role]*1024*1024,
    MemorySwap:({ updater:3072,scanner:4096,worker:256 })[role]*1024*1024,NanoCpus:1e9,PidsLimit:role === 'scanner' ? 128 : 64,
    CapDrop:['ALL'],CapAdd:null,SecurityOpt:['no-new-privileges'],Binds:null,VolumesFrom:null,Devices:[],DeviceRequests:[],PortBindings:{},
    Tmpfs:{ '/tmp':`rw,noexec,nosuid,nodev,size=${role === 'worker' ? 16 : 256}m,mode=1777` },
    Mounts:role === 'worker' ? [] : [{ Type:'volume',Source:names.volume,Target:'/var/lib/clamav',ReadOnly:role === 'scanner' }] },
  Mounts:role === 'worker' ? [] : [{ Type:'volume',Name:names.volume,Destination:'/var/lib/clamav',RW:role === 'updater' }],
  NetworkSettings:{ Networks:role === 'worker' ? {} : role === 'updater' ? { bridge:{ IPAddress:'172.17.0.2',Gateway:'172.17.0.1' } } :
    { none:{ NetworkID:'b'.repeat(64),IPAddress:'',Gateway:'' } },Ports:{ '3310/tcp':null } },
});
const checked = (state,role = 'scanner',running = false) => assertContainerIsolation(state,receipts[role],imageId,{ scannerId:receipts.scanner.id,running });
const refused = (work) => assert.throws(work,{ message:'CLAMAV_CONTAINER_SAFETY' });

test('ClamAV test resources require UUID v4, exact role and full IDs',() => {
  for (const run of [null,{},'existing','../test','12345678-1234-1234-8234-123456789abc']) refused(() => testResourceNames(run));
  for (const id of ['short','a'.repeat(63)+';',null]) refused(() => resourceReceipt(id,'scanner',names.run));
  for (const role of ['other','volume','constructor',null]) refused(() => resourceReceipt('a'.repeat(64),role,names.run));
  refused(() => containerArguments({ ...names,volume:'existing' },'scanner',imageId));
  refused(() => containerArguments(names,'constructor',imageId));
});
test('images are immutable official references, approved version is explicit',() => {
  assert.match(CLAMAV_TEST_IMAGE,/^docker\.io\/clamav\/clamav@sha256:[a-f0-9]{64}$/);
  assert.match(NODE_TEST_IMAGE,/^docker\.io\/library\/node@sha256:[a-f0-9]{64}$/);
  assert.equal(CLAMAV_TEST_VERSION,'1.4.6');
});
test('only updater gets outbound bridge and writable public definitions',() => {
  for (const role of ['updater','scanner','worker']) {
    const args = containerArguments(names,role,imageId,receipts.scanner.id);
    assert.ok(args.includes('--read-only')); assert.ok(args.includes('--pull=never'));
    assert.equal(args.some((arg) => /^(--publish|--privileged|--volume)(=|$)|docker\.sock/.test(arg)),false);
    assert.ok(args.includes(`--network=${role === 'updater' ? 'bridge' : role === 'scanner' ? 'none' : `container:${receipts.scanner.id}`}`));
    if (role === 'worker') assert.equal(args.includes('--mount'),false);
    else assert.ok(args.includes(`type=volume,source=${names.volume},target=/var/lib/clamav${role === 'scanner' ? ',readonly' : ''}`));
    checked(fixture(role),role); checked(fixture(role,true),role,true);
  }
});
test('owned volume requires creation receipt, run label and no external driver',() => {
  const receipt = volumeReceipt(volume(),names.run); assertVolumeOwner(volume(),receipt);
  for (const change of [{ Name:'existing' },{ Driver:'nfs' },{ Scope:'global' },{ Options:{ type:'nfs' } },
    { Labels:{} },{ CreatedAt:'invalid' },{ CreatedAt:'2026-10-05T00:00:00Z' }])
    refused(() => assertVolumeOwner({ ...volume(),...change },receipt));
});
test('cleanup requires matching full container ID, image and run label',() => {
  assertContainerOwner(fixture(),receipts.scanner,imageId);
  for (const change of [{ Id:receipts.worker.id },{ Name:'/existing' },{ Image:`sha256:${'b'.repeat(64)}` },{ Config:{ Labels:{} } }])
    refused(() => assertContainerOwner({ ...fixture(),...change },receipts.scanner,imageId));
  refused(() => assertContainerOwner({ ...fixture(),Name:'/existing' },{ ...receipts.scanner,name:'existing' },imageId));
});
test('root, writable root, unlimited resources and elevated capabilities are refused',() => {
  for (const role of ['updater','scanner','worker']) {
    for (const change of [{ ReadonlyRootfs:false },{ Privileged:true },{ Memory:0 },{ MemorySwap:-1 },{ NanoCpus:0 },
      { PidsLimit:0 },{ CapDrop:[] },{ CapAdd:['SYS_ADMIN'] },{ SecurityOpt:[] },{ LogConfig:{ Type:'json-file' } },
      { RestartPolicy:{ Name:'always' } },{ PidMode:'host' },{ IpcMode:'host' },{ UTSMode:'host' }]) {
      const state = fixture(role); Object.assign(state.HostConfig,change); refused(() => checked(state,role));
    }
    const root = fixture(role); root.Config.User = 'root'; refused(() => checked(root,role));
    const timeZone = fixture(role); timeZone.Config.Env = []; refused(() => checked(timeZone,role));
    const duplicateTimeZone = fixture(role); duplicateTimeZone.Config.Env.push('TZ=Asia/Seoul'); refused(() => checked(duplicateTimeZone,role));
    refused(() => checked(fixture(role,true),role));
  }
});
test('host files, devices, hidden mounts, extra networks and exposed ports are refused',() => {
  for (const role of ['updater','scanner','worker']) {
    for (const change of [{ Binds:['C:/private:/data'] },{ VolumesFrom:['existing'] },{ Devices:[{}] },
      { DeviceRequests:[{}] },{ Tmpfs:{} },{ NetworkMode:'host' },{ PortBindings:{ '3310/tcp':[{ HostPort:'3310' }] } }]) {
      const state = fixture(role); Object.assign(state.HostConfig,change); refused(() => checked(state,role));
    }
    const mounted = fixture(role); mounted.Mounts.push({ Type:'bind',Destination:'/host' }); refused(() => checked(mounted,role));
    const network = fixture(role); network.NetworkSettings.Networks.other = { IPAddress:'10.0.0.2' }; refused(() => checked(network,role));
    const port = fixture(role); port.NetworkSettings.Ports['3310/tcp'] = [{ HostPort:'3310' }]; refused(() => checked(port,role));
  }
  const routed = fixture(); routed.NetworkSettings.Networks.none.Gateway = '1.2.3.4'; refused(() => checked(routed));
});
test('scanner definitions must be read only and worker must have no definitions volume',() => {
  const writable = fixture(); writable.Mounts[0].RW = true; refused(() => checked(writable));
  const extra = fixture(); extra.HostConfig.Mounts.push({ Type:'volume',Source:'other' }); refused(() => checked(extra));
  const wrong = fixture(); wrong.Mounts[0].Name = 'existing'; refused(() => checked(wrong));
  const worker = fixture('worker'); worker.Mounts = fixture().Mounts; refused(() => checked(worker,'worker'));
  const wrongNamespace = fixture('worker'); wrongNamespace.HostConfig.NetworkMode = `container:${receipts.updater.id}`;
  refused(() => checked(wrongNamespace,'worker'));
});
test('test daemon candidate enforces official fresh definitions, scan limits and no content logs',async () => {
  const config = await readFile(new URL('../clamav-test.conf',import.meta.url),'utf8');
  for (const option of ['OfficialDatabaseOnly yes','FailIfCvdOlderThan 2','TCPAddr 127.0.0.1','StreamMaxLength 50M',
    'MaxFileSize 50M','MaxScanSize 100M','MaxFiles 1000','AlertExceedsMax yes','LogClean no','LogVerbose no',
    'LogSyslog no','ExtendedDetectionInfo no','LeaveTemporaryFiles no','GenerateMetadataJson no'])
    assert.ok(config.split(/\r?\n/).includes(option));
  assert.equal(/^\s*(LogFile|VirusEvent)\s+/m.test(config),false);
});
test('build context allowlist excludes env, DB dependencies, docs and attachments',async () => {
  const dockerfile = await readFile(new URL('../clamav-test.Dockerfile',import.meta.url),'utf8');
  assert.ok(dockerfile.includes(`FROM ${CLAMAV_TEST_IMAGE} AS engine`));
  assert.ok(dockerfile.includes(`FROM ${NODE_TEST_IMAGE} AS worker`));
  assert.equal(/^RUN\s/m.test(dockerfile),false);
  const ignore = await readFile(new URL('../clamav-test.Dockerfile.dockerignore',import.meta.url),'utf8');
  const rules = ignore.split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(rules,['**','!package.json','!src/','!src/media-policy.js','!server/','!server/errors.mjs',
    '!server/clamav-client.mjs','!server/clamav-native-test.mjs','!server/clamav-test.conf','!server/clamav-test-freshclam.conf']);
  const updater = await readFile(new URL('../clamav-test-freshclam.conf',import.meta.url),'utf8');
  for (const option of ['DatabaseMirror database.clamav.net','DNSDatabaseInfo current.cvd.clamav.net','TestDatabases yes','MaxAttempts 1'])
    assert.ok(updater.split(/\r?\n/).includes(option));
  assert.equal(/^\s*(PrivateMirror|UpdateLogFile|NotifyClamd|OnUpdateExecute)\s/m.test(updater),false);
});

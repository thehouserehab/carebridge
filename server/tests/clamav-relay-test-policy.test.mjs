import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {clamAvRelayArguments,assertClamAvRelayIsolation} from '../clamav-relay-test-policy.mjs';
import {testResourceNames,resourceReceipt,RUN_LABEL} from '../clamav-container-policy.mjs';
import {localDockerTestConfiguration} from '../local-docker-test-environment.mjs';
import {startWindowsClamAvTestBridge} from '../windows-clamav-test-bridge.mjs';
const run='12345678-1234-4234-8234-123456789abc',names=testResourceNames(run),id='a'.repeat(64),scanner='b'.repeat(64),image='sha256:'+'c'.repeat(64);
const receipt=resourceReceipt(id,'worker',run),denied={message:'CLAMAV_RELAY_TEST_UNAVAILABLE'};
const fixture=()=>({Id:id,Name:'/'+names.worker,Image:image,State:{Running:false},
  Config:{User:'node',OpenStdin:true,Tty:false,Entrypoint:['/usr/local/bin/node'],Cmd:['/app/server/clamav-relay-peer-test.mjs'],Env:['TZ=UTC'],Labels:{[RUN_LABEL]:run}},
  HostConfig:{ReadonlyRootfs:true,Privileged:false,NetworkMode:'container:'+scanner,PidMode:'',IpcMode:'private',UTSMode:'',
    RestartPolicy:{Name:'no'},LogConfig:{Type:'none'},Memory:256*1024*1024,MemorySwap:256*1024*1024,NanoCpus:1e9,PidsLimit:64,
    CapDrop:['ALL'],CapAdd:null,SecurityOpt:['no-new-privileges'],Binds:null,VolumesFrom:null,Devices:[],DeviceRequests:[],PortBindings:{},Mounts:[],
    Ulimits:[{Name:'nofile',Soft:1024,Hard:1024}],Tmpfs:{'/tmp':'rw,noexec,nosuid,nodev,size=16m,mode=1777'}},
  Mounts:[],NetworkSettings:{Networks:{},Ports:{}}});
const check=(value)=>assertClamAvRelayIsolation(value,receipt,image,scanner);
test('relay retains the existing offline worker isolation with only explicit scanner namespace and stdin',()=>{
  const args=clamAvRelayArguments(run,scanner,image);assert.equal(args[0],'create');assert.ok(args.includes('--interactive'));
  assert.ok(args.includes('--network=container:'+scanner));assert.ok(args.includes('--user'));assert.ok(args.includes('node'));
  assert.equal(args.at(-1),image);assert.equal(args.some(arg=>/docker\.sock|--publish|--mount|--privileged|--volume/.test(arg)),false);check(fixture());
});
test('relay refuses non-UUID resources, short scanner IDs and mutable images',()=>{
  for(const values of [[null,scanner,image],['../x',scanner,image],[run,'short',image],[run,scanner,'latest']])
    assert.throws(()=>clamAvRelayArguments(...values),denied);
});
test('relay is exactly a non-TTY fixed Node peer, never a shell or environment-selected destination',()=>{
  for(const patch of [{User:'root'},{OpenStdin:false},{Tty:true},{Entrypoint:['/bin/sh']},{Cmd:['other.mjs']}]) {
    const value=fixture();Object.assign(value.Config,patch);assert.throws(()=>check(value),denied);
  }
});
test('relay rejects public ports, other network namespaces, host files and changed resource or privilege limits',()=>{
  for(const patch of [{NetworkMode:'host'},{NetworkMode:'container:'+'d'.repeat(64)},{Memory:0},{MemorySwap:-1},
    {PidsLimit:0},{ReadonlyRootfs:false},{Privileged:true},{Binds:['/private:/private']},{Mounts:[{}]},
    {SecurityOpt:['no-new-privileges','seccomp=unconfined']},{GroupAdd:['0']},{Ulimits:[]},
    {PortBindings:{'3310/tcp':[{HostIp:'127.0.0.1',HostPort:'3310'}]}}]) {
    const value=fixture();Object.assign(value.HostConfig,patch);assert.throws(()=>check(value),denied);
  }
  const published=fixture();published.NetworkSettings.Ports={'3310/tcp':[{HostIp:'0.0.0.0',HostPort:'3310'}]};assert.throws(()=>check(published),denied);
});
test('relay ownership and actual state remain mandatory before attach or cleanup',()=>{
  for(const patch of [{Id:'d'.repeat(64)},{Image:'sha256:'+'d'.repeat(64)},{Name:'/other'},{State:{Running:true}}])
    assert.throws(()=>check({...fixture(),...patch}),denied);
  assert.throws(()=>assertClamAvRelayIsolation(fixture(),{...receipt,role:'scanner'},image,scanner),denied);
});
test('relay rejects injected proxy/app credentials and duplicated environment even from Docker config',()=>{
  for(const env of [['TZ=UTC','HTTPS_PROXY=synthetic-private'],['TZ=UTC','DATABASE_URL=synthetic-private'],['TZ=UTC','TZ=UTC'],
    ['TZ=UTC','PATH=synthetic-private'],['TZ=UTC','NODE_VERSION=unapproved']]) {
    const value=fixture();value.Config.Env=env;assert.throws(()=>check(value),denied);
  }
  const value=fixture();value.Config.Env.push('NODE_VERSION=24.15.0','YARN_VERSION=1.22.22','PATH=/usr/local/bin:/usr/bin:/bin');check(value);
});
test('relay creation imports no ambient or synthetic DB credentials into its Docker CLI',()=>{
  const config=localDockerTestConfiguration({SYSTEMROOT:'C:\\Windows',LOCALAPPDATA:'C:\\Synthetic',POSTGRES_PASSWORD:'a'.repeat(64)},
    {POSTGRES_PASSWORD:'a'.repeat(64),CAREBRIDGE_FIXTURE_PASSWORD:'a'.repeat(64)});
  const environment=config.environmentFor(clamAvRelayArguments(run,scanner,image));assert.equal(environment.POSTGRES_PASSWORD,undefined);
  assert.equal(environment.CAREBRIDGE_FIXTURE_PASSWORD,undefined);
});
test('relay image build context includes only its fixed peer and no source tree, secrets or dependencies',async()=>{
  const docker=await readFile(new URL('../clamav-relay-test.Dockerfile',import.meta.url),'utf8');
  const ignore=await readFile(new URL('../clamav-relay-test.Dockerfile.dockerignore',import.meta.url),'utf8');
  assert.equal(ignore.trim(),'**\n!server/\n!server/clamav-relay-peer-test.mjs');
  assert.match(docker,/^FROM docker\.io\/library\/node@sha256:[a-f0-9]{64}$/m);assert.equal(/^RUN /m.test(docker),false);
  assert.equal(docker.match(/^COPY /gm)?.length,1);
  const peer=await readFile(new URL('../clamav-relay-peer-test.mjs',import.meta.url),'utf8');assert.match(peer,/socket\.connect\(3310,'127\.0\.0\.1'\)/);
  assert.equal(/process\.env|readFile|writeFile|console\./.test(peer),false);
});
test('bridge rejects malformed options before touching Docker or opening a listener',async()=>{
  for(const value of [null,{}, {force:true},{runtime:{},engineIdentity:'test',scannerReceipt:receipt,scannerImageId:image,relayImageId:image}])
    await assert.rejects(startWindowsClamAvTestBridge(value),denied);
});

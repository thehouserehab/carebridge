import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { testResourceNames,resourceReceipt,RUN_LABEL } from '../postgres-container-policy.mjs';
import { DECODER_NODE_IMAGE } from '../decoder-container-policy.mjs';
import { decoderServiceTestArguments,assertDecoderServiceTestIsolation } from '../decoder-service-test-policy.mjs';
const names = testResourceNames('12345678-1234-4234-8234-123456789abc'),databaseId = 'a'.repeat(64),imageId = `sha256:${'b'.repeat(64)}`;
const receipt = resourceReceipt('c'.repeat(64),names.worker,names.run),target = '/run/carebridge-engine/docker.sock';
const fixture = () => ({ Id:receipt.id,Name:`/${receipt.name}`,Image:imageId,Config:{ User:'node',Labels:{ [RUN_LABEL]:names.run },Cmd:['node','linux-decoder-native-test.mjs'] },State:{ Running:false },
  HostConfig:{ ReadonlyRootfs:true,Privileged:false,NetworkMode:`container:${databaseId}`,RestartPolicy:{ Name:'no' },LogConfig:{ Type:'none' },
    Memory:512*1024*1024,MemorySwap:512*1024*1024,NanoCpus:1e9,PidsLimit:128,CapDrop:['ALL'],CapAdd:null,SecurityOpt:['no-new-privileges'],
    Binds:null,VolumesFrom:null,Devices:[],DeviceRequests:[],PortBindings:{},PidMode:'',UTSMode:'',IpcMode:'private',
    Ulimits:[{ Name:'nofile',Soft:1024,Hard:1024 }],GroupAdd:['0'],Tmpfs:{ '/tmp':'rw,noexec,nosuid,nodev,size=16m,mode=1777' },
    Mounts:[{ Type:'bind',Source:'/var/run/docker.sock',Target:target,ReadOnly:true,BindOptions:{ Propagation:'rprivate' } }] },
  Mounts:[{ Type:'bind',Source:'/var/run/docker.sock',Destination:target,RW:false,Propagation:'rprivate' }],NetworkSettings:{ Networks:{},Ports:{} } });
const checked = (value) => assertDecoderServiceTestIsolation(value,receipt,imageId,{ databaseId });
const refused = (work) => assert.throws(work,{ message:'DECODER_SERVICE_TEST_SAFETY' });
test('trusted test controller has one explicit socket and remains separate from untrusted file workers',() => {
  const args = decoderServiceTestArguments(names,databaseId,imageId); checked(fixture());
  for (const value of ['--read-only','--group-add','0','--memory=512m','--memory-swap=512m','--pids-limit=128',`--network=container:${databaseId}`,
    `type=bind,source=/var/run/docker.sock,target=${target},readonly,bind-propagation=rprivate`]) assert.ok(args.includes(value));
  assert.equal(args.some((value) => /--privileged|--publish/.test(value)),false);
});
test('writable second socket host mounts extra privileges ports and different image are refused',() => {
  for (const mutate of [(s) => { s.HostConfig.Mounts[0].ReadOnly = false; },(s) => { s.Mounts[0].RW = true; },
    (s) => { s.HostConfig.Mounts.push({}); },(s) => { s.Mounts.push({}); },(s) => { s.HostConfig.Mounts[0].Source = '/private'; },
    (s) => { s.HostConfig.GroupAdd.push('1000'); },(s) => { s.Config.User = 'root'; },(s) => { s.HostConfig.PidMode = 'host'; },
    (s) => { s.HostConfig.SecurityOpt.push('seccomp=unconfined'); },(s) => { s.HostConfig.Binds = ['/private:/private']; },
    (s) => { s.HostConfig.PortBindings = { '80/tcp':[{}] }; },(s) => { s.Image = `sha256:${'d'.repeat(64)}`; },
    (s) => { s.Config.Cmd = ['sh']; },(s) => { s.HostConfig.Memory = 0; }]) { const state = fixture(); mutate(state); refused(() => checked(state)); }
});
test('private database namespace remains required despite the trusted engine socket exception',() => {
  for (const mutate of [(s) => { s.HostConfig.NetworkMode = 'host'; },(s) => { s.NetworkSettings.Networks = { bridge:{ IPAddress:'1.2.3.4' } }; },
    (s) => { s.HostConfig.Privileged = true; },(s) => { s.HostConfig.LogConfig.Type = 'json-file'; },(s) => { s.HostConfig.RestartPolicy.Name = 'always'; }]) {
    const state = fixture(); mutate(state); refused(() => checked(state));
  }
});
test('controller build is offline and allowlists only fixed test CLI and internal public sources',async () => {
  const source = await readFile(new URL('../linux-decoder-test.Dockerfile',import.meta.url),'utf8');
  assert.ok(source.includes(`FROM ${DECODER_NODE_IMAGE}`)); assert.ok(source.includes('9c46230f41e4263b3a9d93ae9284722709923c50d138bc64eed2bb6c02af0581'));
  assert.equal(/COPY\s+\.\s|ADD\s|curl\s|wget\s|apk\s|npm\s/.test(source),false);
  const rules = (await readFile(new URL('../linux-decoder-test.Dockerfile.dockerignore',import.meta.url),'utf8')).split(/\r?\n/);
  assert.equal(rules[0],'**'); assert.equal(rules.some((line) => /!\.env|!docs|!src\/app|!test-results\/\*\*/.test(line)),false);
  assert.equal(rules.filter((line) => line.includes('docker-cli-29.8.1/docker/docker')).length,1);
});

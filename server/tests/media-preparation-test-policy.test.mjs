import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { testResourceNames,resourceReceipt,RUN_LABEL } from '../postgres-container-policy.mjs';
import { preparationControllerArguments,assertPreparationControllerIsolation } from '../media-preparation-test-policy.mjs';
const names = testResourceNames('12345678-1234-4234-8234-123456789abc'),scannerId = 'a'.repeat(64),imageId = `sha256:${'b'.repeat(64)}`;
const receipt = resourceReceipt('c'.repeat(64),names.worker,names.run),target = '/run/carebridge-engine/docker.sock';
const fixture = () => ({ Id:receipt.id,Name:`/${receipt.name}`,Image:imageId,
  Config:{ User:'node',Labels:{ [RUN_LABEL]:names.run },Cmd:['node','media-preparation-native-test.mjs'] },State:{ Running:false },
  HostConfig:{ ReadonlyRootfs:true,Privileged:false,NetworkMode:`container:${scannerId}`,RestartPolicy:{ Name:'no' },LogConfig:{ Type:'none' },
    Memory:1024*1024*1024,MemorySwap:1024*1024*1024,NanoCpus:1e9,PidsLimit:128,CapDrop:['ALL'],CapAdd:null,SecurityOpt:['no-new-privileges'],
    Binds:null,VolumesFrom:null,Devices:[],DeviceRequests:[],PortBindings:{},PidMode:'',UTSMode:'',IpcMode:'private',
    Ulimits:[{ Name:'nofile',Soft:1024,Hard:1024 }],GroupAdd:['0'],Tmpfs:{ '/tmp':'rw,noexec,nosuid,nodev,size=16m,mode=1777' },
    Mounts:[{ Type:'bind',Source:'/var/run/docker.sock',Target:target,ReadOnly:true,BindOptions:{ Propagation:'rprivate' } }] },
  Mounts:[{ Type:'bind',Source:'/var/run/docker.sock',Destination:target,RW:false,Propagation:'rprivate' }],NetworkSettings:{ Networks:{},Ports:{} } });
const check = (value) => assertPreparationControllerIsolation(value,receipt,imageId,{ scannerId });
test('preparation test controller uses one fixed command one socket and only the offline scanner namespace',() => {
  const args = preparationControllerArguments(names,scannerId,imageId); check(fixture());
  assert.deepEqual(args.slice(-2),['node','media-preparation-native-test.mjs']);
  assert.ok(args.includes(`--network=container:${scannerId}`)); assert.equal(args.filter((v) => v.includes('source=/var/run/docker.sock')).length,1);
  assert.ok(args.includes('--memory=1024m')); assert.ok(args.includes('--memory-swap=1024m')); assert.equal(args.includes('--memory=512m'),false);
  assert.equal(args.some((v) => /--privileged|--publish/.test(v)),false);
});
test('alternate commands host namespaces public ports writable sockets and second mounts are refused',() => {
  for (const mutate of [(s) => { s.Config.Cmd = ['node','other.mjs']; },(s) => { s.HostConfig.NetworkMode = 'host'; },
    (s) => { s.HostConfig.PortBindings = { '3310/tcp':[{}] }; },(s) => { s.Mounts[0].RW = true; },
    (s) => { s.HostConfig.Mounts.push({}); },(s) => { s.Config.User = 'root'; },(s) => { s.HostConfig.SecurityOpt.push('seccomp=unconfined'); },
    (s) => { s.HostConfig.Memory *= 2; },(s) => { s.HostConfig.MemorySwap /= 2; }]) {
    const state = fixture(); mutate(state); assert.throws(() => check(state));
  }
});
test('test controller build admits only specific synthetic modules and never mounts socket into a file worker',async () => {
  const source = await readFile(new URL('../linux-decoder-test.Dockerfile',import.meta.url),'utf8');
  assert.ok(source.includes('FROM controller AS media-preparation')); assert.ok(source.includes('CMD ["node", "media-preparation-native-test.mjs"]'));
  assert.equal(/COPY\s+\.\s|ADD\s|curl\s|wget\s|apk\s|npm\s/.test(source),false);
  const rules = await readFile(new URL('../linux-decoder-test.Dockerfile.dockerignore',import.meta.url),'utf8');
  for (const fixed of ['!server/clamav-client.mjs','!server/media-preparation.mjs','!server/media-preparation-native-test.mjs']) assert.ok(rules.includes(fixed));
  assert.equal(/!\.env|!docs|!src\/app|!test-results\/\*\*/.test(rules),false);
  const worker = await readFile(new URL('../decoder-job.Dockerfile',import.meta.url),'utf8');
  assert.equal(/docker\.sock|COPY.*node_modules|enable-encoder/.test(worker),false);
});

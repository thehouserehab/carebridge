import assert from 'node:assert/strict';
import { test } from 'node:test';
import { POSTGRES_TEST_IMAGE, NODE_TEST_IMAGE, RUN_LABEL, TEST_TMPFS, testResourceNames, resourceReceipt,
  containerArguments, workerArguments, assertContainerOwner, assertContainerIsolation } from '../postgres-container-policy.mjs';
const names = testResourceNames('12345678-1234-4234-8234-123456789abc');
const receipt = resourceReceipt('a'.repeat(64),names.container,names.run);
const worker = resourceReceipt('b'.repeat(64),names.worker,names.run);
const imageId = `sha256:${'c'.repeat(64)}`;
const fixture = ({ isWorker = false,running = false } = {}) => ({
  Id:isWorker ? worker.id : receipt.id,Name:`/${isWorker ? worker.name : receipt.name}`,Image:imageId,
  Config:{ User:isWorker ? 'node' : 'postgres',Labels:{ [RUN_LABEL]:names.run } },State:{ Running:running },
  HostConfig:{ ReadonlyRootfs:true,Privileged:false,NetworkMode:isWorker ? `container:${receipt.id}` : 'none',
    RestartPolicy:{ Name:'no' },LogConfig:{ Type:'none' },Memory:(isWorker ? 256 : 768)*1024*1024,
    MemorySwap:(isWorker ? 256 : 768)*1024*1024,NanoCpus:1e9,PidsLimit:isWorker ? 64 : 128,
    CapDrop:['ALL'],CapAdd:null,SecurityOpt:['no-new-privileges'],Binds:null,VolumesFrom:null,Mounts:[],
    Devices:[],DeviceRequests:[],PortBindings:{},
    Tmpfs:isWorker ? { '/tmp':'rw,noexec,nosuid,nodev,size=16m,mode=1777' } : { ...TEST_TMPFS } },
  Mounts:[],NetworkSettings:{ Networks:isWorker ? {} : { none:{ NetworkID:'d'.repeat(64),IPAddress:'',Gateway:'' } },Ports:{ '5432/tcp':null } },
});
const refused = (work) => assert.throws(work,{ message:'POSTGRES_CONTAINER_SAFETY' });
test('test names and receipts reject non-UUID resources, short IDs and existing containers',() => {
  assert.notEqual(names.container,names.worker);
  for (const uuid of ['test','../test',null,'12345678-1234-1234-8234-123456789abc']) refused(() => testResourceNames(uuid));
  for (const id of ['short','a'.repeat(12),null,'a'.repeat(63)+';']) refused(() => resourceReceipt(id,names.container,names.run));
  refused(() => resourceReceipt(receipt.id,'existing-customer-container',names.run));
});
test('official images are digest-pinned and arguments contain no password values or host port',() => {
  for (const image of [POSTGRES_TEST_IMAGE,NODE_TEST_IMAGE])
    assert.match(image,/^docker\.io\/library\/(postgres|node)@sha256:[a-f0-9]{64}$/);
  for (const args of [containerArguments(names),workerArguments(names,receipt.id,imageId)]) {
    assert.ok(args.includes('--pull=never')); assert.ok(args.includes('--read-only'));
    assert.equal(args.some((arg) => /^(--privileged|--publish|--volume)(=|$)|docker\.sock|PASSWORD=/.test(arg)),false);
  }
  assert.ok(containerArguments(names).includes('--network=none'));
  assert.ok(workerArguments(names,receipt.id,imageId).includes(`--network=container:${receipt.id}`));
  refused(() => containerArguments({ ...names,container:'existing-customer-container' }));
  refused(() => workerArguments(names,'short',imageId));
});
test('cleanup ownership checks full ID, exact name, image and run label',() => {
  assertContainerOwner(fixture(),receipt,imageId);
  for (const change of [{ Id:worker.id },{ Name:'/other' },{ Image:`sha256:${'d'.repeat(64)}` },{ Config:{ Labels:{} } }])
    refused(() => assertContainerOwner({ ...fixture(),...change },receipt,imageId));
});
test('created/running database and worker profiles require exact namespace and resource limits',() => {
  assertContainerIsolation(fixture(),receipt,imageId);
  assertContainerIsolation(fixture({ running:true }),receipt,imageId,{ running:true });
  assertContainerIsolation(fixture({ isWorker:true }),worker,imageId,{ databaseId:receipt.id });
  refused(() => assertContainerIsolation(fixture({ isWorker:true }),worker,imageId,{ databaseId:worker.id }));
  for (const change of [{ ReadonlyRootfs:false },{ Privileged:true },{ NetworkMode:'host' },
    { RestartPolicy:{ Name:'always' } },{ LogConfig:{ Type:'json-file' } },{ Memory:0 },{ MemorySwap:-1 },
    { NanoCpus:0 },{ PidsLimit:0 },{ CapDrop:[] },{ CapAdd:['SYS_ADMIN'] },{ SecurityOpt:[] },
    { Binds:['/host:/data'] },{ VolumesFrom:['existing'] },{ Mounts:[{}] },{ Devices:[{}] },
    { DeviceRequests:[{}] },{ Tmpfs:{} }]) {
    const state = fixture(); Object.assign(state.HostConfig,change);
    refused(() => assertContainerIsolation(state,receipt,imageId));
  }
});
test('root execution, persistent volumes, additional networks or any host port are rejected',() => {
  const root = fixture(); root.Config.User = 'root';
  const volume = fixture(); volume.Mounts = [{ Type:'volume' }];
  const net = fixture(); net.NetworkSettings.Networks.other = { NetworkID:worker.id };
  const port = fixture(); port.HostConfig.PortBindings = { '5432/tcp':[{ HostIp:'127.0.0.1',HostPort:'15432' }] };
  const actualPort = fixture(); actualPort.NetworkSettings.Ports['5432/tcp'] = [{ HostIp:'0.0.0.0',HostPort:'15432' }];
  for (const state of [root,volume,net,port,actualPort])
    refused(() => assertContainerIsolation(state,receipt,imageId));
});
test('container state must match expectation before execution or cleanup',() => {
  refused(() => assertContainerIsolation(fixture({ running:true }),receipt,imageId));
  refused(() => assertContainerIsolation(fixture(),receipt,imageId,{ running:true }));
});

test('only the explicit recovery suite permits its bounded 512MiB worker profile',() => {
  const args = workerArguments(names,receipt.id,imageId,{ suite:'recovery' });
  assert.ok(args.includes('--memory=512m')); assert.ok(args.includes('--memory-swap=512m'));
  const state = fixture({ isWorker:true }); state.HostConfig.Memory = state.HostConfig.MemorySwap = 512*1024*1024;
  assertContainerIsolation(state,worker,imageId,{ databaseId:receipt.id,suite:'recovery' });
  refused(() => assertContainerIsolation(state,worker,imageId,{ databaseId:receipt.id }));
  refused(() => workerArguments(names,receipt.id,imageId,{ suite:'unlimited' }));
  state.HostConfig.MemorySwap = -1;
  refused(() => assertContainerIsolation(state,worker,imageId,{ databaseId:receipt.id,suite:'recovery' }));
});

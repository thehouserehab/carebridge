// Local test tooling only. Versions reviewed and pulled from Docker Official Images.
export const POSTGRES_TEST_IMAGE = 'docker.io/library/postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';
export const NODE_TEST_IMAGE = 'docker.io/library/node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f';
export const RUN_LABEL = 'carebridge.postgres-test.run';
export const TEST_TMPFS = Object.freeze({
  '/var/lib/postgresql':'rw,noexec,nosuid,nodev,size=512m,uid=70,gid=70,mode=0700',
  '/var/run/postgresql':'rw,noexec,nosuid,nodev,size=4m,uid=70,gid=70,mode=0755',
  '/tmp':'rw,noexec,nosuid,nodev,size=64m,mode=1777',
});
const fail = () => { throw new Error('POSTGRES_CONTAINER_SAFETY'); };
const validId = (id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);

export function testResourceNames(uuid) {
  if (typeof uuid !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(uuid)) fail();
  const suffix = uuid.replaceAll('-','');
  return Object.freeze({ run:uuid,container:`carebridge-pg-test-${suffix}`,
    worker:`carebridge-pg-worker-${suffix}`,image:`carebridge-pg-worker-test:${suffix}` });
}

export function resourceReceipt(id, name, run) {
  const names = testResourceNames(run);
  if (!validId(id) || ![names.container,names.worker].includes(name)) fail();
  return Object.freeze({ id,name,run });
}
export function assertContainerOwner(container, receipt, imageId) {
  resourceReceipt(receipt?.id,receipt?.name,receipt?.run);
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId ?? '') || container?.Id !== receipt.id ||
      container.Name !== `/${receipt.name}` || container.Image !== imageId ||
      container.Config?.Labels?.[RUN_LABEL] !== receipt.run) fail();
}
const hardenedArguments = ['--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
  '--restart=no','--log-driver','none','--cpus=1','--ulimit','nofile=1024:1024'];

export function containerArguments(names) {
  const checked = testResourceNames(names?.run);
  if (names.container !== checked.container) fail();
  return ['create','--pull=never','--platform=linux/amd64','--name',names.container,
    '--label',`${RUN_LABEL}=${names.run}`,'--network=none','--user','postgres',...hardenedArguments,
    '--memory=768m','--memory-swap=768m','--pids-limit=128','--shm-size=64m',
    ...Object.entries(TEST_TMPFS).flatMap(([target,options]) => ['--tmpfs',`${target}:${options}`]),
    '--env','POSTGRES_PASSWORD','--env','TZ=UTC','--env','POSTGRES_USER=carebridge_fixture_admin',
    '--env','POSTGRES_DB=postgres','--env','POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
    '--env','POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 --auth-local=scram-sha-256',
    POSTGRES_TEST_IMAGE,'postgres','-c','listen_addresses=127.0.0.1','-c','max_connections=20',
    '-c','shared_buffers=32MB','-c','jit=off','-c','log_statement=none',
    '-c','log_min_error_statement=panic','-c','log_min_messages=panic'];
}
function workerMemory(suite) {
  if (!['postgres','recovery'].includes(suite)) fail();
  return suite === 'recovery' ? 512 : 256;
}
export function workerArguments(names, databaseId, imageId, { suite = 'postgres' } = {}) {
  const checked = testResourceNames(names?.run);
  if (names.worker !== checked.worker || !validId(databaseId) || !/^sha256:[a-f0-9]{64}$/.test(imageId)) fail();
  return ['create','--pull=never','--platform=linux/amd64','--name',names.worker,
    '--label',`${RUN_LABEL}=${names.run}`,`--network=container:${databaseId}`,'--user','node',...hardenedArguments,
    `--memory=${workerMemory(suite)}m`,`--memory-swap=${workerMemory(suite)}m`,'--pids-limit=64',
    '--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777',
    '--env','CAREBRIDGE_FIXTURE_PASSWORD','--env','TZ=UTC',imageId,'node','postgres-container-fixture.mjs',
    ...(suite === 'recovery' ? ['--recovery'] : [])];
}

export function assertContainerIsolation(container, receipt, imageId, { databaseId, running = false, suite = 'postgres' } = {}) {
  assertContainerOwner(container,receipt,imageId);
  const worker = receipt.name === testResourceNames(receipt.run).worker;
  if (worker && !validId(databaseId)) fail();
  const h = container.HostConfig, networks = container.NetworkSettings?.Networks;
  const expectedTmpfs = worker ? { '/tmp':'rw,noexec,nosuid,nodev,size=16m,mode=1777' } : TEST_TMPFS;
  const memory = (worker ? workerMemory(suite) : 768)*1024*1024;
  const expectedMode = worker ? `container:${databaseId}` : 'none';
  // No published port at all. Worker shares only this run's DB network
  // namespace and connects to 127.0.0.1:5432 inside it, not the Windows host.
  const checks = {
    STATE:container.State?.Running === running,
    USER:container.Config.User === (worker ? 'node' : 'postgres'),
    READ_ONLY:h.ReadonlyRootfs === true && h.Privileged === false,
    NETWORK_MODE:h.NetworkMode === expectedMode,
    RESTART_LOGGING:h.RestartPolicy?.Name === 'no' && h.LogConfig?.Type === 'none',
    RESOURCES:h.Memory === memory && h.MemorySwap === memory && h.NanoCpus === 1e9 && h.PidsLimit === (worker ? 64 : 128),
    CAPABILITIES:JSON.stringify(h.CapDrop) === JSON.stringify(['ALL']) && (h.CapAdd?.length ?? 0) === 0 &&
      h.SecurityOpt?.includes('no-new-privileges'),
    NO_HOST_MOUNTS:(h.Binds?.length ?? 0) === 0 && (h.VolumesFrom?.length ?? 0) === 0 && (h.Mounts?.length ?? 0) === 0,
    NO_DEVICES:(h.Devices?.length ?? 0) === 0 && (h.DeviceRequests?.length ?? 0) === 0,
    TMPFS:Object.keys(h.Tmpfs ?? {}).length === Object.keys(expectedTmpfs).length &&
      Object.entries(expectedTmpfs).every(([target,options]) => h.Tmpfs[target] === options) &&
      (container.Mounts ?? []).every((mount) => mount.Type === 'tmpfs'),
    // Docker's built-in "none" network has its own ID, but no routable
    // address/gateway. A network ID alone does not mean external connectivity.
    NETWORK_ATTACHMENTS:Object.keys(networks ?? {}).every((name) => !worker && name === 'none') &&
      Object.values(networks ?? {}).every((network) => !network.IPAddress && !network.Gateway &&
        !network.GlobalIPv6Address && !network.IPv6Gateway),
    NO_PUBLISHED_PORTS:Object.keys(h.PortBindings ?? {}).length === 0 &&
      !Object.values(container.NetworkSettings?.Ports ?? {}).some((bindings) => bindings?.length),
  };
  for (const [criterion,valid] of Object.entries(checks)) if (!valid) {
    const error = new Error('POSTGRES_CONTAINER_SAFETY'); error.criterion = criterion; throw error;
  }
}

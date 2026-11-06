// Explicit synthetic local tests only. These profiles do not activate uploads.
export const CLAMAV_TEST_IMAGE = 'docker.io/clamav/clamav@sha256:57deb108fc4c72778aa83eafbca7bb7153e28c3f57c005afd38d31f16da86f23';
export const CLAMAV_TEST_VERSION = '1.4.6';
export const NODE_TEST_IMAGE = 'docker.io/library/node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f';
export const RUN_LABEL = 'carebridge.clamav-test.run';
const fail = (criterion) => { const error = new Error('CLAMAV_CONTAINER_SAFETY'); error.criterion = criterion; throw error; };
const validId = (id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
const validImage = (id) => /^sha256:[a-f0-9]{64}$/.test(id ?? '');
const tmpfs = (role) => `rw,noexec,nosuid,nodev,size=${role === 'worker' ? 16 : 256}m,mode=1777`;
const resources = { updater:{ memory:3072,pids:64 },scanner:{ memory:4096,pids:128 },worker:{ memory:256,pids:64 } };

export function testResourceNames(run) {
  if (typeof run !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(run)) fail('RUN');
  const suffix = run.replaceAll('-','');
  return Object.freeze({ run,updater:`carebridge-av-update-${suffix}`,scanner:`carebridge-av-scan-${suffix}`,
    worker:`carebridge-av-worker-${suffix}`,volume:`carebridge-av-definitions-${suffix}`,
    engineImage:`carebridge-av-engine-test:${suffix}`,workerImage:`carebridge-av-worker-test:${suffix}` });
}
export function resourceReceipt(id,role,run) {
  const names = testResourceNames(run);
  if (!validId(id) || !Object.hasOwn(resources,role)) fail('RECEIPT');
  return Object.freeze({ id,role,name:names[role],run });
}
export function volumeReceipt(volume,run) {
  const names = testResourceNames(run);
  if (volume?.Name !== names.volume || volume.Driver !== 'local' || volume.Scope !== 'local' ||
      Object.keys(volume.Options ?? {}).length || volume.Labels?.[RUN_LABEL] !== run ||
      typeof volume.CreatedAt !== 'string' || !Number.isFinite(Date.parse(volume.CreatedAt))) fail('VOLUME');
  return Object.freeze({ name:volume.Name,createdAt:volume.CreatedAt,run });
}
export function assertVolumeOwner(volume,receipt) {
  const checked = volumeReceipt(volume,receipt?.run);
  if (checked.name !== receipt.name || checked.createdAt !== receipt.createdAt) fail('VOLUME');
}
export function assertContainerOwner(container,receipt,imageId) {
  const checked = resourceReceipt(receipt?.id,receipt?.role,receipt?.run);
  if (receipt.name !== checked.name || !validImage(imageId) || container?.Id !== receipt.id || container.Name !== `/${receipt.name}` ||
      container.Image !== imageId || container.Config?.Labels?.[RUN_LABEL] !== receipt.run) fail('OWNER');
}
export function containerArguments(names,role,imageId,scannerId) {
  const checked = testResourceNames(names?.run), limit = resources[role];
  if (!Object.hasOwn(resources,role) || !limit || Object.keys(checked).some((key) => names[key] !== checked[key]) || !validImage(imageId) ||
      (role === 'worker' && !validId(scannerId))) fail('ARGUMENTS');
  const mode = role === 'updater' ? 'bridge' : role === 'scanner' ? 'none' : `container:${scannerId}`;
  return ['create','--pull=never','--platform=linux/amd64','--name',names[role],
    '--label',`${RUN_LABEL}=${names.run}`,`--network=${mode}`,'--user',role === 'worker' ? 'node' : 'clamav',
    '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--restart=no','--log-driver','none',
    '--cpus=1',`--memory=${limit.memory}m`,`--memory-swap=${limit.memory}m`,`--pids-limit=${limit.pids}`,
    '--ulimit','nofile=1024:1024','--tmpfs',`/tmp:${tmpfs(role)}`,'--env','TZ=UTC',
    ...(role === 'worker' ? [] : ['--mount',`type=volume,source=${names.volume},target=/var/lib/clamav${role === 'scanner' ? ',readonly' : ''}`]),
    ...(role === 'updater' ? ['--entrypoint','freshclam'] : []),imageId,
    ...(role === 'updater' ? ['--config-file=/opt/carebridge/freshclam.conf','--stdout'] : [])];
}
export function assertContainerIsolation(container,receipt,imageId,{ scannerId,running = false } = {}) {
  assertContainerOwner(container,receipt,imageId);
  const role = receipt.role, names = testResourceNames(receipt.run), h = container.HostConfig;
  if (role === 'worker' && !validId(scannerId)) fail('SCANNER');
  const expectedMode = role === 'updater' ? 'bridge' : role === 'scanner' ? 'none' : `container:${scannerId}`;
  const volumes = (container.Mounts ?? []).filter((mount) => mount.Type === 'volume');
  const networkEntries = Object.entries(container.NetworkSettings?.Networks ?? {});
  const checks = {
    STATE:container.State?.Running === running,
    USER:container.Config.User === (role === 'worker' ? 'node' : 'clamav'),
    ENVIRONMENT:JSON.stringify(container.Config.Env?.filter((item) => item.startsWith('TZ='))) === '["TZ=UTC"]',
    READ_ONLY:h.ReadonlyRootfs === true && h.Privileged === false,
    NAMESPACE:h.NetworkMode === expectedMode && !h.PidMode && h.IpcMode !== 'host' && h.UTSMode !== 'host',
    LOG_RESTART:h.RestartPolicy?.Name === 'no' && h.LogConfig?.Type === 'none',
    RESOURCES:h.Memory === resources[role].memory*1024*1024 && h.MemorySwap === h.Memory &&
      h.NanoCpus === 1e9 && h.PidsLimit === resources[role].pids,
    CAPABILITIES:JSON.stringify(h.CapDrop) === '["ALL"]' && !(h.CapAdd?.length) && h.SecurityOpt?.includes('no-new-privileges'),
    HOST_ACCESS:!(h.Binds?.length) && !(h.VolumesFrom?.length) && !(h.Devices?.length) && !(h.DeviceRequests?.length),
    TMPFS:Object.keys(h.Tmpfs ?? {}).length === 1 && h.Tmpfs['/tmp'] === tmpfs(role),
    VOLUMES:role === 'worker' ? volumes.length === 0 && !(h.Mounts?.length) :
      volumes.length === 1 && h.Mounts?.length === 1 && volumes[0].Name === names.volume &&
      volumes[0].Destination === '/var/lib/clamav' && volumes[0].RW === (role === 'updater') &&
      h.Mounts[0].Type === 'volume' && h.Mounts[0].Source === names.volume &&
      h.Mounts[0].Target === '/var/lib/clamav' && Boolean(h.Mounts[0].ReadOnly) === (role === 'scanner'),
    NO_EXTRA_MOUNTS:(container.Mounts ?? []).every((mount) => mount.Type === 'volume' ||
      mount.Type === 'tmpfs' && mount.Destination === '/tmp' && mount.RW === true),
    NETWORKS:networkEntries.every(([name,network]) => role === 'updater' ? name === 'bridge' :
      role === 'scanner' && name === 'none' && !network.IPAddress && !network.Gateway &&
      !network.GlobalIPv6Address && !network.IPv6Gateway),
    NO_PORTS:Object.keys(h.PortBindings ?? {}).length === 0 &&
      !Object.values(container.NetworkSettings?.Ports ?? {}).some((bindings) => bindings?.length),
  };
  for (const [criterion,valid] of Object.entries(checks)) if (!valid) fail(criterion);
}

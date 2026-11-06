// Shared fixed per-job isolation policy and explicit synthetic test resources.
// This module grants no engine access and is never an API launcher by itself.
export const DECODER_NODE_IMAGE = 'docker.io/library/node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f';
export const DECODER_RUN_LABEL = 'carebridge.decoder-test.run';
export const DECODER_JOB_LABEL = 'carebridge.decoder-job.run';
const fail = (criterion) => { const error = new Error('DECODER_CONTAINER_SAFETY'); error.criterion = criterion; throw error; };
const fullId = (id) => /^[a-f0-9]{64}$/.test(id ?? '');
const imageIdValid = (id) => /^sha256:[a-f0-9]{64}$/.test(id ?? '');
const tmpfs = 'rw,noexec,nosuid,nodev,size=256m,mode=1777';
export function decoderResourceNames(run,purpose = 'test') {
  if (!['test','job'].includes(purpose)) fail('PURPOSE');
  if (typeof run !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(run)) fail('RUN');
  const suffix = run.replaceAll('-','');
  return Object.freeze({ run,worker:`carebridge-decode-${purpose}-${suffix}`,image:`carebridge-decode-${purpose}:${suffix}` });
}
export function decoderReceipt(id,run,purpose = 'test') {
  if (!fullId(id)) fail('RECEIPT');
  return Object.freeze({ id,run,name:decoderResourceNames(run,purpose).worker,...(purpose === 'job' ? { purpose } : {}) });
}
export function decoderContainerArguments(names,imageId,purpose = 'test') {
  const checked = decoderResourceNames(names?.run,purpose);
  if (Object.keys(checked).some((key) => names[key] !== checked[key]) || !imageIdValid(imageId)) fail('ARGUMENTS');
  return ['create','--pull=never','--platform=linux/amd64','--name',names.worker,
    '--label',`${purpose === 'job' ? DECODER_JOB_LABEL : DECODER_RUN_LABEL}=${names.run}`,'--network=none','--user','node',
    '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--restart=no','--log-driver','none',
    '--cpus=1','--memory=1024m','--memory-swap=1024m','--pids-limit=128',
    '--ulimit','nofile=1024:1024','--tmpfs',`/tmp:${tmpfs}`,'--env','TZ=UTC',
    ...(purpose === 'job' ? ['--interactive','--entrypoint','/usr/local/bin/node'] : []),imageId,
    ...(purpose === 'job' ? ['/app/server/decoder-job-worker.mjs'] : [])];
}
export function assertDecoderOwner(container,receipt,imageId) {
  const purpose = receipt?.purpose ?? 'test',expected = decoderReceipt(receipt?.id,receipt?.run,purpose);
  if (receipt.name !== expected.name || !imageIdValid(imageId) || container?.Id !== receipt.id ||
      container.Name !== `/${receipt.name}` || container.Image !== imageId ||
      container.Config?.Labels?.[purpose === 'job' ? DECODER_JOB_LABEL : DECODER_RUN_LABEL] !== receipt.run) fail('OWNER');
}
export function assertDecoderIsolation(container,receipt,imageId,running = false) {
  assertDecoderOwner(container,receipt,imageId);
  const h = container.HostConfig;
  const checks = {
    STATE:container.State?.Running === running,
    USER:container.Config.User === 'node',
    ENVIRONMENT:JSON.stringify(container.Config.Env?.filter((value) => value.startsWith('TZ='))) === '["TZ=UTC"]',
    READ_ONLY:h.ReadonlyRootfs === true && h.Privileged === false,
    NAMESPACES:h.NetworkMode === 'none' && !h.PidMode && h.IpcMode !== 'host' && h.UTSMode !== 'host',
    RESOURCES:h.Memory === 1024*1024*1024 && h.MemorySwap === h.Memory && h.NanoCpus === 1e9 && h.PidsLimit === 128,
    FILE_DESCRIPTORS:h.Ulimits?.length === 1 && h.Ulimits[0].Name === 'nofile' && h.Ulimits[0].Soft === 1024 && h.Ulimits[0].Hard === 1024,
    LOG_RESTART:h.LogConfig?.Type === 'none' && h.RestartPolicy?.Name === 'no',
    CAPABILITIES:JSON.stringify(h.CapDrop) === '["ALL"]' && !h.CapAdd?.length && JSON.stringify(h.SecurityOpt) === '["no-new-privileges"]',
    NO_HOST_ACCESS:!h.Binds?.length && !h.VolumesFrom?.length && !h.Devices?.length && !h.DeviceRequests?.length && !h.Mounts?.length,
    TMPFS:Object.keys(h.Tmpfs ?? {}).length === 1 && h.Tmpfs['/tmp'] === tmpfs,
    NO_EXTRA_MOUNTS:(container.Mounts ?? []).every((mount) => mount.Type === 'tmpfs' && mount.Destination === '/tmp' && mount.RW === true),
    NO_NETWORK:Object.entries(container.NetworkSettings?.Networks ?? {}).every(([name,network]) => name === 'none' &&
      !network.IPAddress && !network.Gateway && !network.GlobalIPv6Address && !network.IPv6Gateway),
    NO_PORTS:!Object.keys(h.PortBindings ?? {}).length && !Object.values(container.NetworkSettings?.Ports ?? {}).some((value) => value?.length),
    JOB_COMMAND:receipt.purpose !== 'job' || container.Config.OpenStdin === true && container.Config.Tty === false &&
      JSON.stringify(container.Config.Entrypoint) === '["/usr/local/bin/node"]' && JSON.stringify(container.Config.Cmd) === '["/app/server/decoder-job-worker.mjs"]',
  };
  for (const [criterion,valid] of Object.entries(checks)) if (!valid) fail(criterion);
}

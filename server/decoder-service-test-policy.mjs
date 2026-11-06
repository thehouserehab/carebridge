import { workerArguments,assertContainerIsolation,assertContainerOwner } from './postgres-container-policy.mjs';
const fail = () => { throw new Error('DECODER_SERVICE_TEST_SAFETY'); };
const socketTarget = '/run/carebridge-engine/docker.sock';
// Trusted orchestration test ONLY. Unlike an untrusted per-file worker this
// controller is expressly allowed ONE engine socket. Read-only mount does NOT
// make the engine API read-only. Never grant this profile to a web/file worker.
export function decoderServiceTestArguments(names,databaseId,imageId) {
  const base = workerArguments(names,databaseId,imageId),at = base.indexOf(imageId);
  return [...base.slice(0,at).map((arg) => ({ '--memory=256m':'--memory=512m','--memory-swap=256m':'--memory-swap=512m','--pids-limit=64':'--pids-limit=128' })[arg] ?? arg),
    '--group-add','0','--mount',`type=bind,source=/var/run/docker.sock,target=${socketTarget},readonly,bind-propagation=rprivate`,
    '--env','CAREBRIDGE_LINUX_TEST_ENGINE','--env','CAREBRIDGE_LINUX_TEST_IMAGE','--env','CAREBRIDGE_LINUX_TEST_DATABASE_ID',
    imageId,'node','linux-decoder-native-test.mjs'];
}
export function assertDecoderServiceTestIsolation(container,receipt,imageId,{ databaseId,running = false } = {}) {
  try {
    assertContainerOwner(container,receipt,imageId);
    const h = container.HostConfig,mount = h.Mounts?.[0],actual = container.Mounts?.[0];
    if (h.Memory !== 512*1024*1024 || h.MemorySwap !== h.Memory || h.PidsLimit !== 128 ||
        JSON.stringify(h.GroupAdd) !== '["0"]' || h.Mounts?.length !== 1 || container.Mounts?.length !== 1 ||
        mount?.Type !== 'bind' || mount.Source !== '/var/run/docker.sock' || mount.Target !== socketTarget || mount.ReadOnly !== true ||
        mount.BindOptions?.Propagation !== 'rprivate' || actual?.Type !== 'bind' || actual.Source !== '/var/run/docker.sock' ||
        actual.Destination !== socketTarget || actual.RW !== false || actual.Propagation !== 'rprivate' ||
        h.PidMode || h.UTSMode || h.IpcMode === 'host' || JSON.stringify(h.SecurityOpt) !== '["no-new-privileges"]' ||
        h.Ulimits?.length !== 1 || h.Ulimits[0].Name !== 'nofile' || h.Ulimits[0].Soft !== 1024 || h.Ulimits[0].Hard !== 1024 ||
        JSON.stringify(container.Config.Cmd) !== '["node","linux-decoder-native-test.mjs"]') fail();
    // Only the separately verified controller exceptions are projected out;
    // all other existing private DB-worker rules remain enforced unchanged.
    const base = structuredClone(container);
    Object.assign(base.HostConfig,{ Memory:256*1024*1024,MemorySwap:256*1024*1024,PidsLimit:64,Mounts:[] }); base.Mounts = [];
    assertContainerIsolation(base,receipt,imageId,{ databaseId,running });
  } catch { fail(); }
}

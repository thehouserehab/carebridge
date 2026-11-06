import { decoderServiceTestArguments,assertDecoderServiceTestIsolation } from './decoder-service-test-policy.mjs';
// Explicit trusted test controller ONLY. The existing engine-socket exception
// is reused in an offline scanner namespace, not granted to a file worker.
export function preparationControllerArguments(names,scannerId,imageId) {
  const args = decoderServiceTestArguments(names,scannerId,imageId);
  // This trusted synthetic controller now also hosts a PGlite test DB. An
  // actual 512MiB cgroup OOM was measured. Keep a fixed 1GiB test-only bound;
  // neither the base controller nor untrusted per-file limits are changed.
  return [...args.slice(0,-1).map((arg) => ({ '--memory=512m':'--memory=1024m','--memory-swap=512m':'--memory-swap=1024m' })[arg] ?? arg),'media-preparation-native-test.mjs'];
}
export function assertPreparationControllerIsolation(container,receipt,imageId,{ scannerId,running = false } = {}) {
  if (JSON.stringify(container?.Config?.Cmd) !== '["node","media-preparation-native-test.mjs"]' ||
      container.HostConfig?.Memory !== 1024*1024*1024 || container.HostConfig.MemorySwap !== container.HostConfig.Memory) throw new Error('PREPARATION_CONTROLLER_SAFETY');
  const projected = structuredClone(container); projected.Config.Cmd = ['node','linux-decoder-native-test.mjs'];
  projected.HostConfig.Memory = 512*1024*1024; projected.HostConfig.MemorySwap = projected.HostConfig.Memory;
  assertDecoderServiceTestIsolation(projected,receipt,imageId,{ databaseId:scannerId,running });
}

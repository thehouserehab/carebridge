// Dedicated fresh synthetic worker. No test gate, arbitrary process command,
// scanner approval substitute, raw diagnostics forwarding or background service.
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { win32 } from 'node:path';
import { windowsSyntheticWorkerBootstrap, syntheticWorkerAdmissionReporter,
  syntheticWorkerUnavailable } from './windows-synthetic-worker-policy.mjs';
import { mediaWorkerControlId } from './media-worker-control-protocol.mjs';
import { runMediaWorkerControlledProcess } from './media-worker-controlled-process.mjs';
import { runWindowsMediaWorkerProcess } from './windows-media-worker-process.mjs';
import { PrivateFileStore } from './private-file-store.mjs';
import { LocalClamAvClient } from './clamav-client.mjs';
import { localDockerTestRuntime } from './local-docker-test-runtime.mjs';
import { nativeWorkerStageReporter, nativeDatabaseStageReporter } from './windows-native-worker-test-policy.mjs';

const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function ownedRoot(input) {
  const chain = [];
  for (let path = input.mediaRoot; ; path = win32.dirname(path)) {
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw syntheticWorkerUnavailable();
    chain.push({ path, info }); if (path === win32.dirname(path)) break;
  }
  if (win32.resolve(await realpath(input.mediaRoot)) !== input.mediaRoot) throw syntheticWorkerUnavailable();
  const path = win32.join(input.root, '.carebridge-check.json'), entry = await lstat(path, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n || entry.size < 1n || entry.size > 2048n) throw syntheticWorkerUnavailable();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!same(before, entry) || !before.isFile() || before.nlink !== 1n || before.size !== entry.size) throw syntheticWorkerUnavailable();
    const bytes = Buffer.alloc(2049), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (BigInt(bytesRead) !== before.size) throw syntheticWorkerUnavailable();
    const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)));
    const expected = { schema: 1, purpose: 'synthetic-native-e-postgres', runId: input.database.storage.syntheticRunId, root: input.root };
    if (!receipt || Object.keys(receipt).length !== 4 || Object.keys(expected).some(key => receipt[key] !== expected[key])) throw syntheticWorkerUnavailable();
    for (const actual of [await handle.stat({ bigint: true }), await lstat(path, { bigint: true })])
      if (!same(before, actual) || !actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1n || actual.size !== before.size ||
          actual.mtimeNs !== before.mtimeNs || actual.ctimeNs !== before.ctimeNs) throw syntheticWorkerUnavailable();
  } finally { await handle.close(); }
  for (const { path: directory, info } of chain) {
    const current = await lstat(directory, { bigint: true });
    if (!same(info, current) || !current.isDirectory() || current.isSymbolicLink()) throw syntheticWorkerUnavailable();
  }
  return chain[0].info;
}

let bootstrapTimer;
function failed() {
  clearTimeout(bootstrapTimer);
  process.stderr.write('SYNTHETIC_WORKER_FAILED\n');
  if ([undefined, null, 0].includes(process.exitCode)) process.exitCode = 1;
  if (process.connected) process.disconnect();
}
try {
  if (process.platform !== 'win32' || process.env.CAREBRIDGE_SYNTHETIC_WORKER_CHILD !== 'synthetic-only' ||
      process.argv.length !== 3 || !process.connected) throw syntheticWorkerUnavailable();
  const instanceId = mediaWorkerControlId(process.argv[2]);
  process.stdout.on('error', () => { if ([undefined, null, 0].includes(process.exitCode)) process.exitCode = 1; });
  process.stderr.on('error', () => {});
  const start = async bootstrap => {
    clearTimeout(bootstrapTimer);
    try {
      const input = windowsSyntheticWorkerBootstrap(bootstrap);
      await runMediaWorkerControlledProcess(async signal => {
        if (signal.aborted) return { stopped: true, processed: 0 };
        const root = await ownedRoot(input);
        if (signal.aborted) return { stopped: true, processed: 0 };
        const runtime = await localDockerTestRuntime();
        if (await runtime.identity() !== input.nativeMedia.engineIdentity) throw syntheticWorkerUnavailable();
        if (!same(root, await ownedRoot(input))) throw syntheticWorkerUnavailable();
        if (signal.aborted) return { stopped: true, processed: 0 };
        const scanner = new LocalClamAvClient({ endpoint: input.nativeMedia.scannerEndpoint,
          approvedEngineVersions: ['1.4.6'], daemonTimeZone: 'UTC', maxConcurrent: 1 });
        const reportAdmission = syntheticWorkerAdmissionReporter(instanceId, frame => process.stdout.write(frame));
        const reportStage = nativeWorkerStageReporter(frame => process.stderr.write(frame));
        return runWindowsMediaWorkerProcess({ database: input.database, media: {
          store: new PrivateFileStore(input.mediaRoot), scanner, runtime,
          engineIdentity: input.nativeMedia.engineIdentity, approvedImageId: input.nativeMedia.approvedImageId,
          capacity: 1, pollMilliseconds: 1000,
          onStage: event => { reportStage(event); reportAdmission(event); },
          onDatabaseStage: nativeDatabaseStageReporter(frame => process.stderr.write(frame)),
        } }, { signal });
      }, { instanceId });
    } catch { failed(); }
    finally { if (process.connected) process.disconnect(); }
  };
  process.once('message', start);
  // A lost bootstrap cannot strand an IPC-only child before the cooperative
  // worker controller exists. No work has started when this deadline fires.
  bootstrapTimer = setTimeout(() => { process.removeListener('message', start); failed(); }, 30000);
  bootstrapTimer.unref?.();
} catch { failed(); }

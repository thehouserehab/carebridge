import { randomUUID } from 'node:crypto';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDockerTestRuntime } from './local-docker-test-runtime.mjs';
import { CLAMAV_TEST_IMAGE,NODE_TEST_IMAGE,RUN_LABEL,testResourceNames,resourceReceipt,volumeReceipt,
  assertVolumeOwner,assertContainerOwner,containerArguments,assertContainerIsolation } from './clamav-container-policy.mjs';

// Explicit local test command. Never imported by app/API, no auto-install,
// pull, login, host paths/ports, existing databases or clinical files.
const names = testResourceNames(randomUUID()), directory = dirname(fileURLToPath(import.meta.url));
const receipts = {}, images = {};
let runtime,definitions,complete = false,failed = false,retain = false;
const fail = (code) => { throw new Error(code); };
function printResults(output) {
  for (const line of output.split(/\r?\n/)) if (
    /^(PASS|FAIL) [a-zA-Z0-9 .-]{1,140}$/.test(line) || /^CLAMAV_NATIVE_[A-Z_]+$/.test(line) ||
    /^Engine: ClamAV 1\.4\.6; definitions [1-9]\d{0,9}; UTC \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(line) ||
    line === 'Archive file boundary: 999 clean; 1000 rejected; 1001 rejected' ||
    line === 'Native ClamAV integration: 13 scenarios passed.') console.log(line);
}
async function create(role) {
  const imageId = role === 'worker' ? images.worker : images.engine;
  const id = await runtime.docker(containerArguments(names,role,imageId,receipts.scanner?.id),{ timeout:30000 });
  const receipt = resourceReceipt(id,role,names.run); receipts[role] = receipt;
  assertContainerIsolation(await runtime.inspect('container',id),receipt,imageId,{ scannerId:receipts.scanner?.id });
  return receipt;
}
async function inspectRole(role,running) {
  const receipt = receipts[role], imageId = role === 'worker' ? images.worker : images.engine;
  const state = await runtime.inspect('container',receipt.id);
  assertContainerIsolation(state,receipt,imageId,{ scannerId:receipts.scanner?.id,running });
  return state;
}
try {
  runtime = await localDockerTestRuntime();
  // Scanner 4GiB + worker 256MiB + reserve. Updater 3GiB runs before scanner.
  if (!Number.isSafeInteger(runtime.memoryBytes) || runtime.memoryBytes < 5376*1024*1024) fail('CLAMAV_CONTAINER_MEMORY');
  await runtime.officialImage(CLAMAV_TEST_IMAGE); await runtime.officialImage(NODE_TEST_IMAGE);
  await runtime.localBuilder();
  console.log(`Test resource run: ${names.run}`);
  for (const [target,tag] of [['engine',names.engineImage],['worker',names.workerImage]]) {
    await runtime.docker(['build','--builder','desktop-linux','--network=none','--pull=false','--load',
      '--target',target,'--label',`${RUN_LABEL}=${names.run}`,'--tag',tag,
      '--file',join(directory,'clamav-test.Dockerfile'),dirname(directory)],{ timeout:180000 });
    const image = await runtime.inspect('image',tag);
    if (image.Config?.Labels?.[RUN_LABEL] !== names.run || image.Os !== 'linux' || image.Architecture !== 'amd64')
      fail('CLAMAV_CONTAINER_IMAGE');
    images[target] = image.Id;
  }
  // New UUID public-signature volume only. Reject any pre-existing exact name.
  const existing = (await runtime.docker(['volume','ls','--format','{{.Name}}'])).split(/\r?\n/);
  if (existing.includes(names.volume)) fail('CLAMAV_CONTAINER_SAFETY');
  const created = await runtime.docker(['volume','create','--driver','local','--label',`${RUN_LABEL}=${names.run}`,names.volume]);
  if (created !== names.volume) fail('CLAMAV_CONTAINER_SAFETY');
  definitions = volumeReceipt(await runtime.inspect('volume',names.volume),names.run);
  const updater = await create('updater');
  console.log('PASS signature-only updater has no user mounts or published ports');
  // Only this process downloads public definitions. No scan/user bytes here.
  // CLI timeouts do NOT prove a container stopped; retain unknown resources.
  retain = true;
  const update = await runtime.command(['start','--attach',updater.id],{ timeout:600000 });
  const updated = await inspectRole('updater',false);
  if (updated.State.Status !== 'exited') fail('CLAMAV_CONTAINER_UPDATE_FAILED');
  retain = false;
  console.log(`Updater exit: ${updated.State.ExitCode}; OOM: ${Boolean(updated.State.OOMKilled)}`);
  if (update.code !== 0 || updated.State.ExitCode !== 0 || updated.State.OOMKilled) fail('CLAMAV_CONTAINER_UPDATE_FAILED');
  assertVolumeOwner(await runtime.inspect('volume',definitions.name),definitions);
  console.log('PASS official definitions updated before offline scan tests');
  const scanner = await create('scanner');
  await runtime.docker(['start',scanner.id]); await inspectRole('scanner',true);
  const worker = await create('worker');
  console.log('PASS non-root read-only offline scanner and worker with bounded resources');
  retain = true;
  const tests = await runtime.command(['start','--attach',worker.id],{ timeout:360000 });
  printResults(tests.output);
  const stopped = await inspectRole('worker',false);
  if (stopped.State.Status !== 'exited') fail('CLAMAV_CONTAINER_TEST_FAILED');
  retain = false;
  if (tests.code !== 0 || stopped.State.ExitCode !== 0 || stopped.State.OOMKilled ||
      !tests.output.includes('Native ClamAV integration: 13 scenarios passed.')) fail('CLAMAV_CONTAINER_TEST_FAILED');
  await inspectRole('scanner',true); complete = true;
} catch (error) {
  failed = true;
  const allowed = new Set(['LOCAL_DOCKER_TEST_UNAVAILABLE','CLAMAV_CONTAINER_SAFETY','CLAMAV_CONTAINER_MEMORY',
    'CLAMAV_CONTAINER_IMAGE','CLAMAV_CONTAINER_UPDATE_FAILED','CLAMAV_CONTAINER_TEST_FAILED']);
  console.error(allowed.has(error?.message) ? error.message : 'CLAMAV_CONTAINER_UNAVAILABLE');
  if (error?.message === 'CLAMAV_CONTAINER_SAFETY' && /^[A-Z_]{1,32}$/.test(error.criterion ?? ''))
    console.error(`Safety check failed: ${error.criterion}`);
} finally {
  try {
    if (retain) fail('CLAMAV_CONTAINER_RETAIN');
    // Worker first: never stop a scanner while its worker might still run.
    for (const role of ['worker','scanner','updater']) if (receipts[role]) {
      const receipt = receipts[role], imageId = role === 'worker' ? images.worker : images.engine;
      const state = await runtime.inspect('container',receipt.id); assertContainerOwner(state,receipt,imageId);
      if (state.State.Running) {
        if (role !== 'scanner') fail('CLAMAV_CONTAINER_SAFETY');
        await runtime.docker(['stop','--timeout','10',receipt.id],{ timeout:20000 });
      }
      const stopped = await runtime.inspect('container',receipt.id); assertContainerOwner(stopped,receipt,imageId);
      if (stopped.State.Running) fail('CLAMAV_CONTAINER_SAFETY');
      await runtime.docker(['rm',receipt.id]); delete receipts[role];
    }
    if (definitions) {
      assertVolumeOwner(await runtime.inspect('volume',definitions.name),definitions);
      const users = await runtime.docker(['ps','--all','--quiet','--filter',`volume=${definitions.name}`]);
      if (users) fail('CLAMAV_CONTAINER_SAFETY');
      await runtime.docker(['volume','rm',definitions.name]); definitions = undefined;
    }
    for (const [role,tag] of [['worker',names.workerImage],['engine',names.engineImage]]) if (images[role]) {
      const image = await runtime.inspect('image',tag);
      if (image.Id !== images[role] || image.Config?.Labels?.[RUN_LABEL] !== names.run) fail('CLAMAV_CONTAINER_SAFETY');
      await runtime.docker(['image','rm',tag]); delete images[role];
    }
    if (complete) console.log('PASS only owned test containers, signature volume and image tags removed');
  } catch {
    failed = true; console.error('CLAMAV_CONTAINER_CLEANUP: unknown resources retained for inspection.');
  }
  for (const receipt of Object.values(receipts)) console.error(`Retained ${receipt.role}: ${receipt.id}`);
  if (definitions) console.error(`Retained public definitions: ${definitions.name}`);
  if (failed) console.error(`Inspect test run: ${names.run}`);
  if (failed || !complete) process.exitCode = 1;
}

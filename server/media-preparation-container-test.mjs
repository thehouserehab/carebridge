// Opt-in synthetic local integration. No clinical files, public ports, app
// service, operating DB, image pull, security setting or provider deployment.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDockerTestRuntime } from './local-docker-test-runtime.mjs';
import { CLAMAV_TEST_IMAGE,RUN_LABEL as AV_LABEL,testResourceNames as avNamesFor,resourceReceipt as avReceipt,
  volumeReceipt,assertVolumeOwner,assertContainerOwner as assertAvOwner,containerArguments as avArguments,assertContainerIsolation as assertAvIsolation } from './clamav-container-policy.mjs';
import { DECODER_NODE_IMAGE,DECODER_RUN_LABEL,decoderResourceNames } from './decoder-container-policy.mjs';
import { RUN_LABEL,testResourceNames,resourceReceipt,assertContainerOwner } from './postgres-container-policy.mjs';
import { preparationControllerArguments,assertPreparationControllerIsolation } from './media-preparation-test-policy.mjs';
const directory = dirname(fileURLToPath(import.meta.url)),names = testResourceNames(randomUUID()),avNames = avNamesFor(names.run),workerNames = decoderResourceNames(randomUUID());
const images = new Map(),receipts = {},environment = {};
let runtime,engine,definitions,retain = false,complete = false,failed = false;
async function build(file,tag,label,run,target,offline = true) {
  await runtime.docker(['build','--builder','desktop-linux','--pull=false','--load',...(offline ? ['--network=none'] : []),
    '--target',target,'--label',`${label}=${run}`,'--tag',tag,'--file',join(directory,file),dirname(directory)],{ timeout:900000 });
  const image = await runtime.inspect('image',tag); assert.equal(image.Config.Labels[label],run); assert.equal(image.Os,'linux'); assert.equal(image.Architecture,'amd64');
  images.set(tag,{ id:image.Id,label,run }); return image.Id;
}
async function avCreate(role,imageId) {
  retain = true;
  const id = await runtime.docker(avArguments(avNames,role,imageId));
  const receipt = avReceipt(id,role,names.run); receipts[role] = receipt;
  assertAvIsolation(await runtime.inspect('container',id),receipt,imageId); retain = false; return receipt;
}
function print(output) {
  for (const line of output.split(/\r?\n/)) if (/^(PASS|FAIL) [a-zA-Z0-9 .-]{1,180}$/.test(line) ||
    /^MEDIA_PREPARATION_[A-Z_0-9]{1,64}$/.test(line) ||
    /^Engine: ClamAV 1\.4\.6; definitions [1-9]\d{0,9}; UTC \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(line) ||
    /^Embedded marker result: (prepared-unapproved|rejected)$/.test(line) || /^Truncated control result: (source-rejected|decode-invalid)$/.test(line) ||
    line === 'Native combined media preparation: 18 scenarios passed.') console.log(line);
}
try {
  runtime = await localDockerTestRuntime(); engine = await runtime.identity(); await runtime.localBuilder();
  assert.ok(runtime.memoryBytes >= 6*1024**3); await runtime.officialImage(CLAMAV_TEST_IMAGE); await runtime.officialImage(DECODER_NODE_IMAGE);
  console.log(`Combined preparation test run: ${names.run}`); console.log(`Owned preparation build run: ${workerNames.run}`);
  const avImage = await build('clamav-test.Dockerfile',avNames.engineImage,AV_LABEL,names.run,'engine');
  const workerImage = await build('decoder-job.Dockerfile',workerNames.image,DECODER_RUN_LABEL,workerNames.run,'worker',false);
  const controllerImage = await build('linux-decoder-test.Dockerfile',names.image,RUN_LABEL,names.run,'media-preparation');
  assert.equal((await runtime.docker(['volume','ls','--format','{{.Name}}'])).split(/\r?\n/).includes(avNames.volume),false);
  retain = true;
  assert.equal(await runtime.docker(['volume','create','--driver','local','--label',`${AV_LABEL}=${names.run}`,avNames.volume]),avNames.volume);
  definitions = volumeReceipt(await runtime.inspect('volume',avNames.volume),names.run); retain = false;
  const updater = await avCreate('updater',avImage); retain = true;
  const update = await runtime.command(['start','--attach',updater.id],{ timeout:600000 });
  const updated = await runtime.inspect('container',updater.id); assertAvIsolation(updated,updater,avImage);
  assert.equal(updated.State.Status,'exited'); retain = false; assert.equal(update.code,0); assert.equal(updated.State.ExitCode,0); assert.equal(updated.State.OOMKilled,false);
  console.log('PASS official public definitions updated without any file input');
  const scanner = await avCreate('scanner',avImage); await runtime.docker(['start',scanner.id]);
  assertAvIsolation(await runtime.inspect('container',scanner.id),scanner,avImage,{ running:true });
  environment.CAREBRIDGE_LINUX_TEST_ENGINE = engine; environment.CAREBRIDGE_LINUX_TEST_IMAGE = workerImage;
  environment.CAREBRIDGE_LINUX_TEST_DATABASE_ID = scanner.id; // reused opaque namespace variable; NO database is created
  runtime = await localDockerTestRuntime(environment); assert.equal(await runtime.identity(),engine);
  retain = true;
  const controllerId = await runtime.docker(preparationControllerArguments(names,scanner.id,controllerImage));
  receipts.controller = resourceReceipt(controllerId,names.worker,names.run);
  assertPreparationControllerIsolation(await runtime.inspect('container',controllerId),receipts.controller,controllerImage,{ scannerId:scanner.id }); retain = false;
  console.log('PASS trusted local controller separate from every untrusted offline file worker');
  retain = true;
  const result = await runtime.command(['start','--attach',controllerId],{ timeout:360000 }); print(result.output);
  const state = await runtime.inspect('container',controllerId); assertPreparationControllerIsolation(state,receipts.controller,controllerImage,{ scannerId:scanner.id });
  assert.equal(state.State.Status,'exited'); assert.equal(state.State.Running,false);
  console.log(`MEDIA_PREPARATION_CONTROLLER_EXIT_${state.State.ExitCode}`);
  console.log(`MEDIA_PREPARATION_CONTROLLER_OOM_${state.State.OOMKilled ? 'TRUE' : 'FALSE'}`);
  // A stopped controller alone is NOT proof its child namespaces stopped.
  assert.equal(await runtime.docker(['ps','--all','--filter',`ancestor=${workerImage}`,'--format','{{.ID}}']),''); retain = false;
  assert.equal(result.code,0); assert.equal(state.State.ExitCode,0); assert.equal(state.State.OOMKilled,false);
  assert.ok(result.output.includes('Native combined media preparation: 18 scenarios passed.')); complete = true;
} catch (error) {
  failed = true; console.error(error?.message === 'PREPARATION_CONTROLLER_SAFETY' ? error.message : 'MEDIA_PREPARATION_CONTAINER_TEST_FAILED');
  const line = /media-preparation-container-test\.mjs:(\d{1,4}):\d+/.exec(error?.stack ?? '')?.[1]; if (line) console.error(`MEDIA_PREPARATION_CONTAINER_ASSERTION_LINE_${line}`);
} finally {
  try {
    if (retain) throw new Error('UNCONFIRMED_TEST_STATE'); assert.equal(await runtime.identity(),engine);
    if (receipts.controller) {
      const state = await runtime.inspect('container',receipts.controller.id); assertContainerOwner(state,receipts.controller,images.get(names.image).id);
      assert.equal(state.State.Running,false); await runtime.docker(['rm',receipts.controller.id]); delete receipts.controller;
    }
    for (const role of ['scanner','updater']) if (receipts[role]) {
      const receipt = receipts[role],imageId = images.get(avNames.engineImage).id;
      let state = await runtime.inspect('container',receipt.id); assertAvOwner(state,receipt,imageId);
      if (state.State.Running) { assert.equal(role,'scanner'); await runtime.docker(['stop','--timeout','10',receipt.id],{ timeout:20000 }); }
      state = await runtime.inspect('container',receipt.id); assertAvOwner(state,receipt,imageId); assert.equal(state.State.Running,false);
      await runtime.docker(['rm',receipt.id]); delete receipts[role];
    }
    if (definitions) {
      assertVolumeOwner(await runtime.inspect('volume',definitions.name),definitions);
      assert.equal(await runtime.docker(['ps','--all','--quiet','--filter',`volume=${definitions.name}`]),'');
      await runtime.docker(['volume','rm',definitions.name]); definitions = null;
    }
    for (const [tag,{ id,label,run }] of images) {
      const image = await runtime.inspect('image',tag); assert.equal(image.Id,id); assert.equal(image.Config.Labels[label],run); assert.deepEqual(image.RepoTags,[tag]);
      assert.equal(await runtime.docker(['ps','--all','--filter',`ancestor=${id}`,'--format','{{.ID}}']),''); await runtime.docker(['image','rm',tag]); images.delete(tag);
    }
    if (complete) console.log('PASS exact owned test namespaces definition volume and image tags removed');
  } catch { failed = true; console.error(`Retained opaque combined preparation run: ${names.run} worker ${workerNames.run}`); }
  if (failed || !complete) process.exitCode = 1;
}

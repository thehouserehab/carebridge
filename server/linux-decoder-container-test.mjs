// Explicit local synthetic test. No real files, published port, operating DB,
// remote builder, image pull, engine settings or implicit service activation.
import assert from 'node:assert/strict';
import { randomUUID,randomBytes } from 'node:crypto';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDockerTestRuntime } from './local-docker-test-runtime.mjs';
import { DECODER_NODE_IMAGE,DECODER_RUN_LABEL,decoderResourceNames } from './decoder-container-policy.mjs';
import { POSTGRES_TEST_IMAGE,RUN_LABEL,testResourceNames,resourceReceipt,containerArguments,assertContainerOwner,assertContainerIsolation } from './postgres-container-policy.mjs';
import { decoderServiceTestArguments,assertDecoderServiceTestIsolation } from './decoder-service-test-policy.mjs';
const directory = dirname(fileURLToPath(import.meta.url)),names = testResourceNames(randomUUID()),workerNames = decoderResourceNames(randomUUID());
const environment = { POSTGRES_PASSWORD:randomBytes(32).toString('hex') }; environment.CAREBRIDGE_FIXTURE_PASSWORD = environment.POSTGRES_PASSWORD;
let runtime,engine,workerImageId,controllerImageId,dbImageId,database,controller,retain = false,complete = false,failed = false;
async function build(file,name,label,run,target) {
  await runtime.docker(['build','--builder','desktop-linux','--pull=false','--load',...(target ? ['--target',target] : ['--network=none']),
    '--label',`${label}=${run}`,'--tag',name,'--file',join(directory,file),dirname(directory)],{ timeout:900000 });
  const image = await runtime.inspect('image',name); assert.equal(image.Config.Labels[label],run); assert.equal(image.Os,'linux'); assert.equal(image.Architecture,'amd64'); return image.Id;
}
try {
  runtime = await localDockerTestRuntime(environment); engine = await runtime.identity(); await runtime.localBuilder();
  await runtime.officialImage(DECODER_NODE_IMAGE); dbImageId = await runtime.officialImage(POSTGRES_TEST_IMAGE);
  console.log(`Linux combined test run: ${names.run}`); console.log(`Owned decoder public build run: ${workerNames.run}`);
  workerImageId = await build('decoder-job.Dockerfile',workerNames.image,DECODER_RUN_LABEL,workerNames.run,'worker');
  controllerImageId = await build('linux-decoder-test.Dockerfile',names.image,RUN_LABEL,names.run,'controller');
  database = resourceReceipt(await runtime.docker(containerArguments(names)),names.container,names.run);
  assertContainerIsolation(await runtime.inspect('container',database.id),database,dbImageId); await runtime.docker(['start',database.id]);
  assertContainerIsolation(await runtime.inspect('container',database.id),database,dbImageId,{ running:true });
  environment.CAREBRIDGE_LINUX_TEST_ENGINE = engine; environment.CAREBRIDGE_LINUX_TEST_IMAGE = workerImageId; environment.CAREBRIDGE_LINUX_TEST_DATABASE_ID = database.id;
  // The original runtime captured environment values before resource IDs were
  // known. Refresh only the trusted controller's explicit synthetic variables.
  runtime = await localDockerTestRuntime(environment); assert.equal(await runtime.identity(),engine);
  controller = resourceReceipt(await runtime.docker(decoderServiceTestArguments(names,database.id,controllerImageId)),names.worker,names.run);
  assertDecoderServiceTestIsolation(await runtime.inspect('container',controller.id),controller,controllerImageId,{ databaseId:database.id });
  console.log('PASS trusted controller socket profile separate from offline per-file workers');
  retain = true;
  const result = await runtime.command(['start','--attach',controller.id],{ timeout:480000 });
  for (const line of result.output.split(/\r?\n/)) if (/^(PASS|FAIL|WAIT) [a-zA-Z0-9 ,.-]{1,180}$/.test(line) ||
    /^Native Linux decoder with journal: 8 scenarios passed\.$/.test(line) || /^LINUX_DECODER_[A-Z_0-9]{1,64}$/.test(line)) console.log(line);
  const state = await runtime.inspect('container',controller.id);
  assertDecoderServiceTestIsolation(state,controller,controllerImageId,{ databaseId:database.id });
  if (result.code !== 0 || state.State.Status !== 'exited' || state.State.ExitCode !== 0 || state.State.OOMKilled ||
      !result.output.includes('Native Linux decoder with journal: 8 scenarios passed.') ||
      !result.output.includes('PASS temporary combined-test database removed')) throw new Error('LINUX_DECODER_TEST_FAILED');
  // No active job may remain for this exact immutable test image.
  assert.equal(await runtime.docker(['ps','--all','--filter',`ancestor=${workerImageId}`,'--format','{{.ID}}']),'');
  retain = false; complete = true;
} catch (error) {
  failed = true; console.error(error?.message === 'DECODER_SERVICE_TEST_SAFETY' ? error.message : 'LINUX_DECODER_CONTAINER_TEST_FAILED');
} finally {
  try {
    if (retain) throw new Error('RETAIN');
    assert.equal(await runtime.identity(),engine);
    if (controller) {
      const state = await runtime.inspect('container',controller.id); assertContainerOwner(state,controller,controllerImageId);
      assert.equal(state.State.Running,false); await runtime.docker(['rm',controller.id]); controller = null;
    }
    if (database) {
      const state = await runtime.inspect('container',database.id); assertContainerOwner(state,database,dbImageId);
      if (state.State.Running) await runtime.docker(['stop','--timeout','10',database.id],{ timeout:20000 });
      const final = await runtime.inspect('container',database.id); assertContainerOwner(final,database,dbImageId); assert.equal(final.State.Running,false);
      await runtime.docker(['rm',database.id]); database = null;
    }
    for (const [name,id,label,run] of [[names.image,controllerImageId,RUN_LABEL,names.run],[workerNames.image,workerImageId,DECODER_RUN_LABEL,workerNames.run]]) {
      if (!id) continue; const image = await runtime.inspect('image',name); assert.equal(image.Id,id); assert.equal(image.Config.Labels[label],run);
      assert.deepEqual(image.RepoTags,[name]); assert.equal(await runtime.docker(['ps','--all','--filter',`ancestor=${id}`,'--format','{{.ID}}']),'');
      await runtime.docker(['image','rm',name]);
    }
    if (complete) console.log('PASS exact owned combined-test containers and images removed');
  } catch { failed = true; console.error(`Retained opaque test run: ${names.run} decoder ${workerNames.run}`); }
  if (failed || !complete) process.exitCode = 1;
}

// Explicit offline synthetic test, no clinical files/API/operating activation.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDockerTestRuntime } from './local-docker-test-runtime.mjs';
import { DECODER_NODE_IMAGE,DECODER_RUN_LABEL,decoderResourceNames,decoderReceipt,decoderContainerArguments,
  assertDecoderOwner,assertDecoderIsolation } from './decoder-container-policy.mjs';
const names = decoderResourceNames(randomUUID()),directory = dirname(fileURLToPath(import.meta.url));
let runtime,engine,imageId,receipt,retain = false,complete = false,failed = false;
try {
  runtime = await localDockerTestRuntime(); engine = await runtime.identity(); await runtime.officialImage(DECODER_NODE_IMAGE); await runtime.localBuilder();
  assert.ok(runtime.memoryBytes >= 2048*1024*1024);
  assert.equal((await runtime.docker(['ps','--all','--filter',`name=^/${names.worker}$`,'--format','{{.ID}}'])).trim(),'');
  assert.equal((await runtime.docker(['image','ls','--format','{{.Repository}}:{{.Tag}}'])).split(/\r?\n/).includes(names.image),false);
  console.log(`Image metadata test run: ${names.run}`);
  await runtime.docker(['build','--builder','desktop-linux','--pull=false','--load','--target','image-metadata',
    '--label',`${DECODER_RUN_LABEL}=${names.run}`,'--tag',names.image,'--file',join(directory,'decoder-test.Dockerfile'),dirname(directory)],{ timeout:900000 });
  const image = await runtime.inspect('image',names.image); assert.equal(image.Config?.Labels?.[DECODER_RUN_LABEL],names.run);
  assert.equal(image.Os,'linux'); assert.equal(image.Architecture,'amd64'); assert.equal(image.Config.User,'node'); imageId = image.Id;
  // A lost create acknowledgement is not proof of absence. Retain the run
  // and image for operator inspection rather than deleting an unknown job.
  retain = true;
  const id = await runtime.docker(decoderContainerArguments(names,imageId),{ timeout:30000 }); receipt = decoderReceipt(id,names.run);
  assertDecoderIsolation(await runtime.inspect('container',id),receipt,imageId); retain = true;
  console.log('PASS offline non-root read-only image test with no host files or ports');
  const tested = await runtime.command(['start','--attach',id],{ timeout:360000 });
  for (const line of tested.output.split(/\r?\n/)) if (/^(PASS|FAIL) [a-zA-Z0-9 .-]{1,140}$/.test(line) || /^IMAGE_NATIVE_[A-Z_0-9]{1,80}$/.test(line) || /^Native image metadata: \d{1,3} scenarios passed\.$/.test(line)) console.log(line);
  assert.equal(await runtime.identity(),engine); const state = await runtime.inspect('container',id); assertDecoderIsolation(state,receipt,imageId);
  assert.equal(state.State.Status,'exited'); retain = false;
  assert.equal(tested.code,0); assert.equal(state.State.ExitCode,0); assert.equal(state.State.OOMKilled,false);
  assert.ok(tested.output.includes('Native image metadata: 27 scenarios passed.')); complete = true;
} catch { failed = true; console.error('IMAGE_METADATA_CONTAINER_FAILED'); }
finally {
  try {
    assert.equal(retain,false); if (runtime) assert.equal(await runtime.identity(),engine);
    if (receipt) { const state = await runtime.inspect('container',receipt.id); assertDecoderOwner(state,receipt,imageId); assert.equal(state.State.Running,false); await runtime.docker(['rm',receipt.id]); receipt = undefined; }
    if (imageId) {
      const image = await runtime.inspect('image',names.image); assert.equal(image.Id,imageId); assert.equal(image.Config?.Labels?.[DECODER_RUN_LABEL],names.run); assert.deepEqual(image.RepoTags,[names.image]);
      assert.equal((await runtime.docker(['ps','--all','--filter',`ancestor=${imageId}`,'--format','{{.ID}}'])).trim(),''); await runtime.docker(['image','rm',names.image]); imageId = undefined;
    }
    if (complete && !failed) console.log('PASS exact owned image metadata test container and image removed');
  } catch { failed = true; console.error('IMAGE_METADATA_RESOURCES_RETAINED'); }
  if (receipt) console.error(`Retained image metadata worker: ${receipt.id}`);
  if (imageId) console.error(`Retained image metadata image: ${names.image}`);
  if (failed) console.error(`Inspect image metadata test run: ${names.run}`);
  if (failed || !complete) process.exitCode = 1;
}

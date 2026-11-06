import { randomUUID } from 'node:crypto';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDockerTestRuntime } from './local-docker-test-runtime.mjs';
import { DECODER_NODE_IMAGE,DECODER_RUN_LABEL,decoderResourceNames,decoderReceipt,
  decoderContainerArguments,assertDecoderOwner,assertDecoderIsolation } from './decoder-container-policy.mjs';
const names = decoderResourceNames(randomUUID()), directory = dirname(fileURLToPath(import.meta.url));
let runtime,imageId,receipt,retain = false,complete = false,failed = false;
const fail = (code) => { throw new Error(code); };
try {
  runtime = await localDockerTestRuntime(); await runtime.officialImage(DECODER_NODE_IMAGE); await runtime.localBuilder();
  if (!Number.isSafeInteger(runtime.memoryBytes) || runtime.memoryBytes < 2048*1024*1024) fail('DECODER_CONTAINER_MEMORY');
  if ((await runtime.docker(['image','ls','--format','{{.Repository}}:{{.Tag}}'])).split(/\r?\n/).includes(names.image)) fail('DECODER_CONTAINER_SAFETY');
  console.log(`Test resource run: ${names.run}`);
  // Public signed source/signed Alpine build dependencies only. Building can
  // access public repositories; the subsequent decoding container cannot.
  await runtime.docker(['build','--builder','desktop-linux','--pull=false','--load','--target','worker',
    '--label',`${DECODER_RUN_LABEL}=${names.run}`,'--tag',names.image,'--file',join(directory,'decoder-test.Dockerfile'),dirname(directory)],{ timeout:900000 });
  const image = await runtime.inspect('image',names.image);
  if (image.Config?.Labels?.[DECODER_RUN_LABEL] !== names.run || image.Os !== 'linux' || image.Architecture !== 'amd64') fail('DECODER_CONTAINER_IMAGE');
  imageId = image.Id;
  const id = await runtime.docker(decoderContainerArguments(names,imageId),{ timeout:30000 });
  receipt = decoderReceipt(id,names.run); assertDecoderIsolation(await runtime.inspect('container',id),receipt,imageId);
  console.log('PASS offline non-root read-only decoder with no host folders or ports');
  retain = true;
  const tests = await runtime.command(['start','--attach',id],{ timeout:360000 });
  for (const line of tests.output.split(/\r?\n/)) if (/^(PASS|FAIL) [a-zA-Z0-9 .-]{1,140}$/.test(line) ||
      /^DECODER_NATIVE_[A-Z_]+$/.test(line) || /^Native decoder integration: \d{1,3} scenarios passed\.$/.test(line) ||
      /^DECODER_NATIVE_ASSERTION_LINE_\d{1,4}$/.test(line) ||
      /^Engine: FFmpeg 9\.0\.2; video frames \d+; audio frames \d+$/.test(line)) console.log(line);
  const state = await runtime.inspect('container',id); assertDecoderIsolation(state,receipt,imageId);
  if (state.State.Status !== 'exited') fail('DECODER_CONTAINER_TEST_FAILED');
  retain = false;
  if (tests.code !== 0 || state.State.ExitCode !== 0 || state.State.OOMKilled ||
      !tests.output.includes('Native decoder integration: 38 scenarios passed.')) fail('DECODER_CONTAINER_TEST_FAILED');
  complete = true;
} catch (error) {
  failed = true;
  const allowed = new Set(['LOCAL_DOCKER_TEST_UNAVAILABLE','DECODER_CONTAINER_MEMORY','DECODER_CONTAINER_SAFETY','DECODER_CONTAINER_IMAGE','DECODER_CONTAINER_TEST_FAILED']);
  console.error(allowed.has(error?.message) ? error.message : 'DECODER_CONTAINER_UNAVAILABLE');
  if (error?.message === 'DECODER_CONTAINER_SAFETY' && /^[A-Z_]{1,32}$/.test(error.criterion ?? '')) console.error(`Safety check failed: ${error.criterion}`);
} finally {
  try {
    if (retain) fail('DECODER_CONTAINER_RETAIN');
    if (receipt) {
      const state = await runtime.inspect('container',receipt.id); assertDecoderOwner(state,receipt,imageId);
      if (state.State.Running) fail('DECODER_CONTAINER_SAFETY');
      await runtime.docker(['rm',receipt.id]); receipt = undefined;
    }
    if (imageId) {
      const image = await runtime.inspect('image',names.image);
      if (image.Id !== imageId || image.Config?.Labels?.[DECODER_RUN_LABEL] !== names.run) fail('DECODER_CONTAINER_SAFETY');
      await runtime.docker(['image','rm',names.image]); imageId = undefined;
    }
    if (complete) console.log('PASS only owned decoder test container and image tag removed');
  } catch { failed = true; console.error('DECODER_CONTAINER_CLEANUP: unknown resources retained for inspection.'); }
  if (receipt) console.error(`Retained decoder worker: ${receipt.id}`);
  if (imageId) console.error(`Retained decoder image: ${names.image}`);
  if (failed) console.error(`Inspect test run: ${names.run}`);
  if (failed || !complete) process.exitCode = 1;
}

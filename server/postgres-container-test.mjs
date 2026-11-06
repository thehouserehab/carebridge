import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localDockerTestConfiguration } from './local-docker-test-environment.mjs';
import { POSTGRES_TEST_IMAGE, NODE_TEST_IMAGE, RUN_LABEL, testResourceNames, resourceReceipt,
  containerArguments, workerArguments, assertContainerOwner, assertContainerIsolation } from './postgres-container-policy.mjs';

// Explicit local Docker command only: no API, .env, remote builder/context,
// auto-pull/install/login/terms or adoption of an existing container/database.
const names = testResourceNames(randomUUID());
const recovery = process.argv.length === 3 && process.argv[2] === '--recovery';
const milestone = recovery ? 'Native recovery integration: 14 scenarios passed.' : 'Native PostgreSQL integration: 61 scenarios passed.';
const directory = dirname(fileURLToPath(import.meta.url));
const password = randomBytes(32).toString('hex');
let cli, configuration, pgImageId, workerImageId, database, worker, failed = false, complete = false, retain = false;
const fail = (code) => { throw new Error(code); };

async function command(args,{ timeout = 15000 } = {}) {
  const environment = configuration.environmentFor(args);
  return new Promise((resolve,reject) => {
    const child = spawn(cli,['--context','desktop-linux',...args],{
      env:environment,shell:false,stdio:['ignore','pipe','pipe'],windowsHide:true,
    });
    let output = '', bytes = 0, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); },timeout);
    child.stdout.on('data',(data) => {
      bytes += data.length;
      if (bytes > 1024*1024) { timedOut = true; child.kill(); }
      else output += data.toString('utf8');
    });
    // CLI/driver error text may contain credentials; never forward it.
    child.stderr.resume();
    child.on('error',() => { clearTimeout(timer); reject(new Error('POSTGRES_CONTAINER_COMMAND')); });
    child.on('close',(code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('POSTGRES_CONTAINER_COMMAND'));
      else resolve({ code,output:output.trim() });
    });
  });
}
async function docker(args,options) {
  const result = await command(args,options);
  if (result.code !== 0) fail('POSTGRES_CONTAINER_COMMAND');
  return result.output;
}
async function inspect(kind,id) {
  const objects = JSON.parse(await docker([kind,'inspect',id]));
  if (!Array.isArray(objects) || objects.length !== 1) fail('POSTGRES_CONTAINER_SAFETY');
  return objects[0]; // Never print Config.Env or complete inspection output.
}
async function officialImage(reference) {
  const image = await inspect('image',reference);
  if (image.Os !== 'linux' || image.Architecture !== 'amd64' ||
      !image.RepoDigests?.includes(reference.replace('docker.io/library/',''))) fail('POSTGRES_CONTAINER_IMAGE');
  return image.Id;
}
function printResults(output) {
  for (const line of output.split(/\r?\n/)) {
    if (/^(PASS|FAIL) [a-zA-Z0-9 ',.-]{1,160}$/.test(line) ||
        /^RECOVERY_NATIVE_[A-Z0-9_]{1,40}$/.test(line) ||
        /^POSTGRES_TEST_[A-Z_]{1,64}$/.test(line) ||
        /^Disconnect diagnostic: [A-Z0-9_]{1,40}$/.test(line) ||
        /^Disposable test target: carebridge_it_[a-f0-9]{32}$/.test(line) ||
        line === milestone ||
        /^Native server: PostgreSQL 18\.6; Node v24\.15\.0$/.test(line)) console.log(line);
  }
}

try {
  if (process.argv.length > 2 && !recovery) fail('POSTGRES_CONTAINER_SAFETY');
  if (process.platform !== 'win32') fail('POSTGRES_CONTAINER_LOCAL_RUNTIME');
  configuration = localDockerTestConfiguration(process.env,{POSTGRES_PASSWORD:password,CAREBRIDGE_FIXTURE_PASSWORD:password});
  cli = configuration.cli;
  await access(cli);
  const context = JSON.parse(await docker(['context','inspect','desktop-linux']));
  if (context.length !== 1 || context[0].Endpoints?.docker?.Host !== 'npipe:////./pipe/dockerDesktopLinuxEngine')
    fail('POSTGRES_CONTAINER_LOCAL_RUNTIME');
  const info = JSON.parse(await docker(['info','--format','{{json .}}']));
  if (info.OSType !== 'linux' || info.Architecture !== 'x86_64') fail('POSTGRES_CONTAINER_LOCAL_RUNTIME');
  pgImageId = await officialImage(POSTGRES_TEST_IMAGE);
  await officialImage(NODE_TEST_IMAGE);
  // Do not let a selected cloud/remote builder receive the allowlisted source.
  const builders = (await docker(['buildx','ls','--timeout','5s','--format','{{json .}}']))
    .split(/\r?\n/).map((line) => JSON.parse(line)).filter((builder) => builder.Name === 'desktop-linux');
  if (!builders.length || builders.some((builder) => builder.Driver !== 'docker' ||
      builder.Nodes?.length !== 1 || builder.Nodes[0].Endpoint !== 'desktop-linux'))
    fail('POSTGRES_CONTAINER_LOCAL_RUNTIME');
  console.log(`Test resource run: ${names.run}`);
  await docker(['build','--builder','desktop-linux','--network=none','--pull=false','--load',
    '--label',`${RUN_LABEL}=${names.run}`,'--tag',names.image,
    '--file',join(directory,recovery ? 'recovery-test.Dockerfile' : 'postgres-test.Dockerfile'),dirname(directory)],{ timeout:120000 });
  const built = await inspect('image',names.image);
  if (built.Config?.Labels?.[RUN_LABEL] !== names.run || built.Os !== 'linux' || built.Architecture !== 'amd64')
    fail('POSTGRES_CONTAINER_IMAGE');
  workerImageId = built.Id;
  if (Object.keys(built.Config?.Volumes ?? {}).length) fail('POSTGRES_CONTAINER_SAFETY');
  database = resourceReceipt(await docker(containerArguments(names),{ timeout:30000 }),names.container,names.run);
  assertContainerIsolation(await inspect('container',database.id),database,pgImageId);
  await docker(['start',database.id]);
  assertContainerIsolation(await inspect('container',database.id),database,pgImageId,{ running:true });
  const suite = recovery ? 'recovery' : 'postgres';
  const argumentsForWorker = workerArguments(names,database.id,workerImageId,{ suite });
  worker = resourceReceipt(await docker(argumentsForWorker,{ timeout:30000 }),names.worker,names.run);
  assertContainerIsolation(await inspect('container',worker.id),worker,workerImageId,{ databaseId:database.id,suite });
  console.log('PASS isolated non-root read-only containers, no host ports or external network, bounded resources');
  // Killing an attached CLI does not prove the worker stopped. Unknown outcomes
  // retain both resources; never stop a DB while a worker may still be running.
  retain = true;
  const result = await command(['start','--attach',worker.id],{ timeout:180000 });
  printResults(result.output);
  const stopped = await inspect('container',worker.id);
  assertContainerOwner(stopped,worker,workerImageId);
  if (stopped.State.Running || stopped.State.Status !== 'exited') fail('POSTGRES_CONTAINER_INTEGRATION_FAILED');
  if (result.code !== 0 || stopped.State.ExitCode !== 0 ||
      !result.output.includes(milestone) ||
      !result.output.includes('PASS temporary test database removed, no disposable database remains'))
    fail('POSTGRES_CONTAINER_INTEGRATION_FAILED');
  retain = false; complete = true;
} catch (error) {
  failed = true;
  const allowed = new Set(['POSTGRES_CONTAINER_COMMAND','POSTGRES_CONTAINER_SAFETY','POSTGRES_CONTAINER_LOCAL_RUNTIME',
    'POSTGRES_CONTAINER_IMAGE','POSTGRES_CONTAINER_INTEGRATION_FAILED']);
  console.error(allowed.has(error?.message) ? error.message : 'POSTGRES_CONTAINER_UNAVAILABLE');
  if (error?.message === 'POSTGRES_CONTAINER_SAFETY' && /^[A-Z_]{1,40}$/.test(error.criterion ?? ''))
    console.error(`Safety check failed: ${error.criterion}`);
} finally {
  try {
    if (retain) fail('POSTGRES_CONTAINER_INTEGRATION_FAILED'); // Preserve failed/unknown DB cleanup.
    if (worker) {
      const state = await inspect('container',worker.id); assertContainerOwner(state,worker,workerImageId);
      if (state.State.Running) fail('POSTGRES_CONTAINER_SAFETY');
      await docker(['rm',worker.id]); worker = undefined;
    }
    if (database) {
      const state = await inspect('container',database.id); assertContainerOwner(state,database,pgImageId);
      if (state.State.Running) await docker(['stop','--timeout','10',database.id],{ timeout:20000 });
      const stopped = await inspect('container',database.id); assertContainerOwner(stopped,database,pgImageId);
      if (stopped.State.Running) fail('POSTGRES_CONTAINER_SAFETY');
      await docker(['rm',database.id]); database = undefined;
    }
    if (workerImageId) {
      const image = await inspect('image',names.image);
      if (image.Id !== workerImageId || image.Config?.Labels?.[RUN_LABEL] !== names.run) fail('POSTGRES_CONTAINER_SAFETY');
      await docker(['image','rm',names.image]); workerImageId = undefined; // Exact owned tag only; no force/prune.
    }
    if (complete) console.log('PASS only this run\'s temporary containers and worker image removed');
  } catch {
    failed = true; console.error('POSTGRES_CONTAINER_CLEANUP: test resources retained for inspection.');
  }
  if (database) console.error(`Retained test database container: ${database.id}`);
  if (worker) console.error(`Retained test worker: ${worker.id}`);
  if (failed) console.error(`Inspect test resources: ${names.container}, ${names.worker}, ${names.image}`);
  if (failed || !complete) process.exitCode = 1;
  try {
    const resultDirectory = join(dirname(directory),'test-results');
    await mkdir(resultDirectory,{ recursive:true });
    const resultName = recovery ? 'recovery-results.json' : `postgres-${names.run}-results.json`;
    await writeFile(join(resultDirectory,resultName),JSON.stringify({
      runId:names.run,completedAt:new Date().toISOString(),passed:complete && !failed,
      scenarioCount:complete && !failed ? (recovery ? 14 : 61) : 0,
      suite:recovery ? 'synthetic-quiesced-native-pg18.6' : 'synthetic-isolated-native-pg18.6',
      limitations:recovery
        ? ['no operating cutover','no live-writer backup','no separate-cluster role recovery','no persistent-media or key-custody approval']
        : ['synthetic internal services only','no operating accounts or HTTP flow','no independent backup or physical-device approval'],
    },null,2)+'\n');
  } catch { process.exitCode = 1; console.error(recovery ? 'RECOVERY_NATIVE_REPORT_FAILED' : 'POSTGRES_NATIVE_REPORT_FAILED'); }
}

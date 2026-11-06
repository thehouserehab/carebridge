import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { decoderCliTransport } from './decoder-cli-transport.mjs';
import { localDockerTestConfiguration } from './local-docker-test-environment.mjs';

// Shared explicit local test tooling. Never import into an API/application.
const fail = () => { throw new Error('LOCAL_DOCKER_TEST_UNAVAILABLE'); };
export async function localDockerTestRuntime(fixtureEnvironment = {}) {
  if (process.platform !== 'win32') fail();
  const configuration = localDockerTestConfiguration(process.env,fixtureEnvironment);
  const {cli} = configuration;
  await access(cli);
  async function command(args,{ timeout = 15000 } = {}) {
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 900000) fail();
    const environment = configuration.environmentFor(args);
    return new Promise((resolve,reject) => {
      // Buildx requires the builder's named context. This exception handles
      // only the allowlisted public-source builds, never a media payload.
      const endpoint = args[0] === 'build' ? ['--context','desktop-linux'] : ['--host','npipe:////./pipe/dockerDesktopLinuxEngine'];
      const child = spawn(cli,[...endpoint,...args],{
        env:environment,shell:false,stdio:['ignore','pipe','pipe'],windowsHide:true,
      });
      let output = '', bytes = 0, terminated = false;
      const timer = setTimeout(() => { terminated = true; child.kill(); },timeout);
      child.stdout.on('data',(data) => {
        bytes += data.length;
        if (bytes > 1024*1024) { terminated = true; child.kill(); }
        else output += data.toString('utf8');
      });
      // No credentials, filenames, detection details or raw driver errors.
      child.stderr.resume();
      child.once('error',() => { clearTimeout(timer); reject(new Error('LOCAL_DOCKER_TEST_UNAVAILABLE')); });
      child.once('close',(code) => {
        clearTimeout(timer);
        if (terminated) reject(new Error('LOCAL_DOCKER_TEST_UNAVAILABLE'));
        else resolve({ code,output:output.trim() });
      });
    });
  }
  async function docker(args,options) {
    if (args[0] === 'build') {
      const checked = JSON.parse(await docker(['context','inspect','desktop-linux']));
      if (checked.length !== 1 || checked[0].Endpoints?.docker?.Host !== 'npipe:////./pipe/dockerDesktopLinuxEngine' ||
          !args.includes('--builder') || args[args.indexOf('--builder')+1] !== 'desktop-linux') fail();
    }
    const result = await command(args,options); if (result.code !== 0) fail(); return result.output;
  }
  async function inspect(kind,id) {
    const objects = JSON.parse(await docker([kind,'inspect',id]));
    if (!Array.isArray(objects) || objects.length !== 1) fail(); return objects[0];
  }
  const contexts = JSON.parse(await docker(['context','inspect','desktop-linux']));
  if (contexts.length !== 1 || contexts[0].Endpoints?.docker?.Host !== 'npipe:////./pipe/dockerDesktopLinuxEngine') fail();
  const info = JSON.parse(await docker(['info','--format','{{json .}}']));
  if (info.OSType !== 'linux' || info.Architecture !== 'x86_64') fail();
  async function officialImage(reference) {
    if (!/^docker\.io\/[a-z0-9/-]+@sha256:[a-f0-9]{64}$/.test(reference)) fail();
    const image = await inspect('image',reference);
    const canonical = reference.replace(/^docker\.io\/(?:library\/)?/,'');
    if (image.Os !== 'linux' || image.Architecture !== 'amd64' || !image.RepoDigests?.includes(canonical)) fail();
    return image.Id;
  }
  async function localBuilder() {
    const builders = (await docker(['buildx','ls','--timeout','5s','--format','{{json .}}']))
      .split(/\r?\n/).map((line) => JSON.parse(line)).filter((builder) => builder.Name === 'desktop-linux');
    if (!builders.length || builders.some((builder) => builder.Driver !== 'docker' ||
        builder.Nodes?.length !== 1 || builder.Nodes[0].Endpoint !== 'desktop-linux')) fail();
  }
  async function identity() {
    const value = JSON.parse(await docker(['info','--format','{{json .}}']));
    if (value.OSType !== 'linux' || value.Architecture !== 'x86_64' || !/^[a-zA-Z0-9:_-]{12,80}$/.test(value.ID ?? '')) fail();
    return value.ID;
  }
  async function exchange(id,packet,{ signal,outputLimit,onFailure } = {}) {
    if (!/^[a-f0-9]{64}$/.test(id)) fail();
    // Killing this CLI only ends observation. The coordinator must inspect,
    // stop and remove its exact engine-owned container separately.
    // Exercise the production pipe primitive, including binary framing and
    // input/output bounds. Only the explicit Windows test launch differs.
    const transport = decoderCliTransport(async (args) => ({ file:cli,
      args:['--host','npipe:////./pipe/dockerDesktopLinuxEngine',...args],environment:configuration.environmentFor(args) }));
    return transport.exchange(['start','--attach','--interactive',id],packet,{ signal,outputLimit,onFailure });
  }
  return Object.freeze({ command,docker,inspect,officialImage,localBuilder,identity,exchange,memoryBytes:info.MemTotal });
}

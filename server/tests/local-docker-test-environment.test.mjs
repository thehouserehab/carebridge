import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { localDockerTestConfiguration } from '../local-docker-test-environment.mjs';
import { containerArguments,workerArguments,testResourceNames } from '../postgres-container-policy.mjs';
import { decoderServiceTestArguments } from '../decoder-service-test-policy.mjs';
import { decoderContainerArguments,decoderResourceNames } from '../decoder-container-policy.mjs';
import { containerArguments as avArguments,testResourceNames as avNamesFor } from '../clamav-container-policy.mjs';

const source = () => ({SystemRoot:'C:\\Windows',LocalAppData:'C:\\Users\\Synthetic\\AppData\\Local',
  USERPROFILE:'C:\\Users\\Synthetic',APPDATA:'C:\\Users\\Synthetic\\AppData\\Roaming',TEMP:'C:\\Temp',TMP:'C:\\Temp'});
const password = 'a'.repeat(64),image = 'sha256:'+'b'.repeat(64),id = 'c'.repeat(64);
const fixtures = () => ({POSTGRES_PASSWORD:password,CAREBRIDGE_FIXTURE_PASSWORD:password,
  CAREBRIDGE_LINUX_TEST_ENGINE:'synthetic-local-engine-0001',CAREBRIDGE_LINUX_TEST_IMAGE:image,CAREBRIDGE_LINUX_TEST_DATABASE_ID:id});
const names = testResourceNames('12345678-1234-4234-8234-123456789abc');
const denied = (error) => error.message === 'LOCAL_DOCKER_TEST_UNAVAILABLE' && error.cause === undefined;
const fixtureKeys = (environment) => Object.keys(environment).filter((key) => Object.hasOwn(fixtures(),key)).sort();

test('Docker test launches use fixed OS directories and a rebuilt PATH, not the parent environment',() => {
  const configuration = localDockerTestConfiguration({...source(),
    Path:'C:\\Untrusted',WINDIR:'C:\\Untrusted',NODE_OPTIONS:'--import synthetic-private-hook',
    DOCKER_HOST:'tcp://synthetic.invalid:2375',DOCKER_CONTEXT:'synthetic-remote',DOCKER_CONFIG:'C:\\Untrusted',
    DOCKER_TLS_VERIFY:'1',DOCKER_API_VERSION:'0.0',DOCKER_CUSTOM_HEADERS:'synthetic-private-header',
    BUILDX_BUILDER:'synthetic-remote',BUILDX_CONFIG:'C:\\Untrusted',BUILDKIT_HOST:'tcp://synthetic.invalid',
    HTTP_PROXY:'synthetic-private-proxy',HTTPS_PROXY:'synthetic-private-proxy',ALL_PROXY:'synthetic-private-proxy',
    DATABASE_URL:'synthetic-private-url',PGPASSWORD:'synthetic-private-password',AWS_SECRET_ACCESS_KEY:'synthetic-private-key',
    VERCEL_TOKEN:'synthetic-private-token',PSModulePath:'C:\\Untrusted',COMSPEC:'C:\\Untrusted\\cmd.exe',custom:'not-carried'});
  assert.equal(configuration.cli,'C:\\Users\\Synthetic\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin\\docker.exe');
  assert.deepEqual(configuration.environmentFor(['info']),{
    SYSTEMROOT:'C:\\Windows',TEMP:'C:\\Temp',TMP:'C:\\Temp',USERPROFILE:'C:\\Users\\Synthetic',
    APPDATA:'C:\\Users\\Synthetic\\AppData\\Roaming',LOCALAPPDATA:'C:\\Users\\Synthetic\\AppData\\Local',WINDIR:'C:\\Windows',
    PATH:'C:\\Users\\Synthetic\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin;C:\\Windows\\System32;C:\\Windows',TZ:'UTC',LANG:'C',
  });
  assert.ok(Object.isFrozen(configuration));assert.ok(Object.isFrozen(configuration.environmentFor(['info'])));
});

test('case-insensitive ambiguity, accessors, missing native paths and nonlocal paths fail without IO',() => {
  let accessed = false;
  const accessor = {...source()};Object.defineProperty(accessor,'SYSTEMROOT',{get(){accessed=true;throw new Error('synthetic-private');},enumerable:true});
  for (const value of [null,[],{}, {...source(),SYSTEMROOT:'C:\\Other'},accessor,
    {...source(),SystemRoot:'Windows'}, {...source(),LocalAppData:'\\\\remote\\share'},
    {...source(),TEMP:'C:\\Temp\n'}, {...source(),TMP:'C:\\Temp\\..\\Other'},
    {...source(),APPDATA:'C:\\Temp:stream'}]) assert.throws(() => localDockerTestConfiguration(value),denied);
  assert.equal(accessed,false);
});

test('explicit fixture schema rejects overrides, unknown names, coercion and secret-shaped invalid values',() => {
  let accessed=false;const accessor={};Object.defineProperty(accessor,'POSTGRES_PASSWORD',{get(){accessed=true;return password;},enumerable:true});
  for (const extra of [null,[],new Date(),{PATH:'C:\\Other'},{DOCKER_HOST:'remote'},{postgres_password:password},
    {POSTGRES_PASSWORD:'synthetic-private-password'}, {CAREBRIDGE_LINUX_TEST_ENGINE:'short'},
    {CAREBRIDGE_LINUX_TEST_IMAGE:'latest'}, {CAREBRIDGE_LINUX_TEST_DATABASE_ID:id.slice(0,12)},
    {POSTGRES_PASSWORD:{toString(){assert.fail('No coercion');}}},accessor,{[Symbol('private')]:password}])
    assert.throws(() => localDockerTestConfiguration(source(),extra),denied);
  assert.equal(accessed,false);
});

test('configuration captures values once and does not expose fixtures in serialized metadata',() => {
  const parent=source(),extra=fixtures(),configuration=localDockerTestConfiguration(parent,extra);
  parent.SystemRoot='C:\\Changed';extra.POSTGRES_PASSWORD='d'.repeat(64);extra.PATH='C:\\Changed';
  const environment=configuration.environmentFor(['create','--env','POSTGRES_PASSWORD',image]);
  assert.equal(environment.SYSTEMROOT,'C:\\Windows');assert.equal(environment.POSTGRES_PASSWORD,password);
  assert.equal(JSON.stringify(configuration).includes(password),false);assert.ok(Object.isFrozen(environment));
});

test('build, preflight, inspect, attach, binary exchange and cleanup receive no fixture variables',() => {
  const configuration=localDockerTestConfiguration(source(),fixtures());
  for(const args of [['build','--builder','desktop-linux','.'],['context','inspect','desktop-linux'],
    ['info','--format','{{json .}}'],['buildx','ls'],['image','inspect',image],['container','inspect',id],
    ['start','--attach',id],['start','--attach','--interactive',id],['kill','--signal','KILL',id],['rm',id],['volume','rm','synthetic']])
    assert.deepEqual(fixtureKeys(configuration.environmentFor(args)),[]);
});

test('valid-looking fixture names in the ambient environment are not adopted as explicit synthetic inputs',() => {
  const configuration=localDockerTestConfiguration({...source(),...fixtures()});
  assert.deepEqual(fixtureKeys(configuration.environmentFor(['info'])),[]);
  for(const name of Object.keys(fixtures()))
    assert.throws(() => configuration.environmentFor(['create','--env',name,image]),denied);
});

test('database create imports only its generated password and never the controller password or IDs',() => {
  const configuration=localDockerTestConfiguration(source(),fixtures());
  assert.deepEqual(fixtureKeys(configuration.environmentFor(containerArguments(names))),['POSTGRES_PASSWORD']);
  assert.equal(configuration.environmentFor(containerArguments(names)).POSTGRES_PASSWORD,password);
});

test('database worker create imports only its generated connection password',() => {
  const configuration=localDockerTestConfiguration(source(),fixtures());
  for (const suite of ['postgres','recovery'])
    assert.deepEqual(fixtureKeys(configuration.environmentFor(workerArguments(names,id,image,{suite}))),['CAREBRIDGE_FIXTURE_PASSWORD']);
});

test('trusted combined controller imports only its explicitly named synthetic connection and engine inputs',() => {
  const configuration=localDockerTestConfiguration(source(),fixtures());
  assert.deepEqual(fixtureKeys(configuration.environmentFor(decoderServiceTestArguments(names,id,image))),[
    'CAREBRIDGE_FIXTURE_PASSWORD','CAREBRIDGE_LINUX_TEST_DATABASE_ID','CAREBRIDGE_LINUX_TEST_ENGINE','CAREBRIDGE_LINUX_TEST_IMAGE',
  ]);
});

test('offline file worker and definitions updater/scanner receive none of the DB fixture environment',() => {
  const configuration=localDockerTestConfiguration(source(),fixtures());
  for (const args of [decoderContainerArguments(decoderResourceNames(names.run,'job'),image,'job'),
    avArguments(avNamesFor(names.run),'updater',image),avArguments(avNamesFor(names.run),'scanner',image)])
    assert.deepEqual(fixtureKeys(configuration.environmentFor(args)),[]);
});

test('create rejects implicit ambient imports, plaintext fixtures, env files, short aliases and duplicate names',() => {
  const configuration=localDockerTestConfiguration(source(),fixtures());
  for(const flags of [['--env','DATABASE_URL'],['--env','PATH'],['--env','postgres_password'],
    ['--env',`POSTGRES_PASSWORD=${password}`],['--env=POSTGRES_PASSWORD='+password],['--env','TZ=Other'],
    ['--env-file','synthetic.env'],['--env-file=synthetic.env'],['-e','POSTGRES_PASSWORD'],['-ePOSTGRES_PASSWORD'],
    ['--env','POSTGRES_PASSWORD','--env','POSTGRES_PASSWORD'],['--env','TZ=UTC','--env','tz=UTC'],['--env'],['--env=']])
    assert.throws(() => configuration.environmentFor(['create',...flags]),denied);
  assert.throws(() => localDockerTestConfiguration(source()).environmentFor(['create','--env','POSTGRES_PASSWORD',image]),denied);
});

test('long env syntax imports exactly the captured named fixture and returns independent create snapshots',() => {
  const configuration=localDockerTestConfiguration(source(),fixtures());
  const first=configuration.environmentFor(['create','--env=POSTGRES_PASSWORD','--env=TZ=UTC',image]);
  assert.deepEqual(fixtureKeys(first),['POSTGRES_PASSWORD']);
  const second=configuration.environmentFor(['create','--env','CAREBRIDGE_FIXTURE_PASSWORD',image]);
  assert.deepEqual(fixtureKeys(second),['CAREBRIDGE_FIXTURE_PASSWORD']);
  assert.equal(first.CAREBRIDGE_FIXTURE_PASSWORD,undefined);assert.equal(second.POSTGRES_PASSWORD,undefined);
});

test('malformed argument lists fail with a fixed error and cannot accidentally inherit the parent environment',() => {
  const configuration=localDockerTestConfiguration(source());
  for (const args of [null,[],{},['info',1],['info',,'synthetic'],Object.assign(['info'],{extra:true}),['info','synthetic\0private']])
    assert.throws(() => configuration.environmentFor(args),denied);
});

test('actual fresh child observes explicit environment plus OS essentials and the exact fixture subset',{timeout:15000},() => {
  // Synthetic source only. No actual application environment values are read
  // or printed. No Docker/DB/E access or dependent local daemon is required.
  const configuration=localDockerTestConfiguration({...source(),NODE_OPTIONS:'--import synthetic-private-hook',
    DOCKER_CONTEXT:'synthetic-remote',DATABASE_URL:'synthetic-private'},fixtures());
  for(const [args,expected] of [
    [['info'],[]],
    [containerArguments(names),['POSTGRES_PASSWORD']],
    [workerArguments(names,id,image),['CAREBRIDGE_FIXTURE_PASSWORD']],
    [decoderServiceTestArguments(names,id,image),['CAREBRIDGE_FIXTURE_PASSWORD','CAREBRIDGE_LINUX_TEST_DATABASE_ID','CAREBRIDGE_LINUX_TEST_ENGINE','CAREBRIDGE_LINUX_TEST_IMAGE']],
    [['start','--attach','--interactive',id],[]],
  ]) {
    const environment=configuration.environmentFor(args);
    const result=spawnSync(process.execPath,['--input-type=module','-e','console.log(JSON.stringify(Object.keys(process.env).sort()))'],
      {env:environment,shell:false,windowsHide:true,encoding:'utf8',timeout:2000});
    assert.equal(result.error,undefined);assert.equal(result.status,0);assert.equal(result.signal,null);assert.equal(result.stderr,'');
    const keys=JSON.parse(result.stdout);
    // Node 24.15's bundled libuv src/win/process.c required_vars supplies these
    // absent Windows essentials itself. Do not pretend the observed child has
    // no OS additions; only this closed list may supplement the explicit env.
    const essential=process.platform==='win32' ? ['HOMEDRIVE','HOMEPATH','LOGONSERVER','SYSTEMDRIVE','USERDOMAIN','USERNAME'] : [];
    assert.deepEqual(keys.filter((key)=>!essential.includes(key)),Object.keys(environment).sort());
    assert.deepEqual(keys.filter((key)=>Object.hasOwn(fixtures(),key)),expected);
    for(const name of ['NODE_OPTIONS','DOCKER_CONTEXT','DATABASE_URL']) assert.equal(keys.includes(name),false);
  }
});

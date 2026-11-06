import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { decoderCliTransport } from '../decoder-cli-transport.mjs';
import { linuxDecoderConfiguration,linuxDecoderCommand,linuxDecoderRuntime } from '../linux-decoder-runtime.mjs';
import { decoderResourceNames,decoderContainerArguments } from '../decoder-container-policy.mjs';
import { RepositoryError } from '../errors.mjs';
const image = `sha256:${'a'.repeat(64)}`,id = 'b'.repeat(64),names = decoderResourceNames('12345678-1234-4234-8234-123456789abc','job');
const configuration = { cliPath:'/usr/local/bin/docker',cliSha256:'c'.repeat(64),socketPath:'/run/carebridge-engine/docker.sock',
  socketOwnerUid:0,engineIdentity:'synthetic-local-engine-0001',approvedImageId:image };
const refused = (error) => error instanceof RepositoryError && error.code === 'SCAN_UNAVAILABLE' && error.message === error.code;
const script = (code) => decoderCliTransport(async () => ({ file:process.execPath,args:['--input-type=module','-e',code],
  environment:{ PATH:'',LANG:'C',TZ:'UTC' } }));
const source = (bytes = Buffer.from('synthetic bytes')) => Readable.from([bytes],{ objectMode:false });
const options = (changes = {}) => ({ signal:new AbortController().signal,outputLimit:4096,...changes });

test('Linux configuration requires explicit fixed local artifacts and cannot accept URLs or ambient fields',async () => {
  assert.deepEqual(linuxDecoderConfiguration(configuration),configuration); assert.ok(Object.isFrozen(linuxDecoderConfiguration(configuration)));
  for (const changes of [{ cliPath:'docker' },{ cliPath:'/tmp/docker' },{ cliSha256:'latest' },{ socketPath:'tcp://remote:2375' },
    { socketPath:'/var/run/../private.sock' },{ socketOwnerUid:-1 },{ socketOwnerUid:'0' },{ engineIdentity:'short' },
    { approvedImageId:'latest' },{ host:'remote' },{ environment:{} },{ cliSha256:{ toString:() => configuration.cliSha256 } },
    { engineIdentity:{ toString:() => configuration.engineIdentity } },{ approvedImageId:{ toString:() => image } }])
    assert.throws(() => linuxDecoderConfiguration({ ...configuration,...changes }),TypeError);
  const incomplete = { ...configuration }; delete incomplete.socketOwnerUid; assert.throws(() => linuxDecoderConfiguration(incomplete),TypeError);
  if (process.platform !== 'linux') await assert.rejects(linuxDecoderRuntime(configuration),refused);
});
test('only exact per-job commands with full IDs and immutable image are accepted',() => {
  for (const [command,purpose] of [[['info','--format','{{json .}}'],'identity'],[['image','inspect',image],'image'],
    [['container','inspect',id],'container'],[['container','inspect',names.worker],'container'],
    [decoderContainerArguments(names,image,'job'),'create'],[['ps','--all','--filter',`name=^/${names.worker}$`,'--format','{{.ID}}'],'names'],
    [['ps','--all','--no-trunc','--filter',`id=${id}`,'--format','{{.ID}}'],'ids'],[['kill','--signal','KILL',id],'kill'],
    [['rm',id],'remove'],[['start','--attach','--interactive',id],'exchange']]) assert.equal(linuxDecoderCommand(command,image),purpose);
  for (const command of [['build','.'],['pull','latest'],['exec',id,'sh'],['rm','--force',id],['rm',id.slice(0,12)],
    ['kill','--signal','TERM',id],['container','inspect','other'],['image','inspect','latest'],
    ['ps','--all','--filter','label=arbitrary','--format','{{.ID}}'],['start',id],['info','--format','{{json .}}','--host','remote'],
    decoderContainerArguments(names,image,'job').map((value) => value === '--network=none' ? '--network=host' : value)])
    assert.throws(() => linuxDecoderCommand(command,image),refused);
});
test('control pipe preserves fragmented UTF-8 with no inherited application environment',async () => {
  const transport = script("process.stdout.write(Buffer.from([0xe2])); setTimeout(()=>{process.stdout.write(Buffer.from([0x82,0xac]));},5);");
  assert.equal(await transport.command([]),'€');
  assert.equal(await script("console.log(process.env.HOME === undefined && process.env.DOCKER_HOST === undefined)").command([]),'true');
});
test('control exit failure oversized output invalid encoding and timeout reveal only a fixed error',async () => {
  for (const code of ["console.error('PRIVATE SOURCE'); process.exit(1);","process.stdout.write(Buffer.alloc(1048577));",
    "process.stdout.write(Buffer.from([0xff]));","setInterval(()=>{},1000);"])
    await assert.rejects(script(code).command([],{ timeout:200 }),refused);
  await assert.rejects(script('').command([],{ timeout:15001 }),refused);
});
test('actual child pipe consumes bounded input and returns separately corroboratable nonzero exit',async () => {
  const transport = script("let size=0; for await(const bytes of process.stdin) size+=bytes.length; console.log(size); process.exitCode=1;");
  assert.deepEqual(await transport.exchange([],source(),options()),{ code:1,output:'15' });
});
test('stderr oversized output and malformed encoding never become successful exchange evidence',async () => {
  for (const code of ["process.stderr.write('PRIVATE DETAIL'); setInterval(()=>{},1000);",
    "process.stdout.write(Buffer.alloc(4097)); setInterval(()=>{},1000);","for await(const b of process.stdin){};process.stdout.write(Buffer.from([0xff]));"])
    await assert.rejects(script(code).exchange([],source(),options()),refused);
});
test('active pipe cancellation closes unread input and waits for its own CLI process close',async () => {
  const controller = new AbortController(),packet = new Readable({ read() {} }); let failed = 0;
  const pending = script("setInterval(()=>{},1000)").exchange([],packet,options({ signal:controller.signal,onFailure:() => { failed++; } }));
  const rejected = assert.rejects(pending,refused); setTimeout(() => controller.abort('PRIVATE REASON'),50);
  await rejected; assert.equal(packet.destroyed,true); assert.equal(failed,1);
});
test('input IO failure preserves SCAN_INVALID but never native diagnostic text',async () => {
  const typed = new RepositoryError('SCAN_INVALID'); typed.message = 'PRIVATE IO DETAIL';
  for (const error of [new RepositoryError('SCAN_INVALID'),typed,new Error('PRIVATE IO DETAIL')]) {
    const packet = new Readable({ read() { this.destroy(error); } });
    await assert.rejects(script("for await(const b of process.stdin){};").exchange([],packet,options()),
      (caught) => caught instanceof RepositoryError && caught.code === (error instanceof RepositoryError ? 'SCAN_INVALID' : 'SCAN_UNAVAILABLE') && caught.message === caught.code);
  }
});
test('pre-aborted input wrong limits and arbitrary callback cannot start a child pipe',async () => {
  const controller = new AbortController(); controller.abort();
  for (const change of [{ signal:controller.signal },{ outputLimit:4097 },{ onFailure:'callback' }])
    await assert.rejects(script("process.stdout.write('not started')").exchange([],source(),options(change)),refused);
});
test('pipe input has an independent finite byte ceiling even if a caller bypasses the file manifest',async () => {
  const packet = Readable.from((async function* () { for (let i = 0; i < 51; i++) yield Buffer.alloc(1024*1024); })(),{ objectMode:false });
  await assert.rejects(script("for await(const bytes of process.stdin){}; console.log('too late');").exchange([],packet,options()),refused);
  assert.equal(packet.destroyed,true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { parsePrototypeArguments, runPrototype, openPrototypeBrowser } from '../scripts/prototype.mjs';

function streams() {
  const input=new PassThrough(),output=new PassThrough(),diagnostic=new PassThrough(),target=new EventEmitter();
  input.isTTY=output.isTTY=true;
  let text='',errors='';output.on('data',b=>text+=b);diagnostic.on('data',b=>errors+=b);
  return {input,output,diagnostic,target,get text(){return text;},get errors(){return errors;}};
}
test('prototype launcher requires explicit scope, local port, interactive credential output',async()=>{
  assert.deepEqual(parsePrototypeArguments(['--confirm-synthetic-local','--open']),{port:0,open:true});
  for(const args of [[],['--confirm-synthetic-local','--host=0.0.0.0'],['--confirm-synthetic-local','--port=80'],['--confirm-synthetic-local','--port=65536'],['--confirm-synthetic-local','--open','--open']])assert.throws(()=>parsePrototypeArguments(args));
  for(const url of ['https://example.com','http://127.0.0.1:4180/?key=secret','http://0.0.0.0:4180'])assert.throws(()=>openPrototypeBrowser(url));
  const f=streams();f.output.isTTY=false;
  await runPrototype(['--confirm-synthetic-local'],{...f,createSandbox:()=>assert.fail('must not create credentials')});
  assert.equal(f.target.exitCode,1);assert.equal(f.text,'');assert.match(f.errors,/터미널/);
});
test('startup cancellation adopts and closes only its new sandbox without exposing credentials',async()=>{
  const f=streams(),started=Promise.withResolvers(),release=Promise.withResolvers();let closed=0;
  const running=runPrototype(['--confirm-synthetic-local'],{...f,createSandbox:async()=>{started.resolve();await release.promise;return {credentials:[{password:'synthetic-never-display'}],close:async()=>{closed++;}};}});
  await started.promise;f.target.emit('SIGINT');release.resolve();await running;
  assert.equal(closed,1);assert(!f.text.includes('synthetic-never-display'));assert.equal(f.target.listenerCount('SIGINT'),0);
});
test('interactive prototype keeps running until explicit quit and closes after browser opening',async()=>{
  const f=streams();let closed=0,opened=0;
  await runPrototype(['--confirm-synthetic-local','--open'],{...f,
    createSandbox:async()=>({origin:'http://127.0.0.1:4180',credentials:[{role:'therapist',email:'prototype@carebridge.test',password:'synthetic-only'}],close:async()=>{closed++;}}),
    openBrowser:async origin=>{assert.equal(origin,'http://127.0.0.1:4180');opened++;f.input.write('q\n');},
  });
  assert.equal(opened,1);assert.equal(closed,1);assert.match(f.text,/외부 API 비용 없음/);assert.match(f.text,/종료하고/);assert.equal(f.errors,'');
});

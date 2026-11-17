import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseOpenAiPrototypeArguments, createPrototypeTransportAudit, runOpenAiPrototype } from '../scripts/prototype-openai.mjs';
import { runPrototype } from '../scripts/prototype.mjs';

const flags = ['--confirm-synthetic-local', '--enable-external-ai'];
const fakeKey = 'sk-synthetic_never_a_real_key_123456789';
function io() {
  const input = new PassThrough(), output = new PassThrough(), diagnostic = new PassThrough(), target = new EventEmitter();
  input.isTTY = output.isTTY = true;
  let text = '', errors = '';
  output.on('data', value => text += value); diagnostic.on('data', value => errors += value);
  return {input,output,diagnostic,target,get text(){return text;},get errors(){return errors;}};
}

test('live prototype requires both explicit scopes and rejects duplicate/remote options', () => {
  assert.deepEqual(parseOpenAiPrototypeArguments([...flags,'--open','--verify-synthetic-home']), {
    baseArgs: ['--confirm-synthetic-local','--open'], verify: true,
  });
  for (const args of [[],[flags[0]],[flags[1]],[...flags,flags[1]],[...flags,'--verify-synthetic-home','--verify-synthetic-home'],[...flags,'--host=0.0.0.0']])
    assert.throws(() => parseOpenAiPrototypeArguments(args));
});

test('missing key or redirected terminal refuses fixture fallback and removes child key', async () => {
  for (const mode of ['missing','redirected','invalid']) {
    const f=io(), env=mode==='missing'?{}:{CAREBRIDGE_OPENAI_API_KEY:mode==='invalid'?'invalid':fakeKey};
    if(mode==='redirected')f.input.isTTY=false;
    await runOpenAiPrototype(flags,{...f,env,runSession:()=>assert.fail('no server may start')});
    assert.equal(f.target.exitCode,1);assert.equal(f.text,'');assert(!f.errors.includes(fakeKey));
    assert.equal(env.CAREBRIDGE_OPENAI_API_KEY,undefined);
  }
});

test('valid explicit key creates live providers server-side without any startup model call', async () => {
  const f=io(),env={CAREBRIDGE_OPENAI_API_KEY:fakeKey};let created=0;
  await runOpenAiPrototype(flags,{...f,env,fetchImpl:()=>assert.fail('no automatic call'),
    createSandbox:async options=>{
      assert.equal(options.port,4180);assert.equal(options.aiProviders.chatProvider.mode,'openai');
      assert.equal(options.aiProviders.summaryProvider.mode,'openai');created++;return {aiMode:'openai'};
    },
    runSession:async(args,deps)=>{
      assert.deepEqual(args,[flags[0]]);assert.equal(env.CAREBRIDGE_OPENAI_API_KEY,undefined);
      const sandbox=await deps.createSandbox({port:4180});await deps.onReady(sandbox);
    },
  });
  assert.equal(created,1);assert(!f.text.includes(fakeKey));assert.equal(f.errors,'');
});

test('transport audit stores only status and rejects non-OpenAI transports', async () => {
  let calls=0;
  const audit=createPrototypeTransportAudit(async()=>{calls++;return new Response('{}',{status:200});});
  const response=await audit.fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:fakeKey}});
  assert.equal(response.status,200);assert.deepEqual(audit.calls,[{status:200,completed:true}]);
  await assert.rejects(audit.fetch('https://other.invalid',{method:'POST'}));assert.equal(calls,1);
  const failed=createPrototypeTransportAudit(async()=>{throw Error(fakeKey);});
  await assert.rejects(failed.fetch('https://api.openai.com/v1/responses',{method:'POST'}),error=>error.message==='AI_TRANSPORT_FAILED');
  assert(!JSON.stringify(failed.calls).includes(fakeKey));
});

test('live session prints honest mode and cleans sandbox when ready hook fails',async()=>{
  const f=io();let closed=0;
  await runPrototype([flags[0]],{...f,createSandbox:async()=>({aiMode:'openai',origin:'http://127.0.0.1:4180',credentials:[],close:async()=>closed++}),
    onReady:async()=>{throw Error('synthetic verification failure');}});
  assert.match(f.text,/실제 OpenAI 응답/);assert(!f.text.includes('외부 API 비용 없음'));
  assert.equal(closed,1);assert.equal(f.target.exitCode,1);assert.equal(f.target.listenerCount('SIGINT'),0);
});

test('piped live entry cannot print credentials or start a server',()=>{
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/prototype-openai.mjs',import.meta.url)),...flags],{
    env:{...process.env,CAREBRIDGE_OPENAI_API_KEY:fakeKey},encoding:'utf8',timeout:10000,
  });
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert(!result.stderr.includes(fakeKey));assert(!result.stderr.includes('http://'));
});

test('quit propagates cancellation to the ready check before closing the owned session',async()=>{
  const f=io();let closed=0,aborted=false;
  await runPrototype([flags[0]],{...f,createSandbox:async()=>({aiMode:'openai',origin:'http://127.0.0.1:4180',credentials:[],close:async()=>closed++}),
    onReady:async(_sandbox,{signal})=>{
      const stopped=new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));
      f.input.write('q\n');await stopped;
    }});
  assert.equal(aborted,true);assert.equal(closed,1);assert.equal(f.target.listenerCount('SIGINT'),0);
});

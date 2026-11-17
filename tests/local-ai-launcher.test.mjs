import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLocalAiArguments, readLocalAiConfig } from '../scripts/local-ai-api.mjs';
const flags=['--confirm-synthetic-local','--enable-external-ai'];
const fakeKey='sk-synthetic_not_a_real_key_123456789';

test('launcher requires both scope flags and refuses unknown, duplicate and external host options',()=>{
  assert.deepEqual(parseLocalAiArguments(flags),{port:0});
  assert.deepEqual(parseLocalAiArguments([...flags,'--port=4180']),{port:4180});
  for(const args of [[],[flags[0]],[flags[1]],[...flags,flags[0]],[...flags,'--host=0.0.0.0'],[...flags,'--port=1023'],[...flags,'--port=65536'],[...flags,'--port=0','--port=4180']]) {
    assert.throws(()=>parseLocalAiArguments(args),TypeError);
  }
});

test('explicit Carebridge key only, fixed output/time bounds, safe model and reasoning configuration',()=>{
  assert.throws(()=>readLocalAiConfig({OPENAI_API_KEY:fakeKey}),TypeError);
  assert.deepEqual(readLocalAiConfig({CAREBRIDGE_OPENAI_API_KEY:fakeKey}),{
    apiKey:fakeKey,model:'gpt-6-luna',reasoningEffort:'none',maxOutputTokens:800,timeoutMs:8000,
  });
  for(const env of [{CAREBRIDGE_OPENAI_API_KEY:fakeKey+'\n'},{CAREBRIDGE_OPENAI_API_KEY:fakeKey,CAREBRIDGE_AI_MODEL:'https://other.test'},
    {CAREBRIDGE_OPENAI_API_KEY:fakeKey,CAREBRIDGE_AI_REASONING_EFFORT:'unsupported'}]) {
    assert.throws(()=>readLocalAiConfig(env),error=>error instanceof TypeError&&!error.message.includes(fakeKey));
  }
});

test('piped launcher refuses to open a server or print a key/account even with explicit flags',()=>{
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/local-ai-api.mjs',import.meta.url)),...flags],{
    env:{...process.env,CAREBRIDGE_OPENAI_API_KEY:fakeKey},encoding:'utf8',timeout:10000,
  });
  assert.equal(result.status,1);
  assert.equal(result.stdout,'');
  assert.match(result.stderr,/대화형 터미널/);
  assert.equal(result.stderr.includes(fakeKey),false);
  assert.equal(result.stderr.includes('http://'),false);
});

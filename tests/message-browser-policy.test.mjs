import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {messageBrowserConnection,messageBrowserEnvironment,messageBrowserOptions,messageBrowserRunId} from './message-browser-policy.mjs';
import {waitForMessageBrowserChild} from './message-lifecycle-local.mjs';
const module=path.resolve('synthetic-playwright.mjs'),executable=path.resolve('synthetic-chromium.exe');
const runId='b364d384-02e7-497c-9412-ca0c3778ea20';
const fails=fn=>assert.throws(fn,{message:'MESSAGE_BROWSER_TEST_CONFIGURATION'});
test('owned browser runner requires explicit synthetic scope and existing absolute runtime configuration',()=>{
  const options=messageBrowserOptions(['--confirm-synthetic-local'],{PLAYWRIGHT_MODULE:module,STUDY_CHROMIUM_EXECUTABLE:executable});
  assert.deepEqual(options,{module,executable});assert(Object.isFrozen(options));
  for(const args of [[],['--production'],['--confirm-synthetic-local','--confirm-synthetic-local'],['--confirm-synthetic-local','--url=external']])
    fails(()=>messageBrowserOptions(args,{}));
  for(const field of ['PLAYWRIGHT_MODULE','STUDY_CHROMIUM_EXECUTABLE'])for(const value of [undefined,'relative-path','bad\npath'])
    fails(()=>messageBrowserOptions(['--confirm-synthetic-local'],{PLAYWRIGHT_MODULE:module,STUDY_CHROMIUM_EXECUTABLE:executable,[field]:value}));
});
test('browser connection accepts exactly one explicit loopback transport and preserves manual CDP compatibility',()=>{
  assert.deepEqual(messageBrowserConnection({wsEndpoint:'ws://127.0.0.1:12345/synthetic-control'}),{kind:'playwright',url:'ws://127.0.0.1:12345/synthetic-control'});
  assert.deepEqual(messageBrowserConnection({cdpUrl:'http://127.0.0.1:12345'}),{kind:'cdp',url:'http://127.0.0.1:12345/'});
  assert.equal(messageBrowserConnection({cdpUrl:'ws://[::1]:12345/devtools/browser/synthetic'}).kind,'cdp');
  fails(()=>messageBrowserConnection());fails(()=>messageBrowserConnection({wsEndpoint:'ws://127.0.0.1:1/x',cdpUrl:'http://127.0.0.1:2'}));
});
test('external credential-bearing malformed or ambiguous browser endpoints never fall back to another transport',()=>{
  for(const value of ['ws://example.com:1234/x','wss://127.0.0.1:1234/x','http://127.0.0.1:1234/',
    'ws://user:secret@127.0.0.1:1234/x','ws://127.0.0.1:1234/x?token=secret','ws://127.0.0.1:1234/x#fragment',
    'ws://127.0.0.1/x',' ws://127.0.0.1:1234/x','ws://127.0.0.1:1234/x\n','',null,{},123])
    fails(()=>messageBrowserConnection({wsEndpoint:value}));
  for(const wsEndpoint of ['',null])fails(()=>messageBrowserConnection({wsEndpoint,cdpUrl:'http://127.0.0.1:12345/'}));
});
test('child environment excludes application DB credentials hooks proxy and inherited debug URLs',()=>{
  const child=messageBrowserEnvironment({SystemRoot:'synthetic-system',TEMP:'synthetic-temp',DATABASE_URL:'not-carried',
    VERCEL_TOKEN:'not-carried',NODE_OPTIONS:'not-carried',HTTP_PROXY:'not-carried',PORT:'not-carried',
    CDP_URL:'not-carried',PLAYWRIGHT_WS_ENDPOINT:'not-carried',APP_URL:'not-carried',MESSAGE_TEST_RUN_ID:'not-carried'},
  {module,wsEndpoint:'ws://127.0.0.1:12345/synthetic-control',origin:'http://127.0.0.1:54321',runId});
  assert.deepEqual(child,{SystemRoot:'synthetic-system',TEMP:'synthetic-temp',PLAYWRIGHT_MODULE:module,
    PLAYWRIGHT_WS_ENDPOINT:'ws://127.0.0.1:12345/synthetic-control',APP_URL:'http://127.0.0.1:54321/',MESSAGE_TEST_RUN_ID:runId});
  for(const origin of ['https://example.com:1234/','http://127.0.0.1:1234/path','http://127.0.0.1:1234/?secret=x'])
    fails(()=>messageBrowserEnvironment({},{module,wsEndpoint:child.PLAYWRIGHT_WS_ENDPOINT,origin,runId}));
});
test('report run identity cannot name an existing path or silently reuse unrelated results',()=>{
  assert.equal(messageBrowserRunId(runId),runId);
  for(const value of ['../results','synthetic','',null,runId.toUpperCase(),runId+'/extra'])fails(()=>messageBrowserRunId(value));
});
test('browser child error cannot report cleanup or completion before the process pipes actually close',async()=>{
  const child=new EventEmitter();let settled=false;
  const result=waitForMessageBrowserChild(child).then(value=>{settled=true;return value;});
  child.emit('error',new Error('synthetic spawn failure with non-public diagnostic'));
  child.emit('exit',1,null);await Promise.resolve();assert.equal(settled,false);
  child.emit('close',1,null);assert.deepEqual(await result,{code:1,signal:null,failed:true,closed:true});
});
test('normal and timed-out child outcomes retain their exact terminal result without implicit success',async()=>{
  for(const [code,signal]of [[0,null],[1,null],[null,'SIGTERM']]){
    const child=new EventEmitter(),result=waitForMessageBrowserChild(child);
    child.emit('close',code,signal);assert.deepEqual(await result,{code,signal,failed:false,closed:true});
  }
});

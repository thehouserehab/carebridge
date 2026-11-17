import test from 'node:test';
import assert from 'node:assert/strict';
import {WebAiClient,boundedWebAiMessages} from '../src/web-ai-client.js';
import {WebAiUi,sameWebAiSnapshot} from '../src/web-ai-ui.js';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
test('web AI uses same-origin cookie requests and sends only explicit login or model fields',async()=>{
  const calls=[];const client=new WebAiClient({fetch:async(path,options)=>{calls.push({path,options});return json(path.endsWith('session')?{authenticated:true,enabled:true,mode:'openai'}:{kind:'summary',summary:'가상 요약',reviewNotes:[],mode:'openai',model:'synthetic-model'});}});
  await client.session();await client.login('synthetic-access');await client.summary({performed:'가상 활동',response:'가상 반응'});await client.logout();
  assert.deepEqual(calls.map(x=>x.options.method),['GET','POST','POST','DELETE']);
  for(const call of calls){assert.equal(call.options.credentials,'same-origin');assert.equal(call.options.cache,'no-store');assert.equal(call.options.redirect,'error');assert(!Object.hasOwn(call.options.headers,'Authorization'));}
  assert.deepEqual(JSON.parse(calls[1].options.body),{accessCode:'synthetic-access',syntheticConfirmed:true});
  assert.deepEqual(JSON.parse(calls[2].options.body),{kind:'summary',source:{performed:'가상 활동',response:'가상 반응'},syntheticConfirmed:true});
  assert.equal(calls[3].options.headers['X-Carebridge-AI'],'1');
});
test('web AI rejects spoofed or extra response fields and maps raw server errors safely',async()=>{
  for(const value of [{kind:'chat',text:'answer',mode:'fixture',model:'test'},{kind:'chat',text:'answer',mode:'openai',model:'test',secret:'unexpected'}]){
    const client=new WebAiClient({fetch:async()=>json(value)});await assert.rejects(client.chat([{role:'user',content:'가상 질문'}]),error=>error.code==='AI_OUTPUT_INVALID');
  }
  const client=new WebAiClient({fetch:async()=>json({error:{code:'internal-super-secret'}},500)});
  await assert.rejects(client.session(),error=>error.code==='AI_UNAVAILABLE'&&!error.message.includes('internal'));
});
test('WAF throttling maps non-JSON 429 responses to the safe rate-limit message without retry',async()=>{
  let calls=0;
  const client=new WebAiClient({fetch:async()=>{calls++;return new Response('<html>WAF rate limit</html>',{status:429,headers:{'content-type':'text/html'}});}});
  await assert.rejects(client.session(),error=>error.code==='AI_RATE_LIMITED'&&!error.message.includes('WAF'));
  assert.equal(calls,1);
});
test('web AI history is bounded by complete turns and never adds records or identity',()=>{
  const history=Array.from({length:16},(_,i)=>({role:i%2?'assistant':'user',content:String(i)}));
  const result=boundedWebAiMessages(history,'가상 질문');assert.equal(result.length,11);assert.deepEqual(result[0],{role:'user',content:'6'});assert.equal(result.at(-1).content,'가상 질문');
  const large=Array.from({length:6},(_,i)=>({role:i%2?'assistant':'user',content:'x'.repeat(i%2?6000:2000)}));
  assert(boundedWebAiMessages(large,'test').reduce((n,x)=>n+x.content.length,0)<=16000);
  for(const [h,m] of [[[],''],[[],'x'.repeat(2001)],[[{role:'assistant',content:'x'}],'x'],[[{role:'user',content:'x',record:'private'},{role:'assistant',content:'x'}],'x']])assert.throws(()=>boundedWebAiMessages(h,m));
});
test('summary refuses unintended fields and stale snapshots include actor, child, source and previous summary',async()=>{
  const client=new WebAiClient({fetch:()=>assert.fail('No request')});
  for(const source of [{performed:'',response:''},{performed:'a',response:'b',privateNote:'private'}])await assert.rejects(client.summary(source),error=>error.code==='INVALID_INPUT');
  const original={actorId:'t1',role:'therapist',childId:'c1',workspaceRevision:0,recordId:'r1',updatedAt:'test',source:{performed:'a',response:'b'},originalSummary:'old'};
  assert(sameWebAiSnapshot(original,structuredClone(original)));
  for(const key of ['actorId','childId','workspaceRevision','recordId','updatedAt','originalSummary'])assert(!sameWebAiSnapshot(original,{...original,[key]:'changed'}));
  assert(!sameWebAiSnapshot(original,{...original,source:{performed:'changed',response:'b'}}));
});
test('cancelled requests do not present raw network errors or automatically retry',async()=>{
  const controller=new AbortController();let calls=0;
  const client=new WebAiClient({fetch:async()=>{calls++;controller.abort();throw Error('secret');}});
  await assert.rejects(client.session(controller.signal),error=>error.code==='AI_CANCELLED'&&!error.message.includes('secret'));assert.equal(calls,1);
});
test('session expiry clears previous history and drafts before a new connection',async()=>{
  const context={actorId:'t1',role:'therapist',childId:'c1'};
  const ui=new WebAiUi({getContext:()=>context,listRecords:()=>[],getRecord:()=>null,onApply:()=>false,client:{session:async()=>({authenticated:false,enabled:true,mode:'openai'})}});
  ui.context=context;ui.scope=JSON.stringify(['t1','therapist','c1']);ui.dialog={open:true,innerHTML:''};ui.tab='chat';ui.history=[{role:'user',content:'old'},{role:'assistant',content:'old'}];ui.input='old';ui.snapshot={};ui.draft={};ui.status='';
  await ui.checkSession();assert.deepEqual(ui.history,[]);assert.equal(ui.input,'');assert.equal(ui.snapshot,null);assert.equal(ui.draft,null);assert.equal(ui.authenticated,false);
});
test('invalid pasted characters show a safe message without an unhandled rejection or model call',async()=>{
  const ui=new WebAiUi({getContext:()=>({}),listRecords:()=>[],getRecord:()=>null,onApply:()=>false,client:{chat:()=>assert.fail('No model call')}});
  ui.context={role:'therapist'};ui.dialog={innerHTML:''};ui.authenticated=true;ui.tab='chat';ui.input='bad\u0001text';ui.status='';
  await ui.send();assert.equal(ui.status,'입력 내용을 확인해 주세요.');assert.equal(ui.input,'bad\u0001text');
});

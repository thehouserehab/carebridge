import test from 'node:test';
import assert from 'node:assert/strict';
import { AiClient, parseAiConversation, parseAiDraft, parseAiPreview } from '../local-api/ai-client.js';
import { LocalApiClient, LocalApiError } from '../local-api/client.js';

const context = {user:{userId:'test-user'},centerId:'test-center',roomId:'test-room'};
const conversation = {revision:1,messages:[{role:'user',content:'가상 질문'},{role:'assistant',content:'합성 응답'}],mode:'fixture',model:'fixture-ai',contextTruncated:false};
const preview = {recordId:'test-record',revision:1,source:{performed:'가상 블록 활동',response:'가상 반응'},sourceHash:'a'.repeat(64),mode:'fixture',model:'fixture-ai'};
const draft = {...preview,requestId:'test-request',summary:'가상 요약',reviewNotes:[]}; delete draft.source;
const code = expected => error => error instanceof LocalApiError && error.code === expected;
const json = (data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});

test('AI transport preserves existing account binding and POST origin guard without clinical payloads', async () => {
  const requests=[];
  const transport=new LocalApiClient({fetch:async (path,options)=>{requests.push({path,options});return json({conversation});}});
  transport.expectedUserId=context.user.userId;
  const client=new AiClient(transport);
  await client.send(context,{message:'가상 질문',expectedRevision:0,requestId:'test-request'});
  assert.equal(requests[0].path,'/api/local/centers/test-center/conversations/test-room/ai-conversation');
  assert.equal(requests[0].options.headers['X-Carebridge-Account'],context.user.userId);
  assert.equal(requests[0].options.headers['X-Carebridge-Request'],'1');
  assert.equal(requests[0].options.credentials,'same-origin');
  assert.equal(requests[0].options.redirect,'error');
  assert.deepEqual(JSON.parse(requests[0].options.body),{message:'가상 질문',expectedRevision:0,requestId:'test-request'});
});

test('AI requests reject account changes before and after pending responses', async () => {
  let calls=0;
  const api={expectedUserId:'other-user',roomPath:()=>'/room',request:async()=>{calls++;return {conversation};}};
  const client=new AiClient(api);
  await assert.rejects(client.conversation(context),code('AUTH_REQUIRED')); assert.equal(calls,0);
  api.expectedUserId=context.user.userId;
  api.request=async()=>{api.expectedUserId='other-user';return {conversation};};
  await assert.rejects(client.conversation(context),code('AUTH_REQUIRED'));
});

test('aborted completed request is not displayed',async()=>{
  const controller=new AbortController();
  const api={expectedUserId:context.user.userId,roomPath:()=>'/room',request:async()=>{controller.abort();return {conversation};}};
  await assert.rejects(new AiClient(api).conversation(context,controller.signal),code('CANCELLED'));
});

test('AI parsers reject extra source fields, wrong identity, revision and request binding',()=>{
  assert.deepEqual(parseAiPreview(preview,'test-record',1),preview);
  assert.deepEqual(parseAiDraft(draft,preview,'test-request'),draft);
  for(const value of [{...preview,source:{...preview.source,privateNote:'never send'}},{...preview,recordId:'other-record'},{...preview,revision:2},{...preview,sourceHash:'not-a-hash'}]) {
    assert.throws(()=>parseAiPreview(value,'test-record',1),code('INVALID_RESPONSE'));
  }
  for(const value of [{...draft,sourceHash:'b'.repeat(64)},{...draft,requestId:'other-request'},{...draft,mode:'openai'},{...draft,summary:'x'.repeat(1201)},{...draft,reviewNotes:['x'.repeat(201)]},{...draft,privateNote:'never expose'}]) {
    assert.throws(()=>parseAiDraft(value,preview,'test-request'),code('INVALID_RESPONSE'));
  }
});

test('AI conversation validates bounded alternating history and clones results',()=>{
  const parsed=parseAiConversation(conversation);parsed.messages[0].content='changed';
  assert.equal(conversation.messages[0].content,'가상 질문');
  for(const value of [{...conversation,messages:[{role:'assistant',content:'invalid'}]},{...conversation,messages:[...conversation.messages,...conversation.messages,...conversation.messages,...conversation.messages,...conversation.messages,...conversation.messages,...conversation.messages]},
    {...conversation,messages:[{role:'user',content:'x'.repeat(2001)},{role:'assistant',content:'okay'}]}, {...conversation,model:''},{...conversation,contextTruncated:'false'}]) {
    assert.throws(()=>parseAiConversation(value),code('INVALID_RESPONSE'));
  }
});

test('preview and generation send only binding fields and never duplicate source text',async()=>{
  const requests=[];
  const api={expectedUserId:context.user.userId,roomPath:()=>'/room',request:async(path,options)=>{
    requests.push({path,...options});return options.body?{draft}:{preview};
  }};
  const client=new AiClient(api);
  await client.preview(context,{id:'test-record',revision:1});
  await client.generate(context,preview,'test-request');
  assert.equal(requests[0].path,'/room/records/test-record/ai-summary?revision=1');
  assert.deepEqual(requests[1].body,{expectedRevision:1,sourceHash:preview.sourceHash,requestId:'test-request'});
});

test('AI error whitelist does not expose raw provider diagnostics or mask auth denial',async()=>{
  for(const [status,error,expected] of [[503,'AI_UNAVAILABLE','AI_UNAVAILABLE'],[502,'AI_PROVIDER_UNAVAILABLE','AI_PROVIDER_UNAVAILABLE'],[409,'AI_SOURCE_CHANGED','AI_SOURCE_CHANGED'],[401,'AI_UNAVAILABLE','AUTH_REQUIRED'],[403,'AI_OUTPUT_INVALID','FORBIDDEN'],[503,'RAW_PROVIDER_SECRET','UNAVAILABLE']]) {
    const client=new LocalApiClient({fetch:async()=>json({error,message:'PRIVATE RESPONSE'},status)});
    await assert.rejects(client.request('/api/local/test'),value=>code(expected)(value)&&!value.message.includes('PRIVATE'));
  }
});

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { createServer, request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrate.mjs';
import { Conversations } from '../conversations.mjs';
import { Records } from '../records.mjs';
import { AiRecordDrafts } from '../ai-record-drafts.mjs';
import { AiConversations } from '../ai-conversations.mjs';
import { localAiRoute } from '../local-ai-http.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';

// Isolated synthetic memory DB, loopback HTTP, and explicit provider fixtures.
// No provider credentials, external network, real records or public deployment.
let db, server, origin, options, records, aiDrafts, aiConversations, calls, users, cookies, generate, respond;
const actor = {userId:'therapist-a',centerId:'center-a'};
const prefix='/api/local/centers/center-a/conversations/room-a';
const summary=prefix+'/records/record-a/ai-summary', chat=prefix+'/ai-conversation';
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
before(async()=>{db=await PGlite.create();await migrate(db);});
after(async()=>{await db?.close();});
afterEach(async()=>{
  await Promise.all([aiDrafts?.close(),aiConversations?.close()]);
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=null;}
});
beforeEach(async()=>{
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('therapist-a',true),('guardian-a',true),('manager-a',true),('stranger-a',true),('foreign-b',true);
    INSERT INTO cb_memberships VALUES ('center-a','therapist-a','therapist',true),('center-a','guardian-a','guardian',true),
      ('center-a','manager-a','center',true),('center-a','stranger-a','guardian',true),('center-b','foreign-b','therapist',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1),('center-a','room-a','guardian-a','guardian',true,1);
    INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ('center-a','room-a','goal-a','가상 목표','active');`);
  records=new Records(db);const conversations=new Conversations(db);
  await records.save(actor,{conversationId:'room-a',recordId:'record-a',clientId:'record-save-0001',expectedRevision:0,
    content:{date:'2026-11-06',goalId:'goal-a',title:'합성 기록',performed:'블록 두 개를 쌓도록 안내함',response:'도움을 받아 쌓음',
      nextPlan:'NEVER-SEND-PLAN',privateNote:'NEVER-SEND-NOTE',summary:'기존 수동 요약'}});
  calls=[];
  generate=async()=>({summary:'도움을 받아 블록을 쌓았어요.',reviewNotes:[]});
  respond=async()=>({text:'합성 AI 답변',usage:{inputTokens:5,outputTokens:5}});
  const provider={mode:'fixture',model:'synthetic-ai',generate:async(source,opts)=>{
    calls.push({kind:'summary',source});return generate(source,opts);
  },respond:async(messages,opts)=>{calls.push({kind:'conversation',messages});return respond(messages,opts);}};
  aiDrafts=new AiRecordDrafts({records,provider});aiConversations=new AiConversations({conversations,provider});
  users=new Map();cookies=new Map();
  for(const [name,role,center] of [['therapist-a','therapist','center-a'],['guardian-a','guardian','center-a'],
    ['manager-a','center','center-a'],['stranger-a','guardian','center-a'],['foreign-b','therapist','center-b']]){
    const token=randomBytes(32).toString('hex');
    users.set(token,{userId:name,centers:[{id:center,role}]});cookies.set(name,token);
  }
  const auth={login:async()=>{},logout:async token=>users.delete(token),authenticate:async token=>structuredClone(users.get(token)??null)};
  server=createServer(async(req,res)=>{if(!await handleLocalApiRequest(req,res,options)){res.writeHead(404);res.end();}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin='http://127.0.0.1:'+server.address().port;
  options={auth,conversations,records,profiles:{get:async()=>({})},aiDrafts,aiConversations,origin,cookieName:'cb_local_'+randomBytes(16).toString('hex')};
});
function call(path,{user='therapist-a',method='GET',body,headers={}}={}){
  const requestHeaders={...(user?{Cookie:options.cookieName+'='+cookies.get(user),'X-Carebridge-Account':user}:{}),
    ...(method==='POST'?{Origin:origin,'X-Carebridge-Request':'1','Content-Type':'application/json'}:{}),...headers};
  for(const key of Object.keys(requestHeaders))if(requestHeaders[key]===undefined)delete requestHeaders[key];
  return new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:server.address().port,path,method,headers:requestHeaders,agent:false},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
        const text=Buffer.concat(chunks).toString('utf8');resolve({status:res.statusCode,headers:res.headers,text,json:text?JSON.parse(text):null});
      });
    });req.once('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('Synthetic HTTP timeout')));
    req.end(body===undefined?undefined:JSON.stringify(body));
  });
}
const post=(path,body,extra={})=>call(path,{method:'POST',body,...extra});
const ok=(result)=>{assert.equal(result.status,200,result.text);return result.json;};
const denied=(result,status,error)=>{
  assert.equal(result.status,status,result.text);assert.equal(result.json.error,error);
  assert.deepEqual(Object.keys(result.json).sort(),['error','message']);assert.equal(result.headers['cache-control'],'no-store');
  assert(!result.text.includes('NEVER-SEND'));assert.equal(result.headers['access-control-allow-origin'],undefined);
};
async function generationInput(){const {preview}=ok(await call(summary+'?revision=1'));return{expectedRevision:1,sourceHash:preview.sourceHash,requestId:'ai-request-0001'};}
const counts=async()=> (await db.query('SELECT (SELECT count(*) FROM cb_record_revisions)::int AS records,(SELECT count(*) FROM cb_messages)::int AS messages')).rows[0];

test('AI routes are exact and reject unbounded, duplicate and misplaced query parameters',()=>{
  assert.equal(localAiRoute(new URL(summary+'?revision=1',origin),'GET').kind,'summary');
  assert.equal(localAiRoute(new URL(prefix+'/records/record-a/preview',origin),'GET'),null);
  for(const [path,method] of [[summary,'GET'],[summary+'?revision=0','GET'],[summary+'?revision=1&revision=2','GET'],
    [summary+'?revision=2147483648','GET'],[summary+'?revision=1','POST'],[chat+'?recordId=record-a','GET']])
    assert.throws(()=>localAiRoute(new URL(path,origin),method),e=>e.code==='INVALID_INPUT');
});
test('summary preview and draft preserve record/share data and send only selected strings',async()=>{
  const before=await counts(),body=await generationInput();
  const {draft}=ok(await post(summary,body));
  assert.equal(draft.summary,'도움을 받아 블록을 쌓았어요.');
  assert.deepEqual(calls,[{kind:'summary',source:{performed:'블록 두 개를 쌓도록 안내함',response:'도움을 받아 쌓음'}}]);
  assert.deepEqual(await counts(),before);
  assert.equal((await records.get(actor,{conversationId:'room-a',recordId:'record-a'})).summary,'기존 수동 요약');
  assert.deepEqual(ok(await post(summary,body)).draft,draft);assert.equal(calls.length,1);
});
test('missing authentication, wrong expected account, role and cross-center requests are denied before provider',async()=>{
  denied(await call(summary+'?revision=1',{user:null}),401,'AUTH_REQUIRED');
  denied(await call(summary+'?revision=1',{headers:{'X-Carebridge-Account':'guardian-a'}}),401,'AUTH_REQUIRED');
  denied(await call(summary+'?revision=1',{headers:{'X-Carebridge-Account':undefined}}),401,'AUTH_REQUIRED');
  for(const user of ['guardian-a','manager-a','stranger-a','foreign-b'])
    denied(await call(summary+'?revision=1',{user}),404,'NOT_FOUND');
  assert.equal(calls.length,0);
});
test('AI POST keeps existing same-origin/CSRF and strict input checks',async()=>{
  const body=await generationInput();
  denied(await post(summary,body,{headers:{Origin:'https://untrusted.test'}}),403,'SOURCE_REJECTED');
  denied(await post(summary,body,{headers:{'X-Carebridge-Request':undefined}}),403,'SOURCE_REJECTED');
  denied(await post(summary,{...body,performed:'client replaced source'}),400,'INVALID_INPUT');
  denied(await post(summary,{...body,sourceHash:'bad'}),400,'INVALID_INPUT');
  assert.equal(calls.length,0);
});
test('AI services are optional and unavailable is explicit; arbitrary injected service is rejected',async()=>{
  delete options.aiDrafts;delete options.aiConversations;
  denied(await call(summary+'?revision=1'),503,'AI_UNAVAILABLE');
  denied(await call(chat),503,'AI_UNAVAILABLE');
  options.aiDrafts={preview:async()=>({secret:'never'})};
  denied(await call(summary+'?revision=1'),503,'LOCAL_API_UNAVAILABLE');
});
test('logout while summary is generating prevents returned draft',async()=>{
  const started=deferred(),finish=deferred(),body=await generationInput();
  generate=async()=>{started.resolve();return finish.promise;};
  const pending=post(summary,body);await started.promise;users.delete(cookies.get('therapist-a'));
  finish.resolve({summary:'MUST-NOT-RETURN',reviewNotes:[]});
  const result=await pending;denied(result,401,'AUTH_REQUIRED');assert(!result.text.includes('MUST-NOT-RETURN'));
});
test('revoked therapist participation during generation prevents response and does not mutate records',async()=>{
  const started=deferred(),finish=deferred(),body=await generationInput(),before=await counts();
  generate=async()=>{started.resolve();return finish.promise;};
  const pending=post(summary,body);await started.promise;
  await db.query("UPDATE cb_participants SET active=false WHERE user_id='therapist-a'");
  finish.resolve({summary:'MUST-NOT-RETURN',reviewNotes:[]});denied(await pending,404,'NOT_FOUND');
  assert.deepEqual(await counts(),before);
});
test('provider error text is never exposed and a failed request is not automatically retried',async()=>{
  const body=await generationInput();generate=async()=>{throw new Error('NEVER-SEND-SECRET-KEY');};
  denied(await post(summary,body),409,'AI_REQUEST_FAILED');denied(await post(summary,body),409,'AI_REQUEST_FAILED');
  assert.equal(calls.length,1);
});
test('free conversation uses current participant authority and no clinical context',async()=>{
  const before=await counts(),empty=ok(await call(chat,{user:'guardian-a'})).conversation;
  assert.equal(empty.revision,0);assert.deepEqual(empty.messages,[]);
  const result=ok(await post(chat,{requestId:'chat-request-0001',expectedRevision:0,message:'가상 일반 질문'},{user:'guardian-a'})).conversation;
  assert.equal(result.revision,1);assert.equal(result.messages.at(-1).content,'합성 AI 답변');
  assert.equal(calls.length,1);assert.equal(calls[0].kind,'conversation');
  assert(!JSON.stringify(calls).includes('블록'));assert(!JSON.stringify(calls).includes('NEVER-SEND'));
  assert.deepEqual(await counts(),before);
  assert.deepEqual(ok(await call(chat)).conversation.messages,[]);
  denied(await call(chat,{user:'stranger-a'}),404,'NOT_FOUND');
  denied(await call(chat,{user:'manager-a'}),404,'NOT_FOUND');
});
test('closed response aborts the AI provider request',async()=>{
  const started=deferred(),aborted=deferred(),body=await generationInput();
  generate=async(_source,{signal})=>new Promise((resolve,reject)=>{
    started.resolve();signal.addEventListener('abort',()=>{aborted.resolve();reject(new Error('aborted'));},{once:true});
  });
  const req=request({hostname:'127.0.0.1',port:server.address().port,path:summary,method:'POST',agent:false,headers:{
    Cookie:options.cookieName+'='+cookies.get('therapist-a'),'X-Carebridge-Account':'therapist-a',
    Origin:origin,'X-Carebridge-Request':'1','Content-Type':'application/json'}});
  req.on('error',()=>{});req.end(JSON.stringify(body));await started.promise;req.destroy();
  let timer;
  try {
    await Promise.race([aborted.promise,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error('Provider did not receive abort')),1500);
    })]);
  } finally { clearTimeout(timer); }
  assert.equal(calls.length,1);
});

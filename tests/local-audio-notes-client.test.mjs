import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioNotesClient, parseAudioNoteSession } from '../local-api/audio-notes-client.js';
import { LocalApiClient, LocalApiError } from '../local-api/client.js';

const context={user:{userId:'test-user'},role:'therapist',centerId:'test-center',roomId:'test-room'};
const session={id:'test-audio',recordId:'test-record',recordRevision:1,revision:1,filename:'synthetic.wav',type:'audio/wav',size:44,
  sha256:'a'.repeat(64),receivedAt:'2026-11-16T00:00:00.000Z',state:'uploaded',mode:'fixture',model:'fixture-model',
  transcriptionModel:'fixture-transcript',result:null,events:[{kind:'uploaded',at:'2026-11-16T00:00:00.000Z'}],syntheticOnly:true};
const code=expected=>error=>error instanceof LocalApiError&&error.code===expected;
const json=data=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
const deferred=()=>{let resolve;const promise=new Promise(yes=>resolve=yes);return{promise,resolve};};

test('audio client rejects cross-account/guardian access before request and after delayed response',async()=>{
  let calls=0;const gate=deferred();
  const api={expectedUserId:'other-user',roomPath:()=>'/api/local/room',request:async()=>{calls++;return gate.promise;}};
  const client=new AudioNotesClient(api);
  await assert.rejects(client.get(context,'test-record','test-audio'),code('AUTH_REQUIRED'));assert.equal(calls,0);
  api.expectedUserId=context.user.userId;
  await assert.rejects(client.get({...context,role:'guardian'},'test-record','test-audio'),code('AUTH_REQUIRED'));assert.equal(calls,0);
  const pending=client.get(context,'test-record','test-audio');api.expectedUserId='other-user';gate.resolve({session});
  await assert.rejects(pending,code('AUTH_REQUIRED'));
});

test('audio status parsing binds the record and rejects extra data and premature generated result',()=>{
  const parsed=parseAudioNoteSession(session,'test-record');parsed.events[0].kind='changed';assert.equal(session.events[0].kind,'uploaded');
  for(const value of [{...session,recordId:'another-record'},{...session,syntheticOnly:false},{...session,rawKey:'secret'},
    {...session,size:21*1024**2},{...session,filename:'../audio.wav'},{...session,type:'image/png'},
    {...session,result:{private:'unexpected'}},{...session,state:'ready',result:null}]){
    assert.throws(()=>parseAudioNoteSession(value,'test-record'),code('INVALID_RESPONSE'));
  }
});

test('upload requires both explicit confirmations before reading the file',async()=>{
  const api={expectedUserId:context.user.userId,roomPath:()=>'/api/local/room',fetch:()=>assert.fail('must not send')};
  const file={name:'synthetic.wav',type:'audio/wav',size:44,arrayBuffer:()=>assert.fail('must not read')};
  for(const confirmations of [{syntheticConfirmed:false,processingConfirmed:true},{syntheticConfirmed:true,processingConfirmed:false}]){
    await assert.rejects(new AudioNotesClient(api).upload(context,{id:'test-record',revision:1},file,confirmations,'request-123'),code('INVALID_INPUT'));
  }
});

test('upload sends bounded file bytes and confirmations with existing account and origin headers',async()=>{
  const requests=[];
  const api=new LocalApiClient({fetch:async(path,options)=>{requests.push({path,options});return json({session});}});
  api.expectedUserId=context.user.userId;
  const bytes=new Uint8Array(44);bytes.set(new TextEncoder().encode('RIFF'));bytes.set(new TextEncoder().encode('WAVE'),8);
  const file=new File([bytes],'synthetic.wav',{type:'audio/wav'});
  const result=await new AudioNotesClient(api).upload(context,{id:'test-record',revision:1},file,
    {syntheticConfirmed:true,processingConfirmed:true},'request-123');
  assert.equal(result.id,session.id);assert.equal(requests.length,1);
  assert.equal(requests[0].path,'/api/local/centers/test-center/conversations/test-room/records/test-record/audio-notes');
  assert.equal(requests[0].options.headers['X-Carebridge-Account'],context.user.userId);
  assert.equal(requests[0].options.headers['X-Carebridge-Request'],'1');
  assert.equal(requests[0].options.redirect,'error');assert.equal(requests[0].options.credentials,'same-origin');
  const body=JSON.parse(requests[0].options.body);
  assert.equal(body.syntheticConfirmed,true);assert.equal(body.processingConfirmed,true);assert.equal(body.expectedRevision,1);
  assert.deepEqual(Buffer.from(body.base64,'base64'),Buffer.from(bytes));
  assert(!requests[0].path.includes('start'),'upload must not generate');
});

test('account switch or cancellation during file reading prevents uploading',async()=>{
  for(const action of ['switch','cancel']){
    const gate=deferred(),controller=new AbortController();let calls=0;
    const api={expectedUserId:context.user.userId,roomPath:()=>'/api/local/room',fetch:async()=>{calls++;return json({session});}};
    const file={name:'synthetic.wav',type:'audio/wav',size:44,arrayBuffer:()=>gate.promise};
    const pending=new AudioNotesClient(api).upload(context,{id:'test-record',revision:1},file,
      {syntheticConfirmed:true,processingConfirmed:true},'request-123',controller.signal);
    if(action==='switch')api.expectedUserId='another-user';else controller.abort();gate.resolve(new ArrayBuffer(44));
    await assert.rejects(pending,code(action==='switch'?'AUTH_REQUIRED':'CANCELLED'));assert.equal(calls,0);
  }
});

test('start uses the session revision and rejects a different returned session',async()=>{
  const requests=[];const api={expectedUserId:context.user.userId,roomPath:()=>'/api/local/room',request:async(path,options)=>{
    requests.push({path,...options});return {session:{...session,id:'other-audio'}};
  }};
  await assert.rejects(new AudioNotesClient(api).change(context,{...session,revision:4},'start','request-456'),code('INVALID_RESPONSE'));
  assert.deepEqual(requests[0].body,{expectedRevision:4,requestId:'request-456'});
});

test('original download never trusts a wrong content type or oversized Content-Length',async()=>{
  for(const headers of [{'Content-Type':'text/html','Content-Length':'44'},{'Content-Type':'application/octet-stream','Content-Length':'50000000'}]){
    let bodyRead=false;const api={expectedUserId:context.user.userId,roomPath:()=>'/api/local/room',fetch:async()=>({ok:true,headers:new Headers(headers),arrayBuffer:()=>{bodyRead=true;return new ArrayBuffer(44);}})};
    await assert.rejects(new AudioNotesClient(api).original(context,session),code('INVALID_RESPONSE'));assert.equal(bodyRead,false);
  }
});

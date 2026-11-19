import assert from 'node:assert/strict';
import {before,after,beforeEach,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {newWebChatDemo,setupWebChatDemo} from '../web-chat-setup.mjs';
import {setupWebChatMedia,inspectWebChatMedia} from '../web-chat-media-setup.mjs';
import {WebChatMedia} from '../web-chat-media.mjs';
import {Conversations} from '../conversations.mjs';
import {prototypeMediaFiles} from '../prototype-media-assets.mjs';

let db,demo,runtime,media,chat,therapist,guardian;
const [photo,video]=prototypeMediaFiles();
const hasCode=code=>error=>error.code===code;
const upload=(actor=therapist,file=photo,clientId=randomUUID())=>media.upload(actor,{conversationId:demo.roomId,clientId,type:file.type,bytes:file.bytes});
const send=(actor,files,extra={})=>media.send(actor,{conversationId:demo.roomId,clientId:randomUUID(),body:'',attachments:files.map(file=>({id:file.id})),...extra});
const content=(actor,file)=>media.content(actor,{conversationId:demo.roomId,attachmentId:file.id});
const row=async file=>(await db.query('SELECT state,content,bound_message_id FROM carebridge_web.attachments WHERE id=$1',[file.id])).rows[0];

before(async()=>{
  db=await PGlite.create(); await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
  demo=newWebChatDemo(); await setupWebChatDemo(db,demo);
  await setupWebChatMedia(db,{centerId:demo.centerId,runtimeRole:demo.role});
  runtime={transaction:work=>db.transaction(async tx=>{await tx.exec(`SET LOCAL ROLE "${demo.role}"`);return work(tx);})};
  media=new WebChatMedia(runtime);chat=new Conversations(runtime);
  therapist={centerId:demo.centerId,userId:demo.accounts[0].userId};
  guardian={centerId:demo.centerId,userId:demo.accounts[1].userId};
});
after(async()=>{await db?.close();});
beforeEach(async()=>{
  await db.exec('TRUNCATE public.cb_messages,carebridge_web.attachments,carebridge_web.message_requests CASCADE');
  await db.query('UPDATE carebridge_web.center_limits SET limit_bytes=104857600 WHERE center_id=$1',[demo.centerId]);
  await db.query('UPDATE public.cb_users SET active=true WHERE id=ANY($1::text[])',[demo.accounts.map(account=>account.userId)]);
  await db.query('UPDATE public.cb_participants SET first_sequence=1 WHERE center_id=$1',[demo.centerId]);
});

test('both roles upload, bind and read private photo/video bytes across service instances',async()=>{
  const image=await upload(),movie=await upload(guardian,video);
  assert.equal(image.name,'carebridge-photo.png');assert.equal(movie.name,'carebridge-video.mp4');
  await assert.rejects(content(therapist,image),hasCode('ATTACHMENT_NOT_FOUND'));
  const pictureMessage=await send(therapist,[image]),videoMessage=await send(guardian,[movie]);
  assert.equal(pictureMessage.body,'사진 1개');assert.equal(videoMessage.body,'동영상 1개');
  assert.equal(pictureMessage.webAttachments[0].id,image.id);
  assert.deepEqual(pictureMessage.attachments,[]);
  assert.deepEqual((await content(guardian,image)).bytes,photo.bytes);
  assert.deepEqual((await content(therapist,movie)).bytes,video.bytes);
  const page=await chat.list(guardian,{conversationId:demo.roomId});
  const decorated=await new WebChatMedia(runtime).decorate(guardian,{conversationId:demo.roomId,messages:page.messages});
  assert.deepEqual(decorated.map(message=>message.webAttachments[0].id),[image.id,movie.id]);
  const serialized=JSON.stringify(decorated);
  for(const privateKey of ['sha256','content','object_key','owner_id']) assert(!serialized.includes('"'+privateKey+'"'));
});

test('upload/send retries are idempotent and changed bytes, text or attachment lists conflict',async()=>{
  const uploadRequest=randomUUID(),image=await upload(therapist,photo,uploadRequest);
  assert.equal((await upload(therapist,photo,uploadRequest)).id,image.id);
  await assert.rejects(upload(therapist,video,uploadRequest),hasCode('IDEMPOTENCY_CONFLICT'));
  const clientId=randomUUID(),message=await send(therapist,[image],{clientId,body:'가상 사진'});
  const replay=await send(therapist,[image],{clientId,body:'가상 사진'});
  assert.equal(replay.id,message.id);
  await assert.rejects(send(therapist,[],{clientId,body:'가상 사진'}),hasCode('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(send(therapist,[image],{clientId,body:'다른 설명'}),hasCode('IDEMPOTENCY_CONFLICT'));
  const plainId=randomUUID();await chat.sendText(therapist,{conversationId:demo.roomId,clientId:plainId,body:'기존 문자'});
  const other=await upload();
  await assert.rejects(send(therapist,[other],{clientId:plainId,body:'기존 문자'}),hasCode('IDEMPOTENCY_CONFLICT'));
  assert.equal((await db.query('SELECT count(*) AS n FROM public.cb_messages')).rows[0].n,2);
});

test('another sender cannot bind an upload and unrelated or disabled accounts cannot read content',async()=>{
  const image=await upload();
  await assert.rejects(send(guardian,[image]),hasCode('ATTACHMENT_NOT_FOUND'));
  await send(therapist,[image]);
  await assert.rejects(content({...guardian,userId:'unrelated-user'},image),hasCode('NOT_FOUND'));
  await assert.rejects(media.content(guardian,{conversationId:'another-room',attachmentId:image.id}),hasCode('NOT_FOUND'));
  await db.query('UPDATE public.cb_users SET active=false WHERE id=$1',[guardian.userId]);
  await assert.rejects(content(guardian,image),hasCode('NOT_FOUND'));
  await assert.rejects(upload(guardian),hasCode('NOT_FOUND'));
});

test('self-hidden and deleted messages revoke attachment access without owner bypass',async()=>{
  const image=await upload(),message=await send(therapist,[image]);
  await chat.deleteText(guardian,{conversationId:demo.roomId,messageId:message.id,clientId:randomUUID(),scope:'self',confirmed:true});
  await assert.rejects(content(guardian,image),hasCode('NOT_FOUND'));
  assert.deepEqual((await content(therapist,image)).bytes,photo.bytes);
  await chat.deleteText(therapist,{conversationId:demo.roomId,messageId:message.id,clientId:randomUUID(),scope:'all',confirmed:true,expectedRevision:1});
  await assert.rejects(content(therapist,image),hasCode('ATTACHMENT_NOT_FOUND'));
  const hidden=await chat.get(therapist,{conversationId:demo.roomId,messageId:message.id});
  assert.deepEqual((await media.decorate(therapist,{conversationId:demo.roomId,messages:[hidden]}))[0].webAttachments,[]);
});

test('a later history boundary hides shared files and prevents reuse of uploads from the prior assignment',async()=>{
  const clientId=randomUUID(),pending=await upload(guardian,photo,clientId),image=await upload();
  const message=await send(therapist,[image]);
  await db.query('UPDATE public.cb_participants SET first_sequence=$3 WHERE center_id=$1 AND user_id=$2',[demo.centerId,guardian.userId,message.sequence+1]);
  await assert.rejects(content(guardian,image),hasCode('NOT_FOUND'));
  await assert.rejects(send(guardian,[pending]),hasCode('ATTACHMENT_NOT_FOUND'));
  await assert.rejects(upload(guardian,photo,clientId),hasCode('ATTACHMENT_NOT_FOUND'));
  assert.deepEqual((await media.decorate(guardian,{conversationId:demo.roomId,messages:[message]}))[0].webAttachments,[]);
});

test('binding failure rolls back the new message and keeps uploaded bytes pending',async()=>{
  const image=await upload();
  await db.exec(`CREATE FUNCTION carebridge_web.test_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$;
    CREATE TRIGGER test_fail_receipt BEFORE INSERT ON carebridge_web.message_requests FOR EACH ROW EXECUTE FUNCTION carebridge_web.test_fail_receipt();`);
  try {await assert.rejects(send(therapist,[image]));}
  finally {await db.exec('DROP TRIGGER test_fail_receipt ON carebridge_web.message_requests; DROP FUNCTION carebridge_web.test_fail_receipt()');}
  assert.equal((await row(image)).state,'pending');
  assert.equal((await db.query('SELECT count(*) AS n FROM public.cb_messages')).rows[0].n,0);
  assert.equal((await send(therapist,[image])).webAttachments.length,1);
});

test('capacity, pending-count and file-count limits reject before additional data is committed',async()=>{
  await db.query('UPDATE carebridge_web.center_limits SET limit_bytes=$2 WHERE center_id=$1',[demo.centerId,photo.bytes.length]);
  const image=await upload();
  await assert.rejects(upload(),hasCode('MEDIA_STORAGE_FULL'));
  await media.discard(therapist,{conversationId:demo.roomId,attachmentId:image.id});
  assert.equal((await row(image)).content,null);
  await assert.rejects(send(therapist,[image]),hasCode('UPLOAD_EXPIRED'));
  await upload();
  await db.query('UPDATE carebridge_web.center_limits SET limit_bytes=104857600 WHERE center_id=$1',[demo.centerId]);
  const files=[];for(let i=0;i<7;i++)files.push(await upload());
  await assert.rejects(upload(),hasCode('MEDIA_LIMIT'));
  await assert.rejects(send(therapist,files.slice(0,5)),hasCode('MEDIA_LIMIT'));
  await assert.rejects(media.upload(therapist,{conversationId:demo.roomId,clientId:randomUUID(),type:'image/png',bytes:Buffer.alloc(3145729)}),hasCode('MEDIA_LIMIT'));
});

test('expiry releases only pending bytes and keeps their idempotency receipts',async()=>{
  const clientId=randomUUID(),pending=await upload(therapist,photo,clientId),bound=await upload();await send(therapist,[bound]);
  // Move fixture time through owner-only trigger suspension. Runtime lacks ALTER.
  await db.exec('ALTER TABLE carebridge_web.attachments DISABLE TRIGGER web_attachment_guard');
  try {await db.query("UPDATE carebridge_web.attachments SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=$1",[pending.id]);}
  finally {await db.exec('ALTER TABLE carebridge_web.attachments ENABLE TRIGGER web_attachment_guard');}
  await assert.rejects(send(therapist,[pending]),hasCode('UPLOAD_EXPIRED'));
  await upload();
  assert.equal((await row(pending)).state,'expired');assert.equal((await row(pending)).content,null);
  await assert.rejects(upload(therapist,photo,clientId),hasCode('UPLOAD_EXPIRED'));
  assert.deepEqual((await content(guardian,bound)).bytes,photo.bytes);
});

test('runtime and data API roles cannot change manifests, private policy, bound bytes or delete receipts',async()=>{
  const image=await upload();await send(therapist,[image]);
  assert.equal((await inspectWebChatMedia(db,{centerId:demo.centerId,runtimeRole:demo.role})).passed,true);
  await assert.rejects(runtime.transaction(tx=>tx.query('UPDATE carebridge_web.attachments SET size=1 WHERE id=$1',[image.id])),hasCode('42501'));
  await assert.rejects(runtime.transaction(tx=>tx.query('DELETE FROM carebridge_web.attachments WHERE id=$1',[image.id])),hasCode('42501'));
  await assert.rejects(runtime.transaction(tx=>tx.exec('UPDATE carebridge_web.center_limits SET limit_bytes=1')),hasCode('42501'));
  await assert.rejects(runtime.transaction(tx=>tx.query("UPDATE carebridge_web.attachments SET state='discarded',content=NULL WHERE id=$1",[image.id])),hasCode('23514'));
  for(const role of ['anon','authenticated','service_role']) await assert.rejects(db.transaction(async tx=>{
    await tx.exec(`SET LOCAL ROLE ${role}`);await tx.exec('SELECT content FROM carebridge_web.attachments');
  }),hasCode('42501'));
});

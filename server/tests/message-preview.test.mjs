import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../migrate.mjs';
import { Conversations } from '../conversations.mjs';
import { MediaUploads } from '../media-uploads.mjs';
import { Relationships } from '../relationships.mjs';
import { Records } from '../records.mjs';
import { RepositoryError } from '../errors.mjs';
import { configureSyntheticMediaPolicy } from '../media-resource-test-policy.mjs';
import { evidenceForManifest, sealFixture } from '../media-storage-test-evidence.mjs';
import { localMessageView } from '../local-care-http.mjs';
import { LocalApiClient } from '../../local-api/client.js';

// In-memory PostgreSQL and invented metadata ONLY. No bytes, file storage,
// decoder, malware scan, HTTP endpoint, real identity, or clinical proof.
let db, chat, uploads, relationships, records;
const center = 'preview-center', room = 'preview-room';
const guardian = { centerId:center, userId:'preview-guardian' };
const therapist = { centerId:center, userId:'preview-therapist' };
const peer = { centerId:center, userId:'preview-peer' };
const newcomer = { centerId:center, userId:'preview-new' };
const manager = { centerId:center, userId:'preview-manager' };
const foreign = { centerId:'preview-foreign', userId:'preview-outsider' };
const noFileIO = () => assert.fail('Metadata-only projection tests must not access file bytes.');
const code = (expected) => (error) => error instanceof RepositoryError && error.code === expected;
const send = (extra = {}, actor = guardian) => chat.sendText(actor, {
  conversationId:room, clientId:randomUUID(), body:'합성 답변', ...extra,
});
const get = (message, actor = therapist) => chat.get(actor, { conversationId:room, messageId:message.id });
const list = (actor = therapist) => chat.list(actor, { conversationId:room });
const home = async (actor = therapist) => (await chat.inbox(actor)).rooms.find((entry) => entry.conversationId === room);
const edit = (message, body, expectedRevision = 1) => chat.editText(guardian, {
  conversationId:room, messageId:message.id, clientId:randomUUID(), expectedRevision, body,
});
const remove = (message, scope, actor = guardian, expectedRevision = 1) => chat.deleteText(actor, {
  conversationId:room, messageId:message.id, clientId:randomUUID(), expectedRevision, scope, confirmed:true,
});
async function replaceGuardians(selection) {
  const current = await relationships.get(manager,{ conversationId:room });
  return relationships.replace(manager,{ conversationId:room, clientId:randomUUID(), expectedVersion:current.version,
    historyConfirmed:true, therapist:{ userId:therapist.userId, history:'preserve' }, guardians:selection });
}
function noPrivateFileData(value, files) {
  const encoded = JSON.stringify(value);
  for (const file of files) for (const secret of [file.id,file.name,file.object_key,file.candidate_key,file.sha256]) {
    assert.ok(secret, 'the synthetic fixture has each protected value');
    assert.equal(encoded.includes(secret),false,'display summaries must not grant or identify a file');
  }
  assert.doesNotMatch(encoded,/"(?:attachments|attachmentTypes|quoteAttachmentTypes|attachment_types|quote_attachment_types|object_key|candidate_key|url|downloadUrl|name)"/);
}
async function databaseSnapshot() {
  // All application tables, not only read cursors: projections must not append
  // audit rows, alter immutable versions, or change relation/attachment state.
  const tables = (await db.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'cb_%' ORDER BY tablename`)).rows;
  const result = {};
  for (const { tablename } of tables) {
    assert.match(tablename,/^cb_[a-z_]+$/);
    result[tablename] = (await db.query(`SELECT to_jsonb(t) AS row FROM ${tablename} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}
async function manifestOnly(type, actor = guardian) {
  const pending = await uploads.reserve(actor, { conversationId:room, clientId:randomUUID(),
    file:{ name:`SYNTHETIC-PRIVATE-${type.startsWith('image/') ? 'PHOTO.png' : 'VIDEO.webm'}`,
      type, size:64, sha256:'a'.repeat(64) } });
  const input = (row) => ({ conversationId:room, uploadId:row.id, expectedVersion:row.version });
  const receiving = await uploads.claim(actor,input(pending),'receive');
  const quarantined = await uploads.settle(actor,room,receiving,{ state:'quarantined' });
  const inspecting = await uploads.claim(actor,input(quarantined),'inspect');
  return db.transaction((tx) => sealFixture(tx,inspecting,evidenceForManifest({ type, size:64, sha256:'a'.repeat(64) })));
}
async function attachmentMessage(types, body = '') {
  const files = [];
  for (const type of types) files.push(await manifestOnly(type));
  return { files, message:await send({ body, attachments:files.map(({ id }) => ({ id })) }) };
}

async function assertHiddenSendReceipt(input, sent, files = []) {
  await remove(sent, 'self');
  const before = await databaseSnapshot();
  for (let attempt = 0; attempt < 2; attempt++) {
    const receipt = await chat.sendText(guardian, input), projected = localMessageView(receipt);
    // Response-contract test only: real domain/SQL and actual HTTP DTO plus
    // browser decoder, but no HTTP listener, byte serving or native approval.
    const client = new LocalApiClient({ fetch: async () => new Response(JSON.stringify({ message: projected }), {
      status: 201, headers: { 'Content-Type': 'application/json' },
    }) });
    const accepted = await client.send(center, room, { clientId: input.clientId, body: input.body });
    assert.equal(accepted.id, sent.id); assert.equal(accepted.sequence, sent.sequence);
    assert.equal(accepted.authorId, null); assert.equal(accepted.createdAt, sent.createdAt); assert.equal(accepted.read, false);
    assert.equal(accepted.hidden, true); assert.equal(accepted.body, '나에게서 삭제한 소식입니다.');
    assert.equal(accepted.attachmentCount, 0); assert.equal(accepted.canReply, false);
    assert.equal(accepted.canEdit, false); assert.equal(accepted.canDeleteAll, false); assert.equal(accepted.canHide, false);
    assert.deepEqual(receipt.attachments, []); assert.equal(Object.hasOwn(receipt, 'quote'), false);
    for (const key of ['quote', 'reviewNote', 'feedback', 'publication']) assert.equal(Object.hasOwn(accepted, key), false);
    for (const secret of [input.body, 'SYNTHETIC-PRIVATE-QUOTE', 'SYNTHETIC-PRIVATE-REVIEW', ...files.flatMap((f) => [f.id, f.name, f.object_key, f.candidate_key, f.sha256])].filter(Boolean))
      assert.equal(JSON.stringify({ receipt, accepted }).includes(secret), false, 'hidden receipt must not reveal source content or file identifiers');
    assert.deepEqual(await databaseSnapshot(), before, 'an exact hidden retry must not append messages, bindings, audit or sequence changes');
  }
  const count = await db.query('SELECT count(*)::int AS n FROM cb_messages WHERE center_id=$1 AND author_id=$2 AND client_id=$3', [center, guardian.userId, input.clientId]);
  assert.equal(count.rows[0].n, 1);
  await assert.rejects(get(sent, guardian), code('NOT_FOUND'));
  assert.equal((await get(sent, therapist)).body, input.body);
  await assert.rejects(chat.sendText(guardian, { ...input, body: 'different request contents' }), code('IDEMPOTENCY_CONFLICT'));
  await db.query('UPDATE cb_participants SET active=false WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3', [center, room, guardian.userId]);
  await assert.rejects(chat.sendText(guardian, input), code('NOT_FOUND'));
}

test('self-hidden text send receipt stays anonymous, complete and idempotent through the browser response decoder', async () => {
  const source = await send({ body: 'SYNTHETIC-PRIVATE-QUOTE' }, therapist);
  const input = { conversationId: room, clientId: randomUUID(), body: 'SYNTHETIC-PRIVATE-TEXT', replyTo: source.id, expectedReplyVersion: 1 };
  const sent = await chat.sendText(guardian, input);
  await chat.review(therapist, { conversationId: room, messageId: sent.id, note: 'SYNTHETIC-PRIVATE-REVIEW' });
  await assertHiddenSendReceipt(input, sent);
});

test('self-hidden photo/video send receipt reveals no attachment or quote while preserving one original binding', async () => {
  // SQL metadata fixture only: this test neither approves nor opens real bytes.
  const files = [await manifestOnly('image/png'), await manifestOnly('video/webm')];
  const source = await send({ body: 'SYNTHETIC-PRIVATE-QUOTE' }, therapist);
  const input = { conversationId: room, clientId: randomUUID(), body: '', attachments: files.map(({ id }) => ({ id })),
    replyTo: source.id, expectedReplyVersion: 1 };
  const sent = await chat.sendText(guardian, input);
  assert.equal(sent.attachments.length, 2); assert.equal(sent.quote.body, 'SYNTHETIC-PRIVATE-QUOTE');
  await assertHiddenSendReceipt(input, sent, files);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cb_message_attachments WHERE message_id=$1', [sent.id])).rows[0].n, 2);
});

before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers(id) VALUES ('preview-center'),('preview-foreign');
    INSERT INTO cb_users(id,active) VALUES ('preview-guardian',true),('preview-therapist',true),('preview-peer',true),
      ('preview-new',true),('preview-manager',true),('preview-outsider',true);
    INSERT INTO cb_memberships VALUES ('preview-center','preview-guardian','guardian',true),
      ('preview-center','preview-therapist','therapist',true),('preview-center','preview-peer','guardian',true),
      ('preview-center','preview-new','guardian',true),('preview-center','preview-manager','center',true),
      ('preview-foreign','preview-outsider','therapist',true);
    INSERT INTO cb_children VALUES ('preview-center','preview-child'),('preview-foreign','preview-other-child');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('preview-center','preview-room','preview-child'),
      ('preview-foreign','preview-other-room','preview-other-child');
    INSERT INTO cb_participants VALUES ('preview-center','preview-room','preview-guardian','guardian',true,1),
      ('preview-center','preview-room','preview-therapist','therapist',true,1),
      ('preview-center','preview-room','preview-peer','guardian',true,1),
      ('preview-foreign','preview-other-room','preview-outsider','therapist',true,1);
    INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES
      ('preview-center','preview-room','preview-goal','합성 목표','active');`);
  await configureSyntheticMediaPolicy(db,center);
  chat = new Conversations(db);
  uploads = new MediaUploads(db,{ write:noFileIO, openVerified:noFileIO, remove:noFileIO });
  relationships = new Relationships(db); records = new Records(db);
});

test('attachment-only quote keeps empty authored body and projects a photo count', async () => {
  const { message } = await attachmentMessage(['image/png']);
  const reply = await send({ replyTo:message.id, expectedReplyVersion:1 },therapist);
  const quote = (await get(reply)).quote;
  assert.equal(quote.body,'');
  assert.equal(quote.preview,'사진 1장');
});

test('photo, video and mixed summaries identify latest news and quotes without altering authored body or exposing file metadata', async () => {
  for (const [types,expected] of [
    [['image/png','image/jpeg'],'사진 2장'],
    [['video/webm'],'동영상 1개'],
    [['image/png','video/webm','image/jpeg'],'사진 2장 · 동영상 1개'],
  ]) {
    const { message,files } = await attachmentMessage(types,' \t ');
    const before = await databaseSnapshot();
    const latest = (await home()).latest;
    assert.equal(latest.body,expected); assert.equal(latest.id,message.id);
    assert.equal((await home()).targetId,message.id);
    const direct = await get(message), listed = (await list()).messages.find((row) => row.id === message.id);
    assert.equal(direct.body,''); assert.equal(listed.body,'');
    assert.deepEqual(direct.attachments.map(({ type }) => type),types);
    assert.deepEqual(listed.attachments,direct.attachments);
    noPrivateFileData(latest,files);
    assert.deepEqual(await databaseSnapshot(),before);
    const reply = await send({ replyTo:message.id, expectedReplyVersion:1 },therapist);
    const quote = (await get(reply)).quote;
    assert.equal(quote.body,''); assert.equal(quote.preview,expected);
    noPrivateFileData(quote,files);
    assert.equal((await db.query('SELECT body FROM cb_messages WHERE id=$1',[message.id])).rows[0].body,'');
    assert.equal((await db.query('SELECT body FROM cb_message_text_revisions WHERE message_id=$1 AND revision=1',[message.id])).rows[0].body,'');
  }
});

test('authored text takes priority and home preview truncates by Unicode code point at 120', async () => {
  const body = '😀한글'.repeat(60), { message,files } = await attachmentMessage(['image/png'],body);
  const latest = (await home()).latest;
  assert.equal(latest.body,Array.from(body).slice(0,120).join(''));
  assert.equal(Array.from(latest.body).length,120);
  noPrivateFileData(latest,files);
  const reply = await send({ replyTo:message.id, expectedReplyVersion:1 },therapist);
  const quote = (await get(reply)).quote;
  assert.equal(quote.body,body); assert.equal(quote.preview,body);
  assert.equal((await get(message)).body,body);
  noPrivateFileData(quote,files);
});

test('empty pinned original stays a photo summary after text edit, while new replies use the selected current version', async () => {
  const { message,files } = await attachmentMessage(['image/png']);
  const originalReply = await send({ replyTo:message.id, expectedReplyVersion:1 },therapist);
  const authoredRows = (await db.query('SELECT to_jsonb(m) AS row FROM cb_messages m ORDER BY id')).rows;
  await edit(message,'수정한 합성 본문');
  const oldQuote = (await get(originalReply)).quote;
  assert.equal(oldQuote.body,''); assert.equal(oldQuote.preview,'사진 1장');
  assert.equal(oldQuote.version,1); assert.equal(oldQuote.changed,true);
  const snapshot = await databaseSnapshot();
  await assert.rejects(send({ replyTo:message.id, expectedReplyVersion:1 },therapist),code('MESSAGE_CONFLICT'));
  await assert.rejects(edit(message,'오래된 수정',1),code('MESSAGE_CONFLICT'));
  assert.deepEqual(await databaseSnapshot(),snapshot);
  const freshReply = await send({ replyTo:message.id, expectedReplyVersion:2 },therapist);
  const freshQuote = (await get(freshReply)).quote;
  assert.equal(freshQuote.body,'수정한 합성 본문'); assert.equal(freshQuote.preview,'수정한 합성 본문');
  assert.equal(freshQuote.version,2); assert.equal(freshQuote.changed,false);
  assert.equal((await home()).latest.body,'합성 답변');
  const existingRows = (await db.query('SELECT to_jsonb(m) AS row FROM cb_messages m WHERE id=ANY($1::text[]) ORDER BY id',
    [authoredRows.map(({ row }) => row.id)])).rows;
  assert.deepEqual(existingRows,authoredRows);
  noPrivateFileData(oldQuote,files); noPrivateFileData(freshQuote,files);
});

test('text edited to attachment-only keeps older quoted text and adds counts only to new-version quotes', async () => {
  const { message,files } = await attachmentMessage(['video/webm'],'답변 당시 합성 본문');
  const oldReply = await send({ replyTo:message.id, expectedReplyVersion:1 },therapist);
  await edit(message,'');
  const oldQuote = (await get(oldReply)).quote;
  assert.equal(oldQuote.body,'답변 당시 합성 본문'); assert.equal(oldQuote.preview,oldQuote.body);
  assert.equal(oldQuote.changed,true);
  const freshReply = await send({ replyTo:message.id, expectedReplyVersion:2 },therapist);
  const freshQuote = (await get(freshReply)).quote;
  assert.equal(freshQuote.body,''); assert.equal(freshQuote.preview,'동영상 1개');
  noPrivateFileData(freshQuote,files);
});

test('self-hide redacts only the current viewer quote and summary without resurrecting file counts', async () => {
  const { message,files } = await attachmentMessage(['image/png','video/webm']);
  const reply = await send({ replyTo:message.id, expectedReplyVersion:1 },therapist);
  await remove(message,'self',therapist);
  await assert.rejects(get(message),code('NOT_FOUND'));
  const quote = (await get(reply)).quote;
  assert.equal(quote.hidden,true); assert.equal(quote.body,'열람할 수 없는 이전 소식입니다.');
  assert.doesNotMatch(JSON.stringify(quote),/사진|동영상/); noPrivateFileData(quote,files);
  assert.equal((await get(reply,guardian)).quote.preview,'사진 1장 · 동영상 1개');
  assert.equal((await list()).messages.some((row) => row.id === message.id),false);
  await remove(reply,'self',therapist);
  assert.equal((await home()).latest,null);
});

test('all-delete returns anonymous redaction without counts or private notes and keeps independent replies', async () => {
  const { message,files } = await attachmentMessage(['image/png','video/webm']);
  await chat.review(therapist,{ conversationId:room, messageId:message.id, note:'SYNTHETIC-PRIVATE-REVIEW' });
  const reply = await send({ replyTo:message.id, expectedReplyVersion:1 },therapist);
  await remove(message,'all');
  for (const actor of [guardian,therapist,peer]) {
    const tombstone = await get(message,actor), independent = await get(reply,actor);
    assert.equal(tombstone.deleted,true); assert.equal(tombstone.authorId,null);
    assert.equal(tombstone.body,'삭제된 소식입니다.'); assert.deepEqual(tombstone.attachments,[]);
    assert.notEqual(tombstone.reviewed,true);
    assert.equal(independent.body,'합성 답변'); assert.equal(independent.quote.hidden,true);
    assert.equal(independent.quote.body,'삭제된 소식입니다.');
    assert.doesNotMatch(JSON.stringify(independent.quote),/사진|동영상|SYNTHETIC-PRIVATE/);
    assert.doesNotMatch(JSON.stringify(tombstone),/SYNTHETIC-PRIVATE/);
    noPrivateFileData(independent.quote,files);
  }
  await remove(reply,'self',therapist);
  const latest = (await home()).latest;
  assert.equal(latest.body,'삭제된 소식입니다.'); assert.equal(latest.authorId,null);
  assert.equal(latest.deleted,true);
  noPrivateFileData(latest,files);
  assert.equal((await db.query('SELECT note FROM cb_message_reviews WHERE message_id=$1',[message.id])).rows[0].note,'SYNTHETIC-PRIVATE-REVIEW');
});

test('new and reconnected future-only participants cannot recover older attachment summaries through later replies', async () => {
  const { message,files } = await attachmentMessage(['image/png','video/webm']);
  const keepGuardian = { userId:guardian.userId, history:'preserve' };
  await replaceGuardians([keepGuardian]);
  for (const actor of [peer,newcomer,manager,foreign,{ ...guardian,centerId:foreign.centerId }]) {
    await assert.rejects(get(message,actor),code('NOT_FOUND'));
    await assert.rejects(list(actor),code('NOT_FOUND'));
  }
  assert.equal((await home(peer)),undefined);
  await replaceGuardians([keepGuardian,{ userId:peer.userId, history:'from_now' },{ userId:newcomer.userId, history:'from_now' }]);
  for (const actor of [peer,newcomer]) assert.equal((await home(actor)).latest,null);
  const reply = await send({ replyTo:message.id, expectedReplyVersion:1 },therapist);
  for (const actor of [peer,newcomer]) {
    const quote = (await get(reply,actor)).quote;
    assert.equal(quote.hidden,true); assert.equal(quote.body,'열람할 수 없는 이전 소식입니다.');
    assert.equal('authorId' in quote,false); assert.equal('version' in quote,false);
    assert.doesNotMatch(JSON.stringify(quote),/사진|동영상/); noPrivateFileData(quote,files);
    await assert.rejects(get(message,actor),code('NOT_FOUND'));
    assert.equal((await home(actor)).latest.body,'합성 답변');
    assert.equal((await list(actor)).messages.length,1);
  }
  assert.equal((await get(reply,guardian)).quote.preview,'사진 1장 · 동영상 1개');
});

test('guardian sees only a current-revision review boolean; private notes stay therapist-only and edits reset the flag', async () => {
  const message = await send({ body:'합성 확인 대상' });
  for (const actor of [guardian,peer,therapist]) assert.equal((await get(message,actor)).reviewed,false);
  const privateNote = 'SYNTHETIC-PRIVATE-REVIEW';
  await chat.review(therapist,{ conversationId:room, messageId:message.id, note:privateNote });
  for (const actor of [guardian,peer]) {
    for (const row of [await get(message,actor),(await list(actor)).messages.find((value) => value.id === message.id)]) {
      assert.equal(row.reviewed,true);
      for (const field of ['reviewNote','reviewedAt','reviewChanged']) assert.equal(field in row,false);
      assert.equal(JSON.stringify(row).includes(privateNote),false);
    }
    assert.equal(JSON.stringify(await home(actor)).includes(privateNote),false);
  }
  const privateProjection = await get(message);
  assert.equal(privateProjection.reviewed,true); assert.equal(privateProjection.reviewNote,privateNote);
  await edit(message,'합성 수정 본문');
  for (const actor of [guardian,peer,therapist]) assert.equal((await get(message,actor)).reviewed,false);
  assert.equal((await get(message)).reviewChanged,true); assert.equal((await get(message)).reviewNote,privateNote);
  await assert.rejects(chat.review(therapist,{ conversationId:room, messageId:message.id, note:'stale', expectedRevision:1 }),code('MESSAGE_CONFLICT'));
  await chat.review(therapist,{ conversationId:room, messageId:message.id, note:'SYNTHETIC-PRIVATE-CURRENT', expectedRevision:2 });
  for (const actor of [guardian,peer,therapist]) assert.equal((await get(message,actor)).reviewed,true);
});

test('get, list and inbox projections do not write any application table or expose private data through replies', async () => {
  const { message,files } = await attachmentMessage(['image/png','video/webm']);
  const reply = await send({ replyTo:message.id, expectedReplyVersion:1 },therapist);
  await chat.review(therapist,{ conversationId:room, messageId:message.id, note:'SYNTHETIC-PRIVATE-CHECK' });
  const before = await databaseSnapshot();
  for (const actor of [guardian,peer,therapist]) {
    const direct = await get(message,actor), replyView = await get(reply,actor), page = await list(actor), inbox = await home(actor);
    assert.equal(direct.reviewed,true); assert.equal(replyView.quote.preview,'사진 1장 · 동영상 1개');
    noPrivateFileData(replyView.quote,files); noPrivateFileData(inbox.latest,files);
    assert.doesNotMatch(JSON.stringify(replyView.quote),/SYNTHETIC-PRIVATE-CHECK|reviewNote|reviewedAt/);
    assert.equal(page.messages.length,2);
  }
  assert.deepEqual(await databaseSnapshot(),before);
});

test('withdrawn shared media keeps a fixed guardian quote while an authorized therapist retains the shared title', async () => {
  const file = await manifestOnly('image/png',therapist), recordId = 'preview-shared-record';
  await records.save(therapist,{ conversationId:room, recordId, clientId:randomUUID(), expectedRevision:0,
    content:{ date:'2026-10-08', goalId:'preview-goal', performed:'합성 관찰', title:'합성 공유 제목', summary:'합성 공유 요약',
      privateNote:'SYNTHETIC-PRIVATE-RECORD', attachments:[{ id:file.id,share:true }] } });
  const preview = await records.preview(therapist,{ conversationId:room, recordId });
  const publication = await records.publish(therapist,{ conversationId:room, recordId, clientId:randomUUID(),
    expectedRevision:preview.recordRevision, expectedRelationshipsVersion:preview.relationshipsVersion, recipientIds:preview.recipientIds });
  const reply = await send({ replyTo:publication.messageId });
  await chat.withdraw(therapist,{ conversationId:room, messageId:publication.messageId });
  for (const actor of [guardian,peer]) {
    const quote = (await get(reply,actor)).quote;
    assert.equal(quote.hidden,true); assert.equal(quote.body,'공유가 종료된 기록입니다.');
    assert.doesNotMatch(JSON.stringify(quote),/합성 공유|사진|SYNTHETIC-PRIVATE/);
    noPrivateFileData(quote,[file]);
    const card = await get({ id:publication.messageId },actor);
    assert.deepEqual(card.attachments,[]); assert.equal(card.body,'공유가 종료된 기록입니다.');
  }
  const retainedQuote = (await get(reply)).quote;
  assert.equal(retainedQuote.hidden,false); assert.equal(retainedQuote.body,'합성 공유 제목');
  assert.equal(retainedQuote.preview,'합성 공유 제목'); noPrivateFileData(retainedQuote,[file]);
});

test('display previews never replace an immutable clinical source body or its sealed attachments', async () => {
  const { message,files } = await attachmentMessage(['image/png','video/webm']);
  const recordId = 'preview-clinical-record';
  await records.save(therapist,{ conversationId:room, recordId, clientId:randomUUID(), expectedRevision:0,
    content:{ date:'2026-10-08', goalId:'preview-goal', performed:'합성 관찰', referenceMessageIds:[message.id],
      referenceTextRevisions:[{ messageId:message.id,revision:1 }] } });
  const original = await records.get(therapist,{ conversationId:room, recordId });
  assert.equal(original.referenceSources[0].body,'');
  const retainedFiles = structuredClone(original.referenceSources[0].attachments);
  assert.deepEqual(retainedFiles.map(({ id }) => id),files.map(({ id }) => id));
  await edit(message,'합성 후속 본문');
  await remove(message,'all',guardian,2);
  await remove(message,'self',therapist,3);
  await home(); await list();
  const retained = (await records.get(therapist,{ conversationId:room, recordId })).referenceSources[0];
  assert.equal(retained.body,''); assert.equal(retained.messageRevision,1);
  assert.deepEqual(retained.attachments,retainedFiles);
  assert.equal(retained.deleted,true); assert.equal(retained.hidden,true); assert.equal(retained.changed,true);
  assert.equal('preview' in retained,false);
  await assert.rejects(records.get(guardian,{ conversationId:room, recordId }),code('FORBIDDEN'));
});

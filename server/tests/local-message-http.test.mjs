import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { createServer, request } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Auth } from '../auth.mjs';
import { Conversations } from '../conversations.mjs';
import { Children } from '../profiles.mjs';
import { Records } from '../records.mjs';
import { Relationships } from '../relationships.mjs';
import { MediaUploads } from '../media-uploads.mjs';
import { configureSyntheticMediaPolicy } from '../media-resource-test-policy.mjs';
import { evidenceForManifest, sealFixture } from './media-storage-fixtures.mjs';
import { migrate } from '../migrate.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';

// Actual HTTP + fully migrated memory-only PGlite. All accounts/content are
// invented, with no environment, native E database, mail or public listener.
let db, auth, chat, records, server, options, origin, sessions;
const password = 'Synthetic message lifecycle only 2026!';
const guardian = { centerId: 'center-a', userId: 'guardian-a' };
const therapist = { centerId: 'center-a', userId: 'therapist-a' };
const manager = { centerId: 'center-a', userId: 'manager-a' };
const room = '/api/local/centers/center-a/conversations/room-a';
const at = (message) => `${room}/messages/${message.id}`;
const editInput = (extra = {}) => ({ clientId: 'message-edit-0001', expectedRevision: 1, body: '가상 수정 본문', ...extra });
const deleteInput = (extra = {}) => ({ clientId: 'message-delete-01', expectedRevision: 1, scope: 'all', confirmed: true, ...extra });
before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); server = null; }
});
beforeEach(async () => {
  sessions = new Map();
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('guardian-a',true),('therapist-a',true),('manager-a',true),
      ('stranger-a',true),('foreign-b',true),('therapist-new',true);
    INSERT INTO cb_memberships VALUES ('center-a','guardian-a','guardian',true),('center-a','therapist-a','therapist',true),
      ('center-a','manager-a','center',true),('center-a','stranger-a','guardian',true),
      ('center-b','foreign-b','therapist',true),('center-a','therapist-new','therapist',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES
      ('center-a','room-a','child-a'),('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1),
      ('center-a','room-a','guardian-a','guardian',true,1),('center-a','room-other','therapist-a','therapist',true,1),
      ('center-a','room-other','guardian-a','guardian',true,1),('center-b','room-b','foreign-b','therapist',true,1);
    INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ('center-a','room-a','goal-a','합성 목표','active');`);
  auth = new Auth(db, { password: { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } });
  for (const userId of ['guardian-a', 'therapist-a', 'manager-a', 'stranger-a', 'foreign-b'])
    await auth.provisionAccount({ userId, email: `${userId}@message.test`, password });
  chat = new Conversations(db); records = new Records(db);
  server = createServer(async (req, res) => { if (!await handleLocalApiRequest(req, res, options)) { res.writeHead(404); res.end(); } });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  options = { auth, conversations: chat, profiles: new Children(db), records, origin, cookieName: `cb_local_${randomBytes(16).toString('hex')}` };
});
function call(path, { cookie, method = 'GET', body, headers = {}, rawHeaders } = {}) {
  const requestHeaders = { ...(method === 'POST' ? { Origin: origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie, 'X-Carebridge-Account': sessions.get(cookie) } : {}), ...headers };
  for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === undefined) delete requestHeaders[key];
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: rawHeaders ?? requestHeaders, agent: false }, (res) => {
      const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : null });
      });
    });
    req.once('error', reject); req.setTimeout(8000, () => req.destroy(new Error('Synthetic HTTP request timed out.')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const post = (path, cookie, body, headers) => call(path, { cookie, body, headers, method: 'POST' });
function good(result, status = 200) { assert.equal(result.status, status, result.text); return result.json; }
function denied(result, status, code) {
  assert.equal(result.status, status, result.text); assert.equal(result.json.error, code);
  assert.deepEqual(Object.keys(result.json).sort(), ['error', 'message']); assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['access-control-allow-origin'], undefined); assert(!result.text.includes('PRIVATE-'));
}
async function login(userId = 'guardian-a') {
  const result = await post('/api/local/auth/login', null, { email: `${userId}@message.test`, password }); good(result);
  const cookie = result.headers['set-cookie'][0].split(';')[0]; sessions.set(cookie, userId); return cookie;
}
async function send(cookie, extra = {}) {
  return good(await post(`${room}/messages`, cookie, { clientId: randomUUID(), body: '가상 최초 원문', ...extra }), 201).message;
}
const get = async (message, cookie) => good(await call(at(message), { cookie })).message;
const page = async (cookie) => good(await call(`${room}/messages`, { cookie }));
const changes = async () => (await db.query('SELECT operation,message_revision FROM cb_message_change_requests ORDER BY occurred_at')).rows;
async function oldMessage(interval) {
  const id = randomUUID();
  await db.transaction(async (tx) => {
    const { rows } = await tx.query("UPDATE cb_conversations SET last_sequence=last_sequence+1 WHERE id='room-a' RETURNING last_sequence");
    await tx.query(`INSERT INTO cb_messages(center_id,conversation_id,id,sequence,author_id,client_id,request_hash,kind,body,created_at)
      VALUES ('center-a','room-a',$1,$2,'guardian-a',$3,$4,'text','가상 시간 경계',clock_timestamp()+$5::interval)`,
    [id, rows[0].last_sequence, randomUUID(), 'a'.repeat(64), interval]);
  });
  return { id };
}
async function approvedManifest() {
  await configureSyntheticMediaPolicy(db, 'center-a'); const never = () => { throw new Error('Metadata-only fixture forbids file IO.'); };
  const uploads = new MediaUploads(db, { write: never, openVerified: never, remove: never });
  const pending = await uploads.reserve(guardian, { conversationId: 'room-a', clientId: 'message-media-0001',
    file: { name: 'synthetic.png', type: 'image/png', size: 100, sha256: createHash('sha256').update('synthetic-manifest-only').digest('hex') } });
  const position = (row) => ({ conversationId: 'room-a', uploadId: row.id, expectedVersion: row.version });
  const receiving = await uploads.claim(guardian, position(pending), 'receive');
  const quarantined = await uploads.settle(guardian, 'room-a', receiving, { state: 'quarantined' });
  const inspecting = await uploads.claim(guardian, position(quarantined), 'inspect');
  return db.transaction((tx) => sealFixture(tx, inspecting, evidenceForManifest({ type: inspecting.type, size: inspecting.size, sha256: inspecting.sha256 })));
}

test('single-message GET returns only authorized public fields and server capabilities without marking it read', async () => {
  const g = await login(), t = await login('therapist-a'), message = await send(g);
  await chat.review(therapist, { conversationId: 'room-a', messageId: message.id, note: 'PRIVATE-REVIEW' });
  const before = await page(t), author = await get(message, g), peer = await get(message, t);
  assert.equal(author.canEdit, true); assert.equal(author.canDeleteAll, true); assert.equal(author.canHide, true);
  assert.equal(peer.canEdit, false); assert.equal(peer.canDeleteAll, false); assert.equal(peer.canHide, true);
  assert.equal(peer.reviewed, true); assert.equal(peer.body, message.body); assert(!JSON.stringify(peer).includes('PRIVATE-'));
  assert.equal((await page(t)).unread, before.unread); assert.equal((await page(t)).lastRead, before.lastRead);
});

test('edit appends a version, keeps send/sequence and preserves quoted and clinical selected originals', async () => {
  const g = await login(), t = await login('therapist-a'), message = await send(g);
  const reply = await send(t, { body: '독립 공개 답변', replyTo: message.id, expectedReplyVersion: 1 });
  await records.save(therapist, { conversationId: 'room-a', recordId: 'record-a', clientId: 'message-reference-01', expectedRevision: 0,
    content: { date: '2026-10-09', goalId: 'goal-a', performed: '합성 관찰', summary: '공유 요약', privateNote: 'PRIVATE-RECORD',
      referenceMessageIds: [message.id], referenceTextRevisions: [{ messageId: message.id, revision: 1 }] } });
  const original = (await db.query('SELECT * FROM cb_messages WHERE id=$1', [message.id])).rows;
  const originalRecord = (await db.query('SELECT * FROM cb_record_revisions')).rows;
  const before = await page(t), input = editInput();
  const receipt = good(await post(`${at(message)}/edit`, g, input)).receipt;
  assert.deepEqual(receipt, { messageId: message.id, revision: 2, operation: 'edit', replayed: false });
  assert.deepEqual(good(await post(`${at(message)}/edit`, g, input)).receipt, { ...receipt, replayed: true });
  const edited = await get(message, t); assert.equal(edited.version, 2); assert.equal(edited.body, input.body); assert.equal(edited.edited, true);
  assert.equal(edited.sequence, message.sequence); assert.equal((await page(t)).nextCursor, before.nextCursor);
  assert.equal(good(await call(`${room}/messages?expectedRevision=${before.revision}`, { cookie: t })).resetRequired, true);
  const quote = (await get(reply, t)).quote; assert.equal(quote.body, message.body); assert.equal(quote.version, 1); assert.equal(quote.changed, true);
  const record = good(await call(`${room}/records/record-a`, { cookie: t })).record;
  assert.equal(record.referenceSources[0].body, message.body); assert.equal(record.referenceSources[0].messageRevision, 1);
  assert.deepEqual((await db.query('SELECT * FROM cb_messages WHERE id=$1', [message.id])).rows, original);
  assert.deepEqual((await db.query('SELECT * FROM cb_record_revisions')).rows, originalRecord);
  denied(await post(`${room}/messages`, t, { clientId: 'stale-quote-0001', body: '새 답변', replyTo: message.id, expectedReplyVersion: 1 }), 409, 'MESSAGE_CONFLICT');
  denied(await post(`${at(message)}/edit`, g, editInput({ clientId: 'stale-edit-0001' })), 409, 'MESSAGE_CONFLICT');
  denied(await post(`${at(message)}/edit`, g, editInput({ body: '다른 재시도' })), 409, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await changes()).length, 1);
});

test('committed edit/delete retries after response loss or self-hide never resurrect deleted content', async () => {
  const g = await login(), t = await login('therapist-a'), original = { clientId: 'initial-send-0001', body: '삭제 전 가상 원문' };
  const message = await send(g, original), reply = await send(t, { body: '삭제와 별개인 답변', replyTo: message.id, expectedReplyVersion: 1 });
  const edit = editInput(), del = deleteInput({ expectedRevision: 2 });
  const edited = good(await post(`${at(message)}/edit`, g, edit)).receipt;
  const deleted = good(await post(`${at(message)}/delete`, g, del)).receipt;
  // Treat successful replies as lost, then resend their same immutable input.
  assert.deepEqual(good(await post(`${at(message)}/edit`, g, edit)).receipt, { ...edited, replayed: true });
  assert.deepEqual(good(await post(`${at(message)}/delete`, g, del)).receipt, { ...deleted, replayed: true });
  for (const cookie of [g, t]) {
    const tombstone = await get(message, cookie); assert.equal(tombstone.deleted, true); assert.equal(tombstone.hidden, true);
    assert.equal(tombstone.authorId, null); assert.equal(tombstone.canEdit, false); assert.equal(tombstone.canDeleteAll, false);
    assert.equal(tombstone.canHide, true); assert.equal(tombstone.canReply, false); assert.equal(tombstone.attachmentCount, 0);
    assert.equal(tombstone.body, '삭제된 소식입니다.'); assert(!JSON.stringify(tombstone).includes(original.body));
    const surviving = await get(reply, cookie); assert.equal(surviving.body, reply.body); assert.equal(surviving.quote.hidden, true);
  }
  assert.equal((await send(g, original)).deleted, true);
  denied(await post(`${at(message)}/edit`, g, editInput({ clientId: 'new-edit-deleted', expectedRevision: 3 })), 409, 'MESSAGE_DELETED');
  const hidden = good(await post(`${at(message)}/delete`, g, { clientId: 'hide-tombstone-01', scope: 'self', confirmed: true })).receipt;
  assert.equal(hidden.operation, 'self'); assert.equal(hidden.revision, 3);
  denied(await call(at(message), { cookie: g }), 404, 'NOT_FOUND');
  assert.equal(good(await post(`${at(message)}/edit`, g, edit)).receipt.replayed, true);
  assert.equal(good(await post(`${at(message)}/delete`, g, del)).receipt.replayed, true);
  assert.equal((await changes()).length, 3);
  assert.deepEqual((await db.query('SELECT revision,operation FROM cb_message_text_revisions WHERE message_id=$1 ORDER BY revision', [message.id])).rows,
    [{ revision: 1, operation: 'sent' }, { revision: 2, operation: 'edit' }, { revision: 3, operation: 'all' }]);
});

test('self-hide is viewer-only, removes unread/quote access, and retains clinical sources already captured', async () => {
  const g = await login(), t = await login('therapist-a'), message = await send(g);
  const reply = await send(g, { body: '독립 답변', replyTo: message.id, expectedReplyVersion: 1 });
  await records.save(therapist, { conversationId: 'room-a', recordId: 'record-a', clientId: 'hidden-reference-01', expectedRevision: 0,
    content: { date: '2026-10-09', goalId: 'goal-a', performed: '합성 관찰', referenceMessageIds: [message.id], referenceTextRevisions: [{ messageId: message.id, revision: 1 }] } });
  const before = await page(t), input = { clientId: 'hide-message-0001', scope: 'self', confirmed: true };
  const receipt = good(await post(`${at(message)}/delete`, t, input)).receipt;
  assert.deepEqual(good(await post(`${at(message)}/delete`, t, input)).receipt, { ...receipt, replayed: true });
  denied(await call(at(message), { cookie: t }), 404, 'NOT_FOUND');
  assert.equal((await page(t)).unread, before.unread - 1); assert.equal((await page(t)).messages.some((row) => row.id === message.id), false);
  assert.equal((await get(message, g)).body, message.body); assert.equal((await get(reply, t)).quote.hidden, true);
  assert.equal((await get(reply, g)).quote.body, message.body);
  const reference = good(await call(`${room}/records/record-a`, { cookie: t })).record.referenceSources[0];
  assert.equal(reference.body, message.body); assert.equal(reference.hidden, true);
  denied(await post(`${room}/read`, t, { messageId: message.id }), 404, 'NOT_FOUND');
  denied(await post(`${room}/messages`, t, { clientId: 'hidden-quote-001', body: '거부된 답변', replyTo: message.id, expectedReplyVersion: 1 }), 404, 'NOT_FOUND');
});

test('single-message and mutation routes retain exact source, session, account and duplicate-header checks', async () => {
  const g = await login(), t = await login('therapist-a'), message = await send(g);
  for (const path of [at(message), `${at(message)}/edit`, `${at(message)}/delete`]) {
    const mutation = path !== at(message), args = mutation ? { method: 'POST', body: path.endsWith('/edit') ? editInput() : deleteInput() } : {};
    denied(await call(path, args), 401, 'AUTH_REQUIRED');
    denied(await call(path, { ...args, cookie: g, headers: { 'X-Carebridge-Account': undefined } }), 401, 'AUTH_REQUIRED');
    denied(await call(path, { ...args, cookie: t, headers: { 'X-Carebridge-Account': guardian.userId } }), 401, 'AUTH_REQUIRED');
  }
  for (const headers of [{ Origin: 'https://attacker.test' }, { 'X-Carebridge-Request': undefined }, { Host: 'localhost:1234' }])
    denied(await post(`${at(message)}/edit`, g, editInput(), headers), 403, 'SOURCE_REJECTED');
  denied(await call(at(message), { cookie: g, headers: { 'Sec-Fetch-Site': 'cross-site' } }), 403, 'SOURCE_REJECTED');
  const base = ['Host', new URL(origin).host, 'Origin', origin, 'X-Carebridge-Request', '1', 'Content-Type', 'application/json', 'Cookie', g];
  denied(await call(`${at(message)}/delete`, { method: 'POST', body: deleteInput(), rawHeaders: [...base, 'X-Carebridge-Account', guardian.userId, 'X-Carebridge-Account', guardian.userId] }), 400, 'INVALID_INPUT');
  denied(await post(`${at(message)}/delete`, g, deleteInput(), { Cookie: `${g}; ${g}` }), 400, 'INVALID_INPUT');
  assert.equal((await changes()).length, 0); assert.equal((await get(message, g)).version, 1);
});

test('author, tenant, child assignment, active membership and history scope are rechecked for every operation', async () => {
  const g = await login(), t = await login('therapist-a'), message = await send(g);
  denied(await post(`${at(message)}/edit`, t, editInput()), 404, 'NOT_FOUND');
  denied(await post(`${at(message)}/delete`, t, deleteInput()), 404, 'NOT_FOUND');
  for (const userId of ['manager-a', 'stranger-a', 'foreign-b']) {
    const cookie = await login(userId);
    denied(await call(at(message), { cookie }), 404, 'NOT_FOUND');
    denied(await post(`${at(message)}/edit`, cookie, editInput()), 404, 'NOT_FOUND');
    denied(await post(`${at(message)}/delete`, cookie, deleteInput({ scope: 'self' })), 404, 'NOT_FOUND');
  }
  denied(await call(at(message).replace('room-a', 'room-other'), { cookie: g }), 404, 'NOT_FOUND');
  denied(await post(`${at(message).replace('room-a', 'room-other')}/delete`, g, deleteInput()), 404, 'NOT_FOUND');
  await db.query("UPDATE cb_memberships SET active=false WHERE center_id='center-a' AND user_id='guardian-a'");
  denied(await post(`${at(message)}/edit`, g, editInput()), 404, 'NOT_FOUND');
  await db.query("UPDATE cb_memberships SET active=true WHERE center_id='center-a' AND user_id='guardian-a'");
  const relationships = new Relationships(db), current = await relationships.get(manager, { conversationId: 'room-a' });
  await relationships.replace(manager, { conversationId: 'room-a', clientId: 'message-history-01', expectedVersion: current.version,
    historyConfirmed: true, therapist: { userId: 'therapist-new', history: 'from_now' }, guardians: [{ userId: guardian.userId, history: 'preserve' }] });
  const changed = await relationships.get(manager, { conversationId: 'room-a' });
  await relationships.replace(manager, { conversationId: 'room-a', clientId: 'message-history-02', expectedVersion: changed.version,
    historyConfirmed: true, therapist: { userId: therapist.userId, history: 'from_now' }, guardians: [{ userId: guardian.userId, history: 'preserve' }] });
  denied(await call(at(message), { cookie: t }), 404, 'NOT_FOUND');
  denied(await post(`${at(message)}/delete`, t, deleteInput({ scope: 'self' })), 404, 'NOT_FOUND');
  assert.equal((await changes()).length, 0);
});

test('the database clock controls the edit/all-delete window; self-hide remains allowed after expiry', async () => {
  const g = await login();
  for (const interval of ['-25 hours', '1 hour']) {
    const message = await oldMessage(interval), current = await get(message, g);
    assert.equal(current.canEdit, false); assert.equal(current.canDeleteAll, false); assert.equal(current.canHide, true);
    denied(await post(`${at(message)}/edit`, g, editInput({ clientId: randomUUID() })), 409, 'MESSAGE_CHANGE_EXPIRED');
    denied(await post(`${at(message)}/delete`, g, deleteInput({ clientId: randomUUID() })), 409, 'MESSAGE_CHANGE_EXPIRED');
    if (interval === '-25 hours')
      assert.equal(good(await post(`${at(message)}/delete`, g, { clientId: randomUUID(), scope: 'self', confirmed: true })).receipt.operation, 'self');
  }
  assert.deepEqual((await changes()).map((row) => row.operation), ['self']);
});

test('closed mutation schemas reject spoofing, attachments, malformed versions/text and unconfirmed deletion', async () => {
  const g = await login(), message = await send(g);
  for (const extra of [{ userId: guardian.userId }, { role: 'therapist' }, { messageId: message.id }, { conversationId: 'room-a' },
    { now: '2099-01-01' }, { attachments: [] }, { body: '' }, { body: '가상 최초 원문' }, { body: 42 }, { body: 'x'.repeat(2001) },
    { body: '\ud800' }, { body: 'test\u0000' }, { expectedRevision: 0 }, { expectedRevision: '1' }, { expectedRevision: 2147483648 }])
    denied(await post(`${at(message)}/edit`, g, editInput(extra)), 400, 'INVALID_INPUT');
  for (const extra of [{ confirmed: false }, { confirmed: 'true' }, { scope: 'device' }, { expectedRevision: 0 },
    { expectedRevision: undefined }, { body: 'extra' }, { attachments: [] }, { role: 'guardian' }])
    denied(await post(`${at(message)}/delete`, g, deleteInput(extra)), 400, 'INVALID_INPUT');
  denied(await post(`${at(message)}/edit`, g, { clientId: 'missing-revision', body: '내용' }), 400, 'INVALID_INPUT');
  denied(await post(`${at(message)}/delete`, g, { clientId: 'missing-confirm', scope: 'self' }), 400, 'INVALID_INPUT');
  denied(await post(`${at(message)}/edit`, g, editInput({ body: '가'.repeat(6000) })), 413, 'PAYLOAD_TOO_LARGE');
  for (const suffix of ['?revision=1', '?userId=guardian-a', '?limit=1&limit=1']) denied(await call(`${at(message)}${suffix}`, { cookie: g }), 400, 'INVALID_INPUT');
  for (const path of [`${at(message)}/`, `${at(message)}/review`, `${at(message)}/delete/all`]) denied(await call(path, { cookie: g }), 404, 'NOT_FOUND');
  denied(await call(`${at(message)}/edit`, { cookie: g }), 404, 'NOT_FOUND');
  denied(await call(at(message), { cookie: g, method: 'DELETE' }), 404, 'NOT_FOUND');
  assert.equal((await changes()).length, 0);
});

test('public cards can be read but cannot use text edit/delete or client-forged capabilities', async () => {
  const g = await login(), t = await login('therapist-a');
  const card = await chat.publishSnapshot(therapist, { conversationId: 'room-a', clientId: 'public-card-0001', recordId: 'legacy-record', title: '공개 제목', summary: '공개 요약' });
  const view = await get(card, g); assert.equal(view.publication.summary, '공개 요약');
  assert.equal(view.canEdit, false); assert.equal(view.canDeleteAll, false); assert.equal(view.canHide, false);
  denied(await post(`${at(card)}/edit`, t, editInput()), 400, 'INVALID_INPUT');
  denied(await post(`${at(card)}/delete`, t, deleteInput()), 400, 'INVALID_INPUT');
  denied(await post(`${at(card)}/delete`, g, deleteInput({ scope: 'self' })), 400, 'INVALID_INPUT');
  assert.equal((await changes()).length, 0);
});

test('editing existing attachment captions never replaces immutable files and allows attachment-only content without exposing paths', async () => {
  const g = await login(), t = await login('therapist-a'), file = await approvedManifest();
  const message = await chat.sendText(guardian, { conversationId: 'room-a', clientId: 'attached-send-0001', body: '첨부 설명', attachments: [{ id: file.id }] });
  const original = (await db.query('SELECT * FROM cb_message_attachments WHERE message_id=$1', [message.id])).rows;
  good(await post(`${at(message)}/edit`, g, editInput({ body: '' })));
  const current = await get(message, t); assert.equal(current.body, ''); assert.equal(current.attachmentCount, 1);
  assert(!JSON.stringify(current).includes(file.id)); assert(!JSON.stringify(current).includes('object_key'));
  assert.deepEqual((await db.query('SELECT * FROM cb_message_attachments WHERE message_id=$1', [message.id])).rows, original);
  denied(await post(`${at(message)}/edit`, g, editInput({ clientId: 'replace-file-0001', expectedRevision: 2, attachments: [] })), 400, 'INVALID_INPUT');
  good(await post(`${at(message)}/delete`, g, deleteInput({ expectedRevision: 2 })));
  assert.equal((await get(message, t)).attachmentCount, 0);
  assert.deepEqual((await db.query('SELECT * FROM cb_message_attachments WHERE message_id=$1', [message.id])).rows, original);
});

test('unexpected service failures and injected private receipt fields do not enter public errors or receipts', async () => {
  const g = await login(), message = await send(g), realEdit = chat.editText.bind(chat);
  chat.editText = async (...args) => ({ ...await realEdit(...args), privateNote: 'PRIVATE-INTERNAL', object_key: 'PRIVATE-PATH', token: 'PRIVATE-TOKEN' });
  const result = await post(`${at(message)}/edit`, g, editInput()); good(result); assert(!result.text.includes('PRIVATE-'));
  assert.deepEqual(Object.keys(result.json.receipt).sort(), ['messageId', 'operation', 'replayed', 'revision']);
  chat.get = async () => { throw Object.assign(new Error('PRIVATE-DATABASE'), { code: 'MESSAGE_CONFLICT', token: 'PRIVATE-TOKEN' }); };
  denied(await call(at(message), { cookie: g }), 503, 'LOCAL_API_UNAVAILABLE');
  chat.deleteText = async () => { throw new Error('PRIVATE-DATABASE'); };
  denied(await post(`${at(message)}/delete`, g, deleteInput({ expectedRevision: 2 })), 503, 'LOCAL_API_UNAVAILABLE');
});

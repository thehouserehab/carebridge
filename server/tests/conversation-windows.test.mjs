import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Auth } from '../auth.mjs';
import { ActivityFeedback } from '../activity-feedback.mjs';
import { CareRecipientLinks } from '../care-recipient-links.mjs';
import { Conversations } from '../conversations.mjs';
import { RepositoryError } from '../errors.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';
import { Children } from '../profiles.mjs';
import { Records } from '../records.mjs';
import { MediaUploads } from '../media-uploads.mjs';
import { configureSyntheticMediaPolicy } from '../media-resource-test-policy.mjs';
import { evidenceForManifest, sealFixture } from './media-storage-fixtures.mjs';
import { migrate } from '../migrate.mjs';

// Fresh in-memory PostgreSQL only. Bulk fixture insertion is not sending UI
// evidence and never takes a database path, connection string or environment.
let db, chat;
const therapist = { centerId: 'center-a', userId: 'therapist-a' };
const guardian = { centerId: 'center-a', userId: 'guardian-a' };
const recipient = { centerId: 'center-a', userId: 'recipient-a' };
const manager = { centerId: 'center-a', userId: 'manager-a' };
const denied = code => error => error instanceof RepositoryError && error.code === code;
const list = (extra = {}, actor = guardian) => chat.list(actor, { conversationId: 'room-a', ...extra });
const timeline = (extra = {}, actor = guardian) => list({ view: 'timeline', ...extra }, actor);
const send = (body = '합성 소식', actor = therapist, extra = {}) => chat.sendText(actor,
  { conversationId: 'room-a', clientId: randomUUID(), body, ...extra });
const publish = (recordId = randomUUID()) => chat.publishSnapshot(therapist,
  { conversationId: 'room-a', clientId: randomUUID(), recordId, title: '합성 공유', summary: '공개용 합성 요약' });
const sequences = page => page.messages.map(message => message.sequence);
const range = (start, end) => Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);

before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers(id) VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('therapist-a',true),('guardian-a',true),('recipient-a',true),('manager-a',true),('stranger-a',true);
    INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES
      ('center-a','therapist-a','therapist',true),('center-a','guardian-a','guardian',true),
      ('center-a','recipient-a','care_recipient',true),('center-a','manager-a','center',true),('center-a','stranger-a','guardian',true);
    INSERT INTO cb_children(center_id,id) VALUES ('center-a','child-a'),('center-a','child-other');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),('center-a','room-other','child-other');
    INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence) VALUES
      ('center-a','room-a','therapist-a','therapist',true,1),('center-a','room-a','guardian-a','guardian',true,1),
      ('center-a','room-other','therapist-a','therapist',true,1),('center-a','room-other','guardian-a','guardian',true,1);`);
  chat = new Conversations(db);
});
async function bulk(amount) {
  await db.transaction(async tx => {
    const { rows } = await tx.query("SELECT last_sequence FROM cb_conversations WHERE center_id='center-a' AND id='room-a' FOR UPDATE");
    const start = Number(rows[0].last_sequence), prefix = randomUUID();
    await tx.query(`INSERT INTO cb_messages(center_id,conversation_id,id,sequence,author_id,client_id,request_hash,kind,body)
      SELECT 'center-a','room-a',$1||'-'||n, $2::bigint+n,'therapist-a',$1||'-'||n,repeat('a',64),'text','합성 소식 '||n
      FROM generate_series(1,$3::integer) n`, [prefix, start, amount]);
    await tx.query("UPDATE cb_conversations SET last_sequence=last_sequence+$1,revision=revision+$1 WHERE center_id='center-a' AND id='room-a'", [amount]);
  });
}
async function unchangedReads() {
  return {
    reads: (await db.query('SELECT * FROM cb_read_states ORDER BY center_id,conversation_id,user_id')).rows,
    revisions: (await db.query('SELECT center_id,id,revision FROM cb_conversations ORDER BY center_id,id')).rows,
    audit: (await db.query('SELECT count(*)::integer n FROM cb_audit_events')).rows[0].n,
    reviews: (await db.query('SELECT * FROM cb_message_reviews ORDER BY message_id')).rows,
  };
}
async function connectRecipient() {
  const auth = new Auth(db, { password: { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 ** 2 } });
  await auth.provisionAccount({ userId: recipient.userId, email: 'recipient@synthetic.test', password: 'Synthetic test password 2026!' });
  const links = new CareRecipientLinks(db), state = await links.get(manager, { conversationId: 'room-a' });
  await links.connect(manager, { conversationId: 'room-a', userId: recipient.userId, expectedVersion: state.version, clientId: randomUUID() });
}
async function approvedMetadata() {
  // Metadata only: this fixture cannot open, decode, transfer or store bytes.
  const noIO = async () => { throw new Error('Window privacy tests must not access file bytes.'); };
  const uploads = new MediaUploads(db, { write: noIO, openVerified: noIO, remove: noIO });
  await configureSyntheticMediaPolicy(db, 'center-a');
  const pending = await uploads.reserve(therapist, { conversationId: 'room-a', clientId: randomUUID(),
    file: { name: 'PRIVATE-WINDOW-MEDIA.png', type: 'image/png', size: 100, sha256: 'b'.repeat(64) } });
  const input = row => ({ conversationId: 'room-a', uploadId: row.id, expectedVersion: row.version });
  const receiving = await uploads.claim(therapist, input(pending), 'receive');
  const quarantined = await uploads.settle(therapist, 'room-a', receiving, { state: 'quarantined' });
  const inspecting = await uploads.claim(therapist, input(quarantined), 'inspect');
  return db.transaction(tx => sealFixture(tx, inspecting,
    evidenceForManifest({ type: inspecting.type, size: inspecting.size, sha256: inspecting.sha256 })));
}

test('over 2,000 messages: bounded latest/previous/next/stable-from/around, inbox and old active publications never change read state', async t => {
  const setupStart = performance.now(), old = await publish(); await bulk(2200);
  const setupMs = Math.round(performance.now() - setupStart), before = await unchangedReads();
  const latestStart = performance.now(), latest = await timeline(), latestMs = Math.round(performance.now() - latestStart);
  assert.equal(latest.messages.length, 100); assert.deepEqual(sequences(latest), range(2102, 2201));
  assert.deepEqual(latest.window, { hasOlder: true, hasNewer: false, startCursor: 2102, endCursor: 2201 });
  assert(!Object.hasOwn(latest, 'hasMore')); assert(!Object.hasOwn(latest, 'nextCursor'));
  const previous = await timeline({ before: latest.window.startCursor, expectedRevision: latest.revision });
  assert.deepEqual(sequences(previous), range(2002, 2101)); assert(previous.window.hasOlder && previous.window.hasNewer);
  const next = await timeline({ after: previous.window.endCursor, expectedRevision: latest.revision });
  assert.deepEqual(next, latest);
  assert.deepEqual(await timeline({ from: latest.window.startCursor, expectedRevision: latest.revision }), latest);
  const target = latest.messages[14];
  const around = await timeline({ around: target.id, limit: 10 });
  assert.deepEqual(sequences(around), range(target.sequence - 9, target.sequence));
  assert.equal(around.messages.at(-1).id, target.id); assert(around.window.hasNewer && around.window.hasOlder);
  assert.deepEqual(sequences(await timeline({ from: around.window.startCursor, limit: 10 })), sequences(around));
  const publicationStart = performance.now(), active = await list({ view: 'publications' });
  const publicationMs = Math.round(performance.now() - publicationStart);
  assert.deepEqual(active.messages.map(message => message.id), [old.id]); assert.equal(active.hasMore, false);
  assert.equal(latest.unread, 2201); assert.equal(latest.lastRead, 0);
  const legacy = await list(); assert.deepEqual(sequences(legacy), range(1, 50)); assert.equal(legacy.hasMore, true);
  const inboxStart = performance.now(), inbox = await chat.inbox(guardian), inboxMs = Math.round(performance.now() - inboxStart);
  const room = inbox.rooms.find(item => item.conversationId === 'room-a');
  assert.equal(room.targetId, latest.messages.at(-1).id); assert.equal(room.latest.sequence, 2201);
  assert.equal(room.lastRead, 0); assert.equal(room.unread, 2201);
  assert.deepEqual(await chat.inbox(guardian, { expectedSnapshot: inbox.snapshot }), inbox);
  assert.deepEqual(await unchangedReads(), before);
  t.diagnostic(`Isolated synthetic PGlite timings, not a production SLA: fixture=${setupMs}ms, latest100=${latestMs}ms, activeOldPublication=${publicationMs}ms, inbox=${inboxMs}ms`);
});

test('empty and exhausted windows keep zero cursors but truthful visible edges, including numeric zero selectors', async () => {
  assert.deepEqual((await timeline()).window, { hasOlder: false, hasNewer: false, startCursor: 0, endCursor: 0 });
  await bulk(3);
  for (const input of [{ before: 0 }, { before: 1 }])
    assert.deepEqual((await timeline(input)).window, { hasOlder: false, hasNewer: true, startCursor: 0, endCursor: 0 });
  for (const input of [{ after: 3 }, { after: 100 }, { from: 4 }])
    assert.deepEqual((await timeline(input)).window, { hasOlder: true, hasNewer: false, startCursor: 0, endCursor: 0 });
  assert.deepEqual(sequences(await timeline({ after: 0 })), [1, 2, 3]);
  assert.deepEqual(sequences(await timeline({ from: 0 })), [1, 2, 3]);
  const first = (await timeline()).messages[0];
  assert.deepEqual((await timeline({ around: first.id, limit: 1 })).window,
    { hasOlder: false, hasNewer: true, startCursor: 1, endCursor: 1 });
});

test('history, self hides, global deletion and quote privacy use the same page and edge visibility', async () => {
  const old = await send('PRIVATE-OLD'), hidden = await send('PRIVATE-HIDDEN'), deleted = await send('PRIVATE-DELETED'), current = await send('합성 현재');
  await chat.deleteText(guardian, { conversationId: 'room-a', messageId: hidden.id, clientId: randomUUID(), scope: 'self', confirmed: true });
  await chat.deleteText(therapist, { conversationId: 'room-a', messageId: deleted.id, clientId: randomUUID(), scope: 'all', expectedRevision: 1, confirmed: true });
  await db.query("UPDATE cb_participants SET first_sequence=2 WHERE center_id='center-a' AND conversation_id='room-a' AND user_id='guardian-a'");
  const page = await timeline({ limit: 1, before: current.sequence });
  assert.deepEqual(sequences(page), [deleted.sequence]); assert.equal(page.messages[0].deleted, true);
  assert.equal(page.messages[0].body, '삭제된 소식입니다.'); assert.equal(page.messages[0].authorId, null);
  assert.deepEqual(page.window, { hasOlder: false, hasNewer: true, startCursor: 3, endCursor: 3 });
  assert.deepEqual((await timeline({ from: 0 })).messages.map(message => message.id), [deleted.id, current.id]);
  assert(!JSON.stringify(page).includes('PRIVATE-'));
  for (const message of [old, hidden]) await assert.rejects(timeline({ around: message.id }), denied('NOT_FOUND'));
  assert.equal((await timeline({ around: deleted.id })).messages.at(-1).deleted, true);
  const reply = await send('공개 답장', therapist, { replyTo: old.id, expectedReplyVersion: 1 });
  const replyWindow = await timeline({ around: reply.id, limit: 1 });
  assert.equal(replyWindow.messages[0].quote.hidden, true); assert(!JSON.stringify(replyWindow).includes('PRIVATE-OLD'));
});

test('around is an exact authorized target and never falls back across room, account, center or revoked membership', async () => {
  const message = await send();
  const other = await send('다른 방', therapist, { conversationId: 'room-other' });
  for (const target of ['missing-message', other.id]) await assert.rejects(timeline({ around: target }), denied('NOT_FOUND'));
  for (const actor of [manager, { ...guardian, userId: 'stranger-a' }, { ...guardian, centerId: 'center-b' }])
    await assert.rejects(timeline({ around: message.id }, actor), denied('NOT_FOUND'));
  await db.query("UPDATE cb_memberships SET active=false WHERE center_id='center-a' AND user_id='guardian-a'");
  await assert.rejects(timeline({ around: message.id }), denied('NOT_FOUND'));
});

test('publication-only SQL paging excludes text, superseded and withdrawn cards, but keeps old active cards', async () => {
  const old = await publish('old-record'), superseded = await publish('replace-record');
  await bulk(30); const replacement = await publish('replace-record'), withdrawn = await publish('withdrawn-record');
  await chat.withdraw(therapist, { conversationId: 'room-a', messageId: withdrawn.id });
  const first = await list({ view: 'publications', limit: 1 });
  assert.deepEqual(first.messages.map(message => message.id), [old.id]); assert.equal(first.hasMore, true);
  const second = await list({ view: 'publications', after: first.nextCursor, expectedRevision: first.revision, limit: 1 });
  assert.deepEqual(second.messages.map(message => message.id), [replacement.id]); assert.equal(second.hasMore, false);
  const plain = await list({ view: 'publications' });
  assert(plain.messages.every(message => message.type === 'publication' && message.publication && !message.archived && !message.hidden));
  assert(!plain.messages.some(message => [superseded.id, withdrawn.id].includes(message.id)));
  const exhausted = await list({ view: 'publications', after: second.nextCursor });
  assert.deepEqual(exhausted.messages, []); assert.equal(exhausted.nextCursor, second.nextCursor);
  await db.query("UPDATE cb_participants SET first_sequence=$1 WHERE center_id='center-a' AND conversation_id='room-a' AND user_id='guardian-a'", [replacement.sequence]);
  assert.deepEqual((await list({ view: 'publications' })).messages.map(message => message.id), [replacement.id]);
});

test('recipient-only windows and edge flags exclude clinical cards and earlier history, even with a forged role', async () => {
  const older = await send('PRIVATE-PAST');
  await connectRecipient();
  const publicText = await send('당사자 합성 소식'), clinical = await publish();
  const page = await timeline({ limit: 1 }, { ...recipient, role: 'therapist' });
  assert.deepEqual(page.messages.map(message => message.id), [publicText.id]);
  assert.deepEqual(page.window, { hasOlder: false, hasNewer: false, startCursor: publicText.sequence, endCursor: publicText.sequence });
  assert.equal(page.unread, 1); assert.deepEqual((await list({ view: 'publications' }, recipient)).messages, []);
  for (const target of [older.id, clinical.id]) await assert.rejects(timeline({ around: target }, recipient), denied('NOT_FOUND'));
  assert.deepEqual((await timeline({ before: publicText.sequence }, recipient)).window,
    { hasOlder: false, hasNewer: true, startCursor: 0, endCursor: 0 });
  assert.deepEqual((await timeline({ after: publicText.sequence }, recipient)).window,
    { hasOlder: true, hasNewer: false, startCursor: 0, endCursor: 0 });
});

test('a feedback card after the history boundary does not reveal a publication from before that boundary', async () => {
  await db.query("INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ('center-a','room-a','goal-a','합성 목표','active')");
  const records = new Records(db), feedback = new ActivityFeedback(db);
  await records.save(therapist, { conversationId: 'room-a', recordId: 'record-a', clientId: randomUUID(), expectedRevision: 0,
    content: { date: '2026-10-20', goalId: 'goal-a', performed: '합성 관찰', summary: 'PRIVATE-PAST-PUBLICATION',
      privateNote: 'PRIVATE-CLINICAL', activity: { title: '합성 활동', instruction: '합성 놀이', frequency: '가능한 때', caution: '' } } });
  const preview = await records.preview(therapist, { conversationId: 'room-a', recordId: 'record-a' });
  const published = await records.publish(therapist, { conversationId: 'room-a', recordId: 'record-a', clientId: randomUUID(),
    expectedRevision: preview.recordRevision, expectedRelationshipsVersion: preview.relationshipsVersion, recipientIds: preview.recipientIds });
  const current = await send('현재 공개 소식');
  const saved = await feedback.save(guardian, { conversationId: 'room-a', feedbackId: 'feedback-a', sourceMessageId: published.messageId,
    clientId: randomUUID(), expectedRevision: 0, content: { date: '2026-10-20', result: 'done', reaction: 'PRIVATE-PAST-FEEDBACK', difficulty: '' } });
  await db.query("UPDATE cb_participants SET first_sequence=$1 WHERE center_id='center-a' AND conversation_id='room-a' AND user_id='therapist-a'", [current.sequence]);
  const before = await unchangedReads(), page = await timeline({}, therapist);
  assert.deepEqual(page.messages.map(message => message.id), [current.id]);
  assert.deepEqual(page.window, { hasOlder: false, hasNewer: false, startCursor: current.sequence, endCursor: current.sequence });
  assert.equal(page.unread, 0); assert(!JSON.stringify(page).includes('PRIVATE-'));
  assert.deepEqual((await list({ view: 'publications' }, therapist)).messages, []);
  assert.equal((await chat.inbox(therapist)).rooms[0].targetId, current.id);
  await assert.rejects(timeline({ around: saved.messageId }, therapist), denied('NOT_FOUND'));
  await assert.rejects(timeline({ around: published.messageId }, therapist), denied('NOT_FOUND'));
  assert.deepEqual(await unchangedReads(), before);
});

test('recipient window edges and inbox exclude attachment-only messages even after global deletion', async () => {
  await connectRecipient();
  const mixedFile = await approvedMetadata(), onlyFile = await approvedMetadata();
  const mixed = await send('공개 본문', therapist, { attachments: [{ id: mixedFile.id }] });
  const only = await send('', therapist, { attachments: [{ id: onlyFile.id }] });
  for (const deleted of [false, true]) {
    if (deleted) await chat.deleteText(therapist, { conversationId: 'room-a', messageId: only.id,
      clientId: randomUUID(), scope: 'all', expectedRevision: 1, confirmed: true });
    const page = await timeline({ limit: 1 }, recipient);
    assert.deepEqual(page.messages.map(message => message.id), [mixed.id]);
    assert.deepEqual(page.messages[0].attachments, []); assert(!JSON.stringify(page).includes('PRIVATE-'));
    assert.deepEqual(page.window, { hasOlder: false, hasNewer: false, startCursor: mixed.sequence, endCursor: mixed.sequence });
    assert.equal(page.unread, 1);
    await assert.rejects(timeline({ around: only.id }, recipient), denied('NOT_FOUND'));
    const inbox = await chat.inbox(recipient); assert.equal(inbox.rooms[0].targetId, mixed.id); assert.equal(inbox.rooms[0].unread, 1);
  }
});

test('revision reset stays minimal for every view and rechecking the current revision is read-only', async () => {
  const message = await send(), initial = await timeline();
  await chat.markRead(guardian, { conversationId: 'room-a', messageId: message.id });
  const state = await unchangedReads();
  for (const view of [undefined, 'timeline', 'publications']) {
    const params = { ...(view ? { view } : {}), expectedRevision: initial.revision };
    const reset = await list(params); assert.equal(reset.resetRequired, true);
    assert.deepEqual(Object.keys(reset).sort(), ['resetRequired', 'revision']);
    assert(reset.revision > initial.revision);
  }
  assert.deepEqual(await unchangedReads(), state);
});

test('repository rejects ambiguous modes, selectors, bounds, malformed IDs and unknown fields', async () => {
  for (const bad of [{ view: 'latest' }, { view: '' }, { view: null }, { view: undefined }, { before: 0 }, { around: 'abc' },
    { view: 'publications', before: 0 }, { view: 'publications', from: 0 }, { view: 'publications', around: 'abc' },
    ...['before', 'after', 'from'].flatMap(key => [-1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, null].map(value => ({ view: 'timeline', [key]: value }))),
    ...[0, 101, 1.1, '1', null].map(limit => ({ view: 'timeline', limit })),
    ...['', '../secret', 'a'.repeat(101), 1, null, undefined].map(around => ({ view: 'timeline', around })),
    { view: 'timeline', before: 2, after: 0 }, { view: 'timeline', from: 0, around: 'abc' },
    { view: 'timeline', expectedRevision: -1 }, { view: 'timeline', userId: 'forged' }])
    await assert.rejects(list(bad), denied('INVALID_INPUT'));
});

// Exercise the actual HTTP adapter with real Auth + PGlite, but no listening
// socket or service. Request/response objects represent the loopback boundary.
async function http(query, { token, account = guardian.userId } = {}) {
  const cookieName = 'cb_local_0123456789abcdef', host = '127.0.0.1:49123';
  const headers = { host, ...(token ? { cookie: `${cookieName}=${token}`, 'x-carebridge-account': account } : {}) };
  const req = { method: 'GET', url: `/api/local/centers/center-a/conversations/room-a/messages${query ? `?${query}` : ''}`,
    headers, rawHeaders: Object.entries(headers).flat(), complete: true,
    socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1', localPort: 49123 } };
  const res = { destroyed: false, writableEnded: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.json = JSON.parse(body); this.writableEnded = true; } };
  const handled = await handleLocalApiRequest(req, res, { auth: http.auth, conversations: chat, profiles: new Children(db), origin: `http://${host}`, cookieName });
  assert.equal(handled, true); assert.equal(res.headers['Cache-Control'], 'no-store');
  return res;
}
async function httpAccount() {
  http.auth = new Auth(db, { password: { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 ** 2 } });
  const email = 'guardian@synthetic.test', password = 'Synthetic only password 2026!';
  await http.auth.provisionAccount({ userId: guardian.userId, email, password });
  return (await http.auth.login({ email, password })).token;
}
test('HTTP mode-specific DTOs preserve minimal reset and omit unrelated paging/internal fields', async () => {
  const token = await httpAccount(); const shared = await publish(); await bulk(4);
  const page = await http('view=timeline&limit=2', { token }); assert.equal(page.status, 200);
  assert.deepEqual(Object.keys(page.json).sort(), ['messages', 'lastRead', 'unread', 'revision', 'resetRequired', 'window'].sort());
  assert.deepEqual(page.json.window, { hasOlder: true, hasNewer: false, startCursor: 4, endCursor: 5 });
  const target = page.json.messages[0].id;
  assert.deepEqual((await http(`view=timeline&around=${target}&limit=1`, { token })).json.messages.map(message => message.id), [target]);
  const active = await http('view=publications&limit=1', { token }); assert.equal(active.status, 200);
  assert.deepEqual(Object.keys(active.json).sort(), ['messages', 'lastRead', 'unread', 'revision', 'resetRequired', 'hasMore', 'nextCursor'].sort());
  assert.deepEqual(active.json.messages.map(message => message.id), [shared.id]);
  assert.equal(active.json.messages[0].archived, false); assert.equal(active.json.messages[0].hidden, false);
  assert.equal(active.json.messages[0].deleted, false); assert(active.json.messages[0].publication);
  const legacy = await http('limit=1', { token }); assert.equal(legacy.status, 200); assert.equal(legacy.json.nextCursor, 1);
  await send();
  const reset = await http(`view=timeline&expectedRevision=${page.json.revision}`, { token });
  assert.equal(reset.status, 200); assert.equal(reset.json.resetRequired, true);
  assert.deepEqual(Object.keys(reset.json).sort(), ['resetRequired', 'revision']);
});

test('HTTP rejects invalid view combinations, duplicate/encoded aliases and unsafe bounds before repository queries', async () => {
  const token = await httpAccount();
  const invalid = ['view=', 'view=legacy', 'view=timeline&view=timeline', 'view=publications&before=0', 'before=0', 'around=abc',
    'view=timeline&before=0&after=0', 'view=timeline&around=abc&from=0', 'view=timeline&around=', 'view=timeline&around=..%2Fsecret',
    'view=timeline&limit=0', 'view=timeline&limit=101', 'view=timeline&before=-1', 'view=timeline&from=01',
    'view=timeline&after=1.5', 'view=timeline&after=9007199254740992', 'view=timeline&around=a&%61round=b',
    'view=timeline&expectedRevision=-1', 'view=timeline&role=therapist', 'view=timeline&limit=1&limit=2'];
  const original = chat.list; let calls = 0;
  chat.list = async (...args) => { calls++; return original.apply(chat, args); };
  for (const query of invalid) {
    const response = await http(query, { token }); assert.equal(response.status, 400, query);
    assert.equal(response.json.error, 'INVALID_INPUT', query);
  }
  assert.equal(calls, 0);
  assert.equal((await http('view=timeline')).status, 401);
  assert.equal((await http('view=timeline', { token, account: therapist.userId })).status, 401);
  assert.equal((await http('view=timeline&around=absent', { token })).status, 404);
});

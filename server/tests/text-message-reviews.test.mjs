// Invented identities and memory-only PGlite. HTTP cases own an ephemeral
// loopback listener; no E/native service, actual child data or external calls.
import assert from 'node:assert/strict';
import { before, after, beforeEach, afterEach, test } from 'node:test';
import { createServer, request } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { readdir, readFile, mkdtemp, copyFile, unlink, rmdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Conversations } from '../conversations.mjs';
import { Relationships } from '../relationships.mjs';
import { Auth } from '../auth.mjs';
import { Children } from '../profiles.mjs';
import { migrate } from '../migrate.mjs';
import { localMessageRoute, executeLocalMessage } from '../local-message-http.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';
import { expectedTablePrivileges, expectedFunctionExecution } from '../database-privilege-policy.mjs';

let db, chat, server, origin, configuration;
const room = 'room-a', centerId = 'center-a';
const therapist = { centerId, userId: 'therapist-a' }, guardian = { centerId, userId: 'guardian-a' };
const manager = { centerId, userId: 'manager-a' }, replacement = { centerId, userId: 'replacement-a' };
const code = value => error => error.code === value;
const target = message => ({ conversationId: room, messageId: message.id });
const command = (message, extra = {}) => ({ ...target(message), clientId: randomUUID(), expectedRevision: 1,
  expectedReviewVersion: 0, note: 'PRIVATE-SYNTHETIC-REVIEW', ...extra });
const send = (extra = {}, actor = guardian) => chat.sendText(actor, { conversationId: room, clientId: randomUUID(), body: '합성 원문', ...extra });
const review = (message, actor = therapist) => chat.textReview(actor, target(message));
const save = (message, extra = {}, actor = therapist) => chat.textReviewSave(actor, command(message, extra));
const edit = (message, extra = {}) => chat.editText(guardian, { ...target(message), clientId: randomUUID(), expectedRevision: 1, body: '합성 수정 원문', ...extra });
const remove = (message, scope = 'self', actor = therapist) => chat.deleteText(actor,
  { ...target(message), clientId: randomUUID(), expectedRevision: 1, scope, confirmed: true });
const raw = async (table, database = db) => (await database.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
const state = () => Promise.all(['cb_message_reviews', 'cb_message_review_requests', 'cb_audit_events', 'cb_conversations'].map(table => raw(table)));
async function seed(database = db) {
  await database.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('therapist-a',true),('guardian-a',true),('manager-a',true),('replacement-a',true),('foreign-b',true);
    INSERT INTO cb_memberships VALUES ('center-a','therapist-a','therapist',true),('center-a','guardian-a','guardian',true),
      ('center-a','manager-a','center',true),('center-a','replacement-a','therapist',true),('center-b','foreign-b','therapist',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1),('center-a','room-a','guardian-a','guardian',true,1),
      ('center-a','room-other','therapist-a','therapist',true,1),('center-a','room-other','guardian-a','guardian',true,1),
      ('center-b','room-b','foreign-b','therapist',true,1);`);
}
before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
beforeEach(async () => { await seed(); chat = new Conversations(db); });
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; } });

test('strict review reads distinguish unreviewed, current and edited-source notes without extra private projection fields', async () => {
  const message = await send();
  assert.deepEqual(await review(message), { messageId: message.id, conversationId: room, revision: 1, reviewVersion: 0,
    reviewedRevision: null, note: '', body: message.body, attachmentCount: 0 });
  const receipt = await save(message);
  assert.deepEqual(receipt, { messageId: message.id, revision: 1, reviewVersion: 1, operation: 'review', replayed: false });
  await edit(message);
  assert.deepEqual(await review(message), { messageId: message.id, conversationId: room, revision: 2, reviewVersion: 1,
    reviewedRevision: 1, note: 'PRIVATE-SYNTHETIC-REVIEW', body: '합성 수정 원문', attachmentCount: 0 });
  assert.equal((await chat.get(guardian, target(message))).reviewed, false);
  await save(message, { expectedRevision: 2, expectedReviewVersion: 1 });
  assert.equal((await review(message)).reviewVersion, 2);
  assert.equal((await chat.get(guardian, target(message))).reviewed, true);
});

test('exact retries preserve one result, room revision and audit even after a newer private note', async () => {
  const message = await send(), input = command(message);
  const first = await chat.textReviewSave(therapist, input), before = await state();
  assert.deepEqual(await chat.textReviewSave(therapist, input), { ...first, replayed: true });
  assert.deepEqual(await state(), before);
  await save(message, { expectedReviewVersion: 1, note: 'PRIVATE-NEWER' });
  const after = await state();
  assert.deepEqual(await chat.textReviewSave(therapist, input), { ...first, replayed: true });
  assert.deepEqual(await state(), after); assert.equal((await review(message)).note, 'PRIVATE-NEWER');
  assert.doesNotMatch(JSON.stringify((await raw('cb_message_review_requests'))), /PRIVATE|합성/);
});

test('changed payload or room with the same request identity conflicts rather than overwriting another review', async () => {
  const message = await send(), input = command(message); await chat.textReviewSave(therapist, input);
  await assert.rejects(chat.textReviewSave(therapist, { ...input, note: '다른 메모' }), code('IDEMPOTENCY_CONFLICT'));
  const other = await send({ conversationId: 'room-other' });
  await assert.rejects(chat.textReviewSave(therapist, { ...input, conversationId: 'room-other', messageId: other.id }), code('IDEMPOTENCY_CONFLICT'));
  assert.equal((await raw('cb_message_review_requests')).length, 1);
});

test('source and private-note compare-and-swap reject independently; concurrent editors cannot silently win twice', async () => {
  const message = await send();
  const results = await Promise.allSettled([save(message), save(message, { note: 'PRIVATE-COMPETING' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'REVIEW_CONFLICT');
  const before = await state();
  await assert.rejects(save(message), code('REVIEW_CONFLICT')); assert.deepEqual(await state(), before);
  await edit(message);
  await assert.rejects(save(message, { expectedReviewVersion: 1 }), code('MESSAGE_CONFLICT'));
});

test('legacy direct callers retain their view return but advance the same version used by strict callers', async () => {
  const message = await send(), first = await chat.review(therapist, { ...target(message), note: 'PRIVATE-LEGACY' });
  assert.equal(first.reviewNote, 'PRIVATE-LEGACY'); assert.equal((await review(message)).reviewVersion, 1);
  await chat.review(therapist, { ...target(message), note: 'PRIVATE-LEGACY-NEW' });
  await assert.rejects(save(message, { expectedReviewVersion: 1 }), code('REVIEW_CONFLICT'));
  assert.equal((await review(message)).reviewVersion, 2); assert.equal((await raw('cb_message_review_requests')).length, 0);
  const own = await send({}, therapist); assert.equal((await save(own)).reviewVersion, 1);
});

test('hide and all-delete block fresh reads/writes but exact acknowledged retries return no source or note', async () => {
  for (const scope of ['self', 'all']) {
    const message = await send(), input = command(message); const receipt = await chat.textReviewSave(therapist, input);
    await remove(message, scope, scope === 'all' ? guardian : therapist);
    await assert.rejects(review(message), code(scope === 'all' ? 'MESSAGE_DELETED' : 'NOT_FOUND'));
    await assert.rejects(save(message, { expectedReviewVersion: 1 }), code(scope === 'all' ? 'MESSAGE_DELETED' : 'NOT_FOUND'));
    const before = await state(), replay = await chat.textReviewSave(therapist, input);
    assert.deepEqual(replay, { ...receipt, replayed: true }); assert.deepEqual(await state(), before);
    assert.doesNotMatch(JSON.stringify(replay), /PRIVATE|합성|note|body/);
  }
});

test('current role, user, relationship and future-only scope remain required even for committed receipts', async () => {
  const message = await send(), input = command(message); await chat.textReviewSave(therapist, input);
  for (const actor of [guardian, manager, replacement, { centerId: 'center-b', userId: 'foreign-b' }]) {
    await assert.rejects(review(message, actor), code(actor === guardian ? 'FORBIDDEN' : 'NOT_FOUND'));
    await assert.rejects(chat.textReviewSave(actor, input), code(actor === guardian ? 'FORBIDDEN' : 'NOT_FOUND'));
  }
  for (const table of ['cb_users', 'cb_memberships', 'cb_participants']) {
    const key = table === 'cb_users' ? 'id' : 'user_id';
    await db.query(`UPDATE ${table} SET active=false WHERE ${key}=$1`, [therapist.userId]);
    await assert.rejects(chat.textReviewSave(therapist, input), code('NOT_FOUND'));
    await db.query(`UPDATE ${table} SET active=true WHERE ${key}=$1`, [therapist.userId]);
  }
  const relationships = new Relationships(db);
  for (const actor of [replacement, therapist]) {
    const current = await relationships.get(manager, { conversationId: room });
    await relationships.replace(manager, { conversationId: room, clientId: randomUUID(), expectedVersion: current.version,
      historyConfirmed: true, therapist: { userId: actor.userId, history: 'from_now' }, guardians: [{ userId: guardian.userId, history: 'preserve' }] });
  }
  await assert.rejects(review(message), code('NOT_FOUND'));
  await assert.rejects(chat.textReviewSave(therapist, input), code('NOT_FOUND'));
});

test('strict input validation captures versions and trimmed well-formed note before an await', async () => {
  const message = await send();
  for (const patch of [{ note: '' }, { note: ' '.repeat(2) }, { note: 'a'.repeat(2001) }, { note: '\ud800' }, { note: 'x\u0085' },
    { note: 'x\u0000' }, { expectedRevision: 0 }, { expectedRevision: 2147483648 }, { expectedReviewVersion: -1 },
    { expectedReviewVersion: null }, { expectedReviewVersion: 2147483647 }, { expectedReviewVersion: 2147483648 }, { clientId: 'bad' }, { role: 'therapist' }])
    await assert.rejects(save(message, patch), code('INVALID_INPUT'));
  for (const key of ['expectedRevision', 'expectedReviewVersion', 'clientId', 'note']) {
    const input = command(message); delete input[key]; await assert.rejects(chat.textReviewSave(therapist, input), code('INVALID_INPUT'));
  }
  const input = command(message, { note: '  합성\t메모\n다음 회기\r\n  ' });
  const pending = chat.textReviewSave(therapist, input); input.note = 'changed after call'; input.expectedRevision = 99;
  await pending; assert.equal((await review(message)).note, '합성\t메모\n다음 회기');
});

test('publication sources cannot use the ordinary-text private review path', async () => {
  const publication = await chat.publishSnapshot(therapist, { conversationId: room, clientId: randomUUID(), recordId: 'record-a', title: '합성 공유', summary: '합성 요약' });
  await assert.rejects(review(publication), code('INVALID_INPUT'));
  await assert.rejects(save(publication), code('INVALID_INPUT'));
});

test('receipt or audit failure rolls back note, version, room epoch and all request state', async () => {
  const message = await send();
  for (const table of ['cb_audit_events', 'cb_message_review_requests']) {
    const input = command(message), before = await state();
    const failing = new Conversations({ transaction: work => db.transaction(tx => work({ query: async (sql, params) => {
      if (sql.includes(`INSERT INTO ${table}`)) throw Error('SYNTHETIC_ROLLBACK'); return tx.query(sql, params);
    } })) });
    await assert.rejects(failing.textReviewSave(therapist, input), /SYNTHETIC_ROLLBACK/);
    assert.deepEqual(await state(), before);
  }
  assert.equal((await save(message)).reviewVersion, 1);
});

test('database guards enforce monotonic review identity and immutable receipt with an existing exact result', async () => {
  const message = await send(); await save(message);
  for (const sql of ["UPDATE cb_message_reviews SET note='forged'", 'UPDATE cb_message_reviews SET review_version=review_version+2',
    "UPDATE cb_message_reviews SET message_id='other',review_version=review_version+1", 'DELETE FROM cb_message_reviews',
    "UPDATE cb_message_review_requests SET request_hash=repeat('b',64)", 'DELETE FROM cb_message_review_requests'])
    await assert.rejects(db.exec(sql), code('23514'));
  await assert.rejects(db.query(`INSERT INTO cb_message_review_requests
    (center_id,conversation_id,actor_id,client_id,request_hash,message_id,message_revision,review_version)
    VALUES ($1,$2,$3,$4,$5,$6,1,2)`, [centerId, room, therapist.userId, randomUUID(), 'a'.repeat(64), message.id]), code('23514'));
  await edit(message);
  await assert.rejects(db.exec('UPDATE cb_message_reviews SET review_version=review_version+1'), code('23514'));
});

test('new receipt privileges and restore-quarantine guards are explicit without a new executable public helper', async () => {
  const table = 'cb_message_review_requests';
  assert.deepEqual(expectedTablePrivileges('runtime', table), ['SELECT', 'INSERT']);
  assert.deepEqual(expectedTablePrivileges('backup', table), ['SELECT']);
  for (const role of ['worker', 'bootstrap']) assert.deepEqual(expectedTablePrivileges(role, table), []);
  for (const role of ['worker', 'bootstrap', 'runtime', 'backup']) assert.equal(expectedFunctionExecution(role, 'cb_message_review_guard'), false);
  const { rows } = await db.query(`SELECT c.relname,t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE c.relname IN ('cb_message_reviews','cb_message_review_requests') AND t.tgname IN ('cb_000_recovery_guard','cb_recovery_truncate_guard')`);
  assert.equal(rows.length, 4); // Catalog evidence, not a native restore/quarantine execution claim.
});

test('022 migration preserves existing private note/source/author/timestamp and does not invent receipts', async () => {
  const base = await realpath(tmpdir()), directory = await mkdtemp(join(base, 'carebridge-review-migration-'));
  const legacy = await PGlite.create(), names = (await readdir(new URL('../migrations/', import.meta.url))).filter(n => n.endsWith('.sql') && n < '022-');
  try {
    for (const name of names) await copyFile(new URL(`../migrations/${name}`, import.meta.url), join(directory, name));
    await migrate(legacy, pathToFileURL(directory + '/')); await seed(legacy);
    // Preserve the real 021 schema: current Conversations authorization needs
    // 023 and cannot serve as a legacy fixture. The 020 text-capture triggers
    // create the original head/revision from this historical send row.
    assert.equal((await legacy.query('SELECT max(name) AS latest FROM cb_schema_migrations')).rows[0].latest,'021-password-recovery.sql');
    assert.deepEqual((await legacy.query(`SELECT to_regclass('public.cb_message_review_requests') AS receipts,
      to_regclass('public.cb_care_recipient_links') AS recipient_links`)).rows,[{receipts:null,recipient_links:null}]);
    const message = await legacy.transaction(async tx=>{
      const {rows:[counter]}=await tx.query(`UPDATE cb_conversations SET last_sequence=last_sequence+1,revision=revision+1
        WHERE center_id=$1 AND id=$2 RETURNING last_sequence`,[centerId,room]);
      const {rows:[row]}=await tx.query(`INSERT INTO cb_messages
        (center_id,conversation_id,id,sequence,author_id,client_id,request_hash,kind,body)
        VALUES ($1,$2,$3,$4,$5,$6,repeat('a',64),'text','합성 이전 소식') RETURNING id`,
      [centerId,room,randomUUID(),counter.last_sequence,guardian.userId,randomUUID()]);
      return row;
    });
    // Old 021 schema has no review_version, so insert its original contract.
    await legacy.query(`INSERT INTO cb_message_reviews(center_id,conversation_id,message_id,reviewer_id,note,message_revision)
      VALUES ($1,$2,$3,$4,'PRIVATE-EXISTING',1)`, [centerId, room, message.id, therapist.userId]);
    const before = await raw('cb_message_reviews', legacy), messages = await raw('cb_messages', legacy);
    assert.deepEqual(await migrate(legacy), ['022-message-reviews.sql','023-care-recipient-links.sql']); assert.deepEqual(await migrate(legacy), []);
    const after = await raw('cb_message_reviews', legacy); assert.equal(after[0].row.review_version, 1);
    delete after[0].row.review_version; assert.deepEqual(after, before); assert.deepEqual(await raw('cb_messages', legacy), messages);
    assert.deepEqual(await raw('cb_message_review_requests', legacy), []);
    assert.equal((await new Conversations(legacy).textReviewSave(therapist, command(message, { expectedReviewVersion: 1 }))).reviewVersion, 2);
  } finally {
    await legacy.close(); assert.equal(dirname(await realpath(directory)), base); assert(basename(directory).startsWith('carebridge-review-migration-'));
    for (const name of await readdir(directory)) { assert(names.includes(name)); await unlink(join(directory, name)); } await rmdir(directory);
  }
});

async function startHttp() {
  const auth = new Auth(db, { password: { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } });
  const password = 'Synthetic text review only 2026!';
  for (const userId of ['therapist-a', 'guardian-a', 'manager-a', 'replacement-a', 'foreign-b'])
    await auth.provisionAccount({ userId, email: `${userId}@review.test`, password });
  server = createServer(async (req, res) => { if (!await handleLocalApiRequest(req, res, configuration)) { res.writeHead(404); res.end(); } });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  configuration = { auth, conversations: chat, profiles: new Children(db), origin, cookieName: `cb_local_${randomBytes(16).toString('hex')}` };
  return async (userId = therapist.userId) => {
    const result = await http('/api/local/auth/login', { method: 'POST', body: { email: `${userId}@review.test`, password } });
    assert.equal(result.status, 200); return { cookie: result.headers['set-cookie'][0].split(';')[0], userId };
  };
}
const endpoint = message => `/api/local/centers/${centerId}/conversations/${room}/messages/${message.id}/review`;
const postBody = input => Object.fromEntries(['clientId','expectedRevision','expectedReviewVersion','note'].map(k => [k, input[k]]));
function http(path, { method = 'GET', body, cookie, userId, headers = {} } = {}) {
  const allHeaders = { ...(method === 'POST' ? { Origin: origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie, 'X-Carebridge-Account': userId } : {}), ...headers };
  for (const key of Object.keys(allHeaders)) if (allHeaders[key] === undefined) delete allHeaders[key];
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: allHeaders, agent: false }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: res.headers, text, body: text ? JSON.parse(text) : null });
      });
    });
    req.once('error', reject); req.setTimeout(8000, () => req.destroy(Error('SYNTHETIC_HTTP_TIMEOUT')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('actual HTTP exposes private review only on its authorized therapist endpoint and never on public chat projections', async () => {
  const message = await send(), login = await startHttp(), account = await login(), input = command(message);
  const initial = await http(endpoint(message), account); assert.equal(initial.status, 200); assert.equal(initial.body.review.reviewVersion, 0);
  assert.equal((await http(endpoint(message), { ...account, method: 'POST', body: postBody(input) })).status, 200);
  const current = await http(endpoint(message), account); assert.equal(current.body.review.note, input.note);
  assert.deepEqual(Object.keys(current.body.review).sort(), ['messageId','conversationId','revision','reviewVersion','reviewedRevision','note','body','attachmentCount'].sort());
  assert.equal(current.headers['cache-control'], 'no-store'); assert.equal(current.headers['access-control-allow-origin'], undefined);
  for (const userId of [therapist.userId, guardian.userId]) {
    const auth = await login(userId), base = `/api/local/centers/${centerId}`;
    for (const path of [`${base}/conversations/${room}/messages`, `${base}/conversations/${room}/messages/${message.id}`, `${base}/inbox`]) {
      const result = await http(path, auth); assert.equal(result.status, 200); assert.doesNotMatch(result.text, /PRIVATE-|reviewNote|reviewVersion|reviewedRevision/);
    }
  }
});

test('actual HTTP review paths retain auth, expected account, source, role, tenant and current relationship guards', async () => {
  const message = await send(), login = await startHttp(), account = await login();
  assert.equal((await http(endpoint(message))).status, 401);
  for (const userId of [guardian.userId, manager.userId, replacement.userId, 'foreign-b']) {
    const other = await login(userId);
    assert.equal((await http(endpoint(message), other)).status, 404);
    assert.equal((await http(endpoint(message), { ...other, method: 'POST', body: postBody(command(message)) })).status, 404);
  }
  for (const headers of [{ 'X-Carebridge-Account': guardian.userId }, { 'X-Carebridge-Account': undefined }])
    assert.equal((await http(endpoint(message), { ...account, headers })).status, 401);
  for (const headers of [{ Origin: 'https://outside.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }])
    assert.equal((await http(endpoint(message), { ...account, headers })).status, 403);
  for (const headers of [{ Origin: undefined }, { 'X-Carebridge-Request': undefined }])
    assert.equal((await http(endpoint(message), { ...account, method: 'POST', body: postBody(command(message)), headers })).status, 403);
  assert.deepEqual(await raw('cb_message_review_requests'), []);
});

test('actual HTTP strict grammar and CAS errors preserve inputs server-side without permissive legacy fallback', async () => {
  const message = await send(), login = await startHttp(), account = await login(), input = postBody(command(message));
  for (const body of [{ ...input, role: 'therapist' }, { note: input.note }, { ...input, note: '\ud800' }, { ...input, note: 'x\u007f' }])
    assert.equal((await http(endpoint(message), { ...account, method: 'POST', body })).status, 400);
  for (const suffix of ['?revision=1', '?note=PRIVATE', '?revision=1&revision=2'])
    assert.equal((await http(endpoint(message) + suffix, account)).status, 400);
  for (const method of ['PUT','DELETE','HEAD']) assert.equal((await http(endpoint(message), { ...account, method })).status, 404);
  await http(endpoint(message), { ...account, method: 'POST', body: input });
  const conflict = await http(endpoint(message), { ...account, method: 'POST', body: { ...input, clientId: randomUUID() } });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error, 'REVIEW_CONFLICT'); assert.doesNotMatch(conflict.text, /PRIVATE/);
  await edit(message);
  const changed = await http(endpoint(message), { ...account, method: 'POST', body: { ...input, clientId: randomUUID(), expectedReviewVersion: 1 } });
  assert.equal(changed.status, 409); assert.equal(changed.body.error, 'MESSAGE_CONFLICT');
});

test('committed result with a deliberately lost acknowledgement replays through actual HTTP after self-hide without a second write', async () => {
  const message = await send(), login = await startHttp(), account = await login(), input = postBody(command(message));
  let lose = true;
  configuration.conversations = new Conversations({ transaction: async work => {
    const result = await db.transaction(work); if (lose) { lose = false; throw Error('PRIVATE-SYNTHETIC-LOST-ACK'); } return result;
  } });
  // Deliberate post-commit failure double; storage/auth/listener are real.
  const lost = await http(endpoint(message), { ...account, method: 'POST', body: input });
  assert.equal(lost.status, 503); assert.doesNotMatch(lost.text, /PRIVATE/);
  await remove(message);
  const before = await state(), retry = await http(endpoint(message), { ...account, method: 'POST', body: input });
  assert.equal(retry.status, 200); assert.equal(retry.body.receipt.replayed, true); assert.equal(retry.body.receipt.reviewVersion, 1);
  assert.deepEqual(await state(), before); assert.doesNotMatch(retry.text, /PRIVATE|note|body/);
  assert.equal((await http(endpoint(message), account)).status, 404);
});

test('route projection is an explicit allowlist and only the review operation requires the new method', async () => {
  const route = localMessageRoute(new URL('http://127.0.0.1:12345/api/local/centers/c/conversations/r/messages/m/review'), 'GET');
  const privateView = { messageId: 'm', conversationId: 'r', revision: 1, reviewVersion: 0, reviewedRevision: null, note: '', body: '합성', attachmentCount: 0 };
  const result = await executeLocalMessage(route, therapist, null, { textReview: async () => ({ ...privateView, secret: 'NEVER', attachments: ['NEVER'] }) });
  assert.deepEqual(result.body.review, privateView);
  await assert.rejects(executeLocalMessage(route, therapist, null, { review() {} }), code('LOCAL_API_UNAVAILABLE'));
  assert.equal(localMessageRoute(new URL('http://127.0.0.1:12345/api/local/centers/c/conversations/r/messages/m/review/history'), 'GET'), null);
});

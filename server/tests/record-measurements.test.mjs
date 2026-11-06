// Invented data in memory-only PGlite; HTTP checks own one ephemeral IPv4
// loopback listener. No E data, external services, native DB or media is used.
import assert from 'node:assert/strict';
import { before, after, beforeEach, afterEach, test } from 'node:test';
import { createServer, request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Records } from '../records.mjs';
import { Conversations } from '../conversations.mjs';
import { Relationships } from '../relationships.mjs';
import { Goals } from '../care-contexts.mjs';
import { Auth } from '../auth.mjs';
import { Children } from '../profiles.mjs';
import { migrate } from '../migrate.mjs';
import { localCareRoute, executeLocalCare } from '../local-care-http.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';

let db, records, goals, relationships, conversations, counter, server, origin, config;
const therapist = { centerId: 'center-a', userId: 'therapist-a' }, guardian = { centerId: 'center-a', userId: 'guardian-a' };
const manager = { centerId: 'center-a', userId: 'manager-a' }, replacement = { centerId: 'center-a', userId: 'therapist-new' };
const prefix = '/api/local/centers/center-a/conversations/room-a';
const dtoKeys = ['recordId', 'recordRevision', 'date', 'title', 'goalId', 'goalTitle', 'ordinal', 'tool', 'item', 'value', 'unit', 'context'].sort();
const errorCode = code => error => error.code === code;
const row = (value = 0) => ({ tool: '합성 ROM', item: '가상 각도', value, unit: '도', context: '같은 가상 조건' });
const content = (extra = {}) => ({ date: '2026-10-01', title: '합성 회기', goalId: 'goal-a', status: 'saved',
  performed: 'PRIVATE-PERFORMED', response: 'PRIVATE-RESPONSE', summary: 'PRIVATE-SUMMARY', privateNote: 'PRIVATE-NOTE',
  nextPlan: 'PRIVATE-PLAN', observation: { status: 'observed', task: 'PRIVATE-OBSERVATION' },
  activity: { title: 'PRIVATE-ACTIVITY', instruction: 'PRIVATE-INSTRUCTION', frequency: 'PRIVATE-FREQUENCY' }, assessments: [row()], ...extra });
const save = (recordId, data = {}, expectedRevision = 0, actor = therapist) => records.save(actor, {
  conversationId: 'room-a', recordId, expectedRevision, clientId: `measure-save-${++counter}`, content: content(data),
});
const page = (input = {}, actor = therapist) => records.measurements(actor, { conversationId: 'room-a', ...input });
async function relation(actor, history = 'from_now') {
  const current = await relationships.get(manager, { conversationId: 'room-a' });
  return relationships.replace(manager, { conversationId: 'room-a', clientId: `measure-relation-${++counter}`,
    expectedVersion: current.version, historyConfirmed: true, ...(history === 'all' ? { pastHistoryConfirmed: true } : {}),
    therapist: { userId: actor.userId, history },
    guardians: [{ userId: guardian.userId, history: 'preserve' }] });
}
before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
});
beforeEach(async () => {
  counter = 0;
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('therapist-a',true),('guardian-a',true),('manager-a',true),('therapist-new',true),('foreign-b',true);
    INSERT INTO cb_memberships VALUES ('center-a','therapist-a','therapist',true),('center-a','guardian-a','guardian',true),
      ('center-a','manager-a','center',true),('center-a','therapist-new','therapist',true),('center-b','foreign-b','therapist',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-other'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),('center-a','room-other','child-other'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','therapist-a','therapist',true,1),('center-a','room-a','guardian-a','guardian',true,1),
      ('center-a','room-other','therapist-a','therapist',true,1),('center-b','room-b','foreign-b','therapist',true,1);
    INSERT INTO cb_goals(center_id,conversation_id,id,title,status) VALUES ('center-a','room-a','goal-a','당시 합성 목표','active'),
      ('center-a','room-other','goal-other','다른 목표','active');`);
  records = new Records(db); goals = new Goals(db); relationships = new Relationships(db); conversations = new Conversations(db);
});

test('measurements return only exact allowed fields and preserve finite zero, negative and decimal values', async () => {
  await save('record-a', { assessments: [row(0), row(-4.5), row(1.25)] });
  const result = await page();
  assert.equal(result.resetRequired, false); assert.equal(result.hasMore, false);
  assert.deepEqual(result.measurements.map(value => value.value), [0, -4.5, 1.25]);
  assert.deepEqual(result.measurements.map(value => value.ordinal), [0, 1, 2]);
  for (const measurement of result.measurements) {
    assert.deepEqual(Object.keys(measurement).sort(), dtoKeys); assert.equal(measurement.recordRevision, 1);
    assert.equal(measurement.goalTitle, '당시 합성 목표');
  }
  assert(!JSON.stringify(result).includes('PRIVATE-'));
  assert.deepEqual(result.nextCursor, { sequence: 1, ordinal: 2 });
});

test('keyset pagination splits a twenty-row record without skipping or repeating rows and uses creation order rather than date', async () => {
  await save('first', { date: '2026-10-09', assessments: Array.from({ length: 20 }, (_, i) => row(i)) });
  await save('second', { date: '2026-01-01', assessments: [row(-1), row(-2)] });
  const combined = []; let after, expectedRevision, current;
  do {
    current = await page({ limit: 7, ...(after ? { after, expectedRevision } : {}) });
    assert.equal(current.resetRequired, false); assert(current.measurements.length <= 7);
    combined.push(...current.measurements); after = current.nextCursor; expectedRevision = current.revision;
  } while (current.hasMore);
  assert.deepEqual(combined.map(value => [value.recordId, value.ordinal]), [
    ...Array.from({ length: 20 }, (_, i) => ['first', i]), ['second', 0], ['second', 1],
  ]);
  const empty = await page({ after, expectedRevision });
  assert.deepEqual(empty.measurements, []); assert.equal(empty.nextCursor, null); assert.equal(empty.hasMore, false);
  assert.equal((await page({ after: { sequence: 0, ordinal: 0 }, limit: 1 })).measurements[0].value, 0);
});

test('only current saved heads appear; both complete and incomplete drafts and old revisions are excluded', async () => {
  await save('edited', { assessments: [row(1), row(2)] });
  await save('edited', { assessments: [row(9)] }, 1);
  await save('complete-draft', { status: 'draft', assessments: [row(7)] });
  await save('incomplete-draft', { status: 'draft', assessments: [{ tool: '가상 도구', item: '', value: null, unit: '', context: '' }] });
  let result = await page(); assert.deepEqual(result.measurements.map(value => [value.recordId, value.recordRevision, value.value]), [['edited', 2, 9]]);
  await save('edited', { status: 'draft', assessments: [row(10)] }, 2);
  result = await page(); assert.deepEqual(result.measurements, []);
  await save('edited', { assessments: [row(0)] }, 3);
  result = await page(); assert.equal(result.measurements[0].recordRevision, 4); assert.equal(result.measurements[0].value, 0);
  assert.equal((await records.get(therapist, { conversationId: 'room-a', recordId: 'edited', revision: 1 })).assessments[0].value, 1);
});

test('goal label comes from the record-pinned goal revision, never the current renamed goal', async () => {
  await save('earlier');
  await goals.save(therapist, { conversationId: 'room-a', goalId: 'goal-a', clientId: 'measure-goal-rename', expectedRevision: 1,
    content: { title: '나중 합성 목표', description: 'PRIVATE-GOAL-DESCRIPTION', status: 'active' } });
  await save('later');
  assert.deepEqual((await page()).measurements.map(value => value.goalTitle), ['당시 합성 목표', '나중 합성 목표']);
});

test('legacy record without a captured goal version returns null label and never guesses a current goal', async () => {
  // A schema-compatible historical fixture is inserted through the normal
  // immutable row/seal constraints. No migration/constraint is disabled.
  await db.transaction(async tx => {
    await tx.query("UPDATE cb_conversations SET last_sequence=1 WHERE center_id='center-a' AND id='room-a'");
    await tx.query(`INSERT INTO cb_records(center_id,conversation_id,id,created_by,created_sequence,current_revision)
      VALUES ('center-a','room-a','legacy','therapist-a',1,1)`);
    await tx.query(`INSERT INTO cb_record_revisions(center_id,conversation_id,record_id,revision,author_id,goal_id,record_date,status,title,
      performed,response,next_plan,summary,private_note,goal_revision) VALUES
      ('center-a','room-a','legacy',1,'therapist-a','goal-a','2026-01-01','saved','합성 이전 기록','','','','','',null)`);
    await tx.query(`INSERT INTO cb_record_assessments(center_id,conversation_id,record_id,revision,ordinal,tool,item,value,unit,context)
      VALUES ('center-a','room-a','legacy',1,0,'합성','각도',0,'도','조건')`);
    await tx.query("UPDATE cb_record_revisions SET sealed=true WHERE record_id='legacy'");
  });
  const result = await page(); assert.equal(result.measurements.length, 1); assert.equal(result.measurements[0].goalTitle, null);
});

test('record edits reset a pinned page epoch instead of silently mixing revisions', async () => {
  await save('record-a', { assessments: [row(0), row(1)] }); const first = await page({ limit: 1 });
  await save('record-a', { assessments: [row(3), row(4)] }, 1);
  const reset = await page({ after: first.nextCursor, expectedRevision: first.revision });
  assert.deepEqual(Object.keys(reset).sort(), ['resetRequired', 'revision']); assert.equal(reset.resetRequired, true); assert(reset.revision > first.revision);
  assert.deepEqual((await page()).measurements.map(value => value.value), [3, 4]);
});

test('future-only assignment excludes earlier records and revocation denies even a formerly valid cursor', async () => {
  await save('earlier'); const first = await page(); await relation(replacement);
  assert.deepEqual((await page({}, replacement)).measurements, []);
  await assert.rejects(page({ after: first.nextCursor, expectedRevision: first.revision }), errorCode('NOT_FOUND'));
  await save('after-assignment', {}, 0, replacement);
  assert.deepEqual((await page({}, replacement)).measurements.map(value => value.recordId), ['after-assignment']);
  await relation(therapist, 'all');
  assert.deepEqual((await page()).measurements.map(value => value.recordId), ['earlier', 'after-assignment']);
  await assert.rejects(page({}, replacement), errorCode('NOT_FOUND'));
});

test('guardian, center manager, unassigned therapist, foreign tenant and inactive identity cannot read measurements', async () => {
  await save('private-record');
  await assert.rejects(page({}, guardian), errorCode('FORBIDDEN'));
  for (const actor of [manager, replacement, { centerId: 'center-b', userId: 'foreign-b' }]) await assert.rejects(page({}, actor), errorCode('NOT_FOUND'));
  assert.deepEqual((await records.measurements(therapist, { conversationId: 'room-other' })).measurements, []);
  await db.query("UPDATE cb_users SET active=false WHERE id='therapist-a'"); await assert.rejects(page(), errorCode('NOT_FOUND'));
});

test('service validates exact cursor keys, finite integers, limits and room epoch before reading', async () => {
  for (const after of [null, [], 0, {}, { sequence: 1 }, { ordinal: 0 }, { sequence: -1, ordinal: 0 },
    { sequence: 1.5, ordinal: 0 }, { sequence: Number.MAX_SAFE_INTEGER + 1, ordinal: 0 }, { sequence: '1', ordinal: 0 },
    { sequence: 1, ordinal: -1 }, { sequence: 1, ordinal: 20 }, { sequence: 1, ordinal: 0, private: true }])
    await assert.rejects(page({ after }), errorCode('INVALID_INPUT'));
  for (const limit of [null, false, 0, -1, 101, 1.5, Infinity, '1']) await assert.rejects(page({ limit }), errorCode('INVALID_INPUT'));
  for (const expectedRevision of [-1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(page({ expectedRevision }), errorCode('INVALID_INPUT'));
  await assert.rejects(page({ unknown: true }), errorCode('INVALID_INPUT'));
  assert.deepEqual((await page({ limit: 100 })).measurements, []);
});

test('HTTP descriptor is GET-only with exact query/cursor grammar and does not reserve a record identifier', () => {
  const route = (suffix, method = 'GET') => localCareRoute(new URL(`http://127.0.0.1:12345${prefix}${suffix}`), method);
  const after = { sequence: 12, ordinal: 19 };
  assert.deepEqual(route(`/measurements?afterMeasurement=${encodeURIComponent(JSON.stringify(after))}&limit=1&expectedRevision=2`).params,
    { after, limit: 1, expectedRevision: 2 });
  for (const query of ['afterMeasurement=oops', 'afterMeasurement=null', 'afterMeasurement=%5B%5D', 'afterMeasurement=%7B%7D',
    'afterMeasurement=%7B%22sequence%22%3A1%2C%22ordinal%22%3A20%7D', 'afterMeasurement=%7B%22sequence%22%3A1%2C%22ordinal%22%3A0%2C%22extra%22%3A1%7D',
    'limit=1&limit=2', 'afterMeasurement=%7B%7D&afterMeasurement=%7B%7D', 'after=1', 'revision=1', 'limit=-1'])
    assert.throws(() => route(`/measurements?${query}`), errorCode('INVALID_INPUT'));
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) assert.throws(() => route('/measurements', method), errorCode('NOT_FOUND'));
  assert.equal(route('/measurements/record-a'), null);
  assert.equal(route('/records/measurements').targetId, 'measurements');
});

test('local measurement projection is an explicit allowlist and only this route requires the new service method', async () => {
  const route = localCareRoute(new URL(`http://127.0.0.1:12345${prefix}/measurements`), 'GET');
  const minimal = { recordId: 'r1', recordRevision: 1, date: '2026-10-01', title: '합성 기록', goalId: 'g1', goalTitle: null, ordinal: 0, ...row() };
  const result = await executeLocalCare(route, therapist, null, { records: { measurements: async () => ({ revision: 1, resetRequired: false,
    measurements: [{ ...minimal, privateNote: 'PRIVATE', attachments: ['PRIVATE'], source: 'PRIVATE' }],
    nextCursor: { sequence: 1, ordinal: 0, raw: 'PRIVATE' }, hasMore: false, secret: 'PRIVATE' }) } });
  assert.deepEqual(result.body.measurements, [minimal]); assert.deepEqual(result.body.nextCursor, { sequence: 1, ordinal: 0 });
  assert(!JSON.stringify(result).includes('PRIVATE'));
  await assert.rejects(executeLocalCare(route, therapist, null, { records: {} }), errorCode('LOCAL_API_UNAVAILABLE'));
  const listRoute = localCareRoute(new URL(`http://127.0.0.1:12345${prefix}/records`), 'GET');
  const oldService = { list: async () => ({ revision: 0, resetRequired: false, records: [], nextCursor: 0, hasMore: false }), get() {}, save() {}, preview() {}, publish() {} };
  assert.equal((await executeLocalCare(listRoute, therapist, null, { records: oldService })).status, 200);
});

async function startHttp() {
  const auth = new Auth(db, { password: { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } });
  const password = 'Synthetic measurements only 2026!';
  for (const userId of ['therapist-a', 'guardian-a', 'manager-a', 'therapist-new', 'foreign-b'])
    await auth.provisionAccount({ userId, email: `${userId}@measurements.test`, password });
  server = createServer(async (req, res) => { if (!await handleLocalApiRequest(req, res, config)) { res.writeHead(404); res.end(); } });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  config = { auth, records, conversations, profiles: new Children(db), origin, cookieName: `cb_local_${randomBytes(16).toString('hex')}` };
  return async (userId = 'therapist-a') => {
    const result = await http('/api/local/auth/login', { method: 'POST', body: { email: `${userId}@measurements.test`, password } });
    assert.equal(result.status, 200); return { cookie: result.headers['set-cookie'][0].split(';')[0], userId };
  };
}
function http(path, { method = 'GET', body, cookie, userId, headers = {} } = {}) {
  const requestHeaders = { ...(method === 'POST' ? { Origin: origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie, 'X-Carebridge-Account': userId } : {}), ...headers };
  for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === undefined) delete requestHeaders[key];
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: requestHeaders, agent: false }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: res.headers, text, body: text ? JSON.parse(text) : null });
      });
    });
    req.once('error', reject); req.setTimeout(8000, () => req.destroy(Error('SYNTHETIC_HTTP_TIMEOUT')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('actual authenticated HTTP measurements preserve account, source, role and room isolation', async () => {
  await save('record-a'); const login = await startHttp(), account = await login();
  const response = await http(`${prefix}/measurements?limit=1`, account);
  assert.equal(response.status, 200); assert.equal(response.body.measurements[0].value, 0);
  assert.deepEqual(Object.keys(response.body.measurements[0]).sort(), dtoKeys); assert(!response.text.includes('PRIVATE-'));
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal((await http(`${prefix}/measurements`)).status, 401);
  assert.equal((await http(`${prefix}/measurements`, { ...account, headers: { 'X-Carebridge-Account': 'guardian-a' } })).status, 401);
  assert.equal((await http(`${prefix}/measurements`, { ...account, headers: { 'X-Carebridge-Account': undefined } })).status, 401);
  assert.equal((await http(`${prefix}/measurements`, { ...account, headers: { Origin: 'https://outside.invalid' } })).status, 403);
  assert.equal((await http(`${prefix}/measurements`, { ...account, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  for (const userId of ['guardian-a', 'manager-a', 'therapist-new', 'foreign-b']) {
    const denied = await http(`${prefix}/measurements`, await login(userId));
    assert.equal(denied.status, 404); assert.equal(denied.body.error, 'NOT_FOUND'); assert(!denied.text.includes('PRIVATE-'));
  }
});

test('actual HTTP rejects malformed measurement pagination and mutations without affecting stored rows', async () => {
  await save('measurements'); const login = await startHttp(), account = await login();
  for (const query of ['limit=0', 'limit=101', 'limit=1&limit=2', 'afterMeasurement=null', 'afterMeasurement=no', 'after=1', 'privateNote=1'])
    assert.equal((await http(`${prefix}/measurements?${query}`, account)).status, 400, query);
  assert.equal((await http(`${prefix}/measurements`, { ...account, method: 'POST', body: {} })).status, 404);
  assert.equal((await http(`${prefix}/measurements/record-a`, account)).status, 404);
  const record = await http(`${prefix}/records/measurements`, account);
  assert.equal(record.status, 200); assert.equal(record.body.record.id, 'measurements');
  assert.equal((await page()).measurements.length, 1);
});

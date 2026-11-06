// Actual Auth/HTTP/domain transactions against one owned memory-only PGlite.
// All people/content are invented; no native/E, deployed or real data resources.
import assert from 'node:assert/strict';
import { before, after, beforeEach, afterEach, test } from 'node:test';
import { createServer, request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Auth } from '../auth.mjs';
import { Children, MemberProfiles } from '../profiles.mjs';
import { Conversations } from '../conversations.mjs';
import { Goals, Appointments } from '../care-contexts.mjs';
import { Records } from '../records.mjs';
import { Relationships } from '../relationships.mjs';
import { migrate } from '../migrate.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';
import { localOperationsRoute, executeLocalOperations } from '../local-operations-http.mjs';

let db, auth, profiles, conversations, goals, appointments, records, relationships, server, origin, options, cookies, loseNextResponse;
const users = ['manager-a', 'manager-peer', 'manager-b', 'therapist-a', 'therapist-peer', 'therapist-b', 'guardian-a', 'stranger-a'];
const manager = { centerId: 'center-a', userId: 'manager-a' };
const therapist = { centerId: 'center-a', userId: 'therapist-a' };
const guardian = { centerId: 'center-a', userId: 'guardian-a' };
const base = '/api/local/centers/center-a/operations', listPath = `${base}/appointments`;
const endpoint = `${base}/conversations/room-a/appointments/appointment-a`;
const clinical = '/api/local/centers/center-a/conversations/room-a';
const range = '?dateFrom=2026-10-01&dateTo=2026-10-31';
const password = 'Invented operations schedule only 2026!';
const content = (extra = {}) => ({ date: '2026-10-09', time: '10:00', duration: 40, title: '가상 일정', room: '가상 장소', status: 'scheduled', ...extra });
const input = (extra = {}) => ({ clientId: randomUUID(), expectedRevision: 0, content: content(), ...extra });
const raw = async table => (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
const mutationState = () => Promise.all(['cb_appointments', 'cb_appointment_revisions', 'cb_context_requests', 'cb_conversations', 'cb_centers'].map(raw));
const unrelatedState = () => Promise.all(['cb_goals', 'cb_goal_revisions', 'cb_messages', 'cb_publications', 'cb_read_states',
  'cb_records', 'cb_record_revisions', 'cb_record_assessments', 'cb_record_references', 'cb_record_attachments',
  'cb_record_publications', 'cb_publication_attachments', 'cb_child_profiles', 'cb_child_family_plans', 'cb_participants', 'cb_audit_events'].map(raw));

before(async () => { db = await PGlite.create(); await migrate(db); });
after(async () => { await db?.close(); });
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; }
});
beforeEach(async () => {
  cookies = new Map(); loseNextResponse = false;
  await db.exec(`TRUNCATE cb_centers,cb_users RESTART IDENTITY CASCADE;
    INSERT INTO cb_centers VALUES ('center-a'),('center-b');
    INSERT INTO cb_users(id,active) VALUES ('manager-a',true),('manager-peer',true),('manager-b',true),
      ('therapist-a',true),('therapist-peer',true),('therapist-b',true),('guardian-a',true),('stranger-a',true);
    INSERT INTO cb_memberships VALUES ('center-a','manager-a','center',true),('center-a','manager-peer','center',true),
      ('center-b','manager-b','center',true),('center-a','therapist-a','therapist',true),('center-a','therapist-peer','therapist',true),
      ('center-b','therapist-b','therapist',true),('center-a','guardian-a','guardian',true),('center-a','stranger-a','guardian',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-second'),('center-a','child-peer'),('center-a','child-empty'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),('center-a','room-second','child-second'),
      ('center-a','room-peer','child-peer'),('center-a','room-empty','child-empty'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','guardian-a','guardian',true,1),
      ('center-a','room-a','therapist-a','therapist',true,1),('center-a','room-second','therapist-a','therapist',true,1),
      ('center-a','room-peer','therapist-peer','therapist',true,1),('center-b','room-b','therapist-b','therapist',true,1)`);
  auth = new Auth(db, { password: { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } });
  for (const userId of users) await auth.provisionAccount({ userId, email: `${userId}@operations-schedule.test`, password });
  profiles = new Children(db); conversations = new Conversations(db); goals = new Goals(db); appointments = new Appointments(db);
  records = new Records(db); relationships = new Relationships(db);
  server = createServer(async (req, res) => {
    // The DB commit is real; only its HTTP acknowledgment is intentionally lost.
    if (loseNextResponse && req.method === 'POST' && req.url === endpoint) {
      loseNextResponse = false; res.end = () => { res.destroy(); return res; };
    }
    if (!await handleLocalApiRequest(req, res, options)) { res.writeHead(404); res.end(); }
  });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  options = { auth, conversations, profiles, goals, appointments, records, relationships, memberProfiles: new MemberProfiles(db),
    origin, cookieName: `cb_local_${randomBytes(16).toString('hex')}` };
});

function call(path = endpoint, { cookie, method = 'GET', body, headers = {}, rawBody } = {}) {
  const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  const requestHeaders = { ...(method === 'POST' ? { Origin: origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie, 'X-Carebridge-Account': cookies.get(cookie) } : {}), ...headers };
  for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === undefined) delete requestHeaders[key];
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: requestHeaders, agent: false }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : null }); });
    });
    req.once('error', reject); req.setTimeout(8000, () => req.destroy(new Error('Synthetic HTTP request timed out.'))); req.end(payload);
  });
}
const post = (cookie, body, path = endpoint, headers) => call(path, { cookie, method: 'POST', body, headers });
async function login(userId = 'manager-a') {
  const result = await post(null, { email: `${userId}@operations-schedule.test`, password }, '/api/local/auth/login');
  assert.equal(result.status, 200); const cookie = result.headers['set-cookie'][0].split(';')[0]; cookies.set(cookie, userId); return cookie;
}
function good(result, status = 200) { assert.equal(result.status, status, result.text); return result.json; }
function denied(result, status, code) {
  assert.equal(result.status, status, result.text); assert.equal(result.json.error, code);
  assert.deepEqual(Object.keys(result.json).sort(), ['error', 'message']);
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.doesNotMatch(result.text, /PRIVATE-|SELECT |cb_|password|stack/);
}
const cursorQuery = (page) => `&expectedVersion=${page.version}&afterAppointment=${encodeURIComponent(JSON.stringify(page.nextCursor))}`;

test('center without clinical participation creates twelve-field schedule and five-field receipt; assigned clinical readers see it', async () => {
  const m = await login(); denied(await call(endpoint, { cookie: m }), 404, 'NOT_FOUND');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM cb_participants WHERE user_id='manager-a'")).rows[0].n, 0);
  assert.deepEqual(good(await call(listPath + range, { cookie: m })).appointments, []);
  assert.deepEqual(good(await post(m, input({ content: content({ title: ' 가상 일정 ', room: ' 가상 장소 ', duration: '040' }) }))),
    { receipt: { kind: 'appointment', id: 'appointment-a', revision: 1, changed: true, replayed: false } });
  const value = good(await call(endpoint, { cookie: m })).appointment;
  assert.deepEqual(Object.keys(value).sort(), ['id', 'conversationId', 'childId', 'revision', 'title', 'status', 'updatedAt', 'date', 'time', 'duration', 'room', 'therapistId'].sort());
  assert.deepEqual(value, { id: 'appointment-a', conversationId: 'room-a', childId: 'child-a', revision: 1,
    ...content(), therapistId: 'therapist-a', updatedAt: value.updatedAt });
  assert.equal(Number.isFinite(Date.parse(value.updatedAt)), true);
  assert.deepEqual(good(await call(listPath + range, { cookie: m })).appointments, [value]);
  for (const userId of ['therapist-a', 'guardian-a']) assert.deepEqual(good(await call(`${clinical}/appointments/appointment-a`, { cookie: await login(userId) })), { appointment: value });
  assert.doesNotMatch(JSON.stringify(await raw('cb_context_requests')), /가상|"title":|"room":/);
});

test('attendance, absence, cancellation and restoration preserve previous versions; no-op and retry do not bump schedule', async () => {
  const m = await login(); good(await post(m, input())); let revision = 1;
  for (const status of ['attended', 'absent', 'cancelled', 'scheduled']) {
    const previous = good(await call(endpoint, { cookie: m })).appointment;
    good(await post(m, input({ expectedRevision: revision, content: content({ status }) })));
    const saved = await appointments.get(manager, { conversationId: 'room-a', appointmentId: 'appointment-a', revision });
    assert.deepEqual({ ...saved, therapistId: previous.therapistId }, previous); revision++;
  }
  const before = await mutationState(), noOp = input({ expectedRevision: revision });
  assert.deepEqual(good(await post(m, noOp)).receipt, { kind: 'appointment', id: 'appointment-a', revision, changed: false, replayed: false });
  assert.equal(good(await post(m, noOp)).receipt.replayed, true);
  const afterState = await mutationState(); for (const index of [0, 1, 3, 4]) assert.deepEqual(afterState[index], before[index]);
  assert.equal(afterState[2].length, before[2].length + 1);
});

test('lost committed response replays the original receipt and never reverts a later edit', async () => {
  const m = await login(), original = input(); loseNextResponse = true;
  await assert.rejects(post(m, original), error => error.code === 'ECONNRESET');
  assert.equal(good(await call(endpoint, { cookie: m })).appointment.revision, 1);
  good(await post(m, input({ expectedRevision: 1, content: content({ time: '11:00' }) })));
  const before = await mutationState();
  assert.deepEqual(good(await post(m, original)).receipt, { kind: 'appointment', id: 'appointment-a', revision: 1, changed: true, replayed: true });
  assert.deepEqual(await mutationState(), before);
  denied(await post(m, { ...original, content: content({ status: 'cancelled' }) }), 409, 'IDEMPOTENCY_CONFLICT');
  denied(await post(m, original, endpoint.replace('room-a', 'room-second')), 409, 'IDEMPOTENCY_CONFLICT');
  denied(await post(m, original, endpoint.replace('appointment-a', 'another')), 409, 'IDEMPOTENCY_CONFLICT');
});

test('two managers use CAS while concurrent copies of one request create one revision and receipt', async () => {
  const m = await login(), peer = await login('manager-peer'), original = input();
  const copies = await Promise.all([post(m, original), post(m, original)]);
  assert.deepEqual(copies.map(result => good(result).receipt.replayed).sort(), [false, true]);
  const edits = await Promise.all([post(m, input({ expectedRevision: 1, content: content({ title: '가상 A' }) })),
    post(peer, input({ expectedRevision: 1, content: content({ title: '가상 B' }) }))]);
  assert.deepEqual(edits.map(result => result.status).sort(), [200, 409]); denied(edits.find(result => result.status === 409), 409, 'APPOINTMENT_CONFLICT');
  assert.equal((await raw('cb_appointment_revisions')).length, 2); assert.equal((await raw('cb_context_requests')).length, 2);
});

test('allocation conflicts cover child, therapist across children and place; adjacency and other centers remain independent', async () => {
  const m = await login(); good(await post(m, input())); const before = await mutationState();
  for (const [path, extra] of [[endpoint.replace('appointment-a', 'overlap-child'), { time: '10:20', room: '다른 장소' }],
    [endpoint.replace('room-a', 'room-second'), { room: '다른 장소' }], [endpoint.replace('room-a', 'room-peer'), {}]])
    denied(await post(m, input({ content: content(extra) }), path), 409, 'SCHEDULE_CONFLICT');
  assert.deepEqual(await mutationState(), before);
  good(await post(m, input({ content: content({ time: '10:40' }) }), endpoint.replace('appointment-a', 'adjacent')));
  good(await post(m, input({ content: content({ room: '다른 장소' }) }), endpoint.replace('room-a', 'room-peer')));
  good(await post(await login('manager-b'), input(), endpoint.replace('center-a', 'center-b').replace('room-a', 'room-b')));
});

test('cancel frees its allocation while conflicting restoration fails atomically and old cancel receipt stays replayable', async () => {
  const m = await login(); good(await post(m, input()));
  const cancelled = input({ expectedRevision: 1, content: content({ status: 'cancelled' }) }); good(await post(m, cancelled));
  good(await post(m, input(), endpoint.replace('appointment-a', 'replacement'))); const before = await mutationState();
  denied(await post(m, input({ expectedRevision: 2 })), 409, 'SCHEDULE_CONFLICT');
  assert.equal(good(await post(m, cancelled)).receipt.replayed, true); assert.deepEqual(await mutationState(), before);
});

test('unassigned or inactive therapist blocks noncancelled changes without blocking safe cancellation or committed replay', async () => {
  const m = await login(), original = input(); good(await post(m, original));
  const before = await mutationState();
  denied(await post(m, input(), endpoint.replace('room-a', 'room-empty')), 409, 'THERAPIST_UNAVAILABLE');
  assert.deepEqual(await mutationState(), before);
  await db.query("UPDATE cb_memberships SET active=false WHERE user_id='therapist-a'");
  assert.equal(good(await call(endpoint, { cookie: m })).appointment.therapistId, null);
  const deactivated = await mutationState();
  denied(await post(m, input({ expectedRevision: 1, content: content({ time: '11:00' }) })), 409, 'THERAPIST_UNAVAILABLE');
  assert.equal(good(await post(m, original)).receipt.replayed, true); assert.deepEqual(await mutationState(), deactivated);
  assert.equal(good(await post(m, input({ expectedRevision: 1, content: content({ status: 'cancelled' }) }))).receipt.revision, 2);
});

test('center-wide keyset pages include multiple rooms and retain final cursor; move resets the old version', async () => {
  const m = await login(); good(await post(m, input()));
  good(await post(m, input({ content: content({ room: '다른 장소' }) }), endpoint.replace('room-a', 'room-peer')));
  const first = good(await call(`${listPath}${range}&limit=1`, { cookie: m }));
  assert.equal(first.hasMore, true); assert.equal(first.appointments[0].conversationId, 'room-a');
  assert.deepEqual(first.nextCursor, { date: '2026-10-09', time: '10:00', conversationId: 'room-a', appointmentId: 'appointment-a' });
  const last = good(await call(`${listPath}${range}&limit=1${cursorQuery(first)}`, { cookie: m }));
  assert.equal(last.hasMore, false); assert.equal(last.appointments[0].conversationId, 'room-peer'); assert.notEqual(last.nextCursor, null);
  assert.deepEqual(good(await call(`${listPath}${range}${cursorQuery(last)}`, { cookie: m })),
    { appointments: [], version: first.version, resetRequired: false, nextCursor: null, hasMore: false });
  good(await post(m, input({ expectedRevision: 1, content: content({ date: '2026-11-09' }) })));
  const reset = good(await call(`${listPath}${range}${cursorQuery(first)}`, { cookie: m }));
  assert.deepEqual(Object.keys(reset).sort(), ['resetRequired', 'version']); assert.equal(reset.resetRequired, true);
  assert.equal(good(await call(endpoint, { cookie: m })).appointment.date, '2026-11-09');
  assert.equal(good(await call(listPath + range, { cookie: m })).appointments.length, 1);
});

test('relationship replacement resets the center schedule version and exposes only the current assigned therapist', async () => {
  const m = await login(); good(await post(m, input())); const page = good(await call(listPath + range, { cookie: m }));
  const previous = await relationships.get(manager, { conversationId: 'room-a' });
  await relationships.replace(manager, { conversationId: 'room-a', clientId: randomUUID(), expectedVersion: previous.version, historyConfirmed: true,
    therapist: { userId: 'therapist-peer', history: 'from_now' }, guardians: [{ userId: 'guardian-a', history: 'preserve' }] });
  assert.equal(good(await call(`${listPath}${range}&expectedVersion=${page.version}`, { cookie: m })).resetRequired, true);
  assert.equal(good(await call(endpoint, { cookie: m })).appointment.therapistId, 'therapist-peer');
  assert.equal(good(await call(`${clinical}/appointments/appointment-a`, { cookie: await login('therapist-peer') })).appointment.revision, 1);
});

test('clinical roles and other tenants cannot enter operations; center cannot read clinical originals or use clinical aliases', async () => {
  const m = await login(); good(await post(m, input())); const before = await mutationState();
  for (const user of ['therapist-a', 'guardian-a', 'stranger-a', 'manager-b']) {
    const cookie = await login(user);
    denied(await call(listPath + range, { cookie }), 404, 'NOT_FOUND'); denied(await call(endpoint, { cookie }), 404, 'NOT_FOUND');
    denied(await post(cookie, input({ expectedRevision: 1 })), 404, 'NOT_FOUND');
  }
  for (const suffix of ['/appointments', '/appointments/appointment-a', '/profile', '/messages', '/family-plan', '/goals', '/records',
    '/records/record-a', '/measurements', '/feedback/feedback-a', '/messages/message-a/review'])
    denied(await call(clinical + suffix, { cookie: m }), 404, 'NOT_FOUND');
  denied(await post(m, input(), `${clinical}/appointments/appointment-a`), 404, 'NOT_FOUND');
  denied(await call('/api/local/centers/center-a/inbox', { cookie: m }), 404, 'NOT_FOUND');
  for (const path of [endpoint.replace('room-a', 'missing'), endpoint.replace('room-a', 'room-b'), endpoint.replace('center-a', 'center-b')]) {
    denied(await call(path, { cookie: m }), 404, 'NOT_FOUND'); denied(await post(m, input(), path), 404, 'NOT_FOUND');
  }
  assert.deepEqual(await mutationState(), before);
});

for (const boundary of ['membership', 'account', 'role']) test(`${boundary} revocation denies new center reads and writes plus already committed exact retries`, async () => {
  const m = await login(), original = input(); good(await post(m, original));
  if (boundary === 'account') await db.query("UPDATE cb_users SET active=false WHERE id='manager-a'");
  else await db.query(boundary === 'role' ? "UPDATE cb_memberships SET role='guardian' WHERE user_id='manager-a'" : "UPDATE cb_memberships SET active=false WHERE user_id='manager-a'");
  const before = await mutationState(), status = boundary === 'account' ? 401 : 404, code = boundary === 'account' ? 'AUTH_REQUIRED' : 'NOT_FOUND';
  denied(await call(listPath + range, { cookie: m }), status, code); denied(await call(endpoint, { cookie: m }), status, code);
  denied(await post(m, original), status, code); denied(await post(m, input({ expectedRevision: 1 })), status, code);
  assert.deepEqual(await mutationState(), before);
});

for (const route of ['get', 'list', 'save']) test(`center-to-therapist role change after authentication is rejected under the ${route} membership lock`, async () => {
  const m = await login(), original = input(); good(await post(m, original)); let cached, before;
  options.auth = { login: auth.login.bind(auth), logout: auth.logout.bind(auth), authenticate: async token => {
    if (!cached) {
      cached = await auth.authenticate(token);
      await db.exec(`UPDATE cb_participants SET active=false WHERE conversation_id='room-a' AND role='therapist';
        UPDATE cb_memberships SET role='therapist' WHERE user_id='manager-a';
        INSERT INTO cb_participants VALUES ('center-a','room-a','manager-a','therapist',true,1)`);
      before = await mutationState();
    }
    return cached; // Deliberately stale auth identity; domain authority remains current.
  } };
  denied(route === 'get' ? await call(endpoint, { cookie: m }) : route === 'list' ? await call(listPath + range, { cookie: m }) : await post(m, original), 404, 'NOT_FOUND');
  assert.deepEqual(await mutationState(), before);
  assert.equal((await appointments.get(manager, { conversationId: 'room-a', appointmentId: 'appointment-a' })).revision, 1);
  assert.equal((await appointments.list(manager, { dateFrom: '2026-10-01', dateTo: '2026-10-31' })).appointments.length, 1);
  assert.equal((await appointments.save(manager, { conversationId: 'room-a', appointmentId: 'appointment-a', ...original })).replayed, true);
});

test('trusted operational and clinical options cannot combine or coerce and do not replace existing default authority', async () => {
  const service = new Appointments({ transaction: () => { assert.fail('Invalid scope must fail before any transaction.'); } });
  for (const trusted of [{ operationalOnly: null }, { operationalOnly: 1 }, { clinicalOnly: 'false' }, { clinicalOnly: true, operationalOnly: true }])
    await assert.rejects(service.get(manager, { conversationId: 'room-a', appointmentId: 'appointment-a' }, trusted), TypeError);
  await appointments.save(manager, { conversationId: 'room-a', appointmentId: 'appointment-a', ...input() });
  assert.equal((await appointments.get(manager, { conversationId: 'room-a', appointmentId: 'appointment-a' }, { operationalOnly: true })).revision, 1);
  for (const actor of [therapist, guardian]) {
    await assert.rejects(appointments.get(actor, { conversationId: 'room-a', appointmentId: 'appointment-a' }, { operationalOnly: true }), error => error.code === 'NOT_FOUND');
    await assert.rejects(appointments.list(actor, { dateFrom: '2026-10-01', dateTo: '2026-10-31' }, { operationalOnly: true }), error => error.code === 'NOT_FOUND');
    assert.equal((await appointments.get(actor, { conversationId: 'room-a', appointmentId: 'appointment-a' }, { clinicalOnly: true })).revision, 1);
  }
  await assert.rejects(appointments.get(manager, { conversationId: 'room-a', appointmentId: 'appointment-a' }, { clinicalOnly: true }), error => error.code === 'NOT_FOUND');
});

test('operational schedule edits leave fixed clinical record, public share, family concern, files and read cursors unchanged', async () => {
  const m = await login(), t = await login('therapist-a'), g = await login('guardian-a'); good(await post(m, input()));
  await goals.save(therapist, { conversationId: 'room-a', goalId: 'goal-a', clientId: randomUUID(), expectedRevision: 0,
    content: { title: '가상 목표', description: 'PRIVATE-GOAL', status: 'active' } });
  await profiles.saveFamilyPlan(guardian, { conversationId: 'room-a', clientId: randomUUID(), expectedRevision: 0, concern: 'PRIVATE-FAMILY' });
  await conversations.sendText(guardian, { conversationId: 'room-a', clientId: randomUUID(), body: 'PRIVATE-MESSAGE' });
  const recordPath = `${clinical}/records/record-a`;
  good(await post(t, { clientId: randomUUID(), expectedRevision: 0, expectedGoalRevision: 1, expectedAppointmentRevision: 1,
    content: { date: '2026-10-09', goalId: 'goal-a', appointmentId: 'appointment-a', title: '가상 기록', performed: '가상 수행',
      response: '가상 반응', nextPlan: '가상 계획', privateNote: 'PRIVATE-CLINICAL', summary: '가상 공개 요약',
      assessments: [{ tool: '가상 도구', item: '항목', value: 0, unit: '회', context: '가상 조건' }],
      activity: { title: '가상 활동', instruction: '가상 안내', frequency: '1회', caution: '' } } }, recordPath), 201);
  const preview = good(await call(`${recordPath}/preview`, { cookie: t })).preview;
  good(await post(t, { clientId: randomUUID(), expectedRevision: preview.recordRevision,
    expectedRelationshipsVersion: preview.relationshipsVersion, recipientIds: preview.recipientIds }, `${recordPath}/publish`), 201);
  const record = good(await call(recordPath, { cookie: t })), messages = good(await call(`${clinical}/messages`, { cookie: g })), before = await unrelatedState();
  for (const path of [listPath + range, endpoint]) assert.doesNotMatch(JSON.stringify(good(await call(path, { cookie: m }))), /PRIVATE-|privateNote|familyPlan|performed|attachments|summary|assessments/);
  good(await post(m, input({ expectedRevision: 1, content: content({ date: '2026-11-09', status: 'cancelled' }) })));
  assert.deepEqual(await unrelatedState(), before); assert.deepEqual(good(await call(recordPath, { cookie: t })), record);
  const nextMessages = good(await call(`${clinical}/messages`, { cookie: g }));
  assert.deepEqual(nextMessages.messages, messages.messages); assert.equal(nextMessages.lastRead, messages.lastRead);
});

test('list queries reject missing/unknown/duplicate values and malformed or unversioned exact cursors', async () => {
  const m = await login(), validCursor = { date: '2026-10-09', time: '10:00', conversationId: 'room-a', appointmentId: 'appointment-a' };
  for (const suffix of ['', '?dateFrom=2026-10-01', '?dateTo=2026-10-31', '?dateFrom=2026-02-30&dateTo=2026-03-01',
    '?dateFrom=2026-10-02&dateTo=2026-10-01', '?dateFrom=2026-01-01&dateTo=2026-12-31', range + '&dateFrom=2026-10-01',
    ...['limit=0', 'limit=101', 'limit=01', 'limit=1.5', 'limit=1&limit=2', 'expectedVersion=-1', 'expectedVersion=9007199254740992',
      'expectedVersion=1&expectedVersion=1', 'conversationId=room-a', 'clinicalOnly=false', 'operationalOnly=true', 'role=center', 'afterId=x', 'afterAppointment=%7B'].map(v => `${range}&${v}`)])
    denied(await call(listPath + suffix, { cookie: m }), 400, 'INVALID_INPUT');
  for (const value of [null, [], {}, { ...validCursor, extra: 1 }, { ...validCursor, time: '25:00' }, { ...validCursor, date: '2026-09-30' },
    { ...validCursor, conversationId: '' }, { ...validCursor, appointmentId: 1 }, { ...validCursor, appointmentId: undefined }])
    denied(await call(`${listPath}${range}&expectedVersion=0&afterAppointment=${encodeURIComponent(JSON.stringify(value))}`, { cookie: m }), 400, 'INVALID_INPUT');
  denied(await call(`${listPath}${range}&afterAppointment=${encodeURIComponent(JSON.stringify(validCursor))}`, { cookie: m }), 400, 'INVALID_INPUT');
  const q = `afterAppointment=${encodeURIComponent(JSON.stringify(validCursor))}`;
  denied(await call(`${listPath}${range}&expectedVersion=0&${q}&${q}`, { cookie: m }), 400, 'INVALID_INPUT');
});

test('strict full replacement validates all six fields and rejects source/role/target injection before mutation', async () => {
  const m = await login(), valid = input(), before = await mutationState();
  const malformed = [null, [], {}, { ...valid, clientId: undefined }, { ...valid, expectedRevision: undefined }, { ...valid, content: null }, { ...valid, content: [] }];
  for (const key of ['date', 'time', 'duration', 'title', 'room', 'status']) malformed.push({ ...valid, content: { ...valid.content, [key]: undefined } });
  for (const extra of [{ date: '2026-02-30' }, { time: '24:00' }, { time: '23:59' }, { duration: 0 }, { duration: 181 }, { duration: null },
    { title: '\ud800' }, { title: 'x\n' }, { title: 'x\u0085' }, { title: 'x'.repeat(101) }, { room: '' }, { room: 'x'.repeat(61) }, { status: null }, { status: 'missing' }])
    malformed.push({ ...valid, content: content(extra) });
  for (const expectedRevision of [null, -1, 0.5, '0', 2147483648]) malformed.push({ ...valid, expectedRevision });
  for (const key of ['conversationId', 'appointmentId', 'therapistId', 'role', 'operationalOnly', 'clinicalOnly', 'privateNote', 'attachments']) {
    malformed.push({ ...valid, [key]: 'PRIVATE-INJECTED' }); malformed.push({ ...valid, content: { ...valid.content, [key]: 'PRIVATE-INJECTED' } });
  }
  for (const body of malformed) denied(await post(m, body), 400, 'INVALID_INPUT');
  denied(await call(endpoint, { cookie: m, method: 'POST', rawBody: '{' }), 400, 'INVALID_INPUT');
  assert.deepEqual(await mutationState(), before);
});

test('only center-wide list and current scoped item GET/POST exist; no history, deletion, clinical or collection-write aliases', async () => {
  const m = await login();
  for (const suffix of ['?revision=1', '?dateFrom=2026-10-01', '?expectedVersion=1', '?limit=1', '?role=center']) {
    denied(await call(endpoint + suffix, { cookie: m }), 400, 'INVALID_INPUT'); denied(await post(m, input(), endpoint + suffix), 400, 'INVALID_INPUT');
  }
  for (const path of [endpoint + '/', endpoint + '/cancel', endpoint + '/publish', endpoint + '/revisions/1',
    endpoint.replace('appointment-a', '%61ppointment-a'), `${base}/conversations/room-a/appointments`, listPath + '/appointment-a', listPath + '/',
    `${base}/conversations/room-a/messages`, `${base}/conversations/room-a/records`]) denied(await call(path, { cookie: m }), 404, 'NOT_FOUND');
  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    denied(await call(endpoint, { cookie: m, method }), 404, 'NOT_FOUND'); denied(await call(listPath + range, { cookie: m, method }), 404, 'NOT_FOUND');
  }
  denied(await post(m, input(), listPath), 404, 'NOT_FOUND');
});

test('session/account/CSRF/origin/host/JSON boundaries and fixed public error projections stay unchanged', async () => {
  const m = await login(), before = await mutationState();
  for (const path of [endpoint, listPath + range]) {
    denied(await call(path), 401, 'AUTH_REQUIRED');
    for (const account of [undefined, 'manager-peer']) denied(await call(path, { cookie: m, headers: { 'X-Carebridge-Account': account } }), 401, 'AUTH_REQUIRED');
    for (const headers of [{ Origin: 'https://foreign.invalid' }, { 'Sec-Fetch-Site': 'same-site' }, { Host: 'localhost:1234' }])
      denied(await call(path, { cookie: m, headers }), 403, 'SOURCE_REJECTED');
  }
  denied(await post(null, input()), 401, 'AUTH_REQUIRED');
  for (const headers of [{ 'X-Carebridge-Account': undefined }, { 'X-Carebridge-Account': 'guardian-a' }]) denied(await post(m, input(), endpoint, headers), 401, 'AUTH_REQUIRED');
  for (const headers of [{ Origin: undefined }, { 'X-Carebridge-Request': undefined }, { Origin: 'https://foreign.invalid' }, { 'Sec-Fetch-Site': 'same-site' }])
    denied(await post(m, input(), endpoint, headers), 403, 'SOURCE_REJECTED');
  denied(await post(m, input(), endpoint, { 'Content-Type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  assert.deepEqual(await mutationState(), before);
});

test('lazy appointment dependency leaves old operations working and exact DTO projections omit extra service fields', async () => {
  const m = await login(); options.appointments = undefined;
  for (const path of [`${base}/children`, `${base}/members`, `${base}/conversations/room-a/profile`, `${base}/conversations/room-a/relationships`]) good(await call(path, { cookie: m }));
  denied(await call(listPath + range, { cookie: m }), 503, 'LOCAL_API_UNAVAILABLE'); denied(await call(endpoint, { cookie: m }), 503, 'LOCAL_API_UNAVAILABLE');
  denied(await post(m, input()), 503, 'LOCAL_API_UNAVAILABLE');
  const value = { id: 'appointment-a', conversationId: 'room-a', childId: 'child-a', revision: 1, ...content(), updatedAt: null, therapistId: null };
  const internal = { ...value, privateNote: 'PRIVATE-NOTE', participants: ['PRIVATE-MEMBER'], familyPlan: 'PRIVATE-FAMILY', authorId: 'PRIVATE-ACTOR' };
  const get = localOperationsRoute(new URL(endpoint, origin), 'GET'), list = localOperationsRoute(new URL(listPath + range, origin), 'GET');
  assert.deepEqual(await executeLocalOperations(get, manager, null, null, { appointments: { get: async (actor, target, trusted) => {
    assert.deepEqual(actor, manager); assert.deepEqual(target, { conversationId: 'room-a', appointmentId: 'appointment-a' }); assert.deepEqual(trusted, { operationalOnly: true }); return internal;
  } } }), { status: 200, body: { appointment: value } });
  const cursor = { date: value.date, time: value.time, conversationId: value.conversationId, appointmentId: value.id };
  assert.deepEqual(await executeLocalOperations(list, manager, null, null, { appointments: { list: async (actor, params, trusted) => {
    assert.deepEqual(params, { dateFrom: '2026-10-01', dateTo: '2026-10-31' }); assert.deepEqual(trusted, { operationalOnly: true });
    return { appointments: [internal], version: 3, resetRequired: false, nextCursor: { ...cursor, privateNote: 'PRIVATE-CURSOR' }, hasMore: false, privateNote: 'PRIVATE-PAGE' };
  } } }), { status: 200, body: { appointments: [value], version: 3, resetRequired: false, nextCursor: cursor, hasMore: false } });
  assert.deepEqual(await executeLocalOperations(list, manager, null, null, { appointments: { list: async () => ({ version: 4, resetRequired: true, appointments: [internal], privateNote: 'PRIVATE-PAGE' }) } }),
    { status: 200, body: { version: 4, resetRequired: true } });
  const receipt = { kind: 'appointment', id: 'appointment-a', revision: 1, changed: true, replayed: false };
  assert.deepEqual(await executeLocalOperations(localOperationsRoute(new URL(endpoint, origin), 'POST'), manager, input(), null,
    { appointments: { save: async (actor, args, trusted) => { assert.deepEqual(trusted, { operationalOnly: true }); return { ...receipt, request_hash: 'PRIVATE-HASH' }; } } }),
  { status: 200, body: { receipt } });
});

test('receipt persistence failure rolls back allocation/history/counters and preserves the same request for one later success', async () => {
  const m = await login(), original = input(), before = await mutationState();
  await db.exec(`CREATE FUNCTION cb_test_operations_schedule_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE-INTERNAL'; END; $$;
    CREATE TRIGGER cb_test_operations_schedule_failure BEFORE INSERT ON cb_context_requests FOR EACH ROW EXECUTE FUNCTION cb_test_operations_schedule_failure()`);
  try { denied(await post(m, original), 503, 'LOCAL_API_UNAVAILABLE'); assert.deepEqual(await mutationState(), before); }
  finally { await db.exec('DROP TRIGGER cb_test_operations_schedule_failure ON cb_context_requests; DROP FUNCTION cb_test_operations_schedule_failure()'); }
  assert.equal(good(await post(m, original)).receipt.replayed, false); assert.equal(good(await post(m, original)).receipt.replayed, true);
  assert.equal((await raw('cb_appointment_revisions')).length, 1); assert.equal((await raw('cb_context_requests')).length, 1);
});

// Real HTTP, Auth and domain transactions; one owned memory-only PGlite.
// Identities/content are invented. No external, native/E or deployed resource.
import assert from 'node:assert/strict';
import { before, after, beforeEach, afterEach, test } from 'node:test';
import { createServer, request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Auth } from '../auth.mjs';
import { Children } from '../profiles.mjs';
import { Conversations } from '../conversations.mjs';
import { Goals, Appointments } from '../care-contexts.mjs';
import { Records } from '../records.mjs';
import { Relationships } from '../relationships.mjs';
import { RepositoryError } from '../errors.mjs';
import { migrate } from '../migrate.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';
import { localCareRoute, executeLocalCare } from '../local-care-http.mjs';

let db, auth, profiles, conversations, goals, appointments, records, relations, server, origin, options, cookies, loseNextResponse;
const actors = ['therapist-a', 'therapist-peer', 'guardian-a', 'guardian-peer', 'manager-a', 'foreign-b'];
const therapist = { centerId: 'center-a', userId: 'therapist-a' }, peer = { centerId: 'center-a', userId: 'therapist-peer' };
const manager = { centerId: 'center-a', userId: 'manager-a' };
const room = '/api/local/centers/center-a/conversations/room-a', listPath = `${room}/appointments`, endpoint = `${listPath}/appointment-a`;
const range = '?dateFrom=2026-10-01&dateTo=2026-10-31';
const password = 'Invented schedule fixture only 2026!';
const content = (extra = {}) => ({ date: '2026-10-09', time: '10:00', duration: 40, title: '가상 일정', room: '가상 치료실', status: 'scheduled', ...extra });
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
    INSERT INTO cb_users(id,active) VALUES ('therapist-a',true),('therapist-peer',true),('guardian-a',true),
      ('guardian-peer',true),('manager-a',true),('foreign-b',true);
    INSERT INTO cb_memberships VALUES ('center-a','therapist-a','therapist',true),('center-a','therapist-peer','therapist',true),
      ('center-a','guardian-a','guardian',true),('center-a','guardian-peer','guardian',true),
      ('center-a','manager-a','center',true),('center-b','foreign-b','therapist',true);
    INSERT INTO cb_children VALUES ('center-a','child-a'),('center-a','child-second'),('center-a','child-peer'),('center-b','child-b');
    INSERT INTO cb_conversations(center_id,id,child_id) VALUES ('center-a','room-a','child-a'),
      ('center-a','room-second','child-second'),('center-a','room-peer','child-peer'),('center-b','room-b','child-b');
    INSERT INTO cb_participants VALUES ('center-a','room-a','guardian-a','guardian',true,1),
      ('center-a','room-a','therapist-a','therapist',true,1),('center-a','room-second','therapist-a','therapist',true,1),
      ('center-a','room-peer','therapist-peer','therapist',true,1),('center-b','room-b','foreign-b','therapist',true,1)`);
  auth = new Auth(db, { password: { N: 1024, r: 8, p: 1, maxmem: 32 * 1024 * 1024 } });
  for (const userId of actors) await auth.provisionAccount({ userId, email: `${userId}@appointments.test`, password });
  profiles = new Children(db); conversations = new Conversations(db); goals = new Goals(db); appointments = new Appointments(db);
  records = new Records(db); relations = new Relationships(db);
  server = createServer(async (req, res) => {
    // Only the acknowledgment is lost: the real write has completed by res.end.
    if (loseNextResponse && req.method === 'POST' && req.url === endpoint) {
      loseNextResponse = false; res.end = () => { res.destroy(); return res; };
    }
    if (!await handleLocalApiRequest(req, res, options)) { res.writeHead(404); res.end(); }
  });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  options = { auth, conversations, profiles, goals, appointments, records, origin, cookieName: `cb_local_${randomBytes(16).toString('hex')}` };
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
async function login(userId = 'therapist-a') {
  const result = await post(null, { email: `${userId}@appointments.test`, password }, '/api/local/auth/login');
  assert.equal(result.status, 200); const cookie = result.headers['set-cookie'][0].split(';')[0]; cookies.set(cookie, userId); return cookie;
}
function good(result, status = 200) { assert.equal(result.status, status, result.text); return result.json; }
function denied(result, status, code) {
  assert.equal(result.status, status, result.text); assert.equal(result.json.error, code);
  assert.deepEqual(Object.keys(result.json).sort(), ['error', 'message']);
  assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.doesNotMatch(result.text, /PRIVATE-|SELECT |cb_|password|stack/);
}
async function replace(therapistId, guardians = [{ userId: 'guardian-a', history: 'preserve' }]) {
  const current = await relations.get(manager, { conversationId: 'room-a' });
  await relations.replace(manager, { conversationId: 'room-a', clientId: randomUUID(), expectedVersion: current.version,
    historyConfirmed: true, therapist: { userId: therapistId, history: 'from_now' }, guardians });
}

test('therapist creation exposes twelve current schedule fields and a five-field receipt to the current team', async () => {
  const t = await login(), g = await login('guardian-a'); denied(await call(endpoint, { cookie: t }), 404, 'NOT_FOUND');
  assert.deepEqual(good(await call(listPath + range, { cookie: t })).appointments, []);
  const body = input({ content: content({ title: ' 가상 일정 ', room: ' 가상 치료실 ', duration: '040' }) });
  assert.deepEqual(good(await post(t, body)), { receipt: { kind: 'appointment', id: 'appointment-a', revision: 1, changed: true, replayed: false } });
  const appointment = good(await call(endpoint, { cookie: t })).appointment;
  assert.deepEqual(Object.keys(appointment).sort(), ['id', 'conversationId', 'childId', 'revision', 'title', 'status', 'updatedAt', 'date', 'time', 'duration', 'room', 'therapistId'].sort());
  assert.deepEqual(appointment, { id: 'appointment-a', conversationId: 'room-a', childId: 'child-a', revision: 1,
    ...content(), therapistId: 'therapist-a', updatedAt: appointment.updatedAt });
  assert.equal(Number.isFinite(Date.parse(appointment.updatedAt)), true);
  assert.deepEqual(good(await call(endpoint, { cookie: g })), { appointment });
  assert.deepEqual(good(await call(listPath + range, { cookie: g })).appointments, [appointment]);
  assert.doesNotMatch(JSON.stringify(await raw('cb_context_requests')), /가상|"title":|"room":/);
});

test('attendance, absence, cancellation and restoration append immutable history; no-op/retry do not bump schedule versions', async () => {
  const t = await login(), g = await login('guardian-a'); good(await post(t, input()));
  let revision = 1;
  for (const status of ['attended', 'absent', 'cancelled', 'scheduled']) {
    const before = good(await call(endpoint, { cookie: t })).appointment;
    good(await post(t, input({ expectedRevision: revision, content: content({ status }) })));
    const historical = await appointments.get(therapist, { conversationId: 'room-a', appointmentId: 'appointment-a', revision });
    assert.deepEqual({ ...historical, therapistId: before.therapistId }, before);
    assert.equal(good(await call(endpoint, { cookie: g })).appointment.status, status); revision++;
  }
  const before = await mutationState(), noOp = input({ expectedRevision: revision });
  assert.deepEqual(good(await post(t, noOp)).receipt, { kind: 'appointment', id: 'appointment-a', revision, changed: false, replayed: false });
  assert.equal(good(await post(t, noOp)).receipt.replayed, true);
  const afterState = await mutationState();
  for (const i of [0, 1, 3, 4]) assert.deepEqual(afterState[i], before[i]);
  assert.equal(afterState[2].length, before[2].length + 1);
});

test('lost acknowledgment returns the exact committed receipt once without reverting a later schedule edit', async () => {
  const t = await login(), original = input(); loseNextResponse = true;
  await assert.rejects(post(t, original), e => e.code === 'ECONNRESET');
  assert.equal(good(await call(endpoint, { cookie: t })).appointment.revision, 1);
  good(await post(t, input({ expectedRevision: 1, content: content({ time: '11:00' }) })));
  const before = await mutationState();
  assert.deepEqual(good(await post(t, original)).receipt, { kind: 'appointment', id: 'appointment-a', revision: 1, changed: true, replayed: true });
  assert.deepEqual(await mutationState(), before);
  denied(await post(t, { ...original, content: content({ status: 'cancelled' }) }), 409, 'IDEMPOTENCY_CONFLICT');
  denied(await post(t, original, endpoint.replace('room-a', 'room-second')), 409, 'IDEMPOTENCY_CONFLICT');
  denied(await post(t, original, endpoint.replace('appointment-a', 'appointment-b')), 409, 'IDEMPOTENCY_CONFLICT');
});

test('concurrent independent sessions use current appointment CAS and cannot both overwrite revision one', async () => {
  const a = await login(), b = await login(); good(await post(a, input()));
  const results = await Promise.all([post(a, input({ expectedRevision: 1, content: content({ title: '가상 A' }) })),
    post(b, input({ expectedRevision: 1, content: content({ title: '가상 B' }) }))]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]); denied(results.find(r => r.status === 409), 409, 'APPOINTMENT_CONFLICT');
  assert.equal((await raw('cb_appointment_revisions')).length, 2); assert.equal((await raw('cb_context_requests')).length, 2);
});

test('same child, same therapist across children and same place across therapists conflict; adjacency and other centers do not', async () => {
  const t = await login(), p = await login('therapist-peer'), foreign = await login('foreign-b'); good(await post(t, input()));
  const before = await mutationState();
  for (const [cookie, path, extra] of [[t, `${listPath}/overlap-child`, { time: '10:20', room: '다른 곳' }],
    [t, endpoint.replace('room-a', 'room-second'), { room: '다른 곳' }], [p, endpoint.replace('room-a', 'room-peer'), {}]])
    denied(await post(cookie, input({ content: content(extra) }), path), 409, 'SCHEDULE_CONFLICT');
  assert.deepEqual(await mutationState(), before);
  good(await post(t, input({ content: content({ time: '10:40' }) }), `${listPath}/adjacent`));
  good(await post(p, input({ content: content({ room: '다른 곳' }) }), endpoint.replace('room-a', 'room-peer')));
  good(await post(foreign, input(), endpoint.replace('center-a', 'center-b').replace('room-a', 'room-b')));
});

test('cancellation releases allocation, conflicting restoration rolls back, and exact cancellation retry remains valid', async () => {
  const t = await login(); good(await post(t, input()));
  const cancel = input({ expectedRevision: 1, content: content({ status: 'cancelled' }) }); good(await post(t, cancel));
  good(await post(t, input(), `${listPath}/replacement`)); const before = await mutationState();
  denied(await post(t, input({ expectedRevision: 2 })), 409, 'SCHEDULE_CONFLICT');
  assert.equal(good(await post(t, cancel)).receipt.replayed, true); assert.deepEqual(await mutationState(), before);
  assert.equal(good(await call(endpoint, { cookie: t })).appointment.status, 'cancelled');
});

test('guardian writes and center clinical namespace access stay denied; unassigned peers and tenant mismatches disclose nothing', async () => {
  const t = await login(); good(await post(t, input())); const before = await mutationState();
  denied(await post(await login('guardian-a'), input({ expectedRevision: 1 })), 404, 'NOT_FOUND');
  for (const userId of ['manager-a', 'guardian-peer', 'therapist-peer', 'foreign-b']) {
    const cookie = await login(userId);
    denied(await call(endpoint, { cookie }), 404, 'NOT_FOUND'); denied(await call(listPath + range, { cookie }), 404, 'NOT_FOUND');
    denied(await post(cookie, input({ expectedRevision: 1 })), 404, 'NOT_FOUND');
  }
  for (const path of [endpoint.replace('room-a', 'room-b'), endpoint.replace('center-a', 'center-b'), endpoint.replace('room-a', 'missing')]) {
    denied(await call(path, { cookie: t }), 404, 'NOT_FOUND'); denied(await post(t, input(), path), 404, 'NOT_FOUND');
  }
  assert.deepEqual(await mutationState(), before);
});

for (const boundary of ['relationship', 'membership', 'account']) test(`${boundary} termination blocks current detail/list and committed exact retries`, async () => {
  const t = await login(), original = input(); good(await post(t, original));
  if (boundary === 'relationship') await replace('therapist-peer');
  else if (boundary === 'membership') await db.query("UPDATE cb_memberships SET active=false WHERE user_id='therapist-a'");
  else await db.query("UPDATE cb_users SET active=false WHERE id='therapist-a'");
  const before = await mutationState(), status = boundary === 'account' ? 401 : 404, code = boundary === 'account' ? 'AUTH_REQUIRED' : 'NOT_FOUND';
  denied(await call(endpoint, { cookie: t }), status, code); denied(await call(listPath + range, { cookie: t }), status, code);
  denied(await post(t, original), status, code); assert.deepEqual(await mutationState(), before);
});

test('current from-now team sees schedule but cannot request historical HTTP or previously private domain revisions', async () => {
  const t = await login(); good(await post(t, input()));
  await replace('therapist-peer', [{ userId: 'guardian-peer', history: 'from_now' }]);
  const p = await login('therapist-peer'), g = await login('guardian-peer');
  for (const cookie of [p, g]) {
    assert.equal(good(await call(endpoint, { cookie })).appointment.revision, 1);
    assert.equal(good(await call(listPath + range, { cookie })).appointments.length, 1);
    denied(await call(`${endpoint}?revision=1`, { cookie }), 400, 'INVALID_INPUT');
  }
  await assert.rejects(appointments.get(peer, { conversationId: 'room-a', appointmentId: 'appointment-a', revision: 1 }), e => e.code === 'NOT_FOUND');
  good(await post(p, input({ expectedRevision: 1, content: content({ status: 'attended' }) })));
  assert.equal((await appointments.get(peer, { conversationId: 'room-a', appointmentId: 'appointment-a', revision: 2 })).status, 'attended');
});

for (const route of ['get', 'list', 'save']) test(`stale authenticated therapist changing to center is rechecked inside ${route} transaction; direct center service stays operational`, async () => {
  const t = await login(), original = input(); good(await post(t, original));
  let cached;
  options.auth = { login: auth.login.bind(auth), logout: auth.logout.bind(auth), authenticate: async token => {
    if (!cached) {
      cached = await auth.authenticate(token);
      await db.exec("DELETE FROM cb_participants WHERE user_id='therapist-a'; UPDATE cb_memberships SET role='center' WHERE user_id='therapist-a'");
    }
    return cached;
  } };
  const result = route === 'get' ? await call(endpoint, { cookie: t }) : route === 'list'
    ? await call(listPath + range, { cookie: t }) : await post(t, original);
  denied(result, 404, 'NOT_FOUND');
  assert.equal((await appointments.get(therapist, { conversationId: 'room-a', appointmentId: 'appointment-a' })).revision, 1);
  assert.equal((await appointments.list(manager, { conversationId: 'room-a', dateFrom: '2026-10-01', dateTo: '2026-10-31' })).appointments.length, 1);
  await assert.rejects(appointments.save(manager, { conversationId: 'room-a', appointmentId: 'appointment-a', ...input({ expectedRevision: 1, content: content({ time: '11:00' }) }) }), e => e.code === 'THERAPIST_UNAVAILABLE');
  const cancelled = await appointments.save(manager, { conversationId: 'room-a', appointmentId: 'appointment-a',
    ...input({ expectedRevision: 1, content: content({ status: 'cancelled' }) }) });
  assert.equal(cancelled.revision, 2);
});

test('schedule edits preserve goals, fixed clinical snapshots, attachments, public shares and read cursors', async () => {
  const t = await login(), g = await login('guardian-a'); good(await post(t, input()));
  await goals.save(therapist, { conversationId: 'room-a', goalId: 'goal-a', clientId: randomUUID(), expectedRevision: 0,
    content: { title: '가상 목표', description: '고정 설명', status: 'active' } });
  const recordPath = `${room}/records/record-a`, recordBody = { clientId: randomUUID(), expectedRevision: 0, expectedGoalRevision: 1, expectedAppointmentRevision: 1,
    content: { date: '2026-10-09', goalId: 'goal-a', appointmentId: 'appointment-a', title: '가상 기록', performed: '가상 수행',
      response: '가상 반응', nextPlan: '가상 계획', summary: '공개 요약', privateNote: 'PRIVATE-NOTE',
      assessments: [{ tool: '가상 도구', item: '항목', value: 0, unit: '회', context: '가상 조건' }],
      activity: { title: '가상 활동', instruction: '가상 안내', frequency: '1회', caution: '' } } };
  good(await post(t, recordBody, recordPath), 201);
  const preview = good(await call(`${recordPath}/preview`, { cookie: t })).preview;
  good(await post(t, { clientId: randomUUID(), expectedRevision: preview.recordRevision,
    expectedRelationshipsVersion: preview.relationshipsVersion, recipientIds: preview.recipientIds }, `${recordPath}/publish`), 201);
  const old = good(await call(recordPath, { cookie: t })), messages = good(await call(`${room}/messages`, { cookie: g }));
  const before = await unrelatedState();
  good(await post(t, input({ expectedRevision: 1, content: content({ date: '2026-11-09', time: '11:00', status: 'cancelled' }) })));
  assert.deepEqual(await unrelatedState(), before); assert.deepEqual(good(await call(recordPath, { cookie: t })), old);
  denied(await post(t, { ...recordBody, clientId: randomUUID(), expectedRevision: 1 }, recordPath), 409, 'CONTEXT_CHANGED');
  assert.deepEqual(await unrelatedState(), before);
  good(await post(t, { ...recordBody, clientId: randomUUID(), expectedRevision: 1, expectedAppointmentRevision: 2 }, recordPath), 201);
  assert.equal(good(await call(recordPath, { cookie: t })).record.appointmentSnapshot.status, 'cancelled');
  assert.deepEqual(good(await call(`${recordPath}?revision=1`, { cookie: t })), old);
  const currentMessages = good(await call(`${room}/messages`, { cookie: g }));
  assert.deepEqual(currentMessages.messages, messages.messages); assert.equal(currentMessages.lastRead, messages.lastRead);
});

test('schedule paging reset tracks content changes and current detail survives moving out of the selected month', async () => {
  const t = await login(); good(await post(t, input()));
  good(await post(t, input({ content: content({ time: '11:00' }) }), `${listPath}/appointment-b`));
  const page = good(await call(`${listPath}${range}&limit=1`, { cookie: t })); assert.equal(page.hasMore, true);
  const cursor = encodeURIComponent(JSON.stringify(page.nextCursor));
  assert.equal(good(await call(`${listPath}${range}&limit=1&afterAppointment=${cursor}&expectedVersion=${page.version}`, { cookie: t })).appointments[0].id, 'appointment-b');
  good(await post(t, input({ expectedRevision: 1, content: content({ date: '2026-11-09' }) })));
  const reset = good(await call(`${listPath}${range}&afterAppointment=${cursor}&expectedVersion=${page.version}`, { cookie: t }));
  assert.deepEqual(Object.keys(reset).sort(), ['resetRequired', 'version']); assert.equal(reset.resetRequired, true);
  assert.equal(good(await call(endpoint, { cookie: t })).appointment.date, '2026-11-09');
  assert(!good(await call(listPath + range, { cookie: t })).appointments.some(a => a.id === 'appointment-a'));
});

test('strict body, scalar, Unicode and date/interval boundaries reject before writes without injecting authority', async () => {
  const t = await login(), valid = input(), before = await mutationState();
  const invalid = [null, [], {}, { ...valid, content: null }, { ...valid, content: [] }];
  for (const key of ['clientId', 'expectedRevision', 'content']) invalid.push({ ...valid, [key]: undefined });
  for (const key of ['date', 'time', 'duration', 'title', 'room', 'status']) invalid.push({ ...valid, content: { ...valid.content, [key]: undefined } });
  for (const [key, maximum] of [['title', 100], ['room', 60]]) for (const value of [null, false, 0, [], {}, '', ' ', '\ud800', '\udc00',
    'x\0', 'x\n', 'x\r', 'x\t', 'x\u0085', 'x\u007f', 'x'.repeat(maximum + 1), ' '.repeat(maximum) + 'x']) invalid.push({ ...valid, content: content({ [key]: value }) });
  for (const extra of [{ status: null }, { status: false }, { status: 'deleted' }, { date: '2026-02-29' }, { date: '0000-01-01' },
    { time: '24:00' }, { time: '10:00:00' }, { time: '23:21' }, { duration: false }, { duration: null }, { duration: {} },
    { duration: 9 }, { duration: 181 }, { duration: 40.1 }, { duration: '4e1' }]) invalid.push({ ...valid, content: content(extra) });
  for (const expectedRevision of [-1, 0.5, '0', null, 2147483648]) invalid.push({ ...valid, expectedRevision });
  for (const clientId of ['', 'short', 'underscore_id', 'x'.repeat(101)]) invalid.push({ ...valid, clientId });
  for (const key of ['role', 'userId', 'appointmentId', 'conversationId', 'childId', 'therapistId', 'revision', 'clinicalOnly', 'attachments']) {
    invalid.push({ ...valid, [key]: 'PRIVATE-INJECTED' }); invalid.push({ ...valid, content: { ...valid.content, [key]: 'PRIVATE-INJECTED' } });
  }
  for (const body of invalid) denied(await post(t, body), 400, 'INVALID_INPUT');
  denied(await call(endpoint, { cookie: t, method: 'POST', rawBody: '{' }), 400, 'INVALID_INPUT');
  assert.deepEqual(await mutationState(), before);
  good(await post(t, input({ content: content({ title: '가'.repeat(100), room: '장'.repeat(60), time: '23:20', duration: '040' }) })));
});

test('direct schedule save uses the shared text validation before any transaction and keeps omitted status default', async () => {
  const before = await mutationState();
  for (const extra of [{ title: '\ud800' }, { title: 'x\t' }, { room: '\udc00' }, { room: 'x\u0080' },
    { title: ' '.repeat(100) + 'x' }, { room: ' '.repeat(60) + 'x' }, { status: null }])
    await assert.rejects(appointments.save(therapist, { conversationId: 'room-a', appointmentId: 'appointment-a', ...input({ content: content(extra) }) }), e => e.code === 'INVALID_INPUT');
  assert.deepEqual(await mutationState(), before);
  const data = content(); delete data.status;
  await appointments.save(manager, { conversationId: 'room-a', appointmentId: 'appointment-a', ...input({ content: data }) });
  assert.equal((await appointments.get(manager, { conversationId: 'room-a', appointmentId: 'appointment-a' })).status, 'scheduled');
});

test('maximum int32 appointment permits unchanged receipt but safely refuses another revision', async () => {
  const t = await login(); good(await post(t, input()));
  // Owned memory-only boundary fixture. The capture trigger still writes the
  // immutable maximum revision; restore the root guard before any HTTP call.
  await db.transaction(async tx => {
    await tx.exec('ALTER TABLE cb_appointments DISABLE TRIGGER cb_appointment_root_guard');
    await tx.exec("UPDATE cb_conversations SET last_sequence=last_sequence+1,revision=revision+1 WHERE id='room-a'");
    await tx.exec("UPDATE cb_appointments SET current_revision=2147483647,changed_sequence=2,updated_at=clock_timestamp() WHERE id='appointment-a'");
    await tx.exec('SET CONSTRAINTS ALL IMMEDIATE');
    await tx.exec('ALTER TABLE cb_appointments ENABLE TRIGGER cb_appointment_root_guard');
  });
  const noOp = input({ expectedRevision: 2147483647 });
  assert.equal(good(await post(t, noOp)).receipt.changed, false); assert.equal(good(await post(t, noOp)).receipt.replayed, true);
  const before = await mutationState();
  denied(await post(t, input({ expectedRevision: 2147483647, content: content({ status: 'cancelled' }) })), 409, 'REVISION_LIMIT');
  assert.deepEqual(await mutationState(), before);
});

test('only exact current GET/POST is mounted; no historical query, delete, actions or collection write', async () => {
  const t = await login();
  for (const suffix of ['?revision=1', '?expectedVersion=1', '?role=therapist', '?x=1&x=2']) {
    denied(await call(endpoint + suffix, { cookie: t }), 400, 'INVALID_INPUT'); denied(await post(t, input(), endpoint + suffix), 400, 'INVALID_INPUT');
  }
  for (const path of [endpoint + '/', endpoint + '/delete', endpoint + '/preview', endpoint + '/publish', endpoint.replace('appointment-a', '%61ppointment-a')])
    denied(await call(path, { cookie: t }), 404, 'NOT_FOUND');
  for (const method of ['PATCH', 'PUT', 'DELETE', 'OPTIONS']) denied(await call(endpoint, { cookie: t, method }), 404, 'NOT_FOUND');
  denied(await post(t, input(), listPath), 404, 'NOT_FOUND');
});

test('source/session/account/CSRF/media-type boundaries and safe failure text stay unchanged', async () => {
  const t = await login(), before = await mutationState();
  denied(await call(endpoint), 401, 'AUTH_REQUIRED'); denied(await post(null, input()), 401, 'AUTH_REQUIRED');
  for (const account of [undefined, 'guardian-a']) {
    denied(await call(endpoint, { cookie: t, headers: { 'X-Carebridge-Account': account } }), 401, 'AUTH_REQUIRED');
    denied(await post(t, input(), endpoint, { 'X-Carebridge-Account': account }), 401, 'AUTH_REQUIRED');
  }
  for (const headers of [{ Origin: 'https://foreign.invalid' }, { 'Sec-Fetch-Site': 'same-site' }, { Host: 'localhost:1234' }]) {
    denied(await call(endpoint, { cookie: t, headers }), 403, 'SOURCE_REJECTED'); denied(await post(t, input(), endpoint, headers), 403, 'SOURCE_REJECTED');
  }
  for (const headers of [{ Origin: undefined }, { 'X-Carebridge-Request': undefined }]) denied(await post(t, input(), endpoint, headers), 403, 'SOURCE_REJECTED');
  denied(await post(t, input(), endpoint, { 'Content-Type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  assert.deepEqual(await mutationState(), before);
});

test('lazy service requirements, explicit DTO whitelists and trusted clinical option keep the existing list contract', async () => {
  const t = await login(); options.appointments = { list: appointments.list.bind(appointments) };
  assert.deepEqual(good(await call(listPath + range, { cookie: t })).appointments, []);
  denied(await call(endpoint, { cookie: t }), 503, 'LOCAL_API_UNAVAILABLE'); denied(await post(t, input()), 503, 'LOCAL_API_UNAVAILABLE');
  const appointment = { id: 'appointment-a', conversationId: 'room-a', childId: 'child-a', revision: 1,
    ...content(), updatedAt: null, therapistId: null };
  const get = localCareRoute(new URL(endpoint, origin), 'GET'), write = localCareRoute(new URL(endpoint, origin), 'POST');
  assert.deepEqual(await executeLocalCare(get, therapist, null, { appointments: { get: async (actor, args, trusted) => {
    assert.deepEqual(actor, therapist); assert.deepEqual(trusted, { clinicalOnly: true });
    return { ...appointment, privateNote: 'PRIVATE-NOTE', authorId: 'PRIVATE-ACTOR' };
  } } }), { status: 200, body: { appointment } });
  const receipt = { kind: 'appointment', id: 'appointment-a', revision: 1, changed: true, replayed: false };
  assert.deepEqual(await executeLocalCare(write, therapist, input(), { appointments: { save: async (actor, args, trusted) => {
    assert.deepEqual(trusted, { clinicalOnly: true }); assert.equal(args.appointmentId, 'appointment-a'); assert.equal(args.conversationId, 'room-a');
    return { ...receipt, request_hash: 'PRIVATE-HASH', content: 'PRIVATE-CONTENT' };
  } } }), { status: 200, body: { receipt } });
  // Explicit error projection double only; allocation itself was verified above.
  for (const code of ['APPOINTMENT_CONFLICT', 'SCHEDULE_CONFLICT', 'THERAPIST_UNAVAILABLE']) {
    options.appointments = { save: async () => { throw new RepositoryError(code); } };
    denied(await post(t, input()), 409, code);
  }
});

test('receipt write failure rolls back allocation/history/counters and permits exactly one same-request success', async () => {
  const t = await login(), body = input(), before = await mutationState();
  await db.exec(`CREATE FUNCTION cb_test_appointment_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE-INTERNAL'; END; $$;
    CREATE TRIGGER cb_test_appointment_failure BEFORE INSERT ON cb_context_requests FOR EACH ROW EXECUTE FUNCTION cb_test_appointment_failure()`);
  try { denied(await post(t, body), 503, 'LOCAL_API_UNAVAILABLE'); assert.deepEqual(await mutationState(), before); }
  finally { await db.exec('DROP TRIGGER cb_test_appointment_failure ON cb_context_requests; DROP FUNCTION cb_test_appointment_failure()'); }
  assert.equal(good(await post(t, body)).receipt.replayed, false); assert.equal(good(await post(t, body)).receipt.replayed, true);
  assert.equal((await raw('cb_appointment_revisions')).length, 1); assert.equal((await raw('cb_context_requests')).length, 1);
});

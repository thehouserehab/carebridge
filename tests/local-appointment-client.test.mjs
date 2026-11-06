// Synthetic transport doubles only: no listener, database, browser or real data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalApiClient, LocalApiError } from '../local-api/client.js';
import { AppointmentApiClient } from '../local-api/appointment-client.js';

const max = 2147483647;
const path = '/api/local/centers/synthetic-center/conversations/synthetic-room/appointments/synthetic-appointment';
const content = (extra = {}) => ({ date: '2026-10-09', time: '10:00', duration: 30, title: '가상 일정', room: '가상 치료실', status: 'scheduled', ...extra });
const dto = (extra = {}) => ({ id: 'synthetic-appointment', conversationId: 'synthetic-room', childId: 'synthetic-child',
  revision: 1, ...content(), updatedAt: '2026-10-09T00:00:00.000Z', therapistId: 'synthetic-therapist', ...extra });
const command = (extra = {}) => ({ clientId: 'synthetic-appointment-request', expectedRevision: 0, content: content(), ...extra });
const receipt = (extra = {}) => ({ kind: 'appointment', id: 'synthetic-appointment', revision: 1, changed: true, replayed: false, ...extra });
const response = (value, status = 200) => ({ status, ok: status >= 200 && status < 300,
  headers: new Headers({ 'content-type': 'application/json' }), json: async () => value });
const code = (expected) => (error) => error instanceof LocalApiError && error.code === expected;
const deferred = () => { const gate = Promise.withResolvers(); gate.promise.catch(() => {}); return gate; };
function client(fetch, options = {}) {
  const base = new LocalApiClient({ fetch, ...options }); base.expectedUserId = 'synthetic-therapist';
  return { base, api: new AppointmentApiClient(base) };
}
const get = (api, signal) => api.appointment('synthetic-center', 'synthetic-room', 'synthetic-appointment', signal);
const save = (api, operation = command(), signal) => api.save('synthetic-center', 'synthetic-room', 'synthetic-appointment', operation, signal);
const call = (mode, api, signal) => mode === 'get' ? get(api, signal) : save(api, command(), signal);
const payload = (mode) => mode === 'get' ? { appointment: dto() } : { receipt: receipt() };

test('composition reuses one authenticated transport without copying credentials or login methods', async () => {
  const { api, base } = client(async () => response({ appointment: dto() }));
  assert.deepEqual(await get(api), dto()); assert.equal(base.expectedUserId, 'synthetic-therapist');
  assert.equal(api.login, undefined); assert.equal(api.session, undefined); assert.equal(api.expectedUserId, undefined);
  assert.equal(JSON.stringify(api), '{}');
  for (const value of [undefined, null, {}, { request: false }]) assert.throws(() => new AppointmentApiClient(value), TypeError);
});

test('GET uses the exact current appointment route and protected transport, without historical query', async () => {
  const calls = [], { api } = client(async (...args) => { calls.push(args); return response({ appointment: dto() }); });
  assert.deepEqual(await get(api), dto()); assert.equal(calls.length, 1);
  const [url, options] = calls[0]; assert.equal(url, path); assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
  assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
  assert.equal(options.headers['X-Carebridge-Account'], 'synthetic-therapist'); assert(options.signal instanceof AbortSignal);
  assert.equal(options.headers['X-Carebridge-Request'], undefined);
});

test('GET preserves all four states, nullable current therapist and maximum stored revision', async () => {
  for (const status of ['scheduled', 'attended', 'absent', 'cancelled']) for (const therapistId of [null, 'synthetic-therapist']) {
    const value = dto({ status, therapistId, revision: max });
    assert.deepEqual(await get(client(async () => response({ appointment: value })).api), value);
  }
});

test('GET projects only twelve detached scheduling fields and drops unrelated clinical history and secrets', async () => {
  const source = dto({ privateNote: 'PRIVATE-NOTE', history: ['PRIVATE-HISTORY'], participants: ['PRIVATE-PERSON'], token: 'PRIVATE-TOKEN' });
  const { api } = client(async () => response({ appointment: source, secret: 'PRIVATE-OUTER' }));
  const result = await get(api); assert.deepEqual(result, dto()); assert.equal(Object.keys(result).length, 12);
  assert(!JSON.stringify(result).includes('PRIVATE-')); source.title = '다른 응답'; assert.equal(result.title, '가상 일정');
  assert.equal(JSON.stringify(api), '{}');
});

test('GET rejects missing fields, malformed envelopes, wrong identities and revisions outside int32', async () => {
  for (const value of [null, [], {}, { appointment: null }, { appointment: [] }])
    await assert.rejects(get(client(async () => response(value)).api), code('INVALID_RESPONSE'));
  const invalid = [{ id: 'another-appointment' }, { conversationId: 'another-room' }, { childId: '' }, { childId: '../child' },
    { childId: 'x'.repeat(101) }, { therapistId: '' }, { therapistId: '../therapist' }, { therapistId: false },
    ...[0, -1, 1.5, '1', undefined, null, NaN, Infinity, max + 1].map((revision) => ({ revision }))].map(dto);
  for (const key of Object.keys(dto())) { const value = dto(); delete value[key]; invalid.push(value); }
  for (const value of invalid) await assert.rejects(get(client(async () => response({ appointment: value })).api), code('INVALID_RESPONSE'));
});

test('GET requires canonical content, numeric duration and a real canonical timestamp', async () => {
  const invalid = [{ date: '2026-02-30' }, { time: '9:00' }, { duration: '30' }, { duration: 0 }, { title: ' 앞' }, { room: '뒤 ' },
    { title: '' }, { room: '' }, { title: 'a\nb' }, { room: 'a\tb' }, { title: '\ud800' }, { room: 'a\x85b' }, { status: null },
    ...[null, 0, '', 'yesterday', '2026-02-30T00:00:00.000Z', '2026-10-09', '2026-10-09T00:00:00Z'].map((updatedAt) => ({ updatedAt }))];
  for (const extra of invalid) await assert.rejects(get(client(async () => response({ appointment: dto(extra) })).api), code('INVALID_RESPONSE'));
});

test('content normalizes exactly six explicit scheduling fields synchronously without mutating input', () => {
  const { api } = client(async () => { throw new Error('No transport expected.'); });
  const input = content({ title: ' 가상 일정 ', room: ' 가상 치료실 ', duration: '030', status: 'absent' });
  assert.deepEqual(api.content(input), content({ status: 'absent' })); assert.equal(input.duration, '030'); assert.equal(input.title, ' 가상 일정 ');
  const normalized = api.content(input); input.room = '수정'; assert.equal(normalized.room, '가상 치료실');
});

test('content refuses missing, null, inherited and extra fields without inventing defaults or clinical content', () => {
  const { api } = client(async () => response({}));
  const invalid = [null, [], {}, Object.create(content()), ...Object.keys(content()).flatMap((key) => {
    const missing = content(); delete missing[key]; return [missing, content({ [key]: null }), content({ [key]: undefined }), content({ [key]: false })];
  }), content({ privateNote: 'PRIVATE-NOTE' }), content({ therapistId: 'other-therapist' }), content({ [Symbol('private')]: 'PRIVATE-SYMBOL' })];
  for (const value of invalid) assert.throws(() => api.content(value), code('INVALID_INPUT'));
});

test('shared appointment validation enforces raw text length, Unicode and one-line controls', () => {
  const { api } = client(async () => response({}));
  for (const key of ['title', 'room']) {
    const maximum = key === 'title' ? 100 : 60;
    for (const value of ['', ' ', ' ' + 'a'.repeat(maximum), '\ud800', '\udfff'])
      assert.throws(() => api.content(content({ [key]: value })), code('INVALID_INPUT'));
    for (const n of [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => i + 127)])
      assert.throws(() => api.content(content({ [key]: `a${String.fromCharCode(n)}b` })), code('INVALID_INPUT'));
    assert.equal(api.content(content({ [key]: 'a'.repeat(maximum) }))[key].length, maximum);
    assert.equal(api.content(content({ [key]: '😀'.repeat(maximum / 2) }))[key].length, maximum);
  }
});

test('calendar, duration and same-day bounds do not silently coerce invalid appointments', () => {
  const { api } = client(async () => response({}));
  const invalid = [
    ...['0000-01-01', '2026-02-29', '2026-04-31', '2026-13-01', '2026-1-01', ' 2026-01-01', '2026-01-01T00:00:00Z'].map((date) => ({ date })),
    ...['24:00', '23:60', '9:00', '09:0', '09:00:00', ' 09:00'].map((time) => ({ time })),
    ...[0, 9, 181, 30.5, NaN, Infinity, '', ' 30', '30 ', '30.0', '3e1', '+30', '-30', '0030'].map((duration) => ({ duration })),
    ...['', 'deleted', 'SCHEDULED', ' scheduled'].map((status) => ({ status })), { time: '23:51', duration: 10 },
  ];
  for (const extra of invalid) assert.throws(() => api.content(content(extra)), code('INVALID_INPUT'));
  for (const extra of [{ date: '2024-02-29' }, { time: '23:50', duration: 10 }, { time: '00:00', duration: 180 }, { duration: '10' }])
    assert.equal(typeof api.content(content(extra)).duration, 'number');
});

test('unsafe route identifiers never reach GET or POST transport', async () => {
  let calls = 0; const { api } = client(async () => { calls++; return response({}); });
  for (const invalid of ['', '../id', 'id?role=center', 'a/b', 'x'.repeat(101), null, 5]) for (const index of [0, 1, 2]) {
    const ids = ['center', 'room', 'appointment']; ids[index] = invalid;
    await assert.rejects(api.appointment(...ids), code('INVALID_INPUT')); await assert.rejects(api.save(...ids, command()), code('INVALID_INPUT'));
  }
  assert.equal(calls, 0);
});

test('save captures six-field normalized content and all command identities before the first await', async () => {
  const gate = deferred(), calls = [], { api } = client(async (...args) => { calls.push(args); return gate.promise; });
  const input = command({ content: content({ title: ' 가상 일정 ', duration: '30' }), role: 'center', privateNote: 'PRIVATE-NOTE' });
  const pending = save(api, input); input.content.title = '다른 일정'; input.content.duration = 90; input.expectedRevision = 50; input.clientId = 'changed-request';
  const [url, options] = calls[0]; assert.equal(url, path); assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), command()); assert(!options.body.includes('PRIVATE-'));
  assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
  assert.equal(options.headers['X-Carebridge-Account'], 'synthetic-therapist');
  assert.equal(options.headers['X-Carebridge-Request'], '1'); assert.equal(options.headers['Content-Type'], 'application/json');
  gate.resolve(response({ receipt: receipt() })); assert.deepEqual(await pending, receipt());
});

test('malformed write commands are rejected before transport', async () => {
  let calls = 0; const { api } = client(async () => { calls++; return response({}); });
  const invalid = [null, [], {}, ...['', 'short', 'bad_id', 'x'.repeat(101), null].map((clientId) => command({ clientId })),
    ...[-1, 0.5, '0', undefined, null, NaN, Infinity, max + 1].map((expectedRevision) => command({ expectedRevision })),
    ...[null, [], {}, Object.create(content()), content({ title: ' ' }), content({ room: null }), content({ status: null }),
      content({ privateNote: 'PRIVATE-NOTE' })].map((value) => command({ content: value }))];
  for (const value of invalid) await assert.rejects(save(api, value), code('INVALID_INPUT'));
  assert.equal(calls, 0);
});

test('write receipts allow creation, updates, no-op and replay including the maximum int32 no-op', async () => {
  for (const expectedRevision of [0, 1, max - 1, max]) for (const changed of [false, true]) for (const replayed of [false, true]) {
    if ((expectedRevision === 0 && !changed) || (expectedRevision === max && changed)) continue;
    const result = receipt({ revision: expectedRevision + Number(changed), changed, replayed });
    assert.deepEqual(await save(client(async () => response({ receipt: result })).api, command({ expectedRevision })), result);
  }
});

test('receipts require the exact appointment, operation, boolean flags and revision arithmetic', async () => {
  for (const extra of [{ kind: 'goal' }, { id: 'other-appointment' }, { changed: false }, { changed: 1 }, { changed: undefined },
    { replayed: undefined }, { replayed: 1 }, ...[0, 2, -1, 0.5, '1', null, undefined, NaN, Infinity, max + 1].map((revision) => ({ revision }))])
    await assert.rejects(save(client(async () => response({ receipt: receipt(extra) })).api), code('INVALID_RESPONSE'));
  for (const value of [null, [], {}, { receipt: null }, { receipt: [] }])
    await assert.rejects(save(client(async () => response(value)).api), code('INVALID_RESPONSE'));
  await assert.rejects(save(client(async () => response({ receipt: receipt({ revision: 0, changed: false }) })).api), code('INVALID_RESPONSE'));
  await assert.rejects(save(client(async () => response({ receipt: receipt({ revision: max + 1 }) })).api,
    command({ expectedRevision: max })), code('INVALID_RESPONSE'));
});

test('receipt projection contains five detached non-content fields only', async () => {
  const source = receipt({ title: 'PRIVATE-TITLE', room: 'PRIVATE-ROOM', userId: 'PRIVATE-USER', token: 'PRIVATE-TOKEN' });
  const { api } = client(async () => response({ receipt: source, secret: 'PRIVATE-OUTER' }));
  const result = await save(api); assert.deepEqual(result, receipt()); assert.equal(Object.keys(result).length, 5);
  assert(!JSON.stringify(result).includes('PRIVATE-')); source.id = 'other'; assert.equal(result.id, 'synthetic-appointment');
  assert.equal(JSON.stringify(api), '{}');
});

test('GET always fetches current state while the server alone decides scheduling authorization', async () => {
  let count = 0; const { api } = client(async () => response({ appointment: dto({ revision: ++count }) }));
  assert.equal((await get(api)).revision, 1); assert.equal((await get(api)).revision, 2);
  const denied = client(async () => response({ error: 'FORBIDDEN' }, 403)); denied.base.expectedUserId = 'synthetic-guardian';
  await assert.rejects(save(denied.api), code('FORBIDDEN'));
});

test('unknown write outcome never triggers retry or a fresh ID; explicit retry sends identical bytes', async () => {
  const calls = [], { api } = client(async (_path, options) => {
    calls.push(options.body); if (calls.length === 1) throw new Error('PRIVATE-TRANSPORT');
    return response({ receipt: receipt({ replayed: true }) });
  });
  const operation = Object.freeze({ ...command(), content: Object.freeze(content()) });
  await assert.rejects(save(api, operation), code('UNAVAILABLE')); assert.equal(calls.length, 1);
  assert.equal((await save(api, operation)).replayed, true); assert.equal(calls.length, 2); assert.equal(calls[0], calls[1]);
});

test('schedule conflicts map to fixed safe messages without other appointments, raw errors or automatic retry', async () => {
  for (const [status, serverCode, expected] of [
    ...['APPOINTMENT_CONFLICT', 'SCHEDULE_CONFLICT', 'THERAPIST_UNAVAILABLE', 'REVISION_LIMIT', 'IDEMPOTENCY_CONFLICT'].map((value) => [409, value, value]),
    [409, 'PRIVATE-CONFLICT', 'IDEMPOTENCY_CONFLICT'], [401, 'AUTH_REQUIRED', 'AUTH_REQUIRED'], [403, 'FORBIDDEN', 'FORBIDDEN'],
    [404, 'NOT_FOUND', 'NOT_FOUND'], [400, 'INVALID_INPUT', 'INVALID_INPUT'], [413, 'PRIVATE-LENGTH', 'INVALID_INPUT'], [503, 'PRIVATE-SERVER', 'UNAVAILABLE'],
  ]) {
    let calls = 0; const { api } = client(async () => { calls++; return response({ error: serverCode, message: 'PRIVATE-DATABASE', otherAppointment: 'PRIVATE-APPOINTMENT' }, status); });
    await assert.rejects(save(api), (error) => code(expected)(error) && error.status === status && !error.message.includes('PRIVATE-'));
    assert.equal(calls, 1);
  }
  assert.match(new LocalApiError('APPOINTMENT_CONFLICT').message, /최신 일정/);
  assert.match(new LocalApiError('SCHEDULE_CONFLICT').message, /시간과 장소/);
  assert.match(new LocalApiError('THERAPIST_UNAVAILABLE').message, /담당 연결/);
});

test('missing account identity and already-aborted signals block GET and POST before transport', async () => {
  let calls = 0; const { api, base } = client(async () => { calls++; return response({}); });
  for (const identity of [null, '', 'bad identity']) { base.expectedUserId = identity;
    for (const mode of ['get', 'save']) await assert.rejects(call(mode, api), code('AUTH_REQUIRED'));
  }
  base.expectedUserId = 'synthetic-therapist'; const abort = new AbortController(); abort.abort();
  for (const mode of ['get', 'save']) await assert.rejects(call(mode, api, abort.signal), code('CANCELLED'));
  assert.equal(calls, 0);
});

test('late account change or cancellation suppresses read content and receipts after fetch, JSON or failure', async () => {
  for (const mode of ['get', 'save']) for (const phase of ['fetch', 'json', 'error']) for (const cancel of [false, true]) {
    const gate = deferred(), abort = new AbortController();
    const { api, base } = client(async () => phase === 'json' ? { ...response({}), json: () => gate.promise } : gate.promise);
    const pending = call(mode, api, abort.signal); await Promise.resolve();
    if (cancel) abort.abort(); else base.expectedUserId = 'synthetic-other-account';
    if (phase === 'error') gate.reject(new Error('PRIVATE-FAILURE')); else gate.resolve(phase === 'json' ? payload(mode) : response(payload(mode)));
    await assert.rejects(pending, code(cancel ? 'CANCELLED' : 'AUTH_REQUIRED'));
  }
});

test('malformed JSON, raw transport errors and deadlines become fixed safe failures without extra requests', async () => {
  for (const mode of ['get', 'save']) {
    let calls = 0; const { api } = client(async (_path, options) => { calls++;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('PRIVATE-TIMEOUT')), { once: true }));
    }, { timeoutMs: 5 });
    await assert.rejects(call(mode, api), (error) => code('UNAVAILABLE')(error) && !error.message.includes('PRIVATE-')); assert.equal(calls, 1);
    const malformed = client(async () => ({ ...response({}), json: async () => { throw new Error('PRIVATE-JSON'); } })).api;
    await assert.rejects(call(mode, malformed), code('INVALID_RESPONSE'));
    const raw = new AppointmentApiClient({ expectedUserId: 'synthetic-therapist', request: async () => { throw new Error('PRIVATE-RAW'); } });
    await assert.rejects(call(mode, raw), (error) => code('UNAVAILABLE')(error) && !error.message.includes('PRIVATE-'));
  }
});

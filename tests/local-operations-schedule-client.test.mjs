// Synthetic transport doubles only: no service, database, browser or real data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalApiClient, LocalApiError } from '../local-api/client.js';
import { AppointmentApiClient } from '../local-api/appointment-client.js';

const basePath = '/api/local/centers/synthetic-center/operations';
const dates = extra => ({ dateFrom: '2026-10-01', dateTo: '2026-10-31', ...extra });
const content = extra => ({ date: '2026-10-10', time: '10:00', duration: 30, title: '가상 일정', room: '가상 치료실', status: 'scheduled', ...extra });
const dto = extra => ({ id: 'appointment-a', conversationId: 'room-a', childId: 'child-a', revision: 1, ...content(),
  updatedAt: '2026-10-10T00:00:00.000Z', therapistId: 'therapist-a', ...extra });
const position = row => row ? { date: row.date, time: row.time, conversationId: row.conversationId, appointmentId: row.id } : null;
const page = (rows = [dto()], extra = {}) => ({ appointments: rows, version: 7, resetRequired: false,
  nextCursor: position(rows.at(-1)), hasMore: false, ...extra });
const command = extra => ({ clientId: 'synthetic-schedule-command', expectedRevision: 0, content: content(), ...extra });
const receipt = extra => ({ kind: 'appointment', id: 'appointment-a', revision: 1, changed: true, replayed: false, ...extra });
const response = (value, status = 200) => ({ status, ok: status >= 200 && status < 300,
  headers: new Headers({ 'content-type': 'application/json' }), json: async () => value });
const code = expected => error => error instanceof LocalApiError && error.code === expected;
const deferred = () => { const gate = Promise.withResolvers(); gate.promise.catch(() => {}); return gate; };
function fixture(fetch, options = { operational: true }, transportOptions = {}) {
  const base = new LocalApiClient({ fetch, ...transportOptions }); base.expectedUserId = 'synthetic-manager';
  return { base, api: new AppointmentApiClient(base, options) };
}
const list = (api, range = dates(), signal) => api.list('synthetic-center', range, signal);
const get = (api, signal) => api.appointment('synthetic-center', 'room-a', 'appointment-a', signal);
const save = (api, operation = command(), signal) => api.save('synthetic-center', 'room-a', 'appointment-a', operation, signal);
const calls = { list: (api, signal) => list(api, dates(), signal), get, save: (api, signal) => save(api, command(), signal) };
const payloads = { list: () => page(), get: () => ({ appointment: dto() }), save: () => ({ receipt: receipt() }) };

test('mode is an explicit fixed private choice, not a role/query parameter or copied credential', async () => {
  const seen = [], options = { operational: true };
  const { api, base } = fixture(async (url) => { seen.push(url); return response({ appointment: dto() }); }, options);
  options.operational = false; assert.deepEqual(await get(api), dto());
  assert.equal(seen[0], `${basePath}/conversations/room-a/appointments/appointment-a`);
  assert.equal(JSON.stringify(api), '{}'); assert.equal(api.expectedUserId, undefined); assert.equal(api.login, undefined);
  assert.equal(base.expectedUserId, 'synthetic-manager');
  for (const bad of [null, [], true, 'center', { operational: null }, { operational: undefined }, { operational: 1 },
    { operational: 'true' }, { operational: true, role: 'center' }, { [Symbol('mode')]: true }])
    assert.throws(() => new AppointmentApiClient(base, bad), TypeError);
});

test('default and false modes preserve clinical detail/write paths and reject operational collection before transport', async () => {
  for (const options of [undefined, {}, { operational: false }]) {
    const seen = [], { base } = fixture(async (url, init) => { seen.push(url); return response(init.method === 'POST' ? { receipt: receipt() } : { appointment: dto() }); });
    const api = options === undefined ? new AppointmentApiClient(base) : new AppointmentApiClient(base, options);
    await assert.rejects(list(api), code('INVALID_INPUT')); assert.equal(seen.length, 0);
    await get(api); await save(api);
    assert(seen.every(url => url === '/api/local/centers/synthetic-center/conversations/room-a/appointments/appointment-a'));
  }
});

test('list uses only the operational collection and one protected transport with explicit date and page size', async () => {
  const seen = [], { api } = fixture(async (...args) => { seen.push(args); return response(page()); });
  assert.deepEqual(await list(api), { appointments: [dto()], version: 7 }); assert.equal(seen.length, 1);
  const [path, init] = seen[0], url = new URL(path, 'http://127.0.0.1');
  assert.equal(url.pathname, `${basePath}/appointments`);
  assert.deepEqual(Object.fromEntries(url.searchParams), { dateFrom: '2026-10-01', dateTo: '2026-10-31', limit: '100' });
  assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.credentials, 'same-origin');
  assert.equal(init.cache, 'no-store'); assert.equal(init.redirect, 'error'); assert.equal(init.headers['X-Carebridge-Account'], 'synthetic-manager');
  assert(init.signal instanceof AbortSignal); assert.equal(init.headers['X-Carebridge-Request'], undefined);
});

test('multi-room pagination binds global version and exact last-row cursor, permitting repeated IDs across rooms', async () => {
  const first = dto(), second = dto({ conversationId: 'room-b', childId: 'child-b', therapistId: null }), seen = [];
  const { api } = fixture(async (path) => { seen.push(new URL(path, 'http://127.0.0.1'));
    return response(page(seen.length === 1 ? [first] : [second], { version: Number.MAX_SAFE_INTEGER, hasMore: seen.length === 1 })); });
  assert.deepEqual(await list(api), { appointments: [first, second], version: Number.MAX_SAFE_INTEGER });
  assert.equal(seen.length, 2); assert.equal(seen[1].searchParams.get('expectedVersion'), String(Number.MAX_SAFE_INTEGER));
  assert.deepEqual(JSON.parse(seen[1].searchParams.get('afterAppointment')), position(first));
  assert.equal(seen[1].searchParams.get('dateFrom'), dates().dateFrom);
});

test('query period is captured before the first await and later input mutations cannot switch the page scope', async () => {
  const gate = deferred(), seen = [], range = dates();
  const { api } = fixture(async path => { seen.push(new URL(path, 'http://127.0.0.1')); return seen.length === 1 ? gate.promise : response(page([dto({ id: 'appointment-b' })])); });
  const pending = list(api, range); range.dateFrom = '2027-01-01'; range.dateTo = '2027-12-31';
  gate.resolve(response(page([dto()], { hasMore: true }))); await pending;
  for (const url of seen) { assert.equal(url.searchParams.get('dateFrom'), dates().dateFrom); assert.equal(url.searchParams.get('dateTo'), dates().dateTo); }
});

test('empty schedules and all stored states are explicit, current and not cached', async () => {
  let count = 0; const { api } = fixture(async () => response(count++ === 0 ? page([], { version: 0 }) : page([
    ...['scheduled', 'attended', 'absent', 'cancelled'].map((status, index) => dto({ id: `appointment-${index}`, status, therapistId: null, revision: 2147483647 })),
  ], { version: 8 })));
  assert.deepEqual(await list(api), { appointments: [], version: 0 }); const next = await list(api);
  assert.equal(next.version, 8); assert.equal(next.appointments.length, 4); assert.equal(count, 2);
});

test('date ranges use real calendar dates and a 92-day difference bound, with no coercion or extra filters', async () => {
  let count = 0; const { api } = fixture(async () => { count++; return response(page([])); });
  const invalid = [null, [], {}, Object.create(dates()), dates({ role: 'center' }), dates({ [Symbol('filter')]: 1 }),
    dates({ dateFrom: '2026-02-29' }), dates({ dateTo: '2026-04-31' }), dates({ dateFrom: '0000-01-01' }),
    dates({ dateFrom: '2026-10-10', dateTo: '2026-10-09' }), dates({ dateFrom: '2026-01-01', dateTo: '2026-04-04' }),
    dates({ dateFrom: ' 2026-10-01' }), dates({ dateFrom: '2026-10-1' }), dates({ dateTo: null }), dates({ dateTo: 20261031 })];
  for (const value of invalid) await assert.rejects(list(api, value), code('INVALID_INPUT'));
  assert.equal(count, 0);
  await list(api, { dateFrom: '2026-01-01', dateTo: '2026-04-03' }); await list(api, { dateFrom: '2024-02-29', dateTo: '2024-02-29' });
  assert.equal(count, 2);
});

test('unsafe route IDs never reach list, operational detail or writes', async () => {
  let count = 0; const { api } = fixture(async () => { count++; return response({}); });
  for (const invalid of ['', '../center', 'a?role=center', 'a/b', 'x'.repeat(101), null, 3]) {
    await assert.rejects(api.list(invalid, dates()), code('INVALID_INPUT'));
    for (const index of [0, 1, 2]) {
      const ids = ['center', 'room', 'appointment']; ids[index] = invalid;
      await assert.rejects(api.appointment(...ids), code('INVALID_INPUT')); await assert.rejects(api.save(...ids, command()), code('INVALID_INPUT'));
    }
  }
  assert.equal(count, 0);
});

test('reset and silently changed versions discard partial rows and fail once without automatic restart', async () => {
  for (const later of [{ version: 8, resetRequired: true }, page([dto({ id: 'new-row' })], { version: 8 })]) {
    let count = 0; const { api } = fixture(async () => response(++count === 1 ? page([dto()], { hasMore: true }) : later));
    await assert.rejects(list(api), code('SNAPSHOT_CHANGED')); assert.equal(count, 2);
  }
  let count = 0; const { api } = fixture(async () => { count++; return response({ version: 7, resetRequired: true }); });
  await assert.rejects(list(api), code('SNAPSHOT_CHANGED')); assert.equal(count, 1);
});

test('malformed envelopes and schedule versions cannot become successful empty or partial lists', async () => {
  const malformed = [null, [], {}, { resetRequired: true }, page(undefined, { resetRequired: 'false' }),
    ...[-1, 1.5, '1', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(version => page(undefined, { version })),
    page(undefined, { hasMore: 0 }), page(undefined, { appointments: null }), page(undefined, { appointments: {} }),
    page(undefined, { nextCursor: undefined }), page(undefined, { nextCursor: null })];
  for (const value of malformed) await assert.rejects(list(fixture(async () => response(value)).api), code('INVALID_RESPONSE'));
});

test('list rows share exact canonical twelve-field validation and exclude out-of-range schedules', async () => {
  const invalid = [null, [], {}, dto({ id: '' }), dto({ conversationId: '../room' }), dto({ childId: null }), dto({ therapistId: false }),
    dto({ revision: 0 }), dto({ revision: 2147483648 }), dto({ date: '2026-09-30' }), dto({ date: '2026-11-01' }), dto({ date: '2026-02-30' }),
    dto({ duration: '30' }), dto({ room: ' 뒤 ' }), dto({ title: '\ud800' }), dto({ status: null }), dto({ time: '24:00' }),
    dto({ updatedAt: '2026-10-10T00:00:00Z' })];
  for (const key of Object.keys(dto())) { const value = dto(); delete value[key]; invalid.push(value); }
  for (const row of invalid) await assert.rejects(list(fixture(async () => response(page([row]))).api), code('INVALID_RESPONSE'));
  const sparse = new Array(1); await assert.rejects(list(fixture(async () => response(page(sparse))).api), code('INVALID_RESPONSE'));
});

test('minimal row projection strips clinical, profile, account, cursor extras and detaches returned values', async () => {
  const row = dto({ privateNote: 'PRIVATE-NOTE', concern: 'PRIVATE-CONCERN', token: 'PRIVATE-TOKEN', participants: ['PRIVATE-USER'] });
  const { api } = fixture(async () => response(page([row], { unrelated: 'PRIVATE-OUTER' })));
  const result = await list(api); assert.deepEqual(result, { appointments: [dto()], version: 7 });
  assert.equal(Object.keys(result.appointments[0]).length, 12); assert(!JSON.stringify(result).includes('PRIVATE-'));
  row.title = '원 응답 변경'; assert.equal(result.appointments[0].title, '가상 일정'); assert.equal(JSON.stringify(api), '{}');
});

test('last-row cursors require exact four keys, valid dates/time/identities and row identity equality', async () => {
  const first = position(dto());
  for (const nextCursor of [undefined, null, [], {}, { ...first, date: '2026-02-30' }, { ...first, time: '10:0' },
    { ...first, time: '11:00' }, { ...first, conversationId: 'room-b' }, { ...first, appointmentId: 'another' },
    { ...first, privateNote: 'PRIVATE-CURSOR' }, { ...first, [Symbol('key')]: 'private' }])
    await assert.rejects(list(fixture(async () => response(page([dto()], { nextCursor }))).api), code('INVALID_RESPONSE'));
  for (const value of [page([], { hasMore: true }), page([], { nextCursor: first })])
    await assert.rejects(list(fixture(async () => response(value)).api), code('INVALID_RESPONSE'));
});

test('repeated row/cursor and reverse chronological progress fail; database ID collation is not reinvented', async () => {
  for (const rows of [[dto(), dto()], [dto({ id: 'b' }), dto({ id: 'b', revision: 2 })],
    [dto(), dto({ id: 'b', time: '09:00' })], [dto(), dto({ id: 'b', date: '2026-10-09' })]])
    await assert.rejects(list(fixture(async () => response(page(rows))).api), code('INVALID_RESPONSE'));
  let count = 0; const duplicate = fixture(async () => response(page([dto()], { hasMore: ++count === 1 }))).api;
  await assert.rejects(list(duplicate), code('INVALID_RESPONSE')); assert.equal(count, 2);
  // Equal date/time permits IDs in the database's order, even if JS compares
  // their spelling differently. Composite identity, not JS locale sort, wins.
  const rows = [dto({ id: 'z' }), dto({ id: 'A' })]; assert.deepEqual((await list(fixture(async () => response(page(rows))).api)).appointments, rows);
});

test('twenty full pages are permitted but the 2001st entry is never silently truncated or requested', async () => {
  for (const overflow of [false, true]) {
    let count = 0; const { api } = fixture(async () => {
      const index = count++, rows = Array.from({ length: 100 }, (_, i) => dto({ id: `appointment-${index * 100 + i}` }));
      return response(page(rows, { hasMore: overflow || count < 20 }));
    });
    if (overflow) await assert.rejects(list(api), code('TOO_MUCH_DATA'));
    else assert.equal((await list(api)).appointments.length, 2000);
    assert.equal(count, 20);
  }
  const tooMany = Array.from({ length: 101 }, (_, i) => dto({ id: `appointment-${i}` }));
  await assert.rejects(list(fixture(async () => response(page(tooMany))).api), code('INVALID_RESPONSE'));
});

test('failed later pages return no partial rows and an explicit next call starts a new independent snapshot', async () => {
  let count = 0; const { api } = fixture(async () => {
    count++; if (count === 1) return response(page([dto()], { hasMore: true }));
    if (count === 2) throw new Error('PRIVATE-DB'); return response(page([], { version: 9 }));
  });
  await assert.rejects(list(api), code('UNAVAILABLE')); assert.equal(count, 2);
  assert.deepEqual(await list(api), { appointments: [], version: 9 }); assert.equal(count, 3);
});

test('operational current detail uses the same minimum DTO and rejects room or appointment mismatch', async () => {
  const seen = [], { api } = fixture(async path => { seen.push(path); return response({ appointment: dto({ privateNote: 'PRIVATE' }) }); });
  assert.deepEqual(await get(api), dto()); assert.equal(seen[0], `${basePath}/conversations/room-a/appointments/appointment-a`);
  for (const change of [{ conversationId: 'room-b' }, { id: 'appointment-b' }])
    await assert.rejects(get(fixture(async () => response({ appointment: dto(change) })).api), code('INVALID_RESPONSE'));
});

test('operational save captures immutable six-field content and IDs before awaiting with unchanged receipt rules', async () => {
  const gate = deferred(), seen = [], { api } = fixture(async (...args) => { seen.push(args); return gate.promise; });
  const operation = command({ content: content({ title: ' 가상 일정 ', duration: '030' }), role: 'center' });
  const pending = save(api, operation); operation.content.title = '변경'; operation.expectedRevision = 5; operation.clientId = 'changed-request';
  assert.equal(seen[0][0], `${basePath}/conversations/room-a/appointments/appointment-a`);
  assert.deepEqual(JSON.parse(seen[0][1].body), command()); assert.equal(seen[0][1].headers['X-Carebridge-Request'], '1');
  gate.resolve(response({ receipt: receipt({ privateNote: 'PRIVATE' }) })); assert.deepEqual(await pending, receipt());
  const maximum = command({ expectedRevision: 2147483647 });
  assert.deepEqual(await save(fixture(async () => response({ receipt: receipt({ revision: 2147483647, changed: false, replayed: true }) })).api, maximum),
    receipt({ revision: 2147483647, changed: false, replayed: true }));
});

test('unknown operational save never retries automatically and explicit receipt retry preserves request bytes', async () => {
  const seen = [], { api } = fixture(async (path, init) => { seen.push({ path, body: init.body });
    if (seen.length === 1) throw new Error('PRIVATE-TRANSPORT'); return response({ receipt: receipt({ replayed: true }) }); });
  const operation = Object.freeze({ ...command(), content: Object.freeze(content()) });
  await assert.rejects(save(api, operation), code('UNAVAILABLE')); assert.equal(seen.length, 1);
  assert.equal((await save(api, operation)).replayed, true); assert.deepEqual(seen[0], seen[1]); assert.equal(seen.length, 2);
});

test('server alone grants center access and fixed errors never disclose conflicting schedules or raw messages', async () => {
  for (const [status, error, expected] of [[401, 'AUTH_REQUIRED', 'AUTH_REQUIRED'], [404, 'NOT_FOUND', 'NOT_FOUND'],
    [409, 'APPOINTMENT_CONFLICT', 'APPOINTMENT_CONFLICT'], [409, 'SCHEDULE_CONFLICT', 'SCHEDULE_CONFLICT'],
    [409, 'THERAPIST_UNAVAILABLE', 'THERAPIST_UNAVAILABLE'], [503, 'PRIVATE-SERVER', 'UNAVAILABLE']]) {
    let count = 0; const { api, base } = fixture(async () => { count++; return response({ error, message: 'PRIVATE-ERROR', otherAppointment: dto() }, status); });
    base.expectedUserId = 'synthetic-guardian';
    await assert.rejects(save(api), failure => code(expected)(failure) && !failure.message.includes('PRIVATE-'));
    assert.equal(count, 1);
  }
});

test('absent account and pre-aborted signal block all operational methods before transport', async () => {
  let count = 0; const { api, base } = fixture(async () => { count++; return response({}); });
  for (const missing of [null, '', 'bad account']) {
    base.expectedUserId = missing;
    for (const call of Object.values(calls)) await assert.rejects(call(api), code('AUTH_REQUIRED'));
  }
  base.expectedUserId = 'synthetic-manager'; const abort = new AbortController(); abort.abort();
  for (const call of Object.values(calls)) await assert.rejects(call(api, abort.signal), code('CANCELLED'));
  assert.equal(count, 0);
});

test('late account change or abort discards operational data/receipts at fetch, body decode and failure boundaries', async () => {
  for (const mode of Object.keys(calls)) for (const phase of ['fetch', 'json', 'error']) for (const cancel of [false, true]) {
    const gate = deferred(), abort = new AbortController();
    const { api, base } = fixture(async () => phase === 'json' ? { ...response({}), json: () => gate.promise } : gate.promise);
    const pending = calls[mode](api, abort.signal); await Promise.resolve();
    if (cancel) abort.abort(); else base.expectedUserId = 'synthetic-other-account';
    if (phase === 'error') gate.reject(new Error('PRIVATE-FAILURE'));
    else gate.resolve(phase === 'json' ? payloads[mode]() : response(payloads[mode]()));
    await assert.rejects(pending, code(cancel ? 'CANCELLED' : 'AUTH_REQUIRED'));
  }
});

test('mid-pagination account change cannot concatenate another identity or expose already-collected rows', async () => {
  const gate = deferred(); let count = 0;
  const { api, base } = fixture(async () => ++count === 1 ? response(page([dto()], { hasMore: true })) : gate.promise);
  const pending = list(api); for (let i = 0; count < 2 && i < 20; i++) await Promise.resolve(); assert.equal(count, 2);
  base.expectedUserId = 'other-manager'; gate.resolve(response(page([dto({ id: 'other' })])));
  await assert.rejects(pending, code('AUTH_REQUIRED')); assert.equal(count, 2);
});

test('bounded transport timeout, invalid JSON and raw errors retain safe failure behavior with no extra request', async () => {
  for (const mode of Object.keys(calls)) {
    let count = 0; const { api } = fixture(async (_path, init) => { count++;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('PRIVATE-TIMEOUT')), { once: true }));
    }, { operational: true }, { timeoutMs: 5 });
    await assert.rejects(calls[mode](api), failure => code('UNAVAILABLE')(failure) && !failure.message.includes('PRIVATE-')); assert.equal(count, 1);
    const bad = fixture(async () => ({ ...response({}), json: async () => { throw new Error('PRIVATE-JSON'); } })).api;
    await assert.rejects(calls[mode](bad), code('INVALID_RESPONSE'));
  }
});

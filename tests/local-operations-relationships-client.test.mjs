// Synthetic HTTP/transport doubles only; no API, browser or database is started.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalApiClient, LocalApiError } from '../local-api/client.js';
import { OperationsApiClient, relationshipFields } from '../local-api/operations-client.js';

const root = '/api/local/centers/synthetic-center/operations';
const roomPath = `${root}/conversations/synthetic-room/relationships`;
const person = (userId = 'synthetic-guardian', history = 'from_now') => ({ userId, history });
const fields = (extra = {}) => ({ therapist: person('synthetic-therapist'), guardians: [person()],
  historyConfirmed: true, pastHistoryConfirmed: false, ...extra });
const command = (extra = {}) => ({ clientId: 'synthetic-relation-request', expectedVersion: 3, ...fields(), ...extra });
const content = (extra = {}) => ({ name: '가상 아이', age: 0, ageAsOf: '2024-02-29', ...extra });
const registration = (extra = {}) => ({ clientId: 'synthetic-registration-request', childId: 'synthetic-child',
  conversationId: 'synthetic-room', content: content(), ...extra });
const registerReceipt = (extra = {}) => ({ operation: 'child.register', childId: 'synthetic-child', conversationId: 'synthetic-room',
  appliedVersion: 1, changed: true, replayed: false, ...extra });
const member = (extra = {}) => ({ userId: 'synthetic-guardian', role: 'guardian', displayName: '가상 보호자', ...extra });
const page = (members = [member()], extra = {}) => ({ members, hasMore: false, nextCursor: members.at(-1)?.userId ?? null, ...extra });
const participant = (extra = {}) => ({ userId: 'synthetic-guardian', role: 'guardian', firstSequence: 1, ...extra });
const relations = (extra = {}) => ({ conversationId: 'synthetic-room', childId: 'synthetic-child', version: 3,
  participants: [participant()], ...extra });
const relationReceipt = (extra = {}) => ({ conversationId: 'synthetic-room', appliedVersion: 7, changed: true, replayed: false, ...extra });
const response = (value, status = 200) => ({ status, ok: status >= 200 && status < 300,
  headers: new Headers({ 'content-type': 'application/json' }), json: async () => value });
const code = expected => error => error instanceof LocalApiError && error.code === expected;
const deferred = () => { const gate = Promise.withResolvers(); gate.promise.catch(() => {}); return gate; };
function client(fetch, options = {}) {
  const base = new LocalApiClient({ fetch, ...options }); base.expectedUserId = 'synthetic-manager';
  return { api: new OperationsApiClient(base), base };
}
const modes = ['register', 'members', 'get', 'save'];
const payload = mode => mode === 'register' ? { receipt: registerReceipt() } : mode === 'members' ? page()
  : mode === 'get' ? { relationships: relations() } : { receipt: relationReceipt() };
const call = (mode, api, signal) => mode === 'register' ? api.childRegister('synthetic-center', registration(), signal)
  : mode === 'members' ? api.members('synthetic-center', signal) : mode === 'get' ? api.relationships('synthetic-center', 'synthetic-room', signal)
    : api.relationshipsSave('synthetic-center', 'synthetic-room', command(), signal);

test('relationship fields clone and sort choices without assigning roles, IDs or default history', () => {
  const source = fields({ guardians: [person('z'), person('a', 'preserve')] });
  const before = structuredClone(source), value = relationshipFields(source);
  assert.deepEqual(source, before); assert.deepEqual(value.guardians, [person('a', 'preserve'), person('z')]);
  assert.notEqual(value.guardians, source.guardians); assert.notEqual(value.therapist, source.therapist);
  source.guardians[0].history = 'all'; source.therapist.userId = 'changed';
  assert.equal(value.guardians[1].history, 'from_now'); assert.equal(value.therapist.userId, 'synthetic-therapist');
  assert.deepEqual(relationshipFields(fields({ therapist: null, guardians: [] })), fields({ therapist: null, guardians: [] }));
});

test('history is explicit and all always requires separate confirmation', () => {
  for (const history of ['preserve', 'from_now', 'all']) {
    const input = fields({ therapist: person('synthetic-therapist', history), pastHistoryConfirmed: history === 'all' });
    assert.equal(relationshipFields(input).therapist.history, history);
  }
  assert.throws(() => relationshipFields(fields({ historyConfirmed: false })), code('HISTORY_CONFIRMATION_REQUIRED'));
  for (const input of [fields({ therapist: person('t', 'all') }), fields({ guardians: [person('g', 'all')] })])
    assert.throws(() => relationshipFields(input), code('PAST_HISTORY_CONFIRMATION_REQUIRED'));
});

test('malformed, duplicate or role-bearing relationship input is rejected with fixed errors', () => {
  const invalid = [null, [], {}, fields({ role: 'center' }), fields({ historyConfirmed: 'true' }), fields({ pastHistoryConfirmed: null }),
    fields({ therapist: undefined }), fields({ therapist: { ...person('t'), role: 'therapist' } }), fields({ guardians: null }),
    fields({ guardians: [person('a'), person('a')] }), fields({ guardians: [person('synthetic-therapist')] }),
    fields({ guardians: Array(1) }), fields({ guardians: [null] }), fields({ guardians: Array.from({ length: 101 }, (_, i) => person(`g${i}`)) }),
    ...['', '../g', 'x'.repeat(101), null].map(userId => fields({ guardians: [person(userId)] })),
    ...['default', '', null, undefined].map(history => fields({ therapist: { userId: 't', history } }))];
  for (const key of Object.keys(fields())) { const value = fields(); delete value[key]; invalid.push(value); }
  for (const value of invalid) assert.throws(() => relationshipFields(value), code('INVALID_INPUT'));
  assert.equal(relationshipFields(fields({ guardians: Array.from({ length: 100 }, (_, i) => person(`g${i}`)) })).guardians.length, 100);
});

test('registration posts only fixed IDs and canonical three-field profile through the existing transport', async () => {
  const calls = [], { api } = client(async (path, options) => { calls.push([path, options]); return response({ receipt: registerReceipt() }, 201); });
  assert.deepEqual(await api.childRegister('synthetic-center', registration({ content: content({ name: ' 가상 아이 ' }) })), registerReceipt());
  const [path, options] = calls[0]; assert.equal(path, `${root}/children`); assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), registration()); assert.equal(options.credentials, 'same-origin');
  assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
  assert.equal(options.headers['X-Carebridge-Account'], 'synthetic-manager'); assert.equal(options.headers['X-Carebridge-Request'], '1');
  assert.equal(JSON.stringify(api), '{}');
});

test('registration validates explicit nullable age/date, semantic dates, raw lengths and exact keys before I/O', async () => {
  let calls = 0; const { api } = client(async () => { calls++; return response({ receipt: registerReceipt() }, 201); });
  await api.childRegister('synthetic-center', registration({ content: content({ age: null, ageAsOf: null }) }));
  const invalid = [null, [], {}, registration({ clientId: 'short' }), registration({ childId: '../child' }),
    registration({ conversationId: 'bad room' }), registration({ role: 'center' }), registration({ content: { name: '가상 아이' } }),
    ...[{ name: ' '.repeat(31) }, { name: '\ud800' }, { name: '가상\n아이' }, { age: '0' }, { age: 27 }, { age: null },
      { age: undefined, ageAsOf: undefined }, { ageAsOf: '2023-02-29' }, { ageAsOf: '9999-01-01' }, { concern: 'PRIVATE' }]
      .map(extra => registration({ content: content(extra) }))];
  for (const key of Object.keys(registration())) { const value = registration(); delete value[key]; invalid.push(value); }
  for (const value of invalid) await assert.rejects(api.childRegister('synthetic-center', value), code('INVALID_INPUT'));
  assert.equal(calls, 1);
});

test('registration accepts original/replayed receipt but requires exact identity and first profile version', async () => {
  for (const replayed of [false, true]) {
    const receipt = registerReceipt({ replayed });
    assert.deepEqual(await client(async () => response({ receipt }, 201)).api.childRegister('synthetic-center', registration()), receipt);
  }
  for (const extra of [{ operation: 'child.save' }, { childId: 'other' }, { conversationId: 'other' },
    { appliedVersion: 0 }, { appliedVersion: 2 }, { appliedVersion: '1' }, { changed: false }, { changed: 1 }, { replayed: null }])
    await assert.rejects(client(async () => response({ receipt: registerReceipt(extra) }, 201)).api.childRegister('synthetic-center', registration()), code('INVALID_RESPONSE'));
});

test('registration receipt strips private fields and cannot be altered by later response mutation', async () => {
  const receipt = registerReceipt({ userId: 'PRIVATE-ACTOR', name: 'PRIVATE-NAME', token: 'PRIVATE-TOKEN' });
  const value = await client(async () => response({ receipt, password: 'PRIVATE' }, 201)).api.childRegister('synthetic-center', registration());
  assert.deepEqual(value, registerReceipt()); receipt.childId = 'changed'; assert.equal(value.childId, 'synthetic-child');
  assert(!JSON.stringify(value).includes('PRIVATE'));
});

test('members uses complete bounded pages with original database cursor order and all active role DTOs', async () => {
  const calls = [], rows = [member({ userId: 'z', role: 'center', displayName: null }), member({ userId: 'A', role: 'therapist' })];
  const { api } = client(async (path, options) => { calls.push([path, options]); return response(calls.length === 1
    ? page(rows, { hasMore: true }) : page([member({ userId: 'a', displayName: '미등록 아님' })])); });
  assert.deepEqual(await api.members('synthetic-center'), [...rows, member({ userId: 'a', displayName: '미등록 아님' })]);
  assert.deepEqual(calls.map(c => c[0]), [`${root}/members?limit=100`, `${root}/members?limit=100&afterId=A`]);
  for (const [, options] of calls) { assert.equal(options.method, 'GET'); assert.equal(options.body, undefined); }
});

test('empty member directory and empty last page are valid without fabricating the logged-in manager', async () => {
  assert.deepEqual(await client(async () => response(page([]))).api.members('synthetic-center'), []);
  let calls = 0; const { api } = client(async () => response(++calls === 1 ? page([member()], { hasMore: true }) : page([])));
  assert.deepEqual(await api.members('synthetic-center'), [member()]); assert.equal(calls, 2);
});

test('directory rejects malformed member metadata, oversized pages, duplicates and cursor non-progress', async () => {
  for (const extra of [{ userId: '' }, { role: 'admin' }, { displayName: '' }, { displayName: undefined }, { displayName: ' name ' },
    { displayName: 'x'.repeat(31) }, { displayName: '\ud800' }, { displayName: 'name\n' }])
    await assert.rejects(client(async () => response(page([member(extra)]))).api.members('synthetic-center'), code('INVALID_RESPONSE'));
  for (const value of [null, {}, page(Array(1)), page([], { hasMore: true }), page([member()], { nextCursor: null }),
    page([member()], { hasMore: 1 }), page([member(), member()]), page(Array.from({ length: 101 }, (_, i) => member({ userId: `g${i}` })))])
    await assert.rejects(client(async () => response(value)).api.members('synthetic-center'), code('INVALID_RESPONSE'));
  let calls = 0;
  await assert.rejects(client(async () => response(page([member()], { hasMore: ++calls === 1 }))).api.members('synthetic-center'), code('INVALID_RESPONSE'));
  assert.equal(calls, 2);
});

test('directory caps at twenty pages without silent truncation or a twenty-first query', async () => {
  let calls = 0; const { api } = client(async () => response(page([member({ userId: `g${++calls}` })], { hasMore: true })));
  await assert.rejects(api.members('synthetic-center'), code('TOO_MUCH_DATA')); assert.equal(calls, 20);
});

test('directory discards earlier pages after failure and does not cache them in an explicit retry', async () => {
  let calls = 0; const { api } = client(async path => {
    calls++; if (calls === 2) throw new Error('PRIVATE-NETWORK');
    if (calls === 3) { assert.equal(path, `${root}/members?limit=100`); return response(page([])); }
    return response(page([member()], { hasMore: true }));
  });
  await assert.rejects(api.members('synthetic-center'), code('UNAVAILABLE')); assert.deepEqual(await api.members('synthetic-center'), []);
});

test('directory strips contact, identity and clinical extras without reading them', async () => {
  const source = member(); Object.defineProperty(source, 'email', { enumerable: true, get() { throw new Error('PRIVATE'); } });
  const { api } = client(async () => response(page([source], { token: 'PRIVATE' })));
  assert.deepEqual(await api.members('synthetic-center'), [member()]); assert.equal(JSON.stringify(api), '{}');
});

test('relationship GET returns only active relationship contract without filtering absent directory members', async () => {
  const value = relations({ version: Number.MAX_SAFE_INTEGER, participants: [participant({ userId: 'not-in-directory', firstSequence: 24 }),
    participant({ userId: 'therapist', role: 'therapist', firstSequence: Number.MAX_SAFE_INTEGER })] });
  const calls = [], { api } = client(async path => { calls.push(path); return response({ relationships: value }); });
  assert.deepEqual(await api.relationships('synthetic-center', 'synthetic-room'), value); assert.deepEqual(calls, [roomPath]);
  assert.deepEqual(await client(async () => response({ relationships: relations({ version: 0, participants: [] }) })).api.relationships('synthetic-center', 'synthetic-room'), relations({ version: 0, participants: [] }));
});

test('relationship DTO validates room/child, safe version, positive sequence and one-plus-one-hundred participants', async () => {
  const invalid = [null, [], {}, relations({ conversationId: 'other' }), relations({ childId: '' }), relations({ version: '3' }),
    relations({ version: Number.MAX_SAFE_INTEGER + 1 }), relations({ participants: Array(1) }),
    ...[null, { userId: 'a' }, participant({ role: 'center' }), participant({ firstSequence: 0 }), participant({ firstSequence: '1' }),
      participant({ firstSequence: Infinity })].map(p => relations({ participants: [p] })),
    relations({ participants: [participant(), participant()] }),
    relations({ participants: ['a', 'b'].map(userId => participant({ userId, role: 'therapist' })) }),
    relations({ participants: Array.from({ length: 101 }, (_, i) => participant({ userId: `g${i}` })) })];
  for (const value of invalid) await assert.rejects(client(async () => response({ relationships: value })).api.relationships('synthetic-center', 'synthetic-room'), code('INVALID_RESPONSE'));
  const value = relations({ participants: [participant({ userId: 't', role: 'therapist' }), ...Array.from({ length: 100 }, (_, i) => participant({ userId: `g${i}` }))] });
  assert.equal((await client(async () => response({ relationships: value })).api.relationships('synthetic-center', 'synthetic-room')).participants.length, 101);
});

test('relationship DTO deep-projects only public operational fields and detaches participants', async () => {
  const source = relations({ familyPlan: 'PRIVATE', participants: [participant({ email: 'PRIVATE', body: 'PRIVATE', active: true })] });
  const value = await client(async () => response({ relationships: source, token: 'PRIVATE' })).api.relationships('synthetic-center', 'synthetic-room');
  assert.deepEqual(value, relations()); source.participants[0].firstSequence = 99;
  assert.equal(value.participants[0].firstSequence, 1); assert(!JSON.stringify(value).includes('PRIVATE'));
});

test('relationship save sends explicit full set, confirmation flags and canonical copied ordering', async () => {
  const calls = [], operation = command({ guardians: [person('z'), person('a')] });
  const { api } = client(async (path, options) => { calls.push([path, options]); return response({ receipt: relationReceipt() }); });
  assert.deepEqual(await api.relationshipsSave('synthetic-center', 'synthetic-room', operation), relationReceipt());
  assert.equal(calls[0][0], roomPath); assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0][1].body), command({ guardians: [person('a'), person('z')] }));
  assert.deepEqual(operation.guardians, [person('z'), person('a')]);
});

test('relationship write validation rejects malformed commands and omitted confirmations before transport', async () => {
  let calls = 0; const { api } = client(async () => { calls++; return response({}); });
  const invalid = [null, {}, [], command({ clientId: 'short' }), command({ expectedVersion: -1 }), command({ expectedVersion: '3' }),
    command({ expectedVersion: Number.MAX_SAFE_INTEGER + 1 }), command({ role: 'center' })];
  for (const key of Object.keys(command())) { const value = command(); delete value[key]; invalid.push(value); }
  for (const value of invalid) await assert.rejects(api.relationshipsSave('synthetic-center', 'synthetic-room', value), code('INVALID_INPUT'));
  await assert.rejects(api.relationshipsSave('synthetic-center', 'synthetic-room', command({ historyConfirmed: false })), code('HISTORY_CONFIRMATION_REQUIRED'));
  assert.equal(calls, 0);
});

test('relationship receipts allow multiple version steps, no-op MAX_SAFE, and old-request replay independent of current state', async () => {
  for (const [expectedVersion, appliedVersion, changed] of [[0, 3, true], [3, 12, true], [3, 3, false],
    [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, true], [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, false]]) {
    for (const replayed of [false, true]) {
      const receipt = relationReceipt({ appliedVersion, changed, replayed });
      assert.deepEqual(await client(async () => response({ receipt })).api.relationshipsSave('synthetic-center', 'synthetic-room', command({ expectedVersion })), receipt);
    }
  }
});

test('relationship receipt rejects wrong room, coercions and impossible version arithmetic', async () => {
  for (const extra of [{ conversationId: 'other' }, { appliedVersion: 3 }, { appliedVersion: 2 }, { appliedVersion: '7' },
    { appliedVersion: Number.MAX_SAFE_INTEGER + 1 }, { appliedVersion: NaN }, { changed: false }, { changed: 1 }, { replayed: null }])
    await assert.rejects(client(async () => response({ receipt: relationReceipt(extra) })).api.relationshipsSave('synthetic-center', 'synthetic-room', command()), code('INVALID_RESPONSE'));
  const value = await client(async () => response({ receipt: relationReceipt({ participants: 'PRIVATE', token: 'PRIVATE' }) }))
    .api.relationshipsSave('synthetic-center', 'synthetic-room', command());
  assert.deepEqual(value, relationReceipt());
});

test('both writes capture IDs, nested content and history choices before their first await', async () => {
  for (const mode of ['register', 'save']) {
    const gate = deferred(); let captured;
    const transport = { expectedUserId: 'synthetic-manager', request: async (_path, options) => { captured = options.body; return gate.promise; } };
    const api = new OperationsApiClient(transport), operation = mode === 'register' ? registration() : command();
    const pending = mode === 'register' ? api.childRegister('synthetic-center', operation)
      : api.relationshipsSave('synthetic-center', 'synthetic-room', operation);
    operation.clientId = 'changed-request';
    if (mode === 'register') { operation.childId = 'changed'; operation.conversationId = 'changed'; operation.content.name = 'changed'; }
    else { operation.expectedVersion = 99; operation.therapist.userId = 'changed'; operation.guardians[0].history = 'all'; }
    assert.deepEqual(captured, mode === 'register' ? registration() : command());
    gate.resolve(payload(mode)); await pending;
  }
});

test('unknown write outcomes do not auto retry or regenerate identities; explicit retry sends identical bytes', async () => {
  for (const mode of ['register', 'save']) {
    const sent = [], { api } = client(async (_path, options) => { sent.push(options.body); if (sent.length === 1) throw new Error('PRIVATE');
      return response({ receipt: mode === 'register' ? registerReceipt({ replayed: true }) : relationReceipt({ replayed: true }) }, mode === 'register' ? 201 : 200); });
    await assert.rejects(call(mode, api), code('UNAVAILABLE')); assert.equal(sent.length, 1);
    assert.equal((await call(mode, api)).replayed, true); assert.equal(sent.length, 2); assert.equal(sent[0], sent[1]);
  }
});

test('new conflict codes preserve fixed safe public messages without leaking raw errors or triggering retries', async () => {
  for (const name of ['CHILD_EXISTS', 'RELATIONSHIP_CONFLICT', 'PARTICIPANT_UNAVAILABLE', 'HISTORY_CHOICE_REQUIRED',
    'HISTORY_CONFIRMATION_REQUIRED', 'PAST_HISTORY_CONFIRMATION_REQUIRED', 'SEQUENCE_LIMIT', 'SCHEDULE_CONFLICT']) {
    let calls = 0; const { api } = client(async () => { calls++; return response({ error: name, message: 'PRIVATE-DB-DATA' }, 409); });
    await assert.rejects(call('save', api), error => code(name)(error) && error.status === 409 && !error.message.includes('PRIVATE'));
    assert.equal(calls, 1); assert.notEqual(new LocalApiError(name).message, new LocalApiError('UNAVAILABLE').message);
  }
  const { api } = client(async () => response({ error: 'PRIVATE-UNKNOWN', message: 'PRIVATE-DETAIL' }, 503));
  await assert.rejects(call('register', api), error => code('UNAVAILABLE')(error) && !error.message.includes('PRIVATE'));
});

test('unsafe paths and missing or cancelled identities stop every new method before I/O', async () => {
  let calls = 0; const { api, base } = client(async () => { calls++; return response({}); });
  for (const center of ['../center', '', null, 'c'.repeat(101)]) {
    await assert.rejects(api.childRegister(center, registration()), code('INVALID_INPUT'));
    await assert.rejects(api.members(center), code('INVALID_INPUT'));
    await assert.rejects(api.relationships(center, 'room'), code('INVALID_INPUT'));
    await assert.rejects(api.relationshipsSave(center, 'room', command()), code('INVALID_INPUT'));
  }
  for (const room of ['../room', '', null, 'r'.repeat(101)]) {
    await assert.rejects(api.relationships('center', room), code('INVALID_INPUT'));
    await assert.rejects(api.relationshipsSave('center', room, command()), code('INVALID_INPUT'));
  }
  for (const account of [null, '', 'bad account']) { base.expectedUserId = account;
    for (const mode of modes) await assert.rejects(call(mode, api), code('AUTH_REQUIRED')); }
  base.expectedUserId = 'synthetic-manager'; const abort = new AbortController(); abort.abort();
  for (const mode of modes) await assert.rejects(call(mode, api, abort.signal), code('CANCELLED'));
  assert.equal(calls, 0);
});

test('late account replacement and cancellation reject read/write results and errors before any projection escapes', async () => {
  for (const mode of modes) for (const phase of ['fetch', 'json', 'error']) for (const cancel of [false, true]) {
    const gate = deferred(), abort = new AbortController();
    const { api, base } = client(async () => phase === 'json' ? { ...response({}), json: () => gate.promise } : gate.promise);
    const pending = call(mode, api, abort.signal); await Promise.resolve();
    if (cancel) abort.abort(); else base.expectedUserId = 'synthetic-other-manager';
    if (phase === 'error') gate.reject(new Error('PRIVATE'));
    else gate.resolve(phase === 'json' ? payload(mode) : response(payload(mode), mode === 'register' ? 201 : 200));
    await assert.rejects(pending, code(cancel ? 'CANCELLED' : 'AUTH_REQUIRED'));
  }
});

test('member pagination binds one account and discards earlier names when the later page loses authority', async () => {
  for (const cancel of [false, true]) {
    let calls = 0; const gate = deferred(), abort = new AbortController();
    const { api, base } = client(async () => ++calls === 1 ? response(page([member()], { hasMore: true })) : gate.promise);
    const pending = api.members('synthetic-center', abort.signal);
    for (let i = 0; calls < 2 && i < 12; i++) await Promise.resolve(); assert.equal(calls, 2);
    if (cancel) abort.abort(); else base.expectedUserId = 'synthetic-other-manager';
    gate.resolve(response(page([member({ userId: 'second' })])));
    await assert.rejects(pending, code(cancel ? 'CANCELLED' : 'AUTH_REQUIRED')); assert.equal(calls, 2);
  }
});

test('timeouts, malformed JSON and unexpected transport errors never return partial state or raw details', async () => {
  for (const mode of modes) {
    let calls = 0; const { api } = client(async (_path, options) => {
      calls++;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('PRIVATE-TIMEOUT')), { once: true }));
    }, { timeoutMs: 5 });
    await assert.rejects(call(mode, api), error => code('UNAVAILABLE')(error) && !error.message.includes('PRIVATE'));
    assert.equal(calls, 1);
    await assert.rejects(call(mode, client(async () => ({ ...response({}), json: async () => { throw new Error('PRIVATE-JSON'); } })).api), code('INVALID_RESPONSE'));
    const raw = new OperationsApiClient({ expectedUserId: 'synthetic-manager', request: async () => { throw new Error('PRIVATE-RAW'); } });
    await assert.rejects(call(mode, raw), error => code('UNAVAILABLE')(error) && !error.message.includes('PRIVATE'));
  }
});

test('malformed response envelopes cannot become successful registration, list, relationship or receipt state', async () => {
  for (const mode of modes) for (const value of [null, false, [], {}, { receipt: [] }, { receipt: null }, { relationships: null }])
    await assert.rejects(call(mode, client(async () => response(value, mode === 'register' ? 201 : 200)).api), code('INVALID_RESPONSE'));
});

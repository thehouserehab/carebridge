// Transport doubles only: no server, database, browser or native-storage claims.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CareApiClient } from '../local-api/care-client.js';
import { LocalApiError } from '../local-api/client.js';

const row = (extra = {}) => ({ recordId: 'synthetic-record', recordRevision: 2, date: '2026-10-09',
  title: '가상 기록', goalId: 'synthetic-goal', goalTitle: '당시 가상 목표', ordinal: 0,
  tool: 'ROM', item: '가상 각도', value: 0, unit: '도', context: '가상 측정 조건', ...extra });
const page = (measurements = [], extra = {}) => ({ revision: 7, resetRequired: false, measurements,
  nextCursor: measurements.length ? { sequence: 1, ordinal: measurements.at(-1).ordinal } : null, hasMore: false, ...extra });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const rawResponse = (value) => ({ status: 200, ok: true, headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => value });
const errorCode = (code) => (error) => error instanceof LocalApiError && error.code === code;
const run = (value) => new CareApiClient({ fetch: async () => rawResponse(value) }).recordMeasurements('center', 'room');
const deferred = () => { const p = Promise.withResolvers(); p.promise.catch(() => {}); return p; };

test('measurements use only the room collection and safe account-bound GET transport', async () => {
  const seen = [], client = new CareApiClient({ fetch: async (path, options) => { seen.push({ path, options }); return response(page([row()])); } });
  client.expectedUserId = 'synthetic-therapist';
  assert.deepEqual(await client.recordMeasurements('center', 'room'), { revision: 7, measurements: [row()] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, '/api/local/centers/center/conversations/room/measurements?limit=100');
  const options = seen[0].options;
  assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
  assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
  assert.equal(options.headers['X-Carebridge-Account'], 'synthetic-therapist');
});

test('all pages are collected in order, including repeated identical metadata in separate ordinals', async () => {
  const seen = [], values = [row(), row({ ordinal: 1, value: -1.25 }), row({ recordId: 'other-record', recordRevision: 1, value: 4 })];
  const client = new CareApiClient({ fetch: async (path) => {
    const url = new URL(path, 'http://localhost'); seen.push(url);
    return response(seen.length === 1 ? page(values.slice(0, 2), { hasMore: true })
      : page(values.slice(2), { nextCursor: { sequence: 2, ordinal: 0 } }));
  } });
  assert.deepEqual(await client.recordMeasurements('center', 'room'), { revision: 7, measurements: values });
  assert.deepEqual(JSON.parse(seen[1].searchParams.get('afterMeasurement')), { sequence: 1, ordinal: 1 });
  assert.equal(seen[1].searchParams.get('expectedRevision'), '7'); assert.equal(seen[1].searchParams.get('limit'), '100');
});

test('reset discards prior rows and identity checks rather than merging snapshots', async () => {
  const seen = [], client = new CareApiClient({ fetch: async (path) => {
    const url = new URL(path, 'http://localhost'); seen.push(url);
    if (seen.length === 1) return response(page([row()], { hasMore: true }));
    if (seen.length === 2) return response({ revision: 8, resetRequired: true });
    return response(page([row({ recordRevision: 3, value: 12 })], { revision: 8 }));
  } });
  assert.deepEqual(await client.recordMeasurements('center', 'room'), { revision: 8, measurements: [row({ recordRevision: 3, value: 12 })] });
  assert.equal(seen.length, 3); assert.equal(seen[2].searchParams.has('afterMeasurement'), false);
  assert.equal(seen[2].searchParams.has('expectedRevision'), false);
});

test('repeated resets remain bounded and silently mixed room revisions are rejected', async () => {
  let calls = 0;
  const resetting = new CareApiClient({ fetch: async () => { calls++; return response({ revision: calls, resetRequired: true }); } });
  await assert.rejects(resetting.recordMeasurements('center', 'room'), errorCode('SNAPSHOT_CHANGED'));
  assert.equal(calls, 3);
  calls = 0;
  const mixed = new CareApiClient({ fetch: async () => response(++calls === 1 ? page([row()], { hasMore: true })
    : page([row({ recordId: 'other' })], { revision: 8, nextCursor: { sequence: 2, ordinal: 0 } })) });
  await assert.rejects(mixed.recordMeasurements('center', 'room'), errorCode('INVALID_RESPONSE'));
});

test('only the measurement allowlist survives downstream projection, without retaining source objects', async () => {
  const source = row({ body: 'PRIVATE-BODY', privateNote: 'PRIVATE-NOTE', attachments: [{ id: 'PRIVATE-FILE' }],
    referenceSources: [{ body: 'PRIVATE-REFERENCE' }], authorId: 'PRIVATE-AUTHOR' });
  const result = await run(page([source], { privateNote: 'PRIVATE-PAGE' }));
  assert.deepEqual(result, { revision: 7, measurements: [row()] }); assert(!JSON.stringify(result).includes('PRIVATE'));
  result.measurements[0].context = '새 조건'; assert.equal(source.context, '가상 측정 조건');
});

test('empty result and absent historical goal snapshot are explicit, without current-goal substitution', async () => {
  assert.deepEqual(await run(page()), { revision: 7, measurements: [] });
  assert.deepEqual(await run(page([row({ goalTitle: null })])), { revision: 7, measurements: [row({ goalTitle: null })] });
});

test('numeric zero and finite negatives remain numbers; missing, string and nonfinite values fail', async () => {
  for (const value of [0, -0, -4.5, Number.MAX_VALUE, Number.MIN_VALUE])
    assert.equal((await run(page([row({ value })]))).measurements[0].value, value);
  for (const value of [undefined, null, '', '0', '1.2', true, [], {}, NaN, Infinity, -Infinity])
    await assert.rejects(run(page([row({ value })])), errorCode('INVALID_RESPONSE'));
});

test('dates validate calendar semantics including leap years rather than just their format', async () => {
  for (const date of ['0001-01-01', '2000-02-29', '2024-02-29', '9999-12-31'])
    assert.equal((await run(page([row({ date })]))).measurements[0].date, date);
  for (const date of [null, 20261009, '0000-01-01', '1900-02-29', '2025-02-29', '2026-02-30', '2026-04-31',
    '2026-13-01', '2026-00-01', '2026-10-00', '2026-1-01', '2026-10-09T00:00:00Z', ' 2026-10-09'])
    await assert.rejects(run(page([row({ date })])), errorCode('INVALID_RESPONSE'));
});

test('IDs, revision, ordinal and complete bounded metadata are validated without coercion', async () => {
  for (const key of ['recordId', 'goalId']) for (const value of [null, '', 2, '../record', 'x'.repeat(101)])
    await assert.rejects(run(page([row({ [key]: value })])), errorCode('INVALID_RESPONSE'));
  for (const recordRevision of [undefined, 0, -1, 1.5, '2', 2147483648])
    await assert.rejects(run(page([row({ recordRevision })])), errorCode('INVALID_RESPONSE'));
  for (const ordinal of [undefined, null, -1, 20, 0.5, '0'])
    await assert.rejects(run(page([row({ ordinal })])), errorCode('INVALID_RESPONSE'));
  for (const key of ['title', 'goalTitle', 'tool', 'item', 'unit', 'context']) {
    const max = key === 'context' ? 300 : 100;
    assert.equal((await run(page([row({ [key]: 'x'.repeat(max) })]))).measurements[0][key].length, max);
    for (const value of [undefined, '', ' ', ' padded', 'padded ', 7, {}, '\ud800', 'x'.repeat(max + 1)])
      await assert.rejects(run(page([row({ [key]: value })])), errorCode('INVALID_RESPONSE'));
  }
});

test('duplicate row identity and mixed versions of one record fail within and across pages', async () => {
  for (const second of [row(), row({ recordRevision: 3, ordinal: 1 })]) {
    await assert.rejects(run(page([row(), second])), errorCode('INVALID_RESPONSE'));
    let calls = 0;
    const client = new CareApiClient({ fetch: async () => response(++calls === 1 ? page([row()], { hasMore: true })
      : page([second], { nextCursor: { sequence: 2, ordinal: second.ordinal } })) });
    await assert.rejects(client.recordMeasurements('center', 'room'), errorCode('INVALID_RESPONSE'));
  }
});

test('page shape, per-page limit and terminal cursor consistency fail closed', async () => {
  for (const value of [null, {}, [], page([], { revision: '7' }), page([], { revision: -1 }), page([], { revision: Number.MAX_SAFE_INTEGER + 1 }),
    page([], { resetRequired: 0 }), page([], { hasMore: 'false' }), page([], { measurements: null }),
    page([], { nextCursor: undefined }), page([], { nextCursor: { sequence: 1, ordinal: 0 } }), page([], { hasMore: true }),
    page([row()], { nextCursor: null }), page([row()], { nextCursor: { sequence: 1, ordinal: 1 } }),
    page(Array.from({ length: 101 }, (_, n) => row({ recordId: `record-${n}` })))])
    await assert.rejects(run(value), errorCode('INVALID_RESPONSE'));
});

test('cursor accepts only two validated fields, advancing lexicographically on every nonempty page', async () => {
  for (const nextCursor of [undefined, [], 'cursor', {}, { sequence: 1 }, { sequence: 1, ordinal: 0, privateKey: 'PRIVATE' },
    { sequence: 0, ordinal: 0 }, { sequence: -1, ordinal: 0 }, { sequence: '1', ordinal: 0 },
    { sequence: Number.MAX_SAFE_INTEGER + 1, ordinal: 0 }, { sequence: 1.5, ordinal: 0 },
    { sequence: 1, ordinal: -1 }, { sequence: 1, ordinal: 20 }])
    await assert.rejects(run(page([row()], { nextCursor })), errorCode('INVALID_RESPONSE'));
  for (const nextCursor of [{ sequence: 2, ordinal: 1 }, { sequence: 1, ordinal: 2 }]) {
    let calls = 0;
    const client = new CareApiClient({ fetch: async () => response(++calls === 1
      ? page([row({ ordinal: 1 })], { hasMore: true, nextCursor: { sequence: 2, ordinal: 1 } })
      : page([row({ recordId: 'other', ordinal: nextCursor.ordinal })], { nextCursor })) });
    await assert.rejects(client.recordMeasurements('center', 'room'), errorCode('INVALID_RESPONSE'));
  }
  let calls = 0;
  const advancing = new CareApiClient({ fetch: async () => response(page([row({ ordinal: calls++ })], { hasMore: calls === 1 })) });
  assert.equal((await advancing.recordMeasurements('center', 'room')).measurements.length, 2);
});

test('the 400-page/40000-row boundary completes only with a terminal page and never silently truncates', async () => {
  for (const terminal of [true, false]) {
    let calls = 0;
    const client = new CareApiClient({ fetch: async () => {
      const index = calls++;
      const measurements = Array.from({ length: 100 }, (_, n) => {
        const offset = index * 100 + n;
        return row({ recordId: `record-${Math.floor(offset / 20)}`, ordinal: offset % 20 });
      });
      return response(page(measurements, { nextCursor: { sequence: calls * 5, ordinal: 19 }, hasMore: !terminal || calls < 400 }));
    } });
    if (terminal) assert.equal((await client.recordMeasurements('center', 'room')).measurements.length, 40000);
    else await assert.rejects(client.recordMeasurements('center', 'room'), errorCode('TOO_MUCH_DATA'));
    assert.equal(calls, 400);
  }
});

test('a failed later page rejects the entire result and does not expose accumulated clinical rows', async () => {
  for (const status of [401, 404, 503]) {
    let calls = 0, returned = false;
    const client = new CareApiClient({ fetch: async () => ++calls === 1 ? response(page([row()], { hasMore: true }))
      : response({ error: status === 401 ? 'AUTH_REQUIRED' : 'PRIVATE-ERROR', message: 'PRIVATE-DETAIL' }, status) });
    await assert.rejects(client.recordMeasurements('center', 'room').then(() => { returned = true; }), (error) =>
      error instanceof LocalApiError && !error.message.includes('PRIVATE') && !Object.hasOwn(error, 'measurements'));
    assert.equal(returned, false); assert.equal(calls, 2);
  }
});

test('unsafe room identities fail before transport and an already-aborted call does not issue a request', async () => {
  let calls = 0;
  const client = new CareApiClient({ fetch: async () => { calls++; return response(page()); } });
  for (const [center, room] of [['../center', 'room'], ['center', 'room?private=1'], ['center', 'https://remote.invalid']])
    await assert.rejects(client.recordMeasurements(center, room), errorCode('INVALID_INPUT'));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(client.recordMeasurements('center', 'room', abort.signal), errorCode('CANCELLED'));
  assert.equal(calls, 0);
});

test('abort while receiving a late page or JSON body cannot return partial or final results', async () => {
  for (const kind of ['response', 'json']) {
    const gate = deferred(), entered = deferred(), abort = new AbortController(); let calls = 0;
    const client = new CareApiClient({ fetch: async () => {
      if (++calls === 1) return response(page([row()], { hasMore: true }));
      entered.resolve();
      if (kind === 'response') return gate.promise;
      return { ...rawResponse(null), json: () => gate.promise };
    } });
    const pending = client.recordMeasurements('center', 'room', abort.signal);
    await entered.promise; abort.abort(); gate.resolve(kind === 'response' ? response(page()) : page());
    await assert.rejects(pending, errorCode('CANCELLED')); assert.equal(calls, 2);
  }
});

test('account changes during a page cannot mix identities or return stale therapist data', async () => {
  const gate = deferred(), entered = deferred(); let calls = 0;
  const client = new CareApiClient({ fetch: async () => {
    calls++; entered.resolve(); return gate.promise;
  } });
  client.expectedUserId = 'therapist-before';
  const pending = client.recordMeasurements('center', 'room');
  await entered.promise; client.expectedUserId = 'guardian-after'; gate.resolve(response(page([row()], { hasMore: true })));
  await assert.rejects(pending, errorCode('AUTH_REQUIRED')); assert.equal(calls, 1);
});

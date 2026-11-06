// Pure transport doubles: no server, browser, filesystem storage or real data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalApiClient, LocalApiError } from '../local-api/client.js';

const failure = code => error => error instanceof LocalApiError && error.code === code;
const roomId = 'synthetic-room', centerId = 'synthetic-center', userId = 'synthetic-user';
const base = `/api/local/centers/${centerId}/conversations/${roomId}/messages`;
const message = (sequence = 2001, extra = {}) => ({ id: `message-${sequence}`, conversationId: roomId,
  childId: 'synthetic-child', sequence, authorId: 'synthetic-therapist', type: 'text', body: '합성 소식',
  read: false, createdAt: '2026-10-20T00:00:00Z', ...extra });
const windowPage = (messages = [message()], extra = {}) => ({ messages, revision: 9, lastRead: 4, unread: 7,
  resetRequired: false, window: { hasOlder: true, hasNewer: false,
    startCursor: messages[0]?.sequence ?? 0, endCursor: messages.at(-1)?.sequence ?? 0 }, ...extra });
const publication = (sequence = 1, extra = {}) => message(sequence, { type: 'publication', hidden: false, deleted: false,
  archived: false, publication: { id: `publication-${sequence}`, title: '공유 요약' }, ...extra });
const publicationPage = (messages = [publication()], extra = {}) => ({ messages, revision: 9, lastRead: 0, unread: 0,
  resetRequired: false, nextCursor: messages.at(-1)?.sequence ?? 0, hasMore: false, ...extra });
function fixture(respond = () => windowPage()) {
  const calls = [];
  const api = new LocalApiClient({ fetch: async (path, options) => {
    calls.push({ path, options });
    const value = await respond(new URL(path, 'http://synthetic.invalid'), calls.length, api);
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  } });
  api.expectedUserId = userId;
  return { api, calls };
}

test('latest window is one bounded authenticated GET even beyond 2000 historical messages', async () => {
  const f = fixture(), value = await f.api.messageWindow(centerId, roomId);
  assert.deepEqual(value, windowPage());
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, `${base}?view=timeline&limit=100`);
  const options = f.calls[0].options;
  assert.equal(options.method, 'GET'); assert.equal(options.body, undefined);
  assert.equal(options.headers['X-Carebridge-Account'], userId); assert.equal(options.cache, 'no-store');
  assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error');
});

test('each mutually exclusive selector is copied with exact cursor bounds and no mutation', async () => {
  for (const selector of [{ before: 2002 }, { after: 2000 }, { from: 2001 }, { around: 'message-2001' }]) {
    const input = { ...selector, expectedRevision: 9 }, f = fixture();
    assert.deepEqual(await f.api.messageWindow(centerId, roomId, input), windowPage());
    const url = new URL(f.calls[0].path, 'http://synthetic.invalid');
    assert.deepEqual(Object.fromEntries(url.searchParams), { view: 'timeline', limit: '100',
      ...Object.fromEntries(Object.entries(input).map(([key, value]) => [key, String(value)])) });
    assert.deepEqual(input, { ...selector, expectedRevision: 9 });
  }
});

test('invalid or accessor selectors fail before transport and never invoke accessors', async () => {
  let reads = 0;
  const accessor = {}; Object.defineProperty(accessor, 'before', { enumerable: true, get() { reads++; return 1; } });
  const f = fixture();
  for (const selector of [null, [], 'latest', 3, { before: 2, after: 0 }, { from: 1, around: 'message-1' },
    { before: -1 }, { before: '2' }, { after: 1.5 }, { from: Number.MAX_SAFE_INTEGER + 1 }, { from: undefined },
    { around: '' }, { around: '../private' }, { expectedRevision: undefined }, { expectedRevision: -1 },
    { limit: 101 }, { role: 'center' }, { [Symbol('key')]: 1 }, Object.create({ after: 0 }), accessor])
    await assert.rejects(f.api.messageWindow(centerId, roomId, selector), failure('INVALID_INPUT'));
  assert.equal(f.calls.length, 0); assert.equal(reads, 0);
  await assert.rejects(f.api.messageWindow('../invalid', roomId), failure('INVALID_INPUT'));
  await assert.rejects(f.api.messageWindow(centerId, '../invalid'), failure('INVALID_INPUT'));
  assert.equal(f.calls.length, 0);
});

test('empty directional windows retain server navigation flags with zero cursors', async () => {
  for (const [selector, flags] of [[{ after: 9999 }, { hasOlder: true, hasNewer: false }],
    [{ before: 0 }, { hasOlder: false, hasNewer: true }], [{}, { hasOlder: false, hasNewer: false }]]) {
    const page = windowPage([], { window: { ...flags, startCursor: 0, endCursor: 0 } });
    const f = fixture(() => page);
    assert.deepEqual(await f.api.messageWindow(centerId, roomId, selector), page);
  }
});

test('revision resets are minimal and explicit, not an empty successful window', async () => {
  const f = fixture(() => ({ revision: 10, resetRequired: true }));
  assert.deepEqual(await f.api.messageWindow(centerId, roomId, { before: 2001, expectedRevision: 9 }),
    { revision: 10, resetRequired: true });
  await assert.rejects(f.api.messageWindow(centerId, roomId), failure('INVALID_RESPONSE'));
  await assert.rejects(f.api.messageWindow(centerId, roomId, { expectedRevision: 10 }), failure('INVALID_RESPONSE'));
  const extra = fixture(() => ({ revision: 10, resetRequired: true, messages: [message()] }));
  await assert.rejects(extra.api.messageWindow(centerId, roomId, { expectedRevision: 9 }), failure('INVALID_RESPONSE'));
});

test('window DTO rejects extra keys, malformed metadata, mixed rooms or children, ordering and duplicate IDs', async () => {
  const values = [
    null, [], {}, windowPage([message()], { extra: 'not allowed' }),
    windowPage([message()], { revision: -1 }), windowPage([message()], { lastRead: '1' }),
    windowPage([message()], { unread: -1 }), windowPage([message()], { resetRequired: 'false' }),
    windowPage([message()], { window: { hasOlder: true, hasNewer: false, startCursor: 2001, endCursor: 2001, extra: true } }),
    windowPage([message()], { window: { hasOlder: true, hasNewer: false, startCursor: null, endCursor: 2001 } }),
    windowPage([message()], { window: { hasOlder: true, hasNewer: false, startCursor: 2000, endCursor: 2001 } }),
    windowPage([message()], { window: { hasOlder: true, hasNewer: false, startCursor: 2001, endCursor: 2002 } }),
    windowPage([message()], { window: { hasOlder: true, hasNewer: 'false', startCursor: 2001, endCursor: 2001 } }),
    windowPage([message(2001, { conversationId: 'different-room' })]),
    windowPage([message(2001), message(2002, { childId: 'different-child' })]),
    windowPage([message(2002), message(2001)]), windowPage([message(2001), message(2001)]),
    windowPage([message(2001), message(2002, { id: 'message-2001' })]),
    windowPage([message(2001, { privateNote: 'not allowed' })]),
    windowPage([null]), windowPage(new Array(1)), windowPage([], { window: { hasOlder: false, hasNewer: false, startCursor: 1, endCursor: 1 } }),
    windowPage(Array.from({ length: 101 }, (_, i) => message(i + 1))),
  ];
  for (const page of values) {
    const f = fixture(() => page);
    await assert.rejects(f.api.messageWindow(centerId, roomId, { from: 0 }), failure('INVALID_RESPONSE'));
  }
});

test('a response must satisfy the selected range, exact target and expected revision', async () => {
  for (const selector of [{ before: 2001 }, { after: 2001 }, { from: 2002 }, { around: 'missing-message' }, { expectedRevision: 8 }]) {
    const f = fixture(); await assert.rejects(f.api.messageWindow(centerId, roomId, selector), failure('INVALID_RESPONSE'));
  }
  const latest = fixture(() => windowPage([message()], { window: { hasOlder: true, hasNewer: true, startCursor: 2001, endCursor: 2001 } }));
  await assert.rejects(latest.api.messageWindow(centerId, roomId), failure('INVALID_RESPONSE'));
});

test('window and publication reads reject late identity changes and aborts', async () => {
  for (const method of ['messageWindow', 'activePublications']) for (const change of ['account', 'abort']) {
    const controller = new AbortController();
    const f = fixture((_url, _index, api) => {
      if (change === 'account') api.clearIdentity(); else controller.abort();
      return method === 'messageWindow' ? windowPage() : publicationPage();
    });
    await assert.rejects(method === 'messageWindow' ? f.api[method](centerId, roomId, {}, controller.signal) :
      f.api[method](centerId, roomId, controller.signal), failure(change === 'account' ? 'AUTH_REQUIRED' : 'CANCELLED'));
    assert.equal(f.calls.length, 1);
  }
});

test('active publications are independent bounded pages with monotonic cursors and the same revision', async () => {
  const f = fixture((_url, index) => publicationPage([publication(index === 1 ? 1 : 2001)], { hasMore: index === 1 }));
  assert.deepEqual((await f.api.activePublications(centerId, roomId)).map(value => value.sequence), [1, 2001]);
  assert.deepEqual(f.calls.map(call => call.path), [
    `${base}?view=publications&limit=100&after=0`, `${base}?view=publications&limit=100&after=1&expectedRevision=9`,
  ]);
  assert(f.calls.every(call => call.options.method === 'GET' && call.options.headers['X-Carebridge-Account'] === userId));
});

test('active publication resets discard prior IDs and child identity before collecting replacement pages', async () => {
  const f = fixture((_url, index) => index === 1 ? publicationPage([publication(1)], { hasMore: true }) :
    index === 2 ? { revision: 10, resetRequired: true } : publicationPage([publication(1, { childId: 'current-child' })], { revision: 10 }));
  const values = await f.api.activePublications(centerId, roomId);
  assert.equal(values.length, 1); assert.equal(values[0].childId, 'current-child');
  assert.equal(f.calls.length, 3); assert.equal(new URL(f.calls[2].path, 'http://synthetic.invalid').searchParams.get('after'), '0');
});

test('active publication pages reject hidden or non-public cards, mixed identities and repeated pages', async () => {
  for (const extra of [{ hidden: true }, { deleted: true }, { archived: true }, { type: 'text' }, { publication: null },
    { hidden: undefined }, { conversationId: 'different-room' }, { secret: 'not allowed' }]) {
    const f = fixture(() => publicationPage([publication(1, extra)]));
    await assert.rejects(f.api.activePublications(centerId, roomId), failure('INVALID_RESPONSE'));
  }
  for (const second of [publication(1), publication(2, { id: 'message-1' }), publication(2, { childId: 'different-child' })]) {
    const f = fixture((_url, index) => publicationPage([index === 1 ? publication(1) : second], { hasMore: index === 1 }));
    await assert.rejects(f.api.activePublications(centerId, roomId), failure('INVALID_RESPONSE'));
  }
  for (const extra of [{ nextCursor: 2 }, { hasMore: 'yes' }, { unread: null }, { privateNote: 'not allowed' }]) {
    const f = fixture(() => publicationPage([publication(1)], extra));
    await assert.rejects(f.api.activePublications(centerId, roomId), failure('INVALID_RESPONSE'));
  }
});

test('active-publication collection retains the existing 20-page cap and never falls back to whole-history', async () => {
  const f = fixture((_url, index) => publicationPage([publication(index)], { hasMore: true }));
  await assert.rejects(f.api.activePublications(centerId, roomId), failure('TOO_MUCH_DATA'));
  assert.equal(f.calls.length, 20);
  assert(f.calls.every(call => new URL(call.path, 'http://synthetic.invalid').searchParams.get('view') === 'publications'));
});

test('active publication page revision mismatches and forged reset metadata never merge versions', async () => {
  for (const second of [publicationPage([publication(2)], { revision: 10 }),
    { revision: 9, resetRequired: true }, { revision: 10, resetRequired: true, messages: [] }]) {
    const f = fixture((_url, index) => index === 1 ? publicationPage([publication(1)], { hasMore: true }) : second);
    await assert.rejects(f.api.activePublications(centerId, roomId), failure('INVALID_RESPONSE'));
    assert.equal(f.calls.length, 2);
  }
});

test('already-aborted reads perform no transport and selector mutation cannot change the in-flight request', async () => {
  const controller = new AbortController(); controller.abort(); const aborted = fixture();
  await assert.rejects(aborted.api.messageWindow(centerId, roomId, {}, controller.signal), failure('CANCELLED'));
  await assert.rejects(aborted.api.activePublications(centerId, roomId, controller.signal), failure('CANCELLED'));
  assert.equal(aborted.calls.length, 0);
  const selector = { before: 2002, expectedRevision: 9 };
  const f = fixture(() => { selector.before = 1; selector.expectedRevision = 10; return windowPage(); });
  assert.deepEqual(await f.api.messageWindow(centerId, roomId, selector), windowPage());
  assert.equal(f.calls[0].path, `${base}?view=timeline&limit=100&before=2002&expectedRevision=9`);
});

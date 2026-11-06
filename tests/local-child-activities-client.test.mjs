// Transport doubles only. No server, browser, storage or real child data.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CareApiClient } from '../local-api/care-client.js';
import { LocalApiError } from '../local-api/client.js';

const period = { dateFrom: '2026-10-01', dateTo: '2026-10-31' };
const errorCode = (code) => (error) => error instanceof LocalApiError && error.code === code;
const publication = (room = 'room-a', revision = 1, extra = {}) => ({ id: `${room}-publication-${revision}`,
  conversationId: room, childId: `child-${room}`, sequence: revision, authorId: 'synthetic-therapist', type: 'publication',
  body: '가상 공유 소식', read: false, createdAt: '2026-10-09T00:00:00Z', hidden: false, deleted: false, archived: false,
  publication: { id: `${room}-snapshot-${revision}`, recordId: `${room}-record`, version: revision, date: '2026-10-09',
    title: '가상 공유 기록', summary: '가상 공유 요약', activity: { title: `가상 공개 활동 V${revision}`, instruction: '가상 활동 안내', frequency: '', caution: '' } },
  ...extra });
const profile = (room) => ({ conversationId: room, childId: `child-${room}`, name: '가상 아동', participants: [] });
function fixture({ snapshots = ['a', 'a'], messages, onRead, fail } = {}) {
  let inboxReads = 0; const calls = [];
  const api = new CareApiClient({ fetch: async (requestPath, options) => {
    const url = new URL(requestPath, 'http://synthetic.invalid'), room = url.pathname.match(/\/conversations\/([^/]+)/)?.[1];
    const ending = url.pathname.split('/').at(-1); const call = { room, ending, url, options }; calls.push(call);
    if (fail?.(call)) return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    const revision = inboxReads >= 3 ? 2 : 1;
    let value;
    if (ending === 'inbox') value = { snapshot: snapshots[Math.min(inboxReads++, snapshots.length - 1)].repeat(32), resetRequired: false,
      rooms: ['room-a', 'room-b'].map((id) => ({ conversationId: id, childId: `child-${id}`, revision, unread: 0, targetId: null, latest: null })),
      hasMore: false, nextOffset: 2 };
    else if (ending === 'profile') value = profile(room);
    else if (ending === 'messages') value = messages?.(room, revision, url) ?? {
      revision, resetRequired: false, messages: [publication(room, revision)], nextCursor: revision, hasMore: false };
    else if (ending === 'goals') value = { revision, resetRequired: false, goals: [], nextCursor: null, hasMore: false };
    else if (ending === 'appointments') value = { version: revision, resetRequired: false, appointments: [], nextCursor: null, hasMore: false };
    else if (ending === 'records') value = { revision, resetRequired: false, records: [{ id: `${room}-private`, revision,
      date: '2026-10-09', title: 'PRIVATE-UNSHARED-RECORD', status: 'saved', activity: { title: 'PRIVATE-UNSHARED-ACTIVITY' } }], nextCursor: 1, hasMore: false };
    else assert.fail('Unexpected synthetic route');
    if (ending === 'messages' && !value.resetRequired) value = { lastRead: 0, unread: 0, ...value };
    await onRead?.({ ...call, api, value });
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  } });
  api.expectedUserId = 'synthetic-account';
  return { api, calls, load: (role = 'therapist', selected = 'room-a', signal, timeline) => api.careWorkspace('synthetic-center', selected, { ...period, role, timeline }, signal) };
}

test('selected therapist reads authorized active publications separately, never private record activity', async () => {
  const f = fixture(), value = await f.load();
  assert.deepEqual(value.rooms[0].care.publications, [publication()]);
  assert.notEqual(value.rooms[0].care.publications[0], value.messages[0]);
  assert.equal(value.rooms[0].care.publications[0].publication.version, 1);
  assert.deepEqual(value.rooms[1].care.publications, []);
  assert.equal(f.calls.filter((c) => c.ending === 'messages').length, 2);
  assert.equal(f.calls.filter((c) => c.url.searchParams.get('view') === 'publications').length, 1);
  assert.equal(f.calls.find((c) => c.ending === 'messages').room, 'room-a');
  assert(!JSON.stringify(value.rooms.flatMap((r) => r.care.publications)).includes('PRIVATE-'));
  assert(value.rooms.every((r) => r.care.records.length === 1));
});

test('both roles fail closed when the active-publication projection contains a hidden or invalid card', async () => {
  for (const role of ['therapist', 'guardian']) {
    for (const extra of [{ hidden: true }, { deleted: true }, { archived: true }, { type: 'text' }, { type: 'feedback' }, { publication: null }]) {
      const f = fixture({ messages: (room, revision, url) => url.searchParams.get('view') !== 'publications' ? undefined :
        { revision, resetRequired: false, messages: [publication(room, 1, extra)], nextCursor: 1, hasMore: false } });
      await assert.rejects(f.load(role), errorCode('INVALID_RESPONSE'));
    }
  }
});

test('current shared records without activities remain in the independent public projection', async () => {
  const noActivity = publication('room-a', 7, { publication: { ...publication().publication, activity: null } });
  const f = fixture({ messages: (room, _revision, url) => room === 'room-a' && url.searchParams.get('view') === 'publications'
    ? { revision: 1, resetRequired: false, messages: [publication(), noActivity], nextCursor: 7, hasMore: false } : undefined });
  assert.deepEqual((await f.load()).rooms[0].care.publications, [publication(), noActivity]);
});

test('guardians retain all allowed rooms public cards without ever fetching clinical records', async () => {
  for (const selected of ['room-a', null]) {
    const f = fixture(), value = await f.load('guardian', selected);
    assert.deepEqual(value.rooms.map((r) => r.care.publications.map((m) => m.id)), [['room-a-publication-1'], ['room-b-publication-1']]);
    assert(value.rooms.every((r) => r.care.records.length === 0)); assert(!f.calls.some((c) => c.ending === 'records'));
    for (const room of ['room-a', 'room-b']) assert.equal(f.calls.filter((c) => c.url.searchParams.get('view') === 'publications' && c.room === room).length, 1);
    assert.equal(f.calls.filter(c => c.ending === 'messages' && !c.url.searchParams.has('view')).length, selected ? 1 : 0);
  }
});

test('therapist without a selected room never fetches chats and room selection never reuses another room cards', async () => {
  const f = fixture(), home = await f.load('therapist', null);
  assert(home.rooms.every((r) => r.care.publications.length === 0)); assert.deepEqual(home.messages, []);
  assert(!f.calls.some((c) => c.ending === 'messages'));
  const first = await f.load('therapist', 'room-a'), second = await f.load('therapist', 'room-b');
  assert(first.rooms[0].care.publications.every((m) => m.conversationId === 'room-a'));
  assert.deepEqual(second.rooms[0].care.publications, []);
  assert(second.rooms[1].care.publications.length > 0); assert(second.rooms[1].care.publications.every((m) => m.conversationId === 'room-b'));
  assert.deepEqual(f.calls.filter((c) => c.url.searchParams.get('view') === 'publications').map((c) => c.room), ['room-a', 'room-b']);
});

test('wrong-room HTTP messages fail before any child activity projection is returned', async () => {
  const f = fixture({ messages: () => ({ revision: 1, resetRequired: false, messages: [publication('room-b')], nextCursor: 1, hasMore: false }) });
  await assert.rejects(f.load(), errorCode('INVALID_RESPONSE'));
  assert.equal(f.calls.filter((c) => c.ending === 'inbox').length, 1);
});

test('closing workspace snapshot changes discard earlier shared activities with all other room projections', async () => {
  const f = fixture({ snapshots: ['a', 'b', 'b', 'b'] }), value = await f.load();
  assert.equal(value.rooms[0].care.publications[0].id, 'room-a-publication-2');
  assert.equal(value.rooms[0].care.publications[0].publication.version, 2);
  assert(!JSON.stringify(value).includes('가상 공개 활동 V1'));
  assert.equal(f.calls.filter((c) => c.ending === 'messages').length, 4);
  assert(f.calls.filter((c) => c.ending === 'messages').every((c) => c.room === 'room-a'));
  assert.equal(f.calls.filter((c) => c.ending === 'inbox').length, 4);
});

test('repeated workspace changes fail instead of returning the last possibly stale activity set', async () => {
  const f = fixture({ snapshots: ['a', 'b', 'c', 'd', 'e', 'f'] });
  await assert.rejects(f.load(), errorCode('SNAPSHOT_CHANGED'));
  assert.equal(f.calls.filter((c) => c.ending === 'inbox').length, 6);
  assert.equal(f.calls.filter((c) => c.ending === 'messages').length, 6);
});

test('independent publication pagination resets drop the discarded publication version', async () => {
  let reads = 0;
  const f = fixture({ messages: (_room, _revision, url) => {
    if (url.searchParams.get('view') !== 'publications') return undefined;
    reads++;
    if (reads === 1) return { revision: 1, resetRequired: false, messages: [publication('room-a', 1)], nextCursor: 1, hasMore: true };
    if (reads === 2) return { revision: 2, resetRequired: true };
    return { revision: 2, resetRequired: false, messages: [publication('room-a', 2)], nextCursor: 2, hasMore: false };
  } });
  const value = await f.load(); assert.equal(value.rooms[0].care.publications.length, 1);
  assert.equal(value.rooms[0].care.publications[0].publication.version, 2);
  assert(!JSON.stringify(value.rooms[0].care.publications).includes('가상 공개 활동 V1')); assert.equal(reads, 3);
});

test('account change while receiving selected activities or later care data rejects all completed projections', async () => {
  for (const ending of ['messages', 'records']) {
    const gate = Promise.withResolvers(), entered = Promise.withResolvers();
    const f = fixture({ onRead: async (call) => { if (call.ending === ending && call.room === 'room-a') { entered.resolve(); await gate.promise; } } });
    const pending = f.load(); await entered.promise; f.api.expectedUserId = 'synthetic-other-account'; gate.resolve();
    await assert.rejects(pending, errorCode('AUTH_REQUIRED'));
    assert.equal(f.calls.filter((c) => c.ending === 'inbox').length, 1);
    assert(f.calls.filter((c) => c.ending === 'messages').every((c) => c.room === 'room-a'));
  }
});

test('permission failure and explicit abort never return a partial selected activity set', async () => {
  const denied = fixture({ fail: (c) => c.ending === 'messages' });
  await assert.rejects(denied.load(), errorCode('NOT_FOUND'));
  const controller = new AbortController(), aborted = fixture({ onRead: (c) => { if (c.ending === 'records') controller.abort(); } });
  await assert.rejects(aborted.load('therapist', 'room-a', controller.signal), errorCode('CANCELLED'));
  assert.equal(aborted.calls.filter((c) => c.ending === 'inbox').length, 1);
});

test('center stays prohibited before transport and collecting child activities never changes read state', async () => {
  const f = fixture(); await assert.rejects(f.load('center'), errorCode('INVALID_INPUT')); assert.equal(f.calls.length, 0);
  await f.load('therapist'); await f.load('guardian');
  assert(f.calls.every((c) => c.options.method === 'GET'));
  assert(!f.calls.some((c) => c.ending === 'read')); assert(f.calls.every((c) => c.options.headers['X-Carebridge-Account'] === 'synthetic-account'));
});

test('bounded chat windows cannot truncate older still-active shared cards for either role', async () => {
  for (const role of ['therapist', 'guardian']) {
    const recent = { ...publication('room-a', 3001), id: 'recent-text', type: 'text', publication: undefined,
      body: '최신 합성 대화만 담긴 창' };
    const f = fixture({ messages: (_room, revision, url) => url.searchParams.get('view') === 'timeline'
      ? { messages: [recent], revision, lastRead: 0, unread: 1, resetRequired: false,
        window: { hasOlder: true, hasNewer: false, startCursor: 3001, endCursor: 3001 } } : undefined });
    const value = await f.load(role, 'room-a', undefined, {});
    assert.deepEqual(value.messages.map(message => message.id), ['recent-text']);
    assert.deepEqual(value.rooms[0].care.publications, [publication()]);
    assert.equal(value.timelineWindow.window.startCursor, 3001);
    const messageCalls = f.calls.filter(call => call.ending === 'messages');
    assert(messageCalls.every(call => ['timeline', 'publications'].includes(call.url.searchParams.get('view'))));
    assert.equal(messageCalls.filter(call => call.url.searchParams.get('view') === 'timeline').length, 1);
    assert.equal(messageCalls.filter(call => call.url.searchParams.get('view') === 'publications').length, role === 'guardian' ? 2 : 1);
    assert(f.calls.every(call => call.options.method === 'GET'));
  }
});

test('active cards whose child identity differs from their authorized room fail before closing the workspace', async () => {
  const f = fixture({ messages: (room, revision, url) => url.searchParams.get('view') === 'publications'
    ? { revision, resetRequired: false, messages: [publication(room, 1, { childId: 'wrong-child' })], nextCursor: 1, hasMore: false } : undefined });
  await assert.rejects(f.load(), errorCode('INVALID_RESPONSE'));
  assert.equal(f.calls.filter(call => call.ending === 'inbox').length, 1);
});

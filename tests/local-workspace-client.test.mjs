import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalApiClient, LocalApiError } from '../local-api/client.js';

const centerId = 'synthetic-center';
const userId = 'synthetic-user';
const base = `/api/local/centers/${centerId}`;
const tokens = ['a', 'b', 'c', 'd'].map((letter) => letter.repeat(32));
const errorCode = (code) => (error) => error instanceof LocalApiError && error.code === code;
const inboxPath = (offset = 0, snapshot) => `${base}/inbox?limit=100&offset=${offset}${snapshot === undefined ? '' : `&expectedSnapshot=${snapshot}`}`;
const profilePath = (roomId = 'room-1') => `${base}/conversations/${roomId}/profile`;
const messagesPath = (after = 0, revision) => `${base}/conversations/room-1/messages?limit=100&after=${after}${revision === undefined ? '' : `&expectedRevision=${revision}`}`;
const room = (roomId = 'room-1', body = '현재 소식') => ({
  conversationId: roomId, childId: `child-${roomId}`, unread: 1, targetId: 'message-1', latest: { body },
});
const profile = (roomId = 'room-1', name = '합성 아동') => ({
  conversationId: roomId, childId: `child-${roomId}`, name,
  participants: [{ userId, role: 'guardian', displayName: '합성 보호자' }],
});
const message = (body = '현재 소식', sequence = 1) => ({
  id: `message-${sequence}`, conversationId: 'room-1', childId: 'child-room-1', sequence,
  authorId: 'synthetic-therapist', type: 'text', body, read: false, createdAt: '2026-10-09T00:00:00Z',
});
const inbox = (snapshot = tokens[0], rooms = [room()], extra = {}) => ({
  snapshot, rooms, resetRequired: false, nextOffset: rooms.length, hasMore: false, ...extra,
});
const messages = (body = '현재 소식', revision = 1, extra = {}) => ({
  revision, messages: [message(body)], resetRequired: false, nextCursor: 1, hasMore: false, ...extra,
});
const step = (path, result, extra = {}) => ({ path, result, ...extra });
function scripted(steps) {
  const seen = [];
  const client = new LocalApiClient({ fetch: async (path, options) => {
    const expected = steps[seen.length];
    seen.push({ path, options });
    if (!expected) throw new Error('Unexpected synthetic request');
    expected.onRequest?.(client, options);
    return new Response(JSON.stringify(expected.result), {
      status: expected.status ?? 200, headers: { 'Content-Type': 'application/json' },
    });
  } });
  client.expectedUserId = userId;
  return { client, seen, verify() {
    assert.deepEqual(seen.map((item) => item.path), steps.map((item) => item.path));
    for (const { options } of seen) {
      assert.equal(options.method, 'GET');
      assert.equal(options.body, undefined);
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.headers['X-Carebridge-Account'], userId);
    }
  } };
}

test('workspace returns named rooms, selected profile and messages only after a matching closing inbox', async () => {
  const rooms = [room(), room('room-2', '다른 합성 소식')];
  const first = profile(), second = profile('room-2', '두 번째 합성 아동');
  const fixture = scripted([
    step(inboxPath(), inbox(tokens[0], rooms)),
    step(profilePath(), first), step(profilePath('room-2'), second),
    step(messagesPath(), messages()), step(inboxPath(), inbox(tokens[0], rooms)),
  ]);
  const result = await fixture.client.workspace(centerId, 'room-1');
  assert.deepEqual(result, {
    rooms: [{ ...rooms[0], profile: first }, { ...rooms[1], profile: second }], profile: first, messages: [message()],
  });
  assert.equal(result.profile, result.rooms[0].profile);
  fixture.verify();
});

test('workspace discards old inbox/profile mixed with new messages and restarts every projection', async () => {
  const oldRoom = room('room-1', 'OLD-INBOX'), oldProfile = profile('room-1', 'OLD-PROFILE');
  const currentRoom = room('room-1', 'CURRENT-ONLY'), currentProfile = profile('room-1', 'CURRENT-PROFILE');
  const fixture = scripted([
    step(inboxPath(), inbox(tokens[0], [oldRoom])), step(profilePath(), oldProfile),
    step(messagesPath(), messages('NEW-MESSAGES-BEFORE-RESTART', 2)), step(inboxPath(), inbox(tokens[1], [currentRoom])),
    step(inboxPath(), inbox(tokens[1], [currentRoom])), step(profilePath(), currentProfile),
    step(messagesPath(), messages('CURRENT-ONLY', 2)), step(inboxPath(), inbox(tokens[1], [currentRoom])),
  ]);
  const result = await fixture.client.workspace(centerId, 'room-1');
  assert.deepEqual(result, { rooms: [{ ...currentRoom, profile: currentProfile }], profile: currentProfile, messages: [message('CURRENT-ONLY')] });
  assert.doesNotMatch(JSON.stringify(result), /OLD-|BEFORE-RESTART/);
  fixture.verify();
});

test('workspace fails closed after exactly three continuously invalidated attempts', async () => {
  const steps = [];
  for (let attempt = 0; attempt < 3; attempt++) steps.push(
    step(inboxPath(), inbox(tokens[attempt])), step(profilePath(), profile()),
    step(messagesPath(), messages(`UNSTABLE-${attempt}`)), step(inboxPath(), inbox(tokens[attempt + 1])),
  );
  const fixture = scripted(steps);
  await assert.rejects(fixture.client.workspace(centerId, 'room-1'), errorCode('SNAPSHOT_CHANGED'));
  assert.equal(fixture.seen.length, 12);
  fixture.verify();
});

for (const phase of ['initial inbox', 'profile', 'messages', 'closing inbox']) {
  test(`workspace propagates ${phase} permission loss without retrying or returning partial data`, async () => {
    const steps = [
      step(inboxPath(), inbox()), step(profilePath(), profile()),
      step(messagesPath(), messages()), step(inboxPath(), inbox()),
    ];
    const index = ['initial inbox', 'profile', 'messages', 'closing inbox'].indexOf(phase);
    steps[index] = { ...steps[index], result: { error: 'NOT_FOUND' }, status: 404 };
    const fixture = scripted(steps.slice(0, index + 1));
    await assert.rejects(fixture.client.workspace(centerId, 'room-1'), errorCode('NOT_FOUND'));
    fixture.verify();
  });
}

test('workspace stops on session expiry during profile lookup without using the prior inbox', async () => {
  const fixture = scripted([
    step(inboxPath(), inbox()), step(profilePath(), { error: 'AUTH_REQUIRED' }, { status: 401 }),
  ]);
  await assert.rejects(fixture.client.workspace(centerId, 'room-1'), errorCode('AUTH_REQUIRED'));
  fixture.verify();
});

test('workspace makes no requests when already aborted', async () => {
  const fixture = scripted([]), controller = new AbortController(); controller.abort();
  await assert.rejects(fixture.client.workspace(centerId, 'room-1', controller.signal), errorCode('CANCELLED'));
  fixture.verify();
});

test('workspace discards completed profiles when the selected message read is aborted', async () => {
  const controller = new AbortController();
  const fixture = scripted([
    step(inboxPath(), inbox()), step(profilePath(), profile()),
    step(messagesPath(), messages(), { onRequest: () => controller.abort() }),
  ]);
  await assert.rejects(fixture.client.workspace(centerId, 'room-1', controller.signal), errorCode('CANCELLED'));
  fixture.verify();
});

test('workspace rejects a client account-binding change during an in-flight lookup', async () => {
  const fixture = scripted([
    step(inboxPath(), inbox()), step(profilePath(), profile(), { onRequest: (client) => client.clearIdentity() }),
  ]);
  await assert.rejects(fixture.client.workspace(centerId, 'room-1'), errorCode('AUTH_REQUIRED'));
  fixture.verify();
});

test('workspace with no selected room still checks the closing inbox and returns no messages', async () => {
  const rows = [room(), room('room-2')];
  const fixture = scripted([
    step(inboxPath(), inbox(tokens[0], rows)), step(profilePath(), profile()),
    step(profilePath('room-2'), profile('room-2')), step(inboxPath(), inbox(tokens[0], rows)),
  ]);
  const result = await fixture.client.workspace(centerId, null);
  assert.equal(result.profile, null); assert.deepEqual(result.messages, []);
  assert.deepEqual(result.rooms.map((item) => item.profile.conversationId), ['room-1', 'room-2']);
  fixture.verify();
});

test('empty workspace is returned only after its empty inbox boundary remains stable', async () => {
  const fixture = scripted([step(inboxPath(), inbox(tokens[0], [])), step(inboxPath(), inbox(tokens[0], []))]);
  assert.deepEqual(await fixture.client.workspace(centerId, null), { rooms: [], profile: null, messages: [] });
  fixture.verify();
});

test('a selected room absent from the inbox fails as NOT_FOUND before reading any profile', async () => {
  const fixture = scripted([step(inboxPath(), inbox(tokens[0], [room('room-2')]))]);
  await assert.rejects(fixture.client.workspace(centerId, 'room-1'), errorCode('NOT_FOUND'));
  fixture.verify();
});

test('workspace preserves independent inbox and message pagination snapshot contracts', async () => {
  const firstPage = inbox(tokens[0], [room()], { hasMore: true, nextOffset: 1 });
  const lastPage = inbox(tokens[0], [room('room-2')], { nextOffset: 2 });
  const fixture = scripted([
    step(inboxPath(), firstPage), step(inboxPath(1, tokens[0]), lastPage),
    step(profilePath(), profile()), step(profilePath('room-2'), profile('room-2')),
    step(messagesPath(), messages('FIRST-MESSAGE', 7, { hasMore: true })),
    step(messagesPath(1, 7), messages('', 7, { messages: [message('SECOND-MESSAGE', 2)], nextCursor: 2 })),
    step(inboxPath(), firstPage), step(inboxPath(1, tokens[0]), lastPage),
  ]);
  const result = await fixture.client.workspace(centerId, 'room-1');
  assert.equal(result.rooms.length, 2);
  assert.deepEqual(result.messages.map((item) => item.body), ['FIRST-MESSAGE', 'SECOND-MESSAGE']);
  fixture.verify();
});

test('a reset inside inbox pagination drops the obsolete page before any profile is read', async () => {
  const fixture = scripted([
    step(inboxPath(), inbox(tokens[0], [room('removed-room', 'OLD-PRIVATE')], { hasMore: true, nextOffset: 1 })),
    step(inboxPath(1, tokens[0]), { snapshot: tokens[1], resetRequired: true }),
    step(inboxPath(), inbox(tokens[1])), step(profilePath(), profile()),
    step(messagesPath(), messages()), step(inboxPath(), inbox(tokens[1])),
  ]);
  const result = await fixture.client.workspace(centerId, 'room-1');
  assert.deepEqual(result.rooms.map((item) => item.conversationId), ['room-1']);
  assert.doesNotMatch(JSON.stringify(result), /removed-room|OLD-PRIVATE/);
  fixture.verify();
});

test('workspace rejects a mismatched child profile rather than attaching it to an inbox entry', async () => {
  const fixture = scripted([
    step(inboxPath(), inbox()), step(profilePath(), { ...profile(), childId: 'different-child' }),
  ]);
  await assert.rejects(fixture.client.workspace(centerId, 'room-1'), errorCode('INVALID_RESPONSE'));
  fixture.verify();
});

test('workspace validates its center and selected room before making requests', async () => {
  const fixture = scripted([]);
  await assert.rejects(fixture.client.workspace('../private', null), errorCode('INVALID_INPUT'));
  await assert.rejects(fixture.client.workspace(centerId, 'room?other=true'), errorCode('INVALID_INPUT'));
  await assert.rejects(fixture.client.workspace(centerId, undefined), errorCode('INVALID_INPUT'));
  fixture.verify();
});

test('permission loss on a restart never falls back to the earlier inconsistent projections', async () => {
  const fixture = scripted([
    step(inboxPath(), inbox(tokens[0])), step(profilePath(), profile()),
    step(messagesPath(), messages('OBSOLETE-PRIVATE')), step(inboxPath(), inbox(tokens[1])),
    step(inboxPath(), { error: 'NOT_FOUND' }, { status: 404 }),
  ]);
  await assert.rejects(fixture.client.workspace(centerId, 'room-1'), errorCode('NOT_FOUND'));
  fixture.verify();
});

test('related projections are read before the closing token and discarded with every invalidated attempt', async () => {
  const fixture = scripted([
    step(inboxPath(), inbox(tokens[0], [room('room-1', 'OLD-INBOX')])), step(profilePath(), profile('room-1', 'OLD-PROFILE')),
    step(messagesPath(), messages('OLD-MESSAGE')), step(inboxPath(), inbox(tokens[1])),
    step(inboxPath(), inbox(tokens[1])), step(profilePath(), profile('room-1', 'CURRENT-PROFILE')),
    step(messagesPath(), messages('CURRENT-MESSAGE')), step(inboxPath(), inbox(tokens[1])),
  ]);
  let reads = 0;
  const result = await fixture.client.workspace(centerId, 'room-1', undefined, { readRelated: async (entry, selectedMessages) => {
    reads++;
    assert.equal(fixture.seen.length, reads === 1 ? 3 : 7);
    assert.equal(entry.profile.name, reads === 1 ? 'OLD-PROFILE' : 'CURRENT-PROFILE');
    assert.equal(selectedMessages[0].body, reads === 1 ? 'OLD-MESSAGE' : 'CURRENT-MESSAGE');
    return { marker: reads === 1 ? 'OLD-RELATED' : 'CURRENT-RELATED' };
  } });
  assert.equal(reads, 2); assert.equal(result.rooms[0].care.marker, 'CURRENT-RELATED');
  assert.doesNotMatch(JSON.stringify(result), /OLD-/); fixture.verify();
});

test('related callback receives selected messages once and null for other rooms', async () => {
  const rows = [room(), room('room-2')], seen = [];
  const fixture = scripted([
    step(inboxPath(), inbox(tokens[0], rows)), step(profilePath(), profile()), step(profilePath('room-2'), profile('room-2')),
    step(messagesPath(), messages()), step(inboxPath(), inbox(tokens[0], rows)),
  ]);
  const result = await fixture.client.workspace(centerId, 'room-1', undefined, { readRelated: async (entry, currentMessages) => {
    seen.push([entry.conversationId, currentMessages]); return { id: entry.conversationId };
  } });
  assert.equal(seen[0][1], result.messages); assert.equal(seen[1][1], null);
  assert.deepEqual(result.rooms.map((entry) => entry.care.id), ['room-1', 'room-2']); fixture.verify();
});

test('related callback failure after a completed room never returns a partially enriched workspace', async () => {
  const rows = [room(), room('room-2')], seen = [];
  const fixture = scripted([
    step(inboxPath(), inbox(tokens[0], rows)), step(profilePath(), profile()), step(profilePath('room-2'), profile('room-2')),
  ]);
  await assert.rejects(fixture.client.workspace(centerId, null, undefined, { readRelated: async (entry, currentMessages) => {
    assert.equal(currentMessages, null); seen.push(entry.conversationId);
    if (seen.length === 2) throw new LocalApiError('NOT_FOUND', 404);
    return { marker: 'MUST-NOT-RETURN' };
  } }), errorCode('NOT_FOUND'));
  assert.deepEqual(seen, ['room-1', 'room-2']); fixture.verify();
});

for (const stateChange of ['abort', 'account']) {
  test(`related callback ${stateChange} invalidates the whole workspace before a second callback or closing read`, async () => {
    const controller = new AbortController(), rows = [room(), room('room-2')];
    const fixture = scripted([
      step(inboxPath(), inbox(tokens[0], rows)), step(profilePath(), profile()), step(profilePath('room-2'), profile('room-2')),
    ]);
    let reads = 0;
    await assert.rejects(fixture.client.workspace(centerId, null, controller.signal, { readRelated: async () => {
      reads++;
      if (stateChange === 'abort') controller.abort(); else fixture.client.clearIdentity();
      return { marker: 'MUST-NOT-RETURN' };
    } }), errorCode(stateChange === 'abort' ? 'CANCELLED' : 'AUTH_REQUIRED'));
    assert.equal(reads, 1); fixture.verify();
  });
}

test('empty workspace never calls the related loader', async () => {
  const fixture = scripted([step(inboxPath(), inbox(tokens[0], [])), step(inboxPath(), inbox(tokens[0], []))]);
  let reads = 0;
  const result = await fixture.client.workspace(centerId, null, undefined, { readRelated: async () => { reads++; } });
  assert.deepEqual(result, { rooms: [], profile: null, messages: [] }); assert.equal(reads, 0); fixture.verify();
});

const timelinePath = (selector = {}) => `${base}/conversations/room-1/messages?${new URLSearchParams({ view: 'timeline', limit: 100, ...selector })}`;
const windowPage = (body = '현재 소식', revision = 1, sequence = 2001) => ({
  messages: [message(body, sequence)], revision, lastRead: 4, unread: 3, resetRequired: false,
  window: { hasOlder: true, hasNewer: false, startCursor: sequence, endCursor: sequence },
});
const windowRoom = (revision = 1) => ({ ...room(), revision });

test('optional timeline returns one bounded window plus metadata only after its coherent inbox closes', async () => {
  const rows = [windowRoom()], page = windowPage();
  const fixture = scripted([
    step(inboxPath(), inbox(tokens[0], rows)), step(profilePath(), profile()),
    step(timelinePath(), page), step(inboxPath(), inbox(tokens[0], rows)),
  ]);
  const value = await fixture.client.workspace(centerId, 'room-1', undefined, { timeline: {} });
  assert.deepEqual(value.messages, page.messages);
  assert.deepEqual(value.timelineWindow, { revision: 1, lastRead: 4, unread: 3, window: page.window });
  assert.equal(Object.hasOwn(value.timelineWindow, 'messages'), false);
  fixture.verify();
});

test('timeline with no selected room remains null and never fetches a window', async () => {
  const fixture = scripted([step(inboxPath(), inbox(tokens[0], [])), step(inboxPath(), inbox(tokens[0], []))]);
  assert.deepEqual(await fixture.client.workspace(centerId, null, undefined, { timeline: {} }),
    { rooms: [], profile: null, messages: [], timelineWindow: null });
  fixture.verify();
});

test('timeline selector validation happens before any workspace transport', async () => {
  const fixture = scripted([]);
  for (const timeline of [null, { from: -1 }, { before: 2, after: 0 }, { unexpected: true }])
    await assert.rejects(fixture.client.workspace(centerId, 'room-1', undefined, { timeline }), errorCode('INVALID_INPUT'));
  fixture.verify();
});

test('timeline reset restarts the entire workspace, drops only stale revision, and preserves exact position intent', async () => {
  const timeline = { around: 'message-2001', expectedRevision: 1 };
  const fixture = scripted([
    step(inboxPath(), inbox(tokens[0], [windowRoom()])), step(profilePath(), profile()),
    step(timelinePath(timeline), { revision: 2, resetRequired: true }),
    step(inboxPath(), inbox(tokens[1], [windowRoom(2)])), step(profilePath(), profile()),
    step(timelinePath({ around: 'message-2001' }), windowPage('CURRENT', 2)),
    step(inboxPath(), inbox(tokens[1], [windowRoom(2)])),
  ]);
  let related = 0;
  const value = await fixture.client.workspace(centerId, 'room-1', undefined, { timeline,
    readRelated: async () => { related++; return {}; } });
  assert.equal(value.messages[0].body, 'CURRENT'); assert.equal(value.timelineWindow.revision, 2);
  assert.equal(related, 1); assert.deepEqual(timeline, { around: 'message-2001', expectedRevision: 1 });
  fixture.verify();
});

test('a window revision changed after the opening inbox cannot be mixed with that workspace', async () => {
  const fixture = scripted([
    step(inboxPath(), inbox(tokens[0], [windowRoom()])), step(profilePath(), profile()),
    step(timelinePath(), windowPage('DISCARDED', 2)),
    step(inboxPath(), inbox(tokens[1], [windowRoom(2)])), step(profilePath(), profile()),
    step(timelinePath(), windowPage('CURRENT', 2)), step(inboxPath(), inbox(tokens[1], [windowRoom(2)])),
  ]);
  const value = await fixture.client.workspace(centerId, 'room-1', undefined, { timeline: {} });
  assert.equal(value.messages[0].body, 'CURRENT'); assert.equal(value.timelineWindow.revision, 2);
  assert(!JSON.stringify(value).includes('DISCARDED')); fixture.verify();
});

test('closing token changes replace window metadata and related projections together', async () => {
  const fixture = scripted([
    step(inboxPath(), inbox(tokens[0], [windowRoom()])), step(profilePath(), profile()), step(timelinePath({ from: 2001 }), windowPage('DISCARDED')),
    step(inboxPath(), inbox(tokens[1], [windowRoom(2)])),
    step(inboxPath(), inbox(tokens[1], [windowRoom(2)])), step(profilePath(), profile()), step(timelinePath({ from: 2001 }), windowPage('CURRENT', 2, 2002)),
    step(inboxPath(), inbox(tokens[1], [windowRoom(2)])),
  ]);
  let related = 0;
  const value = await fixture.client.workspace(centerId, 'room-1', undefined, { timeline: { from: 2001 },
    readRelated: async (_entry, selected) => ({ body: selected[0].body, count: ++related }) });
  assert.equal(value.timelineWindow.window.startCursor, 2002); assert.equal(value.timelineWindow.revision, 2);
  assert.deepEqual(value.rooms[0].care, { body: 'CURRENT', count: 2 });
  assert(!JSON.stringify(value).includes('DISCARDED')); fixture.verify();
});

test('window identity must match the selected child and a valid opening room revision', async () => {
  for (const [entry, current] of [[windowRoom(), { ...windowPage(), messages: [{ ...message('WRONG CHILD', 2001), childId: 'different-child' }] }],
    [room(), windowPage()]]) {
    const fixture = scripted([step(inboxPath(), inbox(tokens[0], [entry])), step(profilePath(), profile()), step(timelinePath(), current)]);
    await assert.rejects(fixture.client.workspace(centerId, 'room-1', undefined, { timeline: {} }), errorCode('INVALID_RESPONSE'));
    fixture.verify();
  }
});

test('continuously incoherent timeline reads stop after three attempts without returning partial data', async () => {
  const steps = Array.from({ length: 3 }, () => [step(inboxPath(), inbox(tokens[0], [windowRoom()])),
    step(profilePath(), profile()), step(timelinePath(), windowPage('NEVER RETURN', 2))]).flat();
  const fixture = scripted(steps);
  await assert.rejects(fixture.client.workspace(centerId, 'room-1', undefined, { timeline: {} }), errorCode('SNAPSHOT_CHANGED'));
  fixture.verify();
});

test('missing exact target reauthorizes every room and projection before an explicitly marked latest window', async () => {
  const timeline = Object.freeze({ around: 'message-gone', expectedRevision: 1 });
  const oldRows = [windowRoom(), { ...room('room-2'), revision: 1 }];
  const rows = [windowRoom(2), { ...room('room-2'), revision: 3 }];
  const fixture = scripted([
    step(inboxPath(), inbox(tokens[0], oldRows)), step(profilePath(), profile('room-1', 'OLD-SELECTED')),
    step(profilePath('room-2'), profile('room-2', 'OLD-OTHER')),
    step(timelinePath(timeline), { error: 'NOT_FOUND' }, { status: 404 }),
    step(inboxPath(), inbox(tokens[1], rows)), step(profilePath(), profile('room-1', 'CURRENT-SELECTED')),
    step(profilePath('room-2'), profile('room-2', 'CURRENT-OTHER')),
    step(timelinePath(), windowPage('CURRENT-MESSAGE', 2)), step(inboxPath(), inbox(tokens[1], rows)),
  ]);
  const related = [];
  const result = await fixture.client.workspace(centerId, 'room-1', undefined, { timeline,
    readRelated: async (entry, selected) => {
      assert.equal(fixture.seen.length, 8);
      related.push(entry.conversationId);
      assert.equal(entry.profile.name, entry.conversationId === 'room-1' ? 'CURRENT-SELECTED' : 'CURRENT-OTHER');
      assert.deepEqual(selected, entry.conversationId === 'room-1' ? [message('CURRENT-MESSAGE', 2001)] : null);
      return { marker: `CURRENT-RELATED-${entry.conversationId}` };
    } });
  assert.deepEqual(related, ['room-1', 'room-2']);
  assert.equal(result.targetUnavailable, true);
  assert.equal(result.profile, result.rooms[0].profile);
  assert.equal(result.timelineWindow.revision, 2);
  assert.equal(result.messages[0].body, 'CURRENT-MESSAGE');
  assert(!JSON.stringify(result).includes('OLD-'));
  assert.deepEqual(timeline, { around: 'message-gone', expectedRevision: 1 });
  fixture.verify();
});

test('missing target cannot recover a room absent from the fresh inbox', async () => {
  const fixture = scripted([
    step(inboxPath(), inbox(tokens[0], [windowRoom()])), step(profilePath(), profile()),
    step(timelinePath({ around: 'message-gone' }), { error: 'NOT_FOUND' }, { status: 404 }),
    step(inboxPath(), inbox(tokens[1], [room('room-2')])),
  ]);
  let related = 0;
  await assert.rejects(fixture.client.workspace(centerId, 'room-1', undefined, { timeline: { around: 'message-gone' },
    readRelated: async () => { related++; } }), errorCode('NOT_FOUND'));
  assert.equal(related, 0); fixture.verify();
});

for (const phase of ['initial inbox', 'profile', 'closing inbox']) {
  test(`around selection does not catch a ${phase} 404`, async () => {
    const steps = [
      step(inboxPath(), inbox(tokens[0], [windowRoom()])), step(profilePath(), profile()),
      step(timelinePath({ around: 'message-2001' }), windowPage()), step(inboxPath(), inbox(tokens[0], [windowRoom()])),
    ];
    const index = { 'initial inbox': 0, profile: 1, 'closing inbox': 3 }[phase];
    steps[index] = { ...steps[index], result: { error: 'NOT_FOUND' }, status: 404 };
    const fixture = scripted(steps.slice(0, index + 1));
    await assert.rejects(fixture.client.workspace(centerId, 'room-1', undefined, { timeline: { around: 'message-2001' } }),
      errorCode('NOT_FOUND'));
    fixture.verify();
  });
}

for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'FORBIDDEN'], [500, 'UNAVAILABLE']]) {
  test(`around selection propagates window ${status} instead of treating it as target loss`, async () => {
    const fixture = scripted([
      step(inboxPath(), inbox(tokens[0], [windowRoom()])), step(profilePath(), profile()),
      step(timelinePath({ around: 'message-gone' }), { error: code }, { status }),
    ]);
    await assert.rejects(fixture.client.workspace(centerId, 'room-1', undefined, { timeline: { around: 'message-gone' } }),
      errorCode(code));
    fixture.verify();
  });
}

for (const timeline of [{}, { before: 2001 }, { after: 2001 }, { from: 2001 }]) {
  test(`non-target window ${JSON.stringify(timeline)} 404 remains a permission failure`, async () => {
    const fixture = scripted([
      step(inboxPath(), inbox(tokens[0], [windowRoom()])), step(profilePath(), profile()),
      step(timelinePath(timeline), { error: 'NOT_FOUND' }, { status: 404 }),
    ]);
    await assert.rejects(fixture.client.workspace(centerId, 'room-1', undefined, { timeline }), errorCode('NOT_FOUND'));
    fixture.verify();
  });
}

for (const phase of ['initial inbox', 'profile', 'messages', 'closing inbox']) {
  test(`target recovery propagates a fresh ${phase} 404 without another fallback`, async () => {
    const fresh = [
      step(inboxPath(), inbox(tokens[1], [windowRoom(2)])), step(profilePath(), profile()),
      step(timelinePath(), windowPage('MUST-NOT-RETURN', 2)), step(inboxPath(), inbox(tokens[1], [windowRoom(2)])),
    ];
    const index = ['initial inbox', 'profile', 'messages', 'closing inbox'].indexOf(phase);
    fresh[index] = { ...fresh[index], result: { error: 'NOT_FOUND' }, status: 404 };
    const fixture = scripted([
      step(inboxPath(), inbox(tokens[0], [windowRoom()])), step(profilePath(), profile()),
      step(timelinePath({ around: 'message-gone' }), { error: 'NOT_FOUND' }, { status: 404 }),
      ...fresh.slice(0, index + 1),
    ]);
    await assert.rejects(fixture.client.workspace(centerId, 'room-1', undefined, { timeline: { around: 'message-gone' } }),
      errorCode('NOT_FOUND'));
    fixture.verify();
  });
}

test('target recovery cannot hide a related projection 404 or return a partial workspace', async () => {
  const fixture = scripted([
    step(inboxPath(), inbox(tokens[0], [windowRoom()])), step(profilePath(), profile()),
    step(timelinePath({ around: 'message-gone' }), { error: 'NOT_FOUND' }, { status: 404 }),
    step(inboxPath(), inbox(tokens[1], [windowRoom(2)])), step(profilePath(), profile()),
    step(timelinePath(), windowPage('MUST-NOT-RETURN', 2)),
  ]);
  let related = 0;
  await assert.rejects(fixture.client.workspace(centerId, 'room-1', undefined, { timeline: { around: 'message-gone' },
    readRelated: async () => { related++; throw new LocalApiError('NOT_FOUND', 404); } }), errorCode('NOT_FOUND'));
  assert.equal(related, 1); fixture.verify();
});

test('target recovery retains its explicit notice across another complete coherence restart', async () => {
  const fixture = scripted([
    step(inboxPath(), inbox(tokens[0], [windowRoom()])), step(profilePath(), profile()),
    step(timelinePath({ around: 'message-gone' }), { error: 'NOT_FOUND' }, { status: 404 }),
    step(inboxPath(), inbox(tokens[1], [windowRoom(2)])), step(profilePath(), profile('room-1', 'DISCARD-PROFILE')),
    step(timelinePath(), windowPage('DISCARD-MESSAGE', 2)), step(inboxPath(), inbox(tokens[2], [windowRoom(3)])),
    step(inboxPath(), inbox(tokens[2], [windowRoom(3)])), step(profilePath(), profile('room-1', 'CURRENT-PROFILE')),
    step(timelinePath(), windowPage('CURRENT-MESSAGE', 3)), step(inboxPath(), inbox(tokens[2], [windowRoom(3)])),
  ]);
  let related = 0;
  const result = await fixture.client.workspace(centerId, 'room-1', undefined, { timeline: { around: 'message-gone' },
    readRelated: async (_entry, selected) => { related++; return { marker: selected[0].body }; } });
  assert.equal(result.targetUnavailable, true); assert.equal(result.timelineWindow.revision, 3);
  assert.equal(related, 2); assert(!JSON.stringify(result).includes('DISCARD-'));
  fixture.verify();
});

test('target recovery consumes the same three-attempt budget and never returns unstable latest projections', async () => {
  const steps = [
    step(inboxPath(), inbox(tokens[0], [windowRoom()])), step(profilePath(), profile()),
    step(timelinePath({ around: 'message-gone' }), { error: 'NOT_FOUND' }, { status: 404 }),
  ];
  for (let attempt = 1; attempt < 3; attempt++) steps.push(
    step(inboxPath(), inbox(tokens[attempt], [windowRoom(attempt + 1)])), step(profilePath(), profile()),
    step(timelinePath(), windowPage('NEVER-RETURN', attempt + 1)),
    step(inboxPath(), inbox(tokens[attempt + 1], [windowRoom(attempt + 2)])),
  );
  const fixture = scripted(steps);
  await assert.rejects(fixture.client.workspace(centerId, 'room-1', undefined, { timeline: { around: 'message-gone' } }),
    errorCode('SNAPSHOT_CHANGED'));
  assert.equal(fixture.seen.filter(item => item.path.includes('around=')).length, 1);
  fixture.verify();
});

for (const change of ['abort', 'account']) {
  test(`target 404 with concurrent ${change} cannot trigger a fresh workspace read`, async () => {
    const controller = new AbortController();
    const fixture = scripted([
      step(inboxPath(), inbox(tokens[0], [windowRoom()])), step(profilePath(), profile()),
      step(timelinePath({ around: 'message-gone' }), { error: 'NOT_FOUND' }, { status: 404,
        onRequest: client => change === 'abort' ? controller.abort() : client.clearIdentity() }),
    ]);
    await assert.rejects(fixture.client.workspace(centerId, 'room-1', controller.signal, { timeline: { around: 'message-gone' } }),
      errorCode(change === 'abort' ? 'CANCELLED' : 'AUTH_REQUIRED'));
    fixture.verify();
  });
}

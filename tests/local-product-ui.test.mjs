import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CareApiClient } from '../local-api/care-client.js';
import { LocalApiError } from '../local-api/client.js';
import { escapeHtml, roleName, childName, localDay, workspacePeriod, formatWorkspaceTime, newsMarkup,
  appointmentMarkup, homeMarkup, guardianRecordsMarkup, childMarkup, loadingMarkup,
  captureMessagePosition, restoreMessagePosition, visibleMessageRows } from '../local-api/workspace-ui.js';

const errorCode = (code) => (error) => error instanceof LocalApiError && error.code === code;
const period = { dateFrom: '2026-10-01', dateTo: '2026-10-31', label: '2026년 10월' };
const profile = (id = 'room-1') => ({ conversationId: id, childId: `child-${id}`, name: `합성 ${id}`, age: null, ageAsOf: null,
  revision: 1, familyPlan: { concern: '', revision: 0, updatedAt: null }, participants: [{ userId: 'synthetic-therapist', role: 'therapist', displayName: '합성 치료사' }] });
const room = (id = 'room-1') => ({ conversationId: id, childId: `child-${id}`, unread: 0, targetId: 'message-1',
  latest: { id: 'message-1', body: `합성 소식 ${id}`, authorId: 'synthetic-therapist', createdAt: '2026-10-09T00:00:00Z' },
  profile: profile(id), care: { goals: [], appointments: [], records: [], publications: [] } });
const appointment = (extra = {}) => ({ id: 'appointment-1', revision: 1, date: '2026-10-10', time: '14:00', title: '합성 일정',
  room: '가상 장소', status: 'scheduled', ...extra });
const message = (id = 'publication-1', roomId = 'room-1', extra = {}) => ({
  id, conversationId: roomId, childId: `child-${roomId}`, sequence: 1, authorId: 'synthetic-therapist',
  type: 'publication', body: '합성 공유', read: false, createdAt: '2026-10-09T00:00:00Z', hidden: false, archived: false, deleted: false,
  publication: { id: `snapshot-${id}`, recordId: `record-${id}`, title: '공개된 합성 기록', summary: '공개 요약', date: '2026-10-09',
    activity: { title: '현재 공개 활동', instruction: '합성 안내', frequency: '편한 시간', caution: '' } }, ...extra,
});
function careFixture({ roomMessages = {}, roomPublications = {}, snapshots = ['a'.repeat(32), 'a'.repeat(32)], failPath, onRead } = {}) {
  const seen = []; let inboxReads = 0;
  const client = new CareApiClient({ fetch: async (path, options) => {
    const url = new URL(path, 'http://synthetic.invalid'), ending = url.pathname.split('/').at(-1);
    const roomId = url.pathname.match(/\/conversations\/([^/]+)/)?.[1];
    const view = url.searchParams.get('view');
    seen.push({ path, options, roomId, ending, view });
    if (url.pathname.endsWith(failPath ?? '/never-fail'))
      return new Response(JSON.stringify({ error: 'NOT_FOUND' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    const revision = inboxReads >= 3 ? 2 : 1;
    let result;
    if (ending === 'inbox') {
      const snapshot = snapshots[Math.min(inboxReads++, snapshots.length - 1)];
      result = { snapshot, resetRequired: false, rooms: ['room-1', 'room-2'].map((id) => {
        const { profile: ignoredProfile, care: ignoredCare, ...entry } = room(id); return entry;
      }), hasMore: false, nextOffset: 2 };
    } else if (ending === 'profile') result = profile(roomId);
    else if (ending === 'messages') {
      const history = roomMessages[roomId] ?? [message(`public-${roomId}`, roomId)];
      const messages = view === 'publications' ? roomPublications[roomId] ?? history.filter(item =>
        item.type === 'publication' && item.publication && !item.hidden && !item.deleted && !item.archived) : history;
      result = { revision, resetRequired: false, messages, lastRead: 0, unread: 0,
        hasMore: false, nextCursor: messages.at(-1)?.sequence ?? 0 };
    }
    else if (ending === 'goals') result = { revision, resetRequired: false, goals: [{ id: `goal-${roomId}`, revision, title: `GOAL-V${revision}`, status: 'active' }], hasMore: false, nextCursor: null };
    else if (ending === 'appointments') result = { version: revision, resetRequired: false, appointments: [appointment({ id: `appointment-${roomId}`, title: `APPOINTMENT-V${revision}` })], hasMore: false, nextCursor: null };
    else if (ending === 'records') result = { revision, resetRequired: false, records: [{ id: `record-${roomId}`, revision, title: `RECORD-V${revision}`, date: '2026-10-09', status: 'draft', appointmentId: null }], hasMore: false, nextCursor: 1 };
    else throw new Error('Unexpected synthetic route');
    onRead?.({ path, ending, roomId, client, seen });
    return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
  } });
  client.expectedUserId = 'synthetic-user';
  return { client, seen };
}

test('guardian care workspace uses only current public cards and never requests therapist records', async () => {
  const visible = message('visible'), hidden = message('hidden', 'room-1', { hidden: true }), archived = message('archived', 'room-1', { archived: true });
  const fixture = careFixture({ roomMessages: { 'room-1': [visible, hidden, archived,
    message('deleted', 'room-1', { deleted: true }), message('text', 'room-1', { type: 'text' }), message('empty', 'room-1', { publication: null })]
    .map((item, index) => ({ ...item, sequence: index + 1 })) } });
  const result = await fixture.client.careWorkspace('center', 'room-1', { ...period, role: 'guardian' });
  assert.deepEqual(result.rooms[0].care.publications, [visible]);
  assert.deepEqual(result.rooms[1].care.publications.map((m) => m.id), ['public-room-2']);
  assert(result.rooms.every((entry) => entry.care.records.length === 0));
  assert.equal(fixture.seen.some((entry) => entry.ending === 'records'), false);
  assert.equal(fixture.seen.filter((entry) => entry.ending === 'messages' && entry.roomId === 'room-1').length, 2);
  assert.equal(fixture.seen.filter((entry) => entry.ending === 'messages' && entry.roomId === 'room-2').length, 1);
  assert.deepEqual(fixture.seen.filter(entry => entry.view === 'publications').map(entry => entry.roomId), ['room-1', 'room-2']);
  assert.equal(result.messages.length, 6, 'General history and current public-card projection stay independent.');
  assert.equal(fixture.seen.at(-1).ending, 'inbox');
  for (const call of fixture.seen) assert.equal(call.options.headers['X-Carebridge-Account'], 'synthetic-user');
});

test('therapist care workspace loads private record summaries without fetching every unselected chat', async () => {
  const fixture = careFixture();
  const result = await fixture.client.careWorkspace('center', 'room-1', { ...period, role: 'therapist' });
  assert(result.rooms.every((entry) => entry.care.records.length === 1));
  assert.deepEqual(result.rooms[0].care.publications.map((m) => m.id), ['public-room-1']);
  assert.deepEqual(result.rooms[1].care.publications, []);
  assert.equal(fixture.seen.filter((call) => call.ending === 'records').length, 2);
  assert.equal(fixture.seen.filter((call) => call.ending === 'messages').length, 2);
  assert.deepEqual(fixture.seen.filter(call => call.view === 'publications').map(call => call.roomId), ['room-1']);
  assert(fixture.seen.filter(call => call.ending === 'messages').every(call => call.roomId === 'room-1'));
  for (const call of fixture.seen.filter((entry) => entry.ending === 'appointments')) {
    const url = new URL(call.path, 'http://synthetic.invalid');
    assert.equal(url.searchParams.get('dateFrom'), period.dateFrom); assert.equal(url.searchParams.get('dateTo'), period.dateTo);
  }
});

test('care workspace without a selected room still resolves all guardian public projections', async () => {
  const fixture = careFixture();
  const result = await fixture.client.careWorkspace('center', null, { ...period, role: 'guardian' });
  assert.equal(result.profile, null); assert.deepEqual(result.messages, []);
  assert.equal(result.rooms.flatMap((entry) => entry.care.publications).length, 2);
  assert.equal(fixture.seen.filter((call) => call.ending === 'messages').length, 2);
  assert(fixture.seen.filter(call => call.ending === 'messages').every(call => call.view === 'publications'));
});

test('care workspace discards all related data when the closing room snapshot changes', async () => {
  const fixture = careFixture({ snapshots: ['a', 'b', 'b', 'b'].map((v) => v.repeat(32)) });
  const result = await fixture.client.careWorkspace('center', null, { ...period, role: 'therapist' });
  assert.doesNotMatch(JSON.stringify(result), /GOAL-V1|APPOINTMENT-V1|RECORD-V1/);
  assert.equal(result.rooms[0].care.goals[0].title, 'GOAL-V2');
  assert.equal(fixture.seen.filter((call) => call.ending === 'records').length, 4);
  assert.equal(fixture.seen.filter((call) => call.ending === 'inbox').length, 4);
});

for (const [ending, role] of [['goals', 'therapist'], ['appointments', 'therapist'], ['records', 'therapist'], ['messages', 'guardian']]) {
  test(`care workspace ${ending} permission failure returns no partial room projections`, async () => {
    const fixture = careFixture({ failPath: `/conversations/room-2/${ending}` });
    await assert.rejects(fixture.client.careWorkspace('center', null, { ...period, role }), errorCode('NOT_FOUND'));
    assert.equal(fixture.seen.filter((call) => call.ending === 'inbox').length, 1);
  });
}

test('care workspace rejects unsupported role hints and malformed periods before transport', async () => {
  const fixture = careFixture();
  for (const role of ['center', 'admin', undefined, null])
    await assert.rejects(fixture.client.careWorkspace('center', null, { ...period, role }), errorCode('INVALID_INPUT'));
  await assert.rejects(fixture.client.careWorkspace('center', null, { ...period, role: 'guardian', dateFrom: 'not-a-date' }), errorCode('INVALID_INPUT'));
  assert.equal(fixture.seen.length, 0);
});

test('related transport abort never exposes completed first-room clinical data', async () => {
  const controller = new AbortController();
  const fixture = careFixture({ onRead: ({ roomId, ending }) => {
    if (roomId === 'room-2' && ending === 'goals') controller.abort();
  } });
  await assert.rejects(fixture.client.careWorkspace('center', null, { ...period, role: 'therapist' }, controller.signal), errorCode('CANCELLED'));
  assert.equal(fixture.seen.at(-1).ending, 'goals');
  assert.equal(fixture.seen.filter((call) => call.ending === 'inbox').length, 1);
});

test('period calculations use Seoul calendar boundaries, leap days and year rollover', () => {
  assert.equal(localDay(new Date('2024-02-29T15:00:00Z')), '2024-03-01');
  assert.deepEqual(workspacePeriod(0, new Date('2024-02-10T00:00:00Z')), { dateFrom: '2024-02-01', dateTo: '2024-02-29', label: '2024년 2월' });
  assert.deepEqual(workspacePeriod(0, new Date('2025-02-10T00:00:00Z')), { dateFrom: '2025-02-01', dateTo: '2025-02-28', label: '2025년 2월' });
  assert.deepEqual(workspacePeriod(-1, new Date('2026-01-01T00:00:00Z')), { dateFrom: '2025-12-01', dateTo: '2025-12-31', label: '2025년 12월' });
  assert.deepEqual(workspacePeriod(1, new Date('2026-12-10T00:00:00Z')), { dateFrom: '2027-01-01', dateTo: '2027-01-31', label: '2027년 1월' });
});

test('Seoul calendar time formatting handles midnight, leap day and invalid values', () => {
  for (const [instant, day, label] of [
    ['2026-12-31T14:59:59Z', '2026-12-31', '12. 31. 오후 11:59'],
    ['2026-12-31T15:00:00Z', '2027-01-01', '1. 1. 오전 12:00'],
    ['2024-02-28T15:00:00Z', '2024-02-29', '2. 29. 오전 12:00'],
  ]) {
    assert.equal(localDay(new Date(instant)), day);
    assert.equal(formatWorkspaceTime(instant), label);
  }
  assert.equal(formatWorkspaceTime('2027-01-01T00:00:00+09:00'), formatWorkspaceTime('2026-12-31T15:00:00Z'));
  for (const value of [null, undefined, '', 'not-a-date']) assert.equal(formatWorkspaceTime(value), '');
});

test('child view distinguishes explicit age zero from unknown and preserves the stated basis date', () => {
  const current = room(); current.profile.age = 0; current.profile.ageAsOf = '2026-01-01';
  assert.match(childMarkup(current, 'guardian', period), /0세 · 2026-01-01 기준/);
  current.profile.age = null; current.profile.ageAsOf = null; current.profile.name = null;
  const unknown = childMarkup(current, 'guardian', period);
  assert.match(unknown, /<dd>미등록<\/dd>/); assert.doesNotMatch(unknown, /0세/);
  assert.match(unknown, /이름 미등록 아동/); assert.equal(childName(null), '이름 미등록 아동');
  assert.match(childMarkup(null, 'therapist', period), /아이를 선택/);
});

test('home prioritizes unread rooms without mutating server order and preserves exact message targets', () => {
  const first = room('read-room'), second = room('unread-room'), third = room('also-unread'); second.unread = 1; third.unread = 2;
  second.targetId = 'selected-source'; const rooms = [first, second, third];
  const html = homeMarkup(rooms, 'guardian', period, '2026-10-09');
  assert(html.indexOf('data-open-room="unread-room"') < html.indexOf('data-open-room="read-room"'));
  assert(html.indexOf('data-open-room="unread-room"') < html.indexOf('data-open-room="also-unread"'));
  assert.match(html, /data-target-id="selected-source"/); assert.match(html, /새 소식 2/);
  assert.deepEqual(rooms.map((entry) => entry.conversationId), ['read-room', 'unread-room', 'also-unread']);
});

test('home keeps therapist drafts and guardian current public activities on separate surfaces', async () => {
  const fixture = careFixture({ roomMessages: { 'room-1': [message(), message('old-activity', 'room-1', { sequence: 2, archived: true,
    publication: { ...message().publication, activity: { title: 'WITHDRAWN-ACTIVITY' } } })] } });
  const guardian = await fixture.client.careWorkspace('center', 'room-1', { ...period, role: 'guardian' });
  const guardianHtml = homeMarkup(guardian.rooms, 'guardian', period, '2026-10-09');
  assert.match(guardianHtml, /현재 공개 활동/); assert.doesNotMatch(guardianHtml, /WITHDRAWN-ACTIVITY|data-open-record/);
  const current = room(); current.care.records = [
    { id: 'draft-1', title: 'DRAFT-ONLY', status: 'draft', date: '2026-10-09' },
    { id: 'saved-1', title: 'SAVED-NOT-DRAFT', status: 'saved', date: '2026-10-09' },
  ]; current.care.publications = [message()];
  const therapistHtml = homeMarkup([current], 'therapist', period, '2026-10-09');
  assert.match(therapistHtml, /DRAFT-ONLY/); assert.doesNotMatch(therapistHtml, /SAVED-NOT-DRAFT|현재 공개 활동/);
});

test('home labels the queried month and includes only remaining scheduled appointments in time order', () => {
  const current = room(); current.care.appointments = [
    appointment({ id: 'later', time: '15:00', title: 'LATER' }), appointment({ id: 'earlier', time: '09:00', title: 'EARLIER' }),
    appointment({ id: 'past', date: '2026-10-08', title: 'PAST' }), appointment({ id: 'cancelled', title: 'CANCELLED', status: 'cancelled' }),
    appointment({ id: 'attended', title: 'ATTENDED', status: 'attended' }),
  ];
  const html = homeMarkup([current], 'guardian', period, '2026-10-09');
  assert.match(html, /2026년 10월/);
  assert(html.indexOf('EARLIER') < html.indexOf('LATER')); assert.doesNotMatch(html, /PAST|CANCELLED|ATTENDED/);
  assert.match(childMarkup(current, 'guardian', period), /2026년 10월/);
  assert.match(childMarkup(current, 'guardian', period), /aria-label="이전 달 일정"/);
});

test('appointment actions reuse a linked record for therapists but expose only chat to guardians', () => {
  const current = room(), item = appointment();
  assert.match(appointmentMarkup(current, item, 'therapist'), />기록하기<\/button>/);
  current.care.records = [{ id: 'record-1', appointmentId: item.id }];
  assert.match(appointmentMarkup(current, item, 'therapist'), /기록 이어보기/);
  const guardian = appointmentMarkup(current, item, 'guardian');
  assert.match(guardian, />대화하기<\/button>/); assert.doesNotMatch(guardian, /data-appointment-record|record-1/);
});

test('current server absence and paused goal statuses retain their actual meaning', () => {
  const current = room(); current.care.goals = [{ title: '가상 목표', description: '', status: 'paused' }];
  assert.match(appointmentMarkup(current, appointment({ status: 'absent' }), 'guardian'), /미참석/);
  assert.match(childMarkup(current, 'guardian', period), /잠시 보류/);
  assert.doesNotMatch(childMarkup(current, 'guardian', period), />종료<\/p>/);
});

test('all product markup escapes server strings in text and data attributes', () => {
  const attack = '<img src=x onerror="injected">&\'"';
  const current = room(); current.conversationId = attack; current.targetId = attack; current.profile.name = attack;
  current.profile.familyPlan.concern = attack; current.profile.participants[0].displayName = attack;
  current.latest.body = attack; current.care.goals = [{ title: attack, description: attack, status: 'active' }];
  current.care.records = [{ id: attack, title: attack, status: 'draft', date: attack }];
  current.care.appointments = [appointment({ id: attack, title: attack, room: attack })];
  current.care.publications = [message(attack, 'room-1', { publication: {
    title: attack, summary: attack, date: attack, activity: { title: attack, frequency: attack },
  } })];
  const encoded = escapeHtml(attack);
  for (const html of [newsMarkup([current], null, true), newsMarkup([current], attack),
    appointmentMarkup(current, current.care.appointments[0], 'therapist'), homeMarkup([current], 'therapist', period, '2026-10-09'),
    homeMarkup([current], 'guardian', period, '2026-10-09'), guardianRecordsMarkup(current), childMarkup(current, 'guardian', { ...period, label: attack })]) {
    assert(!html.includes(attack)); assert(!html.includes('<img')); assert(html.includes(encoded));
    assert(!html.includes('onerror="injected"'));
  }
});

test('empty and current-room states remain explicit without inventing names, schedules or records', () => {
  assert.match(newsMarkup([]), /연결된 아동이 없습니다/);
  assert.match(guardianRecordsMarkup(room()), /현재 열람 가능한 공유 기록이 없습니다/);
  assert.match(homeMarkup([], 'therapist', period), /서버에 임시저장한 기록이 없습니다/);
  assert.match(homeMarkup([], 'guardian', period), /현재 공유된 가정 활동이 없습니다/);
  assert.match(newsMarkup([room()], 'room-1'), /aria-current="true"/);
  assert.doesNotMatch(newsMarkup([room()], 'room-1', true), /aria-current/);
  assert.equal(roleName('guardian'), '보호자'); assert.equal(roleName('unsupported'), '사용자');
});

test('loading surfaces have a stable accessible shell and never interpolate caller data', () => {
  for (const view of ['home', 'inbox', 'room', 'records-content', 'child-content', '<private-child>']) {
    const html = loadingMarkup(view);
    assert.match(html, /aria-busy="true"/); assert.match(html, /aria-hidden="true"/);
    assert.doesNotMatch(html, /private-child|data-message-id|data-open-room|<button/);
  }
});

test('home has one primary communication entry without duplicating the four-menu navigation', () => {
  assert.match(homeMarkup([], 'therapist', period), /data-start-chat>대화 시작/);
  assert.match(homeMarkup([], 'guardian', period), /data-start-chat>소식 보내기/);
  assert.doesNotMatch(homeMarkup([], 'guardian', period), /data-view=/);
  const news = newsMarkup([room()], null, true);
  assert.match(news, /data-open-room="room-1" data-target-id="message-1"/);
  assert.match(news, /class="room-cta" aria-hidden="true">→/);
  assert.equal((news.match(/<button\b/g) ?? []).length, 1);
});

function selectMessageNodes(selector, nodes) {
  if (selector === '[data-message-id]') return nodes.filter((node) => 'messageId' in node.dataset);
  if (selector === '[data-testid="message-row"][data-message-id]') {
    return nodes.filter((node) => node.dataset.testid === 'message-row' && 'messageId' in node.dataset);
  }
  throw new Error(`Unsupported scroll fixture selector: ${selector}`);
}
function scrollList() {
  const list = { scrollTop: 260, scrollHeight: 1000, clientHeight: 300, clientTop: 1, viewportTop: 100,
    getBoundingClientRect: () => ({ top: list.viewportTop, bottom: list.viewportTop + list.clientHeight }),
    rows: [{ id: 'one', offset: 100, height: 80, sequence: 1 },
      { id: 'two', offset: 240, height: 120, sequence: 2 }, { id: 'three', offset: 400, height: 120, sequence: 3 }] };
  const nodes = new WeakMap();
  list.node = (item) => {
    if (!nodes.has(item)) nodes.set(item, {
      tagName: item.control ? 'BUTTON' : 'LI',
      dataset: { messageId: item.id, ...(item.control ? {} : { testid: 'message-row', sequence: String(item.sequence) }) },
      getBoundingClientRect: () => {
        // Native controls inside a closed details element have a zero rectangle,
        // not their parent's off-screen geometry. Open controls occupy space.
        if (item.hidden) return { top: 0, bottom: 0, height: 0 };
        const top = list.viewportTop + list.clientTop + item.offset - list.scrollTop;
        return { top, bottom: top + item.height, height: item.height };
      },
    });
    return nodes.get(item);
  };
  list.querySelectorAll = (selector) => selectMessageNodes(selector,
    list.rows.flatMap((row) => [row, ...(row.controls ?? [])]).map(list.node));
  return list;
}
test('message anchor keeps the same visible line after messages above it change height', () => {
  const list = scrollList(), position = captureMessagePosition(list);
  assert.deepEqual(position, { atEnd: false, messageId: 'two', offset: -20, top: 260 });
  list.rows[1].offset += 75; list.rows[2].offset += 75;
  restoreMessagePosition(list, position); assert.equal(list.scrollTop, 335);
  assert.deepEqual(Object.keys(position).sort(), ['atEnd', 'messageId', 'offset', 'top']);
});
test('message anchors handle fresh, bottom-following, removed and hidden projections', () => {
  const list = scrollList(), position = captureMessagePosition(list);
  list.rows = list.rows.filter((row) => row.id !== position.messageId); list.scrollTop = 0;
  restoreMessagePosition(list, position); assert.equal(list.scrollTop, 260);
  list.scrollTop = 690; assert.equal(captureMessagePosition(list).atEnd, true);
  restoreMessagePosition(list, { atEnd: true }); assert.equal(list.scrollTop, 1000);
  list.scrollTop = 0; restoreMessagePosition(list, null); assert.equal(list.scrollTop, 1000);
  list.clientHeight = 0; assert.equal(captureMessagePosition(list), null);
  list.scrollTop = 0; restoreMessagePosition(list, position); assert.equal(list.scrollTop, 0);
});
test('closed message menus cannot replace the row anchor while the outer page is scrolled', () => {
  const list = scrollList(); list.viewportTop = -300;
  list.rows[0].controls = [{ id: 'one', control: true, offset: 140, height: 44, hidden: true }];
  list.rows[1].controls = [{ id: 'two', control: true, offset: 300, height: 44 }];
  const expected = { atEnd: false, messageId: 'two', offset: -20, top: 260 };
  assert.equal(list.querySelectorAll('[data-message-id]').length, 5, 'The fixture includes nested message-ID controls.');
  assert.equal(list.node(list.rows[0].controls[0]).getBoundingClientRect().bottom, 0);
  // Repeated authorized paints must not drift from a zero-rectangle button to
  // its parent row or reset an explicit Home target to an earlier message.
  for (let poll = 0; poll < 5; poll++) {
    const position = captureMessagePosition(list);
    assert.deepEqual(position, expected);
    restoreMessagePosition(list, position);
    assert.equal(list.scrollTop, 260);
  }
  list.rows[1].offset += 75; list.rows[2].offset += 75;
  restoreMessagePosition(list, expected);
  assert.equal(list.scrollTop, 335);
  assert.equal(captureMessagePosition(list).offset, expected.offset);
});
test('a missing target row uses the saved top even if a remaining control carries its message ID', () => {
  const list = scrollList(), position = captureMessagePosition(list);
  list.rows = list.rows.filter((row) => row.id !== position.messageId);
  list.rows[0].controls = [{ id: position.messageId, control: true, offset: 160, height: 44 }];
  list.scrollTop = 0;
  restoreMessagePosition(list, position);
  assert.equal(list.scrollTop, position.top);
});
test('visible messages contain only intersecting rows, never open or closed message-ID controls', () => {
  const list = scrollList();
  list.rows[0].controls = [{ id: 'one', control: true, offset: 140, height: 44, hidden: true }];
  list.rows[1].controls = [{ id: 'two', control: true, offset: 300, height: 44 }];
  list.rows[2].controls = [{ id: 'three', control: true, offset: 450, height: 44 }];
  const second = list.node(list.rows[1]), third = list.node(list.rows[2]);
  assert.deepEqual(visibleMessageRows(list, 900), [second, third]);
  assert.deepEqual(visibleMessageRows(list, 240), [second]); // Keyboard/nav excludes the lower row.
  assert.deepEqual(visibleMessageRows(list, 400, 220), [third]); // Visual viewport pan excludes the upper row.
  list.viewportTop = -300;
  assert.deepEqual(visibleMessageRows(list, 740), []); // Whole list is above the actual screen.
});
test('read visibility requires an actual intersection between the list and the viewport', () => {
  const row = { dataset: { testid: 'message-row', messageId: 'tall', sequence: '1' },
    getBoundingClientRect: () => ({ top: 500, bottom: 1500 }) };
  const list = { clientHeight: 240, getBoundingClientRect: () => ({ top: 1000, bottom: 1240 }),
    querySelectorAll: (selector) => selectMessageNodes(selector, [row]) };
  assert.deepEqual(visibleMessageRows(list, 900), []);
  list.getBoundingClientRect = () => ({ top: 700, bottom: 940 });
  assert.deepEqual(visibleMessageRows(list, 900), [row]);
  assert.deepEqual(visibleMessageRows(list, 400), []); // Keyboard reduces visible height.
  assert.deepEqual(visibleMessageRows(list, 1600, 1500), []); // Zoom/pan clips above visual viewport.
  assert.deepEqual(visibleMessageRows(list, 690), []); // Fixed navigation covers the list.
  list.clientHeight = 0; assert.deepEqual(visibleMessageRows(list, 900), []);
});

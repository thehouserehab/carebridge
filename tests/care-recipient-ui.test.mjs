// Pure synthetic transport/DOM doubles. No server, browser, account or DB is created.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { LocalApiClient, LocalApiError } from '../local-api/client.js';
import { CareApiClient } from '../local-api/care-client.js';
import { CareRecipientApiClient, recipientTextMessage } from '../local-api/care-recipient-client.js';
import { recipientSettingsCandidates, RecipientSettingsOperation, recipientSettingsMarkup, OperationsRecipientUi } from '../local-api/operations-recipient.js';
import { OperationsApiClient } from '../local-api/operations-client.js';
import { RelationshipDraft, relationshipsMarkup } from '../local-api/operations-onboarding.js';
import { assignedCenters } from '../local-api/approval-pending-ui.js';
import { roleName, workspaceMenus, homeMarkup, childMarkup, primaryCommunicatorMarkup, roomParticipantsMarkup } from '../local-api/workspace-ui.js';
import { renderCareMessage } from '../local-api/care-ui.js';
import { InvitationApiClient, INVITATION_REQUEST_NOTICE } from '../local-api/invitation-client.js';

const center = 'synthetic-center', roomId = 'synthetic-room', childId = 'synthetic-child';
const root = `/api/local/centers/${center}`;
const code = expected => error => error instanceof LocalApiError && error.code === expected;
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const link = (extra = {}) => ({ conversationId: roomId, childId, userId: null, active: false, version: 2, ...extra });
const primary = (extra = {}) => ({ conversationId: roomId, userId: null, revision: 0, ...extra });
const members = [
  { userId: 'g1', role: 'guardian', displayName: '합성 보호자' },
  { userId: 'g2', role: 'guardian', displayName: '미연결 보호자' },
  { userId: 'r1', role: 'care_recipient', displayName: '합성 대상자' },
  { userId: 'r2', role: 'care_recipient', displayName: '다른 대상자' },
  { userId: 't1', role: 'therapist', displayName: '합성 치료사' },
  { userId: 'm1', role: 'center', displayName: '합성 관리자' },
];
const relationships = (extra = {}) => ({ conversationId: roomId, childId, version: 2,
  participants: [members[0], members[4]].map(p => ({ userId: p.userId, role: p.role, firstSequence: 1 })), ...extra });
const command = (extra = {}) => ({ conversationId: roomId, userId: 'r1', expectedVersion: 2, clientId: 'synthetic-request-0001', ...extra });
const profile = (extra = {}) => ({ conversationId: roomId, childId, name: '합성 대상자', participants: [members[0], members[2], members[4]], ...extra });
const textMessage = (extra = {}) => ({ id: 'message-1', conversationId: roomId, childId, sequence: 1, authorId: 't1',
  type: 'text', body: '연결 이후 합성 소식', read: false, createdAt: '2026-10-16T00:00:00Z', ...extra });
const period = { dateFrom: '2026-10-01', dateTo: '2026-10-31', label: '2026년 10월' };
const fixtureRoom = (extra = {}) => ({ conversationId: roomId, childId, unread: 1, targetId: 'message-1',
  latest: { id: 'message-1', body: '합성 소식', authorId: 't1', createdAt: '2026-10-16T00:00:00Z' },
  profile: profile(), care: { goals: [], appointments: [], publications: [], records: [] }, ...extra });
function client(fetch) {
  const transport = new LocalApiClient({ fetch }); transport.expectedUserId = 'synthetic-manager';
  return { api: new CareRecipientApiClient(transport), transport };
}
const deferred = () => Promise.withResolvers();

test('role-specific navigation retains external flex layout without CSP-blocked inline styling', async () => {
  const source = await readFile(new URL('../local-api/app.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../local-api/styles.css', import.meta.url), 'utf8');
  const nav = source.match(/<nav class="main-nav"[^>]*>/)?.[0];
  assert(nav);
  assert.doesNotMatch(nav, /\bstyle\s*=/);
  assert.match(css, /\.main-nav\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.main-nav button\s*\{[^}]*flex:\s*1/);
});

test('independent recipient role is assigned without opening clinical menus or manager surfaces', () => {
  assert.equal(roleName('care_recipient'), '대상자');
  assert.deepEqual(workspaceMenus('care_recipient'), [['home', '홈'], ['chat', '대화'], ['child', '참여 정보']]);
  assert(workspaceMenus('guardian').some(([key]) => key === 'records'));
  assert.deepEqual(assignedCenters({ centers: [{ id: center, role: 'care_recipient' }, { id: center, role: 'unknown' }] }), [{ id: center, role: 'care_recipient' }]);
});

test('recipient session and invitation accept new role, without widening arbitrary role acceptance', async () => {
  const user = { userId: 'synthetic-recipient', email: 'synthetic-recipient@example.test',
    centers: [{ id: center, role: 'care_recipient' }], expiresAt: '2026-10-17T00:00:00.000Z' };
  const api = new LocalApiClient({ fetch: async () => response({ user }) });
  assert.deepEqual(await api.session(), user);
  let posted;
  const invitation = new InvitationApiClient({ expectedUserId: 'synthetic-manager', request: async (path, { body }) => {
    posted = { path, body }; return { message: INVITATION_REQUEST_NOTICE };
  } });
  await invitation.invite(center, { email: user.email, role: 'care_recipient' });
  assert.equal(posted.body.role, 'care_recipient');
  await assert.rejects(invitation.invite(center, { email: user.email, role: 'center' }), code('INVALID_INPUT'));
  await assert.rejects(new LocalApiClient({ fetch: async () => response({ user: { ...user, centers: [{ id: center, role: 'root' }] } }) }).session(), code('INVALID_RESPONSE'));
});

test('recipient home and participant view cannot render supplied clinical/private payloads', () => {
  const current = fixtureRoom({ profile: profile({ age: 8, ageAsOf: '2000-01-01', familyPlan: { concern: 'PRIVATE-FAMILY', revision: 1 } }),
    care: { goals: [{ title: 'PRIVATE-GOAL' }], appointments: [{ title: 'PRIVATE-APPOINTMENT' }], records: [{ title: 'PRIVATE-RECORD' }],
      publications: [{ publication: { title: 'PRIVATE-PUBLICATION', activity: { title: 'PRIVATE-ACTIVITY' } } }] } });
  for (const html of [homeMarkup([current], 'care_recipient', period), childMarkup(current, 'care_recipient', period)]) {
    assert.doesNotMatch(html, /PRIVATE|2000-01-01|data-open-record|data-open-goal|data-open-appointment|data-family-plan|data-media/);
    assert.match(html, /대화/); assert.match(html, /합성 대상자/);
  }
  assert.doesNotMatch(homeMarkup([], 'care_recipient', period), /data-home-panel="(?:work|schedule)"/);
});

test('recipient text projection excludes private cards, attachments, quoted previews and review metadata', () => {
  const value = textMessage({ attachments: [{ name: 'PRIVATE-FILE' }], attachmentCount: 1, quote: { preview: 'PRIVATE-QUOTE' },
    reviewed: true, review: { note: 'PRIVATE-REVIEW' }, publication: { title: 'PRIVATE-TITLE' } });
  const projected = recipientTextMessage(value);
  assert.equal(projected.body, value.body); assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|attachment|quote|review|publication/);
  for (const type of ['publication', 'feedback']) {
    assert.equal(recipientTextMessage({ ...value, type }), null);
    assert.equal(renderCareMessage({ ...value, type }, 'care_recipient', 'r1', true), '');
  }
  assert.equal(recipientTextMessage({ ...value, body: '  ' }), null);
  assert(recipientTextMessage({ ...value, body: '', deleted: true }));
  const html = renderCareMessage(value, 'care_recipient', 'r1', true);
  assert.match(html, /연결 이후 합성 소식/); assert.doesNotMatch(html, /PRIVATE|button|img|video|data-media/);
  assert.equal(renderCareMessage({ ...value, body: '<script>test</script>' }, 'care_recipient', 'r1'), '<p>&lt;script&gt;test&lt;/script&gt;</p>');
  assert.match(renderCareMessage({ ...value, deleted: true }, 'care_recipient', 'r1'), /삭제된/);
});

test('primary communicator is displayed only for an eligible current participant and clearly not as permission', () => {
  const p = profile({ primaryCommunicator: primary({ userId: 'r1' }) });
  assert.match(primaryCommunicatorMarkup(p), /합성 대상자 \(대상자\)/);
  assert.match(primaryCommunicatorMarkup(p), /개인 대화·동의 완료·기록 열람 권한을 뜻하지 않/);
  assert.match(roomParticipantsMarkup(p.participants, 'r1'), /합성 대상자 · 주 소통자/);
  for (const userId of ['t1', 'm1', 'missing']) assert.match(primaryCommunicatorMarkup({ ...p, primaryCommunicator: primary({ userId }) }), /미지정/);
  assert.doesNotMatch(roomParticipantsMarkup(p.participants, 't1'), /치료사 · 주 소통자/);
});

test('recipient care workspace calls inbox/profile/text only and produces no clinical collection reads', async () => {
  const seen = [];
  const api = new CareApiClient({ fetch: async path => {
    const ending = new URL(path, 'http://synthetic.invalid').pathname.split('/').at(-1); seen.push(ending);
    if (ending === 'inbox') return response({ snapshot: 'a'.repeat(32), resetRequired: false, rooms: [{ conversationId: roomId, childId,
      unread: 1, targetId: 'message-1', latest: fixtureRoom().latest }], hasMore: false, nextOffset: 1 });
    if (ending === 'profile') return response(profile());
    if (ending === 'messages') return response({ revision: 1, resetRequired: false, messages: [textMessage()], hasMore: false, nextCursor: 1 });
    throw new Error('Unexpected clinical route');
  } });
  api.expectedUserId = 'synthetic-recipient';
  const value = await api.careWorkspace(center, roomId, { ...period, role: 'care_recipient' });
  assert.deepEqual(value.rooms[0].care, { goals: [], appointments: [], records: [], publications: [] });
  assert.deepEqual([...new Set(seen)].sort(), ['inbox', 'messages', 'profile']);
  assert.equal(value.messages[0].body, textMessage().body);
});

test('recipient API exact scoped routes use existing account and CSRF transport, not supplied actor roles', async () => {
  const calls = [];
  const { api } = client(async (path, options) => {
    calls.push({ path, options }); const body = options.body && JSON.parse(options.body);
    if (!body) return response(path.includes('care-recipient-link') ? { link: link() } : { primary: primary() });
    return response({ receipt: { conversationId: roomId, [path.endsWith('primary-communicator') ? 'appliedRevision' : 'appliedVersion']:
      (body.expectedVersion ?? body.expectedRevision) + 1, changed: true, replayed: false } });
  });
  assert.deepEqual(await api.link(center, roomId), link()); assert.deepEqual(await api.primary(center, roomId), primary());
  await api.save(center, 'connect', command()); await api.save(center, 'disconnect', command());
  await api.save(center, 'primary', { conversationId: roomId, userId: null, expectedRevision: 0, clientId: 'synthetic-primary-0001' });
  assert.deepEqual(calls.map(c => c.path), [`${root}/care-recipient-link?conversationId=${roomId}`, `${root}/primary-communicator?conversationId=${roomId}`,
    `${root}/care-recipient-link`, `${root}/care-recipient-link/disconnect`, `${root}/primary-communicator`]);
  for (const { options } of calls) { assert.equal(options.credentials, 'same-origin'); assert.equal(options.headers['X-Carebridge-Account'], 'synthetic-manager'); assert.equal(options.cache, 'no-store'); }
  for (const { options } of calls.slice(2)) { assert.equal(options.method, 'POST'); assert.equal(options.headers['X-Carebridge-Request'], '1'); }
  assert.deepEqual(JSON.parse(calls[2].options.body), command());
  assert.equal(JSON.parse(calls[4].options.body).userId, null);
});

test('malformed command, extra authority and path input rejected before transport', async () => {
  let calls = 0; const { api } = client(async () => { calls++; return response({}); });
  for (const extra of [{ role: 'center' }, { actorId: 'other' }, { userId: null }, { expectedVersion: -1 }, { expectedVersion: 2.1 },
    { expectedVersion: Number.MAX_SAFE_INTEGER + 1 }, { conversationId: '../room' }, { clientId: 'short' }])
    await assert.rejects(api.save(center, 'connect', command(extra)), code('INVALID_INPUT'));
  await assert.rejects(api.link('../center', roomId), code('INVALID_INPUT'));
  await assert.rejects(api.primary(center, 'bad room'), code('INVALID_INPUT'));
  await assert.rejects(api.save(center, 'reassign', command()), code('INVALID_INPUT'));
  assert.equal(calls, 0);
});

test('read DTOs validate exact room, nullable link state, bounded revision, and private excess fields', async () => {
  for (const extra of [{ conversationId: 'other' }, { childId: null }, { userId: 'bad id' }, { active: true }, { version: -1 },
    { version: Number.MAX_SAFE_INTEGER + 1 }, { version: '2' }, { email: 'PRIVATE' }])
    await assert.rejects(client(async () => response({ link: link(extra) })).api.link(center, roomId), code('INVALID_RESPONSE'));
  for (const extra of [{ conversationId: 'other' }, { revision: -1 }, { userId: '' }, { actor: 'PRIVATE' }])
    await assert.rejects(client(async () => response({ primary: primary(extra) })).api.primary(center, roomId), code('INVALID_RESPONSE'));
  const source = link({ userId: 'r1', active: true }); const value = await client(async () => response({ link: source })).api.link(center, roomId);
  assert(Object.isFrozen(value)); source.userId = 'r2'; assert.equal(value.userId, 'r1');
});

test('receipts validate exact applied version and retain replay/no-op distinctions', async () => {
  for (const changed of [true, false]) for (const replayed of [true, false]) {
    const receipt = { conversationId: roomId, appliedVersion: changed ? 3 : 2, changed, replayed };
    assert.deepEqual(await client(async () => response({ receipt })).api.save(center, 'connect', command()), receipt);
  }
  for (const extra of [{ conversationId: 'other' }, { appliedVersion: 4 }, { changed: 1 }, { replayed: null }, { actorId: 'PRIVATE' }]) {
    const receipt = { conversationId: roomId, appliedVersion: 3, changed: true, replayed: false, ...extra };
    await assert.rejects(client(async () => response({ receipt })).api.save(center, 'connect', command()), code('INVALID_RESPONSE'));
  }
});

test('account changes and aborts reject delayed results, no account never sends', async () => {
  for (const mode of ['account', 'abort']) {
    const gate = deferred(), { api, transport } = client(async () => { await gate.promise; return response({ link: link() }); });
    const controller = new AbortController(), pending = api.link(center, roomId, controller.signal);
    if (mode === 'account') transport.expectedUserId = 'different-account'; else controller.abort();
    gate.resolve(); await assert.rejects(pending, code(mode === 'account' ? 'AUTH_REQUIRED' : 'CANCELLED'));
  }
  let calls = 0; const { api, transport } = client(async () => { calls++; return response({}); });
  transport.expectedUserId = null; await assert.rejects(api.link(center, roomId), code('AUTH_REQUIRED')); assert.equal(calls, 0);
});

test('candidate policy preserves stable identity and only offers active linked guardian/recipient as primary', () => {
  assert.deepEqual(recipientSettingsCandidates(link(), relationships(), members).available.map(m => m.userId), ['r1', 'r2']);
  for (const active of [true, false]) {
    const value = recipientSettingsCandidates(link({ userId: 'r1', active }), relationships(), members);
    assert.deepEqual(value.available.map(m => m.userId), ['r1']);
    assert.deepEqual(value.primary.map(m => m.userId), active ? ['g1', 'r1'] : ['g1']);
  }
});

test('uncertain writes keep exact frozen command even after later conflicts and refuse double submit', () => {
  const mutation = new RecipientSettingsOperation(), body = { conversationId: roomId, userId: 'r1', expectedVersion: 2 };
  const first = mutation.begin('connect', body, () => 'synthetic-request'); body.userId = 'r2';
  assert.equal(mutation.begin('disconnect', body), null); assert(Object.isFrozen(first.body));
  mutation.failed(first, new LocalApiError('UNAVAILABLE'));
  assert.equal(mutation.begin('primary', { userId: 'other' }), first);
  mutation.failed(first, new LocalApiError('RELATIONSHIP_CONFLICT', 409));
  assert.equal(mutation.operation, first); assert(mutation.uncertain); assert.equal(first.body.userId, 'r1');
  mutation.accepted(first); assert.equal(mutation.operation, null);
  const second = mutation.begin('connect', { ...body, expectedVersion: 9 }, () => 'synthetic-other-request');
  mutation.failed(second, new LocalApiError('RELATIONSHIP_CONFLICT', 409)); assert.equal(mutation.operation, null);
  assert(!mutation.uncertain);
});

test('manager markup explains identity/permission boundaries and escapes display names without contact data', () => {
  const mutation = new RecipientSettingsOperation();
  const state = { name: '<img src=x>', connected: true, link: link({ userId: 'r1', active: true }), primary: primary(), relationships: relationships(),
    members: members.map(m => ({ ...m, email: 'PRIVATE-EMAIL' })), selection: { link: 'r1', primary: '' }, checked: { link: false, primary: false }, mutation };
  const html = recipientSettingsMarkup(state);
  assert.match(html, /&lt;img src=x&gt;/); assert.doesNotMatch(html, /PRIVATE-EMAIL|<img/);
  assert.match(html, /연결 이후 일반 텍스트 대화만/); assert.match(html, /본인의 의사·동의 확인을 대신하지/);
  assert.match(html, /다른 계정으로 재배정하지/); assert.match(html, /value="" selected>미지정/);
  mutation.begin('disconnect', { conversationId: roomId, userId: 'r1', expectedVersion: 2 }, () => 'synthetic-request');
  mutation.interrupt(); assert.match(recipientSettingsMarkup(state), /같은 요청으로 확인/);
  assert.match(recipientSettingsMarkup({ ...state, link: null, error: 'READ-ERROR' }), /처리 결과가 불확실/);
});

test('existing relationship draft keeps recipient read-only and never adds it to replacement choices', async () => {
  const data = relationships({ participants: [...relationships().participants, { userId: 'r1', role: 'care_recipient', firstSequence: 10 }] });
  const api = new OperationsApiClient({ expectedUserId: 'synthetic-manager', request: async path => path.includes('/members')
    ? { members, hasMore: false, nextCursor: members.at(-1).userId } : { relationships: data } });
  assert.deepEqual(await api.members(center), members);
  assert.deepEqual(await api.relationships(center, roomId), data);
  const draft = new RelationshipDraft(data, members); draft.values.historyConfirmed = true;
  const command = draft.begin(() => 'synthetic-relationship-command');
  assert.equal(command.therapist.userId, 't1'); assert.deepEqual(command.guardians.map(p => p.userId), ['g1']);
  assert.doesNotMatch(JSON.stringify(command), /r1|care_recipient/);
  assert.match(relationshipsMarkup(draft), /대상자 본인 계정 연결은 유지/);
});

function uiFixture({ getLink = async () => link(), getPrimary = async () => primary(), save = async () => ({}), getRelationships = async () => relationships() } = {}) {
  const controls = new Map(); let renders = 0;
  const host = { ownerDocument: { activeElement: null }, contains: () => false, querySelector: selector => controls.get(selector) ?? null,
    querySelectorAll: () => [], addEventListener() {}, replaceChildren() { this.innerHTML = ''; },
    set innerHTML(value) { this.html = value; renders++; }, get innerHTML() { return this.html; } };
  const transport = { expectedUserId: 'synthetic-manager' }, denied = [];
  const ui = new OperationsRecipientUi({ host, transport, centerId: center, userId: transport.expectedUserId, roomId, name: '합성 대상자',
    client: { link: getLink, primary: getPrimary, save }, directory: { members: async () => structuredClone(members), relationships: getRelationships }, onDenied: e => denied.push(e.code) });
  const choose = (name, value, confirmed = true) => {
    const key = name === 'recipientUserId' ? 'linkConfirmed' : 'primaryConfirmed';
    controls.set(`[name="${name}"]`, { value }); controls.set(`[name="${key}"]`, { checked: confirmed });
  };
  return { ui, host, transport, controls, choose, denied, renders: () => renders };
}

test('manager UI reads and repeated identical polls do not write or reset a confirmed selection', async () => {
  let writes = 0; const f = uiFixture({ save: async () => { writes++; } }); await f.ui.mount();
  f.choose('recipientUserId', 'r1'); f.ui.capture(); await f.ui.refresh();
  assert.equal(f.ui.selection.link, 'r1'); assert.equal(f.ui.checked.link, true); assert.equal(writes, 0);
  const count = f.renders(); await f.ui.refresh(); assert.equal(f.renders(), count);
});

test('manager UI requires explicit confirmation and uncertainty retries exact original command', async () => {
  const calls = []; let version = 2;
  const f = uiFixture({ getLink: async () => link({ version }), getRelationships: async () => relationships({ version }), save: async (...args) => {
    calls.push(args); if (calls.length === 1) throw new LocalApiError('UNAVAILABLE');
  } });
  await f.ui.mount(); f.choose('recipientUserId', 'r1', false); await f.ui.save('connect'); assert.equal(calls.length, 0);
  f.choose('recipientUserId', 'r1'); await f.ui.save('connect'); assert.equal(calls.length, 1); assert(f.ui.hasPendingWrite());
  version = 3; f.choose('recipientUserId', 'r2'); await f.ui.refresh(); assert.equal(calls.length, 1);
  await f.ui.save('connect'); assert.equal(calls.length, 2); assert.equal(calls[0][2], calls[1][2]);
  assert.equal(calls[1][2].userId, 'r1'); assert.equal(calls[1][2].expectedVersion, 2); assert(!f.ui.hasPendingWrite());
});

test('manager UI prevents overlapping writes and records lost visibility as uncertain without auto retry', async () => {
  const gate = deferred(); let writes = 0;
  const f = uiFixture({ save: async () => { writes++; await gate.promise; } });
  await f.ui.mount(); f.choose('recipientUserId', 'r1'); const pending = f.ui.save('connect');
  await f.ui.save('connect'); assert.equal(writes, 1); f.ui.suspend();
  assert.equal(f.host.innerHTML, ''); assert(f.ui.mutation.uncertain); gate.resolve(); await pending;
  assert(f.ui.hasPendingWrite()); await f.ui.resume(); assert.equal(writes, 1); assert(f.ui.hasPendingWrite());
});

test('effective primary loss at the same designation revision resets selection and confirmation without writing', async () => {
  let userId = 'g1', writes = 0;
  const f = uiFixture({ getPrimary: async () => primary({ userId, revision: 4 }), save: async () => { writes++; } });
  await f.ui.mount(); f.choose('primaryUserId', 'g1'); f.ui.capture();
  assert.equal(f.ui.selection.primary, 'g1'); assert.equal(f.ui.checked.primary, true);
  userId = null; await f.ui.refresh();
  assert.equal(f.ui.primary.revision, 4); assert.equal(f.ui.primary.userId, null);
  assert.equal(f.ui.selection.primary, ''); assert.equal(f.ui.checked.primary, false); assert.equal(writes, 0);
  assert.match(f.host.innerHTML, /value="" selected>미지정/);
});

test('manager UI rejects mismatched read versions and discards late results after account changes', async () => {
  const mismatch = uiFixture({ getLink: async () => link({ version: 3 }) }); await mismatch.ui.mount();
  assert(!mismatch.ui.connected); assert.equal(mismatch.ui.link, null);
  const gate = deferred(), f = uiFixture({ getLink: async () => { await gate.promise; return link(); } });
  const pending = f.ui.mount(); f.transport.expectedUserId = 'other-account'; gate.resolve(); await pending;
  assert.equal(f.ui.link, null); assert(!f.ui.connected); await f.ui.save('connect'); assert.deepEqual(f.denied, ['AUTH_REQUIRED']);
});

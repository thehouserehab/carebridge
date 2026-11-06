// Controller/DOM doubles only. Separate live-browser evidence is required.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApprovalPendingUi, assignedCenters, approvalPendingMarkup } from '../local-api/approval-pending-ui.js';

const user = { userId: 'synthetic-pending', centers: [] };
const approved = { ...user, centers: [{ id: 'synthetic-center', role: 'guardian' }] };
function fixture(session = async () => user) {
  const calls = [], notices = [], outcomes = [], nodes = {};
  for (const name of ['[data-approval="refresh"]', '[data-approval="logout"]', 'h1'])
    nodes[name] = { disabled: false, focus() { calls.push('focus'); },
      addEventListener(type, handler, { signal }) { this.click = () => { if (!signal.aborted) handler(); }; } };
  const host = { innerHTML: '', querySelector: name => nodes[name] };
  const ui = new ApprovalPendingUi({ host, userId: user.userId,
    transport: { async session(signal) { calls.push(signal); return session(signal); } },
    announce: message => notices.push(message), onApproved: identity => outcomes.push(['approved', identity]),
    onDenied: () => outcomes.push(['denied']), onLogout: () => outcomes.push(['logout']) });
  ui.mount();
  return { ui, host, nodes, calls, notices, outcomes };
}

test('pending screen exposes only check/logout and no role, account or clinical input', () => {
  const html = approvalPendingMarkup();
  assert.match(html, /관리자 승인을 기다리고/); assert.match(html, /역할은 센터 관리자가 부여/);
  assert.equal((html.match(/<button/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<(?:input|select|form)\b|data-view=|data-open-room=|@/);
  assert.match(html, /<h1 tabindex="-1">/);
});
test('only current server centers with recognized roles can enter an assigned screen', () => {
  for (const role of ['guardian', 'therapist', 'center'])
    assert.deepEqual(assignedCenters({ centers: [{ id: 'c', role }] }), [{ id: 'c', role }]);
  for (const identity of [null, {}, { role: 'center' }, { centers: 'center' },
    { centers: [null, { id: 'c', role: 'admin' }, { id: '', role: 'center' }] }])
    assert.deepEqual(assignedCenters(identity), []);
});
test('pending refresh only reads a session; no automatic role, child or logout action', async () => {
  const f = fixture(); await f.ui.refresh();
  assert.equal(f.calls.length, 2); assert.equal(f.outcomes.length, 0);
  assert.match(f.notices.at(-1), /대기 중/); assert.equal(f.nodes['[data-approval="refresh"]'].disabled, false);
  f.ui.destroy();
});
test('server assignment passes the returned identity, not a selected role', async () => {
  const f = fixture(async () => approved); await f.ui.refresh();
  assert.deepEqual(f.outcomes, [['approved', approved]]); f.ui.destroy();
});
test('changed account or expired session never opens an assigned screen', async () => {
  for (const session of [async () => ({ ...approved, userId: 'different' }),
    async () => { throw Object.assign(new Error('internal'), { code: 'AUTH_REQUIRED' }); }]) {
    const f = fixture(session); await f.ui.refresh(); assert.deepEqual(f.outcomes, [['denied']]);
    assert(!f.notices.join('').includes('internal')); f.ui.destroy();
  }
});
test('network failure preserves pending state without exposing internal errors', async () => {
  const f = fixture(async () => { throw new Error('private-internal-address'); });
  await f.ui.refresh(); assert.equal(f.outcomes.length, 0);
  assert.match(f.notices.at(-1), /확인하지 못했어요/);
  assert(!f.notices.join('').includes('private-internal')); f.ui.destroy();
});
test('overlapping refreshes are coalesced and suspension rejects a late approved result', async () => {
  const wait = Promise.withResolvers(), f = fixture(() => wait.promise);
  const first = f.ui.refresh(); await f.ui.refresh(); assert.equal(f.calls.length, 2);
  f.ui.suspend(); assert.equal(f.calls[1].aborted, true); wait.resolve(approved); await first;
  assert.equal(f.outcomes.length, 0); f.ui.destroy();
});
test('destroy detaches buttons and prevents a late session result crossing logout', async () => {
  const wait = Promise.withResolvers(), f = fixture(() => wait.promise), pending = f.ui.refresh();
  f.ui.destroy(); f.nodes['[data-approval="logout"]'].click(); wait.resolve(approved); await pending;
  assert.equal(f.outcomes.length, 0); await f.ui.refresh(); assert.equal(f.calls.length, 2);
});
test('explicit logout aborts an outstanding approval read before exiting', async () => {
  const wait = Promise.withResolvers(), f = fixture(() => wait.promise), pending = f.ui.refresh();
  f.nodes['[data-approval="logout"]'].click(); assert.equal(f.calls[1].aborted, true);
  wait.resolve(approved); await pending; assert.deepEqual(f.outcomes, [['logout']]); f.ui.destroy();
});
test('resuming after suspension can accept a newly assigned server role', async () => {
  const waits = [Promise.withResolvers(), Promise.withResolvers()]; let index = 0;
  const f = fixture(() => waits[index++].promise), old = f.ui.refresh(); f.ui.suspend();
  const current = f.ui.refresh(); waits[0].resolve(approved); await old;
  assert.equal(f.outcomes.length, 0); waits[1].resolve(approved); await current;
  assert.deepEqual(f.outcomes, [['approved', approved]]); f.ui.destroy();
});

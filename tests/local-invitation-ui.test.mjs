// Pure controller and bounded DOM doubles. Not browser/API/DB/mail evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalApiError } from '../local-api/client.js';
import { InvitationUi, invitationMarkup } from '../local-api/invitation-ui.js';
import { OperationsInvitationsUi, operationsInvitationsMarkup } from '../local-api/operations-invitations.js';
import { INVITATION_REQUEST_NOTICE } from '../local-api/invitation-client.js';

const token = 'z'.repeat(43), iid = `inv_${'b'.repeat(32)}`;
const invitation = () => ({ id: iid, centerId: 'synthetic-center', role: 'guardian', expiresAt: '2026-10-12T00:00:00.000Z' });
const user = (extra = {}) => ({ userId: 'synthetic-user', email: 'person@example.test', centers: [{ id: 'synthetic-center', role: 'guardian' }], expiresAt: '2026-10-10T08:00:00.000Z', ...extra });
const listed = (extra = {}) => ({ ...invitation(), email: 'person@example.test', status: 'pending', createdAt: '2026-10-10T00:00:00.000Z', acceptedAt: null, revokedAt: null, ...extra });
const result = (existing = false) => ({ user: user(), invitation: { id: iid, centerId: 'synthetic-center', role: 'guardian' }, ...(existing ? { linked: true, replayed: false } : {}) });
const gate = () => Promise.withResolvers();
const decode = s => s.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

// Model only form identity, values, named controls, password clearing and owned
// listener teardown used here. Real focus/layout validity needs browser tests.
function hostDouble() {
  let html = '', forms = [], nodes = [];
  const listeners = [], document = { activeElement: null };
  const host = { ownerDocument: document, listeners,
    addEventListener(type, fn, options) { listeners.push({ type, fn, signal: options.signal }); },
    contains: node => nodes.includes(node) || forms.includes(node),
    querySelectorAll(selector) { return selector.startsWith('input[name=') ? nodes.filter(n => ['password', 'confirmation'].includes(n.name)) : nodes; },
    querySelector(selector) {
      if (selector === 'h1') return { focus() {} };
      const name = /data-invitation-form="([^"]+)"/.exec(selector)?.[1];
      if (selector.includes('data-invitation-form')) return forms.find(f => !name || f.dataset.invitationForm === name) ?? null;
      return null;
    },
    replaceChildren() { this.innerHTML = ''; },
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value; forms = []; nodes = [];
      for (const found of value.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
        const kind = /data-invitation-form="([^"]+)"/.exec(found[1])?.[1]; if (!kind) continue;
        const controls = [];
        for (const input of found[2].matchAll(/<(input|select)\b([^>]*)>/g)) {
          const name = /name="([^"]+)"/.exec(input[2])?.[1]; if (!name) continue;
          const node = { name, type: /type="([^"]+)"/.exec(input[2])?.[1] ?? input[1], checked: false,
            value: decode(/value="([^"]*)"/.exec(input[2])?.[1] ?? (name === 'role' ? 'guardian' : '')),
            disabled: input[2].includes('disabled'), dataset: {}, focus() { document.activeElement = this; } };
          controls.push(node); nodes.push(node);
        }
        const form = { dataset: { invitationForm: kind, invitationId: /data-invitation-id="([^"]+)"/.exec(found[1])?.[1] },
          elements: { namedItem: name => controls.find(n => n.name === name) }, reportValidity: () => true,
          matches: selector => selector.includes('data-invitation-form') };
        forms.push(form);
      }
    },
  };
  return host;
}
function fixture({ signedIn = false, client = {}, transport = {} } = {}) {
  const host = hostDouble(), calls = [], authenticated = [], exits = [];
  let current = signedIn ? user() : null;
  const base = { expectedUserId: current?.userId ?? null, clearIdentity() { this.expectedUserId = null; },
    async session(signal) { calls.push(['session', signal]); if (!current) throw new LocalApiError('AUTH_REQUIRED', 401); this.expectedUserId = current.userId; return current; },
    async login(email, password, signal) { calls.push(['login', email, signal]); current = user({ email }); this.expectedUserId = current.userId; return current; },
    async logout(signal) { calls.push(['logout', signal]); current = null; }, ...transport };
  const api = { async preview(t, signal) { calls.push(['preview', t, signal]); return invitation(); },
    async accept(input, signal) { calls.push(['accept', input, signal]); current = user(); return result(); },
    async acceptExisting(input, signal) { calls.push(['existing', input, signal]); return result(true); }, ...client };
  const ui = new InvitationUi({ host, transport: base, client: api, onAuthenticated: (...args) => authenticated.push(args), onExit: () => exits.push(true) });
  return { host, base, api, ui, calls, authenticated, exits, setUser(value) { current = value; },
    form: () => host.querySelector('[data-invitation-form]') };
}
function values(form, input = {}) {
  for (const [name, value] of Object.entries(input)) {
    const node = form.elements.namedItem(name); assert(node, `missing test control ${name}`);
    if (name === 'confirmed') node.checked = value; else node.value = value;
  }
  return form;
}
async function newForm(f) { await f.ui.mount(token); await f.ui.action('new'); return values(f.form(), { password: 'Synthetic-password-1', confirmation: 'Synthetic-password-1', confirmed: true }); }

test('anonymous landing reads session and preview, never renders capability or preview email', async () => {
  const f = fixture(); await f.ui.mount(token);
  assert.equal(f.ui.phase, 'choose'); assert.deepEqual(f.calls.map(c => c[0]), ['session', 'preview']);
  assert(!f.host.innerHTML.includes(token)); assert(!JSON.stringify(f.ui).includes(token)); assert(!f.host.innerHTML.includes('person@example.test'));
  assert.match(f.host.innerHTML, /새 시험 계정으로 수락/); f.ui.destroy();
});
test('already authenticated landing requires explicit current-account center/role confirmation', async () => {
  const f = fixture({ signedIn: true }); await f.ui.mount(token); assert.equal(f.ui.phase, 'existing');
  assert.match(f.host.innerHTML, /person@example.test/); assert.match(f.host.innerHTML, /위 센터와 역할/);
  await f.ui.submit(f.form()); assert.equal(f.calls.filter(c => c[0] === 'existing').length, 0); f.ui.destroy();
});
test('new acceptance clears both password DOM controls before awaiting and fences callback with current session', async () => {
  const f = fixture(), form = await newForm(f), fields = ['password', 'confirmation'].map(n => form.elements.namedItem(n));
  await f.ui.submit(form); assert(fields.every(n => n.value === ''));
  assert.equal(f.authenticated.length, 1); assert.deepEqual(f.authenticated[0], [user(), 'synthetic-center']);
  assert.equal(f.calls.at(-1)[0], 'session'); assert.equal(f.host.innerHTML, ''); assert.equal(f.ui.invitation, null);
});
test('missing native confirmation never submits; stale detached form cannot submit twice', async () => {
  const f = fixture(), form = await newForm(f); values(form, { confirmed: false }); await f.ui.submit(form);
  assert.equal(f.calls.filter(c => c[0] === 'accept').length, 0);
  await f.ui.action('existing'); await f.ui.submit(form); assert.equal(f.calls.filter(c => c[0] === 'accept').length, 0); f.ui.destroy();
});
test('new acceptance unknown has no retry or new-account path and exit clears capability', async () => {
  let writes = 0; const f = fixture({ client: { accept: async () => { writes++; throw new LocalApiError('UNAVAILABLE'); } } });
  await f.ui.submit(await newForm(f)); assert.equal(f.ui.phase, 'unknown-new'); assert.match(f.host.innerHTML, /초대받은 시험 이메일/);
  for (const action of ['new', 'existing', 'retry-existing']) await f.ui.action(action);
  assert.equal(writes, 1); assert(!f.form()); f.ui.suspend(); await f.ui.resume(); assert.equal(f.ui.phase, 'unknown-new');
  await f.ui.action('exit'); assert.equal(f.exits.length, 1); assert.equal(f.host.innerHTML, '');
});
test('new acceptance explicit account-exists rejection opens login but never silently replaces a session', async () => {
  const f = fixture({ client: { accept: async () => { throw new LocalApiError('INVITATION_ACCOUNT_EXISTS', 409); } } });
  await f.ui.submit(await newForm(f)); assert.equal(f.ui.phase, 'login'); assert.equal(f.base.expectedUserId, null); assert.equal(f.authenticated.length, 0); f.ui.destroy();
});
test('new acceptance invalid input allows re-entry without retaining old password', async () => {
  const f = fixture({ client: { accept: async () => { throw new LocalApiError('INVALID_INPUT', 400); } } });
  await f.ui.submit(await newForm(f)); assert.equal(f.ui.phase, 'new'); assert.equal(f.form().elements.namedItem('password').value, ''); f.ui.destroy();
});
test('new acceptance success with mismatched invitation cannot adopt the returned identity', async () => {
  const f = fixture({ client: { accept: async () => ({ ...result(), invitation: { ...result().invitation, id: `inv_${'c'.repeat(32)}` } }) } });
  await f.ui.submit(await newForm(f)); assert.equal(f.authenticated.length, 0); assert.equal(f.base.expectedUserId, null); assert.equal(f.ui.phase, 'unknown-new'); f.ui.destroy();
});
test('accept success followed by cookie/account mismatch never authenticates the workspace', async () => {
  const f = fixture({ client: { accept: async () => { f.setUser(user({ userId: 'different' })); return result(); } } });
  await f.ui.submit(await newForm(f)); assert.equal(f.authenticated.length, 0); assert.equal(f.ui.phase, 'unknown-new'); f.ui.destroy();
});
test('existing login uses only entered synthetic credentials then requires explicit confirmation', async () => {
  const f = fixture(); await f.ui.mount(token); await f.ui.action('existing');
  const form = values(f.form(), { email: 'PERSON@example.test', password: 'Synthetic-password-1' }); await f.ui.submit(form);
  assert.equal(f.ui.phase, 'existing'); assert.equal(form.elements.namedItem('password').value, '');
  assert.equal(f.calls.filter(c => c[0] === 'existing').length, 0); assert.equal(f.calls.filter(c => c[0] === 'preview').length, 2);
  await f.ui.submit(values(f.form(), { confirmed: true })); assert.equal(f.authenticated.length, 1);
});
test('wrong existing email invalid invitation remains correctable only through explicit logout/login', async () => {
  const f = fixture({ signedIn: true, client: { acceptExisting: async () => { throw new LocalApiError('INVITATION_INVALID', 410); } } });
  await f.ui.mount(token); await f.ui.submit(values(f.form(), { confirmed: true })); assert.equal(f.ui.phase, 'existing');
  assert.match(f.host.innerHTML, /다른 계정으로 로그인/); await f.ui.action('logout'); assert.equal(f.ui.phase, 'login'); assert.equal(f.base.expectedUserId, null); f.ui.destroy();
});
test('existing acceptance unknown retries the identical private body without another preview', async () => {
  let tries = 0; const bodies = []; const f = fixture({ signedIn: true, client: { acceptExisting: async input => { bodies.push(input); if (++tries === 1) throw new LocalApiError('UNAVAILABLE'); return { ...result(true), replayed: true }; } } });
  await f.ui.mount(token); await f.ui.submit(values(f.form(), { confirmed: true })); assert.equal(f.ui.phase, 'unknown-existing');
  assert(!f.host.innerHTML.includes(token)); assert(!JSON.stringify(f.ui).includes(token));
  f.ui.suspend(); await f.ui.resume(); assert.equal(f.ui.phase, 'unknown-existing');
  await f.ui.action('retry-existing'); assert.equal(bodies[0], bodies[1]); assert(Object.isFrozen(bodies[0]));
  assert.equal(f.calls.filter(c => c[0] === 'preview').length, 1); assert.equal(f.authenticated.length, 1);
});
test('unknown existing later 410 or conflict keeps original retry-only state', async () => {
  let tries = 0; const f = fixture({ signedIn: true, client: { acceptExisting: async () => { throw ++tries === 1 ? new LocalApiError('UNAVAILABLE') : new LocalApiError('INVITATION_INVALID', 410); } } });
  await f.ui.mount(token); await f.ui.submit(values(f.form(), { confirmed: true })); await f.ui.action('retry-existing');
  assert.equal(f.ui.phase, 'unknown-existing'); assert(!f.form()); f.ui.destroy();
});
test('unknown existing loses retry eligibility when another account is observed on resume', async () => {
  const f = fixture({ signedIn: true, client: { acceptExisting: async () => { throw new LocalApiError('UNAVAILABLE'); } } });
  await f.ui.mount(token); await f.ui.submit(values(f.form(), { confirmed: true })); f.ui.suspend(); f.setUser(user({ userId: 'other' }));
  await f.ui.resume(); assert.equal(f.ui.phase, 'unavailable'); assert(!f.host.innerHTML.includes('retry-existing')); f.ui.destroy();
});
test('suspending a pending new acceptance removes all DOM and late success cannot reopen or authenticate', async () => {
  const pending = gate(), f = fixture({ client: { accept: () => pending.promise } }), form = await newForm(f);
  const work = f.ui.submit(form); f.ui.suspend(); assert.equal(f.host.innerHTML, ''); pending.resolve(result()); await work;
  assert.equal(f.host.innerHTML, ''); assert.equal(f.authenticated.length, 0); await f.ui.resume(); assert.equal(f.ui.phase, 'unknown-new'); f.ui.destroy();
});
test('destroyed preview and login continuations cannot recreate secret or account UI', async () => {
  const pending = gate(), f = fixture({ client: { preview: () => pending.promise } });
  const work = f.ui.mount(token); await Promise.resolve(); f.ui.destroy(); pending.resolve(invitation()); await work;
  assert.equal(f.host.innerHTML, ''); assert.equal(f.ui.invitation, null); assert(f.host.listeners.every(v => v.signal.aborted));
});
test('repeated resume does not duplicate an in-flight request', async () => {
  const pending = gate(), f = fixture({ client: { preview: () => pending.promise } });
  const work = f.ui.mount(token); await Promise.resolve(); await f.ui.resume(); pending.resolve(invitation()); await work;
  assert.equal(f.calls.filter(c => c[0] === 'session').length, 1); f.ui.destroy();
});
test('recipient markup escapes untrusted display text and never offers fake recovery or account selection', () => {
  const html = invitationMarkup({ phase: 'existing', invitation: { ...invitation(), centerId: '<img>' }, user: user({ email: '<script>' }), error: '<error>' });
  for (const value of ['&lt;img&gt;', '&lt;script&gt;', '&lt;error&gt;']) assert(html.includes(value));
  for (const value of ['<img>', '<script>', 'name="accountId"', 'recovery-reset', 'data-token', 'name="token"']) assert(!html.includes(value));
});

function opsFixture(client = {}) {
  const host = hostDouble(), notices = [], denials = [], base = { expectedUserId: 'synthetic-manager' };
  const calls = [], api = { async list() { calls.push('list'); return [listed()]; }, async invite() { calls.push('invite'); return { message: INVITATION_REQUEST_NOTICE }; },
    async revoke() { calls.push('revoke'); return { revoked: true }; }, ...client };
  const ui = new OperationsInvitationsUi({ host, transport: base, client: api, userId: base.expectedUserId, centerId: 'synthetic-center',
    announce: value => notices.push(value), onDenied: value => denials.push(value) });
  return { host, base, ui, calls, notices, denials };
}
test('operations panel contains only invitation metadata, synthetic notice and separately confirmed revocation', async () => {
  const f = opsFixture(); await f.ui.mount(); assert.match(f.host.innerHTML, /구성원 초대/); assert.match(f.host.innerHTML, /아동|아이/);
  assert.match(f.host.innerHTML, /name="confirmed" required/); assert(!f.host.innerHTML.includes('name="token"')); f.ui.destroy();
});
test('operations successful invite announces only generic request and refreshes current list', async () => {
  const f = opsFixture(); await f.ui.mount(); f.ui.values = { email: 'p@example.test', role: 'guardian' }; await f.ui.invite();
  assert.deepEqual(f.calls, ['list', 'invite', 'list']); assert.equal(f.ui.values.email, ''); assert.deepEqual(f.notices, [INVITATION_REQUEST_NOTICE]); f.ui.destroy();
});
test('operations unknown request cannot issue again until explicit acknowledgement of a successful fresh list', async () => {
  let count = 0; const f = opsFixture({ invite: async () => { count++; throw new LocalApiError('UNAVAILABLE'); } });
  await f.ui.mount(); f.ui.values.email = 'p@example.test'; await f.ui.invite(); await f.ui.invite();
  assert.equal(count, 1); assert.equal(f.ui.uncertain, true); assert.equal(f.ui.checked, true); assert.match(f.host.innerHTML, /data-invites-action="acknowledge"/); f.ui.destroy();
});
test('operations definitive rejected invitation preserves editable input, not an unknown fixed retry', async () => {
  const f = opsFixture({ invite: async () => { throw new LocalApiError('INVITATION_EXISTS', 409); } });
  await f.ui.mount(); f.ui.values.email = 'p@example.test'; await f.ui.invite(); assert.equal(f.ui.uncertain, false); assert.equal(f.ui.values.email, 'p@example.test');
  assert.equal(f.ui.error, new LocalApiError('INVITATION_EXISTS', 409).message); await f.ui.refresh();
  assert.equal(f.ui.error, new LocalApiError('INVITATION_EXISTS', 409).message); f.ui.destroy();
});
test('suspend clears invitation metadata and resume cannot show old rows before fresh permission read', async () => {
  const pending = gate(), f = opsFixture(); await f.ui.mount(); f.ui.client.list = () => pending.promise;
  f.ui.suspend(); assert.deepEqual(f.ui.rows, []); assert.equal(f.host.innerHTML, '');
  const work = f.ui.resume(); assert(!f.host.innerHTML.includes('person@example.test'));
  pending.reject(new LocalApiError('FORBIDDEN', 403)); await work; assert.equal(f.host.innerHTML, ''); assert.equal(f.denials.length, 1);
});
test('operations transient list failure clears rows and cannot acknowledge an unverified list', async () => {
  const f = opsFixture(); await f.ui.mount(); f.ui.uncertain = true;
  f.ui.client.list = async () => { throw new LocalApiError('UNAVAILABLE'); }; await f.ui.refresh();
  assert.deepEqual(f.ui.rows, []); assert.equal(f.ui.checked, false); assert(!f.host.innerHTML.includes('person@example.test')); f.ui.destroy();
});
test('operations pending write reports ownership and hidden late result cannot restore content', async () => {
  const pending = gate(), f = opsFixture({ invite: () => pending.promise }); await f.ui.mount(); f.ui.values.email = 'p@example.test';
  const work = f.ui.invite(); assert(f.ui.hasPendingWrite()); f.ui.suspend(); assert.equal(f.ui.hasPendingWrite(), false); assert(f.ui.uncertain);
  pending.resolve({ message: INVITATION_REQUEST_NOTICE }); await work; assert.equal(f.host.innerHTML, ''); assert.equal(f.notices.length, 0); f.ui.destroy();
});
test('operations account replacement denies before any new request and clears local inputs', async () => {
  const f = opsFixture(); await f.ui.mount(); f.ui.values.email = 'p@example.test'; f.base.expectedUserId = 'other';
  await f.ui.refresh(); assert.deepEqual(f.calls, ['list']); assert.equal(f.host.innerHTML, ''); assert.equal(f.ui.values.email, ''); assert.equal(f.denials.length, 1);
});
test('operations unchanged periodic render preserves nodes and never restores a generic confirmed checkbox to the wrong invitation', async () => {
  const f = opsFixture(); await f.ui.mount(); const form = f.host.querySelector('[data-invitation-form="invite"]');
  await f.ui.refresh(); assert.equal(f.host.querySelector('[data-invitation-form="invite"]'), form);
  const confirmed = f.host.querySelector('[data-invitation-form="revoke"]').elements.namedItem('confirmed'); confirmed.focus();
  f.ui.client.list = async () => [listed({ status: 'expired' })]; await f.ui.refresh();
  assert.equal(f.host.ownerDocument.activeElement, confirmed); f.ui.destroy();
});
test('operations markup escapes addresses and gives no recipient link, token or clinical surface', () => {
  const html = operationsInvitationsMarkup({ rows: [listed({ email: '<script>' })], values: { email: '<input>', role: 'guardian' }, error: '<error>' });
  assert(html.includes('&lt;script&gt;')); assert(html.includes('&lt;input&gt;')); assert(html.includes('&lt;error&gt;'));
  for (const value of ['<script>', 'data-token', 'href=', 'data-open-room', 'data-record-id']) assert(!html.includes(value));
});

test('pending existing acceptance survives suspension only as a same-account frozen confirmation request', async () => {
  const pending = gate(), bodies = [], f = fixture({ signedIn: true, client: { acceptExisting: async input => {
    bodies.push(input); return bodies.length === 1 ? pending.promise : result(true);
  } } });
  await f.ui.mount(token); const work = f.ui.submit(values(f.form(), { confirmed: true }));
  f.ui.suspend(); pending.resolve(result(true)); await work; assert.equal(f.authenticated.length, 0);
  await f.ui.resume(); assert.equal(f.ui.phase, 'unknown-existing'); await f.ui.action('retry-existing');
  assert.equal(bodies[0], bodies[1]); assert.equal(f.authenticated.length, 1);
});
test('existing definitive authority rejection clears private retry state and refuses further writes', async () => {
  let writes = 0; const f = fixture({ signedIn: true, client: { acceptExisting: async () => { writes++; throw new LocalApiError('AUTH_REQUIRED', 401); } } });
  await f.ui.mount(token); await f.ui.submit(values(f.form(), { confirmed: true }));
  assert.equal(f.ui.phase, 'unavailable'); assert.equal(f.ui.user, null); await f.ui.action('retry-existing');
  assert.equal(writes, 1); f.ui.destroy();
});
test('existing logout failure never displays another login form or silently clears bound identity', async () => {
  const f = fixture({ signedIn: true, transport: { logout: async () => { throw new LocalApiError('UNAVAILABLE'); } } });
  await f.ui.mount(token); await f.ui.action('logout'); assert.equal(f.ui.phase, 'unavailable');
  assert.equal(f.base.expectedUserId, 'synthetic-user'); assert.equal(f.form(), null); f.ui.destroy();
});
test('raw transport failure is replaced by fixed public wording rather than displayed or remembered', async () => {
  const f = fixture({ client: { preview: async () => { throw new Error('PRIVATE-CAPABILITY-CONTENT'); } } });
  await f.ui.mount(token); assert.equal(f.ui.phase, 'unavailable'); assert(!f.host.innerHTML.includes('PRIVATE-')); assert(!JSON.stringify(f.ui).includes('PRIVATE-')); f.ui.destroy();
});
test('operations current list lookup never performs an automatic revoke replay after unknown', async () => {
  let writes = 0; const f = opsFixture({ revoke: async () => { writes++; throw new LocalApiError('UNAVAILABLE'); } });
  await f.ui.mount(); await f.ui.revoke(iid); await f.ui.revoke(iid); await f.ui.refresh();
  assert.equal(writes, 1); assert(f.ui.uncertain); assert(f.ui.checked); assert.equal(f.ui.hasPendingWrite(), false); f.ui.destroy();
});
test('operations destroyed pending lookup does not render rows or emit a later denial', async () => {
  const pending = gate(), f = opsFixture({ list: () => pending.promise }); const work = f.ui.mount();
  f.ui.destroy(); pending.resolve([listed()]); await work;
  assert.deepEqual(f.ui.rows, []); assert.equal(f.host.innerHTML, ''); assert.equal(f.denials.length, 0); assert(f.host.listeners.every(v => v.signal.aborted));
});
test('explicit invitation interrupts only an in-flight periodic read and its late rows cannot overwrite the fresh result', async () => {
  const pending = gate(), f = opsFixture(); await f.ui.mount();
  let reads = 0; f.ui.client.list = async () => ++reads === 1 ? pending.promise : [listed({ status: 'expired' })];
  const refreshing = f.ui.refresh(); f.ui.values.email = 'p@example.test';
  await f.ui.invite(); assert.equal(f.calls.filter(v => v === 'invite').length, 1);
  pending.resolve([listed()]); await refreshing; assert.equal(f.ui.rows[0].status, 'expired'); assert.equal(f.ui.loading, false); f.ui.destroy();
});

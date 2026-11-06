// Controller/form-identity doubles only; no browser, mail, API or DB claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalApiError } from '../local-api/client.js';
import { RecoveryUi, recoveryMarkup } from '../local-api/recovery-ui.js';
import { RECOVERY_REQUEST_NOTICE } from '../local-api/recovery-client.js';

const token = `cr1.${'s'.repeat(43)}`, password = 'Synthetic-password-2';
const deferred = () => Promise.withResolvers();
function hostDouble() {
  let html = '', form = null, fields = [];
  const listeners = [], host = { listeners, focusCount: 0,
    addEventListener(type, fn, options) { listeners.push({ type, fn, signal: options.signal }); },
    contains(node) { return node === form || fields.includes(node); },
    querySelectorAll() { return fields.filter(f => ['newPassword', 'confirmation'].includes(f.name)); },
    querySelector(selector) { return selector === 'h1' ? { focus() { host.focusCount++; } } : selector === '[data-recovery-form]' ? form : null; },
    replaceChildren() { this.innerHTML = ''; },
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value; fields = []; form = null;
      const kind = /data-recovery-form="([^"]+)"/.exec(value)?.[1]; if (!kind) return;
      for (const found of value.matchAll(/<input\b([^>]*)>/g)) {
        fields.push({ name: /name="([^"]+)"/.exec(found[1])?.[1], type: /type="([^"]+)"/.exec(found[1])?.[1], value: '' });
      }
      const controls = fields;
      form = { dataset: { recoveryForm: kind }, elements: { namedItem: name => controls.find(f => f.name === name) },
        reportValidity: () => true, matches: selector => selector === '[data-recovery-form]' };
    },
  };
  return host;
}
function fixture({ mode = 'complete', signedIn = false, client = {}, transport = {} } = {}) {
  const calls = [], host = hostDouble(), exits = [];
  let user = signedIn ? { userId: 'synthetic-user', email: 'sensitive@example.test', centers: [{ id: 'center-private', role: 'guardian' }] } : null;
  const base = { expectedUserId: user?.userId ?? null, clearIdentity() { this.expectedUserId = null; },
    async session(signal) { calls.push(['session', signal]); if (!user) throw new LocalApiError('AUTH_REQUIRED', 401); this.expectedUserId = user.userId; return user; },
    async logout(signal) { calls.push(['logout', this.expectedUserId, signal]); user = null; }, ...transport };
  const api = { async request(email, signal) { calls.push(['request', email, signal]); return { message: RECOVERY_REQUEST_NOTICE }; },
    async complete(body, signal) { calls.push(['complete', body, signal]); return { passwordChanged: true, reauthenticate: true }; }, ...client };
  const ui = new RecoveryUi({ host, transport: base, client: api, mode, onExit: () => exits.push(true) });
  return { ui, host, calls, exits, base, api, setUser(value) { user = value; }, form: () => host.querySelector('[data-recovery-form]'),
    mount: () => ui.mount(mode === 'complete' ? token : null) };
}
function values(f, data = { newPassword: password, confirmation: password }) {
  const form = f.form(); assert(form);
  for (const [name, value] of Object.entries(data)) { const field = form.elements.namedItem(name); assert(field); field.value = value; }
  return form;
}

test('anonymous completion checks session only; no preview or capability/account data in DOM or public state', async () => {
  const f = fixture(); await f.mount(); assert.equal(f.ui.phase, 'complete'); assert.deepEqual(f.calls.map(c => c[0]), ['session']);
  assert(!f.host.innerHTML.includes(token)); assert(!JSON.stringify(f.ui).includes(token)); assert(!f.host.innerHTML.includes('sensitive@example.test')); f.ui.destroy();
});
test('request landing uses only synthetic address form and the generic outcome', async () => {
  const f = fixture({ mode: 'request' }); await f.mount(); await f.ui.submit(values(f, { email: 'person@example.test' }));
  assert.equal(f.ui.phase, 'requested'); assert.match(f.host.innerHTML, /안내가 가능한 경우/); assert(!f.form());
  assert.equal(f.calls.filter(c => c[0] === 'request').length, 1); f.ui.destroy();
});
test('live session blocks both forms without account details; logout is explicit and account-bound', async () => {
  for (const mode of ['request', 'complete']) {
    const f = fixture({ mode, signedIn: true }); await f.mount(); assert.equal(f.ui.phase, 'session'); assert(!f.form());
    assert(!/sensitive@example|center-private|guardian/.test(f.host.innerHTML)); assert(!('user' in f.ui));
    assert.equal(f.calls.filter(c => c[0] === 'logout').length, 0);
    await f.ui.action('logout'); assert.equal(f.calls.find(c => c[0] === 'logout')[1], 'synthetic-user'); assert.equal(f.ui.phase, mode); f.ui.destroy();
  }
});
test('only exact 401 AUTH_REQUIRED permits anonymous input', async () => {
  for (const error of [new LocalApiError('UNAVAILABLE', 503), new LocalApiError('AUTH_REQUIRED'), new LocalApiError('AUTH_INVALID', 401), new Error('private')]) {
    const f = fixture({ transport: { async session() { throw error; } } }); await f.mount(); assert.equal(f.ui.phase, 'unavailable'); assert(!f.form()); assert(!f.host.innerHTML.includes('private')); f.ui.destroy();
  }
});
test('session recheck reads a changed cookie afresh rather than treating an old account fence as signed out', async () => {
  const f = fixture({ signedIn: true }); await f.mount(); f.ui.suspend(); f.setUser({ userId: 'different', email: 'other@example.test' });
  await f.ui.resume(); assert.equal(f.ui.phase, 'session'); assert.equal(f.base.expectedUserId, 'different'); assert(!f.host.innerHTML.includes('other@example.test')); f.ui.destroy();
});
test('logout unknown does not open a form or repeat logout; explicit fresh session read is required', async () => {
  let attempts = 0; const f = fixture({ signedIn: true, transport: { async logout() { attempts++; throw new LocalApiError('UNAVAILABLE'); } } });
  await f.mount(); await f.ui.action('logout'); assert.equal(f.ui.phase, 'unavailable'); assert(!f.form());
  await f.ui.action('logout'); assert.equal(attempts, 1); await f.ui.action('session'); assert.equal(f.ui.phase, 'session'); f.ui.destroy();
});
test('successful logout followed by another live cookie remains blocked without another logout', async () => {
  const f = fixture({ signedIn: true, transport: { async logout() { f.setUser({ userId: 'changed-account' }); } } });
  await f.mount(); await f.ui.action('logout'); assert.equal(f.ui.phase, 'session'); assert.equal(f.base.expectedUserId, 'changed-account'); f.ui.destroy();
});
test('complete clears password controls before awaiting and never adopts or automatically logs in', async () => {
  const gate = deferred(), f = fixture({ client: { complete: () => gate.promise } }); await f.mount();
  const form = values(f), fields = [form.elements.namedItem('newPassword'), form.elements.namedItem('confirmation')]; fields[0].type = 'text';
  const work = f.ui.submit(form); assert(fields.every(n => n.value === '')); assert.equal(f.ui.phase, 'completing');
  assert(!f.host.innerHTML.includes(password)); assert(!JSON.stringify(f.ui).includes(password));
  gate.resolve({ passwordChanged: true, reauthenticate: true }); await work;
  assert.equal(f.ui.phase, 'completed'); assert.equal(f.base.expectedUserId, null); assert.equal(f.exits.length, 0);
  assert.equal(f.calls.filter(c => c[0] === 'session').length, 1); assert(!f.form()); f.ui.destroy();
});
test('duplicate submit, detached form and invented retry action cannot duplicate completion', async () => {
  const gate = deferred(); let attempts = 0; const f = fixture({ client: { complete: () => { attempts++; return gate.promise; } } }); await f.mount();
  const form = values(f), work = f.ui.submit(form); await f.ui.submit(form); await f.ui.action('retry'); assert.equal(attempts, 1);
  gate.resolve({ passwordChanged: true, reauthenticate: true }); await work; await f.ui.submit(form); assert.equal(attempts, 1); f.ui.destroy();
});
test('definite invalid input/confirmation/unchanged errors allow blank re-entry with the same idle token', async () => {
  for (const name of ['INVALID_INPUT', 'PASSWORD_CONFIRMATION_MISMATCH', 'PASSWORD_UNCHANGED']) {
    let tries = 0; const bodies = [], f = fixture({ client: { complete: async body => { bodies.push(body); if (++tries === 1) throw new LocalApiError(name, 400); return { passwordChanged: true, reauthenticate: true }; } } });
    await f.mount(); await f.ui.submit(values(f)); assert.equal(f.ui.phase, 'complete'); assert.equal(f.form().elements.namedItem('newPassword').value, '');
    await f.ui.submit(values(f)); assert.equal(f.ui.phase, 'completed'); assert.equal(bodies[1].token, token); f.ui.destroy();
  }
});
test('status zero local validation permits safe re-entry but the same code with 503 is unknown', async () => {
  for (const [status, expected] of [[0, 'complete'], [503, 'unknown-complete']]) {
    const f = fixture({ client: { complete: async () => { throw new LocalApiError('INVALID_INPUT', status); } } }); await f.mount(); await f.ui.submit(values(f)); assert.equal(f.ui.phase, expected); f.ui.destroy();
  }
});
test('completion unknown destroys capability and offers only normal login; no resume or action can replay', async () => {
  let attempts = 0; const f = fixture({ client: { complete: async () => { attempts++; throw new LocalApiError('UNAVAILABLE', 503); } } });
  await f.mount(); const old = values(f); await f.ui.submit(old); assert.equal(f.ui.phase, 'unknown-complete');
  assert(!f.form()); assert.match(f.host.innerHTML, /설정한 새 비밀번호로 일반 로그인/); assert(!f.host.innerHTML.includes(token));
  f.ui.suspend(); await f.ui.resume(); await f.ui.action('session'); await f.ui.action('retry'); await f.ui.submit(old);
  assert.equal(attempts, 1); assert.equal(f.ui.phase, 'unknown-complete'); assert(!f.form()); f.ui.destroy();
});
test('request unknown never claims mail success or retries across visibility changes', async () => {
  let attempts = 0; const f = fixture({ mode: 'request', client: { request: async () => { attempts++; throw new Error('private email'); } } });
  await f.mount(); const form = values(f, { email: 'private@example.test' }); await f.ui.submit(form); assert.equal(f.ui.phase, 'unknown-request');
  assert(!f.host.innerHTML.includes('private')); f.ui.suspend(); await f.ui.resume(); await f.ui.submit(form); assert.equal(attempts, 1); assert(!f.form()); f.ui.destroy();
});
test('invalid link 410 is terminal and does not reveal reason or original token', async () => {
  const f = fixture({ client: { complete: async () => { throw new LocalApiError('PASSWORD_RECOVERY_INVALID', 410); } } });
  await f.mount(); await f.ui.submit(values(f)); assert.equal(f.ui.phase, 'invalid'); assert(!f.form()); assert.match(f.host.innerHTML, /새 재설정 안내 요청/);
  f.ui.suspend(); await f.ui.resume(); assert.equal(f.ui.phase, 'invalid'); f.ui.destroy();
});
test('late live-session 409 rechecks current account then requires explicit logout without retaining passwords', async () => {
  let tries = 0; const f = fixture({ client: { complete: async () => { tries++; f.setUser({ userId: 'late-account' }); throw new LocalApiError('ACCOUNT_SESSION_PRESENT', 409); } } });
  await f.mount(); await f.ui.submit(values(f)); assert.equal(f.ui.phase, 'session'); assert.equal(f.base.expectedUserId, 'late-account');
  assert.equal(tries, 1); await f.ui.action('logout'); assert.equal(f.ui.phase, 'complete'); assert.equal(f.form().elements.namedItem('newPassword').value, ''); f.ui.destroy();
});
test('failed session recheck after no-write 409 remains closed until explicit verification', async () => {
  const f = fixture({ client: { complete: async () => { f.base.session = async () => { throw new LocalApiError('UNAVAILABLE'); }; throw new LocalApiError('ACCOUNT_SESSION_PRESENT', 409); } } });
  await f.mount(); await f.ui.submit(values(f)); assert.equal(f.ui.phase, 'unavailable'); assert(!f.form()); f.ui.destroy();
});
test('suspending an idle form wipes passwords but permits token-only resume after fresh session check', async () => {
  const f = fixture(); await f.mount(); const form = values(f); f.ui.suspend(); assert.equal(form.elements.namedItem('newPassword').value, ''); assert.equal(f.host.innerHTML, '');
  await f.ui.resume(); assert.equal(f.ui.phase, 'complete'); assert.equal(f.form().elements.namedItem('newPassword').value, '');
  await f.ui.submit(values(f)); assert.equal(f.calls.find(c => c[0] === 'complete')[1].token, token); f.ui.destroy();
});
test('suspend during pending completion is permanently unknown even if late success or definite rejection arrives', async () => {
  for (const failure of [false, true]) {
    const gate = deferred(), f = fixture({ client: { complete: () => gate.promise } }); await f.mount(); const work = f.ui.submit(values(f));
    f.ui.suspend(); assert.equal(f.host.innerHTML, ''); if (failure) gate.reject(new LocalApiError('PASSWORD_UNCHANGED', 400)); else gate.resolve({ passwordChanged: true, reauthenticate: true });
    await work; assert.equal(f.host.innerHTML, ''); await f.ui.resume(); assert.equal(f.ui.phase, 'unknown-complete'); assert(!f.form()); f.ui.destroy();
  }
});
test('suspend during request preserves unknown rather than resending address', async () => {
  const gate = deferred(), f = fixture({ mode: 'request', client: { request: () => gate.promise } }); await f.mount();
  const work = f.ui.submit(values(f, { email: 'a@example.test' })); f.ui.suspend(); gate.resolve({ message: RECOVERY_REQUEST_NOTICE }); await work;
  await f.ui.resume(); assert.equal(f.ui.phase, 'unknown-request'); assert(!f.form()); f.ui.destroy();
});
test('destroy fences pending session, wipes fields/listeners and cannot remount', async () => {
  const gate = deferred(), f = fixture({ transport: { session: () => gate.promise } }), work = f.mount(); f.ui.destroy();
  gate.reject(new LocalApiError('AUTH_REQUIRED', 401)); await work; await f.mount(); await f.ui.resume();
  assert.equal(f.host.innerHTML, ''); assert(f.host.listeners.every(l => l.signal.aborted));
});
test('repeated resume during session or mutation never starts duplicate asynchronous work', async () => {
  const gate = deferred(); let reads = 0; const f = fixture({ transport: { session: () => { reads++; return gate.promise; } } });
  const work = f.mount(); await f.ui.resume(); gate.reject(new LocalApiError('AUTH_REQUIRED', 401)); await work; assert.equal(reads, 1); f.ui.destroy();
});
test('explicit exit while pending wipes immediately and late completion cannot navigate again', async () => {
  const gate = deferred(), f = fixture({ client: { complete: () => gate.promise } }); await f.mount(); const work = f.ui.submit(values(f));
  await f.ui.action('exit'); assert.equal(f.host.innerHTML, ''); assert.equal(f.exits.length, 1); gate.resolve({ passwordChanged: true, reauthenticate: true }); await work;
  assert.equal(f.host.innerHTML, ''); assert.equal(f.exits.length, 1); assert(f.host.listeners.every(l => l.signal.aborted));
});
test('invalid mount is handled without session/network and cannot acquire a token from a later mount', async () => {
  const f = fixture(); await f.ui.mount('invalid'); await f.ui.mount(token); assert.equal(f.ui.phase, 'invalid'); assert.equal(f.calls.length, 0); f.ui.destroy();
});
test('markup labels, limits, fixed links, escaping and status semantics contain no token fields', () => {
  const html = recoveryMarkup({ phase: 'complete', error: '<img src=x onerror=private>' });
  assert.match(html, /class="login invitation-card"/);
  assert.match(html, /새 비밀번호 확인/); assert.match(html, /minlength="12" maxlength="128"/); assert.match(html, /autocomplete="off"/);
  assert(!html.includes('<img')); assert.match(html, /role="alert"/); assert(!html.includes('name="token"'));
  assert.match(recoveryMarkup({ phase: 'request' }), /maxlength="254"/);
});

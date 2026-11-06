import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalApiClient, LocalApiError } from '../local-api/client.js';
import { EmailLoginClient, EMAIL_LOGIN_NOTICE, emailLoginRequest } from '../local-api/email-login-client.js';
import { EmailLoginUi, emailLoginMarkup } from '../local-api/email-login-ui.js';

const email = 'guardian@email.test', code = '12345678', identity = { userId: 'guardian', email, centers: [], expiresAt: '2030-01-01T00:00:00Z' };
function hostDouble() {
  let html = '', form = null, fields = [];
  return { addEventListener() {}, contains: () => true,
    querySelectorAll: () => fields.filter(f => f.name === 'code'),
    querySelector: selector => selector === 'h1' ? { focus() {} } : selector === '[data-email-form]' ? form : null,
    replaceChildren() { this.innerHTML = ''; }, get innerHTML() { return html; },
    set innerHTML(value) {
      html = value; fields = []; form = null; const kind = /data-email-form="([^"]+)"/.exec(value)?.[1]; if (!kind) return;
      for (const found of value.matchAll(/<input\b([^>]*)>/g)) fields.push({ name: /name="([^"]+)"/.exec(found[1])?.[1], value: '' });
      const controls = fields; form = { dataset: { emailForm: kind }, reportValidity: () => true, elements: { namedItem: name => controls.find(f => f.name === name) } };
    },
  };
}
function fixture(client = {}) {
  const host = hostDouble(), calls = [], adopted = []; let time = 100000, backs = 0;
  const transport = { expectedUserId: null, clearIdentity() { this.expectedUserId = null; }, async session() { return identity; } };
  const ui = new EmailLoginUi({ host, transport, client: {
    async request(body) { calls.push(['request', body]); return { message: EMAIL_LOGIN_NOTICE }; },
    async verify(body) { calls.push(['verify', body]); return identity; }, ...client,
  }, now: () => time, onAuthenticated: user => { adopted.push(user); ui.destroy(); }, onBack: () => { backs++; } });
  ui.mount();
  const form = (name, value) => { const result = host.querySelector('[data-email-form]'); assert(result); result.elements.namedItem(name).value = value; return result; };
  return { ui, host, calls, adopted, transport, form, advance: n => { time += n; }, get backs() { return backs; } };
}
test('client normalizes .test input and sends only bootstrap/request/code, no identity claims', async () => {
  const calls = [], transport = { expectedUserId: null,
    async request(path, options) { calls.push([path, options.body]); return path.endsWith('/start') ? { ready: true } : { message: EMAIL_LOGIN_NOTICE }; },
    async emailLoginVerify(body) { calls.push(['verify', body]); return identity; } };
  const client = new EmailLoginClient(transport), body = emailLoginRequest(' GUARDIAN@EMAIL.TEST ');
  await client.request(body); await client.verify({ clientId: body.clientId, code, role: 'center' });
  assert.equal(calls[1][1].email, email); assert.deepEqual(Object.keys(calls[1][1]), ['email', 'clientId']); assert.deepEqual(Object.keys(calls[2][1]), ['clientId', 'code']);
  assert.throws(() => emailLoginRequest('real@example.com'), error => error.code === 'INVALID_INPUT');
  transport.expectedUserId = 'other'; await assert.rejects(client.request(body), error => error.code === 'ACCOUNT_SESSION_PRESENT');
});
test('cookie client adopts only server identity and preserves generic email invalid error', async () => {
  const calls = [], api = new LocalApiClient({ fetch: async (path, options) => {
    calls.push([path, options]); return new Response(JSON.stringify({ user: identity }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  assert.deepEqual(await api.emailLoginVerify({ clientId: 'fixture', code }), identity); assert.equal(api.expectedUserId, 'guardian');
  assert.equal(calls[0][1].headers['X-Carebridge-Account'], undefined);
  const invalid = new LocalApiClient({ fetch: async () => new Response(JSON.stringify({ error: 'EMAIL_LOGIN_INVALID', message: 'private' }), { status: 401, headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(invalid.emailLoginVerify({ clientId: 'fixture', code }), error => error.code === 'EMAIL_LOGIN_INVALID' && error.status === 401 && !error.message.includes('private'));
});
test('pending role is passed unchanged; code DOM and controller serialization are cleared', async () => {
  const f = fixture(); await f.ui.submit(f.form('email', email)); assert.equal(f.ui.phase, 'code');
  const form = f.form('code', code), input = form.elements.namedItem('code'); await f.ui.submit(form);
  assert.equal(input.value, ''); assert.deepEqual(f.adopted, [identity]); assert(!JSON.stringify(f.ui).includes(code)); assert(!f.host.innerHTML.includes(code));
});
test('unknown request retry preserves same immutable email/id, including hidden/resume', async () => {
  const bodies = []; let n = 0; const f = fixture({ async request(body) { bodies.push(body); if (++n === 1) throw new LocalApiError('UNAVAILABLE', 503); } });
  await f.ui.submit(f.form('email', email)); assert.equal(f.ui.phase, 'unknown-request');
  f.ui.suspend(); f.ui.resume(); await f.ui.action('retry'); assert.equal(f.ui.phase, 'code'); assert.strictEqual(bodies[0], bodies[1]); f.ui.destroy();
});
test('unknown verification allows only exact replay; never new issuance or back navigation', async () => {
  const bodies = []; let n = 0; const f = fixture({ async verify(body) { bodies.push(body); if (++n === 1) throw new LocalApiError('UNAVAILABLE'); return identity; } });
  await f.ui.submit(f.form('email', email)); await f.ui.submit(f.form('code', code)); assert.equal(f.ui.phase, 'unknown-verify');
  assert(!f.host.innerHTML.includes(code)); assert(!JSON.stringify(f.ui).includes(code));
  await f.ui.action('back'); await f.ui.action('resend'); assert.equal(f.backs, 0); assert.equal(f.calls.filter(c => c[0] === 'request').length, 1);
  await f.ui.action('retry'); assert.strictEqual(bodies[0], bodies[1]); assert.deepEqual(f.adopted, [identity]);
});
test('wrong or expired code allows blank code entry, never assigns a role', async () => {
  const f = fixture({ async verify() { throw new LocalApiError('EMAIL_LOGIN_INVALID', 401); } });
  await f.ui.submit(f.form('email', email)); await f.ui.submit(f.form('code', code)); assert.equal(f.ui.phase, 'code');
  assert.equal(f.form('code', '').elements.namedItem('code').value, ''); assert.equal(f.adopted.length, 0); f.ui.destroy();
});
test('a misleading invalid-input code on server failure stays an unknown verification', async () => {
  const f = fixture({ async verify() { throw new LocalApiError('INVALID_INPUT', 503); } });
  await f.ui.submit(f.form('email', email)); await f.ui.submit(f.form('code', code)); assert.equal(f.ui.phase, 'unknown-verify'); f.ui.destroy();
});
test('resend requires 60 seconds and a fresh id, server remains final limiter', async () => {
  const f = fixture(); await f.ui.submit(f.form('email', email)); await f.ui.action('resend'); assert.equal(f.calls.length, 1);
  f.advance(60000); await f.ui.action('resend'); assert.equal(f.calls.length, 2); assert.notEqual(f.calls[0][1].clientId, f.calls[1][1].clientId); f.ui.destroy();
});
test('duplicate submissions and detached forms cannot create duplicate requests', async () => {
  const gate = Promise.withResolvers(); let calls = 0; const f = fixture({ async request() { calls++; return gate.promise; } });
  const form = f.form('email', email), task = f.ui.submit(form); await f.ui.submit(form); assert.equal(calls, 1);
  gate.resolve(); await task; await f.ui.submit(form); assert.equal(calls, 1); f.ui.destroy();
});
test('late success after destroy never renders or adopts a session', async () => {
  const gate = Promise.withResolvers(), f = fixture({ verify: () => gate.promise });
  await f.ui.submit(f.form('email', email)); const task = f.ui.submit(f.form('code', code)); f.ui.destroy(); gate.resolve(identity); await task;
  assert.equal(f.adopted.length, 0); assert.equal(f.host.innerHTML, '');
});
test('hidden verification is unknown and resumes without automatic request', async () => {
  const gate = Promise.withResolvers(), f = fixture({ verify: () => gate.promise });
  await f.ui.submit(f.form('email', email)); const task = f.ui.submit(f.form('code', code)); f.ui.suspend(); assert.equal(f.ui.phase, 'unknown-verify');
  gate.resolve(identity); await task; f.ui.resume(); assert.equal(f.adopted.length, 0); assert.match(f.host.innerHTML, /같은 로그인 다시 확인/); f.ui.destroy();
});
test('existing session is explicitly checked, not logged out or overwritten', async () => {
  const f = fixture({ async request() { throw new LocalApiError('ACCOUNT_SESSION_PRESENT', 409); } });
  await f.ui.submit(f.form('email', email)); assert.equal(f.ui.phase, 'session'); await f.ui.action('session'); assert.deepEqual(f.adopted, [identity]);
});
test('markup escapes echoed email and never exposes a role selector', () => {
  const html = emailLoginMarkup({ phase: 'code', email: '<script>fixture</script>' });
  assert(!html.includes('<script>')); assert(!html.includes('<select')); assert.match(html, /inputmode="numeric"/); assert.match(html, /one-time-code/);
});

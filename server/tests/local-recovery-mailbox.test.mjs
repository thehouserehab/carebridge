import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { LocalRecoveryMailbox } from '../local-recovery-mailbox.mjs';
const email = 'synthetic@carebridge.test', origin = 'http://127.0.0.1:4180', token = `cr1.${'a'.repeat(43)}`;
const envelope = (overrides = {}) => ({ purpose: 'password-recovery', to: email,
  link: `https://carebridge.test/account/password-recovery#token=${token}`, ...overrides });
test('recovery capability is private, purpose-separated and consumed once by its intended synthetic recipient', async () => {
  const box = new LocalRecoveryMailbox(); assert.deepEqual(await box.send(envelope()), { status: 'accepted' });
  assert.equal(JSON.stringify(box), '{}'); assert.deepEqual(Object.keys(box), []); assert.equal(inspect(box).includes(token), false);
  assert.equal(box.take('other@carebridge.test', origin), null);
  assert.equal(box.take(email, origin), `${origin}/account/password-recovery#token=${token}`);
  assert.equal(box.take(email, origin), null); box.close();
});
test('recovery mailbox rejects real addresses, wrong purposes and any nonfixed bearer link', async () => {
  const box = new LocalRecoveryMailbox();
  for (const overrides of [{ to: 'real@example.com' }, { to: ` ${email}` }, { to: `${email}\r\nX:a@b.test` },
    { purpose: 'invitation' }, { link: `https://other.test/account/password-recovery#token=${token}` },
    { link: `https://carebridge.test/account/password-recovery?token=${token}` },
    { link: `https://carebridge.test/account/password-recovery#token=${token}&next=/` },
    { link: 'https://carebridge.test/account/password-recovery#token=' + 'a'.repeat(43) }])
    await assert.rejects(box.send(envelope(overrides)), { message: 'Synthetic recovery delivery unavailable.' });
  assert.equal(box.take(email, origin), null); box.close();
});
test('recovery remap allows only an exact unprivileged IPv4 loopback origin', async () => {
  const box = new LocalRecoveryMailbox(); await box.send(envelope());
  for (const value of ['http://localhost:4180', 'http://127.0.0.1:80', `${origin}/`, `${origin}?q=1`,
    'http://user@127.0.0.1:4180', 'https://carebridge.test', 'http://0.0.0.0:4180']) assert.throws(() => box.take(email, value));
  assert.ok(box.take(email, origin)); box.close();
});
test('recovery mailbox is bounded at thirty-two without silently evicting older capabilities', async () => {
  const box = new LocalRecoveryMailbox();
  for (let i = 0; i < 32; i++) await box.send(envelope({ to: `person${i}@carebridge.test` }));
  await assert.rejects(box.send(envelope())); assert.ok(box.take('person0@carebridge.test', origin));
  await box.send(envelope()); assert.ok(box.take(email, origin)); box.close();
});
test('fifteen-minute mailbox expiry is not a claim to revoke the authoritative reset token', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 });
  const box = new LocalRecoveryMailbox(); await box.send(envelope()); t.mock.timers.tick(15 * 60 * 1000);
  assert.equal(box.take(email, origin), null); box.close();
});
test('abort and close cannot deliver or reopen the private mailbox', async () => {
  const box = new LocalRecoveryMailbox(); await assert.rejects(box.send(envelope(), { signal: AbortSignal.abort() }));
  assert.equal(box.take(email, origin), null); await box.send(envelope()); box.close(); box.close();
  await assert.rejects(box.send(envelope())); assert.throws(() => box.take(email, origin));
});

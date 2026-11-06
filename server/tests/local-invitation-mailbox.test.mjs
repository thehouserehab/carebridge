import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalInvitationMailbox } from '../local-invitation-mailbox.mjs';

const email = 'recipient@carebridge.test', origin = 'http://127.0.0.1:4180';
const token = 'a'.repeat(43);
const message = (overrides = {}) => ({ purpose: 'invitation', to: email,
  link: `https://carebridge.test/account/invitation#token=${token}`, ...overrides });

test('mailbox exposes no serialized recipient or secret and delivers once to exact recipient', async () => {
  const box = new LocalInvitationMailbox();
  assert.deepEqual(await box.send(message()), { status: 'accepted' });
  assert.equal(JSON.stringify(box), '{}'); assert.deepEqual(Object.keys(box), []);
  assert.equal(box.take('other@carebridge.test', origin), null);
  assert.equal(box.take(email, origin), `${origin}/account/invitation#token=${token}`);
  assert.equal(box.take(email, origin), null); box.close();
});
test('mailbox rejects real addresses, foreign origins, wrong purposes and query/header injection', async () => {
  const box = new LocalInvitationMailbox();
  for (const overrides of [{ to: 'person@example.com' }, { to: 'x@carebridge.test\r\nBcc:x@test.test' },
    { to: ' person@carebridge.test' }, { purpose: 'password-recovery' },
    { link: `https://example.com/account/invitation#token=${token}` },
    { link: `https://carebridge.test/account/invitation?token=${token}` },
    { link: `https://carebridge.test/account/invitation#token=${token}&next=/` }]) {
    await assert.rejects(box.send(message(overrides)), { message: 'Synthetic invitation delivery unavailable.' });
  }
  assert.equal(box.take(email, origin), null); box.close();
});
test('mailbox remap permits only exact nonprivileged loopback origin', async () => {
  const box = new LocalInvitationMailbox(); await box.send(message());
  for (const target of ['https://example.com', 'http://localhost:4180', 'http://127.0.0.1:80',
    `${origin}/`, `${origin}?x=1`, 'http://user@127.0.0.1:4180', 'http://0.0.0.0:4180'])
    assert.throws(() => box.take(email, target), { message: 'Synthetic invitation delivery unavailable.' });
  assert.ok(box.take(email, origin)); box.close();
});
test('mailbox bounded queue fails closed instead of silently dropping an older recipient', async () => {
  const box = new LocalInvitationMailbox();
  for (let index = 0; index < 32; index++) await box.send(message({ to: `person${index}@carebridge.test` }));
  await assert.rejects(box.send(message()));
  assert.ok(box.take('person0@carebridge.test', origin));
  await box.send(message()); assert.ok(box.take(email, origin)); box.close();
});
test('mailbox expiry removes delivery capabilities without claiming to revoke domain invitations', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10_000 });
  const box = new LocalInvitationMailbox(); await box.send(message());
  t.mock.timers.tick(15 * 60 * 1000);
  assert.equal(box.take(email, origin), null); box.close();
});
test('mailbox close and aborted delivery discard capabilities and cannot reopen', async () => {
  const box = new LocalInvitationMailbox();
  await assert.rejects(box.send(message(), { signal: AbortSignal.abort() }));
  assert.equal(box.take(email, origin), null);
  await box.send(message()); box.close(); box.close();
  await assert.rejects(box.send(message())); assert.throws(() => box.take(email, origin));
});

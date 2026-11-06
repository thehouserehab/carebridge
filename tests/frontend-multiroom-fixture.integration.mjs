// DB integration: npm run test:fixtures:local (server development dependencies required).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access } from 'node:fs/promises';
import { request } from 'node:http';
import { createFrontendMultiroomFixture } from './frontend-multiroom-fixture.mjs';
import { Goals, Appointments } from '../server/care-contexts.mjs';
import { Conversations } from '../server/conversations.mjs';
import { Children } from '../server/profiles.mjs';
import { childProfileFields, memberDisplayName } from '../src/profile-fields.js';

function localGet(origin) {
  const target = new URL(origin);
  assert.equal(target.protocol, 'http:'); assert.equal(target.hostname, '127.0.0.1');
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: target.port, path: '/', agent: false }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode)); res.once('error', reject);
    });
    req.once('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('Synthetic fixture local request timed out.')));
    req.end();
  });
}

test('fixture forwards the existing strict port-only options without evaluating accessors', async () => {
  let getterCalls = 0;
  for (const input of [null, [], new Date(), { host: '0.0.0.0' }, { database: {} }, { path: 'unused-synthetic' },
    { port: undefined }, { port: '0' }, { port: 443 }, { port: 65536 }, { port: 0, worker: true },
    { [Symbol('unsupported')]: 0 }, Object.create({ port: 0 }),
    Object.defineProperty({}, 'port', { get() { getterCalls++; return 0; } }),
  ]) await assert.rejects(createFrontendMultiroomFixture(input), TypeError);
  assert.equal(getterCalls, 0);
});

test('two-room synthetic fixture has coherent readable profiles, care contexts and long separate message histories', async (t) => {
  const fixture = await createFrontendMultiroomFixture();
  const { sandbox, rooms } = fixture;
  t.after(() => sandbox.close());
  assert(Object.isFrozen(fixture)); assert(Object.isFrozen(sandbox)); assert(Object.isFrozen(rooms));
  assert.equal(rooms.length, 2); assert(rooms.every(Object.isFrozen));
  assert.match(sandbox.origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
  assert.equal(await localGet(sandbox.origin), 200);
  assert.deepEqual(Object.keys(sandbox).sort(), ['close', 'ids', 'origin']);
  assert.equal(Object.getOwnPropertyDescriptor(sandbox, 'credentials').enumerable, false);
  assert.equal(Object.getOwnPropertyDescriptor(sandbox, 'database').enumerable, false);
  assert.equal(sandbox.credentials.length, 3);
  const serialized = JSON.stringify(fixture);
  assert(!serialized.includes('@carebridge.test'));
  assert(!serialized.includes('password'));
  for (const credential of sandbox.credentials) assert(!serialized.includes(credential.password));
  assert.equal(rooms[0].conversationId, sandbox.ids.conversationId);
  assert.equal(rooms[0].childId, sandbox.ids.childId);
  assert.notEqual(rooms[1].conversationId, rooms[0].conversationId);
  const conversations = new Conversations(sandbox.database), profiles = new Children(sandbox.database);
  const goals = new Goals(sandbox.database), appointments = new Appointments(sandbox.database);
  const observedIds = new Set();
  for (const role of ['therapist', 'guardian']) {
    const actor = { centerId: sandbox.ids.centerId, userId: sandbox.ids[`${role}Id`] };
    const inbox = await conversations.inbox(actor);
    assert.deepEqual(inbox.rooms.map(room => room.conversationId).sort(), rooms.map(room => room.conversationId).sort());
    assert(inbox.rooms.every(room => room.unread >= 22));
    for (const [index, room] of rooms.entries()) {
      const profile = await profiles.get(actor, { conversationId: room.conversationId });
      assert.equal(profile.name, room.name); assert(room.name.length >= 20 && room.name.length <= 30);
      assert.deepEqual(childProfileFields({ name: profile.name, age: profile.age, ageAsOf: profile.ageAsOf }),
        { name: room.name, age: null, ageAsOf: null });
      assert.deepEqual(profile.participants.map(member => member.userId).sort(), [sandbox.ids.therapistId, sandbox.ids.guardianId].sort());
      for (const member of profile.participants) assert.equal(memberDisplayName(member.displayName), member.displayName);
      const goal = await goals.get(actor, { conversationId: room.conversationId, goalId: room.goalId });
      const appointment = await appointments.get(actor, { conversationId: room.conversationId, appointmentId: room.appointmentId });
      assert.equal(goal.status, 'active'); assert(goal.title.includes(index === 0 ? '첫째' : '둘째'));
      assert.equal(appointment.status, 'scheduled'); assert.equal(appointment.time, index === 0 ? '14:00' : '15:00');
      assert.equal(appointment.childId, room.childId);
      const history = await conversations.list(actor, { conversationId: room.conversationId, limit: 100 });
      assert.equal(history.hasMore, false); assert.equal(history.messages.length, index === 0 ? 45 : 44);
      const seeded = history.messages.filter(message => message.body.startsWith(`가상 ${index === 0 ? '첫째' : '둘째'} 대화 `));
      assert.equal(seeded.length, 44); assert(seeded.some(message => message.body.length > 150));
      assert.equal(new Set(seeded.map(message => message.authorId)).size, 2);
      for (const message of history.messages) {
        assert.deepEqual(message.attachments, []); assert.match(message.body, /가상|합성/);
        assert.equal(message.conversationId, room.conversationId); assert.equal(message.childId, room.childId);
        if (role === 'therapist') { assert(!observedIds.has(message.id)); observedIds.add(message.id); }
      }
      assert(history.messages.every((message, offset, list) => offset === 0 || list[offset - 1].sequence < message.sequence));
    }
  }
  assert.equal(observedIds.size, 89);
  assert.equal((await sandbox.database.query('SELECT count(*)::int AS count FROM cb_read_states')).rows[0].count, 0);
  assert.equal((await sandbox.database.query('SELECT count(*)::int AS count FROM cb_media_uploads')).rows[0].count, 0);
  const mediaRoot = sandbox.mediaRoot, originalCredential = sandbox.credentials[0];
  const closing = sandbox.close(); assert.equal(sandbox.close(), closing); await closing;
  assert.equal(sandbox.database.closed, true); assert.equal(sandbox.credentials.length, 0);
  assert.equal(originalCredential.password, ''); assert.equal(originalCredential.email, '');
  await assert.rejects(access(mediaRoot), { code: 'ENOENT' });
  await assert.rejects(localGet(sandbox.origin), { code: 'ECONNREFUSED' });
});

test('extra-room seed failure closes the original owned sandbox instead of returning a partial fixture', async (t) => {
  const original = Goals.prototype.save;
  const failure = new Error('Synthetic frontend seed failure.');
  let failedDatabase;
  t.mock.method(Goals.prototype, 'save', async function (actor, input) {
    if (input.goalId.startsWith('frontend-goal-')) {
      failedDatabase = this.conversations.database;
      throw failure;
    }
    return original.call(this, actor, input);
  });
  await assert.rejects(createFrontendMultiroomFixture({ port: 0 }), error => error === failure);
  assert(failedDatabase); assert.equal(failedDatabase.closed, true);
});

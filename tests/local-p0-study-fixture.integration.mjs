// DB integration: npm run test:fixtures:local (server dependencies and Git history required).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createLocalP0StudyFixture, LOCAL_P0_BASELINE_COMMIT, LOCAL_P0_BASELINE_SEED_BLOB,
  LOCAL_P0_TASK_C_SUMMARY } from './local-p0-study-fixture.mjs';
import { TASK_A, TASK_B, studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { Conversations } from '../server/conversations.mjs';
import { Children } from '../server/profiles.mjs';
import { Goals, Appointments } from '../server/care-contexts.mjs';
import { Records } from '../server/records.mjs';
import { getPendingSyntheticCleanup } from '../server/local-sandbox-cleanup.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function pinnedSeed(day) {
  // Read-only Git lookup of the reviewed object, never checkout/reset. Execute
  // only the exact pinned pure seed body in a new VM with one fixed day.
  const bytes = execFileSync('git', ['show', `${LOCAL_P0_BASELINE_COMMIT}:src/seed.js`],
    { cwd:root, windowsHide:true, env:studyChildEnvironment(), timeout:10000, maxBuffer:100000 });
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(blob, LOCAL_P0_BASELINE_SEED_BLOB);
  const source = bytes.toString('utf8');
  assert.ok(source.startsWith('import { today } from "./config.js";\nexport function seed()'));
  const executable = source.replace('import { today } from "./config.js";', '').replace('export function seed()', 'function seed()');
  return JSON.parse(JSON.stringify(runInNewContext(`${executable}\nseed();`, { today:() => day }, { timeout:1000 })));
}
function localGet(origin) {
  const target = new URL(origin);
  assert.equal(target.protocol, 'http:'); assert.equal(target.hostname, '127.0.0.1');
  return new Promise((resolve, reject) => {
    const req = request({ hostname:'127.0.0.1', port:target.port, path:'/', agent:false }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode)); res.once('error', reject);
    });
    req.once('error', reject); req.setTimeout(5000, () => req.destroy(new Error('Synthetic P0 loopback timeout'))); req.end();
  });
}

test('one explicit task and the original port-only options reject custom endpoints, existing data and accessors', async () => {
  for (const task of [undefined, null, '', 'AB', 'D', {}, ['A']]) await assert.rejects(createLocalP0StudyFixture(task), TypeError);
  let getters = 0;
  for (const options of [null, [], new Date(), { port:undefined }, { port:'0' }, { port:443 }, { port:65536 },
    { host:'0.0.0.0' }, { database:{} }, { path:'existing' }, { port:0, task:'B' },
    { [Symbol('unsupported')]:true }, Object.create({ port:0 }),
    Object.defineProperty({}, 'port', { get() { getters++; return 0; } })])
    await assert.rejects(createLocalP0StudyFixture('A', options), TypeError);
  assert.equal(getters, 0);
});

test('A/B initial state matches pinned visible children, goals, records, publication and empty responses; C changes only its shared summary', async t => {
  for (const task of ['A', 'B', 'C']) {
    const f = await createLocalP0StudyFixture(task), { sandbox, rooms } = f;
    t.after(() => sandbox.close());
    const legacy = pinnedSeed(f.day), database = sandbox.database;
    const therapist = { centerId:sandbox.ids.centerId, userId:sandbox.ids.therapistId };
    const guardian = { centerId:sandbox.ids.centerId, userId:sandbox.ids.guardianId };
    const chat = new Conversations(database), profiles = new Children(database), goals = new Goals(database);
    const appointments = new Appointments(database), records = new Records(database);
    assert(Object.isFrozen(f)); assert(Object.isFrozen(rooms)); assert(rooms.every(Object.isFrozen));
    assert(Object.isFrozen(f.expected)); assert(Object.isFrozen(f.expected.counts)); assert(Object.isFrozen(f.evidence.limitations));
    assert.equal(f.task, task); assert.equal(f.baselineCommit, LOCAL_P0_BASELINE_COMMIT); assert.equal(f.baselineSeedBlob, LOCAL_P0_BASELINE_SEED_BLOB);
    assert.equal(f.evidence.setupOnly, true); assert.equal(f.evidence.uiTaskCompleted, false); assert.equal(f.evidence.humanMetricsCollected, false);
    assert.match(sandbox.origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/); assert.equal(await localGet(sandbox.origin), 200);
    assert.deepEqual(Object.keys(sandbox).sort(), ['close', 'ids', 'origin']);
    for (const key of ['credentials', 'database']) assert.equal(Object.getOwnPropertyDescriptor(sandbox, key).enumerable, false);
    assert.equal(sandbox.credentials.length, 3);
    const serialized = JSON.stringify(f);
    for (const credential of sandbox.credentials) { assert(!serialized.includes(credential.password)); assert(!serialized.includes(credential.email)); }
    assert(!serialized.includes('privateNote')); assert(!serialized.includes('password'));

    for (const [actor, visible] of [[therapist, legacy.children.filter(child => child.therapistId === 't1')],
      [guardian, legacy.children.filter(child => child.guardianIds.includes('p1'))]]) {
      const inbox = await chat.inbox(actor);
      assert.deepEqual(inbox.rooms.map(room => room.conversationId).sort(), rooms.filter(room => visible.some(child => child.id === room.legacyChildId)).map(room => room.conversationId).sort());
    }
    for (const room of rooms) {
      const child = legacy.children.find(row => row.id === room.legacyChildId);
      const profile = await profiles.get(therapist, { conversationId:room.conversationId });
      assert.equal(profile.name, child.name); assert.equal(profile.age, child.age); assert.equal(profile.ageAsOf, f.day);
      assert.equal(profile.familyPlan.concern, child.concern);
      const expectedGoals = legacy.goals.filter(goal => goal.childId === child.id);
      assert.equal(room.goalIds.length, expectedGoals.length);
      const availableGoals = await goals.list(therapist, { conversationId:room.conversationId });
      assert.deepEqual(availableGoals.goals.map(goal => goal.id), room.goalIds);
      assert.deepEqual(availableGoals.goals.map(goal => goal.title), expectedGoals.map(goal => goal.title));
      if (room.legacyChildId === 'c1') {
        const guardianGoals = await goals.list(guardian, { conversationId:room.conversationId });
        assert.deepEqual(guardianGoals.goals.map(goal => goal.id), room.goalIds);
        assert.deepEqual(guardianGoals.goals.map(goal => goal.title), expectedGoals.map(goal => goal.title));
        assert.equal(availableGoals.goals[0].title, '놀이에 스스로 참여하기');
      }
      for (const [index, goalId] of room.goalIds.entries()) {
        const goal = await goals.get(therapist, { conversationId:room.conversationId, goalId });
        for (const key of ['title', 'description', 'status']) assert.equal(goal[key], expectedGoals[index][key]);
      }
      const appointment = await appointments.get(therapist, { conversationId:room.conversationId, appointmentId:room.appointmentId });
      const oldAppointment = legacy.appointments.find(item => item.childId === child.id);
      for (const key of ['date', 'time', 'duration', 'title', 'room', 'status']) assert.equal(appointment[key], oldAppointment[key]);
      const listed = await records.list(therapist, { conversationId:room.conversationId });
      assert.equal(listed.records.length, legacy.records.filter(record => record.childId === child.id).length);
    }
    await assert.rejects(chat.list(guardian, { conversationId:rooms[1].conversationId }), { code:'NOT_FOUND' });
    for (const old of legacy.records) {
      const record = await records.get(therapist, { conversationId:rooms[0].conversationId, recordId:f.records[old.id] });
      for (const key of ['date', 'title', 'privateNote', 'nextPlan', 'activity']) assert.deepEqual(record[key], old[key]);
      assert.equal(record.summary, task === 'C' && old.id === 'r1' ? LOCAL_P0_TASK_C_SUMMARY : old.summary);
      assert.equal(record.status, 'saved'); assert.equal(record.performed, ''); assert.equal(record.response, '');
      assert.deepEqual(record.assessments, old.assessment ? [old.assessment] : []);
      assert.deepEqual(record.attachments, []); assert.deepEqual(record.referenceMessageIds, []);
      await assert.rejects(records.get(guardian, { conversationId:rooms[0].conversationId, recordId:record.id }), { code:'FORBIDDEN' });
    }
    const messages = (await chat.list(guardian, { conversationId:rooms[0].conversationId })).messages;
    assert.equal(messages.length, 2); assert.equal(messages.filter(message => message.type === 'text').length, 1);
    const shared = messages.find(message => message.type === 'publication');
    assert.equal(shared.id, f.publication.messageId); assert.equal(shared.publication.id, f.publication.publicationId);
    assert.equal(shared.publication.title, legacy.publications[0].title); assert.equal(shared.publication.date, legacy.publications[0].date);
    assert.equal(shared.publication.summary, f.expected.summary); assert.deepEqual(shared.publication.activity, legacy.publications[0].activity);
    assert.deepEqual(f.expected.activity, legacy.publications[0].activity);
    assert.equal(messages.at(-1).id, shared.id); assert.deepEqual(shared.attachments, []);
    const publicBody = JSON.stringify(messages);
    for (const old of legacy.records) assert(!publicBody.includes(old.privateNote));
    assert.doesNotMatch(publicBody, /"(?:privateNote|performed|response|assessments)"/);
    for (const [table, count] of [['cb_records', 2], ['cb_publications', 1], ['cb_activity_feedback', 0], ['cb_media_uploads', 0], ['cb_read_states', 0], ['cb_auth_accounts', 3], ['cb_auth_sessions', 0]])
      assert.equal((await database.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count, count);
    assert.deepEqual(f.expected.counts, { therapistRooms:2, guardianRooms:1, records:2, publications:1, feedback:0 });
    assert(!publicBody.includes(TASK_A.reaction));
    assert.equal((await database.query('SELECT count(*)::integer AS count FROM cb_record_revisions WHERE title=$1', [TASK_B.title])).rows[0].count, 0);
    assert.deepEqual(TASK_B.assessments.map(row => [row.value, row.unit]), [[3, '분'], [0, '회']]);
    const mediaRoot = sandbox.mediaRoot, credentials = sandbox.credentials.map(value => value);
    const closing = sandbox.close(); assert.equal(sandbox.close(), closing); await closing;
    assert.equal(database.closed, true); assert.equal(sandbox.credentials.length, 0);
    for (const credential of credentials) { assert.equal(credential.password, ''); assert.equal(credential.email, ''); }
    await assert.rejects(access(mediaRoot), { code:'ENOENT' });
    await assert.rejects(localGet(sandbox.origin), { code:'ECONNREFUSED' });
  }
});

test('C preparation uses the exact participant-facing document paragraph, not an answer rubric', async () => {
  const document = await readFile(new URL('../docs/p0-user-validation.md', import.meta.url), 'utf8');
  const section = document.slice(document.indexOf('### C.'), document.indexOf('### D.'));
  const paragraph = section.split(/\r?\n/).find(line => line.startsWith('> '));
  assert.equal(LOCAL_P0_TASK_C_SUMMARY, paragraph.slice(2));
  assert(!LOCAL_P0_TASK_C_SUMMARY.includes('독립 설명')); assert(!LOCAL_P0_TASK_C_SUMMARY.includes('①'));
});

test('publication setup failure closes its owned sandbox and never returns a partially prepared study', async t => {
  const failure = new Error('Synthetic P0 publication setup failure'); let database;
  t.mock.method(Records.prototype, 'publish', async function () { database = this.conversations.database; throw failure; });
  await assert.rejects(createLocalP0StudyFixture('A'), error => error === failure);
  assert(database); assert.equal(database.closed, true);
  assert.equal(getPendingSyntheticCleanup(failure), undefined);
});

test('publication setup and cleanup failure retain the exact sandbox close until the retry succeeds', async t => {
  const initial = Error('synthetic publication setup failure'), cleanup = Error('synthetic cleanup failure');
  let database, actualClose, closeCalls = 0;
  t.mock.method(Records.prototype, 'publish', async function () {
    database = this.conversations.database; actualClose = database.close.bind(database);
    t.mock.method(database, 'close', async () => { if (++closeCalls <= 2) throw cleanup; await actualClose(); });
    throw initial;
  });
  let close;
  try {
    let failure;
    await assert.rejects(createLocalP0StudyFixture('A'), error => { failure = error; return error instanceof AggregateError; });
    assert.deepEqual(failure.errors, [initial, cleanup]); assert.equal(JSON.stringify(failure), '{}');
    assert.equal(database.closed, false); assert.equal(closeCalls, 1);
    close = getPendingSyntheticCleanup(failure); assert.equal(typeof close, 'function');
    await assert.rejects(close(), error => error === cleanup);
    assert.equal(database.closed, false); assert.equal(getPendingSyntheticCleanup(failure), close);
    await close(); assert.equal(database.closed, true); assert.equal(closeCalls, 3);
    assert.equal(getPendingSyntheticCleanup(failure), undefined);
  } finally { if (close) await close(); else if (database && !database.closed) await actualClose(); }
});

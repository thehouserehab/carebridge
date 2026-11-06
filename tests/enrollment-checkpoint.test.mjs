import test from 'node:test';
import assert from 'node:assert/strict';
import { enrollmentCheckpoint } from './enrollment-checkpoint.mjs';

const fixedError = /^Error: ENROLLMENT_CHECKPOINT_INVALID$/;
const input = () => ({ runId: '12345678-1234-4123-8123-123456789abc', sourceSha256: 'a'.repeat(64),
  phase: '390:THERAPIST_RECORD_HISTORY_IS_NOT_OWNERSHIP_BYPASS', step: 'DISCONNECT_EDITOR_READY', elapsedMs: 1234,
  memory: { rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 },
  counts: { contexts: 4, sandboxes: 1, routeWork: 0, retainedSandboxHandles: 3 } });
const phases = ['SANDBOX', 'REGISTER_COMMIT_LOSS', 'EXISTING_MEMBER_EXPLICIT_CONNECTION', 'UI_PRIVATE_RECORD_AND_OLD_NEWS',
  'FROM_NOW_USES_COMMIT_BOUNDARY', 'DISCONNECT_AND_RECONNECT_FROM_NOW', 'ALL_HISTORY_NEEDS_EXTRA_CONFIRMATION',
  'THERAPIST_RECORD_HISTORY_IS_NOT_OWNERSHIP_BYPASS', 'OLD_RECEIPT_CANNOT_REAPPLY_RELATIONSHIPS',
  'REAL_RELATIONSHIP_VERSION_CONFLICT', 'LATE_RELATIONSHIP_OTHER_CHILD', 'LATE_RELATIONSHIP_CHANGED_ACCOUNT',
  'MANAGER_AUTHORITY_AND_NO_CLINICAL_SIDE_EFFECTS', 'WIDTH_CLEANUP'];

test('checkpoint projects only fixed numeric metadata without visiting unknown getters or toJSON', () => {
  const value = input();
  for (const object of [value, value.memory, value.counts]) {
    for (const key of ['private', 'token', 'path', 'body', 'error', 'toJSON']) Object.defineProperty(object, key, {
      enumerable: true, get() { assert.fail('Unknown metadata must not be read.'); },
    });
    Object.defineProperty(object, Symbol('private'), { get() { assert.fail('Unknown symbols must not be read.'); } });
  }
  const result = enrollmentCheckpoint(value);
  assert.deepEqual(Object.keys(result), ['runId', 'sourceSha256', 'phase', 'step', 'width', 'elapsedMs', 'memory', 'counts']);
  assert.deepEqual(Object.keys(result.memory), ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']);
  assert.deepEqual(Object.keys(result.counts), ['contexts', 'sandboxes', 'routeWork', 'retainedSandboxHandles']);
  assert.equal(result.width, 390); assert.equal(result.counts.retainedSandboxHandles, 3);
  assert(!JSON.stringify(result).includes('private')); assert(JSON.stringify(result).length <= 2048);
});

test('all fourteen fixed phases accept each supported width and only startup/cleanup omit width', () => {
  for (const width of [390, 768, 1440]) for (const phase of phases) {
    const result = enrollmentCheckpoint({ ...input(), phase: `${width}:${phase}`, step: null });
    assert.equal(result.width, width); assert.equal(result.phase, `${width}:${phase}`); assert.equal(result.step, null);
  }
  for (const phase of ['STARTUP', 'CLEANUP']) {
    const value = { ...input(), phase }; delete value.step;
    const result = enrollmentCheckpoint(value); assert.equal(result.width, null); assert.equal(result.step, null);
  }
});

test('history and per-width cleanup substeps are accepted only in their declared phase', () => {
  for (const [phase, steps] of [
    ['THERAPIST_RECORD_HISTORY_IS_NOT_OWNERSHIP_BYPASS', ['DISCONNECT_EDITOR_READY', 'DISCONNECT_SAVED', 'DISCONNECTED_ACCESS_DENIED',
      'DISCONNECTED_READER_REFRESHED', 'FROM_NOW_EDITOR_READY', 'FROM_NOW_SAVED', 'FROM_NOW_RECORD_HIDDEN', 'ALL_HISTORY_EDITOR_READY',
      'ALL_HISTORY_SAVED', 'ORIGINAL_RECORD_VERIFIED', 'RESTORED_READER_VISIBLE']],
    ['WIDTH_CLEANUP', ['CONTEXTS_CLOSED', 'SANDBOX_CLOSED']],
  ]) for (const width of [390, 768, 1440]) for (const step of steps) {
    assert.equal(enrollmentCheckpoint({ ...input(), phase: `${width}:${phase}`, step }).step, step);
    for (const other of phases.filter(name => name !== phase))
      assert.throws(() => enrollmentCheckpoint({ ...input(), phase: `${width}:${other}`, step }), fixedError);
    assert.throws(() => enrollmentCheckpoint({ ...input(), phase: 'STARTUP', step }), fixedError);
  }
});

test('global cleanup has exactly its four permitted steps and no fabricated child context', () => {
  for (const step of ['ROUTES_SETTLED', 'CONTEXTS_CLOSED', 'BROWSER_STOPPED', 'SANDBOXES_CLOSED']) {
    const result = enrollmentCheckpoint({ ...input(), phase: 'CLEANUP', step });
    assert.equal(result.width, null); assert.equal(result.step, step);
    assert.throws(() => enrollmentCheckpoint({ ...input(), phase: 'STARTUP', step }), fixedError);
  }
  for (const step of ['SANDBOX_CLOSED', 'DISCONNECT_SAVED', 'raw error', 1, {}, false])
    assert.throws(() => enrollmentCheckpoint({ ...input(), phase: 'CLEANUP', step }), fixedError);
});

test('unknown phase, unsupported width, uncontrolled step and malformed identity fail with one fixed error', () => {
  for (const phase of ['private message', '1440:UNKNOWN', '320:SANDBOX', '0390:SANDBOX', '390:STARTUP', '390:CLEANUP',
    'WIDTH_CLEANUP', '390:SANDBOX\n', '', 'x'.repeat(121), null, 1])
    assert.throws(() => enrollmentCheckpoint({ ...input(), phase, step: null }), fixedError);
  for (const step of ['raw failure', '', 'SANDBOX_CLOSED', 1, {}, false])
    assert.throws(() => enrollmentCheckpoint({ ...input(), step }), fixedError);
  for (const value of ['private token', '', null, 1, '12345678-1234-1123-8123-123456789abc', '12345678-1234-4123-7123-123456789abc',
    '12345678-1234-4123-8123-123456789ABC'])
    assert.throws(() => enrollmentCheckpoint({ ...input(), runId: value }), fixedError);
  for (const value of ['private path', '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), null, 1])
    assert.throws(() => enrollmentCheckpoint({ ...input(), sourceSha256: value }), fixedError);
});

test('every numeric field rejects missing, negative, fractional, non-finite or non-numeric observations', () => {
  for (const bad of [undefined, null, false, -1, NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, 'private memory', 1n]) {
    for (const group of ['memory', 'counts']) for (const key of Object.keys(input()[group])) {
      const value = input(); value[group][key] = bad;
      assert.throws(() => enrollmentCheckpoint(value), fixedError);
    }
    assert.throws(() => enrollmentCheckpoint({ ...input(), elapsedMs: bad }), fixedError);
  }
  for (const bad of [undefined, null, [], 'private', 1]) {
    assert.throws(() => enrollmentCheckpoint(bad), fixedError);
    for (const group of ['memory', 'counts']) assert.throws(() => enrollmentCheckpoint({ ...input(), [group]: bad }), fixedError);
  }
});

test('zero and maximum safe numbers remain bounded, detached and deeply frozen', () => {
  for (const number of [0, Number.MAX_SAFE_INTEGER]) {
    const value = input(); value.elapsedMs = number;
    for (const group of ['memory', 'counts']) for (const key of Object.keys(value[group])) value[group][key] = number;
    const result = enrollmentCheckpoint(value);
    assert(Object.isFrozen(result) && Object.isFrozen(result.memory) && Object.isFrozen(result.counts));
    assert(JSON.stringify(result).length <= 2048);
    value.memory.rss = 50; value.counts.contexts = 20; value.elapsedMs = 2;
    assert.equal(result.memory.rss, number); assert.equal(result.counts.contexts, number); assert.equal(result.elapsedMs, number);
    assert.throws(() => { result.memory.rss = 5; }, TypeError);
  }
});

test('a throwing known-field accessor cannot disclose its raw diagnostic exception', () => {
  for (const [group, key] of [[null, 'phase'], ['memory', 'rss'], ['counts', 'contexts']]) {
    const value = input();
    Object.defineProperty(group ? value[group] : value, key, { get() { throw new Error('PRIVATE-DIAGNOSTIC'); } });
    assert.throws(() => enrollmentCheckpoint(value), fixedError);
  }
});
test('terminal newlines cannot turn an otherwise valid phase or identity into an admitted diagnostic string', () => {
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    for (const key of ['runId', 'sourceSha256', 'phase']) {
      const value = { ...input(), step: null }; value[key] += suffix;
      assert.throws(() => enrollmentCheckpoint(value), fixedError);
    }
  }
});

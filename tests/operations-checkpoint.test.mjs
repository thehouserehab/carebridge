import test from 'node:test';
import assert from 'node:assert/strict';
import { operationsCheckpoint } from './operations-checkpoint.mjs';

const input = () => ({ runId: '12345678-1234-4123-8123-123456789abc', sourceSha256: 'a'.repeat(64),
  phase: '1440:ACTUAL_PROFILE_CONFLICT', step: 'CONFLICT_CAPTURED', elapsedMs: 1234,
  memory: { rss: 1, heapTotal: 2, heapUsed: 3, external: 4, arrayBuffers: 5 },
  counts: { contexts: 4, sandboxes: 1, routeWork: 0, retainedSandboxHandles: 3 } });

test('checkpoint is a bounded immutable numeric projection, not a clinical or runtime dump', () => {
  const value = input();
  for (const object of [value, value.memory, value.counts]) Object.defineProperty(object, 'private', {
    get() { assert.fail('Unknown metadata must not be read.'); }, enumerable: true,
  });
  const output = operationsCheckpoint(value);
  assert.deepEqual(Object.keys(output), ['runId', 'sourceSha256', 'phase', 'step', 'width', 'elapsedMs', 'memory', 'counts']);
  assert.deepEqual(Object.keys(output.memory), ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']);
  assert.deepEqual(Object.keys(output.counts), ['contexts', 'sandboxes', 'routeWork', 'retainedSandboxHandles']);
  assert.equal(output.width, 1440); assert.equal(output.counts.retainedSandboxHandles, 3);
  assert(!JSON.stringify(output).includes('private')); assert(JSON.stringify(output).length <= 2048);
  assert(Object.isFrozen(output) && Object.isFrozen(output.memory) && Object.isFrozen(output.counts));
  value.memory.rss = 999; assert.equal(output.memory.rss, 1);
});

test('all six fixed substeps are accepted only in their corresponding phase', () => {
  for (const [phase, steps] of [
    ['ACTUAL_PROFILE_CONFLICT', ['CONFLICT_CAPTURED', 'CONFLICT_INPUT_KEPT', 'CONFLICT_RECEIPT_RECEIVED', 'CONFLICT_DB_CHECKED']],
    ['LATE_DETAIL_OTHER_CHILD', ['LATE_CHILD_GET_HELD', 'LATE_CHILD_GATE_RELEASED']],
  ]) for (const step of steps) {
    const value = { ...input(), phase: `390:${phase}`, step };
    assert.equal(operationsCheckpoint(value).step, step);
    assert.throws(() => operationsCheckpoint({ ...value, phase: '390:SANDBOX' }), /^Error: OPERATIONS_CHECKPOINT_INVALID$/);
  }
});

test('startup and existing phases have no invented substep or child context', () => {
  assert.equal(operationsCheckpoint({ ...input(), phase: 'STARTUP', step: null }).width, null);
  for (const width of [390, 768, 1440]) assert.equal(operationsCheckpoint({ ...input(), phase: `${width}:SANDBOX`, step: null }).width, width);
  for (const value of ['private message', '1440:UNKNOWN', '320:SANDBOX'])
    assert.throws(() => operationsCheckpoint({ ...input(), phase: value }), /^Error: OPERATIONS_CHECKPOINT_INVALID$/);
  assert.throws(() => operationsCheckpoint({ ...input(), step: 'raw error' }), /^Error: OPERATIONS_CHECKPOINT_INVALID$/);
});

test('numeric and identity failures have a fixed error without input details', () => {
  for (const bad of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, 'private memory']) {
    for (const field of ['memory', 'counts']) {
      const value = input(), key = Object.keys(value[field])[0]; value[field][key] = bad;
      assert.throws(() => operationsCheckpoint(value), /^Error: OPERATIONS_CHECKPOINT_INVALID$/);
    }
    assert.throws(() => operationsCheckpoint({ ...input(), elapsedMs: bad }), /^Error: OPERATIONS_CHECKPOINT_INVALID$/);
  }
  for (const key of ['runId', 'sourceSha256'])
    assert.throws(() => operationsCheckpoint({ ...input(), [key]: 'private token' }), /^Error: OPERATIONS_CHECKPOINT_INVALID$/);
});

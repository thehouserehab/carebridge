import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { captureNativeApiResources, nativeApiResourceMessage, parseNativeApiResourceMessage,
  NATIVE_API_RESOURCE_TYPES, NATIVE_API_RESOURCE_LIMIT } from '../windows-native-api-test-resources.mjs';

const unavailable = { message: 'WINDOWS_NATIVE_API_TEST_UNAVAILABLE' };
const id = randomUUID();
const sample = () => ({ available: true, truncated: false, counts: [{ type: 'Timeout', count: 2 }, { type: 'Other', count: 1 }] });
const frame = () => nativeApiResourceMessage(id, 'before-service-close', sample());

test('resource observation emits only fixed type counts, mapping arbitrary runtime names to Other', () => {
  const input = ['PRIVATE_PATH_PASSWORD', 'TCPSocketWrap', 'Timeout', 'Timeout', 'PRIVATE_ADDRESS'];
  const result = captureNativeApiResources(() => input);
  assert.deepEqual(result, { available: true, truncated: false, counts: [
    { type: 'Timeout', count: 2 }, { type: 'TCPSocketWrap', count: 1 }, { type: 'Other', count: 2 }] });
  input[0] = 'Timeout'; assert.equal(result.counts[2].count, 2);
  assert(!JSON.stringify(result).includes('PRIVATE'));
  for (const object of [result, result.counts, ...result.counts]) assert(Object.isFrozen(object));
});

test('capture bounds work and reported counts without reading beyond the fixed maximum', () => {
  const input = Array(NATIVE_API_RESOURCE_LIMIT + 1).fill('Timeout');
  Object.defineProperty(input, String(NATIVE_API_RESOURCE_LIMIT), { get() { throw new Error('must not read'); } });
  assert.deepEqual(captureNativeApiResources(() => input), { available: true, truncated: true,
    counts: [{ type: 'Timeout', count: NATIVE_API_RESOURCE_LIMIT }] });
  assert.deepEqual(captureNativeApiResources(() => []), { available: true, truncated: false, counts: [] });
});

test('observer error, non-array, sparse or accessor input becomes a fixed unavailable sample', async () => {
  let getters = 0;
  const accessor = Object.defineProperty([], '0', { get() { getters++; return 'PRIVATE'; } });
  for (const read of [() => { throw new Error('PRIVATE'); }, () => null, () => ({}), () => Array(1), () => accessor, () => [null],
    async () => { throw new Error('PRIVATE'); }]) {
    assert.deepEqual(captureNativeApiResources(read), { available: false, truncated: false, counts: [] });
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getters, 0);
});

test('strict resource IPC captures ordered bounded counts without retaining mutable input', () => {
  const value = sample(), message = nativeApiResourceMessage(id, 'after-service-close', value);
  value.counts[0].count = 999;
  assert.equal(message.counts[0].count, 2);
  assert.deepEqual(parseNativeApiResourceMessage(message, id), message);
  assert(Object.isFrozen(message)); assert(Object.isFrozen(message.counts));
  assert.deepEqual(Object.keys(message).sort(), ['available', 'counts', 'instanceId', 'phase', 'protocol', 'truncated']);
});

test('resource IPC rejects unknown fields, phases, instance, handles, types, duplicates and count overflow', () => {
  const malformed = [
    { ...frame(), path: 'PRIVATE' }, { ...frame(), phase: 'exit' }, { ...frame(), instanceId: randomUUID() },
    { ...frame(), protocol: 'other' }, { ...frame(), available: 1 }, { ...frame(), truncated: 0 },
    { ...frame(), counts: [{ type: 'PRIVATE', count: 1 }] },
    { ...frame(), counts: [{ type: 'Timeout', count: 1, private: true }] },
    { ...frame(), counts: [{ type: 'Other', count: 1 }, { type: 'Timeout', count: 1 }] },
    { ...frame(), counts: [{ type: 'Timeout', count: 1 }, { type: 'Timeout', count: 1 }] },
    { ...frame(), counts: NATIVE_API_RESOURCE_TYPES.map(type => ({ type, count: NATIVE_API_RESOURCE_LIMIT })) },
    { ...frame(), counts: Array(NATIVE_API_RESOURCE_TYPES.length + 1).fill({ type: 'Other', count: 1 }) },
    { ...frame(), counts: Array(1) }, { ...frame(), available: false },
    { ...frame(), counts: [], available: false, truncated: true }, { ...frame(), truncated: true },
    ...[0, -1, 1.5, NaN, Infinity, '1', NATIVE_API_RESOURCE_LIMIT + 1].map(count => ({ ...frame(), counts: [{ type: 'Timeout', count }] })),
  ];
  for (const value of malformed) assert.throws(() => parseNativeApiResourceMessage(value, id), unavailable);
  assert.throws(() => parseNativeApiResourceMessage(frame(), id, {}), unavailable);
  assert.throws(() => nativeApiResourceMessage('PRIVATE', 'before-service-close', sample()), unavailable);
});

test('resource IPC never invokes input accessors or accepts symbol fields', () => {
  let getters = 0;
  const accessor = Object.defineProperty({ ...frame() }, 'counts', { get() { getters++; return []; } });
  const entry = Object.defineProperty({ type: 'Timeout' }, 'count', { get() { getters++; return 1; } });
  const array = Object.defineProperty([], '0', { get() { getters++; return { type: 'Timeout', count: 1 }; } });
  for (const value of [accessor, { ...frame(), counts: [entry] }, { ...frame(), counts: array },
    { ...frame(), [Symbol('PRIVATE')]: 'PRIVATE' }]) assert.throws(() => parseNativeApiResourceMessage(value, id), unavailable);
  assert.equal(getters, 0);
});

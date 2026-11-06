// Pure promises/timers only. No files, browser, database, credentials or E.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnrollmentProgressWriter } from './enrollment-progress-writer.mjs';

const fixedError = /^Error: ENROLLMENT_PROGRESS_WRITE_FAILED$/;
const checkpoint = Object.freeze({ phase: 'STARTUP', elapsedMs: 0 });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('sequential successful writes preserve exact input and expose only frozen fixed status fields', async () => {
  const seen = [], writer = createEnrollmentProgressWriter(value => { seen.push(value); });
  assert(Object.isFrozen(writer)); assert.deepEqual(Object.keys(writer), ['write', 'status']);
  const before = writer.status(); assert(Object.isFrozen(before));
  assert.deepEqual(before, { failed: false, inFlight: false, timedOut: false });
  const work = writer.write(checkpoint); assert.deepEqual(writer.status(), { failed: false, inFlight: true, timedOut: false });
  await work; await writer.write(checkpoint);
  assert.deepEqual(seen, [checkpoint, checkpoint]); assert.equal(seen[0], checkpoint);
  assert.deepEqual(writer.status(), before); assert.deepEqual(before, { failed: false, inFlight: false, timedOut: false });
});

test('the callback payload is not inspected, copied, stringified or included in status', async () => {
  const value = {}; Object.defineProperty(value, 'secret', { get() { assert.fail('Payload must not be inspected.'); }, enumerable: true });
  const writer = createEnrollmentProgressWriter(item => assert.equal(item, value));
  await writer.write(value); assert.deepEqual(Object.keys(writer.status()), ['failed', 'inFlight', 'timedOut']);
});

test('synchronous callback failure permanently seals writer with no raw message or cause', async () => {
  let calls = 0; const writer = createEnrollmentProgressWriter(() => { calls++; throw new Error('PRIVATE-PATH'); });
  await assert.rejects(writer.write(checkpoint), e => fixedError.test(String(e)) && e.cause === undefined && !e.stack.includes('PRIVATE-PATH'));
  assert.deepEqual(writer.status(), { failed: true, inFlight: false, timedOut: false });
  await assert.rejects(writer.write(checkpoint), fixedError); assert.equal(calls, 1);
});

test('asynchronous callback rejection permanently seals without propagating its diagnostic value', async () => {
  const gate = Promise.withResolvers(); let calls = 0;
  const writer = createEnrollmentProgressWriter(() => { calls++; return gate.promise; });
  const work = writer.write(checkpoint), rejected = assert.rejects(work, fixedError);
  assert.equal(writer.status().inFlight, true); gate.reject({ private: 'PRIVATE-PAYLOAD' }); await rejected;
  assert.deepEqual(writer.status(), { failed: true, inFlight: false, timedOut: false });
  await assert.rejects(writer.write(checkpoint), fixedError); assert.equal(calls, 1);
});

test('deadline rejects observer but retains actual in-flight ownership until late success and never restarts', async () => {
  const gate = Promise.withResolvers(); let calls = 0;
  const writer = createEnrollmentProgressWriter(() => { calls++; return gate.promise; }, { timeoutMs: 15 });
  await assert.rejects(writer.write(checkpoint), fixedError);
  const atDeadline = writer.status(); assert.deepEqual(atDeadline, { failed: true, inFlight: true, timedOut: true });
  await assert.rejects(writer.write(checkpoint), fixedError); assert.equal(calls, 1);
  gate.resolve('not a checkpoint result'); await flush();
  assert.deepEqual(writer.status(), { failed: true, inFlight: false, timedOut: true });
  assert.deepEqual(atDeadline, { failed: true, inFlight: true, timedOut: true });
  await assert.rejects(writer.write(checkpoint), fixedError); assert.equal(calls, 1);
});

test('late rejection after deadline is observed without an unhandled rejection or raw error escape', async () => {
  const gate = Promise.withResolvers(), writer = createEnrollmentProgressWriter(() => gate.promise, { timeoutMs: 15 });
  await assert.rejects(writer.write(checkpoint), fixedError);
  gate.reject(new Error('PRIVATE-LATE-PATH')); await flush();
  assert.deepEqual(writer.status(), { failed: true, inFlight: false, timedOut: true });
  await assert.rejects(writer.write(checkpoint), fixedError);
});

test('first overlapping call seals the whole writer and rejects both observers without ending actual I/O', async () => {
  const gate = Promise.withResolvers(); let calls = 0;
  const writer = createEnrollmentProgressWriter(() => { calls++; return gate.promise; });
  const first = writer.write(checkpoint), firstRejected = assert.rejects(first, fixedError);
  await assert.rejects(writer.write(Object.freeze({ phase: 'CLEANUP' })), fixedError); await firstRejected;
  assert.equal(calls, 1); assert.deepEqual(writer.status(), { failed: true, inFlight: true, timedOut: false });
  gate.resolve(); await flush();
  assert.deepEqual(writer.status(), { failed: true, inFlight: false, timedOut: false });
  await assert.rejects(writer.write(checkpoint), fixedError); assert.equal(calls, 1);
});

test('overlap followed by late failure never reopens writer or fabricates a deadline', async () => {
  const gate = Promise.withResolvers(), writer = createEnrollmentProgressWriter(() => gate.promise);
  const first = writer.write(checkpoint), firstRejected = assert.rejects(first, fixedError);
  await assert.rejects(writer.write(checkpoint), fixedError); await firstRejected;
  gate.reject(new Error('PRIVATE')); await flush();
  assert.deepEqual(writer.status(), { failed: true, inFlight: false, timedOut: false });
});

test('a throwing then accessor is handled as actual failed settlement', async () => {
  const writer = createEnrollmentProgressWriter(() => ({ get then() { throw new Error('PRIVATE-THENABLE'); } }));
  await assert.rejects(writer.write(checkpoint), fixedError);
  assert.deepEqual(writer.status(), { failed: true, inFlight: false, timedOut: false });
});

test('known-option getter failures and invalid callback/deadline values use only the fixed error', async () => {
  for (const write of [undefined, null, {}, false]) assert.throws(() => createEnrollmentProgressWriter(write), fixedError);
  for (const timeoutMs of [null, 0, -1, 30001, 1.5, NaN, Infinity, '15'])
    assert.throws(() => createEnrollmentProgressWriter(() => {}, { timeoutMs }), fixedError);
  for (const options of [null, [], 1, 'private']) assert.throws(() => createEnrollmentProgressWriter(() => {}, options), fixedError);
  assert.throws(() => createEnrollmentProgressWriter(() => {}, { get timeoutMs() { throw new Error('PRIVATE'); } }), fixedError);
  for (const timeoutMs of [1, 30000]) {
    const writer = createEnrollmentProgressWriter(() => {}, { timeoutMs });
    assert.deepEqual(writer.status(), { failed: false, inFlight: false, timedOut: false });
  }
  let reads = 0;
  const writer = createEnrollmentProgressWriter(() => {}, { get timeoutMs() { reads++; return 30000; } });
  await writer.write(checkpoint); assert.equal(reads, 1);
});

test('unrelated options getters are ignored and success clears its timer rather than failing later', async () => {
  const options = { timeoutMs: 15, get private() { assert.fail('Unrelated options must not be read.'); } };
  const writer = createEnrollmentProgressWriter(() => {}, options); await writer.write(checkpoint);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(writer.status(), { failed: false, inFlight: false, timedOut: false }); await writer.write(checkpoint);
});

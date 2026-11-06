import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { MEDIA_LIMITS } from '../../src/media-policy.js';
import { RepositoryError } from '../errors.mjs';
import { drainLocalMediaContent, localMediaContentRoute, streamLocalMediaContent } from '../local-media-content-http.mjs';

// Real loopback Node HTTP with synthetic service doubles ONLY. These tests
// verify the streaming adapter, not database authorization, malware approval,
// decoding or the parent's source/session/expected-account guard.
const uploadId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const routePath = `/api/local/centers/synthetic-center/conversations/synthetic-room/messages/synthetic-message/attachments/${uploadId}/content`;
const recordPath = `/api/local/centers/synthetic-center/conversations/synthetic-room/records/synthetic-record/revisions/2/attachments/${uploadId}/content`;
const feedbackPath = routePath.replace('/attachments/', '/feedback-revisions/3/attachments/');
const referencePath = recordPath.replace('/attachments/', '/references/synthetic-message/attachments/');
const identity = Object.freeze({ userId: 'synthetic-reader', centerId: 'synthetic-center' });
const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const secret = 'SYNTHETIC_INTERNAL_VALUE_NEVER_RETURN';
function deferred() {
  let resolve, reject, settled = false;
  const promise = new Promise((yes, no) => {
    resolve = (value) => { settled = true; yes(value); };
    reject = (error) => { settled = true; no(error); };
  });
  return { promise, resolve, reject, get settled() { return settled; } };
}
async function until(predicate) {
  const end = performance.now() + 2000;
  while (!predicate()) {
    assert(performance.now() < end, 'SYNTHETIC_MEDIA_OBSERVATION_TIMEOUT');
    await new Promise(setImmediate);
  }
}
function opened({ type = 'image/png', body = bytes, stream, ...overrides } = {}) {
  return { stream: stream ?? Readable.from([body], { objectMode: false }),
    attachment: { id: uploadId, name: `${secret}\r\nX-Injected: yes`, type, size: body.length, object_key: secret },
    total: body.length, range: { start: 0, end: body.length - 1 }, ...overrides };
}
function header(req, name) {
  const count = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name).length;
  if (count > 1 || (req.headers[name] !== undefined && typeof req.headers[name] !== 'string')) throw new RepositoryError('INVALID_INPUT');
  return req.headers[name];
}
async function fixture(t, mediaAccess) {
  const errors = [], handles = [];
  const server = createServer((req, res) => {
    const handler = (async () => {
      try {
        const route = localMediaContentRoute(new URL(req.url, 'http://127.0.0.1'), req.method);
        if (!route) throw new RepositoryError('NOT_FOUND');
        await streamLocalMediaContent(route, identity, { mediaAccess }, req, res, header);
      } catch (error) {
        errors.push(error);
        if (res.destroyed || res.writableEnded) return;
        if (res.headersSent) { res.destroy(); return; }
        const statuses = { NOT_FOUND: 404, FORBIDDEN: 404, INVALID_INPUT: 400, MEDIA_READ_BUSY: 409,
          UPLOAD_CONFLICT: 409, REQUEST_TIMEOUT: 408, LOCAL_API_UNAVAILABLE: 503 };
        const code = Object.hasOwn(statuses, error.code) ? error.code : 'LOCAL_API_UNAVAILABLE';
        res.writeHead(statuses[code], { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: code }));
      }
    })();
    handles.push(handler);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await Promise.all(handles);
    if (mediaAccess) await drainLocalMediaContent(mediaAccess);
  });
  function call({ path = routePath, method = 'GET', headers = {}, onData } = {}) {
    let outgoing;
    const result = new Promise((resolve) => {
      let done = false;
      const finish = (value) => { if (!done) { done = true; resolve(value); } };
      outgoing = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers, agent: false }, (res) => {
        const chunks = [];
        const value = (aborted) => ({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), aborted });
        res.on('data', (chunk) => { chunks.push(chunk); onData?.(outgoing); });
        res.on('end', () => finish(value(false)));
        res.on('error', () => finish(value(true)));
        res.on('aborted', () => finish(value(true)));
      });
      outgoing.on('error', () => finish({ status: null, headers: {}, body: Buffer.alloc(0), aborted: true }));
      outgoing.end();
    });
    return { request: outgoing, result };
  }
  return { call, errors };
}

test('the descriptor accepts only the exact message-bound UUID GET with no query', () => {
  const url = (suffix = '') => new URL(`http://127.0.0.1${routePath}${suffix}`);
  assert.deepEqual(localMediaContentRoute(url(), 'GET'), {
    centerId: 'synthetic-center', conversationId: 'synthetic-room', messageId: 'synthetic-message', uploadId,
  });
  for (const method of ['HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'])
    assert.throws(() => localMediaContentRoute(url(), method), { code: 'NOT_FOUND' });
  for (const suffix of ['?range=0', '?source=record', '?x=1&x=2'])
    assert.throws(() => localMediaContentRoute(url(suffix), 'GET'), { code: 'INVALID_INPUT' });
  for (const pathname of [routePath + '/', routePath.replace('/messages/', '/records/'),
    routePath.replace(uploadId, 'not-a-uuid'), routePath.replace('synthetic-message', '%73ynthetic-message'),
    routePath.replace('/content', '/original'), routePath.replace(uploadId, uploadId.toUpperCase())])
    assert.equal(localMediaContentRoute(new URL(`http://127.0.0.1${pathname}`), 'GET'), null);
});

test('record descriptor requires an explicit canonical positive database revision and never changes the message descriptor', () => {
  const url = (path = recordPath) => new URL(`http://127.0.0.1${path}`);
  assert.deepEqual(localMediaContentRoute(url(), 'GET'), { centerId: 'synthetic-center', conversationId: 'synthetic-room',
    recordId: 'synthetic-record', revision: 2, uploadId });
  for (const method of ['HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'])
    assert.throws(() => localMediaContentRoute(url(), method), { code: 'NOT_FOUND' });
  for (const suffix of ['?revision=1', '?source=message', '?x=1&x=2'])
    assert.throws(() => localMediaContentRoute(url(recordPath + suffix), 'GET'), { code: 'INVALID_INPUT' });
  for (const value of ['0', '-1', '01', '1.5', '1e0', 'latest', '%32'])
    assert.equal(localMediaContentRoute(url(recordPath.replace('/2/', `/${value}/`)), 'GET'), null);
  assert.throws(() => localMediaContentRoute(url(recordPath.replace('/2/', '/2147483648/')), 'GET'), { code: 'INVALID_INPUT' });
  for (const path of [recordPath.replace('/revisions/2', ''), recordPath.replace('/content', '/original'),
    recordPath.replace(uploadId, 'not-a-uuid'), recordPath + '/']) assert.equal(localMediaContentRoute(url(path), 'GET'), null);
});

test('record content passes only its exact immutable record source to the existing authorized streamer', async (t) => {
  let calls = 0;
  const f = await fixture(t, { async open(actor, input) {
    calls++; assert.deepEqual(actor, identity);
    assert.deepEqual(input, { conversationId: 'synthetic-room', uploadId,
      source: { kind: 'record', recordId: 'synthetic-record', revision: 2 } });
    return opened();
  } });
  const response = await f.call({ path: recordPath }).result;
  assert.equal(response.status, 200); assert.deepEqual(response.body, bytes);
  assert.equal(response.headers['content-disposition'], 'attachment; filename="download.png"');
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(calls, 1);
});

test('feedback and record-reference descriptors require exact positive revisions with no alternate origin or query', () => {
  for (const [path, expected] of [
    [feedbackPath, { messageId: 'synthetic-message', feedbackRevision: 3 }],
    [referencePath, { recordId: 'synthetic-record', revision: 2, messageId: 'synthetic-message' }],
  ]) {
    const url = (value = path) => new URL(`http://127.0.0.1${value}`);
    assert.deepEqual(localMediaContentRoute(url(), 'GET'), { centerId: 'synthetic-center', conversationId: 'synthetic-room', ...expected, uploadId });
    for (const method of ['HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) assert.throws(() => localMediaContentRoute(url(), method), { code: 'NOT_FOUND' });
    for (const query of ['?revision=1', '?source=record', '?feedbackRevision=1']) assert.throws(() => localMediaContentRoute(url(path + query), 'GET'), { code: 'INVALID_INPUT' });
    const number = path === feedbackPath ? '3' : '2';
    for (const invalid of ['0', '-1', '01', '1.5', 'latest', `%3${number}`])
      assert.equal(localMediaContentRoute(url(path.replace(`/${number}/`, `/${invalid}/`)), 'GET'), null);
    assert.throws(() => localMediaContentRoute(url(path.replace(`/${number}/`, '/2147483648/')), 'GET'), { code: 'INVALID_INPUT' });
    for (const invalid of [path + '/', path.replace('/content', '/original'), path.replace(uploadId, 'missing'), path.replace('synthetic-message', '%73ynthetic-message')])
      assert.equal(localMediaContentRoute(url(invalid), 'GET'), null);
  }
});

test('feedback and record-reference content preserve their distinct exact MediaAccess anchors', async (t) => {
  const inputs = [];
  const f = await fixture(t, { async open(actor, input) { assert.deepEqual(actor, identity); inputs.push(input); return opened(); } });
  for (const path of [feedbackPath, referencePath]) {
    const response = await f.call({ path }).result;
    assert.equal(response.status, 200); assert.deepEqual(response.body, bytes);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['content-disposition'], 'attachment; filename="download.png"');
  }
  assert.deepEqual(inputs, [
    { conversationId: 'synthetic-room', uploadId, source: { kind: 'message', messageId: 'synthetic-message', feedbackRevision: 3 } },
    { conversationId: 'synthetic-room', uploadId, source: { kind: 'record-reference', recordId: 'synthetic-record', revision: 2, messageId: 'synthetic-message' } },
  ]);
});

test('all six approved types use immutable full-file metadata and generic names with private response headers', async (t) => {
  const types = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm' };
  let type, calls = 0;
  const f = await fixture(t, { async open(actor, input) {
    calls++; assert.deepEqual(actor, identity);
    assert.deepEqual(input, { conversationId: 'synthetic-room', uploadId, source: { kind: 'message', messageId: 'synthetic-message' } });
    return opened({ type });
  } });
  for (const [mime, extension] of Object.entries(types)) {
    type = mime;
    const response = await f.call().result;
    assert.equal(response.status, 200); assert.equal(response.aborted, false); assert.deepEqual(response.body, bytes);
    assert.equal(response.headers['content-type'], mime);
    assert.equal(response.headers['content-length'], String(bytes.length));
    assert.equal(response.headers['content-disposition'], `attachment; filename="download.${extension}"`);
    assert.equal(response.headers['accept-ranges'], 'none'); assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    for (const key of ['etag', 'last-modified', 'content-range', 'content-encoding', 'access-control-allow-origin', 'x-injected'])
      assert.equal(response.headers[key], undefined);
    assert(!JSON.stringify(response.headers).includes(secret));
  }
  assert.equal(calls, 6); assert.equal(f.errors.length, 0);
});

test('Range and conditional cache requests never become partial, 304, or an alternative authorization source', async (t) => {
  const inputs = [];
  const f = await fixture(t, { async open(_actor, input) { inputs.push(input); return opened(); } });
  for (const range of ['bytes=0-1', 'bytes=999999-', 'not-a-range']) {
    const response = await f.call({ headers: { Range: range, 'If-Range': secret, 'If-None-Match': '*', 'If-Modified-Since': new Date().toUTCString() } }).result;
    assert.equal(response.status, 200); assert.deepEqual(response.body, bytes); assert.equal(response.headers['accept-ranges'], 'none');
  }
  assert(inputs.every((input) => !Object.hasOwn(input, 'range')));
});

test('duplicate Range is rejected through the supplied strict header reader before opening any file', async (t) => {
  let calls = 0;
  const f = await fixture(t, { async open() { calls++; return opened(); } });
  const response = await f.call({ headers: ['Host', '127.0.0.1', 'Range', 'bytes=0-', 'range', 'bytes=1-'] }).result;
  assert.equal(response.status, 400); assert.equal(calls, 0);
});

test('missing service and unavailable or unauthorized sources return only fixed safe errors', async (t) => {
  let failure;
  const f = await fixture(t, { async open() { throw failure; } });
  for (const [code, expected, status] of [['NOT_FOUND', 'NOT_FOUND', 404], ['FORBIDDEN', 'FORBIDDEN', 404],
    ['CONTENT_UNAVAILABLE', 'NOT_FOUND', 404], ['INVALID_RANGE', 'NOT_FOUND', 404], ['UPLOAD_CONFLICT', 'UPLOAD_CONFLICT', 409],
    ['PRIVATE_INTERNAL_CODE', 'LOCAL_API_UNAVAILABLE', 503]]) {
    failure = Object.assign(new RepositoryError(code), { cause: new Error(secret), path: secret });
    const response = await f.call().result;
    assert.equal(response.status, status); assert.deepEqual(JSON.parse(response.body), { error: expected });
    const observed = f.errors.at(-1);
    assert.equal(observed.cause, undefined); assert.equal(observed.path, undefined);
  }
  failure = new Error(secret);
  assert.deepEqual(JSON.parse((await f.call().result).body), { error: 'LOCAL_API_UNAVAILABLE' });
  const absent = await fixture(t, undefined);
  assert.equal((await absent.call().result).status, 503);
});

test('invalid manifests, partial streams and unsafe media types are rejected before response bytes and closed', async (t) => {
  let value;
  const f = await fixture(t, { async open() { return value; } });
  const changes = [
    (v) => { v.attachment.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; },
    (v) => { v.attachment.type = 'image/svg+xml'; },
    (v) => { v.attachment.type = `image/png\r\nX-Injected: ${secret}`; },
    (v) => { v.attachment.size = 0; },
    (v) => { v.attachment.size = MEDIA_LIMITS.image + 1; },
    (v) => { v.attachment.type = 'video/mp4'; v.attachment.size = MEDIA_LIMITS.video + 1; },
    (v) => { v.attachment.size = 1.5; },
    (v) => { v.total++; }, (v) => { v.range.start = 1; }, (v) => { v.range.end--; },
    (v) => { v.stream.setEncoding('utf8'); },
    (v) => { v.stream.destroy(); },
  ];
  for (const change of changes) {
    value = opened(); change(value);
    const response = await f.call().result;
    assert.equal(response.status, 503); assert.deepEqual(JSON.parse(response.body), { error: 'LOCAL_API_UNAVAILABLE' });
    assert.equal(value.stream.destroyed, true);
  }
  value = opened({ stream: Readable.from([bytes]) }); // Object mode is forbidden.
  assert.equal((await f.call().result).status, 503); assert(value.stream.destroyed);
});

test('short and excessive byte streams fail closed without appending internal errors to media bytes', async (t) => {
  let value;
  const f = await fixture(t, { async open() { return value; } });
  for (const body of [bytes.subarray(0, 1), Buffer.concat([bytes, bytes])]) {
    value = opened({ stream: Readable.from([body], { objectMode: false }) });
    const response = await f.call().result;
    assert.equal(response.aborted, true); assert(value.stream.destroyed);
    assert(!response.body.includes(Buffer.from(secret))); assert(!response.body.includes(Buffer.from('LOCAL_API_UNAVAILABLE')));
  }
});

test('an internal stream error after headers destroys the response without exposing details', async (t) => {
  let source;
  const f = await fixture(t, { async open() {
    source = new Readable({ read() { this.push(bytes.subarray(0, 1)); this._read = () => {}; setImmediate(() => this.destroy(new Error(secret))); } });
    return opened({ stream: source });
  } });
  const response = await f.call().result;
  assert.equal(response.aborted, true); assert(source.destroyed); assert(!response.body.includes(Buffer.from(secret)));
});

test('a client disconnect destroys its open stream and leaves a subsequent read usable', async (t) => {
  let first = true, source;
  const f = await fixture(t, { async open() {
    if (!first) return opened();
    first = false; source = new Readable({ read() { this.push(bytes.subarray(0, 1)); this._read = () => {}; } });
    return opened({ stream: source });
  } });
  const request = f.call({ onData: (req) => req.destroy() });
  assert.equal((await request.result).aborted, true);
  await until(() => source.closed);
  assert.equal((await f.call().result).status, 200);
});

test('two pending opens share the service cap across listeners, retain it after disconnect, and close late streams', async (t) => {
  const gates = [deferred(), deferred()]; let calls = 0;
  t.after(() => { for (const gate of gates) if (!gate.settled) gate.resolve(opened()); });
  const access = { async open() { const i = calls++; return i < 2 ? gates[i].promise : opened(); } };
  const a = await fixture(t, access), b = await fixture(t, access);
  const first = a.call(), second = b.call();
  await until(() => calls === 2);
  first.request.destroy(); second.request.destroy(); await Promise.all([first.result, second.result]);
  assert.equal((await a.call().result).status, 409); assert.equal(calls, 2);
  const late = [opened(), opened()]; gates[0].resolve(late[0]); gates[1].resolve(late[1]);
  await until(() => late.every((value) => value.stream.closed));
  assert.equal((await b.call().result).status, 200); assert.equal(calls, 3);
});

test('active reads also share the cap and do not release it before asynchronous destroy completes', async (t) => {
  const gates = [deferred(), deferred()], sources = [];
  t.after(() => { gates.forEach((gate) => gate.resolve()); });
  let calls = 0;
  const f = await fixture(t, { async open() {
    const i = calls++;
    if (i >= 2) return opened();
    const stream = new Readable({ read() { this.push(bytes.subarray(0, 1)); this._read = () => {}; },
      destroy(_error, callback) { gates[i].promise.then(() => callback()); } });
    sources.push(stream); return opened({ stream });
  } });
  const first = f.call({ onData: (req) => req.destroy() }), second = f.call({ onData: (req) => req.destroy() });
  await Promise.all([first.result, second.result]);
  await until(() => sources.length === 2 && sources.every((source) => source.destroyed));
  assert.equal((await f.call().result).status, 409); assert.equal(calls, 2);
  gates.forEach((gate) => gate.resolve());
  await until(() => sources.every((source) => source.closed));
  assert.equal((await f.call().result).status, 200);
});

test('a failed open releases capacity and an independent service is not blocked by another service', async (t) => {
  const gates = [deferred(), deferred()]; let calls = 0;
  t.after(() => { for (const gate of gates) if (!gate.settled) gate.resolve(opened()); });
  const a = await fixture(t, { async open() { const i = calls++; return i < 2 ? gates[i].promise : opened(); } });
  const first = a.call(), second = a.call(); await until(() => calls === 2);
  const b = await fixture(t, { async open() { return opened(); } });
  assert.equal((await b.call().result).status, 200);
  gates[0].reject(new Error(secret)); gates[1].reject(new Error(secret));
  assert.equal((await first.result).status, 503); assert.equal((await second.result).status, 503);
  assert.equal((await a.call().result).status, 200);
});

test('the fixed 30-second deadline includes a pending open and a late result is destroyed', async (t) => {
  const gate = deferred(); let calls = 0;
  t.after(() => { if (!gate.settled) gate.resolve(opened()); });
  const access = { async open() { calls++; return gate.promise; } };
  const f = await fixture(t, access);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.call(); await until(() => calls === 1);
  t.mock.timers.tick(30_001);
  const response = await pending.result;
  assert.equal(response.status, 408); assert.deepEqual(JSON.parse(response.body), { error: 'REQUEST_TIMEOUT' });
  let drained = false;
  const completion = drainLocalMediaContent(access).then(() => { drained = true; });
  await new Promise(setImmediate); assert.equal(drained, false);
  const late = opened(); gate.resolve(late); await until(() => late.stream.closed);
  await completion; assert.equal(drained, true);
  t.mock.timers.reset();
});

test('the same deadline bounds a stalled response and does not expose a timeout payload inside the file', async (t) => {
  let source, dataSeen = false;
  const f = await fixture(t, { async open() {
    source = new Readable({ read() { this.push(bytes.subarray(0, 1)); this._read = () => {}; } });
    return opened({ stream: source });
  } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.call({ onData: () => { dataSeen = true; } }); await until(() => dataSeen);
  t.mock.timers.tick(30_001);
  const response = await pending.result; assert.equal(response.aborted, true);
  await until(() => source.closed); assert(!response.body.includes(Buffer.from('REQUEST_TIMEOUT')));
  t.mock.timers.reset();
});

test('draining an unused service is idempotent and permanently closes only that service to new reads', async (t) => {
  let calls = 0;
  const access = { async open() { calls++; return opened(); } };
  await Promise.all([drainLocalMediaContent(access), drainLocalMediaContent(access)]);
  const f = await fixture(t, access);
  for (let i = 0; i < 2; i++) {
    const result = await f.call().result;
    assert.equal(result.status, 503); assert.deepEqual(JSON.parse(result.body), { error: 'LOCAL_API_UNAVAILABLE' });
  }
  assert.equal(calls, 0);
  await drainLocalMediaContent(access);
  const independent = await fixture(t, { async open() { return opened(); } });
  assert.equal((await independent.call().result).status, 200);
});

test('drain waits past disconnected HTTP for a late open and its asynchronous destruction', async (t) => {
  const opening = deferred(), destroying = deferred(); let calls = 0;
  t.after(() => { if (!opening.settled) opening.resolve(opened()); destroying.resolve(); });
  const access = { async open() { calls++; return opening.promise; } };
  const f = await fixture(t, access), pending = f.call();
  await until(() => calls === 1);
  pending.request.destroy(); await pending.result;
  let completions = 0;
  const drains = [drainLocalMediaContent(access), drainLocalMediaContent(access)].map((promise) =>
    promise.then(() => { completions++; }));
  await new Promise(setImmediate); assert.equal(completions, 0);
  const refused = await f.call().result;
  assert.equal(refused.status, 503); assert.equal(calls, 1);
  const stream = new Readable({ read() {}, destroy(_error, done) { destroying.promise.then(() => done()); } });
  opening.resolve(opened({ stream }));
  await until(() => stream.destroyed);
  assert.equal(stream.closed, false); assert.equal(completions, 0);
  destroying.resolve(); await Promise.all(drains);
  assert.equal(stream.closed, true); assert.equal(completions, 2);
});

test('drain observes both listeners without aborting active transfers and waits for every disposal', async (t) => {
  const destroying = [deferred(), deferred()], sources = [];
  t.after(() => { destroying.forEach((gate) => gate.resolve()); });
  const access = { async open() {
    const i = sources.length;
    const stream = new Readable({ read() { this.push(bytes.subarray(0, 1)); this._read = () => {}; },
      destroy(_error, done) { destroying[i].promise.then(() => done()); } });
    sources.push(stream); return opened({ stream });
  } };
  const a = await fixture(t, access), b = await fixture(t, access);
  let dataSeen = 0;
  const first = a.call({ onData: () => { dataSeen++; } });
  await until(() => dataSeen === 1);
  const second = b.call({ onData: () => { dataSeen++; } });
  await until(() => dataSeen === 2);
  let drained = false;
  const completion = drainLocalMediaContent(access).then(() => { drained = true; });
  await new Promise(setImmediate);
  assert.equal(drained, false); assert(sources.every((stream) => !stream.destroyed));
  assert.equal((await a.call().result).status, 503); assert.equal(sources.length, 2);
  first.request.destroy(); await first.result;
  await until(() => sources[0].destroyed);
  destroying[0].resolve(); await until(() => sources[0].closed);
  assert.equal(drained, false); assert.equal(sources[1].destroyed, false);
  second.request.destroy(); await second.result;
  await until(() => sources[1].destroyed);
  assert.equal(drained, false);
  destroying[1].resolve(); await completion;
  assert(sources.every((stream) => stream.closed));
});

test('previous and pending failed opens do not turn fully settled drain into an error', async (t) => {
  const opening = deferred(); let calls = 0;
  t.after(() => { if (!opening.settled) opening.reject(new Error(secret)); });
  const access = { async open() { if (++calls === 1) throw new Error(secret); return opening.promise; } };
  const f = await fixture(t, access);
  assert.equal((await f.call().result).status, 503);
  const pending = f.call(); await until(() => calls === 2);
  let drained = false;
  const completion = drainLocalMediaContent(access).then(() => { drained = true; });
  await new Promise(setImmediate); assert.equal(drained, false);
  opening.reject(new Error(secret));
  assert.equal((await pending.result).status, 503);
  await completion; assert.equal(drained, true);
  await drainLocalMediaContent(access);
});

test('readable end without autoDestroy is not mistaken for completed asynchronous resource disposal', async (t) => {
  const destroying = deferred(); let source;
  t.after(() => { destroying.resolve(); });
  const access = { async open() {
    source = new Readable({ autoDestroy: false, read() { this.push(bytes); this.push(null); },
      destroy(_error, done) { destroying.promise.then(() => done()); } });
    return opened({ stream: source });
  } };
  const f = await fixture(t, access);
  const response = await f.call().result;
  assert.equal(response.status, 200); assert.deepEqual(response.body, bytes);
  await until(() => source.destroyed);
  assert.equal(source.readableEnded, true); assert.equal(source.closed, false);
  let drained = false;
  const completion = drainLocalMediaContent(access).then(() => { drained = true; });
  await new Promise(setImmediate); assert.equal(drained, false);
  destroying.resolve(); await completion;
  assert.equal(source.closed, true);
});

test('same-turn admission is tracked before open starts and cannot slip past a closing service', async () => {
  // Event doubles expose the exact synchronous admission boundary. No file
  // bytes are sent in this test; the admitted service open fails safely.
  const req = Object.assign(new EventEmitter(), { aborted: false, rawHeaders: [], headers: {} });
  const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, headersSent: false });
  const route = localMediaContentRoute(new URL(`http://127.0.0.1${routePath}`), 'GET');
  const opening = deferred(); let calls = 0, drained = false;
  const access = { async open() { calls++; return opening.promise; } };
  const pending = streamLocalMediaContent(route, identity, { mediaAccess: access }, req, res, header)
    .then(() => null, (error) => error.code);
  assert.equal(calls, 0);
  const completion = drainLocalMediaContent(access).then(() => { drained = true; });
  try {
    await assert.rejects(streamLocalMediaContent(route, identity, { mediaAccess: access }, req, res, header),
      { code: 'LOCAL_API_UNAVAILABLE' });
    assert.equal(calls, 1); assert.equal(drained, false);
  } finally { opening.reject(new Error(secret)); }
  assert.equal(await pending, 'LOCAL_API_UNAVAILABLE'); await completion;
  assert.equal(drained, true); assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);

  let headerDrain, lateCalls = 0;
  const other = { async open() { lateCalls++; return opened(); } };
  await assert.rejects(streamLocalMediaContent(route, identity, { mediaAccess: other }, req, res,
    () => { headerDrain = drainLocalMediaContent(other); }), { code: 'LOCAL_API_UNAVAILABLE' });
  await headerDrain; assert.equal(lateCalls, 0);
});

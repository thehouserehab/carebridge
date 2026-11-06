import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { LocalApiClient, LOCAL_MEDIA_CONFLICT_CODES } from '../local-api/client.js';
import { MediaApiClient, MediaApiError, mediaFileManifest } from '../local-api/media-client.js';
import { MEDIA_LIMITS } from '../src/media-policy.js';

const scope = () => ({ userId: 'synthetic-user', centerId: 'synthetic-center', roomId: 'synthetic-room' });
const uploadId = '12345678-1234-4234-8234-123456789abc';
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const file = (name = 'synthetic.png') => new File([bytes], name, { type: 'image/png' });
const manifest = () => ({ name: 'synthetic.png', type: 'image/png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
const dto = (changes = {}) => ({ id: uploadId, conversationId: scope().roomId, name: 'synthetic.png', type: 'image/png', size: bytes.length,
  state: 'pending', version: 1, failureCode: null, expiresAt: '2030-01-01T00:00:00Z', expired: false, ...changes });
const body = (changes = {}) => ({ mode: 'quarantine-only', upload: dto(changes) });
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });
const code = (value) => (error) => error instanceof MediaApiError && error.code === value;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function client(fetch, options) { const api = new LocalApiClient({ fetch }); api.expectedUserId = scope().userId; return { api, media: new MediaApiClient(api, options) }; }

test('format hint and SHA-256 produce an exact immutable manifest without approving a file', async () => {
  const result = await mediaFileManifest(file());
  assert.deepEqual(result, manifest()); assert(Object.isFrozen(result));
  assert.deepEqual(Object.keys(result), ['name', 'type', 'size', 'sha256']);
  assert.equal((await mediaFileManifest(file(' synthetic.png '))).name, 'synthetic.png');
});
test('unsupported content, names, empty files and cancelled hashing fail safely', async () => {
  for (const bad of [new File([], 'empty.png', { type: 'image/png' }), new File(['not png'], 'wrong.png', { type: 'image/png' }),
    new File(['svg'], 'a.svg', { type: 'image/svg+xml' }), file('../escape.png'), file('a\nb.png'), file('x'.repeat(256))])
    await assert.rejects(mediaFileManifest(bad), code('MEDIA_INVALID_FILE'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(mediaFileManifest(file(), controller.signal), code('CANCELLED'));
});
test('reserve uses same-origin JSON authentication and captures mutable inputs before await', async () => {
  const wait = deferred(); let call;
  const { media } = client(async (path, options) => { call = { path, options }; await wait.promise; return json(body()); });
  const s = scope(), original = manifest(), operation = { clientId: 'synthetic-request-1', file: original };
  const pending = media.reserve(s, operation);
  original.sha256 = '0'.repeat(64); original.name = 'CHANGED'; operation.clientId = 'DIFFERENT'; s.roomId = 'other';
  wait.resolve(); const result = await pending;
  assert.equal(call.path, `/api/local/centers/${scope().centerId}/conversations/${scope().roomId}/uploads`);
  assert.deepEqual(JSON.parse(call.options.body), { clientId: 'synthetic-request-1', file: manifest() });
  assert.equal(call.options.headers['X-Carebridge-Account'], scope().userId);
  assert.equal(call.options.headers['X-Carebridge-Request'], '1');
  assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.cache, 'no-store'); assert.equal(call.options.redirect, 'error');
  assert(Object.isFrozen(result)); assert.deepEqual(result, dto());
});
test('response DTO rejects extra secret fields, other rooms/IDs, approval states and malformed metadata', async () => {
  const invalid = [body({ objectKey: 'PRIVATE' }), body({ sha256: 'PRIVATE' }), { ...body(), privatePath: 'PRIVATE' },
    { ...body(), mode: 'ready' }, body({ state: 'ready' }), body({ state: 'bound' }), body({ state: 'inspecting' }),
    body({ conversationId: 'foreign-room' }), body({ id: 'not-uuid' }), body({ version: 0 }), body({ size: 0 }),
    body({ expiresAt: null }), body({ failureCode: 'PRIVATE SQL' }), body({ replayed: 'true' }), body({ name: '<bad>\n.png' })];
  for (const value of invalid) {
    const { media } = client(async () => json(value));
    await assert.rejects(media.get(scope(), uploadId), (error) => code('INVALID_RESPONSE')(error) && !error.message.includes('PRIVATE'));
  }
});
test('reserve cannot silently adopt a mismatched file and accepts only the expected upload ID', async () => {
  await assert.rejects(client(async () => json(body({ size: bytes.length + 1 }))).media.reserve(scope(), { clientId: 'synthetic-request', file: manifest() }), code('INVALID_RESPONSE'));
  await assert.rejects(client(async () => json(body({ id: '22345678-1234-4234-8234-123456789abc' }))).media.get(scope(), uploadId), code('INVALID_RESPONSE'));
});
test('scope, ID and manifest injection are rejected before any request', async () => {
  let calls = 0; const { media } = client(async () => { calls++; return json(body()); });
  for (const roomId of ['../other', 'https://other.test', 'a/b', 'a?b', 'a%2Fb']) await assert.rejects(media.get({ ...scope(), roomId }, uploadId), code('INVALID_INPUT'));
  await assert.rejects(media.get({ ...scope(), role: 'center' }, uploadId), code('INVALID_INPUT'));
  await assert.rejects(media.get(scope(), '../content'), code('INVALID_INPUT'));
  await assert.rejects(media.reserve(scope(), { clientId: 'synthetic-request', file: { ...manifest(), path: 'PRIVATE' } }), code('INVALID_INPUT'));
  assert.equal(calls, 0);
});
test('binary upload sends the immutable File, explicit version and fixed account without content-length spoofing', async () => {
  let call; const input = file();
  const { media } = client(async (path, options) => { call = { path, options }; return json(body({ state: 'quarantined', version: 3 })); });
  const result = await media.receive(scope(), dto(), input);
  assert(call.path.endsWith(`/uploads/${uploadId}/content`)); assert.equal(call.options.body, input);
  assert.equal(call.options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(call.options.headers['X-Carebridge-Upload-Version'], '1');
  assert.equal(call.options.headers['X-Carebridge-Account'], scope().userId); assert.equal(call.options.headers['X-Carebridge-Request'], '1');
  assert.equal(Object.keys(call.options.headers).some((k) => k.toLowerCase() === 'content-length'), false);
  assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.redirect, 'error'); assert.equal(call.options.cache, 'no-store');
  assert.equal(result.state, 'quarantined');
});
test('binary upload refuses receiving, expired, wrong-sized or different-kind files before sending', async () => {
  let calls = 0; const { media } = client(async () => { calls++; return json(body()); });
  for (const u of [dto({ state: 'receiving' }), dto({ expired: true }), dto({ version: 0 }), dto({ conversationId: 'foreign' })])
    await assert.rejects(media.receive(scope(), u, file()), code('INVALID_INPUT'));
  await assert.rejects(media.receive(scope(), dto({ size: bytes.length + 1 }), file()), code('INVALID_RESPONSE'));
  assert.equal(calls, 0);
});
test('account binding is checked before and after both JSON and binary reads', async () => {
  for (const binary of [false, true]) {
    const gate = deferred(); const { api, media } = client(async () => { await gate.promise; return json(body(binary ? { state: 'quarantined', version: 3 } : {})); });
    const pending = binary ? media.receive(scope(), dto(), file()) : media.get(scope(), uploadId);
    api.expectedUserId = 'other-account'; gate.resolve(); await assert.rejects(pending, code('AUTH_REQUIRED'));
    await assert.rejects(media.get(scope(), uploadId), code('AUTH_REQUIRED'));
  }
});
test('binary timeout and explicit abort are unknown/safe outcomes with no raw server detail', async () => {
  const waiting = (_path, { signal }) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new Error('PRIVATE')), { once: true }); });
  await assert.rejects(client(waiting, { timeoutMs: 5 }).media.receive(scope(), dto(), file()), code('UNAVAILABLE'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client(waiting).media.receive(scope(), dto(), file(), controller.signal), code('CANCELLED'));
  for (const [status, expected] of [[400, 'INVALID_INPUT'], [401, 'AUTH_REQUIRED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [409, 'UNAVAILABLE'], [500, 'UNAVAILABLE']]) {
    const { media } = client(async () => json({ error: 'PRIVATE', message: 'PRIVATE' }, status));
    await assert.rejects(media.receive(scope(), dto(), file()), (e) => code(expected)(e) && !e.message.includes('PRIVATE'));
  }
});
test('known media conflict codes keep the shared safe message without exposing unknown server text', async () => {
  for (const expected of [...LOCAL_MEDIA_CONFLICT_CODES, 'IDEMPOTENCY_CONFLICT']) {
    const { media } = client(async () => json({ error: expected, message: 'PRIVATE DETAILS' }, 409));
    await assert.rejects(media.receive(scope(), dto(), file()), (e) => code(expected)(e) && !e.message.includes('PRIVATE'));
  }
});
test('cancel is a version-pinned JSON request and neither returned manifests nor errors contain private fields', async () => {
  let call; const { media } = client(async (path, options) => { call = { path, options }; return json(body({ state: 'delete_pending', version: 4 })); });
  const result = await media.cancel(scope(), dto({ state: 'quarantined', version: 3 }));
  assert(call.path.endsWith('/cancel')); assert.deepEqual(JSON.parse(call.options.body), { expectedVersion: 3 });
  assert.equal(result.state, 'delete_pending'); assert.equal('sha256' in result, false); assert.equal('objectKey' in result, false);
});
test('late binary response after deadline or an abort during response decoding is never accepted', async () => {
  const { media } = client(async () => { await new Promise((done) => setTimeout(done, 10)); return json(body({ state: 'quarantined', version: 3 })); }, { timeoutMs: 2 });
  await assert.rejects(media.receive(scope(), dto(), file()), code('UNAVAILABLE'));
  const controller = new AbortController();
  const other = client(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => { controller.abort(); return body({ state: 'quarantined', version: 3 }); } })).media;
  await assert.rejects(other.receive(scope(), dto(), file(), controller.signal), code('CANCELLED'));
});

const sourceMetadata = (extra = {}) => ({ name: 'synthetic.png', type: 'image/png', size: bytes.length, ...extra });
const prepared = (changes = {}, source = {}) => ({ mode: 'prepared-delivery', upload: dto(changes), source: sourceMetadata(source) });
const attachment = (extra = {}) => ({ id: uploadId, ...sourceMetadata(), ...extra });
const messageId = 'synthetic-message';

test('prepared delivery requires exact frozen source metadata and accepts inspection/ready/bound without altering quarantine DTOs', async () => {
  for (const state of ['pending', 'receiving', 'quarantined', 'inspecting', 'rejected', 'ready', 'bound', 'delete_pending', 'deleted']) {
    const changes = { state, ...(state === 'bound' ? { expiresAt: null } : {}) };
    const result = await client(async () => json(prepared(changes))).media.get(scope(), uploadId);
    assert.equal(result.mode, 'prepared-delivery'); assert.deepEqual(result.source, sourceMetadata());
    assert(Object.isFrozen(result)); assert(Object.isFrozen(result.source));
    assert.throws(() => { result.source.size = 1; }, TypeError);
    assert.equal(JSON.stringify(result).includes('sha256'), false);
  }
  assert.deepEqual(await client(async () => json(body())).media.get(scope(), uploadId), dto());
});
test('reserve replays and receive confirmations compare immutable source size, not a smaller prepared candidate', async () => {
  const ready = prepared({ state: 'ready', size: 5, replayed: true, version: 5 });
  const c = client(async () => json(ready)).media;
  const received = await c.reserve(scope(), { clientId: 'synthetic-request', file: manifest() });
  assert.equal(received.size, 5); assert.equal(received.source.size, bytes.length);
  const input = await client(async () => json(prepared())).media.get(scope(), uploadId);
  const result = await c.receive(scope(), input, file()); assert.equal(result.size, 5);
  for (const state of ['delete_pending', 'deleted']) {
    const cancelled = await client(async () => json(prepared({ state, size: 5, version: 6 }))).media.cancel(scope(), received);
    assert.equal(cancelled.size, 5); assert.equal(cancelled.source.size, bytes.length);
  }
});
test('prepared source mismatches, early candidate substitution and wrong bound expiry fail closed', async () => {
  const invalid = [ { mode: 'prepared-delivery', upload: dto() }, { ...prepared(), source: { ...sourceMetadata(), sha256: 'PRIVATE' } },
    prepared({}, { name: 'different.png' }), prepared({}, { type: 'video/webm' }), prepared({}, { size: 0 }),
    prepared({ state: 'bound' }), prepared({ state: 'bound', expiresAt: null, expired: true }),
    prepared({ state: 'ready', expiresAt: null }), prepared({ state: 'ready', size: MEDIA_LIMITS.image + 1 }),
    ...['pending', 'receiving', 'quarantined', 'inspecting', 'rejected'].map((state) => prepared({ state, size: 5 })),
    { ...body(), source: sourceMetadata() } ];
  for (const value of invalid) await assert.rejects(client(async () => json(value)).media.get(scope(), uploadId), code('INVALID_RESPONSE'));
  await assert.rejects(client(async () => json(prepared({ state: 'ready', size: 5 }, { size: 100 }))).media.reserve(scope(),
    { clientId: 'synthetic-request', file: manifest() }), code('INVALID_RESPONSE'));
});

// WHAT THIS PROVES: byte-count/type/authentication/deadline client handling.
// Synthetic network streams are not a server, real decoder or malware scan.
function streamingResponse(chunks = [bytes], { status = 200, headers = {}, afterRead, readErrorAt = 0, stalled = false } = {}) {
  const metrics = { reads: 0, readerCancel: 0, released: 0, bodyCancel: 0 };
  const stream = new ReadableStream({ start(controller) {
    if (!stalled) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); }
  } });
  const rawGetReader = stream.getReader.bind(stream), rawCancel = stream.cancel.bind(stream);
  stream.getReader = () => {
    const reader = rawGetReader();
    return { read: async () => {
      metrics.reads++;
      if (readErrorAt === metrics.reads) throw new Error('PRIVATE transport diagnostics');
      const result = await reader.read(); await afterRead?.(metrics.reads, result); return result;
    }, cancel: async () => { metrics.readerCancel++; return reader.cancel(); },
    releaseLock: () => { metrics.released++; reader.releaseLock(); } };
  };
  stream.cancel = async () => { metrics.bodyCancel++; return rawCancel(); };
  const responseHeaders = new Headers({ 'Content-Type': 'image/png', 'Content-Length': String(bytes.length) });
  for (const [key, value] of Object.entries(headers)) if (value === null) responseHeaders.delete(key); else responseHeaders.set(key, value);
  return { response: { status, ok: status >= 200 && status < 300, headers: responseHeaders, body: stream, redirected: false }, stream, metrics };
}

test('bound media GET captures immutable identifiers and returns a typed Blob from bounded chunks only', async () => {
  const gate = deferred(), chunks = [bytes.slice(0, 4), bytes.slice(4)], r = streamingResponse(chunks);
  let call; const { media } = client(async (path, options) => { call = { path, options }; await gate.promise; return r.response; });
  const s = scope(), expected = attachment();
  const pending = media.openMessageAttachment(s, messageId, expected);
  s.roomId = 'other-room'; expected.id = 'other-id'; expected.size = 1; expected.type = 'video/webm'; gate.resolve();
  const blob = await pending;
  assert.equal(call.path, `/api/local/centers/${scope().centerId}/conversations/${scope().roomId}/messages/${messageId}/attachments/${uploadId}/content`);
  assert.equal(call.options.method, 'GET'); assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.cache, 'no-store'); assert.equal(call.options.redirect, 'error');
  assert.equal(call.options.headers['X-Carebridge-Account'], scope().userId); assert.equal(call.options.headers.Accept, 'image/png');
  assert(!Object.hasOwn(call.options.headers, 'Range')); assert(!Object.hasOwn(call.options, 'body'));
  assert(blob instanceof Blob); assert.equal(blob.type, 'image/png'); assert.equal(blob.size, bytes.length);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  assert.equal(r.metrics.released, 1); assert.equal(r.metrics.readerCancel, 0); assert.equal(r.stream.locked, false);
});
test('video metadata uses the same authenticated read contract without special unguarded URLs', async () => {
  const r = streamingResponse([bytes], { headers: { 'Content-Type': 'video/webm' } });
  const blob = await client(async () => r.response).media.openMessageAttachment(scope(), messageId,
    attachment({ name: 'synthetic.webm', type: 'video/webm' }));
  assert.equal(blob.type, 'video/webm'); assert.equal(blob.size, bytes.length);
});

test('record reads require an exact immutable revision and share the bounded authenticated reader', async () => {
  const r = streamingResponse(), expected = attachment(); let call;
  const { media } = client(async (path, options) => { call = { path, options }; return r.response; });
  const blob = await media.openRecordAttachment(scope(), 'synthetic-record', 3, expected);
  assert.equal(call.path, `/api/local/centers/${scope().centerId}/conversations/${scope().roomId}/records/synthetic-record/revisions/3/attachments/${uploadId}/content`);
  assert.equal(call.options.headers['X-Carebridge-Account'], scope().userId);
  assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.cache, 'no-store');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes); assert.equal(r.metrics.released, 1);
  let requests = 0; const blocked = client(async () => { requests++; return streamingResponse().response; }).media;
  for (const revision of [undefined, null, '1', 0, -1, 1.5, 2147483648, Infinity])
    await assert.rejects(blocked.openRecordAttachment(scope(), 'synthetic-record', revision, expected), code('INVALID_INPUT'));
  for (const recordId of ['../record', 'https://foreign.test', 'id?revision=1', 'id%2Fother'])
    await assert.rejects(blocked.openRecordAttachment(scope(), recordId, 1, expected), code('INVALID_INPUT'));
  assert.equal(requests, 0);
});

test('record read interruption, account replacement and invalid content release bytes without a fallback URL', async () => {
  for (const scenario of ['wrong-type', 'short', 'account', 'abort']) {
    const controller = new AbortController(); let api;
    const r = streamingResponse(scenario === 'short' ? [bytes.slice(0, 2)] : [bytes], {
      ...(scenario === 'wrong-type' ? { headers: { 'Content-Type': 'text/html' } } : {}),
      afterRead: () => { if (scenario === 'account') api.expectedUserId = 'other-user'; if (scenario === 'abort') controller.abort(); },
    });
    const result = client(async () => r.response); api = result.api;
    await assert.rejects(result.media.openRecordAttachment(scope(), 'synthetic-record', 1, attachment(), controller.signal),
      code(scenario === 'account' ? 'AUTH_REQUIRED' : scenario === 'abort' ? 'CANCELLED' : 'INVALID_RESPONSE'));
    assert.equal(r.stream.locked, false);
    assert.equal(scenario === 'wrong-type' ? r.metrics.bodyCancel : r.metrics.released, 1);
  }
});

test('feedback-version and record-reference readers use only exact validated anchors with the bounded reader', async () => {
  for (const kind of ['feedback', 'reference']) {
    let call;
    const r = streamingResponse();
    const { media } = client(async (path, options) => { call = { path, options }; return r.response; });
    const read = (revision = 2, target = 'synthetic-message', file = attachment()) => kind === 'feedback'
      ? media.openFeedbackAttachment(scope(), target, revision, file)
      : media.openReferenceAttachment(scope(), 'synthetic-record', revision, target, file);
    const blob = await read();
    const anchor = kind === 'feedback' ? 'messages/synthetic-message/feedback-revisions/2'
      : 'records/synthetic-record/revisions/2/references/synthetic-message';
    assert.equal(call.path, `/api/local/centers/${scope().centerId}/conversations/${scope().roomId}/${anchor}/attachments/${uploadId}/content`);
    assert.equal(call.options.headers['X-Carebridge-Account'], scope().userId);
    assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.redirect, 'error');
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes); assert.equal(r.metrics.released, 1);
    call = null;
    for (const revision of [null, '1', 0, -1, 1.5, 2147483648]) await assert.rejects(read(revision), code('INVALID_INPUT'));
    for (const target of ['../source', 'https://foreign.test', 'a?b', 'a%2Fb']) await assert.rejects(read(2, target), code('INVALID_INPUT'));
    await assert.rejects(read(2, 'synthetic-message', attachment({ originalUrl: 'PRIVATE' })), code('INVALID_INPUT'));
    await assert.rejects(media.openReferenceAttachment(scope(), '../record', 2, 'synthetic-message', attachment()), code('INVALID_INPUT'));
    assert.equal(call, null);
  }
});

test('feedback and reference downloads discard aborted, replaced-account and wrong-type responses', async () => {
  for (const kind of ['feedback', 'reference']) for (const scenario of ['wrong-type', 'account', 'abort']) {
    let api; const controller = new AbortController();
    const r = streamingResponse([bytes], {
      ...(scenario === 'wrong-type' ? { headers: { 'Content-Type': 'text/html' } } : {}),
      afterRead: () => { if (scenario === 'account') api.expectedUserId = 'other-user'; if (scenario === 'abort') controller.abort(); },
    });
    const result = client(async () => r.response); api = result.api;
    const pending = kind === 'feedback'
      ? result.media.openFeedbackAttachment(scope(), messageId, 2, attachment(), controller.signal)
      : result.media.openReferenceAttachment(scope(), 'synthetic-record', 2, messageId, attachment(), controller.signal);
    await assert.rejects(pending, code(scenario === 'account' ? 'AUTH_REQUIRED' : scenario === 'abort' ? 'CANCELLED' : 'INVALID_RESPONSE'));
    assert.equal(r.stream.locked, false);
    assert.equal(scenario === 'wrong-type' ? r.metrics.bodyCancel : r.metrics.released, 1);
  }
});
test('invalid file metadata, path injection and oversized declarations fail before fetch or allocating a download buffer', async () => {
  let calls = 0; const { media } = client(async () => { calls++; return streamingResponse().response; });
  for (const value of [attachment({ objectKey: 'PRIVATE' }), attachment({ id: '../file' }), attachment({ name: '../file.png' }),
    attachment({ name: ' padded.png ' }), attachment({ type: 'image/svg+xml' }), attachment({ size: 0 }),
    attachment({ size: MEDIA_LIMITS.image + 1 }), attachment({ type: 'video/webm', size: MEDIA_LIMITS.video + 1 })])
    await assert.rejects(media.openMessageAttachment(scope(), messageId, value), code('INVALID_INPUT'));
  for (const target of ['../source', 'https://foreign.test', 'a?b', 'a%2Fb'])
    await assert.rejects(media.openMessageAttachment(scope(), target, attachment()), code('INVALID_INPUT'));
  assert.equal(calls, 0);
});
test('non-exact type/length, encoded content, partial responses and redirects are rejected without reading bytes', async () => {
  const cases = [ { headers: { 'Content-Type': 'image/jpeg' } }, { headers: { 'Content-Type': 'image/png; charset=utf-8' } },
    { headers: { 'Content-Length': null } }, { headers: { 'Content-Length': '0' } }, { headers: { 'Content-Length': '11, 11' } },
    { headers: { 'Content-Length': String(bytes.length + 1) } }, { headers: { 'Content-Length': '99999999999999999' } },
    { headers: { 'Content-Range': 'bytes 0-10/11' } }, { headers: { 'Content-Encoding': 'gzip' } }, { status: 206 }, { redirected: true } ];
  for (const options of cases) {
    const r = streamingResponse([bytes], options); if (options.redirected) r.response.redirected = true;
    await assert.rejects(client(async () => r.response).media.openMessageAttachment(scope(), messageId, attachment()), code('INVALID_RESPONSE'));
    assert.equal(r.metrics.reads, 0); assert.equal(r.metrics.bodyCancel, 1); assert.equal(r.stream.locked, false);
  }
});
test('oversized, short or non-byte stream chunks cannot become a Blob and always release their reader', async () => {
  const cases = [ [new Uint8Array(bytes.length + 1)], [bytes.slice(0, 3)], [bytes.slice(0, 6), bytes.slice(0, 6)], ['PRIVATE non-byte data'] ];
  for (const chunks of cases) {
    const r = streamingResponse(chunks);
    await assert.rejects(client(async () => r.response).media.openMessageAttachment(scope(), messageId, attachment()), code('INVALID_RESPONSE'));
    assert.equal(r.metrics.released, 1); assert.equal(r.stream.locked, false);
    if (chunks.length !== 1 || chunks[0]?.length !== 3) assert.equal(r.metrics.readerCancel, 1);
  }
});
test('network interruption mid-body cancels and unlocks the stream without exposing diagnostic text', async () => {
  const r = streamingResponse([bytes.slice(0, 4), bytes.slice(4)], { readErrorAt: 2 });
  await assert.rejects(client(async () => r.response).media.openMessageAttachment(scope(), messageId, attachment()),
    (e) => code('UNAVAILABLE')(e) && !e.message.includes('PRIVATE'));
  assert.equal(r.metrics.readerCancel, 1); assert.equal(r.metrics.released, 1); assert.equal(r.stream.locked, false);
});
test('explicit abort while a body read is pending cancels the reader and returns no partial data', async () => {
  const r = streamingResponse([], { stalled: true }), controller = new AbortController(), started = deferred();
  const raw = r.stream.getReader; r.stream.getReader = () => { const reader = raw(); const read = reader.read; reader.read = () => { started.resolve(); return read(); }; return reader; };
  const pending = client(async () => r.response).media.openMessageAttachment(scope(), messageId, attachment(), controller.signal);
  await started.promise; controller.abort(); await assert.rejects(pending, code('CANCELLED'));
  assert.equal(r.metrics.readerCancel, 1); assert.equal(r.metrics.released, 1); assert.equal(r.stream.locked, false);
});
test('body deadline cancels a stalled read and late fetch responses are discarded and closed', async () => {
  const stalled = streamingResponse([], { stalled: true });
  await assert.rejects(client(async () => stalled.response, { timeoutMs: 5 }).media.openMessageAttachment(scope(), messageId, attachment()), code('UNAVAILABLE'));
  assert.equal(stalled.metrics.readerCancel, 1); assert.equal(stalled.metrics.released, 1);
  const late = streamingResponse();
  await assert.rejects(client(async () => { await new Promise((done) => setTimeout(done, 10)); return late.response; }, { timeoutMs: 2 })
    .media.openMessageAttachment(scope(), messageId, attachment()), code('UNAVAILABLE'));
  assert.equal(late.metrics.reads, 0); assert.equal(late.metrics.bodyCancel, 1);
});
test('account change before response, mid-stream or at EOF discards the file and releases resources', async () => {
  for (const boundary of ['response', 'chunk', 'eof']) {
    let api;
    const r = streamingResponse([bytes], { afterRead: (_count, result) => {
      if (boundary === 'chunk' && !result.done || boundary === 'eof' && result.done) api.expectedUserId = 'different-account';
    } });
    const c = client(async () => { if (boundary === 'response') api.expectedUserId = 'different-account'; return r.response; }); api = c.api;
    await assert.rejects(c.media.openMessageAttachment(scope(), messageId, attachment()), code('AUTH_REQUIRED'));
    assert.equal(r.stream.locked, false);
    assert.equal(boundary === 'response' ? r.metrics.bodyCancel : r.metrics.readerCancel, 1);
  }
});
test('file GET errors are fixed messages; only bounded allowlisted JSON conflicts select a server code', async () => {
  for (const [status, expected] of [[401, 'AUTH_REQUIRED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [500, 'UNAVAILABLE']]) {
    const r = streamingResponse([new TextEncoder().encode('PRIVATE')], { status });
    await assert.rejects(client(async () => r.response).media.openMessageAttachment(scope(), messageId, attachment()),
      (e) => code(expected)(e) && !e.message.includes('PRIVATE'));
    assert.equal(r.metrics.bodyCancel, 1); assert.equal(r.metrics.reads, 0);
  }
  for (const serverCode of [...LOCAL_MEDIA_CONFLICT_CODES, 'PRIVATE SQL']) {
    const r = streamingResponse([new TextEncoder().encode(JSON.stringify({ error: serverCode, message: 'PRIVATE' }))],
      { status: 409, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(client(async () => r.response).media.openMessageAttachment(scope(), messageId, attachment()),
      (e) => code(serverCode === 'PRIVATE SQL' ? 'UNAVAILABLE' : serverCode)(e) && !e.message.includes('PRIVATE'));
    assert.equal(r.metrics.released, 1); assert.equal(r.stream.locked, false);
  }
  const large = streamingResponse([new Uint8Array(8193)], { status: 409, headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(client(async () => large.response).media.openMessageAttachment(scope(), messageId, attachment()), code('INVALID_RESPONSE'));
  assert.equal(large.metrics.readerCancel, 1); assert.equal(large.metrics.released, 1);
});
test('abort before fetch does not issue a request and absent bodies are never accepted', async () => {
  let calls = 0; const { media } = client(async () => { calls++; const r = streamingResponse(); r.response.body = null; return r.response; });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(media.openMessageAttachment(scope(), messageId, attachment(), controller.signal), code('CANCELLED')); assert.equal(calls, 0);
  await assert.rejects(media.openMessageAttachment(scope(), messageId, attachment()), code('INVALID_RESPONSE'));
});

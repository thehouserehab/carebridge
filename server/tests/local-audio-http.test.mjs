import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { createServer, request } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { AiAudioNotes } from '../ai-audio-notes.mjs';
import { handleLocalApiRequest } from '../local-api-http.mjs';
import { localAudioRoute } from '../local-audio-http.mjs';
import { fail } from '../errors.mjs';

// Loopback HTTP plus explicit in-memory identity/record/provider fixtures.
// Browser integration separately exercises the actual Auth and Records services.
const route = '/api/local/centers/center-a/conversations/room-a/records/record-a/audio-notes';
const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32)]);
const result = { transcript: { text: '가상 놀이를 함께 골랐습니다.', durationSeconds: 2,
  segments: [{ id: 0, start: 0, end: 2, text: '가상 놀이를 함께 골랐습니다.' }] },
  analysis: { performed: [{ text: '놀이를 함께 골랐습니다.', segmentIds: [0] }], response: [], reflection: [],
    nextPlan: [], summary: [{ text: '함께 놀이를 골랐어요.', segmentIds: [0] }], warnings: [] } };
let server, origin, options, service, users, cookies, calls, generate, recordRevision, recordAllowed;
beforeEach(async () => {
  calls = 0; recordRevision = 1; recordAllowed = true; generate = async () => structuredClone(result);
  const records = { get: async (actor, input) => {
    if (!recordAllowed || actor.userId !== 'therapist-a' || actor.centerId !== 'center-a' ||
        input.conversationId !== 'room-a' || input.recordId !== 'record-a') fail('FORBIDDEN');
    return { id: 'record-a', conversationId: 'room-a', revision: recordRevision };
  } };
  service = new AiAudioNotes({ records, provider: { mode: 'fixture', model: 'synthetic-analysis',
    transcriptionModel: 'synthetic-transcription', generate: (...args) => { calls++; return generate(...args); } } });
  users = new Map(); cookies = new Map();
  for (const [name, role, center] of [['therapist-a', 'therapist', 'center-a'], ['guardian-a', 'guardian', 'center-a'],
    ['manager-a', 'center', 'center-a'], ['foreign-a', 'therapist', 'center-b']]) {
    const token = randomBytes(32).toString('hex'); cookies.set(name, token);
    users.set(token, { userId: name, centers: [{ id: center, role }] });
  }
  const auth = { login: async () => {}, logout: async token => users.delete(token),
    authenticate: async token => structuredClone(users.get(token) ?? null) };
  options = { auth, records, conversations: { inbox: async () => {}, list: async () => {}, sendText: async () => {}, markRead: async () => {} },
    profiles: { get: async () => {} }, aiAudioNotes: service, cookieName: 'cb_local_' + randomBytes(16).toString('hex') };
  server = createServer(async (req, res) => { if (!await handleLocalApiRequest(req, res, options)) { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port; options.origin = origin;
});
afterEach(async () => {
  await service?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
function call(path, { user = 'therapist-a', body, headers = {}, raw = false } = {}) {
  const post = body !== undefined;
  const requestHeaders = { ...(user ? { Cookie: options.cookieName + '=' + cookies.get(user), 'X-Carebridge-Account': user } : {}),
    ...(post ? { Origin: origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' } : {}), ...headers };
  for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === undefined) delete requestHeaders[key];
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path,
      method: post ? 'POST' : 'GET', headers: requestHeaders, agent: false }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const bytes = Buffer.concat(chunks), text = bytes.toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, bytes,
          json: res.headers['content-type']?.startsWith('application/json') && text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('Synthetic HTTP timeout')));
    req.end(post ? raw ? body : JSON.stringify(body) : undefined);
  });
}
const uploadBody = (overrides = {}) => ({ expectedRevision: 1, requestId: 'audio-upload-0001', filename: 'synthetic.wav',
  type: 'audio/wav', base64: wav.toString('base64'), syntheticConfirmed: true, processingConfirmed: true, ...overrides });
async function upload() {
  const response = await call(route, { body: uploadBody() }); assert.equal(response.status, 201);
  return response.json.session;
}
async function settle(id) {
  for (let i = 0; i < 100; i++) {
    const response = await call(route + '/' + id); assert.equal(response.status, 200);
    if (response.json.session.state !== 'processing') return response.json.session;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Synthetic job did not settle');
}
test('audio route is closed, exact, and disallows misplaced queries or methods', () => {
  assert.equal(localAudioRoute(new URL(route, origin), 'GET').method, 'GET');
  assert.equal(localAudioRoute(new URL(route + '/session-a/start', origin), 'POST').action, 'start');
  assert.equal(localAudioRoute(new URL(route + '/session-a/unknown', origin), 'POST'), null);
  for (const [path, method] of [[route + '?role=therapist', 'GET'], [route, 'PUT'], [route + '/session-a/original', 'POST'],
    [route + '/session-a/start', 'GET'], [route + '/session-a', 'POST']])
    assert.throws(() => localAudioRoute(new URL(path, origin), method));
});
test('authenticated upload stays private and does not invoke provider; source hash matches exact bytes', async () => {
  const session = await upload(); assert.equal(calls, 0); assert.equal(session.state, 'uploaded');
  assert.equal(session.sha256, createHash('sha256').update(wav).digest('hex'));
  const list = await call(route); assert.equal(list.json.sessions.length, 1);
  assert(!JSON.stringify(list.json).includes(wav.toString('base64')));
  const original = await call(route + '/' + session.id + '/original');
  assert.equal(original.status, 200); assert.deepEqual(original.bytes, wav);
  assert.equal(original.headers['cache-control'], 'no-store');
  assert.equal(original.headers['content-type'], 'application/octet-stream');
  assert.match(original.headers['content-disposition'], /^attachment; filename="carebridge-synthetic-/);
  assert.equal(original.headers['x-content-sha256'], session.sha256);
});
test('explicit async start processes once and repeat request ID reuses receipt', async () => {
  const session = await upload(), path = route + '/' + session.id + '/start';
  const body = { expectedRevision: session.revision, requestId: 'audio-start-0001' };
  assert.equal((await call(path, { body })).status, 202);
  const done = await settle(session.id); assert.equal(done.state, 'ready'); assert.deepEqual(done.result, result);
  assert.equal((await call(path, { body })).status, 202); assert.equal(calls, 1);
});
for (const user of [null, 'guardian-a', 'manager-a', 'foreign-a']) test('audio rejects unauthorized identity before parsing upload: ' + user, async () => {
  const response = await call(route, { user, body: '{not-json', raw: true });
  assert.equal(response.status, user === null ? 401 : 404); assert.equal(calls, 0);
  assert(!JSON.stringify(response.json).includes('synthetic.wav'));
});
test('missing account precondition and different origin are rejected', async () => {
  assert.equal((await call(route, { headers: { 'X-Carebridge-Account': undefined } })).status, 401);
  assert.equal((await call(route, { body: uploadBody(), headers: { Origin: 'http://127.0.0.1:9999' } })).status, 403);
});
test('unrelated or revoked record prevents upload and original read', async () => {
  assert.equal((await call(route.replace('record-a', 'record-b'), { body: uploadBody() })).status, 404);
  const session = await upload(); recordAllowed = false;
  assert.equal((await call(route + '/' + session.id + '/original')).status, 404);
});
test('changed record revision prevents new paid processing', async () => {
  const session = await upload(); recordRevision = 2;
  const response = await call(route + '/' + session.id + '/start', { body: { expectedRevision: session.revision, requestId: 'audio-start-0001' } });
  assert.equal(response.status, 409); assert.equal(response.json.error, 'AI_SOURCE_CHANGED'); assert.equal(calls, 0);
});
test('logout during provider work cannot commit derived content', async () => {
  let release; generate = () => new Promise(resolve => { release = () => resolve(structuredClone(result)); });
  const session = await upload();
  await call(route + '/' + session.id + '/start', { body: { expectedRevision: session.revision, requestId: 'audio-start-0001' } });
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  users.delete(cookies.get('therapist-a')); release();
  await new Promise(resolve => setTimeout(resolve, 20));
  const current = await service.get({ userId: 'therapist-a', centerId: 'center-a' },
    { conversationId: 'room-a', recordId: 'record-a', sessionId: session.id });
  assert.equal(current.state, 'failed'); assert.equal(current.result, null);
  assert.equal((await call(route + '/' + session.id)).status, 401);
});
test('removing an uploaded session denies subsequent original download', async () => {
  const session = await upload();
  assert.equal((await call(route + '/' + session.id + '/remove', { body: {} })).status, 204);
  assert.equal((await call(route + '/' + session.id + '/original')).status, 404);
});
test('synthetic/external acknowledgements are mandatory and extra authority fields rejected', async () => {
  for (const body of [uploadBody({ syntheticConfirmed: false }), uploadBody({ processingConfirmed: false }),
    { ...uploadBody(), userId: 'therapist-a' }, uploadBody({ base64: 'not base64' })])
    assert.equal((await call(route, { body })).status, 400);
  assert.equal(calls, 0);
});
test('disabled service cannot accept or process synthetic audio', async () => {
  delete options.aiAudioNotes;
  const response = await call(route, { body: uploadBody() });
  assert.equal(response.status, 503); assert.equal(response.json.error, 'AI_UNAVAILABLE'); assert.equal(calls, 0);
});
test('a pending upload body denies a second large admission and releases after disconnect', async () => {
  const first = request({ hostname: '127.0.0.1', port: server.address().port, path: route, method: 'POST', agent: false,
    headers: { Cookie: options.cookieName + '=' + cookies.get('therapist-a'), 'X-Carebridge-Account': 'therapist-a',
      Origin: origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' } });
  first.on('error', () => {}); first.write('{"expectedRevision":1,');
  try {
    await new Promise(resolve => setTimeout(resolve, 40));
    const denied = await call(route, { body: uploadBody() });
    assert.equal(denied.status, 409); assert.equal(denied.json.error, 'AI_BUSY'); assert.equal(calls, 0);
  } finally { first.destroy(); }
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal((await call(route, { body: uploadBody() })).status, 201);
});
test('relationship revocation during final login check denies original and zeroes its copied buffer', async () => {
  const session = await upload(), authenticate = options.auth.authenticate;
  let reads = 0, exported;
  const getOriginal = service.getOriginal.bind(service);
  service.getOriginal = async (...args) => { exported = await getOriginal(...args); return exported; };
  options.auth.authenticate = async token => {
    const user = await authenticate(token);
    if (++reads === 3) recordAllowed = false;
    return user;
  };
  const response = await call(route + '/' + session.id + '/original');
  assert.equal(response.status, 404);
  assert(exported?.bytes.every(byte => byte === 0), 'Discarded export copy must be cleared');
  recordAllowed = true; options.auth.authenticate = authenticate;
  assert.equal((await call(route + '/' + session.id + '/original')).status, 200, 'Failed export must release admission');
});

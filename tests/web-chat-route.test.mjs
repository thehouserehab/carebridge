import test from 'node:test';
import assert from 'node:assert/strict';
import { createVercelChatHandler } from '../api/chat.js';
import { createWebChatHandler } from '../server/web-chat-http.mjs';

const origin = 'https://chat.example.test';
const env = {
  CAREBRIDGE_WEB_CHAT_ENABLED: 'true', CAREBRIDGE_CHAT_CENTER_ID: 'synthetic-center',
  CAREBRIDGE_CHAT_DATABASE_URL: 'postgresql://synthetic:synthetic@database.example.test/postgres',
  CAREBRIDGE_WEB_ORIGINS: origin,
};
function capture() {
  let seen;
  return { handle: createVercelChatHandler(async request => { seen = request; return new Response(null, { status: 204 }); }),
    request: () => seen };
}

test('Vercel chat adapter removes the exact single rewrite capture and preserves all other query fields', async () => {
  const spy = capture();
  const original = new Request(origin + '/api/chat/rooms/room-one/messages?after=2&path=rooms%2Froom-one%2Fmessages&limit=20&after=3');
  assert.equal((await spy.handle(original)).status, 204);
  const url = new URL(spy.request().url);
  assert.equal(url.origin, origin);
  assert.equal(url.pathname, '/api/chat/rooms/room-one/messages');
  assert.deepEqual([...url.searchParams], [['after', '2'], ['limit', '20'], ['after', '3']]);
  assert.equal(new URL(original.url).searchParams.get('path'), 'rooms/room-one/messages');
});

test('Vercel chat adapter forwards request body, method, headers and abort signal without reading the body', async () => {
  const spy = capture(), controller = new AbortController();
  const text = JSON.stringify({ clientId: 'synthetic-request-1', body: '가상 대화 확인' });
  const original = new Request(origin + '/api/chat/rooms/room-one/messages?path=rooms%2Froom-one%2Fmessages', {
    method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-carebridge-chat': '1',
      'x-carebridge-chat-user': 'synthetic-user', cookie: '__Secure-carebridge-chat=synthetic-cookie-value' },
    body: text, signal: controller.signal,
  });
  assert.equal((await spy.handle(original)).status, 204);
  const forwarded = spy.request();
  assert.equal(forwarded.method, 'POST');
  assert.deepEqual([...forwarded.headers], [...original.headers]);
  assert.equal(forwarded.bodyUsed, false);
  assert.equal(await forwarded.text(), text);
  controller.abort();
  assert.equal(forwarded.signal.aborted, true);
});

test('Vercel chat adapter rejects duplicate, mismatched and malformed captures before invoking the backend', async () => {
  for (const suffix of [
    '/session?path=session&path=session', '/session?path=rooms', '/session?path=',
    '/session?path=https%3A%2F%2Fother.example.test%2Fsession',
    '/rooms/room-one/messages?path=rooms%2Froom-two%2Fmessages',
    '/rooms/%ZZ/messages?path=rooms%2F%25ZZ%2Fmessages',
  ]) {
    const spy = capture(), response = await spy.handle(new Request(origin + '/api/chat' + suffix));
    assert.equal(response.status, 400, suffix);
    assert.deepEqual(await response.json(), { error: { code: 'INVALID_INPUT' } });
    assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(spy.request(), undefined);
  }
});

test('Vercel chat adapter leaves original requests without routing metadata unchanged', async () => {
  const spy = capture(), request = new Request(origin + '/api/chat/session');
  assert.equal((await spy.handle(request)).status, 204);
  assert.equal(spy.request(), request);
});

test('Vercel rewritten sessions retain core query checks and direct endpoint cannot route through query values', async () => {
  let serviceCalls = 0;
  const handle = createVercelChatHandler(createWebChatHandler({ env,
    getServices: async () => { serviceCalls++; return { auth: { authenticate: async () => null } }; },
  }));
  const response = await handle(new Request(origin + '/api/chat/session?path=session'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: true, authenticated: false, user: null });
  assert.equal(serviceCalls, 1);
  for (const suffix of ['/api/chat/session?path=session&extra=1', '/api/chat/session?path=session&...path=session']) {
    const rejected = await handle(new Request(origin + suffix));
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: { code: 'INVALID_INPUT' } });
  }
  for (const suffix of ['/api/chat', '/api/chat?path=session', '/api/chat?path=rooms%2Froom-one%2Fmessages']) {
    const rejected = await handle(new Request(origin + suffix));
    assert.equal(rejected.status, 404);
    assert.deepEqual(await rejected.json(), { error: { code: 'NOT_FOUND' } });
  }
  assert.equal(serviceCalls, 1);
});

test('Vercel rewritten nested messages preserve backend authentication and origin boundaries', async () => {
  let serviceCalls = 0;
  const handle = createVercelChatHandler(createWebChatHandler({ env,
    getServices: async () => { serviceCalls++; return { auth: { authenticate: async () => null } }; },
  }));
  const suffix = '/api/chat/rooms/room-one/messages?path=rooms%2Froom-one%2Fmessages';
  assert.equal((await handle(new Request(origin + suffix))).status, 401);
  const forbidden = await handle(new Request('https://other.example.test' + suffix));
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: { code: 'CROSS_ORIGIN_DENIED' } });
  assert.equal(serviceCalls, 1);
});

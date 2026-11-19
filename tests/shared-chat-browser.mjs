import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = (res, value, status = 200, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(value)); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function verifySharedChatBrowser({ origin, therapist, guardian, reportDirectory,
  playwrightModule = process.env.PLAYWRIGHT_MODULE, executablePath = process.env.STUDY_CHROMIUM_EXECUTABLE } = {}) {
  if (!origin || new URL(origin).origin !== origin || !path.isAbsolute(reportDirectory) || ![therapist, guardian].every(value => typeof value?.email === 'string' && typeof value?.password === 'string')) throw Error('CHAT_CHECK_CONFIGURATION');
  const report = { passed: false, syntheticOnly: true, checks: [], screenshots: [], errors: [], cleanup: {} };
  let chrome, browser, contexts = [], phase = 'START';
  try {
    await mkdir(reportDirectory, { recursive: true });
    const { chromium } = await import(pathToFileURL(playwrightModule).href);
    chrome = await chromium.launchServer({ executablePath, headless: true, host: '127.0.0.1', port: 0, env: studyChildEnvironment() });
    browser = await chromium.connect(chrome.wsEndpoint());
    const pages = [];
    for (const [index, credentials] of [therapist, guardian].entries()) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', permissions: [], serviceWorkers: 'block' }); contexts.push(context);
      const page = await context.newPage(); page.setDefaultTimeout(25000); page.on('pageerror', () => report.errors.push({ phase, kind: 'PAGE_ERROR' })); pages.push(page);
      phase = `LOGIN_${index}`; await page.goto(origin + '/chat/'); await page.locator('[data-chat-login]').waitFor();
      const unauthorized = await context.request.get(origin + '/api/chat/rooms'); assert.equal(unauthorized.status(), 401);
      await page.locator('[name=email]').fill(credentials.email); await page.locator('[name=password]').fill(credentials.password); await page.locator('[name=synthetic]').check();
      await page.getByRole('button', { name: '대화 시작하기', exact: true }).click(); await page.locator('[data-chat-compose] textarea:enabled').waitFor();
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
      const identity = await (await context.request.get(origin + '/api/chat/session')).json();
      const wrongAccount = await context.request.get(origin + '/api/chat/rooms', { headers: { 'X-Carebridge-Chat-User': 'not-this-synthetic-account' } }); assert.equal(wrongAccount.status(), 401);
      const wrongRoom = await context.request.get(origin + '/api/chat/rooms/not-this-synthetic-room/messages', { headers: { 'X-Carebridge-Chat-User': identity.user.userId } }); assert.equal(wrongRoom.status(), 404);
      report.checks.push({ kind: 'separateAuthenticatedAccount', role: index ? 'guardian' : 'therapist', passed: true });
    }
    const [first, second] = pages, marker = randomUUID().slice(0, 8);
    const send = async (page, body) => { await page.locator('[data-chat-compose] textarea').fill(body); await page.getByRole('button', { name: '보내기', exact: true }).click(); await page.waitForFunction(() => document.querySelector('[data-chat-compose] textarea').value === ''); };
    const waitMessage = (page, body) => page.locator('.message-bubble p').filter({ hasText: body }).waitFor();
    phase = 'THERAPIST_TO_GUARDIAN'; const firstText = `가상 시연 ${marker}: 치료사가 보낸 연결 확인입니다.`;
    await send(first, firstText); await waitMessage(second, firstText);
    phase = 'GUARDIAN_TO_THERAPIST'; const secondText = `가상 시연 ${marker}: 보호자가 답장을 보냈습니다.`;
    await send(second, secondText); await waitMessage(first, secondText);
    report.checks.push({ kind: 'bidirectionalPolling', passed: true });
    phase = 'REFRESH'; await second.reload(); await second.locator('[data-chat-compose] textarea:enabled').waitFor(); await waitMessage(second, firstText); await waitMessage(second, secondText);
    report.checks.push({ kind: 'reloadPreservesServerMessages', passed: true });
    phase = 'LOST_ACK'; let intercepted = false;
    await first.route('**/api/chat/rooms/*/messages', async route => {
      if (route.request().method() !== 'POST' || intercepted) return route.continue();
      intercepted = true; const response = await route.fetch(); assert.equal(response.status(), 201); await route.abort('failed');
    });
    const lostText = `가상 시연 ${marker}: 응답 유실 뒤 같은 번호로 확인합니다.`;
    await first.locator('[data-chat-compose] textarea').fill(lostText); await first.getByRole('button', { name: '보내기', exact: true }).click();
    await first.locator('[data-chat-retry]:visible').waitFor(); assert.equal(await first.locator('textarea').inputValue(), lostText);
    assert.equal(await first.locator('textarea').getAttribute('readonly'), '');
    await first.locator('[data-chat-retry]').click(); await first.waitForFunction(() => document.querySelector('[data-chat-compose] textarea').value === '');
    await waitMessage(second, lostText); assert.equal(await second.locator('.message-bubble p').filter({ hasText: lostText }).count(), 1);
    await first.unroute('**/api/chat/rooms/*/messages'); report.checks.push({ kind: 'lostAckRetainsDraftAndIdempotentRetry', passed: true });
    phase = 'PRESERVE_READING';
    // One tall synthetic message supplies scrollable history without generating
    // dozens of writes. A new incoming message must not jump the reader down.
    const longText = `가상 시연 ${marker}: 읽기 위치 확인\n` + Array.from({ length: 30 }, (_, index) => `가상 관찰 ${index + 1}: 블록을 골랐어요.`).join('\n');
    await send(second, longText); await waitMessage(first, longText.slice(0, 32));
    await first.locator('[data-chat-timeline]').evaluate(node => { node.scrollTop = 0; });
    const beforeScroll = await first.locator('[data-chat-timeline]').evaluate(node => node.scrollTop);
    const laterText = `가상 시연 ${marker}: 읽는 동안 도착한 소식입니다.`; await send(second, laterText); await waitMessage(first, laterText);
    assert(Math.abs(await first.locator('[data-chat-timeline]').evaluate(node => node.scrollTop) - beforeScroll) <= 2);
    await first.locator('[data-chat-new]:visible').waitFor(); await first.locator('[data-chat-new]').click();
    report.checks.push({ kind: 'readingPositionPreservedWithNewMessage', passed: true });
    phase = 'HIDDEN_POLLING'; let hiddenReads = 0;
    const countRead = request => { if (request.method() === 'GET' && new URL(request.url()).pathname.startsWith('/api/chat/')) hiddenReads++; };
    await first.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await pause(300); first.on('request', countRead); await pause(5300); first.off('request', countRead); assert.equal(hiddenReads, 0);
    await first.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
    report.checks.push({ kind: 'hiddenPagePausesPolling', passed: true });
    phase = 'LAYOUT';
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      await first.setViewportSize(viewport); await first.waitForFunction(() => parseInt(document.documentElement.style.getPropertyValue('--chat-height'), 10) === Math.round(visualViewport.height)); await first.locator('textarea').focus();
      const layout = await first.evaluate(() => {
        const input = document.querySelector('textarea').getBoundingClientRect(), send = document.querySelector('[data-chat-send]').getBoundingClientRect();
        return { noOverflow: document.documentElement.scrollWidth <= innerWidth + 1, inputFits: input.left >= -1 && input.right <= innerWidth + 1 && input.top >= 0 && input.bottom <= innerHeight + 1,
          sendFits: send.left >= -1 && send.right <= innerWidth + 1 && send.top >= 0 && send.bottom <= innerHeight + 1 };
      });
      report.checks.push({ kind: 'layout', width: viewport.width, ...layout });
      const name = `${viewport.width}-conversation.png`; await first.screenshot({ path: path.join(reportDirectory, name), mask: [first.locator('[type=password]')] }); report.screenshots.push(name);
      assert(Object.values(layout).every(Boolean));
    }
    phase = 'LOGOUT'; await first.setViewportSize({ width: 1440, height: 1000 }); await first.locator('[data-chat-logout]').click(); await first.locator('[data-chat-login]').waitFor();
    assert.equal(await first.locator('.chat-message').count(), 0); assert.equal((await contexts[0].request.get(origin + '/api/chat/rooms')).status(), 401);
    await second.setViewportSize({ width: 1440, height: 1000 }); await second.locator('[data-chat-logout]').click(); await second.locator('[data-chat-login]').waitFor();
    report.checks.push({ kind: 'logoutClearsPrivateSurface', passed: true }); assert.deepEqual(report.errors, []); report.passed = true;
  } catch { report.errors.push({ phase, kind: 'CHAT_BROWSER_CHECK_FAILED' }); }
  finally {
    for (const context of contexts) await context.close().catch(() => report.errors.push({ phase: 'CLEANUP', kind: 'CONTEXT_CLOSE_FAILED' })); report.cleanup.contextsClosed = true;
    try { await browser?.close(); await chrome?.close(); report.cleanup.browserClosed = true; } catch { report.errors.push({ phase: 'CLEANUP', kind: 'BROWSER_CLOSE_FAILED' }); }
    report.passed = report.passed && !report.errors.length; await mkdir(reportDirectory, { recursive: true }); await writeFile(path.join(reportDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

async function mockRun() {
  const accounts = [
    { userId: 'synthetic-therapist', email: 'therapist@example.test', password: 'synthetic-therapist-password', role: 'therapist', centerId: 'center-synthetic' },
    { userId: 'synthetic-guardian', email: 'guardian@example.test', password: 'synthetic-guardian-password', role: 'guardian', centerId: 'center-synthetic' },
  ], sessions = new Map(), messages = [], operations = new Map(), reads = new Map(), snapshots = new Map(), unseenReads = [];
  let revision = 1;
  const userView = user => ({ userId: user.userId, email: user.email, role: user.role, centerId: user.centerId, expiresAt: '2030-01-01T00:00:00.000Z' });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost'), token = req.headers.cookie?.match(/chat_test=([^;]+)/)?.[1], user = sessions.get(token);
      if (!url.pathname.startsWith('/api/chat/')) {
        const filename = url.pathname === '/chat/' ? 'shared-chat.html' : url.pathname.slice(1);
        if (!/^(shared-chat\.html|src\/[A-Za-z0-9_.-]+\.(js|css)|favicon\.svg)$/.test(filename)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.svg') ? 'image/svg+xml' : 'text/html' }); res.end(await readFile(path.join(root, filename))); return;
      }
      let input; if (req.method === 'POST') { let body = ''; for await (const chunk of req) body += chunk; input = JSON.parse(body); }
      const accountHeader = req.headers['x-carebridge-chat-user'];
      if (accountHeader && accountHeader !== user?.userId) return json(res, { error: { code: 'AUTH_REQUIRED' } }, 401);
      if (url.pathname === '/api/chat/session') {
        if (req.method === 'POST') {
          const candidate = accounts.find(item => item.email === input.email && item.password === input.password);
          if (!candidate || input.syntheticConfirmed !== true) return json(res, { error: { code: 'AUTH_INVALID' } }, 401);
          const value = randomUUID(); sessions.set(value, candidate);
          return json(res, { enabled: true, authenticated: true, user: userView(candidate) }, 200, { 'Set-Cookie': `chat_test=${value}; Path=/api/chat; HttpOnly; SameSite=Strict` });
        }
        if (req.method === 'DELETE') { sessions.delete(token); return json(res, { enabled: true, authenticated: false, user: null }, 200, { 'Set-Cookie': 'chat_test=; Max-Age=0; Path=/api/chat; HttpOnly; SameSite=Strict' }); }
        return json(res, { enabled: true, authenticated: !!user, user: user ? userView(user) : null });
      }
      if (!user || accountHeader !== user.userId) return json(res, { error: { code: 'AUTH_REQUIRED' } }, 401);
      if (url.pathname === '/api/chat/rooms') return json(res, { rooms: [{ conversationId: 'room-synthetic', childId: 'child-synthetic', name: '가상 하루', participants: accounts.map(item => ({ userId: item.userId, role: item.role, displayName: item.role === 'therapist' ? '가상 치료사' : '가상 보호자' })), revision, lastRead: reads.get(user.userId) ?? 0, unread: 0, latest: messages.at(-1) ?? null }], snapshot: 'synthetic-snapshot', resetRequired: false, nextOffset: 1, hasMore: false });
      if (url.pathname === '/api/chat/rooms/room-synthetic/messages') {
        if (req.method === 'POST') {
          const operation = user.userId + ':' + input.clientId; let message = operations.get(operation);
          if (!message) { message = { id: 'message-' + randomUUID(), conversationId: 'room-synthetic', childId: 'child-synthetic', sequence: messages.length + 1, authorId: user.userId, createdAt: new Date().toISOString(), type: 'text', body: input.body, read: false, hidden: false, deleted: false, edited: false }; messages.push(message); operations.set(operation, message); revision++; }
          return json(res, { message }, 201);
        }
        snapshots.set(user.userId, messages.length);
        return json(res, { messages, lastRead: reads.get(user.userId) ?? 0, unread: 0, revision, nextCursor: messages.length, hasMore: false, resetRequired: false });
      }
      if (url.pathname === '/api/chat/rooms/room-synthetic/read') { const message = messages.find(item => item.id === input.messageId); if (message?.sequence > (snapshots.get(user.userId) ?? 0)) unseenReads.push(message.sequence); reads.set(user.userId, message?.sequence ?? 0); return json(res, { lastRead: reads.get(user.userId) }); }
      json(res, { error: { code: 'NOT_FOUND' } }, 404);
    } catch { json(res, { error: { code: 'CHAT_UNAVAILABLE' } }, 503); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = path.join(root, 'test-results', 'shared-chat-browser-' + randomUUID());
  try {
    const report = await verifySharedChatBrowser({ origin: `http://127.0.0.1:${server.address().port}`, therapist: accounts[0], guardian: accounts[1], reportDirectory: directory });
    report.checks.push({ kind: 'readReceiptsFollowCompleteSnapshots', passed: unseenReads.length === 0 }); report.passed = report.passed && unseenReads.length === 0;
    await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, reportDirectory: directory, provider: 'explicit synthetic HTTP test backend', modelCalls: 0, errors: report.errors })); if (!report.passed) process.exitCode = 1;
  } finally { await new Promise(resolve => server.close(resolve)); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await mockRun();

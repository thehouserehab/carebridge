// Explicit, synthetic vertical slice only. Owns its memory-only PostgreSQL,
// loopback server, headless browser and fresh contexts. No existing tabs, .env,
// native database, actual child data, uploads or stored credential artifacts.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceRoom, workspaceAccountAction } from './local-workspace-browser-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const within = async (work, timeoutMs = 10_000) => {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('LOCAL_API_BROWSER_CLEANUP_TIMEOUT')), timeoutMs);
  })]); } finally { clearTimeout(timer); }
};
async function sources() {
  const names = ['tests/local-api-browser.mjs', 'tests/local-workspace-browser-helpers.mjs'];
  for (const dir of ['local-api', 'src', 'server', 'server/migrations']) {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      if (!/\.(?:mjs|js|css|html|sql)$/.test(entry.name) || entry.isDirectory()) continue;
      assert(entry.isFile() && !entry.isSymbolicLink(), 'LOCAL_API_BROWSER_SOURCE_TYPE');
      names.push(`${dir}/${entry.name}`);
    }
  }
  const files = [];
  for (const name of names.sort()) files.push({ name, sha256: sha256(await readFile(path.join(root, name))) });
  return { sha256: sha256(JSON.stringify(files)), files };
}
const localOrigin = (value) => {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
  assert(url.port && !url.username && !url.password && !url.search && !url.hash);
  assert.equal(url.pathname, '/'); return url.origin;
};

export async function runLocalApiBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const file of [options.module, options.executable]) assert((await lstat(file)).isFile());
  const { chromium } = await import(pathToFileURL(options.module).href);
  const source = await sources();
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-api-${runId}`);
  await mkdir(folder);
  const report = { runId, at: new Date().toISOString(), source, passed: false, checks: [], screenshots: [],
    errors: [], unexpectedRequests: [], failure: null, cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Synthetic loopback HTTP and in-memory PGlite only; no real accounts, actual child information, attachments or persistent database.',
      'Browser viewport emulation is not physical-device, cross-device, production TLS, notification or human usability evidence.',
      'The second synthetic child/room and therapist relationship changes are fixture-only SQL; message writes still use the authenticated UI and actual HTTP handler.',
      'Only intentional response loss and offline network faults intercept transport; ordinary requests use the real HTTP handler and domain services.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, startedAt: report.at, finished: false };
  await writeFile(path.join(folder, 'ownership.json'), JSON.stringify(ownership, null, 2));
  let browserServer, browserProcess, browser, phase = 'STARTUP';
  const openContexts = new Set(), openSandboxes = new Set();
  try {
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    browserProcess = browserServer.process(); browser = await chromium.connect(browserServer.wsEndpoint());
    ownership.browserProcessId = browserProcess.pid;
    await writeFile(path.join(folder, 'ownership.json'), JSON.stringify(ownership, null, 2));
    report.browserVersion = browser.version();
    for (const width of [390, 1440, 320]) {
      phase = `${width}:START_SANDBOX`;
      const sandbox = await createLocalApiSandbox({ port: 0 }); openSandboxes.add(sandbox);
      const origin = localOrigin(sandbox.origin), ids = sandbox.ids;
      // A second authorized room lets the selected workspace succeed while A
      // is revoked. Give B only the therapist, so the existing guardian's final
      // no-rooms permission test retains its original meaning.
      const extra = { childId: `draft-child-${randomUUID()}`, roomId: `draft-room-${randomUUID()}` };
      await sandbox.database.transaction(async (tx) => {
        await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)', [ids.centerId, extra.childId]);
        await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)', [ids.centerId, extra.roomId, extra.childId]);
        await tx.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
          VALUES ($1,$2,$3,'therapist',true,1)`, [ids.centerId, extra.roomId, ids.therapistId]);
        await tx.query(`INSERT INTO cb_child_profiles(center_id,child_id,name,revision,updated_by)
          VALUES ($1,$2,'가상 초안 분리 아동',1,$3)`, [ids.centerId, extra.childId, ids.therapistId]);
      });
      const roomPath = `/api/local/centers/${ids.centerId}/conversations/${ids.conversationId}`;
      const inboxPath = `/api/local/centers/${ids.centerId}/inbox`;
      const sent = [], fault = { loseNext: false, lost: 0, failure: false };
      const result = { width, login: false, storagePrivate: false, inbox: false, delivery: false, read: false,
        reload: false, responseLossRetry: false, offlineDraftRecovery: false, logout: false, logoutFailure: false,
        nonSelectedDraftRevocation: false, accountChangePrecondition: false, removedRelationship: false, layout: false, cleanup: false };
      report.currentCheck = result;
      const newActor = async (role) => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR',
          isMobile: width <= 640, hasTouch: width <= 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        openContexts.add(context);
        await context.route('**/*', async (route) => {
          const request = route.request(), url = new URL(request.url());
          const staticAsset = ['/', '/favicon.ico', '/local-api/client.js', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/styles.css',
            '/local-api/care-client.js', '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/media-client.js', '/local-api/media-ui.js', '/local-api/media-viewer.js', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js'].includes(url.pathname) && ['GET', 'HEAD'].includes(request.method());
          const primaryRead = request.method() === 'GET' && url.pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
            [...url.searchParams].length === 1 && [ids.conversationId, extra.roomId].includes(url.searchParams.get('conversationId'));
          const api = /^\/api\/local\/(?:auth\/(?:login|session|logout)|centers\/[A-Za-z0-9_-]+\/(?:inbox|conversations\/[A-Za-z0-9_-]+\/(?:profile|messages(?:\/[A-Za-z0-9_-]+)?|read|goals|records|appointments(?:\/[A-Za-z0-9_-]+)?)))$/.test(url.pathname);
          if (url.origin !== origin || !['GET', 'POST', 'HEAD'].includes(request.method()) || !(staticAsset || api || primaryRead)) {
            report.unexpectedRequests.push({ width, role, phase, sameOrigin: url.origin === origin, method: request.method() });
            return route.abort().catch(() => {});
          }
          if (url.pathname === `${roomPath}/messages` && request.method() === 'POST') {
            const payload = request.postDataJSON(); sent.push({ role, ...payload });
            if (fault.loseNext) {
              fault.loseNext = false;
              try {
                // Commit through the real handler, then discard only its HTTP
                // response. No mocked success body and no direct message insert.
                const response = await route.fetch({ maxRedirects: 0 });
                if (response.status() !== 201) fault.failure = true;
                else fault.lost++;
                await response.dispose(); await route.abort('failed');
              } catch { fault.failure = true; await route.abort('failed').catch(() => {}); }
              return;
            }
          }
          // A lifetime/account change can cancel a request while its GET gate
          // is being released. An already handled route is not a new request.
          return route.continue().catch(() => {});
        });
        const page = await context.newPage(); page.setDefaultTimeout(12_000);
        page.on('pageerror', () => report.errors.push({ width, role, phase, type: 'pageerror' }));
        page.on('console', (entry) => {
          // Browser resource diagnostics for deliberately failed requests and
          // expected 401/404s contain no application exception evidence.
          if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:'))
            report.errors.push({ width, role, phase, type: 'console' });
        });
        await page.goto(origin);
        await page.getByTestId('login-form').waitFor();
        return { context, page, role };
      };
      const therapist = await newActor('therapist'), guardian = await newActor('guardian');
      const actors = [therapist, guardian];
      const login = async ({ page, role }) => {
        const account = sandbox.credentials.find((item) => item.role === role);
        assert(account && account.email.endsWith('.test'), 'LOCAL_API_BROWSER_SYNTHETIC_ACCOUNT');
        await page.getByLabel('시험 이메일', { exact: true }).fill(account.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(account.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click();
        await page.getByTestId('home').waitFor();
      };
      const room = async ({ page }) => workspaceRoom(page, ids.conversationId, { keyboard: width === 320 });
      const refresh = async ({ page }) => { await workspaceAccountAction(page, 'refresh'); };
      const row = (actor, body) => actor.page.getByTestId('message-row').filter({ hasText: body });
      const post = async (actor, body) => {
        await actor.page.getByLabel('메시지', { exact: true }).fill(body);
        const button = actor.page.getByRole('button', { name: '보내기', exact: true });
        if (width === 320) { await button.focus(); await button.press('Enter'); }
        else await button.click();
      };
      const count = async (body) => {
        const { rows } = await sandbox.database.query('SELECT count(*)::integer AS count FROM cb_messages WHERE center_id=$1 AND conversation_id=$2 AND body=$3', [ids.centerId, ids.conversationId, body]);
        return rows[0].count;
      };
      const api = (actor, pathname, body) => actor.page.evaluate(async ({ pathname, body, expectedAccount }) => {
        const response = await fetch(pathname, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'X-Carebridge-Account': expectedAccount, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Carebridge-Request': '1' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, value: response.status === 204 ? null : await response.json() };
      }, { pathname, body, expectedAccount: ids[`${actor.role}Id`] });
      const privateStorage = async (actor) => {
        assert.deepEqual(await actor.page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 }, 'LOCAL_API_BROWSER_NO_BROWSER_STORAGE');
        assert.equal(await actor.page.evaluate(() => document.cookie), '', 'LOCAL_API_BROWSER_NO_SCRIPT_COOKIE');
        const cookies = await actor.context.cookies(`${origin}/api/local/`);
        assert(cookies.length > 0 && cookies.every((cookie) => cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/api/local/'), 'LOCAL_API_BROWSER_COOKIE_SCOPE');
      };
      const capture = async (actor, label) => {
        const page = actor.page;
        await page.locator('#room-title').focus();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'LOCAL_API_BROWSER_PAGE_OVERFLOW');
        assert.equal(await page.getByTestId('room').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, 'LOCAL_API_BROWSER_ROOM_OVERFLOW');
        const filename = `${width}-${label}.png`;
        await page.screenshot({ path: path.join(folder, filename), fullPage: true,
          mask: [page.locator('input[type="email"]'), page.locator('input[type="password"]')] });
        report.screenshots.push({ width, label, filename, syntheticOnly: true });
      };

      phase = `${width}:LOGIN_INBOX`;
      for (const actor of actors) { await login(actor); await privateStorage(actor); }
      result.login = result.storagePrivate = true;
      const baselineHome = await api(guardian, inboxPath);
      assert.equal(baselineHome.status, 200);
      const baselineUnread = baselineHome.value.rooms.find((entry) => entry.conversationId === ids.conversationId).unread;
      await room(therapist);
      assert.equal(await therapist.page.getByLabel('메시지', { exact: true }).getAttribute('maxlength'), '2000');
      const initial = `가상 API 소식 ${width} <img src=x onerror=window.__apiXss=1>`, reply = `가상 API 답변 ${width}`;
      await post(therapist, initial); await row(therapist, initial).waitFor();
      assert.equal(await count(initial), 1, 'LOCAL_API_BROWSER_INITIAL_DB_COMMIT');
      assert((await row(therapist, initial).innerText()).includes('전송됨'), 'LOCAL_API_BROWSER_NOT_PREMATURELY_READ');
      await refresh(guardian);
      await guardian.page.getByTestId('home').getByText(initial, { exact: true }).waitFor();
      const home = await api(guardian, inboxPath);
      assert.equal(home.status, 200); assert.equal(home.value.rooms[0].unread, baselineUnread + 1);
      result.inbox = true;

      phase = `${width}:DELIVERY_READ`;
      const { rows: originalRows } = await sandbox.database.query('SELECT id,sequence FROM cb_messages WHERE center_id=$1 AND conversation_id=$2 AND body=$3', [ids.centerId, ids.conversationId, initial]);
      await Promise.all([
        guardian.page.waitForResponse((response) => response.url() === `${origin}${roomPath}/read` && response.status() === 200 &&
          response.request().postDataJSON()?.messageId === originalRows[0].id),
        (async () => { await room(guardian); await row(guardian, initial).waitFor(); await row(guardian, initial).scrollIntoViewIfNeeded(); })(),
      ]);
      await refresh(therapist);
      await row(therapist, initial).locator('.meta').filter({ hasText: '읽음' }).waitFor();
      const { rows: readRows } = await sandbox.database.query('SELECT sequence FROM cb_read_states WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3', [ids.centerId, ids.conversationId, ids.guardianId]);
      assert.equal(Number(readRows[0]?.sequence), Number(originalRows[0].sequence), 'LOCAL_API_BROWSER_READ_COMMITTED'); result.read = true;
      await post(guardian, reply); await row(guardian, reply).waitFor();
      await refresh(therapist); await row(therapist, reply).waitFor();
      assert.equal(await count(reply), 1); result.delivery = true;
      for (const actor of actors) {
        assert.equal(await row(actor, initial).locator('.bubble > p').first().innerText(), initial, 'LOCAL_API_BROWSER_LITERAL_TEXT');
        assert.equal(await row(actor, initial).locator('img,script').count(), 0, 'LOCAL_API_BROWSER_NO_INJECTED_ELEMENT');
        assert.equal(await actor.page.evaluate(() => window.__apiXss === undefined), true, 'LOCAL_API_BROWSER_NO_SCRIPT_EXECUTION');
      }
      await capture(therapist, 'delivered-read'); result.layout = true;

      phase = `${width}:RELOAD`;
      for (const actor of actors) {
        await actor.page.reload(); await actor.page.getByTestId('home').waitFor(); await room(actor);
        await row(actor, initial).waitFor(); await row(actor, reply).waitFor(); await privateStorage(actor);
      }
      result.reload = true;

      phase = `${width}:COMMITTED_RESPONSE_LOSS`;
      const lostBody = `가상 응답 유실 재전송 ${width}`;
      fault.loseNext = true; await post(therapist, lostBody);
      await therapist.page.getByTestId('send-error').waitFor();
      assert.equal(fault.failure, false); assert.equal(fault.lost, 1);
      assert.equal(await count(lostBody), 1, 'LOCAL_API_BROWSER_LOST_RESPONSE_ALREADY_COMMITTED');
      assert.equal(await therapist.page.getByLabel('메시지', { exact: true }).inputValue(), lostBody);
      assert.equal(await therapist.page.getByLabel('메시지', { exact: true }).evaluate((input) => input.readOnly), true);
      await therapist.page.getByRole('button', { name: '다시 보내기', exact: true }).click();
      await row(therapist, lostBody).waitFor();
      await therapist.page.getByTestId('send-error').waitFor({ state: 'hidden' });
      const attempts = sent.filter((item) => item.role === 'therapist' && item.body === lostBody);
      assert.equal(attempts.length, 2); assert.equal(attempts[0].clientId, attempts[1].clientId);
      assert.equal(await count(lostBody), 1, 'LOCAL_API_BROWSER_RETRY_SINGLE_COMMIT');
      await refresh(guardian); await row(guardian, lostBody).waitFor();
      assert.equal(await row(guardian, lostBody).count(), 1); result.responseLossRetry = true;

      phase = `${width}:OFFLINE_DRAFT_RECOVERY`;
      const offlineBody = `가상 오프라인 복구 ${width}`;
      await guardian.page.getByLabel('메시지', { exact: true }).fill(offlineBody);
      await guardian.context.setOffline(true);
      await guardian.page.getByLabel('메시지', { exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await count(offlineBody), 0);
      assert.equal(await guardian.page.getByTestId('message-row').count(), 0);
      await guardian.context.setOffline(false);
      await guardian.page.getByLabel('메시지', { exact: true }).waitFor();
      assert.equal(await guardian.page.getByLabel('메시지', { exact: true }).inputValue(), offlineBody);
      await guardian.page.getByRole('button', { name: '보내기', exact: true }).click();
      await row(guardian, offlineBody).waitFor(); assert.equal(await count(offlineBody), 1); result.offlineDraftRecovery = true;

      phase = `${width}:NON_SELECTED_DRAFT_REVOCATION`;
      const revokedDraft = `가상 A 권한 종료 전 미전송 초안 ${width}`;
      const allowedDraft = `가상 B 유지할 미전송 초안 ${width}`;
      await therapist.page.bringToFront(); await room(therapist);
      const composer = therapist.page.getByLabel('메시지', { exact: true });
      await composer.fill(revokedDraft);
      await workspaceRoom(therapist.page, extra.roomId, { keyboard: width === 320 });
      assert.equal(await composer.inputValue(), '', 'LOCAL_API_BROWSER_DRAFT_ROOM_ISOLATION');
      await composer.fill(allowedDraft);
      await sandbox.database.transaction(async (tx) => {
        await tx.query('SELECT id FROM cb_conversations WHERE center_id=$1 AND id=$2 FOR UPDATE', [ids.centerId, ids.conversationId]);
        await tx.query('UPDATE cb_participants SET active=false WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3',
          [ids.centerId, ids.conversationId, ids.therapistId]);
      });
      await refresh(therapist);
      // An absent A alone could be a failed/partial read. Require the complete
      // successful workspace to keep B selected and its unsent input intact.
      await therapist.page.waitForFunction(({ removed, kept, body }) => {
        const inbox = document.querySelector('[data-testid="inbox"]');
        const selected = inbox?.querySelector(`[data-room-id="${kept}"][aria-current="true"]`);
        const input = document.querySelector('#message');
        return inbox && !inbox.querySelector(`[data-room-id="${removed}"]`) && selected &&
          input?.getClientRects().length > 0 && input.value === body &&
          document.querySelector('#status')?.textContent === '서버와 연결되어 있어요.';
      }, { removed: ids.conversationId, kept: extra.roomId, body: allowedDraft });
      const revokedInbox = await api(therapist, inboxPath);
      assert.equal(revokedInbox.status, 200); assert.equal(revokedInbox.value.hasMore, false);
      assert.deepEqual(revokedInbox.value.rooms.map(entry => entry.conversationId), [extra.roomId], 'LOCAL_API_BROWSER_COMPLETE_REVOKED_WORKSPACE');
      assert.equal((await api(therapist, `${roomPath}/messages`)).status, 404);
      const participant = (await sandbox.database.query(`SELECT active,first_sequence FROM cb_participants
        WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3`, [ids.centerId, ids.conversationId, ids.therapistId])).rows[0];
      assert.equal(participant.active, false, 'LOCAL_API_BROWSER_REVOKED_PARTICIPANT');
      await sandbox.database.transaction(async (tx) => {
        await tx.query('SELECT id FROM cb_conversations WHERE center_id=$1 AND id=$2 FOR UPDATE', [ids.centerId, ids.conversationId]);
        await tx.query(`UPDATE cb_participants SET active=true,first_sequence=(SELECT last_sequence+1 FROM cb_conversations WHERE center_id=$1 AND id=$2)
          WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3`, [ids.centerId, ids.conversationId, ids.therapistId]);
      });
      await refresh(therapist);
      await therapist.page.waitForFunction((id) => !!document.querySelector(`[data-testid="inbox"] [data-room-id="${id}"]`), ids.conversationId);
      await room(therapist);
      assert.equal(await composer.inputValue(), '', 'LOCAL_API_BROWSER_RECONNECTED_DRAFT_EMPTY');
      assert.equal(await composer.evaluate(input => input.readOnly), false, 'LOCAL_API_BROWSER_RECONNECTED_OPERATION_EMPTY');
      assert.equal(await therapist.page.getByTestId('send-error').isVisible(), false);
      assert.equal((await api(therapist, `${roomPath}/messages`)).status, 200);
      await workspaceRoom(therapist.page, extra.roomId, { keyboard: width === 320 });
      assert.equal(await composer.inputValue(), allowedDraft, 'LOCAL_API_BROWSER_OTHER_DRAFT_RETAINED');
      const { rows: unsentRows } = await sandbox.database.query(`SELECT count(*)::integer AS count FROM cb_messages
        WHERE center_id=$1 AND body=ANY($2::text[])`, [ids.centerId, [revokedDraft, allowedDraft]]);
      assert.equal(unsentRows[0].count, 0, 'LOCAL_API_BROWSER_DRAFTS_NOT_AUTO_SENT');
      await privateStorage(therapist); await capture(therapist, 'revoked-draft-cleared-other-room-preserved');
      result.nonSelectedDraftRevocation = true;

      phase = `${width}:ACCOUNT_CHANGE_PRECONDITION`;
      // Cookies are shared by tabs in one context. Delay only tab A's GETs so
      // the account switch cannot be accidentally covered by a polling refresh.
      // No response is fabricated: releasing the gate resumes real HTTP reads.
      const otherPage = await guardian.context.newPage();
      otherPage.setDefaultTimeout(12_000);
      otherPage.on('pageerror', () => report.errors.push({ width, role: 'shared-cookie-tab', phase, type: 'pageerror' }));
      otherPage.on('console', (entry) => {
        if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:'))
          report.errors.push({ width, role: 'shared-cookie-tab', phase, type: 'console' });
      });
      const otherActor = { page: otherPage, context: guardian.context, role: 'therapist' };
      let releaseGets;
      const getGate = new Promise((resolve) => { releaseGets = resolve; }), heldGets = [];
      const delayGets = (route) => {
        if (route.request().method() !== 'GET') return route.fallback().catch(() => {});
        const work = (async () => { await getGate; await route.fallback().catch(() => {}); })();
        heldGets.push(work); return work;
      };
      const switchedBody = `가상 계정 변경 전 보호자 발신 ${width}`;
      try {
        await otherPage.goto(origin); await otherPage.getByTestId('home').waitFor();
        await guardian.page.bringToFront(); await refresh(guardian); await room(guardian);
        await guardian.page.route('**/api/local/**', delayGets);
        fault.loseNext = true; await post(guardian, switchedBody);
        await guardian.page.getByTestId('send-error').waitFor();
        assert.equal(fault.failure, false); assert.equal(await count(switchedBody), 1);
        const operation = sent.find((item) => item.body === switchedBody);
        assert(operation, 'LOCAL_API_BROWSER_OLD_ACCOUNT_OPERATION');
        await workspaceAccountAction(otherPage, 'logout');
        await otherPage.getByTestId('login-form').waitFor(); await login(otherActor);
        const retry = guardian.page.getByRole('button', { name: '다시 보내기', exact: true });
        if (await retry.isVisible()) {
          await Promise.all([
            guardian.page.waitForResponse((response) => response.url() === `${origin}${roomPath}/messages` && response.request().method() === 'POST' && response.status() === 401),
            retry.click(),
          ]);
          result.accountChangeUiRetry = true;
        } else {
          // Hiding a tab may have already removed its composer. That is safe;
          // still prove the old account's exact request cannot become B's send.
          assert.equal(await guardian.page.getByTestId('message-row').count(), 0);
          assert.equal((await api(guardian, `${roomPath}/messages`, { clientId: operation.clientId, body: operation.body })).status, 401);
          result.accountChangeUiRetry = false;
        }
        assert.equal(await count(switchedBody), 1, 'LOCAL_API_BROWSER_ACCOUNT_CHANGE_NO_DUPLICATE');
        const { rows: authors } = await sandbox.database.query('SELECT author_id FROM cb_messages WHERE center_id=$1 AND conversation_id=$2 AND body=$3', [ids.centerId, ids.conversationId, switchedBody]);
        assert.equal(authors[0].author_id, ids.guardianId, 'LOCAL_API_BROWSER_AUTHOR_NOT_REBOUND');
      } finally {
        releaseGets(); await Promise.allSettled(heldGets);
        await guardian.page.unroute('**/api/local/**', delayGets);
        await otherPage.close();
      }
      await guardian.page.bringToFront();
      await guardian.page.getByTestId('login-form').waitFor();
      assert.equal(await guardian.page.getByTestId('message-row').count(), 0);
      assert.equal(await guardian.page.getByLabel('메시지', { exact: true }).count(), 0);
      result.accountChangePrecondition = true;
      await login(guardian); await room(guardian);

      phase = `${width}:LOGOUT_FAILURE`;
      await therapist.context.setOffline(true);
      await workspaceAccountAction(therapist.page, 'logout');
      await therapist.page.getByTestId('logout-error').waitFor();
      assert.equal(await therapist.page.getByTestId('message-row').count(), 0);
      assert.equal(await therapist.page.getByLabel('메시지', { exact: true }).count(), 0);
      await therapist.context.setOffline(false);
      await therapist.page.getByRole('button', { name: '로그아웃 다시 시도', exact: true }).click();
      await therapist.page.getByTestId('login-form').waitFor();
      assert.equal((await api(therapist, '/api/local/auth/session')).status, 401); result.logoutFailure = true;

      phase = `${width}:LOGOUT`;
      await workspaceAccountAction(guardian.page, 'logout');
      await guardian.page.getByTestId('login-form').waitFor();
      assert.equal((await api(guardian, '/api/local/auth/session')).status, 401);
      assert.equal((await api(guardian, inboxPath)).status, 401);
      assert.equal(await guardian.page.getByTestId('message-row').count(), 0);
      await guardian.page.reload(); await guardian.page.getByTestId('login-form').waitFor(); result.logout = true;

      phase = `${width}:RELATIONSHIP_REMOVED`;
      await login(guardian); await room(guardian); await row(guardian, initial).waitFor();
      await sandbox.database.transaction(async (tx) => {
        await tx.query('SELECT id FROM cb_conversations WHERE center_id=$1 AND id=$2 FOR UPDATE', [ids.centerId, ids.conversationId]);
        await tx.query('UPDATE cb_participants SET active=false WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3', [ids.centerId, ids.conversationId, ids.guardianId]);
      });
      await refresh(guardian);
      await guardian.page.getByText('대화에 대한 접근 권한이 변경되었어요. 허용된 대화만 다시 불러와 주세요.', { exact: true }).waitFor();
      assert.equal(await guardian.page.getByTestId('message-row').count(), 0);
      assert.equal(await guardian.page.getByLabel('메시지', { exact: true }).count(), 0);
      assert.equal((await api(guardian, `${roomPath}/messages`)).status, 404);
      assert.equal((await api(guardian, `${roomPath}/messages`, { clientId: randomUUID(), body: '가상 권한 철회 후 거부' })).status, 404);
      assert.equal(await count('가상 권한 철회 후 거부'), 0);
      assert.deepEqual((await api(guardian, inboxPath)).value.rooms, []); result.removedRelationship = true;
      assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedRequests, []);
      for (const actor of actors) { await actor.context.close(); openContexts.delete(actor.context); }
      await sandbox.close();
      assert.equal(sandbox.database.closed, true, 'LOCAL_API_BROWSER_DATABASE_CLOSED');
      assert.equal(sandbox.credentials.length, 0, 'LOCAL_API_BROWSER_CREDENTIAL_REFERENCES_CLEARED');
      openSandboxes.delete(sandbox); result.cleanup = true;
      report.checks.push(result);
      console.log(JSON.stringify({ width, passed: true, completedBoundaries: 14 }));
    }
    report.finalSource = await sources();
    assert.equal(report.finalSource.sha256, source.sha256, 'LOCAL_API_BROWSER_SOURCE_CHANGED');
  } catch (error) {
    // Playwright errors may contain filled credentials, request bodies or cookie
    // headers. Preserve only the fixed verification boundary, never raw errors.
    report.failure = { code: 'LOCAL_API_BROWSER_FAILED', phase,
      kind: ['TimeoutError', 'AssertionError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-api-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      helperLine: Number(error?.stack?.match(/local-workspace-browser-helpers\.mjs:(\d+):\d+/)?.[1]) || null,
      assertion: /^LOCAL_API_BROWSER_[A-Z_]+$/.test(error?.message ?? '') ? error.message : null };
  } finally {
    for (const context of openContexts) try { await within(context.close()); openContexts.delete(context); } catch {}
    report.cleanup.contextsClosed = openContexts.size === 0;
    if (browserServer) {
      try { await within(browserServer.close()); } catch { try { await within(browserServer.kill()); } catch {} }
      report.cleanup.browserStopped = typeof browserProcess?.exitCode === 'number' || typeof browserProcess?.signalCode === 'string';
    }
    for (const sandbox of openSandboxes) try {
      await within(sandbox.close());
      assert.equal(sandbox.database.closed, true);
      openSandboxes.delete(sandbox);
    } catch {}
    report.cleanup.sandboxesClosed = openSandboxes.size === 0;
    report.finishedAt = new Date().toISOString();
    report.passed = !report.failure && report.checks.length === 3 && Object.values(report.cleanup).every(Boolean);
    ownership.finished = true; ownership.cleanup = report.cleanup;
    await writeFile(path.join(folder, 'ownership.json'), JSON.stringify(ownership, null, 2));
    await writeFile(path.join(folder, 'results.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length, failure: report.failure, cleanup: report.cleanup }));
  return report.passed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runLocalApiBrowser()) process.exitCode = 1; }
  catch { console.error('LOCAL_API_BROWSER_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

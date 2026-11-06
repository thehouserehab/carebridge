// Four-menu UI -> real loopback HTTP -> owned memory-only PostgreSQL -> UI.
// Additional room/profile/goal rows are synthetic fixture setup, not UI evidence.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceView, workspaceRoom, workspaceRecords, workspaceAccountAction } from './local-workspace-browser-helpers.mjs';
import { getPendingSyntheticCleanup } from '../server/local-sandbox-cleanup.mjs';
import { verifyDesktopChatLayout } from './local-desktop-chat-browser-helpers.mjs';
import { verifyMobileChatLayout } from './local-mobile-chat-browser-helpers.mjs';
import { verifyResponsiveShell } from './local-responsive-shell-browser-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
async function sources() {
  const names = ['tests/local-product-browser.mjs', 'tests/local-workspace-browser-helpers.mjs',
    'tests/local-desktop-chat-browser-helpers.mjs', 'tests/local-mobile-chat-browser-helpers.mjs',
    'tests/local-responsive-shell-browser-helpers.mjs'];
  for (const directory of ['local-api', 'src', 'server', 'server/migrations']) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      if (entry.isDirectory() || !/\.(?:mjs|js|css|html|sql)$/.test(entry.name)) continue;
      assert(entry.isFile() && !entry.isSymbolicLink(), 'LOCAL_PRODUCT_SOURCE_TYPE');
      names.push(`${directory}/${entry.name}`);
    }
  }
  const files = [];
  for (const name of names.sort()) files.push({ name, sha256: hash(await readFile(path.join(root, name))) });
  return { sha256: hash(JSON.stringify(files)), files };
}
async function bounded(work, milliseconds = 10_000) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('LOCAL_PRODUCT_CLEANUP_TIMEOUT')), milliseconds);
  })]); } finally { clearTimeout(timer); }
}
export async function waitForProductReadingFixture(page, roomId, messageIds) {
  assert(typeof roomId === 'string' && roomId.length > 0 && Array.isArray(messageIds) &&
    messageIds.length === 4 && messageIds.every((id) => typeof id === 'string' && id.length > 0) &&
    new Set(messageIds).size === 4, 'LOCAL_PRODUCT_READING_FIXTURE_IDS');
  // One synchronous DOM observation: network-idle or individually awaited
  // rows can belong to different snapshots and do not establish readiness.
  const ready = await page.waitForFunction(({ roomId, messageIds }) => {
    const activeChat = [...document.querySelectorAll('button[data-view="chat"][aria-current="page"]')]
      .some((node) => node.getClientRects().length > 0);
    const selected = [...document.querySelectorAll('[data-testid="inbox"] [data-room-id][aria-current="true"]')];
    const list = document.querySelector('[data-testid="room"] [data-testid="message-list"]');
    if (!activeChat || selected.length !== 1 || selected[0].dataset.roomId !== roomId ||
        !list || list.getClientRects().length === 0) return false;
    const ids = [...list.querySelectorAll('[data-testid="message-row"][data-message-id]')]
      .map((node) => node.dataset.messageId);
    if (!messageIds.every((id) => ids.filter((present) => present === id).length === 1)) return false;
    return { expected: messageIds.length, received: messageIds.length, rowCount: ids.length };
  }, { roomId, messageIds }, { timeout: 15_000 });
  try { return await ready.jsonValue(); } finally { await ready.dispose(); }
}
async function secondRoom(sandbox) {
  const id = randomUUID(), ids = sandbox.ids;
  const extra = { childId: `product-child-${id}`, conversationId: `product-room-${id}`, goalId: `product-goal-${id}` };
  await sandbox.database.transaction(async (tx) => {
    await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)', [ids.centerId, extra.childId]);
    await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)', [ids.centerId, extra.conversationId, extra.childId]);
    await tx.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
      VALUES ($1,$2,$3,'therapist',true,1),($1,$2,$4,'guardian',true,1)`, [ids.centerId, extra.conversationId, ids.therapistId, ids.guardianId]);
    await tx.query(`INSERT INTO cb_child_profiles(center_id,child_id,name,age,age_as_of,revision,updated_by)
      VALUES ($1,$2,'가상 두 번째 아동',NULL,NULL,1,$3)`, [ids.centerId, extra.childId, ids.therapistId]);
  });
  const { Goals } = await import('../server/care-contexts.mjs');
  await new Goals(sandbox.database).save({ centerId: ids.centerId, userId: ids.therapistId }, {
    conversationId: extra.conversationId, goalId: extra.goalId, clientId: randomUUID(), expectedRevision: 0,
    content: { title: '가상 두 번째 아이의 목표', description: '별도 아이 문맥 시험', status: 'active' },
  });
  return extra;
}

export async function runLocalProductBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const file of [options.module, options.executable]) assert((await lstat(file)).isFile());
  const source = await sources();
  const { chromium } = await import(pathToFileURL(options.module).href);
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-product-${runId}`);
  await mkdir(folder);
  const report = { runId, at: new Date().toISOString(), source, passed: false, checks: [], screenshots: [],
    errors: [], unexpectedRequests: [], failure: null,
    cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Synthetic two-room fixture, real loopback HTTP and memory-only PGlite; no user tabs, real accounts, actual child information or persistent database.',
      'Viewport emulation is not physical-device, production deployment or human usability evidence.',
      'Photo/video HTTP integration and notification delivery are not part of this test.',
      'Real workspace-message and record GET responses are intentionally delayed across menu navigation; their status/body are not fabricated.',
      'SQL creates only the extra fixture relationship/profile and revokes a synthetic relationship; record/message/share actions are performed through UI.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, origins: [], startedAt: report.at, finished: false };
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2));
  await save('ownership.json', ownership); await save('source-manifest.json', source);
  let browserServer, browserProcess, browser, pendingCleanup, phase = 'STARTUP';
  const contexts = new Set(), sandboxes = new Set();
  const advance = async (next) => {
    phase = next; await save('progress.json', { runId, phase, at: new Date().toISOString(), sourceSha256: source.sha256,
      completed: report.checks, current: report.currentCheck ?? null });
  };
  try {
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    browserProcess = browserServer.process(); ownership.browserProcessId = browserProcess.pid; await save('ownership.json', ownership);
    browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    for (const width of [390, 1440, 320]) {
      await advance(`${width}:START_SANDBOX`);
      const sandbox = await createLocalApiSandbox({ port: 0 }); sandboxes.add(sandbox);
      const ids = sandbox.ids, extra = await secondRoom(sandbox), url = new URL(sandbox.origin);
      assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.pathname, '/');
      assert(url.port && !url.username && !url.password && !url.search && !url.hash);
      const origin = url.origin, base = `/api/local/centers/${ids.centerId}/conversations/${ids.conversationId}`;
      ownership.origins.push(origin); await save('ownership.json', ownership);
      const result = { width, homeNoRead: false, navigationNoRead: false, homeTarget: false, readIsolation: false, sameRoomTarget: false,
        homeScheduleFirstChild: false, homeScheduleSelectedChild: false, homeScheduleMonth: false, homeScheduleNoRead: false,
        navigationCancelsPendingSchedule: false,
        draftIsolation: false, appointmentRecord: false, navigationCancelsPendingOpen: false, navigationCancelsLateDialog: false,
        closedMenuPollAnchor: false, roomReadingAnchor: false, explicitHomeTargetPriority: false, publicRecords: false, guardianPrivateRequests: false,
        nonChatRevocation: false, storagePrivate: false, layout: false, cleanup: false };
      report.currentCheck = result;
      const reads = [], operations = [], guardianPrivateRequests = [];
      const actor = async (role) => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR',
          isMobile: width <= 640, hasTouch: width <= 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context);
        await context.route('**/*', async (route) => {
          const request = route.request(), requested = new URL(request.url());
          const asset = ['/', '/favicon.ico', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/client.js', '/local-api/care-client.js',
            '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css', '/local-api/media-client.js', '/local-api/media-ui.js', '/local-api/media-viewer.js', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js'].includes(requested.pathname) && ['GET', 'HEAD'].includes(request.method());
          const primaryRead = request.method() === 'GET' && requested.pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
            [...requested.searchParams].length === 1 && [ids.conversationId, extra.conversationId].includes(requested.searchParams.get('conversationId'));
          const api = /^\/api\/local\/(?:auth\/(?:login|session|logout)|centers\/[A-Za-z0-9_-]+\/(?:inbox|conversations\/[A-Za-z0-9_-]+\/(?:profile|read|goals|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+)?|records(?:\/[A-Za-z0-9_-]+(?:\/(?:preview|publish))?)?)))$/.test(requested.pathname);
          if (requested.origin !== origin || !['GET', 'POST', 'HEAD'].includes(request.method()) || !(asset || api || primaryRead)) {
            report.unexpectedRequests.push({ width, role, phase, sameOrigin: requested.origin === origin, method: request.method() });
            return route.abort().catch(() => {});
          }
          if (role === 'guardian' && /\/(?:records(?:\/|$)|feedback\/[^/]+\/review$)/.test(requested.pathname))
            guardianPrivateRequests.push({ phase, method: request.method() });
          if (request.method() === 'POST') {
            if (requested.pathname.endsWith('/read')) reads.push({ role, roomId: requested.pathname.split('/').at(-2), messageId: request.postDataJSON().messageId });
            else if (requested.pathname.startsWith(base)) operations.push({ pathname: requested.pathname, body: request.postDataJSON() });
          }
          return route.continue().catch(() => {});
        });
        const page = await context.newPage(); page.setDefaultTimeout(15_000);
        page.on('pageerror', () => report.errors.push({ width, role, phase, type: 'pageerror' }));
        page.on('console', (entry) => {
          if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:')) report.errors.push({ width, role, phase, type: 'console' });
        });
        await page.goto(origin); await page.getByTestId('login-form').waitFor();
        const credential = sandbox.credentials.find((item) => item.role === role);
        assert(credential?.email.endsWith('.test'), 'LOCAL_PRODUCT_SYNTHETIC_CREDENTIAL');
        await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click(); await page.getByTestId('home').waitFor();
        await page.getByTestId('home').locator(`[data-open-room="${extra.conversationId}"]`).first().waitFor();
        return { page, context, role };
      };
      const therapist = await actor('therapist'), guardian = await actor('guardian'), actors = [therapist, guardian];
      const room = (who, id = ids.conversationId) => workspaceRoom(who.page, id, { keyboard: width === 320 });
      const noChatDom = async (who) => assert.equal(await who.page.getByTestId('message-row').count(), 0, 'LOCAL_PRODUCT_NON_CHAT_SOURCE_DOM');
      const childContext = async (who, view, roomId) => {
        await workspaceView(who.page, view);
        await who.page.locator('#child-select:not([disabled])').waitFor();
        if (await who.page.locator('#child-select').inputValue() !== roomId) await who.page.locator('#child-select').selectOption(roomId);
        await who.page.waitForFunction((id) => {
          const select = document.querySelector('#child-select');
          return select && !select.disabled && select.value === id;
        }, roomId);
        const surface = who.page.getByTestId(view === 'child' ? 'child-content' : 'records-content');
        await surface.getByRole('heading', { name: roomId === ids.conversationId ? '가상 아동' : '가상 두 번째 아동', exact: true }).waitFor();
        if (view === 'records') await who.page.getByTestId('care').waitFor();
      };
      const refresh = async (who) => {
        await Promise.all([who.page.waitForResponse((response) => response.url().includes('/inbox') && response.status() === 200),
          workspaceAccountAction(who.page, 'refresh')]);
        // Wait for the complete bounded snapshot, not just its first inbox
        // response. Polling is every five seconds; no transport is mocked.
        await who.page.waitForLoadState('networkidle');
      };
      const row = (who, id) => who.page.locator(`[data-testid="message-row"][data-message-id="${id}"]`);
      const field = (name) => therapist.page.getByTestId('care-dialog').locator(`[name="${name}"]`);
      const fill = async (name, value) => {
        const input = field(name);
        for (const details of await input.locator('xpath=ancestor::details').all())
          if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
        await input.fill(value);
      };
      const readCount = async (userId) => (await sandbox.database.query('SELECT count(*)::integer AS count FROM cb_read_states WHERE center_id=$1 AND user_id=$2', [ids.centerId, userId])).rows[0].count;
      const capture = async (who, label) => {
        assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'LOCAL_PRODUCT_PAGE_OVERFLOW');
        const filename = `${width}-${label}.png`;
        await who.page.screenshot({ path: path.join(folder, filename), fullPage: false,
          mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]'), who.page.locator('.workspace-head .account')] });
        report.screenshots.push({ width, label, filename, syntheticOnly: true });
      };

      await advance(`${width}:NON_CHAT_DOES_NOT_READ`);
      assert.equal(reads.length, 0); assert.equal(await readCount(ids.guardianId), 0); result.homeNoRead = true;
      for (const who of actors) {
        await workspaceView(who.page, 'chat');
        await who.page.getByTestId('inbox').locator(`[data-room-id="${ids.conversationId}"]`).waitFor();
        assert.equal(await who.page.getByLabel('메시지', { exact: true }).isVisible(), false, 'LOCAL_PRODUCT_LIST_NOT_ROOM');
        for (const view of ['records', 'child', 'home']) {
          await workspaceView(who.page, view);
          if (view !== 'home') {
            await childContext(who, view, extra.conversationId);
            await childContext(who, view, ids.conversationId);
          } else await who.page.getByTestId('home').locator(`[data-open-room="${ids.conversationId}"]`).first().waitFor();
          await capture(who, `${who.role}-${view}`);
        }
      }
      assert.equal(reads.length, 0, 'LOCAL_PRODUCT_NON_CHAT_READ_REQUEST');
      assert.equal(await readCount(ids.guardianId), 0); assert.equal(await readCount(ids.therapistId), 0); result.navigationNoRead = true;

      if (width === 1440) {
        await advance(`${width}:RESPONSIVE_WORKSPACE_SHELL`);
        const beforeOperations = operations.length, beforeReads = reads.length;
        result.responsiveShellEvidence = [];
        for (const who of actors) {
          const geometry = await verifyResponsiveShell({ page: who.page,
            capture: label => capture(who, `${who.role}-${label}`) });
          result.responsiveShellEvidence.push({ role: who.role, ...geometry });
          await noChatDom(who);
        }
        assert.equal(operations.length, beforeOperations, 'LOCAL_PRODUCT_SHELL_NO_WRITE');
        assert.equal(reads.length, beforeReads, 'LOCAL_PRODUCT_SHELL_NO_READ_REQUEST');
        assert.equal(await readCount(ids.guardianId), 0); assert.equal(await readCount(ids.therapistId), 0);
        result.responsiveShellLayout = true;
      }

      await advance(`${width}:HOME_SCHEDULE_ENTRY`);
      const scheduleReadSnapshot = async () => (await sandbox.database.query(`SELECT user_id,conversation_id,sequence
        FROM cb_read_states WHERE center_id=$1 ORDER BY user_id,conversation_id`, [ids.centerId])).rows;
      const scheduleReadsBefore = reads.length, scheduleCursorsBefore = await scheduleReadSnapshot();
      const scheduleTarget = async (who, id) => {
        const name = id === ids.conversationId ? '가상 아동' : '가상 두 번째 아동';
        await who.page.getByTestId('child-content').locator('[data-schedule-heading]').waitFor();
        await who.page.waitForFunction(({ id, name }) => {
          const title = document.querySelector('[data-schedule-heading]');
          const select = document.querySelector('#child-select');
          if (!title || title.tagName !== 'H2' || title.textContent !== `${name}의 일정` ||
              document.activeElement !== title || select?.value !== id || select.disabled) return false;
          const box = title.getBoundingClientRect();
          const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
          return box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= innerHeight &&
            box.left >= 0 && box.right <= innerWidth + 1 && (hit === title || title.contains(hit)) &&
            document.documentElement.scrollWidth <= innerWidth + 1;
        }, { id, name });
        assert.equal(await who.page.locator('button[data-view="child"]:visible').getAttribute('aria-current'), 'page');
        assert.deepEqual(await who.page.locator('button[data-view]:visible').evaluateAll((nodes) => nodes.map((n) => n.dataset.view).sort()),
          ['chat', 'child', 'home', 'records'], 'LOCAL_PRODUCT_SCHEDULE_FOUR_MENUS');
        assert.equal(await who.page.getByTestId('child-appointments').evaluate((panel) => {
          const bounds = panel.getBoundingClientRect(), style = getComputedStyle(panel);
          const left = bounds.left + parseFloat(style.paddingLeft), right = bounds.right - parseFloat(style.paddingRight);
          return [...panel.querySelectorAll('.period-head button')].every((button) => {
            const box = button.getBoundingClientRect();
            return box.left >= left - 1 && box.right <= right + 1 && box.height >= 43.5;
          });
        }), true, 'LOCAL_PRODUCT_SCHEDULE_ACTIONS_INSIDE_CARD');
        await noChatDom(who);
      };
      const openSchedule = async (who) => {
        const button = who.page.getByTestId('home').locator('[data-home-panel="schedule"] button[data-open-schedule]');
        assert.equal(await button.innerText(), '전체 일정');
        assert.equal(await button.isEnabled(), true, 'LOCAL_PRODUCT_SCHEDULE_SHORTCUT_ENABLED');
        if (width === 320) { await button.focus(); await button.press('Enter'); }
        else await button.click();
      };
      const schedulePeriod = (who) => who.page.getByTestId('child-appointments').locator('.period-head .section-head p');
      result.scheduleObservations = [];
      // Fresh UI logins establish genuinely unselected entry. Existing actors
      // retain their original state for every pre-existing scenario below.
      for (const role of ['therapist', 'guardian']) {
        const who = await actor(role);
        try {
          assert.equal(await who.page.locator('#child-select').inputValue(), '', 'LOCAL_PRODUCT_SCHEDULE_FIRST_SELECTION_EMPTY');
          const firstAllowed = await who.page.locator('#child-select').evaluate((select) => [...select.options].find((option) => option.value)?.value);
          assert([ids.conversationId, extra.conversationId].includes(firstAllowed), 'LOCAL_PRODUCT_SCHEDULE_ALLOWED_FIRST_CHILD');
          const initialLabel = await who.page.getByTestId('home').locator('[data-home-panel="schedule"] .section-head p').innerText();
          await openSchedule(who); await scheduleTarget(who, firstAllowed);
          assert.equal(await schedulePeriod(who).innerText(), initialLabel, 'LOCAL_PRODUCT_SCHEDULE_FIRST_PERIOD_PRESERVED');
          await capture(who, `${role}-schedule-first-child`);

          await childContext(who, 'child', extra.conversationId);
          await who.page.getByTestId('child-appointments').getByText('이번 조회 기간의 일정이 없습니다.', { exact: true }).waitFor();
          await workspaceView(who.page, 'home'); await openSchedule(who); await scheduleTarget(who, extra.conversationId);
          assert.equal(await schedulePeriod(who).innerText(), initialLabel, 'LOCAL_PRODUCT_SCHEDULE_SELECTED_PERIOD_PRESERVED');
          await capture(who, `${role}-schedule-empty-selected-child`);

          const month = /^(\d{4})년 (\d{1,2})월$/.exec(initialLabel);
          assert(month, 'LOCAL_PRODUCT_SCHEDULE_PERIOD_LABEL');
          const range = (offset) => {
            const start = new Date(Date.UTC(Number(month[1]), Number(month[2]) - 1 + offset, 1));
            const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
            return { dateFrom: start.toISOString().slice(0, 10), dateTo: end.toISOString().slice(0, 10),
              label: `${start.getUTCFullYear()}년 ${start.getUTCMonth() + 1}월` };
          };
          const shiftMonth = async (offset, expected) => {
            const [response] = await Promise.all([
              who.page.waitForResponse((response) => {
                const requested = new URL(response.url());
                return response.request().method() === 'GET' && response.status() === 200 && requested.origin === origin &&
                  requested.pathname === `/api/local/centers/${ids.centerId}/conversations/${extra.conversationId}/appointments` &&
                  requested.searchParams.get('dateFrom') === expected.dateFrom && requested.searchParams.get('dateTo') === expected.dateTo;
              }),
              who.page.getByTestId('child-appointments').locator(`[data-month-shift="${offset}"]`).click(),
            ]);
            assert.equal(await response.finished(), null, 'LOCAL_PRODUCT_SCHEDULE_MONTH_RESPONSE_COMPLETE');
            await who.page.waitForFunction((label) => document.querySelector('[data-testid="child-appointments"] .period-head .section-head p')?.textContent === label, expected.label);
            assert.equal(await who.page.locator('#child-select').inputValue(), extra.conversationId, 'LOCAL_PRODUCT_SCHEDULE_MONTH_CHILD_PRESERVED');
          };
          await shiftMonth(1, range(1));
          await workspaceView(who.page, 'home');
          assert.equal(await who.page.getByTestId('home').locator('[data-home-panel="schedule"] .section-head p').innerText(), range(1).label);
          await openSchedule(who); await scheduleTarget(who, extra.conversationId);
          assert.equal(await schedulePeriod(who).innerText(), range(1).label, 'LOCAL_PRODUCT_SCHEDULE_REENTRY_MONTH_PRESERVED');
          await capture(who, `${role}-schedule-next-month`);
          await shiftMonth(-1, range(0));
          await noChatDom(who);
          result.scheduleObservations.push({ role, firstChild: firstAllowed === ids.conversationId ? 'A' : 'B',
            selectedEmptyChild: 'B', nextMonthResponse: true, returnedMonthResponse: true });
        } finally { await bounded(who.context.close()); contexts.delete(who.context); }
      }
      result.homeScheduleFirstChild = result.homeScheduleSelectedChild = result.homeScheduleMonth = true;

      await advance(`${width}:NAVIGATION_CANCELS_PENDING_SCHEDULE`);
      const scheduleActor = await actor('therapist');
      let releaseSchedule, reachedSchedule;
      const scheduleGate = new Promise((resolve) => { releaseSchedule = resolve; });
      const scheduleReached = new Promise((resolve) => { reachedSchedule = resolve; });
      const scheduleHeld = [], scheduleFault = { pending: true, status: null, delivery: null, failed: false };
      const pendingScheduleRoom = await scheduleActor.page.locator('#child-select').evaluate((select) => [...select.options].find((option) => option.value)?.value);
      const scheduleUrl = (url) => url.origin === origin && url.pathname === `/api/local/centers/${ids.centerId}/conversations/${pendingScheduleRoom}/messages`;
      const delaySchedule = (route) => {
        if (route.request().method() !== 'GET' || !scheduleFault.pending) return route.fallback().catch(() => {});
        scheduleFault.pending = false;
        const work = (async () => {
          let response;
          try {
            response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
            scheduleFault.status = response.status(); reachedSchedule(); await scheduleGate;
            await route.fulfill({ response }); scheduleFault.delivery = 'delivered';
          } catch { scheduleFault.failed = true; reachedSchedule(); await route.abort().catch(() => {}); }
          finally { await response?.dispose().catch(() => {}); }
        })();
        scheduleHeld.push(work); return work;
      };
      await scheduleActor.page.route(scheduleUrl, delaySchedule);
      try {
        await openSchedule(scheduleActor); await bounded(scheduleReached, 15_000);
        assert.equal(scheduleFault.status, 200, 'LOCAL_PRODUCT_PENDING_SCHEDULE_REAL_RESPONSE');
        assert.equal(scheduleFault.failed, false);
        await workspaceView(scheduleActor.page, 'home');
        // Home can still be the permission-checking shell while selection is
        // pending. Its navigation control remains mounted in either state.
        await scheduleActor.page.locator('button[data-view="home"]:visible').focus();
        await scheduleActor.page.evaluate(() => {
          window.__localProductScheduleFocusStolen = false;
          window.__localProductScheduleFocusListener = (event) => {
            if (event.target.matches?.('[data-schedule-heading]')) window.__localProductScheduleFocusStolen = true;
          };
          document.addEventListener('focusin', window.__localProductScheduleFocusListener);
        });
        const [response] = await Promise.all([
          scheduleActor.page.waitForResponse((response) => response.request().method() === 'GET' && scheduleUrl(new URL(response.url())) && response.status() === 200),
          (async () => { releaseSchedule(); await bounded(Promise.allSettled(scheduleHeld), 15_000); })(),
        ]);
        assert.equal(await response.finished(), null, 'LOCAL_PRODUCT_PENDING_SCHEDULE_RESPONSE_COMPLETE');
        await scheduleActor.page.waitForLoadState('networkidle');
        assert.equal(scheduleFault.failed, false, 'LOCAL_PRODUCT_PENDING_SCHEDULE_TRANSPORT_FAILURE');
        assert.equal(scheduleFault.delivery, 'delivered', 'LOCAL_PRODUCT_PENDING_SCHEDULE_SETTLED');
        assert.equal(await scheduleActor.page.locator('button[data-view="home"]:visible').getAttribute('aria-current'), 'page', 'LOCAL_PRODUCT_PENDING_SCHEDULE_CHANGED_VIEW');
        assert.equal(await scheduleActor.page.locator('[data-schedule-heading]').isVisible(), false, 'LOCAL_PRODUCT_PENDING_SCHEDULE_REOPENED');
        assert.equal(await scheduleActor.page.evaluate(() => window.__localProductScheduleFocusStolen), false, 'LOCAL_PRODUCT_PENDING_SCHEDULE_FOCUS_STOLEN');
        await noChatDom(scheduleActor); await capture(scheduleActor, 'therapist-cancelled-schedule-home');
        result.navigationCancelsPendingSchedule = true;
      } finally {
        releaseSchedule();
        try { await bounded(Promise.allSettled(scheduleHeld), 15_000); }
        finally {
          await scheduleActor.page.unroute(scheduleUrl, delaySchedule).catch(() => {});
          await scheduleActor.page.evaluate(() => document.removeEventListener('focusin', window.__localProductScheduleFocusListener)).catch(() => {});
          await bounded(scheduleActor.context.close()); contexts.delete(scheduleActor.context);
        }
      }
      assert.equal(reads.length, scheduleReadsBefore, 'LOCAL_PRODUCT_SCHEDULE_READ_REQUEST');
      assert.deepEqual(await scheduleReadSnapshot(), scheduleCursorsBefore, 'LOCAL_PRODUCT_SCHEDULE_READ_CURSOR_CHANGED');
      assert.equal(await readCount(ids.guardianId), 0); assert.equal(await readCount(ids.therapistId), 0);
      result.homeScheduleNoRead = true;

      await advance(`${width}:HOME_TARGET_AND_VISIBLE_READ`);
      const first = (await sandbox.database.query('SELECT id,sequence FROM cb_messages WHERE center_id=$1 AND conversation_id=$2 ORDER BY sequence LIMIT 1', [ids.centerId, ids.conversationId])).rows[0];
      const news = guardian.page.getByTestId('home').locator(`[data-open-room="${ids.conversationId}"][data-target-id="${first.id}"]`);
      await Promise.all([
        guardian.page.waitForResponse((response) => response.url() === `${origin}${base}/read` && response.status() === 200 && response.request().postDataJSON()?.messageId === first.id),
        news.click(),
      ]);
      await row(guardian, first.id).waitFor();
      assert.equal(await row(guardian, first.id).evaluate((node) => node.classList.contains('target')), true, 'LOCAL_PRODUCT_HOME_TARGET');
      assert(reads.some((r) => r.role === 'guardian' && r.messageId === first.id));
      assert.equal(await readCount(ids.guardianId), 1); result.homeTarget = true;
      assert.equal(await readCount(ids.therapistId), 0, 'LOCAL_PRODUCT_OTHER_USER_READ_UNCHANGED');
      assert.equal(reads.filter((read) => read.role === 'therapist').length, 0, 'LOCAL_PRODUCT_OTHER_USER_READ_REQUEST');
      const guardianRead = (await sandbox.database.query(`SELECT conversation_id,sequence FROM cb_read_states
        WHERE center_id=$1 AND user_id=$2`, [ids.centerId, ids.guardianId])).rows;
      assert.deepEqual(guardianRead.map(({ conversation_id, sequence }) => ({ roomId: conversation_id, sequence: Number(sequence) })),
        [{ roomId: ids.conversationId, sequence: Number(first.sequence) }], 'LOCAL_PRODUCT_ONLY_TARGET_ROOM_READ');
      result.readIsolation = true;
      await workspaceView(guardian.page, 'home');
      await room(therapist);
      const latestBody = `가상 이미 선택한 방의 새 소식 ${width}`;
      await therapist.page.getByLabel('메시지', { exact: true }).fill(latestBody);
      await therapist.page.getByRole('button', { name: '보내기', exact: true }).click();
      await therapist.page.getByTestId('message-row').getByText(latestBody, { exact: true }).waitFor();
      const latest = (await sandbox.database.query('SELECT id FROM cb_messages WHERE center_id=$1 AND body=$2', [ids.centerId, latestBody])).rows[0];
      await refresh(guardian);
      const latestNews = guardian.page.getByTestId('home').locator(`[data-open-room="${ids.conversationId}"][data-target-id="${latest.id}"]`);
      await latestNews.waitFor(); await latestNews.click(); await row(guardian, latest.id).waitFor();
      assert.equal(await row(guardian, latest.id).evaluate((node) => node.classList.contains('target')), true, 'LOCAL_PRODUCT_RESELECT_TARGET'); result.sameRoomTarget = true;

      await advance(`${width}:TWO_ROOM_DRAFTS_AND_LAYOUT`);
      const draftA = `가상 첫 아이 미전송 ${width}`, draftB = `가상 둘째 아이 미전송 ${width}`;
      await therapist.page.getByLabel('메시지', { exact: true }).fill(draftA);
      await workspaceRecords(therapist.page, ids.conversationId); await noChatDom(therapist);
      await childContext(therapist, 'child', ids.conversationId); await noChatDom(therapist);
      await workspaceView(therapist.page, 'home'); await noChatDom(therapist);
      await room(therapist);
      assert.equal(await therapist.page.getByLabel('메시지', { exact: true }).inputValue(), draftA);
      await room(therapist, extra.conversationId);
      assert.equal(await therapist.page.getByLabel('메시지', { exact: true }).inputValue(), '');
      await therapist.page.getByLabel('메시지', { exact: true }).fill(draftB);
      await childContext(therapist, 'child', extra.conversationId);
      await noChatDom(therapist);
      assert.equal(await therapist.page.locator('#child-select').inputValue(), extra.conversationId);
      await therapist.page.getByRole('heading', { name: '가상 두 번째 아이의 목표', exact: true }).waitFor();
      await workspaceRecords(therapist.page, extra.conversationId); await noChatDom(therapist); await room(therapist, ids.conversationId);
      assert.equal(await therapist.page.getByLabel('메시지', { exact: true }).inputValue(), draftA);
      await room(therapist, extra.conversationId);
      assert.equal(await therapist.page.getByLabel('메시지', { exact: true }).inputValue(), draftB);
      assert.equal((await sandbox.database.query('SELECT count(*)::integer AS count FROM cb_messages WHERE center_id=$1 AND body=ANY($2::text[])', [ids.centerId, [draftA, draftB]])).rows[0].count, 0);
      result.draftIsolation = true;
      if (width <= 640) {
        assert.equal(await therapist.page.getByTestId('inbox').isVisible(), false, 'LOCAL_PRODUCT_MOBILE_SINGLE_ROOM');
        await therapist.page.locator('[data-action="room-list"]:visible').click();
        assert.equal(await therapist.page.getByLabel('메시지', { exact: true }).isVisible(), false, 'LOCAL_PRODUCT_MOBILE_SINGLE_LIST');
        await room(therapist, extra.conversationId);
        await therapist.page.setViewportSize({ width, height: 420 });
        await therapist.page.getByLabel('메시지', { exact: true }).focus();
        const sendButton = therapist.page.getByRole('button', { name: '보내기', exact: true });
        await sendButton.scrollIntoViewIfNeeded(); await sendButton.click({ trial: true });
        const nav = await therapist.page.locator('button[data-view="home"]:visible').boundingBox();
        const send = await sendButton.boundingBox();
        assert(nav && send && send.y >= 0 && send.y + send.height <= nav.y, 'LOCAL_PRODUCT_COMPOSER_ABOVE_NAV');
        await therapist.page.setViewportSize({ width, height: 900 });
      } else {
        const list = await therapist.page.getByTestId('inbox').boundingBox(), selected = await therapist.page.getByTestId('room').boundingBox();
        assert(list && selected && list.x + list.width <= selected.x + 1, 'LOCAL_PRODUCT_DESKTOP_TWO_COLUMNS');
      }
      await capture(therapist, 'conversation'); result.layout = true;

      await advance(`${width}:APPOINTMENT_TO_RECORD`);
      await workspaceView(therapist.page, 'home');
      const appointment = (await sandbox.database.query('SELECT date::text AS date,title,current_revision FROM cb_appointments WHERE center_id=$1 AND id=$2', [ids.centerId, ids.appointmentId])).rows[0];
      await therapist.page.getByTestId('home').locator(`[data-appointment-record="${ids.appointmentId}"][data-context-room="${ids.conversationId}"]`).click();
      await therapist.page.getByTestId('care-dialog').waitFor();
      assert.equal(await field('date').inputValue(), appointment.date, 'LOCAL_PRODUCT_APPOINTMENT_DATE_PREFILL');
      assert.equal(await field('title').inputValue(), appointment.title, 'LOCAL_PRODUCT_APPOINTMENT_TITLE_PREFILL');
      assert.equal(await field('goalId').inputValue(), '', 'LOCAL_PRODUCT_APPOINTMENT_GOAL_EXPLICIT');
      const title = `가상 일정에서 만든 기록 ${width}`, privateNote = `가상 비공개 임상 메모 ${width}`, summary = `가상 보호자 공개 요약 ${width}`;
      for (const [name, value] of Object.entries({ title, performed: '가상 직접 관찰', response: '가상 반응', nextPlan: '가상 다음 계획', privateNote, summary })) await fill(name, value);
      await field('goalId').selectOption(ids.goalId);
      await therapist.page.getByTestId('care-dialog').getByRole('button', { name: '기록 저장', exact: true }).click();
      await therapist.page.getByTestId('care-dialog').waitFor({ state: 'hidden' });
      const saveRequest = operations.find((op) => op.body.content?.title === title); assert(saveRequest, 'LOCAL_PRODUCT_RECORD_REQUEST');
      const recordId = saveRequest.pathname.split('/').at(-1);
      assert.equal(saveRequest.body.expectedAppointmentRevision, appointment.current_revision, 'LOCAL_PRODUCT_APPOINTMENT_PRECONDITION');
      assert.equal(saveRequest.body.content.appointmentId, ids.appointmentId);
      const saved = (await sandbox.database.query('SELECT appointment_id,appointment_revision,record_date::text AS date,title,private_note FROM cb_record_revisions WHERE center_id=$1 AND record_id=$2 AND revision=1', [ids.centerId, recordId])).rows[0];
      assert.deepEqual(saved, { appointment_id: ids.appointmentId, appointment_revision: appointment.current_revision, date: appointment.date, title, private_note: privateNote });
      result.appointmentRecord = true;

      await advance(`${width}:NAVIGATION_CANCELS_PENDING_RECORD_OPEN`);
      await room(therapist, extra.conversationId);
      await workspaceView(therapist.page, 'home'); await refresh(therapist);
      let releaseWorkspace, reachedWorkspace;
      const workspaceGate = new Promise((resolve) => { releaseWorkspace = resolve; });
      const workspaceReached = new Promise((resolve) => { reachedWorkspace = resolve; });
      const workspaceHeld = [], workspaceFault = { pending: true, status: null, delivery: null, failed: false };
      const workspaceUrl = (url) => url.origin === origin && url.pathname === `${base}/messages`;
      const pendingAppointmentUrl = `${origin}${base}/appointments/${ids.appointmentId}`;
      let obsoleteAppointmentReads = 0;
      const observeAppointmentRead = (request) => {
        if (request.method() === 'GET' && request.url() === pendingAppointmentUrl) obsoleteAppointmentReads++;
      };
      const delayWorkspace = (route) => {
        if (route.request().method() !== 'GET' || !workspaceFault.pending) return route.fallback().catch(() => {});
        workspaceFault.pending = false;
        const work = (async () => {
          let response;
          try {
            // Only the selected A room's real read is delayed. The B room is
            // already loaded, and neither mutations nor response bodies change.
            response = await route.fetch({ maxRedirects: 0 });
            workspaceFault.status = response.status(); reachedWorkspace(); await workspaceGate;
            try { await route.fulfill({ response }); workspaceFault.delivery = 'delivered'; }
            catch {
              if (route.request().failure()?.errorText === 'net::ERR_ABORTED') workspaceFault.delivery = 'cancelled';
              else workspaceFault.failed = true;
            }
          } catch { workspaceFault.failed = true; reachedWorkspace(); await route.abort().catch(() => {}); }
          finally { await response?.dispose().catch(() => {}); }
        })();
        workspaceHeld.push(work); return work;
      };
      await therapist.page.route(workspaceUrl, delayWorkspace);
      therapist.page.on('request', observeAppointmentRead);
      try {
        // Saved records are absent from home's draft-only list. The existing
        // scheduled appointment offers "continue record" for this saved record
        // and reads its current appointment before loading the record itself.
        const continueRecord = therapist.page.getByTestId('home').locator(`[data-appointment-record="${ids.appointmentId}"][data-context-room="${ids.conversationId}"]`);
        await continueRecord.waitFor();
        assert.equal(await continueRecord.innerText(), '기록 이어보기', 'LOCAL_PRODUCT_PENDING_OPEN_APPOINTMENT_LINK');
        await continueRecord.click();
        await bounded(workspaceReached, 15_000);
        assert.equal(workspaceFault.status, 200, 'LOCAL_PRODUCT_PENDING_OPEN_REAL_RESPONSE');
        assert.equal(workspaceFault.failed, false);
        assert.equal(obsoleteAppointmentReads, 0, 'LOCAL_PRODUCT_APPOINTMENT_READ_BEFORE_WORKSPACE');
        // A single explicit home -> records round trip cancels the original
        // opening intent even though it ends on the same child and menu.
        // Do not use workspaceRoom's retrying navigation helper while gated.
        await workspaceView(therapist.page, 'home');
        await workspaceView(therapist.page, 'records');
        await therapist.page.evaluate(() => {
          window.__localProductPendingDialog = false;
          window.__localProductPendingObserver = new MutationObserver((changes) => {
            for (const change of changes) {
              if (change.type === 'attributes' && change.target.matches('[data-testid="care-dialog"]') &&
                  (change.target.open || change.oldValue === null)) window.__localProductPendingDialog = true;
              for (const node of change.addedNodes) {
                if (node.nodeType === 1 && (node.matches?.('[data-testid="care-dialog"][open]') ||
                    node.querySelector?.('[data-testid="care-dialog"][open]'))) window.__localProductPendingDialog = true;
              }
            }
          });
          window.__localProductPendingObserver.observe(document.body, { subtree: true, childList: true,
            attributes: true, attributeFilter: ['open'], attributeOldValue: true });
        });
        const [deliveredWorkspace] = await Promise.all([
          therapist.page.waitForResponse((response) => response.request().method() === 'GET' &&
            workspaceUrl(new URL(response.url())) && response.status() === 200),
          (async () => { releaseWorkspace(); await Promise.allSettled(workspaceHeld); })(),
        ]);
        // A timeout/cancelled read must not masquerade as navigation success:
        // the stale opening intent is tested after a complete real response.
        assert.equal(await deliveredWorkspace.finished(), null, 'LOCAL_PRODUCT_PENDING_OPEN_RESPONSE_COMPLETE');
        await therapist.page.waitForLoadState('networkidle');
        await therapist.page.getByTestId('records-content').getByRole('heading', { name: '가상 아동', exact: true }).waitFor();
        assert.equal(workspaceFault.failed, false, 'LOCAL_PRODUCT_PENDING_OPEN_TRANSPORT_FAILURE');
        assert.equal(workspaceFault.delivery, 'delivered', 'LOCAL_PRODUCT_PENDING_OPEN_SETTLED');
        assert.equal(obsoleteAppointmentReads, 0, 'LOCAL_PRODUCT_OBSOLETE_APPOINTMENT_REQUEST');
        assert.equal(await therapist.page.evaluate(() => window.__localProductPendingDialog), false, 'LOCAL_PRODUCT_PENDING_DIALOG_TRANSIENT_REOPEN');
        assert.equal(await therapist.page.getByTestId('care-dialog').isVisible(), false, 'LOCAL_PRODUCT_PENDING_DIALOG_REOPENED');
        assert.equal(await therapist.page.locator('button[data-view="records"]:visible').getAttribute('aria-current'), 'page', 'LOCAL_PRODUCT_PENDING_OPEN_CHANGED_VIEW');
        assert.equal(await therapist.page.locator('#child-select').inputValue(), ids.conversationId, 'LOCAL_PRODUCT_PENDING_OPEN_CHANGED_CHILD');
      } finally {
        releaseWorkspace(); await Promise.allSettled(workspaceHeld); await therapist.page.unroute(workspaceUrl, delayWorkspace);
        therapist.page.off('request', observeAppointmentRead);
        await therapist.page.evaluate(() => window.__localProductPendingObserver?.disconnect()).catch(() => {});
      }
      result.observations = { pendingWorkspaceResponse: workspaceFault.delivery };
      result.navigationCancelsPendingOpen = true;

      await advance(`${width}:NAVIGATION_CANCELS_LATE_RECORD_DIALOG`);
      await workspaceRecords(therapist.page, ids.conversationId);
      let releaseRecord, reachedRecord;
      const gate = new Promise((resolve) => { releaseRecord = resolve; });
      const reached = new Promise((resolve) => { reachedRecord = resolve; });
      const held = [], fault = { pending: true, status: null, delivery: null, failed: false };
      const recordUrl = `${origin}${base}/records/${recordId}`;
      const delayRecord = (route) => {
        if (route.request().method() !== 'GET' || !fault.pending) return route.fallback().catch(() => {});
        fault.pending = false;
        const work = (async () => {
          let response;
          try {
            // Obtain the actual authenticated server response before gating its
            // delivery. The user then changes view while this read is pending.
            response = await route.fetch({ maxRedirects: 0 });
            fault.status = response.status(); reachedRecord(); await gate;
            try { await route.fulfill({ response }); fault.delivery = 'delivered'; }
            catch {
              if (route.request().failure()?.errorText === 'net::ERR_ABORTED') fault.delivery = 'cancelled';
              else fault.failed = true;
            }
          } catch { fault.failed = true; reachedRecord(); await route.abort().catch(() => {}); }
          finally { await response?.dispose().catch(() => {}); }
        })();
        held.push(work); return work;
      };
      await therapist.page.route(recordUrl, delayRecord);
      try {
        await therapist.page.locator(`[data-care-action="edit-record"][data-record-id="${recordId}"]`).click();
        await bounded(reached, 15_000);
        assert.equal(fault.status, 200, 'LOCAL_PRODUCT_LATE_RECORD_REAL_RESPONSE');
        assert.equal(fault.failed, false);
        await workspaceView(therapist.page, 'home'); await therapist.page.getByTestId('home').waitFor();
        await therapist.page.evaluate(() => {
          window.__localProductLateDialog = false;
          window.__localProductDialogObserver = new MutationObserver((changes) => {
            for (const change of changes) {
              if (change.type === 'attributes' && change.target.matches('[data-testid="care-dialog"]') &&
                  (change.target.open || change.oldValue === null)) window.__localProductLateDialog = true;
              for (const node of change.addedNodes) {
                if (node.nodeType === 1 && (node.matches?.('[data-testid="care-dialog"][open]') ||
                    node.querySelector?.('[data-testid="care-dialog"][open]'))) window.__localProductLateDialog = true;
              }
            }
          });
          window.__localProductDialogObserver.observe(document.body, { subtree: true, childList: true,
            attributes: true, attributeFilter: ['open'], attributeOldValue: true });
        });
        releaseRecord(); await Promise.allSettled(held);
        await therapist.page.waitForLoadState('networkidle');
        assert.equal(fault.failed, false, 'LOCAL_PRODUCT_LATE_RECORD_TRANSPORT_FAILURE');
        assert(['delivered', 'cancelled'].includes(fault.delivery), 'LOCAL_PRODUCT_LATE_RECORD_SETTLED');
        assert.equal(await therapist.page.evaluate(() => window.__localProductLateDialog), false, 'LOCAL_PRODUCT_LATE_DIALOG_TRANSIENT_REOPEN');
        assert.equal(await therapist.page.getByTestId('care-dialog').isVisible(), false, 'LOCAL_PRODUCT_LATE_DIALOG_REOPENED');
        assert.equal(await therapist.page.locator('button[data-view="home"]:visible').getAttribute('aria-current'), 'page', 'LOCAL_PRODUCT_LATE_DIALOG_CHANGED_VIEW');
        assert(!(await therapist.page.getByTestId('home').innerText()).includes(privateNote), 'LOCAL_PRODUCT_LATE_RECORD_PRIVATE_HOME');
      } finally {
        releaseRecord(); await Promise.allSettled(held); await therapist.page.unroute(recordUrl, delayRecord);
        await therapist.page.evaluate(() => window.__localProductDialogObserver?.disconnect()).catch(() => {});
      }
      result.observations.lateRecordResponse = fault.delivery;
      result.navigationCancelsLateDialog = true;

      await advance(`${width}:ROOM_READING_ANCHOR_AND_EXPLICIT_TARGET`);
      await room(guardian);
      const longMessageIds = [];
      for (let index = 0; index < 4; index++) {
        const body = `가상 읽기 위치 메시지 ${width}-${index + 1}\n${Array.from({ length: 10 }, (_, line) =>
          `${line + 1}. 가상 대화 스크롤 확인용 문장입니다. 실제 아동 자료가 아닙니다.`).join('\n')}`;
        await guardian.page.getByLabel('메시지', { exact: true }).fill(body);
        await guardian.page.getByRole('button', { name: '보내기', exact: true }).click();
        const text = guardian.page.getByTestId('message-row').getByText(body, { exact: true });
        await text.waitFor();
        const id = await text.locator('xpath=ancestor::li[@data-message-id]').getAttribute('data-message-id');
        assert(id, 'LOCAL_PRODUCT_READING_FIXTURE_MESSAGE'); longMessageIds.push(id);
      }
      await room(therapist); await refresh(therapist);
      result.observations.readingFixtureReady = await waitForProductReadingFixture(therapist.page, ids.conversationId, longMessageIds);
      if (width === 1440) {
        await advance(`${width}:DESKTOP_CHAT_READING_AND_WRITING_SPACE`);
        const beforeOperations = operations.length;
        const beforeMessages = (await sandbox.database.query('SELECT count(*)::int AS count FROM cb_messages')).rows[0].count;
        result.observations.desktopChat = [];
        for (const who of actors) {
          await room(who);
          const geometry = await verifyDesktopChatLayout({ page: who.page, roomId: ids.conversationId,
            capture: label => capture(who, `${who.role}-${label}`),
            refreshWhileFocused: async () => {
              const response = await who.page.waitForResponse(response => {
                const requested = new URL(response.url());
                return requested.origin === origin && requested.pathname === `/api/local/centers/${ids.centerId}/primary-communicator`
                  && requested.searchParams.get('conversationId') === ids.conversationId
                  && response.request().method() === 'GET' && response.status() === 200;
              });
              assert.equal(await response.finished(), null, 'LOCAL_PRODUCT_DESKTOP_POLL_FINISHED');
              await who.page.waitForLoadState('networkidle');
            } });
          result.observations.desktopChat.push({ role: who.role, ...geometry });
        }
        assert.equal(operations.length, beforeOperations, 'LOCAL_PRODUCT_DESKTOP_NO_WRITE');
        assert.equal((await sandbox.database.query('SELECT count(*)::int AS count FROM cb_messages')).rows[0].count,
          beforeMessages, 'LOCAL_PRODUCT_DESKTOP_NO_MESSAGE_COMMIT');
        await advance(`${width}:MOBILE_CHAT_FRAME_AND_COMPOSER`);
        result.observations.mobileChat = [];
        for (const who of actors) {
          await room(who);
          const geometry = await verifyMobileChatLayout({ page: who.page, roomId: ids.conversationId,
            capture: label => capture(who, `${who.role}-${label}`),
            refreshWhileFocused: async () => {
              const response = await who.page.waitForResponse(response => {
                const requested = new URL(response.url());
                return requested.origin === origin && requested.pathname === `/api/local/centers/${ids.centerId}/primary-communicator`
                  && requested.searchParams.get('conversationId') === ids.conversationId
                  && response.request().method() === 'GET' && response.status() === 200;
              });
              assert.equal(await response.finished(), null, 'LOCAL_PRODUCT_MOBILE_POLL_FINISHED');
              await who.page.waitForLoadState('networkidle');
            } });
          result.observations.mobileChat.push({ role: who.role, ...geometry });
        }
        assert.equal(operations.length, beforeOperations, 'LOCAL_PRODUCT_MOBILE_NO_WRITE');
        assert.equal((await sandbox.database.query('SELECT count(*)::int AS count FROM cb_messages')).rows[0].count,
          beforeMessages, 'LOCAL_PRODUCT_MOBILE_NO_MESSAGE_COMMIT');
        result.mobileChatLayout = true;
        await room(therapist);
      }
      const readingPosition = () => therapist.page.getByTestId('message-list').evaluate((list) => {
        const top = list.getBoundingClientRect().top + list.clientTop;
        // Menu actions carry the same ID but are not message rows. This
        // independent observation must never reproduce the app's old selector.
        const anchor = [...list.querySelectorAll('[data-testid="message-row"][data-message-id]')].find((node) => node.getBoundingClientRect().bottom > top);
        return { messageId: anchor?.dataset.messageId ?? null,
          offset: anchor ? anchor.getBoundingClientRect().top - top : 0, top: list.scrollTop,
          atEnd: list.scrollHeight - list.scrollTop - list.clientHeight < 48 };
      });
      // Native focus of a keyboard-operable message summary scrolls to history;
      // this never assigns scrollTop or injects the app's saved-position state.
      const historyMenu = row(therapist, longMessageIds[1]).locator('.care-message-menu');
      const historySummary = historyMenu.locator(':scope > summary');
      // Keep setup evidence distinct from the anchor-preservation assertions.
      // Native disclosure/focus can scroll; a setup failure is not evidence
      // that the later polling or room-switch restoration ran at all.
      result.observations.readingAnchorSetup = [];
      const observeReadingSetup = async (stage) => {
        const position = await readingPosition();
        const geometry = await therapist.page.getByTestId('message-list').evaluate((list) => ({
          clientHeight: list.clientHeight, scrollHeight: list.scrollHeight,
          rowCount: list.querySelectorAll('[data-testid="message-row"]').length,
        }));
        result.observations.readingAnchorSetup.push({ stage, ...geometry,
          scrollTop: position.top, offset: position.offset, atEnd: position.atEnd,
          anchorPresent: !!position.messageId, fixtureIndex: longMessageIds.indexOf(position.messageId) });
      };
      await observeReadingSetup('before-focus');
      await historySummary.focus();
      await observeReadingSetup('focused');
      assert.equal(await historyMenu.getAttribute('open'), null, 'LOCAL_PRODUCT_READING_MENU_INITIAL_CLOSED');
      await historySummary.press('Enter');
      await observeReadingSetup('opened');
      assert.notEqual(await historyMenu.getAttribute('open'), null, 'LOCAL_PRODUCT_READING_MENU_OPEN');
      await historySummary.press('Enter');
      await observeReadingSetup('closed');
      assert.equal(await historyMenu.getAttribute('open'), null, 'LOCAL_PRODUCT_READING_MENU_CLOSED');
      assert(await therapist.page.getByTestId('message-list')
        .locator('.care-message-menu:not([open]) [data-care-action][data-message-id]').count() > 0,
      'LOCAL_PRODUCT_READING_CLOSED_MENU_ACTIONS_PRESENT');
      const beforeSwitch = await readingPosition();
      if (!(beforeSwitch.messageId && beforeSwitch.top > 0 && !beforeSwitch.atEnd))
        await capture(therapist, 'reading-anchor-setup-failed');
      assert(beforeSwitch.messageId && beforeSwitch.top > 0 && !beforeSwitch.atEnd, 'LOCAL_PRODUCT_READING_ANCHOR_IN_HISTORY');
      assert.notEqual(beforeSwitch.messageId, longMessageIds.at(-1), 'LOCAL_PRODUCT_READING_ANCHOR_NOT_LATEST');
      // Observe two ordinary scheduled HTTP polls without clicking refresh,
      // changing scrollTop, or modifying the application's saved-position map.
      // Hidden nested menu buttons remain present throughout this regression.
      for (let poll = 0; poll < 2; poll++) {
        await therapist.page.waitForResponse((response) => {
          const requested = new URL(response.url());
          return requested.origin === origin && requested.pathname === `${base}/messages` &&
            response.request().method() === 'GET' && response.status() === 200;
        });
        await therapist.page.waitForLoadState('networkidle');
        const afterPoll = await readingPosition();
        assert.equal(afterPoll.messageId, beforeSwitch.messageId, 'LOCAL_PRODUCT_CLOSED_MENU_POLL_ANCHOR');
        assert(Math.abs(afterPoll.offset - beforeSwitch.offset) <= 3, 'LOCAL_PRODUCT_CLOSED_MENU_POLL_OFFSET');
        assert(Math.abs(afterPoll.top - beforeSwitch.top) <= 3, 'LOCAL_PRODUCT_CLOSED_MENU_POLL_SCROLL');
        assert.equal(afterPoll.atEnd, false, 'LOCAL_PRODUCT_CLOSED_MENU_POLL_NOT_BOTTOM');
        assert.equal(await historyMenu.getAttribute('open'), null, 'LOCAL_PRODUCT_CLOSED_MENU_POLL_STAYS_CLOSED');
      }
      result.closedMenuPollAnchor = true;
      await room(therapist, extra.conversationId);
      assert.equal(await therapist.page.getByLabel('메시지', { exact: true }).inputValue(), draftB, 'LOCAL_PRODUCT_ANCHOR_SECOND_DRAFT');
      await room(therapist); await therapist.page.waitForLoadState('networkidle');
      const restored = await readingPosition();
      assert.equal(restored.messageId, beforeSwitch.messageId, 'LOCAL_PRODUCT_ROOM_READING_ANCHOR');
      assert(Math.abs(restored.offset - beforeSwitch.offset) <= 3, 'LOCAL_PRODUCT_ROOM_READING_OFFSET');
      assert.equal(restored.atEnd, false, 'LOCAL_PRODUCT_ROOM_READING_NOT_BOTTOM');
      assert.equal(await therapist.page.getByLabel('메시지', { exact: true }).inputValue(), draftA, 'LOCAL_PRODUCT_ANCHOR_FIRST_DRAFT');
      result.roomReadingAnchor = true;
      await workspaceView(therapist.page, 'home');
      const explicitLatest = longMessageIds.at(-1);
      await therapist.page.getByTestId('home').locator(`[data-open-room="${ids.conversationId}"][data-target-id="${explicitLatest}"]`).click();
      await row(therapist, explicitLatest).waitFor();
      assert.equal(await row(therapist, explicitLatest).evaluate((node) => node.classList.contains('target')), true, 'LOCAL_PRODUCT_EXPLICIT_TARGET_OVER_ANCHOR');
      assert.equal(await row(therapist, explicitLatest).evaluate((node) => {
        const bounds = node.getBoundingClientRect(), list = node.closest('[data-testid="message-list"]').getBoundingClientRect();
        return bounds.bottom > list.top && bounds.top < list.bottom;
      }), true, 'LOCAL_PRODUCT_EXPLICIT_TARGET_VISIBLE');
      assert.notEqual((await readingPosition()).messageId, beforeSwitch.messageId, 'LOCAL_PRODUCT_EXPLICIT_TARGET_MOVED_ANCHOR');
      result.explicitHomeTargetPriority = true;

      await advance(`${width}:GUARDIAN_PUBLIC_RECORDS`);
      await workspaceRecords(therapist.page, ids.conversationId);
      await therapist.page.locator(`[data-care-action="preview-record"][data-record-id="${recordId}"]`).click();
      const preview = therapist.page.getByTestId('care-dialog'); await preview.waitFor();
      assert(!(await preview.innerText()).includes(privateNote));
      await preview.locator('[name="confirmed"]').check(); await preview.getByRole('button', { name: '확인하고 공유', exact: true }).click(); await preview.waitFor({ state: 'hidden' });
      await workspaceRecords(guardian.page, ids.conversationId); await refresh(guardian);
      const card = guardian.page.locator('[data-shared-message]').filter({ hasText: summary }); await card.waitFor();
      const publicationMessageId = await card.getAttribute('data-shared-message'); assert(publicationMessageId);
      assert(!(await guardian.page.locator('body').innerText()).includes(privateNote), 'LOCAL_PRODUCT_PRIVATE_DOM');
      const beforePublicRead = reads.filter((r) => r.role === 'guardian').length;
      await refresh(guardian); assert.equal(reads.filter((r) => r.role === 'guardian').length, beforePublicRead, 'LOCAL_PRODUCT_RECORDS_NOT_CHAT_READ');
      await card.locator(`[data-open-room="${ids.conversationId}"][data-target-id="${publicationMessageId}"]`).click();
      await row(guardian, publicationMessageId).waitFor();
      assert.equal(await row(guardian, publicationMessageId).evaluate((node) => node.classList.contains('target')), true, 'LOCAL_PRODUCT_PUBLIC_RECORD_TARGET');
      result.publicRecords = true;

      await advance(`${width}:NON_CHAT_AUTHORITY_REMOVED`);
      await childContext(guardian, 'child', ids.conversationId);
      await guardian.page.getByRole('heading', { name: '가상 놀이 참여 관찰', exact: true }).waitFor();
      await sandbox.database.transaction(async (tx) => {
        await tx.query('SELECT id FROM cb_conversations WHERE center_id=$1 AND id=$2 FOR UPDATE', [ids.centerId, ids.conversationId]);
        await tx.query('UPDATE cb_participants SET active=false WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3', [ids.centerId, ids.conversationId, ids.guardianId]);
      });
      await refresh(guardian);
      await guardian.page.getByRole('heading', { name: '가상 놀이 참여 관찰', exact: true }).waitFor({ state: 'hidden' });
      for (const view of ['home', 'records', 'child']) {
        await workspaceView(guardian.page, view);
        assert.equal(await guardian.page.locator(`[data-open-room="${ids.conversationId}"],#child-select option[value="${ids.conversationId}"]`).count(), 0, 'LOCAL_PRODUCT_REMOVED_ROOM_PROJECTION');
        const text = await guardian.page.locator('body').innerText();
        for (const forbidden of [summary, title, latestBody, '가상 놀이 참여 관찰']) assert(!text.includes(forbidden), 'LOCAL_PRODUCT_REMOVED_CONTENT_VISIBLE');
      }
      assert.deepEqual(guardianPrivateRequests, [], 'LOCAL_PRODUCT_GUARDIAN_PRIVATE_REQUEST');
      result.guardianPrivateRequests = result.nonChatRevocation = true;
      for (const who of actors) assert.deepEqual(await who.page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, '']);
      result.storagePrivate = true;
      assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedRequests, []);
      for (const who of actors) { await who.context.close(); contexts.delete(who.context); }
      await sandbox.close(); assert.equal(sandbox.database.closed, true); assert.equal(sandbox.credentials.length, 0); sandboxes.delete(sandbox);
      result.cleanup = true; report.checks.push(result);
      console.log(JSON.stringify({ width, passed: true, completedBoundaries: Object.entries(result).filter(([key, value]) => key !== 'cleanup' && value === true).length }));
    }
    report.finalSource = await sources(); assert.equal(report.finalSource.sha256, source.sha256, 'LOCAL_PRODUCT_SOURCE_CHANGED');
  } catch (error) {
    pendingCleanup = getPendingSyntheticCleanup(error);
    report.failure = { code: 'LOCAL_PRODUCT_BROWSER_FAILED', phase,
      kind: ['AssertionError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-product-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      helperLine: Number(error?.stack?.match(/local-workspace-browser-helpers\.mjs:(\d+):\d+/)?.[1]) || null,
      assertion: error?.message?.match(/^(LOCAL_(?:PRODUCT|WORKSPACE|DESKTOP|MOBILE|RESPONSIVE)_[A-Z_]+)(?:\r?\n|$)/)?.[1] ?? null,
      desktopStage: typeof error?.desktopStage === 'string' ? error.desktopStage : null,
      desktopGeometry: error?.desktopGeometry ?? null,
      mobileStage: typeof error?.mobileStage === 'string' ? error.mobileStage : null,
      mobileGeometry: error?.mobileGeometry ?? null,
      shellStage: typeof error?.shellStage === 'string' ? error.shellStage : null,
      shellGeometry: error?.shellGeometry ?? null };
  } finally {
    for (const context of contexts) try { await bounded(context.close()); contexts.delete(context); } catch {}
    report.cleanup.contextsClosed = contexts.size === 0;
    if (browserServer) {
      try { await bounded(browserServer.close()); } catch { try { await bounded(browserServer.kill()); } catch {} }
      report.cleanup.browserStopped = typeof browserProcess?.exitCode === 'number' || typeof browserProcess?.signalCode === 'string';
    }
    for (const sandbox of sandboxes) try { await bounded(sandbox.close()); assert.equal(sandbox.database.closed, true); sandboxes.delete(sandbox); } catch {}
    let pendingClosed = !pendingCleanup;
    if (pendingCleanup) try { await bounded(pendingCleanup()); pendingClosed = true; } catch {}
    report.cleanup.sandboxesClosed = sandboxes.size === 0 && pendingClosed;
    report.finishedAt = new Date().toISOString();
    report.passed = !report.failure && report.checks.length === 3 && Object.values(report.cleanup).every(Boolean);
    ownership.finished = Object.values(report.cleanup).every(Boolean); ownership.cleanup = report.cleanup;
    await save('ownership.json', ownership); await save('results.json', report);
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length, failure: report.failure, cleanup: report.cleanup }));
  return report.passed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runLocalProductBrowser()) process.exitCode = 1; }
  catch { console.error('LOCAL_PRODUCT_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

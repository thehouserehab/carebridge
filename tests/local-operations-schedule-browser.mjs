// Real synthetic center UI -> authenticated loopback HTTP -> owned memory PGlite.
// Every successful clinical/schedule/enrollment write uses UI; fixture SQL only
// revokes the synthetic center membership. No E/native or existing browser.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceView, workspaceAccountAction } from './local-workspace-browser-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), code = 'LOCAL_OPERATIONS_SCHEDULE_FAILED';
const hash = value => createHash('sha256').update(value).digest('hex');
const appointmentKeys = ['id', 'conversationId', 'childId', 'revision', 'date', 'time', 'duration', 'title', 'room', 'status', 'updatedAt', 'therapistId'].sort();
const receiptKeys = ['kind', 'id', 'revision', 'changed', 'replayed'].sort();
const assets = new Set(['/', '/favicon.ico', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/client.js', '/local-api/care-client.js',
  '/local-api/appointment-client.js', '/local-api/goal-client.js', '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css',
  '/local-api/media-client.js', '/local-api/media-ui.js', '/local-api/media-viewer.js', '/local-api/operations-client.js',
  '/local-api/operations-ui.js', '/local-api/operations-recipient.js', '/local-api/operations-onboarding.js', '/local-api/operations-schedule.js', '/src/media-policy.js',
  '/src/record-fields.js', '/src/feedback-fields.js', '/src/profile-fields.js', '/src/context-fields.js']);
const clinicalTables = ['cb_messages', 'cb_read_states', 'cb_message_reviews', 'cb_records', 'cb_record_revisions',
  'cb_record_requests', 'cb_record_assessments', 'cb_publications', 'cb_activity_feedback', 'cb_feedback_revisions',
  'cb_feedback_reviews', 'cb_feedback_requests', 'cb_child_family_plans', 'cb_goals', 'cb_goal_revisions', 'cb_audit_events'];
async function sources() {
  const names = ['tests/local-operations-schedule-browser.mjs', 'tests/local-workspace-browser-helpers.mjs',
    'tests/message-browser-policy.mjs', 'scripts/p0-study-policy.mjs'];
  for (const directory of ['local-api', 'src', 'server', 'server/migrations']) for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (entry.isDirectory() || !/\.(?:mjs|js|css|html|sql)$/.test(entry.name)) continue;
    assert(entry.isFile() && !entry.isSymbolicLink(), code); names.push(`${directory}/${entry.name}`);
  }
  const files = [];
  for (const name of names.sort()) files.push({ name, sha256: hash(await readFile(path.join(root, name))) });
  return { sha256: hash(JSON.stringify(files)), files };
}
async function bounded(work, ms = 30_000) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); })]); }
  finally { clearTimeout(timer); }
}
function lifetime(child) {
  assert(child && Number.isInteger(child.pid), code);
  const streams = [...new Set((child.stdio ?? []).filter(Boolean))], done = Promise.withResolvers();
  let exited = child.exitCode !== null || child.signalCode !== null, closed = false;
  const terminal = () => exited && closed && streams.every(stream => stream.closed === true);
  const changed = () => { if (terminal()) done.resolve(); };
  child.once('exit', () => { exited = true; changed(); }); child.once('close', () => { closed = true; changed(); });
  for (const stream of streams) stream.once('close', changed);
  return { terminal, done: done.promise };
}
async function reachable(button) {
  const deadline = Date.now() + 5000; let observation;
  while (Date.now() < deadline) {
    const timeout = () => Math.max(1, deadline - Date.now());
    await button.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }), undefined, { timeout: timeout() });
    await button.click({ trial: true, timeout: timeout() });
    observation = await button.evaluate(element => {
      const r = element.getBoundingClientRect(), nav = document.querySelector('.main-nav');
      const n = nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect() : null;
      const outsideNav = !!element.closest('dialog')?.open || !n || r.bottom <= n.top || r.top >= n.bottom || r.right <= n.left || r.left >= n.right;
      const withinViewport = r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      const x = Math.min(6, r.width / 4), y = Math.min(6, r.height / 4);
      const hits = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + x, r.top + y], [r.right - x, r.top + y],
        [r.left + x, r.bottom - y], [r.right - x, r.bottom - y]].map(([px, py]) => element.contains(document.elementFromPoint(px, py)));
      const rect = v => v ? Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map(k => [k, v[k]])) : null;
      return { connected: element.isConnected, bounds: rect(r), viewport: { width: innerWidth, height: innerHeight },
        fixedNav: rect(n), withinViewport, outsideNav, hits, passed: withinViewport && outsideNav && hits.every(Boolean) };
    }, undefined, { timeout: timeout() });
    if (observation.passed) return;
    if (observation.connected) break;
  }
  const error = new Error(code); error.name = 'AssertionError'; error.reachability = observation; throw error;
}
async function reveal(locator) {
  for (const details of await locator.locator('xpath=ancestor::details').all())
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
}

export async function runLocalOperationsScheduleBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const name of [options.module, options.executable]) { const stat = await lstat(name); assert(stat.isFile() && !stat.isSymbolicLink(), code); }
  const source = await sources(), { chromium } = await import(pathToFileURL(options.module).href);
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-operations-schedule-${runId}`); await mkdir(folder);
  const report = { runId, startedAt: new Date().toISOString(), source, passed: false, checks: [], screenshots: [], errors: [], unexpectedRequests: [],
    failure: null, cleanupObservationTimedOut: false, cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Owned Chromium and fresh memory-only PGlite; invented accounts only. No E/native, real records, external service or existing user browser.',
      'All successful schedule/enrollment/clinical writes are UI actions. Fixture SQL only revokes the synthetic manager membership.',
      'One real committed response is discarded; actual traffic is delayed for CAS and late-response tests. No server result or permission is fabricated.',
      'Overview is assembled from separately loaded current lists, not an atomic statistics snapshot. Count comparisons are made after writes settle.',
      'Authenticated direct reads prove exact history and rejected scope; they are not automatic UI requests.',
      'Three viewport widths are not physical-device evidence. Empty browser storage does not prove secure RAM erasure or operational retention.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, sourceSha256: source.sha256, sandboxes: [], finished: false };
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  const note = (list, value) => { if (list.length < 32) list.push(value); };
  const contexts = new Set(), sandboxes = new Set(), ownedSandboxes = new Map(), pages = new Map(), releases = new Set(), routeWork = new Set();
  let browserServer, browser, browserLife, phase = 'STARTUP'; await save('ownership.json', ownership);
  try {
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable, host: '127.0.0.1', port: 0,
      env: studyChildEnvironment(), timeout: 30_000 });
    browserLife = lifetime(browserServer.process()); ownership.browserProcessId = browserServer.process().pid;
    await save('ownership.json', ownership); browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    for (const width of [390, 768, 1440]) {
      phase = `${width}:SANDBOX`; const sandbox = await createLocalApiSandbox({ port: 0 }); sandboxes.add(sandbox);
      const owned = { width, mediaDirectoryName: path.basename(sandbox.mediaRoot), closed: false };
      ownedSandboxes.set(sandbox, owned); ownership.sandboxes.push(owned); await save('ownership.json', ownership);
      const { ids, origin } = sandbox, originUrl = new URL(origin);
      assert(originUrl.origin === origin && originUrl.protocol === 'http:' && originUrl.hostname === '127.0.0.1' && originUrl.port && !originUrl.username && !originUrl.password, code);
      const operationsBase = `/api/local/centers/${ids.centerId}/operations`;
      const clinicalBase = `/api/local/centers/${ids.centerId}/conversations/${ids.conversationId}`;
      const operationalBase = `${operationsBase}/conversations/${ids.conversationId}`;
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      const title1 = `가상 <b>센터 일정 ${width}</b>`, title2 = `가상 변경된 센터 일정 ${width}`, peerTitle = `가상 다른 창 일정 ${width}`;
      const keptTitle = `가상 유지할 일정 입력 ${width}`, revokedTitle = `가상 종료할 일정 입력 ${width}`, place = '가상 센터 시험실';
      const recordTitle = `가상 비공개 일정 기록 ${width}`, privateNote = `가상 센터 비공개 내부 메모 ${width}`, concern = `가상 가족 관심사 ${width}`;
      const clinicalSentinels = [recordTitle, privateNote, concern], mutations = [], clinicalRequests = [], appointmentResponses = [];
      const result = { width, overviewCounts: false, overviewDateAndStatuses: false, dateFilter: false, operationalOnly: false, minimalDto: false,
        defaults: false, realLossRetry: false, receiptExactlyOnce: false, bothReadersCurrent: false, linkedRecord: false, oneRecordPerAppointment: false,
        historicalSnapshot: false, cancelledAndRestored: false, noOp: false, scheduleConflict: false, actualRevisionConflict: false,
        explicitKeepAndReplace: false, draftRetained: false, lateChildDiscarded: false, lateAccountDiscarded: false,
        managerRevoked: false, roleAndScope: false, noAutomaticClinicalWrites: false, keyboard: false, reachability: false,
        layout: false, browserStorageEmpty: false, cleanup: false };
      report.currentCheck = result;
      const isManager = label => ['center', 'peer'].includes(label);
      const userOf = label => isManager(label) ? ids.managerId : ids[`${label}Id`];
      const login = async (page, label) => {
        const credential = sandbox.credentials.find(item => item.role === (isManager(label) ? 'center' : label)); assert(credential?.email.endsWith('.test'), code);
        await page.getByTestId('login-form').waitFor();
        await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click();
        await page.getByTestId(isManager(label) ? 'operations-children' : 'home').waitFor();
      };
      const actor = async label => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR', isMobile: width <= 640,
          hasTouch: width <= 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context); context.once('close', () => contexts.delete(context)); assert.equal((await context.cookies()).length, 0, code);
        const fault = { loseNext: false, losses: 0, receipt: null, nextGet: null, nextPost: null };
        await context.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url()), method = request.method(), entryPhase = phase;
          const primaryRead = method === 'GET' && url.pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
            [...url.searchParams].length === 1 && url.searchParams.get('conversationId') === ids.conversationId;
          const allowed = /^\/api\/local\/(?:auth\/(?:login|session|logout)|centers\/[A-Za-z0-9_-]+\/(?:operations\/(?:children|members|appointments|conversations\/[A-Za-z0-9_-]+\/(?:profile|relationships|appointments\/[A-Za-z0-9_-]+))|inbox|conversations\/[A-Za-z0-9_-]+\/(?:profile|family-plan|read|goals(?:\/[A-Za-z0-9_-]+)?|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+)?|records(?:\/[A-Za-z0-9_-]+)?)))$/.test(url.pathname);
          if (url.origin !== origin || !['GET', 'POST', 'HEAD'].includes(method) || !((assets.has(url.pathname) && ['GET', 'HEAD'].includes(method)) || allowed || primaryRead)) {
            note(report.unexpectedRequests, { width, label, phase: entryPhase, sameOrigin: url.origin === origin, method: ['GET', 'POST', 'HEAD'].includes(method) ? method : 'OTHER' });
            return route.abort().catch(() => {});
          }
          const operational = url.pathname.startsWith(operationsBase + '/');
          if (request.headers()['x-carebridge-account'] === ids.managerId && url.pathname.startsWith('/api/local/centers/') && !operational)
            clinicalRequests.push({ width, label, phase: entryPhase });
          const detail = /\/appointments\/[A-Za-z0-9_-]+$/.test(url.pathname), list = url.pathname === operationsBase + '/appointments';
          if (!operational && !detail) return route.continue().catch(() => {});
          const item = detail && method === 'POST' ? { label, pathname: url.pathname, body: structuredClone(request.postDataJSON()) } : null;
          if (item) mutations.push(item);
          const lost = !!item && fault.loseNext; if (lost) fault.loseNext = false;
          const heldGet = detail && method === 'GET' ? fault.nextGet : null; if (heldGet) fault.nextGet = null;
          const heldPost = item ? fault.nextPost : null; if (heldPost) fault.nextPost = null;
          const work = (async () => {
            let response;
            try {
              if (heldPost) { heldPost.entered.resolve(); await heldPost.release.promise; }
              response = await route.fetch({ maxRedirects: 0, timeout: 15_000 }); const body = await response.json();
              assert.equal(response.headers()['cache-control'], 'no-store', code);
              if (operational) assert(!clinicalSentinels.some(value => JSON.stringify(body).includes(value)), code);
              if (response.status() === 200 && detail) {
                if (item) {
                  assert.deepEqual(Object.keys(body), ['receipt'], code); assert.deepEqual(Object.keys(body.receipt).sort(), receiptKeys, code);
                  assert.deepEqual(Object.keys(item.body).sort(), ['clientId', 'expectedRevision', 'content'].sort(), code);
                  assert.deepEqual(Object.keys(item.body.content).sort(), ['date', 'time', 'duration', 'title', 'room', 'status'].sort(), code);
                  item.receipt = structuredClone(body.receipt);
                } else {
                  assert.deepEqual(Object.keys(body), ['appointment'], code); assert.deepEqual(Object.keys(body.appointment).sort(), appointmentKeys, code);
                  appointmentResponses.push(body.appointment);
                }
              } else if (response.status() === 200 && list) {
                if (body.resetRequired) assert.deepEqual(Object.keys(body).sort(), ['version', 'resetRequired'].sort(), code);
                else {
                  assert.deepEqual(Object.keys(body).sort(), ['appointments', 'version', 'resetRequired', 'nextCursor', 'hasMore'].sort(), code);
                  for (const appointment of body.appointments) assert.deepEqual(Object.keys(appointment).sort(), appointmentKeys, code);
                }
              } else assert([200, 201, 400, 401, 404, 409].includes(response.status()), code);
              if (item) item.status = response.status();
              if (lost) { assert.equal(response.status(), 200, code); fault.losses++; fault.receipt = structuredClone(body.receipt); await route.abort('failed').catch(() => {}); return; }
              if (heldGet) { heldGet.entered.resolve(); await heldGet.release.promise; }
              await route.fulfill({ response }).catch(() => {});
            } catch { note(report.errors, { width, label, phase: entryPhase, type: 'response-contract' }); await route.abort().catch(() => {}); }
            finally { await response?.dispose().catch(() => {}); heldGet?.done.resolve(); heldPost?.done.resolve(); }
          })(); routeWork.add(work); try { await work; } finally { routeWork.delete(work); }
        });
        if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => { note(report.unexpectedRequests, { width, label, phase, type: 'websocket' }); socket.close(); });
        const page = await context.newPage(); page.setDefaultTimeout(15_000); pages.set(label, page);
        page.on('pageerror', () => note(report.errors, { width, label, phase, type: 'pageerror' }));
        page.on('console', entry => { if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:')) note(report.errors, { width, label, phase, type: 'console' }); });
        await page.goto(origin); await login(page, label); return { context, page, label, userId: userOf(label), fault };
      };
      const center = await actor('center'), peer = await actor('peer'), therapist = await actor('therapist'), guardian = await actor('guardian');
      const actors = [center, peer, therapist, guardian], dialog = who => who.page.getByTestId('care-dialog');
      const form = who => who.page.getByTestId('operations-appointment-form');
      const request = async (who, pathname, method = 'GET', body = undefined) => {
        const response = await who.context.request.fetch(origin + pathname, { method, ...(body === undefined ? {} : { data: body }), timeout: 15_000, maxRedirects: 0,
          headers: { 'X-Carebridge-Account': who.userId, ...(method === 'POST' ? { Origin: origin, 'X-Carebridge-Request': '1' } : {}) } });
        try { return { status: response.status(), body: await response.json() }; } finally { await response.dispose(); }
      };
      const snapshot = async tables => {
        const value = {};
        for (const table of tables) value[table] = (await sandbox.database.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE center_id=$1 ORDER BY to_jsonb(t)::text`, [ids.centerId])).rows;
        return value;
      };
      const contextSnapshot = () => snapshot(['cb_appointments', 'cb_appointment_revisions', 'cb_context_requests', 'cb_conversations']);
      const readRecord = async (id, revision = 1) => {
        const response = await request(therapist, `${clinicalBase}/records/${id}?revision=${revision}`); assert.equal(response.status, 200, code); return response.body.record;
      };
      const gate = () => {
        const g = { entered: Promise.withResolvers(), release: Promise.withResolvers(), done: Promise.withResolvers() }, release = () => g.release.resolve();
        releases.add(release); return { ...g, finish: () => { release(); releases.delete(release); } };
      };
      const capture = async (who, name) => {
        assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code);
        if (await dialog(who).isVisible()) assert.equal(await dialog(who).evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, code);
        const filename = `${width}-${name}.png`; assert(!report.screenshots.some(item => item.filename === filename), code);
        await who.page.screenshot({ path: path.join(folder, filename), fullPage: false,
          mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]'), who.page.locator('.workspace-head .account')] });
        report.screenshots.push({ width, filename, syntheticOnly: true });
      };
      const noClinicalLeak = async who => {
        const text = await who.page.locator('body').innerText(); assert(!clinicalSentinels.some(value => text.includes(value)), code);
        assert.equal(await who.page.locator('[data-testid="home"],[data-testid="inbox"],[data-testid="care"],[data-testid="message-row"],.main-nav').count(), 0, code);
      };
      const view = async (who, name) => {
        await who.page.bringToFront(); await who.page.locator(`[data-ops-view="${name}"]`).click();
        await who.page.getByTestId(`operations-${name === 'overview' ? 'overview' : name === 'schedule' ? 'schedule' : 'children'}`).waitFor();
      };
      const schedule = async (who, date = today) => {
        await view(who, 'schedule'); const dateForm = who.page.locator('[data-ops-date-form]');
        await dateForm.locator('[name="scheduleDate"]').fill(date);
        const response = who.page.waitForResponse(r => { const u = new URL(r.url()); return u.pathname === operationsBase + '/appointments' &&
          r.request().method() === 'GET' && u.searchParams.get('dateFrom') === date && u.searchParams.get('dateTo') === date; });
        await dateForm.getByRole('button', { name: '날짜 적용', exact: true }).click(); assert.equal((await response).status(), 200, code);
        await who.page.getByTestId('operations-schedule').waitFor();
        await who.page.waitForFunction(date => {
          const section = document.querySelector('[data-testid="operations-schedule"]');
          return !!section?.getClientRects().length && section.querySelector('[name="scheduleDate"]')?.value === date;
        }, date);
      };
      const open = async (who, appointmentId = null, date = today) => {
        await schedule(who, date);
        if (appointmentId) await who.page.locator(`[data-ops-appointment="${appointmentId}"][data-ops-room="${ids.conversationId}"]`).click();
        else { await who.page.locator('[data-ops-new-child]').selectOption(ids.conversationId); await who.page.locator('[data-ops-action="new-appointment"]').click(); }
        await form(who).waitFor();
      };
      const fill = async (who, values) => { for (const [name, value] of Object.entries(values)) {
        const input = form(who).locator(`[name="${name}"]`); if (name === 'status') await input.selectOption(value); else await input.fill(String(value));
      } };
      const submit = async (who, action = 'submit', expected = 200) => {
        const response = who.page.waitForResponse(r => new URL(r.url()).pathname.startsWith(operationalBase + '/appointments/') && r.request().method() === 'POST');
        await form(who).locator(action === 'submit' ? 'button[type="submit"]' : `[data-ops-action="${action}"]`).click();
        const result = await response; assert.equal(result.status(), expected, code); const body = await result.json();
        if (expected === 200) await who.page.getByTestId('operations-schedule').waitFor(); return body;
      };
      const childView = async who => {
        await who.page.bringToFront(); await workspaceView(who.page, 'child'); await who.page.locator('#child-select:not([disabled])').waitFor();
        if (await who.page.locator('#child-select').inputValue() !== ids.conversationId) await who.page.locator('#child-select').selectOption(ids.conversationId);
        await who.page.getByTestId('child-appointments').waitFor();
      };
      const readerSchedule = async (who, title, status, time = '11:00') => {
        await childView(who); await workspaceAccountAction(who.page, 'refresh');
        const row = who.page.getByTestId('child-appointments').locator('.schedule-row').filter({ has: who.page.getByRole('heading', { name: title, exact: true }) });
        await row.waitFor(); await who.page.waitForFunction(({ title, status, time }) => [...document.querySelectorAll('[data-testid="child-appointments"] .schedule-row')]
          .some(node => node.querySelector('h3')?.textContent === title && node.textContent.includes(status) && node.textContent.includes(time)), { title, status, time });
        return row;
      };
      const checkOverview = async who => {
        await view(who, 'overview'); await who.page.locator('[data-ops-action="refresh"]').click();
        const countRows = (await sandbox.database.query(`SELECT cm.role,count(*)::int AS count FROM cb_memberships cm JOIN cb_users u ON u.id=cm.user_id
          WHERE cm.center_id=$1 AND cm.active AND u.active GROUP BY cm.role`, [ids.centerId])).rows;
        const childCount = (await sandbox.database.query('SELECT count(*)::int AS count FROM cb_children WHERE center_id=$1', [ids.centerId])).rows[0].count;
        const statuses = (await sandbox.database.query('SELECT status,count(*)::int AS count FROM cb_appointments WHERE center_id=$1 AND date=$2 GROUP BY status', [ids.centerId, today])).rows;
        const expected = { children: childCount, therapists: countRows.find(r => r.role === 'therapist')?.count ?? 0, guardians: countRows.find(r => r.role === 'guardian')?.count ?? 0 };
        const expectedStatuses = Object.fromEntries(['scheduled', 'attended', 'absent', 'cancelled'].map(status => [status, statuses.find(r => r.status === status)?.count ?? 0]));
        await who.page.waitForFunction(({ expected, expectedStatuses, today }) =>
          document.querySelector('[data-ops-summary-date]')?.textContent.trim() === today &&
          Object.entries(expected).every(([k, v]) => document.querySelector(`[data-ops-count="${k}"]`)?.textContent.trim() === String(v)) &&
          Object.entries(expectedStatuses).every(([k, v]) => document.querySelector(`[data-ops-status-count="${k}"]`)?.textContent.trim() === String(v)), { expected, expectedStatuses, today });
        await noClinicalLeak(who);
      };
      const observeLate = who => who.page.evaluate(() => {
        window.__lateOperationalSchedule = false; window.__opsScheduleObserver?.disconnect();
        window.__opsScheduleObserver = new MutationObserver(changes => { if (changes.some(change => [...change.addedNodes].some(node => node.nodeType === Node.ELEMENT_NODE &&
          (node.matches('[data-testid="operations-appointment-form"]') || node.querySelector('[data-testid="operations-appointment-form"]'))))) window.__lateOperationalSchedule = true; });
        window.__opsScheduleObserver.observe(document.body, { subtree: true, childList: true });
      });
      const noLate = async who => {
        await who.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await who.page.evaluate(() => window.__lateOperationalSchedule), false, code); await who.page.evaluate(() => window.__opsScheduleObserver.disconnect());
      };

      phase = `${width}:UI_CONTEXT_AND_OVERVIEW`;
      await childView(guardian); await guardian.page.locator('[data-family-plan]').click();
      await dialog(guardian).locator('[name="concern"]').fill(concern);
      await dialog(guardian).getByRole('button', { name: '가족 관심사 저장', exact: true }).click(); await dialog(guardian).waitFor({ state: 'hidden' });
      await center.page.bringToFront(); await center.page.locator('[data-ops-action="new-child"]').click();
      const registration = center.page.getByTestId('operations-registration-form'), extraName = '가상 일정 전환 아동';
      await registration.locator('[name="name"]').fill(extraName);
      const enrolled = center.page.waitForResponse(r => new URL(r.url()).pathname === operationsBase + '/children' && r.request().method() === 'POST');
      await registration.getByRole('button', { name: '아이 등록', exact: true }).click(); const registered = await enrolled;
      assert.equal(registered.status(), 201, code); const extraRoomId = (await registered.json()).receipt.conversationId;
      await center.page.getByTestId('operations-children').waitFor();
      const beforeCreate = await snapshot(clinicalTables); await checkOverview(center); await capture(center, 'overview-initial'); result.overviewCounts = true;

      phase = `${width}:CENTER_CREATE_REAL_LOSS_RETRY`;
      await schedule(center); const create = center.page.locator('[data-ops-action="new-appointment"]');
      await center.page.locator('[data-ops-new-child]').selectOption(ids.conversationId); await reachable(create); await create.focus(); await create.press('Enter'); await form(center).waitFor();
      assert.equal(await form(center).locator('[name="date"]').inputValue(), today, code);
      for (const name of ['time', 'duration', 'title', 'room']) assert.equal(await form(center).locator(`[name="${name}"]`).inputValue(), '', code);
      assert.equal(await form(center).locator('[name="status"]').inputValue(), 'scheduled', code); result.defaults = true;
      await fill(center, { date: today, time: '09:00', duration: 30, title: title1, room: place, status: 'scheduled' });
      await form(center).locator('[name="title"]').focus(); await center.page.keyboard.press('Tab');
      assert.equal(await form(center).locator('[name="room"]').evaluate(node => node === document.activeElement), true, code);
      await reachable(form(center).getByRole('button', { name: '일정 저장', exact: true })); await capture(center, 'center-schedule-editor');
      center.fault.loseNext = true; await form(center).getByRole('button', { name: '일정 저장', exact: true }).click();
      await form(center).locator('[data-ops-action="retry"]:not([disabled])').waitFor();
      assert.equal(center.fault.losses, 1, code); assert.equal(mutations.length, 1, code);
      const operation = structuredClone(mutations[0]), committed = await contextSnapshot();
      for (const field of await form(center).locator('input,select').all()) assert.equal(await field.isDisabled(), true, code);
      assert.equal(await form(center).locator('[data-ops-action="discard"]').isDisabled(), true, code); await capture(center, 'unknown-frozen-schedule');
      const replay = await submit(center, 'retry'), appointmentId = replay.receipt.id;
      assert.deepEqual(mutations[1].body, operation.body, code); assert.equal(mutations[1].pathname, operation.pathname, code);
      assert.deepEqual(replay.receipt, { ...center.fault.receipt, replayed: true }, code); assert.equal(replay.receipt.revision, 1, code);
      assert.deepEqual(await contextSnapshot(), committed, code); assert.deepEqual(await snapshot(clinicalTables), beforeCreate, code);
      result.realLossRetry = result.receiptExactlyOnce = result.keyboard = result.reachability = true;

      phase = `${width}:READERS_AND_OPERATIONAL_SCOPE`;
      for (const who of [therapist, guardian]) await readerSchedule(who, title1, '예정', '09:00');
      assert.equal(await guardian.page.locator('[data-appointment-new],[data-appointment-edit],[data-appointment-record]').count(), 0, code);
      assert.equal(await guardian.page.locator('h3 b').count(), 0, code); await capture(guardian, 'guardian-center-created-schedule'); result.bothReadersCurrent = true;
      const endpoint = `${operationalBase}/appointments/${appointmentId}`;
      for (const who of [therapist, guardian]) {
        assert.equal((await request(who, endpoint)).status, 404, code);
        assert.equal((await request(who, endpoint, 'POST', operation.body)).status, 404, code);
        assert.equal((await request(who, operationsBase + `/appointments?dateFrom=${today}&dateTo=${today}`)).status, 404, code);
      }
      for (const suffix of ['/profile', '/messages', '/records', '/family-plan', `/appointments/${appointmentId}`])
        assert.equal((await request(center, clinicalBase + suffix)).status, 404, code);
      assert.equal((await request(center, clinicalBase + `/appointments/${appointmentId}`, 'POST', operation.body)).status, 404, code);
      assert.equal((await request(center, `${operationsBase}/conversations/${extraRoomId}/appointments/${appointmentId}`)).status, 404, code);
      assert.deepEqual(await snapshot(clinicalTables), beforeCreate, code); result.roleAndScope = true;

      phase = `${width}:THERAPIST_LINKED_RECORD`;
      await childView(therapist); const recordButton = therapist.page.getByTestId('child-appointments').locator(`[data-appointment-record="${appointmentId}"]`);
      await reachable(recordButton); await recordButton.click(); await dialog(therapist).locator('form[data-care-form="record"]').waitFor();
      await dialog(therapist).locator('[name="goalId"]').selectOption(ids.goalId);
      for (const [name, value] of Object.entries({ title: recordTitle, performed: '가상 회기 관찰', response: '가상 반응', nextPlan: '가상 다음 계획', privateNote })) {
        const input = dialog(therapist).locator(`[name="${name}"]`); await reveal(input); await input.fill(value);
      }
      const recordResponse = therapist.page.waitForResponse(r => new URL(r.url()).pathname.startsWith(clinicalBase + '/records/') && r.request().method() === 'POST');
      await dialog(therapist).getByRole('button', { name: '기록 저장', exact: true }).click(); const savedRecord = await recordResponse;
      assert.equal(savedRecord.status(), 201, code); const recordId = (await savedRecord.json()).receipt.recordId;
      await dialog(therapist).waitFor({ state: 'hidden' }); const originalRecord = await readRecord(recordId);
      assert.equal(originalRecord.appointmentId, appointmentId, code); assert.equal(originalRecord.appointmentRevision, 1, code);
      assert.deepEqual(originalRecord.appointmentSnapshot, { revision: 1, date: today, time: '09:00', duration: 30, title: title1, room: place, status: 'scheduled' }, code);
      assert.equal((await request(guardian, `${clinicalBase}/records/${recordId}?revision=1`)).status, 404, code);
      const clinicalBaseline = await snapshot(clinicalTables); result.linkedRecord = true;

      phase = `${width}:CENTER_CHANGE_CANCEL_RESTORE`;
      await open(center, appointmentId); await fill(center, { time: '11:00', title: title2, status: 'attended' });
      assert.equal((await submit(center)).receipt.revision, 2, code);
      for (const [status, label] of [['attended', '완료'], ['absent', '미참석'], ['cancelled', '취소'], ['scheduled', '예정']]) {
        if (status !== 'attended') { await open(center, appointmentId); await fill(center, { status }); await submit(center); }
        for (const who of [therapist, guardian]) await readerSchedule(who, title2, label);
        assert.deepEqual(await readRecord(recordId), originalRecord, code); await checkOverview(center);
      }
      await capture(center, 'overview-current-statuses'); result.overviewDateAndStatuses = result.cancelledAndRestored = true;
      await childView(therapist); await therapist.page.getByTestId('child-appointments').locator(`[data-appointment-record="${appointmentId}"]`).filter({ hasText: '기록 이어보기' }).click();
      await dialog(therapist).locator('form[data-care-form="record"]').waitFor();
      const historical = dialog(therapist).locator('[data-record-appointment-snapshot]'), current = dialog(therapist).locator('.care-appointment-context');
      const historicalText = await historical.innerText(), currentText = await current.innerText();
      assert(historicalText.includes('09:00') && historicalText.includes('1번째 내용') && historicalText.includes(title1) && !historicalText.includes('11:00'), code);
      assert(currentText.includes('11:00') && currentText.includes(title2) && !currentText.includes('09:00'), code);
      await dialog(therapist).evaluate(node => { node.scrollTop = 0; });
      for (const label of [current, historical]) assert.equal(await label.evaluate(node => {
        const r = node.getBoundingClientRect(), d = node.closest('dialog').getBoundingClientRect();
        return r.height > 0 && r.top >= Math.max(0, d.top) && r.bottom <= Math.min(innerHeight, d.bottom) &&
          r.left >= Math.max(0, d.left) && r.right <= Math.min(innerWidth, d.right);
      }), true, code);
      await capture(therapist, 'record-current-and-historical-schedule');
      await dialog(therapist).getByRole('button', { name: '입력 취소', exact: true }).click(); await dialog(therapist).waitFor({ state: 'hidden' });
      assert.deepEqual(await readRecord(recordId), originalRecord, code);
      const linkedRows = (await sandbox.database.query('SELECT id FROM cb_records WHERE center_id=$1 AND conversation_id=$2 AND appointment_id=$3', [ids.centerId, ids.conversationId, appointmentId])).rows;
      assert.deepEqual(linkedRows.map(row => row.id), [recordId], code); result.historicalSnapshot = result.oneRecordPerAppointment = true;
      assert.deepEqual(await snapshot(clinicalTables), clinicalBaseline, code);

      phase = `${width}:NO_OP_DATE_FILTER_AND_DRAFT`;
      await open(center, appointmentId); const beforeNoOp = await contextSnapshot(), noOp = await submit(center), afterNoOp = await contextSnapshot();
      assert.equal(noOp.receipt.changed, false, code);
      for (const table of ['cb_appointments', 'cb_appointment_revisions', 'cb_conversations']) assert.deepEqual(afterNoOp[table], beforeNoOp[table], code);
      assert.equal(afterNoOp.cb_context_requests.length, beforeNoOp.cb_context_requests.length + 1, code); result.noOp = true;
      await schedule(center, tomorrow); assert.equal(await center.page.locator(`[data-ops-appointment="${appointmentId}"]`).count(), 0, code);
      await center.page.locator('[data-ops-new-child]').selectOption(ids.conversationId); await center.page.locator('[data-ops-action="new-appointment"]').click(); await form(center).waitFor();
      assert.equal(await form(center).locator('[name="date"]').inputValue(), tomorrow, code);
      await form(center).locator('[data-ops-action="discard"]').click(); await center.page.getByTestId('operations-schedule').waitFor(); result.dateFilter = true;
      await open(center, appointmentId); await fill(center, { title: keptTitle }); await center.page.locator('[data-ops-action="back"]').click();
      await center.page.locator(`[data-ops-resume="${ids.conversationId}/${appointmentId}"]`).click(); await form(center).waitFor();
      assert.equal(await form(center).locator('[name="title"]').inputValue(), keptTitle, code);
      await form(center).locator('[data-ops-action="discard"]').click(); await center.page.getByTestId('operations-schedule').waitFor(); result.draftRetained = true;

      phase = `${width}:REAL_SCHEDULE_CONFLICT`;
      await open(center); await fill(center, { date: today, time: '11:00', duration: 30, title: keptTitle, room: place, status: 'scheduled' });
      const beforeCollision = await contextSnapshot(), collision = await submit(center, 'submit', 409);
      assert.equal(collision.error, 'SCHEDULE_CONFLICT', code); assert.equal(await form(center).locator('[name="title"]').inputValue(), keptTitle, code);
      assert.equal(await form(center).locator('[name="time"]').inputValue(), '11:00', code); assert.deepEqual(await contextSnapshot(), beforeCollision, code);
      await capture(center, 'time-conflict-preserved'); await fill(center, { time: '10:00' }); const corrected = await submit(center);
      assert.equal(corrected.receipt.revision, 1, code); assert.notEqual(corrected.receipt.id, appointmentId, code); result.scheduleConflict = true;

      phase = `${width}:REAL_CROSS_ROLE_REVISION_CONFLICT`;
      await childView(therapist); await therapist.page.getByTestId('child-appointments').locator(`[data-appointment-edit="${appointmentId}"]`).click();
      await dialog(therapist).locator('form[data-care-form="appointment"]').waitFor(); await dialog(therapist).locator('[name="title"]').fill(peerTitle);
      await open(center, appointmentId); await fill(center, { title: keptTitle }); const heldPost = gate(); center.fault.nextPost = heldPost;
      try {
        const conflictResponse = center.page.waitForResponse(r => new URL(r.url()).pathname === endpoint && r.request().method() === 'POST' && r.status() === 409); void conflictResponse.catch(() => {});
        await form(center).getByRole('button', { name: '일정 저장', exact: true }).click(); await bounded(heldPost.entered.promise, 5000);
        await therapist.page.bringToFront(); const peerResponse = therapist.page.waitForResponse(r => new URL(r.url()).pathname === clinicalBase + `/appointments/${appointmentId}` && r.request().method() === 'POST');
        await dialog(therapist).getByRole('button', { name: '일정 저장', exact: true }).click(); assert.equal((await peerResponse).status(), 200, code); await dialog(therapist).waitFor({ state: 'hidden' });
        heldPost.finish(); assert.equal((await (await conflictResponse).json()).error, 'APPOINTMENT_CONFLICT', code); await bounded(heldPost.done.promise, 5000);
        await center.page.bringToFront(); await form(center).locator('[data-ops-conflict]:not([hidden])').waitFor();
        assert.equal(await form(center).locator('[name="title"]').inputValue(), keptTitle, code); assert.equal(await form(center).getByRole('button', { name: '일정 저장', exact: true }).isDisabled(), true, code);
        await center.page.locator('[data-ops-action="refresh"]').click(); await form(center).locator('[data-ops-latest]').filter({ hasText: peerTitle }).waitFor();
        const beforeKeep = await contextSnapshot(), keepCount = mutations.length; await reachable(form(center).locator('[data-ops-action="keep"]')); await capture(center, 'cross-role-conflict-preserved');
        await form(center).locator('[data-ops-action="keep"]').click(); assert.equal(await form(center).locator('[name="title"]').inputValue(), keptTitle, code);
        assert.deepEqual(await contextSnapshot(), beforeKeep, code); assert.equal(mutations.length, keepCount, code); await submit(center); result.actualRevisionConflict = true;
      } finally { heldPost.finish(); }

      phase = `${width}:LATEST_REPLACE_IS_NOT_AUTO_SAVE`;
      await open(peer, appointmentId); await fill(peer, { title: peerTitle }); await open(center, appointmentId); await fill(center, { title: keptTitle + ' 임시' });
      await submit(peer); await center.page.bringToFront(); await center.page.locator('[data-ops-action="refresh"]').click();
      await form(center).locator('[data-ops-latest]').filter({ hasText: peerTitle }).waitFor(); const beforeReplace = await contextSnapshot(), replaceCount = mutations.length;
      await form(center).locator('[data-ops-action="replace"]').click(); assert.equal(await form(center).locator('[name="title"]').inputValue(), peerTitle, code);
      assert.deepEqual(await contextSnapshot(), beforeReplace, code); assert.equal(mutations.length, replaceCount, code);
      assert.equal((await submit(center)).receipt.changed, false, code); result.explicitKeepAndReplace = true;

      phase = `${width}:LATE_DETAIL_OTHER_CHILD`;
      await open(center, appointmentId); const heldChild = gate(); center.fault.nextGet = heldChild;
      try {
        await center.page.locator('[data-ops-action="refresh"]').click(); await bounded(heldChild.entered.promise, 5000);
        await view(center, 'children'); await center.page.locator(`[data-ops-child="${extraRoomId}"]`).click(); await center.page.getByTestId('operations-form').waitFor();
        assert.equal(await center.page.getByTestId('operations-form').locator('[name="name"]').inputValue(), extraName, code); await observeLate(center);
        heldChild.finish(); await bounded(heldChild.done.promise, 5000); await noLate(center);
        assert.equal(await form(center).count(), 0, code); assert.equal(await center.page.getByTestId('operations-form').locator('[name="name"]').inputValue(), extraName, code);
        await capture(center, 'late-other-child'); result.lateChildDiscarded = true;
      } finally { heldChild.finish(); }

      phase = `${width}:LATE_DETAIL_CHANGED_ACCOUNT`;
      await open(center, appointmentId); const heldAccount = gate(); center.fault.nextGet = heldAccount; let otherPage;
      try {
        await center.page.locator('[data-ops-action="refresh"]').click(); await bounded(heldAccount.entered.promise, 5000);
        otherPage = await center.context.newPage(); otherPage.setDefaultTimeout(15_000); await otherPage.goto(origin);
        await workspaceAccountAction(otherPage, 'logout'); await login(otherPage, 'guardian');
        await center.page.bringToFront(); await center.page.getByTestId('login-form').waitFor(); await observeLate(center);
        heldAccount.finish(); await bounded(heldAccount.done.promise, 5000); await noLate(center);
        assert.equal(await center.page.getByTestId('operations').count(), 0, code); assert(!(await center.page.locator('body').innerText()).includes(peerTitle), code);
        await capture(center, 'late-account-cleared'); result.lateAccountDiscarded = true;
      } finally { heldAccount.finish(); await otherPage?.close(); }
      await login(center.page, 'center');

      phase = `${width}:MANAGER_REVOKED_AND_NO_CLINICAL_WRITES`;
      await checkOverview(center); await noClinicalLeak(center); await noClinicalLeak(peer);
      assert.equal(clinicalRequests.length, 0, code); result.operationalOnly = true;
      assert(appointmentResponses.length > 0, code); result.minimalDto = true;
      assert.deepEqual(await readRecord(recordId), originalRecord, code); assert.deepEqual(await snapshot(clinicalTables), clinicalBaseline, code); result.noAutomaticClinicalWrites = true;
      await open(center, appointmentId); await fill(center, { title: revokedTitle });
      await sandbox.database.query('UPDATE cb_memberships SET active=false WHERE center_id=$1 AND user_id=$2', [ids.centerId, ids.managerId]);
      await center.page.locator('[data-ops-action="refresh"]').click(); await center.page.getByTestId('login-form').waitFor();
      assert.equal(await form(center).count(), 0, code); assert.equal(await center.page.getByTestId('operations-schedule').count(), 0, code);
      assert(!(await center.page.locator('body').innerText()).includes(revokedTitle), code); assert.equal((await request(center, endpoint)).status, 404, code);
      await capture(center, 'manager-revoked-cleared'); result.managerRevoked = true;
      for (const who of actors) assert.deepEqual(await who.page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, ''], code);
      result.browserStorageEmpty = result.layout = true; assert.equal(report.errors.length, 0, code); assert.equal(report.unexpectedRequests.length, 0, code);
      for (const who of actors) await who.context.close(); pages.clear();
      await sandbox.close(); assert.equal(sandbox.database.closed, true, code); assert.equal(sandbox.credentials.length, 0, code); sandboxes.delete(sandbox);
      owned.closed = true; await save('ownership.json', ownership); result.cleanup = true; report.checks.push(result); delete report.currentCheck;
      console.log(JSON.stringify({ width, passed: true, boundaries: Object.values(result).filter(value => value === true).length - 1 }));
    }
    report.finalSource = await sources(); assert.equal(report.finalSource.sha256, source.sha256, code);
  } catch (error) {
    report.failure = { code, phase, kind: ['AssertionError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-operations-schedule-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      workspaceHelperLine: Number(error?.stack?.match(/local-workspace-browser-helpers\.mjs:(\d+):\d+/)?.[1]) || null };
    if (error?.reachability) report.failure.reachability = error.reachability;
    const labels = /READERS|THERAPIST|CENTER_CHANGE/.test(phase) ? ['therapist', 'guardian'] : ['center', 'peer'];
    for (const label of labels) { const page = pages.get(label); if (!page) continue; try {
      const filename = `failure-${label}.png`; await page.screenshot({ path: path.join(folder, filename), fullPage: false,
        mask: [page.locator('input[type="email"]'), page.locator('input[type="password"]'), page.locator('.workspace-head .account')] });
      report.screenshots.push({ filename, syntheticOnly: true, failure: true });
    } catch { note(report.errors, { phase, type: 'failure-screenshot' }); } }
  } finally {
    for (const release of releases) release();
    try { await bounded(Promise.all([...routeWork])); } catch { report.cleanupObservationTimedOut = true; }
    for (const context of contexts) try { await bounded(context.close()); contexts.delete(context); } catch { report.cleanupObservationTimedOut = true; }
    report.cleanup.contextsClosed = contexts.size === 0;
    if (browserServer) {
      try { await bounded(browser?.close()); await bounded(browserServer.close()); await bounded(browserLife.done); }
      catch { report.cleanupObservationTimedOut = true; try { await bounded(browserServer.kill()); await bounded(browserLife.done); } catch {} }
      report.cleanup.browserStopped = browserLife?.terminal() === true;
    } else report.cleanup.browserStopped = true;
    if (report.cleanup.browserStopped) for (const sandbox of sandboxes) try {
      await bounded(sandbox.close()); assert.equal(sandbox.database.closed, true, code); sandboxes.delete(sandbox); ownedSandboxes.get(sandbox).closed = true;
    } catch { report.failure ??= { code, phase: 'SANDBOX_CLEANUP', kind: 'Error' }; }
    report.cleanup.sandboxesClosed = sandboxes.size === 0; report.finishedAt = new Date().toISOString();
    report.passed = !report.failure && !report.cleanupObservationTimedOut && report.checks.length === 3 && report.errors.length === 0 &&
      report.unexpectedRequests.length === 0 && Object.values(report.cleanup).every(Boolean);
    ownership.finished = Object.values(report.cleanup).every(Boolean); ownership.cleanup = report.cleanup;
    await save('ownership.json', ownership); await save('results.json', report);
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length, failure: report.failure, cleanup: report.cleanup }));
  return report.passed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runLocalOperationsScheduleBrowser()) process.exitCode = 1; }
  catch { console.error('LOCAL_OPERATIONS_SCHEDULE_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

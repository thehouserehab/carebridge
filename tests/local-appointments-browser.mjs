// Synthetic appointment UI -> authenticated HTTP -> owned memory PGlite.
// Clinical writes use UI. Fixture SQL only creates a child/relationships and
// later revokes one synthetic therapist relationship; no E/native service.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceView, workspaceRecords, workspaceAccountAction } from './local-workspace-browser-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), code = 'LOCAL_APPOINTMENTS_FAILED';
const hash = value => createHash('sha256').update(value).digest('hex');
const appointmentKeys = ['id', 'conversationId', 'childId', 'revision', 'date', 'time', 'duration', 'title', 'room', 'status', 'updatedAt', 'therapistId'].sort();
const receiptKeys = ['kind', 'id', 'revision', 'changed', 'replayed'].sort();
const assets = new Set(['/', '/favicon.ico', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/client.js', '/local-api/care-client.js',
  '/local-api/appointment-client.js', '/local-api/goal-client.js', '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css',
  '/local-api/media-client.js', '/local-api/media-ui.js', '/local-api/media-viewer.js', '/local-api/operations-client.js',
  '/local-api/operations-ui.js', '/local-api/operations-recipient.js', '/local-api/operations-onboarding.js', '/local-api/operations-schedule.js', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js',
  '/src/profile-fields.js', '/src/context-fields.js']);
const clinicalTables = ['cb_messages', 'cb_read_states', 'cb_message_reviews', 'cb_records', 'cb_record_revisions',
  'cb_record_requests', 'cb_record_assessments', 'cb_publications', 'cb_activity_feedback', 'cb_feedback_revisions',
  'cb_feedback_reviews', 'cb_feedback_requests', 'cb_child_family_plans', 'cb_goals', 'cb_goal_revisions', 'cb_audit_events'];
async function sources() {
  const names = ['tests/local-appointments-browser.mjs', 'tests/local-workspace-browser-helpers.mjs',
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
      const modal = element.closest('dialog');
      // An open modal is in the top layer, above the background fixed nav.
      const outsideNav = !!modal?.open || !n || r.bottom <= n.top || r.top >= n.bottom || r.right <= n.left || r.left >= n.right;
      const withinViewport = r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      const x = Math.min(6, r.width / 4), y = Math.min(6, r.height / 4);
      const hits = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + x, r.top + y], [r.right - x, r.top + y],
        [r.left + x, r.bottom - y], [r.right - x, r.bottom - y]].map(([px, py]) => element.contains(document.elementFromPoint(px, py)));
      const rect = v => v ? Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map(k => [k, v[k]])) : null;
      return { connected: element.isConnected, bounds: rect(r), viewport: { width: innerWidth, height: innerHeight },
        fixedNav: rect(n), modal: !!modal?.open, withinViewport, outsideNav, hits, passed: withinViewport && outsideNav && hits.every(Boolean) };
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
async function fixture(sandbox) {
  const suffix = randomUUID(), { ids } = sandbox;
  const child = { childId: `appointment-child-${suffix}`, roomId: `appointment-room-${suffix}` };
  await sandbox.database.transaction(async tx => {
    await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)', [ids.centerId, child.childId]);
    await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)', [ids.centerId, child.roomId, child.childId]);
    await tx.query(`INSERT INTO cb_child_profiles(center_id,child_id,name,age,age_as_of,revision,updated_by)
      VALUES ($1,$2,'가상 다른 일정 아동',NULL,NULL,1,$3)`, [ids.centerId, child.childId, ids.managerId]);
    await tx.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
      VALUES ($1,$2,$3,'therapist',true,1),($1,$2,$4,'guardian',true,1)`, [ids.centerId, child.roomId, ids.therapistId, ids.guardianId]);
  });
  return child;
}

export async function runLocalAppointmentsBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const name of [options.module, options.executable]) { const stat = await lstat(name); assert(stat.isFile() && !stat.isSymbolicLink(), code); }
  const source = await sources(), { chromium } = await import(pathToFileURL(options.module).href);
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-appointments-${runId}`); await mkdir(folder);
  const report = { runId, startedAt: new Date().toISOString(), source, passed: false, checks: [], screenshots: [], errors: [], unexpectedRequests: [],
    failure: null, cleanupObservationTimedOut: false, cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Owned Chromium and fresh memory-only PGlite; synthetic accounts only. No E/native, physical devices, real data or external service.',
      'All successful appointment and clinical writes use UI. SQL only creates an invented child/relationships and revokes its therapist relationship.',
      'One actual successful appointment response is discarded; real traffic is delayed to expose conflicts and late responses. No approval/result is fabricated.',
      'Authenticated direct requests prove exact historical records and rejected role/scope access, not automatic UI behavior.',
      'Viewport and storage checks do not prove physical-device usability, secure memory erasure or production retention.'] };
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
      const extra = await fixture(sandbox), { ids, origin } = sandbox, originUrl = new URL(origin);
      const child = { roomId: ids.conversationId, childId: ids.childId };
      assert(originUrl.origin === origin && originUrl.protocol === 'http:' && originUrl.hostname === '127.0.0.1' && originUrl.port && !originUrl.username && !originUrl.password, code);
      const base = `/api/local/centers/${ids.centerId}/conversations/${child.roomId}`;
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const title1 = `가상 <b>새 일정 ${width}</b>`, title2 = `가상 바뀐 일정 ${width}`, peerTitle = `가상 다른 창 일정 ${width}`;
      const keptTitle = `가상 유지할 일정 입력 ${width}`, revokedTitle = `가상 종료할 일정 입력 ${width}`;
      const place = '가상 시험실', privateNote = `가상 일정 기록 내부 메모 ${width}`;
      const mutations = [], privilegedRequests = [], appointmentResponses = [];
      const result = { width, newAppointment: false, realLossRetry: false, receiptExactlyOnce: false, minimalDto: false,
        roleAndScope: false, sharedCurrent: false, linkedRecord: false, oneRecordPerAppointment: false, historicalSnapshot: false,
        cancelAndRestore: false, noOp: false, scheduleConflict: false, conflictInputPreserved: false,
        actualRevisionConflict: false, explicitKeepAndReplace: false, lateRoomDiscarded: false, lateAccountDiscarded: false,
        revokedInputCleared: false, noAutomaticClinicalWrites: false, keyboard: false, reachability: false, layout: false,
        browserStorageEmpty: false, cleanup: false };
      report.currentCheck = result;
      const roleOf = label => label === 'peer' ? 'therapist' : label;
      const userOf = label => roleOf(label) === 'center' ? ids.managerId : ids[`${roleOf(label)}Id`];
      const login = async (page, label) => {
        const credential = sandbox.credentials.find(item => item.role === roleOf(label)); assert(credential?.email.endsWith('.test'), code);
        await page.getByTestId('login-form').waitFor();
        await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click();
        await page.getByTestId(roleOf(label) === 'center' ? 'operations-children' : 'home').waitFor();
      };
      const actor = async label => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR', isMobile: width <= 640,
          hasTouch: width <= 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context); context.once('close', () => contexts.delete(context)); assert.equal((await context.cookies()).length, 0, code);
        const fault = { loseNext: false, losses: 0, receipt: null, nextGet: null, nextPost: null };
        await context.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url()), method = request.method(), entryPhase = phase;
          const primaryRead = method === 'GET' && url.pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
            [...url.searchParams].length === 1 && [ids.conversationId, extra.roomId].includes(url.searchParams.get('conversationId'));
          const allowed = /^\/api\/local\/(?:auth\/(?:login|session|logout)|centers\/[A-Za-z0-9_-]+\/(?:operations\/(?:children|conversations\/[A-Za-z0-9_-]+\/profile)|inbox|conversations\/[A-Za-z0-9_-]+\/(?:profile|family-plan|read|goals(?:\/[A-Za-z0-9_-]+)?|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+)?|records(?:\/[A-Za-z0-9_-]+)?(?:\/(?:preview|publish))?)))$/.test(url.pathname);
          if (url.origin !== origin || !['GET', 'POST', 'HEAD'].includes(method) || !((assets.has(url.pathname) && ['GET', 'HEAD'].includes(method)) || allowed || primaryRead)) {
            note(report.unexpectedRequests, { width, label, phase: entryPhase, sameOrigin: url.origin === origin, method: ['GET', 'POST', 'HEAD'].includes(method) ? method : 'OTHER' });
            return route.abort().catch(() => {});
          }
          const detail = /\/appointments\/[A-Za-z0-9_-]+$/.test(url.pathname);
          if (request.headers()['x-carebridge-account'] === ids.guardianId && (detail && method === 'POST' || /\/records(?:\/|$)/.test(url.pathname)))
            privilegedRequests.push({ label, phase: entryPhase });
          if (!detail) return route.continue().catch(() => {});
          const item = method === 'POST' ? { label, pathname: url.pathname, body: structuredClone(request.postDataJSON()) } : null;
          if (item) mutations.push(item);
          const lost = !!item && fault.loseNext; if (lost) fault.loseNext = false;
          const heldGet = method === 'GET' ? fault.nextGet : null; if (heldGet) fault.nextGet = null;
          const heldPost = item ? fault.nextPost : null; if (heldPost) fault.nextPost = null;
          const work = (async () => {
            let response;
            try {
              if (heldPost) { heldPost.entered.resolve(); await heldPost.release.promise; }
              response = await route.fetch({ maxRedirects: 0, timeout: 15_000 }); const body = await response.json();
              assert.equal(response.headers()['cache-control'], 'no-store', code); assert(!JSON.stringify(body).includes(privateNote), code);
              if (response.status() === 200) {
                if (item) {
                  assert.deepEqual(Object.keys(body), ['receipt'], code); assert.deepEqual(Object.keys(body.receipt).sort(), receiptKeys, code);
                  assert.deepEqual(Object.keys(item.body).sort(), ['clientId', 'expectedRevision', 'content'].sort(), code);
                  assert.deepEqual(Object.keys(item.body.content).sort(), ['date', 'time', 'duration', 'title', 'room', 'status'].sort(), code);
                  item.receipt = structuredClone(body.receipt);
                } else {
                  assert.deepEqual(Object.keys(body), ['appointment'], code); assert.deepEqual(Object.keys(body.appointment).sort(), appointmentKeys, code);
                  appointmentResponses.push(body.appointment);
                }
              } else assert([400, 401, 404, 409].includes(response.status()), code);
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
      const therapist = await actor('therapist'), guardian = await actor('guardian'), peer = await actor('peer'), manager = await actor('center');
      const actors = [therapist, guardian, peer, manager], dialog = who => who.page.getByTestId('care-dialog');
      const field = (who, name) => dialog(who).locator(`[name="${name}"]`);
      const fill = async (who, name, value) => { const input = field(who, name); await reveal(input); await input.fill(value); };
      const childView = async (who, roomId = child.roomId) => {
        await who.page.bringToFront(); await workspaceView(who.page, 'child'); await who.page.locator('#child-select:not([disabled])').waitFor();
        if (await who.page.locator('#child-select').inputValue() !== roomId) await who.page.locator('#child-select').selectOption(roomId);
        await who.page.waitForFunction(id => document.querySelector('#child-select')?.value === id && !document.querySelector('#child-select')?.disabled, roomId);
        await who.page.getByTestId('child-activities').waitFor();
      };
      const request = async (who, suffix, method = 'GET', body = undefined, roomId = child.roomId) => {
        const response = await who.context.request.fetch(`${origin}/api/local/centers/${ids.centerId}/conversations/${roomId}${suffix}`, {
          method, ...(body === undefined ? {} : { data: body }), timeout: 15_000, maxRedirects: 0,
          headers: { 'X-Carebridge-Account': who.userId, ...(method === 'POST' ? { Origin: origin, 'X-Carebridge-Request': '1' } : {}) } });
        try { return { status: response.status(), body: await response.json() }; } finally { await response.dispose(); }
      };
      const readRecord = async (recordId, revision = 1) => {
        const response = await request(therapist, `/records/${recordId}?revision=${revision}`); assert.equal(response.status, 200, code); return response.body.record;
      };
      const snapshot = async tables => {
        const value = {};
        for (const table of tables) value[table] = (await sandbox.database.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE center_id=$1 ORDER BY to_jsonb(t)::text`, [ids.centerId])).rows;
        return value;
      };
      const contextSnapshot = () => snapshot(['cb_appointments', 'cb_appointment_revisions', 'cb_context_requests', 'cb_conversations']);
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
      const openAppointment = async (who, appointmentId = null) => {
        await childView(who);
        const button = who.page.getByTestId('child-appointments').locator(appointmentId ? `[data-appointment-edit="${appointmentId}"]` : '[data-appointment-new]');
        await button.click(); await dialog(who).locator('form[data-care-form="appointment"]').waitFor();
      };
      const appointmentValues = async (who, overrides = {}) => {
        const values = { date: today, time: '09:00', duration: '30', title: title1, room: place, status: 'scheduled', ...overrides };
        for (const [name, value] of Object.entries(values)) {
          if (name === 'status') await field(who, name).selectOption(value); else await fill(who, name, String(value));
        }
      };
      const submitAppointment = async (who, label = '일정 저장', expected = 200) => {
        const [response] = await Promise.all([who.page.waitForResponse(r => new URL(r.url()).pathname.startsWith(base + '/appointments/') && r.request().method() === 'POST'),
          dialog(who).getByRole('button', { name: label, exact: true }).click()]);
        assert.equal(response.status(), expected, code); const body = await response.json();
        if (expected === 200) await dialog(who).waitFor({ state: 'hidden' }); return body;
      };
      const currentAppointment = async id => {
        const response = await request(therapist, `/appointments/${id}`); assert.equal(response.status, 200, code); return response.body.appointment;
      };
      const visibleSchedule = async (who, title, status) => {
        await childView(who); await workspaceAccountAction(who.page, 'refresh');
        const schedule = who.page.getByTestId('child-appointments');
        const row = schedule.locator('.schedule-row').filter({ has: who.page.getByRole('heading', { name: title, exact: true }) });
        await row.waitFor(); await who.page.waitForFunction(({ title, status }) => [...document.querySelectorAll('[data-testid="child-appointments"] .schedule-row')]
          .some(node => node.querySelector('h3')?.textContent === title && node.textContent.includes(status)), { title, status });
        await row.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
        assert.equal(await schedule.getByRole('heading', { name: title, exact: true }).count(), 1, code); return row;
      };
      const observeLate = who => who.page.evaluate(() => {
        window.__lateAppointment = false; window.__appointmentObserver?.disconnect();
        window.__appointmentObserver = new MutationObserver(changes => { if (changes.some(change => [...change.addedNodes].some(node => node.nodeType === Node.ELEMENT_NODE &&
          (node.matches('form[data-care-form="appointment"]') || node.querySelector('form[data-care-form="appointment"]'))))) window.__lateAppointment = true; });
        window.__appointmentObserver.observe(document.body, { subtree: true, childList: true });
      });
      const noLate = async who => {
        await who.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await who.page.evaluate(() => window.__lateAppointment), false, code); await who.page.evaluate(() => window.__appointmentObserver.disconnect());
      };


      phase = `${width}:CREATE_REAL_LOSS_AND_EXACT_RETRY`;
      const beforeCreate = await snapshot(clinicalTables); await childView(therapist);
      const add = therapist.page.getByTestId('child-appointments').locator('[data-appointment-new]'); await reachable(add); await add.focus(); await add.press('Enter');
      await dialog(therapist).locator('form[data-care-form="appointment"]').waitFor();
      assert.equal(await field(therapist, 'time').inputValue(), '', code); assert.equal(await field(therapist, 'duration').inputValue(), '', code);
      await appointmentValues(therapist); await field(therapist, 'title').focus(); await therapist.page.keyboard.press('Tab');
      assert.equal(await field(therapist, 'room').evaluate(node => node === document.activeElement), true, code);
      await reachable(dialog(therapist).getByRole('button', { name: '일정 저장', exact: true })); await capture(therapist, 'new-appointment-editor');
      therapist.fault.loseNext = true; await dialog(therapist).getByRole('button', { name: '일정 저장', exact: true }).click();
      await dialog(therapist).getByRole('button', { name: '같은 요청 다시 확인', exact: true }).waitFor();
      await therapist.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="care-dialog"] button')].some(button =>
        button.textContent === '같은 요청 다시 확인' && !button.disabled && button.getClientRects().length > 0));
      assert.equal(therapist.fault.losses, 1, code); assert.equal(mutations.length, 1, code);
      const operation = structuredClone(mutations[0]), committed = await contextSnapshot(); await capture(therapist, 'unknown-appointment-preserved');
      const replay = await submitAppointment(therapist, '같은 요청 다시 확인'), appointmentId = replay.receipt.id;
      assert.deepEqual(mutations[1].body, operation.body, code); assert.equal(mutations[1].pathname, operation.pathname, code);
      assert.deepEqual(replay.receipt, { ...therapist.fault.receipt, replayed: true }, code);
      assert.equal(replay.receipt.revision, 1, code); assert.deepEqual(await contextSnapshot(), committed, code);
      assert.deepEqual(await snapshot(clinicalTables), beforeCreate, code);
      result.newAppointment = result.realLossRetry = result.receiptExactlyOnce = result.keyboard = result.reachability = true;
      const firstAppointment = await currentAppointment(appointmentId);
      assert.equal(firstAppointment.date, today, code); assert.equal(firstAppointment.time, '09:00', code); assert.equal(firstAppointment.duration, 30, code);

      phase = `${width}:GUARDIAN_CURRENT_AND_ROLE_SCOPE`;
      await visibleSchedule(guardian, title1, '예정'); await capture(guardian, 'guardian-current-schedule');
      assert.equal(await guardian.page.locator('[data-appointment-new],[data-appointment-edit],[data-appointment-record]').count(), 0, code);
      assert.equal(await guardian.page.locator('h3 b').count(), 0, code);
      const guardianAppointment = await request(guardian, `/appointments/${appointmentId}`);
      assert.equal(guardianAppointment.status, 200, code); assert.deepEqual(Object.keys(guardianAppointment.body.appointment).sort(), appointmentKeys, code);
      const rejected = { clientId: randomUUID(), expectedRevision: 1, content: { date: today, time: '09:00', duration: 30, title: title1, room: place, status: 'scheduled' } };
      assert.equal((await request(guardian, `/appointments/${appointmentId}`, 'POST', rejected)).status, 404, code);
      assert.equal((await request(manager, `/appointments/${appointmentId}`)).status, 404, code);
      assert.equal((await request(manager, `/appointments/${appointmentId}`, 'POST', rejected)).status, 404, code);
      assert.equal((await request(therapist, `/appointments/${appointmentId}`, 'GET', undefined, extra.roomId)).status, 404, code);
      assert.deepEqual(await snapshot(clinicalTables), beforeCreate, code); result.roleAndScope = result.sharedCurrent = true;

      phase = `${width}:APPOINTMENT_TO_ONE_RECORD`;
      await childView(therapist); const recordButton = therapist.page.getByTestId('child-appointments').locator(`[data-appointment-record="${appointmentId}"]`);
      await recordButton.waitFor(); await reachable(recordButton); await capture(therapist, 'schedule-record-entry'); await recordButton.click();
      await dialog(therapist).locator('form[data-care-form="record"]').waitFor(); assert.equal(await field(therapist, 'date').inputValue(), today, code);
      await field(therapist, 'goalId').selectOption(ids.goalId);
      for (const [name, value] of Object.entries({ title: `가상 일정 연결 기록 ${width}`, performed: '가상 회기 관찰', response: '가상 반응', nextPlan: '가상 다음 계획', privateNote })) await fill(therapist, name, value);
      const [recordResponse] = await Promise.all([therapist.page.waitForResponse(r => new URL(r.url()).pathname.startsWith(base + '/records/') && r.request().method() === 'POST'),
        dialog(therapist).getByRole('button', { name: '기록 저장', exact: true }).click()]);
      assert.equal(recordResponse.status(), 201, code); const recordId = (await recordResponse.json()).receipt.recordId;
      await dialog(therapist).waitFor({ state: 'hidden' }); const originalRecord = await readRecord(recordId);
      assert.equal(originalRecord.appointmentId, appointmentId, code); assert.equal(originalRecord.appointmentRevision, 1, code);
      assert.deepEqual(originalRecord.appointmentSnapshot, { revision: 1, date: today, time: '09:00', duration: 30, title: title1, room: place, status: 'scheduled' }, code);
      await childView(therapist); await therapist.page.getByTestId('child-appointments').locator(`[data-appointment-record="${appointmentId}"]`).filter({ hasText: '기록 이어보기' }).waitFor();
      await therapist.page.getByTestId('child-appointments').locator(`[data-appointment-record="${appointmentId}"]`).click(); await dialog(therapist).locator('form[data-care-form="record"]').waitFor();
      assert.equal(await field(therapist, 'title').inputValue(), originalRecord.title, code);
      await dialog(therapist).getByRole('button', { name: '입력 취소', exact: true }).click(); await dialog(therapist).waitFor({ state: 'hidden' });
      const recordRows = (await sandbox.database.query('SELECT id FROM cb_records WHERE center_id=$1 AND conversation_id=$2 AND appointment_id=$3', [ids.centerId, child.roomId, appointmentId])).rows;
      assert.deepEqual(recordRows.map(row => row.id), [recordId], code);
      assert.equal((await request(guardian, `/records/${recordId}?revision=1`)).status, 404, code);
      result.linkedRecord = result.oneRecordPerAppointment = true; const clinicalBaseline = await snapshot(clinicalTables);

      phase = `${width}:EDIT_CANCEL_RESTORE_AND_SNAPSHOT`;
      await openAppointment(therapist, appointmentId); await appointmentValues(therapist, { title: title2, time: '11:00', status: 'attended' });
      assert.equal((await submitAppointment(therapist)).receipt.revision, 2, code);
      await visibleSchedule(guardian, title2, '완료'); assert.deepEqual(await readRecord(recordId), originalRecord, code);
      await openAppointment(therapist, appointmentId); await field(therapist, 'status').selectOption('cancelled'); await submitAppointment(therapist);
      await visibleSchedule(guardian, title2, '취소'); await capture(guardian, 'guardian-cancelled-schedule');
      await openAppointment(therapist, appointmentId); await field(therapist, 'status').selectOption('scheduled'); await submitAppointment(therapist);
      await visibleSchedule(guardian, title2, '예정'); assert.deepEqual(await readRecord(recordId), originalRecord, code);
      await childView(therapist); await therapist.page.getByTestId('child-appointments').locator(`[data-appointment-record="${appointmentId}"]`).click();
      await dialog(therapist).locator('form[data-care-form="record"]').waitFor();
      const historicalSchedule = dialog(therapist).locator('[data-record-appointment-snapshot]');
      const currentSchedule = dialog(therapist).locator('.care-appointment-context');
      const historicalText = await historicalSchedule.innerText(), currentText = await currentSchedule.innerText();
      assert(historicalText.includes('09:00') && historicalText.includes('1번째 내용') && historicalText.includes(title1), code);
      assert(!historicalText.includes('11:00'), code);
      assert(currentText.includes('11:00') && currentText.includes(title2) && !currentText.includes('09:00'), code);
      // Scroll only: inspect the two distinct labels in the actual saved-record
      // editor without saving a new revision or changing its historical data.
      await dialog(therapist).evaluate(node => { node.scrollTop = 0; });
      for (const label of [currentSchedule, historicalSchedule]) assert.equal(await label.evaluate(node => {
        const r = node.getBoundingClientRect(), d = node.closest('dialog').getBoundingClientRect();
        return r.height > 0 && r.top >= Math.max(0, d.top) && r.bottom <= Math.min(innerHeight, d.bottom) &&
          r.left >= Math.max(0, d.left) && r.right <= Math.min(innerWidth, d.right);
      }), true, code);
      await capture(therapist, 'record-historical-and-current-appointment');
      await dialog(therapist).getByRole('button', { name: '입력 취소', exact: true }).click(); await dialog(therapist).waitFor({ state: 'hidden' });
      assert.deepEqual(await readRecord(recordId), originalRecord, code);
      assert.deepEqual(await snapshot(clinicalTables), clinicalBaseline, code); result.cancelAndRestore = result.historicalSnapshot = true;
      await openAppointment(therapist, appointmentId); const beforeNoOp = await contextSnapshot(), noOp = await submitAppointment(therapist);
      assert.equal(noOp.receipt.changed, false, code); const afterNoOp = await contextSnapshot();
      for (const table of ['cb_appointments', 'cb_appointment_revisions', 'cb_conversations']) assert.deepEqual(afterNoOp[table], beforeNoOp[table], code);
      assert.equal(afterNoOp.cb_context_requests.length, beforeNoOp.cb_context_requests.length + 1, code); result.noOp = true;

      phase = `${width}:REAL_TIME_COLLISION`;
      await openAppointment(therapist); const conflictTitle = `가상 겹치는 일정 ${width}`;
      await appointmentValues(therapist, { title: conflictTitle, time: '11:00' });
      const scheduleBefore = await contextSnapshot(), collision = await submitAppointment(therapist, '일정 저장', 409);
      assert.equal(collision.error, 'SCHEDULE_CONFLICT', code);
      assert.equal(await field(therapist, 'title').inputValue(), conflictTitle, code); assert.equal(await field(therapist, 'time').inputValue(), '11:00', code);
      assert.deepEqual(await contextSnapshot(), scheduleBefore, code); await capture(therapist, 'schedule-conflict-preserved');
      await fill(therapist, 'time', '10:00'); const corrected = await submitAppointment(therapist);
      assert.equal(corrected.receipt.revision, 1, code); assert.notEqual(corrected.receipt.id, appointmentId, code);
      assert.equal((await currentAppointment(corrected.receipt.id)).time, '10:00', code);
      assert.deepEqual(await snapshot(clinicalTables), clinicalBaseline, code); result.scheduleConflict = result.conflictInputPreserved = true;

      phase = `${width}:REAL_REVISION_CONFLICT_KEEP`;
      await openAppointment(peer, appointmentId); await fill(peer, 'title', peerTitle);
      await openAppointment(therapist, appointmentId); await fill(therapist, 'title', keptTitle);
      const heldPost = gate(); therapist.fault.nextPost = heldPost;
      try {
        const conflict = therapist.page.waitForResponse(r => new URL(r.url()).pathname === `${base}/appointments/${appointmentId}` && r.request().method() === 'POST' && r.status() === 409); void conflict.catch(() => {});
        await dialog(therapist).getByRole('button', { name: '일정 저장', exact: true }).click(); await bounded(heldPost.entered.promise, 5000);
        await submitAppointment(peer); heldPost.finish(); assert.equal((await (await conflict).json()).error, 'APPOINTMENT_CONFLICT', code); await bounded(heldPost.done.promise, 5000);
        assert.equal(await field(therapist, 'title').inputValue(), keptTitle, code);
        assert.equal(await dialog(therapist).getByRole('button', { name: '일정 저장', exact: true }).isDisabled(), true, code);
        await dialog(therapist).getByRole('button', { name: '최신 일정 확인', exact: true }).click();
        await dialog(therapist).locator('[data-appointment-latest]').filter({ hasText: peerTitle }).waitFor();
        const beforeKeep = await contextSnapshot(), keep = dialog(therapist).getByRole('button', { name: '현재 입력 유지하고 다시 검토', exact: true });
        await reachable(keep); await capture(therapist, 'revision-conflict-keep'); await keep.click();
        assert.equal(await field(therapist, 'title').inputValue(), keptTitle, code); assert.deepEqual(await contextSnapshot(), beforeKeep, code);
        await submitAppointment(therapist); result.actualRevisionConflict = true;
      } finally { heldPost.finish(); }

      phase = `${width}:LATEST_REPLACE_REQUIRES_EXPLICIT_SAVE`;
      await openAppointment(peer, appointmentId); const replacedTitle = `가상 최신 내용으로 바꿀 일정 ${width}`; await fill(peer, 'title', replacedTitle);
      await openAppointment(therapist, appointmentId); await fill(therapist, 'title', '가상 버릴 수정 입력'); await submitAppointment(peer);
      await dialog(therapist).getByRole('button', { name: '최신 일정 확인', exact: true }).click();
      await dialog(therapist).locator('[data-appointment-latest]').filter({ hasText: replacedTitle }).waitFor();
      const beforeReplace = await contextSnapshot(), countBeforeReplace = mutations.length;
      await dialog(therapist).getByRole('button', { name: '최신 내용으로 바꾸기', exact: true }).click();
      assert.equal(await field(therapist, 'title').inputValue(), replacedTitle, code); assert.equal(mutations.length, countBeforeReplace, code);
      assert.deepEqual(await contextSnapshot(), beforeReplace, code);
      const replaced = await submitAppointment(therapist); assert.equal(replaced.receipt.changed, false, code);
      result.explicitKeepAndReplace = true; assert.deepEqual(await readRecord(recordId), originalRecord, code);

      phase = `${width}:LATE_APPOINTMENT_OTHER_ROOM`;
      await childView(therapist); const heldRoom = gate(); therapist.fault.nextGet = heldRoom;
      try {
        await therapist.page.getByTestId('child-appointments').locator(`[data-appointment-edit="${appointmentId}"]`).click(); await bounded(heldRoom.entered.promise, 5000);
        await therapist.page.locator('#child-select').selectOption(extra.roomId);
        await therapist.page.waitForFunction(id => document.querySelector('#child-select')?.value === id && !document.querySelector('#child-select')?.disabled, extra.roomId);
        await observeLate(therapist); heldRoom.finish(); await bounded(heldRoom.done.promise, 5000); await noLate(therapist);
        assert.equal(await dialog(therapist).isVisible(), false, code); assert.equal(await therapist.page.getByTestId('child-appointments').locator(`[data-appointment-edit="${appointmentId}"]`).count(), 0, code);
        result.lateRoomDiscarded = true;
      } finally { heldRoom.finish(); }

      phase = `${width}:LATE_APPOINTMENT_ACCOUNT_SWITCH`;
      await childView(therapist); const heldAccount = gate(); therapist.fault.nextGet = heldAccount;
      try {
        await therapist.page.getByTestId('child-appointments').locator(`[data-appointment-edit="${appointmentId}"]`).click(); await bounded(heldAccount.entered.promise, 5000);
        await workspaceAccountAction(therapist.page, 'logout'); await login(therapist.page, 'guardian');
        await observeLate(therapist); heldAccount.finish(); await bounded(heldAccount.done.promise, 5000); await noLate(therapist);
        assert.equal(await dialog(therapist).isVisible(), false, code); assert.equal(await therapist.page.locator('[data-appointment-new],[data-appointment-edit]').count(), 0, code);
        result.lateAccountDiscarded = true;
      } finally { heldAccount.finish(); }
      await workspaceAccountAction(therapist.page, 'logout'); await login(therapist.page, 'therapist');

      phase = `${width}:RELATIONSHIP_REVOKES_EDITOR`;
      await openAppointment(therapist, appointmentId); await fill(therapist, 'title', revokedTitle);
      await sandbox.database.query('UPDATE cb_participants SET active=false WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3', [ids.centerId, child.roomId, ids.therapistId]);
      await dialog(therapist).waitFor({ state: 'hidden', timeout: 15_000 });
      assert.equal(await therapist.page.locator('form[data-care-form="appointment"]').count(), 0, code);
      assert(!(await therapist.page.locator('body').innerText()).includes(revokedTitle), code);
      assert.equal((await request(therapist, `/appointments/${appointmentId}`)).status, 404, code); await capture(therapist, 'revoked-appointment-cleared'); result.revokedInputCleared = true;
      assert.deepEqual(await snapshot(clinicalTables), clinicalBaseline, code); result.noAutomaticClinicalWrites = true;
      assert.equal(privilegedRequests.length, 0, code); assert(appointmentResponses.length > 0, code); result.minimalDto = true;
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
      testLine: Number(error?.stack?.match(/local-appointments-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      workspaceHelperLine: Number(error?.stack?.match(/local-workspace-browser-helpers\.mjs:(\d+):\d+/)?.[1]) || null };
    if (error?.reachability) report.failure.reachability = error.reachability;
    for (const [label, page] of [...pages].filter(([label]) => ['therapist', 'peer'].includes(label)).slice(0, 2)) try {
      const filename = `failure-${label}.png`; await page.screenshot({ path: path.join(folder, filename), fullPage: false,
        mask: [page.locator('input[type="email"]'), page.locator('input[type="password"]'), page.locator('.workspace-head .account')] });
      report.screenshots.push({ filename, syntheticOnly: true, failure: true });
    } catch { note(report.errors, { phase, type: 'failure-screenshot' }); }
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
  try { if (!await runLocalAppointmentsBrowser()) process.exitCode = 1; }
  catch { console.error('LOCAL_APPOINTMENTS_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

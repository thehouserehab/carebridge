// Synthetic goal UI -> authenticated HTTP -> owned memory PGlite.
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

const root = fileURLToPath(new URL('../', import.meta.url)), code = 'LOCAL_GOALS_FAILED';
const hash = value => createHash('sha256').update(value).digest('hex');
const goalKeys = ['id', 'conversationId', 'childId', 'revision', 'title', 'description', 'status', 'updatedAt'].sort();
const receiptKeys = ['kind', 'id', 'revision', 'changed', 'replayed'].sort();
const assets = new Set(['/', '/favicon.ico', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/client.js', '/local-api/care-client.js',
  '/local-api/goal-client.js', '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css',
  '/local-api/media-client.js', '/local-api/media-ui.js', '/local-api/media-viewer.js', '/local-api/operations-client.js',
  '/local-api/operations-ui.js', '/local-api/operations-recipient.js', '/local-api/operations-onboarding.js', '/local-api/operations-schedule.js', '/local-api/appointment-client.js', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js',
  '/src/profile-fields.js', '/src/context-fields.js']);
const clinicalTables = ['cb_messages', 'cb_read_states', 'cb_message_reviews', 'cb_records', 'cb_record_revisions',
  'cb_record_requests', 'cb_record_assessments', 'cb_publications', 'cb_activity_feedback', 'cb_feedback_revisions',
  'cb_feedback_reviews', 'cb_feedback_requests', 'cb_child_family_plans', 'cb_appointments', 'cb_appointment_revisions', 'cb_audit_events'];
async function sources() {
  const names = ['tests/local-goals-browser.mjs', 'tests/local-workspace-browser-helpers.mjs',
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
  const child = { childId: `goal-child-${suffix}`, roomId: `goal-room-${suffix}` };
  await sandbox.database.transaction(async tx => {
    await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)', [ids.centerId, child.childId]);
    await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)', [ids.centerId, child.roomId, child.childId]);
    await tx.query(`INSERT INTO cb_child_profiles(center_id,child_id,name,age,age_as_of,revision,updated_by)
      VALUES ($1,$2,'가상 첫 목표 아동',NULL,NULL,1,$3)`, [ids.centerId, child.childId, ids.managerId]);
    await tx.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
      VALUES ($1,$2,$3,'therapist',true,1),($1,$2,$4,'guardian',true,1)`, [ids.centerId, child.roomId, ids.therapistId, ids.guardianId]);
  });
  return child;
}

export async function runLocalGoalsBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const name of [options.module, options.executable]) { const stat = await lstat(name); assert(stat.isFile() && !stat.isSymbolicLink(), code); }
  const source = await sources(), { chromium } = await import(pathToFileURL(options.module).href);
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-goals-${runId}`); await mkdir(folder);
  const report = { runId, startedAt: new Date().toISOString(), source, passed: false, checks: [], screenshots: [], errors: [], unexpectedRequests: [],
    failure: null, cleanupObservationTimedOut: false, cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Owned Chromium and fresh memory-only PGlite; synthetic accounts only. No E/native, physical devices, real data or external service.',
      'All successful goal and clinical writes use UI. SQL only creates an invented child/relationships and revokes its therapist relationship.',
      'One actual successful goal response is discarded; real traffic is delayed to expose conflicts and late responses. No approval/result is fabricated.',
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
      const child = await fixture(sandbox), { ids, origin } = sandbox, originUrl = new URL(origin);
      assert(originUrl.origin === origin && originUrl.protocol === 'http:' && originUrl.hostname === '127.0.0.1' && originUrl.port && !originUrl.username && !originUrl.password, code);
      const base = `/api/local/centers/${ids.centerId}/conversations/${child.roomId}`;
      const title1 = `가상 <b>첫 놀이 목표 ${width}</b>`, title2 = `가상 수정한 목표 ${width}`, peerTitle = `가상 다른 창 목표 ${width}`;
      const keptTitle = `가상 유지할 목표 입력 ${width}`, revokedTitle = `가상 종료할 목표 입력 ${width}`;
      const description1 = '가상 가족의 관심사에서 정한 목표\n실제 치료 지침이 아닙니다.', privateNote = `가상 내부 메모 ${width}`;
      const mutations = [], privilegedRequests = [], goalResponses = [];
      const result = { width, firstGoalUnlocksRecord: false, roleAndScope: false, sharedCurrent: false, minimalDto: false,
        realLossRetry: false, receiptExactlyOnce: false, newGoalRecord: false, historicalSnapshot: false, newRevisionRecord: false,
        noOp: false, actualConflict: false, conflictInputPreserved: false, recordReceiptObserved: false, staleRecordRejected: false,
        explicitRecordContextRecovery: false,
        lateRoomDiscarded: false, lateAccountDiscarded: false, revokedInputCleared: false, noAutomaticClinicalWrites: false,
        keyboard: false, reachability: false, layout: false, browserStorageEmpty: false, cleanup: false };
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
        const fault = { loseNext: false, losses: 0, receipt: null, nextGoalGet: null, nextGoalPost: null, nextRecordPost: null };
        await context.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url()), method = request.method(), entryPhase = phase;
          const primaryRead = method === 'GET' && url.pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
            [...url.searchParams].length === 1 && [ids.conversationId, child.roomId].includes(url.searchParams.get('conversationId'));
          const allowed = /^\/api\/local\/(?:auth\/(?:login|session|logout)|centers\/[A-Za-z0-9_-]+\/(?:operations\/(?:children|conversations\/[A-Za-z0-9_-]+\/profile)|inbox|conversations\/[A-Za-z0-9_-]+\/(?:profile|family-plan|read|goals(?:\/[A-Za-z0-9_-]+)?|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+)?|records(?:\/[A-Za-z0-9_-]+)?(?:\/(?:preview|publish))?)))$/.test(url.pathname);
          if (url.origin !== origin || !['GET', 'POST', 'HEAD'].includes(method) || !((assets.has(url.pathname) && ['GET', 'HEAD'].includes(method)) || allowed || primaryRead)) {
            note(report.unexpectedRequests, { width, label, phase: entryPhase, sameOrigin: url.origin === origin, method: ['GET', 'POST', 'HEAD'].includes(method) ? method : 'OTHER' });
            return route.abort().catch(() => {});
          }
          const goalDetail = /\/goals\/[A-Za-z0-9_-]+$/.test(url.pathname), recordPost = method === 'POST' && /\/records\/[A-Za-z0-9_-]+$/.test(url.pathname);
          if (request.headers()['x-carebridge-account'] === ids.guardianId && (goalDetail && method === 'POST' || /\/records(?:\/|$)/.test(url.pathname)))
            privilegedRequests.push({ label, phase: entryPhase });
          if (!goalDetail && !(recordPost && fault.nextRecordPost)) return route.continue().catch(() => {});
          const item = goalDetail && method === 'POST' ? { label, pathname: url.pathname, body: structuredClone(request.postDataJSON()) } : null;
          if (item) mutations.push(item);
          const lost = !!item && fault.loseNext; if (lost) fault.loseNext = false;
          const heldGet = goalDetail && method === 'GET' ? fault.nextGoalGet : null; if (heldGet) fault.nextGoalGet = null;
          const heldPost = item ? fault.nextGoalPost : recordPost ? fault.nextRecordPost : null;
          if (heldPost) { if (item) fault.nextGoalPost = null; else fault.nextRecordPost = null; }
          const work = (async () => {
            let response;
            try {
              if (heldPost) { heldPost.entered.resolve(); await heldPost.release.promise; }
              response = await route.fetch({ maxRedirects: 0, timeout: 15_000 }); const body = await response.json();
              assert.equal(response.headers()['cache-control'], 'no-store', code);
              if (goalDetail) {
                assert(!JSON.stringify(body).includes(privateNote), code);
                if (response.status() === 200) {
                  if (item) {
                    assert.deepEqual(Object.keys(body), ['receipt'], code); assert.deepEqual(Object.keys(body.receipt).sort(), receiptKeys, code);
                    assert.deepEqual(Object.keys(item.body).sort(), ['clientId', 'expectedRevision', 'content'].sort(), code);
                    assert.deepEqual(Object.keys(item.body.content).sort(), ['title', 'description', 'status'].sort(), code); item.receipt = structuredClone(body.receipt);
                  } else { assert.deepEqual(Object.keys(body), ['goal'], code); assert.deepEqual(Object.keys(body.goal).sort(), goalKeys, code); goalResponses.push(body.goal); }
                } else assert([400, 401, 404, 409].includes(response.status()), code);
              }
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
      const contextSnapshot = () => snapshot(['cb_goals', 'cb_goal_revisions', 'cb_context_requests', 'cb_conversations']);
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
      const openGoal = async (who, goalId = null) => {
        await childView(who); await who.page.locator(goalId ? `[data-goal-edit="${goalId}"]` : '[data-goal-new]').click();
        await dialog(who).locator('form[data-care-form="goal"]').waitFor();
      };
      const goalValues = async (who, title, status = 'active', description = description1) => {
        await fill(who, 'title', title); await fill(who, 'description', description); await field(who, 'status').selectOption(status);
      };
      const submitGoal = async (who, label = '목표 저장', expected = 200) => {
        const [response] = await Promise.all([who.page.waitForResponse(r => new URL(r.url()).pathname.startsWith(base + '/goals/') && r.request().method() === 'POST'),
          dialog(who).getByRole('button', { name: label, exact: true }).click()]);
        assert.equal(response.status(), expected, code); const body = await response.json();
        if (expected === 200) await dialog(who).waitFor({ state: 'hidden' }); return body;
      };
      const record = async (title, goalId, value) => {
        await therapist.page.bringToFront(); await workspaceRecords(therapist.page, child.roomId);
        await therapist.page.locator('[data-care-action="new-record"]').click(); await dialog(therapist).locator('form[data-care-form="record"]').waitFor();
        await field(therapist, 'goalId').selectOption(goalId);
        for (const [name, text] of Object.entries({ title, performed: '가상 관찰 활동', response: '가상 반응', nextPlan: '가상 다음 계획', summary: '가상 보호자 공유 요약', privateNote })) await fill(therapist, name, text);
        const add = dialog(therapist).locator('[data-care-action="add-assessment"]'); await reveal(add); await add.click();
        for (const [key, text] of Object.entries({ tool: '가상 도구', item: '가상 참여', value: String(value), unit: '회', context: '가상 동일 조건' })) await fill(therapist, `assessment-0-${key}`, text);
        const [response] = await Promise.all([therapist.page.waitForResponse(r => new URL(r.url()).pathname.startsWith(base + '/records/') &&
          !new URL(r.url()).pathname.slice((base + '/records/').length).includes('/') && r.request().method() === 'POST'),
          dialog(therapist).getByRole('button', { name: '기록 저장', exact: true }).click()]);
        assert.equal(response.status(), 201, code); const receipt = (await response.json()).receipt; await dialog(therapist).waitFor({ state: 'hidden' }); return receipt;
      };
      const observeLate = who => who.page.evaluate(() => {
        window.__lateGoal = false; window.__goalObserver?.disconnect();
        window.__goalObserver = new MutationObserver(changes => { if (changes.some(change => [...change.addedNodes].some(node => node.nodeType === Node.ELEMENT_NODE &&
          (node.matches('form[data-care-form="goal"]') || node.querySelector('form[data-care-form="goal"]'))))) window.__lateGoal = true; });
        window.__goalObserver.observe(document.body, { subtree: true, childList: true });
      });
      const noLateGoal = async who => {
        await who.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await who.page.evaluate(() => window.__lateGoal), false, code); await who.page.evaluate(() => window.__goalObserver.disconnect());
      };

      phase = `${width}:FIRST_GOAL_REAL_COMMIT_LOSS`;
      await therapist.page.bringToFront(); await workspaceRecords(therapist.page, child.roomId);
      assert.equal(await therapist.page.locator('[data-care-action="new-record"]').isDisabled(), true, code);
      const beforeGoal = await snapshot(clinicalTables);
      await childView(therapist); const newButton = therapist.page.locator('[data-goal-new]'); await reachable(newButton); await newButton.focus(); await newButton.press('Enter');
      await dialog(therapist).locator('form[data-care-form="goal"]').waitFor(); await goalValues(therapist, title1);
      await field(therapist, 'title').focus(); await therapist.page.keyboard.press('Tab');
      assert.equal(await field(therapist, 'description').evaluate(node => node === document.activeElement), true, code);
      await reachable(dialog(therapist).getByRole('button', { name: '목표 저장', exact: true })); await capture(therapist, 'first-goal-editor');
      therapist.fault.loseNext = true; await dialog(therapist).getByRole('button', { name: '목표 저장', exact: true }).click();
      const retry = dialog(therapist).getByRole('button', { name: '같은 요청 다시 확인', exact: true }); await retry.waitFor();
      await therapist.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="care-dialog"] button')].some(button =>
        button.textContent === '같은 요청 다시 확인' && !button.disabled && button.getClientRects().length > 0));
      assert.equal(therapist.fault.losses, 1, code); assert.equal(mutations.length, 1, code);
      const originalRequest = structuredClone(mutations[0]), committed = await contextSnapshot();
      await capture(therapist, 'unknown-goal-preserved');
      const replay = await submitGoal(therapist, '같은 요청 다시 확인'); const goalId = replay.receipt.id;
      assert.deepEqual(mutations[1].body, originalRequest.body, code); assert.equal(mutations[1].pathname, originalRequest.pathname, code);
      assert.deepEqual(replay.receipt, { ...therapist.fault.receipt, replayed: true }, code); assert.deepEqual(await contextSnapshot(), committed, code);
      assert.equal(replay.receipt.revision, 1, code); assert.deepEqual(await snapshot(clinicalTables), beforeGoal, code);
      result.realLossRetry = result.receiptExactlyOnce = result.noAutomaticClinicalWrites = result.keyboard = result.reachability = true;
      await workspaceRecords(therapist.page, child.roomId);
      // Closing a successful dialog precedes the real workspace refresh.
      // Wait for its usable record entry, without forcing a reload or state.
      await therapist.page.locator('[data-care-action="new-record"]:not([disabled])').waitFor();
      assert.equal(await therapist.page.locator('[data-care-action="new-record"]').isEnabled(), true, code);
      result.firstGoalUnlocksRecord = true;

      phase = `${width}:FIRST_RECORD_AND_SHARED_CURRENT`;
      const first = await record(`가상 첫 목표 기록 ${width}`, goalId, 0), oldRecord = await readRecord(first.recordId);
      assert.equal(oldRecord.goalId, goalId, code); assert.equal(oldRecord.goalRevision, 1, code); assert.equal(oldRecord.goalSnapshot.title, title1, code);
      assert.equal(oldRecord.assessments[0].value, 0, code); result.newGoalRecord = true;
      await workspaceRecords(therapist.page, child.roomId); await therapist.page.locator(`[data-care-action="preview-record"][data-record-id="${first.recordId}"]`).click();
      await dialog(therapist).locator('form[data-care-form="publish"]').waitFor(); assert(!(await dialog(therapist).innerText()).includes(privateNote), code);
      await field(therapist, 'confirmed').check();
      const [publishedResponse] = await Promise.all([therapist.page.waitForResponse(r => new URL(r.url()).pathname === `${base}/records/${first.recordId}/publish` && r.request().method() === 'POST'),
        dialog(therapist).getByRole('button', { name: '확인하고 공유', exact: true }).click()]);
      assert.equal(publishedResponse.status(), 201, code); const publishedId = (await publishedResponse.json()).receipt.messageId; await dialog(therapist).waitFor({ state: 'hidden' });
      const oldPublic = await request(guardian, `/messages/${publishedId}`); assert.equal(oldPublic.status, 200, code);
      await childView(guardian); await guardian.page.getByRole('heading', { name: title1, exact: true }).waitFor();
      assert.equal(await guardian.page.locator('[data-goal-new],[data-goal-edit]').count(), 0, code);
      assert.equal(await guardian.page.locator('h3 b').count(), 0, code); assert(!(await guardian.page.locator('body').innerText()).includes(privateNote), code);
      const current = await request(guardian, `/goals/${goalId}`); assert.equal(current.status, 200, code); assert.deepEqual(Object.keys(current.body.goal).sort(), goalKeys, code);
      const rejectedWrite = { clientId: randomUUID(), expectedRevision: 1, content: { title: '권한 없는 가상 변경', description: '', status: 'active' } };
      assert.equal((await request(guardian, `/goals/${goalId}`, 'POST', rejectedWrite)).status, 404, code);
      assert.equal((await request(manager, `/goals/${goalId}`)).status, 404, code);
      assert.equal((await request(manager, `/goals/${goalId}`, 'POST', rejectedWrite)).status, 404, code);
      assert.equal((await request(therapist, `/goals/${goalId}`, 'GET', undefined, ids.conversationId)).status, 404, code);
      assert.equal((await request(guardian, `/records/${first.recordId}`)).status, 404, code);
      await capture(guardian, 'guardian-shared-goal'); result.roleAndScope = result.sharedCurrent = true;

      phase = `${width}:GOAL_EDIT_PRESERVES_RECORD_SNAPSHOT`;
      const beforeEdit = await snapshot(clinicalTables);
      await openGoal(therapist, goalId); await goalValues(therapist, title2, 'paused', '가상 수정 후 설명');
      const changed = await submitGoal(therapist); assert.equal(changed.receipt.revision, 2, code);
      assert.deepEqual(await snapshot(clinicalTables), beforeEdit, code); assert.deepEqual(await readRecord(first.recordId), oldRecord, code);
      assert.deepEqual(await request(guardian, `/messages/${publishedId}`), oldPublic, code); result.historicalSnapshot = true;
      await childView(guardian); await workspaceAccountAction(guardian.page, 'refresh');
      await guardian.page.getByRole('heading', { name: title2, exact: true }).waitFor();
      assert((await guardian.page.locator('.goal-row').filter({ hasText: title2 }).innerText()).includes('잠시 보류'), code);
      assert.equal(await guardian.page.getByRole('heading', { name: title1, exact: true }).count(), 0, code);
      await capture(guardian, 'guardian-updated-goal');
      const second = await record(`가상 바뀐 목표 기록 ${width}`, goalId, 1), newRecord = await readRecord(second.recordId);
      assert.equal(newRecord.goalRevision, 2, code); assert.equal(newRecord.goalSnapshot.title, title2, code); assert.equal(newRecord.goalSnapshot.status, 'paused', code);
      result.newRevisionRecord = true;
      await openGoal(therapist, goalId); const beforeNoOp = await contextSnapshot(), noOp = await submitGoal(therapist);
      assert.equal(noOp.receipt.changed, false, code); assert.equal(noOp.receipt.revision, 2, code);
      const afterNoOp = await contextSnapshot();
      for (const table of ['cb_goals', 'cb_goal_revisions', 'cb_conversations']) assert.deepEqual(afterNoOp[table], beforeNoOp[table], code);
      assert.equal(afterNoOp.cb_context_requests.length, beforeNoOp.cb_context_requests.length + 1, code); result.noOp = true;
      let stableClinical = await snapshot(clinicalTables);

      phase = `${width}:REAL_GOAL_CAS_CONFLICT`;
      await openGoal(peer, goalId); await goalValues(peer, peerTitle, 'achieved');
      await openGoal(therapist, goalId); await goalValues(therapist, keptTitle); const heldPost = gate(); therapist.fault.nextGoalPost = heldPost;
      try {
        const conflict = therapist.page.waitForResponse(r => new URL(r.url()).pathname === `${base}/goals/${goalId}` && r.request().method() === 'POST' && r.status() === 409); void conflict.catch(() => {});
        await dialog(therapist).getByRole('button', { name: '목표 저장', exact: true }).click(); await bounded(heldPost.entered.promise, 5000);
        await submitGoal(peer); heldPost.finish(); assert.equal((await (await conflict).json()).error, 'GOAL_CONFLICT', code); await bounded(heldPost.done.promise, 5000);
        assert.equal(await field(therapist, 'title').inputValue(), keptTitle, code);
        assert.equal(await dialog(therapist).getByRole('button', { name: '목표 저장', exact: true }).isDisabled(), true, code);
        await dialog(therapist).getByRole('button', { name: '최신 목표 확인', exact: true }).click();
        await dialog(therapist).locator('[data-goal-latest]').filter({ hasText: peerTitle }).waitFor();
        await reachable(dialog(therapist).getByRole('button', { name: '현재 입력 유지하고 다시 검토', exact: true })); await capture(therapist, 'goal-conflict-preserved');
        await dialog(therapist).getByRole('button', { name: '현재 입력 유지하고 다시 검토', exact: true }).click();
        assert.equal(await field(therapist, 'title').inputValue(), keptTitle, code); await submitGoal(therapist);
        result.actualConflict = result.conflictInputPreserved = true;
      } finally { heldPost.finish(); }

      phase = `${width}:STALE_RECORD_GOAL_VERSION`;
      // Prepare the peer edit before holding the record request. Keep the
      // real client deadline unchanged while waiting for the normal 5s poll.
      await openGoal(peer, goalId); await goalValues(peer, '가상 기록 작성 중 수정한 목표', 'active');
      await therapist.page.bringToFront();
      await workspaceRecords(therapist.page, child.roomId); await therapist.page.locator(`[data-care-action="edit-record"][data-record-id="${second.recordId}"]`).click();
      await dialog(therapist).locator('form[data-care-form="record"]').waitFor(); await fill(therapist, 'performed', '가상 보존할 오래된 목표 입력');
      const heldRecord = gate(); therapist.fault.nextRecordPost = heldRecord;
      try {
        const stale = therapist.page.waitForResponse(r => new URL(r.url()).pathname === `${base}/records/${second.recordId}` && r.request().method() === 'POST' && r.status() === 409); void stale.catch(() => {});
        await dialog(therapist).getByRole('button', { name: '기록 저장', exact: true }).click(); await bounded(heldRecord.entered.promise, 5000);
        await submitGoal(peer);
        await dialog(therapist).locator('form[data-care-form="receipt"]').waitFor({ timeout: 7500 });
        assert.equal(await field(therapist, 'performed').count(), 0, code); result.recordReceiptObserved = true;
        await capture(therapist, 'record-pending-source-hidden');
        heldRecord.finish(); assert.equal((await (await stale).json()).error, 'CONTEXT_CHANGED', code); await bounded(heldRecord.done.promise, 5000);
        await dialog(therapist).locator('form[data-care-form="record"]').waitFor();
        assert.equal(await field(therapist, 'performed').inputValue(), '가상 보존할 오래된 목표 입력', code);
        assert.deepEqual(await readRecord(second.recordId), newRecord, code); await capture(therapist, 'stale-record-preserved');
        assert.deepEqual(await snapshot(clinicalTables), stableClinical, code);
        assert.equal(await dialog(therapist).getByRole('button', { name: '기록 저장', exact: true }).isDisabled(), true, code);
        result.staleRecordRejected = true;
        phase = `${width}:EXPLICIT_RECORD_CONTEXT_RECOVERY`;
        const refreshContext = dialog(therapist).getByRole('button', { name: '목표·일정 다시 확인', exact: true });
        await reachable(refreshContext); await refreshContext.click();
        await dialog(therapist).locator('[data-record-context]').filter({ hasText: '가상 기록 작성 중 수정한 목표' }).waitFor();
        await therapist.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="care-dialog"] button')].some(button =>
          button.textContent === '기록 저장' && !button.disabled && button.getClientRects().length > 0));
        assert.equal(await field(therapist, 'performed').inputValue(), '가상 보존할 오래된 목표 입력', code);
        for (const name of ['title', 'response', 'nextPlan', 'summary', 'privateNote']) assert.equal(await field(therapist, name).inputValue(), newRecord[name], code);
        assert.equal(await field(therapist, 'assessment-0-value').inputValue(), '1', code);
        // Metadata reread must not write or silently replace the saved revision.
        assert.deepEqual(await snapshot(clinicalTables), stableClinical, code);
        assert.deepEqual(await readRecord(second.recordId), newRecord, code);
        await capture(therapist, 'record-context-rechecked');
        const [recoveredResponse] = await Promise.all([therapist.page.waitForResponse(r => new URL(r.url()).pathname === `${base}/records/${second.recordId}` && r.request().method() === 'POST'),
          dialog(therapist).getByRole('button', { name: '기록 저장', exact: true }).click()]);
        assert.equal(recoveredResponse.status(), 201, code); const recoveredReceipt = (await recoveredResponse.json()).receipt;
        assert.equal(recoveredReceipt.recordId, second.recordId, code); assert.equal(recoveredReceipt.revision, 2, code);
        await dialog(therapist).waitFor({ state: 'hidden' });
        const recoveredRecord = await readRecord(second.recordId, 2), latestGoal = (await request(therapist, `/goals/${goalId}`)).body.goal;
        assert.equal(recoveredRecord.goalRevision, latestGoal.revision, code); assert.equal(recoveredRecord.goalSnapshot.title, latestGoal.title, code);
        assert.equal(recoveredRecord.performed, '가상 보존할 오래된 목표 입력', code);
        for (const name of ['title', 'date', 'response', 'nextPlan', 'summary', 'privateNote', 'observation', 'activity', 'assessments', 'attachments', 'referenceMessageIds', 'referenceSources', 'appointmentId'])
          assert.deepEqual(recoveredRecord[name], newRecord[name], code);
        assert.deepEqual(await readRecord(second.recordId), newRecord, code); assert.deepEqual(await readRecord(first.recordId), oldRecord, code);
        stableClinical = await snapshot(clinicalTables); result.explicitRecordContextRecovery = true;
      } finally { heldRecord.finish(); }

      phase = `${width}:LATE_GOAL_OTHER_ROOM`;
      await childView(therapist); const heldRoom = gate(); therapist.fault.nextGoalGet = heldRoom;
      try {
        await therapist.page.locator(`[data-goal-edit="${goalId}"]`).click(); await bounded(heldRoom.entered.promise, 5000);
        await therapist.page.locator('#child-select').selectOption(ids.conversationId);
        await therapist.page.waitForFunction(id => document.querySelector('#child-select')?.value === id && !document.querySelector('#child-select')?.disabled, ids.conversationId);
        await observeLate(therapist); heldRoom.finish(); await bounded(heldRoom.done.promise, 5000); await noLateGoal(therapist);
        assert.equal(await dialog(therapist).isVisible(), false, code); assert.equal(await therapist.page.locator(`[data-goal-edit="${goalId}"]`).count(), 0, code); result.lateRoomDiscarded = true;
      } finally { heldRoom.finish(); }

      phase = `${width}:LATE_GOAL_ACCOUNT_SWITCH`;
      await childView(therapist); const heldAccount = gate(); therapist.fault.nextGoalGet = heldAccount;
      try {
        await therapist.page.locator(`[data-goal-edit="${goalId}"]`).click(); await bounded(heldAccount.entered.promise, 5000);
        await workspaceAccountAction(therapist.page, 'logout'); await login(therapist.page, 'guardian');
        await observeLate(therapist); heldAccount.finish(); await bounded(heldAccount.done.promise, 5000); await noLateGoal(therapist);
        assert.equal(await dialog(therapist).isVisible(), false, code); assert.equal(await therapist.page.locator('[data-goal-new],[data-goal-edit]').count(), 0, code);
        result.lateAccountDiscarded = true;
      } finally { heldAccount.finish(); }
      await workspaceAccountAction(therapist.page, 'logout'); await login(therapist.page, 'therapist');

      phase = `${width}:RELATIONSHIP_REVOKES_EDITOR`;
      await openGoal(therapist, goalId); await goalValues(therapist, revokedTitle);
      await sandbox.database.query('UPDATE cb_participants SET active=false WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3', [ids.centerId, child.roomId, ids.therapistId]);
      await dialog(therapist).waitFor({ state: 'hidden', timeout: 15_000 });
      assert.equal(await therapist.page.locator('form[data-care-form="goal"]').count(), 0, code);
      assert(!(await therapist.page.locator('body').innerText()).includes(revokedTitle), code);
      assert.equal((await request(therapist, `/goals/${goalId}`)).status, 404, code); await capture(therapist, 'revoked-goal-cleared'); result.revokedInputCleared = true;
      assert.deepEqual(await snapshot(clinicalTables), stableClinical, code);
      assert.equal(privilegedRequests.length, 0, code); assert(goalResponses.length > 0, code); result.minimalDto = true;
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
      testLine: Number(error?.stack?.match(/local-goals-browser\.mjs:(\d+):\d+/)?.[1]) || null,
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
  try { if (!await runLocalGoalsBrowser()) process.exitCode = 1; }
  catch { console.error('LOCAL_GOALS_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

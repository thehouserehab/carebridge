// Family context: visible UI -> authenticated loopback HTTP -> owned memory PGlite.
// SQL creates only synthetic users/relationships and revokes one relationship.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceView, workspaceAccountAction } from './local-workspace-browser-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const code = 'LOCAL_FAMILY_PLAN_FAILED';
const hash = value => createHash('sha256').update(value).digest('hex');
const planKeys = ['conversationId', 'childId', 'revision', 'concern'].sort();
const receiptKeys = ['operation', 'childId', 'conversationId', 'appliedVersion', 'changed', 'replayed'].sort();
const assets = new Set(['/', '/favicon.ico', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/client.js', '/local-api/care-client.js',
  '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css', '/local-api/media-client.js',
  '/local-api/media-ui.js', '/local-api/media-viewer.js', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js']);
const clinicalTables = ['cb_messages', 'cb_read_states', 'cb_message_reviews', 'cb_publications', 'cb_records',
  'cb_record_revisions', 'cb_record_requests', 'cb_activity_feedback', 'cb_feedback_revisions', 'cb_feedback_reviews',
  'cb_feedback_requests', 'cb_goals', 'cb_goal_revisions', 'cb_appointments', 'cb_appointment_revisions', 'cb_audit_events'];
async function sources() {
  const names = ['tests/local-family-plan-browser.mjs', 'tests/local-workspace-browser-helpers.mjs',
    'tests/message-browser-policy.mjs', 'scripts/p0-study-policy.mjs'];
  for (const directory of ['local-api', 'src', 'server', 'server/migrations']) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      if (entry.isDirectory() || !/\.(?:mjs|js|css|html|sql)$/.test(entry.name)) continue;
      assert(entry.isFile() && !entry.isSymbolicLink(), code); names.push(`${directory}/${entry.name}`);
    }
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
    await button.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }), undefined, { timeout: Math.max(1, deadline - Date.now()) });
    await button.click({ trial: true, timeout: Math.max(1, deadline - Date.now()) });
    observation = await button.evaluate(element => {
      const r = element.getBoundingClientRect(), nav = document.querySelector('.main-nav');
      const n = nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect() : null;
      const x = Math.min(12, r.width / 4), y = Math.min(12, r.height / 4);
      const bounds = value => value ? Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map(key => [key, value[key]])) : null;
      const withinViewport = r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      const outsideFixedNav = !n || r.bottom <= n.top || r.top >= n.bottom || r.right <= n.left || r.left >= n.right;
      const hits = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + x, r.top + y], [r.right - x, r.top + y],
        [r.left + x, r.bottom - y], [r.right - x, r.bottom - y]].map(([px, py]) => element.contains(document.elementFromPoint(px, py)));
      return { bounds: bounds(r), viewport: { width: innerWidth, height: innerHeight }, fixedNav: bounds(n),
        connected: element.isConnected, withinViewport, outsideFixedNav, hits, passed: withinViewport && outsideFixedNav && hits.every(Boolean) };
    }, undefined, { timeout: Math.max(1, deadline - Date.now()) });
    if (observation.passed) return;
    if (observation.connected) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
  }
  const error = new Error(code); error.name = 'AssertionError'; error.reachability = observation; throw error;
}
async function fixture(sandbox) {
  const suffix = randomUUID(), ids = sandbox.ids;
  const extra = { childId: `family-child-${suffix}`, conversationId: `family-room-${suffix}`,
    peerId: `family-guardian-${suffix}`, centerUserId: `family-center-${suffix}` };
  await sandbox.database.transaction(async tx => {
    await tx.query('INSERT INTO cb_users(id,active) VALUES ($1,true),($2,true)', [extra.peerId, extra.centerUserId]);
    await tx.query(`INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES ($1,$2,'guardian',true),($1,$3,'center',true)`,
      [ids.centerId, extra.peerId, extra.centerUserId]);
    await tx.query(`INSERT INTO cb_member_profiles(center_id,user_id,display_name,revision)
      VALUES ($1,$2,'가상 다른 보호자',1),($1,$3,'가상 센터 운영자',1)`, [ids.centerId, extra.peerId, extra.centerUserId]);
    await tx.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
      VALUES ($1,$2,$3,'guardian',true,1)`, [ids.centerId, ids.conversationId, extra.peerId]);
    await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)', [ids.centerId, extra.childId]);
    await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)', [ids.centerId, extra.conversationId, extra.childId]);
    await tx.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
      VALUES ($1,$2,$3,'therapist',true,1),($1,$2,$4,'guardian',true,1),($1,$2,$5,'guardian',true,1)`,
    [ids.centerId, extra.conversationId, ids.therapistId, ids.guardianId, extra.peerId]);
    await tx.query(`INSERT INTO cb_child_profiles(center_id,child_id,name,age,age_as_of,revision,updated_by)
      VALUES ($1,$2,'가상 다른 가족 아동',NULL,NULL,1,$3)`, [ids.centerId, extra.childId, ids.therapistId]);
  });
  const { Auth } = await import('../server/auth.mjs');
  for (const [role, userId] of [['peer', extra.peerId], ['center', extra.centerUserId]]) {
    const credential = { role, email: `${role}.${suffix}@carebridge.test`, password: randomBytes(24).toString('base64url') };
    sandbox.credentials.push(credential);
    await new Auth(sandbox.database).provisionAccount({ userId, email: credential.email, password: credential.password });
  }
  return extra;
}

export async function runLocalFamilyPlanBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const filename of [options.module, options.executable]) {
    const info = await lstat(filename); assert(info.isFile() && !info.isSymbolicLink(), code);
  }
  const source = await sources(), { chromium } = await import(pathToFileURL(options.module).href);
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-family-plan-${runId}`); await mkdir(folder);
  const report = { runId, startedAt: new Date().toISOString(), source, passed: false, checks: [], screenshots: [], errors: [], unexpectedRequests: [],
    failure: null, cleanupObservationTimedOut: false, cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Synthetic identities, owned Chromium and memory-only PGlite; no E/native storage, actual child information, mail, external listener or deployment.',
      '390/768/1440 viewports do not establish physical-device or human usability results.',
      'Family text is saved only through visible UI. SQL is limited to invented accounts/relationships and revoking one relationship; default Auth provisions fixture credentials.',
      'Faults delay real requests/responses or discard one committed response; no success, permission, version or API data is fabricated.',
      'Role-changing a current membership is covered outside this browser test. This test uses real guardian/therapist/center sessions, account switching and relationship revocation.',
      'DOM/storage disposal is not a guarantee of secure memory zeroization or production retention policy.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, finished: false };
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  const note = (list, value) => { if (list.length < 32) list.push(value); };
  const contexts = new Set(), sandboxes = new Set(), pages = new Map(), releases = new Set(), routeWork = new Set();
  let browserServer, browser, browserLife, phase = 'STARTUP'; await save('ownership.json', ownership);
  try {
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    browserLife = lifetime(browserServer.process()); ownership.browserProcessId = browserServer.process().pid;
    await save('ownership.json', ownership); browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    for (const width of [390, 768, 1440]) {
      phase = `${width}:SANDBOX`; const sandbox = await createLocalApiSandbox({ port: 0 }); sandboxes.add(sandbox);
      const extra = await fixture(sandbox), { origin, ids } = sandbox, originUrl = new URL(origin);
      assert(originUrl.origin === origin && originUrl.hostname === '127.0.0.1' && originUrl.protocol === 'http:' && originUrl.port && !originUrl.username && !originUrl.password, code);
      const base = `/api/local/centers/${ids.centerId}/conversations/${ids.conversationId}`, endpoint = base + '/family-plan';
      const firstText = `가상 가족이 바라는 변화 ${width}`, peerText = `가상 다른 보호자가 정한 변화 ${width}`,
        conflictText = `가상 충돌 시 보존할 입력 ${width}`, currentText = `가상 현재 가족의 변화 ${width}`, revokedText = `가상 관계 종료 입력 ${width}`;
      const sensitive = [firstText, peerText, conflictText, currentText, revokedText];
      const operations = [], unexpectedWrites = [], familyGets = [];
      const result = { width, freshEditor: false, savedCurrentContext: false, responseLossRetry: false, noDuplicateWrite: false,
        sharedRoles: false, actualVersionConflict: false, conflictedInputPreserved: false, explicitClear: false, noOp: false,
        lateRoomResponseDiscarded: false, lateAccountResponseDiscarded: false, revokedInputCleared: false,
        roleAuthority: false, noImplicitClinicalWriteOrRead: false, browserStorageEmpty: false,
        keyboard: false, reachability: false, layout: false, cleanup: false };
      report.currentCheck = result;
      const credential = label => sandbox.credentials.find(item => item.role === label);
      const userId = label => ({ guardian: ids.guardianId, therapist: ids.therapistId, peer: extra.peerId, center: extra.centerUserId })[label];
      const login = async (page, label) => {
        const account = credential(label); assert(account.email.endsWith('.test'), code);
        await page.getByTestId('login-form').waitFor();
        await page.getByLabel('시험 이메일', { exact: true }).fill(account.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(account.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click(); await page.getByTestId('home').waitFor();
      };
      const actor = async label => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR',
          isMobile: width <= 640, hasTouch: width <= 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context); context.once('close', () => contexts.delete(context)); assert.equal((await context.cookies()).length, 0, code);
        const fault = { loseNext: false, nextGet: null, nextPost: null, lost: 0, receipt: null };
        await context.route('**/*', async route => {
          const request = route.request(), target = new URL(request.url()), method = request.method(), entryPhase = phase;
          const primaryRead = method === 'GET' && target.pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
            [...target.searchParams].length === 1 && [ids.conversationId, extra.conversationId].includes(target.searchParams.get('conversationId'));
          const api = /^\/api\/local\/(?:auth\/(?:login|session|logout)|centers\/[A-Za-z0-9_-]+\/(?:inbox|conversations\/[A-Za-z0-9_-]+\/(?:family-plan|profile|read|goals|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+)?|records(?:\/[A-Za-z0-9_-]+)?)))$/.test(target.pathname);
          if (target.origin !== origin || !['GET', 'POST', 'HEAD'].includes(method) || !((assets.has(target.pathname) && ['GET', 'HEAD'].includes(method)) || api || primaryRead)) {
            note(report.unexpectedRequests, { width, label, phase: entryPhase, sameOrigin: target.origin === origin,
              method: ['GET', 'POST', 'HEAD'].includes(method) ? method : 'OTHER' }); return route.abort().catch(() => {});
          }
          const family = target.pathname.endsWith('/family-plan');
          if (method === 'POST' && !target.pathname.startsWith('/api/local/auth/') && !family) unexpectedWrites.push({ label, phase: entryPhase });
          const operation = family && method === 'POST' ? { label, body: structuredClone(request.postDataJSON()) } : null;
          if (operation) operations.push(operation);
          if (!family) return route.continue().catch(() => {});
          const lost = method === 'POST' && fault.loseNext; if (lost) fault.loseNext = false;
          const heldGet = method === 'GET' ? fault.nextGet : null; if (heldGet) fault.nextGet = null;
          const heldPost = method === 'POST' ? fault.nextPost : null; if (heldPost) fault.nextPost = null;
          const work = (async () => {
            let response;
            try {
              if (heldPost) { heldPost.entered.resolve(); await heldPost.release.promise; }
              response = await route.fetch({ maxRedirects: 0, timeout: 15_000 }); const body = await response.json();
              if (response.status() === 200) {
                if (method === 'GET') {
                  assert.deepEqual(Object.keys(body), ['familyPlan'], code); assert.deepEqual(Object.keys(body.familyPlan).sort(), planKeys, code);
                  familyGets.push({ label, plan: structuredClone(body.familyPlan) });
                } else {
                  assert.deepEqual(Object.keys(body), ['receipt'], code); assert.deepEqual(Object.keys(body.receipt).sort(), receiptKeys, code);
                  operation.receipt = structuredClone(body.receipt);
                }
              } else {
                assert([401, 404, 409].includes(response.status()), code);
                assert(!sensitive.some(value => JSON.stringify(body).includes(value)), code);
              }
              if (operation) operation.status = response.status();
              if (lost) {
                assert.equal(response.status(), 200, code); fault.lost++; fault.receipt = structuredClone(body.receipt);
                await route.abort('failed').catch(() => {}); return;
              }
              if (heldGet) { heldGet.entered.resolve(); await heldGet.release.promise; }
              // A real validated response can be cancelled by account/room navigation.
              await route.fulfill({ response }).catch(() => {});
            } catch { note(report.errors, { width, label, phase: entryPhase, type: 'response-contract' }); await route.abort().catch(() => {}); }
            finally { await response?.dispose().catch(() => {}); heldGet?.done.resolve(); heldPost?.done.resolve(); }
          })();
          routeWork.add(work); try { await work; } finally { routeWork.delete(work); }
        });
        if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => {
          note(report.unexpectedRequests, { width, label, phase, type: 'websocket' }); socket.close();
        });
        const page = await context.newPage(); page.setDefaultTimeout(15_000); pages.set(label, page);
        page.on('pageerror', () => note(report.errors, { width, label, phase, type: 'pageerror' }));
        page.on('console', entry => { if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:')) note(report.errors, { width, label, phase, type: 'console' }); });
        await page.goto(origin); await login(page, label); return { page, context, label, userId: userId(label), fault };
      };
      const guardian = await actor('guardian'), peer = await actor('peer'), therapist = await actor('therapist'), center = await actor('center');
      const actors = [guardian, peer, therapist, center], dialog = who => who.page.getByTestId('care-dialog');
      const child = async (who, conversationId = ids.conversationId) => {
        await workspaceView(who.page, 'child'); await who.page.locator('#child-select:not([disabled])').waitFor();
        if (await who.page.locator('#child-select').inputValue() !== conversationId) await who.page.locator('#child-select').selectOption(conversationId);
        await who.page.waitForFunction(id => document.querySelector('#child-select')?.value === id && !document.querySelector('#child-select')?.disabled, conversationId);
        await who.page.locator('[data-family-plan-concern]').waitFor();
      };
      const refresh = async who => { await workspaceAccountAction(who.page, 'refresh'); };
      const open = async (who, { wait = true, keyboard = false } = {}) => {
        const button = who.page.locator('[data-family-plan]'); await reachable(button);
        if (keyboard) { await button.focus(); await button.press('Enter'); } else await button.click();
        if (wait) await dialog(who).locator('form[data-care-form="family-plan"]').waitFor();
      };
      const submit = async (who, label = '가족 관심사 저장', status = 200) => {
        const [response] = await Promise.all([who.page.waitForResponse(response => new URL(response.url()).pathname === endpoint &&
          response.request().method() === 'POST' && response.status() === status), dialog(who).getByRole('button', { name: label, exact: true }).click()]);
        const body = await response.json(); if (status === 200) await dialog(who).waitFor({ state: 'hidden' }); return body;
      };
      const discard = async who => { await dialog(who).getByRole('button', { name: '입력 취소', exact: true }).click(); await dialog(who).waitFor({ state: 'hidden' }); };
      const request = async (who, method = 'GET', data) => {
        const response = await who.context.request.fetch(origin + endpoint, { method, maxRedirects: 0, timeout: 15_000,
          headers: { 'X-Carebridge-Account': who.userId, ...(method === 'POST' ? { Origin: origin, 'X-Carebridge-Request': '1', 'Content-Type': 'application/json' } : {}) },
          ...(data ? { data } : {}) });
        try { return { status: response.status(), body: await response.json() }; } finally { await response.dispose(); }
      };
      const plan = async who => { const value = await request(who); assert.equal(value.status, 200, code); assert.deepEqual(Object.keys(value.body.familyPlan).sort(), planKeys, code); return value.body.familyPlan; };
      const savedSnapshot = async () => ({
        plan: (await sandbox.database.query('SELECT * FROM cb_child_family_plans WHERE center_id=$1 AND child_id=$2', [ids.centerId, ids.childId])).rows,
        receipts: (await sandbox.database.query("SELECT * FROM cb_profile_requests WHERE center_id=$1 AND child_id=$2 AND operation='child.concern' ORDER BY actor_id,client_id", [ids.centerId, ids.childId])).rows,
        conversation: (await sandbox.database.query('SELECT last_sequence,revision FROM cb_conversations WHERE center_id=$1 AND id=$2', [ids.centerId, ids.conversationId])).rows,
      });
      const clinicalSnapshot = async () => {
        const rows = {};
        for (const table of clinicalTables) rows[table] = (await sandbox.database.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE center_id=$1 ORDER BY to_jsonb(t)::text`, [ids.centerId])).rows;
        return rows;
      };
      const displayed = async (who, value) => {
        await who.page.waitForFunction(text => document.querySelector('[data-family-plan-concern]')?.textContent === text, value);
      };
      const noInput = async who => {
        assert.equal(await dialog(who).isVisible(), false, code);
        const values = await who.page.locator('input,textarea').evaluateAll(elements => elements.map(element => element.value));
        assert(values.every(value => sensitive.every(secret => !value.includes(secret))), code);
      };
      const watchLateDialog = who => who.page.evaluate(() => {
        window.__familyLateDialog = false; window.__familyObserver?.disconnect();
        const includesForm = node => node.nodeType === Node.ELEMENT_NODE &&
          (node.matches('form[data-care-form="family-plan"]') || !!node.querySelector('form[data-care-form="family-plan"]'));
        window.__familyObserver = new MutationObserver(changes => {
          if (changes.some(change => [...change.addedNodes].some(includesForm))) window.__familyLateDialog = true;
        });
        window.__familyObserver.observe(document.body, { subtree: true, childList: true });
      });
      const assertNoLateDialog = async who => {
        await who.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await who.page.evaluate(() => window.__familyLateDialog), false, code);
        await who.page.evaluate(() => window.__familyObserver.disconnect());
      };
      const capture = async (who, label) => {
        assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code);
        if (await dialog(who).isVisible()) assert.equal(await dialog(who).evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, code);
        const filename = `${width}-${label}.png`; await who.page.screenshot({ path: path.join(folder, filename), fullPage: false,
          mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]'), who.page.locator('.workspace-head .account')] });
        report.screenshots.push({ filename, width, syntheticOnly: true });
      };
      const gate = () => {
        const result = { entered: Promise.withResolvers(), release: Promise.withResolvers(), done: Promise.withResolvers() };
        const release = () => result.release.resolve(); releases.add(release); return { ...result, finish: () => { release(); releases.delete(release); } };
      };
      const baseline = await clinicalSnapshot(); result.clinicalBaselineSha256 = hash(JSON.stringify(baseline));

      phase = `${width}:FRESH_GUARDIAN_EDITOR`; await guardian.page.bringToFront(); await child(guardian);
      await open(guardian, { keyboard: true });
      assert.equal(await dialog(guardian).getByRole('heading').textContent(), '가족이 바라는 변화', code);
      const initial = familyGets.at(-1).plan;
      assert.deepEqual(initial, { conversationId: ids.conversationId, childId: ids.childId, revision: 0, concern: '' }, code);
      assert.equal(await dialog(guardian).locator('[name="concern"]').inputValue(), '', code);
      assert.equal(await dialog(guardian).locator('[name="concern"]').getAttribute('maxlength'), '1000', code);
      await dialog(guardian).locator('[data-family-plan-version]').waitFor();
      await dialog(guardian).locator('[name="concern"]').fill(firstText); await dialog(guardian).locator('[name="concern"]').press('Tab');
      const saveButton = dialog(guardian).getByRole('button', { name: '가족 관심사 저장', exact: true });
      assert.equal(await saveButton.evaluate(element => element === document.activeElement), true, code); await reachable(saveButton);
      await capture(guardian, 'guardian-editor'); result.freshEditor = result.keyboard = result.reachability = true;

      phase = `${width}:REAL_COMMIT_LOSS_RETRY`; guardian.fault.loseNext = true; await saveButton.click();
      await dialog(guardian).getByRole('button', { name: '같은 요청 다시 확인', exact: true }).waitFor();
      assert.equal(guardian.fault.lost, 1, code); assert.equal(operations.length, 1, code);
      const firstOperation = structuredClone(operations[0].body), afterCommit = await savedSnapshot();
      assert.deepEqual(Object.keys(firstOperation).sort(), ['clientId', 'expectedRevision', 'concern'].sort(), code);
      assert.equal(firstOperation.expectedRevision, 0, code); assert.equal(firstOperation.concern, firstText, code);
      assert.equal(afterCommit.plan[0].revision, 1, code); assert.equal(afterCommit.receipts.length, 1, code);
      await capture(guardian, 'unknown-same-request');
      const retried = await submit(guardian, '같은 요청 다시 확인');
      assert.deepEqual(operations[1].body, firstOperation, code); assert.equal(operations.length, 2, code);
      assert.deepEqual(retried.receipt, { ...guardian.fault.receipt, replayed: true }, code);
      assert.deepEqual(await savedSnapshot(), afterCommit, code); result.responseLossRetry = result.noDuplicateWrite = true;
      await displayed(guardian, firstText); result.savedCurrentContext = true;

      phase = `${width}:SHARED_CURRENT_ROLES`;
      for (const who of [peer, therapist]) { await who.page.bringToFront(); await refresh(who); await child(who); await displayed(who, firstText); assert.deepEqual(await plan(who), await plan(guardian), code); }
      assert.equal(await therapist.page.locator('[data-family-plan]').count(), 0, code);
      await capture(therapist, 'therapist-read-only'); result.sharedRoles = true;
      for (const who of [therapist, center]) {
        const denied = await request(who, 'POST', { clientId: randomUUID(), expectedRevision: 1, concern: '가상 권한 시험' });
        assert.equal(denied.status, 404, code); assert(!sensitive.some(value => JSON.stringify(denied.body).includes(value)), code);
      }
      assert.equal((await request(center)).status, 404, code); result.roleAuthority = true;

      phase = `${width}:ACTUAL_CONCURRENT_VERSION_CONFLICT`;
      await child(peer); await open(peer); await dialog(peer).locator('[name="concern"]').fill(peerText);
      await guardian.page.bringToFront(); await child(guardian); await open(guardian); await dialog(guardian).locator('[name="concern"]').fill(conflictText);
      const heldPost = gate(); guardian.fault.nextPost = heldPost;
      try {
        const conflict = guardian.page.waitForResponse(response => new URL(response.url()).pathname === endpoint && response.request().method() === 'POST' && response.status() === 409);
        void conflict.catch(() => {});
        await dialog(guardian).getByRole('button', { name: '가족 관심사 저장', exact: true }).click(); await bounded(heldPost.entered.promise, 5000);
        const changed = await submit(peer); assert.equal(changed.receipt.appliedVersion, 2, code); assert.equal(changed.receipt.changed, true, code);
        heldPost.finish(); const rejected = await conflict; assert.equal((await rejected.json()).error, 'PROFILE_CONFLICT', code);
        await bounded(heldPost.done.promise, 5000);
        assert.equal(await dialog(guardian).locator('[name="concern"]').inputValue(), conflictText, code);
        assert.equal((await plan(guardian)).concern, peerText, code); assert.equal((await plan(guardian)).revision, 2, code);
        await capture(guardian, 'conflict-preserved'); result.actualVersionConflict = result.conflictedInputPreserved = true;
      } finally { heldPost.finish(); }
      await discard(guardian);

      phase = `${width}:CLEAR_AND_NO_OP`; await open(guardian); await dialog(guardian).locator('[name="concern"]').fill('');
      const cleared = await submit(guardian); assert.equal(cleared.receipt.appliedVersion, 3, code); assert.equal(cleared.receipt.changed, true, code);
      assert.equal((await plan(guardian)).concern, '', code); result.explicitClear = true;
      const beforeNoOp = await savedSnapshot(); await open(guardian); const same = await submit(guardian);
      assert.equal(same.receipt.appliedVersion, 3, code); assert.equal(same.receipt.changed, false, code); assert.equal(same.receipt.replayed, false, code);
      const afterNoOp = await savedSnapshot(); assert.deepEqual(afterNoOp.plan, beforeNoOp.plan, code); assert.deepEqual(afterNoOp.conversation, beforeNoOp.conversation, code);
      assert.equal(afterNoOp.receipts.length, beforeNoOp.receipts.length + 1, code); result.noOp = true;
      await peer.page.bringToFront(); await refresh(peer); await child(peer); await open(peer); await dialog(peer).locator('[name="concern"]').fill(currentText);
      const latest = await submit(peer); assert.equal(latest.receipt.appliedVersion, 4, code);

      phase = `${width}:LATE_GET_ROOM_CHANGE`; await guardian.page.bringToFront(); await refresh(guardian); await child(guardian);
      const heldGet = gate(); guardian.fault.nextGet = heldGet;
      try {
        await open(guardian, { wait: false }); await bounded(heldGet.entered.promise, 5000); await child(guardian, extra.conversationId);
        await watchLateDialog(guardian);
        heldGet.finish(); await bounded(heldGet.done.promise, 5000);
        await assertNoLateDialog(guardian);
        await noInput(guardian); assert(!(await guardian.page.locator('[data-family-plan-concern]').textContent()).includes(currentText), code);
        await capture(guardian, 'late-room-response-discarded'); result.lateRoomResponseDiscarded = true;
      } finally { heldGet.finish(); }

      phase = `${width}:LATE_GET_ACCOUNT_SWITCH`; await child(guardian);
      const heldAccount = gate(); guardian.fault.nextGet = heldAccount; let otherPage;
      try {
        await open(guardian, { wait: false }); await bounded(heldAccount.entered.promise, 5000);
        otherPage = await guardian.context.newPage(); otherPage.setDefaultTimeout(15_000);
        await otherPage.goto(origin); await workspaceAccountAction(otherPage, 'logout');
        await login(otherPage, 'peer'); await guardian.page.bringToFront();
        await guardian.page.getByTestId('login-form').waitFor(); await watchLateDialog(guardian);
        heldAccount.finish(); await bounded(heldAccount.done.promise, 5000); await assertNoLateDialog(guardian); await noInput(guardian);
        assert(!(await guardian.page.locator('body').innerText()).includes(currentText), code);
        await capture(guardian, 'late-account-response-discarded'); result.lateAccountResponseDiscarded = true;
      } finally { heldAccount.finish(); await otherPage?.close(); }
      await login(guardian.page, 'guardian');

      phase = `${width}:RELATIONSHIP_REVOKED_INPUT_CLEAR`; await child(guardian); await open(guardian);
      await dialog(guardian).locator('[name="concern"]').fill(revokedText);
      await sandbox.database.transaction(async tx => {
        await tx.query('SELECT id FROM cb_conversations WHERE center_id=$1 AND id=$2 FOR UPDATE', [ids.centerId, ids.conversationId]);
        await tx.query('UPDATE cb_participants SET active=false WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3', [ids.centerId, ids.conversationId, ids.guardianId]);
      });
      await dialog(guardian).waitFor({ state: 'hidden' }); await noInput(guardian);
      await child(guardian, extra.conversationId); await noInput(guardian);
      assert.equal((await request(guardian)).status, 404, code);
      assert.equal((await plan(peer)).concern, currentText, code); assert.equal((await plan(peer)).revision, 4, code);
      await capture(guardian, 'revoked-input-cleared'); result.revokedInputCleared = true;

      phase = `${width}:NO_IMPLICIT_CLINICAL_MUTATION`;
      assert.equal(unexpectedWrites.length, 0, code); assert.deepEqual(await clinicalSnapshot(), baseline, code);
      result.noImplicitClinicalWriteOrRead = true;
      for (const who of actors) assert.deepEqual(await who.page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, ''], code);
      result.browserStorageEmpty = result.layout = true;
      assert.equal(report.errors.length, 0, code); assert.equal(report.unexpectedRequests.length, 0, code);
      for (const who of actors) await who.context.close(); pages.clear();
      await sandbox.close(); assert.equal(sandbox.database.closed, true, code); assert.equal(sandbox.credentials.length, 0, code); sandboxes.delete(sandbox);
      result.cleanup = true; report.checks.push(result); delete report.currentCheck;
      console.log(JSON.stringify({ width, passed: true, boundaries: 18 }));
    }
    report.finalSource = await sources(); assert.equal(report.finalSource.sha256, source.sha256, code);
  } catch (error) {
    report.failure = { code, phase, kind: ['AssertionError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-family-plan-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      workspaceHelperLine: Number(error?.stack?.match(/local-workspace-browser-helpers\.mjs:(\d+):\d+/)?.[1]) || null };
    if (error?.reachability) report.failure.reachability = error.reachability;
    for (const [label, page] of [...pages].slice(0, 2)) try {
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
      await bounded(sandbox.close()); assert.equal(sandbox.database.closed, true, code); sandboxes.delete(sandbox);
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
  try { if (!await runLocalFamilyPlanBrowser()) process.exitCode = 1; }
  catch { console.error('LOCAL_FAMILY_PLAN_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

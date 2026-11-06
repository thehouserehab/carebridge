// Center enrollment -> separate explicit relationships -> real reader history.
// Owned Chromium and fresh memory PGlite only. All enrollment, relationships,
// messages, goals and records are written through the UI, never fixture SQL.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceView, workspaceRoom, workspaceRecords, workspaceAccountAction } from './local-workspace-browser-helpers.mjs';
import { enrollmentCheckpoint } from './enrollment-checkpoint.mjs';
import { createEnrollmentProgressWriter } from './enrollment-progress-writer.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), code = 'LOCAL_ENROLLMENT_FAILED';
const hash = value => createHash('sha256').update(value).digest('hex');
const profileKeys = ['conversationId', 'childId', 'name', 'age', 'ageAsOf', 'revision'].sort();
const registerReceiptKeys = ['operation', 'childId', 'conversationId', 'appliedVersion', 'changed', 'replayed'].sort();
const relationshipKeys = ['conversationId', 'childId', 'version', 'participants'].sort();
const relationReceiptKeys = ['conversationId', 'appliedVersion', 'changed', 'replayed'].sort();
const assets = new Set(['/', '/favicon.ico', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/client.js', '/local-api/care-client.js',
  '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css', '/local-api/goal-client.js',
  '/local-api/appointment-client.js', '/local-api/media-client.js', '/local-api/media-ui.js', '/local-api/media-viewer.js',
  '/local-api/operations-client.js', '/local-api/operations-ui.js', '/local-api/operations-recipient.js', '/local-api/operations-onboarding.js', '/local-api/operations-schedule.js',
  '/src/context-fields.js', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js', '/src/profile-fields.js']);
const clinicalTables = ['cb_messages', 'cb_records', 'cb_record_revisions', 'cb_record_requests', 'cb_record_assessments',
  'cb_publications', 'cb_activity_feedback', 'cb_feedback_revisions', 'cb_feedback_reviews', 'cb_feedback_requests',
  'cb_child_family_plans', 'cb_goals', 'cb_goal_revisions', 'cb_appointments', 'cb_appointment_revisions', 'cb_audit_events'];

async function sources() {
  const names = ['tests/local-enrollment-browser.mjs', 'tests/enrollment-checkpoint.mjs', 'tests/enrollment-progress-writer.mjs', 'tests/local-workspace-browser-helpers.mjs',
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
    await button.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest' }), undefined, { timeout: timeout() });
    await button.click({ trial: true, timeout: timeout() });
    observation = await button.evaluate(node => {
      const r = node.getBoundingClientRect(), nav = document.querySelector('.main-nav');
      const n = nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect() : null;
      const x = Math.min(6, r.width / 4), y = Math.min(6, r.height / 4), modal = !!node.closest('dialog')?.open;
      const viewport = r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      const outsideNav = modal || !n || r.bottom <= n.top || r.top >= n.bottom || r.right <= n.left || r.left >= n.right;
      const hits = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + x, r.top + y], [r.right - x, r.top + y],
        [r.left + x, r.bottom - y], [r.right - x, r.bottom - y]].map(([px, py]) => node.contains(document.elementFromPoint(px, py)));
      const rect = v => v ? Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map(k => [k, v[k]])) : null;
      return { connected: node.isConnected, bounds: rect(r), viewport: { width: innerWidth, height: innerHeight }, fixedNav: rect(n),
        withinViewport: viewport, outsideNav, hits, passed: viewport && outsideNav && hits.every(Boolean) };
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

export async function runLocalEnrollmentBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const name of [options.module, options.executable]) { const stat = await lstat(name); assert(stat.isFile() && !stat.isSymbolicLink(), code); }
  const source = await sources(), { chromium } = await import(pathToFileURL(options.module).href);
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-enrollment-${runId}`); await mkdir(folder);
  const report = { runId, startedAt: new Date().toISOString(), source, passed: false, checks: [], screenshots: [], errors: [], unexpectedRequests: [],
    failure: null, cleanupObservationTimedOut: false, cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Owned Chromium and fresh memory-only PGlite with synthetic existing accounts. No mail, E/native, real children, public listener or existing browser.',
      'All successful enrollment, relationship and clinical writes use UI. Only the final synthetic manager membership revocation uses fixture SQL.',
      'Real successful responses are discarded and real requests held to prove retry, CAS and late-response boundaries; no result or authority is fabricated.',
      'Read-only authenticated requests and DB snapshots supplement UI evidence. No raw credentials, clinical body or request payload is serialized to the report.',
      'Viewport checks are not physical-device or human usability evidence; no-browser-storage and removed input are not secure RAM erasure claims.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, sourceSha256: source.sha256, sandboxes: [], finished: false };
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  const note = (list, value) => { if (list.length < 32) list.push(value); };
  const contexts = new Set(), sandboxes = new Set(), ownedSandboxes = new Map(), pages = new Map(), releases = new Set(), routeWork = new Set();
  let browserServer, browser, browserLife, phase = 'STARTUP'; await save('ownership.json', ownership);
  const observedAt = performance.now();
  const progressWriter = createEnrollmentProgressWriter(checkpoint => save('progress.json', checkpoint));
  const advance = async (next = phase, step = null) => {
    phase = next;
    // Last observation only. Fixed phase labels and numeric Node counters;
    // no request, user, environment, process dump, token or clinical content.
    await progressWriter.write(enrollmentCheckpoint({ runId, sourceSha256: source.sha256, phase, step,
      elapsedMs: Math.floor(performance.now() - observedAt), memory: process.memoryUsage(),
      counts: { contexts: contexts.size, sandboxes: sandboxes.size, routeWork: routeWork.size,
        retainedSandboxHandles: ownedSandboxes.size } }));
  };
  try {
    await advance();
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable, host: '127.0.0.1', port: 0,
      env: studyChildEnvironment(), timeout: 30_000 });
    browserLife = lifetime(browserServer.process()); ownership.browserProcessId = browserServer.process().pid;
    await save('ownership.json', ownership); browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    for (const width of [390, 768, 1440]) {
      await advance(`${width}:SANDBOX`); const sandbox = await createLocalApiSandbox({ port: 0 }); sandboxes.add(sandbox);
      const owned = { width, mediaDirectoryName: path.basename(sandbox.mediaRoot), closed: false };
      ownedSandboxes.set(sandbox, owned); ownership.sandboxes.push(owned); await save('ownership.json', ownership);
      const { ids, origin } = sandbox, originUrl = new URL(origin), ops = `/api/local/centers/${ids.centerId}/operations`;
      assert(originUrl.origin === origin && originUrl.protocol === 'http:' && originUrl.hostname === '127.0.0.1' && originUrl.port && !originUrl.username && !originUrl.password, code);
      const childName = `가상 <b>신규 연결 아동 ${width}</b>`, privateNote = `가상 임상 비공개 계획 ${width}`;
      const firstText = `가상 연결 전 소식 ${width}`, pendingText = `가상 관계 저장 직전 소식 ${width}`, futureText = `가상 연결 뒤 소식 ${width}`;
      const removedText = `가상 해제 중 소식 ${width}`, rejoinedText = `가상 재연결 뒤 소식 ${width}`, unsentText = `가상 폐기할 미전송 입력 ${width}`;
      const recordTitle = `가상 보존할 이전 기록 ${width}`, operations = [], clinicalRequests = [], clinicalSecrets = [privateNote, firstText, pendingText, recordTitle];
      const result = { width, separateEnrollment: false, registrationRetry: false, oneRegistration: false, minimalDto: false,
        existingMembersOnly: false, explicitDefaults: false, commitTimeBoundary: false, guardianHistory: false, quoteRedacted: false,
        disconnectRevokes: false, reconnectFromNow: false, allRequiresConfirmation: false, readCursorScope: false,
        therapistRecordHistory: false, oldReceiptNoResurrection: false, actualConflict: false, inputPreserved: false,
        lateRoomDiscarded: false, lateAccountDiscarded: false, managerRevoked: false, noAutomaticClinicalWrites: false,
        noAccountsCreated: false, keyboard: false, reachability: false, layout: false, browserStorageEmpty: false, cleanup: false };
      report.currentCheck = result;
      let childId, roomId;
      const base = () => `/api/local/centers/${ids.centerId}/conversations/${roomId}`;
      const isManager = label => label === 'center' || label === 'peer';
      const userId = label => isManager(label) ? ids.managerId : ids[`${label}Id`];
      const login = async (page, label) => {
        const credential = sandbox.credentials.find(item => item.role === (isManager(label) ? 'center' : label)); assert(credential?.email.endsWith('.test'), code);
        await page.getByTestId('login-form').waitFor(); await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password); await page.getByRole('button', { name: '로그인', exact: true }).click();
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
            [...url.searchParams].length === 1 && [ids.conversationId, roomId].includes(url.searchParams.get('conversationId'));
          const allowed = /^\/api\/local\/(?:auth\/(?:login|session|logout)|centers\/[A-Za-z0-9_-]+\/(?:operations\/(?:children|members|conversations\/[A-Za-z0-9_-]+\/(?:profile|relationships))|inbox|conversations\/[A-Za-z0-9_-]+\/(?:profile|family-plan|read|goals(?:\/[A-Za-z0-9_-]+)?|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+)?|records(?:\/[A-Za-z0-9_-]+)?(?:\/(?:preview|publish))?)))$/.test(url.pathname);
          if (url.origin !== origin || !['GET', 'POST', 'HEAD'].includes(method) || !((assets.has(url.pathname) && ['GET', 'HEAD'].includes(method)) || allowed || primaryRead)) {
            note(report.unexpectedRequests, { width, label, phase: entryPhase, sameOrigin: url.origin === origin, method: ['GET', 'POST', 'HEAD'].includes(method) ? method : 'OTHER' });
            return route.abort().catch(() => {});
          }
          const operational = url.pathname.startsWith(ops + '/');
          if (request.headers()['x-carebridge-account'] === ids.managerId && url.pathname.startsWith('/api/local/centers/') && !operational)
            clinicalRequests.push({ label, phase: entryPhase });
          if (!operational) return route.continue().catch(() => {});
          const item = method === 'POST' ? { label, pathname: url.pathname, body: structuredClone(request.postDataJSON()) } : null;
          if (item) operations.push(item);
          const lost = !!item && fault.loseNext; if (lost) fault.loseNext = false;
          const heldGet = method === 'GET' && url.pathname.endsWith('/relationships') ? fault.nextGet : null; if (heldGet) fault.nextGet = null;
          const heldPost = item ? fault.nextPost : null; if (heldPost) fault.nextPost = null;
          const work = (async () => {
            let response;
            try {
              if (heldPost) { heldPost.entered.resolve(); await heldPost.release.promise; }
              response = await route.fetch({ maxRedirects: 0, timeout: 15_000 }); const body = await response.json();
              assert.equal(response.headers()['cache-control'], 'no-store', code);
              assert(!clinicalSecrets.some(value => JSON.stringify(body).includes(value)), code);
              if ([200, 201].includes(response.status())) {
                if (item) {
                  assert.deepEqual(Object.keys(body), ['receipt'], code);
                  if (url.pathname.endsWith('/children')) {
                    assert.equal(response.status(), 201, code); assert.deepEqual(Object.keys(body.receipt).sort(), registerReceiptKeys, code);
                    assert.deepEqual(Object.keys(item.body).sort(), ['clientId', 'childId', 'conversationId', 'content'].sort(), code);
                    assert.deepEqual(Object.keys(item.body.content).sort(), ['name', 'age', 'ageAsOf'].sort(), code);
                  } else {
                    assert.equal(response.status(), 200, code); assert.deepEqual(Object.keys(body.receipt).sort(), relationReceiptKeys, code);
                    assert.deepEqual(Object.keys(item.body).sort(), ['clientId', 'expectedVersion', 'therapist', 'guardians', 'historyConfirmed', 'pastHistoryConfirmed'].sort(), code);
                  }
                  item.receipt = structuredClone(body.receipt);
                } else if (url.pathname.endsWith('/members')) {
                  assert.deepEqual(Object.keys(body).sort(), ['members', 'nextCursor', 'hasMore'].sort(), code);
                  for (const member of body.members) assert.deepEqual(Object.keys(member).sort(), ['userId', 'role', 'displayName'].sort(), code);
                } else if (url.pathname.endsWith('/relationships')) {
                  assert.deepEqual(Object.keys(body), ['relationships'], code); assert.deepEqual(Object.keys(body.relationships).sort(), relationshipKeys, code);
                  for (const member of body.relationships.participants) assert.deepEqual(Object.keys(member).sort(), ['userId', 'role', 'firstSequence'].sort(), code);
                } else if (url.pathname.endsWith('/children')) {
                  assert.deepEqual(Object.keys(body).sort(), ['children', 'nextCursor', 'hasMore'].sort(), code);
                  for (const child of body.children) assert.deepEqual(Object.keys(child).sort(), profileKeys, code);
                } else { assert.deepEqual(Object.keys(body), ['profile'], code); assert.deepEqual(Object.keys(body.profile).sort(), profileKeys, code); }
              } else assert([400, 401, 404, 409].includes(response.status()), code);
              if (item) item.status = response.status();
              if (lost) { assert([200, 201].includes(response.status()), code); fault.losses++; fault.receipt = structuredClone(body.receipt); await route.abort('failed').catch(() => {}); return; }
              if (heldGet) { heldGet.entered.resolve(); await heldGet.release.promise; }
              await route.fulfill({ response }).catch(() => {});
            } catch { note(report.errors, { width, label, phase: entryPhase, type: 'operational-response-contract' }); await route.abort().catch(() => {}); }
            finally { await response?.dispose().catch(() => {}); heldGet?.done.resolve(); heldPost?.done.resolve(); }
          })(); routeWork.add(work); try { await work; } finally { routeWork.delete(work); }
        });
        if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => { note(report.unexpectedRequests, { width, label, phase, type: 'websocket' }); socket.close(); });
        const page = await context.newPage(); page.setDefaultTimeout(15_000); pages.set(label, page);
        page.on('pageerror', () => note(report.errors, { width, label, phase, type: 'pageerror' }));
        page.on('console', entry => { if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:')) note(report.errors, { width, label, phase, type: 'console' }); });
        await page.goto(origin); await login(page, label); return { context, page, label, userId: userId(label), fault };
      };
      const center = await actor('center'), peer = await actor('peer'), therapist = await actor('therapist'), guardian = await actor('guardian');
      const actors = [center, peer, therapist, guardian], registration = who => who.page.getByTestId('operations-registration-form');
      const relations = who => who.page.getByTestId('operations-relationships-form'), dialog = who => who.page.getByTestId('care-dialog');
      const gate = () => { const g = { entered: Promise.withResolvers(), release: Promise.withResolvers(), done: Promise.withResolvers() };
        const release = () => g.release.resolve(); releases.add(release); return { ...g, finish: () => { release(); releases.delete(release); } }; };
      const capture = async (who, name) => {
        assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code);
        if (await dialog(who).isVisible()) assert.equal(await dialog(who).evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, code);
        if (await relations(who).isVisible()) assert.equal(await relations(who).evaluate(form =>
          [...form.querySelectorAll('.ops-check')].filter(label => label.getClientRects().length).every(label => {
            const box = label.querySelector('input').getBoundingClientRect(), text = label.querySelector('span').getBoundingClientRect();
            return getComputedStyle(label).display === 'flex' && box.width >= 22 && text.left >= box.right && Math.abs(text.top - box.top) <= 2;
          })), true, code);
        const filename = `${width}-${name}.png`; assert(!report.screenshots.some(item => item.filename === filename), code);
        await who.page.screenshot({ path: path.join(folder, filename), fullPage: false,
          mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]'), who.page.locator('.workspace-head .account')] });
        report.screenshots.push({ width, filename, syntheticOnly: true });
      };
      const request = async (who, pathname) => {
        const response = await who.context.request.get(origin + pathname, { timeout: 15_000, maxRedirects: 0, headers: { 'X-Carebridge-Account': who.userId } });
        try { return { status: response.status(), body: await response.json() }; } finally { await response.dispose(); }
      };
      const snapshot = async tables => { const out = {};
        for (const table of tables) out[table] = (await sandbox.database.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
        return out;
      };
      const relationshipState = () => snapshot(['cb_participants', 'cb_relationship_requests', 'cb_relationship_changes', 'cb_conversations', 'cb_read_states']);
      const clinicalSnapshot = () => snapshot(clinicalTables);
      const activeRelations = async () => { const response = await request(center, `${ops}/conversations/${roomId}/relationships`); assert.equal(response.status, 200, code); return response.body.relationships; };
      const refreshReader = async who => { await who.page.bringToFront(); await workspaceView(who.page, 'home'); await workspaceAccountAction(who.page, 'refresh'); };
      const openRelations = async (who, target = roomId) => {
        await who.page.bringToFront();
        // Discard/back refreshes authority before rendering the list. A
        // transient empty view is not evidence that an editor has a back CTA.
        await who.page.locator('[data-testid="operations-children"], [data-ops-action="back"]').first().waitFor();
        if (!await who.page.getByTestId('operations-children').isVisible()) await who.page.locator('[data-ops-action="back"]').click();
        await who.page.getByTestId('operations-children').waitFor();
        await workspaceAccountAction(who.page, 'refresh');
        await who.page.locator(`[data-ops-relationships="${target}"]`).click(); await relations(who).waitFor();
      };
      const selectRelation = async (who, { therapist: therapistSelected = true, guardian: guardianSelected = true, therapistHistory, guardianHistory, all = false } = {}) => {
        const f = relations(who); await f.locator('[name="therapist"]').selectOption(therapistSelected ? ids.therapistId : '');
        if (therapistSelected && therapistHistory) await f.locator('[name="therapistHistory"]').selectOption(therapistHistory);
        await f.locator(`[name="guardian"][value="${ids.guardianId}"]`).setChecked(guardianSelected);
        if (guardianSelected && guardianHistory) await f.locator(`[data-guardian-history="${ids.guardianId}"]`).selectOption(guardianHistory);
        await f.locator('[name="historyConfirmed"]').check();
        if (all) await f.locator('[name="pastHistoryConfirmed"]').check();
      };
      const submitRelations = async (who, { retry = false, expected = 200 } = {}) => {
        await who.page.bringToFront();
        const button = retry ? relations(who).locator('[data-ops-action="retry"]') : relations(who).getByRole('button', { name: '관계 저장', exact: true });
        const [response] = await Promise.all([who.page.waitForResponse(r => new URL(r.url()).pathname === `${ops}/conversations/${roomId}/relationships` && r.request().method() === 'POST'), button.click()]);
        assert.equal(response.status(), expected, code); const body = await response.json();
        if (expected === 200) await who.page.getByTestId('operations-children').waitFor(); return body;
      };
      const send = async (who, text) => {
        await who.page.bringToFront(); await workspaceRoom(who.page, roomId); await who.page.getByLabel('메시지', { exact: true }).fill(text);
        const [response] = await Promise.all([who.page.waitForResponse(r => new URL(r.url()).pathname === base() + '/messages' && r.request().method() === 'POST'),
          who.page.locator('.composer').getByRole('button', { name: '보내기', exact: true }).click()]);
        assert.equal(response.status(), 201, code); const body = await response.json(); await who.page.locator(`[data-message-id="${body.message.id}"]`).first().waitFor(); return body.message;
      };
      const messages = async who => { const response = await request(who, base() + '/messages'); assert.equal(response.status, 200, code); return response.body; };
      const noPrivateCenter = async () => {
        assert.equal(clinicalRequests.length, 0, code);
        for (const who of [center, peer]) {
          const text = await who.page.locator('body').innerText(); assert(!clinicalSecrets.some(value => text.includes(value)), code);
          assert.equal(await who.page.locator('[data-testid="home"],[data-testid="inbox"],[data-testid="care"],.main-nav').count(), 0, code);
        }
      };
      const accountBaseline = await snapshot(['cb_users', 'cb_memberships', 'cb_auth_accounts']);
      const beforeRegistration = await clinicalSnapshot();

      await advance(`${width}:REGISTER_COMMIT_LOSS`);
      const create = center.page.locator('[data-ops-action="new-child"]'); await reachable(create); await create.focus(); await create.press('Enter');
      await registration(center).waitFor();
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      for (const [name, value] of Object.entries({ name: childName, age: '0', ageAsOf: today })) await registration(center).locator(`[name="${name}"]`).fill(value);
      await registration(center).locator('[name="name"]').focus(); await center.page.keyboard.press('Tab');
      assert.equal(await registration(center).locator('[name="age"]').evaluate(node => node === document.activeElement), true, code);
      await reachable(registration(center).getByRole('button', { name: '아이 등록', exact: true })); await capture(center, 'registration-editor');
      center.fault.loseNext = true; await registration(center).getByRole('button', { name: '아이 등록', exact: true }).click();
      await registration(center).locator('[data-ops-action="retry"]:not([disabled])').waitFor();
      assert.equal(center.fault.losses, 1, code); assert.equal(operations.length, 1, code);
      const registeredOperation = structuredClone(operations[0]); childId = registeredOperation.body.childId; roomId = registeredOperation.body.conversationId;
      for (const id of [childId, roomId, registeredOperation.body.clientId]) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, code);
      assert.equal(new Set([childId, roomId, registeredOperation.body.clientId]).size, 3, code);
      const registeredState = await snapshot(['cb_children', 'cb_conversations', 'cb_child_profiles', 'cb_profile_requests', 'cb_participants']);
      for (const input of await registration(center).locator('input').all()) assert.equal(await input.isDisabled(), true, code);
      await capture(center, 'registration-unknown-frozen');
      const [registrationResponse] = await Promise.all([center.page.waitForResponse(r => new URL(r.url()).pathname === ops + '/children' && r.request().method() === 'POST'),
        registration(center).locator('[data-ops-action="retry"]').click()]);
      assert.equal(registrationResponse.status(), 201, code); const registrationReplay = (await registrationResponse.json()).receipt;
      assert.deepEqual(registrationReplay, { ...center.fault.receipt, replayed: true }, code);
      assert.deepEqual(operations[1].body, registeredOperation.body, code); assert.deepEqual(await snapshot(Object.keys(registeredState)), registeredState, code);
      await center.page.getByTestId('operations-children').waitFor();
      assert.equal((await sandbox.database.query('SELECT id FROM cb_children WHERE center_id=$1 AND id=$2', [ids.centerId, childId])).rows.length, 1, code);
      assert.equal((await sandbox.database.query('SELECT id FROM cb_conversations WHERE center_id=$1 AND id=$2', [ids.centerId, roomId])).rows.length, 1, code);
      assert.equal((await sandbox.database.query('SELECT child_id FROM cb_child_profiles WHERE center_id=$1 AND child_id=$2', [ids.centerId, childId])).rows.length, 1, code);
      assert.equal((await sandbox.database.query('SELECT user_id FROM cb_participants WHERE center_id=$1 AND conversation_id=$2', [ids.centerId, roomId])).rows.length, 0, code);
      const savedChild = registeredState.cb_child_profiles.find(row => row.value.child_id === childId)?.value;
      assert.equal(savedChild?.name, childName, code); assert.equal(savedChild?.age, 0, code); assert.equal(savedChild?.age_as_of, today, code);
      assert.equal(registeredState.cb_profile_requests.filter(row => row.value.client_id === registeredOperation.body.clientId && row.value.operation === 'child.register').length, 1, code);
      assert.equal(await center.page.locator(`[data-ops-child="${roomId}"] b`).count(), 0, code);
      assert.equal((await activeRelations()).participants.length, 0, code);
      for (const who of [therapist, guardian]) {
        await refreshReader(who); assert.equal((await request(who, base() + '/profile')).status, 404, code);
        const inbox = await request(who, `/api/local/centers/${ids.centerId}/inbox`); assert.equal(inbox.status, 200, code);
        assert(!inbox.body.rooms.some(row => row.conversationId === roomId), code);
      }
      assert.deepEqual(await clinicalSnapshot(), beforeRegistration, code); assert.deepEqual(await snapshot(Object.keys(accountBaseline)), accountBaseline, code);
      result.separateEnrollment = result.registrationRetry = result.oneRegistration = result.keyboard = result.reachability = true;

      await advance(`${width}:EXISTING_MEMBER_EXPLICIT_CONNECTION`);
      const memberResponse = await request(center, ops + '/members'); assert.equal(memberResponse.status, 200, code);
      assert.deepEqual(memberResponse.body.members.map(member => member.userId).sort(), [ids.managerId, ids.therapistId, ids.guardianId].sort(), code);
      await openRelations(center);
      assert.equal(await relations(center).locator('[name="therapist"]').inputValue(), '', code);
      assert.equal(await relations(center).locator(`[name="guardian"][value="${ids.guardianId}"]`).isChecked(), false, code);
      assert.equal(await relations(center).locator('[name="therapistHistory"]').inputValue(), 'from_now', code);
      assert.equal(await relations(center).locator(`[data-guardian-history="${ids.guardianId}"]`).inputValue(), 'from_now', code);
      assert.equal(await relations(center).locator(`[name="therapist"] option[value="${ids.managerId}"],[name="guardian"][value="${ids.managerId}"]`).count(), 0, code);
      await selectRelation(center, { guardian: false }); await capture(center, 'first-relationship-defaults'); await submitRelations(center);
      const initial = await activeRelations(); assert.deepEqual(initial.participants.map(p => [p.userId, p.role, p.firstSequence]), [[ids.therapistId, 'therapist', 1]], code);
      assert.deepEqual(await clinicalSnapshot(), beforeRegistration, code); result.existingMembersOnly = result.explicitDefaults = true;

      await advance(`${width}:UI_PRIVATE_RECORD_AND_OLD_NEWS`);
      await refreshReader(therapist); await workspaceView(therapist.page, 'child'); await therapist.page.locator('#child-select:not([disabled])').waitFor();
      await therapist.page.locator('#child-select').selectOption(roomId);
      await therapist.page.waitForFunction(id => document.querySelector('#child-select')?.value === id && !document.querySelector('#child-select')?.disabled, roomId);
      await therapist.page.locator('[data-goal-new]').click(); await dialog(therapist).locator('[data-care-form="goal"]').waitFor();
      await dialog(therapist).locator('[name="title"]').fill(`가상 연결 확인 목표 ${width}`);
      await dialog(therapist).locator('[name="description"]').fill('가상 관계 검증용 목표');
      const [goalResponse] = await Promise.all([therapist.page.waitForResponse(r => new URL(r.url()).pathname.startsWith(base() + '/goals/') && r.request().method() === 'POST'),
        dialog(therapist).getByRole('button', { name: '목표 저장', exact: true }).click()]);
      assert.equal(goalResponse.status(), 200, code); const goalId = (await goalResponse.json()).receipt.id;
      await dialog(therapist).waitFor({ state: 'hidden' }); await workspaceRecords(therapist.page, roomId);
      await therapist.page.getByTestId('care').locator('[data-care-action="new-record"]:not([disabled])').waitFor();
      await therapist.page.getByTestId('care').locator('[data-care-action="new-record"]').click(); await dialog(therapist).locator('[data-care-form="record"]').waitFor();
      await dialog(therapist).locator('[name="goalId"]').selectOption(goalId);
      for (const [name, value] of Object.entries({ title: recordTitle, performed: '가상 연결 전 관찰', response: '가상 반응', nextPlan: '가상 다음 계획', privateNote })) {
        const field = dialog(therapist).locator(`[name="${name}"]`); await reveal(field); await field.fill(value);
      }
      const [recordResponse] = await Promise.all([therapist.page.waitForResponse(r => new URL(r.url()).pathname.startsWith(base() + '/records/') && r.request().method() === 'POST'),
        dialog(therapist).getByRole('button', { name: '기록 저장', exact: true }).click()]);
      assert.equal(recordResponse.status(), 201, code); const recordId = (await recordResponse.json()).receipt.recordId; await dialog(therapist).waitFor({ state: 'hidden' });
      const originalRecord = await request(therapist, base() + `/records/${recordId}?revision=1`); assert.equal(originalRecord.status, 200, code);
      const first = await send(therapist, firstText);
      const immutableClinical = await clinicalSnapshot();

      await advance(`${width}:FROM_NOW_USES_COMMIT_BOUNDARY`);
      await openRelations(center); assert.equal(await relations(center).locator('[name="therapistHistory"]').inputValue(), 'preserve', code);
      await selectRelation(center); assert.equal(await relations(center).locator(`[data-guardian-history="${ids.guardianId}"]`).inputValue(), 'from_now', code);
      const relationshipVersion = (await activeRelations()).version;
      const beforeAdmission = await send(therapist, pendingText); assert.equal((await activeRelations()).version, relationshipVersion, code);
      await submitRelations(center); const admitted = await activeRelations();
      assert.equal(admitted.participants.find(p => p.userId === ids.guardianId).firstSequence, beforeAdmission.sequence + 1, code);
      assert.equal(admitted.participants.find(p => p.userId === ids.therapistId).firstSequence, 1, code);
      await refreshReader(guardian); const initialGuardian = await messages(guardian);
      assert.deepEqual(initialGuardian.messages, [], code); assert.equal(initialGuardian.unread, 0, code);
      assert.equal((await request(guardian, base() + `/messages/${first.id}`)).status, 404, code);
      assert.equal((await request(guardian, base() + `/messages/${beforeAdmission.id}`)).status, 404, code);
      await workspaceRoom(guardian.page, roomId); assert(!(await guardian.page.getByTestId('message-list').innerText()).includes(firstText), code);
      await capture(guardian, 'new-guardian-history-empty'); result.commitTimeBoundary = result.guardianHistory = true;
      await therapist.page.bringToFront(); await workspaceRoom(therapist.page, roomId);
      const replyButton = therapist.page.getByTestId('message-list').locator(`[data-message-id="${first.id}"] [data-care-action="reply"]`);
      await reveal(replyButton); await replyButton.click();
      await dialog(therapist).locator('[data-care-form="reply"]').waitFor(); await dialog(therapist).locator('[name="body"]').fill(futureText);
      const [replyResponse] = await Promise.all([therapist.page.waitForResponse(r => new URL(r.url()).pathname === base() + '/messages' && r.request().method() === 'POST'),
        dialog(therapist).getByRole('button', { name: '답장 보내기', exact: true }).click()]);
      assert.equal(replyResponse.status(), 201, code); const afterAdmission = (await replyResponse.json()).message;
      await dialog(therapist).waitFor({ state: 'hidden' }); await refreshReader(guardian); const guardianAfter = await messages(guardian);
      assert.deepEqual(guardianAfter.messages.map(m => m.id), [afterAdmission.id], code);
      assert.equal(guardianAfter.messages[0].quote.hidden, true, code); assert(!JSON.stringify(guardianAfter).includes(firstText), code);
      const [readResponse] = await Promise.all([guardian.page.waitForResponse(r => new URL(r.url()).pathname === base() + '/read' &&
        r.request().method() === 'POST' && r.request().postDataJSON()?.messageId === afterAdmission.id), workspaceRoom(guardian.page, roomId)]);
      assert.equal(readResponse.status(), 200, code); await guardian.page.locator(`[data-message-id="${afterAdmission.id}"]`).first().waitFor();
      const readCommitted = await sandbox.database.query('SELECT sequence FROM cb_read_states WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3', [ids.centerId, roomId, ids.guardianId]);
      assert.equal(Number(readCommitted.rows[0]?.sequence), afterAdmission.sequence, code);
      await capture(guardian, 'visible-new-news-hidden-quote'); result.quoteRedacted = true;

      await advance(`${width}:DISCONNECT_AND_RECONNECT_FROM_NOW`);
      await guardian.page.getByLabel('메시지', { exact: true }).fill(unsentText);
      await openRelations(center); await selectRelation(center, { guardian: false }); await submitRelations(center);
      await guardian.page.waitForFunction(({ text, id }) => ![...document.querySelectorAll('input,textarea')].some(node => node.value === text) &&
        !document.querySelector(`[data-testid="inbox"] [data-room-id="${id}"]`), { text: unsentText, id: roomId }, { timeout: 15_000 });
      for (const suffix of ['/profile', '/messages', `/messages/${afterAdmission.id}`]) assert.equal((await request(guardian, base() + suffix)).status, 404, code);
      await capture(guardian, 'disconnected-guardian-cleared'); result.disconnectRevokes = true;
      const whileRemoved = await send(therapist, removedText); await openRelations(center);
      assert.equal(await relations(center).locator(`[data-guardian-history="${ids.guardianId}"]`).inputValue(), 'from_now', code);
      assert.equal(await relations(center).locator(`[data-guardian-history="${ids.guardianId}"] option[value="preserve"]`).isDisabled(), true, code);
      await selectRelation(center); await submitRelations(center);
      assert.equal((await activeRelations()).participants.find(p => p.userId === ids.guardianId).firstSequence, whileRemoved.sequence + 1, code);
      const afterRejoin = await messages(guardian); assert.equal(afterRejoin.lastRead, 0, code); assert.equal(afterRejoin.unread, 0, code); assert.deepEqual(afterRejoin.messages, [], code);
      const afterRejoined = await send(therapist, rejoinedText); await refreshReader(guardian);
      const beforeOpening = await messages(guardian); assert.equal(beforeOpening.lastRead, 0, code); assert.equal(beforeOpening.unread, 1, code);
      assert.deepEqual(beforeOpening.messages.map(m => m.id), [afterRejoined.id], code); result.reconnectFromNow = true;

      await advance(`${width}:ALL_HISTORY_NEEDS_EXTRA_CONFIRMATION`);
      await openRelations(center); await selectRelation(center, { guardianHistory: 'all' });
      assert.equal(await relations(center).locator('[name="pastHistoryConfirmed"]').isChecked(), false, code);
      const beforeConfirmation = await relationshipState(), requestCount = operations.length;
      await relations(center).getByRole('button', { name: '관계 저장', exact: true }).click();
      await relations(center).locator('[data-ops-error]').filter({ hasText: /확인/ }).waitFor();
      assert.equal(operations.length, requestCount, code); assert.deepEqual(await relationshipState(), beforeConfirmation, code);
      const otherRead = (await sandbox.database.query('SELECT * FROM cb_read_states WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3', [ids.centerId, roomId, ids.therapistId])).rows;
      await relations(center).locator('[name="pastHistoryConfirmed"]').check(); await capture(center, 'explicit-all-history-confirmation'); await submitRelations(center);
      const restored = await messages(guardian); assert.equal(restored.lastRead, 0, code);
      assert(restored.messages.some(m => m.id === first.id) && restored.messages.some(m => m.id === whileRemoved.id), code);
      assert.equal(restored.messages.find(m => m.id === afterAdmission.id).quote.hidden, false, code);
      assert.deepEqual((await sandbox.database.query('SELECT * FROM cb_read_states WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3', [ids.centerId, roomId, ids.therapistId])).rows, otherRead, code);
      await refreshReader(guardian); await workspaceRoom(guardian.page, roomId); await guardian.page.locator(`[data-message-id="${first.id}"]`).first().waitFor();
      await capture(guardian, 'explicit-old-history-visible'); result.allRequiresConfirmation = result.readCursorScope = true;

      await advance(`${width}:THERAPIST_RECORD_HISTORY_IS_NOT_OWNERSHIP_BYPASS`);
      await openRelations(center); await selectRelation(center, { therapist: false });
      await advance(phase, 'DISCONNECT_EDITOR_READY'); await submitRelations(center);
      await advance(phase, 'DISCONNECT_SAVED');
      assert.equal((await request(therapist, base() + `/records/${recordId}?revision=1`)).status, 404, code);
      await advance(phase, 'DISCONNECTED_ACCESS_DENIED');
      await refreshReader(therapist); await therapist.page.waitForFunction(id => !document.querySelector(`[data-testid="inbox"] [data-room-id="${id}"]`), roomId);
      await advance(phase, 'DISCONNECTED_READER_REFRESHED');
      await openRelations(center); await selectRelation(center, { therapistHistory: 'from_now' });
      await advance(phase, 'FROM_NOW_EDITOR_READY'); await submitRelations(center);
      await advance(phase, 'FROM_NOW_SAVED');
      assert.equal((await request(therapist, base() + `/records/${recordId}?revision=1`)).status, 404, code);
      await refreshReader(therapist); await workspaceRecords(therapist.page, roomId);
      assert.equal(await therapist.page.getByTestId('care').locator(`[data-record-id="${recordId}"]`).count(), 0, code);
      await advance(phase, 'FROM_NOW_RECORD_HIDDEN');
      await openRelations(center); await selectRelation(center, { therapistHistory: 'all', all: true });
      await advance(phase, 'ALL_HISTORY_EDITOR_READY'); await submitRelations(center);
      await advance(phase, 'ALL_HISTORY_SAVED');
      const preservedRecord = await request(therapist, base() + `/records/${recordId}?revision=1`); assert.deepEqual(preservedRecord, originalRecord, code);
      await advance(phase, 'ORIGINAL_RECORD_VERIFIED');
      await refreshReader(therapist); await workspaceRecords(therapist.page, roomId);
      await therapist.page.getByTestId('care').locator(`[data-care-action="edit-record"][data-record-id="${recordId}"]`).waitFor();
      await advance(phase, 'RESTORED_READER_VISIBLE');
      await capture(therapist, 'record-restored-by-explicit-history'); result.therapistRecordHistory = true;

      await advance(`${width}:OLD_RECEIPT_CANNOT_REAPPLY_RELATIONSHIPS`);
      await openRelations(center); await selectRelation(center, { guardian: false }); await submitRelations(center);
      await openRelations(center); await selectRelation(center, { guardianHistory: 'all', all: true });
      center.fault.loseNext = true; const originalCount = operations.length;
      await relations(center).getByRole('button', { name: '관계 저장', exact: true }).click();
      await relations(center).locator('[data-ops-action="retry"]:not([disabled])').waitFor();
      assert.equal(center.fault.losses, 2, code); const pendingRelation = structuredClone(operations[originalCount]);
      await openRelations(peer); await selectRelation(peer, { guardian: false }); await submitRelations(peer);
      const afterPeerDisconnect = await relationshipState(); await center.page.bringToFront();
      await relations(center).locator('[data-ops-action="retry"]:not([disabled])').waitFor(); await capture(center, 'relationship-unknown-frozen');
      const oldReceipt = await submitRelations(center, { retry: true }); assert.deepEqual(oldReceipt.receipt, { ...pendingRelation.receipt, replayed: true }, code);
      assert.deepEqual(operations.at(-1).body, pendingRelation.body, code); assert.deepEqual(await relationshipState(), afterPeerDisconnect, code);
      assert(!(await activeRelations()).participants.some(p => p.userId === ids.guardianId), code);
      await openRelations(center); assert.equal(await relations(center).locator(`[name="guardian"][value="${ids.guardianId}"]`).isChecked(), false, code);
      await center.page.locator('[data-ops-action="discard"]').click(); result.oldReceiptNoResurrection = true;

      await advance(`${width}:REAL_RELATIONSHIP_VERSION_CONFLICT`);
      await openRelations(center); await selectRelation(center, { guardian: true });
      await openRelations(peer); await selectRelation(peer, { therapist: false, guardian: false });
      const heldPost = gate(); center.fault.nextPost = heldPost;
      try {
        const rejected = center.page.waitForResponse(r => new URL(r.url()).pathname === `${ops}/conversations/${roomId}/relationships` && r.request().method() === 'POST' && r.status() === 409); void rejected.catch(() => {});
        await relations(center).getByRole('button', { name: '관계 저장', exact: true }).click(); await bounded(heldPost.entered.promise, 5000);
        await submitRelations(peer); heldPost.finish(); assert.equal((await (await rejected).json()).error, 'RELATIONSHIP_CONFLICT', code); await bounded(heldPost.done.promise, 5000);
        await relations(center).locator('[data-ops-conflict]:not([hidden])').waitFor();
        assert.equal(await relations(center).locator('[name="therapist"]').inputValue(), ids.therapistId, code);
        assert.equal(await relations(center).locator(`[name="guardian"][value="${ids.guardianId}"]`).isChecked(), true, code);
        assert.equal(await relations(center).getByRole('button', { name: '관계 저장', exact: true }).isDisabled(), true, code);
        await workspaceAccountAction(center.page, 'refresh'); await relations(center).locator('[data-ops-latest]').waitFor();
        const countBeforeKeep = operations.length, stateBeforeKeep = await relationshipState();
        await reachable(relations(center).locator('[data-ops-action="keep"]')); await capture(center, 'relationship-cas-conflict');
        await relations(center).locator('[data-ops-action="keep"]').click();
        assert.equal(await relations(center).locator('[name="therapistHistory"]').inputValue(), 'from_now', code);
        assert.equal(await relations(center).locator('[name="historyConfirmed"]').isChecked(), false, code);
        assert.equal(operations.length, countBeforeKeep, code); assert.deepEqual(await relationshipState(), stateBeforeKeep, code);
        await selectRelation(center); await submitRelations(center); result.actualConflict = result.inputPreserved = true;
      } finally { heldPost.finish(); }

      await advance(`${width}:LATE_RELATIONSHIP_OTHER_CHILD`);
      await openRelations(center); const heldRoom = gate(); center.fault.nextGet = heldRoom;
      const observeLate = async () => center.page.evaluate(() => {
        window.__enrollmentLate = false; window.__enrollmentObserver?.disconnect();
        window.__enrollmentObserver = new MutationObserver(changes => { if (changes.some(change => [...change.addedNodes].some(node => node.nodeType === Node.ELEMENT_NODE &&
          (node.matches('[data-testid="operations-relationships-form"]') || node.querySelector('[data-testid="operations-relationships-form"]'))))) window.__enrollmentLate = true; });
        window.__enrollmentObserver.observe(document.body, { subtree: true, childList: true });
      });
      const noLate = async () => { await center.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await center.page.evaluate(() => window.__enrollmentLate), false, code); await center.page.evaluate(() => window.__enrollmentObserver.disconnect()); };
      try {
        await workspaceAccountAction(center.page, 'refresh'); await bounded(heldRoom.entered.promise, 5000);
        await center.page.locator('[data-ops-action="back"]').click(); await center.page.locator(`[data-ops-child="${ids.conversationId}"]`).click();
        await center.page.getByTestId('operations-form').waitFor(); await observeLate(); heldRoom.finish(); await bounded(heldRoom.done.promise, 5000); await noLate();
        assert.equal(await relations(center).count(), 0, code); assert.equal(await center.page.getByTestId('operations-form').locator('[name="name"]').inputValue(), '가상 아동', code);
        await capture(center, 'late-relationship-other-child'); result.lateRoomDiscarded = true;
      } finally { heldRoom.finish(); }

      await advance(`${width}:LATE_RELATIONSHIP_CHANGED_ACCOUNT`);
      await openRelations(center); const heldAccount = gate(); center.fault.nextGet = heldAccount; let otherPage;
      try {
        await workspaceAccountAction(center.page, 'refresh'); await bounded(heldAccount.entered.promise, 5000);
        otherPage = await center.context.newPage(); otherPage.setDefaultTimeout(15_000); await otherPage.goto(origin);
        await workspaceAccountAction(otherPage, 'logout'); await login(otherPage, 'guardian');
        await center.page.bringToFront(); await center.page.getByTestId('login-form').waitFor(); await observeLate();
        heldAccount.finish(); await bounded(heldAccount.done.promise, 5000); await noLate(); assert.equal(await center.page.getByTestId('operations').count(), 0, code);
        await capture(center, 'late-relationship-account-cleared'); result.lateAccountDiscarded = true;
      } finally { heldAccount.finish(); await otherPage?.close(); }
      await login(center.page, 'center');

      await advance(`${width}:MANAGER_AUTHORITY_AND_NO_CLINICAL_SIDE_EFFECTS`);
      await noPrivateCenter();
      for (const suffix of ['/profile', '/messages', '/records', '/family-plan']) assert.equal((await request(center, base() + suffix)).status, 404, code);
      for (const who of [therapist, guardian]) {
        assert.equal((await request(who, `${ops}/conversations/${roomId}/relationships`)).status, 404, code);
        assert.equal((await request(who, ops + '/members')).status, 404, code);
      }
      // Explicit UI messages added after the first immutable clinical baseline;
      // all pre-existing record/goal bytes stay identical across relationships.
      const afterClinical = await clinicalSnapshot();
      for (const table of clinicalTables.filter(table => !['cb_messages', 'cb_audit_events'].includes(table))) assert.deepEqual(afterClinical[table], immutableClinical[table], code);
      assert.equal(afterClinical.cb_messages.length, immutableClinical.cb_messages.length + 4, code);
      assert.equal(afterClinical.cb_audit_events.length, immutableClinical.cb_audit_events.length + 4, code);
      for (const original of immutableClinical.cb_audit_events) assert(afterClinical.cb_audit_events.some(row => JSON.stringify(row) === JSON.stringify(original)), code);
      assert.deepEqual(await snapshot(Object.keys(accountBaseline)), accountBaseline, code);
      result.noAutomaticClinicalWrites = result.noAccountsCreated = result.minimalDto = true;
      await openRelations(center); await relations(center).locator(`[name="guardian"][value="${ids.guardianId}"]`).uncheck();
      await sandbox.database.query('UPDATE cb_memberships SET active=false WHERE center_id=$1 AND user_id=$2', [ids.centerId, ids.managerId]);
      await workspaceAccountAction(center.page, 'refresh'); await center.page.getByTestId('login-form').waitFor();
      assert.equal(await relations(center).count(), 0, code); assert.equal(await center.page.locator('[data-ops-child],[data-ops-relationships]').count(), 0, code);
      assert.equal((await request(center, `${ops}/conversations/${roomId}/relationships`)).status, 404, code);
      await capture(center, 'manager-revoked-relationship-cleared'); result.managerRevoked = true;
      for (const who of actors) assert.deepEqual(await who.page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, ''], code);
      result.browserStorageEmpty = result.layout = true;
      assert.equal(report.errors.length, 0, code); assert.equal(report.unexpectedRequests.length, 0, code);
      await advance(`${width}:WIDTH_CLEANUP`);
      for (const who of actors) await who.context.close(); pages.clear();
      await advance(phase, 'CONTEXTS_CLOSED');
      await sandbox.close(); assert.equal(sandbox.database.closed, true, code); assert.equal(sandbox.credentials.length, 0, code); sandboxes.delete(sandbox);
      // Keep only the small ownership receipt, not the closed PGlite object.
      owned.closed = true; ownedSandboxes.delete(sandbox); assert.equal(ownedSandboxes.size, 0, code);
      await advance(phase, 'SANDBOX_CLOSED');
      await save('ownership.json', ownership); result.cleanup = true; report.checks.push(result); delete report.currentCheck;
      console.log(JSON.stringify({ width, passed: true, boundaries: Object.values(result).filter(value => value === true).length - 1 }));
    }
    report.finalSource = await sources(); assert.equal(report.finalSource.sha256, source.sha256, code);
  } catch (error) {
    report.failure = { code, phase, kind: ['AssertionError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-enrollment-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      workspaceHelperLine: Number(error?.stack?.match(/local-workspace-browser-helpers\.mjs:(\d+):\d+/)?.[1]) || null };
    if (error?.reachability) report.failure.reachability = error.reachability;
    const failureReaders = /FROM_NOW|ALL_HISTORY|DISCONNECT|RECORD_HISTORY/.test(phase) ? ['guardian', 'therapist']
      : /UI_PRIVATE_RECORD/.test(phase) ? ['therapist', 'center'] : ['center', 'peer'];
    for (const [label, page] of [...pages].filter(([label]) => failureReaders.includes(label)).slice(0, 2)) try {
      const filename = `failure-${label}.png`; await page.screenshot({ path: path.join(folder, filename), fullPage: false,
        mask: [page.locator('input[type="email"]'), page.locator('input[type="password"]'), page.locator('.workspace-head .account')] });
      report.screenshots.push({ filename, syntheticOnly: true, failure: true });
    } catch { note(report.errors, { phase, type: 'failure-screenshot' }); }
  } finally {
    // Diagnostic I/O must never prevent cleanup. A failure still fails the run.
    const cleanupCheckpoint = async step => {
      try { await advance('CLEANUP', step); }
      catch { report.failure ??= { code, phase: 'CHECKPOINT_WRITE', kind: 'Error' }; }
    };
    await cleanupCheckpoint(null);
    for (const release of releases) release();
    try { await bounded(Promise.all([...routeWork])); } catch { report.cleanupObservationTimedOut = true; }
    if (routeWork.size === 0) await cleanupCheckpoint('ROUTES_SETTLED');
    for (const context of contexts) try { await bounded(context.close()); contexts.delete(context); } catch { report.cleanupObservationTimedOut = true; }
    report.cleanup.contextsClosed = contexts.size === 0;
    if (report.cleanup.contextsClosed) await cleanupCheckpoint('CONTEXTS_CLOSED');
    if (browserServer) {
      try { await bounded(browser?.close()); await bounded(browserServer.close()); await bounded(browserLife.done); }
      catch { report.cleanupObservationTimedOut = true; try { await bounded(browserServer.kill()); await bounded(browserLife.done); } catch {} }
      report.cleanup.browserStopped = browserLife?.terminal() === true;
    } else report.cleanup.browserStopped = true;
    if (report.cleanup.browserStopped) await cleanupCheckpoint('BROWSER_STOPPED');
    if (report.cleanup.browserStopped) for (const sandbox of sandboxes) try {
      await bounded(sandbox.close()); assert.equal(sandbox.database.closed, true, code); sandboxes.delete(sandbox); ownedSandboxes.get(sandbox).closed = true;
      ownedSandboxes.delete(sandbox);
    } catch { report.failure ??= { code, phase: 'SANDBOX_CLEANUP', kind: 'Error' }; }
    report.cleanup.sandboxesClosed = sandboxes.size === 0 && ownedSandboxes.size === 0;
    if (report.cleanup.sandboxesClosed) await cleanupCheckpoint('SANDBOXES_CLOSED');
    report.finishedAt = new Date().toISOString();
    report.checkpointObservation = progressWriter.status();
    report.passed = !report.failure && !Object.values(report.checkpointObservation).some(Boolean) && !report.cleanupObservationTimedOut && report.checks.length === 3 && report.checks.every(check => Object.entries(check).every(([key, value]) => key === 'width' || value === true)) &&
      report.errors.length === 0 && report.unexpectedRequests.length === 0 && Object.values(report.cleanup).every(Boolean);
    ownership.finished = Object.values(report.cleanup).every(Boolean); ownership.cleanup = report.cleanup;
    await save('ownership.json', ownership); await save('results.json', report);
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length, failure: report.failure, cleanup: report.cleanup }));
  return report.passed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runLocalEnrollmentBrowser()) process.exitCode = 1; }
  catch { console.error(code); process.exitCode = 1; }
}

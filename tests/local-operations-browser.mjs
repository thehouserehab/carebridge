// Center-only operational UI -> authenticated HTTP -> owned memory PGlite.
// Clinical and profile writes use visible UI; SQL only adds a synthetic child
// and revokes an invented center membership. No E/native or existing browser.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceView, workspaceRecords, workspaceAccountAction } from './local-workspace-browser-helpers.mjs';
import { operationsCheckpoint } from './operations-checkpoint.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), code = 'LOCAL_OPERATIONS_FAILED';
const hash = value => createHash('sha256').update(value).digest('hex');
const profileKeys = ['conversationId', 'childId', 'name', 'age', 'ageAsOf', 'revision'].sort();
const receiptKeys = ['operation', 'childId', 'conversationId', 'appliedVersion', 'changed', 'replayed'].sort();
const assets = new Set(['/', '/favicon.ico', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/client.js', '/local-api/care-client.js',
  '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css', '/local-api/media-client.js', '/local-api/media-ui.js',
  '/local-api/media-viewer.js', '/local-api/operations-ui.js', '/local-api/operations-recipient.js', '/local-api/operations-client.js', '/local-api/operations-onboarding.js',
  '/local-api/operations-schedule.js', '/local-api/appointment-client.js', '/src/context-fields.js',
  '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js', '/src/profile-fields.js']);
const clinicalTables = ['cb_messages', 'cb_read_states', 'cb_records', 'cb_record_revisions', 'cb_record_requests', 'cb_publications',
  'cb_activity_feedback', 'cb_feedback_revisions', 'cb_feedback_reviews', 'cb_feedback_requests', 'cb_child_family_plans',
  'cb_goals', 'cb_goal_revisions', 'cb_appointments', 'cb_appointment_revisions', 'cb_participants', 'cb_audit_events'];
async function sources() {
  const names = ['tests/local-operations-browser.mjs', 'tests/operations-checkpoint.mjs', 'tests/local-workspace-browser-helpers.mjs',
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
      const r = element.getBoundingClientRect(), x = Math.min(6, r.width / 4), y = Math.min(6, r.height / 4);
      const nav = document.querySelector('.main-nav'), n = nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect() : null;
      const rect = value => value ? Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map(key => [key, value[key]])) : null;
      const withinViewport = r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      const outsideNav = !n || r.bottom <= n.top || r.top >= n.bottom || r.right <= n.left || r.left >= n.right;
      const hits = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + x, r.top + y], [r.right - x, r.top + y],
        [r.left + x, r.bottom - y], [r.right - x, r.bottom - y]].map(([px, py]) => element.contains(document.elementFromPoint(px, py)));
      return { connected: element.isConnected, bounds: rect(r), viewport: { width: innerWidth, height: innerHeight },
        fixedNav: rect(n), withinViewport, outsideNav, hits, passed: withinViewport && outsideNav && hits.every(Boolean) };
    }, undefined, { timeout: Math.max(1, deadline - Date.now()) });
    if (observation.passed) return;
    if (observation.connected) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
  }
  const error = new Error(code); error.name = 'AssertionError'; error.reachability = observation; throw error;
}
async function reveal(locator) {
  for (const details of await locator.locator('xpath=ancestor::details').all())
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
}
async function fixture(sandbox) {
  const suffix = randomUUID(), ids = sandbox.ids;
  const extra = { childId: `operations-child-${suffix}`, conversationId: `operations-room-${suffix}`, name: '가상 다른 관리 아동' };
  await sandbox.database.transaction(async tx => {
    await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)', [ids.centerId, extra.childId]);
    await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)', [ids.centerId, extra.conversationId, extra.childId]);
    await tx.query(`INSERT INTO cb_child_profiles(center_id,child_id,name,age,age_as_of,revision,updated_by)
      VALUES ($1,$2,$3,NULL,NULL,1,$4)`, [ids.centerId, extra.childId, extra.name, ids.managerId]);
  });
  return extra;
}

export async function runLocalOperationsBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const filename of [options.module, options.executable]) { const stat = await lstat(filename); assert(stat.isFile() && !stat.isSymbolicLink(), code); }
  const source = await sources(), { chromium } = await import(pathToFileURL(options.module).href);
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-operations-${runId}`); await mkdir(folder);
  const report = { runId, startedAt: new Date().toISOString(), source, passed: false, checks: [], screenshots: [], errors: [], unexpectedRequests: [],
    failure: null, cleanupObservationTimedOut: false, cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Owned Chromium and fresh memory-only PGlite with synthetic accounts; no native/E storage, real children, existing browser, mail or public listener.',
      'Viewport checks at 390/768/1440 are not physical-device or human usability evidence.',
      'All profile and clinical writes are visible UI operations. Fixture SQL only creates an invented second child and revokes the synthetic manager membership.',
      'One real successful response is discarded, and real GET/POST traffic is delayed. No API result, permission or success is fabricated.',
      'Center clinical HTTP denial checks use separate authenticated read-only requests, not automatic UI requests.',
      'Browser storage absence and input removal do not prove secure RAM erasure or production retention policy.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, sourceSha256: source.sha256, sandboxes: [], finished: false };
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  const note = (list, value) => { if (list.length < 32) list.push(value); };
  const contexts = new Set(), sandboxes = new Set(), sandboxOwnership = new Map(), pages = new Map(), releases = new Set(), routeWork = new Set();
  let browserServer, browser, browserLife, phase = 'STARTUP'; await save('ownership.json', ownership);
  const observedAt = performance.now();
  const advance = async (next = phase, step = null) => {
    phase = next;
    // Last checkpoint only: no timers, payloads, environment, paths or dump.
    // A write failure follows the ordinary catch/finally failure and cleanup.
    await save('progress.json', operationsCheckpoint({ runId, sourceSha256: source.sha256, phase, step,
      elapsedMs: Math.floor(performance.now() - observedAt), memory: process.memoryUsage(),
      counts: { contexts: contexts.size, sandboxes: sandboxes.size, routeWork: routeWork.size,
        retainedSandboxHandles: sandboxOwnership.size } }));
  };
  try {
    await advance();
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    browserLife = lifetime(browserServer.process()); ownership.browserProcessId = browserServer.process().pid;
    await save('ownership.json', ownership); browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    for (const width of [390, 768, 1440]) {
      await advance(`${width}:SANDBOX`); const sandbox = await createLocalApiSandbox({ port: 0 }); sandboxes.add(sandbox);
      const ownedSandbox = { width, mediaDirectoryName: path.basename(sandbox.mediaRoot), closed: false };
      sandboxOwnership.set(sandbox, ownedSandbox); ownership.sandboxes.push(ownedSandbox); await save('ownership.json', ownership);
      const { origin, ids } = sandbox, extra = await fixture(sandbox), url = new URL(origin);
      assert(url.origin === origin && url.hostname === '127.0.0.1' && url.protocol === 'http:' && url.port && !url.username && !url.password, code);
      const operationsBase = `/api/local/centers/${ids.centerId}/operations`;
      const endpoint = `${operationsBase}/conversations/${ids.conversationId}/profile`;
      const clinicalBase = `/api/local/centers/${ids.centerId}/conversations/${ids.conversationId}`;
      const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      const firstName = `가상 센터 수정 아이 ${width}`, peerName = `가상 다른 창의 이름 ${width}`, conflictName = `가상 충돌 입력 ${width}`;
      const draftName = `가상 보존할 입력 ${width}`, revokedName = `가상 종료할 입력 ${width}`;
      const clinicalTitle = `가상 비공개 기록 ${width}`, privateNote = `가상 임상 내부 메모 ${width}`, concern = `가상 가족 공동 관심사 ${width}`;
      const secrets = [clinicalTitle, privateNote, concern], operations = [], clinicalRequests = [], profileResponses = [];
      const result = { width, operationalOnly: false, minimalDto: false, lostResponseRetry: false, immutableReceipt: false,
        crossRoleRefresh: false, zeroAge: false, explicitAgeClear: false, invalidPairAndFutureDate: false, noOp: false,
        draftRetained: false, actualConflict: false, conflictInputPreserved: false, lateChildDiscarded: false,
        lateAccountDiscarded: false, membershipRevoked: false, clinicalDataUnchanged: false,
        keyboard: false, reachability: false, layout: false, browserStorageEmpty: false, cleanup: false };
      report.currentCheck = result;
      const isManager = label => label === 'center' || label === 'peer';
      const userId = label => isManager(label) ? ids.managerId : ids[`${label}Id`];
      const login = async (page, label) => {
        const credential = sandbox.credentials.find(value => value.role === (isManager(label) ? 'center' : label));
        assert(credential?.email.endsWith('.test'), code); await page.getByTestId('login-form').waitFor();
        await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click();
        await page.getByTestId(isManager(label) ? 'operations-children' : 'home').waitFor();
      };
      const actor = async label => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR',
          isMobile: width <= 640, hasTouch: width <= 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context); context.once('close', () => contexts.delete(context)); assert.equal((await context.cookies()).length, 0, code);
        const fault = { loseNext: false, nextGet: null, nextPost: null, losses: 0, receipt: null };
        await context.route('**/*', async route => {
          const request = route.request(), target = new URL(request.url()), method = request.method(), entryPhase = phase;
          const primaryRead = method === 'GET' && target.pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
            [...target.searchParams].length === 1 && [ids.conversationId, extra.conversationId].includes(target.searchParams.get('conversationId'));
          const api = /^\/api\/local\/(?:auth\/(?:login|session|logout)|centers\/[A-Za-z0-9_-]+\/(?:operations\/(?:children|conversations\/[A-Za-z0-9_-]+\/profile)|inbox|conversations\/[A-Za-z0-9_-]+\/(?:profile|family-plan|read|goals|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+)?|records(?:\/[A-Za-z0-9_-]+)?)))$/.test(target.pathname);
          if (target.origin !== origin || !['GET', 'POST', 'HEAD'].includes(method) || !((assets.has(target.pathname) && ['GET', 'HEAD'].includes(method)) || api || primaryRead)) {
            note(report.unexpectedRequests, { width, label, phase: entryPhase, sameOrigin: target.origin === origin,
              method: ['GET', 'POST', 'HEAD'].includes(method) ? method : 'OTHER' }); return route.abort().catch(() => {});
          }
          const operational = target.pathname.startsWith(operationsBase + '/');
          if (request.headers()['x-carebridge-account'] === ids.managerId && target.pathname.startsWith('/api/local/centers/') && !operational)
            clinicalRequests.push({ label, phase: entryPhase });
          if (!operational) return route.continue().catch(() => {});
          const operation = method === 'POST' ? { label, body: structuredClone(request.postDataJSON()), pathname: target.pathname } : null;
          if (operation) operations.push(operation);
          const lost = method === 'POST' && fault.loseNext; if (lost) fault.loseNext = false;
          const heldGet = method === 'GET' && target.pathname.endsWith('/profile') ? fault.nextGet : null; if (heldGet) fault.nextGet = null;
          const heldPost = method === 'POST' ? fault.nextPost : null; if (heldPost) fault.nextPost = null;
          const work = (async () => {
            let response;
            try {
              if (heldPost) { heldPost.entered.resolve(); await heldPost.release.promise; }
              response = await route.fetch({ maxRedirects: 0, timeout: 15_000 }); const body = await response.json();
              assert.equal(response.headers()['cache-control'], 'no-store', code);
              assert(!secrets.some(secret => JSON.stringify(body).includes(secret)), code);
              if (response.status() === 200) {
                if (method === 'POST') {
                  assert.deepEqual(Object.keys(body), ['receipt'], code); assert.deepEqual(Object.keys(body.receipt).sort(), receiptKeys, code);
                  assert.deepEqual(Object.keys(operation.body).sort(), ['clientId', 'expectedRevision', 'content'].sort(), code);
                  assert.deepEqual(Object.keys(operation.body.content).sort(), ['name', 'age', 'ageAsOf'].sort(), code);
                  operation.receipt = structuredClone(body.receipt);
                } else if (target.pathname.endsWith('/children')) {
                  assert.deepEqual(Object.keys(body).sort(), ['children', 'nextCursor', 'hasMore'].sort(), code);
                  for (const profile of body.children) assert.deepEqual(Object.keys(profile).sort(), profileKeys, code);
                } else {
                  assert.deepEqual(Object.keys(body), ['profile'], code); assert.deepEqual(Object.keys(body.profile).sort(), profileKeys, code);
                  profileResponses.push({ label, profile: structuredClone(body.profile) });
                }
              } else assert([401, 404, 409].includes(response.status()), code);
              if (operation) operation.status = response.status();
              if (lost) {
                assert.equal(response.status(), 200, code); fault.losses++; fault.receipt = structuredClone(body.receipt);
                await route.abort('failed').catch(() => {}); return;
              }
              if (heldGet) { heldGet.entered.resolve(); await heldGet.release.promise; }
              await route.fulfill({ response }).catch(() => {});
            } catch { note(report.errors, { width, label, phase: entryPhase, type: 'operational-response-contract' }); await route.abort().catch(() => {}); }
            finally { await response?.dispose().catch(() => {}); heldGet?.done.resolve(); heldPost?.done.resolve(); }
          })(); routeWork.add(work); try { await work; } finally { routeWork.delete(work); }
        });
        if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => {
          note(report.unexpectedRequests, { width, label, phase, type: 'websocket' }); socket.close();
        });
        const page = await context.newPage(); page.setDefaultTimeout(15_000); pages.set(label, page);
        page.on('pageerror', () => note(report.errors, { width, label, phase, type: 'pageerror' }));
        page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) note(report.errors, { width, label, phase, type: 'console' }); });
        await page.goto(origin); await login(page, label); return { context, page, label, userId: userId(label), fault };
      };
      const therapist = await actor('therapist'), guardian = await actor('guardian');
      const dialog = who => who.page.getByTestId('care-dialog'), form = who => who.page.getByTestId('operations-form');
      const capture = async (who, label) => {
        assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code);
        const filename = `${width}-${label}.png`; assert(!report.screenshots.some(item => item.filename === filename), code);
        await who.page.screenshot({ path: path.join(folder, filename), fullPage: false,
          mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]'), who.page.locator('.workspace-head .account')] });
        report.screenshots.push({ width, filename, syntheticOnly: true });
      };
      const request = async (who, pathname) => {
        const response = await who.context.request.get(origin + pathname, { timeout: 15_000, maxRedirects: 0,
          headers: { 'X-Carebridge-Account': who.userId } });
        try { return { status: response.status(), body: await response.json() }; } finally { await response.dispose(); }
      };
      const gate = () => {
        const g = { entered: Promise.withResolvers(), release: Promise.withResolvers(), done: Promise.withResolvers() };
        const release = () => g.release.resolve(); releases.add(release); return { ...g, finish: () => { release(); releases.delete(release); } };
      };
      const clinicalSnapshot = async () => {
        const value = {};
        for (const table of clinicalTables) value[table] = (await sandbox.database.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE center_id=$1 ORDER BY to_jsonb(t)::text`, [ids.centerId])).rows;
        return value;
      };
      const savedSnapshot = async () => ({
        profile: (await sandbox.database.query('SELECT * FROM cb_child_profiles WHERE center_id=$1 AND child_id=$2', [ids.centerId, ids.childId])).rows,
        requests: (await sandbox.database.query("SELECT * FROM cb_profile_requests WHERE center_id=$1 AND actor_id=$2 AND operation='child.save' ORDER BY client_id", [ids.centerId, ids.managerId])).rows,
        conversation: (await sandbox.database.query('SELECT last_sequence,revision FROM cb_conversations WHERE center_id=$1 AND id=$2', [ids.centerId, ids.conversationId])).rows,
      });
      const clinicalChild = async who => {
        await who.page.bringToFront(); await workspaceView(who.page, 'child'); await who.page.locator('#child-select:not([disabled])').waitFor();
        if (await who.page.locator('#child-select').inputValue() !== ids.conversationId) await who.page.locator('#child-select').selectOption(ids.conversationId);
        await who.page.locator('[data-family-plan-concern]').waitFor();
      };

      await advance(`${width}:UI_CLINICAL_SENTINELS`);
      await therapist.page.bringToFront(); await workspaceRecords(therapist.page, ids.conversationId);
      await therapist.page.locator('[data-care-action="new-record"]').click();
      for (const [name, value] of Object.entries({ title: clinicalTitle, performed: '가상 직접 관찰 원문', summary: '가상 별도 공유 요약', privateNote })) {
        const input = dialog(therapist).locator(`[name="${name}"]`); await reveal(input); await input.fill(value);
      }
      await dialog(therapist).locator('[name="goalId"]').selectOption(ids.goalId);
      await dialog(therapist).getByRole('button', { name: '기록 저장', exact: true }).click(); await dialog(therapist).waitFor({ state: 'hidden' });
      await clinicalChild(guardian); await guardian.page.locator('[data-family-plan]').click();
      await dialog(guardian).locator('[name="concern"]').fill(concern);
      await dialog(guardian).getByRole('button', { name: '가족 관심사 저장', exact: true }).click(); await dialog(guardian).waitFor({ state: 'hidden' });
      const baseline = await clinicalSnapshot();
      const center = await actor('center'), peer = await actor('peer'), actors = [center, peer, therapist, guardian];
      const open = async (who, roomId = ids.conversationId, keyboard = false) => {
        await who.page.bringToFront();
        if (await form(who).isVisible()) await who.page.getByRole('button', { name: '아이 목록으로', exact: true }).click();
        const button = who.page.locator(`[data-ops-child="${roomId}"]`); await reachable(button);
        if (keyboard) { await button.focus(); await button.press('Enter'); } else await button.click();
        await form(who).waitFor();
      };
      const fillProfile = async (who, values) => { for (const [name, value] of Object.entries(values)) await form(who).locator(`[name="${name}"]`).fill(value); };
      const submit = async (who, label = '기본정보 저장', expected = 200) => {
        const [response] = await Promise.all([who.page.waitForResponse(r => new URL(r.url()).pathname === endpoint && r.request().method() === 'POST'),
          who.page.getByRole('button', { name: label, exact: true }).click()]);
        assert.equal(response.status(), expected, code); const body = await response.json();
        if (expected === 200) await who.page.getByTestId('operations-children').waitFor(); return body;
      };
      const noClinicalLeak = async who => {
        const text = await who.page.locator('body').innerText(); assert(!secrets.some(secret => text.includes(secret)), code);
        assert.equal(await who.page.locator('[data-testid="home"],[data-testid="inbox"],[data-testid="care"],[data-testid="message-row"],.main-nav').count(), 0, code);
      };
      const observeLate = who => who.page.evaluate(() => {
        window.__opsLateForm = false; window.__opsLateObserver?.disconnect();
        window.__opsLateObserver = new MutationObserver(changes => {
          if (changes.some(change => [...change.addedNodes].some(node => node.nodeType === Node.ELEMENT_NODE &&
            (node.matches('[data-testid="operations-form"]') || node.querySelector('[data-testid="operations-form"]'))))) window.__opsLateForm = true;
        }); window.__opsLateObserver.observe(document.body, { childList: true, subtree: true });
      });
      const noLateForm = async who => {
        await who.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await who.page.evaluate(() => window.__opsLateForm), false, code);
        await who.page.evaluate(() => window.__opsLateObserver.disconnect());
      };

      await advance(`${width}:CENTER_ONLY_LIST_AND_EDITOR`);
      await center.page.bringToFront(); await noClinicalLeak(center);
      assert.equal(await center.page.locator('[data-ops-child]').count(), 2, code);
      await capture(center, 'center-list'); await open(center, ids.conversationId, true);
      assert.equal(await form(center).locator('[name="age"]').inputValue(), '', code);
      assert.equal(await form(center).locator('[name="ageAsOf"]').inputValue(), '', code);
      await fillProfile(center, { name: firstName, age: '0', ageAsOf: today });
      await reachable(form(center).getByRole('button', { name: '기본정보 저장', exact: true }));
      await form(center).locator('[name="name"]').focus(); await center.page.keyboard.press('Tab');
      assert.equal(await form(center).locator('[name="age"]').evaluate(node => node === document.activeElement), true, code);
      await capture(center, 'center-editor-zero-age'); result.keyboard = result.reachability = true;

      await advance(`${width}:REAL_COMMIT_LOSS_AND_EXACT_RETRY`);
      center.fault.loseNext = true; await form(center).getByRole('button', { name: '기본정보 저장', exact: true }).click();
      await form(center).locator('[data-ops-action="retry"]:not([disabled])').waitFor();
      await form(center).locator('[data-ops-error]').filter({ hasText: '저장 결과를 확인하지 못했어요.' }).waitFor();
      assert.equal(center.fault.losses, 1, code); assert.equal(operations.length, 1, code);
      const original = structuredClone(operations[0].body), afterCommit = await savedSnapshot();
      assert.equal(afterCommit.profile[0].age, 0, code); assert.equal(afterCommit.profile[0].revision, 2, code);
      assert.equal(afterCommit.requests.length, 1, code);
      for (const input of await form(center).locator('input').all()) assert.equal(await input.isDisabled(), true, code);
      assert.equal(await center.page.getByRole('button', { name: '입력 취소', exact: true }).isDisabled(), true, code);
      await capture(center, 'unknown-preserved');
      const retried = await submit(center, '같은 요청으로 확인');
      assert.deepEqual(operations[1].body, original, code); assert.deepEqual(retried.receipt, { ...center.fault.receipt, replayed: true }, code);
      assert.deepEqual(await savedSnapshot(), afterCommit, code); result.lostResponseRetry = result.immutableReceipt = result.zeroAge = true;
      assert((await center.page.locator(`[data-ops-child="${ids.conversationId}"]`).innerText()).includes(`0세 · ${today} 기준`), code);

      await advance(`${width}:CLINICAL_READERS_REFRESH`);
      for (const who of [therapist, guardian]) {
        await clinicalChild(who); await workspaceAccountAction(who.page, 'refresh');
        await who.page.getByRole('heading', { name: firstName, exact: true }).waitFor();
        const profile = await request(who, clinicalBase + '/profile'); assert.equal(profile.status, 200, code);
        assert.equal(profile.body.name, firstName, code); assert.equal(profile.body.age, 0, code);
        assert.equal(profile.body.ageAsOf, today, code); assert.equal(profile.body.familyPlan.concern, concern, code);
      }
      result.crossRoleRefresh = true;
      for (const pathname of [`/api/local/centers/${ids.centerId}/inbox`, clinicalBase + '/profile', clinicalBase + '/messages',
        clinicalBase + '/records', clinicalBase + '/family-plan']) assert.equal((await request(center, pathname)).status, 404, code);
      for (const who of [therapist, guardian]) assert.equal((await request(who, endpoint)).status, 404, code);

      await advance(`${width}:NO_OP_AND_EXPLICIT_CLEAR`);
      await open(center); const beforeNoOp = await savedSnapshot(); const noOp = await submit(center);
      assert.equal(noOp.receipt.changed, false, code); const afterNoOp = await savedSnapshot();
      assert.deepEqual(afterNoOp.profile, beforeNoOp.profile, code); assert.deepEqual(afterNoOp.conversation, beforeNoOp.conversation, code);
      assert.equal(afterNoOp.requests.length, beforeNoOp.requests.length + 1, code); result.noOp = true;
      await open(center); const beforeInvalid = operations.length;
      await fillProfile(center, { age: '2', ageAsOf: '' });
      await form(center).getByRole('button', { name: '기본정보 저장', exact: true }).click();
      await form(center).locator('[data-ops-error]').filter({ hasText: '함께 입력' }).waitFor(); assert.equal(operations.length, beforeInvalid, code);
      await fillProfile(center, { age: '2', ageAsOf: tomorrow });
      await form(center).getByRole('button', { name: '기본정보 저장', exact: true }).click();
      assert.equal(await form(center).locator('[name="ageAsOf"]').evaluate(node => node.validity.rangeOverflow), true, code);
      assert.equal(operations.length, beforeInvalid, code); result.invalidPairAndFutureDate = true;
      await fillProfile(center, { age: '', ageAsOf: '' }); await submit(center);
      const cleared = await savedSnapshot(); assert.equal(cleared.profile[0].age, null, code); assert.equal(cleared.profile[0].age_as_of, null, code);
      result.explicitAgeClear = true;

      await advance(`${width}:DRAFT_LIST_RETURN`);
      await open(center); await fillProfile(center, { name: draftName });
      await center.page.getByRole('button', { name: '아이 목록으로', exact: true }).click();
      const entry = center.page.locator(`[data-ops-child="${ids.conversationId}"]`); await entry.waitFor();
      assert((await entry.innerText()).includes('작성 중인 입력 이어보기'), code); await entry.click(); await form(center).waitFor();
      assert.equal(await form(center).locator('[name="name"]').inputValue(), draftName, code);
      await center.page.getByRole('button', { name: '입력 취소', exact: true }).click();
      await center.page.getByTestId('operations-children').waitFor(); result.draftRetained = true;

      await advance(`${width}:ACTUAL_PROFILE_CONFLICT`);
      await open(peer); await fillProfile(peer, { name: peerName });
      await open(center); await fillProfile(center, { name: conflictName }); const heldPost = gate(); center.fault.nextPost = heldPost;
      try {
        const rejectedResponse = center.page.waitForResponse(r => new URL(r.url()).pathname === endpoint && r.request().method() === 'POST' && r.status() === 409);
        void rejectedResponse.catch(() => {});
        await form(center).getByRole('button', { name: '기본정보 저장', exact: true }).click(); await bounded(heldPost.entered.promise, 5000);
        await submit(peer); heldPost.finish(); assert.equal((await (await rejectedResponse).json()).error, 'PROFILE_CONFLICT', code);
        await bounded(heldPost.done.promise, 5000); await form(center).locator('[data-ops-conflict]:not([hidden])').waitFor();
        assert.equal(await form(center).locator('[name="name"]').inputValue(), conflictName, code);
        assert.equal(await form(center).getByRole('button', { name: '기본정보 저장', exact: true }).isDisabled(), true, code);
        await workspaceAccountAction(center.page, 'refresh');
        await form(center).locator('[data-ops-latest]').filter({ hasText: peerName }).waitFor();
        await reachable(center.page.getByRole('button', { name: '현재 입력 유지하고 다시 검토', exact: true }));
        await capture(center, 'actual-conflict-preserved');
        await advance(phase, 'CONFLICT_CAPTURED');
        await center.page.getByRole('button', { name: '현재 입력 유지하고 다시 검토', exact: true }).click();
        assert.equal(await form(center).locator('[name="name"]').inputValue(), conflictName, code);
        await advance(phase, 'CONFLICT_INPUT_KEPT');
        await submit(center); await advance(phase, 'CONFLICT_RECEIPT_RECEIVED');
        assert.equal((await savedSnapshot()).profile[0].name, conflictName, code); await advance(phase, 'CONFLICT_DB_CHECKED');
        result.actualConflict = result.conflictInputPreserved = true;
      } finally { heldPost.finish(); }

      await advance(`${width}:LATE_DETAIL_OTHER_CHILD`);
      await open(center); const heldChild = gate(); center.fault.nextGet = heldChild;
      try {
        await workspaceAccountAction(center.page, 'refresh'); await bounded(heldChild.entered.promise, 5000);
        await advance(phase, 'LATE_CHILD_GET_HELD');
        await center.page.getByRole('button', { name: '아이 목록으로', exact: true }).click();
        await center.page.locator(`[data-ops-child="${extra.conversationId}"]`).click(); await form(center).waitFor();
        assert.equal(await form(center).locator('[name="name"]').inputValue(), extra.name, code); await observeLate(center);
        heldChild.finish(); await bounded(heldChild.done.promise, 5000); await noLateForm(center);
        await advance(phase, 'LATE_CHILD_GATE_RELEASED');
        assert.equal(await form(center).locator('[name="name"]').inputValue(), extra.name, code);
        await capture(center, 'late-other-child'); result.lateChildDiscarded = true;
      } finally { heldChild.finish(); }

      await advance(`${width}:LATE_DETAIL_ACCOUNT_SWITCH`);
      const heldAccount = gate(); center.fault.nextGet = heldAccount; let otherPage;
      try {
        await workspaceAccountAction(center.page, 'refresh'); await bounded(heldAccount.entered.promise, 5000);
        otherPage = await center.context.newPage(); otherPage.setDefaultTimeout(15_000); await otherPage.goto(origin);
        await workspaceAccountAction(otherPage, 'logout'); await login(otherPage, 'guardian');
        await center.page.bringToFront(); await center.page.getByTestId('login-form').waitFor(); await observeLate(center);
        heldAccount.finish(); await bounded(heldAccount.done.promise, 5000); await noLateForm(center);
        assert.equal(await center.page.getByTestId('operations').count(), 0, code);
        assert(!(await center.page.locator('body').innerText()).includes(conflictName), code);
        await capture(center, 'late-account-cleared'); result.lateAccountDiscarded = true;
      } finally { heldAccount.finish(); await otherPage?.close(); }
      await login(center.page, 'center');

      await advance(`${width}:MANAGER_MEMBERSHIP_REVOKED`);
      await open(center); await fillProfile(center, { name: revokedName });
      await sandbox.database.query('UPDATE cb_memberships SET active=false WHERE center_id=$1 AND user_id=$2', [ids.centerId, ids.managerId]);
      await workspaceAccountAction(center.page, 'refresh'); await center.page.getByTestId('login-form').waitFor();
      assert.equal(await form(center).count(), 0, code); assert.equal(await center.page.locator('[data-ops-child]').count(), 0, code);
      assert(!(await center.page.locator('body').innerText()).includes(revokedName), code);
      assert.equal((await request(center, endpoint)).status, 404, code); result.membershipRevoked = true;
      await capture(center, 'revoked-manager-cleared');
      assert.equal(clinicalRequests.length, 0, code); result.operationalOnly = true;
      assert(profileResponses.length > 0, code); result.minimalDto = true;
      assert.deepEqual(await clinicalSnapshot(), baseline, code); result.clinicalDataUnchanged = true;
      for (const who of actors) assert.deepEqual(await who.page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, ''], code);
      result.browserStorageEmpty = result.layout = true;
      assert.equal(report.errors.length, 0, code); assert.equal(report.unexpectedRequests.length, 0, code);
      for (const who of actors) await who.context.close(); pages.clear();
      await sandbox.close(); assert.equal(sandbox.database.closed, true, code); assert.equal(sandbox.credentials.length, 0, code); sandboxes.delete(sandbox);
      ownedSandbox.closed = true; await save('ownership.json', ownership);
      result.cleanup = true; report.checks.push(result); delete report.currentCheck;
      console.log(JSON.stringify({ width, passed: true, boundaries: Object.values(result).filter(value => value === true).length - 1 }));
    }
    report.finalSource = await sources(); assert.equal(report.finalSource.sha256, source.sha256, code);
  } catch (error) {
    report.failure = { code, phase, kind: ['AssertionError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-operations-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      workspaceHelperLine: Number(error?.stack?.match(/local-workspace-browser-helpers\.mjs:(\d+):\d+/)?.[1]) || null };
    if (error?.reachability) report.failure.reachability = error.reachability;
    for (const [label, page] of [...pages].filter(([label]) => isManagerLabel(label)).slice(0, 2)) try {
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
      await bounded(sandbox.close()); assert.equal(sandbox.database.closed, true, code); sandboxes.delete(sandbox); sandboxOwnership.get(sandbox).closed = true;
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
const isManagerLabel = label => label === 'center' || label === 'peer';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runLocalOperationsBrowser()) process.exitCode = 1; }
  catch { console.error('LOCAL_OPERATIONS_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

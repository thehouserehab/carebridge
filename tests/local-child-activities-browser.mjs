// Actual authenticated UI -> HTTP -> owned memory-only PGlite. No native/E data.
// Fixture SQL creates invented accounts/relationships only; clinical writes use UI.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceView, workspaceRecords, workspaceRoom, workspaceAccountAction } from './local-workspace-browser-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const code = 'LOCAL_CHILD_ACTIVITIES_FAILED';
const hash = value => createHash('sha256').update(value).digest('hex');
const assets = new Set(['/', '/favicon.ico', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/client.js', '/local-api/care-client.js',
  '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css', '/local-api/media-client.js',
  '/local-api/media-ui.js', '/local-api/media-viewer.js', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js']);
const snapshotTables = ['cb_messages', 'cb_read_states', 'cb_records', 'cb_record_revisions', 'cb_record_requests',
  'cb_publications', 'cb_activity_feedback', 'cb_feedback_revisions', 'cb_feedback_reviews', 'cb_feedback_requests', 'cb_audit_events'];
async function sources() {
  const names = ['tests/local-child-activities-browser.mjs', 'tests/local-workspace-browser-helpers.mjs',
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
      const rect = value => value ? Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map(key => [key, value[key]])) : null;
      const viewport = r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
      const unobscured = !n || r.bottom <= n.top || r.top >= n.bottom || r.right <= n.left || r.left >= n.right;
      const hits = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + x, r.top + y], [r.right - x, r.top + y],
        [r.left + x, r.bottom - y], [r.right - x, r.bottom - y]].map(([px, py]) => element.contains(document.elementFromPoint(px, py)));
      return { bounds: rect(r), viewport: { width: innerWidth, height: innerHeight }, fixedNav: rect(n),
        connected: element.isConnected, withinViewport: viewport, outsideFixedNav: unobscured, hits, passed: viewport && unobscured && hits.every(Boolean) };
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
async function targetExposure(page, messageId, guardian) {
  // Observe the application's navigation only. Never scroll/focus/click the
  // target here: Playwright auto-scrolling would conceal a broken destination.
  const deadline = Date.now() + 5000; let observation;
  while (Date.now() < deadline) {
    observation = await page.evaluate(({ messageId, guardian }) => {
      const row = document.querySelector(`[data-testid="message-row"][data-message-id="${messageId}"]`);
      const list = row?.closest('[data-testid="message-list"]');
      const nav = document.querySelector('.main-nav');
      const n = nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect() : null;
      const rect = r => r ? Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map(key => [key, Math.round(r[key] * 100) / 100])) : null;
      const elementState = node => {
        if (!node) return { present: false, passed: false };
        const r = node.getBoundingClientRect();
        let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent), p = parent.getBoundingClientRect();
          if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) {
            left = Math.max(left, p.left + parent.clientLeft); right = Math.min(right, p.left + parent.clientLeft + parent.clientWidth);
          }
          if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)) {
            top = Math.max(top, p.top + parent.clientTop); bottom = Math.min(bottom, p.top + parent.clientTop + parent.clientHeight);
          }
        }
        const withinClip = r.width > 0 && r.height > 0 && r.left >= left - .5 && r.top >= top - .5 && r.right <= right + .5 && r.bottom <= bottom + .5;
        const outsideNav = !n || r.bottom <= n.top || r.top >= n.bottom || r.right <= n.left || r.left >= n.right;
        const x = Math.min(4, r.width / 4), y = Math.min(4, r.height / 4);
        const hits = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + x, r.top + y], [r.right - x, r.top + y],
          [r.left + x, r.bottom - y], [r.right - x, r.bottom - y]].map(([px, py]) => node.contains(document.elementFromPoint(px, py)));
        return { present: true, connected: node.isConnected, bounds: rect(r), clip: { left, top, right, bottom },
          withinClip, outsideNav, hits, passed: node.isConnected && withinClip && outsideNav && hits.every(Boolean) };
      };
      const title = elementState(row?.querySelector('.care-activity h3'));
      const action = guardian ? elementState(row?.querySelector('[data-care-action="feedback"]')) : null;
      // A long card need not fit its heading and action into the same 300px
      // scroller. Initial arrival is the title; action reachability is separate.
      return { passed: title.passed, title, action,
        viewport: { width: innerWidth, height: innerHeight, scrollY }, fixedNav: rect(n),
        list: list ? { bounds: rect(list.getBoundingClientRect()), scrollTop: list.scrollTop, scrollHeight: list.scrollHeight, clientHeight: list.clientHeight } : null,
        target: row ? { bounds: rect(row.getBoundingClientRect()), offsetTop: row.offsetTop, targetClass: row.classList.contains('target') } : null };
    }, { messageId, guardian });
    if (observation.passed) return observation;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
  const error = new Error(code); error.name = 'AssertionError'; error.targetExposure = observation; throw error;
}
async function fixture(sandbox) {
  const suffix = randomUUID(), ids = sandbox.ids;
  const extra = { childId: `activity-child-${suffix}`, conversationId: `activity-room-${suffix}`, futureId: `activity-guardian-${suffix}` };
  await sandbox.database.transaction(async tx => {
    await tx.query('INSERT INTO cb_users(id,active) VALUES ($1,true)', [extra.futureId]);
    await tx.query("INSERT INTO cb_memberships(center_id,user_id,role,active) VALUES ($1,$2,'guardian',true)", [ids.centerId, extra.futureId]);
    await tx.query("INSERT INTO cb_member_profiles(center_id,user_id,display_name,revision) VALUES ($1,$2,'가상 새 보호자',1)", [ids.centerId, extra.futureId]);
    await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)', [ids.centerId, extra.childId]);
    await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)', [ids.centerId, extra.conversationId, extra.childId]);
    await tx.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
      VALUES ($1,$2,$3,'therapist',true,1),($1,$2,$4,'guardian',true,1)`,
    [ids.centerId, extra.conversationId, ids.therapistId, ids.guardianId]);
    await tx.query(`INSERT INTO cb_child_profiles(center_id,child_id,name,age,age_as_of,revision,updated_by)
      VALUES ($1,$2,'가상 다른 아이',NULL,NULL,1,$3)`, [ids.centerId, extra.childId, ids.therapistId]);
  });
  const { Auth } = await import('../server/auth.mjs');
  const credential = { role: 'future', email: `future.${suffix}@carebridge.test`, password: randomBytes(24).toString('base64url') };
  sandbox.credentials.push(credential);
  await new Auth(sandbox.database).provisionAccount({ userId: extra.futureId, email: credential.email, password: credential.password });
  return extra;
}

export async function runLocalChildActivitiesBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const filename of [options.module, options.executable]) {
    const info = await lstat(filename); assert(info.isFile() && !info.isSymbolicLink(), code);
  }
  const source = await sources(), { chromium } = await import(pathToFileURL(options.module).href);
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-child-activities-${runId}`); await mkdir(folder);
  const report = { runId, startedAt: new Date().toISOString(), source, passed: false, checks: [], screenshots: [], errors: [], unexpectedRequests: [],
    failure: null, cleanupObservationTimedOut: false, cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Owned Chromium, invented accounts and memory-only PGlite; no E/native engine, actual child data, external listener or deployment.',
      '390/768/1440 viewport checks are not physical-device or human usability evidence.',
      'Record, publication, activity feedback and withdrawal writes use visible UI. SQL only creates synthetic relationships/accounts or changes relationship authority.',
      'Past-history suppression and withdrawn publication are exercised. There is no publication self-hide UI, and this test does not invent one.',
      'No attachment upload or inspection is part of this activity-navigation test; no API success or data is fabricated.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, finished: false };
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  const note = (list, value) => { if (list.length < 32) list.push(value); };
  const contexts = new Set(), sandboxes = new Set(), pages = new Map();
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
      const base = `/api/local/centers/${ids.centerId}/conversations/${ids.conversationId}`;
      const title = `가상 활동 연결 기록 ${width}`, privateNote = `가상 내부 계획 비공개 ${width}`;
      const oldTitle = `가상 함께 선택하며 이어가는 긴 제목의 활동 첫 안내 ${width}`;
      const newTitle = `가상 함께 선택하며 이어가는 긴 제목의 활동 새 안내 ${width}`;
      const oldInstruction = `가상 첫 번째 활동의 구체 안내 ${width}`, newInstruction = `가상 새 활동의 구체 안내 ${width}`;
      const caution = `가상 활동에서 확인할 주의사항 ${width}`, reaction = `가상 보호자가 전한 활동 경험 ${width}`;
      const operations = [], guardianPrivate = [], reads = [];
      const result = { width, recordSharedThroughUi: false, bothRolesCurrentActivities: false, summaryOnly: false,
        childViewNoReadOrWrite: false, exactTargetBothRoles: false, guardianFeedback: false, therapistReceived: false,
        otherChildIsolation: false, futureHistoryExcluded: false, reshareCurrentOnly: false, withdrawalRemoved: false,
        relationshipRevoked: false, noGuardianPrivateRead: false, keyboard: false, reachability: false,
        layout: false, browserStorageEmpty: false, cleanup: false };
      report.currentCheck = result;
      const actor = async label => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR',
          isMobile: width <= 640, hasTouch: width <= 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context); context.once('close', () => contexts.delete(context)); assert.equal((await context.cookies()).length, 0, code);
        await context.route('**/*', async route => {
          const request = route.request(), target = new URL(request.url()), method = request.method();
          const primaryRead = method === 'GET' && target.pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
            [...target.searchParams].length === 1 && [ids.conversationId, extra.conversationId].includes(target.searchParams.get('conversationId'));
          const api = /^\/api\/local\/(?:auth\/(?:login|session|logout)|centers\/[A-Za-z0-9_-]+\/(?:inbox|conversations\/[A-Za-z0-9_-]+\/(?:profile|read|goals|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+)?|records(?:\/[A-Za-z0-9_-]+(?:\/(?:preview|publish))?)?|feedback\/[A-Za-z0-9_-]+(?:\/review)?|publications\/[A-Za-z0-9_-]+\/withdraw)))$/.test(target.pathname);
          if (target.origin !== origin || !['GET', 'POST', 'HEAD'].includes(method) || !((assets.has(target.pathname) && ['GET', 'HEAD'].includes(method)) || api || primaryRead)) {
            note(report.unexpectedRequests, { width, label, phase, sameOrigin: target.origin === origin,
              method: ['GET', 'POST', 'HEAD'].includes(method) ? method : 'OTHER' }); return route.abort().catch(() => {});
          }
          if (label !== 'therapist' && /\/(?:records|feedback\/[^/]+\/review)(?:\/|$)/.test(target.pathname)) guardianPrivate.push({ label, phase });
          if (method === 'POST' && !target.pathname.startsWith('/api/local/auth/')) {
            const operation = { label, pathname: target.pathname, body: structuredClone(request.postDataJSON()) }; operations.push(operation);
            if (target.pathname.endsWith('/read')) reads.push(operation);
          }
          return route.continue().catch(() => {});
        });
        if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => {
          note(report.unexpectedRequests, { width, label, phase, type: 'websocket' }); socket.close();
        });
        const page = await context.newPage(); page.setDefaultTimeout(15_000); pages.set(label, page);
        page.on('pageerror', () => note(report.errors, { width, label, phase, type: 'pageerror' }));
        page.on('console', entry => { if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:')) note(report.errors, { width, label, phase, type: 'console' }); });
        await page.goto(origin); await page.getByTestId('login-form').waitFor();
        const credential = sandbox.credentials.find(item => item.role === label); assert(credential.email.endsWith('.test'), code);
        await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click(); await page.getByTestId('home').waitFor();
        return { context, page, label, userId: label === 'future' ? extra.futureId : ids[`${label}Id`] };
      };
      const therapist = await actor('therapist'), guardian = await actor('guardian'), actors = [therapist, guardian];
      const dialog = who => who.page.getByTestId('care-dialog');
      const section = who => who.page.getByTestId('child-activities');
      const exactRow = (who, messageId) => who.page.locator(`[data-testid="message-row"][data-message-id="${messageId}"]`);
      const field = (who, name) => dialog(who).locator(`[name="${name}"]`);
      const fill = async (who, name, value) => { const input = field(who, name); await reveal(input); await input.fill(value); };
      const request = async (who, suffix) => {
        const response = await who.context.request.get(origin + base + suffix, { timeout: 15_000, maxRedirects: 0, headers: { 'X-Carebridge-Account': who.userId } });
        try { return { status: response.status(), body: await response.json() }; } finally { await response.dispose(); }
      };
      const messages = async who => { const response = await request(who, '/messages?limit=100'); assert.equal(response.status, 200, code); return response.body.messages; };
      const clinicalSnapshot = async () => {
        const value = {};
        for (const table of snapshotTables) value[table] = (await sandbox.database.query(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE center_id=$1 ORDER BY to_jsonb(t)::text`, [ids.centerId])).rows;
        return value;
      };
      const child = async (who, roomId = ids.conversationId) => {
        await who.page.bringToFront(); await workspaceView(who.page, 'child'); await who.page.locator('#child-select:not([disabled])').waitFor();
        if (await who.page.locator('#child-select').inputValue() !== roomId) await who.page.locator('#child-select').selectOption(roomId);
        await who.page.waitForFunction(id => document.querySelector('#child-select')?.value === id && !document.querySelector('#child-select')?.disabled, roomId);
        await section(who).waitFor();
      };
      const refreshChild = async (who, roomId = ids.conversationId) => {
        await child(who, roomId); await workspaceAccountAction(who.page, 'refresh');
        await who.page.locator('#child-select:not([disabled])').waitFor(); await section(who).waitFor();
      };
      const activityIds = who => section(who).locator('button[data-open-room][data-target-id]').evaluateAll(buttons => buttons.map(button => button.dataset.targetId));
      const awaitActivities = async (who, expected) => {
        await who.page.waitForFunction(ids => {
          const section = document.querySelector('[data-testid="child-activities"]');
          const actual = [...(section?.querySelectorAll('button[data-open-room][data-target-id]') ?? [])].map(button => button.dataset.targetId);
          return !!section && JSON.stringify(actual.sort()) === JSON.stringify([...ids].sort());
        }, expected);
        assert.deepEqual((await activityIds(who)).sort(), [...expected].sort(), code);
      };
      const capture = async (who, name) => {
        assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code);
        if (await dialog(who).isVisible()) assert.equal(await dialog(who).evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, code);
        const filename = `${width}-${name}.png`; assert(!report.screenshots.some(item => item.filename === filename), code);
        await who.page.screenshot({ path: path.join(folder, filename), fullPage: false,
          mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]'), who.page.locator('.workspace-head .account')] });
        report.screenshots.push({ width, filename, syntheticOnly: true });
      };
      const submit = async (who, name, suffix, expected = 201) => {
        const [response] = await Promise.all([who.page.waitForResponse(r => new URL(r.url()).pathname === base + suffix && r.request().method() === 'POST'),
          dialog(who).getByRole('button', { name, exact: true }).click()]);
        assert.equal(response.status(), expected, code); const body = await response.json(); await dialog(who).waitFor({ state: 'hidden' }); return body;
      };
      const openRecord = async (id = null) => {
        await therapist.page.bringToFront(); await workspaceRecords(therapist.page, ids.conversationId);
        await therapist.page.locator(id ? `[data-care-action="edit-record"][data-record-id="${id}"]` : '[data-care-action="new-record"]').click();
        await dialog(therapist).locator('form[data-care-form="record"]').waitFor();
      };
      const publish = async recordId => {
        await workspaceRecords(therapist.page, ids.conversationId);
        await therapist.page.locator(`[data-care-action="preview-record"][data-record-id="${recordId}"]`).click();
        await dialog(therapist).locator('form[data-care-form="publish"]').waitFor();
        assert(!(await dialog(therapist).innerText()).includes(privateNote), code);
        await field(therapist, 'confirmed').check(); const body = await submit(therapist, '확인하고 공유', `/records/${recordId}/publish`);
        assert(body.receipt?.messageId, code);
        const published = await request(therapist, `/messages/${body.receipt.messageId}`);
        assert.equal(published.status, 200, code); assert(published.body.message?.publication?.id, code);
        return published.body.message;
      };
      const openActivity = async (who, message, keyboard = false, label = 'initial') => {
        await child(who); const button = section(who).locator(`[data-open-room="${ids.conversationId}"][data-target-id="${message.id}"]`);
        await reachable(button); await capture(who, `${who.label}-activity-link-${label}`);
        if (keyboard) { await button.focus(); await button.press('Enter'); } else await button.click();
        await exactRow(who, message.id).waitFor();
        await who.page.waitForFunction(id => document.querySelector(`[data-testid="message-row"][data-message-id="${id}"]`)?.classList.contains('target'), message.id);
        assert.equal(await exactRow(who, message.id).evaluate(node => node.classList.contains('target')), true, code);
        assert((await exactRow(who, message.id).innerText()).includes(message.publication.activity.instruction), code);
        assert((await exactRow(who, message.id).innerText()).includes(caution), code);
        await targetExposure(who.page, message.id, who.label !== 'therapist');
        await capture(who, `${who.label}-visible-target-${label}`);
        if (who.label !== 'therapist') {
          // Only AFTER unassisted title arrival may the user scroll farther
          // through a long card to reach its activity feedback action.
          await reachable(exactRow(who, message.id).locator('[data-care-action="feedback"]'));
          await capture(who, `${who.label}-reachable-feedback-${label}`);
        }
      };

      phase = `${width}:UI_RECORD_AND_PUBLICATION`;
      await openRecord();
      for (const [name, value] of Object.entries({ title, performed: '가상 직접 관찰', response: '가상 참여 반응', nextPlan: '가상 다음 계획',
        summary: `가상 보호자 공유 요약 ${width}`, privateNote, activityTitle: oldTitle, activityInstruction: oldInstruction,
        activityFrequency: '가상 하루 한 번 편한 시간에', activityCaution: caution })) await fill(therapist, name, value);
      await field(therapist, 'goalId').selectOption(ids.goalId);
      const saveResponse = therapist.page.waitForResponse(r => new URL(r.url()).pathname.startsWith(base + '/records/') && r.request().method() === 'POST');
      await dialog(therapist).getByRole('button', { name: '기록 저장', exact: true }).click();
      const saved = await saveResponse; assert.equal(saved.status(), 201, code); const recordId = new URL(saved.url()).pathname.split('/').at(-1);
      assert.equal((await saved.json()).receipt.revision, 1, code); await dialog(therapist).waitFor({ state: 'hidden' });
      const first = await publish(recordId); result.recordSharedThroughUi = true;

      phase = `${width}:CHILD_CURRENT_ACTIVITIES_NO_WRITE`;
      const beforeView = await clinicalSnapshot(), beforeOperations = operations.length, beforeReads = reads.length;
      for (const who of actors) {
        await refreshChild(who); await awaitActivities(who, [first.id]);
        const text = await section(who).innerText(); assert(text.includes(oldTitle), code); assert(text.includes('가상 하루 한 번 편한 시간에'), code);
        for (const secret of [oldInstruction, caution, privateNote]) assert(!text.includes(secret), code);
        await section(who).getByRole('heading', { name: '공유 중인 가정 활동', exact: true }).waitFor();
        await reachable(section(who).locator('button[data-target-id]')); await capture(who, `${who.label}-child-activities`);
      }
      assert.equal(operations.length, beforeOperations, code); assert.equal(reads.length, beforeReads, code);
      assert.deepEqual(await clinicalSnapshot(), beforeView, code);
      result.bothRolesCurrentActivities = result.summaryOnly = result.childViewNoReadOrWrite = true;
      result.reachability = true;

      phase = `${width}:OTHER_CHILD_ISOLATION`;
      for (const who of actors) {
        await child(who, extra.conversationId); await awaitActivities(who, []);
        assert(!(await section(who).innerText()).includes(oldTitle), code);
        assert.equal(await section(who).locator(`[data-open-room="${ids.conversationId}"]`).count(), 0, code);
      }
      result.otherChildIsolation = true;

      phase = `${width}:FUTURE_PARTICIPANT_HISTORY`;
      await sandbox.database.transaction(async tx => {
        const { rows } = await tx.query('SELECT last_sequence FROM cb_conversations WHERE center_id=$1 AND id=$2 FOR UPDATE', [ids.centerId, ids.conversationId]);
        await tx.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
          VALUES ($1,$2,$3,'guardian',true,$4)`, [ids.centerId, ids.conversationId, extra.futureId, Number(rows[0].last_sequence) + 1]);
      });
      const future = await actor('future'); actors.push(future); await child(future); await awaitActivities(future, []);
      const past = await request(future, `/messages/${first.id}`); assert.equal(past.status, 404, code);
      assert(!(await future.page.locator('body').innerText()).includes(oldInstruction), code);
      await capture(future, 'future-no-past-activity'); result.futureHistoryExcluded = true;

      phase = `${width}:EXACT_TARGET_AND_FEEDBACK`;
      await openActivity(therapist, first, true); await openActivity(guardian, first, true);
      result.exactTargetBothRoles = result.keyboard = true;
      await exactRow(guardian, first.id).locator('[data-care-action="feedback"]').click();
      await dialog(guardian).locator('form[data-care-form="feedback"]').waitFor();
      await field(guardian, 'result').selectOption('partial'); await fill(guardian, 'reaction', reaction); await fill(guardian, 'difficulty', '가상 도움 요청');
      const feedbackResponse = guardian.page.waitForResponse(r => new URL(r.url()).pathname.startsWith(base + '/feedback/') && r.request().method() === 'POST');
      await dialog(guardian).getByRole('button', { name: '활동 경험 저장', exact: true }).click();
      const feedbackSaved = await feedbackResponse; assert.equal(feedbackSaved.status(), 201, code);
      const feedbackReceipt = (await feedbackSaved.json()).receipt; assert(feedbackReceipt.feedbackId && feedbackReceipt.messageId, code);
      await dialog(guardian).waitFor({ state: 'hidden' }); result.guardianFeedback = true;
      await therapist.page.bringToFront(); await workspaceRoom(therapist.page, ids.conversationId);
      await workspaceAccountAction(therapist.page, 'refresh');
      await exactRow(therapist, feedbackReceipt.messageId).waitFor();
      assert((await exactRow(therapist, feedbackReceipt.messageId).innerText()).includes(reaction), code);
      const { rows: feedbackCount } = await sandbox.database.query('SELECT count(*)::integer AS count FROM cb_activity_feedback WHERE center_id=$1 AND id=$2', [ids.centerId, feedbackReceipt.feedbackId]);
      assert.equal(feedbackCount[0].count, 1, code); result.therapistReceived = true;
      await capture(therapist, 'therapist-feedback-received');

      phase = `${width}:RESHARE_NEW_TARGET_ONLY`;
      await openRecord(recordId); await fill(therapist, 'activityTitle', newTitle); await fill(therapist, 'activityInstruction', newInstruction);
      await submit(therapist, '기록 저장', `/records/${recordId}`); const second = await publish(recordId);
      assert.notEqual(second.id, first.id, code);
      for (const who of actors) {
        await refreshChild(who); await awaitActivities(who, [second.id]); assert(!(await section(who).innerText()).includes(oldTitle), code);
      }
      await openActivity(guardian, second, false, 'reshared'); result.reshareCurrentOnly = true;
      await capture(guardian, 'new-publication-target');

      phase = `${width}:WITHDRAWAL_REMOVES_ACTIVITY`;
      await workspaceRoom(therapist.page, ids.conversationId); await therapist.page.bringToFront();
      await exactRow(therapist, second.id).locator('[data-care-action="withdraw"]').click();
      await submit(therapist, '공유 종료 확인', `/publications/${second.id}/withdraw`, 200);
      for (const who of actors) {
        await refreshChild(who); await awaitActivities(who, []);
        const text = await section(who).innerText(); assert(!text.includes(oldTitle) && !text.includes(newTitle), code);
      }
      const hidden = (await messages(guardian)).find(message => message.id === second.id);
      assert.equal(hidden?.hidden, true, code); assert.equal(hidden?.publication ?? null, null, code);
      await capture(guardian, 'withdrawn-activity-absent'); result.withdrawalRemoved = true;

      phase = `${width}:RELATIONSHIP_REVOKED_ON_CHILD_PAGE`;
      await therapist.page.bringToFront(); const third = await publish(recordId);
      await refreshChild(guardian); await awaitActivities(guardian, [third.id]);
      await sandbox.database.transaction(async tx => {
        await tx.query('SELECT id FROM cb_conversations WHERE center_id=$1 AND id=$2 FOR UPDATE', [ids.centerId, ids.conversationId]);
        await tx.query('UPDATE cb_participants SET active=false WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3', [ids.centerId, ids.conversationId, ids.guardianId]);
      });
      await workspaceAccountAction(guardian.page, 'refresh');
      await guardian.page.locator(`#child-select option[value="${ids.conversationId}"]`).waitFor({ state: 'detached' });
      await child(guardian, extra.conversationId); await awaitActivities(guardian, []);
      assert.equal(await guardian.page.locator(`[data-target-id="${third.id}"]`).count(), 0, code);
      assert(!(await guardian.page.locator('body').innerText()).includes(newTitle), code);
      assert.equal((await request(guardian, `/messages/${third.id}`)).status, 404, code);
      await refreshChild(therapist); await awaitActivities(therapist, [third.id]);
      await capture(guardian, 'revoked-activity-absent'); result.relationshipRevoked = true;
      assert.equal(guardianPrivate.length, 0, code); result.noGuardianPrivateRead = true;
      for (const who of actors) assert.deepEqual(await who.page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, ''], code);
      result.browserStorageEmpty = result.layout = true;
      assert.equal(report.errors.length, 0, code); assert.equal(report.unexpectedRequests.length, 0, code);
      for (const who of actors) await who.context.close(); pages.clear();
      await sandbox.close(); assert.equal(sandbox.database.closed, true, code); assert.equal(sandbox.credentials.length, 0, code); sandboxes.delete(sandbox);
      result.cleanup = true; report.checks.push(result); delete report.currentCheck;
      console.log(JSON.stringify({ width, passed: true, boundaries: Object.values(result).filter(value => value === true).length - 1 }));
    }
    report.finalSource = await sources(); assert.equal(report.finalSource.sha256, source.sha256, code);
  } catch (error) {
    report.failure = { code, phase, kind: ['AssertionError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-child-activities-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      workspaceHelperLine: Number(error?.stack?.match(/local-workspace-browser-helpers\.mjs:(\d+):\d+/)?.[1]) || null };
    if (error?.reachability) report.failure.reachability = error.reachability;
    if (error?.targetExposure) report.failure.targetExposure = error.targetExposure;
    for (const [label, page] of [...pages].slice(0, 2)) try {
      const filename = `failure-${label}.png`; await page.screenshot({ path: path.join(folder, filename), fullPage: false,
        mask: [page.locator('input[type="email"]'), page.locator('input[type="password"]'), page.locator('.workspace-head .account')] });
      report.screenshots.push({ filename, syntheticOnly: true, failure: true });
    } catch { note(report.errors, { phase, type: 'failure-screenshot' }); }
  } finally {
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
  try { if (!await runLocalChildActivitiesBrowser()) process.exitCode = 1; }
  catch { console.error('LOCAL_CHILD_ACTIVITIES_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

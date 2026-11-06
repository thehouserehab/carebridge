// Current local-api A/B/C preparation, not a human study or a baseline UI comparison.
// The caller owns new synthetic memory-only sandboxes and nonpersistent browser contexts.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TASK_A, TASK_B, studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceRecords, workspaceRoom, workspaceAccountAction } from './local-workspace-browser-helpers.mjs';
import { createLocalP0StudyFixture, LOCAL_P0_TASK_C_SUMMARY } from './local-p0-study-fixture.mjs';
import { verifyRecordActionLayout, verifyPendingRecordActions } from './local-record-action-browser-helpers.mjs';
import { verifyHomeNewsLayout } from './local-home-news-browser-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const code = 'LOCAL_P0_STUDY_PREPARATION_FAILED';
const hash = value => createHash('sha256').update(value).digest('hex');
const assets = new Set(['/', '/favicon.ico', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/client.js', '/local-api/care-client.js',
  '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css', '/local-api/media-client.js',
  '/local-api/media-ui.js', '/local-api/media-viewer.js', '/local-api/approval-pending-ui.js',
  '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js']);
const assessmentKeys = ['tool', 'item', 'value', 'unit', 'context'];

export async function captureLocalP0StudySources() {
  const names = ['tests/local-p0-study-browser.mjs', 'tests/local-record-action-browser-helpers.mjs', 'tests/local-p0-study-fixture.mjs',
    'tests/local-home-news-browser-helpers.mjs', 'tests/local-home-news-layout.test.mjs', 'tests/local-product-ui.test.mjs',
    'tests/local-primary-communicator-browser-helpers.mjs', 'tests/local-primary-communicator.test.mjs', 'tests/local-chat-layout.test.mjs',
    'tests/local-composer-editing-browser-helpers.mjs',
    'tests/local-p0-study-fixture.test.mjs', 'tests/local-workspace-browser-helpers.mjs',
    'tests/message-browser-policy.mjs', 'scripts/p0-study-policy.mjs', 'scripts/local-p0-study.mjs',
    'scripts/local-p0-study-preflight.mjs', 'tests/local-p0-study-cli.test.mjs',
    'tests/local-p0-study-preflight.test.mjs', 'docs/p0-user-validation.md'];
  const walk = async directory => {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), code);
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(name);
      else if (/\.(?:mjs|js|css|html|sql)$/.test(entry.name)) { assert(entry.isFile(), code); names.push(name); }
    }
  };
  for (const directory of ['local-api', 'src', 'server']) await walk(directory);
  const files = [];
  for (const name of [...new Set(names)].sort()) {
    const filename = path.join(root, name), info = await lstat(filename);
    assert(info.isFile() && !info.isSymbolicLink(), code);
    files.push({ name, sha256: hash(await readFile(filename)) });
  }
  return { sha256: hash(JSON.stringify(files)), files };
}

async function bounded(work, milliseconds = 30_000) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

function processLifetime(child) {
  assert(child && Number.isInteger(child.pid), code);
  const streams = [...new Set((child.stdio ?? []).filter(Boolean))], done = Promise.withResolvers();
  let exited = child.exitCode !== null || child.signalCode !== null, closed = false;
  const terminal = () => exited && closed && streams.every(stream => stream.closed === true);
  const changed = () => { if (terminal()) done.resolve(); };
  child.once('exit', () => { exited = true; changed(); }); child.once('close', () => { closed = true; changed(); });
  for (const stream of streams) stream.once('close', changed);
  return { terminal, done: done.promise };
}

async function reveal(input) {
  for (const details of await input.locator('xpath=ancestor::details').all())
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
}

// Only the immutable starting material is compared. Sessions, read cursors,
// room revision counters and the task's NEW record/feedback are intentionally excluded.
async function startingMaterial(fixture) {
  const { sandbox, records, publication, rooms } = fixture;
  const recordIds = Object.values(records), roomIds = rooms.map(room => room.conversationId);
  const definitions = [
    ['records', 'cb_records', 'id', recordIds],
    ['revisions', 'cb_record_revisions', 'record_id', recordIds],
    ['assessments', 'cb_record_assessments', 'record_id', recordIds],
    ['references', 'cb_record_references', 'record_id', recordIds],
    ['recordRequests', 'cb_record_requests', 'record_id', recordIds],
    ['publications', 'cb_publications', 'id', [publication.publicationId]],
    ['recordPublications', 'cb_record_publications', 'publication_id', [publication.publicationId]],
    ['recipients', 'cb_record_recipients', 'publication_id', [publication.publicationId]],
    ['publicationMessage', 'cb_messages', 'id', [publication.messageId]],
    ['profiles', 'cb_child_profiles', 'child_id', rooms.map(room => room.childId)],
    ['familyPlans', 'cb_child_family_plans', 'child_id', rooms.map(room => room.childId)],
    ['memberProfiles', 'cb_member_profiles', 'user_id', [sandbox.ids.therapistId, sandbox.ids.guardianId]],
    ['goals', 'cb_goals', 'conversation_id', roomIds],
    ['goalRevisions', 'cb_goal_revisions', 'conversation_id', roomIds],
    ['appointments', 'cb_appointments', 'conversation_id', roomIds],
    ['appointmentRevisions', 'cb_appointment_revisions', 'conversation_id', roomIds],
    ['participants', 'cb_participants', 'conversation_id', roomIds],
  ];
  const result = {};
  for (const [name, table, column, ids] of definitions) {
    // Table/column names come only from the fixed allowlist above; IDs are parameters.
    result[name] = (await sandbox.database.query(`SELECT to_jsonb(t) AS value FROM ${table} t
      WHERE center_id=$1 AND ${column}=ANY($2::text[]) ORDER BY to_jsonb(t)::text`, [sandbox.ids.centerId, ids])).rows.map(row => row.value);
  }
  assert.equal(result.records.length, 2, code); assert.equal(result.publications.length, 1, code);
  return result;
}

async function taskCounts(sandbox) {
  return (await sandbox.database.query(`SELECT
    (SELECT count(*)::integer FROM cb_records WHERE center_id=$1) AS records,
    (SELECT count(*)::integer FROM cb_publications WHERE center_id=$1) AS publications,
    (SELECT count(*)::integer FROM cb_activity_feedback WHERE center_id=$1) AS feedback`, [sandbox.ids.centerId])).rows[0];
}

function privateMarkers(material) {
  const publicText = JSON.stringify([material.publications, material.recordPublications]);
  return [...new Set([
    ...material.revisions.flatMap(row => [row.private_note, row.performed, row.response, row.next_plan]),
    ...material.assessments.flatMap(row => [row.tool, row.item, row.context]),
  ].filter(value => typeof value === 'string' && value.length >= 4 && !publicText.includes(value)))];
}

export async function runLocalP0StudyBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const filename of [options.module, options.executable]) {
    const info = await lstat(filename); assert(info.isFile() && !info.isSymbolicLink(), code);
  }
  const source = await captureLocalP0StudySources(), { chromium } = await import(pathToFileURL(options.module).href);
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-p0-study-${runId}`);
  await mkdir(folder);
  const report = { runId, startedAt: new Date().toISOString(), source, passed: false, checks: [], screenshots: [],
    errors: [], unexpectedRequests: [], failure: null, humanMetricsCollected: false, humanTaskCompletion: false,
    cleanupObservationTimedOut: false, cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['This is current local-api preparation only; no baseline UI or design-improvement percentage is measured.',
      'A/B preserve the same task information, not identical storage, full conversation history or experimental conditions.',
      'Initial material is seeded separately by domain services; seeding is not UI task completion. The sandbox notice remains.',
      'C verifies the exact shared summary and reply location, not a human explanation or comprehension score.',
      'Fresh Chromium 390/1440 viewports, home-only 320x740 and record-only 320x640/844x390 checks are not physical-device, VoiceOver or human usability evidence.',
      'Record action checks exercise browser keyboard focus only, not physical mobile keyboards or an accessibility audit.',
      'Synthetic accounts, authenticated loopback HTTP and memory-only PGlite only; no E drive, Docker, external access or native media.',
      'Reload/reopen verifies saved data, not API restart, cross-device delivery or unsaved-draft durability.',
      'No automated task timing, action counts or participant responses are collected.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, finished: false };
  const contexts = new Set(), closingContexts = new WeakSet(), sandboxes = new Set(), pages = new Map();
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  const note = (list, value) => { if (list.length < 32) list.push(value); };
  const stopped = Promise.withResolvers(); void stopped.promise.catch(() => {});
  let asyncFailure = false, browserServer, browser, lifetime, phase = 'STARTUP';
  const stop = () => { asyncFailure = true; stopped.reject(new Error(code)); };
  const step = async (name, operation) => {
    phase = name; assert(!asyncFailure, code);
    const value = await Promise.race([operation(), stopped.promise]); assert(!asyncFailure, code); return value;
  };
  await save('ownership.json', ownership);
  try {
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    lifetime = processLifetime(browserServer.process()); ownership.browserProcessId = browserServer.process().pid;
    await save('ownership.json', ownership); browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    for (const width of [390, 1440]) for (const task of ['A', 'B', 'C']) {
      const prefix = `${width}:${task}`, fixture = await step(`${prefix}:FIXTURE`, () => createLocalP0StudyFixture(task, { port: 0 }));
      const { sandbox, rooms, publication } = fixture; sandboxes.add(sandbox);
      const { origin, ids } = sandbox, url = new URL(origin), room = rooms[0];
      assert(url.origin === origin && url.hostname === '127.0.0.1' && url.protocol === 'http:' && url.port && !url.username && !url.password, code);
      assert.equal(fixture.task, task, code); assert.equal(fixture.evidence.setupOnly, true, code);
      assert.equal(fixture.evidence.uiTaskCompleted, false, code); assert.equal(fixture.evidence.humanMetricsCollected, false, code);
      const initial = await step(`${prefix}:STARTING_MATERIAL`, () => startingMaterial(fixture));
      assert.deepEqual(await step(`${prefix}:INITIAL_COUNTS`, () => taskCounts(sandbox)), { records: 2, publications: 1, feedback: 0 }, code);
      assert(!initial.revisions.some(record => record.title === TASK_B.title), code);
      const initialHash = hash(JSON.stringify(initial)), forbidden = privateMarkers(initial), writes = [], actors = [];
      let recordSaveGate = null;
      assert(forbidden.length > 0, code);
      const base = `/api/local/centers/${ids.centerId}/conversations/${room.conversationId}`;
      const result = { width, task, origin, baselineCommit: fixture.baselineCommit, baselineSeedBlob: fixture.baselineSeedBlob, day: fixture.day,
        initialMaterialSha256: initialHash, homeEntry: false, uiWriteVerified: false, preparedReadingOnly: task === 'C',
        apiRead: false, reloadReopen: false, sourceUnchanged: false, guardianPrivate: false, layout: false, cleanup: false };
      report.currentCheck = result;
      const homeReady = async page => {
        await page.getByTestId('home').waitFor();
        // The shell can exist before authorization and inbox refresh finish.
        // Only a rendered child entry proves this starting surface is ready.
        await page.getByTestId('home').locator(`[data-home-news] [data-open-room="${room.conversationId}"]`).waitFor();
        assert.equal(await page.locator('button[data-view="home"]:visible').getAttribute('aria-current'), 'page', code);
        assert((await page.getByTestId('home').innerText()).includes(room.name), code);
      };
      const actor = async role => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul',
          isMobile: width <= 640, hasTouch: width <= 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context); context.once('close', () => contexts.delete(context));
        assert.equal((await context.cookies()).length, 0, code);
        await context.route('**/*', async route => {
          if (closingContexts.has(context)) return route.abort().catch(() => {});
          try {
            const request = route.request(), target = new URL(request.url()), method = request.method();
            const auth = /^\/api\/local\/auth\/(?:login|session|logout)$/.test(target.pathname);
            const inbox = target.pathname === `/api/local/centers/${ids.centerId}/inbox`;
            const allowedRooms = role === 'guardian' ? [room] : rooms;
            const primaryRead = method === 'GET' && target.pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
              [...target.searchParams].length === 1 && allowedRooms.some(item => item.conversationId === target.searchParams.get('conversationId'));
            const suffix = allowedRooms.map(item => `/api/local/centers/${ids.centerId}/conversations/${item.conversationId}`)
              .find(start => target.pathname.startsWith(start + '/'));
            const part = suffix ? target.pathname.slice(suffix.length) : '';
            const roomApi = /^\/(?:profile|read|goals|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+)?|records(?:\/[A-Za-z0-9_-]+(?:\/preview)?)?|feedback\/[A-Za-z0-9_-]+)$/.test(part);
            const clinicalWrite = method === 'POST' && suffix === base &&
              ((task === 'A' && role === 'guardian' && /^\/feedback\/[A-Za-z0-9_-]+$/.test(part)) ||
               (task === 'B' && role === 'therapist' && /^\/records\/[A-Za-z0-9_-]+$/.test(part)));
            const read = ['GET', 'HEAD'].includes(method), ordinaryPost = method === 'POST' &&
              ((auth && target.pathname !== '/api/local/auth/session') || (roomApi && part === '/read'));
            if (target.origin !== origin || !((read && (assets.has(target.pathname) || auth || inbox || roomApi || primaryRead)) || ordinaryPost || clinicalWrite) ||
                (role === 'guardian' && part.startsWith('/records'))) {
              note(report.unexpectedRequests, { width, task, role, phase, sameOrigin: target.origin === origin,
                method: ['GET', 'POST', 'HEAD'].includes(method) ? method : 'OTHER' }); stop(); return route.abort().catch(() => {});
            }
            if (clinicalWrite) writes.push({ role, kind: task === 'A' ? 'feedback' : 'record',
              id: part.split('/').at(-1), body: structuredClone(request.postDataJSON()) });
            if (clinicalWrite && task === 'B' && recordSaveGate) {
              const gate = recordSaveGate; recordSaveGate = null;
              gate.hit.resolve(); await gate.release.promise;
            }
            await route.continue();
          } catch {
            if (!closingContexts.has(context)) { note(report.errors, { width, task, role, phase, type: 'route' }); stop(); }
            await route.abort().catch(() => {});
          }
        });
        if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => {
          note(report.unexpectedRequests, { width, task, role, phase, type: 'websocket' }); stop(); socket.close();
        });
        const page = await context.newPage(); page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(20_000);
        const label = `${width}-${task}-${role}`; pages.set(label, page);
        page.on('pageerror', () => { note(report.errors, { width, task, role, phase, type: 'pageerror' }); stop(); });
        page.on('console', entry => {
          if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:')) {
            note(report.errors, { width, task, role, phase, type: 'console' }); stop();
          }
        });
        const who = { page, context, role, userId: ids[role + 'Id'], label }; actors.push(who);
        const credential = sandbox.credentials.find(item => item.role === role); assert(credential?.email.endsWith('.test'), code);
        await page.goto(origin); await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click(); await homeReady(page); return who;
      };
      const dialog = who => who.page.getByTestId('care-dialog');
      const input = (who, name) => dialog(who).locator(`[name="${name}"]`);
      const fill = async (who, name, value) => { const element = input(who, name); await reveal(element); await element.fill(String(value)); };
      const get = async (who, pathname, status = 200) => {
        assert(pathname.startsWith(`/api/local/centers/${ids.centerId}/`), code);
        const response = await who.context.request.get(origin + pathname, { maxRedirects: 0, timeout: 15_000,
          headers: { 'X-Carebridge-Account': who.userId } });
        try { assert.equal(response.status(), status, code); return await response.json(); } finally { await response.dispose(); }
      };
      const messages = async who => {
        const value = await get(who, base + '/messages?limit=100'); assert.equal(value.hasMore, false, code); return value.messages;
      };
      const capture = async (who, name, { fullPage = false } = {}) => {
        assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code);
        if (await dialog(who).isVisible()) assert.equal(await dialog(who).evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, code);
        const filename = `${width}-${task}-${name}.png`;
        await who.page.screenshot({ path: path.join(folder, filename), fullPage,
          mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]'), who.page.locator('.workspace-head .account')] });
        report.screenshots.push({ filename, ...who.page.viewportSize(), fullPage, task, syntheticOnly: true });
      };
      const homePublication = async (who, activation = null) => {
        const entry = who.page.getByTestId('home').locator(`[data-home-news] [data-open-room="${room.conversationId}"][data-target-id="${publication.messageId}"]`);
        await entry.waitFor(); assert((await entry.innerText()).includes(room.name), code);
        if (activation) { await entry.focus(); await entry.press(activation); result.homeKeyboard = activation === ' ' ? 'Space' : activation; }
        else await entry.click();
        await who.page.locator(`[data-testid="message-row"][data-message-id="${publication.messageId}"]`).waitFor();
        assert.equal(await who.page.locator('#room-title').textContent(), room.name, code); result.homeEntry = true;
      };
      const card = who => who.page.locator(`[data-publication-id="${publication.publicationId}"]`);
      const checkPublication = async who => {
        await card(who).waitFor(); assert.equal(await card(who).locator(':scope > p').nth(1).textContent(), fixture.expected.summary, code);
        assert((await card(who).innerText()).includes(fixture.expected.activity.title), code);
        const source = (await messages(who)).find(message => message.id === publication.messageId);
        assert(source && !source.archived && !source.hidden && !source.deleted, code);
        assert.equal(source.publication.id, publication.publicationId, code); assert.equal(source.publication.summary, fixture.expected.summary, code);
        assert.deepEqual(source.publication.activity, fixture.expected.activity, code); return source;
      };
      const inspectSummary = who => card(who).locator(':scope > p').nth(1).evaluate(summary => {
        const pane = summary.closest('[data-testid="message-list"]'), bounds = pane.getBoundingClientRect();
        const clip = { left: Math.max(0, bounds.left + pane.clientLeft), top: Math.max(0, bounds.top + pane.clientTop),
          right: Math.min(innerWidth, bounds.left + pane.clientLeft + pane.clientWidth),
          bottom: Math.min(innerHeight, bounds.top + pane.clientTop + pane.clientHeight) };
        const range = document.createRange(); range.selectNodeContents(summary);
        const lines = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => {
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
            visible: rect.left >= clip.left - 1 && rect.right <= clip.right + 1
              && rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1 && !!hit && summary.contains(hit) };
        });
        return { clip, paneScrollTop: pane.scrollTop, pageScrollY: scrollY, lines };
      });
      const verifySummaryReading = async (who, name) => {
        // Observe entry before trial-click actionability can scroll the page.
        // Later scrolling must never turn a failed initial position into a pass.
        const entry = await inspectSummary(who);
        await capture(who, `${name}-entry`);
        assert(entry.lines.length > 0 && entry.lines[0].visible, `${code}:SUMMARY_ENTRY`);
        await card(who).getByRole('button', { name: '인용 답장', exact: true }).click({ trial: true });
        const afterTrial = await inspectSummary(who); await capture(who, name);
        assert.equal(afterTrial.lines.length, entry.lines.length, code);
        const seen = new Set(), reading = []; let current = afterTrial, wheelUsed = false;
        for (let attempt = 0; attempt <= 12; attempt++) {
          reading.push(current);
          current.lines.forEach((line, index) => { if (line.visible) seen.add(index); });
          if (seen.size === entry.lines.length) break;
          assert(attempt < 12, `${code}:SUMMARY_SCROLL_LIMIT`);
          const target = current.lines.find((line, index) => !seen.has(index));
          const direction = target.top < current.clip.top ? -1 : 1;
          const height = current.clip.bottom - current.clip.top;
          assert(height > 32 && current.clip.right > current.clip.left, `${code}:SUMMARY_PANE`);
          await who.page.mouse.move((current.clip.left + current.clip.right) / 2,
            (current.clip.top + current.clip.bottom) / 2);
          await who.page.mouse.wheel(0, direction * Math.max(32, Math.floor(height / 2))); wheelUsed = true;
          await who.page.waitForFunction(previous => {
            const pane = document.querySelector('[data-testid="message-list"]');
            return pane && (Math.abs(pane.scrollTop - previous.paneScrollTop) > 1
              || Math.abs(scrollY - previous.pageScrollY) > 1);
          }, { paneScrollTop: current.paneScrollTop, pageScrollY: current.pageScrollY }, { timeout: 3000 });
          current = await inspectSummary(who);
          assert.equal(current.lines.length, entry.lines.length, code);
        }
        assert.equal(seen.size, entry.lines.length, `${code}:SUMMARY_LINES`);
        await capture(who, `${name}-readable`);
        return { entry, afterTrial, reading, wheelUsed, allLinesObserved: true };
      };
      const saveTask = async (who, kind, buttonName) => {
        const [response] = await Promise.all([who.page.waitForResponse(response => {
          const target = new URL(response.url()); return target.origin === origin && response.request().method() === 'POST' &&
            new RegExp(`^${base}/${kind}/[A-Za-z0-9_-]+$`).test(target.pathname);
        }), dialog(who).getByRole('button', { name: buttonName, exact: true }).click()]);
        assert.equal(response.status(), 201, code); const receipt = (await response.json()).receipt;
        assert.equal(receipt.revision, 1, code); assert.equal(receipt.operation, 'save', code); assert.equal(receipt.replayed, false, code);
        await dialog(who).waitFor({ state: 'hidden' }); return receipt;
      };
      const guardianBoundary = async (who, extra = []) => {
        const response = await get(who, `/api/local/centers/${ids.centerId}/inbox?limit=100&offset=0`);
        assert.equal(response.hasMore, false, code); assert.deepEqual(response.rooms.map(item => item.conversationId), [room.conversationId], code);
        const data = await messages(who), text = JSON.stringify(data), visible = await who.page.locator('body').innerText();
        for (const marker of [...forbidden, ...extra]) { assert(!text.includes(marker), code); assert(!visible.includes(marker), code); }
        const inspect = value => {
          if (!value || typeof value !== 'object') return;
          for (const [key, child] of Object.entries(value)) {
            assert(!['privateNote', 'assessments', 'performed', 'response', 'nextPlan', 'observation'].includes(key), code); inspect(child);
          }
        };
        inspect(data);
        assert.equal(await who.page.locator('[data-care-action="new-record"],[data-care-action="edit-record"],[data-care-action="reuse-record"]').count(), 0, code);
        // This explicit negative API GET is verification only, not a UI request or write.
        const denied = await who.context.request.get(`${origin}${base}/records/${fixture.records.r1}`, {
          maxRedirects: 0, timeout: 15_000, headers: { 'X-Carebridge-Account': who.userId } });
        try { assert([403, 404].includes(denied.status()), code); } finally { await denied.dispose(); }
        result.guardianPrivate = true;
      };

      const who = await step(`${prefix}:LOGIN`, () => actor(task === 'B' ? 'therapist' : 'guardian'));
      await step(`${prefix}:HOME_LAYOUT`, async () => {
        await capture(who, 'home');
        result.homeNewsLayout = await verifyHomeNewsLayout({ page: who.page, capture: name => capture(who, name) });
      });
      if (task === 'A') {
        await step(`${prefix}:HOME_SHARED_ACTIVITY`, async () => { await homePublication(who, 'Enter'); await checkPublication(who); });
        await step(`${prefix}:ACTIVITY_INPUT`, async () => {
          await card(who).getByRole('button', { name: '활동 경험 남기기', exact: true }).click(); await dialog(who).waitFor();
          await fill(who, 'date', fixture.day); await input(who, 'result').selectOption(TASK_A.result);
          await fill(who, 'reaction', TASK_A.reaction); await fill(who, 'difficulty', TASK_A.difficulty); await capture(who, 'activity-input');
        });
        const receipt = await step(`${prefix}:ACTIVITY_UI_SAVE`, () => saveTask(who, 'feedback', '활동 경험 저장'));
        const stored = await step(`${prefix}:ACTIVITY_API_READ`, async () => {
          const { message } = await get(who, `${base}/feedback/${receipt.feedbackId}`);
          assert.equal(message.id, receipt.messageId, code); assert.equal(message.authorId, ids.guardianId, code);
          assert.equal(message.feedback.publicationId, publication.publicationId, code); assert.equal(message.feedback.revision, 1, code);
          for (const [key, value] of Object.entries({ date: fixture.day, ...TASK_A })) assert.equal(message.feedback[key], value, code);
          assert.equal((await messages(who)).filter(item => item.type === 'feedback').length, 1, code); return message;
        });
        assert.equal(writes.length, 1, code); assert.equal(writes[0].id, receipt.feedbackId, code);
        assert.deepEqual(writes[0].body.content, { date: fixture.day, ...TASK_A }, code);
        assert.equal(writes[0].body.sourceMessageId, publication.messageId, code); result.uiWriteVerified = result.apiRead = true;
        await step(`${prefix}:ACTIVITY_RELOAD_REOPEN`, async () => {
          await who.page.reload(); await homeReady(who.page); await workspaceRoom(who.page, room.conversationId);
          const feedbackCard = who.page.locator(`[data-feedback-id="${receipt.feedbackId}"]`);
          await feedbackCard.getByRole('button', { name: '활동 경험 수정', exact: true }).click(); await dialog(who).waitFor();
          for (const [key, value] of Object.entries({ date: fixture.day, ...TASK_A })) assert.equal(await input(who, key).inputValue(), value, code);
          const fresh = (await get(who, `${base}/feedback/${receipt.feedbackId}`)).message;
          assert.deepEqual(fresh.feedback, stored.feedback, code); await capture(who, 'activity-reopened');
          await dialog(who).getByRole('button', { name: '닫기', exact: true }).click(); await dialog(who).waitFor({ state: 'hidden' });
        });
        await step(`${prefix}:GUARDIAN_BOUNDARY`, () => guardianBoundary(who));
      } else if (task === 'B') {
        await step(`${prefix}:HOME_RECORD_ENTRY`, async () => {
          await workspaceRecords(who.page, room.conversationId);
          await who.page.locator('[data-care-action="new-record"]').click(); await dialog(who).waitFor();
          assert.equal(await dialog(who).locator('[data-care-child]').textContent(), room.name, code); result.homeEntry = true;
        });
        await step(`${prefix}:RECORD_ACTION_LAYOUT`, async () => {
          result.recordActions = await verifyRecordActionLayout({ page: who.page, dialog: dialog(who),
            capture: name => capture(who, name), assertNoWrites: () => assert.equal(writes.length, 0, code) });
        });
        await step(`${prefix}:RECORD_INPUT`, async () => {
          await fill(who, 'date', fixture.day); await input(who, 'goalId').selectOption(room.goalIds[0]);
          for (const key of ['title', 'performed', 'response', 'nextPlan', 'summary']) await fill(who, key, TASK_B[key]);
          for (const [index, row] of TASK_B.assessments.entries()) {
            const add = dialog(who).locator('[data-care-action="add-assessment"]'); await reveal(add); await add.click();
            for (const [key, value] of Object.entries(row)) await fill(who, `assessment-${index}-${key}`, value);
          }
          await capture(who, 'record-input');
        });
        const receipt = await step(`${prefix}:RECORD_UI_SAVE`, async () => {
          // Delay this real request before server handling, without fabricating
          // a success or changing its body. Always release on inspection failure.
          const gate = { hit: Promise.withResolvers(), release: Promise.withResolvers() };
          recordSaveGate = gate;
          const saved = saveTask(who, 'records', '기록 저장'); void saved.catch(() => {});
          try {
            await bounded(gate.hit.promise, 10_000);
            result.pendingRecordActions = await verifyPendingRecordActions({ page: who.page, dialog: dialog(who) });
            await capture(who, 'record-actions-pending');
          } finally { gate.release.resolve(); recordSaveGate = null; }
          return await saved;
        });
        const stored = await step(`${prefix}:RECORD_API_READ`, async () => {
          const { record } = await get(who, `${base}/records/${receipt.recordId}`);
          assert(!Object.values(fixture.records).includes(record.id), code); assert.equal(record.status, 'saved', code);
          assert.equal(record.revision, 1, code); assert.equal(record.date, fixture.day, code); assert.equal(record.goalId, room.goalIds[0], code);
          for (const key of ['title', 'performed', 'response', 'nextPlan', 'summary']) assert.equal(record[key], TASK_B[key], code);
          assert.deepEqual(record.assessments.map(row => Object.fromEntries(assessmentKeys.map(key => [key, row[key]]))), TASK_B.assessments, code);
          assert.equal(record.privateNote, '', code); assert.equal(record.attachmentCount, 0, code); return record;
        });
        assert.equal(writes.length, 1, code); assert.equal(writes[0].id, receipt.recordId, code);
        assert.equal(writes[0].body.content.status, 'saved', code); result.uiWriteVerified = result.apiRead = true;
        await step(`${prefix}:RECORD_RELOAD_REOPEN`, async () => {
          await who.page.reload(); await homeReady(who.page); await workspaceRecords(who.page, room.conversationId);
          await who.page.locator(`[data-care-action="edit-record"][data-record-id="${receipt.recordId}"]`).click(); await dialog(who).waitFor();
          for (const [key, value] of Object.entries({ date: fixture.day, goalId: room.goalIds[0],
            ...Object.fromEntries(['title', 'performed', 'response', 'nextPlan', 'summary'].map(key => [key, TASK_B[key]])) }))
            assert.equal(await input(who, key).inputValue(), value, code);
          const rows = await dialog(who).locator('[data-assessment-row]').evaluateAll(rows => rows.map(row =>
            Object.fromEntries([...row.querySelectorAll('[data-assessment-field]')].map(field => [field.dataset.assessmentField, field.value]))));
          assert.deepEqual(rows, TASK_B.assessments.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, String(value)]))), code);
          assert.deepEqual((await get(who, `${base}/records/${receipt.recordId}`)).record, stored, code);
          await capture(who, 'record-reopened'); await dialog(who).getByRole('button', { name: '닫기', exact: true }).click();
        });
        await step(`${prefix}:RECORD_UNCHANGED_CLOSE_AND_PREVIEW`, async () => {
          const resume = who.page.locator('[data-care-action="resume"]');
          const openRecord = async () => {
            await who.page.locator(`[data-care-action="edit-record"][data-record-id="${receipt.recordId}"]`).click();
            await dialog(who).locator('[data-care-form="record"]').waitFor();
          };
          const preview = async (id, title) => {
            await who.page.locator(`[data-care-action="preview-record"][data-record-id="${id}"]`).click();
            await dialog(who).getByRole('heading', { name: '공유 미리보기', exact: true }).waitFor();
            assert.equal(await dialog(who).locator('.care-share-preview > h3').textContent(), title, code);
            assert.equal(writes.length, 1, code);
            await capture(who, id === receipt.recordId ? 'record-clean-preview' : 'record-other-preview');
            await dialog(who).getByRole('button', { name: '입력 취소', exact: true }).click();
            await dialog(who).waitFor({ state: 'hidden' });
          };
          await dialog(who).waitFor({ state: 'hidden' });
          assert.equal(await resume.count(), 0, code);
          await preview(receipt.recordId, TASK_B.title);
          await openRecord();
          // Merely expanding measurements, including numeric zero, is not an edit.
          await reveal(input(who, 'assessment-1-value'));
          assert.equal(await input(who, 'assessment-1-value').inputValue(), '0', code);
          await who.page.keyboard.press('Escape'); await dialog(who).waitFor({ state: 'hidden' });
          assert.equal(await resume.count(), 0, code);
          const otherTitle = (await get(who, `${base}/records/${fixture.records.r1}`)).record.title;
          await preview(fixture.records.r1, otherTitle);
          await openRecord();
          const changedSummary = `${TASK_B.summary} 가상 수정 보존 확인`;
          await fill(who, 'summary', changedSummary); await fill(who, 'assessment-1-value', '');
          await dialog(who).getByRole('button', { name: '닫기', exact: true }).click();
          await dialog(who).waitFor({ state: 'hidden' }); assert.equal(await resume.count(), 1, code);
          await who.page.locator(`[data-care-action="preview-record"][data-record-id="${fixture.records.r1}"]`).click();
          await dialog(who).locator('[data-care-form="record"]').waitFor();
          assert.equal(await input(who, 'title').inputValue(), TASK_B.title, code);
          assert.equal(await input(who, 'summary').inputValue(), changedSummary, code);
          assert.equal(await input(who, 'assessment-1-value').inputValue(), '', code);
          assert.deepEqual((await get(who, `${base}/records/${receipt.recordId}`)).record, stored, code);
          await capture(who, 'record-dirty-preserved');
          await fill(who, 'summary', TASK_B.summary); await fill(who, 'assessment-1-value', '0');
          await dialog(who).getByRole('button', { name: '닫기', exact: true }).click();
          await dialog(who).waitFor({ state: 'hidden' }); assert.equal(await resume.count(), 0, code);
          await who.page.locator('[data-care-action="new-record"]').click(); await dialog(who).waitFor();
          await dialog(who).getByRole('button', { name: '닫기', exact: true }).click();
          await dialog(who).waitFor({ state: 'hidden' }); assert.equal(await resume.count(), 1, code);
          await who.page.locator(`[data-care-action="preview-record"][data-record-id="${receipt.recordId}"]`).click();
          await dialog(who).getByRole('heading', { name: '새 기록', exact: true }).waitFor();
          await dialog(who).getByRole('button', { name: '입력 취소', exact: true }).click();
          await dialog(who).waitFor({ state: 'hidden' }); assert.equal(await resume.count(), 0, code);
          assert.equal(writes.length, 1, code);
          assert.deepEqual((await get(who, `${base}/records/${receipt.recordId}`)).record, stored, code);
          result.recordClose = { unchangedClose: true, unchangedEscape: true, directSamePreview: true,
            directOtherPreview: true, dirtyValuesPreserved: true, restoredValuesClose: true,
            emptyNewDraftPreserved: true, noAdditionalWrites: true };
        });
        const guardian = await step(`${prefix}:GUARDIAN_LOGIN`, () => actor('guardian'));
        await step(`${prefix}:GUARDIAN_BOUNDARY`, async () => {
          await homePublication(guardian); await checkPublication(guardian);
          await guardianBoundary(guardian, [TASK_B.title, TASK_B.performed, TASK_B.response, TASK_B.nextPlan,
            ...TASK_B.assessments.map(row => row.item)]); await capture(guardian, 'guardian-existing-share-only');
        });
      } else {
        assert.equal(fixture.expected.summary, LOCAL_P0_TASK_C_SUMMARY, code);
        await step(`${prefix}:HOME_EXACT_SUMMARY`, async () => {
          await homePublication(who, ' '); await checkPublication(who);
          result.summaryReading = await verifySummaryReading(who, 'shared-summary');
        });
        result.apiRead = true;
        await step(`${prefix}:SUMMARY_RELOAD_REOPEN`, async () => {
          await who.page.reload(); await homeReady(who.page); await homePublication(who); await checkPublication(who);
          result.summaryReadingReopened = await verifySummaryReading(who, 'shared-summary-reopened');
          await guardianBoundary(who);
        });
        assert.equal(writes.length, 0, code);
      }
      result.reloadReopen = result.layout = true;
      await step(`${prefix}:SOURCE_UNCHANGED`, async () => {
        const after = await startingMaterial(fixture); assert.deepEqual(after, initial, code);
        result.finalMaterialSha256 = hash(JSON.stringify(after)); assert.equal(result.finalMaterialSha256, initialHash, code);
        const totals = await taskCounts(sandbox);
        assert.deepEqual(totals, { records: 2 + Number(task === 'B'), publications: 1, feedback: Number(task === 'A') }, code);
        result.sourceUnchanged = true;
      });
      await step(`${prefix}:LOGOUT_AND_CLEANUP`, async () => {
        for (const actor of actors) {
          await actor.page.bringToFront();
          if (await dialog(actor).isVisible()) await dialog(actor).getByRole('button', { name: '닫기', exact: true }).click();
          await workspaceAccountAction(actor.page, 'logout'); await actor.page.getByTestId('login-form').waitFor();
          closingContexts.add(actor.context); await bounded(actor.context.close()); pages.delete(actor.label);
        }
        assert.equal(contexts.size, 0, code);
        await bounded(sandbox.close()); assert.equal(sandbox.database.closed, true, code); assert.equal(sandbox.credentials.length, 0, code);
        sandboxes.delete(sandbox); result.cleanup = true;
      });
      report.checks.push(result); delete report.currentCheck;
      console.log(JSON.stringify({ width, task, preparationPassed: true, humanMetricsCollected: false }));
    }
    report.finalSource = await captureLocalP0StudySources(); assert.equal(report.finalSource.sha256, source.sha256, code);
  } catch (error) {
    report.failure = { code, phase, kind: ['AssertionError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-p0-study-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      workspaceHelperLine: Number(error?.stack?.match(/local-workspace-browser-helpers\.mjs:(\d+):\d+/)?.[1]) || null };
    report.failure.recordActionHelperLine = Number(error?.stack?.match(/local-record-action-browser-helpers\.mjs:(\d+):\d+/)?.[1]) || null;
    report.failure.recordActionStage = error?.recordActionStage ?? null;
    report.failure.recordActionGeometry = error?.recordActionGeometry ?? null;
    report.failure.homeNewsHelperLine = Number(error?.stack?.match(/local-home-news-browser-helpers\.mjs:(\d+):\d+/)?.[1]) || null;
    if (/^LOCAL_HOME_NEWS_LAYOUT:[a-z0-9:-]+$/.test(error?.message ?? '')) {
      report.failure.homeNewsStage = error.message.slice('LOCAL_HOME_NEWS_LAYOUT:'.length);
      report.failure.homeNewsGeometry = error.homeNewsGeometry ?? null;
    }
    for (const [label, page] of [...pages].slice(0, 2)) try {
      const filename = `failure-${label}.png`; await bounded(page.screenshot({ path: path.join(folder, filename), fullPage: true,
        mask: [page.locator('input[type="email"]'), page.locator('input[type="password"]'), page.locator('.workspace-head .account')] }), 5000);
      report.screenshots.push({ filename, syntheticOnly: true, failure: true });
    } catch { note(report.errors, { phase, type: 'failure-screenshot' }); }
  } finally {
    for (const context of contexts) try { closingContexts.add(context); await bounded(context.close()); contexts.delete(context); } catch { report.cleanupObservationTimedOut = true; }
    report.cleanup.contextsClosed = contexts.size === 0;
    if (browserServer) {
      try { await bounded(browser?.close()); await bounded(browserServer.close()); await bounded(lifetime.done); }
      catch { report.cleanupObservationTimedOut = true; try { await bounded(browserServer.kill()); await bounded(lifetime.done); } catch {} }
      report.cleanup.browserStopped = lifetime?.terminal() === true;
    } else report.cleanup.browserStopped = true;
    // An unconfirmed browser shutdown is not authority to dispose its live backend.
    if (report.cleanup.browserStopped) for (const sandbox of sandboxes) try {
      await bounded(sandbox.close()); assert.equal(sandbox.database.closed, true, code); sandboxes.delete(sandbox);
    } catch { report.failure ??= { code, phase: 'SANDBOX_CLEANUP', kind: 'Error' }; }
    report.cleanup.sandboxesClosed = sandboxes.size === 0; report.finishedAt = new Date().toISOString();
    report.passed = !report.failure && !report.cleanupObservationTimedOut && report.checks.length === 6 &&
      report.errors.length === 0 && report.unexpectedRequests.length === 0 && Object.values(report.cleanup).every(Boolean);
    ownership.finished = Object.values(report.cleanup).every(Boolean); ownership.cleanup = report.cleanup;
    await save('ownership.json', ownership); await save('results.json', report);
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length, failure: report.failure,
    cleanup: report.cleanup, humanMetricsCollected: false }));
  return report.passed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runLocalP0StudyBrowser()) process.exitCode = 1; }
  catch { console.error('LOCAL_P0_STUDY_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

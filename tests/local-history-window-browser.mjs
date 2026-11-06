// Actual Chrome -> authenticated loopback HTTP -> fresh memory-only PGlite.
// Bulk SQL is explicitly fixture preparation; subsequent sends and feedback use UI.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment, TASK_A } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { createLocalP0StudyFixture } from './local-p0-study-fixture.mjs';
import { workspaceRoom, workspaceView } from './local-workspace-browser-helpers.mjs';
import { getPendingSyntheticCleanup } from '../server/local-sandbox-cleanup.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const code = 'LOCAL_HISTORY_WINDOW_FAILED', preparedMessages = 2105;
const hash = value => createHash('sha256').update(value).digest('hex');
const assets = new Set(['/', '/favicon.ico', '/local-api/app.js', '/local-api/client.js', '/local-api/care-client.js',
  '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css', '/local-api/media-client.js',
  '/local-api/media-ui.js', '/local-api/media-viewer.js', '/local-api/approval-pending-ui.js',
  '/local-api/care-recipient-client.js', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js']);
async function sources() {
  const names = ['tests/local-history-window-browser.mjs', 'tests/local-workspace-browser-helpers.mjs',
    'tests/local-p0-study-fixture.mjs', 'tests/message-browser-policy.mjs', 'scripts/p0-study-policy.mjs'];
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
async function bounded(operation, ms = 30_000) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); })]); }
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

// Keep the real publication/clinical history intact. Real database constraints,
// immutable text-history triggers and attachment sealing stay enabled.
async function seedLongHistory(fixture) {
  const { sandbox, rooms, publication } = fixture, { database, ids } = sandbox;
  const roomId = rooms[0].conversationId, prefix = `history-${randomUUID()}`;
  const prepared = Array.from({ length: preparedMessages }, (_, index) => {
    const body = `가상 긴 대화 ${index + 1}: 화면 탐색 시험만을 위한 일반 소식입니다. 실제 사람 정보가 아닙니다.`;
    return { id: `${prefix}-${index + 1}`, client_id: `${prefix}-${index + 1}`,
      request_hash: hash(JSON.stringify({ kind: 'text', body, replyTo: null })), body, ordinal: index + 1 };
  });
  await database.transaction(async tx => {
    const previous = (await tx.query('SELECT last_sequence FROM cb_conversations WHERE center_id=$1 AND id=$2 FOR UPDATE',
      [ids.centerId, roomId])).rows[0];
    assert(previous, code);
    await tx.query(`INSERT INTO cb_messages
      (center_id,conversation_id,id,sequence,author_id,client_id,request_hash,kind,body,attachments_sealed)
      SELECT $1,$2,p.id,$3::bigint+p.ordinal,$4,p.client_id,p.request_hash,'text',p.body,true
      FROM jsonb_to_recordset($5::jsonb) AS p(id text,client_id text,request_hash text,body text,ordinal integer)
      ORDER BY p.ordinal`, [ids.centerId, roomId, Number(previous.last_sequence), ids.therapistId, JSON.stringify(prepared)]);
    await tx.query('UPDATE cb_conversations SET last_sequence=last_sequence+$3,revision=revision+$3 WHERE center_id=$1 AND id=$2',
      [ids.centerId, roomId, preparedMessages]);
  });
  const counts = (await database.query(`SELECT count(*)::integer AS total,max(sequence)::text AS latest
    FROM cb_messages WHERE center_id=$1 AND conversation_id=$2`, [ids.centerId, roomId])).rows[0];
  assert(counts.total > 2000, code);
  const old = (await database.query('SELECT sequence FROM cb_messages WHERE center_id=$1 AND conversation_id=$2 AND id=$3',
    [ids.centerId, roomId, publication.messageId])).rows[0];
  assert(old && Number(old.sequence) < Number(counts.latest) - 2000, code);
  assert.equal((await database.query(`SELECT count(*)::integer AS count FROM cb_message_text_heads
    WHERE center_id=$1 AND conversation_id=$2 AND message_id LIKE $3`, [ids.centerId, roomId, `${prefix}-%`])).rows[0].count,
  preparedMessages, code);
  return { total: counts.total, latestSequence: Number(counts.latest), latestId: prepared.at(-1).id,
    publicationSequence: Number(old.sequence), fixtureOnly: true };
}

async function verifyShortHistoryControls({ page, capture }) {
  const originalViewport = page.viewportSize(), input = page.getByLabel('메시지', { exact: true });
  const primary = page.locator('.primary-communicator-details'), participants = page.locator('.room-participants');
  const originalDraft = await input.inputValue();
  const originalPrimary = await primary.count() ? await primary.getAttribute('open') !== null : null;
  const originalParticipants = await participants.getAttribute('open') !== null;
  const draft = '가상 짧은 화면에서 이전 소식을 찾는 중인 미전송 초안입니다.';
  const evidence = []; let stage = 'setup', latest, mainError;
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const observe = async label => {
    stage = label; await settle();
    latest = await page.evaluate(() => {
      const rect = element => {
        const r = element.getBoundingClientRect();
        return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height };
      };
      const inspect = element => {
        if (!element) return null;
        const box = rect(element), style = getComputedStyle(element);
        let visible = element.getClientRects().length > 0 && box.width > 0 && box.height > 0
          && style.display !== 'none' && style.visibility !== 'hidden'
          && box.left >= -1 && box.top >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
        for (let parent = element.parentElement; visible && parent; parent = parent.parentElement) {
          const clip = rect(parent), overflow = getComputedStyle(parent);
          if (/(auto|scroll|hidden|clip)/.test(overflow.overflowX)) visible = box.left >= clip.left - 1 && box.right <= clip.right + 1;
          if (visible && /(auto|scroll|hidden|clip)/.test(overflow.overflowY)) visible = box.top >= clip.top - 1 && box.bottom <= clip.bottom + 1;
        }
        const owns = (x,y) => { const hit = document.elementFromPoint(x,y); return hit === element || element.contains(hit); };
        const dx = Math.min(5,box.width / 4), dy = Math.min(5,box.height / 4);
        return { box, visible, accessible:visible && [[box.left+box.width/2,box.top+box.height/2],
          [box.left+dx,box.top+dy],[box.right-dx,box.bottom-dy]].every(point => owns(...point)),
          focused:document.activeElement === element };
      };
      const tools = document.querySelector('[data-chat-tools]'), list = document.querySelector('[data-testid="message-list"]');
      const controls = document.querySelector('[data-history-controls]');
      const record = document.querySelector('[data-chat-care] [data-care-action="new-record"]');
      return { viewport:{ width:innerWidth,height:innerHeight }, outerScrollY:scrollY, pageWidth:document.documentElement.scrollWidth,
        nav:inspect(document.querySelector('.main-nav')), input:inspect(document.querySelector('.composer textarea')),
        send:inspect(document.querySelector('.composer button[type="submit"]')), messages:inspect(list),
        newRecord:inspect(record), recordInsideTools:!!record && !!tools && tools.contains(record),
        history:inspect(document.querySelector('[data-action="history-older"]')),
        historyVisible:!!controls && !controls.hidden, historyInsideTools:!!tools && tools.contains(controls),
        tools:tools ? { box:rect(tools), scrollTop:tools.scrollTop, clientHeight:tools.clientHeight, scrollHeight:tools.scrollHeight } : null,
        primaryOpen:document.querySelector('.primary-communicator-details')?.open === true,
        participantsOpen:document.querySelector('.room-participants')?.open === true };
    });
    evidence.push({ label, ...latest });
    assert(latest.pageWidth <= latest.viewport.width + 1, code);
    assert(latest.nav?.accessible && latest.input?.accessible && latest.send?.accessible, code);
    assert(latest.input.box.bottom <= latest.nav.box.top + 1 && latest.send.box.bottom <= latest.nav.box.top + 1, code);
    assert(latest.send.box.height >= 43.5 && latest.historyVisible && latest.historyInsideTools && latest.tools, code);
    assert(latest.messages?.box.height > 0, code);
    return latest;
  };
  const stableComposer = (before, after) => {
    assert(Math.abs(before.outerScrollY - after.outerScrollY) <= 1, code);
    assert(Math.abs(before.input.box.top - after.input.box.top) <= 1 && Math.abs(before.send.box.bottom - after.send.box.bottom) <= 1, code);
  };
  const disclosure = async (details, open) => {
    if (!await details.count() || (await details.getAttribute('open') !== null) === open) return;
    const summary = details.locator(':scope > summary'); await summary.focus(); await summary.press('Enter'); await settle();
    assert.equal(await details.getAttribute('open') !== null, open, code);
  };
  try {
    await page.setViewportSize({ width:390,height:420 });
    // First observation precedes any focus/scroll rescue of the short layout.
    const initial = await observe('initial-short-history'); await capture('entry');
    await input.fill(draft);
    const editing = await observe('draft-entered'); stableComposer(initial,editing);
    const older = page.locator('[data-action="history-older"]');
    await older.scrollIntoViewIfNeeded(); await older.focus();
    const focused = await observe('history-control-focused'); stableComposer(editing,focused);
    assert(focused.history.accessible && focused.history.focused && focused.history.box.height >= 43.5, code);
    if (!editing.history.accessible) assert(Math.abs(focused.tools.scrollTop - editing.tools.scrollTop) > 1, code);
    assert.equal(await input.inputValue(),draft,code);
    await capture('history-control-focused');

    if (originalPrimary !== null) {
      await disclosure(primary,true);
      const opened = await observe('primary-open');
      // Disclosures may redistribute the bounded chrome, but must never move
      // the outer page or make the composer inaccessible (checked by observe).
      assert(Math.abs(editing.outerScrollY - opened.outerScrollY) <= 1, code);
      assert(opened.primaryOpen,code); assert.equal(await input.inputValue(),draft,code); await capture('primary-open');
      const record = page.locator('[data-chat-care] [data-care-action="new-record"]');
      if (await record.count()) {
        // Opening the full-width disclosure may move the therapist action into
        // the next tools row. Native Tab must reveal it within that scroll
        // container, without a corrective scroll or submitting a record.
        await primary.locator(':scope > summary').focus();
        const beforeTab = await observe('primary-record-tab-start');
        stableComposer(opened,beforeTab);
        await page.keyboard.press('Tab');
        const recordFocused = await observe('primary-record-keyboard-focused');
        stableComposer(beforeTab,recordFocused);
        assert(recordFocused.primaryOpen && recordFocused.recordInsideTools, code);
        assert(recordFocused.newRecord?.accessible && recordFocused.newRecord.focused, code);
        assert(recordFocused.newRecord.box.height >= 43.5 && recordFocused.newRecord.box.width >= 43.5, code);
        if (!beforeTab.newRecord?.accessible)
          assert(Math.abs(recordFocused.tools.scrollTop - beforeTab.tools.scrollTop) > 1, code);
        assert.equal(await input.inputValue(),draft,code);
        await capture('primary-record-keyboard-focused');
      }
      await disclosure(primary,false);
    }
    await disclosure(participants,true);
    const expanded = await observe('participants-open');
    assert(Math.abs(editing.outerScrollY - expanded.outerScrollY) <= 1, code);
    assert(expanded.participantsOpen,code); assert.equal(await input.inputValue(),draft,code); await capture('participants-open');
    await disclosure(participants,false);
    const closed = await observe('disclosures-closed'); stableComposer(editing,closed);
    assert.equal(await input.inputValue(),draft,code);
  } catch (error) {
    mainError = Object.assign(new Error(code), { shortHistoryStage:stage, shortHistoryGeometry:latest,
      shortHistoryKind:['AssertionError','TimeoutError'].includes(error?.name) ? error.name : 'Error' });
    try { await capture('failure'); } catch { /* Keep the original sanitized failure. */ }
  } finally {
    try {
      if (originalPrimary !== null) await disclosure(primary,originalPrimary);
      await disclosure(participants,originalParticipants);
      await input.fill(originalDraft);
      await page.setViewportSize(originalViewport); await settle();
      assert.equal(await input.inputValue(),originalDraft,code);
    } catch { mainError ??= Object.assign(new Error(code), { shortHistoryStage:'restore', shortHistoryGeometry:latest }); }
  }
  if (mainError) throw mainError;
  return { evidence, noMessageSubmitted:true, physicalKeyboardVerified:false };
}

export async function runLocalHistoryWindowBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const filename of [options.module, options.executable]) {
    const info = await lstat(filename); assert(info.isFile() && !info.isSymbolicLink(), code);
  }
  const source = await sources(), { chromium } = await import(pathToFileURL(options.module).href);
  const runId = randomUUID(), parent = path.join(root, 'test-results'), folder = path.join(parent, `local-history-window-${runId}`);
  await mkdir(parent, { recursive: true }); const parentInfo = await lstat(parent);
  assert(parentInfo.isDirectory() && !parentInfo.isSymbolicLink(), code); await mkdir(folder);
  const report = { runId, startedAt: new Date().toISOString(), source, passed: false, checks: [], screenshots: [],
    errors: [], unexpectedRequests: [], requestFailures: [], httpFailures: [], expectedInitialAuthResponses: [],
    timelineResponses: [], legacyMessageCollections: [], failure: null,
    humanMetricsCollected: false, cleanupObservationTimedOut: false,
    cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Owned memory-only synthetic database and nonpersistent Chrome at 320/390/1440 CSS pixels; not physical-device or human usability evidence.',
      '2105 ordinary messages per fixture are prepared with SQL under real triggers; bulk setup is not UI-send evidence.',
      'The old active publication is the existing study fixture. Only the new therapist message and guardian activity feedback are UI writes.',
      'No uploads, E/native data, Docker, trust/firewall changes, existing browser profiles, external origins or deployment.',
      'Scheduled polling and menu navigation are checked; one real 200 response is delayed, never replaced with fabricated data.',
      'Unavailable-target fallback, server/process restart and browser-termination draft recovery are not covered.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, origins: [], finished: false };
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  const note = (collection, value, limit = 160) => { if (collection.length < limit) collection.push(value); };
  const contexts = new Set(), sandboxes = new Set(), pages = new Map(), responseTasks = new Set();
  const closingContexts = new WeakSet();
  let browserServer, browser, lifetime, pendingCleanup, phase = 'STARTUP';
  const step = async (label, operation) => {
    phase = label; await save('progress.json', { runId, phase, completedWidths: report.checks.map(check => check.width) });
    assert.equal(report.errors.length, 0, code); assert.equal(report.unexpectedRequests.length, 0, code);
    const value = await operation();
    assert.equal(report.errors.length, 0, code); assert.equal(report.unexpectedRequests.length, 0, code); return value;
  };
  await save('ownership.json', ownership);
  try {
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    lifetime = processLifetime(browserServer.process()); ownership.browserProcessId = browserServer.process().pid;
    await save('ownership.json', ownership); browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    for (const width of [320, 390, 1440]) {
      const fixture = await step(`${width}:FIXTURE`, () => createLocalP0StudyFixture('A', { port: 0 }));
      const { sandbox, rooms, publication } = fixture, { origin, ids } = sandbox; sandboxes.add(sandbox);
      const url = new URL(origin); assert(url.origin === origin && url.hostname === '127.0.0.1' && url.protocol === 'http:' && url.port, code);
      assert(!url.username && !url.password && !url.search && !url.hash, code);
      ownership.origins.push(origin); await save('ownership.json', ownership);
      const originalMaterial = async () => (await sandbox.database.query(`SELECT to_jsonb(r) AS value FROM cb_record_revisions r
        WHERE center_id=$1 AND conversation_id=$2 ORDER BY record_id,revision`, [ids.centerId, rooms[0].conversationId])).rows;
      const beforeMaterial = await originalMaterial();
      const prepared = await step(`${width}:LONG_HISTORY_SETUP`, () => seedLongHistory(fixture));
      const roomId = rooms[0].conversationId, forbiddenRoomId = rooms[1].conversationId;
      const base = `/api/local/centers/${ids.centerId}/conversations/${roomId}`;
      const result = { width, prepared, home: false, boundedLatest: false, olderNewerLatest: false,
        pollAnchorAndDraft: false, incomingWhileReading: false, pendingOlderSuperseded: false, oldActivityTarget: false,
        feedbackUiStored: false, feedbackEditOffWindow: false, originalRecordsPreserved: false,
        authorizedNavigation: false, historyControls: [], shortViewportControls: [], maxDomRows: null, cleanup: false };
      report.currentCheck = result;
      const actor = async role => {
        let authenticated = false, initialAuthObserved = false;
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul',
          isMobile: width < 640, hasTouch: width < 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context); assert.equal((await context.cookies()).length, 0, code);
        const allowedRoomIds = role === 'guardian' ? [roomId] : rooms.map(room => room.conversationId);
        await context.route('**/*', async route => {
          if (closingContexts.has(context)) return route.abort().catch(() => {});
          try {
            const request = route.request(), target = new URL(request.url()), method = request.method();
            const auth = /^\/api\/local\/auth\/(login|session|logout)$/.test(target.pathname);
            const inbox = target.pathname === `/api/local/centers/${ids.centerId}/inbox`;
            const primary = target.pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
              [...target.searchParams].length === 1 && allowedRoomIds.includes(target.searchParams.get('conversationId'));
            const room = allowedRoomIds.find(id => target.pathname.startsWith(`/api/local/centers/${ids.centerId}/conversations/${id}/`));
            const tail = room ? target.pathname.slice(`/api/local/centers/${ids.centerId}/conversations/${room}`.length) : '';
            if (method === 'GET' && tail === '/messages' && !['timeline', 'publications'].includes(target.searchParams.get('view')))
              note(report.legacyMessageCollections, { width, role, phase });
            const read = /^\/(profile|read|goals|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+)?|feedback\/[A-Za-z0-9_-]+)$/.test(tail) ||
              role === 'therapist' && /^\/records(?:\/[A-Za-z0-9_-]+)?$/.test(tail);
            const write = (auth && !target.pathname.endsWith('/session')) || tail === '/read' ||
              room === roomId && (role === 'therapist' && tail === '/messages' || role === 'guardian' && /^\/feedback\/[A-Za-z0-9_-]+$/.test(tail));
            const allowed = target.origin === origin && (['GET', 'HEAD'].includes(method) && (assets.has(target.pathname) || auth || inbox || primary || read) || method === 'POST' && write);
            if (!allowed) {
              note(report.unexpectedRequests, { width, role, phase, sameOrigin: target.origin === origin,
                method: ['GET', 'HEAD', 'POST'].includes(method) ? method : 'OTHER' }); return route.abort().catch(() => {});
            }
            await route.continue();
          } catch { if (!closingContexts.has(context)) note(report.errors, { width, role, phase, type: 'route' }); await route.abort().catch(() => {}); }
        });
        if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => {
          note(report.unexpectedRequests, { width, role, phase, type: 'websocket' }); socket.close();
        });
        const page = await context.newPage(); pages.set(role, page); page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(20_000);
        page.on('pageerror', () => { if (!closingContexts.has(context)) note(report.errors, { width, role, phase, type: 'pageerror' }); });
        page.on('console', entry => { if (!closingContexts.has(context) && entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:'))
          note(report.errors, { width, role, phase, type: 'console' }); });
        page.on('requestfailed', request => {
          if (!closingContexts.has(context)) note(report.requestFailures, { width, role, phase,
            cancelled: request.failure()?.errorText === 'net::ERR_ABORTED' });
        });
        page.on('response', response => {
          if (closingContexts.has(context)) return;
          const target = new URL(response.url());
          if (target.origin !== origin) return;
          // An empty owned context first asks whether it has a session. Exactly
          // one pre-login GET /auth/session 401 is the normal login boundary;
          // login POST failures and all post-login 401s must still fail.
          const initialUnauthenticated = !authenticated && !initialAuthObserved && response.status() === 401 &&
            response.request().method() === 'GET' && target.pathname === '/api/local/auth/session';
          if (initialUnauthenticated) { initialAuthObserved = true; note(report.expectedInitialAuthResponses, { width, role, status: 401 }); }
          else if (response.status() >= 400) note(report.httpFailures, { width, role, phase, status: response.status(),
            kind: target.pathname.startsWith('/api/local/auth/') ? 'auth' : 'application' });
          if (target.pathname !== `${base}/messages` || target.searchParams.get('view') !== 'timeline') return;
          const responsePhase = phase;
          const task = (async () => {
            try {
              if (response.status() !== 200 || await response.finished() !== null) return;
              const body = await response.json(); if (body.resetRequired) return;
              assert(Array.isArray(body.messages) && body.messages.length <= 100, code);
              note(report.timelineResponses, { width, role, phase: responsePhase, count: body.messages.length,
                selector: ['before', 'after', 'from', 'around'].find(key => target.searchParams.has(key)) ?? 'latest',
                first: body.messages[0]?.sequence ?? null, last: body.messages.at(-1)?.sequence ?? null });
            } catch { if (!closingContexts.has(context)) note(report.errors, { width, role, phase: responsePhase, type: 'timeline-response' }); }
          })(); responseTasks.add(task); void task.finally(() => responseTasks.delete(task));
        });
        const credential = sandbox.credentials.find(item => item.role === role); assert(credential?.email.endsWith('.test'), code);
        await page.goto(origin); await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click(); await page.getByTestId('home').waitFor();
        authenticated = true;
        await page.evaluate(() => {
          const evidence = { maxRows: 0, observations: 0 };
          const observe = () => { evidence.observations++; evidence.maxRows = Math.max(evidence.maxRows,
            document.querySelectorAll('[data-testid="message-row"]').length); };
          window.__historyWindowEvidence = evidence;
          const observer = new MutationObserver(observe); observer.observe(document.body, { childList: true, subtree: true }); observe();
        });
        return { page, context, role, userId: ids[`${role}Id`] };
      };
      const guardian = await step(`${width}:GUARDIAN_HOME`, () => actor('guardian'));
      const row = id => guardian.page.locator(`[data-testid="message-row"][data-message-id="${id}"]`);
      const button = action => guardian.page.locator(`button[data-action="history-${action}"]`);
      const range = () => guardian.page.getByTestId('message-row').evaluateAll(rows => ({
        count: rows.length, first: Number(rows[0]?.dataset.sequence ?? 0), last: Number(rows.at(-1)?.dataset.sequence ?? 0),
      }));
      const boundedRows = async () => { const value = await range(); assert(value.count > 0 && value.count <= 100, code); return value; };
      const controlLayout = async () => {
        const layout = await guardian.page.locator('[data-history-controls]').evaluate(controls => ({
          hidden: controls.hidden, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
          buttons: [...controls.querySelectorAll('button')].map(button => {
            const box = button.getBoundingClientRect(), text = document.createRange(); text.selectNodeContents(button);
            const textRects = [...text.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
            const lines = new Set(textRects.map(rect => Math.round(rect.top))).size;
            return { action: button.dataset.action, height: box.height, width: box.width, lines,
              insideHorizontalViewport: box.left >= 0 && box.right <= innerWidth + 1,
              textInsideButton: textRects.every(rect => rect.left >= box.left && rect.right <= box.right + 1 && rect.top >= box.top && rect.bottom <= box.bottom + 1),
            };
          }),
        }));
        assert.equal(layout.hidden, false, code); assert.equal(layout.horizontalOverflow, false, code); assert.equal(layout.buttons.length, 3, code);
        for (const button of layout.buttons) assert(button.height >= 44 && button.width > 0 && button.lines === 1 &&
          button.insideHorizontalViewport && button.textInsideButton, code);
        if (result.historyControls.length < 24) result.historyControls.push({ phase, ...layout });
      };
      const settled = async () => { await guardian.page.waitForLoadState('networkidle'); await boundedRows(); await controlLayout(); };
      const capture = async label => {
        assert.equal(await guardian.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code);
        const filename = `${width}-${label}.png`;
        await guardian.page.screenshot({ path: path.join(folder, filename), fullPage: false,
          mask: [guardian.page.locator('input[type="email"]'), guardian.page.locator('input[type="password"]'), guardian.page.locator('.workspace-head .account')] });
        report.screenshots.push({ filename, width, syntheticOnly: true, fullPage: false });
      };
      const shortControls = async who => {
        const observation = await verifyShortHistoryControls({ page:who.page, capture:async label => {
          const filename = `${width}-${who.role}-short-history-${label}.png`;
          await who.page.screenshot({ path:path.join(folder,filename),fullPage:false,
            mask:[who.page.locator('input[type="email"]'),who.page.locator('input[type="password"]'),who.page.locator('.workspace-head .account')] });
          report.screenshots.push({ filename,...who.page.viewportSize(),role:who.role,syntheticOnly:true,fullPage:false });
        } });
        result.shortViewportControls.push({ role:who.role,...observation });
      };
      const readingAnchor = () => guardian.page.getByTestId('message-list').evaluate(list => {
        const top = list.getBoundingClientRect().top + list.clientTop;
        const anchor = [...list.querySelectorAll('[data-testid="message-row"]')].find(node => node.getBoundingClientRect().bottom > top);
        return { id: anchor?.dataset.messageId ?? null, offset: anchor ? anchor.getBoundingClientRect().top - top : 0, scrollTop: list.scrollTop };
      });
      const poll = async () => {
        const response = await guardian.page.waitForResponse(response => {
          const target = new URL(response.url()); return target.origin === origin && target.pathname === `${base}/messages` &&
            target.searchParams.get('view') === 'timeline' && response.request().method() === 'GET' && response.status() === 200;
        }, { timeout: 15_000 });
        assert.equal(await response.finished(), null, code); await settled();
      };
      await step(`${width}:HOME_AND_LATEST`, async () => {
        await guardian.page.getByTestId('home').locator(`[data-activity-link][data-target-id="${publication.messageId}"]`).waitFor();
        assert.equal(await guardian.page.locator(`[data-open-room="${forbiddenRoomId}"]`).count(), 0, code); result.home = true;
        await capture('home-old-activity'); await workspaceRoom(guardian.page, roomId); await row(prepared.latestId).waitFor(); await settled();
        const latest = await boundedRows(); assert.equal(latest.last, prepared.latestSequence, code); result.initialRange = latest;
        result.boundedLatest = true; await capture('latest-window');
      });
      if (width === 390) await step(`${width}:GUARDIAN_SHORT_HISTORY_CONTROLS`, () => shortControls(guardian));
      await step(`${width}:OLDER_NEWER_LATEST`, async () => {
        await button('older').click(); await guardian.page.waitForFunction(last => {
          const rows = document.querySelectorAll('[data-testid="message-row"]'); return rows.length > 0 && Number(rows[rows.length - 1].dataset.sequence) < last;
        }, result.initialRange.last); await settled();
        const older = await boundedRows(); assert(older.last < result.initialRange.first, code); result.olderRange = older;
        await button('newer').click(); await row(prepared.latestId).waitFor(); await settled(); assert.deepEqual(await range(), result.initialRange, code);
        await button('older').click(); await guardian.page.waitForFunction(first => Number(document.querySelector('[data-testid="message-row"]')?.dataset.sequence) === first, older.first);
        await settled(); await button('latest').click(); await row(prepared.latestId).waitFor(); await settled();
        assert.deepEqual(await range(), result.initialRange, code); result.olderNewerLatest = true;
        await button('older').click(); await guardian.page.waitForFunction(first => Number(document.querySelector('[data-testid="message-row"]')?.dataset.sequence) === first, older.first); await settled();
      });
      const draft = '가상 긴 대화 탐색 중 미전송 초안입니다.';
      let anchored;
      await step(`${width}:POLL_HISTORY_ANCHOR`, async () => {
        await guardian.page.getByLabel('메시지', { exact: true }).fill(draft);
        const summary = guardian.page.getByTestId('message-row').nth(20).locator('.care-message-menu > summary');
        await summary.focus(); anchored = await readingAnchor(); assert(anchored.id && anchored.scrollTop > 0, code);
        for (let count = 0; count < 2; count++) {
          await poll(); const after = await readingAnchor();
          assert.equal(after.id, anchored.id, code); assert(Math.abs(after.offset - anchored.offset) <= 3, code);
          assert.deepEqual(await range(), result.olderRange, code);
          assert.equal(await guardian.page.getByLabel('메시지', { exact: true }).inputValue(), draft, code);
        }
        result.pollAnchorAndDraft = true; await capture('older-after-poll');
      });
      await step(`${width}:INCOMING_WHILE_HISTORY`, async () => {
        const therapist = await actor('therapist'); await workspaceRoom(therapist.page, roomId);
        if (width === 390) await shortControls(therapist);
        const body = '가상 치료사가 현재 화면에서 보낸 새 연결 확인 소식입니다.';
        await therapist.page.getByLabel('메시지', { exact: true }).fill(body);
        const [response] = await Promise.all([therapist.page.waitForResponse(response => response.url() === `${origin}${base}/messages` && response.request().method() === 'POST'),
          therapist.page.getByRole('button', { name: '보내기', exact: true }).click()]);
        assert.equal(response.status(), 201, code);
        await therapist.page.getByTestId('message-row').getByText(body, { exact: true }).waitFor();
        const rows = (await sandbox.database.query('SELECT id,sequence FROM cb_messages WHERE center_id=$1 AND conversation_id=$2 AND body=$3',
          [ids.centerId, roomId, body])).rows; assert.equal(rows.length, 1, code);
        await guardian.page.bringToFront(); await poll(); const after = await readingAnchor();
        assert.equal(after.id, anchored.id, code); assert(Math.abs(after.offset - anchored.offset) <= 3, code);
        assert.deepEqual(await range(), result.olderRange, code); assert.equal(await guardian.page.getByLabel('메시지', { exact: true }).inputValue(), draft, code);
        await button('latest').click(); await row(rows[0].id).waitFor(); await settled();
        assert.equal((await range()).last, Number(rows[0].sequence), code); result.incomingWhileReading = true;
        await capture('new-message-latest');
      });
      await step(`${width}:OLD_ACTIVITY_SUPERSEDES_PENDING_OLDER`, async () => {
        const starting = await range();
        let release, reached;
        const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { reached = resolve; });
        const pending = [], delayed = { intercepted: false, status: null, delivery: null, transportFailure: false };
        const matcher = url => url.origin === origin && url.pathname === `${base}/messages` &&
          url.searchParams.get('view') === 'timeline' && url.searchParams.has('before');
        const handler = route => {
          if (delayed.intercepted || route.request().method() !== 'GET') return route.fallback();
          delayed.intercepted = true;
          const work = (async () => {
            let response;
            try {
              response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
              delayed.status = response.status(); reached(); await gate;
              try { await route.fulfill({ response }); delayed.delivery = 'delivered'; }
              catch {
                if (route.request().failure()?.errorText === 'net::ERR_ABORTED') delayed.delivery = 'cancelled';
                else delayed.transportFailure = true;
              }
            } catch { delayed.transportFailure = true; reached(); await route.abort().catch(() => {}); }
            finally { await response?.dispose().catch(() => {}); }
          })(); pending.push(work); return work;
        };
        await guardian.page.route(matcher, handler);
        try {
          await button('older').click(); await bounded(ready, 20_000);
          assert.equal(delayed.status, 200, code); assert.equal(delayed.transportFailure, false, code);
          await workspaceView(guardian.page, 'home');
          const [targetResponse] = await Promise.all([guardian.page.waitForResponse(response => {
            const target = new URL(response.url()); return target.origin === origin && target.pathname === `${base}/messages` &&
              target.searchParams.get('view') === 'timeline' && target.searchParams.get('around') === publication.messageId;
          }), guardian.page.getByTestId('home').locator(`[data-activity-link][data-target-id="${publication.messageId}"]`).click()]);
          assert.equal(targetResponse.status(), 200, code);
          // The deliberately held request need not be globally network-idle.
          await row(publication.messageId).waitFor(); await boundedRows(); await controlLayout();
          const targeted = await range(); assert(targeted.first <= prepared.publicationSequence && targeted.last < starting.first, code);
          release(); await bounded(Promise.all(pending), 20_000); await settled();
          assert.equal(delayed.transportFailure, false, code); assert(['delivered', 'cancelled'].includes(delayed.delivery), code);
          assert.deepEqual(await range(), targeted, code);
          assert.equal(await row(publication.messageId).evaluate(node => {
            const rect = node.getBoundingClientRect(), list = node.closest('[data-testid="message-list"]').getBoundingClientRect();
            return rect.bottom > list.top && rect.top < list.bottom;
          }), true, code);
          assert.equal(await guardian.page.getByLabel('메시지', { exact: true }).inputValue(), draft, code);
          result.pendingOlderSuperseded = true; result.delayedOlderResponse = { ...delayed };
          await capture('activity-target-after-late-older');
        } finally {
          release(); await bounded(Promise.allSettled(pending), 20_000);
          await guardian.page.unroute(matcher, handler);
        }
        await button('latest').click(); await guardian.page.waitForFunction(last => {
          const rows = document.querySelectorAll('[data-testid="message-row"]');
          return rows.length > 0 && Number(rows[rows.length - 1].dataset.sequence) === last;
        }, starting.last); await settled();
      });
      await step(`${width}:OLD_ACTIVITY_TARGET_AND_FEEDBACK`, async () => {
        await workspaceView(guardian.page, 'home');
        const [targetResponse] = await Promise.all([guardian.page.waitForResponse(response => {
          const target = new URL(response.url()); return target.origin === origin && target.pathname === `${base}/messages` &&
            target.searchParams.get('view') === 'timeline' && target.searchParams.get('around') === publication.messageId &&
            response.request().method() === 'GET';
        }), guardian.page.getByTestId('home').locator(`[data-activity-link][data-target-id="${publication.messageId}"]`).click()]);
        assert.equal(targetResponse.status(), 200, code); const targeted = await targetResponse.json();
        assert(targeted.messages.length <= 100 && targeted.messages.some(message =>
          message.id === publication.messageId && message.sequence === prepared.publicationSequence), code);
        await row(publication.messageId).waitFor(); await settled();
        // Highlight is ephemeral; the exact authorized target's actual viewport
        // intersection and surrounding real HTTP window prove navigation.
        assert.equal(await row(publication.messageId).evaluate(node => {
          const rect = node.getBoundingClientRect(), list = node.closest('[data-testid="message-list"]').getBoundingClientRect();
          return rect.bottom > list.top && rect.top < list.bottom;
        }), true, code);
        result.oldActivityTarget = true; await capture('old-activity-target');
        await row(publication.messageId).getByRole('button', { name: '활동 경험 남기기', exact: true }).click();
        const dialog = guardian.page.getByTestId('care-dialog'); await dialog.waitFor();
        const expected = { date: fixture.day, ...TASK_A };
        for (const [key, value] of Object.entries(expected)) {
          const field = dialog.locator(`[name="${key}"]`); if (key === 'result') await field.selectOption(value); else await field.fill(value);
        }
        const [response] = await Promise.all([guardian.page.waitForResponse(response => {
          const target = new URL(response.url()); return target.origin === origin && target.pathname.startsWith(`${base}/feedback/`) && response.request().method() === 'POST';
        }), dialog.getByRole('button', { name: '활동 경험 저장', exact: true }).click()]);
        assert.equal(response.status(), 201, code); const receipt = (await response.json()).receipt;
        assert.equal(receipt.revision, 1, code); assert.equal(receipt.replayed, false, code); await dialog.waitFor({ state: 'hidden' });
        const saved = (await sandbox.database.query(`SELECT r.activity_date::text AS date,r.result,r.reaction,r.difficulty
          FROM cb_activity_feedback f JOIN cb_feedback_revisions r ON
          (r.center_id,r.conversation_id,r.feedback_id,r.revision)=(f.center_id,f.conversation_id,f.id,f.current_revision)
          WHERE f.center_id=$1 AND f.conversation_id=$2 AND f.id=$3 AND f.author_id=$4 AND f.publication_id=$5`,
        [ids.centerId, roomId, receipt.feedbackId, ids.guardianId, publication.publicationId])).rows;
        assert.deepEqual(saved, [expected], code);
        const api = await guardian.context.request.get(`${origin}${base}/feedback/${receipt.feedbackId}`, {
          maxRedirects: 0, timeout: 15_000, headers: { 'X-Carebridge-Account': ids.guardianId } });
        try { assert.equal(api.status(), 200, code); const { message } = await api.json(); assert.equal(message.id, receipt.messageId, code);
          for (const [key, value] of Object.entries(expected)) assert.equal(message.feedback[key], value, code); }
        finally { await api.dispose(); }
        // Successful feedback append must itself return to recent messages;
        // manually pressing latest here would hide a broken post-save flow.
        await row(receipt.messageId).waitFor();
        await boundedRows(); result.feedbackUiStored = true; await capture('feedback-saved');
        // The source publication is deliberately >2000 rows behind this recent
        // feedback. Editing must resolve the authorized active-publication data,
        // not require its source to remain in the 100-message timeline DOM.
        assert.equal(await row(publication.messageId).count(), 0, code);
        await row(receipt.messageId).getByRole('button', { name: '활동 경험 수정', exact: true }).click();
        await dialog.waitFor();
        for (const [key, value] of Object.entries(expected)) assert.equal(await dialog.locator(`[name="${key}"]`).inputValue(), value, code);
        const editedReaction = '가상 최근 답변 수정: 좋아하는 놀이를 다시 골랐어요.';
        await dialog.locator('[name="reaction"]').fill(editedReaction);
        const [editedResponse] = await Promise.all([guardian.page.waitForResponse(response => {
          const target = new URL(response.url()); return target.origin === origin && target.pathname === `${base}/feedback/${receipt.feedbackId}` && response.request().method() === 'POST';
        }), dialog.getByRole('button', { name: '활동 경험 저장', exact: true }).click()]);
        assert.equal(editedResponse.status(), 201, code); const editedReceipt = (await editedResponse.json()).receipt;
        assert.equal(editedReceipt.feedbackId, receipt.feedbackId, code); assert.equal(editedReceipt.revision, 2, code);
        assert.equal(editedReceipt.replayed, false, code); await dialog.waitFor({ state: 'hidden' });
        await row(receipt.messageId).getByText(editedReaction, { exact: true }).waitFor();
        const edited = (await sandbox.database.query(`SELECT r.activity_date::text AS date,r.result,r.reaction,r.difficulty
          FROM cb_activity_feedback f JOIN cb_feedback_revisions r ON
          (r.center_id,r.conversation_id,r.feedback_id,r.revision)=(f.center_id,f.conversation_id,f.id,f.current_revision)
          WHERE f.center_id=$1 AND f.conversation_id=$2 AND f.id=$3 AND f.author_id=$4 AND f.publication_id=$5`,
        [ids.centerId, roomId, receipt.feedbackId, ids.guardianId, publication.publicationId])).rows;
        assert.deepEqual(edited, [{ ...expected, reaction: editedReaction }], code);
        assert.equal((await sandbox.database.query('SELECT count(*)::integer AS count FROM cb_activity_feedback WHERE center_id=$1 AND conversation_id=$2',
          [ids.centerId, roomId])).rows[0].count, 1, code);
        assert.equal(await row(publication.messageId).count(), 0, code); result.feedbackEditOffWindow = true;
        await capture('feedback-edited-source-off-window');
      });
      await step(`${width}:AUTHORIZED_MENU_NAVIGATION`, async () => {
        for (const view of ['home', 'records', 'child', 'chat']) {
          await workspaceView(guardian.page, view);
          if (view !== 'home' && view !== 'chat') await guardian.page.locator('#child-select:not([disabled])').waitFor();
          assert.equal(await guardian.page.locator(`[data-open-room="${forbiddenRoomId}"], [data-room-id="${forbiddenRoomId}"], #child-select option[value="${forbiddenRoomId}"]`).count(), 0, code);
          assert(!(await guardian.page.locator('body').innerText()).includes('나무'), code);
        }
        const denied = await guardian.context.request.get(`${origin}/api/local/centers/${ids.centerId}/conversations/${forbiddenRoomId}/messages?view=timeline&limit=100`, {
          maxRedirects: 0, timeout: 15_000, headers: { 'X-Carebridge-Account': ids.guardianId } });
        try { assert([403, 404].includes(denied.status()), code); result.unauthorizedApiStatus = denied.status(); } finally { await denied.dispose(); }
        result.authorizedNavigation = true;
        const evidence = await guardian.page.evaluate(() => window.__historyWindowEvidence);
        assert(evidence.observations > 0 && evidence.maxRows <= 100, code); result.maxDomRows = evidence.maxRows;
        await Promise.all([...responseTasks]); assert.equal(report.httpFailures.length, 0, code);
        assert.equal(report.requestFailures.filter(item => !item.cancelled).length, 0, code);
        assert.equal(report.legacyMessageCollections.length, 0, code);
        assert.deepEqual(await originalMaterial(), beforeMaterial, code); result.originalRecordsPreserved = true;
      });
      for (const context of [...contexts]) { closingContexts.add(context); await bounded(context.close()); contexts.delete(context); }
      pages.clear(); await bounded(sandbox.close()); assert.equal(sandbox.database.closed, true, code);
      assert.equal(sandbox.credentials.length, 0, code); sandboxes.delete(sandbox);
      result.cleanup = true; report.checks.push(result); delete report.currentCheck;
      console.log(JSON.stringify({ width, passed: true, maxDomRows: result.maxDomRows, fixtureMessageCount: prepared.total }));
    }
    report.finalSource = await sources(); assert.equal(report.finalSource.sha256, source.sha256, code);
  } catch (error) {
    pendingCleanup = getPendingSyntheticCleanup(error);
    report.failure = { code, phase, kind: ['AssertionError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-history-window-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      shortHistoryStage:typeof error?.shortHistoryStage === 'string' ? error.shortHistoryStage : null,
      shortHistoryGeometry:error?.shortHistoryGeometry ?? null,
      shortHistoryKind:error?.shortHistoryKind ?? null };
    for (const [role, page] of pages) try {
      const filename = `failure-${role}.png`; await bounded(page.screenshot({ path: path.join(folder, filename), fullPage: false,
        mask: [page.locator('input[type="email"]'), page.locator('input[type="password"]'), page.locator('.workspace-head .account')] }), 5000);
      report.screenshots.push({ filename, syntheticOnly: true, failure: true, fullPage: false });
    } catch { note(report.errors, { phase, type: 'failure-screenshot' }); }
  } finally {
    for (const context of contexts) try { closingContexts.add(context); await bounded(context.close()); contexts.delete(context); }
    catch { report.cleanupObservationTimedOut = true; }
    report.cleanup.contextsClosed = contexts.size === 0;
    await Promise.all([...responseTasks]);
    if (browserServer) {
      try { await bounded(browser?.close()); await bounded(browserServer.close()); await bounded(lifetime.done); }
      catch { report.cleanupObservationTimedOut = true; try { await bounded(browserServer.kill()); await bounded(lifetime.done); } catch {} }
      report.cleanup.browserStopped = lifetime?.terminal() === true;
    } else report.cleanup.browserStopped = true;
    if (report.cleanup.browserStopped) {
      for (const sandbox of sandboxes) try { await bounded(sandbox.close()); assert.equal(sandbox.database.closed, true, code); sandboxes.delete(sandbox); }
      catch { report.failure ??= { code, phase: 'SANDBOX_CLEANUP', kind: 'Error' }; }
      if (pendingCleanup) try { await bounded(pendingCleanup()); pendingCleanup = null; }
      catch { report.failure ??= { code, phase: 'PENDING_SANDBOX_CLEANUP', kind: 'Error' }; }
    }
    report.cleanup.sandboxesClosed = sandboxes.size === 0 && !pendingCleanup; report.finishedAt = new Date().toISOString();
    report.passed = !report.failure && !report.cleanupObservationTimedOut && report.checks.length === 3 &&
      report.errors.length === 0 && report.unexpectedRequests.length === 0 && report.httpFailures.length === 0 &&
      report.legacyMessageCollections.length === 0 &&
      report.requestFailures.every(item => item.cancelled) && Object.values(report.cleanup).every(Boolean);
    ownership.finished = Object.values(report.cleanup).every(Boolean); ownership.cleanup = report.cleanup;
    await save('ownership.json', ownership); await save('results.json', report);
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length, failure: report.failure, cleanup: report.cleanup }));
  return report.passed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runLocalHistoryWindowBrowser()) process.exitCode = 1; }
  catch { console.error('LOCAL_HISTORY_WINDOW_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

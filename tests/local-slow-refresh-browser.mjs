// Controlled latency against real local HTTP. No fabricated success responses,
// real data, user browser profiles, persistent storage or human timing metrics.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { getPendingSyntheticCleanup } from '../server/local-sandbox-cleanup.mjs';
import { createLocalP0StudyFixture } from './local-p0-study-fixture.mjs';
import { Conversations } from '../server/conversations.mjs';
import { MemberProfiles } from '../server/profiles.mjs';
import { PrimaryCommunicators } from '../server/primary-communicators.mjs';
import { captureLocalP0StudySources } from './local-p0-study-browser.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceRecords, workspaceView, workspaceAccountAction } from './local-workspace-browser-helpers.mjs';
import { verifyPrimaryCommunicatorLayout } from './local-primary-communicator-browser-helpers.mjs';
import { verifyComposerEditing } from './local-composer-editing-browser-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const code = 'LOCAL_SLOW_REFRESH_FAILED';
const assets = new Set(['/', '/favicon.ico', '/local-api/app.js', '/local-api/client.js',
  '/local-api/care-client.js', '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css',
  '/local-api/media-client.js', '/local-api/media-ui.js', '/local-api/media-viewer.js',
  '/local-api/approval-pending-ui.js', '/local-api/care-recipient-client.js',
  '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js']);
async function sourceSnapshot() {
  return { ...(await captureLocalP0StudySources()),
    runnerSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex') };
}
async function bounded(work, milliseconds = 30_000) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(code)), milliseconds);
  })]); } finally { clearTimeout(timer); }
}
function processLifetime(child) {
  const streams = [...new Set((child.stdio ?? []).filter(Boolean))], done = Promise.withResolvers();
  let exited = child.exitCode !== null || child.signalCode !== null, closed = false;
  const terminal = () => exited && closed && streams.every(stream => stream.closed === true);
  const changed = () => { if (terminal()) done.resolve(); };
  child.once('exit', () => { exited = true; changed(); });
  child.once('close', () => { closed = true; changed(); });
  for (const stream of streams) stream.once('close', changed);
  return { done: done.promise, terminal };
}

export async function runLocalSlowRefresh(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const filename of [options.module, options.executable]) {
    const info = await lstat(filename); assert(info.isFile() && !info.isSymbolicLink(), code);
  }
  const source = await sourceSnapshot(), { chromium } = await import(pathToFileURL(options.module).href);
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-slow-refresh-${runId}`);
  await mkdir(folder);
  const report = { runId, source, startedAt: new Date().toISOString(), passed: false, checks: [], screenshots: [],
    errors: [], unexpectedRequests: [], failure: null, humanMetricsCollected: false,
    cleanupObservationTimedOut: false, cleanup: { contextClosed: false, browserStopped: false, sandboxClosed: false },
    limitations: ['One memory-only synthetic therapist fixture and one owned Chromium context: 1440x900, 390x844 and 320x740 responsive layout checks.',
      'GET requests are held before reaching the real server; no response payload, authentication or success status is fabricated.',
      'One synthetic guardian text is added through the domain service during the held home GET; this is fixture preparation, not UI sending evidence.',
      'Primary contact designation and one synthetic guardian name change use domain services; only their subsequent real HTTP display is browser evidence, not UI editing evidence.',
      'Checks in-app refresh/polling, a real client timeout and browser-context offline mode, not hard navigation, real-device networking or human perceived latency.',
      'Unsent text only. No attachments, clinical saves, server restart, source integration or deployment.'] };
  const owner = { runId, testProcessId: process.pid, browserProcessId: null, origin: null, finished: false };
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  let sandbox, fixture, server, browser, lifetime, context, page, closing = false, pendingCleanup;
  let gate = null, phase = 'STARTUP';
  const gates = [], pendingRoutes = new Set();
  const snapshot = async label => {
    const filename = `${page.viewportSize().width}-${label}.png`;
    await page.screenshot({ path: path.join(folder, filename), fullPage: false,
      mask: [page.locator('input[type="email"]'), page.locator('input[type="password"]'), page.locator('.workspace-head .account')] });
    report.screenshots.push(filename);
  };
  const step = async (label, action, milliseconds = 40_000) => { phase = label; await bounded(action(), milliseconds);
    assert.equal(report.errors.length + report.unexpectedRequests.length, 0, code); };
  // A deferred real GET is released explicitly, or aborted after the real
  // client's timeout. Cleanup releases every held route before closing owners.
  const hold = pathname => {
    assert.equal(gate, null, code);
    const value = { pathname, hit: Promise.withResolvers(), released: Promise.withResolvers(),
      done: Promise.withResolvers(), request: null, abort: false, capturedAt: null };
    gate = value; gates.push(value); return value;
  };
  const release = async (value, abort = false) => {
    value.abort = abort; value.released.resolve(); await bounded(value.done.promise);
  };
  const observe = async (selector, expectedValue = null) => page.evaluate(({ selector, expectedValue }) => {
    const node = document.querySelector(selector); if (!node) throw Error('MISSING_OBSERVED_NODE');
    const rect = node.getBoundingClientRect();
    const result = { frames: 0, missingFrames: 0, replacedFrames: 0, valueMismatchFrames: 0, boundsChangedFrames: 0 };
    let active = true;
    const sample = () => {
      if (!active) return;
      result.frames++;
      const current = document.querySelector(selector), bounds = node.getBoundingClientRect();
      if (!node.isConnected || !node.getClientRects().length || getComputedStyle(node).visibility === 'hidden') result.missingFrames++;
      if (current !== node) result.replacedFrames++;
      if (expectedValue !== null && node.value !== expectedValue) result.valueMismatchFrames++;
      if (Math.abs(bounds.x - rect.x) > 1 || Math.abs(bounds.y - rect.y) > 1 ||
          Math.abs(bounds.width - rect.width) > 1 || Math.abs(bounds.height - rect.height) > 1) result.boundsChangedFrames++;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    window.__slowRefreshObservation = () => { active = false; return result; };
  }, { selector, expectedValue });
  const finishObservation = async label => {
    const value = await page.evaluate(() => { const result = window.__slowRefreshObservation(); delete window.__slowRefreshObservation; return result; });
    report.checks.push({ label, ...value });
    assert(value.frames >= 15, code);
    for (const key of ['missingFrames', 'replacedFrames', 'valueMismatchFrames', 'boundsChangedFrames']) assert.equal(value[key], 0, code);
  };
  await save('ownership.json', owner);
  try {
    fixture = await createLocalP0StudyFixture('B', { port: 0 }); sandbox = fixture.sandbox;
    const { origin, ids } = sandbox, room = fixture.rooms[0], url = new URL(origin);
    assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.origin === origin && url.port, code);
    owner.origin = origin; report.origin = origin;
    const center = `/api/local/centers/${ids.centerId}`;
    const base = `${center}/conversations/${room.conversationId}`;
    const primaryService = new PrimaryCommunicators(sandbox.database);
    const members = new MemberProfiles(sandbox.database);
    const manager = { centerId: ids.centerId, userId: ids.managerId };
    const guardian = { centerId: ids.centerId, userId: ids.guardianId };
    const setPrimary = async userId => {
      const current = await primaryService.get(manager, { conversationId: room.conversationId });
      await primaryService.save(manager, { conversationId: room.conversationId, userId,
        expectedRevision: current.revision, clientId: randomUUID() });
    };
    await setPrimary(ids.guardianId);
    const initial = (await sandbox.database.query('SELECT to_jsonb(r) AS value FROM cb_record_revisions r ORDER BY record_id,revision')).rows;
    server = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    lifetime = processLifetime(server.process()); owner.browserProcessId = server.process().pid;
    await save('ownership.json', owner); browser = await chromium.connect(server.wsEndpoint());
    report.browserVersion = browser.version();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul',
      serviceWorkers: 'block', permissions: [], acceptDownloads: false });
    await context.route('**/*', route => {
      const operation = (async () => {
        if (closing) return route.abort().catch(() => {});
        try {
          const request = route.request(), target = new URL(request.url()), method = request.method();
          const auth = /^\/api\/local\/auth\/(login|session|logout)$/.test(target.pathname);
          const roomPath = fixture.rooms.find(item => target.pathname.startsWith(`${center}/conversations/${item.conversationId}/`));
          const part = roomPath ? target.pathname.slice(`${center}/conversations/${roomPath.conversationId}`.length) : '';
          const roomRead = /^\/(profile|messages|records|goals|appointments)(?:\/[A-Za-z0-9_-]+)?$/.test(part);
          const primary = target.pathname === `${center}/primary-communicator` &&
            fixture.rooms.some(item => item.conversationId === target.searchParams.get('conversationId'));
          const read = ['GET', 'HEAD'].includes(method) && (assets.has(target.pathname) || auth ||
            target.pathname === `${center}/inbox` || roomRead || primary);
          const post = method === 'POST' && ((auth && target.pathname !== '/api/local/auth/session') || part === '/read');
          if (target.origin !== origin || !(read || post)) {
            report.unexpectedRequests.push({ phase, method, sameOrigin: target.origin === origin }); return route.abort();
          }
          if (gate && method === 'GET' && target.pathname === gate.pathname) {
            const current = gate; gate = null; current.request = request;
            current.capturedAt = performance.now(); current.hit.resolve();
            await current.released.promise;
            try { if (current.abort || closing) await route.abort(); else await route.continue(); }
            catch { if (!current.abort && !closing) throw Error(code); }
            finally { current.done.resolve(); }
          } else await route.continue();
        } catch { if (!closing) report.errors.push({ phase, type: 'route' }); }
      })();
      pendingRoutes.add(operation); void operation.finally(() => pendingRoutes.delete(operation)); return operation;
    });
    if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => {
      report.unexpectedRequests.push({ phase, type: 'websocket' }); socket.close();
    });
    page = await context.newPage(); page.setDefaultTimeout(15_000);
    page.on('pageerror', () => report.errors.push({ phase, type: 'pageerror' }));
    page.on('console', entry => { if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:'))
      report.errors.push({ phase, type: 'console' }); });
    const homeSelector = `[data-testid="home"] [data-home-news] [data-open-room="${room.conversationId}"]`;
    const ready = () => page.locator(homeSelector).waitFor();
    await step('LOGIN', async () => {
      const credential = sandbox.credentials.find(item => item.role === 'therapist'); assert(credential.email.endsWith('.test'), code);
      await page.goto(origin); await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
      await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
      await page.getByRole('button', { name: '로그인', exact: true }).click(); await ready();
    });
    await step('HOME_SHORT_DELAY', async () => {
      const held = hold(`${center}/inbox`);
      await workspaceAccountAction(page, 'refresh'); await bounded(held.hit.promise, 12_000);
      await page.locator(homeSelector).focus();
      await observe(homeSelector);
      const changedText = '가상 소식 갱신 시험: 집에서 놀이를 이어 했고 아이가 고른 활동과 반응을 함께 전합니다. 다음 회기에 확인할 내용도 남깁니다.';
      // A new event in this owned in-memory fixture. The UI still receives it
      // only through the original real authorized GET, never DOM injection.
      const added = await new Conversations(sandbox.database).sendText({ centerId: ids.centerId, userId: ids.guardianId },
        { conversationId: room.conversationId, clientId: randomUUID(), body: changedText });
      await wait(1200); await snapshot('home-delayed');
      const response = page.waitForResponse(value => value.request() === held.request);
      await release(held); assert.equal((await response).status(), 200, code); await wait(500);
      await finishObservation('home-1200ms-real-get');
      assert.equal(await page.locator(homeSelector).locator('.preview').innerText(), changedText, code);
      assert.equal(await page.locator(homeSelector).locator('.news-sender').innerText(), '하루 보호자', code);
      assert.equal(await page.locator(homeSelector).getAttribute('data-target-id'), added.id, code);
      assert.equal(await page.locator(homeSelector).evaluate(node => document.activeElement === node), true, code);
      Object.assign(report.checks.at(-1), { currentContentReplaced: true, currentTargetReplaced: true, focusRetained: true });
      await snapshot('home-updated');
    });
    const chatDraft = '가상 지연 시험: 아직 보내지 않은 소식입니다.';
    await step('CHAT_SHORT_DELAY', async () => {
      // One real user navigation. Retrying the click while loading would
      // cancel and restart selection, contaminating the latency observation.
      await page.locator(homeSelector).click();
      const composer = page.getByLabel('메시지', { exact: true }); await composer.waitFor();
      assert.equal(await page.getByTestId('inbox').locator(`[data-room-id="${room.conversationId}"]`).getAttribute('aria-current'), 'true', code);
      await composer.fill(chatDraft);
      const held = hold(base + '/messages');
      await workspaceAccountAction(page, 'refresh'); await bounded(held.hit.promise, 12_000);
      await observe('.composer textarea', chatDraft);
      await wait(1200); await snapshot('chat-delayed');
      const response = page.waitForResponse(value => value.request() === held.request);
      await release(held); assert.equal((await response).status(), 200, code); await wait(500);
      await finishObservation('chat-1200ms-real-get'); assert.equal(await composer.inputValue(), chatDraft, code);
      await composer.fill('');
    });
    await step('PRIMARY_COMMUNICATOR_REFRESH_AND_LAYOUT', async () => {
      const host = page.locator('.primary-communicator-compact');
      const details = host.locator('details'), summary = details.locator('summary');
      const composer = page.getByLabel('메시지', { exact: true });
      await composer.fill(chatDraft);
      assert.equal(await details.getAttribute('open'), null, code);
      assert.equal(await host.locator('[data-primary-person]').innerText(), '하루 보호자 (보호자)', code);
      await summary.focus(); await summary.press('Enter');
      const summaryNode = await summary.elementHandle(), detailsNode = await details.elementHandle();
      const retained = async () => {
        assert.equal(await summaryNode.evaluate(node => node.isConnected && document.activeElement === node &&
          document.querySelector('.primary-communicator-details > summary') === node), true, code);
        assert.equal(await detailsNode.evaluate(node => node.isConnected && node.open &&
          document.querySelector('.primary-communicator-details') === node), true, code);
        assert.equal(await composer.inputValue(), chatDraft, code);
      };
      const refresh = async (pathname, mutate, expectedPerson) => {
        const held = hold(pathname);
        await workspaceAccountAction(page, 'refresh');
        await bounded(held.hit.promise, 12_000); await summary.focus();
        if (mutate) await mutate();
        const response = page.waitForResponse(value => value.request() === held.request);
        await release(held); assert.equal((await response).status(), 200, code);
        await page.waitForFunction(person => document.querySelector('[data-primary-person]')?.textContent === person,
          expectedPerson);
        await wait(500);
        await retained();
      };
      // A later selected-primary GET proves the unchanged poll completed; the
      // focused native disclosure is retained, not reconstructed from HTML.
      await refresh(`${center}/primary-communicator`, null, '하루 보호자 (보호자)');
      const changedName = '가상 보호자 이름 길이 확인을 위한 시험 이름';
      await refresh(base + '/profile', async () => {
        const current = await members.getSelf(guardian);
        await members.saveSelf(guardian, { clientId: randomUUID(), expectedRevision: current.revision, displayName: changedName });
      }, `${changedName} (보호자)`);
      const layout = await verifyPrimaryCommunicatorLayout({ page, capture: snapshot, expectedDraft: chatDraft });
      // Clearing contact metadata cannot retain the former person's label.
      await refresh(`${center}/primary-communicator`, () => setPrimary(null), '미지정');
      assert.equal((await host.innerText()).includes(changedName), false, code);
      await snapshot('primary-unassigned');
      await workspaceView(page, 'home'); await page.locator(homeSelector).click();
      await composer.waitFor();
      assert.equal(await details.getAttribute('open'), null, code);
      assert.equal(await composer.inputValue(), chatDraft, code);
      await composer.fill('');
      await summaryNode.dispose(); await detailsNode.dispose();
      report.checks.push({ label: 'primary-communicator-refresh-and-layout', unchangedPollRetained: true,
        nameRefreshed: true, selectionCleared: true, disclosureAndFocusRetained: true,
        draftRetained: true, remountClosed: true, layout });
    });
    await step('COMPOSER_NATIVE_EDITING', async () => {
      const countMessages = async () => (await sandbox.database.query('SELECT count(*)::int AS count FROM cb_messages')).rows[0].count;
      const before = await countMessages();
      let completedPolls = 0;
      const editing = await verifyComposerEditing({ page, capture: snapshot,
        refreshWhileFocused: async () => {
          // Let the application's own scheduled poll run. Do not click a
          // refresh button or move focus away from the selected draft text.
          const held = hold(base + '/messages'); await bounded(held.hit.promise, 12_000);
          const response = page.waitForResponse(value => value.request() === held.request);
          const finalRead = page.waitForResponse(value => value.request().method() === 'GET'
            && new URL(value.url()).pathname === `${center}/primary-communicator`);
          await wait(1200); await release(held);
          assert.equal((await response).status(), 200, code);
          const primaryRead = await finalRead; assert.equal(primaryRead.status(), 200, code);
          assert.equal(await primaryRead.finished(), null, code); await wait(500);
          completedPolls++;
        } });
      assert.equal(completedPolls, 3, code);
      assert.equal(await countMessages(), before, code);
      report.checks.push({ label: 'composer-native-editing', completedRealPolls: completedPolls,
        messageCountUnchanged: true, editing });
    }, 90_000);
    const recordDraft = '가상 지연 시험: 저장하지 않은 기록입니다.';
    const dialog = page.getByTestId('care-dialog');
    await step('RECORD_POLL_SHORT_DELAY', async () => {
      await workspaceRecords(page, room.conversationId);
      await page.locator('[data-care-action="new-record"]').click(); await dialog.waitFor();
      await dialog.locator('[name="performed"]').fill(recordDraft);
      const held = hold('/api/local/auth/session'); await bounded(held.hit.promise, 12_000);
      await observe('[data-testid="care-dialog"] [name="performed"]', recordDraft);
      await wait(1200); await snapshot('record-poll-delayed');
      const response = page.waitForResponse(value => value.request() === held.request);
      await release(held); assert.equal((await response).status(), 200, code); await wait(500);
      await finishObservation('record-poll-1200ms-real-get');
    });
    await step('REAL_CLIENT_TIMEOUT_AND_REAUTHORIZATION', async () => {
      const held = hold(`${center}/inbox`); await bounded(held.hit.promise, 12_000);
      const failed = page.waitForEvent('requestfailed', { predicate: request => request === held.request, timeout: 15_000 });
      await failed; const elapsed = Math.round(performance.now() - held.capturedAt);
      assert(elapsed >= 8500 && elapsed <= 14000, code);
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('[data-testid="records-content"] [data-record-id]').count(), 0, code);
      const recovery = page.getByTestId('records-content').locator('[data-connection-state="unavailable"]');
      await recovery.waitFor();
      assert.match(await recovery.innerText(), /이 창에 남아 있는 입력은 연결·권한 확인 후/);
      assert.doesNotMatch(await recovery.innerText(), /가상 지연 시험|하루|놀이 참여 관찰/);
      await snapshot('timeout-cleared');
      await release(held, true);
      const reauthorization = hold('/api/local/auth/session');
      const retry = recovery.getByRole('button', { name: '연결 다시 확인', exact: true });
      await retry.focus(); await retry.press('Enter'); await bounded(reauthorization.hit.promise, 12_000);
      assert.equal(await recovery.isVisible(), true, code);
      assert.equal(await dialog.isVisible(), false, code);
      assert.equal(await page.locator('[data-testid="records-content"] [data-record-id]').count(), 0, code);
      const response = page.waitForResponse(value => value.request() === reauthorization.request);
      await release(reauthorization); assert.equal((await response).status(), 200, code);
      await page.locator('[data-care-action="resume"]').waitFor({ state: 'visible', timeout: 15_000 });
      assert.equal(await page.locator('[data-connection-state]:visible').count(), 0, code);
      await page.locator('[data-care-action="resume"]').click(); await dialog.waitFor();
      assert.equal(await dialog.locator('[name="performed"]').inputValue(), recordDraft, code);
      await snapshot('draft-restored-after-authorization');
      report.checks.push({ label: 'real-client-timeout', networkWaitMs: elapsed,
        recordCardsAbsent: true, editorClosed: true, recoveryNotice: true, keyboardRetry: true,
        contentHiddenUntilReauthorization: true, draftRestoredAfterAuthorizedRefresh: true });
      await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    });
    await step('MOBILE_OFFLINE_AND_RECOVERY', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await context.setOffline(true);
      const offline = page.getByTestId('records-content').locator('[data-connection-state="offline"]');
      await offline.waitFor();
      assert.equal(await offline.getByRole('button', { name: '연결 다시 확인', exact: true }).isDisabled(), true, code);
      assert.equal(await page.locator('[data-testid="records-content"] [data-record-id]').count(), 0, code);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), code);
      await snapshot('offline');
      await context.setOffline(false);
      await page.locator('[data-care-action="resume"]').waitFor({ state: 'visible', timeout: 15_000 });
      assert.equal(await page.locator('[data-connection-state]:visible').count(), 0, code);
      await page.locator('[data-care-action="resume"]').click(); await dialog.waitFor();
      assert.equal(await dialog.locator('[name="performed"]').inputValue(), recordDraft, code);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), code);
      await snapshot('offline-draft-restored');
      await dialog.getByRole('button', { name: '닫기', exact: true }).click();
      report.checks.push({ label: 'mobile-offline-and-recovery', width: 390, offlineNotice: true,
        recordCardsAbsent: true, draftRestoredAfterAuthorizedRefresh: true, horizontalOverflow: false });
    });
    await step('PRESERVATION_AND_LOGOUT', async () => {
      assert.deepEqual((await sandbox.database.query('SELECT to_jsonb(r) AS value FROM cb_record_revisions r ORDER BY record_id,revision')).rows, initial, code);
      assert.equal((await sandbox.database.query('SELECT count(*)::int AS count FROM cb_activity_feedback')).rows[0].count, 0, code);
      await workspaceView(page, 'home'); await workspaceAccountAction(page, 'logout');
      await page.getByTestId('login-form').waitFor();
      report.finalSource = await sourceSnapshot(); assert.deepEqual(report.finalSource, source, code);
    });
  } catch (error) {
    pendingCleanup = getPendingSyntheticCleanup(error);
    report.failure = { code, phase, kind: ['AssertionError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-slow-refresh-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      primaryStage: error?.primaryStage ?? null, primaryGeometry: error?.primaryGeometry ?? null,
      composerStage: error?.composerStage ?? null, composerGeometry: error?.composerGeometry ?? null };
    if (page) try { await bounded(snapshot('failure'), 5000); } catch { report.errors.push({ phase, type: 'failure-screenshot' }); }
  } finally {
    closing = true; gate = null;
    for (const held of gates) { held.abort = true; held.released.resolve(); }
    try { await bounded(Promise.allSettled([...pendingRoutes])); } catch { report.cleanupObservationTimedOut = true; }
    try { if (context) await bounded(context.close()); report.cleanup.contextClosed = true; } catch { report.cleanupObservationTimedOut = true; }
    if (server) {
      try { await bounded(browser?.close()); await bounded(server.close()); await bounded(lifetime.done); }
      catch { report.cleanupObservationTimedOut = true; try { await bounded(server.kill()); await bounded(lifetime.done); } catch {} }
      report.cleanup.browserStopped = lifetime?.terminal() === true;
    } else report.cleanup.browserStopped = true;
    if (report.cleanup.browserStopped) try {
      if (sandbox) { await bounded(sandbox.close()); assert.equal(sandbox.database.closed, true, code); assert.equal(sandbox.credentials.length, 0, code); }
      if (pendingCleanup) await bounded(pendingCleanup()); report.cleanup.sandboxClosed = true;
    } catch { report.failure ??= { code, phase: 'SANDBOX_CLEANUP', kind: 'Error' }; }
    report.finishedAt = new Date().toISOString();
    report.passed = !report.failure && !report.cleanupObservationTimedOut && report.checks.length === 7 &&
      !report.errors.length && !report.unexpectedRequests.length && Object.values(report.cleanup).every(Boolean);
    owner.finished = Object.values(report.cleanup).every(Boolean); owner.cleanup = report.cleanup;
    await save('ownership.json', owner); await save('results.json', report);
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks, failure: report.failure, cleanup: report.cleanup }));
  return report.passed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runLocalSlowRefresh()) process.exitCode = 1; }
  catch { console.error('LOCAL_SLOW_REFRESH_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

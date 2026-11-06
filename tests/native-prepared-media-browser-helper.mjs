// Trusted synthetic native harness only. Real UI/HTTP/worker output; no SQL,
// preparation approval double, browser-role injection or existing user profile.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceRoom } from './local-workspace-browser-helpers.mjs';
import { exerciseInteractiveCare } from './native-interactive-care-browser-helper.mjs';
import { prepareReplySources, verifyReplyWithdrawal } from './native-reply-source-browser-helper.mjs';
import { exerciseNativeHistoryMediaBrowser } from './native-history-media-browser-helper.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const code = 'NATIVE_PREPARED_MEDIA_BROWSER_FAILED';
const uuid = (v) => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const id = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const assets = new Set(['/', '/favicon.ico', '/local-api/client.js', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/styles.css',
  '/local-api/care-client.js', '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/media-client.js',
  '/local-api/media-ui.js', '/local-api/media-viewer.js', '/local-api/goal-client.js', '/local-api/appointment-client.js',
  '/local-api/self-profile-ui.js', '/local-api/self-profile-client.js', '/src/context-fields.js', '/src/profile-fields.js',
  '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js']);

export function assertCurrentMessageReferenceRead(evidence, start, expected) {
  assert(Array.isArray(evidence) && Number.isSafeInteger(start) && start >= 0 && start < evidence.length, code);
  assert(id(expected?.messageId) && uuid(expected.uploadId) && ['image/png', 'video/mp4', 'video/webm'].includes(expected.type) &&
    Number.isSafeInteger(expected.size) && expected.size > 0 && /^[a-f0-9]{64}$/.test(expected.sha256), code);
  const fresh = evidence.slice(start);
  assert(fresh.every(entry => ['messageId', 'uploadId', 'type', 'size', 'sha256'].every(key => entry[key] === expected[key])), code);
  return fresh.length;
}

export function preparedHelperFailureLocation(error) {
  try {
    const stack = error?.stack;
    if (typeof stack !== 'string') return null;
    // Keep only this helper's location, never the error text or absolute path.
    for (const frame of stack.slice(0, 32768).split('\n', 65).slice(1)) {
      const match = /^\s*at (?:[^\r\n]*[\\/])?native-prepared-media-browser-helper\.mjs:([1-9]\d{0,6}):([1-9]\d{0,4})\)?\s*$/.exec(frame);
      if (match) return { file: 'native-prepared-media-browser-helper.mjs', line: Number(match[1]), column: Number(match[2]) };
    }
  } catch { /* Diagnostic access must not replace the original failure. */ }
  return null;
}

async function sources() {
  const resumeSources = ['tests/windows-synthetic-resume-check.mjs', 'tests/synthetic-resume-process.mjs',
    'scripts/windows-synthetic-session-vault-provider.ps1', 'scripts/check-synthetic-session-storage.ps1'];
  const names = ['tests/native-prepared-media-browser-helper.mjs', 'tests/native-interactive-care-browser-helper.mjs',
    'tests/native-history-media-browser-helper.mjs',
    'tests/native-record-attachments-browser-helper.mjs', 'tests/native-reply-source-browser-helper.mjs',
    'tests/native-feedback-attachments-browser-helper.mjs', 'tests/native-upload-status-observation.mjs', 'tests/native-api-restart-browser-helper.mjs',
    'tests/windows-synthetic-session-check.mjs', 'tests/browser-media-fixture.mjs', 'tests/native-video-fixture.mjs', 'scripts/synthetic-e-api.mjs', 'tests/message-browser-policy.mjs',
    'tests/local-workspace-browser-helpers.mjs', 'scripts/p0-study-policy.mjs',
    'scripts/prepare-beta-postgres.ps1', 'scripts/postgres-prepare-lock.ps1', 'scripts/windows-database-credential-provider.ps1', 'scripts/beta-storage-policy.ps1',
    'server/tests/windows-postgres-tls-fixture.ps1'];
  for (const directory of ['local-api', 'src', 'server', 'server/migrations']) {
    const base = path.join(root, directory), info = await lstat(base);
    assert(info.isDirectory() && !info.isSymbolicLink(), code);
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (entry.isDirectory() || !/(?:\.(?:mjs|js|css|html|sql|ps1)|\.Dockerfile(?:\.dockerignore)?)$/.test(entry.name)) continue;
      assert(entry.isFile() && !entry.isSymbolicLink(), code); names.push(`${directory}/${entry.name}`);
    }
  }
  names.push(...resumeSources);
  const files = [];
  for (const name of names.sort()) {
    const filename = path.join(root, name), info = await lstat(filename);
    assert(info.isFile() && !info.isSymbolicLink(), code);
    files.push({ name, sha256: sha(await readFile(filename)) });
  }
  return { sha256: sha(JSON.stringify(files)), files };
}

// The timeout is diagnostic only. The same actual process remains owned and
// awaited; it is never killed or declared terminated because time elapsed.
function processLifetime(child, report) {
  assert(child && Number.isInteger(child.pid), code);
  const streams = [...new Set((child.stdio ?? []).filter(Boolean))], done = Promise.withResolvers();
  let exited = child.exitCode !== null || child.signalCode !== null, closed = false;
  const terminal = () => exited && closed && streams.every((stream) => stream.closed === true);
  const changed = () => { if (terminal()) done.resolve(); };
  child.once('exit', () => { exited = true; changed(); });
  child.once('close', () => { closed = true; changed(); });
  for (const stream of streams) stream.once('close', changed);
  return { terminal, wait: async () => {
    const timer = setTimeout(() => { report.cleanupObservationTimedOut = true; }, 30_000);
    try { await done.promise; } finally { clearTimeout(timer); }
  } };
}

export async function exercisePreparedMediaBrowser({ origin, centerId, conversationId, credentials, samples,
  evidenceDirectory, browserRuntime, onOwned, careContext, replyAttachments = false } = {}) {
  const report = { runId: randomUUID(), startedAt: new Date().toISOString(), passed: false, checks: [], deliveries: [],
    contentEvidence: [], uploadStates: [], screenshots: [], errors: [], unexpectedRequests: [], failure: null, source: null, sourceAfter: null,
    cleanup: { contextsClosed: false, browserStopped: false }, cleanupObservationTimedOut: false,
    limitations: ['Fresh synthetic accounts and Chromium viewports, not physical-device or human-usability evidence.',
      'Native inspection/processing is supplied by the caller-owned real worker, never simulated in this helper.',
      'One committed message response is deliberately lost; retry uses the actual endpoint with the same captured request.'] };
  let phase = 'CONFIGURATION', folder, folderOwned = false, browserServer, browserProcess, browser, lifetime, closePromise, closing = false;
  const contexts = new Set(), observers = new Set();
  const ownership = { runId: report.runId, testProcessId: process.pid, browserProcessId: null, finished: false };
  const state = () => ({ contextsClosed: contexts.size === 0, browserStopped: browserServer ? lifetime?.terminal() === true : true });
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      // Prefer graceful context acknowledgements before disconnecting their
      // transport. If they stall, also request server closure but STILL await
      // the same original completions and actual process; never fake success.
      const tasks = [...contexts].map(async (context) => { await context.close(); contexts.delete(context); });
      let serverClose;
      const stopServer = () => {
        if (!serverClose) { serverClose = Promise.resolve().then(() => browserServer?.close()); serverClose.catch(() => {}); }
        return serverClose;
      };
      const timer = setTimeout(() => { report.cleanupObservationTimedOut = true; void stopServer(); }, 30_000);
      let results;
      try {
        results = await Promise.allSettled(tasks);
        if (browser) results.push(...await Promise.allSettled([browser.close()]));
        results.push(...await Promise.allSettled([stopServer()]));
        if (lifetime) await lifetime.wait();
      } finally { clearTimeout(timer); }
      await Promise.allSettled([...observers]);
      Object.assign(report.cleanup, state());
      if (results.some((r) => r.status === 'rejected') || !Object.values(report.cleanup).every(Boolean)) throw new Error(code);
    })();
    closePromise.catch(() => { closePromise = undefined; });
    return closePromise;
  };
  const save = async (name, value, fresh = false) => writeFile(path.join(folder, name), `${JSON.stringify(value, null, 2)}\n`, fresh ? { flag: 'wx' } : undefined);
  const note = (collection, item) => { if (collection.length < 32) collection.push(item); };
  try {
    phase = 'SOURCE_CAPTURE'; report.source = await sources(); phase = 'CONFIGURATION';
    const url = new URL(origin);
    assert(url.origin === origin && url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) >= 1024 &&
      !url.username && !url.password && !url.search && !url.hash && id(centerId) && id(conversationId), code);
    assert(onOwned === undefined || typeof onOwned === 'function', code);
    assert(careContext === undefined || id(careContext.goalId) && id(careContext.appointmentId) && id(careContext.guardianId), code);
    assert(typeof replyAttachments === 'boolean', code);
    if (replyAttachments) assert(careContext && id(careContext.otherConversationId) && careContext.otherConversationId !== conversationId, code);
    const options = messageBrowserOptions(['--confirm-synthetic-local'], {
      PLAYWRIGHT_MODULE: browserRuntime?.module, STUDY_CHROMIUM_EXECUTABLE: browserRuntime?.executable });
    for (const file of [options.module, options.executable]) { const info = await lstat(file); assert(info.isFile() && !info.isSymbolicLink(), code); }
    assert(Array.isArray(credentials) && credentials.length === 2 && ['guardian', 'therapist'].every((role) => credentials.filter((c) =>
      c.role === role && id(c.userId) && typeof c.email === 'string' && c.email.endsWith('.test') && typeof c.password === 'string' && c.password.length > 0).length === 1), code);
    assert(Array.isArray(samples), code);
    const chosen = [samples.find((s) => s.type === 'image/png'), samples.find((s) => ['video/mp4', 'video/webm'].includes(s.type))];
    assert(chosen.every((s) => s && Buffer.isBuffer(s.bytes) && s.bytes.length > 0 &&
      s.bytes.length <= (s.type === 'image/png' ? 10 : 50) * 1024 ** 2), code);
    folder = path.resolve(evidenceDirectory);
    const parent = path.join(root, 'test-results'), basename = path.basename(folder);
    assert(path.dirname(folder) === parent && basename.startsWith('native-prepared-') && uuid(basename.slice('native-prepared-'.length)), code);
    const parentInfo = await lstat(parent); assert(parentInfo.isDirectory() && !parentInfo.isSymbolicLink(), code);
    assert.equal(path.resolve(await realpath(parent)), path.resolve(parent), code);
    await mkdir(folder); folderOwned = true; // New exact directory, never adopt/overwrite.
    await save('ownership.json', ownership, true);
    const { chromium } = await import(pathToFileURL(options.module).href);
    phase = 'BROWSER_STARTUP';
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    browserProcess = browserServer.process(); lifetime = processLifetime(browserProcess, report);
    onOwned?.(Object.freeze({ close, status: () => Object.freeze(state()) }));
    ownership.browserProcessId = browserProcess.pid; await save('ownership.json', ownership);
    browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    const base = `/api/local/centers/${centerId}/conversations/${conversationId}`;
    const sends = [], lost = { armed: false, count: 0, messageId: null, invalid: false };
    let therapistRoomPosts = 0;
    const actor = async (role, width) => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR',
        isMobile: false, hasTouch: false, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
      contexts.add(context);
      context.once('close', () => contexts.delete(context));
      await context.route('**/*', async (route) => {
        const request = route.request(), requestUrl = new URL(request.url()), method = request.method();
        const local = requestUrl.origin === origin;
        const api = requestUrl.pathname.startsWith('/api/local/');
        if (!local || !['GET', 'POST', 'HEAD'].includes(method) || !((assets.has(requestUrl.pathname) && ['GET', 'HEAD'].includes(method)) || api || requestUrl.protocol === 'blob:')) {
          note(report.unexpectedRequests, { role, phase, sameOrigin: local, method: ['GET', 'POST', 'HEAD'].includes(method) ? method : 'OTHER' });
          return route.abort().catch(() => {});
        }
        if (role === 'therapist' && requestUrl.pathname.startsWith(base + '/') && method === 'POST') therapistRoomPosts++;
        if (role === 'guardian' && requestUrl.pathname === `${base}/messages` && method === 'POST') {
          const payload = request.postDataJSON(); sends.push(structuredClone(payload));
          if (lost.armed) {
            lost.armed = false;
            try {
              // Fault injection only: let the real server commit before losing
              // its response. No success fixture or direct send is substituted.
              const response = await route.fetch({ maxRedirects: 0 });
              try {
                const result = await response.json();
                if (response.status() !== 201 || !id(result?.message?.id)) lost.invalid = true;
                else { lost.messageId = result.message.id; lost.count++; }
              } finally { await response.dispose(); }
              await route.abort('failed');
            } catch { lost.invalid = true; await route.abort('failed').catch(() => {}); }
            return;
          }
        }
        return route.continue().catch(() => {});
      });
      if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', (socket) => {
        note(report.unexpectedRequests, { role, phase, type: 'websocket' }); socket.close();
      });
      const page = await context.newPage(); page.setDefaultTimeout(15_000);
      page.on('pageerror', () => note(report.errors, { role, phase, type: 'pageerror' }));
      page.on('console', (entry) => { if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:'))
        note(report.errors, { role, phase, type: 'console' }); });
      page.on('response', (response) => {
        if (role !== 'therapist' || response.request().method() !== 'GET') return;
        const u = new URL(response.url()), match = u.pathname.match(new RegExp(`^${base}/messages/([A-Za-z0-9_-]+)/attachments/([a-f0-9-]+)/content$`));
        if (u.origin !== origin || u.search || !match || response.status() !== 200) return;
        let observation;
        observation = (async () => {
          const headers = response.headers(), type = headers['content-type'], size = Number(headers['content-length']);
          assert(['image/png', 'video/mp4', 'video/webm'].includes(type) && Number.isSafeInteger(size) && size > 0 && size <= 50 * 1024 ** 2, code);
          const bytes = await response.body();
          try { assert.equal(bytes.length, size, code); report.contentEvidence.push({ messageId: match[1], uploadId: match[2], type, size, sha256: sha(bytes) }); }
          finally { bytes.fill(0); }
        })().catch(() => { if (!closing) note(report.errors, { role, phase, type: 'content-observation' }); })
          .finally(() => observers.delete(observation));
        observers.add(observation);
      });
      phase = `${role.toUpperCase()}_LOGIN`;
      const credential = credentials.find((c) => c.role === role);
      try {
        await page.goto(origin); await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click(); await page.getByTestId('home').waitFor();
      } finally { credential.email = ''; credential.password = ''; }
      assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie })),
        { local: 0, session: 0, cookie: '' }, code);
      return { page, context, role, userId: credential.userId };
    };
    const guardian = await actor('guardian', 390), therapist = await actor('therapist', 1440);
    const capture = async (who, label) => {
      assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code);
      const viewer = who.page.getByTestId('media-viewer');
      if (await viewer.isVisible()) assert.equal(await viewer.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true, code);
      const careDialog = who.page.getByTestId('care-dialog');
      if (await careDialog.isVisible()) assert.equal(await careDialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, code);
      const filename = `${label}.png`;
      await who.page.screenshot({ path: path.join(folder, filename), fullPage: true,
        mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]'), who.page.locator('.workspace-head .account')] });
      report.screenshots.push({ filename, width: who.page.viewportSize().width, syntheticOnly: true });
    };
    const careArguments = { origin, centerId, conversationId, ...careContext, guardian, therapist, capture,
      onPhase: value => { phase = value; } };
    const replySources = replyAttachments ? await prepareReplySources(careArguments) : null;
    if (replySources) {
      report.mode = 'reply-attachments';
      report.care = { ...replySources.checks, draftRoomIsolation: false, publicationAttachmentReply: false,
        textVersionAttachmentReply: false, withdrawalIndependentAttachment: false };
    } else if (careContext) {
      report.care = { ...await exerciseInteractiveCare(careArguments), currentReferencePhoto: false, currentReferenceVideo: false };
    }
    const authenticatedGet = async (who, suffix) => {
      const response = await who.context.request.get(origin + base + suffix, { maxRedirects: 0, timeout: 15_000,
        headers: { 'X-Carebridge-Account': who.userId, 'X-Carebridge-Request': '1', Origin: origin } });
      try { assert.equal(response.status(), 200, code); return await response.json(); }
      finally { await response.dispose(); }
    };
    const unsavedCurrentReference = async (message, file, expectedBytes, kind) => {
      const phasePrefix = kind === 'PNG' ? 'PNG_UNSAVED_CURRENT_REFERENCE' : 'VIDEO_UNSAVED_CURRENT_REFERENCE';
      phase = phasePrefix + '_BASELINE_READ';
      const before = await authenticatedGet(therapist, '/records?limit=100');
      assert(Array.isArray(before.records) && before.hasMore === false, code);
      const row = therapist.page.locator('[data-testid="message-row"][data-message-id="' + message.id + '"]');
      const menu = row.locator('.care-message-menu');
      phase = phasePrefix + '_MENU_OPEN';
      if (await menu.count() && await menu.getAttribute('open') === null) await menu.locator(':scope > summary').click();
      phase = phasePrefix + '_REFERENCE_OPEN';
      await row.locator('[data-care-action="reference"]').click();
      phase = phasePrefix + '_RECORD_FORM';
      const careDialog = therapist.page.getByTestId('care-dialog'); await careDialog.waitFor();
      const form = careDialog.locator('[data-care-form="record"]'); await form.waitFor();
      phase = phasePrefix + '_INPUT_CAPTURE';
      const performed = form.locator('[name="performed"]'); await performed.fill('가상 첨부 원문을 확인하며 작성 중인 관찰');
      const inputBefore = await performed.inputValue(), inputNode = await performed.elementHandle();
      const inputs = () => form.evaluate(el => [...el.querySelectorAll('input[name],textarea[name],select[name]')]
        .map(node => ({ name: node.name, type: node.type, value: node.value, checked: node.checked === true })));
      const fieldsBefore = await inputs(), postsBefore = therapistRoomPosts;
      const reference = form.locator('[data-reference-message-id="' + message.id + '"]');
      const quoteBefore = await reference.locator('[data-reference-quote]').innerText();
      const toggle = reference.locator('[data-care-action="reference-source"]');
      phase = phasePrefix + '_SOURCE_OPEN';
      await toggle.focus(); await toggle.press('Enter');
      const panel = reference.locator('[data-reference-source]');
      const button = panel.locator('[data-open-current-reference-attachment="' + file.id + '"][data-message-id="' + message.id + '"]');
      phase = phasePrefix + '_FILE_BUTTON';
      await button.waitFor();
      const evidenceStart = report.contentEvidence.length;
      phase = phasePrefix + '_VIEWER_OPEN';
      await button.focus(); await button.press('Enter');
      const viewer = therapist.page.getByTestId('media-viewer'); await viewer.waitFor();
      await viewer.getByRole('heading', { name: '현재 참고 첨부', exact: true }).waitFor();
      phase = phasePrefix + '_VIEWER_CONTENT';
      if (file.type === 'image/png') {
        await therapist.page.waitForFunction(() => { const img = document.querySelector('[data-media-viewer-content] img'); return img?.complete && img.naturalWidth > 0; });
        assert(await viewer.locator('img').evaluate(async img => { await img.decode(); return img.naturalWidth > 0 && img.currentSrc.startsWith('blob:'); }), code);
      } else {
        await therapist.page.waitForFunction(() => { const video = document.querySelector('[data-media-viewer-content] video'); return video?.readyState >= 1 && video.videoWidth > 0; });
        const video = viewer.locator('video'); assert.equal(await video.evaluate(el => el.autoplay), false, code);
        await video.focus(); await video.press('Space');
        await therapist.page.waitForFunction(() => { const video = document.querySelector('[data-media-viewer-content] video');
          return video && !video.error && video.currentTime > 0 && (video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0) > 0; });
      }
      assert.equal(await viewer.locator('[data-media-viewer-name]').textContent(), file.name, code);
      phase = phasePrefix + '_EVIDENCE';
      await Promise.all([...observers]);
      assertCurrentMessageReferenceRead(report.contentEvidence, evidenceStart, expectedBytes);
      phase = phasePrefix + '_SCREENSHOT';
      await capture(therapist, '320-' + kind.toLowerCase() + '-unsaved-current-reference');
      phase = phasePrefix + '_VIEWER_CLOSE';
      await viewer.locator('[data-media-viewer-close]').focus(); await viewer.locator('[data-media-viewer-close]').press('Enter');
      await viewer.waitFor({ state: 'detached' });
      phase = phasePrefix + '_INPUT_PRESERVED';
      assert.equal(await button.evaluate(el => el === document.activeElement), true, code);
      assert.equal(await inputNode.evaluate(el => el.isConnected), true, code);
      assert.equal(await performed.inputValue(), inputBefore, code); assert.deepEqual(await inputs(), fieldsBefore, code);
      assert.equal(await reference.locator('[data-reference-quote]').innerText(), quoteBefore, code);
      phase = phasePrefix + '_SOURCE_CLOSE';
      await toggle.focus(); await toggle.press('Enter'); await panel.waitFor({ state: 'hidden' });
      assert.equal(await panel.locator('[data-open-current-reference-attachment]').count(), 0, code);
      assert.equal(therapistRoomPosts, postsBefore, code);
      phase = phasePrefix + '_DISCARD';
      await careDialog.getByRole('button', { name: '입력 취소', exact: true }).click(); await careDialog.waitFor({ state: 'hidden' });
      phase = phasePrefix + '_RECORD_RECHECK';
      const after = await authenticatedGet(therapist, '/records?limit=100');
      assert.equal(after.hasMore, false, code); assert.deepEqual(after.records, before.records, code);
      phase = phasePrefix + '_MESSAGE_RECHECK';
      const current = (await authenticatedGet(therapist, '/messages/' + message.id)).message;
      assert.equal(current.body, '', code); assert.equal(current.version, message.version, code);
      assert.deepEqual(current.attachments, message.attachments, code);
      await inputNode.dispose();
    };
    for (const [index, sample] of chosen.entries()) {
      const width = index === 0 ? 390 : 1440, kind = index === 0 ? 'PNG' : 'VIDEO';
      phase = `${kind}_SELECT`;
      await guardian.page.setViewportSize({ width, height: 900 }); await workspaceRoom(guardian.page, conversationId);
      const replySource = replySources?.sources[index];
      const replyDialog = guardian.page.getByTestId('care-dialog');
      if (replySource) {
        const sourceRow = guardian.page.locator(`[data-testid="message-row"][data-message-id="${replySource.id}"]`);
        const menu = sourceRow.locator('.care-message-menu');
        if (await menu.count() && await menu.getAttribute('open') === null) await menu.locator(':scope > summary').click();
        await sourceRow.locator(`[data-care-action="reply"][data-message-id="${replySource.id}"]`).click();
        await replyDialog.locator('[data-care-form="reply"]').waitFor();
      }
      const panel = replySource ? replyDialog.locator('[data-reply-upload]') : guardian.page.getByTestId('media-upload-panel');
      const details = panel.locator('[data-media-details]');
      if (await details.getAttribute('open') === null) await panel.locator('[data-media-details] > summary').click();
      const filename = sample.filename ?? sample.fileName ?? (index === 0
        ? '가상사진-<img src=x onerror=globalThis.__careNativeXss=1>-긴이름검사-사진첨부.png'
        : `가상영상-길고자세한파일이름도생략없이확인하는검증-보호자치료사연결-준비된원본영상.${sample.type === 'video/mp4' ? 'mp4' : 'webm'}`);
      assert(typeof filename === 'string' && filename.length <= 255 && !/[\x00-\x1f\x7f/\\]/.test(filename), code);
      await panel.locator('input[type="file"]').setInputFiles({ name: filename, mimeType: sample.type, buffer: sample.bytes });
      const row = panel.getByTestId('media-upload-row').filter({ hasText: filename });
      await row.waitFor(); assert.equal(await row.locator('.account').textContent(), filename, code);
      assert.equal(await row.locator('img,video,script').count(), 0, code);
      if (replySource && index === 0) {
        phase = 'PNG_REPLY_DRAFT_ISOLATION';
        const beforeUnready = sends.length;
        await replyDialog.getByRole('button', { name: '답장 보내기', exact: true }).click();
        await replyDialog.locator('[data-care-error]:not(:empty)').waitFor();
        assert.equal(sends.length, beforeUnready, code);
        await replyDialog.getByRole('button', { name: '닫기', exact: true }).click();
        await replyDialog.waitFor({ state: 'hidden' });
        await workspaceRoom(guardian.page, careContext.otherConversationId);
        assert.equal(await guardian.page.getByTestId('media-upload-panel').getByTestId('media-upload-row').count(), 0, code);
        assert.equal(await guardian.page.locator('[data-care-action="resume"]:visible').count(), 0, code);
        await workspaceRoom(guardian.page, conversationId);
        assert.equal(await guardian.page.getByTestId('media-upload-panel').getByTestId('media-upload-row').count(), 0, code);
        await guardian.page.locator('[data-care-action="resume"]:visible').click();
        await replyDialog.locator('[data-care-form="reply"]').waitFor(); await row.waitFor();
        assert.equal(await row.locator('.account').textContent(), filename, code);
        report.care.draftRoomIsolation = true;
      }
      phase = `${kind}_UPLOAD`;
      const [reserved, received] = await Promise.all([
        guardian.page.waitForResponse((r) => r.url() === `${origin}${base}/uploads` && r.request().method() === 'POST' && r.status() === 200),
        guardian.page.waitForResponse((r) => r.url().startsWith(`${origin}${base}/uploads/`) && r.url().endsWith('/content') && r.request().method() === 'POST' && r.status() === 200),
        row.locator('[data-media-action="upload"]').click(),
      ]);
      const reservation = await reserved.json(), reception = await received.json(), uploadId = reservation.upload?.id;
      assert(uuid(uploadId) && reservation.mode === 'prepared-delivery' && reception.upload?.id === uploadId, code);
      assert.equal(reservation.source.name, filename, code); assert.equal(reservation.source.size, sample.bytes.length, code);
      phase = `${kind}_WAIT_REAL_WORKER`;
      const observedStates = {kind,states:[]}; report.uploadStates.push(observedStates);
      const observeUpload = upload => {
        const state = ['pending','receiving','quarantined','inspecting','ready','bound','rejected','delete_pending','deleted'].includes(upload?.state) ? upload.state : 'UNKNOWN';
        const failureCode = upload?.failureCode == null ? null : ['SCAN_INVALID','SCAN_UNAVAILABLE','SCAN_REJECTED'].includes(upload.failureCode) ? upload.failureCode : 'OTHER';
        const fixed = {state,failureCode};
        if (JSON.stringify(observedStates.states.at(-1)) !== JSON.stringify(fixed) && observedStates.states.length < 24) observedStates.states.push(fixed);
      };
      observeUpload(reception.upload);
      const deadline = performance.now() + 180_000;
      while (!(await row.textContent()).includes('준비 완료')) {
        assert(performance.now() < deadline, code);
        assert(!(await row.textContent()).includes('거부됨'), code);
        const [response] = await Promise.all([
          guardian.page.waitForResponse((r) => r.url() === `${origin}${base}/uploads/${uploadId}` && r.request().method() === 'GET' && r.status() === 200),
          row.locator('[data-media-action="refresh"]').click(),
        ]);
        const current = await response.json(); assert.equal(current.mode, 'prepared-delivery', code);
        observeUpload(current.upload);
        if (current.upload.state === 'ready') {
          await guardian.page.waitForFunction((name) => [...document.querySelectorAll('[data-testid="media-upload-row"]')]
            .some((el) => el.textContent.includes(name) && el.textContent.includes('준비 완료')), filename); break;
        }
        await wait(Math.min(1000, Math.max(0, deadline - performance.now())));
      }
      await capture(guardian, `${width}-${kind.toLowerCase()}-ready`);
      phase = `${kind}_SEND`;
      assert.equal(await (replySource ? replyDialog.locator('[name="body"]') : guardian.page.getByLabel('메시지', { exact: true })).inputValue(), '', code);
      const sendButton = replySource ? replyDialog.getByRole('button', { name: '답장 보내기', exact: true })
        : guardian.page.getByRole('button', { name: '보내기', exact: true });
      const before = sends.length;
      if (index === 0) {
        lost.armed = true; await sendButton.click();
        await (replySource ? replyDialog.locator('[data-care-action="retry"]:not([disabled])') : guardian.page.getByTestId('send-error')).waitFor();
        assert.equal(lost.count, 1, code); assert.equal(lost.invalid, false, code);
        if (replySource && !await replyDialog.locator('[data-care-form="reply"]').isVisible()) {
          // A permission poll may safely redact the pending form. It must
          // preserve the exact receipt retry, never restore the quote/files.
          await replyDialog.locator('[data-care-form="receipt"]').waitFor();
          assert.equal(await replyDialog.locator('input[type="file"],blockquote').count(), 0, code);
          assert.equal((await replyDialog.innerText()).includes(filename), false, code);
        } else {
          assert.equal(await panel.locator('input[type="file"]').isDisabled(), true, code);
          assert.equal(await row.locator('[data-media-action="cancel"]').isDisabled(), true, code);
        }
      }
      const [sentResponse] = await Promise.all([
        guardian.page.waitForResponse((r) => r.url() === `${origin}${base}/messages` && r.request().method() === 'POST' && r.status() === 201),
        (index === 0 ? replySource ? replyDialog.locator('[data-care-action="retry"]')
          : guardian.page.getByRole('button', { name: '다시 보내기', exact: true }) : sendButton).click(),
      ]);
      const message = (await sentResponse.json()).message;
      assert(id(message?.id) && message.body === '' && message.attachments?.length === 1 && message.attachments[0].id === uploadId, code);
      if (index === 0) { assert.equal(message.id, lost.messageId, code); assert.deepEqual(sends[before], sends[before + 1], code); }
      assert.equal(sends.length - before, index === 0 ? 2 : 1, code);
      assert.deepEqual(sends.at(-1).attachments, [{ id: uploadId }], code);
      if (replySource) {
        assert.equal(sends.at(-1).replyTo, replySource.id, code);
        assert.equal(sends.at(-1).expectedReplyVersion, replySource.type === 'text' ? replySource.version : undefined, code);
        assert.equal(message.quote?.id, replySource.id, code);
        await replyDialog.waitFor({ state: 'hidden' });
        report.care[index === 0 ? 'publicationAttachmentReply' : 'textVersionAttachmentReply'] = true;
      }
      await row.waitFor({ state: 'detached' });
      if (!replySource) await guardian.page.getByTestId('send-error').waitFor({ state: 'hidden' });
      report.deliveries.push({ uploadId, messageId: message.id, type: sample.type });
      phase = `${kind}_VIEW`;
      await therapist.page.reload(); await therapist.page.getByTestId('home').waitFor(); await workspaceRoom(therapist.page, conversationId);
      if (replySource) {
        const receivedRow = therapist.page.locator(`[data-testid="message-row"][data-message-id="${message.id}"]`);
        await receivedRow.waitFor();
        assert.equal(await receivedRow.locator('.message-quote').innerText(), message.quote.preview ?? message.quote.body, code);
        if (replySource.type === 'text') assert.equal(message.quote.version, replySource.version, code);
      }
      const button = therapist.page.locator(`[data-open-attachment="${uploadId}"][data-message-id="${message.id}"]`);
      await button.waitFor(); await button.focus(); await button.press('Enter');
      const viewer = therapist.page.getByTestId('media-viewer'); await viewer.waitFor();
      assert.equal(await viewer.locator('[data-media-viewer-name]').textContent().then((value) => value === '' || value === filename), true, code);
      if (index === 0) {
        await therapist.page.waitForFunction(() => { const img = document.querySelector('[data-media-viewer-content] img'); return img?.complete && img.naturalWidth > 0; });
        const decoded = await viewer.locator('img').evaluate(async (img) => { await img.decode(); return img.naturalWidth > 0 && img.currentSrc.startsWith('blob:'); });
        assert(decoded, code);
      } else {
        await therapist.page.waitForFunction(() => { const video = document.querySelector('[data-media-viewer-content] video'); return video?.readyState >= 1 && video.videoWidth > 0; });
        const video = viewer.locator('video'); assert.equal(await video.evaluate((el) => el.autoplay), false, code);
        // Exercise the real video control with a user gesture, then observe
        // playback progress/decoded frames rather than counting a DOM element.
        await video.focus(); await video.press('Space');
        await therapist.page.waitForFunction(() => { const v = document.querySelector('[data-media-viewer-content] video');
          return v && !v.error && v.currentTime > 0 && (v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0) > 0; });
      }
      assert.equal(await viewer.locator('[data-media-viewer-name]').textContent(), filename, code);
      assert.equal(await therapist.page.evaluate(() => globalThis.__careNativeXss === undefined), true, code);
      await Promise.all([...observers]);
      assert(report.contentEvidence.some((e) => e.uploadId === uploadId && e.messageId === message.id && e.type === sample.type), code);
      await capture(therapist, `1440-${kind.toLowerCase()}-viewer`);
      await therapist.page.setViewportSize({ width: 320, height: 900 }); await capture(therapist, `320-${kind.toLowerCase()}-viewer`);
      await viewer.locator('[data-media-viewer-close]').focus(); await viewer.locator('[data-media-viewer-close]').press('Enter');
      await viewer.waitFor({ state: 'detached' });
      assert.equal(await button.evaluate((el) => el === document.activeElement), true, code);
      if (careContext && !replySources) {
        phase = `${kind}_UNSAVED_CURRENT_REFERENCE`;
        const candidateBytes = report.contentEvidence.find(entry => entry.messageId === message.id && entry.uploadId === uploadId);
        assert(candidateBytes, code);
        await unsavedCurrentReference(message, message.attachments[0], candidateBytes, kind);
        report.care[index === 0 ? 'currentReferencePhoto' : 'currentReferenceVideo'] = true;
      }
      await therapist.page.setViewportSize({ width: 1440, height: 900 });
      report.checks.push({ kind, senderWidth: width, receiverWidth: 1440, compactWidth: 320,
        uiUpload: true, realPreparedStatus: true, attachmentOnlySend: true, receiverReload: true,
        decoded: true, playback: index === 1, lostResponseExactRetry: index === 0, focusRestored: true, noFilenameMarkup: true });
    }
    if (replySources) {
      const first = report.deliveries[0];
      await guardian.page.setViewportSize({ width: 390, height: 900 });
      report.care.withdrawalIndependentAttachment = await verifyReplyWithdrawal({ ...careArguments,
        publicationMessageId: replySources.sources[0].id, replyMessageId: first.messageId, uploadId: first.uploadId });
      assert(Object.values(report.care).every(value => value === true), code);
      try {
        report.historyMedia = await exerciseNativeHistoryMediaBrowser({ origin, centerId, conversationId,
          guardian, therapist, deliveries: report.deliveries, expectedContent: report.contentEvidence,
          capture, onPhase: value => { phase = value; } });
      } catch (error) {
        if (error.historyMediaObservation) report.historyMedia = error.historyMediaObservation;
        throw error;
      }
      assert.equal(report.historyMedia.passed, true, code);
    }
    assert.equal(report.errors.length, 0, code); assert.equal(report.unexpectedRequests.length, 0, code);
  } catch (error) {
    report.failure = { code, phase, category: error?.name === 'AssertionError' ? 'assertion' : 'runtime-or-timeout' };
    const location = preparedHelperFailureLocation(error);
    if (location) report.failure.location = location;
  } finally {
    // Do not retain even synthetic account passwords in a result, exception,
    // screenshot, log or input object after its login attempt.
    if (Array.isArray(credentials)) for (const credential of credentials) {
      try { credential.email = ''; credential.password = ''; } catch { report.failure ??= { code, phase: 'CREDENTIAL_CLEAR', category: 'cleanup' }; }
    }
    try { await close(); } catch { report.failure ??= { code, phase: 'CLEANUP', category: 'cleanup' }; }
    Object.assign(report.cleanup, state()); ownership.finished = Object.values(report.cleanup).every(Boolean); ownership.cleanup = { ...report.cleanup };
    if (report.source) {
      try { report.sourceAfter = await sources(); assert.equal(report.sourceAfter.sha256, report.source.sha256, code); }
      catch { report.failure ??= { code, phase: 'SOURCE_RECHECK', category: 'source-changed-or-unavailable' }; }
    }
    report.finishedAt = new Date().toISOString();
    report.passed = !report.failure && !report.cleanupObservationTimedOut && report.checks.length === 2 && Object.values(report.cleanup).every(Boolean);
    if (folderOwned) {
      try { await save('ownership.json', ownership); await save('results.json', report, true); }
      catch { report.failure ??= { code, phase: 'EVIDENCE_WRITE', category: 'io' }; report.passed = false; }
    }
  }
  if (!report.passed) { const error = new Error(code); error.browserObservation = report; throw error; }
  return report;
}

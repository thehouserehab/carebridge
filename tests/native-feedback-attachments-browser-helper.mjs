// Explicit, fresh synthetic native session only. All mutations use real UI;
// a committed response may be lost, but preparation/authorization is never faked.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { windowsPostgresOptions } from '../server/windows-postgres-policy.mjs';
import { syntheticPng } from '../server/image-metadata-test-fixtures.mjs';
import { nativeSyntheticVideoBytes } from './native-video-fixture.mjs';
import { syntheticSessionCheckOptions, assertFreshAttachmentContent } from './native-record-attachments-browser-helper.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceRecords, workspaceRoom, workspaceView } from './local-workspace-browser-helpers.mjs';
import { createUploadStatusObservations } from './native-upload-status-observation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const code = 'NATIVE_FEEDBACK_ATTACHMENTS_BROWSER_FAILED';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const assets = new Set(['/', '/favicon.ico', '/local-api/client.js', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/styles.css',
  '/local-api/care-client.js', '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/media-client.js',
  '/local-api/media-ui.js', '/local-api/media-viewer.js', '/local-api/goal-client.js', '/local-api/appointment-client.js',
  '/local-api/self-profile-ui.js', '/local-api/self-profile-client.js', '/src/context-fields.js', '/src/profile-fields.js',
  '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js']);

// A new explicit mode still uses the unchanged fresh-E session policy. Other
// modes delegate to the existing parser; modes cannot be combined or repeated.
export function feedbackSessionCheckOptions(input) {
  assert(Array.isArray(input), code);
  if (input[0] === '--reply-attachments') {
    const args = input.slice(1); windowsPostgresOptions(args);
    return Object.freeze({ args: Object.freeze(args), recordAttachments: false, feedbackAttachments: false, replyAttachments: true });
  }
  if (input[0] === '--api-restart') {
    const args = input.slice(1); windowsPostgresOptions(args);
    return Object.freeze({ args: Object.freeze(args), recordAttachments: false, feedbackAttachments: true, apiRestart: true });
  }
  if (input[0] !== '--feedback-attachments') return Object.freeze({ ...syntheticSessionCheckOptions(input), feedbackAttachments: false });
  const args = input.slice(1); windowsPostgresOptions(args);
  return Object.freeze({ args: Object.freeze(args), recordAttachments: false, feedbackAttachments: true });
}

// Trusted test-memory handoff only. The original report remains safely JSON
// serializable: request bodies are NEVER part of its persisted evidence.
export function attachRestartCheckpoint(report, value) {
  const copy = structuredClone(value);
  const freeze = item => {
    if (item && typeof item === 'object') { for (const child of Object.values(item)) freeze(child); Object.freeze(item); }
    return item;
  };
  Object.defineProperty(report, 'restartCheckpoint', { value: freeze(copy), enumerable: false });
  return report;
}

export function feedbackAttachmentSamples() {
  // Exactly two real-decodable synthetic sources. Their conservative format
  // reservations total 20 + 100 MiB, never a third upload or a raised limit.
  return [{ type: 'image/png', bytes: syntheticPng() },
    { type: 'video/mp4', bytes: nativeSyntheticVideoBytes() }];
}

// Only a new response from the current-message content endpoint proves this
// action. An earlier read or the preserved feedback/record endpoint cannot pass.
export function assertCurrentReferenceContentEvidence(evidence, start, { messageId, file, expectedSha256 }) {
  assert(Array.isArray(evidence) && Number.isSafeInteger(start) && start >= 0 && start < evidence.length, code);
  assert(id(messageId) && uuid(file?.id) && ['image/png', 'video/mp4'].includes(file.type) &&
    Number.isSafeInteger(file.size) && file.size > 0 && /^[a-f0-9]{64}$/.test(expectedSha256), code);
  const fresh = evidence.slice(start);
  assert(fresh.every(entry => entry.role === 'therapist' && entry.kind === 'current-message' &&
    entry.messageId === messageId && entry.uploadId === file.id && entry.type === file.type &&
    entry.size === file.size && entry.sha256 === expectedSha256), code);
  return fresh.length;
}

// Follow the current collapsed UI with an ordinary user action. Never force
// attachment clicks or inject the details.open property into the document.
export async function revealFeedbackRecordReference(dialog, messageId) {
  assert(id(messageId), code);
  const reference = dialog.locator('[data-reference-message-id="' + messageId + '"]');
  await reference.waitFor({ state: 'attached' });
  assert.equal(await reference.count(), 1, code);
  const details = reference.locator('xpath=ancestor::details[@data-record-references]');
  assert.equal(await details.count(), 1, code);
  if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
  await reference.waitFor({ state: 'visible' });
  return reference;
}

// An independent reply survives withdrawal, but its source quote must become
// a minimal tombstone. Check the actual public response, not only rendered text.
export function assertRetainedReplyRedaction(message, { replyId, body, sourceId, privateValues }) {
  assert(id(replyId) && id(sourceId) && typeof body === 'string' && body.length > 0, code);
  assert(Array.isArray(privateValues) && privateValues.every(value => typeof value === 'string' && value.length > 0), code);
  assert.equal(message?.id, replyId, code); assert.equal(message.body, body, code);
  assert.equal(message.hidden, false, code);
  assert.equal(message.quote?.id, sourceId, code); assert.equal(message.quote.hidden, true, code);
  assert.deepEqual(Object.keys(message.quote).sort(), ['body', 'hidden', 'id'], code);
  assert(typeof message.quote.body === 'string' && message.quote.body.length > 0, code);
  for (const value of privateValues) assert(!JSON.stringify(message).includes(value), code);
}

// Read position and time-sensitive action permissions are deliberately omitted.
// This bounded public projection stays only inside the private test handoff.
export function stableConnectedMessage(message) {
  return Object.fromEntries(['id', 'conversationId', 'sequence', 'authorId', 'createdAt', 'type', 'body', 'version',
    'quote', 'publication', 'hidden', 'archived', 'attachmentCount', 'attachments']
    .filter(key => message[key] !== undefined).map(key => [key, structuredClone(message[key])]));
}

async function sources() {
  const resumeSources = ['tests/windows-synthetic-resume-check.mjs', 'tests/synthetic-resume-process.mjs',
    'scripts/windows-synthetic-session-vault-provider.ps1', 'scripts/check-synthetic-session-storage.ps1'];
  const names = ['tests/native-feedback-attachments-browser-helper.mjs', 'tests/native-record-attachments-browser-helper.mjs', 'tests/windows-synthetic-session-check.mjs',
    'tests/native-prepared-media-browser-helper.mjs', 'tests/native-interactive-care-browser-helper.mjs', 'tests/native-reply-source-browser-helper.mjs',
    'tests/native-upload-status-observation.mjs', 'tests/native-api-restart-browser-helper.mjs',
    'tests/native-video-fixture.mjs', 'tests/message-browser-policy.mjs', 'tests/local-workspace-browser-helpers.mjs',
    'scripts/synthetic-e-api.mjs', 'scripts/p0-study-policy.mjs', 'scripts/prepare-beta-postgres.ps1', 'scripts/postgres-prepare-lock.ps1',
    'scripts/windows-database-credential-provider.ps1', 'scripts/beta-storage-policy.ps1',
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

function processLifetime(child, report) {
  assert(child && Number.isInteger(child.pid), code);
  const streams = [...new Set((child.stdio ?? []).filter(Boolean))], done = Promise.withResolvers();
  let exited = child.exitCode !== null || child.signalCode !== null, closed = false;
  const terminal = () => exited && closed && streams.every(stream => stream.closed === true);
  const changed = () => { if (terminal()) done.resolve(); };
  child.once('exit', () => { exited = true; changed(); });
  child.once('close', () => { closed = true; changed(); });
  for (const stream of streams) stream.once('close', changed);
  return { terminal, wait: async () => {
    // A diagnostic deadline never substitutes for actual process termination.
    const timer = setTimeout(() => { report.cleanupObservationTimedOut = true; }, 30_000);
    try { await done.promise; } finally { clearTimeout(timer); }
  } };
}

export async function exerciseFeedbackAttachmentsBrowser({ origin, centerId, conversationId, credentials, samples,
  evidenceDirectory, browserRuntime, onOwned, careContext, prepareRestart = false } = {}) {
  const report = { runId: randomUUID(), mode: 'feedback-attachments', startedAt: new Date().toISOString(), passed: false,
    checks: { publication: false, firstFeedback: false, pinnedReference: false, replacementRetry: false,
      publicReply: false, privateReview: false, nextStructuredRecord: false, nextRecordShare: false, independentSharePreserved: false,
      currentSecondFile: false, pinnedFirstFile: false, unsavedCurrentReferencePhoto: false, currentReferenceVideo: false,
      withdrawalDenial: false, retainedReference: false, reload: false,
      ...(prepareRestart ? { textReviewStored: false, textReviewPrivacy: false, currentFeedbackReviewStored: false } : {}) },
    contentEvidence: [], uploadStates: [], screenshots: [], errors: [], unexpectedRequests: [], failure: null,
    source: null, sourceAfter: null, cleanup: { contextsClosed: false, browserStopped: false }, cleanupObservationTimedOut: false,
    limitations: ['Fresh synthetic accounts and same-machine isolated Chromium contexts; not physical devices or real users.',
      'Real caller-owned native worker only. One PNG and one MP4 reservation total exactly the unchanged 120 MiB ceiling.',
      'Only a committed feedback-update response is lost; no approval, API success, database write or role is simulated.',
      'Same-machine synthetic feedback/reference verification only; no production access or physical-device claim.'] };
  let phase = 'CONFIGURATION', folder, folderOwned = false, browserServer, browser, lifetime, closePromise, closing = false, restartCheckpoint;
  const contexts = new Set(), observers = new Set(), pages = new Map();
  const ownership = { runId: report.runId, testProcessId: process.pid, browserProcessId: null, finished: false };
  const state = () => ({ contextsClosed: contexts.size === 0, browserStopped: browserServer ? lifetime?.terminal() === true : true });
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const tasks = [...contexts].map(async context => { await context.close(); contexts.delete(context); });
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
      if (results.some(result => result.status === 'rejected') || !Object.values(report.cleanup).every(Boolean)) throw new Error(code);
    })();
    closePromise.catch(() => { closePromise = undefined; });
    return closePromise;
  };
  const save = (name, value, fresh = false) => writeFile(path.join(folder, name), `${JSON.stringify(value, null, 2)}\n`, fresh ? { flag: 'wx' } : undefined);
  const note = (collection, value) => { if (collection.length < 32) collection.push(value); };
  const screenshot = async (who, label, failure = false) => {
    const filename = `${label}.png`;
    await who.page.screenshot({ path: path.join(folder, filename), fullPage: true,
      mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]'), who.page.locator('.workspace-head .account'),
        who.page.locator('[data-care-form="text-review"]'), who.page.locator('[data-care-form="review"] [name="note"]')] });
    report.screenshots.push({ filename, width: who.page.viewportSize().width, syntheticOnly: true, ...(failure ? { failure: true } : {}) });
  };
  try {
    phase = 'SOURCE_CAPTURE'; report.source = await sources(); phase = 'CONFIGURATION';
    const url = new URL(origin);
    assert(url.origin === origin && url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) >= 1024 &&
      !url.username && !url.password && !url.search && !url.hash && id(centerId) && id(conversationId), code);
    assert(onOwned === undefined || typeof onOwned === 'function', code);
    assert.equal(typeof prepareRestart, 'boolean', code);
    assert(careContext && [careContext.goalId, careContext.appointmentId, careContext.guardianId].every(id), code);
    const options = messageBrowserOptions(['--confirm-synthetic-local'], {
      PLAYWRIGHT_MODULE: browserRuntime?.module, STUDY_CHROMIUM_EXECUTABLE: browserRuntime?.executable });
    for (const filename of [options.module, options.executable]) { const info = await lstat(filename); assert(info.isFile() && !info.isSymbolicLink(), code); }
    assert(Array.isArray(credentials) && credentials.length === 2 && ['guardian', 'therapist'].every(role => credentials.filter(c =>
      c.role === role && id(c.userId) && typeof c.email === 'string' && c.email.endsWith('.test') && typeof c.password === 'string' && c.password.length > 0).length === 1), code);
    assert.equal(credentials.find(c => c.role === 'guardian').userId, careContext.guardianId, code);
    assert(Array.isArray(samples) && samples.length === 2, code);
    const chosen = samples.slice();
    assert(chosen.every((s, index) => s?.type === (index === 0 ? 'image/png' : 'video/mp4') && Buffer.isBuffer(s.bytes) &&
      s.bytes.length > 0 && s.bytes.length <= (index === 0 ? 10 : 50) * 1024 ** 2), code);
    assert.notEqual(sha(chosen[0].bytes), sha(chosen[1].bytes), code);
    folder = path.resolve(evidenceDirectory);
    const parent = path.join(root, 'test-results'), basename = path.basename(folder), prefix = 'native-feedback-attachments-';
    assert(path.dirname(folder) === parent && basename.startsWith(prefix) && uuid(basename.slice(prefix.length)), code);
    const parentInfo = await lstat(parent); assert(parentInfo.isDirectory() && !parentInfo.isSymbolicLink(), code);
    assert.equal(path.resolve(await realpath(parent)), path.resolve(parent), code);
    await mkdir(folder); folderOwned = true; await save('ownership.json', ownership, true);
    const { chromium } = await import(pathToFileURL(options.module).href);
    phase = 'BROWSER_STARTUP';
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    const browserProcess = browserServer.process(); lifetime = processLifetime(browserProcess, report);
    onOwned?.(Object.freeze({ close, status: () => Object.freeze(state()) }));
    ownership.browserProcessId = browserProcess.pid; await save('ownership.json', ownership);
    browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    const base = `/api/local/centers/${centerId}/conversations/${conversationId}`, endpoint = `${origin}${base}`;
    const feedbackSaves = [], lost = { armed: false, count: 0, invalid: false, receipt: null };
    let therapistRoomPosts = 0;
    const actor = async (role, width) => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR',
        isMobile: false, hasTouch: false, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
      contexts.add(context); context.once('close', () => contexts.delete(context));
      await context.route('**/*', async route => {
        const request = route.request(), u = new URL(request.url()), method = request.method(), local = u.origin === origin;
        if (!local || !['GET', 'POST', 'HEAD'].includes(method) || !((assets.has(u.pathname) && ['GET', 'HEAD'].includes(method)) || u.pathname.startsWith('/api/local/') || u.protocol === 'blob:')) {
          note(report.unexpectedRequests, { role, phase, sameOrigin: local, method: ['GET', 'POST', 'HEAD'].includes(method) ? method : 'OTHER' });
          return route.abort().catch(() => {});
        }
        if (role === 'therapist' && method === 'POST' && u.pathname.startsWith(base + '/')) therapistRoomPosts++;
        if (role === 'guardian' && method === 'POST' && new RegExp(`^${base}/feedback/[A-Za-z0-9_-]+$`).test(u.pathname)) {
          feedbackSaves.push({ pathname: u.pathname, body: structuredClone(request.postDataJSON()) });
          if (lost.armed) {
            lost.armed = false;
            try {
              const response = await route.fetch({ maxRedirects: 0 });
              try {
                const receipt = (await response.json()).receipt;
                if (response.status() !== 201 || !id(receipt?.feedbackId) || !id(receipt.messageId) || receipt.revision !== 2) lost.invalid = true;
                else { lost.receipt = { feedbackId: receipt.feedbackId, messageId: receipt.messageId, revision: receipt.revision }; lost.count++; }
              } finally { await response.dispose(); }
              await route.abort('failed');
            } catch { lost.invalid = true; await route.abort('failed').catch(() => {}); }
            return;
          }
        }
        return route.continue().catch(() => {});
      });
      if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => {
        note(report.unexpectedRequests, { role, phase, type: 'websocket' }); socket.close();
      });
      const page = await context.newPage(); page.setDefaultTimeout(15_000);
      pages.set(role, { page, context, role });
      page.on('pageerror', () => note(report.errors, { role, phase, type: 'pageerror' }));
      page.on('console', entry => { if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:')) note(report.errors, { role, phase, type: 'console' }); });
      page.on('response', response => {
        if (response.request().method() !== 'GET' || response.status() !== 200) return;
        const u = new URL(response.url()); if (u.origin !== origin || u.search) return;
        const reference = u.pathname.match(new RegExp(`^${base}/records/([A-Za-z0-9_-]+)/revisions/([1-9][0-9]*)/references/([A-Za-z0-9_-]+)/attachments/([a-f0-9-]+)/content$`));
        const feedback = u.pathname.match(new RegExp(`^${base}/messages/([A-Za-z0-9_-]+)/feedback-revisions/([1-9][0-9]*)/attachments/([a-f0-9-]+)/content$`));
        const message = u.pathname.match(new RegExp(`^${base}/messages/([A-Za-z0-9_-]+)/attachments/([a-f0-9-]+)/content$`));
        if (!reference && !feedback && !message) return;
        const anchor = reference ? { kind: 'record-reference', recordId: reference[1], revision: Number(reference[2]), messageId: reference[3], uploadId: reference[4] }
          : feedback ? { kind: 'feedback-revision', messageId: feedback[1], feedbackRevision: Number(feedback[2]), uploadId: feedback[3] }
            : { kind: 'current-message', messageId: message[1], uploadId: message[2] };
        const observationPhase = phase;
        let observation, observationStage = 'anchor';
        observation = (async () => {
          assert(uuid(anchor.uploadId) && (!(reference || feedback) || role === 'therapist'), code);
          assert(report.contentEvidence.length < 24, code);
          observationStage = 'headers';
          const headers = response.headers(), type = headers['content-type'], size = Number(headers['content-length']);
          assert(['image/png', 'video/mp4'].includes(type) && Number.isSafeInteger(size) && size > 0 && size <= (type === 'image/png' ? 10 : 50) * 1024 ** 2, code);
          assert(headers['cache-control']?.includes('no-store') && headers['x-content-type-options'] === 'nosniff', code);
          observationStage = 'body-read';
          const bytes = await response.body();
          try {
            observationStage = 'body-size'; assert.equal(bytes.length, size, code);
            observationStage = 'evidence'; report.contentEvidence.push({ role, ...anchor, type, size, sha256: sha(bytes) });
          }
          finally { bytes.fill(0); }
        })().catch(error => note(report.errors, {
          role, phase: observationPhase, type: 'content-observation', stage: observationStage,
          category: error?.name === 'AssertionError' ? 'assertion' : observationStage === 'body-read' ? 'body-read-failed' : 'runtime',
        })).finally(() => observers.delete(observation));
        observers.add(observation);
      });
      phase = `${role.toUpperCase()}_LOGIN`; const credential = credentials.find(c => c.role === role), userId = credential.userId;
      try {
        await page.goto(origin); await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click(); await page.getByTestId('home').waitFor();
      } finally { credential.email = ''; credential.password = ''; }
      assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie })),
        { local: 0, session: 0, cookie: '' }, code);
      return { context, page, role, userId };
    };
    const therapist = await actor('therapist', 1440), guardian = await actor('guardian', 390);
    const capture = async (who, label) => {
      assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code);
      const viewer = who.page.getByTestId('media-viewer');
      if (await viewer.isVisible()) assert.equal(await viewer.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, code);
      const careDialog = who.page.getByTestId('care-dialog');
      if (await careDialog.isVisible()) assert.equal(await careDialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, code);
      await screenshot(who, label);
    };
    const dialog = who => who.page.getByTestId('care-dialog');
    const response = (who, suffix, method, status) => who.page.waitForResponse(r => r.url() === endpoint + suffix &&
      r.request().method() === method && r.status() === status);
    const collectionSave = (who, collection) => who.page.waitForResponse(r => {
      const u = new URL(r.url()), prefix = base + '/' + collection + '/';
      return u.origin === origin && !u.search && u.pathname.startsWith(prefix) && id(u.pathname.slice(prefix.length)) &&
        r.request().method() === 'POST' && r.status() === 201;
    });
    const action = (who, name, value, key = 'message-id') => who.page.locator('[data-care-action="' + name + '"][data-' + key + '="' + value + '"]');
    const field = async (who, name, value, select = false) => {
      const input = dialog(who).locator('[name="' + name + '"]');
      for (const details of await input.locator('xpath=ancestor::details').all())
        if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
      if (select) await input.selectOption(value); else await input.fill(value);
    };
    const submit = async (who, name) => {
      await dialog(who).getByRole('button', { name, exact: true }).click(); await dialog(who).waitFor({ state: 'hidden' });
    };
    const refreshRoom = async who => {
      await who.page.reload(); await who.page.getByTestId('home').waitFor(); await workspaceRoom(who.page, conversationId);
    };
    const authenticatedGet = async (who, suffix, expected) => {
      // Diagnostic reads only. All mutations below still go through visible UI.
      const reply = await who.context.request.get(endpoint + suffix, { maxRedirects: 0, timeout: 15_000,
        headers: { 'X-Carebridge-Account': who.userId, 'X-Carebridge-Request': '1', Origin: origin } });
      try { assert.equal(reply.status(), expected, code); return expected === 200 ? await reply.json() : null; }
      finally { await reply.dispose(); }
    };
    const viewFile = async (who, button, file, label, expectedTitle = null) => {
      await button.waitFor(); await button.focus(); await button.press('Enter');
      const viewer = who.page.getByTestId('media-viewer'); await viewer.waitFor();
      if (expectedTitle) await viewer.getByRole('heading', { name: expectedTitle, exact: true }).waitFor();
      if (file.type === 'video/mp4') {
        await who.page.waitForFunction(() => { const v = document.querySelector('[data-media-viewer-content] video'); return v?.readyState >= 1 && v.videoWidth > 0; });
        const video = viewer.locator('video'); assert.equal(await video.evaluate(el => el.autoplay), false, code);
        await video.focus(); await video.press('Space');
        await who.page.waitForFunction(() => { const v = document.querySelector('[data-media-viewer-content] video');
          return v && !v.error && v.currentTime > 0 && (v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0) > 0; });
      } else {
        await who.page.waitForFunction(() => { const img = document.querySelector('[data-media-viewer-content] img'); return img?.complete && img.naturalWidth > 0; });
        assert(await viewer.locator('img').evaluate(async img => { await img.decode(); return img.naturalWidth > 0 && img.currentSrc.startsWith('blob:'); }), code);
      }
      assert.equal(await viewer.locator('[data-media-viewer-name]').textContent(), file.name, code);
      assert.equal(await who.page.evaluate(() => globalThis.__careFeedbackXss === undefined), true, code);
      await capture(who, label); await Promise.all([...observers]);
      await viewer.locator('[data-media-viewer-close]').focus(); await viewer.locator('[data-media-viewer-close]').press('Enter');
      await viewer.waitFor({ state: 'detached' }); assert.equal(await button.evaluate(el => el === document.activeElement), true, code);
    };
    const recordInput = async () => dialog(therapist).locator('[data-care-form="record"]').evaluate(form =>
      [...form.querySelectorAll('input[name],textarea[name],select[name]')].map(node => ({
        name: node.name, type: node.type, value: node.value, checked: node.checked === true,
      })));
    const currentReferenceFile = async (messageId, file, expectedSha256, label) => {
      const reference = await revealFeedbackRecordReference(dialog(therapist), messageId);
      const panel = reference.locator('[data-reference-source]');
      const quoteBefore = await reference.locator('[data-reference-quote]').innerText(), inputBefore = await recordInput();
      const inputNode = await dialog(therapist).locator('[name="performed"]').elementHandle();
      const postsBefore = therapistRoomPosts;
      const original = reference.locator('[data-care-action="reference-source"]');
      await original.focus(); await original.press('Enter');
      const button = panel.locator('[data-open-current-reference-attachment="' + file.id + '"][data-message-id="' + messageId + '"]');
      await button.waitFor();
      const evidenceStart = report.contentEvidence.length;
      await viewFile(therapist, button, file, label, '현재 참고 첨부');
      assertCurrentReferenceContentEvidence(report.contentEvidence, evidenceStart, { messageId, file, expectedSha256 });
      assert.equal(await inputNode.evaluate(node => node.isConnected), true, code);
      assert.deepEqual(await recordInput(), inputBefore, code);
      assert.equal(await reference.locator('[data-reference-quote]').innerText(), quoteBefore, code);
      await original.focus(); await original.press('Enter'); await panel.waitFor({ state: 'hidden' });
      assert.equal(await panel.locator('[data-open-current-reference-attachment]').count(), 0, code);
      assert.deepEqual(await recordInput(), inputBefore, code);
      assert.equal(therapistRoomPosts, postsBefore, code);
      await inputNode.dispose();
    };
    const uploadFeedback = async index => {
      const sample = chosen[index], kind = index === 0 ? 'F1_PNG' : 'F2_VIDEO';
      const filename = index === 0 ? '가상-F1-<img src=x onerror=globalThis.__careFeedbackXss=1>-당시사진.png' : '가상-F2-교체한현재영상.mp4';
      const panel = dialog(guardian).locator('[data-feedback-upload]');
      await panel.waitFor(); if (await panel.locator('[data-media-details]').getAttribute('open') === null) await panel.locator('[data-media-details] > summary').click();
      phase = kind + '_SELECT';
      await panel.getByLabel('시험용 사진·영상 선택', { exact: true }).setInputFiles({ name: filename, mimeType: sample.type, buffer: sample.bytes });
      const row = panel.getByTestId('media-upload-row').filter({ hasText: filename }); await row.waitFor();
      assert.equal(await row.locator('.account').textContent(), filename, code);
      assert.equal(await row.locator('img,video,script').count(), 0, code);
      assert.equal(await row.locator('[data-media-share]').count(), 0, code);
      phase = kind + '_UPLOAD';
      const [reserved, received] = await Promise.all([
        response(guardian, '/uploads', 'POST', 200),
        guardian.page.waitForResponse(r => {
          const u = new URL(r.url()); return u.origin === origin && !u.search &&
            u.pathname.startsWith(base + '/uploads/') && u.pathname.endsWith('/content') &&
            r.request().method() === 'POST' && r.status() === 200;
        }),
        row.locator('[data-media-action="upload"]').click(),
      ]);
      const reservation = await reserved.json(), reception = await received.json(), uploadId = reservation.upload?.id;
      assert(uuid(uploadId) && reservation.mode === 'prepared-delivery' && reception.upload?.id === uploadId, code);
      assert.equal(reservation.source.name, filename, code); assert.equal(reservation.source.size, sample.bytes.length, code);
      const observed = { kind, states: [], statusRequests: [] }; report.uploadStates.push(observed);
      const statusObservations = createUploadStatusObservations();
      const observeUpload = upload => {
        const state = ['pending', 'receiving', 'quarantined', 'inspecting', 'ready', 'bound', 'rejected', 'delete_pending', 'deleted'].includes(upload?.state) ? upload.state : 'UNKNOWN';
        const failureCode = upload?.failureCode == null ? null : ['SCAN_INVALID', 'SCAN_UNAVAILABLE', 'SCAN_REJECTED'].includes(upload.failureCode) ? upload.failureCode : 'OTHER';
        const fixed = { state, failureCode };
        if (JSON.stringify(observed.states.at(-1)) !== JSON.stringify(fixed) && observed.states.length < 24) observed.states.push(fixed);
      };
      observeUpload(reception.upload); phase = kind + '_WAIT_REAL_WORKER';
      const deadline = performance.now() + 180_000; let prepared;
      do {
        assert(performance.now() < deadline, code);
        const observation = statusObservations.begin(guardian.page, request => request.method() === 'GET' && request.url() === endpoint + '/uploads/' + uploadId);
        let current;
        try {
          const responseWait = guardian.page.waitForResponse(result => observation.matchesResponse(result) && result.status() === 200)
            .catch(error => { observation.responseWaitFailed(error); throw error; });
          const [currentResponse] = await Promise.all([responseWait, row.locator('[data-media-action="refresh"]').click()]);
          current = await observation.readJson(currentResponse);
        } finally { observed.statusRequests = observation.finish(); }
        assert.equal(current.mode, 'prepared-delivery', code);
        observeUpload(current.upload); assert(!['rejected', 'delete_pending', 'deleted'].includes(current.upload.state), code);
        if (current.upload.state === 'ready') { prepared = current.upload; break; }
        await wait(Math.min(1000, Math.max(0, deadline - performance.now())));
      } while (true);
      await guardian.page.waitForFunction(name => [...document.querySelectorAll('[data-feedback-upload] [data-testid="media-upload-row"]')]
        .some(el => el.textContent.includes(name) && el.textContent.includes('준비 완료')), filename);
      await capture(guardian, '390-' + kind.toLowerCase() + '-ready');
      return { id: uploadId, name: filename, type: sample.type, size: prepared.size };
    };
    const text = { title: '가상 사진 피드백 원본 활동', performed: '가상 치료사 내부 수행', response: '가상 치료사 내부 반응',
      nextPlan: '가상 치료사 내부 다음 계획', privateNote: '가상 보호자 비공개 임상 관찰', summary: '가상 가정 활동 피드백 안내' };
    const f1Text = '가상 F1 처음 사진의 활동 반응', f2Text = '가상 F2 새 영상으로 바꾼 활동 반응', referenceTitle = '가상 F1 사진을 보존한 다음 기록';
    const publicReplyText = '가상 사진을 확인했어요. 다음 놀이에서 함께 살펴볼게요.';
    const feedbackReviewNote = '가상 사진에 대한 치료사 전용 검토 계획';
    const nextContent = { performed: '가상 F1 사진 참고와 직접 관찰 구분', response: '가상 다음 관찰', nextPlan: '가상 다음 놀이',
      privateNote: '가상 다음 기록 내부 계획', summary: '가상 다음 회기에는 놀이 참여를 함께 살펴봅니다.' };
    const nextAssessments = [
      { tool: '가상 도구 A', item: '가상 참여', value: '3', unit: '분', context: '가상 동일 조건' },
      { tool: '가상 도구 B', item: '가상 도움', value: '0', unit: '회', context: '가상 동일 조건' },
    ];
    phase = 'CREATE_PUBLICATION'; await workspaceView(therapist.page, 'home');
    await therapist.page.getByTestId('home').locator('[data-appointment-record="' + careContext.appointmentId + '"][data-context-room="' + conversationId + '"]').click();
    await dialog(therapist).waitFor();
    for (const [name, value] of Object.entries(text)) await field(therapist, name, value);
    await field(therapist, 'goalId', careContext.goalId, true);
    for (const [name, value] of Object.entries({ activityTitle: '가상 가정 사진과 영상', activityInstruction: '가상 활동 뒤 반응을 남겨요',
      activityFrequency: '가상 하루 한 번', activityCaution: '가상 피곤하면 쉬어요' })) await field(therapist, name, value);
    const [createdResponse] = await Promise.all([collectionSave(therapist, 'records'), submit(therapist, '기록 저장')]);
    const created = (await createdResponse.json()).receipt, sourceRecordId = created.recordId;
    assert(id(sourceRecordId) && created.revision === 1, code);
    await workspaceRecords(therapist.page, conversationId);
    const [previewResponse] = await Promise.all([response(therapist, '/records/' + sourceRecordId + '/preview', 'GET', 200),
      action(therapist, 'preview-record', sourceRecordId, 'record-id').click()]);
    await dialog(therapist).waitFor(); const preview = (await previewResponse.json()).preview;
    assert.deepEqual(preview.recipientIds, [careContext.guardianId], code); assert.equal(preview.attachmentCount, 0, code);
    assert.equal(preview.recordRevision, 1, code); assert(!JSON.stringify(preview).includes(text.privateNote), code);
    await dialog(therapist).locator('[name="confirmed"]').check();
    const [publishedResponse] = await Promise.all([response(therapist, '/records/' + sourceRecordId + '/publish', 'POST', 201), submit(therapist, '확인하고 공유')]);
    const publicationMessageId = (await publishedResponse.json()).receipt.messageId; assert(id(publicationMessageId), code);
    report.checks.publication = true;

    phase = 'F1_FEEDBACK_FORM'; await refreshRoom(guardian);
    for (const value of [text.performed, text.response, text.nextPlan, text.privateNote]) assert(!(await guardian.page.locator('body').innerText()).includes(value), code);
    await action(guardian, 'feedback', publicationMessageId).click(); await dialog(guardian).waitFor();
    await field(guardian, 'result', 'partial', true); await field(guardian, 'reaction', f1Text); await field(guardian, 'difficulty', '가상 잠시 쉬었어요');
    const first = await uploadFeedback(0);
    phase = 'F1_FEEDBACK_SAVE';
    const [firstResponse] = await Promise.all([collectionSave(guardian, 'feedback'), submit(guardian, '활동 경험 저장')]);
    const firstReceipt = (await firstResponse.json()).receipt, feedbackId = firstReceipt.feedbackId, messageId = firstReceipt.messageId;
    assert(id(feedbackId) && id(messageId) && firstReceipt.revision === 1, code);
    assert.equal(feedbackSaves.length, 1, code); assert.deepEqual(feedbackSaves[0].body.content.attachments, [{ id: first.id }], code);
    let firstMessage = (await authenticatedGet(therapist, '/feedback/' + feedbackId + '?revision=1', 200)).message;
    assert.equal(firstMessage.feedback.revision, 1, code); assert.deepEqual(firstMessage.attachments, [first], code);
    phase = 'F1_PUBLIC_REPLY_PRIVATE_REVIEW'; await refreshRoom(therapist);
    await action(therapist, 'reply', messageId).click(); await dialog(therapist).waitFor();
    await field(therapist, 'body', publicReplyText);
    const [replyResponse] = await Promise.all([response(therapist, '/messages', 'POST', 201), submit(therapist, '답장 보내기')]);
    const publicReply = (await replyResponse.json()).message;
    assert(id(publicReply.id) && publicReply.body === publicReplyText, code);
    assert.equal(publicReply.quote.id, messageId, code); assert.equal(publicReply.quote.feedbackRevision, 1, code);
    assert.equal(publicReply.quote.body, f1Text, code);
    await action(therapist, 'review', messageId).click(); await dialog(therapist).waitFor();
    await field(therapist, 'note', feedbackReviewNote);
    const [reviewResponse] = await Promise.all([response(therapist, '/feedback/' + feedbackId + '/review', 'POST', 200), submit(therapist, '임상 검토 저장')]);
    const reviewReceipt = (await reviewResponse.json()).receipt;
    assert.equal(reviewReceipt.feedbackId, feedbackId, code); assert.equal(reviewReceipt.revision, 1, code);
    assert.equal(reviewReceipt.reviewVersion, 1, code);
    const review = (await authenticatedGet(therapist, '/feedback/' + feedbackId + '/review', 200)).review;
    assert.equal(review.note, feedbackReviewNote, code); assert.equal(review.reviewed, true, code);
    await authenticatedGet(guardian, '/feedback/' + feedbackId + '/review', 404);
    await refreshRoom(guardian);
    const replyRow = guardian.page.locator('[data-testid="message-row"][data-message-id="' + publicReply.id + '"]');
    await replyRow.waitFor(); assert((await replyRow.innerText()).includes(publicReplyText), code);
    assert(!(await guardian.page.locator('body').innerText()).includes(feedbackReviewNote), code);
    for (const who of [therapist, guardian]) {
      const publicFeedback = (await authenticatedGet(who, '/messages/' + messageId, 200)).message;
      assert.equal(publicFeedback.feedback.reviewed, true, code);
      assert(!JSON.stringify(publicFeedback).includes(feedbackReviewNote), code);
    }
    firstMessage = (await authenticatedGet(therapist, '/feedback/' + feedbackId + '?revision=1', 200)).message;
    assert.equal(firstMessage.feedback.revision, 1, code); assert.deepEqual(firstMessage.attachments, [first], code);
    report.checks.publicReply = true; report.checks.privateReview = true;
    phase = 'F1_EXACT_FEEDBACK_READ'; await refreshRoom(therapist);
    // Exact feedback-version actions live in a source-aware clinical modal,
    // not the current-message attachment buttons in the conversation itself.
    await action(therapist, 'reference', messageId).click(); await dialog(therapist).waitFor();
    await revealFeedbackRecordReference(dialog(therapist), messageId);
    const feedbackButton = (file, revision) => therapist.page.locator('[data-open-feedback-attachment="' + file.id + '"][data-feedback-id="' + feedbackId +
      '"][data-message-id="' + messageId + '"][data-feedback-revision="' + revision + '"]');
    const f1Start = report.contentEvidence.length;
    await viewFile(therapist, feedbackButton(first, 1), first, '1440-f1-exact-feedback');
    const f1Evidence = assertFreshAttachmentContent(report.contentEvidence.slice(f1Start), { role: 'therapist', kind: 'feedback-revision',
      messageId, feedbackRevision: 1, uploadId: first.id, type: first.type, size: first.size });
    await authenticatedGet(guardian, '/messages/' + messageId + '/feedback-revisions/1/attachments/' + first.id + '/content', 404);
    report.checks.firstFeedback = true;

    phase = 'UNSAVED_CURRENT_REFERENCE_PHOTO';
    await currentReferenceFile(messageId, first, f1Evidence.sha256, '1440-unsaved-current-reference-photo');
    const firstAfterCurrent = (await authenticatedGet(therapist, '/feedback/' + feedbackId + '?revision=1', 200)).message;
    // Read cursors may legitimately advance in the chat before the modal opens;
    // compare the stored feedback and bound files, not that derived read badge.
    assert.deepEqual(firstAfterCurrent.feedback, firstMessage.feedback, code);
    assert.deepEqual(firstAfterCurrent.attachments, firstMessage.attachments, code);
    report.checks.unsavedCurrentReferencePhoto = true;

    phase = 'EXPLICIT_REFERENCE_SAVE';
    await field(therapist, 'title', referenceTitle); await field(therapist, 'goalId', careContext.goalId, true);
    for (const [name, value] of Object.entries(nextContent))
      await field(therapist, name, value);
    assert.equal(await dialog(therapist).locator('[data-assessment-row]').count(), 0, code);
    for (const [index, assessment] of nextAssessments.entries()) {
      const add = dialog(therapist).locator('[data-care-action="add-assessment"]');
      for (const details of await add.locator('xpath=ancestor::details').all())
        if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
      await add.click();
      for (const [key, value] of Object.entries(assessment)) await field(therapist, `assessment-${index}-${key}`, value);
    }
    const [referenceResponse] = await Promise.all([collectionSave(therapist, 'records'), submit(therapist, '기록 저장')]);
    const referenceReceipt = (await referenceResponse.json()).receipt, recordId = referenceReceipt.recordId;
    assert(id(recordId) && recordId !== sourceRecordId && referenceReceipt.revision === 1, code);
    const referenceRequest = referenceResponse.request().postDataJSON();
    assert.deepEqual(referenceRequest.content.referenceMessageIds, [messageId], code);
    assert.deepEqual(referenceRequest.content.referenceFeedbackRevisions, [{ messageId, revision: 1 }], code);
    const checkReference = record => {
      assert.equal(record.id, recordId, code); assert.equal(record.revision, 1, code);
      assert.equal(record.title, referenceTitle, code); assert.equal(record.goalId, careContext.goalId, code);
      for (const [name, value] of Object.entries(nextContent)) assert.equal(record[name], value, code);
      assert.deepEqual(record.assessments.map(({ tool, item, value, unit, context }) => ({ tool, item, value: String(value), unit, context })), nextAssessments, code);
      assert.equal(record.attachmentCount, 0, code); assert.deepEqual(record.attachments, [], code);
      assert.deepEqual(record.referenceMessageIds, [messageId], code); assert.equal(record.referenceSources.length, 1, code);
      const source = record.referenceSources[0]; assert.equal(source.messageId, messageId, code);
      assert.equal(source.feedbackId, feedbackId, code); assert.equal(source.feedbackRevision, 1, code);
      assert.equal(source.attachmentCount, 1, code); assert.deepEqual(source.attachments, [first], code);
    };
    checkReference((await authenticatedGet(therapist, '/records/' + recordId, 200)).record);
    report.checks.pinnedReference = true; report.checks.nextStructuredRecord = true;

    phase = 'NEXT_RECORD_PREVIEW_AND_SHARE'; await workspaceRecords(therapist.page, conversationId);
    const [nextPreviewResponse] = await Promise.all([response(therapist, '/records/' + recordId + '/preview', 'GET', 200),
      action(therapist, 'preview-record', recordId, 'record-id').click()]);
    await dialog(therapist).waitFor(); const nextPreview = (await nextPreviewResponse.json()).preview;
    assert.equal(nextPreview.recordId, recordId, code); assert.equal(nextPreview.recordRevision, 1, code);
    assert.deepEqual(nextPreview.recipientIds, [careContext.guardianId], code);
    assert.equal(nextPreview.title, referenceTitle, code); assert.equal(nextPreview.summary, nextContent.summary, code);
    assert.equal(nextPreview.attachmentCount, 0, code); assert.deepEqual(nextPreview.attachments, [], code);
    assert.deepEqual(await dialog(therapist).locator('[data-share-recipients] li').allTextContents(), ['가상 보호자'], code);
    const nextPrivate = [nextContent.performed, nextContent.response, nextContent.nextPlan, nextContent.privateNote,
      feedbackReviewNote, f1Text, first.name, ...nextAssessments.flatMap(value => [value.tool, value.item])];
    for (const value of nextPrivate) {
      assert(!(await dialog(therapist).innerText()).includes(value), code); assert(!JSON.stringify(nextPreview).includes(value), code);
    }
    assert.equal(await dialog(therapist).locator('[data-open-record-attachment]').count(), 0, code);
    await capture(therapist, '1440-next-record-public-preview'); await dialog(therapist).locator('[name="confirmed"]').check();
    const [nextPublishedResponse] = await Promise.all([response(therapist, '/records/' + recordId + '/publish', 'POST', 201), submit(therapist, '확인하고 공유')]);
    const nextPublicationId = (await nextPublishedResponse.json()).receipt.messageId; assert(id(nextPublicationId), code);
    const nextPublishRequest = nextPublishedResponse.request().postDataJSON();
    assert.equal(nextPublishRequest.expectedRevision, 1, code);
    assert.equal(nextPublishRequest.expectedRelationshipsVersion, nextPreview.relationshipsVersion, code);
    assert.deepEqual(nextPublishRequest.recipientIds, nextPreview.recipientIds, code);
    const assertNextPublication = async () => {
      const current = (await authenticatedGet(guardian, '/messages/' + nextPublicationId, 200)).message;
      assert.equal(current.publication.recordId, recordId, code); assert.equal(current.publication.recordRevision, 1, code);
      assert.equal(current.publication.summary, nextContent.summary, code); assert.equal(current.hidden, false, code); assert.equal(current.archived, false, code);
      assert.equal(current.attachmentCount, 0, code); assert.deepEqual(current.attachments, [], code);
      for (const value of nextPrivate) assert(!JSON.stringify(current).includes(value), code);
      const card = guardian.page.locator('[data-testid="message-row"][data-message-id="' + nextPublicationId + '"]');
      await card.waitFor(); assert((await card.innerText()).includes(nextContent.summary), code);
    };
    await refreshRoom(guardian); await assertNextPublication(); await capture(guardian, '390-next-record-received');
    report.checks.nextRecordShare = true;

    phase = 'F2_REPLACE_FORM'; await refreshRoom(guardian);
    await action(guardian, 'edit-feedback', messageId).click(); await dialog(guardian).waitFor();
    const savedFile = dialog(guardian).locator('[data-feedback-attachment="' + first.id + '"]');
    await savedFile.waitFor(); assert((await savedFile.innerText()).includes(first.name), code);
    await savedFile.locator('[data-care-action="remove-feedback-attachment"][data-attachment-id="' + first.id + '"]').click();
    await savedFile.waitFor({ state: 'detached' }); await field(guardian, 'reaction', f2Text);
    const second = await uploadFeedback(1);
    phase = 'F2_COMMIT_RESPONSE_LOSS'; lost.armed = true;
    await dialog(guardian).getByRole('button', { name: '활동 경험 저장', exact: true }).click();
    await dialog(guardian).getByRole('button', { name: '같은 요청 다시 확인', exact: true }).waitFor();
    assert.equal(lost.invalid, false, code); assert.equal(lost.count, 1, code);
    assert.deepEqual(lost.receipt, { feedbackId, messageId, revision: 2 }, code);
    const uploadPanel = dialog(guardian).locator('[data-feedback-upload]');
    if (await uploadPanel.isVisible()) assert.equal(await uploadPanel.locator('input[type="file"]').isDisabled(), true, code);
    const [retryResponse] = await Promise.all([response(guardian, '/feedback/' + feedbackId, 'POST', 201), submit(guardian, '같은 요청 다시 확인')]);
    const retry = (await retryResponse.json()).receipt;
    assert.equal(retry.feedbackId, feedbackId, code); assert.equal(retry.messageId, messageId, code);
    assert.equal(retry.revision, 2, code); assert.equal(retry.replayed, true, code);
    assert.equal(feedbackSaves.length, 3, code); assert.deepEqual(feedbackSaves[1], feedbackSaves[2], code);
    assert.equal(feedbackSaves[1].body.expectedRevision, 1, code);
    assert.deepEqual(feedbackSaves[1].body.content.attachments, [{ id: second.id }], code);
    report.checks.replacementRetry = true;

    phase = 'F2_CURRENT_FEEDBACK'; await refreshRoom(therapist);
    const latest = (await authenticatedGet(therapist, '/messages/' + messageId, 200)).message;
    assert.equal(latest.feedback.revision, 2, code); assert.deepEqual(latest.attachments, [second], code);
    const preservedReply = (await authenticatedGet(therapist, '/messages/' + publicReply.id, 200)).message;
    assert.equal(preservedReply.body, publicReplyText, code); assert.equal(preservedReply.quote.feedbackRevision, 1, code);
    assert.equal(preservedReply.quote.body, f1Text, code);
    await action(therapist, 'review', messageId).click(); await dialog(therapist).waitFor();
    const f2Start = report.contentEvidence.length;
    await viewFile(therapist, feedbackButton(second, 2), second, '1440-f2-current-video');
    const f2Evidence = assertFreshAttachmentContent(report.contentEvidence.slice(f2Start), { role: 'therapist', kind: 'feedback-revision',
      messageId, feedbackRevision: 2, uploadId: second.id, type: second.type, size: second.size });
    assert.notEqual(f2Evidence.sha256, f1Evidence.sha256, code);
    await submit(therapist, '입력 취소');
    await refreshRoom(guardian);
    const guardianButton = guardian.page.locator('[data-open-attachment="' + second.id + '"][data-message-id="' + messageId + '"]');
    const guardianStart = report.contentEvidence.length;
    await viewFile(guardian, guardianButton, second, '390-f2-guardian-video');
    assertFreshAttachmentContent(report.contentEvidence.slice(guardianStart), { role: 'guardian', kind: 'current-message',
      messageId, uploadId: second.id, type: second.type, size: second.size }, f2Evidence);
    await authenticatedGet(guardian, '/messages/' + messageId + '/attachments/' + first.id + '/content', 404);
    await authenticatedGet(guardian, '/messages/' + messageId + '/feedback-revisions/2/attachments/' + second.id + '/content', 404);
    report.checks.currentSecondFile = true;

    const referencePath = file => '/records/' + recordId + '/revisions/1/references/' + messageId + '/attachments/' + file.id + '/content';
    const openReferenceRecord = async () => {
      await workspaceRecords(therapist.page, conversationId);
      const [read] = await Promise.all([response(therapist, '/records/' + recordId, 'GET', 200),
        action(therapist, 'edit-record', recordId, 'record-id').click()]);
      await dialog(therapist).waitFor(); const record = (await read.json()).record; checkReference(record);
      await revealFeedbackRecordReference(dialog(therapist), messageId);
      return dialog(therapist).locator('[data-open-reference-attachment="' + first.id + '"][data-record-id="' + recordId +
        '"][data-record-revision="1"][data-message-id="' + messageId + '"]');
    };
    const assertPinnedBytes = () => {
      const evidence = report.contentEvidence.filter(e => e.role === 'therapist' && e.kind === 'record-reference' &&
        e.recordId === recordId && e.revision === 1 && e.messageId === messageId && e.uploadId === first.id);
      assert(evidence.length > 0 && evidence.every(e => e.sha256 === f1Evidence.sha256 && e.size === first.size && e.type === first.type), code);
      assert(!report.contentEvidence.some(e => e.kind === 'record-reference' && e.uploadId === second.id), code);
      return evidence.length;
    };
    const viewPinnedFile = async (button, label) => {
      const start = report.contentEvidence.length;
      await viewFile(therapist, button, first, label);
      assertFreshAttachmentContent(report.contentEvidence.slice(start), { role: 'therapist', kind: 'record-reference',
        recordId, revision: 1, messageId, uploadId: first.id, type: first.type, size: first.size }, f1Evidence);
    };
    phase = 'PINNED_F1_AFTER_F2'; let referenceButton = await openReferenceRecord();
    assert((await dialog(therapist).innerText()).includes(f1Text), code);
    assert(!(await dialog(therapist).innerText()).includes(f2Text), code);
    await viewPinnedFile(referenceButton, '1440-pinned-f1-after-f2');
    assertPinnedBytes();
    await therapist.page.setViewportSize({ width: 320, height: 900 }); await capture(therapist, '320-pinned-reference');
    await viewPinnedFile(referenceButton, '320-pinned-reference-viewer');
    phase = 'CURRENT_F2_FROM_PINNED_F1_RECORD';
    const savedBeforeCurrent = (await authenticatedGet(therapist, '/records/' + recordId, 200)).record;
    const performedBeforeCurrent = await dialog(therapist).locator('[name="performed"]').inputValue();
    await field(therapist, 'performed', performedBeforeCurrent + ' · 가상 미저장 입력 보존');
    await currentReferenceFile(messageId, second, f2Evidence.sha256, '320-current-f2-from-pinned-f1');
    assert.deepEqual((await authenticatedGet(therapist, '/records/' + recordId, 200)).record, savedBeforeCurrent, code);
    checkReference(savedBeforeCurrent); assertPinnedBytes();
    assert.equal(await dialog(therapist).locator('[data-open-reference-attachment="' + first.id + '"]').count(), 1, code);
    assert.equal(await dialog(therapist).locator('[data-open-reference-attachment="' + second.id + '"]').count(), 0, code);
    report.checks.currentReferenceVideo = true;
    await therapist.page.setViewportSize({ width: 1440, height: 900 });
    await authenticatedGet(therapist, referencePath(second), 404);
    await authenticatedGet(guardian, referencePath(first), 404);
    await submit(therapist, '입력 취소'); report.checks.pinnedFirstFile = true;

    phase = 'WITHDRAW_PUBLICATION'; await workspaceRoom(therapist.page, conversationId);
    await action(therapist, 'withdraw', publicationMessageId).click(); await dialog(therapist).waitFor();
    const [withdrawnResponse] = await Promise.all([response(therapist, '/publications/' + publicationMessageId + '/withdraw', 'POST', 200),
      submit(therapist, '공유 종료 확인')]);
    assert.equal((await withdrawnResponse.json()).message.id, publicationMessageId, code);
    await refreshRoom(guardian);
    const guardianText = await guardian.page.locator('body').innerText();
    for (const value of [first.name, second.name, f1Text, f2Text, text.privateNote]) assert(!guardianText.includes(value), code);
    assert.equal(await guardian.page.locator('[data-open-attachment="' + second.id + '"]').count(), 0, code);
    for (const [revision, file] of [[1, first], [2, second]]) {
      await authenticatedGet(guardian, '/messages/' + messageId + '/attachments/' + file.id + '/content', 404);
      await authenticatedGet(guardian, '/messages/' + messageId + '/feedback-revisions/' + revision + '/attachments/' + file.id + '/content', 404);
    }
    for (const hiddenId of [publicationMessageId, messageId]) {
      const hidden = (await authenticatedGet(guardian, '/messages/' + hiddenId, 200)).message;
      assert.equal(hidden.hidden, true, code); assert.equal(hidden.archived, true, code); assert.equal(hidden.attachmentCount, 0, code);
      for (const key of ['publication', 'feedback', 'attachments']) assert(!Object.hasOwn(hidden, key), code);
      for (const value of [first.name, second.name, f1Text, f2Text, text.privateNote, feedbackReviewNote]) assert(!JSON.stringify(hidden).includes(value), code);
    }
    await authenticatedGet(guardian, referencePath(first), 404);
    await capture(guardian, '390-withdrawn-feedback'); report.checks.withdrawalDenial = true;
    await assertNextPublication();
    const retainedPublicReply = (await authenticatedGet(guardian, '/messages/' + publicReply.id, 200)).message;
    assertRetainedReplyRedaction(retainedPublicReply, { replyId: publicReply.id, body: publicReplyText, sourceId: messageId,
      privateValues: [f1Text, f2Text, first.name, second.name, feedbackReviewNote, text.privateNote] });
    await guardian.page.locator('[data-testid="message-row"][data-message-id="' + publicReply.id + '"]').waitFor();
    report.checks.independentSharePreserved = true;

    phase = 'RETAINED_REFERENCE_AFTER_WITHDRAWAL'; await therapist.page.reload(); await therapist.page.getByTestId('home').waitFor();
    const countBefore = assertPinnedBytes(); referenceButton = await openReferenceRecord();
    await viewPinnedFile(referenceButton, '1440-retained-reference-after-withdrawal');
    assert(assertPinnedBytes() > countBefore, code); report.checks.retainedReference = true;
    await submit(therapist, '입력 취소');
    await therapist.page.reload(); await therapist.page.getByTestId('home').waitFor();
    referenceButton = await openReferenceRecord(); await referenceButton.waitFor(); await capture(therapist, '1440-reference-reload');
    await viewPinnedFile(referenceButton, '1440-reference-reload-photo');
    await submit(therapist, '입력 취소'); report.checks.reload = true;
    report.reference = { sourceRecordId, publicationMessageId, feedbackId, messageId, firstFeedbackRevision: 1, currentFeedbackRevision: 2,
      recordId, recordRevision: 1, firstUploadId: first.id, currentUploadId: second.id };
    report.connectedFlow = { publicReplyId: publicReply.id, nextPublicationId, assessmentCount: nextAssessments.length };
    if (prepareRestart) {
      // The private review endpoint exposes the CURRENT feedback revision only.
      // Review F2 explicitly; never compare the old F1 note with this projection.
      phase = 'RESTART_CURRENT_FEEDBACK_REVIEW'; await workspaceRoom(therapist.page, conversationId);
      const feedbackReviewPath = '/feedback/' + feedbackId + '/review';
      const initialFeedbackReview = (await authenticatedGet(therapist, feedbackReviewPath, 200)).review;
      assert.deepEqual(initialFeedbackReview, { feedbackId, revision: 2, reviewVersion: 0, note: '', reviewed: false, reviewedAt: null }, code);
      await action(therapist, 'review', messageId).click(); await dialog(therapist).waitFor();
      const currentFeedbackNote = '가상 영상 버전의 재시작 보존 검토';
      await field(therapist, 'note', currentFeedbackNote);
      const [currentReviewResponse] = await Promise.all([response(therapist, feedbackReviewPath, 'POST', 200), submit(therapist, '임상 검토 저장')]);
      const currentReviewRequest = currentReviewResponse.request().postDataJSON();
      const currentReviewReceipt = (await currentReviewResponse.json()).receipt;
      assert.deepEqual(currentReviewRequest, { clientId: currentReviewRequest.clientId, expectedRevision: 2, expectedReviewVersion: 0, note: currentFeedbackNote }, code);
      assert(uuid(currentReviewRequest.clientId), code);
      assert.deepEqual(currentReviewReceipt, { feedbackId, revision: 2, reviewVersion: 1, messageId, operation: 'review', replayed: false }, code);
      const currentReview = (await authenticatedGet(therapist, feedbackReviewPath, 200)).review;
      assert.deepEqual(currentReview, { feedbackId, revision: 2, reviewVersion: 1, note: currentFeedbackNote, reviewed: true, reviewedAt: currentReview.reviewedAt }, code);
      assert(typeof currentReview.reviewedAt === 'string' && Number.isFinite(Date.parse(currentReview.reviewedAt)), code);
      await authenticatedGet(guardian, feedbackReviewPath, 404);
      for (const who of [therapist, guardian]) assert(!JSON.stringify((await authenticatedGet(who, '/messages/' + messageId, 200)).message).includes(currentFeedbackNote), code);
      report.checks.currentFeedbackReviewStored = true;
      phase = 'RESTART_MESSAGE_BASELINE';
      const send = async (who, body) => {
        await who.page.bringToFront(); await workspaceRoom(who.page, conversationId); await who.page.locator('#message').fill(body);
        const [sent] = await Promise.all([response(who, '/messages', 'POST', 201), who.page.locator('.composer').getByRole('button', { name: '보내기', exact: true }).click()]);
        const value = (await sent.json()).message; assert(value && id(value.id) && value.body === body, code); return value;
      };
      const inbox = async who => {
        const reply = await who.context.request.get(origin + '/api/local/centers/' + centerId + '/inbox?limit=100', {
          maxRedirects: 0, timeout: 15_000, headers: { 'X-Carebridge-Account': who.userId } });
        try {
          assert.equal(reply.status(), 200, code); const value = await reply.json();
          assert.equal(value.hasMore, false, code);
          return value.rooms.map(room => ({ conversationId: room.conversationId, lastRead: room.lastRead, unread: room.unread, targetId: room.targetId })).sort((a, b) => a.conversationId.localeCompare(b.conversationId));
        } finally { await reply.dispose(); }
      };
      const waitRead = async (who, sequence) => {
        await who.page.bringToFront();
        await who.page.locator('[data-testid="message-row"][data-sequence="' + sequence + '"]').scrollIntoViewIfNeeded();
        const deadline = performance.now() + 15_000;
        do {
          const current = await inbox(who), room = current.find(item => item.conversationId === conversationId);
          if (room?.lastRead >= sequence) return current;
          assert(performance.now() < deadline, code); await wait(100);
        } while (true);
      };
      const original = await send(therapist, '가상 재접속 후에도 남는 독립 소식');
      await refreshRoom(guardian);
      await guardian.page.locator('[data-message-id="' + original.id + '"] .care-message-menu > summary').click();
      await action(guardian, 'reply', original.id).click(); await dialog(guardian).waitFor();
      await field(guardian, 'body', '가상 재접속 인용 답변');
      const [quotedResponse] = await Promise.all([response(guardian, '/messages', 'POST', 201), submit(guardian, '답장 보내기')]);
      const quoted = (await quotedResponse.json()).message;
      assert.equal(quoted.quote.id, original.id, code); assert.equal(quoted.quote.version, 1, code); assert.equal(quoted.quote.body, original.body, code);
      await refreshRoom(guardian); await waitRead(guardian, quoted.sequence);
      await workspaceView(guardian.page, 'home');
      const guardianBefore = await inbox(guardian);
      await refreshRoom(therapist); await waitRead(therapist, quoted.sequence);

      phase = 'RESTART_TEXT_REVIEW_STORE';
      // A guardian-authored ordinary text, independent of the withdrawn
      // publication/feedback, exercises the private review's real runtime role.
      assert.equal(quoted.authorId, guardian.userId, code); assert.equal(quoted.version, 1, code);
      const reviewPath = '/messages/' + quoted.id + '/review';
      const initialReview = (await authenticatedGet(therapist, reviewPath, 200)).review;
      assert.deepEqual(initialReview, { messageId: quoted.id, conversationId, revision: 1,
        reviewVersion: 0, reviewedRevision: null, note: '', body: quoted.body, attachmentCount: 0 }, code);
      const reviewRow = therapist.page.locator('[data-testid="message-row"][data-message-id="' + quoted.id + '"]');
      await reviewRow.locator('.care-message-menu > summary').click();
      await action(therapist, 'text-review', quoted.id).click();
      await dialog(therapist).locator('[data-care-form="text-review"]').waitFor();
      const privateReviewNote = '가상 재접속 후에도 유지할 비공개 반영 메모';
      await field(therapist, 'note', privateReviewNote);
      const [reviewResponse] = await Promise.all([response(therapist, reviewPath, 'POST', 200), submit(therapist, '반영 확인 저장')]);
      const reviewRequest = reviewResponse.request().postDataJSON(), reviewReceipt = (await reviewResponse.json()).receipt;
      assert.deepEqual(Object.keys(reviewRequest).sort(), ['clientId', 'expectedRevision', 'expectedReviewVersion', 'note'].sort(), code);
      assert(uuid(reviewRequest.clientId), code);
      assert.deepEqual(reviewRequest, { clientId: reviewRequest.clientId, expectedRevision: 1, expectedReviewVersion: 0, note: privateReviewNote }, code);
      assert.deepEqual(reviewReceipt, { messageId: quoted.id, revision: 1, reviewVersion: 1, operation: 'review', replayed: false }, code);
      const savedReview = (await authenticatedGet(therapist, reviewPath, 200)).review;
      assert.deepEqual(savedReview, { ...initialReview, reviewVersion: 1, reviewedRevision: 1, note: privateReviewNote }, code);
      report.checks.textReviewStored = true;
      phase = 'RESTART_TEXT_REVIEW_PRIVACY';
      await authenticatedGet(guardian, reviewPath, 404);
      for (const who of [guardian, therapist]) {
        const current = (await authenticatedGet(who, '/messages/' + quoted.id, 200)).message;
        assert.equal(current.reviewed, true, code); assert.equal(current.body, quoted.body, code);
        assert(!JSON.stringify(current).includes(privateReviewNote), code);
        for (const key of ['reviewNote', 'note', 'reviewedAt', 'reviewerId', 'reviewVersion', 'reviewedRevision']) assert(!Object.hasOwn(current, key), code);
      }
      assert(!(await guardian.page.locator('body').innerText()).includes(privateReviewNote), code);
      report.checks.textReviewPrivacy = true;
      phase = 'RESTART_MESSAGE_BASELINE';
      const marker = await send(therapist, '가상 재접속 전 아직 읽지 않은 마지막 소식');
      await waitRead(therapist, marker.sequence); await workspaceView(therapist.page, 'home');
      const baselines = { guardian: await inbox(guardian), therapist: await inbox(therapist) };
      const beforeRoom = guardianBefore.find(item => item.conversationId === conversationId);
      const guardianRoom = baselines.guardian.find(item => item.conversationId === conversationId);
      assert.equal(beforeRoom.unread, 0, code);
      assert.equal(guardianRoom.lastRead, beforeRoom.lastRead, code); assert.equal(guardianRoom.unread, beforeRoom.unread + 1, code);
      assert.equal(guardianRoom.targetId, marker.id, code);
      assert.equal(baselines.therapist.find(item => item.conversationId === conversationId).unread, 0, code);
      const stable = message => Object.fromEntries(['id', 'conversationId', 'sequence', 'authorId', 'createdAt', 'type', 'body', 'version', 'quote'].filter(key => message[key] !== undefined).map(key => [key, message[key]]));
      const pinnedFeedbackMessage = (await authenticatedGet(therapist, '/feedback/' + feedbackId + '?revision=1', 200)).message;
      const pinnedFeedback = { messageId: pinnedFeedbackMessage.id, feedbackId: pinnedFeedbackMessage.feedback.id,
        revision: pinnedFeedbackMessage.feedback.revision, body: pinnedFeedbackMessage.body };
      assert.deepEqual(pinnedFeedback, { messageId, feedbackId, revision: 1, body: f1Text }, code);
      assert.equal(pinnedFeedbackMessage.feedback.reaction, f1Text, code);
      restartCheckpoint = {
        schema: 2, centerId, conversationId, roles: { guardian: guardian.userId, therapist: therapist.userId },
        reference: { ...report.reference }, first: { ...first, sha256: f1Evidence.sha256 }, second: { ...second, sha256: f2Evidence.sha256 },
        record: (await authenticatedGet(therapist, '/records/' + recordId, 200)).record,
        sourceRecord: (await authenticatedGet(therapist, '/records/' + sourceRecordId, 200)).record,
        feedback: (await authenticatedGet(therapist, '/messages/' + messageId, 200)).message.feedback,
        messages: [stable(original), stable(quoted), stable(marker)], baselines,
        textReview: { review: structuredClone(savedReview), request: structuredClone(reviewRequest), receipt: structuredClone(reviewReceipt) },
        connectedFlow: {
          pinnedFeedback,
          publicReplies: {
            guardian: stableConnectedMessage((await authenticatedGet(guardian, '/messages/' + publicReply.id, 200)).message),
            therapist: stableConnectedMessage((await authenticatedGet(therapist, '/messages/' + publicReply.id, 200)).message),
          },
          nextPublication: stableConnectedMessage((await authenticatedGet(guardian, '/messages/' + nextPublicationId, 200)).message),
          feedbackReview: { review: currentReview, request: currentReviewRequest, receipt: currentReviewReceipt },
        },
        replay: { pathname: feedbackSaves[1].pathname, body: structuredClone(feedbackSaves[1].body), receipt: structuredClone(retry) },
        forbidden: [...new Set([first.name, second.name, f1Text, f2Text, text.privateNote, ...nextPrivate, currentFeedbackNote, privateReviewNote])],
      };
      assert.equal((await authenticatedGet(therapist, '/messages/' + marker.id, 200)).message.read, false, code);
      report.restartPrepared = true;
      await capture(guardian, '390-restart-home-unread'); await capture(therapist, '1440-restart-home');
    }
    await Promise.all([...observers]); assert.equal(report.errors.length, 0, code); assert.equal(report.unexpectedRequests.length, 0, code);
  } catch (error) {
    report.failure = { code, phase, category: error?.name === 'AssertionError' ? 'assertion' : 'runtime-or-timeout' };
    // At most one masked screenshot per synthetic actor, before owned pages
    // close. Never serialize raw errors, selectors, credentials or page HTML.
    if (folderOwned) for (const who of [...pages.values()].slice(0, 2)) {
      try { if (!who.page.isClosed()) await screenshot(who, `failure-${who.role}`, true); }
      catch { note(report.errors, { role: who.role, phase, type: 'failure-screenshot' }); }
    }
  } finally {
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
    report.passed = !report.failure && !report.cleanupObservationTimedOut && Object.values(report.checks).every(Boolean) && report.errors.length === 0 && report.unexpectedRequests.length === 0 && Object.values(report.cleanup).every(Boolean);
    if (folderOwned) {
      try { await save('ownership.json', ownership); await save('results.json', report, true); }
      catch { report.failure ??= { code, phase: 'EVIDENCE_WRITE', category: 'io' }; report.passed = false; }
    }
  }
  if (!report.passed) { const error = new Error(code); error.browserObservation = report; throw error; }
  return restartCheckpoint ? attachRestartCheckpoint(report, restartCheckpoint) : report;
}

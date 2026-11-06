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
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceRecords, workspaceRoom, workspaceView } from './local-workspace-browser-helpers.mjs';
import { createUploadStatusObservations } from './native-upload-status-observation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const code = 'NATIVE_RECORD_ATTACHMENTS_BROWSER_FAILED';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const assets = new Set(['/', '/favicon.ico', '/local-api/client.js', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/styles.css',
  '/local-api/care-client.js', '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/media-client.js',
  '/local-api/media-ui.js', '/local-api/media-viewer.js', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js']);

// Consume one explicit leading test-mode flag. The existing E-drive parser
// still validates every remaining argument; no path/session override is added.
export function syntheticSessionCheckOptions(input) {
  assert(Array.isArray(input), code);
  const recordAttachments = input[0] === '--record-attachments';
  const args = input.slice(recordAttachments ? 1 : 0);
  windowsPostgresOptions(args);
  return Object.freeze({ recordAttachments, args: Object.freeze(args) });
}

export function assertSelectedRecordPreview(preview, expected) {
  for (const key of ['recordId', 'recordRevision', 'date', 'title', 'summary']) assert.equal(preview[key], expected[key], code);
  assert(Number.isSafeInteger(preview.relationshipsVersion) && preview.relationshipsVersion >= 0, code);
  assert.deepEqual(preview.recipientIds, expected.recipientIds, code);
  assert.deepEqual(preview.activity, expected.activity, code);
  assert.equal(preview.attachmentCount, 1, code);
  assert.deepEqual(preview.attachments, [{ ...expected.file, share: true }], code);
  for (const value of expected.privateValues) assert(!JSON.stringify(preview).includes(value), code);
}

// Caller supplies only observations made after the current viewer action.
// A previous successful download cannot stand in for a fresh reload/download.
export function assertFreshAttachmentContent(observations, expected, previous = undefined) {
  const anchor = Object.entries(expected).filter(([key]) => !['type', 'size'].includes(key));
  const matching = observations.filter(entry => anchor.every(([key, value]) => entry[key] === value));
  assert(matching.length > 0, code);
  const baseline = previous ?? matching[0];
  for (const entry of matching) {
    // A later correct response must not conceal an inconsistent response for
    // the same role, immutable record/message anchor and upload, even on the first read.
    for (const [key, value] of Object.entries(expected)) assert.equal(entry[key], value, code);
    assert(/^[a-f0-9]{64}$/.test(entry.sha256), code);
    for (const key of ['uploadId', 'type', 'size', 'sha256']) assert.equal(entry[key], baseline[key], code);
  }
  return matching.at(-1);
}

async function sources() {
  const resumeSources = ['tests/windows-synthetic-resume-check.mjs', 'tests/synthetic-resume-process.mjs',
    'scripts/windows-synthetic-session-vault-provider.ps1', 'scripts/check-synthetic-session-storage.ps1'];
  const names = ['tests/native-record-attachments-browser-helper.mjs', 'tests/windows-synthetic-session-check.mjs',
    'tests/native-feedback-attachments-browser-helper.mjs', 'tests/native-upload-status-observation.mjs', 'tests/native-api-restart-browser-helper.mjs',
    'tests/native-prepared-media-browser-helper.mjs', 'tests/native-interactive-care-browser-helper.mjs', 'tests/native-reply-source-browser-helper.mjs',
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

export async function exerciseRecordAttachmentsBrowser({ origin, centerId, conversationId, credentials, samples,
  evidenceDirectory, browserRuntime, onOwned, careContext } = {}) {
  const report = { runId: randomUUID(), mode: 'record-attachments', startedAt: new Date().toISOString(), passed: false,
    checks: { privateDefaults: false, preparedUploads: false, exactSaveRetry: false, privateRevisionRead: false,
      explicitPreview: false, readOnlyPreview: false, selectedShare: false, publicProjection: false,
      guardianVideo: false, privateFileDenied: false, reload: false },
    contentEvidence: [], uploadStates: [], screenshots: [], errors: [], unexpectedRequests: [], failure: null,
    source: null, sourceAfter: null, cleanup: { contextsClosed: false, browserStopped: false }, cleanupObservationTimedOut: false,
    limitations: ['Fresh synthetic accounts and same-machine isolated Chromium contexts; not physical devices or real users.',
      'Real caller-owned native worker only. One PNG and one MP4 remain within the unchanged 120 MiB reservation ceiling.',
      'Only a committed record-save response is lost; no approval, API success, database write or role is simulated.',
      'Feedback file attachments and production access are outside this check.'] };
  let phase = 'CONFIGURATION', folder, folderOwned = false, browserServer, browser, lifetime, closePromise, closing = false;
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
      mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]'), who.page.locator('.workspace-head .account')] });
    report.screenshots.push({ filename, width: who.page.viewportSize().width, syntheticOnly: true, ...(failure ? { failure: true } : {}) });
  };
  try {
    phase = 'SOURCE_CAPTURE'; report.source = await sources(); phase = 'CONFIGURATION';
    const url = new URL(origin);
    assert(url.origin === origin && url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) >= 1024 &&
      !url.username && !url.password && !url.search && !url.hash && id(centerId) && id(conversationId), code);
    assert(onOwned === undefined || typeof onOwned === 'function', code);
    assert(careContext && [careContext.goalId, careContext.appointmentId, careContext.guardianId].every(id), code);
    const options = messageBrowserOptions(['--confirm-synthetic-local'], {
      PLAYWRIGHT_MODULE: browserRuntime?.module, STUDY_CHROMIUM_EXECUTABLE: browserRuntime?.executable });
    for (const filename of [options.module, options.executable]) { const info = await lstat(filename); assert(info.isFile() && !info.isSymbolicLink(), code); }
    assert(Array.isArray(credentials) && credentials.length === 2 && ['guardian', 'therapist'].every(role => credentials.filter(c =>
      c.role === role && id(c.userId) && typeof c.email === 'string' && c.email.endsWith('.test') && typeof c.password === 'string' && c.password.length > 0).length === 1), code);
    assert.equal(credentials.find(c => c.role === 'guardian').userId, careContext.guardianId, code);
    assert(Array.isArray(samples) && samples.length === 2, code);
    const chosen = [samples.find(s => s.type === 'image/png'), samples.find(s => s.type === 'video/mp4')];
    assert(chosen.every(s => s && Buffer.isBuffer(s.bytes) && s.bytes.length > 0 && s.bytes.length <= (s.type === 'image/png' ? 10 : 50) * 1024 ** 2), code);
    folder = path.resolve(evidenceDirectory);
    const parent = path.join(root, 'test-results'), basename = path.basename(folder), prefix = 'native-record-attachments-';
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
    const saves = [], publishes = [], lost = { armed: false, count: 0, invalid: false, receipt: null };
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
        if (role === 'therapist' && method === 'POST' && new RegExp(`^${base}/records/[A-Za-z0-9_-]+/publish$`).test(u.pathname)) {
          publishes.push({ pathname: u.pathname, body: structuredClone(request.postDataJSON()) });
        }
        if (role === 'therapist' && method === 'POST' && new RegExp(`^${base}/records/[A-Za-z0-9_-]+$`).test(u.pathname)) {
          saves.push({ pathname: u.pathname, body: structuredClone(request.postDataJSON()) });
          if (lost.armed) {
            lost.armed = false;
            try {
              const response = await route.fetch({ maxRedirects: 0 });
              try {
                const receipt = (await response.json()).receipt;
                if (response.status() !== 201 || !id(receipt?.recordId) || receipt.revision !== 1) lost.invalid = true;
                else { lost.receipt = { recordId: receipt.recordId, revision: receipt.revision }; lost.count++; }
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
        const record = u.pathname.match(new RegExp(`^${base}/records/([A-Za-z0-9_-]+)/revisions/([1-9][0-9]*)/attachments/([a-f0-9-]+)/content$`));
        const message = u.pathname.match(new RegExp(`^${base}/messages/([A-Za-z0-9_-]+)/attachments/([a-f0-9-]+)/content$`));
        if (!record && !message) return;
        const anchor = record ? { kind: 'record', recordId: record[1], revision: Number(record[2]), uploadId: record[3] }
          : { kind: 'publication-message', messageId: message[1], uploadId: message[2] };
        let observation;
        observation = (async () => {
          assert(uuid(anchor.uploadId) && (record ? role === 'therapist' : role === 'guardian'), code);
          const headers = response.headers(), type = headers['content-type'], size = Number(headers['content-length']);
          assert(['image/png', 'video/mp4'].includes(type) && Number.isSafeInteger(size) && size > 0 && size <= 50 * 1024 ** 2, code);
          assert(headers['cache-control']?.includes('no-store') && headers['x-content-type-options'] === 'nosniff', code);
          const bytes = await response.body();
          try { assert.equal(bytes.length, size, code); report.contentEvidence.push({ role, ...anchor, type, size, sha256: sha(bytes) }); }
          finally { bytes.fill(0); }
        })().catch(() => note(report.errors, { role, phase, type: 'content-observation' })).finally(() => observers.delete(observation));
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
    const dialog = therapist.page.getByTestId('care-dialog');
    const response = (who, suffix, method, status) => who.page.waitForResponse(r => r.url() === endpoint + suffix &&
      r.request().method() === method && r.status() === status);
    const field = async (name, value, select = false) => {
      const input = dialog.locator(`[name="${name}"]`);
      for (const details of await input.locator('xpath=ancestor::details').all())
        if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
      if (select) await input.selectOption(value); else await input.fill(value);
    };
    const submit = async name => { await dialog.getByRole('button', { name, exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); };
    const authenticatedGet = async (who, suffix, expected) => {
      // Read-only IDOR probes use the real authenticated session and expected
      // account, never an injected cookie, role or direct database read.
      const reply = await who.context.request.get(endpoint + suffix, { maxRedirects: 0, timeout: 15_000,
        headers: { 'X-Carebridge-Account': who.userId, 'X-Carebridge-Request': '1', Origin: origin } });
      try { assert.equal(reply.status(), expected, code); return expected === 200 ? await reply.json() : null; }
      finally { await reply.dispose(); }
    };
    const text = { title: '가상 기록 첨부 선택 공유', performed: '가상 내부 수행', response: '가상 내부 반응', nextPlan: '가상 다음 계획',
      privateNote: '가상 치료사 전용 첨부 관찰', summary: '가상 보호자 공유 영상 안내' };
    phase = 'HOME_RECORD'; await workspaceView(therapist.page, 'home');
    await therapist.page.getByTestId('home').locator(`[data-appointment-record="${careContext.appointmentId}"][data-context-room="${conversationId}"]`).click();
    await dialog.waitFor();
    for (const [name, value] of Object.entries(text)) await field(name, value);
    await field('goalId', careContext.goalId, true);
    const activity = { title: '가상 영상 따라 놀이', instruction: '가상 영상은 보호자와 함께 확인해요',
      frequency: '가상 하루 한 번', caution: '가상 피곤하면 쉬어요' };
    for (const [name, value] of Object.entries(activity)) await field(`activity${name[0].toUpperCase()}${name.slice(1)}`, value);
    const panel = dialog.locator('[data-record-upload]');
    await panel.waitFor(); if (await panel.locator('[data-media-details]').getAttribute('open') === null) await panel.locator('[data-media-details] > summary').click();
    const files = [];
    for (const [index, sample] of chosen.entries()) {
      const kind = index === 0 ? 'PNG' : 'VIDEO', filename = index === 0
        ? '가상-비공개-<img src=x onerror=globalThis.__careRecordXss=1>-사진.png' : '가상-선택공유-동영상.mp4';
      phase = `${kind}_SELECT`;
      await panel.getByLabel('시험용 사진·영상 선택', { exact: true }).setInputFiles({ name: filename, mimeType: sample.type, buffer: sample.bytes });
      const row = panel.getByTestId('media-upload-row').filter({ hasText: filename }); await row.waitFor();
      assert.equal(await row.locator('.account').textContent(), filename, code);
      assert.equal(await row.locator('img,video,script').count(), 0, code);
      assert.equal(await row.locator('[data-media-share]').isChecked(), false, code);
      phase = `${kind}_UPLOAD`;
      const [reserved, received] = await Promise.all([
        response(therapist, '/uploads', 'POST', 200),
        therapist.page.waitForResponse(r => new RegExp(`^${endpoint}/uploads/[a-f0-9-]+/content$`).test(r.url()) && r.request().method() === 'POST' && r.status() === 200),
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
      observeUpload(reception.upload); phase = `${kind}_WAIT_REAL_WORKER`;
      const deadline = performance.now() + 180_000; let prepared;
      do {
        assert(performance.now() < deadline, code);
        const observation = statusObservations.begin(therapist.page, request =>
          request.method() === 'GET' && request.url() === `${endpoint}/uploads/${uploadId}`);
        let current;
        try {
          const responseWait = therapist.page.waitForResponse(result => observation.matchesResponse(result) && result.status() === 200)
            .catch(error => { observation.responseWaitFailed(error); throw error; });
          const [currentResponse] = await Promise.all([responseWait, row.locator('[data-media-action="refresh"]').click()]);
          current = await observation.readJson(currentResponse);
        } finally { observed.statusRequests = observation.finish(); }
        assert.equal(current.mode, 'prepared-delivery', code);
        observeUpload(current.upload); assert(!['rejected', 'delete_pending', 'deleted'].includes(current.upload.state), code);
        if (current.upload.state === 'ready') { prepared = current.upload; break; }
        await wait(Math.min(1000, Math.max(0, deadline - performance.now())));
      } while (true);
      await therapist.page.waitForFunction(name => [...document.querySelectorAll('[data-record-upload] [data-testid="media-upload-row"]')]
        .some(el => el.textContent.includes(name) && el.textContent.includes('준비 완료')), filename);
      assert.equal(await row.locator('[data-media-share]').isChecked(), false, code);
      files.push({ id: uploadId, name: filename, type: sample.type, size: prepared.size });
    }
    report.checks.privateDefaults = true; report.checks.preparedUploads = true;
    await capture(therapist, '1440-record-private-ready');
    phase = 'SAVE_COMMIT_RESPONSE_LOSS'; lost.armed = true;
    await dialog.getByRole('button', { name: '기록 저장', exact: true }).click();
    await dialog.getByRole('button', { name: '같은 요청 다시 확인', exact: true }).waitFor();
    assert.equal(lost.invalid, false, code); assert.equal(lost.count, 1, code);
    const recordId = lost.receipt.recordId;
    if (await panel.isVisible()) {
      assert.equal(await panel.locator('input[type="file"]').isDisabled(), true, code);
      for (const input of await panel.locator('[data-media-share]').all()) assert.equal(await input.isDisabled(), true, code);
    }
    const [retryResponse] = await Promise.all([response(therapist, `/records/${recordId}`, 'POST', 201), submit('같은 요청 다시 확인')]);
    const retryReceipt = (await retryResponse.json()).receipt;
    assert.equal(retryReceipt.recordId, recordId, code); assert.equal(retryReceipt.revision, 1, code); assert.equal(retryReceipt.replayed, true, code);
    assert.equal(saves.length, 2, code); assert.deepEqual(saves[0], saves[1], code);
    assert.deepEqual(saves[0].body.content.attachments, files.map(file => ({ id: file.id, share: false })), code);
    report.checks.exactSaveRetry = true;
    phase = 'PRIVATE_RECORD_REOPEN'; await workspaceRecords(therapist.page, conversationId);
    const openRecord = async () => {
      const [read] = await Promise.all([response(therapist, `/records/${recordId}`, 'GET', 200),
        therapist.page.locator(`[data-care-action="edit-record"][data-record-id="${recordId}"]`).click()]);
      await dialog.waitFor(); return (await read.json()).record;
    };
    const saved = await openRecord();
    assert.equal(saved.revision, 1, code); assert.deepEqual(saved.attachments, files.map(file => ({ ...file, share: false })), code);
    assert.equal(saved.appointmentId, careContext.appointmentId, code); assert.equal(saved.goalId, careContext.goalId, code);
    await guardian.page.reload(); await guardian.page.getByTestId('home').waitFor();
    const assertPrivateAbsent = async () => {
      const body = await guardian.page.locator('body').innerText();
      for (const privateText of [files[0].name, text.performed, text.response, text.nextPlan, text.privateNote]) assert(!body.includes(privateText), code);
      assert.equal(await guardian.page.evaluate(() => globalThis.__careRecordXss === undefined), true, code);
    };
    await assertPrivateAbsent(); assert(!(await guardian.page.locator('body').innerText()).includes(files[1].name), code);
    for (const file of files) await authenticatedGet(guardian, `/records/${recordId}/revisions/1/attachments/${file.id}/content`, 404);
    const viewFile = async (who, button, file, label, playback = false) => {
      await button.waitFor(); await button.focus(); await button.press('Enter');
      const viewer = who.page.getByTestId('media-viewer'); await viewer.waitFor();
      if (playback) {
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
      assert.equal(await who.page.evaluate(() => globalThis.__careRecordXss === undefined), true, code);
      await capture(who, label); await Promise.all([...observers]);
      await viewer.locator('[data-media-viewer-close]').focus(); await viewer.locator('[data-media-viewer-close]').press('Enter'); await viewer.waitFor({ state: 'detached' });
      assert.equal(await button.evaluate(el => el === document.activeElement), true, code);
    };
    await viewFile(therapist, dialog.locator(`[data-open-record-attachment="${files[0].id}"][data-record-id="${recordId}"][data-record-revision="1"]`), files[0], '1440-private-record-png');
    assert(report.contentEvidence.some(e => e.role === 'therapist' && e.kind === 'record' && e.recordId === recordId && e.revision === 1 && e.uploadId === files[0].id), code);
    phase = 'COMPACT_PRIVATE_RECORD'; await therapist.page.setViewportSize({ width: 320, height: 900 });
    await capture(therapist, '320-private-record-selection');
    await viewFile(therapist, dialog.locator(`[data-open-record-attachment="${files[0].id}"][data-record-id="${recordId}"][data-record-revision="1"]`), files[0], '320-private-record-png');
    await therapist.page.setViewportSize({ width: 1440, height: 900 });
    report.checks.privateRevisionRead = true;
    phase = 'SELECT_VIDEO_ONLY';
    const privateShare = dialog.locator(`[data-record-share="${files[0].id}"]`), videoShare = dialog.locator(`[data-record-share="${files[1].id}"]`);
    assert.equal(await privateShare.isChecked(), false, code); assert.equal(await videoShare.isChecked(), false, code);
    await videoShare.check();
    const [updatedResponse] = await Promise.all([response(therapist, `/records/${recordId}`, 'POST', 201), submit('기록 저장')]);
    const updated = (await updatedResponse.json()).receipt; assert.equal(updated.revision, 2, code);
    assert.deepEqual(saves.at(-1).body.content.attachments, files.map((file, index) => ({ id: file.id, share: index === 1 })), code);
    assert.equal(saves.at(-1).body.expectedRevision, 1, code);
    const old = (await authenticatedGet(therapist, `/records/${recordId}?revision=1`, 200)).record;
    assert.equal(old.revision, 1, code); assert.deepEqual(old.attachments, saved.attachments, code);
    phase = 'EXPLICIT_SHARE_PREVIEW'; await workspaceRecords(therapist.page, conversationId);
    const [previewResponse] = await Promise.all([response(therapist, `/records/${recordId}/preview`, 'GET', 200),
      therapist.page.locator(`[data-care-action="preview-record"][data-record-id="${recordId}"]`).click()]);
    await dialog.waitFor(); const preview = (await previewResponse.json()).preview;
    const privateValues = [files[0].name, text.performed, text.response, text.nextPlan, text.privateNote];
    assertSelectedRecordPreview(preview, { recordId, recordRevision: 2, date: saved.date, title: text.title, summary: text.summary,
      recipientIds: [careContext.guardianId], activity, file: files[1], privateValues });
    assert.deepEqual(await dialog.locator('[data-share-recipients] li').allTextContents(), ['가상 보호자'], code);
    const previewText = await dialog.innerText(); assert(previewText.includes(files[1].name), code);
    for (const value of [preview.date, text.title, text.summary, ...Object.values(activity)]) assert(previewText.includes(value), code);
    for (const value of privateValues) {
      assert(!previewText.includes(value), code); assert(!JSON.stringify(preview).includes(value), code);
    }
    const previewVideo = dialog.locator(`[data-open-record-attachment="${files[1].id}"][data-record-id="${recordId}"][data-record-revision="2"]`);
    assert.equal(await dialog.locator('[data-open-record-attachment]').count(), 1, code);
    assert.equal(await previewVideo.count(), 1, code);
    assert.equal(await dialog.locator('[name="confirmed"]').isChecked(), false, code);
    report.checks.explicitPreview = true;
    phase = 'READ_ONLY_PREVIEW_VIDEO';
    const saveCount = saves.length, previewContentStart = report.contentEvidence.length;
    assert.equal(publishes.length, 0, code);
    await viewFile(therapist, previewVideo, files[1], '1440-preview-video-playback', true);
    const previewContent = assertFreshAttachmentContent(report.contentEvidence.slice(previewContentStart), {
      role: 'therapist', kind: 'record', recordId, revision: 2, uploadId: files[1].id, type: files[1].type, size: files[1].size });
    assert.equal(await dialog.locator('[name="confirmed"]').isChecked(), false, code);
    assert.equal(saves.length, saveCount, code); assert.equal(publishes.length, 0, code);
    report.checks.readOnlyPreview = true;
    await capture(therapist, '1440-selected-video-preview'); await dialog.locator('[name="confirmed"]').check();
    const [publishedResponse] = await Promise.all([response(therapist, `/records/${recordId}/publish`, 'POST', 201), submit('확인하고 공유')]);
    const publicationReceipt = (await publishedResponse.json()).receipt, messageId = publicationReceipt.messageId;
    assert.equal(publishes.length, 1, code); assert.equal(publishes[0].pathname, `${base}/records/${recordId}/publish`, code);
    assert.equal(publishes[0].body.expectedRevision, preview.recordRevision, code);
    assert.equal(publishes[0].body.expectedRelationshipsVersion, preview.relationshipsVersion, code);
    assert.deepEqual(publishes[0].body.recipientIds, preview.recipientIds, code);
    assert(id(messageId) && publicationReceipt.revision === 2, code); report.checks.selectedShare = true;
    phase = 'GUARDIAN_PUBLICATION_VIDEO'; await guardian.page.reload(); await guardian.page.getByTestId('home').waitFor();
    await workspaceRoom(guardian.page, conversationId); await assertPrivateAbsent();
    const publicMessage = (await authenticatedGet(guardian, `/messages/${messageId}`, 200)).message;
    assert.equal(publicMessage.id, messageId, code); assert.equal(publicMessage.conversationId, conversationId, code);
    for (const key of ['recordId', 'recordRevision', 'date', 'title', 'summary', 'activity'])
      assert.deepEqual(publicMessage.publication[key], preview[key], code);
    assert.equal(publicMessage.attachmentCount, 1, code); assert.deepEqual(publicMessage.attachments, [files[1]], code);
    for (const value of privateValues) assert(!JSON.stringify(publicMessage).includes(value), code);
    report.checks.publicProjection = true;
    // The exact file/message anchor is authoritative, independent of card wrapper markup.
    const publicButton = guardian.page.locator(`[data-open-attachment="${files[1].id}"][data-message-id="${messageId}"]`);
    await publicButton.waitFor();
    assert.equal(await guardian.page.locator(`[data-open-attachment="${files[0].id}"]`).count(), 0, code);
    const guardianContentStart = report.contentEvidence.length;
    await viewFile(guardian, publicButton, files[1], '390-guardian-publication-video', true);
    const guardianContentExpected = { role: 'guardian', kind: 'publication-message', messageId,
      uploadId: files[1].id, type: files[1].type, size: files[1].size };
    const guardianContent = assertFreshAttachmentContent(report.contentEvidence.slice(guardianContentStart), guardianContentExpected, previewContent);
    report.checks.guardianVideo = true;
    phase = 'PRIVATE_ANCHOR_DENIED';
    await authenticatedGet(guardian, `/messages/${messageId}/attachments/${files[0].id}/content`, 404);
    for (const file of files) await authenticatedGet(guardian, `/records/${recordId}/revisions/2/attachments/${file.id}/content`, 404);
    report.checks.privateFileDenied = true;
    phase = 'RELOAD_PRESERVES_SELECTION';
    await therapist.page.reload(); await therapist.page.getByTestId('home').waitFor(); await workspaceRecords(therapist.page, conversationId);
    const latest = await openRecord();
    assert.equal(latest.revision, 2, code); assert.deepEqual(latest.attachments, files.map((file, index) => ({ ...file, share: index === 1 })), code);
    assert.equal(await dialog.locator(`[data-record-share="${files[0].id}"]`).isChecked(), false, code);
    assert.equal(await dialog.locator(`[data-record-share="${files[1].id}"]`).isChecked(), true, code);
    await capture(therapist, '1440-record-selection-reload');
    await dialog.getByRole('button', { name: '입력 취소', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await guardian.page.reload(); await guardian.page.getByTestId('home').waitFor(); await workspaceRoom(guardian.page, conversationId);
    await publicButton.waitFor(); await assertPrivateAbsent(); await capture(guardian, '390-publication-reload');
    const reloadContentStart = report.contentEvidence.length;
    await viewFile(guardian, publicButton, files[1], '390-publication-reload-video', true);
    assertFreshAttachmentContent(report.contentEvidence.slice(reloadContentStart), guardianContentExpected, guardianContent);
    report.checks.reload = true;
    report.record = { recordId, privateRevision: 1, sharedRevision: 2, messageId, privateUploadId: files[0].id, sharedUploadId: files[1].id };
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
  return report;
}

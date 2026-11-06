// Real fresh browser AFTER the caller's same-session cooperative API restart.
// No database access, seeding, scanner substitute, cookie import or disk resume.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceRecords, workspaceRoom } from './local-workspace-browser-helpers.mjs';
import { revealFeedbackRecordReference, stableConnectedMessage, assertRetainedReplyRedaction } from './native-feedback-attachments-browser-helper.mjs';
import { assertFreshAttachmentContent } from './native-record-attachments-browser-helper.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const code = 'NATIVE_API_RESTART_BROWSER_FAILED';
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const assets = new Set(['/', '/favicon.ico', '/local-api/client.js', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/styles.css',
  '/local-api/care-client.js', '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/media-client.js',
  '/local-api/media-ui.js', '/local-api/media-viewer.js', '/local-api/goal-client.js', '/local-api/appointment-client.js',
  '/local-api/self-profile-ui.js', '/local-api/self-profile-client.js', '/src/context-fields.js', '/src/profile-fields.js',
  '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js']);

export function validateApiRestartCheckpoint(input, centerId, conversationId) {
  const value = structuredClone(input);
  assert(id(centerId) && id(conversationId) && value?.schema === 2 && value.centerId === centerId && value.conversationId === conversationId, code);
  assert(['guardian', 'therapist'].every(role => id(value.roles?.[role])) && value.roles.guardian !== value.roles.therapist, code);
  const r = value.reference;
  assert(r && ['sourceRecordId', 'publicationMessageId', 'feedbackId', 'messageId', 'recordId'].every(key => id(r[key])), code);
  assert(r.recordRevision === 1 && r.firstFeedbackRevision === 1 && r.currentFeedbackRevision === 2, code);
  for (const [file, type, uploadId] of [[value.first, 'image/png', r.firstUploadId], [value.second, 'video/mp4', r.currentUploadId]]) {
    assert(file && uuid(file.id) && file.id === uploadId && file.type === type && typeof file.name === 'string' && file.name.length > 0 &&
      Number.isSafeInteger(file.size) && file.size > 0 && file.size <= (type === 'image/png' ? 10 : 50) * 1024 ** 2 && /^[a-f0-9]{64}$/.test(file.sha256), code);
  }
  assert(value.first.id !== value.second.id && value.first.sha256 !== value.second.sha256, code);
  assert(value.record?.id === r.recordId && value.record.revision === r.recordRevision && value.sourceRecord?.id === r.sourceRecordId &&
    value.sourceRecord.revision === 1 && value.feedback?.id === r.feedbackId && value.feedback.revision === 2, code);
  assert(Array.isArray(value.messages) && value.messages.length === 3 && new Set(value.messages.map(message => message.id)).size === 3, code);
  value.messages.forEach((message, index) => assert(id(message.id) && message.conversationId === conversationId && message.type === 'text' &&
    Number.isSafeInteger(message.sequence) && message.sequence > (value.messages[index - 1]?.sequence ?? 0) && typeof message.body === 'string', code));
  assert(value.messages[1].quote?.id === value.messages[0].id && value.messages[1].quote.version === 1 && value.messages[1].quote.body === value.messages[0].body, code);
  for (const role of ['guardian', 'therapist']) {
    const rooms = value.baselines?.[role];
    assert(Array.isArray(rooms) && rooms.length > 0 && rooms.length <= 100 && new Set(rooms.map(room => room.conversationId)).size === rooms.length, code);
    assert(rooms.some(room => room.conversationId === conversationId), code);
    rooms.forEach(room => assert(id(room.conversationId) && Number.isSafeInteger(room.lastRead) && room.lastRead >= 0 &&
      Number.isSafeInteger(room.unread) && room.unread >= 0 && (room.targetId === null || id(room.targetId)), code));
  }
  assert(value.baselines.guardian.find(room => room.conversationId === conversationId).unread === 1 &&
    value.baselines.therapist.find(room => room.conversationId === conversationId).unread === 0, code);
  const replay = value.replay;
  assert(replay?.pathname === `/api/local/centers/${centerId}/conversations/${conversationId}/feedback/${r.feedbackId}` &&
    uuid(replay.body?.clientId) && replay.body.expectedRevision === 1 && replay.body.sourceMessageId === r.publicationMessageId, code);
  const attachments = replay.body.content?.attachments;
  assert(Array.isArray(attachments) && attachments.length === 1 && attachments[0] &&
    Object.keys(attachments[0]).length === 1 && attachments[0].id === value.second.id, code);
  assert(replay.receipt?.feedbackId === r.feedbackId && replay.receipt.messageId === r.messageId && replay.receipt.revision === 2 &&
    replay.receipt.operation === 'save' && replay.receipt.replayed === true, code);
  assert(Array.isArray(value.forbidden) && value.forbidden.length <= 24 && value.forbidden.every(item => typeof item === 'string' && item.length > 0), code);
  // Private note and exact committed request are trusted memory handoff only.
  // Accept no extra fields that could accidentally smuggle credentials/paths.
  const exact = (object, names) => object && typeof object === 'object' && !Array.isArray(object) &&
    Object.keys(object).length === names.length && names.every(name => Object.hasOwn(object, name));
  const textReview = value.textReview, source = value.messages[1];
  assert(exact(textReview, ['review', 'request', 'receipt']), code);
  const { review, request, receipt } = textReview;
  assert(exact(review, ['messageId', 'conversationId', 'revision', 'reviewVersion', 'reviewedRevision', 'note', 'body', 'attachmentCount']) &&
    exact(request, ['clientId', 'expectedRevision', 'expectedReviewVersion', 'note']) &&
    exact(receipt, ['messageId', 'revision', 'reviewVersion', 'operation', 'replayed']), code);
  assert(source.authorId === value.roles.guardian && source.version === 1 && review.messageId === source.id &&
    review.conversationId === conversationId && review.body === source.body && review.revision === 1 && review.reviewVersion === 1 &&
    review.reviewedRevision === 1 && review.attachmentCount === 0, code);
  assert(typeof review.note === 'string' && review.note.length > 0 && review.note.length <= 2000 && review.note === review.note.trim() &&
    review.note.isWellFormed() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(review.note) && value.forbidden.includes(review.note), code);
  assert(uuid(request.clientId) && request.expectedRevision === 1 && request.expectedReviewVersion === 0 && request.note === review.note &&
    receipt.messageId === source.id && receipt.revision === 1 && receipt.reviewVersion === 1 && receipt.operation === 'review' && receipt.replayed === false, code);
  const flow = value.connectedFlow, record = value.record;
  assert(exact(flow, ['pinnedFeedback', 'publicReplies', 'nextPublication', 'feedbackReview']) && exact(flow.publicReplies, ['guardian', 'therapist']), code);
  for (const key of ['performed', 'response', 'nextPlan', 'privateNote', 'title', 'summary', 'date'])
    assert(typeof record[key] === 'string' && record[key].length > 0, code);
  assert(Array.isArray(record.assessments) && record.assessments.length === 2, code);
  for (const row of record.assessments) {
    assert(exact(row, ['tool', 'item', 'value', 'unit', 'context']), code);
    for (const key of ['tool', 'item', 'unit', 'context']) assert(typeof row[key] === 'string' && row[key].length > 0, code);
    assert(['string', 'number'].includes(typeof row.value) && String(row.value).length > 0 && Number.isFinite(Number(row.value)), code);
  }
  assert.notEqual(record.assessments[0].tool + '/' + record.assessments[0].item, record.assessments[1].tool + '/' + record.assessments[1].item, code);
  assert(Array.isArray(record.referenceSources) && record.referenceSources.length === 1, code);
  const pinned = record.referenceSources[0];
  assert(pinned.messageId === r.messageId && pinned.feedbackId === r.feedbackId && pinned.feedbackRevision === 1, code);
  // Feedback references contain IDs/files, unlike ordinary text references.
  // The UI obtains their body from the exact historical feedback endpoint.
  const pinnedFeedback = flow.pinnedFeedback;
  assert(exact(pinnedFeedback, ['messageId', 'feedbackId', 'revision', 'body']) &&
    pinnedFeedback.messageId === r.messageId && pinnedFeedback.feedbackId === r.feedbackId && pinnedFeedback.revision === 1 &&
    typeof pinnedFeedback.body === 'string' && pinnedFeedback.body.length > 0, code);
  const common = ['id', 'conversationId', 'sequence', 'authorId', 'createdAt', 'type', 'body', 'version', 'hidden', 'archived', 'attachmentCount', 'attachments'];
  for (const [item, extra, type] of [[flow.publicReplies.guardian, 'quote', 'text'], [flow.publicReplies.therapist, 'quote', 'text'], [flow.nextPublication, 'publication', 'publication']]) {
    assert(exact(item, [...common, extra]) && id(item.id) && item.conversationId === conversationId && item.authorId === value.roles.therapist &&
      Number.isSafeInteger(item.sequence) && item.sequence > 0 && item.type === type && typeof item.body === 'string' &&
      typeof item.createdAt === 'string' && Number.isFinite(Date.parse(item.createdAt)) && item.hidden === false && item.archived === false, code);
    assert.equal(item.attachmentCount, 0, code); assert.deepEqual(item.attachments, [], code);
  }
  const publicReply = flow.publicReplies.guardian, clinicalReply = flow.publicReplies.therapist;
  assert.equal(publicReply.id, clinicalReply.id, code); assert.equal(publicReply.body, clinicalReply.body, code);
  assert(publicReply.body.length > 0, code); assert.equal(publicReply.sequence, clinicalReply.sequence, code);
  assert(exact(publicReply.quote, ['id', 'hidden', 'body']) && publicReply.quote.id === r.messageId && publicReply.quote.hidden === true, code);
  assert(typeof publicReply.quote.body === 'string' && publicReply.quote.body.length > 0, code);
  assert(clinicalReply.quote?.id === r.messageId && clinicalReply.quote.hidden === false && clinicalReply.quote.feedbackId === r.feedbackId &&
    clinicalReply.quote.feedbackRevision === 1 && clinicalReply.quote.body === pinnedFeedback.body, code);
  assert(Object.keys(clinicalReply.quote).every(key => ['id', 'hidden', 'authorId', 'body', 'preview', 'version', 'changed', 'feedbackId', 'feedbackRevision'].includes(key)), code);
  const publication = flow.nextPublication.publication;
  assert(exact(publication, ['id', 'recordId', 'version', 'recordRevision', 'date', 'title', 'summary', 'sharedAt', 'activity']) &&
    id(publication.id) && publication.recordId === r.recordId && publication.recordRevision === r.recordRevision && publication.version === 1, code);
  for (const key of ['date', 'title', 'summary', 'activity']) assert.deepEqual(publication[key], record[key], code);
  assert(flow.nextPublication.id !== r.publicationMessageId && flow.nextPublication.id !== publicReply.id &&
    flow.nextPublication.sequence > publicReply.sequence && flow.nextPublication.sequence < value.messages[0].sequence, code);
  const currentReview = flow.feedbackReview;
  assert(exact(currentReview, ['review', 'request', 'receipt']), code);
  assert(exact(currentReview.review, ['feedbackId', 'revision', 'reviewVersion', 'note', 'reviewed', 'reviewedAt']) &&
    exact(currentReview.request, ['clientId', 'expectedRevision', 'expectedReviewVersion', 'note']) &&
    exact(currentReview.receipt, ['feedbackId', 'revision', 'reviewVersion', 'messageId', 'operation', 'replayed']), code);
  assert(currentReview.review.feedbackId === r.feedbackId && currentReview.review.revision === 2 && currentReview.review.reviewVersion === 1 &&
    currentReview.review.reviewed === true && typeof currentReview.review.reviewedAt === 'string' && Number.isFinite(Date.parse(currentReview.review.reviewedAt)), code);
  const currentNote = currentReview.review.note;
  assert(typeof currentNote === 'string' && currentNote.length > 0 && currentNote.length <= 2000 && currentNote === currentNote.trim() &&
    currentNote.isWellFormed() && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(currentNote) && value.forbidden.includes(currentNote), code);
  assert(uuid(currentReview.request.clientId) && currentReview.request.expectedRevision === 2 && currentReview.request.expectedReviewVersion === 0 &&
    currentReview.request.note === currentNote && currentReview.receipt.feedbackId === r.feedbackId && currentReview.receipt.messageId === r.messageId &&
    currentReview.receipt.revision === 2 && currentReview.receipt.reviewVersion === 1 && currentReview.receipt.operation === 'review' && currentReview.receipt.replayed === false, code);
  for (const hidden of [record.performed, record.response, record.nextPlan, record.privateNote, pinnedFeedback.body, value.first.name, value.second.name])
    assert(value.forbidden.includes(hidden), code);
  for (const publicValue of [publicReply, flow.nextPublication]) for (const hidden of value.forbidden)
    assert(!JSON.stringify(publicValue).includes(hidden), code);
  const freeze = item => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } return item; };
  return freeze(value);
}

async function sources() {
  const resumeSources = ['tests/windows-synthetic-resume-check.mjs', 'tests/synthetic-resume-process.mjs',
    'scripts/windows-synthetic-session-vault-provider.ps1', 'scripts/check-synthetic-session-storage.ps1'];
  const names = ['tests/native-feedback-attachments-browser-helper.mjs', 'tests/native-record-attachments-browser-helper.mjs', 'tests/windows-synthetic-session-check.mjs',
    'tests/native-prepared-media-browser-helper.mjs', 'tests/native-interactive-care-browser-helper.mjs', 'tests/native-reply-source-browser-helper.mjs',
    'tests/native-upload-status-observation.mjs', 'tests/native-api-restart-browser-helper.mjs',
    'tests/native-video-fixture.mjs', 'tests/message-browser-policy.mjs', 'tests/local-workspace-browser-helpers.mjs',
    'scripts/synthetic-e-api.mjs', 'scripts/p0-study-policy.mjs', 'scripts/prepare-beta-postgres.ps1', 'scripts/postgres-prepare-lock.ps1',
    'scripts/windows-database-credential-provider.ps1', 'scripts/beta-storage-policy.ps1', 'server/tests/windows-postgres-tls-fixture.ps1'];
  for (const directory of ['local-api', 'src', 'server', 'server/migrations']) {
    const base = path.join(root, directory), info = await lstat(base); assert(info.isDirectory() && !info.isSymbolicLink(), code);
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (entry.isDirectory() || !/(?:\.(?:mjs|js|css|html|sql|ps1)|\.Dockerfile(?:\.dockerignore)?)$/.test(entry.name)) continue;
      assert(entry.isFile() && !entry.isSymbolicLink(), code); names.push(`${directory}/${entry.name}`);
    }
  }
  names.push(...resumeSources);
  const files = [];
  for (const name of names.sort()) {
    const filename = path.join(root, name), info = await lstat(filename); assert(info.isFile() && !info.isSymbolicLink(), code);
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
  child.once('exit', () => { exited = true; changed(); }); child.once('close', () => { closed = true; changed(); });
  for (const stream of streams) stream.once('close', changed);
  return { terminal, wait: async () => {
    const timer = setTimeout(() => { report.cleanupObservationTimedOut = true; }, 30_000);
    try { await done.promise; } finally { clearTimeout(timer); }
  } };
}

export async function exerciseApiRestartBrowser({ origin, apiGeneration, restartKind='api', centerId, conversationId, credentials, checkpoint,
  evidenceDirectory, browserRuntime, onOwned } = {}) {
  const report = { runId: randomUUID(), mode: restartKind==='session'?'full-session-resume-relogin':'api-restart-relogin', apiGeneration, startedAt: new Date().toISOString(), passed: false,
    checks: { freshLogin: false, homeReadState: false, messagesAndQuote: false, recordAndFeedback: false,
      pinnedAndCurrentFiles: false, withdrawalDenial: false, roleReadIsolation: false, databaseReceiptReplay: false,
      textReviewRestored: false, textReviewPrivacy: false, textReviewReceiptReplay: false,
      connectedPublicFlow: false, structuredRecordFields: false, currentFeedbackReviewRestored: false, currentFeedbackReviewReplay: false },
    source: null, sourceAfter: null, contentEvidence: [], screenshots: [], errors: [], unexpectedRequests: [], failure: null,
    cleanup: { contextsClosed: false, browserStopped: false }, cleanupObservationTimedOut: false,
    limitations: ['Same-machine fresh Chromium and two contexts, not independent physical devices.',
      restartKind==='session'?'Caller verifies full process shutdown and fresh-process disk resume; this helper verifies fresh-browser data continuity.':
        'Only API is restarted; PostgreSQL, worker, TLS/DPAPI custody and two existing files remain owned by the caller.',
      'The authenticated exact HTTP replay verifies a persisted database receipt, NOT restoration of an unsent UI draft.'] };
  let phase = 'CONFIGURATION', folder, folderOwned = false, browserServer, browser, lifetime, closePromise;
  const contexts = new Set(), observers = new Set(), pages = new Map();
  const ownership = { runId: report.runId, testProcessId: process.pid, browserProcessId: null, finished: false };
  const state = () => ({ contextsClosed: contexts.size === 0, browserStopped: browserServer ? lifetime?.terminal() === true : true });
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      const tasks = [...contexts].map(async context => { await context.close(); contexts.delete(context); });
      let serverClose;
      const stopServer = () => { if (!serverClose) { serverClose = Promise.resolve().then(() => browserServer?.close()); serverClose.catch(() => {}); } return serverClose; };
      const timer = setTimeout(() => { report.cleanupObservationTimedOut = true; void stopServer(); }, 30_000);
      let results;
      try {
        results = await Promise.allSettled(tasks);
        if (browser) results.push(...await Promise.allSettled([browser.close()]));
        results.push(...await Promise.allSettled([stopServer()])); if (lifetime) await lifetime.wait();
      } finally { clearTimeout(timer); }
      await Promise.allSettled([...observers]); Object.assign(report.cleanup, state());
      if (results.some(result => result.status === 'rejected') || !Object.values(report.cleanup).every(Boolean)) throw new Error(code);
    })();
    closePromise.catch(() => { closePromise = undefined; }); return closePromise;
  };
  const save = (name, value, fresh = false) => writeFile(path.join(folder, name), `${JSON.stringify(value, null, 2)}\n`, fresh ? { flag: 'wx' } : undefined);
  const note = (collection, value) => { if (collection.length < 32) collection.push(value); };
  const capture = async (who, label, failure = false) => {
    if (!failure) {
      assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code);
      for (const testId of ['care-dialog', 'media-viewer']) { const panel = who.page.getByTestId(testId);
        if (await panel.isVisible()) assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, code); }
    }
    const filename = label + '.png';
    await who.page.screenshot({ path: path.join(folder, filename), fullPage: true,
      mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]'), who.page.locator('.workspace-head .account'),
        who.page.locator('[data-care-form="text-review"]'), who.page.locator('[data-care-form="review"] [name="note"]')] });
    report.screenshots.push({ filename, width: who.page.viewportSize().width, syntheticOnly: true, ...(failure ? { failure: true } : {}) });
  };
  try {
    phase = 'SOURCE_CAPTURE'; report.source = await sources(); phase = 'CHECKPOINT_CONTRACT';
    const expected = validateApiRestartCheckpoint(checkpoint, centerId, conversationId), r = expected.reference;
    phase = 'CONFIGURATION';
    const url = new URL(origin);
    assert(url.origin === origin && url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) >= 1024 &&
      !url.username && !url.password && !url.search && !url.hash &&
      ['api','session'].includes(restartKind)&&apiGeneration===(restartKind==='session'?1:2), code);
    assert(onOwned === undefined || typeof onOwned === 'function', code);
    assert(Array.isArray(credentials) && credentials.length === 2 && ['guardian', 'therapist'].every(role => credentials.filter(c =>
      c.role === role && c.userId === expected.roles[role] && typeof c.email === 'string' && c.email.endsWith('.test') && typeof c.password === 'string' && c.password.length > 0).length === 1), code);
    const options = messageBrowserOptions(['--confirm-synthetic-local'], { PLAYWRIGHT_MODULE: browserRuntime?.module, STUDY_CHROMIUM_EXECUTABLE: browserRuntime?.executable });
    for (const filename of [options.module, options.executable]) { const info = await lstat(filename); assert(info.isFile() && !info.isSymbolicLink(), code); }
    folder = path.resolve(evidenceDirectory); const parent = path.join(root, 'test-results'), prefix = restartKind==='session'?'native-session-resume-':'native-api-restart-';
    assert(path.dirname(folder) === parent && path.basename(folder).startsWith(prefix) && uuid(path.basename(folder).slice(prefix.length)), code);
    const parentInfo = await lstat(parent); assert(parentInfo.isDirectory() && !parentInfo.isSymbolicLink(), code);
    assert.equal(path.resolve(await realpath(parent)), parent, code); await mkdir(folder); folderOwned = true; await save('ownership.json', ownership, true);
    const { chromium } = await import(pathToFileURL(options.module).href);
    phase = 'FRESH_BROWSER_START';
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable, host: '127.0.0.1', port: 0,
      env: studyChildEnvironment(), timeout: 30_000 });
    const child = browserServer.process(); lifetime = processLifetime(child, report);
    onOwned?.(Object.freeze({ close, status: () => Object.freeze(state()) })); ownership.browserProcessId = child.pid; await save('ownership.json', ownership);
    browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    const base = `/api/local/centers/${centerId}/conversations/${conversationId}`, endpoint = origin + base;
    const actor = async (role, width) => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR', isMobile: false, hasTouch: false,
        serviceWorkers: 'block', permissions: [], acceptDownloads: false });
      contexts.add(context); context.once('close', () => contexts.delete(context)); assert.equal((await context.cookies()).length, 0, code);
      await context.route('**/*', async route => {
        const request = route.request(), u = new URL(request.url()), method = request.method(), local = u.origin === origin;
        if (!local || !['GET', 'POST', 'HEAD'].includes(method) || !((assets.has(u.pathname) && ['GET', 'HEAD'].includes(method)) || u.pathname.startsWith('/api/local/'))) {
          note(report.unexpectedRequests, { role, phase, sameOrigin: local, method: ['GET', 'POST', 'HEAD'].includes(method) ? method : 'OTHER' });
          return route.abort().catch(() => {});
        }
        return route.continue().catch(() => {});
      });
      if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => { note(report.unexpectedRequests, { role, phase, type: 'websocket' }); socket.close(); });
      const page = await context.newPage(); page.setDefaultTimeout(15_000); pages.set(role, { page, context, role });
      page.on('pageerror', () => note(report.errors, { role, phase, type: 'pageerror' }));
      page.on('console', entry => { if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:')) note(report.errors, { role, phase, type: 'console' }); });
      page.on('response', response => {
        if (response.request().method() !== 'GET' || response.status() !== 200) return;
        const u = new URL(response.url()); if (u.origin !== origin || u.search) return;
        const reference = u.pathname === `${base}/records/${r.recordId}/revisions/1/references/${r.messageId}/attachments/${expected.first.id}/content`;
        const feedback = u.pathname === `${base}/messages/${r.messageId}/feedback-revisions/2/attachments/${expected.second.id}/content`;
        if (!reference && !feedback) return;
        const file = reference ? expected.first : expected.second;
        const observationPhase = phase;
        let observation, observationStage = 'anchor';
        observation = (async () => {
          assert.equal(role, 'therapist', code); assert(report.contentEvidence.length < 8, code);
          observationStage = 'headers';
          const headers = response.headers(); assert.equal(headers['content-type'], file.type, code); assert.equal(Number(headers['content-length']), file.size, code);
          assert(headers['cache-control']?.includes('no-store') && headers['x-content-type-options'] === 'nosniff', code);
          observationStage = 'body-read';
          const bytes = await response.body();
          try {
            observationStage = 'body-size'; assert.equal(bytes.length, file.size, code); assert.equal(sha(bytes), file.sha256, code);
            observationStage = 'evidence';
            report.contentEvidence.push({ role, kind: reference ? 'record-reference' : 'feedback-revision', uploadId: file.id, messageId: r.messageId,
              ...(reference ? { recordId: r.recordId, revision: 1 } : { feedbackRevision: 2 }), type: file.type, size: bytes.length, sha256: sha(bytes) });
          } finally { bytes.fill(0); }
        })().catch(error => note(report.errors, {
          role, phase: observationPhase, type: 'content-observation', stage: observationStage,
          category: error?.name === 'AssertionError' ? 'assertion' : observationStage === 'body-read' ? 'body-read-failed' : 'runtime',
        })).finally(() => observers.delete(observation)); observers.add(observation);
      });
      phase = role.toUpperCase() + '_FRESH_LOGIN'; const credential = credentials.find(value => value.role === role);
      try {
        const unauthenticated = await context.request.get(origin + '/api/local/auth/session', { maxRedirects: 0, timeout: 15_000 });
        try { assert.equal(unauthenticated.status(), 401, code); } finally { await unauthenticated.dispose(); }
        await page.goto(origin); await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        const [login] = await Promise.all([page.waitForResponse(response => response.url() === origin + '/api/local/auth/login' && response.request().method() === 'POST' && response.status() === 200),
          page.getByRole('button', { name: '로그인', exact: true }).click()]);
        assert.equal((await login.json()).user.userId, expected.roles[role], code); await page.getByTestId('home').waitFor();
      } finally { credential.email = ''; credential.password = ''; }
      assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie })), { local: 0, session: 0, cookie: '' }, code);
      return { page, context, role, userId: expected.roles[role] };
    };
    const therapist = await actor('therapist', 1440), guardian = await actor('guardian', 390); report.checks.freshLogin = true;
    const get = async (who, pathname, status = 200) => {
      const response = await who.context.request.get(origin + pathname, { maxRedirects: 0, timeout: 15_000, headers: { 'X-Carebridge-Account': who.userId } });
      try { assert.equal(response.status(), status, code); return status === 200 ? await response.json() : null; } finally { await response.dispose(); }
    };
    const inbox = async who => {
      const value = await get(who, '/api/local/centers/' + centerId + '/inbox?limit=100'); assert.equal(value.hasMore, false, code);
      return value.rooms.map(room => ({ conversationId: room.conversationId, lastRead: room.lastRead, unread: room.unread, targetId: room.targetId })).sort((a, b) => a.conversationId.localeCompare(b.conversationId));
    };
    const message = async (who, messageId) => (await get(who, base + '/messages/' + messageId)).message;
    const stable = value => Object.fromEntries(['id', 'conversationId', 'sequence', 'authorId', 'createdAt', 'type', 'body', 'version', 'quote'].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
    const connected = expected.connectedFlow;
    const forbiddenClinicalKeys = new Set(['reviewNote', 'note', 'reviewedAt', 'reviewerId', 'reviewVersion', 'reviewedRevision',
      'performed', 'response', 'nextPlan', 'privateNote', 'assessments', 'referenceSources', 'referenceMessageIds']);
    const publicOnly = value => {
      for (const note of [expected.textReview.review.note, connected.feedbackReview.review.note, expected.record.privateNote])
        assert(!JSON.stringify(value).includes(note), code);
      if (Array.isArray(value)) value.forEach(publicOnly);
      else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
        assert(!forbiddenClinicalKeys.has(key), code); publicOnly(item);
      }
    };
    const connectedMessages = async () => {
      for (const who of [guardian, therapist]) {
        const reply = await message(who, connected.publicReplies[who.role].id);
        assert.deepEqual(stableConnectedMessage(reply), connected.publicReplies[who.role], code); publicOnly(reply);
        if (who.role === 'guardian') assertRetainedReplyRedaction(reply, {
          replyId: connected.publicReplies.guardian.id, body: connected.publicReplies.guardian.body, sourceId: r.messageId, privateValues: expected.forbidden });
        const publication = await message(who, connected.nextPublication.id);
        assert.deepEqual(stableConnectedMessage(publication), connected.nextPublication, code); publicOnly(publication);
        for (const hidden of expected.forbidden) assert(!JSON.stringify(publication).includes(hidden), code);
      }
    };
    phase = 'RESTORED_HOME_READ_STATE';
    for (const who of [guardian, therapist]) { assert.deepEqual(await inbox(who), expected.baselines[who.role], code); await capture(who, who.role + '-home-restored'); }
    const marker = expected.messages[2]; assert.equal((await message(therapist, marker.id)).read, false, code);
    report.checks.homeReadState = true;
    phase = 'RESTORED_MESSAGES_AND_QUOTE';
    for (const who of [guardian, therapist]) for (const before of expected.messages) assert.deepEqual(stable(await message(who, before.id)), before, code);
    report.checks.messagesAndQuote = true;
    phase = 'RESTORED_RECORD_AND_FEEDBACK';
    assert.deepEqual((await get(therapist, base + '/records/' + r.recordId)).record, expected.record, code);
    assert.deepEqual((await get(therapist, base + '/records/' + r.sourceRecordId)).record, expected.sourceRecord, code);
    const restored = await message(therapist, r.messageId); assert.deepEqual(restored.feedback, expected.feedback, code);
    assert.deepEqual(restored.attachments, [Object.fromEntries(['id', 'name', 'type', 'size'].map(key => [key, expected.second[key]]))], code);
    await connectedMessages();
    const pinnedFeedback = (await get(therapist, base + '/feedback/' + r.feedbackId + '?revision=1')).message;
    assert.deepEqual({ messageId: pinnedFeedback.id, feedbackId: pinnedFeedback.feedback.id,
      revision: pinnedFeedback.feedback.revision, body: pinnedFeedback.body }, connected.pinnedFeedback, code);
    assert.equal(pinnedFeedback.feedback.reaction, connected.pinnedFeedback.body, code);
    await get(guardian, base + '/feedback/' + r.feedbackId + '?revision=1', 404);
    assert.deepEqual((await get(therapist, base + '/feedback/' + r.feedbackId + '/review')).review, connected.feedbackReview.review, code);
    await get(guardian, base + '/feedback/' + r.feedbackId + '/review', 404);
    report.checks.recordAndFeedback = true;
    const dialog = who => who.page.getByTestId('care-dialog');
    const discard = async who => { await dialog(who).getByRole('button', { name: '입력 취소', exact: true }).click(); await dialog(who).waitFor({ state: 'hidden' }); };
    const view = async (who, button, file, label) => {
      const evidenceStart = report.contentEvidence.length;
      await button.waitFor(); await button.focus(); await button.press('Enter'); const viewer = who.page.getByTestId('media-viewer'); await viewer.waitFor();
      if (file.type === 'image/png') {
        await who.page.waitForFunction(() => { const img = document.querySelector('[data-media-viewer-content] img'); return img?.complete && img.naturalWidth > 0; });
        assert(await viewer.locator('img').evaluate(async img => { await img.decode(); return img.currentSrc.startsWith('blob:') && img.naturalWidth > 0; }), code);
      } else {
        await who.page.waitForFunction(() => { const video = document.querySelector('[data-media-viewer-content] video'); return video?.readyState >= 1 && video.videoWidth > 0; });
        const video = viewer.locator('video'); assert.equal(await video.evaluate(el => el.autoplay), false, code); await video.focus(); await video.press('Space');
        await who.page.waitForFunction(() => { const video = document.querySelector('[data-media-viewer-content] video'); return video && !video.error && video.currentTime > 0 && (video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0) > 0; });
      }
      assert.equal(await viewer.locator('[data-media-viewer-name]').textContent(), file.name, code); await capture(who, label); await Promise.all([...observers]);
      assertFreshAttachmentContent(report.contentEvidence.slice(evidenceStart), {
        role: 'therapist', kind: file.id === expected.first.id ? 'record-reference' : 'feedback-revision',
        messageId: r.messageId, uploadId: file.id, type: file.type, size: file.size,
        ...(file.id === expected.first.id ? { recordId: r.recordId, revision: 1 } : { feedbackRevision: 2 }),
      }, { uploadId: file.id, type: file.type, size: file.size, sha256: file.sha256 });
      await viewer.locator('[data-media-viewer-close]').focus(); await viewer.locator('[data-media-viewer-close]').press('Enter'); await viewer.waitFor({ state: 'detached' });
      assert.equal(await button.evaluate(el => el === document.activeElement), true, code);
    };
    phase = 'RESTORED_PINNED_AND_CURRENT_FILES'; await therapist.page.bringToFront(); await workspaceRecords(therapist.page, conversationId);
    await therapist.page.locator('[data-care-action="edit-record"][data-record-id="' + r.recordId + '"]').click(); await dialog(therapist).waitFor();
    for (const key of ['performed', 'response', 'nextPlan', 'privateNote', 'summary', 'title'])
      assert.equal(await dialog(therapist).locator('[name="' + key + '"]').inputValue(), expected.record[key], code);
    const assessmentRows = dialog(therapist).locator('[data-assessment-row]');
    assert.equal(await assessmentRows.count(), 2, code);
    for (const details of await assessmentRows.first().locator('xpath=ancestor::details').all())
      if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
    await assessmentRows.first().waitFor();
    for (let index = 0; index < 2; index++) for (const key of ['tool', 'item', 'value', 'unit', 'context'])
      assert.equal(await assessmentRows.nth(index).locator('[data-assessment-field="' + key + '"]').inputValue(), String(expected.record.assessments[index][key]), code);
    report.checks.structuredRecordFields = true;
    const restoredReference = await revealFeedbackRecordReference(dialog(therapist), r.messageId);
    assert.equal(await restoredReference.locator('[data-reference-quote]').textContent(), connected.pinnedFeedback.body, code);
    await view(therapist, dialog(therapist).locator('[data-open-reference-attachment="' + expected.first.id + '"][data-record-id="' + r.recordId + '"][data-record-revision="1"][data-message-id="' + r.messageId + '"]'), expected.first, '1440-pinned-f1-after-api-restart');
    await discard(therapist); await workspaceRoom(therapist.page, conversationId);
    await therapist.page.locator('[data-care-action="review"][data-message-id="' + r.messageId + '"]').click(); await dialog(therapist).waitFor();
    assert.equal(await dialog(therapist).locator('[name="note"]').inputValue(), connected.feedbackReview.review.note, code);
    report.checks.currentFeedbackReviewRestored = true;
    await view(therapist, dialog(therapist).locator('[data-open-feedback-attachment="' + expected.second.id + '"][data-feedback-id="' + r.feedbackId + '"][data-message-id="' + r.messageId + '"][data-feedback-revision="2"]'), expected.second, '1440-f2-video-after-api-restart');
    await discard(therapist); assert.equal(report.contentEvidence.length, 2, code); report.checks.pinnedAndCurrentFiles = true;
    phase = 'RESTORED_WITHDRAWAL_PERMISSIONS';
    for (const messageId of [r.publicationMessageId, r.messageId]) { const hidden = await message(guardian, messageId);
      assert.equal(hidden.hidden, true, code); assert.equal(hidden.archived, true, code); assert.equal(hidden.attachmentCount, 0, code);
      for (const key of ['publication', 'feedback', 'attachments']) assert(!Object.hasOwn(hidden, key), code);
      for (const forbidden of expected.forbidden) assert(!JSON.stringify(hidden).includes(forbidden), code); }
    await get(guardian, base + '/records/' + r.recordId, 404);
    for (const [revision, file] of [[1, expected.first], [2, expected.second]]) {
      await get(guardian, `${base}/messages/${r.messageId}/attachments/${file.id}/content`, 404);
      await get(guardian, `${base}/messages/${r.messageId}/feedback-revisions/${revision}/attachments/${file.id}/content`, 404);
      await get(guardian, `${base}/records/${r.recordId}/revisions/1/references/${r.messageId}/attachments/${file.id}/content`, 404);
    }
    await get(therapist, `${base}/records/${r.recordId}/revisions/1/references/${r.messageId}/attachments/${expected.second.id}/content`, 404);
    report.checks.withdrawalDenial = true;
    phase = 'ROLE_READ_ISOLATION';
    assert.deepEqual(await inbox(guardian), expected.baselines.guardian, code);
    const therapistBeforeRead = await inbox(therapist); await guardian.page.bringToFront(); await workspaceRoom(guardian.page, conversationId);
    const markerRow = guardian.page.locator('[data-testid="message-row"][data-message-id="' + marker.id + '"]'); await markerRow.scrollIntoViewIfNeeded();
    const deadline = performance.now() + 15_000; let guardianAfter;
    do { guardianAfter = await inbox(guardian); if (guardianAfter.find(room => room.conversationId === conversationId)?.lastRead >= marker.sequence) break;
      assert(performance.now() < deadline, code); await wait(100); } while (true);
    assert.equal(guardianAfter.find(room => room.conversationId === conversationId).unread, 0, code);
    assert.deepEqual(guardianAfter.filter(room => room.conversationId !== conversationId), expected.baselines.guardian.filter(room => room.conversationId !== conversationId), code);
    assert.deepEqual(await inbox(therapist), therapistBeforeRead, code); assert.equal((await message(therapist, marker.id)).read, true, code);
    assert.equal((await message(therapist, marker.id)).reviewed, false, code);
    const guardianText = await guardian.page.locator('body').innerText(); expected.forbidden.forEach(value => assert(!guardianText.includes(value), code));
    await capture(guardian, '390-withdrawn-and-independent-messages'); report.checks.roleReadIsolation = true;

    // Only open/scroll guardian messages AFTER the unread-marker isolation test.
    phase = 'RESTORED_CONNECTED_PUBLIC_FLOW'; await connectedMessages();
    const replyRow = guardian.page.locator('[data-testid="message-row"][data-message-id="' + connected.publicReplies.guardian.id + '"]');
    await replyRow.scrollIntoViewIfNeeded();
    assert((await replyRow.innerText()).includes(connected.publicReplies.guardian.body), code);
    assert((await replyRow.innerText()).includes(connected.publicReplies.guardian.quote.body), code);
    await capture(guardian, '390-restored-public-reply-hidden-quote');
    const nextShareRow = guardian.page.locator('[data-testid="message-row"][data-message-id="' + connected.nextPublication.id + '"]');
    await nextShareRow.scrollIntoViewIfNeeded();
    for (const key of ['title', 'summary']) assert((await nextShareRow.innerText()).includes(connected.nextPublication.publication[key]), code);
    assert.equal(await nextShareRow.locator('[data-open-attachment]').count(), 0, code);
    await capture(guardian, '390-restored-next-publication'); report.checks.connectedPublicFlow = true;

    phase = 'RESTORED_TEXT_REVIEW';
    const privateReview = expected.textReview, reviewedMessageId = expected.messages[1].id;
    const reviewPath = base + '/messages/' + reviewedMessageId + '/review';
    assert.deepEqual((await get(therapist, reviewPath)).review, privateReview.review, code);
    await therapist.page.bringToFront(); await workspaceRoom(therapist.page, conversationId);
    const reviewedRow = therapist.page.locator('[data-testid="message-row"][data-message-id="' + reviewedMessageId + '"]');
    await reviewedRow.locator('.care-message-menu > summary').click();
    await reviewedRow.locator('[data-care-action="text-review"]').click();
    await dialog(therapist).locator('[data-care-form="text-review"]').waitFor();
    assert.equal(await dialog(therapist).locator('[name="note"]').inputValue(), privateReview.review.note, code);
    assert.equal(await dialog(therapist).locator('blockquote').textContent(), privateReview.review.body, code);
    await discard(therapist); report.checks.textReviewRestored = true;

    phase = 'RESTORED_TEXT_REVIEW_PRIVACY';
    await get(guardian, reviewPath, 404);
    for (const who of [guardian, therapist]) {
      const current = await message(who, reviewedMessageId); publicOnly(current);
      assert.equal(current.reviewed, true, code); assert.equal(current.body, expected.messages[1].body, code);
      publicOnly(await get(who, base + '/messages?limit=100'));
      publicOnly(await get(who, '/api/local/centers/' + centerId + '/inbox?limit=100'));
    }
    const publicBadge = guardian.page.locator('[data-testid="message-row"][data-message-id="' + reviewedMessageId + '"] [data-text-review-status]');
    assert.equal(await publicBadge.textContent(), '다음 회기 반영 확인', code);
    assert.equal(await guardian.page.locator('[data-care-action="text-review"]').count(), 0, code);
    assert(!(await guardian.page.locator('body').innerText()).includes(privateReview.review.note), code);
    report.checks.textReviewPrivacy = true;

    phase = 'TEXT_REVIEW_DATABASE_RECEIPT_REPLAY';
    const beforeReviewMessages = await get(therapist, base + '/messages?limit=100');
    const reviewReplay = await therapist.context.request.post(origin + reviewPath, { maxRedirects: 0, timeout: 15_000,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Carebridge-Request': '1', 'X-Carebridge-Account': therapist.userId },
      data: privateReview.request });
    try { assert.equal(reviewReplay.status(), 200, code);
      assert.deepEqual((await reviewReplay.json()).receipt, { ...privateReview.receipt, replayed: true }, code); }
    finally { await reviewReplay.dispose(); }
    assert.deepEqual((await get(therapist, reviewPath)).review, privateReview.review, code);
    const afterReviewMessages = await get(therapist, base + '/messages?limit=100');
    assert.equal(afterReviewMessages.revision, beforeReviewMessages.revision, code);
    assert.deepEqual(afterReviewMessages.messages.map(value => value.id), beforeReviewMessages.messages.map(value => value.id), code);
    report.checks.textReviewReceiptReplay = true;

    phase = 'CURRENT_FEEDBACK_REVIEW_RECEIPT_REPLAY';
    const feedbackReviewPath = base + '/feedback/' + r.feedbackId + '/review';
    const beforeFeedbackReviewMessages = await get(therapist, base + '/messages?limit=100');
    assert.equal(beforeFeedbackReviewMessages.hasMore, false, code);
    const feedbackReviewReplay = await therapist.context.request.post(origin + feedbackReviewPath, { maxRedirects: 0, timeout: 15_000,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Carebridge-Request': '1', 'X-Carebridge-Account': therapist.userId },
      data: connected.feedbackReview.request });
    try { assert.equal(feedbackReviewReplay.status(), 200, code);
      assert.deepEqual((await feedbackReviewReplay.json()).receipt, { ...connected.feedbackReview.receipt, replayed: true }, code); }
    finally { await feedbackReviewReplay.dispose(); }
    assert.deepEqual((await get(therapist, feedbackReviewPath)).review, connected.feedbackReview.review, code);
    await get(guardian, feedbackReviewPath, 404);
    const afterFeedbackReviewMessages = await get(therapist, base + '/messages?limit=100');
    assert.equal(afterFeedbackReviewMessages.revision, beforeFeedbackReviewMessages.revision, code);
    assert.deepEqual(afterFeedbackReviewMessages.messages.map(value => value.id), beforeFeedbackReviewMessages.messages.map(value => value.id), code);
    for (const who of [therapist, guardian]) publicOnly(await get(who, base + '/messages?limit=100'));
    report.checks.currentFeedbackReviewReplay = true;

    phase = 'DATABASE_RECEIPT_REPLAY';
    const beforeMessages = await get(therapist, base + '/messages?limit=100'); assert.equal(beforeMessages.hasMore, false, code);
    // This real authorized HTTP mutation replays the exact already-committed
    // request. It is explicitly NOT a UI draft restored in this fresh browser.
    const replayed = await guardian.context.request.post(origin + expected.replay.pathname, { maxRedirects: 0, timeout: 15_000,
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Carebridge-Request': '1', 'X-Carebridge-Account': guardian.userId }, data: expected.replay.body });
    try { assert.equal(replayed.status(), 201, code); assert.deepEqual((await replayed.json()).receipt, expected.replay.receipt, code); }
    finally { await replayed.dispose(); }
    const afterMessages = await get(therapist, base + '/messages?limit=100');
    assert.equal(afterMessages.revision, beforeMessages.revision, code);
    assert.deepEqual(afterMessages.messages.map(value => value.id), beforeMessages.messages.map(value => value.id), code);
    assert.deepEqual((await message(therapist, r.messageId)).feedback, expected.feedback, code);
    assert.equal((await message(guardian, r.messageId)).hidden, true, code);
    await get(guardian, `${base}/messages/${r.messageId}/attachments/${expected.second.id}/content`, 404);
    await connectedMessages();
    assert.deepEqual((await get(therapist, feedbackReviewPath)).review, connected.feedbackReview.review, code);
    assert.deepEqual((await get(therapist, base + '/records/' + r.recordId)).record, expected.record, code);
    report.checks.databaseReceiptReplay = true;
    await Promise.all([...observers]); assert.equal(report.errors.length, 0, code); assert.equal(report.unexpectedRequests.length, 0, code);
  } catch (error) {
    report.failure = { code, phase, category: error?.name === 'AssertionError' ? 'assertion' : 'runtime-or-timeout' };
    if (folderOwned) for (const who of [...pages.values()].slice(0, 2)) {
      try { if (!who.page.isClosed()) await capture(who, 'failure-' + who.role, true); } catch { note(report.errors, { role: who.role, phase, type: 'failure-screenshot' }); }
    }
  } finally {
    if (Array.isArray(credentials)) for (const credential of credentials) {
      try { credential.email = ''; credential.password = ''; } catch { report.failure ??= { code, phase: 'CREDENTIAL_CLEAR', category: 'cleanup' }; }
    }
    try { await close(); } catch { report.failure ??= { code, phase: 'CLEANUP', category: 'cleanup' }; }
    Object.assign(report.cleanup, state()); ownership.finished = Object.values(report.cleanup).every(Boolean); ownership.cleanup = { ...report.cleanup };
    if (report.source) { try { report.sourceAfter = await sources(); assert.equal(report.sourceAfter.sha256, report.source.sha256, code); }
      catch { report.failure ??= { code, phase: 'SOURCE_RECHECK', category: 'source-changed-or-unavailable' }; } }
    report.finishedAt = new Date().toISOString(); report.passed = !report.failure && !report.cleanupObservationTimedOut && Object.values(report.checks).every(Boolean) &&
      report.errors.length === 0 && report.unexpectedRequests.length === 0 && Object.values(report.cleanup).every(Boolean);
    if (folderOwned) try { await save('ownership.json', ownership); await save('results.json', report, true); }
    catch { report.failure ??= { code, phase: 'EVIDENCE_WRITE', category: 'io' }; report.passed = false; }
  }
  if (!report.passed) { const error = new Error(code); error.browserObservation = report; throw error; }
  return report;
}

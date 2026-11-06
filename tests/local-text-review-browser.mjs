// C05: UI -> real authenticated local HTTP -> owned memory-only PGlite.
// The only setup writes create/revoke a synthetic second-room relationship.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceRoom, workspaceAccountAction } from './local-workspace-browser-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const code = 'LOCAL_TEXT_REVIEW_FAILED';
const assets = new Set(['/', '/favicon.ico', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/client.js', '/local-api/care-client.js',
  '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css', '/local-api/media-client.js',
  '/local-api/media-ui.js', '/local-api/media-viewer.js', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js']);
const reviewKeys = ['messageId', 'conversationId', 'revision', 'reviewVersion', 'reviewedRevision', 'note', 'body', 'attachmentCount'].sort();
const receiptKeys = ['messageId', 'revision', 'reviewVersion', 'operation', 'replayed'].sort();
const forbiddenKeys = new Set(['reviewNote', 'note', 'reviewedAt', 'reviewerId', 'reviewVersion', 'reviewedRevision']);
function publicOnly(value, secrets) {
  assert(!secrets.some(secret => JSON.stringify(value).includes(secret)), code);
  if (Array.isArray(value)) value.forEach(item => publicOnly(item, secrets));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    assert(!forbiddenKeys.has(key), code); publicOnly(item, secrets);
  }
}
async function sources() {
  const names = ['tests/local-text-review-browser.mjs', 'tests/local-workspace-browser-helpers.mjs',
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
async function reveal(locator) {
  for (const details of await locator.locator('xpath=ancestor::details').all())
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
}
async function reachable(button) {
  const deadline = Date.now() + 5000;
  let observation, attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    await button.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }), undefined, { timeout: Math.max(1, deadline - Date.now()) });
    await button.click({ trial: true, timeout: Math.max(1, deadline - Date.now()) });
    observation = await button.evaluate(element => {
    const r = element.getBoundingClientRect(), nav = document.querySelector('.main-nav');
    const n = nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect() : null;
    const x = Math.min(12, r.width / 4), y = Math.min(12, r.height / 4);
    const rect = value => value ? Object.fromEntries(['left', 'top', 'right', 'bottom', 'width', 'height'].map(key => [key, value[key]])) : null;
    const hits = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + x, r.top + y], [r.right - x, r.top + y],
      [r.left + x, r.bottom - y], [r.right - x, r.bottom - y]].map(([px, py]) => element.contains(document.elementFromPoint(px, py)));
    const withinViewport = r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    const outsideFixedNav = !n || r.bottom <= n.top || r.top >= n.bottom || r.right <= n.left || r.left >= n.right;
    return { bounds: rect(r), viewport: { width: innerWidth, height: innerHeight }, fixedNav: rect(n),
      connected: element.isConnected, withinViewport, outsideFixedNav, hits,
      passed: withinViewport && outsideFixedNav && hits.every(Boolean) };
    }, undefined, { timeout: Math.max(1, deadline - Date.now()) });
    if (observation.passed) return;
    // Normal polling replaces inbox/message markup. Only an actually detached
    // node may be reacquired; visible obstruction/overflow is still a failure.
    if (observation.connected) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
  }
  const error = new Error(code); error.name = 'AssertionError'; error.reachability = { ...observation, attempts }; throw error;
}
async function secondRoom(sandbox) {
  const suffix = randomUUID(), ids = sandbox.ids, extra = { childId: `review-child-${suffix}`, conversationId: `review-room-${suffix}` };
  await sandbox.database.transaction(async tx => {
    await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)', [ids.centerId, extra.childId]);
    await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)', [ids.centerId, extra.conversationId, extra.childId]);
    await tx.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
      VALUES ($1,$2,$3,'therapist',true,1),($1,$2,$4,'guardian',true,1)`, [ids.centerId, extra.conversationId, ids.therapistId, ids.guardianId]);
    await tx.query(`INSERT INTO cb_child_profiles(center_id,child_id,name,age,age_as_of,revision,updated_by)
      VALUES ($1,$2,'가상 두 번째 소식 아동',NULL,NULL,1,$3)`, [ids.centerId, extra.childId, ids.therapistId]);
  });
  return extra;
}

export async function runLocalTextReviewBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const filename of [options.module, options.executable]) {
    const info = await lstat(filename); assert(info.isFile() && !info.isSymbolicLink(), code);
  }
  const source = await sources(), { chromium } = await import(pathToFileURL(options.module).href);
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-text-review-${runId}`); await mkdir(folder);
  const report = { runId, startedAt: new Date().toISOString(), source, passed: false, checks: [], screenshots: [], errors: [], unexpectedRequests: [],
    failure: null, cleanupObservationTimedOut: false, cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Synthetic identities, own Chromium, authenticated loopback HTTP and memory-only PGlite; no E/native storage or actual child information.',
      '390/768/1440 viewports are not physical devices or human usability evidence.',
      'Clinical messages, edits, replies and reviews are written only through visible UI. SQL is limited to synthetic room setup/relationship revocation and read-only verification.',
      'Transport loss discards one real committed response; delayed GET holds a real response. No response/approval data is invented.',
      'Revocation checks rendered DOM/browser storage and current server authority, not arbitrary inspection of JavaScript heap or production retention policy.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, finished: false };
  const contexts = new Set(), sandboxes = new Set(), pages = new Map(), releases = new Set(), routeWork = new Set();
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  const note = (list, value) => { if (list.length < 32) list.push(value); };
  let browserServer, browser, lifetime, phase = 'STARTUP'; await save('ownership.json', ownership);
  try {
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    lifetime = processLifetime(browserServer.process()); ownership.browserProcessId = browserServer.process().pid;
    await save('ownership.json', ownership); browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    for (const width of [390, 768, 1440]) {
      phase = `${width}:SANDBOX`; const sandbox = await createLocalApiSandbox({ port: 0 }); sandboxes.add(sandbox);
      const extra = await secondRoom(sandbox), { origin, ids } = sandbox, url = new URL(origin);
      assert(url.origin === origin && url.hostname === '127.0.0.1' && url.protocol === 'http:' && url.port && !url.username && !url.password, code);
      const base = `/api/local/centers/${ids.centerId}/conversations/${ids.conversationId}`;
      const privateNote = `가상 비공개 반영 계획 ${width}`, updatedNote = `가상 수정 후 비공개 계획 ${width}`, unsavedNote = `가상 권한 종료 입력 ${width}`;
      const secrets = [privateNote, updatedNote, unsavedNote], publicResponses = [], privateGets = [], operations = [], guardianPrivate = [];
      const result = { width, readNotReview: false, privateEditor: false, exactRetry: false, noDuplicateWrite: false,
        publicAnswerSeparate: false, changedSourceWarning: false, currentRevisionConfirmed: false, lateGetDiscarded: false,
        revokedDraftCleared: false, serverPrivateAuthority: false, guardianNoPrivateGet: false, publicDtoPrivate: false,
        sourcePreserved: false, keyboard: false, reachability: false, layout: false, cleanup: false };
      report.currentCheck = result;
      const actor = async role => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR',
          isMobile: width <= 640, hasTouch: width <= 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context); context.once('close', () => contexts.delete(context)); assert.equal((await context.cookies()).length, 0, code);
        const fault = { loseNextReview: false, nextGet: null, lost: 0, committed: null };
        await context.route('**/*', async route => {
          const request = route.request(), target = new URL(request.url()), method = request.method(), entryPhase = phase;
          const primaryRead = method === 'GET' && target.pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
            [...target.searchParams].length === 1 && [ids.conversationId, extra.conversationId].includes(target.searchParams.get('conversationId'));
          const api = /^\/api\/local\/(?:auth\/(?:login|session|logout)|centers\/[A-Za-z0-9_-]+\/(?:inbox|conversations\/[A-Za-z0-9_-]+\/(?:profile|read|goals|measurements|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+(?:\/(?:edit|delete|review))?)?|records(?:\/[A-Za-z0-9_-]+(?:\/(?:preview|publish))?)?)))$/.test(target.pathname);
          if (target.origin !== origin || !['GET', 'POST', 'HEAD'].includes(method) || !((assets.has(target.pathname) && ['GET', 'HEAD'].includes(method)) || api || primaryRead)) {
            note(report.unexpectedRequests, { width, role, phase: entryPhase, sameOrigin: target.origin === origin,
              method: ['GET', 'POST', 'HEAD'].includes(method) ? method : 'OTHER' }); return route.abort().catch(() => {});
          }
          const isReview = /\/messages\/[A-Za-z0-9_-]+\/review$/.test(target.pathname);
          const isPublicGet = method === 'GET' && (/\/messages(?:\/[A-Za-z0-9_-]+)?$/.test(target.pathname) || target.pathname.endsWith('/inbox'));
          if (role === 'guardian' && isReview) guardianPrivate.push(method);
          if (isReview && method === 'POST') operations.push({ role, pathname: target.pathname, body: structuredClone(request.postDataJSON()) });
          const lost = isReview && method === 'POST' && fault.loseNextReview;
          if (lost) fault.loseNextReview = false;
          const held = isReview && method === 'GET' ? fault.nextGet : null; if (held) fault.nextGet = null;
          if (!isPublicGet && !(isReview && method === 'GET') && !lost) return route.continue().catch(() => {});
          const work = (async () => {
            let response;
            try {
              response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
              const body = await response.json();
              if (isPublicGet) { publicOnly(body, secrets); publicResponses.push({ role, status: response.status() }); }
              else if (method === 'GET') {
                if (response.status() === 200) {
                  assert.deepEqual(Object.keys(body), ['review'], code); assert.deepEqual(Object.keys(body.review).sort(), reviewKeys, code);
                  privateGets.push({ role, review: structuredClone(body.review) });
                } else { assert.equal(response.status(), 404, code); publicOnly(body, secrets); }
              }
              if (lost) {
                assert.equal(response.status(), 200, code); assert.deepEqual(Object.keys(body.receipt).sort(), receiptKeys, code);
                fault.lost++; fault.committed = structuredClone(body.receipt); await route.abort('failed').catch(() => {}); return;
              }
              if (held) { held.entered.resolve(); await held.release.promise; }
              // A validated real GET may be cancelled by a normal room refresh
              // or navigation. Delivery failure is not a DTO failure; subsequent
              // visible-flow assertions still require an actual response.
              await route.fulfill({ response }).catch(() => {});
            } catch { note(report.errors, { width, role, phase: entryPhase, type: 'response-contract' }); await route.abort().catch(() => {}); }
            finally { await response?.dispose().catch(() => {}); held?.done.resolve(); }
          })();
          routeWork.add(work); try { await work; } finally { routeWork.delete(work); }
        });
        if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => {
          note(report.unexpectedRequests, { width, role, phase, type: 'websocket' }); socket.close();
        });
        const page = await context.newPage(); page.setDefaultTimeout(15_000); pages.set(role, page);
        page.on('pageerror', () => note(report.errors, { width, role, phase, type: 'pageerror' }));
        page.on('console', entry => { if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:')) note(report.errors, { width, role, phase, type: 'console' }); });
        const credential = sandbox.credentials.find(item => item.role === role); assert(credential.email.endsWith('.test'), code);
        await page.goto(origin); await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click(); await page.getByTestId('home').waitFor();
        return { page, context, role, userId: ids[role + 'Id'], fault };
      };
      const therapist = await actor('therapist'), guardian = await actor('guardian');
      const dialog = who => who.page.getByTestId('care-dialog');
      const messageRow = (who, messageId) => who.page.locator(`[data-testid="message-row"][data-message-id="${messageId}"]`);
      const room = (who, conversationId = ids.conversationId) => workspaceRoom(who.page, conversationId, { keyboard: true });
      const refresh = who => workspaceAccountAction(who.page, 'refresh');
      const get = async (who, suffix) => {
        const response = await who.context.request.get(`${origin}${base}${suffix}`, {
          maxRedirects: 0, timeout: 15_000, headers: { 'X-Carebridge-Account': who.userId } });
        try { return { status: response.status(), body: await response.json() }; } finally { await response.dispose(); }
      };
      const message = async (who, messageId) => {
        const response = await get(who, `/messages/${messageId}`); assert.equal(response.status, 200, code); publicOnly(response.body, secrets); return response.body.message;
      };
      const reviewSnapshot = async (messageId, clientId) => {
        const params = [ids.centerId, ids.conversationId, messageId];
        return {
          review: (await sandbox.database.query('SELECT * FROM cb_message_reviews WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3', params)).rows,
          receipt: (await sandbox.database.query('SELECT * FROM cb_message_review_requests WHERE center_id=$1 AND actor_id=$2 AND client_id=$3', [ids.centerId, ids.therapistId, clientId])).rows,
          audit: (await sandbox.database.query("SELECT * FROM cb_audit_events WHERE center_id=$1 AND conversation_id=$2 AND actor_id=$3 AND action='message.reviewed' ORDER BY id", [ids.centerId, ids.conversationId, ids.therapistId])).rows,
        };
      };
      const sourceSnapshot = async messageId => ({
        head: (await sandbox.database.query('SELECT * FROM cb_message_text_heads WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3', [ids.centerId, ids.conversationId, messageId])).rows,
        revisions: (await sandbox.database.query('SELECT * FROM cb_message_text_revisions WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3 ORDER BY revision', [ids.centerId, ids.conversationId, messageId])).rows,
      });
      const openAction = async (who, name, messageId, { keyboard = false, wait = true } = {}) => {
        const button = who.page.locator(`[data-care-action="${name}"][data-message-id="${messageId}"]`); await reveal(button); await reachable(button);
        if (keyboard) { await button.focus(); await button.press('Enter'); } else await button.click();
        if (wait) await dialog(who).waitFor();
      };
      const submit = async (who, label, endpoint, status = 200) => {
        const [response] = await Promise.all([who.page.waitForResponse(response => new URL(response.url()).pathname === endpoint &&
          response.request().method() === 'POST' && response.status() === status), dialog(who).getByRole('button', { name: label, exact: true }).click()]);
        const body = await response.json(); await dialog(who).waitFor({ state: 'hidden' }); return body;
      };
      const capture = async (who, label) => {
        assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code);
        if (await dialog(who).isVisible()) assert.equal(await dialog(who).evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, code);
        const filename = `${width}-${label}.png`; await who.page.screenshot({ path: path.join(folder, filename), fullPage: false,
          mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]'), who.page.locator('.workspace-head .account')] });
        report.screenshots.push({ filename, width, syntheticOnly: true });
      };
      const noPrivateDom = async who => {
        const visible = await who.page.locator('body').innerText(); for (const secret of secrets) assert(!visible.includes(secret), code);
        const values = await who.page.locator('input,textarea').evaluateAll(elements => elements.map(element => element.value));
        assert(values.every(value => secrets.every(secret => !value.includes(secret))), code);
      };
      const watchPrivateDom = who => who.page.evaluate(needles => {
        window.__textReviewLeak = false; window.__textReviewObserver?.disconnect();
        const contains = node => needles.some(text => (node?.textContent ?? '').includes(text));
        window.__textReviewObserver = new MutationObserver(changes => {
          if (changes.some(change => [...change.addedNodes].some(contains) || change.type === 'characterData' && contains(change.target))) window.__textReviewLeak = true;
        });
        window.__textReviewObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
      }, secrets);

      phase = `${width}:READ_IS_NOT_REVIEW`; await guardian.page.bringToFront(); await room(guardian);
      const originalBody = `가상 보호자 일반 소식 ${width}`, changedBody = `가상 보호자 수정한 소식 ${width}`, replyBody = `가상 공개 안내 답장 ${width}`;
      const [sentResponse] = await Promise.all([guardian.page.waitForResponse(response => new URL(response.url()).pathname === base + '/messages' &&
        response.request().method() === 'POST' && response.status() === 201), (async () => {
          await guardian.page.getByLabel('메시지', { exact: true }).fill(originalBody);
          await guardian.page.getByRole('button', { name: '보내기', exact: true }).click();
        })()]);
      const original = (await sentResponse.json()).message, messageId = original.id, endpoint = `${base}/messages/${messageId}/review`;
      await messageRow(guardian, messageId).waitFor(); await therapist.page.bringToFront(); await refresh(therapist); await room(therapist);
      await messageRow(therapist, messageId).waitFor();
      await therapist.page.waitForFunction(id => document.querySelector(`[data-testid="message-row"][data-message-id="${id}"]`)?.innerText.includes('반영 확인 전'), messageId);
      {
        const deadline = Date.now() + 15_000;
        let observed = false;
        while (Date.now() < deadline) {
          const read = await sandbox.database.query('SELECT sequence FROM cb_read_states WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3', [ids.centerId, ids.conversationId, ids.therapistId]);
          if (Number(read.rows[0]?.sequence ?? 0) >= original.sequence) { observed = true; break; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert(observed, code);
      }
      assert.equal((await sandbox.database.query('SELECT count(*)::integer AS count FROM cb_message_reviews WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3', [ids.centerId, ids.conversationId, messageId])).rows[0].count, 0, code);
      const readMessage = await message(guardian, messageId); assert.equal(readMessage.read, true, code); assert.equal(readMessage.reviewed, false, code);
      const originalSnapshot = await sourceSnapshot(messageId); result.originalSha256 = hash(JSON.stringify(originalSnapshot)); result.readNotReview = true;

      phase = `${width}:PRIVATE_REVIEW_EDITOR`; await openAction(therapist, 'text-review', messageId, { keyboard: true });
      await dialog(therapist).locator('form[data-care-form="text-review"]').waitFor();
      assert.equal(await dialog(therapist).getByRole('heading').textContent(), '소식 반영 메모', code);
      assert.equal(await dialog(therapist).locator('[name="note"]').inputValue(), '', code);
      const initial = privateGets.at(-1).review;
      assert.equal(initial.messageId, messageId, code); assert.equal(initial.body, originalBody, code);
      assert.equal(initial.revision, 1, code); assert.equal(initial.reviewVersion, 0, code); assert.equal(initial.reviewedRevision, null, code);
      const noteField = dialog(therapist).locator('[name="note"]'); await noteField.fill(privateNote); await noteField.press('Tab');
      const saveButton = dialog(therapist).getByRole('button', { name: '반영 확인 저장', exact: true });
      assert.equal(await saveButton.evaluate(element => element === document.activeElement), true, code); await reachable(saveButton);
      await capture(therapist, 'private-editor'); result.privateEditor = result.keyboard = result.reachability = true;

      phase = `${width}:COMMITTED_RESPONSE_LOSS_RETRY`; therapist.fault.loseNextReview = true; await saveButton.click();
      const retry = dialog(therapist).getByRole('button', { name: '같은 요청 다시 확인', exact: true }); await retry.waitFor();
      assert.equal(therapist.fault.lost, 1, code); assert.equal(operations.length, 1, code);
      const first = structuredClone(operations[0].body), beforeRetry = await reviewSnapshot(messageId, first.clientId);
      assert.deepEqual(Object.keys(first).sort(), ['clientId', 'expectedRevision', 'expectedReviewVersion', 'note'].sort(), code);
      assert.equal(first.expectedRevision, 1, code); assert.equal(first.expectedReviewVersion, 0, code); assert.equal(first.note, privateNote, code);
      assert.equal(beforeRetry.review.length, 1, code); assert.equal(beforeRetry.receipt.length, 1, code); assert.equal(beforeRetry.audit.length, 1, code);
      const locked = dialog(therapist).locator('[name="note"]');
      if (await locked.count()) assert.equal(await locked.evaluate(element => element.readOnly || element.disabled), true, code);
      await capture(therapist, 'unknown-same-request');
      const retried = await submit(therapist, '같은 요청 다시 확인', endpoint);
      assert.deepEqual(operations[1].body, first, code); assert.equal(operations.length, 2, code);
      assert.deepEqual(retried.receipt, { ...therapist.fault.committed, replayed: true }, code);
      assert.deepEqual(await reviewSnapshot(messageId, first.clientId), beforeRetry, code);
      assert.deepEqual(await sourceSnapshot(messageId), originalSnapshot, code);
      result.exactRetry = result.noDuplicateWrite = result.sourcePreserved = true;
      await room(therapist); await messageRow(therapist, messageId).locator('[data-text-review-status]').filter({ hasText: '다음 회기 반영 확인' }).waitFor();
      await guardian.page.bringToFront(); await refresh(guardian); await room(guardian);
      await messageRow(guardian, messageId).locator('[data-text-review-status]').filter({ hasText: '다음 회기 반영 확인' }).waitFor();
      await noPrivateDom(guardian); assert.equal(await guardian.page.locator('[data-care-action="text-review"]').count(), 0, code);

      phase = `${width}:PUBLIC_REPLY_SEPARATE`; await therapist.page.bringToFront(); await openAction(therapist, 'reply', messageId);
      await dialog(therapist).locator('[name="body"]').fill(replyBody);
      const replied = await submit(therapist, '답장 보내기', base + '/messages', 201);
      publicOnly(replied, secrets); assert.equal(replied.message.quote.id, messageId, code); assert.equal(replied.message.quote.body, originalBody, code);
      await guardian.page.bringToFront(); await refresh(guardian); await room(guardian); await messageRow(guardian, replied.message.id).waitFor();
      await noPrivateDom(guardian); result.publicAnswerSeparate = true;
      await capture(guardian, 'guardian-public-only');

      phase = `${width}:SOURCE_EDIT_AND_HISTORICAL_NOTE`; await openAction(guardian, 'text-edit', messageId);
      await dialog(guardian).locator('[name="body"]').fill(changedBody);
      const edited = await submit(guardian, '수정 저장', `${base}/messages/${messageId}/edit`); assert.equal(edited.receipt.revision, 2, code);
      await therapist.page.bringToFront(); await refresh(therapist); await room(therapist);
      await messageRow(therapist, messageId).locator('[data-text-review-status]').filter({ hasText: '반영 확인 전' }).waitFor();
      await openAction(therapist, 'text-review', messageId); await dialog(therapist).locator('[data-text-review-history]').waitFor();
      const history = privateGets.at(-1).review;
      assert.equal(history.revision, 2, code); assert.equal(history.reviewedRevision, 1, code); assert.equal(history.reviewVersion, 1, code);
      assert.equal(history.note, privateNote, code); assert.equal(history.body, changedBody, code);
      assert.equal(await dialog(therapist).locator('[name="note"]').inputValue(), privateNote, code); await capture(therapist, 'history-warning');
      result.changedSourceWarning = true; await dialog(therapist).locator('[name="note"]').fill(updatedNote);
      const confirmed = await submit(therapist, '반영 확인 저장', endpoint);
      assert.equal(confirmed.receipt.revision, 2, code); assert.equal(confirmed.receipt.reviewVersion, 2, code); assert.equal(confirmed.receipt.replayed, false, code);
      const confirmedReview = (await get(therapist, `/messages/${messageId}/review`)).body.review;
      assert.equal(confirmedReview.reviewedRevision, 2, code); assert.equal(confirmedReview.note, updatedNote, code);
      assert.deepEqual((await sourceSnapshot(messageId)).revisions[0], originalSnapshot.revisions[0], code); result.currentRevisionConfirmed = true;

      phase = `${width}:LATE_PRIVATE_GET_ROOM_CHANGE`; await room(therapist);
      const held = { entered: Promise.withResolvers(), release: Promise.withResolvers(), done: Promise.withResolvers() };
      const release = () => held.release.resolve(); releases.add(release); therapist.fault.nextGet = held;
      try {
        await openAction(therapist, 'text-review', messageId, { wait: false }); await bounded(held.entered.promise, 15_000);
        await room(therapist, extra.conversationId); await watchPrivateDom(therapist);
        release(); await bounded(held.done.promise, 15_000);
        await therapist.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await dialog(therapist).isVisible(), false, code); await noPrivateDom(therapist);
        assert.equal(await therapist.page.evaluate(() => window.__textReviewLeak), false, code);
        await therapist.page.evaluate(() => window.__textReviewObserver.disconnect());
        assert.equal(await therapist.page.getByTestId('inbox').locator(`[data-room-id="${extra.conversationId}"]`).getAttribute('aria-current'), 'true', code);
        await capture(therapist, 'late-private-response-discarded'); result.lateGetDiscarded = true;
      } finally { release(); releases.delete(release); }

      phase = `${width}:RELATIONSHIP_REVOCATION`;
      await room(therapist); await openAction(therapist, 'text-review', messageId);
      await dialog(therapist).locator('[name="note"]').fill(unsavedNote);
      // Test precondition only; no application auth shortcut or credential mutation.
      await sandbox.database.transaction(async tx => {
        await tx.query('SELECT id FROM cb_conversations WHERE center_id=$1 AND id=$2 FOR UPDATE', [ids.centerId, ids.conversationId]);
        await tx.query('UPDATE cb_participants SET active=false WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3', [ids.centerId, ids.conversationId, ids.therapistId]);
      });
      // The app's normal visible-page refresh/guard detects revoked membership.
      // Do not force-click the inert workspace behind the open native dialog.
      await dialog(therapist).waitFor({ state: 'hidden' }); await noPrivateDom(therapist);
      assert.equal(await therapist.page.locator('.workspace-grid').evaluate(element => element.classList.contains('room-open')), false, code);
      await therapist.page.getByTestId('inbox').waitFor({ state: 'visible' });
      // No detour through another menu may repair stale mobile room state.
      await room(therapist, extra.conversationId); await noPrivateDom(therapist);
      assert.equal(await therapist.page.locator('[data-care-action="resume"]').count(), 0, code);
      const deniedTherapist = await get(therapist, `/messages/${messageId}/review`), deniedGuardian = await get(guardian, `/messages/${messageId}/review`);
      assert.equal(deniedTherapist.status, 404, code); assert.equal(deniedGuardian.status, 404, code);
      publicOnly(deniedTherapist.body, secrets); publicOnly(deniedGuardian.body, secrets);
      const retained = await reviewSnapshot(messageId, first.clientId);
      assert.equal(retained.review[0].note, updatedNote, code); assert.equal(retained.review[0].review_version, 2, code);
      assert.equal(retained.audit.length, 2, code); result.revokedDraftCleared = result.serverPrivateAuthority = true;
      await capture(therapist, 'revoked-private-input-cleared');

      phase = `${width}:FINAL_PRIVATE_BOUNDARY`;
      await guardian.page.bringToFront(); await refresh(guardian); await room(guardian); await noPrivateDom(guardian);
      assert.equal(guardianPrivate.length, 0, code); assert(publicResponses.some(item => item.role === 'guardian' && item.status === 200), code);
      assert(privateGets.length >= 3 && privateGets.every(item => item.role === 'therapist'), code);
      for (const who of [therapist, guardian]) assert.deepEqual(await who.page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, ''], code);
      result.guardianNoPrivateGet = result.publicDtoPrivate = result.layout = true;
      assert.equal(report.errors.length, 0, code); assert.equal(report.unexpectedRequests.length, 0, code);
      for (const who of [therapist, guardian]) await who.context.close(); pages.clear();
      await sandbox.close(); assert.equal(sandbox.database.closed, true, code); assert.equal(sandbox.credentials.length, 0, code); sandboxes.delete(sandbox);
      result.cleanup = true; report.checks.push(result); delete report.currentCheck;
      console.log(JSON.stringify({ width, passed: true, boundaries: 16 }));
    }
    report.finalSource = await sources(); assert.equal(report.finalSource.sha256, source.sha256, code);
  } catch (error) {
    report.failure = { code, phase, kind: ['AssertionError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-text-review-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      workspaceHelperLine: Number(error?.stack?.match(/local-workspace-browser-helpers\.mjs:(\d+):\d+/)?.[1]) || null };
    if (error?.reachability) report.failure.reachability = error.reachability;
    for (const [role, page] of [...pages].slice(0, 2)) try {
      const filename = `failure-${role}.png`; await page.screenshot({ path: path.join(folder, filename), fullPage: false,
        mask: [page.locator('input[type="email"]'), page.locator('input[type="password"]'), page.locator('.workspace-head .account')] });
      report.screenshots.push({ filename, syntheticOnly: true, failure: true });
    } catch { note(report.errors, { phase, type: 'failure-screenshot' }); }
  } finally {
    for (const release of releases) release();
    try { await bounded(Promise.all([...routeWork])); } catch { report.cleanupObservationTimedOut = true; }
    for (const context of contexts) try { await bounded(context.close()); contexts.delete(context); } catch { report.cleanupObservationTimedOut = true; }
    report.cleanup.contextsClosed = contexts.size === 0;
    if (browserServer) {
      try { await bounded(browser?.close()); await bounded(browserServer.close()); await bounded(lifetime.done); }
      catch { report.cleanupObservationTimedOut = true; try { await bounded(browserServer.kill()); await bounded(lifetime.done); } catch {} }
      report.cleanup.browserStopped = lifetime?.terminal() === true;
    } else report.cleanup.browserStopped = true;
    if (report.cleanup.browserStopped) for (const sandbox of sandboxes) try {
      await bounded(sandbox.close()); assert.equal(sandbox.database.closed, true, code); sandboxes.delete(sandbox);
    } catch { report.failure ??= { code, phase: 'SANDBOX_CLEANUP', kind: 'Error' }; }
    report.cleanup.sandboxesClosed = sandboxes.size === 0; report.finishedAt = new Date().toISOString();
    report.passed = !report.failure && !report.cleanupObservationTimedOut && report.checks.length === 3 &&
      report.errors.length === 0 && report.unexpectedRequests.length === 0 && Object.values(report.cleanup).every(Boolean);
    ownership.finished = Object.values(report.cleanup).every(Boolean); ownership.cleanup = report.cleanup;
    await save('ownership.json', ownership); await save('results.json', report);
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length, failure: report.failure, cleanup: report.cleanup }));
  return report.passed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runLocalTextReviewBrowser()) process.exitCode = 1; }
  catch { console.error('LOCAL_TEXT_REVIEW_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

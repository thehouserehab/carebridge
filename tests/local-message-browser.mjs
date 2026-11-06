// Synthetic browser -> HTTP -> memory-only PostgreSQL -> rendered response.
// Own every listener/context/database; never use an existing tab, .env or data.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceRecords, workspaceRoom, workspaceAccountAction } from './local-workspace-browser-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function sourceManifest() {
  const names = ['tests/local-message-browser.mjs', 'tests/local-workspace-browser-helpers.mjs'];
  for (const directory of ['local-api', 'src', 'server', 'server/migrations']) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      if (entry.isDirectory() || !/\.(?:mjs|js|css|html|sql)$/.test(entry.name)) continue;
      assert(entry.isFile() && !entry.isSymbolicLink(), 'LOCAL_MESSAGE_SOURCE_TYPE');
      names.push(`${directory}/${entry.name}`);
    }
  }
  const files = [];
  for (const name of names.sort()) files.push({ name, sha256: hash(await readFile(path.join(root, name))) });
  return { sha256: hash(JSON.stringify(files)), files };
}
async function bounded(operation, ms = 10_000) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('LOCAL_MESSAGE_CLEANUP_TIMEOUT')), ms);
  })]); } finally { clearTimeout(timer); }
}
async function reveal(locator) {
  // CSS, not getByRole: descendants of a closed details are not in its
  // accessibility tree until the user activates the native summary.
  await locator.waitFor({ state: 'attached' });
  for (const details of await locator.locator('xpath=ancestor::details').all())
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
}

export async function runLocalMessageBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const file of [options.module, options.executable]) assert((await lstat(file)).isFile());
  const { chromium } = await import(pathToFileURL(options.module).href);
  const source = await sourceManifest();
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-message-${runId}`);
  await mkdir(folder);
  const report = { runId, at: new Date().toISOString(), source, passed: false, checks: [], screenshots: [],
    errors: [], unexpectedRequests: [], failure: null,
    cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Synthetic loopback HTTP and memory-only PGlite; no actual accounts, child data, persistent database or external service.',
      'Message time-window boundary tests belong to HTTP/domain tests; this browser uses newly sent real synthetic messages.',
      'Photo/video uploads, physical devices, production TLS and human usability are outside this test.',
      'Resumed-draft source authority is changed by same-account self-hide; this browser does not itself simulate membership reconnection.',
      'Only committed-response loss, offline suspension and bounded GET gates alter transport; mutations use actual HTTP handlers and UI.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, startedAt: report.at, finished: false };
  await writeFile(path.join(folder, 'ownership.json'), JSON.stringify(ownership, null, 2));
  await writeFile(path.join(folder, 'source-manifest.json'), JSON.stringify(source, null, 2));
  let browserServer, browserProcess, browser, phase = 'STARTUP', step = 'STARTUP';
  const advance = async (nextPhase) => {
    phase = nextPhase;
    await writeFile(path.join(folder, 'progress.json'), JSON.stringify({ runId, sourceSha256: source.sha256,
      phase, at: new Date().toISOString(), completedChecks: report.checks, currentCheck: report.currentCheck ?? null }, null, 2));
  };
  const contexts = new Set(), sandboxes = new Set();
  try {
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    browserProcess = browserServer.process(); ownership.browserProcessId = browserProcess.pid;
    await writeFile(path.join(folder, 'ownership.json'), JSON.stringify(ownership, null, 2));
    browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    for (const width of [390, 1440, 320]) {
      await advance(`${width}:START_SANDBOX`);
      const sandbox = await createLocalApiSandbox({ port: 0 }); sandboxes.add(sandbox);
      const url = new URL(sandbox.origin);
      assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
      assert(url.port && !url.username && !url.password && !url.search && !url.hash); assert.equal(url.pathname, '/');
      const origin = url.origin, ids = sandbox.ids;
      const base = `/api/local/centers/${ids.centerId}/conversations/${ids.conversationId}`;
      const operations = [], fault = { target: null, lost: 0, failed: false };
      const result = { width, loginAndSend: false, capabilities: false, menuFocus: false, textReply: false, recordReference: false,
        editRetry: false, currentAndPinnedVersions: false, currentTextReference: false, lateReferenceRead: false,
        staleEdit: false, selfHide: false, hiddenReferenceUnavailable: false,
        allDeleteRetry: false, deletionBoundaries: false, deletedReferenceUnavailable: false, reload: false, expectedAccount: false,
        openDraftAuthority: false, suspendedDraftAuthority: false, pendingReceiptAuthority: false,
        storagePrivate: false, layout: false, cleanup: false, observations: {} };
      report.currentCheck = result;
      const observe = (page, role) => {
        page.setDefaultTimeout(15_000);
        page.on('pageerror', () => report.errors.push({ width, role, phase, type: 'pageerror' }));
        page.on('console', (entry) => {
          if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:'))
            report.errors.push({ width, role, phase, type: 'console' });
        });
      };
      const login = async (who) => {
        step = `LOGIN:${who.role}`;
        const credential = sandbox.credentials.find((entry) => entry.role === who.role);
        assert(credential?.email.endsWith('.test'), 'LOCAL_MESSAGE_SYNTHETIC_CREDENTIAL');
        await who.page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await who.page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        await who.page.getByRole('button', { name: '로그인', exact: true }).click();
        await who.page.getByTestId('home').waitFor();
      };
      const actor = async (role) => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR',
          isMobile: width <= 640, hasTouch: width <= 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context);
        await context.route('**/*', async (route) => {
          const request = route.request(), requested = new URL(request.url());
          const asset = ['/', '/favicon.ico', '/local-api/client.js', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/care-client.js',
            '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css', '/local-api/media-client.js', '/local-api/media-ui.js', '/local-api/media-viewer.js', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js'].includes(requested.pathname) && ['GET', 'HEAD'].includes(request.method());
          const primaryRead = request.method() === 'GET' && requested.pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
            [...requested.searchParams].length === 1 && requested.searchParams.get('conversationId') === ids.conversationId;
          const api = /^\/api\/local\/(?:auth\/(?:login|session|logout)|centers\/[A-Za-z0-9_-]+\/(?:inbox|conversations\/[A-Za-z0-9_-]+\/(?:profile|read|goals|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+(?:\/(?:edit|delete))?)?|records(?:\/[A-Za-z0-9_-]+)?)?))$/.test(requested.pathname);
          if (requested.origin !== origin || !['GET', 'POST', 'HEAD'].includes(request.method()) || !(asset || api || primaryRead)) {
            report.unexpectedRequests.push({ width, role, phase, sameOrigin: requested.origin === origin, method: request.method() });
            return route.abort().catch(() => {});
          }
          if (request.method() === 'POST' && requested.pathname.startsWith(base)) {
            const body = request.postDataJSON(); operations.push({ role, pathname: requested.pathname, body });
            if (fault.target === requested.pathname) {
              fault.target = null;
              try {
                const response = await route.fetch({ maxRedirects: 0 });
                if (response.status() !== 200) fault.failed = true; else fault.lost++;
                await response.dispose(); await route.abort('failed').catch(() => {});
              } catch { fault.failed = true; await route.abort('failed').catch(() => {}); }
              return;
            }
          }
          return route.continue().catch(() => {});
        });
        const page = await context.newPage(); observe(page, role);
        const who = { context, page, role };
        await page.goto(origin); await page.getByTestId('login-form').waitFor(); await login(who); return who;
      };
      const therapist = await actor('therapist'), guardian = await actor('guardian'), actors = [therapist, guardian];
      const dialog = (who) => who.page.getByTestId('care-dialog');
      const row = (who, id) => who.page.locator(`[data-testid="message-row"][data-message-id="${id}"]`);
      const field = (who, name) => dialog(who).locator(`[name="${name}"]`);
      const reference = (who, id) => dialog(who).locator(`blockquote.care-reference[data-reference-message-id="${id}"]`);
      // Authored values are compared in memory, never added to diagnostics.
      const recordInput = (who) => dialog(who).locator('form').evaluate((form) => [...form.elements]
        .filter((node) => node.name && !['submit', 'button'].includes(node.type))
        .map((node) => ({ name: node.name, type: node.type, value: node.value,
          ...(node.type === 'checkbox' ? { checked: node.checked } : {}) })));
      const fill = async (who, name, value) => { step = `FILL:${name}`; const input = field(who, name); await reveal(input); await input.fill(value); };
      const action = async (who, name, id, key = 'message-id') => {
        step = `ACTION:${name}`;
        if (['edit-record', 'preview-record'].includes(name)) await workspaceRecords(who.page, ids.conversationId);
        else await room(who);
        if (name === 'reference') await who.page.locator('[data-care-action="new-record"]:not([disabled])').waitFor();
        const button = who.page.locator(`[data-care-action="${name}"][data-${key}="${id}"]`);
        await reveal(button); await button.click(); await dialog(who).waitFor();
      };
      const submit = async (who, name) => {
        step = `SUBMIT:${name}`; await dialog(who).getByRole('button', { name, exact: true }).click();
        await dialog(who).waitFor({ state: 'hidden' });
        await room(who);
      };
      const discard = async (who) => { await submit(who, '입력 취소'); };
      const closeInput = async (who) => { await submit(who, '닫기'); };
      const refresh = async (who) => { await workspaceAccountAction(who.page, 'refresh'); };
      const room = async (who) => workspaceRoom(who.page, ids.conversationId, { keyboard: width === 320 });
      const api = (who, suffix, body) => who.page.evaluate(async ({ pathname, body, expectedAccount }) => {
        const response = await fetch(pathname, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'X-Carebridge-Account': expectedAccount, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Carebridge-Request': '1' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, value: response.status === 204 ? null : await response.json() };
      }, { pathname: `${base}${suffix}`, body, expectedAccount: ids[`${who.role}Id`] });
      const messages = async (who) => { const response = await api(who, '/messages?limit=100'); assert.equal(response.status, 200); return response.value.messages; };
      const message = async (who, id) => { const response = await api(who, `/messages/${id}`); assert.equal(response.status, 200); return response.value.message; };
      const record = async (id) => { const response = await api(therapist, `/records/${id}`); assert.equal(response.status, 200); return response.value.record; };
      // Current hidden/deleted/changed flags may evolve; the captured clinical
      // content and source revision must not. Compare those contracts separately.
      const referenceSnapshot = (source) => Object.fromEntries(['messageId', 'messageRevision', 'body', 'attachmentCount'].map((key) => [key, source[key]]));
      const post = async (who, body) => {
        step = 'SEND_TEXT'; await who.page.getByLabel('메시지', { exact: true }).fill(body);
        await who.page.getByRole('button', { name: '보내기', exact: true }).click();
        await who.page.getByTestId('message-row').filter({ hasText: body }).waitFor();
        const created = (await messages(who)).find((entry) => entry.body === body); assert(created); return created;
      };
      const revision = async (id) => {
        const { rows } = await sandbox.database.query('SELECT current_revision FROM cb_message_text_heads WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3', [ids.centerId, ids.conversationId, id]);
        return rows[0]?.current_revision;
      };
      const revisionCount = async (id) => {
        const { rows } = await sandbox.database.query('SELECT count(*)::integer AS count FROM cb_message_text_revisions WHERE center_id=$1 AND conversation_id=$2 AND message_id=$3', [ids.centerId, ids.conversationId, id]);
        return rows[0].count;
      };
      const guardResumeDom = async (who, forbiddenText) => {
        await who.page.evaluate((needles) => {
          window.__localMessageResumeObserver?.disconnect();
          window.__localMessageResumeLeak = false;
          const contains = (node) => needles.some((text) => (node?.textContent ?? '').includes(text));
          window.__localMessageResumeObserver = new MutationObserver((changes) => {
            for (const change of changes) {
              // Added nodes remain inspectable even if immediately detached;
              // observing only the final dialog text can miss a brief redraw.
              if ([...change.addedNodes].some(contains) || change.type === 'characterData' && contains(change.target))
                window.__localMessageResumeLeak = true;
            }
          });
          window.__localMessageResumeObserver.observe(document.body, { subtree: true, childList: true, characterData: true });
        }, forbiddenText);
      };
      const checkResumeDom = async (who, forbiddenText) => {
        assert.equal(await who.page.evaluate(() => window.__localMessageResumeLeak), false, 'LOCAL_MESSAGE_RESUME_SOURCE_REEXPOSED');
        const text = await who.page.locator('body').innerText();
        for (const forbidden of forbiddenText) assert(!text.includes(forbidden), 'LOCAL_MESSAGE_RESUME_SOURCE_VISIBLE');
        await who.page.evaluate(() => window.__localMessageResumeObserver?.disconnect());
      };
      const capture = async (who, label) => {
        if (!await dialog(who).isVisible()) await who.page.locator('#room-title').focus();
        assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'LOCAL_MESSAGE_PAGE_OVERFLOW');
        if (await dialog(who).isVisible()) assert.equal(await dialog(who).evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, 'LOCAL_MESSAGE_DIALOG_OVERFLOW');
        const filename = `${width}-${label}.png`;
        await who.page.screenshot({ path: path.join(folder, filename), fullPage: true,
          mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]')] });
        report.screenshots.push({ width, label, filename, syntheticOnly: true });
      };
      const originalBody = `가상 보호자 첫 소식 ${width}`, editedBody = `가상 보호자 수정 소식 ${width}`;
      const finalBody = `가상 다른 창에서 저장한 소식 ${width}`, replyBody = `가상 치료사 독립 답장 ${width}`;
      const recordTitle = `가상 당시 소식 참고 기록 ${width}`;
      for (const who of actors) await room(who);

      await advance(`${width}:SEND_AND_CAPABILITIES`);
      const original = await post(guardian, originalBody); await refresh(therapist); await row(therapist, original.id).waitFor();
      assert.equal(original.version, 1); assert.equal(await revision(original.id), 1); result.loginAndSend = true;
      const own = await message(guardian, original.id), other = await message(therapist, original.id);
      assert.equal(own.canEdit, true); assert.equal(own.canDeleteAll, true); assert.equal(other.canEdit, false); assert.equal(other.canDeleteAll, false);
      assert.equal(await row(therapist, original.id).locator('[data-care-action="text-edit"],[data-care-action="text-delete-all"]').count(), 0);
      result.capabilities = true;

      await advance(`${width}:POLL_PRESERVES_MENU_FOCUS`);
      const focusedReply = row(therapist, original.id).locator('[data-care-action="reply"]');
      await reveal(focusedReply); await focusedReply.focus();
      const pollMessage = await post(guardian, `가상 메뉴가 열린 동안 도착한 소식 ${width}`);
      await row(therapist, pollMessage.id).waitFor();
      assert.notEqual(await row(therapist, original.id).locator('.care-message-menu').getAttribute('open'), null);
      assert.equal(await focusedReply.evaluate((element) => document.activeElement === element), true);
      result.menuFocus = true;

      await advance(`${width}:TEXT_REPLY_AND_REFERENCE`);
      await action(therapist, 'reply', original.id); await fill(therapist, 'body', replyBody); await submit(therapist, '답장 보내기');
      const reply = (await messages(therapist)).find((entry) => entry.body === replyBody); assert(reply);
      assert.equal(reply.quote.body, originalBody); assert.equal(reply.quote.version, 1);
      await row(therapist, reply.id).locator('.message-quote').filter({ hasText: originalBody }).waitFor();
      assert.equal(await row(therapist, reply.id).locator('.message-quote').innerText(), originalBody); result.textReply = true;
      await action(therapist, 'reference', original.id); await fill(therapist, 'title', recordTitle);
      await fill(therapist, 'performed', '가상 소식과 치료사의 직접 관찰을 구분해 기록');
      await field(therapist, 'goalId').selectOption(ids.goalId); await submit(therapist, '기록 저장');
      const recordSave = operations.find((entry) => entry.body.content?.title === recordTitle); assert(recordSave);
      const recordId = recordSave.pathname.split('/').at(-1);
      const pinned = referenceSnapshot((await record(recordId)).referenceSources[0]); assert.equal(pinned.messageId, original.id);
      assert.equal(pinned.messageRevision, 1); assert.equal(pinned.body, originalBody); result.recordReference = true;

      await advance(`${width}:EDIT_COMMITTED_RESPONSE_LOSS`);
      await action(guardian, 'text-edit', original.id); await fill(guardian, 'body', editedBody); await capture(guardian, 'edit-form');
      fault.target = `${base}/messages/${original.id}/edit`;
      await dialog(guardian).getByRole('button', { name: '수정 저장', exact: true }).click();
      await dialog(guardian).getByRole('button', { name: '같은 요청 다시 확인', exact: true }).waitFor();
      assert.equal(fault.failed, false); assert.equal(fault.lost, 1); assert.equal(await revision(original.id), 2);
      const uncertainView = await dialog(guardian).evaluate((node) => {
        const body = node.querySelector('[name="body"]');
        return body ? { kind: 'editor', value: body.value, disabled: body.disabled }
          : { kind: 'receipt', title: node.querySelector('h2')?.textContent };
      });
      // A normal poll may conservatively replace an uncertain editor with the
      // source-free receipt view. Both must retain the original operation.
      if (uncertainView.kind === 'editor') { assert.equal(uncertainView.value, editedBody); assert.equal(uncertainView.disabled, true); }
      else assert.equal(uncertainView.title, '이전 요청 처리 확인');
      await submit(guardian, '같은 요청 다시 확인');
      const edits = operations.filter((entry) => entry.pathname === `${base}/messages/${original.id}/edit`);
      assert.equal(edits.length, 2); assert.deepEqual(edits[0].body, edits[1].body);
      assert.equal(await revision(original.id), 2); assert.equal(await revisionCount(original.id), 2); result.editRetry = true;

      await advance(`${width}:CURRENT_AND_PINNED_VERSIONS`);
      for (const who of actors) { await who.page.reload(); await who.page.getByTestId('home').waitFor(); await room(who); await row(who, original.id).getByText(editedBody, { exact: true }).waitFor(); }
      const current = await message(therapist, original.id), pinnedReply = await message(therapist, reply.id);
      assert.equal(current.body, editedBody); assert.equal(current.version, 2); assert.equal(current.edited, true);
      assert.equal(pinnedReply.quote.body, originalBody); assert.equal(pinnedReply.quote.version, 1); assert.equal(pinnedReply.quote.changed, true);
      await row(therapist, reply.id).locator('.message-quote').filter({ hasText: originalBody }).waitFor();
      assert.equal(await row(therapist, reply.id).locator('.message-quote').innerText(), originalBody);
      assert.deepEqual(referenceSnapshot((await record(recordId)).referenceSources[0]), pinned);
      await action(therapist, 'edit-record', recordId, 'record-id');
      assert((await dialog(therapist).innerText()).includes(originalBody)); assert(!(await dialog(therapist).innerText()).includes(editedBody));
      await advance(`${width}:CURRENT_TEXT_REFERENCE`);
      const savedBeforeCurrentRead = await record(recordId);
      await fill(therapist, 'performed', '가상 원문 확인 중 보존할 미저장 관찰');
      await fill(therapist, 'privateNote', '가상 원문 확인 중 보존할 비공개 초안');
      const authoredBefore = await recordInput(therapist), inputNode = await field(therapist, 'performed').elementHandle();
      const writesBeforeCurrentRead = operations.filter((entry) => entry.role === 'therapist').length;
      const referenceNote = reference(therapist, original.id), currentPanel = referenceNote.locator('[data-reference-source]');
      assert.equal(await referenceNote.locator('[data-reference-quote]').innerText(), originalBody);
      await referenceNote.getByRole('button', { name: '현재 원문 보기', exact: true }).click();
      await currentPanel.getByText(editedBody, { exact: true }).waitFor();
      assert((await currentPanel.innerText()).includes('현재 2번째 소식'));
      assert.equal(await referenceNote.locator('[data-reference-quote]').innerText(), originalBody);
      assert.deepEqual(await recordInput(therapist), authoredBefore, 'LOCAL_MESSAGE_REFERENCE_INPUT_UNCHANGED');
      assert.equal(await inputNode.evaluate((node) => node.isConnected), true, 'LOCAL_MESSAGE_REFERENCE_INPUT_NOT_REPLACED');
      assert.deepEqual(await record(recordId), savedBeforeCurrentRead, 'LOCAL_MESSAGE_REFERENCE_RECORD_UNCHANGED');
      assert.equal(operations.filter((entry) => entry.role === 'therapist').length, writesBeforeCurrentRead, 'LOCAL_MESSAGE_REFERENCE_READ_HAS_NO_POST');
      await capture(therapist, 'current-v2-and-pinned-v1-reference');
      await referenceNote.getByRole('button', { name: '현재 원문 닫기', exact: true }).click(); await currentPanel.waitFor({ state: 'hidden' });
      assert.deepEqual(await recordInput(therapist), authoredBefore); await inputNode.dispose();
      result.currentTextReference = true;

      await advance(`${width}:LATE_REFERENCE_READ_AFTER_DISCARD`);
      let releaseReference, referenceHeld;
      const referenceGate = new Promise((resolve) => { releaseReference = resolve; });
      const heldReference = new Promise((resolve) => { referenceHeld = resolve; }), referenceReads = [];
      const sourcePath = `${origin}${base}/messages/${original.id}`;
      const holdReference = (route) => {
        if (route.request().method() !== 'GET') return route.fallback().catch(() => {});
        const work = (async () => {
          const response = await route.fetch({ maxRedirects: 0 });
          try {
            assert.equal(response.status(), 200, 'LOCAL_MESSAGE_REFERENCE_REAL_READ'); referenceHeld();
            await referenceGate; await route.fulfill({ response }).catch(() => {});
          } finally { await response.dispose(); }
        })();
        referenceReads.push(work); return work;
      };
      try {
        await therapist.page.route(sourcePath, holdReference);
        await referenceNote.getByRole('button', { name: '현재 원문 보기', exact: true }).click();
        await bounded(heldReference, 5000);
        // Closing must invalidate the in-flight source read, without discarding
        // this record's authored values. Resume checks the saved record itself.
        await dialog(therapist).getByRole('button', { name: '닫기', exact: true }).click();
        await dialog(therapist).waitFor({ state: 'hidden' });
        await therapist.page.locator('[data-care-action="resume"]').click(); await dialog(therapist).waitFor();
        assert.deepEqual(await recordInput(therapist), authoredBefore, 'LOCAL_MESSAGE_REFERENCE_CLOSE_PRESERVES_DRAFT');
        await guardResumeDom(therapist, [editedBody]);
        await dialog(therapist).getByRole('button', { name: '입력 취소', exact: true }).click();
        await dialog(therapist).waitFor({ state: 'hidden' });
      } finally {
        releaseReference();
        try { await bounded(Promise.all(referenceReads), 5000); }
        finally { await therapist.page.unroute(sourcePath, holdReference); }
      }
      await checkResumeDom(therapist, [editedBody]);
      assert.equal(await dialog(therapist).locator('[data-reference-source]').count(), 0);
      assert.deepEqual(await record(recordId), savedBeforeCurrentRead, 'LOCAL_MESSAGE_LATE_REFERENCE_RECORD_UNCHANGED');
      result.lateReferenceRead = true; await room(therapist); result.currentAndPinnedVersions = true;

      await advance(`${width}:STALE_EDIT_CONFLICT`);
      await action(guardian, 'text-edit', original.id); await fill(guardian, 'body', '가상 저장되지 않아야 하는 이전 창 입력');
      const secondPage = await guardian.context.newPage(); observe(secondPage, 'guardian-other-tab');
      const second = { page: secondPage, context: guardian.context, role: 'guardian' };
      try {
        await secondPage.goto(origin); await secondPage.getByTestId('home').waitFor(); await room(second);
        await action(second, 'text-edit', original.id); await fill(second, 'body', finalBody); await submit(second, '수정 저장');
        await Promise.all([
          guardian.page.waitForResponse((response) => response.url() === `${origin}${base}/messages/${original.id}/edit` && response.request().method() === 'POST' && response.status() === 409),
          dialog(guardian).getByRole('button', { name: '수정 저장', exact: true }).click(),
        ]);
        assert.equal(await field(guardian, 'body').inputValue(), '가상 저장되지 않아야 하는 이전 창 입력');
        assert.equal(await field(guardian, 'body').isDisabled(), false);
        assert.equal((await message(guardian, original.id)).body, finalBody); assert.equal(await revision(original.id), 3);
        await discard(guardian);
      } finally { await secondPage.close(); }
      result.staleEdit = true;

      await advance(`${width}:RECIPIENT_SELF_HIDE`);
      await refresh(therapist); await row(therapist, original.id).getByText(finalBody, { exact: true }).waitFor();
      await action(therapist, 'text-delete-self', original.id); await field(therapist, 'confirmed').check(); await submit(therapist, '나에게만 삭제 확인');
      await row(therapist, original.id).waitFor({ state: 'detached' });
      const hiddenList = await messages(therapist), hiddenQuote = hiddenList.find((entry) => entry.id === reply.id);
      assert.equal(hiddenList.some((entry) => entry.id === original.id), false);
      assert.equal((await api(therapist, `/messages/${original.id}`)).status, 404);
      assert.equal(hiddenQuote.body, replyBody); assert.equal(hiddenQuote.quote.hidden, true);
      assert.equal(hiddenQuote.quote.body, '열람할 수 없는 이전 소식입니다.');
      await row(therapist, reply.id).locator('.message-quote').filter({ hasText: '열람할 수 없는 이전 소식입니다.' }).waitFor();
      assert.equal(await row(therapist, reply.id).locator('.message-quote').innerText(), '열람할 수 없는 이전 소식입니다.');
      assert.equal((await message(guardian, original.id)).body, finalBody);
      assert.equal((await message(guardian, reply.id)).quote.body, originalBody);
      assert.deepEqual(referenceSnapshot((await record(recordId)).referenceSources[0]), pinned); result.selfHide = true;
      await advance(`${width}:HIDDEN_CURRENT_REFERENCE_DENIED`);
      await action(therapist, 'edit-record', recordId, 'record-id');
      const hiddenRecord = await record(recordId);
      await fill(therapist, 'performed', '가상 숨긴 원문과 별도로 보존할 관찰');
      const hiddenInputs = await recordInput(therapist), hiddenReference = reference(therapist, original.id);
      await hiddenReference.getByRole('button', { name: '현재 원문 보기', exact: true }).click();
      const unavailableText = '현재 원문을 볼 수 없습니다. 기록 당시 참고는 그대로 보존됩니다.';
      await hiddenReference.locator('[data-reference-source]').filter({ hasText: unavailableText }).waitFor();
      assert.equal(await hiddenReference.locator('[data-reference-source]').innerText(), unavailableText);
      assert.equal(await hiddenReference.locator('[data-reference-quote]').innerText(), originalBody);
      assert(!(await hiddenReference.locator('[data-reference-source]').innerText()).includes(finalBody));
      assert.deepEqual(await recordInput(therapist), hiddenInputs); assert.deepEqual(await record(recordId), hiddenRecord);
      await discard(therapist); result.hiddenReferenceUnavailable = true;

      await advance(`${width}:ALL_DELETE_COMMITTED_RESPONSE_LOSS`);
      await refresh(guardian); await row(guardian, original.id).getByText(finalBody, { exact: true }).waitFor();
      await action(guardian, 'text-delete-all', original.id); await field(guardian, 'confirmed').check();
      fault.target = `${base}/messages/${original.id}/delete`;
      await dialog(guardian).getByRole('button', { name: '모두에게서 삭제 확인', exact: true }).click();
      await dialog(guardian).getByRole('button', { name: '같은 요청 다시 확인', exact: true }).waitFor();
      assert.equal(fault.failed, false); assert.equal(fault.lost, 2); assert.equal(await revision(original.id), 4);
      await submit(guardian, '같은 요청 다시 확인');
      const deletions = operations.filter((entry) => entry.pathname === `${base}/messages/${original.id}/delete` && entry.body.scope === 'all');
      assert.equal(deletions.length, 2); assert.deepEqual(deletions[0].body, deletions[1].body);
      assert.equal(await revision(original.id), 4); assert.equal(await revisionCount(original.id), 4); result.allDeleteRetry = true;
      const tombstone = await message(guardian, original.id), removedQuote = await message(guardian, reply.id);
      assert.equal(tombstone.hidden, true); assert.equal(tombstone.deleted, true); assert.equal(tombstone.authorId, null); assert.equal(tombstone.body, '삭제된 소식입니다.');
      assert.equal(tombstone.canEdit, false); assert.equal(tombstone.canDeleteAll, false);
      assert.equal(removedQuote.body, replyBody); assert.equal(removedQuote.quote.hidden, true); assert.equal(removedQuote.quote.body, '삭제된 소식입니다.');
      assert.deepEqual(referenceSnapshot((await record(recordId)).referenceSources[0]), pinned);
      await action(therapist, 'edit-record', recordId, 'record-id'); assert((await dialog(therapist).innerText()).includes(originalBody));
      await advance(`${width}:DELETED_CURRENT_REFERENCE_DENIED`);
      const deletedRecord = await record(recordId), deletedInputs = await recordInput(therapist);
      const deletedReference = reference(therapist, original.id);
      await deletedReference.getByRole('button', { name: '현재 원문 보기', exact: true }).click();
      await deletedReference.locator('[data-reference-source]').filter({ hasText: unavailableText }).waitFor();
      assert.equal(await deletedReference.locator('[data-reference-source]').innerText(), unavailableText);
      assert.equal(await deletedReference.locator('[data-reference-quote]').innerText(), originalBody);
      assert(!(await deletedReference.locator('[data-reference-source]').innerText()).includes(finalBody));
      assert.deepEqual(await recordInput(therapist), deletedInputs); assert.deepEqual(await record(recordId), deletedRecord);
      await discard(therapist); result.deletedReferenceUnavailable = true;
      result.deletionBoundaries = true;

      await advance(`${width}:RELOAD_STORAGE_LAYOUT`);
      for (const who of actors) {
        await who.page.reload(); await who.page.getByTestId('home').waitFor(); await room(who);
        await row(who, reply.id).getByText(replyBody, { exact: true }).waitFor();
        assert.equal((await who.page.locator('body').innerText()).includes(originalBody), false);
        assert.equal((await who.page.locator('body').innerText()).includes(finalBody), false);
        assert.deepEqual(await who.page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, '']);
        await capture(who, `${who.role}-deleted`);
      }
      assert.deepEqual(referenceSnapshot((await record(recordId)).referenceSources[0]), pinned);
      result.reload = result.storagePrivate = result.layout = true;

      await advance(`${width}:ACCOUNT_SWITCH_PRECONDITION`);
      const switchedBody = `가상 계정 전환 전 새 소식 ${width}`, switchedEdit = `가상 계정 전환 전 수정 ${width}`;
      const switched = await post(guardian, switchedBody);
      const accountPage = await guardian.context.newPage(); observe(accountPage, 'shared-cookie-other-account');
      const differentAccount = { page: accountPage, context: guardian.context, role: 'therapist' };
      let releaseGets; const gate = new Promise((resolve) => { releaseGets = resolve; }), heldGets = [];
      const delayGets = (route) => {
        if (route.request().method() !== 'GET') return route.fallback().catch(() => {});
        const work = (async () => { await gate; await route.fallback().catch(() => {}); })(); heldGets.push(work); return work;
      };
      try {
        await accountPage.goto(origin); await accountPage.getByTestId('home').waitFor();
        await guardian.page.bringToFront(); await action(guardian, 'text-edit', switched.id); await fill(guardian, 'body', switchedEdit);
        await guardian.page.route('**/api/local/**', delayGets);
        fault.target = `${base}/messages/${switched.id}/edit`;
        await dialog(guardian).getByRole('button', { name: '수정 저장', exact: true }).click();
        await dialog(guardian).getByRole('button', { name: '같은 요청 다시 확인', exact: true }).waitFor();
        assert.equal(fault.failed, false); assert.equal(fault.lost, 3); assert.equal(await revision(switched.id), 2);
        const frozenOperation = operations.find((entry) => entry.pathname === `${base}/messages/${switched.id}/edit`); assert(frozenOperation);
        await workspaceAccountAction(accountPage, 'logout'); await accountPage.getByTestId('login-form').waitFor(); await login(differentAccount);
        const retry = dialog(guardian).getByRole('button', { name: '같은 요청 다시 확인', exact: true });
        if (await retry.isVisible()) {
          await Promise.all([
            guardian.page.waitForResponse((response) => response.url() === `${origin}${base}/messages/${switched.id}/edit` && response.request().method() === 'POST' && response.status() === 401),
            retry.click(),
          ]);
          result.observations.accountChangeUiRetry = true;
        } else {
          assert.equal(await guardian.page.getByTestId('message-row').count(), 0);
          assert.equal((await api(guardian, `/messages/${switched.id}/edit`, frozenOperation.body)).status, 401);
          result.observations.accountChangeUiRetry = false;
        }
        assert.equal(await revision(switched.id), 2); assert.equal(await revisionCount(switched.id), 2);
        const { rows: authors } = await sandbox.database.query('SELECT author_id FROM cb_messages WHERE center_id=$1 AND conversation_id=$2 AND id=$3', [ids.centerId, ids.conversationId, switched.id]);
        assert.equal(authors[0].author_id, ids.guardianId);
      } finally {
        releaseGets(); await Promise.allSettled(heldGets); await guardian.page.unroute('**/api/local/**', delayGets); await accountPage.close();
      }
      await guardian.page.getByTestId('login-form').waitFor();
      assert.equal(await guardian.page.getByTestId('message-row').count(), 0); assert.equal(await dialog(guardian).count(), 0);
      result.expectedAccount = true;

      // Same account, same room, changed source authority. Unlike a sign-out,
      // these transitions retain the draft owner and exercise source validation.
      await login(guardian); await room(guardian);
      const peerPage = await guardian.context.newPage(); observe(peerPage, 'same-account-source-change');
      const peer = { page: peerPage, context: guardian.context, role: 'guardian' };
      try {
        await peerPage.goto(origin); await peerPage.getByTestId('home').waitFor(); await room(peer);
        await advance(`${width}:OPEN_DRAFT_SOURCE_HIDDEN`);
        const openSource = await post(therapist, `가상 열린 답장의 접근 변경 원문 ${width}`);
        await refresh(guardian); await row(guardian, openSource.id).waitFor();
        await action(guardian, 'reply', openSource.id); await fill(guardian, 'body', `가상 아직 보내지 않은 열린 답장 ${width}`);
        await refresh(peer); await row(peer, openSource.id).waitFor();
        await action(peer, 'text-delete-self', openSource.id); await field(peer, 'confirmed').check(); await submit(peer, '나에게만 삭제 확인');
        // The ordinary periodic refresh, not a reload or test-driven state
        // reset, must remove the source from an already open dialog.
        await dialog(guardian).waitFor({ state: 'hidden' });
        await row(guardian, openSource.id).waitFor({ state: 'detached' });
        assert.equal((await api(guardian, `/messages/${openSource.id}`)).status, 404);
        assert(!(await guardian.page.locator('body').innerText()).includes(openSource.body));
        assert.equal((await message(therapist, openSource.id)).body, openSource.body);
        assert.equal((await messages(guardian)).some((entry) => entry.body === `가상 아직 보내지 않은 열린 답장 ${width}`), false);
        result.openDraftAuthority = true;

        await advance(`${width}:SUSPENDED_DRAFT_SOURCE_HIDDEN`);
        const suspendedSource = await post(therapist, `가상 재개 전에 숨긴 답장 원문 ${width}`);
        await refresh(guardian); await row(guardian, suspendedSource.id).waitFor();
        await action(guardian, 'reply', suspendedSource.id); await fill(guardian, 'body', `가상 재개 대기 답장 ${width}`); await closeInput(guardian);
        let releaseDraftGets; const draftGate = new Promise((resolve) => { releaseDraftGets = resolve; }), draftGets = [];
        const holdDraftGets = (route) => {
          if (route.request().method() !== 'GET') return route.fallback().catch(() => {});
          const work = (async () => { await draftGate; await route.fallback().catch(() => {}); })(); draftGets.push(work); return work;
        };
        try {
          await guardian.page.route('**/api/local/**', holdDraftGets);
          await refresh(peer); await row(peer, suspendedSource.id).waitFor();
          await action(peer, 'text-delete-self', suspendedSource.id); await field(peer, 'confirmed').check(); await submit(peer, '나에게만 삭제 확인');
          await guardian.context.setOffline(true);
          await guardian.page.getByTestId('message-row').first().waitFor({ state: 'detached' });
          await guardResumeDom(guardian, [suspendedSource.body]);
        } finally {
          releaseDraftGets(); await Promise.allSettled(draftGets); await guardian.page.unroute('**/api/local/**', holdDraftGets);
          await guardian.context.setOffline(false);
        }
        await room(guardian);
        const resumeDraft = guardian.page.locator('[data-care-action="resume"]');
        if (await resumeDraft.isVisible()) {
          await Promise.all([
            guardian.page.waitForResponse((response) => response.url() === `${origin}${base}/messages/${suspendedSource.id}` && response.status() === 404),
            resumeDraft.click(),
          ]);
          await dialog(guardian).waitFor({ state: 'hidden' });
          result.observations.suspendedDraftExplicitResume = true;
        } else {
          // A completed refresh may already close the source-dependent draft;
          // that is safe and must not be misreported as an explicit resume.
          result.observations.suspendedDraftExplicitResume = false;
        }
        assert.equal((await api(guardian, `/messages/${suspendedSource.id}`)).status, 404);
        await checkResumeDom(guardian, [suspendedSource.body]);
        assert.equal((await messages(guardian)).some((entry) => entry.body === `가상 재개 대기 답장 ${width}`), false);
        result.suspendedDraftAuthority = true;

        await advance(`${width}:UNKNOWN_MUTATION_SOURCE_HIDDEN`);
        const pendingBody = `가상 확인 대기 전 원문 ${width}`, pendingEdit = `가상 확인 대기 중 수정 ${width}`;
        const pendingSource = await post(guardian, pendingBody);
        await action(guardian, 'text-edit', pendingSource.id); await fill(guardian, 'body', pendingEdit);
        fault.target = `${base}/messages/${pendingSource.id}/edit`;
        await dialog(guardian).getByRole('button', { name: '수정 저장', exact: true }).click();
        await dialog(guardian).getByRole('button', { name: '같은 요청 다시 확인', exact: true }).waitFor();
        assert.equal(fault.failed, false); assert.equal(fault.lost, 4); assert.equal(await revision(pendingSource.id), 2);
        await closeInput(guardian);
        await refresh(peer); await row(peer, pendingSource.id).getByText(pendingEdit, { exact: true }).waitFor();
        await action(peer, 'text-delete-self', pendingSource.id); await field(peer, 'confirmed').check(); await submit(peer, '나에게만 삭제 확인');
        await refresh(guardian); await row(guardian, pendingSource.id).waitFor({ state: 'detached' });
        await guardResumeDom(guardian, [pendingBody, pendingEdit]);
        await guardian.page.locator('[data-care-action="resume"]').click(); await dialog(guardian).waitFor();
        await dialog(guardian).getByRole('heading', { name: '이전 요청 처리 확인', exact: true }).waitFor();
        assert.equal(await field(guardian, 'body').count(), 0);
        assert.equal(await dialog(guardian).getByRole('button', { name: '같은 요청 다시 확인', exact: true }).isVisible(), true);
        await submit(guardian, '같은 요청 다시 확인');
        const pendingAttempts = operations.filter((entry) => entry.pathname === `${base}/messages/${pendingSource.id}/edit`);
        assert.equal(pendingAttempts.length, 2); assert.deepEqual(pendingAttempts[0].body, pendingAttempts[1].body);
        assert.equal(await revision(pendingSource.id), 2); assert.equal(await revisionCount(pendingSource.id), 2);
        assert.equal((await api(guardian, `/messages/${pendingSource.id}`)).status, 404);
        await checkResumeDom(guardian, [pendingBody, pendingEdit]);
        result.pendingReceiptAuthority = true;
      } finally { await peerPage.close(); }
      assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedRequests, []);
      for (const who of actors) { await who.context.close(); contexts.delete(who.context); }
      await sandbox.close(); assert.equal(sandbox.database.closed, true); assert.equal(sandbox.credentials.length, 0);
      sandboxes.delete(sandbox); result.cleanup = true; report.checks.push(result);
      await advance(`${width}:COMPLETED`);
      const boundaryResults = Object.entries(result).filter(([key, value]) => key !== 'cleanup' && typeof value === 'boolean');
      assert(boundaryResults.every(([, value]) => value === true));
      console.log(JSON.stringify({ width, passed: true, completedBoundaries: boundaryResults.filter(([, value]) => value).length }));
    }
    report.finalSource = await sourceManifest(); assert.equal(report.finalSource.sha256, source.sha256, 'LOCAL_MESSAGE_SOURCE_CHANGED');
  } catch (error) {
    report.failure = { code: 'LOCAL_MESSAGE_BROWSER_FAILED', phase, step,
      kind: ['TimeoutError', 'AssertionError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-message-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      workspaceHelperLine: Number(error?.stack?.match(/local-workspace-browser-helpers\.mjs:(\d+):\d+/)?.[1]) || null,
      assertion: /^LOCAL_MESSAGE_[A-Z_]+$/.test(error?.message ?? '') ? error.message : null };
    report.failureSurfaces = [];
    for (const context of contexts) for (const page of context.pages()) {
      try {
        const filename = `failure-surface-${report.failureSurfaces.length}.png`;
        const state = await page.evaluate(() => ({
          dialogOpen: !!document.querySelector('[data-testid="care-dialog"]')?.open,
          fieldNames: [...(document.querySelector('[data-testid="care-dialog"]')?.querySelectorAll('[name]') ?? [])].map((node) => node.name),
          formErrorPresent: !!document.querySelector('[data-care-error]')?.textContent,
        }));
        await page.screenshot({ path: path.join(folder, filename), fullPage: true,
          mask: [page.locator('input[type="email"]'), page.locator('input[type="password"]')] });
        report.failureSurfaces.push({ ...state, filename, syntheticOnly: true });
      } catch { report.failureSurfaces.push({ unavailable: true }); }
    }
  } finally {
    for (const context of contexts) try { await bounded(context.close()); contexts.delete(context); } catch {}
    report.cleanup.contextsClosed = contexts.size === 0;
    if (browserServer) {
      try { await bounded(browserServer.close()); } catch { try { await bounded(browserServer.kill()); } catch {} }
      report.cleanup.browserStopped = typeof browserProcess?.exitCode === 'number' || typeof browserProcess?.signalCode === 'string';
    }
    for (const sandbox of sandboxes) try { await bounded(sandbox.close()); assert.equal(sandbox.database.closed, true); sandboxes.delete(sandbox); } catch {}
    report.cleanup.sandboxesClosed = sandboxes.size === 0;
    report.finishedAt = new Date().toISOString(); report.passed = !report.failure && report.checks.length === 3 && Object.values(report.cleanup).every(Boolean);
    ownership.finished = true; ownership.cleanup = report.cleanup;
    await writeFile(path.join(folder, 'ownership.json'), JSON.stringify(ownership, null, 2));
    await writeFile(path.join(folder, 'results.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length, failure: report.failure, cleanup: report.cleanup }));
  return report.passed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runLocalMessageBrowser()) process.exitCode = 1; }
  catch { console.error('LOCAL_MESSAGE_BROWSER_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

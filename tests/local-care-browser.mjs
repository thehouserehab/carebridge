// Synthetic clinical vertical slice. This test owns every loopback listener,
// memory-only database, browser and context; no actual child data or uploads.
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
  const names = ['tests/local-care-browser.mjs', 'tests/local-workspace-browser-helpers.mjs'];
  for (const directory of ['local-api', 'src', 'server', 'server/migrations']) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      if (entry.isDirectory() || !/\.(?:mjs|js|css|html|sql)$/.test(entry.name)) continue;
      assert(entry.isFile() && !entry.isSymbolicLink(), 'LOCAL_CARE_SOURCE_TYPE');
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
    timer = setTimeout(() => reject(new Error('LOCAL_CARE_CLEANUP_TIMEOUT')), ms);
  })]); } finally { clearTimeout(timer); }
}
async function reveal(locator) {
  for (const details of await locator.locator('xpath=ancestor::details').all())
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
}
async function workspaceFailureSurface(page) {
  // Structural diagnostics only: never include field values, page text, URLs,
  // actor identifiers or credentials. Capture before a peer tab is closed,
  // since closing it can change visibility/focus and trigger a fresh read.
  try {
    return await bounded(page.evaluate(() => {
      const visible = (node) => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
      const currentView = [...document.querySelectorAll('[data-view][aria-current="page"]')]
        .filter(visible).map((node) => node.dataset.view).filter((value) => ['home', 'chat', 'records', 'child'].includes(value));
      const nav = [...document.querySelectorAll('[data-view="chat"]')].find(visible);
      const rect = nav?.getBoundingClientRect();
      const points = rect ? [[rect.x + rect.width / 2, rect.y + rect.height / 2],
        [rect.left + 3, rect.top + 3], [rect.right - 3, rect.top + 3],
        [rect.left + 3, rect.bottom - 3], [rect.right - 3, rect.bottom - 3]] : [];
      const round = (value) => Math.round(value * 100) / 100;
      const hitTest = points.map(([x, y]) => ({ point: [round(x), round(y)],
        insideViewport: x >= 0 && y >= 0 && x < innerWidth && y < innerHeight,
        elements: document.elementsFromPoint(x, y).slice(0, 3).map((node) => ({
          tag: ['HTML', 'BODY', 'BUTTON', 'NAV', 'DIV', 'SECTION', 'MAIN', 'DIALOG', 'FORM', 'P', 'SPAN', 'A', 'INPUT', 'TEXTAREA'].includes(node.tagName) ? node.tagName : 'OTHER',
          target: node === nav, targetContains: nav.contains(node), isDialog: node.matches('dialog'),
          withinMainNav: !!node.closest('.main-nav'),
        })),
      }));
      return {
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        currentView,
        chatNavigationCount: [...document.querySelectorAll('[data-view="chat"]')].filter(visible).length,
        inboxEntryCount: document.querySelectorAll('[data-testid="inbox"] [data-room-id]').length,
        selectedEntryCount: document.querySelectorAll('[data-testid="inbox"] [data-room-id][aria-current="true"]').length,
        visibleBackCount: [...document.querySelectorAll('[data-action="room-list"]')].filter(visible).length,
        composerVisible: visible(document.querySelector('#message')),
        dialogOpen: !!document.querySelector('[data-testid="care-dialog"]')?.open,
        chatNavigation: nav ? { disabled: nav.disabled, inertAncestor: !!nav.closest('[inert]'),
          rect: { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) },
          viewport: { width: innerWidth, height: innerHeight, scrollY: round(scrollY) }, hitTest } : null,
      };
    }), 2000);
  } catch { return { unavailable: true }; }
}

export async function runLocalCareBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const file of [options.module, options.executable]) assert((await lstat(file)).isFile());
  const { chromium } = await import(pathToFileURL(options.module).href);
  const source = await sourceManifest();
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-care-${runId}`);
  await mkdir(folder);
  const report = { runId, at: new Date().toISOString(), source, passed: false, checks: [], screenshots: [],
    errors: [], unexpectedRequests: [], failure: null,
    cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Synthetic loopback HTTP and memory-only PGlite; no actual accounts, child information, persistent database or external service.',
      'This step does not connect photo/video uploads, storage or native media inspection through HTTP.',
      'Viewport emulation is not physical-device, cross-device, production deployment or human usability evidence.',
      'Deliberate response loss exercises idempotency; delaying one real first 409 response exercises input recovery after polling. Responses are not fabricated; clinical operations use actual UI and HTTP domain services.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, origins: [], startedAt: report.at, finished: false };
  await writeFile(path.join(folder, 'ownership.json'), JSON.stringify(ownership, null, 2));
  let browserServer, browserProcess, browser, phase = 'STARTUP', step = 'STARTUP';
  const contexts = new Set(), sandboxes = new Set();
  try {
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    browserProcess = browserServer.process(); ownership.browserProcessId = browserProcess.pid;
    await writeFile(path.join(folder, 'ownership.json'), JSON.stringify(ownership, null, 2));
    browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    for (const width of [390, 1440, 320]) {
      phase = `${width}:START_SANDBOX`;
      const sandbox = await createLocalApiSandbox({ port: 0 }); sandboxes.add(sandbox);
      const originUrl = new URL(sandbox.origin);
      assert.equal(originUrl.protocol, 'http:'); assert.equal(originUrl.hostname, '127.0.0.1');
      assert(originUrl.port && !originUrl.username && !originUrl.password && !originUrl.search && !originUrl.hash);
      assert.equal(originUrl.pathname, '/');
      const origin = originUrl.origin, ids = sandbox.ids;
      ownership.origins.push(origin);
      await writeFile(path.join(folder, 'ownership.json'), JSON.stringify(ownership, null, 2));
      const base = `/api/local/centers/${ids.centerId}/conversations/${ids.conversationId}`;
      const result = { width, draftRetry: false, structuredRecord: false, explicitPreview: false, sharedView: false,
        guardianFeedback: false, quotedReply: false, publicationReply: false, privateReview: false, savedReference: false,
        nextStructuredRecord: false, nextExplicitPreview: false, nextSharedView: false, nextShareIsolation: false,
        pinnedFeedbackVersion: false, currentFeedbackReference: false, referenceDraftPreserved: false, archivedReferenceReadable: false,
        internalEditIsolation: false, staleConflict: false, polledRejectionDraft: false,
        reshare: false, withdrawal: false, reload: false, permissions: false, layout: false, cleanup: false };
      report.currentCheck = result;
      const operations = [], fault = { loseRecordSave: false, committedLosses: 0, failed: false,
        holdFeedback: false, feedbackGate: null, onFeedbackHeld: null,
        holdRecordConflict: false, recordConflictGate: null, onRecordConflictHeld: null, heldRecordStatus: null };
      const observe = (page, role) => {
        page.setDefaultTimeout(15_000);
        page.on('pageerror', () => report.errors.push({ width, role, phase, type: 'pageerror' }));
        page.on('console', (message) => {
          if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:'))
            report.errors.push({ width, role, phase, type: 'console' });
        });
      };
      const actor = async (role) => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR',
          isMobile: width <= 640, hasTouch: width <= 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context);
        await context.route('**/*', async (route) => {
          const request = route.request(), url = new URL(request.url());
          const staticFile = ['/', '/favicon.ico', '/local-api/client.js', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/care-ui.js', '/local-api/care-client.js', '/local-api/workspace-ui.js', '/local-api/styles.css', '/local-api/media-client.js', '/local-api/media-ui.js', '/local-api/media-viewer.js', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js'].includes(url.pathname) && ['GET', 'HEAD'].includes(request.method());
          const primaryRead = request.method() === 'GET' && url.pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
            [...url.searchParams].length === 1 && url.searchParams.get('conversationId') === ids.conversationId;
          const api = /^\/api\/local\/(?:auth\/(?:login|session|logout)|centers\/[A-Za-z0-9_-]+\/(?:inbox|conversations\/[A-Za-z0-9_-]+\/(?:profile|messages(?:\/[A-Za-z0-9_-]+)?|read|goals|appointments(?:\/[A-Za-z0-9_-]+)?|records(?:\/[A-Za-z0-9_-]+(?:\/(?:preview|publish))?)?|feedback\/[A-Za-z0-9_-]+(?:\/review)?|publications\/[A-Za-z0-9_-]+\/withdraw)))$/.test(url.pathname);
          if (url.origin !== origin || !['GET', 'POST', 'HEAD'].includes(request.method()) || !(staticFile || api || primaryRead)) {
            report.unexpectedRequests.push({ width, role, phase, sameOrigin: url.origin === origin, method: request.method() });
            return route.abort().catch(() => {});
          }
          if (request.method() === 'POST' && url.pathname.startsWith(base)) {
            const body = request.postDataJSON(); operations.push({ role, pathname: url.pathname, body });
            if (fault.holdRecordConflict && /^\/records\/[A-Za-z0-9_-]+$/.test(url.pathname.slice(base.length))) {
              fault.holdRecordConflict = false;
              // Obtain a real first-attempt rejection, then delay delivery just
              // long enough for normal workspace polling to hide the form.
              // Do not synthesize an error or alter the rejected request.
              const response = await route.fetch({ maxRedirects: 0 });
              fault.heldRecordStatus = response.status(); fault.onRecordConflictHeld();
              try { await fault.recordConflictGate; await route.fulfill({ response }); }
              finally { await response.dispose(); }
              return;
            }
            if (role === 'guardian' && fault.holdFeedback && /^\/feedback\/[A-Za-z0-9_-]+$/.test(url.pathname.slice(base.length))) {
              fault.holdFeedback = false; fault.onFeedbackHeld();
              await fault.feedbackGate;
              return route.continue().catch(() => {});
            }
            if (fault.loseRecordSave && /^\/records\/[A-Za-z0-9_-]+$/.test(url.pathname.slice(base.length))) {
              fault.loseRecordSave = false;
              try {
                const response = await route.fetch({ maxRedirects: 0 });
                if (response.status() === 201) fault.committedLosses++; else fault.failed = true;
                await response.dispose(); await route.abort('failed').catch(() => {});
              } catch { fault.failed = true; await route.abort('failed').catch(() => {}); }
              return;
            }
          }
          return route.continue().catch(() => {});
        });
        const page = await context.newPage(); observe(page, role);
        await page.goto(origin); await page.getByTestId('login-form').waitFor();
        const credential = sandbox.credentials.find((item) => item.role === role);
        assert(credential?.email.endsWith('.test'), 'LOCAL_CARE_SYNTHETIC_CREDENTIAL');
        await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click();
        await page.getByTestId('home').waitFor();
        return { context, page, role };
      };
      const therapist = await actor('therapist'), guardian = await actor('guardian');
      const actors = [therapist, guardian];
      const dialog = (who) => who.page.getByTestId('care-dialog');
      const button = (who, action, id = null, idKey = 'record-id') => ({ click: async () => {
        if (['new-record', 'edit-record', 'preview-record'].includes(action)) await workspaceRecords(who.page, ids.conversationId);
        else await room(who);
        await who.page.locator(`[data-care-action="${action}"]${id ? `[data-${idKey}="${id}"]` : ''}`).click();
      } });
      const field = (who, name) => dialog(who).locator(`[name="${name}"]`);
      const reference = (who, messageId) => dialog(who).locator(`blockquote.care-reference[data-reference-message-id="${messageId}"]`);
      // Snapshot only in memory; the report never serializes authored inputs.
      const recordInput = (who) => dialog(who).locator('form').evaluate((form) => [...form.elements]
        .filter((node) => node.name && !['submit', 'button'].includes(node.type))
        .map((node) => ({ name: node.name, type: node.type, value: node.value,
          ...(node.type === 'checkbox' ? { checked: node.checked } : {}) })));
      const fill = async (who, name, value) => { step = `FILL:${name}`; const input = field(who, name); await reveal(input); await input.fill(String(value)); };
      const select = async (who, name, value) => { const input = field(who, name); await reveal(input); await input.selectOption(value); };
      const addAssessments = async (who, assessments) => {
        assert.equal(await field(who, 'assessment-0-tool').count(), 0, 'LOCAL_CARE_NEW_ASSESSMENTS_REQUIRED');
        for (const [index, assessment] of assessments.entries()) {
          const add = dialog(who).locator('[data-care-action="add-assessment"]');
          step = `ADD_ASSESSMENT:${index}`;
          await reveal(add); await add.click();
          for (const [key, value] of Object.entries(assessment)) await fill(who, `assessment-${index}-${key}`, value);
        }
      };
      const refresh = async (who) => { await workspaceAccountAction(who.page, 'refresh'); };
      const room = async (who) => workspaceRoom(who.page, ids.conversationId, { keyboard: width === 320 });
      const cancelInput = async (who) => {
        const accept = (prompt) => prompt.accept(); who.page.on('dialog', accept);
        try { await dialog(who).getByRole('button', { name: '입력 취소', exact: true }).click(); await dialog(who).waitFor({ state: 'hidden' }); await room(who); }
        finally { who.page.off('dialog', accept); }
      };
      const submit = async (who, name) => {
        step = `SUBMIT:${name}`;
        await dialog(who).getByRole('button', { name, exact: true }).click();
        await dialog(who).waitFor({ state: 'hidden' });
        await room(who);
      };
      const api = (who, suffix, body) => who.page.evaluate(async ({ pathname, expectedAccount, body }) => {
        const response = await fetch(pathname, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'X-Carebridge-Account': expectedAccount, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Carebridge-Request': '1' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, value: response.status === 204 ? null : await response.json() };
      }, { pathname: `${base}${suffix}`, expectedAccount: ids[`${who.role}Id`], body });
      const record = async (id) => { const response = await api(therapist, `/records/${id}`); assert.equal(response.status, 200); return response.value.record; };
      const messages = async (who) => { const response = await api(who, '/messages?limit=100'); assert.equal(response.status, 200); return response.value.messages; };
      const publication = (who, id) => who.page.locator(`[data-publication-id="${id}"]`);
      const checkNoPrivate = async () => {
        const text = JSON.stringify(await messages(guardian));
        for (const value of privateValues) assert(!text.includes(value), 'LOCAL_CARE_PUBLIC_RESPONSE_PRIVATE_LEAK');
        const body = await guardian.page.locator('body').innerText();
        for (const value of privateValues) assert(!body.includes(value), 'LOCAL_CARE_PUBLIC_DOM_PRIVATE_LEAK');
      };
      const capture = async (who, label) => {
        assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'LOCAL_CARE_PAGE_OVERFLOW');
        if (await dialog(who).isVisible()) assert.equal(await dialog(who).evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, 'LOCAL_CARE_DIALOG_OVERFLOW');
        const filename = `${width}-${label}.png`;
        await who.page.screenshot({ path: path.join(folder, filename), fullPage: true,
          mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]')] });
        report.screenshots.push({ width, label, filename, syntheticOnly: true });
      };
      const title = `가상 세션 ${width}`, draftTitle = `가상 임시기록 ${width}`, nextTitle = `가상 다음기록 ${width}`;
      const performed = `가상 내부 수행 ${width}`, response = `가상 내부 반응 ${width}`, nextPlan = `가상 내부 다음계획 ${width}`;
      const privateNote = `가상 비공개 기록 메모 ${width}`, reviewNote = `가상 비공개 검토 메모 ${width}`;
      const summary = `가상 보호자 요약 첫 버전 ${width}`, updatedSummary = `가상 보호자 요약 내부 수정 ${width}`;
      const f1 = `가상 보호자 반응 첫 버전 ${width}`, f2 = `가상 보호자 반응 수정본 ${width}`, replyText = `가상 공개 답장 ${width}`;
      const nextContent = { performed: `가상 다음 회기 직접 관찰 활동 ${width}`, response: `가상 다음 회기 직접 관찰 반응 ${width}`,
        nextPlan: `가상 다음 회기 치료사 계획 ${width}`, privateNote: `가상 다음 회기 내부 메모 ${width}`,
        summary: `가상 다음 회기 공유 요약 ${width}` };
      const nextAssessments = [
        { tool: '가상 다음 관찰 A', item: '가상 다음 참여 시간', value: '4', unit: '분', context: '가상 다음 회기 동일 놀이 조건' },
        { tool: '가상 다음 관찰 B', item: '가상 다음 도움 횟수', value: '0', unit: '회', context: '가상 다음 회기 동일 놀이 조건' },
      ];
      const privateValues = [privateNote, reviewNote, performed, response, nextPlan,
        nextContent.performed, nextContent.response, nextContent.nextPlan, nextContent.privateNote,
        ...nextAssessments.flatMap(({ tool, item, context }) => [tool, item, context])];
      await room(therapist); await room(guardian);

      phase = `${width}:DRAFT_COMMIT_RESPONSE_LOSS`;
      await button(therapist, 'new-record').click(); await dialog(therapist).waitFor();
      await fill(therapist, 'title', draftTitle); await select(therapist, 'goalId', ids.goalId);
      fault.loseRecordSave = true;
      await dialog(therapist).getByRole('button', { name: '임시저장', exact: true }).click();
      await dialog(therapist).getByRole('button', { name: '같은 요청 다시 확인', exact: true }).waitFor();
      assert.equal(fault.failed, false); assert.equal(fault.committedLosses, 1);
      if (await field(therapist, 'title').count()) {
        assert.equal(await field(therapist, 'title').inputValue(), draftTitle);
        assert.equal(await field(therapist, 'title').isDisabled(), true);
      } else {
        await dialog(therapist).getByRole('heading', { name: '이전 요청 처리 확인', exact: true }).waitFor();
        assert(!(await dialog(therapist).innerText()).includes(draftTitle));
      }
      const firstSave = operations.find((op) => op.body.content?.title === draftTitle);
      const recordId = firstSave.pathname.split('/').at(-1);
      const { rows: beforeRetry } = await sandbox.database.query('SELECT current_revision FROM cb_records WHERE center_id=$1 AND conversation_id=$2 AND id=$3', [ids.centerId, ids.conversationId, recordId]);
      assert.equal(beforeRetry[0].current_revision, 1);
      await submit(therapist, '같은 요청 다시 확인');
      const saveAttempts = operations.filter((op) => op.body.content?.title === draftTitle);
      assert.equal(saveAttempts.length, 2); assert.deepEqual(saveAttempts[0].body, saveAttempts[1].body);
      assert.equal((await record(recordId)).revision, 1); assert.equal((await record(recordId)).status, 'draft');
      result.draftRetry = true;

      phase = `${width}:STRUCTURED_RECORD`;
      step = 'OPEN_SAVED_DRAFT';
      await button(therapist, 'edit-record', recordId).click(); await dialog(therapist).waitFor();
      for (const [name, value] of Object.entries({ title, performed, response, nextPlan, summary, privateNote,
        activityTitle: '가상 집에서 놀이', activityInstruction: '가상 두 활동 중 하나를 골라요.', activityFrequency: '가상 하루 한 번', activityCaution: '가상 피곤하면 쉬어요.' })) await fill(therapist, name, value);
      await addAssessments(therapist, [
        { tool: '가상 도구 A', item: '가상 참여', value: '3', unit: '분', context: '가상 동일 조건' },
        { tool: '가상 도구 B', item: '가상 도움', value: '0', unit: '회', context: '가상 동일 조건' },
      ]);
      await capture(therapist, 'structured-record'); await submit(therapist, '기록 저장');
      const saved = await record(recordId);
      assert.equal(saved.revision, 2); assert.equal(saved.status, 'saved');
      for (const [key, value] of Object.entries({ performed, response, nextPlan, summary, privateNote })) assert.equal(saved[key], value);
      assert.deepEqual(saved.assessments.map((item) => Number(item.value)), [3, 0]); assert.equal(saved.activity.title, '가상 집에서 놀이');
      result.structuredRecord = true;

      phase = `${width}:EXPLICIT_PREVIEW_AND_SHARE`;
      await button(therapist, 'preview-record', recordId).click(); await dialog(therapist).waitFor();
      const preview = (await api(therapist, `/records/${recordId}/preview`)).value.preview;
      assert.deepEqual(preview.recipientIds, [ids.guardianId]); assert.equal(preview.recordRevision, 2);
      for (const value of [privateNote, performed, response, nextPlan]) {
        assert(!JSON.stringify(preview).includes(value)); assert(!(await dialog(therapist).innerText()).includes(value));
      }
      assert((await dialog(therapist).innerText()).includes(summary));
      await field(therapist, 'confirmed').check(); await capture(therapist, 'public-preview');
      await submit(therapist, '확인하고 공유'); result.explicitPreview = true;
      await refresh(guardian);
      const firstPublication = (await messages(guardian)).find((item) => item.type === 'publication');
      assert(firstPublication?.publication?.id); const publicationId = firstPublication.publication.id;
      await publication(guardian, publicationId).waitFor();
      assert((await publication(guardian, publicationId).innerText()).includes(summary));
      await checkNoPrivate(); result.sharedView = true;

      phase = `${width}:PUBLICATION_QUOTED_REPLY`;
      const publicationReplyText = `가상 공유 기록 답장 ${width}`;
      await publication(guardian, publicationId).locator('[data-care-action="reply"]').click();
      await dialog(guardian).waitFor(); await fill(guardian, 'body', publicationReplyText);
      await submit(guardian, '답장 보내기');
      const publicationReply = (await messages(guardian)).find((item) => item.body === publicationReplyText);
      assert.equal(publicationReply?.quote?.id, firstPublication.id);
      assert.equal(publicationReply.quote.body, title);
      await refresh(therapist);
      const publicationReplyRow = therapist.page.getByTestId('message-row').filter({ hasText: publicationReplyText });
      await publicationReplyRow.waitFor();
      assert.equal(await publicationReplyRow.locator('.message-quote').innerText(), title);

      phase = `${width}:GUARDIAN_FEEDBACK`;
      await publication(guardian, publicationId).locator('[data-care-action="feedback"]').click(); await dialog(guardian).waitFor();
      await select(guardian, 'result', 'partial'); await fill(guardian, 'reaction', f1); await fill(guardian, 'difficulty', '가상 집중이 잠시 어려웠어요.');
      await submit(guardian, '활동 경험 저장');
      const feedback = (await messages(guardian)).find((item) => item.type === 'feedback' && item.body === f1);
      assert(feedback?.feedback?.id); result.guardianFeedback = true;
      await refresh(therapist);

      phase = `${width}:PUBLIC_REPLY_PRIVATE_REVIEW`;
      await button(therapist, 'reply', feedback.id, 'message-id').click(); await fill(therapist, 'body', replyText);
      await submit(therapist, '답장 보내기');
      const publicReply = (await messages(therapist)).find((item) => item.body === replyText);
      assert.equal(publicReply.quote.feedbackRevision, 1); assert.equal(publicReply.quote.body, f1); result.quotedReply = true;
      await therapist.page.getByTestId('message-row').filter({ hasText: replyText }).waitFor();
      await button(therapist, 'review', feedback.id, 'message-id').click(); await fill(therapist, 'note', reviewNote); await submit(therapist, '임상 검토 저장');
      const review = await api(therapist, `/feedback/${feedback.feedback.id}/review`);
      assert.equal(review.value.review.note, reviewNote); await refresh(guardian); await checkNoPrivate(); result.privateReview = true;

      phase = `${width}:SAVE_PINNED_REFERENCE`;
      await button(therapist, 'reference', feedback.id, 'message-id').click();
      for (const [name, value] of Object.entries({ title: nextTitle, ...nextContent })) await fill(therapist, name, value);
      await select(therapist, 'goalId', ids.goalId); await addAssessments(therapist, nextAssessments);
      await reveal(reference(therapist, feedback.id));
      assert.equal(await reference(therapist, feedback.id).locator('[data-reference-quote]').innerText(), f1);
      await capture(therapist, 'next-record-with-feedback-reference'); await submit(therapist, '기록 저장');
      const nextSave = operations.find((op) => op.body.content?.title === nextTitle), nextId = nextSave.pathname.split('/').at(-1);
      const next = await record(nextId);
      assert.deepEqual(next.referenceMessageIds, [feedback.id]);
      assert.equal(next.referenceSources[0].feedbackRevision, 1); result.savedReference = true;
      for (const [name, value] of Object.entries(nextContent)) assert.equal(next[name], value, 'LOCAL_CARE_NEXT_RECORD_VALUE');
      assert.deepEqual(next.assessments.map(({ tool, item, value, unit, context }) => ({ tool, item, value: String(value), unit, context })), nextAssessments);
      assert.equal(next.revision, 1); assert.equal(next.status, 'saved'); result.nextStructuredRecord = true;

      phase = `${width}:NEXT_RECORD_PREVIEW_AND_SHARE`;
      await button(therapist, 'preview-record', nextId).click(); await dialog(therapist).waitFor();
      const nextPreview = (await api(therapist, `/records/${nextId}/preview`)).value.preview;
      assert.equal(nextPreview.recordId, nextId); assert.equal(nextPreview.recordRevision, next.revision);
      assert.deepEqual(nextPreview.recipientIds, [ids.guardianId]); assert.equal(nextPreview.summary, nextContent.summary);
      const recipientPanel = dialog(therapist).locator('[data-share-recipients]');
      assert.equal(await recipientPanel.locator('li').count(), 1);
      assert((await recipientPanel.innerText()).includes('가상 보호자'), 'LOCAL_CARE_NEXT_RECIPIENT_VISIBLE');
      const previewText = await dialog(therapist).innerText();
      assert(previewText.includes(nextContent.summary));
      for (const value of [...privateValues, f1]) {
        assert(!JSON.stringify(nextPreview).includes(value), 'LOCAL_CARE_NEXT_PREVIEW_PRIVATE_LEAK');
        assert(!previewText.includes(value), 'LOCAL_CARE_NEXT_PREVIEW_DOM_PRIVATE_LEAK');
      }
      await field(therapist, 'confirmed').check(); await capture(therapist, 'next-record-public-preview');
      result.nextExplicitPreview = true; await submit(therapist, '확인하고 공유');
      await refresh(guardian);
      const nextPublication = (await messages(guardian)).find((item) => item.type === 'publication' && item.publication?.recordId === nextId && !item.archived);
      assert(nextPublication?.publication?.id, 'LOCAL_CARE_NEXT_PUBLICATION_REQUIRED');
      assert.equal(nextPublication.publication.summary, nextContent.summary);
      await publication(guardian, nextPublication.publication.id).waitFor();
      assert((await publication(guardian, nextPublication.publication.id).innerText()).includes(nextContent.summary));
      assert.equal((await messages(guardian)).filter((item) => item.type === 'publication' && item.publication?.recordId === nextId).length, 1);
      await checkNoPrivate(); await capture(guardian, 'next-record-received'); result.nextSharedView = true;

      phase = `${width}:FEEDBACK_REVISION_PRESERVED`;
      await button(guardian, 'edit-feedback', feedback.id, 'message-id').click(); await fill(guardian, 'reaction', f2); await submit(guardian, '활동 경험 저장');
      await refresh(therapist);
      const latestFeedback = (await messages(therapist)).find((item) => item.id === feedback.id);
      assert.equal(latestFeedback.feedback.revision, 2);
      const oldQuote = (await messages(therapist)).find((item) => item.id === publicReply.id).quote;
      assert.equal(oldQuote.feedbackRevision, 1); assert.equal(oldQuote.body, f1);
      const quotedBody = therapist.page.getByTestId('message-row').filter({ hasText: replyText }).locator('.message-quote').filter({ hasText: f1 });
      await quotedBody.waitFor(); assert.equal(await quotedBody.innerText(), f1);
      assert.equal((await record(nextId)).referenceSources[0].feedbackRevision, 1);
      await button(therapist, 'edit-record', nextId).click();
      // Opening the saved record also reads its pinned feedback revision.
      // A click completing is not evidence that those HTTP reads finished.
      await dialog(therapist).waitFor();
      await reveal(reference(therapist, feedback.id));
      assert((await dialog(therapist).innerText()).includes(f1)); assert(!(await dialog(therapist).innerText()).includes(f2));
      phase = `${width}:CURRENT_FEEDBACK_REFERENCE`;
      const savedReferenceBefore = await record(nextId);
      await fill(therapist, 'performed', '가상 원문 확인 중에도 보존할 미저장 활동');
      await fill(therapist, 'privateNote', '가상 원문 확인 중에도 보존할 비공개 초안');
      const authoredBefore = await recordInput(therapist);
      const inputNode = await field(therapist, 'performed').elementHandle();
      const writesBeforeReference = operations.filter((op) => op.role === 'therapist').length;
      const note = reference(therapist, feedback.id), currentSource = note.locator('[data-reference-source]');
      assert.equal(await note.locator('[data-reference-quote]').innerText(), f1);
      await note.getByRole('button', { name: '현재 원문 보기', exact: true }).click();
      await currentSource.getByText(f2, { exact: true }).waitFor();
      assert((await currentSource.innerText()).includes('현재 활동 경험 2번째 내용'));
      for (const value of [latestFeedback.feedback.date, '일부 했어요', latestFeedback.feedback.difficulty])
        assert((await currentSource.innerText()).includes(value), 'LOCAL_CARE_CURRENT_FEEDBACK_DETAILS');
      assert.equal(await note.locator('[data-reference-quote]').innerText(), f1);
      assert.deepEqual(await recordInput(therapist), authoredBefore, 'LOCAL_CARE_CURRENT_REFERENCE_INPUT_UNCHANGED');
      assert.equal(await inputNode.evaluate((node) => node.isConnected), true, 'LOCAL_CARE_CURRENT_REFERENCE_INPUT_NOT_REPLACED');
      assert.deepEqual(await record(nextId), savedReferenceBefore, 'LOCAL_CARE_CURRENT_REFERENCE_RECORD_UNCHANGED');
      assert.equal(operations.filter((op) => op.role === 'therapist').length, writesBeforeReference, 'LOCAL_CARE_REFERENCE_READ_HAS_NO_POST');
      await capture(therapist, 'current-f2-and-pinned-f1-reference');
      await note.getByRole('button', { name: '현재 원문 닫기', exact: true }).click();
      await currentSource.waitFor({ state: 'hidden' });
      assert.deepEqual(await recordInput(therapist), authoredBefore);
      result.currentFeedbackReference = true;
      // Closing the source and editor is not a save or discard. Explicitly
      // resume the same record draft before the existing test discards it.
      await dialog(therapist).getByRole('button', { name: '닫기', exact: true }).click();
      await dialog(therapist).waitFor({ state: 'hidden' });
      await therapist.page.locator('[data-care-action="resume"]').click(); await dialog(therapist).waitFor();
      assert.deepEqual(await recordInput(therapist), authoredBefore, 'LOCAL_CARE_REFERENCE_RESUME_INPUT_UNCHANGED');
      await reveal(reference(therapist, feedback.id));
      assert.equal(await reference(therapist, feedback.id).locator('[data-reference-quote]').innerText(), f1);
      assert.deepEqual(await record(nextId), savedReferenceBefore);
      await inputNode.dispose(); result.referenceDraftPreserved = true;
      await cancelInput(therapist); result.pinnedFeedbackVersion = true;

      phase = `${width}:INTERNAL_EDIT_ISOLATION`;
      await button(therapist, 'edit-record', recordId).click(); await fill(therapist, 'summary', updatedSummary); await submit(therapist, '기록 저장');
      await refresh(guardian); await publication(guardian, publicationId).waitFor();
      assert((await publication(guardian, publicationId).innerText()).includes(summary));
      assert(!(await publication(guardian, publicationId).innerText()).includes(updatedSummary)); result.internalEditIsolation = true;

      phase = `${width}:STALE_RECORD_CONFLICT`;
      await button(therapist, 'edit-record', recordId).click(); await fill(therapist, 'summary', '가상 아직 저장되지 않은 충돌 입력');
      const otherPage = await therapist.context.newPage(); observe(otherPage, 'therapist-other-tab');
      const other = { page: otherPage, context: therapist.context, role: 'therapist' };
      let releaseRecordConflict;
      try {
        await otherPage.goto(origin); await otherPage.getByTestId('home').waitFor(); await room(other);
        await button(other, 'edit-record', recordId).click(); await fill(other, 'summary', '가상 다른 탭에서 확정한 요약'); await submit(other, '기록 저장');
        const storedBeforeRejection = await record(recordId);
        const held = new Promise((resolve) => { fault.onRecordConflictHeld = resolve; });
        fault.recordConflictGate = new Promise((resolve) => { releaseRecordConflict = resolve; });
        fault.holdRecordConflict = true;
        await dialog(therapist).getByRole('button', { name: '기록 저장', exact: true }).click();
        await bounded(held, 5000);
        assert.equal(fault.heldRecordStatus, 409, 'LOCAL_CARE_FIRST_REJECTION_REQUIRED');
        await dialog(therapist).getByRole('heading', { name: '이전 요청 처리 확인', exact: true }).waitFor();
        assert.equal(await field(therapist, 'summary').count(), 0, 'LOCAL_CARE_PENDING_FORM_HIDDEN');
        await Promise.all([
          therapist.page.waitForResponse((res) => res.url() === `${origin}${base}/records/${recordId}` && res.request().method() === 'POST' && res.status() === 409),
          Promise.resolve().then(() => releaseRecordConflict()),
        ]);
        await field(therapist, 'summary').waitFor({ state: 'attached' });
        assert.equal(await field(therapist, 'summary').inputValue(), '가상 아직 저장되지 않은 충돌 입력');
        assert.equal(await field(therapist, 'summary').isDisabled(), false);
        for (const [name, value] of Object.entries({ performed, response, nextPlan, privateNote }))
          assert.equal(await field(therapist, name).inputValue(), value, 'LOCAL_CARE_REJECTED_INPUT_PRESERVED');
        assert.deepEqual(await record(recordId), storedBeforeRejection, 'LOCAL_CARE_REJECTED_RECORD_UNCHANGED');
        result.polledRejectionDraft = true;
        await cancelInput(therapist);
      } catch (error) {
        report.staleConflictFailureSurfaces = {
          therapist: await workspaceFailureSurface(therapist.page),
          peer: await workspaceFailureSurface(otherPage),
        };
        throw error;
      } finally { releaseRecordConflict?.(); await otherPage.close(); }
      result.staleConflict = true; await refresh(therapist);

      phase = `${width}:RESHARE`;
      await button(therapist, 'preview-record', recordId).click(); await field(therapist, 'confirmed').check(); await submit(therapist, '확인하고 공유');
      await refresh(guardian);
      const reshared = (await messages(guardian)).find((item) => item.type === 'publication' && !item.archived && item.publication?.recordId === recordId);
      assert(reshared && reshared.publication.id !== publicationId);
      await publication(guardian, reshared.publication.id).waitFor();
      const oldPublic = (await messages(guardian)).find((item) => item.id === firstPublication.id);
      assert.equal(oldPublic.hidden, true); assert.equal(oldPublic.body, '공유가 종료된 기록입니다.'); assert.equal(oldPublic.publication, undefined);
      const closedPublicationReply = (await messages(guardian)).find((item) => item.id === publicationReply.id);
      assert.equal(closedPublicationReply.body, publicationReplyText);
      assert.equal(closedPublicationReply.quote.hidden, true);
      assert.equal(closedPublicationReply.quote.body, '공유가 종료된 기록입니다.');
      const closedPublicationReplyRow = guardian.page.getByTestId('message-row').filter({ hasText: publicationReplyText });
      await closedPublicationReplyRow.waitFor();
      assert.equal(await closedPublicationReplyRow.locator('.message-quote').innerText(), '공유가 종료된 기록입니다.');
      result.publicationReply = true;
      const afterReshareText = await guardian.page.locator('body').innerText();
      assert(!afterReshareText.includes(summary)); assert(!afterReshareText.includes(f1));
      assert.equal((await record(nextId)).referenceSources[0].feedbackRevision, 1); result.reshare = true;

      phase = `${width}:ARCHIVED_CURRENT_REFERENCE_REMAINS_READABLE`;
      // Ending guardian sharing does not remove a therapist's existing clinical
      // read authority. Do not confuse archived/cannot-reply with read denial.
      const archivedFeedback = (await messages(therapist)).find((item) => item.id === feedback.id);
      assert.equal(archivedFeedback.archived, true); assert.equal(archivedFeedback.hidden, false);
      const savedArchivedReference = await record(nextId);
      await button(therapist, 'edit-record', nextId).click(); await dialog(therapist).waitFor();
      const archivedNote = reference(therapist, feedback.id), archivedPanel = archivedNote.locator('[data-reference-source]');
      await reveal(archivedNote);
      await archivedNote.getByRole('button', { name: '현재 원문 보기', exact: true }).click();
      await archivedPanel.getByText(f2, { exact: true }).waitFor();
      assert((await archivedPanel.innerText()).includes('공유가 종료된 소식입니다. 현재 치료사 열람 권한으로 확인한 내용입니다.'));
      assert.equal(await archivedNote.locator('[data-reference-quote]').innerText(), f1);
      assert.deepEqual(await record(nextId), savedArchivedReference);
      await cancelInput(therapist); result.archivedReferenceReadable = true;

      phase = `${width}:WITHDRAW_STALE_FEEDBACK`;
      await publication(guardian, reshared.publication.id).locator('[data-care-action="feedback"]').click();
      await fill(guardian, 'reaction', '가상 철회 직전 작성 중인 내용'); await select(guardian, 'result', 'partial');
      // The refreshed UI now closes drafts whose source lost read authority.
      // Exercise a genuinely in-flight write instead of relying on a stale
      // form remaining open after withdrawal: hold this request before HTTP,
      // withdraw through the therapist UI, then let the server reject it.
      let releaseFeedback;
      fault.feedbackGate = new Promise((resolve) => { releaseFeedback = resolve; });
      const feedbackHeld = new Promise((resolve) => { fault.onFeedbackHeld = resolve; });
      fault.holdFeedback = true;
      try {
        await dialog(guardian).getByRole('button', { name: '활동 경험 저장', exact: true }).click();
        await bounded(feedbackHeld, 15_000);
        await button(therapist, 'withdraw', reshared.id, 'message-id').click(); await submit(therapist, '공유 종료 확인');
        await Promise.all([
          guardian.page.waitForResponse((res) => res.url().startsWith(`${origin}${base}/feedback/`) && res.request().method() === 'POST' && res.status() === 409),
          Promise.resolve().then(() => releaseFeedback()),
        ]);
        // Unlike a still-authorized conflict, this source is now unreadable to
        // the guardian. Wait for normal permission polling to close and clear
        // the form; a check-then-cancel click races with that required closure.
        await dialog(guardian).waitFor({ state: 'hidden' });
        assert.equal(await dialog(guardian).evaluate((node) => node.open), false, 'LOCAL_CARE_WITHDRAWN_FEEDBACK_CLOSED');
        assert.equal(await field(guardian, 'reaction').count(), 0, 'LOCAL_CARE_WITHDRAWN_FEEDBACK_INPUT_CLEARED');
        assert(!(await guardian.page.locator('body').textContent()).includes('가상 철회 직전 작성 중인 내용'), 'LOCAL_CARE_WITHDRAWN_FEEDBACK_DOM_CLEARED');
      } finally { releaseFeedback(); fault.holdFeedback = false; }
      await refresh(guardian); await refresh(therapist);
      const guardianMessages = await messages(guardian);
      assert.equal(guardianMessages.find((item) => item.id === reshared.id).hidden, true);
      assert.equal(guardianMessages.find((item) => item.id === publicReply.id).body, replyText);
      await guardian.page.getByTestId('message-row').filter({ hasText: replyText }).waitFor();
      assert.equal((await record(nextId)).referenceSources[0].feedbackRevision, 1);
      const { rows: rejectedFeedback } = await sandbox.database.query('SELECT count(*)::integer AS count FROM cb_feedback_revisions WHERE reaction=$1', ['가상 철회 직전 작성 중인 내용']);
      assert.equal(rejectedFeedback[0].count, 0); result.withdrawal = true;

      phase = `${width}:RELOAD_PERMISSIONS_LAYOUT`;
      for (const who of actors) {
        await who.page.reload(); await who.page.getByTestId('home').waitFor(); await room(who);
        assert.deepEqual(await who.page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
        await capture(who, `${who.role}-final`);
      }
      assert.equal((await record(nextId)).referenceSources[0].feedbackRevision, 1); await checkNoPrivate();
      const preservedNextPublication = (await messages(guardian)).find((item) => item.id === nextPublication.id);
      assert.equal(preservedNextPublication.hidden, false); assert.equal(preservedNextPublication.archived, false);
      assert.deepEqual(preservedNextPublication.publication, nextPublication.publication, 'LOCAL_CARE_OTHER_RECORD_SHARE_UNCHANGED');
      await publication(guardian, nextPublication.publication.id).waitFor();
      assert((await publication(guardian, nextPublication.publication.id).innerText()).includes(nextContent.summary));
      assert.deepEqual(await record(nextId), next, 'LOCAL_CARE_REFERENCED_RECORD_PRESERVED'); result.nextShareIsolation = true;
      assert.equal((await api(guardian, `/records/${recordId}`)).status, 404);
      assert.equal((await api(guardian, `/feedback/${feedback.feedback.id}/review`)).status, 404);
      result.reload = result.permissions = result.layout = true;
      assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedRequests, []);
      for (const who of actors) { await who.context.close(); contexts.delete(who.context); }
      await sandbox.close(); assert.equal(sandbox.database.closed, true); assert.equal(sandbox.credentials.length, 0);
      sandboxes.delete(sandbox); result.cleanup = true; report.checks.push(result);
      const boundaryResults = Object.entries(result).filter(([key, value]) => key !== 'cleanup' && typeof value === 'boolean');
      assert(boundaryResults.every(([, value]) => value === true), 'LOCAL_CARE_BOUNDARY_INCOMPLETE');
      console.log(JSON.stringify({ width, passed: true, completedBoundaries: boundaryResults.length }));
    }
    report.finalSource = await sourceManifest(); assert.equal(report.finalSource.sha256, source.sha256, 'LOCAL_CARE_SOURCE_CHANGED');
  } catch (error) {
    const assertion = error?.message?.split('\n')[0];
    report.failure = { code: 'LOCAL_CARE_BROWSER_FAILED', phase, step,
      kind: ['TimeoutError', 'AssertionError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-care-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      workspaceHelperLine: Number(error?.stack?.match(/local-workspace-browser-helpers\.mjs:(\d+):\d+/)?.[1]) || null,
      workspaceDiagnostics: error?.workspaceDiagnostics ?? null,
      assertion: /^LOCAL_(?:CARE|WORKSPACE)_[A-Z_]+$/.test(assertion ?? '') ? assertion : null };
    report.failureSurfaces = [];
    for (const context of contexts) for (const page of context.pages()) {
      try {
        const index = report.failureSurfaces.length;
        const state = await page.evaluate(() => ({
          dialogOpen: !!document.querySelector('[data-testid="care-dialog"]')?.open,
          recordButtons: document.querySelectorAll('[data-care-action="edit-record"]').length,
          fieldNames: [...(document.querySelector('[data-testid="care-dialog"]')?.querySelectorAll('[name]') ?? [])].map((node) => node.name),
          statusPresent: !!document.querySelector('[data-care-status]'),
          formErrorPresent: !!document.querySelector('[data-care-error]')?.textContent,
        }));
        const filename = `failure-surface-${index}.png`;
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
  try { if (!await runLocalCareBrowser()) process.exitCode = 1; }
  catch { console.error('LOCAL_CARE_BROWSER_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

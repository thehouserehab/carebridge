// R05: real UI -> authenticated loopback HTTP -> owned memory-only PGlite.
// No user tabs, E/native storage, uploads, approval doubles or clinical fixtures.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceRecords } from './local-workspace-browser-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const code = 'LOCAL_RECORD_TEMPLATE_FAILED';
const assets = new Set(['/', '/favicon.ico', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/client.js', '/local-api/care-client.js',
  '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css', '/local-api/media-client.js',
  '/local-api/media-ui.js', '/local-api/media-viewer.js', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js']);
const fieldKeys = ['tool', 'item', 'value', 'unit', 'context'];
const blankFields = ['title', 'performed', 'response', 'nextPlan', 'summary', 'privateNote', 'observationStatus',
  'observationTask', 'observationAssistance', 'observationAmount', 'observationRepetitions', 'observationDuration', 'observationContext',
  'activityTitle', 'activityInstruction', 'activityFrequency', 'activityCaution'];
async function sources() {
  const names = ['tests/local-record-template-browser.mjs', 'tests/local-workspace-browser-helpers.mjs',
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
async function reveal(input) {
  for (const details of await input.locator('xpath=ancestor::details').all())
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
}

export async function runLocalRecordTemplateBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const filename of [options.module, options.executable]) {
    const info = await lstat(filename); assert(info.isFile() && !info.isSymbolicLink(), code);
  }
  const source = await sources(), { chromium } = await import(pathToFileURL(options.module).href);
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-record-template-${runId}`);
  await mkdir(folder);
  const report = { runId, startedAt: new Date().toISOString(), source, passed: false, checks: [], screenshots: [],
    errors: [], unexpectedRequests: [], failure: null, cleanupObservationTimedOut: false,
    cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Synthetic accounts, real authenticated loopback HTTP and memory-only PGlite, not persistent PostgreSQL or E/native media.',
      '320/390/768/1440 Chromium viewports and fresh browser contexts are not physical devices or human usability evidence.',
      'All record writes use the visible UI. Database queries are read-only verification of the same owned sandbox.',
      'No upload is performed: nonempty source attachment exclusion is outside this browser test and belongs to the pure template tests.',
      'A fresh authenticated browser context verifies saved data, not restoration of an unsaved draft after browser termination.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, finished: false };
  const contexts = new Set(), sandboxes = new Set(), pages = new Map();
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  const note = (collection, value) => { if (collection.length < 32) collection.push(value); };
  let browserServer, browser, lifetime, phase = 'STARTUP';
  await save('ownership.json', ownership);
  try {
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    lifetime = processLifetime(browserServer.process()); ownership.browserProcessId = browserServer.process().pid;
    await save('ownership.json', ownership); browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    for (const width of [320, 390, 768, 1440]) {
      phase = `${width}:SANDBOX`; const sandbox = await createLocalApiSandbox({ port: 0 }); sandboxes.add(sandbox);
      const { origin, ids } = sandbox, url = new URL(origin);
      assert(url.origin === origin && url.hostname === '127.0.0.1' && url.protocol === 'http:' && url.port && !url.username && !url.password, code);
      const base = `/api/local/centers/${ids.centerId}/conversations/${ids.conversationId}`;
      const result = { width, sourceCreated: false, existingDraftPreserved: false, templateOnly: false, incompleteBlocked: false,
        draftStored: false, newValuesStored: false, sourceUnchanged: false, freshSession: false, guardianPrivate: false,
        keyboard: false, layout: false, listActions: false, templateHeader: false, cleanup: false };
      report.currentCheck = result;
      const requests = [], guardianPrivate = [];
      const actor = async (role, label = role) => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR',
          isMobile: width <= 640, hasTouch: width <= 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context); context.once('close', () => contexts.delete(context));
        assert.equal((await context.cookies()).length, 0, code);
        await context.route('**/*', async route => {
          const request = route.request(), target = new URL(request.url()), method = request.method();
          const primaryRead = method === 'GET' && target.pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
            [...target.searchParams].length === 1 && target.searchParams.get('conversationId') === ids.conversationId;
          const api = /^\/api\/local\/(?:auth\/(?:login|session|logout)|centers\/[A-Za-z0-9_-]+\/(?:inbox|conversations\/[A-Za-z0-9_-]+\/(?:profile|read|goals|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+)?|records(?:\/[A-Za-z0-9_-]+(?:\/(?:preview|publish))?)?)))$/.test(target.pathname);
          if (target.origin !== origin || !['GET', 'POST', 'HEAD'].includes(method) || !((assets.has(target.pathname) && ['GET', 'HEAD'].includes(method)) || api || primaryRead)) {
            note(report.unexpectedRequests, { width, role, phase, sameOrigin: target.origin === origin,
              method: ['GET', 'POST', 'HEAD'].includes(method) ? method : 'OTHER' }); return route.abort().catch(() => {});
          }
          if (target.pathname.startsWith(base + '/records')) {
            if (role === 'guardian') guardianPrivate.push({ method });
            requests.push({ role, method, pathname: target.pathname, revision: target.searchParams.get('revision'),
              ...(method === 'POST' ? { body: structuredClone(request.postDataJSON()) } : {}) });
          }
          return route.continue().catch(() => {});
        });
        if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => {
          note(report.unexpectedRequests, { width, role, phase, type: 'websocket' }); socket.close();
        });
        const page = await context.newPage(); page.setDefaultTimeout(15_000); pages.set(label, page);
        page.on('pageerror', () => note(report.errors, { width, role, phase, type: 'pageerror' }));
        page.on('console', entry => { if (entry.type() === 'error' && !entry.text().startsWith('Failed to load resource:')) note(report.errors, { width, role, phase, type: 'console' }); });
        const credential = sandbox.credentials.find(item => item.role === role); assert(credential.email.endsWith('.test'), code);
        await page.goto(origin); await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click(); await page.getByTestId('home').waitFor();
        return { page, context, role, userId: ids[role + 'Id'] };
      };
      const therapist = await actor('therapist'), guardian = await actor('guardian');
      const dialog = who => who.page.getByTestId('care-dialog');
      const input = (who, name) => dialog(who).locator(`[name="${name}"]`);
      const fill = async (who, name, value) => { const field = input(who, name); await reveal(field); await field.fill(String(value)); };
      const get = async (who, recordId, revision) => {
        const response = await who.context.request.get(`${origin}${base}/records/${recordId}${revision ? `?revision=${revision}` : ''}`, {
          maxRedirects: 0, timeout: 15_000, headers: { 'X-Carebridge-Account': who.userId } });
        try { assert.equal(response.status(), 200, code); return (await response.json()).record; } finally { await response.dispose(); }
      };
      const dbRecord = async recordId => {
        const params = [ids.centerId, ids.conversationId, recordId];
        const values = {};
        for (const [key, query] of Object.entries({ head: 'SELECT * FROM cb_records WHERE center_id=$1 AND conversation_id=$2 AND id=$3',
          revisions: 'SELECT * FROM cb_record_revisions WHERE center_id=$1 AND conversation_id=$2 AND record_id=$3 ORDER BY revision',
          assessments: 'SELECT * FROM cb_record_assessments WHERE center_id=$1 AND conversation_id=$2 AND record_id=$3 ORDER BY revision,ordinal' }))
          values[key] = (await sandbox.database.query(query, params)).rows;
        return values;
      };
      const capture = async (who, label, { fullPage = true } = {}) => {
        assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code);
        if (await dialog(who).isVisible()) assert.equal(await dialog(who).evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, code);
        const filename = `${width}-${label}.png`;
        await who.page.screenshot({ path: path.join(folder, filename), fullPage,
          mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]'), who.page.locator('.workspace-head .account')] });
        report.screenshots.push({ filename, width, syntheticOnly: true });
      };
      const saveRecord = async (who, draft, implicit = false) => {
        const [response] = await Promise.all([who.page.waitForResponse(response => {
          const target = new URL(response.url()); return target.origin === origin && target.pathname.startsWith(base + '/records/') &&
            !target.pathname.slice((base + '/records/').length).includes('/') && response.request().method() === 'POST' && response.status() === 201;
        }), implicit ? input(who, 'title').press('Enter') :
          dialog(who).getByRole('button', { name: draft ? '임시저장' : '기록 저장', exact: true }).click()]);
        const receipt = (await response.json()).receipt; await dialog(who).waitFor({ state: 'hidden' }); return receipt;
      };
      const rowValues = who => dialog(who).locator('[data-assessment-row]').evaluateAll(rows => rows.map(row =>
        Object.fromEntries([...row.querySelectorAll('[data-assessment-field]')].map(field => [field.dataset.assessmentField, field.value]))));
      const openRecord = async (who, recordId) => {
        await workspaceRecords(who.page, ids.conversationId);
        await who.page.locator(`[data-care-action="edit-record"][data-record-id="${recordId}"]`).click(); await dialog(who).waitFor();
      };
      const reuse = async (recordId, keyboard = false) => {
        await workspaceRecords(therapist.page, ids.conversationId);
        const button = therapist.page.locator(`[data-care-action="reuse-record"][data-record-id="${recordId}"]`);
        await button.waitFor(); assert.equal(await button.textContent(), '양식으로 새 기록', code);
        if (keyboard) { await button.focus(); await button.press('Enter'); } else await button.click();
        await dialog(therapist).waitFor();
      };

      phase = `${width}:SOURCE_UI_SAVE`;
      await therapist.page.bringToFront();
      await therapist.page.getByTestId('home').locator(`[data-appointment-record="${ids.appointmentId}"]`).click(); await dialog(therapist).waitFor();
      phase = `${width}:RECORD_FOOTER_LAYOUT`;
      result.footer = await dialog(therapist).evaluate(element => {
        const footer = element.querySelector('.care-submit'), boundary = footer.getBoundingClientRect();
        const buttons = [...footer.querySelectorAll('button')].map(button => {
          const rect = button.getBoundingClientRect();
          const text = document.createRange(); text.selectNodeContents(button);
          return { label: button.textContent.trim(), x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            textLines: new Set([...text.getClientRects()].map(line => Math.round(line.y))).size,
            inside: rect.left >= boundary.left && rect.right <= boundary.right && rect.top >= boundary.top && rect.bottom <= boundary.bottom };
        });
        return { height: boundary.height, fieldsHeight: element.querySelector('.care-fields').getBoundingClientRect().height,
          rows: new Set(buttons.map(button => Math.round(button.y))).size, buttons };
      });
      await capture(therapist, 'record-footer', { fullPage: false });
      assert(result.footer.rows <= 2, code);
      assert(result.footer.buttons.every(button => button.inside && button.width >= 44 && button.height >= 44), code);
      assert.deepEqual(result.footer.buttons.map(button => button.label), ['임시저장', '입력 취소', '기록 저장', '공유 준비'], code);
      assert(result.footer.buttons.every(button => button.textLines === 1), code);
      if (width <= 390) { assert.equal(result.footer.rows, 2, code); assert(result.footer.height <= 125, code); }
      const footerButtons = dialog(therapist).locator('.care-submit button');
      await footerButtons.first().focus();
      for (let index = 0; index < 4; index++) {
        assert.equal(await footerButtons.nth(index).evaluate(button => button === document.activeElement), true, code);
        if (index < 3) await footerButtons.nth(index).press('Tab');
      }
      if (width === 320) {
        phase = `${width}:SHORT_RECORD_REACHABILITY`;
        await therapist.page.setViewportSize({ width, height: 360 });
        const controls = [input(therapist, 'performed'), input(therapist, 'nextPlan'), ...await footerButtons.all()];
        for (const control of controls) {
          await control.scrollIntoViewIfNeeded(); await control.click({ trial: true });
          assert.equal(await control.evaluate(element => {
            const rect = element.getBoundingClientRect(), x = (rect.left + rect.right) / 2, y = (rect.top + rect.bottom) / 2;
            const hit = document.elementFromPoint(x, y);
            return x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight && (hit === element || element.contains(hit));
          }), true, code);
        }
        await capture(therapist, 'record-short-height', { fullPage: false });
        await therapist.page.setViewportSize({ width, height: 900 });
        result.shortHeightReachable = true;
      }
      result.footerKeyboard = true;
      phase = `${width}:SOURCE_UI_SAVE`;
      await input(therapist, 'goalId').selectOption(ids.goalId);
      const sourceFields = { date: '2001-01-02', title: '가상 원본 양식의 기록', performed: '가상 원본 수행 결과', response: '가상 원본 아이 반응',
        nextPlan: '가상 원본 다음 계획', summary: '가상 원본 공유 요약', privateNote: '가상 원본 비공개 메모',
        observationTask: '가상 원본 관찰 과제', observationAssistance: '가상 원본 도움 종류', observationAmount: '가상 원본 도움 정도',
        observationRepetitions: '원본 5회', observationDuration: '원본 6분', observationContext: '가상 원본 관찰 조건',
        activityTitle: '가상 원본 가정 활동', activityInstruction: '가상 원본 안내', activityFrequency: '가상 원본 빈도', activityCaution: '가상 원본 주의사항' };
      for (const [name, value] of Object.entries(sourceFields)) await fill(therapist, name, value);
      await input(therapist, 'observationStatus').selectOption('observed');
      const measurements = [{ tool: '가상 도구 <b>형식 아님</b>', item: '가상 첫 항목', value: '0', unit: '회', context: '가상 같은 조건 A' },
        { tool: '가상 두 번째 도구', item: '가상 두 번째 측정 항목', value: '12.5', unit: '초', context: '가상 같은 조건 B' }];
      for (const [index, row] of measurements.entries()) {
        const add = dialog(therapist).locator('[data-care-action="add-assessment"]'); await reveal(add); await add.click();
        for (const [key, value] of Object.entries(row)) await fill(therapist, `assessment-${index}-${key}`, value);
      }
      const originalReceipt = await saveRecord(therapist, false), sourceId = originalReceipt.recordId;
      assert.equal(originalReceipt.revision, 1, code);
      const original = await get(therapist, sourceId, 1), originalDatabase = await dbRecord(sourceId);
      assert.equal(original.appointmentId, ids.appointmentId, code); assert.deepEqual(original.assessments.map(row => row.value), [0, 12.5], code);
      result.sourceCreated = true;

      phase = `${width}:RECORD_LIST_ACTIONS`;
      await workspaceRecords(therapist.page, ids.conversationId);
      assert.equal(await dialog(therapist).isVisible(), false, code);
      const sourceArticle = therapist.page.locator(`article.care-record[data-record-id="${sourceId}"]`);
      await sourceArticle.scrollIntoViewIfNeeded();
      const sourceActions = sourceArticle.locator('[data-care-action]');
      assert.deepEqual(await sourceActions.allTextContents(), ['기록 열기', '양식으로 새 기록', '공유 미리보기'], code);
      for (const button of await sourceActions.all()) assert.equal(await button.isVisible(), true, code);
      assert.equal(await sourceArticle.evaluate(article => {
        const boundary = article.getBoundingClientRect();
        const buttons = [...article.querySelectorAll('[data-care-action]')].map(button => button.getBoundingClientRect());
        return article.scrollWidth <= article.clientWidth + 1 && buttons.every((button, index) =>
          button.width > 0 && button.height > 0 && button.left >= boundary.left - 1 && button.right <= boundary.right + 1 &&
          button.top >= boundary.top - 1 && button.bottom <= boundary.bottom + 1 && buttons.slice(index + 1).every(other =>
            button.right <= other.left + 1 || other.right <= button.left + 1 || button.bottom <= other.top + 1 || other.bottom <= button.top + 1));
      }), true, code);
      await capture(therapist, 'record-list-actions');
      phase = `${width}:RECORD_LIST_REACHABILITY`;
      result.buttonReachability = [];
      for (const action of ['edit-record', 'preview-record', 'reuse-record']) {
        const button = sourceArticle.locator(`[data-care-action="${action}"]`);
        // Exercise ordinary scroll/actionability only; never click or mutate UI state.
        await button.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
        await button.click({ trial: true });
        const observation = await button.evaluate(element => {
          const bounds = element.getBoundingClientRect(), nav = document.querySelector('.main-nav');
          const navigation = nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect() : null;
          const insetX = Math.min(12, bounds.width / 4), insetY = Math.min(12, bounds.height / 4);
          const points = [[bounds.left + bounds.width / 2, bounds.top + bounds.height / 2],
            [bounds.left + insetX, bounds.top + insetY], [bounds.right - insetX, bounds.top + insetY],
            [bounds.left + insetX, bounds.bottom - insetY], [bounds.right - insetX, bounds.bottom - insetY]];
          return {
            withinViewport: bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.top >= 0 &&
              bounds.right <= innerWidth && bounds.bottom <= innerHeight,
            clearOfFixedNavigation: !navigation || bounds.right <= navigation.left || bounds.left >= navigation.right ||
              bounds.bottom <= navigation.top || bounds.top >= navigation.bottom,
            hitTargets: points.every(([x, y]) => element.contains(document.elementFromPoint(x, y))),
          };
        });
        assert.deepEqual(observation, { withinViewport: true, clearOfFixedNavigation: true, hitTargets: true }, code);
        result.buttonReachability.push({ action, ...observation, trialClick: true });
      }
      await capture(therapist, 'record-list-reachable', { fullPage: false }); result.listActions = true;

      phase = `${width}:EXISTING_DRAFT_NOT_OVERWRITTEN`;
      await workspaceRecords(therapist.page, ids.conversationId);
      await therapist.page.locator('[data-care-action="new-record"]').click(); await dialog(therapist).waitFor();
      const unsaved = '가상 현재 작성 중인 입력은 덮어쓰지 않음'; await fill(therapist, 'performed', unsaved);
      await dialog(therapist).getByRole('button', { name: '닫기', exact: true }).click(); await dialog(therapist).waitFor({ state: 'hidden' });
      const beforeRestoreGets = requests.filter(r => r.method === 'GET' && r.pathname === base + '/records/' + sourceId).length;
      await reuse(sourceId, true); assert.equal(await input(therapist, 'performed').inputValue(), unsaved, code);
      assert.equal((await rowValues(therapist)).length, 0, code); assert.equal(await dialog(therapist).locator('[data-record-template-notice]').count(), 0, code);
      assert.equal(requests.filter(r => r.method === 'GET' && r.pathname === base + '/records/' + sourceId).length, beforeRestoreGets, code);
      await capture(therapist, 'existing-draft-kept');
      await dialog(therapist).getByRole('button', { name: '입력 취소', exact: true }).click(); await dialog(therapist).waitFor({ state: 'hidden' });
      result.existingDraftPreserved = true;

      phase = `${width}:TEMPLATE_ALLOWED_FIELDS_ONLY`;
      await reuse(sourceId, true); await dialog(therapist).locator('[data-record-template-notice]').waitFor();
      // Scrolling changes no application data or focus/authorization state.
      await dialog(therapist).evaluate(element => { element.scrollTop = 0; });
      assert.equal(await dialog(therapist).evaluate(element => {
        const boundary = element.getBoundingClientRect(), notice = element.querySelector('[data-record-template-notice]').getBoundingClientRect();
        return element.scrollTop === 0 && notice.top >= boundary.top && notice.bottom <= boundary.bottom &&
          notice.left >= boundary.left && notice.right <= boundary.right;
      }), true, code);
      await capture(therapist, 'template-header'); result.templateHeader = true;
      assert(requests.some(r => r.method === 'GET' && r.pathname === base + '/records/' + sourceId && r.revision === '1'), code);
      const currentDate = await therapist.page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
      assert.equal(await input(therapist, 'date').inputValue(), currentDate, code); assert.equal(await input(therapist, 'goalId').inputValue(), ids.goalId, code);
      for (const name of blankFields) assert.equal(await input(therapist, name).inputValue(), '', code);
      assert.equal(await dialog(therapist).locator('.care-appointment-context,.care-reference').count(), 0, code);
      assert.equal(await dialog(therapist).locator('[data-record-attachment],[data-open-reference-attachment]').count(), 0, code);
      const blanks = measurements.map(row => ({ ...row, value: '' })); assert.deepEqual(await rowValues(therapist), blanks, code);
      assert.equal(await dialog(therapist).locator('[data-assessment-rows]').evaluate(el => el.closest('details').open), true, code);
      assert.equal(await input(therapist, 'assessment-0-tool').inputValue(), measurements[0].tool, code);
      const valueInput = input(therapist, 'assessment-0-value'); await valueInput.focus(); await valueInput.press('Tab');
      assert.equal(await input(therapist, 'assessment-0-unit').evaluate(el => el === document.activeElement), true, code);
      await capture(therapist, 'template-empty-values'); result.keyboard = result.templateOnly = true;

      phase = `${width}:INCOMPLETE_SAVE_REJECTED`;
      const beforePosts = requests.filter(r => r.method === 'POST').length;
      await dialog(therapist).getByRole('button', { name: '기록 저장', exact: true }).click();
      await dialog(therapist).getByTestId('care-error').filter({ hasText: '측정값' }).waitFor();
      assert.equal(await dialog(therapist).isVisible(), true, code); assert.equal(requests.filter(r => r.method === 'POST').length, beforePosts, code);
      assert.deepEqual(await rowValues(therapist), blanks, code); result.incompleteBlocked = true;

      phase = `${width}:EMPTY_VALUES_DRAFT`;
      const draftReceipt = await saveRecord(therapist, true, width === 320), newId = draftReceipt.recordId;
      assert.notEqual(newId, sourceId, code); assert.equal(draftReceipt.revision, 1, code);
      const draft = await get(therapist, newId, 1);
      assert.equal(draft.status, 'draft', code); assert.equal(draft.appointmentId, null, code); assert.equal(draft.date, currentDate, code);
      assert.deepEqual(draft.assessments.map(row => row.value), [null, null], code);
      for (const name of ['performed', 'response', 'nextPlan', 'summary', 'privateNote']) assert.equal(draft[name], '', code);
      assert.equal(draft.observation, null, code); assert.equal(draft.activity, null, code);
      assert.deepEqual(draft.referenceMessageIds, [], code); assert.equal(draft.attachmentCount, 0, code);
      const draftRequest = requests.find(r => r.method === 'POST' && r.pathname === base + '/records/' + newId);
      assert.equal(draftRequest.body.expectedRevision, 0, code); assert.equal(draftRequest.body.content.title, '', code);
      assert.equal(draftRequest.body.content.appointmentId, null, code); result.draftStored = true;
      result.implicitEnterPreservesDraft = width === 320;

      phase = `${width}:NEW_MEASUREMENTS_SAVE`;
      await openRecord(therapist, newId);
      await fill(therapist, 'assessment-0-value', '7'); await fill(therapist, 'assessment-1-value', '15.25');
      const savedReceipt = await saveRecord(therapist, false); assert.equal(savedReceipt.recordId, newId, code); assert.equal(savedReceipt.revision, 2, code);
      const saved = await get(therapist, newId, 2); assert.equal(saved.status, 'saved', code);
      assert.deepEqual(saved.assessments.map(row => row.value), [7, 15.25], code); result.newValuesStored = true;
      assert.deepEqual(await get(therapist, sourceId, 1), original, code); assert.deepEqual(await dbRecord(sourceId), originalDatabase, code);
      const counts = await sandbox.database.query('SELECT count(*)::integer AS count FROM cb_records WHERE center_id=$1 AND conversation_id=$2', [ids.centerId, ids.conversationId]);
      assert.equal(counts.rows[0].count, 2, code);
      result.originalRevision = 1; result.originalSha256 = hash(JSON.stringify(original)); result.sourceUnchanged = true;

      phase = `${width}:FRESH_AUTHENTICATED_CONTEXT`;
      await therapist.context.close(); pages.delete('therapist');
      const fresh = await actor('therapist', 'fresh-therapist'); await fresh.page.bringToFront(); await openRecord(fresh, newId);
      await reveal(input(fresh, 'assessment-0-value'));
      assert.deepEqual((await rowValues(fresh)).map(row => row.value), ['7', '15.25'], code);
      assert.deepEqual(await get(fresh, newId, 2), saved, code); assert.deepEqual(await get(fresh, sourceId, 1), original, code);
      await capture(fresh, 'fresh-session-saved-values'); result.freshSession = true;

      phase = `${width}:GUARDIAN_BOUNDARY`;
      await guardian.page.bringToFront(); await workspaceRecords(guardian.page, ids.conversationId);
      assert.equal(await guardian.page.locator('[data-care-action="reuse-record"],[data-care-action="edit-record"]').count(), 0, code);
      assert.equal(guardianPrivate.length, 0, code);
      const guardianText = await guardian.page.locator('body').innerText();
      for (const value of [sourceFields.privateNote, sourceFields.performed, sourceFields.title, ...measurements.map(row => row.tool)]) assert(!guardianText.includes(value), code);
      for (const who of [fresh, guardian]) assert.deepEqual(await who.page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, ''], code);
      await capture(guardian, 'guardian-no-private-template'); result.guardianPrivate = result.layout = true;
      assert.equal(report.errors.length, 0, code); assert.equal(report.unexpectedRequests.length, 0, code);
      for (const who of [fresh, guardian]) await who.context.close(); pages.clear();
      await sandbox.close(); assert.equal(sandbox.database.closed, true, code); assert.equal(sandbox.credentials.length, 0, code); sandboxes.delete(sandbox);
      result.cleanup = true; report.checks.push(result); delete report.currentCheck;
      console.log(JSON.stringify({ width, passed: true, boundaries: 13 }));
    }
    report.finalSource = await sources(); assert.equal(report.finalSource.sha256, source.sha256, code);
  } catch (error) {
    report.failure = { code, phase, kind: ['AssertionError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-record-template-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      workspaceHelperLine: Number(error?.stack?.match(/local-workspace-browser-helpers\.mjs:(\d+):\d+/)?.[1]) || null };
    for (const [role, page] of [...pages].slice(0, 2)) try {
      const filename = `failure-${role}.png`; await page.screenshot({ path: path.join(folder, filename), fullPage: true,
        mask: [page.locator('input[type="email"]'), page.locator('input[type="password"]'), page.locator('.workspace-head .account')] });
      report.screenshots.push({ filename, syntheticOnly: true, failure: true });
    } catch { note(report.errors, { phase, type: 'failure-screenshot' }); }
  } finally {
    for (const context of contexts) try { await bounded(context.close()); contexts.delete(context); } catch { report.cleanupObservationTimedOut = true; }
    report.cleanup.contextsClosed = contexts.size === 0;
    if (browserServer) {
      try { await bounded(browser?.close()); await bounded(browserServer.close()); await bounded(lifetime.done); }
      catch { report.cleanupObservationTimedOut = true; try { await bounded(browserServer.kill()); await bounded(lifetime.done); } catch {} }
      report.cleanup.browserStopped = lifetime?.terminal() === true;
    } else report.cleanup.browserStopped = true;
    // Unknown browser ownership is not permission to dispose its live backend.
    if (report.cleanup.browserStopped) for (const sandbox of sandboxes) try {
      await bounded(sandbox.close()); assert.equal(sandbox.database.closed, true, code); sandboxes.delete(sandbox);
    } catch { report.failure ??= { code, phase: 'SANDBOX_CLEANUP', kind: 'Error' }; }
    report.cleanup.sandboxesClosed = sandboxes.size === 0; report.finishedAt = new Date().toISOString();
    report.passed = !report.failure && !report.cleanupObservationTimedOut && report.checks.length === 4 &&
      report.errors.length === 0 && report.unexpectedRequests.length === 0 && Object.values(report.cleanup).every(Boolean);
    ownership.finished = Object.values(report.cleanup).every(Boolean); ownership.cleanup = report.cleanup;
    await save('ownership.json', ownership); await save('results.json', report);
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length, failure: report.failure, cleanup: report.cleanup }));
  return report.passed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runLocalRecordTemplateBrowser()) process.exitCode = 1; }
  catch { console.error('LOCAL_RECORD_TEMPLATE_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

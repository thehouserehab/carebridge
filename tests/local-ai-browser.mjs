// Actual Chrome UI → owned loopback HTTP → memory DB → fixture providers.
// No API keys, external calls, real accounts, clinical data or persisted DB.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceRoom, workspaceAccountAction } from './local-workspace-browser-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const content = Object.freeze({
  date: '2026-11-06', title: '가상 AI 요약 대상', status: 'saved',
  performed: '합성 자료: 블록 두 개를 쌓는 놀이를 제시함.',
  response: '가상 아동이 블록을 선택하고 쌓기 시작함.',
  nextPlan: 'SYNTHETIC_PRIVATE_NEXT_PLAN', privateNote: 'SYNTHETIC_PRIVATE_NOTE',
  summary: '저장된 이전 합성 요약', assessments: [], observation: null, activity: null,
});
const summaryText = '합성 요약: 블록 쌓기를 제시했고, 스스로 블록을 선택해 쌓기 시작했어요.';
const questions = ['합성 시험: 보호자 안내 문장을 간결하게 쓰는 방법을 알려주세요.',
  '합성 시험: 앞선 안내를 두 문장으로 정리해 주세요.'];
const responseText = index => `합성 AI 답변 ${index}: 전달할 내용을 짧게 나누고, 관찰한 행동과 다음 질문을 구분해 보세요.`;

async function sourceManifest() {
  const names = ['tests/local-ai-browser.mjs', 'tests/message-browser-policy.mjs',
    'tests/local-workspace-browser-helpers.mjs', 'scripts/p0-study-policy.mjs'];
  for (const directory of ['local-api', 'src', 'server', 'server/migrations']) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      if (entry.isDirectory() || !/\.(?:mjs|js|css|html|sql)$/.test(entry.name)) continue;
      assert(entry.isFile() && !entry.isSymbolicLink(), 'LOCAL_AI_SOURCE_TYPE');
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
    timer = setTimeout(() => reject(new Error('LOCAL_AI_CLEANUP_TIMEOUT')), ms);
  })]); } finally { clearTimeout(timer); }
}
async function dialogReady(page) {
  await page.locator('.ai-assistant[open] .ai-fixture').waitFor();
  await page.waitForFunction(() => {
    const input = document.querySelector('.ai-assistant[open] [data-ai-input]');
    return input && !input.disabled;
  });
}
async function layout(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('.ai-assistant[open]');
    const round = value => Math.round(value * 100) / 100;
    const measure = node => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height),
        inside: rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1,
        reachable: hit === node || node.contains(hit) };
    };
    return { width: innerWidth, height: innerHeight,
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      dialogOverflow: !!dialog && dialog.scrollWidth > dialog.clientWidth + 1,
      dialog: measure(dialog), input: measure(dialog?.querySelector('[data-ai-input]')),
      inputLabel: measure(dialog?.querySelector('.ai-compose label')),
      send: measure(dialog?.querySelector('.ai-compose button[type="submit"]')),
      history: measure(dialog?.querySelector('.ai-history')) };
  });
}
function assertLayout(value) {
  assert.equal(value.documentOverflow, false, 'LOCAL_AI_DOCUMENT_OVERFLOW');
  assert.equal(value.dialogOverflow, false, 'LOCAL_AI_DIALOG_OVERFLOW');
  assert(value.dialog?.inside && value.input?.inside && value.input?.reachable &&
    value.send?.inside && value.send?.reachable, 'LOCAL_AI_COMPOSER_UNREACHABLE');
  assert(value.input.width >= 180, 'LOCAL_AI_INPUT_TOO_NARROW');
  assert(value.input.height >= 44 && value.send.height >= 44, 'LOCAL_AI_COMPOSER_TOO_SMALL');
  assert(value.inputLabel?.width <= 1 && value.inputLabel?.height <= 1, 'LOCAL_AI_SCREENREADER_LABEL_VISIBLE');
  assert(value.history?.height >= 44, 'LOCAL_AI_HISTORY_COLLAPSED');
}

export async function runLocalAiBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const file of [options.module, options.executable]) assert((await lstat(file)).isFile());
  const { chromium } = await import(pathToFileURL(options.module).href);
  const source = await sourceManifest();
  const { createLocalAiApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const { Records } = await import('../server/records.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-ai-${runId}`);
  await mkdir(path.dirname(folder), { recursive: true });
  await mkdir(folder);
  const report = { runId, at: new Date().toISOString(), source, passed: false, checks: [], screenshots: [],
    errors: [], unexpectedRequests: [], failure: null, actualModelCalls: 0, humanMetricsCollected: false,
    cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Owned loopback HTTP, fresh memory-only PGlite and synthetic accounts/data/providers only.',
      'Fixture responses verify integration and handling, not actual OpenAI model quality, paid API access or regional processing.',
      'Chrome viewport emulation is not physical-device, cross-device, production deployment or human usability evidence.',
      'Applying AI text is verified as an unsaved record form; existing save/share integration is outside this runner.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, origins: [], startedAt: report.at, finished: false };
  await writeFile(path.join(folder, 'ownership.json'), JSON.stringify(ownership, null, 2));
  let browserServer, browserProcess, browser, phase = 'STARTUP';
  const contexts = new Set(), sandboxes = new Set();
  try {
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    browserProcess = browserServer.process(); ownership.browserProcessId = browserProcess.pid;
    await writeFile(path.join(folder, 'ownership.json'), JSON.stringify(ownership, null, 2));
    browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      const { width } = viewport, calls = { chat: [], summary: [] };
      let cancelNext = false, cancellationStarted;
      phase = `${width}:START_SANDBOX`;
      const sandbox = await createLocalAiApiSandbox({
        summaryProvider: { mode: 'fixture', model: 'fixture-ai', async generate(input, { signal }) {
          assert(!signal.aborted, 'LOCAL_AI_PROVIDER_ABORTED');
          calls.summary.push(structuredClone(input));
          return { summary: summaryText, reviewNotes: ['합성 자료로 생성한 시험 초안입니다.'], usage: { inputTokens: 10, outputTokens: 20 } };
        } },
        chatProvider: { mode: 'fixture', model: 'fixture-ai', async respond(input, { signal }) {
          assert(!signal.aborted, 'LOCAL_AI_PROVIDER_ABORTED');
          calls.chat.push(structuredClone(input));
          if (cancelNext) {
            cancelNext = false;
            return new Promise((_, reject) => {
              signal.addEventListener('abort', () => reject(new Error('synthetic cancellation')), { once: true });
              cancellationStarted();
            });
          }
          return { text: responseText(calls.chat.length), usage: { inputTokens: 10, outputTokens: 20 } };
        } },
      });
      sandboxes.add(sandbox);
      const originUrl = new URL(sandbox.origin);
      assert.equal(originUrl.protocol, 'http:'); assert.equal(originUrl.hostname, '127.0.0.1');
      assert(originUrl.port && !originUrl.username && !originUrl.password && !originUrl.search && !originUrl.hash);
      assert.equal(originUrl.pathname, '/');
      const origin = originUrl.origin, ids = sandbox.ids;
      ownership.origins.push(origin);
      await writeFile(path.join(folder, 'ownership.json'), JSON.stringify(ownership, null, 2));
      const records = new Records(sandbox.database), actor = { centerId: ids.centerId, userId: ids.therapistId };
      const recordId = `ai-fixture-${randomUUID()}`;
      await records.save(actor, { conversationId: ids.conversationId, recordId, clientId: randomUUID(),
        expectedRevision: 0, content: { ...content, goalId: ids.goalId } });
      const record = () => records.get(actor, { conversationId: ids.conversationId, recordId });
      const original = await record();
      const result = { ...viewport, twoTurnChat: false, serverHistory: false, previewBeforeGeneration: false,
        sourceMinimized: false, applyUnsavedOnly: false, guardianIsolation: false, accountChangeClears: false,
        cancellationPreservesInput: false, browserStorageEmpty: false, layout: [], cleanup: false };
      report.currentCheck = result;
      const createContext = async () => {
        const context = await browser.newContext({ viewport, locale: 'ko-KR', isMobile: width <= 640,
          hasTouch: width <= 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context);
        await context.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url());
          if (url.origin !== origin || !['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method())) {
            report.unexpectedRequests.push({ phase, externalOrigin: url.origin !== origin, method: request.method() });
            await route.abort('blockedbyclient'); return;
          }
          await route.continue();
        });
        context.on('page', page => {
          page.setDefaultTimeout(15_000);
          page.on('pageerror', () => report.errors.push({ phase, kind: 'PAGE_ERROR' }));
          page.on('console', message => {
            if (message.type() === 'error' && !/status of 401/.test(message.text()))
              report.errors.push({ phase, kind: 'CONSOLE_ERROR' });
          });
          page.on('dialog', prompt => { void prompt.accept(); });
        });
        return context;
      };
      const login = async (page, role) => {
        await page.goto(origin);
        await page.getByTestId('login-form').waitFor();
        const credential = sandbox.credentials.find(item => item.role === role);
        assert(credential?.email.endsWith('.test'), 'LOCAL_AI_SYNTHETIC_CREDENTIAL');
        await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click();
        await page.getByTestId('home').waitFor();
        await workspaceRoom(page, ids.conversationId);
      };
      const capture = async (page, label) => {
        const filename = `${width}-${label}.png`;
        await page.screenshot({ path: path.join(folder, filename), fullPage: false,
          mask: [page.locator('input[type="email"]'), page.locator('input[type="password"]'), page.locator('.account-panel')] });
        report.screenshots.push(filename);
      };
      const context = await createContext(), page = await context.newPage();
      phase = `${width}:LOGIN_CHAT`;
      await login(page, 'therapist');
      await page.locator('[data-action="ai-assistant"]').click();
      await dialogReady(page);
      assert.equal(await page.locator('.ai-bubble').count(), 0);
      for (let index = 0; index < questions.length; index++) {
        await page.locator('[data-ai-input]').fill(questions[index]);
        await page.locator('.ai-compose button[type="submit"]').click();
        await page.waitForFunction(count => document.querySelectorAll('.ai-bubble.assistant').length === count, index + 1);
        await dialogReady(page);
        assert.equal(await page.locator('.ai-bubble.assistant p').last().innerText(), responseText(index + 1));
      }
      assert.deepEqual(calls.chat, [{ messages: [{ role: 'user', content: questions[0] }] },
        { messages: [{ role: 'user', content: questions[0] }, { role: 'assistant', content: responseText(1) },
          { role: 'user', content: questions[1] }] }], 'LOCAL_AI_CHAT_CONTEXT');
      result.twoTurnChat = true;
      let measured = await layout(page); assertLayout(measured); result.layout.push(measured);
      await capture(page, 'chat');
      phase = `${width}:SHORT_VIEWPORT`;
      await page.setViewportSize({ width, height: 420 });
      measured = await layout(page); assertLayout(measured); result.layout.push(measured);
      await capture(page, 'chat-short');
      await page.setViewportSize(viewport);
      phase = `${width}:REOPEN_HISTORY`;
      await page.locator('[data-ai-action="close"]').click();
      await page.locator('[data-action="ai-assistant"]').click();
      await dialogReady(page);
      assert.equal(await page.locator('.ai-bubble').count(), 4);
      assert.equal(calls.chat.length, 2);
      result.serverHistory = true;
      phase = `${width}:CANCEL_PENDING`;
      const cancelQuestion = '합성 시험: 이 요청은 취소하고 입력만 유지합니다.';
      const started = new Promise(resolve => { cancellationStarted = resolve; });
      cancelNext = true;
      await page.locator('[data-ai-input]').fill(cancelQuestion);
      await page.locator('.ai-compose button[type="submit"]').click();
      await bounded(started);
      await page.locator('[data-ai-action="cancel"]').click();
      await dialogReady(page);
      assert.equal(await page.locator('[data-ai-input]').inputValue(), cancelQuestion);
      assert.equal(await page.locator('.ai-bubble').count(), 4);
      assert((await page.locator('[data-ai-status]').innerText()).includes('취소'), 'LOCAL_AI_CANCEL_STATUS');
      assert.equal(calls.chat.length, 3);
      result.cancellationPreservesInput = true;
      phase = `${width}:SUMMARY_PREVIEW`;
      await page.locator('[data-ai-action="summary"]').click();
      await page.locator(`[data-ai-record] option[value="${recordId}"]`).waitFor({ state: 'attached' });
      await page.locator('[data-ai-record]').selectOption(recordId);
      await page.locator('.ai-source').waitFor();
      const preview = await page.locator('.ai-source').innerText();
      assert(preview.includes(content.performed) && preview.includes(content.response), 'LOCAL_AI_SOURCE_VISIBLE');
      for (const excluded of [content.privateNote, content.nextPlan, content.summary, recordId, ids.childId,
        ids.guardianId, ids.therapistId, ids.centerId, ids.conversationId])
        assert(!preview.includes(excluded), 'LOCAL_AI_SOURCE_EXCLUDES_PRIVATE');
      assert.equal(calls.summary.length, 0); result.previewBeforeGeneration = true;
      await capture(page, 'summary-preview');
      phase = `${width}:SUMMARY_GENERATE_APPLY`;
      await page.locator('[data-ai-action="generate"]').click();
      await page.locator('.ai-generated').waitFor();
      assert.equal(await page.locator('.ai-generated').innerText(), summaryText);
      assert.deepEqual(calls.summary, [{ performed: content.performed, response: content.response }], 'LOCAL_AI_MINIMAL_PROVIDER_SOURCE');
      assert.deepEqual(await record(), original, 'LOCAL_AI_GENERATION_PRESERVES_RECORD');
      result.sourceMinimized = true;
      await page.locator('[data-ai-action="apply"]').click();
      await page.locator('.ai-assistant').waitFor({ state: 'detached' });
      const form = page.locator('[data-care-form="record"]');
      await form.waitFor();
      assert.equal(await form.locator('[name="summary"]').inputValue(), summaryText);
      assert.deepEqual(await record(), original, 'LOCAL_AI_APPLY_PRESERVES_RECORD');
      result.applyUnsavedOnly = true;
      await capture(page, 'applied-unsaved');
      await page.getByTestId('care-dialog').getByRole('button', { name: '입력 취소', exact: true }).click();
      await page.getByTestId('care-dialog').waitFor({ state: 'hidden' });
      assert.deepEqual(await record(), original);
      phase = `${width}:ACCOUNT_CHANGE`;
      await page.locator('[data-action="ai-assistant"]').click();
      await dialogReady(page);
      await page.locator('[data-ai-input]').fill('합성 미전송 입력: 계정 변경 시 지워져야 함');
      const peer = await context.newPage();
      await peer.goto(origin); await peer.getByTestId('home').waitFor();
      await workspaceAccountAction(peer, 'logout');
      await peer.getByTestId('login-form').waitFor();
      // Bring the original page to front so normal focus/polling observes logout.
      await page.bringToFront();
      await page.getByTestId('login-form').waitFor();
      assert.equal(await page.locator('.ai-assistant').count(), 0);
      assert.equal(await page.locator('[data-ai-input]').count(), 0);
      result.accountChangeClears = true;
      await peer.close();
      phase = `${width}:GUARDIAN_ISOLATION`;
      await login(page, 'guardian');
      await page.locator('[data-action="ai-assistant"]').click();
      await dialogReady(page);
      assert.equal(await page.locator('.ai-bubble').count(), 0);
      assert.equal(await page.locator('[data-ai-action="summary"]').count(), 0);
      assert.equal(await page.locator('[data-ai-input]').inputValue(), '');
      assert.equal(calls.chat.length, 3); assert.equal(calls.summary.length, 1);
      result.guardianIsolation = true;
      assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
      result.browserStorageEmpty = true;
      await capture(page, 'guardian');
      assert.deepEqual(report.errors, [], 'LOCAL_AI_BROWSER_ERRORS');
      assert.deepEqual(report.unexpectedRequests, [], 'LOCAL_AI_NETWORK_ESCAPE');
      await context.close(); contexts.delete(context);
      await sandbox.close(); assert.equal(sandbox.database.closed, true); assert.equal(sandbox.credentials.length, 0);
      sandboxes.delete(sandbox); result.cleanup = true; report.checks.push(result);
      delete report.currentCheck;
      console.log(JSON.stringify({ width, passed: true, fixtureChatCalls: calls.chat.length, fixtureSummaryCalls: calls.summary.length }));
    }
    report.finalSource = await sourceManifest();
    assert.equal(report.finalSource.sha256, source.sha256, 'LOCAL_AI_SOURCE_CHANGED');
  } catch (error) {
    const assertion = error?.message?.split('\n')[0];
    report.failure = { code: 'LOCAL_AI_BROWSER_FAILED', phase,
      kind: ['TimeoutError', 'AssertionError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-ai-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      assertion: /^LOCAL_(?:AI|WORKSPACE)_[A-Z_]+$/.test(assertion ?? '') ? assertion : null };
    report.failureSurfaces = [];
    for (const context of contexts) for (const page of context.pages()) {
      try {
        const filename = `failure-${report.failureSurfaces.length}.png`;
        const state = await layout(page);
        await page.screenshot({ path: path.join(folder, filename), fullPage: false,
          mask: [page.locator('input[type="email"]'), page.locator('input[type="password"]'), page.locator('.account-panel')] });
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
  try { if (!await runLocalAiBrowser()) process.exitCode = 1; }
  catch { console.error('LOCAL_AI_BROWSER_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

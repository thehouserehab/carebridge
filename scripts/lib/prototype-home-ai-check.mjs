import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Records } from '../../server/records.mjs';
import { studyChildEnvironment } from '../p0-study-policy.mjs';

const checked = new WeakSet();
const digest = value => createHash('sha256').update(value).digest('hex');
const prompt = '가상 자료 연결 시험입니다. 파란 블록과 노란 블록 중 파란 블록을 골랐다는 가상 관찰을 보호자에게 전하는 짧은 문장 하나로 다듬어 주세요. 진단이나 추가 사실은 넣지 마세요.';
const expectedSource = Object.freeze({
  performed: '가상 사례: 파란 블록과 노란 블록 중 고르는 놀이를 했습니다.',
  response: '가상 사례: 하루가 파란 블록을 골랐습니다.',
});
function configuration(sandbox, options) {
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new Error('HOME_AI_CHECK_CONFIGURATION_INVALID');
  if (sandbox?.mode !== 'synthetic-prototype' || sandbox.aiMode !== 'openai' ||
      !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/.test(sandbox.origin) ||
      !sandbox.database || !sandbox.ids?.recordId?.startsWith('prototype-record-') || checked.has(sandbox)) {
    throw new Error('HOME_AI_CHECK_SCOPE_INVALID');
  }
  for (const value of [options.reportDirectory, options.playwrightModule, options.executablePath]) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error('HOME_AI_CHECK_CONFIGURATION_INVALID');
    }
  }
  const account = sandbox.credentials?.find(value => value.role === 'therapist');
  if (!account || !account.email.endsWith('.test')) throw new Error('HOME_AI_CHECK_SCOPE_INVALID');
  return account;
}
async function bounded(work) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CLEANUP_TIMEOUT')), 15000); })]); }
  finally { clearTimeout(timer); }
}
async function ready(page) {
  await page.waitForFunction(() => {
    const input = document.querySelector('.ai-assistant[open] [data-ai-input]');
    return input && !input.disabled;
  });
  assert.equal(await page.locator('.ai-assistant[open] .ai-fixture').count(), 0);
}

/** Two explicit model actions against a newly owned, unchanged synthetic session.
 * Never takes a key, reads an existing browser profile, or closes the caller's sandbox.
 * Provider HTTP execution must be attested separately; mode metadata alone is not proof.
 */
export async function verifyPrototypeHomeAi(sandbox, {
  reportDirectory,
  playwrightModule = process.env.PLAYWRIGHT_MODULE,
  executablePath = process.env.STUDY_CHROMIUM_EXECUTABLE,
  signal,
} = {}) {
  const credential = configuration(sandbox, { reportDirectory, playwrightModule, executablePath, signal });
  const active = () => { if (signal?.aborted) throw new Error('HOME_AI_CHECK_CANCELLED'); };
  active();
  const records = new Records(sandbox.database);
  const actor = { centerId: sandbox.ids.centerId, userId: sandbox.ids.therapistId };
  const selection = { conversationId: sandbox.ids.conversationId, recordId: sandbox.ids.recordId };
  const original = await records.get(actor, selection);
  if (original.title !== '놀이 참여 관찰' || original.performed !== expectedSource.performed || original.response !== expectedSource.response) {
    throw new Error('HOME_AI_CHECK_SOURCE_CHANGED');
  }
  checked.add(sandbox);
  await mkdir(reportDirectory, { recursive: true });
  const report = { passed: false, cancelled: false, syntheticOnly: true, providerMode: 'openai', modelActionsAttempted: 0,
    checks: [], responses: [], screenshots: [], errors: [], unexpectedRequests: [],
    cleanup: { browserStopped: false, contextsClosed: false },
    limitations: ['Browser-to-API evidence; actual provider HTTP calls require the launcher transport receipt.', 'Synthetic local session only; no physical device or production data.'] };
  let phase = 'BROWSER_START', browserServer, browser, browserProcess;
  const contexts = new Set();
  let abortClosing = Promise.resolve();
  const onAbort = () => {
    report.cancelled = true;
    // Closing only owned pages cancels their in-flight HTTP requests. Provider
    // cancellation is forwarded by the ordinary API rather than a new channel.
    abortClosing = Promise.allSettled([...contexts].map(context => context.close()))
      .then(() => browser?.close()).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const base = `/api/local/centers/${sandbox.ids.centerId}/conversations/${sandbox.ids.conversationId}`;
  let posts = 0;
  try {
    active();
    const { chromium } = await import(pathToFileURL(playwrightModule).href);
    active();
    browserServer = await chromium.launchServer({ headless: true, executablePath, host: '127.0.0.1', port: 0,
      env: studyChildEnvironment(), timeout: 30000 });
    browserProcess = browserServer.process();
    active();
    browser = await chromium.connect(browserServer.wsEndpoint());
    let answerHash;
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      active();
      phase = `${viewport.width}:LOGIN`;
      const context = await browser.newContext({ viewport, locale: 'ko-KR', timezoneId: 'Asia/Seoul',
        isMobile: viewport.width < 600, hasTouch: viewport.width < 600, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
      contexts.add(context);
      active();
      await context.route('**/*', route => {
        if (signal?.aborted) return route.abort();
        const request = route.request(), url = new URL(request.url());
        const aiPost = request.method() === 'POST' && /\/(?:ai-conversation|ai-summary)$/.test(url.pathname);
        if (url.origin !== sandbox.origin || !['GET', 'POST'].includes(request.method()) || (aiPost && ++posts > 2)) {
          report.unexpectedRequests.push({ phase, method: request.method() });
          return route.abort();
        }
        return route.continue();
      });
      const page = await context.newPage(); page.setDefaultTimeout(35000);
      page.on('pageerror', () => { if (!signal?.aborted) report.errors.push({ phase, kind: 'PAGE_ERROR' }); });
      page.on('console', message => { if (!signal?.aborted && message.type() === 'error' && !/status of 401/.test(message.text())) report.errors.push({ phase, kind: 'CONSOLE_ERROR' }); });
      const responseFor = (suffix, method) => {
        const pending = page.waitForResponse(response => {
          const url = new URL(response.url());
          return url.origin === sandbox.origin && url.pathname === base + suffix && response.request().method() === method;
        });
        // A concurrent abort can make the UI action throw before its response
        // promise is awaited. Observe that rejection without hiding it from the
        // ordinary await, avoiding an unhandled rejection during cancellation.
        void pending.catch(() => {});
        return pending;
      };
      const capture = async name => {
        const filename = `${viewport.width}-${name}.png`;
        await page.screenshot({ path: path.join(reportDirectory, filename), mask: [page.locator('input[type=password]'), page.locator('input[type=email]'), page.locator('.account-panel')] });
        report.screenshots.push(filename);
      };
      await page.goto(sandbox.origin);
      assert.equal(await page.locator('html').getAttribute('data-ai-mode'), 'openai');
      await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
      await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
      await page.getByRole('button', { name: '로그인', exact: true }).click();
      await page.locator('[data-home-news]').waitFor();
      await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('서버와 연결'));
      phase = `${viewport.width}:HOME_OPEN`;
      const entry = page.locator('[data-action="ai-assistant"]');
      assert.equal(await entry.isDisabled(), false);
      const initialResponse = responseFor('/ai-conversation', 'GET');
      await entry.click(); const initial = await initialResponse;
      assert.equal(initial.status(), 200);
      const initialData = (await initial.json()).conversation;
      assert.equal(initialData.mode, 'openai');
      await ready(page);
      const dialog = page.locator('.ai-assistant[open]');
      if (viewport.width === 1440) {
        assert.equal(initialData.messages.length, 0, 'NEW_SYNTHETIC_CHAT_REQUIRED');
        phase = '1440:CHAT';
        await dialog.locator('[data-ai-input]').fill(prompt);
        active();
        const sent = responseFor('/ai-conversation', 'POST');
        report.modelActionsAttempted++;
        await dialog.getByRole('button', { name: '보내기', exact: true }).click();
        const response = await sent;
        active();
        report.responses.push({ kind: 'chat', status: response.status() });
        assert.equal(response.status(), 200);
        const conversation = (await response.json()).conversation;
        assert.equal(conversation.mode, 'openai'); assert.equal(conversation.messages.length, 2);
        await dialog.locator('.ai-bubble.assistant').waitFor();
        const answer = await dialog.locator('.ai-bubble.assistant p').innerText();
        assert(answer.trim().length > 0 && !answer.includes('시연용 예시 답변입니다.'));
        assert.equal(answer, conversation.messages[1].content);
        answerHash = digest(answer);
        report.checks.push({ kind: 'homeChat', responseLength: answer.length, responseSha256: answerHash, providerMode: conversation.mode });
        await capture('home-ai-answer');
        phase = '1440:CHAT_REFRESH';
        await page.reload(); await page.locator('[data-home-news]').waitFor();
        await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('서버와 연결'));
        await entry.click(); await ready(page);
        assert.equal(digest(await dialog.locator('.ai-bubble.assistant p').innerText()), answerHash);
        report.checks.push({ kind: 'chatRefresh', preserved: true });
        phase = '1440:SUMMARY';
        await dialog.locator('[data-ai-action="summary"]').click();
        await dialog.locator(`[data-ai-record] option[value="${sandbox.ids.recordId}"]`).waitFor({ state: 'attached' });
        const previewPromise = responseFor(`/records/${sandbox.ids.recordId}/ai-summary`, 'GET');
        await dialog.locator('[data-ai-record]').selectOption(sandbox.ids.recordId);
        const previewResponse = await previewPromise;
        assert.equal(previewResponse.status(), 200);
        const preview = (await previewResponse.json()).preview;
        assert.equal(preview.mode, 'openai'); assert.deepEqual(preview.source, expectedSource);
        active();
        const generated = responseFor(`/records/${sandbox.ids.recordId}/ai-summary`, 'POST');
        report.modelActionsAttempted++;
        await dialog.locator('[data-ai-action="generate"]').click();
        const generatedResponse = await generated;
        active();
        report.responses.push({ kind: 'summary', status: generatedResponse.status() });
        assert.equal(generatedResponse.status(), 200);
        const draft = (await generatedResponse.json()).draft;
        assert.equal(draft.mode, 'openai');
        await dialog.locator('.ai-generated').waitFor();
        const summary = await dialog.locator('.ai-generated').innerText();
        assert(summary.trim().length > 0); assert.equal(summary, draft.summary);
        report.checks.push({ kind: 'recordSummary', responseLength: summary.length, responseSha256: digest(summary), providerMode: draft.mode });
        await capture('record-summary');
        await page.reload(); await page.locator('[data-home-news]').waitFor();
        assert.deepEqual(await records.get(actor, selection), original, 'AI_DRAFT_MUST_NOT_SAVE_RECORD');
        report.checks.push({ kind: 'recordPreservation', unchanged: true });
      } else {
        phase = `${viewport.width}:PERSISTED_CHAT_LAYOUT`;
        assert.equal(initialData.messages.length, 2);
        assert.equal(digest(await dialog.locator('.ai-bubble.assistant p').innerText()), answerHash);
        await dialog.locator('.ai-bubble.assistant').scrollIntoViewIfNeeded();
        const layout = await dialog.evaluate(node => {
          const bounds = node.getBoundingClientRect(), input = node.querySelector('[data-ai-input]').getBoundingClientRect();
          return { noPageOverflow: document.documentElement.scrollWidth <= innerWidth + 1,
            dialogInViewport: bounds.left >= -1 && bounds.right <= innerWidth + 1 && bounds.top >= -1 && bounds.bottom <= innerHeight + 1,
            inputInViewport: input.top >= 0 && input.bottom <= innerHeight + 1 };
        });
        assert(Object.values(layout).every(Boolean));
        await capture('home-ai-persisted');
        await dialog.locator('[data-ai-action="close"]').click();
        assert.equal(await page.locator('.main-nav [data-view="home"]').getAttribute('aria-current'), 'page');
        report.checks.push({ kind: 'mobileHome', width: viewport.width, preserved: true, historyScrolledToAnswer: true, ...layout });
      }
      assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
      await context.close(); contexts.delete(context);
    }
    assert.equal(posts, 2); assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedRequests, []);
    report.passed = true;
  } catch {
    report.cancelled = signal?.aborted === true;
    report.errors.push({ phase, kind: report.cancelled ? 'HOME_AI_CHECK_CANCELLED' : 'HOME_AI_CHECK_FAILED' });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { await bounded(abortClosing); }
    catch { report.errors.push({ phase: 'CLEANUP', kind: 'CANCEL_CLOSE_FAILED' }); }
    for (const context of contexts) {
      try { await bounded(context.close()); contexts.delete(context); }
      catch { report.errors.push({ phase: 'CLEANUP', kind: 'CONTEXT_CLOSE_FAILED' }); }
    }
    report.cleanup.contextsClosed = contexts.size === 0;
    try { await bounded(browser?.close()); await bounded(browserServer?.close()); }
    catch { report.errors.push({ phase: 'CLEANUP', kind: 'BROWSER_CLOSE_FAILED' }); }
    report.cleanup.browserStopped = !browserProcess || browserProcess.exitCode !== null || browserProcess.signalCode !== null;
    report.passed = report.passed && report.errors.length === 0 && Object.values(report.cleanup).every(Boolean);
    await writeFile(path.join(reportDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

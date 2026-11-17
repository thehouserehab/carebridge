// Actual Chrome -> owned loopback API -> fresh memory DB. Fixture AI only.
// Does not connect to an existing study server or measure human usability.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceRoom, workspaceView } from './local-workspace-browser-helpers.mjs';
import { captureLocalP0StudySources } from './local-p0-study-browser.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const filename = fileURLToPath(import.meta.url);
const code = 'LOCAL_AI_READ_STATE_FAILED';
const hash = value => createHash('sha256').update(value).digest('hex');

async function bounded(operation, milliseconds = 15_000) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('LOCAL_AI_READ_STATE_TIMEOUT')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function eventually(read, expected) {
  const deadline = performance.now() + 15_000;
  while (true) {
    const actual = await read();
    if (actual === expected) return actual;
    assert(performance.now() < deadline, 'LOCAL_AI_READ_STATE_DB_TIMEOUT');
    await wait(80);
  }
}

async function dialogReady(page) {
  await page.locator('.ai-assistant[open] .ai-fixture').waitFor();
  await page.waitForFunction(() => {
    const input = document.querySelector('.ai-assistant[open] [data-ai-input]');
    return input && !input.disabled;
  });
}

export async function runLocalAiReadStateBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const file of [options.module, options.executable]) assert((await lstat(file)).isFile(), code);
  const { chromium } = await import(pathToFileURL(options.module).href);
  const { createLocalAiApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const source = await captureLocalP0StudySources();
  assert(!source.files.some(file => file.name === 'tests/local-ai-read-state-browser.mjs'), 'LOCAL_AI_READ_STATE_P0_SCOPE');
  const testSourceSha256 = hash(await readFile(filename));
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-ai-read-state-${runId}`);
  await mkdir(path.dirname(folder), { recursive: true });
  await mkdir(folder);
  const report = { runId, at: new Date().toISOString(), source, testSourceSha256, passed: false, checks: [],
    errors: [], unexpectedRequests: [], failure: null, actualModelCalls: 0, fixtureModelCalls: 0,
    humanMetricsCollected: false, cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Fresh memory-only synthetic accounts and owned loopback HTTP; no existing study server is accessed.',
      'Actual Chrome viewport emulation, not physical-device, human comprehension or production evidence.',
      'Fixture AI capability and modal only; no prompt submission or external model request.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, origins: [], finished: false };
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2));
  await save('ownership.json', ownership);
  const contexts = new Set(), sandboxes = new Set();
  let browserServer, browserProcess, browser, phase = 'STARTUP';
  try {
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    browserProcess = browserServer.process(); ownership.browserProcessId = browserProcess.pid;
    await save('ownership.json', ownership);
    browser = await chromium.connect(browserServer.wsEndpoint());
    report.browserVersion = browser.version();
    for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
      const { width } = viewport;
      phase = `${width}:SANDBOX`;
      const neverGenerate = async () => {
        report.fixtureModelCalls++;
        throw new Error('LOCAL_AI_READ_STATE_UNEXPECTED_GENERATION');
      };
      const sandbox = await createLocalAiApiSandbox({
        summaryProvider: { mode: 'fixture', model: 'fixture-read-state', generate: neverGenerate },
        chatProvider: { mode: 'fixture', model: 'fixture-read-state', respond: neverGenerate },
      });
      sandboxes.add(sandbox);
      const url = new URL(sandbox.origin);
      assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.pathname === '/', code);
      const origin = url.origin, ids = sandbox.ids;
      ownership.origins.push(origin); await save('ownership.json', ownership);
      const base = `/api/local/centers/${ids.centerId}`;
      const messagesPath = `${base}/conversations/${ids.conversationId}/messages`;
      const readPath = `${base}/conversations/${ids.conversationId}/read`;
      const result = { ...viewport, normalPollingObserved: 0, modalBlocksRead: false,
        homeUnreadPreserved: false, closeAllowsRead: false, homeUnreadCleared: false, cleanup: false };
      report.currentCheck = result;
      const therapistReadWrites = [];
      const createActor = async role => {
        const context = await browser.newContext({ viewport, locale: 'ko-KR', isMobile: width < 640,
          hasTouch: width < 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context);
        await context.route('**/*', async route => {
          const request = route.request(), target = new URL(request.url());
          if (target.origin !== origin || !['GET', 'POST'].includes(request.method())) {
            report.unexpectedRequests.push({ phase, role, externalOrigin: target.origin !== origin, method: request.method() });
            await route.abort('blockedbyclient'); return;
          }
          await route.continue();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        page.on('pageerror', () => report.errors.push({ phase, role, kind: 'PAGE_ERROR' }));
        page.on('console', entry => {
          if (entry.type() === 'error' && !/status of 401/.test(entry.text()))
            report.errors.push({ phase, role, kind: 'CONSOLE_ERROR' });
        });
        if (role === 'therapist') page.on('request', request => {
          if (new URL(request.url()).pathname === readPath && request.method() === 'POST') therapistReadWrites.push(1);
        });
        await page.goto(origin);
        await page.getByTestId('login-form').waitFor();
        const credential = sandbox.credentials.find(item => item.role === role);
        assert(credential?.email.endsWith('.test'), code);
        await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click();
        await page.getByTestId('home').waitFor();
        await workspaceRoom(page, ids.conversationId);
        return { context, page };
      };
      const guardian = await createActor('guardian'), therapist = await createActor('therapist');
      const readPosition = async () => {
        const { rows } = await sandbox.database.query(`SELECT sequence FROM cb_read_states
          WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3`, [ids.centerId, ids.conversationId, ids.therapistId]);
        return Number(rows[0]?.sequence ?? 0);
      };
      const inbox = async () => {
        const response = await therapist.page.evaluate(async ({ pathname, account }) => {
          const response = await fetch(pathname, { credentials: 'same-origin', cache: 'no-store',
            headers: { Accept: 'application/json', 'X-Carebridge-Account': account } });
          return { status: response.status, value: await response.json() };
        }, { pathname: `${base}/inbox`, account: ids.therapistId });
        assert.equal(response.status, 200, code);
        return response.value.rooms.find(room => room.conversationId === ids.conversationId);
      };
      phase = `${width}:INITIAL_READ`;
      const { rows: seedMessages } = await sandbox.database.query(`SELECT MAX(sequence) AS sequence FROM cb_messages
        WHERE center_id=$1 AND conversation_id=$2`, [ids.centerId, ids.conversationId]);
      const seedSequence = Number(seedMessages[0].sequence);
      assert(seedSequence > 0, code);
      try { await eventually(readPosition, seedSequence); }
      catch (error) {
        result.initialReadObserved = await readPosition();
        result.initialSurface = await therapist.page.evaluate(() => {
          const bounds = selector => {
            const node = document.querySelector(selector), rect = node?.getBoundingClientRect();
            return rect ? { top: rect.top, bottom: rect.bottom, height: rect.height, clientHeight: node.clientHeight } : null;
          };
          return { visibility: document.visibilityState, view: document.querySelector('#app')?.dataset.view,
            viewportHeight: window.visualViewport?.height, innerHeight, openDialogs: document.querySelectorAll('dialog[open]').length,
            list: bounds('[data-testid="message-list"]'), row: bounds('[data-testid="message-row"]'), nav: bounds('.main-nav') };
        });
        throw error;
      }
      assert.equal((await inbox()).unread, 0, code);
      const before = await readPosition();
      await therapist.page.locator('[data-action="ai-assistant"]').click();
      await dialogReady(therapist.page);
      const readWriteCount = therapistReadWrites.length;
      phase = `${width}:GUARDIAN_UI_SEND`;
      const body = `합성 읽음 경계 시험 ${width}: AI 창을 닫은 뒤 확인할 새 메시지입니다.`;
      await guardian.page.getByLabel('메시지', { exact: true }).fill(body);
      await guardian.page.getByRole('button', { name: '보내기', exact: true }).click();
      await guardian.page.getByTestId('message-row').filter({ hasText: body }).waitFor();
      const { rows: inserted } = await sandbox.database.query(`SELECT id, sequence, author_id FROM cb_messages
        WHERE center_id=$1 AND conversation_id=$2 AND body=$3`, [ids.centerId, ids.conversationId, body]);
      assert.equal(inserted.length, 1, code);
      const message = inserted[0], nextSequence = Number(message.sequence);
      assert.equal(message.author_id, ids.guardianId, code);
      assert.equal(nextSequence, before + 1, code);
      phase = `${width}:MODAL_POLLING`;
      // Do not call refresh, reload, manipulate timers or inject app state. Two
      // normal polling responses must carry the new message behind the dialog.
      for (let index = 0; index < 2; index++) {
        await therapist.page.waitForResponse(async response => {
          if (new URL(response.url()).pathname !== messagesPath || response.request().method() !== 'GET' || response.status() !== 200) return false;
          const value = await response.json();
          return value.messages?.some(item => item.id === message.id) === true;
        });
        await therapist.page.locator(`[data-message-id="${message.id}"][data-testid="message-row"]`).waitFor({ state: 'attached' });
        await therapist.page.waitForFunction(roomId => document.querySelector(`[data-home-news] [data-news-room="${roomId}"] .badge`)?.textContent === '새 소식 1', ids.conversationId);
        assert.equal(await readPosition(), before, 'LOCAL_AI_READ_STATE_MODAL_ADVANCED');
        assert.equal(therapistReadWrites.length, readWriteCount, 'LOCAL_AI_READ_STATE_MODAL_WRITE');
        const home = await inbox();
        assert.equal(home.lastRead, before, code); assert.equal(home.unread, 1, code);
        assert.equal(home.latest.id, message.id, code);
        result.normalPollingObserved++;
      }
      result.geometry = await therapist.page.evaluate(messageId => {
        const dialog = document.querySelector('.ai-assistant[open]');
        const row = document.querySelector(`[data-message-id="${messageId}"][data-testid="message-row"]`);
        const list = document.querySelector('[data-testid="message-list"]');
        const bounds = row.getBoundingClientRect(), listBounds = list.getBoundingClientRect();
        return { documentVisible: document.visibilityState === 'visible', nativeModalOpen: dialog?.matches(':modal') === true,
          chatStillSelected: document.querySelector('#app')?.dataset.view === 'chat',
          messageWithinViewport: bounds.top < Math.min(innerHeight, listBounds.bottom) && bounds.bottom > Math.max(0, listBounds.top) };
      }, message.id);
      assert(Object.values(result.geometry).every(Boolean), 'LOCAL_AI_READ_STATE_OCCLUSION_PRECONDITION');
      result.before = before; result.afterHiddenPoll = await readPosition(); result.newMessageSequence = nextSequence;
      result.modalBlocksRead = true; result.homeUnreadPreserved = true;
      phase = `${width}:CLOSE_AND_READ`;
      await therapist.page.locator('[data-ai-action="close"]').click();
      await therapist.page.locator('.ai-assistant[open]').waitFor({ state: 'detached' });
      await eventually(readPosition, nextSequence);
      assert(therapistReadWrites.length > readWriteCount, 'LOCAL_AI_READ_STATE_CLOSE_WRITE_MISSING');
      result.afterClose = await readPosition(); result.closeAllowsRead = true;
      await workspaceView(therapist.page, 'home');
      await therapist.page.waitForFunction(roomId => {
        const badge = document.querySelector(`[data-home-news] [data-news-room="${roomId}"] .badge`);
        return badge?.classList.contains('badge-empty') && badge.textContent === '';
      }, ids.conversationId);
      assert.equal((await inbox()).unread, 0, code);
      result.homeUnreadCleared = true;
      assert.equal(report.fixtureModelCalls, 0, code);
      assert.deepEqual(report.errors, [], 'LOCAL_AI_READ_STATE_BROWSER_ERRORS');
      assert.deepEqual(report.unexpectedRequests, [], 'LOCAL_AI_READ_STATE_NETWORK_ESCAPE');
      for (const actor of [guardian, therapist]) { await actor.context.close(); contexts.delete(actor.context); }
      await sandbox.close(); assert.equal(sandbox.database.closed, true); assert.equal(sandbox.credentials.length, 0);
      sandboxes.delete(sandbox); result.cleanup = true;
      report.checks.push(result); delete report.currentCheck;
      console.log(JSON.stringify({ width, passed: true, normalPollingObserved: result.normalPollingObserved,
        readBefore: before, readBehindModal: result.afterHiddenPoll, readAfterClose: result.afterClose }));
    }
    report.finalSource = await captureLocalP0StudySources();
    assert.equal(report.finalSource.sha256, source.sha256, 'LOCAL_AI_READ_STATE_SOURCE_CHANGED');
    assert.equal(hash(await readFile(filename)), testSourceSha256, 'LOCAL_AI_READ_STATE_TEST_CHANGED');
  } catch (error) {
    const assertion = error?.message?.split('\n')[0];
    report.failure = { code, phase, kind: ['TimeoutError', 'AssertionError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-ai-read-state-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      assertion: /^LOCAL_(?:AI_READ_STATE|WORKSPACE)_[A-Z_]+$/.test(assertion ?? '') ? assertion : null };
  } finally {
    for (const context of contexts) try { await bounded(context.close()); contexts.delete(context); } catch {}
    report.cleanup.contextsClosed = contexts.size === 0;
    if (browserServer) {
      try { await bounded(browserServer.close()); } catch { try { await bounded(browserServer.kill()); } catch {} }
      report.cleanup.browserStopped = typeof browserProcess?.exitCode === 'number' || typeof browserProcess?.signalCode === 'string';
    }
    for (const sandbox of sandboxes) try {
      await bounded(sandbox.close()); assert.equal(sandbox.database.closed, true); assert.equal(sandbox.credentials.length, 0); sandboxes.delete(sandbox);
    } catch {}
    report.cleanup.sandboxesClosed = sandboxes.size === 0;
    report.finishedAt = new Date().toISOString();
    report.passed = !report.failure && report.checks.length === 2 && report.errors.length === 0 &&
      report.unexpectedRequests.length === 0 && report.fixtureModelCalls === 0 && Object.values(report.cleanup).every(Boolean);
    ownership.finished = Object.values(report.cleanup).every(Boolean); ownership.cleanup = report.cleanup;
    await save('ownership.json', ownership); await save('results.json', report);
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length, failure: report.failure,
    cleanup: report.cleanup, actualModelCalls: 0, fixtureModelCalls: report.fixtureModelCalls }));
  return report.passed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  try { if (!await runLocalAiReadStateBrowser()) process.exitCode = 1; }
  catch { console.error('LOCAL_AI_READ_STATE_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

// Independent current-API reachability check. Never measures a person's task
// time or modifies the pinned A/B material or the existing six-combination run.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TASK_A, studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { createLocalP0StudyFixture } from './local-p0-study-fixture.mjs';
import { captureLocalP0StudySources } from './local-p0-study-browser.mjs';
import { workspaceRoom } from './local-workspace-browser-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), filename = fileURLToPath(import.meta.url);
const code = 'LOCAL_FEEDBACK_VIEWPORT_FAILED';
const sha = value => createHash('sha256').update(value).digest('hex');
const viewports = [{ width: 1280, height: 600, mobile: false }, { width: 1024, height: 576, mobile: false },
  { width: 390, height: 640, mobile: true }, { width: 844, height: 390, mobile: true }];
const assets = new Set(['/', '/favicon.ico', '/local-api/app.js', '/local-api/ai-assistant-ui.js', '/local-api/ai-client.js',
  '/local-api/care-recipient-client.js', '/local-api/client.js', '/local-api/care-client.js', '/local-api/care-ui.js',
  '/local-api/workspace-ui.js', '/local-api/styles.css', '/local-api/media-client.js', '/local-api/media-ui.js',
  '/local-api/media-viewer.js', '/local-api/approval-pending-ui.js', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js']);

async function sources() {
  const original = await captureLocalP0StudySources();
  const files = [...original.files, { name: 'tests/local-feedback-viewport-browser.mjs', sha256: sha(await readFile(filename)) }]
    .sort((a, b) => a.name.localeCompare(b.name));
  return { sha256: sha(JSON.stringify(files)), p0SourceSha256: original.sha256, files };
}
async function bounded(work) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), 15_000); })]); }
  finally { clearTimeout(timer); }
}
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function geometry(dialog, selector) {
  return dialog.evaluate((node, selector) => {
    const form = node.querySelector('[data-care-form="feedback"]'), target = node.querySelector(selector);
    const rectangle = element => {
      const r = element.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const viewport = visualViewport ? { left: visualViewport.offsetLeft, top: visualViewport.offsetTop,
      right: visualViewport.offsetLeft + visualViewport.width, bottom: visualViewport.offsetTop + visualViewport.height,
      scale: visualViewport.scale } : { left: 0, top: 0, right: innerWidth, bottom: innerHeight, scale: 1 };
    const bounds = target ? rectangle(target) : null, clip = { ...viewport };
    for (let parent = target?.parentElement; parent; parent = parent.parentElement) {
      const r = rectangle(parent), style = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
        clip.left = Math.max(clip.left, r.left + parent.clientLeft);
        clip.right = Math.min(clip.right, r.left + parent.clientLeft + parent.clientWidth);
      }
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
        clip.top = Math.max(clip.top, r.top + parent.clientTop);
        clip.bottom = Math.min(clip.bottom, r.top + parent.clientTop + parent.clientHeight);
      }
      // showModal() renders this dialog in the top layer: body/html overflow
      // does not clip it, although its own and its descendants' overflow does.
      if (parent === node) break;
    }
    const visible = !!bounds && target.getClientRects().length > 0 && bounds.width > 0 && bounds.height > 0
      && bounds.left >= clip.left - 1 && bounds.top >= clip.top - 1 && bounds.right <= clip.right + 1 && bounds.bottom <= clip.bottom + 1;
    const dx = bounds && Math.min(8, bounds.width / 4), dy = bounds && Math.min(8, bounds.height / 4);
    const unobscured = visible && [[bounds.left + dx, bounds.top + dy], [bounds.right - dx, bounds.top + dy],
      [bounds.left + dx, bounds.bottom - dy], [bounds.right - dx, bounds.bottom - dy],
      [bounds.left + bounds.width / 2, bounds.top + bounds.height / 2]].every(([x, y]) => {
      const hit = document.elementFromPoint(x, y); return hit === target || target.contains(hit);
    });
    return { viewport: { width: innerWidth, height: innerHeight, ...viewport }, dialog: rectangle(node),
      dialogScrollTop: node.scrollTop, dialogScrollHeight: node.scrollHeight, dialogClientHeight: node.clientHeight,
      pageScrollY: scrollY, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      dialogOverflow: node.scrollWidth > node.clientWidth + 1, open: node.open === true,
      target: { bounds, visible, unobscured, focused: target === document.activeElement, formOwned: target?.form === form,
        disabled: target?.disabled === true, type: target?.type ?? null } };
  }, selector);
}
function assertTarget(observed, { button = false } = {}) {
  assert(observed.open && !observed.pageOverflow && !observed.dialogOverflow, code);
  assert(observed.dialog.top >= -1 && observed.dialog.bottom <= observed.viewport.height + 1, code);
  assert(observed.target.visible && observed.target.unobscured && observed.target.focused, code);
  assert(observed.target.formOwned && !observed.target.disabled, code);
  if (button) assert(observed.target.type === 'submit' && observed.target.bounds.height >= 43.5, code);
}

export async function runLocalFeedbackViewportBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const file of [options.module, options.executable]) assert((await lstat(file)).isFile(), code);
  const { chromium } = await import(pathToFileURL(options.module).href), source = await sources();
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-feedback-viewport-${runId}`);
  await mkdir(folder);
  const report = { runId, at: new Date().toISOString(), source, passed: false, checks: [], screenshots: [], errors: [], unexpectedRequests: [],
    humanMetricsCollected: false, humanTaskCompletion: false, failure: null,
    cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Current local-api with fresh synthetic P0 A fixture; no pinned baseline UI or participant performance claim.',
      'Headless Chrome viewport/keyboard/wheel only; not physical mobile keyboards, native display zoom or an accessibility audit.',
      'Memory-only PGlite and owned loopback HTTP; no E drive, Docker, attachments, external AI or production access.',
      'Saved feedback survives page reload; API process restart and unsaved draft durability are not tested.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, origins: [], finished: false };
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2));
  const contexts = new Set(), sandboxes = new Set();
  let browserServer, browserProcess, browser, phase = 'STARTUP', activePage;
  await save('ownership.json', ownership);
  try {
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable, host: '127.0.0.1', port: 0,
      env: studyChildEnvironment(), timeout: 30_000 });
    browserProcess = browserServer.process(); ownership.browserProcessId = browserProcess.pid; await save('ownership.json', ownership);
    browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    for (const viewport of viewports) {
      const label = `${viewport.width}x${viewport.height}`; phase = `${label}:SETUP`;
      const fixture = await createLocalP0StudyFixture('A', { port: 0 }), { sandbox, publication } = fixture;
      sandboxes.add(sandbox); const { origin, ids } = sandbox, roomId = fixture.rooms[0].conversationId;
      assert.equal(new URL(origin).hostname, '127.0.0.1', code);
      ownership.origins.push(origin); await save('ownership.json', ownership);
      const center = `/api/local/centers/${ids.centerId}`, base = `${center}/conversations/${roomId}`, writes = [];
      const result = { ...viewport, baselineSeedUnchanged: false, collapsedKeyboard: false, expandedKeyboard: false,
        wheelAccessible: false, stored: false, reloadPreserved: false, inputTabClipping: [], geometry: [], cleanup: false };
      report.currentCheck = result;
      const initialRecord = (await sandbox.database.query('SELECT to_jsonb(r) AS value FROM cb_records r ORDER BY id')).rows;
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height },
        locale: 'ko-KR', timezoneId: 'Asia/Seoul', isMobile: viewport.mobile, hasTouch: viewport.mobile,
        permissions: [], serviceWorkers: 'block', acceptDownloads: false }); contexts.add(context);
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), method = request.method();
        const read = ['GET', 'HEAD'].includes(method);
        const auth = /^\/api\/local\/auth\/(?:login|session|logout)$/.test(url.pathname);
        const suffix = url.pathname.startsWith(base + '/') ? url.pathname.slice(base.length) : '';
        const roomRead = /^\/(?:profile|messages(?:\/[A-Za-z0-9_-]+)?|goals|appointments|feedback\/[A-Za-z0-9_-]+)$/.test(suffix);
        const feedbackWrite = method === 'POST' && /^\/feedback\/[A-Za-z0-9_-]+$/.test(suffix);
        const allowed = read && (assets.has(url.pathname) || auth || url.pathname === `${center}/inbox`
          || url.pathname === `${center}/primary-communicator` && url.searchParams.get('conversationId') === roomId || roomRead)
          || method === 'POST' && (url.pathname === '/api/local/auth/login' || url.pathname === '/api/local/auth/logout' || suffix === '/read')
          || feedbackWrite;
        if (url.origin !== origin || !allowed) {
          report.unexpectedRequests.push({ phase, method, sameOrigin: url.origin === origin }); return route.abort();
        }
        if (feedbackWrite) writes.push({ id: suffix.split('/').at(-1), body: request.postDataJSON() });
        return route.continue();
      });
      if (context.routeWebSocket) await context.routeWebSocket('**/*', socket => {
        report.unexpectedRequests.push({ phase, type: 'websocket' }); socket.close();
      });
      const page = activePage = await context.newPage(); page.setDefaultTimeout(15_000);
      page.on('pageerror', () => report.errors.push({ phase, type: 'pageerror' }));
      const dialog = page.getByTestId('care-dialog'), field = name => dialog.locator(`[name="${name}"]`);
      const screenshot = async stage => {
        const name = `${label}-${stage}.png`;
        await page.screenshot({ path: path.join(folder, name), mask: [page.locator('input[type="password"]'), page.locator('input[type="email"]')] });
        report.screenshots.push(name);
      };
      const observe = async (stage, selector, options = {}) => {
        phase = `${label}:${stage}`; await settle(page);
        const value = await geometry(dialog, selector); result.geometry.push({ stage, ...value });
        assertTarget(value, options); return value;
      };
      const tabTo = async (selector, { reverse = false } = {}) => {
        for (let n = 0; n < 30; n++) {
          if (await dialog.locator(selector).evaluate(node => node === document.activeElement)) return;
          await page.keyboard.press(reverse ? 'Shift+Tab' : 'Tab');
        }
        assert.fail(code);
      };
      const readFeedback = async id => {
        const response = await context.request.get(`${origin}${base}/feedback/${id}`, {
          headers: { 'X-Carebridge-Account': ids.guardianId }, maxRedirects: 0, timeout: 15_000 });
        try { assert.equal(response.status(), 200, code); return (await response.json()).message; }
        finally { await response.dispose(); }
      };
      const credential = sandbox.credentials.find(item => item.role === 'guardian');
      await page.goto(origin); await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
      await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
      await page.getByRole('button', { name: '로그인', exact: true }).click();
      await workspaceRoom(page, roomId);
      await page.locator(`[data-publication-id="${publication.publicationId}"] [data-care-action="feedback"]`).click();
      await dialog.locator('[data-care-form="feedback"]').waitFor();
      const submit = '[data-care-form="feedback"] button[type="submit"]';
      result.entry = await geometry(dialog, submit); await screenshot('entry');
      assert.equal(await dialog.locator('[data-feedback-activity]').getAttribute('open'), null, code);
      for (const [name, value] of Object.entries({ date: fixture.day, ...TASK_A })) {
        const selector = `[name="${name}"]`;
        await tabTo(selector); await settle(page);
        const tabPosition = await geometry(dialog, selector);
        if (!tabPosition.target.visible || !tabPosition.target.unobscured) {
          // Native focus may reveal only the caret line of a textarea. Record
          // that clipping separately; a successful wheel recovery must not be
          // reported as a fully visible keyboard-only route.
          result.inputTabClipping.push({ field: name, geometry: tabPosition });
          for (let n = 0; n < 10; n++) {
            const current = await geometry(dialog, selector);
            if (current.target.visible && current.target.unobscured) break;
            const direction = current.target.bounds.top < current.dialog.top ? -1 : 1;
            await page.mouse.move(current.dialog.left + 10, (current.dialog.top + current.dialog.bottom) / 2);
            await page.mouse.wheel(0, direction * 80);
            await page.waitForFunction(before => Math.abs(document.querySelector('[data-testid="care-dialog"]').scrollTop - before) > 1,
              current.dialogScrollTop, { timeout: 5_000 });
          }
        }
        await observe(`INPUT_${name.toUpperCase()}`, selector);
        if (name === 'result') await page.keyboard.press('ArrowDown');
        else if (name === 'date') await field(name).fill(value);
        else { await page.keyboard.press('Control+A'); await page.keyboard.insertText(value); }
        assert.equal(await field(name).inputValue(), value, code);
      }
      await tabTo(submit); await observe('COLLAPSED_TAB_SAVE', submit, { button: true });
      await screenshot('collapsed-keyboard-save'); result.collapsedKeyboard = true;
      await tabTo('[data-feedback-activity] > summary', { reverse: true }); await page.keyboard.press('Enter');
      assert.notEqual(await dialog.locator('[data-feedback-activity]').getAttribute('open'), null, code);
      await tabTo(submit); const focused = await observe('EXPANDED_TAB_SAVE', submit, { button: true });
      await screenshot('expanded-keyboard-save'); result.expandedKeyboard = true;
      assert(focused.dialogScrollTop > 0 && focused.dialogScrollHeight > focused.dialogClientHeight, code);
      // Exercise a real scroll away from and back to the target. Never assign
      // scrollTop or rely on Playwright's click/scrollIntoView correction.
      phase = `${label}:WHEEL_SCROLL`;
      await page.mouse.move(focused.dialog.left + 10, (focused.dialog.top + focused.dialog.bottom) / 2);
      await page.mouse.wheel(0, -240);
      await page.waitForFunction(before => document.querySelector('[data-testid="care-dialog"]').scrollTop < before - 1,
        focused.dialogScrollTop, { timeout: 5_000 });
      const wheelStart = await geometry(dialog, submit); result.geometry.push({ stage: 'WHEEL_UP', ...wheelStart });
      for (let n = 0; n < 12; n++) {
        const value = await geometry(dialog, submit);
        if (value.target.visible && value.target.unobscured) break;
        const previous = value.dialogScrollTop;
        await page.mouse.wheel(0, 160);
        await page.waitForFunction(before => document.querySelector('[data-testid="care-dialog"]').scrollTop > before + 1,
          previous, { timeout: 5_000 });
      }
      const wheelEnd = await observe('WHEEL_SAVE', submit, { button: true });
      assert(wheelEnd.dialogScrollTop > wheelStart.dialogScrollTop, code);
      assert.equal(wheelEnd.pageScrollY, focused.pageScrollY, code); result.wheelAccessible = true;
      await screenshot('wheel-save'); assert.equal(writes.length, 0, code);
      phase = `${label}:ENTER_SAVE`;
      const [response] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).origin === origin && response.request().method() === 'POST'
          && new RegExp(`^${base}/feedback/[A-Za-z0-9_-]+$`).test(new URL(response.url()).pathname)),
        page.keyboard.press('Enter'),
      ]);
      assert.equal(response.status(), 201, code); const receipt = (await response.json()).receipt;
      assert.equal(receipt.revision, 1, code); assert.equal(receipt.replayed, false, code);
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(writes.length, 1, code); assert.equal(writes[0].id, receipt.feedbackId, code);
      assert.equal(writes[0].body.sourceMessageId, publication.messageId, code);
      assert.deepEqual(writes[0].body.content, { date: fixture.day, ...TASK_A }, code);
      const stored = await readFeedback(receipt.feedbackId);
      assert.equal(stored.id, receipt.messageId, code); assert.equal(stored.feedback.publicationId, publication.publicationId, code);
      for (const [key, value] of Object.entries({ date: fixture.day, ...TASK_A })) assert.equal(stored.feedback[key], value, code);
      result.stored = true; phase = `${label}:RELOAD`;
      await page.reload(); await page.getByTestId('home').waitFor(); await workspaceRoom(page, roomId);
      await page.locator(`[data-feedback-id="${receipt.feedbackId}"] [data-care-action="edit-feedback"]`).click();
      await dialog.locator('[data-care-form="feedback"]').waitFor();
      for (const [key, value] of Object.entries({ date: fixture.day, ...TASK_A })) assert.equal(await field(key).inputValue(), value, code);
      assert.deepEqual((await readFeedback(receipt.feedbackId)).feedback, stored.feedback, code);
      assert.equal(writes.length, 1, code); await screenshot('reopened'); result.reloadPreserved = true;
      assert.deepEqual((await sandbox.database.query('SELECT to_jsonb(r) AS value FROM cb_records r ORDER BY id')).rows, initialRecord, code);
      result.baselineSeedUnchanged = true;
      await context.close(); contexts.delete(context); activePage = null;
      await sandbox.close(); assert.equal(sandbox.database.closed, true); sandboxes.delete(sandbox);
      result.cleanup = true; report.checks.push(result); delete report.currentCheck;
      console.log(JSON.stringify({ viewport: label, passed: true, stored: true, humanMetricsCollected: false }));
    }
    report.finalSource = await sources(); assert.equal(report.finalSource.sha256, source.sha256, code);
  } catch (error) {
    report.failure = { code, phase, kind: ['TimeoutError', 'AssertionError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-feedback-viewport-browser\.mjs:(\d+):\d+/)?.[1]) || null };
    if (activePage) try {
      await bounded(activePage.screenshot({ path: path.join(folder, 'failure.png'),
        mask: [activePage.locator('input[type="password"]'), activePage.locator('input[type="email"]')] }));
      report.screenshots.push('failure.png');
    } catch {}
  } finally {
    for (const context of contexts) try { await bounded(context.close()); contexts.delete(context); } catch {}
    report.cleanup.contextsClosed = contexts.size === 0;
    if (browserServer) {
      try { await bounded(browserServer.close()); } catch { try { await bounded(browserServer.kill()); } catch {} }
      report.cleanup.browserStopped = typeof browserProcess?.exitCode === 'number' || typeof browserProcess?.signalCode === 'string';
    }
    if (report.cleanup.browserStopped) for (const sandbox of sandboxes) try {
      await bounded(sandbox.close()); assert.equal(sandbox.database.closed, true); sandboxes.delete(sandbox);
    } catch {}
    report.cleanup.sandboxesClosed = sandboxes.size === 0; report.finishedAt = new Date().toISOString();
    report.passed = !report.failure && report.checks.length === viewports.length && !report.errors.length && !report.unexpectedRequests.length
      && Object.values(report.cleanup).every(Boolean);
    ownership.finished = Object.values(report.cleanup).every(Boolean); ownership.cleanup = report.cleanup;
    await save('ownership.json', ownership); await save('results.json', report);
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length, failure: report.failure, cleanup: report.cleanup }));
  return report.passed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  try { if (!await runLocalFeedbackViewportBrowser()) process.exitCode = 1; }
  catch { console.error('LOCAL_FEEDBACK_VIEWPORT_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

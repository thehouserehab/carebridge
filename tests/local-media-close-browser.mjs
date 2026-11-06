// Current CareUi + MediaViewer in a deliberately narrow browser fixture.
// A real authenticated message GET is held before its response is delivered.
// Closing before validation tests UI cancellation, NOT prepared-file delivery.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLocalApiSandbox } from '../server/local-api-sandbox.mjs';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const code = 'LOCAL_MEDIA_CLOSE_FAILED';
const hash = value => createHash('sha256').update(value).digest('hex');
async function snapshot() {
  const files = [];
  for (const name of ['tests/local-media-close-browser.mjs', 'local-api/app.js', 'local-api/media-viewer.js',
    'local-api/care-ui.js', 'local-api/care-client.js', 'local-api/client.js', 'local-api/workspace-ui.js', 'local-api/styles.css'])
    files.push({ name, sha256: hash(await readFile(path.join(root, name))) });
  return { files, sha256: hash(JSON.stringify(files)) };
}
async function bounded(work, milliseconds = 20000) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(code)), milliseconds);
  })]); } finally { clearTimeout(timer); }
}
export async function runLocalMediaCloseBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const filename of [options.module, options.executable]) assert((await lstat(filename)).isFile(), code);
  const { chromium } = await import(pathToFileURL(options.module).href);
  const source = await snapshot(), appSource = await readFile(path.join(root, 'local-api/app.js'), 'utf8');
  const hook = appSource.match(/function restoreCareAfterMediaClose\(source\) \{[\s\S]*?\n\}/)?.[0] ?? null;
  if (hook) assert.match(appSource, /onClose: restoreCareAfterMediaClose/);
  const hookModule = `export function createCloseHook(care, getMediaContext) {\n${hook ?? ''}\nreturn ${hook ? 'restoreCareAfterMediaClose' : 'undefined'};\n}`;
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-media-close-${runId}`);
  await mkdir(folder);
  const report = { runId, source, passed: false, checks: [], errors: [], unexpectedRequests: [],
    cleanup: { contextsClosed: false, browserStopped: false, sandboxClosed: false, privateRootRemoved: false },
    limitations: ['Isolated current-module fixture with the exact app close callback in a test-only same-origin module, not full workspace navigation. No eval or CSP relaxation.',
      'Real authenticated HTTP message metadata is withheld. No attachment metadata, bytes, prepared mode, success response or authorization is fabricated.',
      'The synthetic message has no attachment: cancellation happens before validation; this is not playback or delivery evidence.',
      'Memory-only PGlite and owned Chromium at 320/390/1440 widths; no E drive, Docker, actual data, device or deployment.'] };
  const owner = { runId, testProcessId: process.pid, browserProcessId: null, origin: null, finished: false };
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2));
  let sandbox, server, browser, context, gate = null, phase = 'START';
  const pending = new Set();
  await save('ownership.json', owner);
  try {
    sandbox = await createLocalApiSandbox(); owner.origin = sandbox.origin;
    server = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment() });
    owner.browserProcessId = server.process().pid; await save('ownership.json', owner);
    browser = await chromium.connect(server.wsEndpoint());
    for (const width of [320, 390, 1440]) {
      phase = `${width}:SETUP`;
      context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR',
        isMobile: width <= 640, hasTouch: width <= 640, serviceWorkers: 'block', acceptDownloads: false, permissions: [] });
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === sandbox.origin && url.pathname === '/__test__/media-close-hook.js' && request.method() === 'GET')
          return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: hookModule });
        const allowed = url.origin === sandbox.origin && ['GET', 'POST'].includes(request.method()) &&
          (url.pathname.startsWith('/api/local/') || /^\/(?:local-api\/[a-z-]+\.(?:js|css)|src\/[a-z-]+\.js)$/.test(url.pathname));
        if (!allowed) { report.unexpectedRequests.push({ phase }); return route.abort(); }
        const task = (async () => {
          if (gate && request.method() === 'GET' && url.pathname === gate.pathname) {
            const current = gate;
            try {
              const response = await route.fetch();
              current.status = response.status(); current.hit.resolve();
              await current.release.promise;
              // The UI has cancelled its request by now. Never turn cancellation
              // into a synthetic successful file/metadata response.
              await route.abort('aborted');
            } finally { current.done.resolve(); }
          } else await route.continue();
        })();
        pending.add(task); task.finally(() => pending.delete(task)).catch(() => {}); return task;
      });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      page.on('pageerror', () => report.errors.push({ phase }));
      // This same-origin document contains no app timers or synthetic state
      // injection into the production application. Only the fixture owns it.
      await page.goto(`${sandbox.origin}/local-api/media-viewer.js`);
      await page.setContent('<!doctype html><html lang="ko"><head><link rel="stylesheet" href="/local-api/styles.css"></head><body><main><button id="opener">합성 첨부 열기</button><div id="care"></div><div id="viewer"></div></main></body></html>');
      const credential = sandbox.credentials.find(value => value.role === 'therapist');
      phase = `${width}:MODULE_SETUP`;
      const messagePath = await page.evaluate(async ({ credential, ids }) => {
        const { CareApiClient } = await import('/local-api/care-client.js');
        const { CareUi } = await import('/local-api/care-ui.js');
        const { MediaViewer } = await import('/local-api/media-viewer.js');
        const { workspacePeriod } = await import('/local-api/workspace-ui.js');
        const { createCloseHook } = await import('/__test__/media-close-hook.js');
        const api = new CareApiClient(), user = await api.login(credential.email, credential.password);
        const next = await api.careWorkspace(ids.centerId, ids.conversationId, { role: 'therapist', ...workspacePeriod() });
        const lifetime = new AbortController();
        let current = { user, centerId: ids.centerId, roomId: ids.conversationId, profile: next.profile, messages: next.messages,
          careData: next.rooms.find(room => room.conversationId === ids.conversationId).care, panelMode: 'compact',
          generation: 1, signal: lifetime.signal, connected: true, role: 'therapist', enabled: true, visible: true };
        const getContext = () => current, getMediaContext = () => current;
        const care = new CareUi({ api, getContext }); care.bind(document.querySelector('#care')); care.update();
        const onClose = createCloseHook(care, getMediaContext);
        const viewer = new MediaViewer({ api, mediaApi: { openMessageAttachment() { throw Error('UNEXPECTED_CONTENT_READ'); } },
          getContext: getMediaContext, ...(onClose ? { onClose } : {}), onError: () => { throw Error('UNEXPECTED_VIEWER_ERROR'); } });
        viewer.bind(document.querySelector('#viewer'));
        const messageId = next.messages[0].id;
        document.querySelector('#opener').addEventListener('click', () => {
          care.suspend(); window.__mediaClosePending = viewer.open(messageId, '12345678-1234-4234-8234-123456789abc');
        });
        window.__mediaCloseFixture = { invalidate() { current = { ...current, generation: current.generation + 1, connected: false }; },
          clear() { lifetime.abort(); viewer.clear(); care.clear(); } };
        return `/api/local/centers/${ids.centerId}/conversations/${ids.conversationId}/messages/${messageId}`;
      }, { credential, ids: sandbox.ids });
      const action = page.locator('#care [data-care-action="new-record"]');
      assert(await action.isEnabled(), code);
      for (const boundary of ['normal', 'generation']) {
        phase = `${width}:${boundary}`;
        gate = { pathname: messagePath, hit: Promise.withResolvers(), release: Promise.withResolvers(), done: Promise.withResolvers(), status: null };
        await page.locator('#opener').click(); await bounded(gate.hit.promise); assert.equal(gate.status, 200, code);
        assert.equal(await action.count(), 0, code);
        if (boundary === 'generation') await page.evaluate(() => window.__mediaCloseFixture.invalidate());
        await page.locator('[data-media-viewer-close]').click();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const after = { width, boundary, realMetadataStatus: gate.status, actionCount: await action.count(),
          enabled: await action.count() === 1 ? await action.isEnabled() : false,
          focusReturned: await page.locator('#opener').evaluate(node => node === document.activeElement),
          dialogCount: await page.locator('[data-testid="media-viewer"]').count() };
        report.checks.push(after);
        assert.equal(after.actionCount, boundary === 'normal' ? 1 : 0, code);
        assert.equal(after.enabled, boundary === 'normal', code); assert.equal(after.dialogCount, 0, code);
        if (boundary === 'normal') assert(after.focusReturned, code);
        gate.release.resolve(); await bounded(gate.done.promise); gate = null;
        assert.equal(await page.evaluate(() => window.__mediaClosePending), false, code);
      }
      await page.evaluate(() => { window.__mediaCloseFixture.clear(); delete window.__mediaCloseFixture; delete window.__mediaClosePending; });
      await context.close(); context = null;
    }
    report.sourceAfter = await snapshot(); assert.equal(report.sourceAfter.sha256, source.sha256, code);
    assert.equal(report.errors.length + report.unexpectedRequests.length, 0, code); report.passed = true;
  } catch (error) { report.failure = { phase, code,
    category: ['Error', 'AssertionError', 'TimeoutError', 'TypeError'].includes(error?.name) ? error.name : 'Other',
    cspBlocked: /Content Security Policy|unsafe-eval|content security policy/.test(error?.message ?? '') }; }
  finally {
    try {
      gate?.release.resolve(); if (pending.size) await bounded(Promise.allSettled([...pending]));
      await bounded(context?.close()); report.cleanup.contextsClosed = true;
      await bounded(browser?.close()); await bounded(server?.close()); report.cleanup.browserStopped = true;
      await bounded(sandbox?.close()); report.cleanup.sandboxClosed = true;
      if (sandbox) await assert.rejects(lstat(sandbox.mediaRoot), { code: 'ENOENT' }); report.cleanup.privateRootRemoved = true;
    } catch { report.passed = false; report.cleanupFailure = true; }
    owner.finished = Object.values(report.cleanup).every(Boolean); await save('ownership.json', owner); await save('results.json', report);
  }
  process.stdout.write(JSON.stringify({ runId, passed: report.passed, checks: report.checks, failure: report.failure, cleanup: report.cleanup }) + '\n');
  if (!report.passed) process.exitCode = 1;
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runLocalMediaCloseBrowser();

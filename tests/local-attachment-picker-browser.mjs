// UI-only prepared-state doubles plus a separate real, attachment-free save.
// Never treat the synthetic readiness responses as inspection or delivery proof.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TASK_A, studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { createLocalP0StudyFixture } from './local-p0-study-fixture.mjs';
import { workspaceRoom } from './local-workspace-browser-helpers.mjs';
import { syntheticVideoBytes } from './browser-media-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const code = 'LOCAL_ATTACHMENT_PICKER_BROWSER_FAILED';
const hash = value => createHash('sha256').update(value).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=', 'base64');
const assets = new Set(['/', '/favicon.ico', '/local-api/app.js', '/local-api/ai-assistant-ui.js', '/local-api/ai-client.js',
  '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/client.js', '/local-api/care-client.js',
  '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/media-client.js', '/local-api/media-ui.js',
  '/local-api/media-viewer.js', '/local-api/styles.css', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js']);

async function sources() {
  const names = ['tests/local-attachment-picker-browser.mjs', 'tests/local-p0-study-fixture.mjs',
    'tests/local-workspace-browser-helpers.mjs', 'tests/browser-media-fixture.mjs', 'tests/message-browser-policy.mjs',
    'scripts/p0-study-policy.mjs'];
  for (const directory of ['local-api', 'src', 'server', 'server/migrations', 'server/schema-proposals']) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), code);
      if (entry.isFile() && /\.(?:mjs|js|css|html|sql)$/.test(entry.name)) names.push(`${directory}/${entry.name}`);
    }
  }
  const files = [];
  for (const name of [...new Set(names)].sort()) files.push({ name, sha256: hash(await readFile(path.join(root, name))) });
  return { sha256: hash(JSON.stringify(files)), files };
}

async function until(check) {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('LOCAL_ATTACHMENT_PICKER_CONDITION_TIMEOUT');
}

async function bounded(work) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('LOCAL_ATTACHMENT_PICKER_CLEANUP_TIMEOUT')), 30_000);
  })]); } finally { clearTimeout(timer); }
}

async function keyboardReach(page, from, target) {
  await from.focus();
  for (let count = 0; count <= 35; count++) {
    if (await target.evaluate(node => document.activeElement === node)) {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await target.evaluate(node => {
        const rect = node.getBoundingClientRect(), dialog = node.closest('dialog'), modal = dialog.getBoundingClientRect();
        const view = visualViewport, left = view?.offsetLeft ?? 0, top = view?.offsetTop ?? 0;
        const right = left + (view?.width ?? innerWidth), bottom = top + (view?.height ?? innerHeight);
        const points = [[rect.left + 8, rect.top + 8], [rect.right - 8, rect.top + 8],
          [rect.left + 8, rect.bottom - 8], [rect.right - 8, rect.bottom - 8],
          [rect.left + rect.width / 2, rect.top + rect.height / 2]];
        const hits = points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit === node || node.contains(hit); });
        let clipped = false;
        for (let parent = node.parentElement; parent && parent !== dialog; parent = parent.parentElement) {
          const style = getComputedStyle(parent), bound = parent.getBoundingClientRect();
          const clipX = /auto|scroll|hidden|clip/.test(style.overflowX), clipY = /auto|scroll|hidden|clip/.test(style.overflowY);
          clipped ||= clipX && (rect.left < bound.left + parent.clientLeft - 1 || rect.right > bound.left + parent.clientLeft + parent.clientWidth + 1)
            || clipY && (rect.top < bound.top + parent.clientTop - 1 || rect.bottom > bound.top + parent.clientTop + parent.clientHeight + 1);
        }
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
          focused: document.activeElement === node, hitPoints: hits, clipped,
          reachable: rect.width >= 44 && rect.height >= 43.5 && rect.left >= Math.max(left, modal.left) - 1
            && rect.top >= Math.max(top, modal.top) - 1 && rect.right <= Math.min(right, modal.right) + 1
            && rect.bottom <= Math.min(bottom, modal.bottom) + 1 && hits.every(Boolean) && !clipped,
          pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, tabSteps: 0 };
      });
      geometry.tabSteps = count;
      assert(geometry.focused && geometry.reachable && geometry.pageWidth <= geometry.viewportWidth + 1,
        JSON.stringify({ code: 'LOCAL_ATTACHMENT_PICKER_HIT_AREA', geometry }));
      return geometry;
    }
    await page.keyboard.press('Tab');
  }
  assert.fail('LOCAL_ATTACHMENT_PICKER_KEYBOARD_TARGET');
}

export async function runLocalAttachmentPickerBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args), source = await sources();
  for (const filename of [options.module, options.executable]) {
    const info = await lstat(filename); assert(info.isFile() && !info.isSymbolicLink(), code);
  }
  const { chromium } = await import(pathToFileURL(options.module).href);
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-attachment-picker-${runId}`);
  await mkdir(folder);
  const report = { runId, source, passed: false, checks: [], screenshots: [], errors: [], unexpectedRequests: [],
    cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false, privateRootsRemoved: false },
    limitations: [
      'The exact owned document marker and upload responses are explicit UI fixtures; the real server remains quarantine-only.',
      'Pending/quarantined/ready/cancel responses are fabricated UI states. No malware inspection, decoder, worker, file storage, binding, playback or attachment delivery is verified.',
      'Native chooser events and empty chooser returns are observed in headless Chromium; this is not an operating-system dialog or physical-device cancellation test.',
      'Only attachment-free feedback uses the real authenticated HTTP service and memory-only database; its successful save is reported separately.',
      '320/390/1440 by 420, 390 by 640 and 1280 by 600 CSS-pixel viewports are not physical mobile keyboard or human usability evidence. No human task timing is collected.',
      'No E drive, Docker, actual records, external API, paid call, deployment or existing user browser is used.',
    ] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, finished: false };
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  const contexts = new Set(), sandboxes = new Set(), mediaRoots = new Set(), pendingRoutes = new Set();
  let server, browser, phase = 'START', closing = false;
  await save('ownership.json', ownership);
  try {
    server = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    ownership.browserProcessId = server.process().pid; await save('ownership.json', ownership);
    browser = await chromium.connect(server.wsEndpoint()); report.browserVersion = browser.version();
    for (const [width, height] of [[320, 420], [390, 420], [1440, 420], [390, 640], [1280, 600]]) {
      phase = `${width}x${height}:SETUP`;
      const fixture = await createLocalP0StudyFixture('A'), { sandbox, publication, day } = fixture;
      sandboxes.add(sandbox); mediaRoots.add(sandbox.mediaRoot);
      const { ids, origin, database } = sandbox, base = `/api/local/centers/${ids.centerId}/conversations/${ids.conversationId}`;
      const context = await browser.newContext({ viewport: { width, height }, locale: 'ko-KR', timezoneId: 'Asia/Seoul',
        isMobile: width <= 640, hasTouch: width <= 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
      contexts.add(context);
      const uploads = new Map(), writes = [], fixtureRequests = [], messagePosts = [];
      let allowReady = false, documentFixtures = 0;
      const dto = item => ({ mode: 'prepared-delivery', source: { name: item.file.name, type: item.file.type, size: item.file.size },
        upload: { id: item.id, conversationId: ids.conversationId, name: item.file.name, type: item.file.type,
          size: item.file.size, state: item.state, version: item.version, failureCode: null,
          expiresAt: item.expiresAt, expired: false } });
      await context.route('**/*', route => {
        const work = (async () => {
          if (closing) return route.abort().catch(() => {});
          const request = route.request(), url = new URL(request.url()), method = request.method();
          const pathname = url.pathname, part = pathname.startsWith(base + '/') ? pathname.slice(base.length) : '';
          if (url.origin === origin && method === 'POST' && part === '/messages') {
            messagePosts.push({ phase });
            assert.fail('LOCAL_ATTACHMENT_PICKER_UNEXPECTED_MESSAGE_SEND');
          }
          const asset = method === 'GET' && !url.search && assets.has(pathname);
          const auth = (method === 'GET' && pathname === '/api/local/auth/session') ||
            (method === 'POST' && ['/api/local/auth/login', '/api/local/auth/logout'].includes(pathname));
          const centerRead = method === 'GET' && (pathname === `/api/local/centers/${ids.centerId}/inbox` ||
            pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
            [...url.searchParams].length === 1 && url.searchParams.get('conversationId') === ids.conversationId);
          const roomRead = method === 'GET' && /^\/(?:profile|goals|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+)?|feedback\/[A-Za-z0-9_-]+)$/.test(part);
          const feedbackPost = method === 'POST' && /^\/feedback\/[A-Za-z0-9_-]+$/.test(part);
          const ordinaryPost = method === 'POST' && part === '/read';
          const uploadCollection = method === 'POST' && part === '/uploads' && !url.search;
          const uploadMatch = part.match(/^\/uploads\/([a-f0-9-]{36})(?:\/(content|cancel))?$/);
          const uploadItem = uploadMatch && uploads.has(uploadMatch[1]) && !url.search &&
            ((!uploadMatch[2] && method === 'GET') || (['content', 'cancel'].includes(uploadMatch[2]) && method === 'POST'));
          if (url.origin !== origin || !(asset || auth || centerRead || roomRead || feedbackPost || ordinaryPost || uploadCollection || uploadItem)) {
            report.unexpectedRequests.push({ width, phase, method, sameOrigin: url.origin === origin });
            return route.abort();
          }
          if (asset && pathname === '/') {
            const response = await route.fetch(), body = await response.text();
            assert.equal(response.status(), 200, code);
            // The real sandbox also adds email/recovery attributes to <html>.
            // Replace only this exact existing attribute; preserve every other byte.
            const marker = 'data-media-mode="quarantine-only"';
            assert.equal(body.split(marker).length, 2, code); documentFixtures++;
            return route.fulfill({ response, body: body.replace(marker, 'data-media-mode="prepared-delivery"') });
          }
          if (uploadCollection) {
            const body = request.postDataJSON(); assert.deepEqual(Object.keys(body).sort(), ['clientId', 'file'], code);
            assert.equal(typeof body.file.sha256, 'string', code);
            const item = { id: randomUUID(), file: body.file, state: 'pending', version: 1,
              expiresAt: new Date(Date.now() + 600_000).toISOString() };
            uploads.set(item.id, item); fixtureRequests.push('reserve-pending');
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dto(item)) });
          }
          if (uploadItem) {
            const item = uploads.get(uploadMatch[1]), action = uploadMatch[2];
            if (action === 'content') {
              assert.equal(item.state, 'pending', code);
              const bytes = request.postDataBuffer(); assert.equal(bytes.length, item.file.size, code);
              assert.equal(hash(bytes), item.file.sha256, code); item.state = 'quarantined'; item.version++;
              fixtureRequests.push('receive-quarantined');
            } else if (action === 'cancel') {
              assert.equal(request.postDataJSON().expectedVersion, item.version, code);
              item.state = 'deleted'; item.version++; fixtureRequests.push('cancel-deleted');
            } else if (allowReady && item.state === 'quarantined') {
              item.state = 'ready'; item.version++; fixtureRequests.push('get-ready');
            }
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dto(item)) });
          }
          if (feedbackPost) {
            const body = request.postDataJSON();
            // Never forward a fabricated ready identifier to the real service.
            assert.deepEqual(body.content.attachments ?? [], [], code);
            writes.push({ id: part.split('/').at(-1), body });
          }
          return route.continue();
        })().catch(async () => {
          if (!closing) report.errors.push({ width, phase, kind: 'route' });
          await route.abort().catch(() => {});
        });
        pendingRoutes.add(work); void work.finally(() => pendingRoutes.delete(work)); return work;
      });
      const page = await context.newPage(); page.setDefaultTimeout(12_000);
      page.on('pageerror', () => report.errors.push({ width, phase, kind: 'page' }));
      const credential = sandbox.credentials.find(item => item.role === 'guardian');
      await page.goto(origin); await page.locator('#email').fill(credential.email); await page.locator('#password').fill(credential.password);
      await page.getByTestId('login-form').locator('button[type="submit"]').click(); await workspaceRoom(page, ids.conversationId);
      await page.locator(`[data-publication-id="${publication.publicationId}"] [data-care-action="feedback"]`).click();
      const dialog = page.getByTestId('care-dialog'); await dialog.waitFor();
      const values = { date: day, ...TASK_A }, input = name => dialog.locator(`[name="${name}"]`);
      for (const [name, value] of Object.entries(values)) {
        if (name === 'result') await input(name).selectOption(value); else await input(name).fill(value);
      }
      const host = dialog.locator('[data-feedback-upload]'), picker = host.locator('[data-media-pick]');
      const rows = host.getByTestId('media-upload-row'), submit = dialog.locator('button[type="submit"]');
      const assertDraft = async () => { for (const [name, value] of Object.entries(values)) assert.equal(await input(name).inputValue(), value, code); };
      const selection = () => rows.evaluateAll(nodes => nodes.map(node => ({ id: node.dataset.mediaId, name: node.querySelector('.media-file-name').textContent })));
      const choose = async files => {
        const event = page.waitForEvent('filechooser'); await picker.click(); const chooser = await event;
        assert.equal(chooser.isMultiple(), true, code); await chooser.setFiles(files);
      };
      const photo = { name: 'picker-synthetic.png', mimeType: 'image/png', buffer: png };
      const video = { name: 'picker-synthetic.webm', mimeType: 'video/webm', buffer: syntheticVideoBytes() };
      const result = { width, height, nativeChooser: false, multiple: false, emptyReturnPreserves: false,
        sameFileReselected: false, unreadyBlocksPost: false, syntheticReadyEnables: false, textSave: false,
        reloadPreservesText: false, noRealUploadOrBinding: false, chatSelectionBlocksSend: false,
        chatEmptyReturnPreserves: false, chatRemovalRestoresSend: false, compactInputsHiddenFromAccessibility: false, geometry: [] };
      phase = `${width}x${height}:DIRECT_PICKER`;
      assert.equal(await host.locator('input[type="file"]').count(), 1, code);
      assert.equal(await host.locator('input[type="file"]').getAttribute('aria-hidden'), 'true', code);
      assert.equal(await host.locator('input[type="file"]').getAttribute('tabindex'), '-1', code);
      assert.equal(await picker.locator('xpath=ancestor::details').count(), 0, code);
      result.geometry.push({ stage: 'picker-empty', ...await keyboardReach(page, input('difficulty'), picker) });
      const entryScreenshot = `${width}x${height}-feedback-picker-empty.png`;
      await page.screenshot({ path: path.join(folder, entryScreenshot) }); report.screenshots.push(entryScreenshot);
      await choose([photo, video]); await until(async () => await rows.count() === 2);
      assert.equal(fixtureRequests.length, 0, code); result.nativeChooser = result.multiple = true;
      await assertDraft(); assert.equal(await submit.isDisabled(), true, code); assert.equal(writes.length, 0, code);
      phase = `${width}x${height}:EMPTY_RETURN_AND_RESELECT`;
      const original = await selection(); await choose([]); assert.deepEqual(await selection(), original, code);
      await assertDraft(); result.emptyReturnPreserves = true;
      await rows.filter({ hasText: photo.name }).locator('[data-media-action="cancel"]').click();
      await until(async () => await rows.count() === 1); await choose([photo]);
      await until(async () => await rows.count() === 2);
      const again = await selection(); assert.equal(again.filter(item => item.name === photo.name).length, 1, code);
      assert.notEqual(again.find(item => item.name === photo.name).id, original.find(item => item.name === photo.name).id, code);
      await assertDraft(); result.sameFileReselected = true;
      phase = `${width}x${height}:UNREADY_UI_FIXTURE`;
      for (const item of again) await rows.filter({ hasText: item.name }).locator('[data-media-action="upload"]').click();
      await until(() => uploads.size === 2 && [...uploads.values()].every(item => item.state === 'quarantined'));
      assert.equal(await submit.isDisabled(), true, code); assert.equal(writes.length, 0, code);
      assert.equal((await database.query('SELECT count(*)::int n FROM cb_activity_feedback')).rows[0].n, 0, code);
      await assertDraft(); result.unreadyBlocksPost = true;
      phase = `${width}x${height}:READY_UI_FIXTURE`;
      allowReady = true;
      for (const item of again) await rows.filter({ hasText: item.name }).locator('[data-media-action="refresh"]').click();
      await until(async () => await submit.isEnabled()); assert.equal(writes.length, 0, code);
      result.geometry.push({ stage: 'synthetic-ready-save', ...await keyboardReach(page, input('difficulty'), submit) });
      result.syntheticReadyEnables = true; await assertDraft();
      const screenshot = `${width}x${height}-feedback-picker-ready-ui-fixture.png`;
      await page.screenshot({ path: path.join(folder, screenshot) }); report.screenshots.push(screenshot);
      phase = `${width}x${height}:REMOVE_THEN_REAL_TEXT_SAVE`;
      for (const item of again) await rows.filter({ hasText: item.name }).locator('[data-media-action="cancel"]').click();
      await until(async () => await rows.count() === 0 && await submit.isEnabled()); await assertDraft();
      result.geometry.push({ stage: 'actual-text-save', ...await keyboardReach(page, input('difficulty'), submit) });
      const responseEvent = page.waitForResponse(response => response.request().method() === 'POST' &&
        new URL(response.url()).origin === origin && new RegExp(`^${base}/feedback/[A-Za-z0-9_-]+$`).test(new URL(response.url()).pathname));
      await page.keyboard.press('Enter'); const response = await responseEvent;
      assert.equal(response.status(), 201, code); const receipt = (await response.json()).receipt;
      assert.equal(receipt.revision, 1, code); assert.equal(receipt.replayed, false, code); await dialog.waitFor({ state: 'hidden' });
      assert.equal(writes.length, 1, code); assert.equal(writes[0].body.sourceMessageId, publication.messageId, code);
      assert.deepEqual(writes[0].body.content, { ...values, attachments: [] }, code);
      const readFeedback = async () => {
        const response = await context.request.get(`${origin}${base}/feedback/${receipt.feedbackId}`, { maxRedirects: 0,
          headers: { 'X-Carebridge-Account': ids.guardianId } });
        try { assert.equal(response.status(), 200, code); return (await response.json()).message; }
        finally { await response.dispose(); }
      };
      const stored = await readFeedback(); assert.equal(stored.id, receipt.messageId, code); assert.equal(stored.attachmentCount, 0, code);
      for (const [name, value] of Object.entries(values)) assert.equal(stored.feedback[name], value, code); result.textSave = true;
      phase = `${width}x${height}:RELOAD_TEXT_SAVE`;
      await page.reload(); await workspaceRoom(page, ids.conversationId);
      await page.locator(`[data-feedback-id="${receipt.feedbackId}"]`).getByRole('button', { name: '활동 경험 수정', exact: true }).click();
      await dialog.waitFor(); await assertDraft(); assert.deepEqual((await readFeedback()).feedback, stored.feedback, code);
      result.reloadPreservesText = true;
      phase = `${width}x${height}:CHAT_UNREADY_SEND_GUARD`;
      await dialog.getByRole('button', { name: '닫기', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
      const chatInput = page.locator('.composer textarea'), chatSend = page.locator('.composer button[type="submit"]');
      const chatPicker = page.locator('[data-chat-attach]'), chatHost = page.getByTestId('media-upload-panel');
      const chatRows = chatHost.getByTestId('media-upload-row'), chatDraft = '가상 사진을 선택해도 아직 보내지 않은 메시지 초안';
      assert.equal(await chatHost.locator('input[type="file"]').count(), 1, code);
      assert.equal(await chatHost.locator('input[type="file"]').getAttribute('aria-hidden'), 'true', code);
      assert.equal(await chatHost.locator('input[type="file"]').getAttribute('tabindex'), '-1', code);
      result.compactInputsHiddenFromAccessibility = true;
      await chatInput.fill(chatDraft); assert.equal(await chatSend.isEnabled(), true, code);
      const chooseChat = async files => {
        const event = page.waitForEvent('filechooser'); await chatPicker.click(); const chooser = await event;
        assert.equal(chooser.isMultiple(), true, code); await chooser.setFiles(files);
      };
      await chooseChat([photo]); await until(async () => await chatRows.count() === 1);
      assert.equal(await chatSend.isDisabled(), true, code); assert.equal(messagePosts.length, 0, code);
      assert.equal(await chatInput.inputValue(), chatDraft, code); result.chatSelectionBlocksSend = true;
      const chatSelection = await chatRows.getAttribute('data-media-id'); await chooseChat([]);
      assert.equal(await chatRows.count(), 1, code); assert.equal(await chatRows.getAttribute('data-media-id'), chatSelection, code);
      assert.equal(await chatSend.isDisabled(), true, code); assert.equal(await chatInput.inputValue(), chatDraft, code);
      result.chatEmptyReturnPreserves = true;
      await chatRows.locator('[data-media-action="cancel"]').click();
      await until(async () => await chatRows.count() === 0 && await chatSend.isEnabled());
      assert.equal(await chatInput.inputValue(), chatDraft, code); assert.equal(messagePosts.length, 0, code);
      assert.equal(uploads.size, 2, code); result.chatRemovalRestoresSend = true;
      assert.equal((await database.query('SELECT count(*)::int n FROM cb_media_uploads')).rows[0].n, 0, code);
      assert.equal((await database.query('SELECT count(*)::int n FROM cb_feedback_attachments')).rows[0].n, 0, code);
      assert.equal((await database.query('SELECT count(*)::int n FROM cb_activity_feedback')).rows[0].n, 1, code);
      assert.equal((await readdir(sandbox.mediaRoot)).length, 0, code); result.noRealUploadOrBinding = true;
      result.documentFixtureCount = documentFixtures; result.syntheticUploadResponses = fixtureRequests;
      await context.close(); contexts.delete(context); await sandbox.close(); sandboxes.delete(sandbox);
      await assert.rejects(lstat(sandbox.mediaRoot), { code: 'ENOENT' }); mediaRoots.delete(sandbox.mediaRoot);
      report.checks.push(result); await save('progress.json', { phase, checks: report.checks });
    }
    report.sourceAfter = await sources(); assert.equal(report.sourceAfter.sha256, source.sha256, code);
    assert.equal(report.errors.length, 0, code); assert.equal(report.unexpectedRequests.length, 0, code); report.passed = true;
  } catch (error) { report.failure = { phase, message: String(error.message).slice(0, 1200) }; }
  finally {
    closing = true;
    try {
      for (const context of contexts) await bounded(context.close()); contexts.clear(); report.cleanup.contextsClosed = true;
      await bounded(Promise.allSettled([...pendingRoutes]));
      await bounded(browser?.close()); await bounded(server?.close());
      const child = server?.process();
      assert(!child || child.exitCode !== null || child.signalCode !== null, code); report.cleanup.browserStopped = true;
      for (const sandbox of sandboxes) await bounded(sandbox.close()); sandboxes.clear(); report.cleanup.sandboxesClosed = true;
      for (const mediaRoot of mediaRoots) await assert.rejects(lstat(mediaRoot), { code: 'ENOENT' });
      report.cleanup.privateRootsRemoved = true;
    } catch { report.passed = false; report.cleanupFailure = true; }
    ownership.finished = Object.values(report.cleanup).every(Boolean);
    await save('ownership.json', ownership); await save('results.json', report);
  }
  process.stdout.write(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length, failure: report.failure, cleanup: report.cleanup }) + '\n');
  if (!report.passed) process.exitCode = 1;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runLocalAttachmentPickerBrowser();

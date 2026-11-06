// Real UI -> loopback HTTP -> private quarantine bytes. Deliberately no clean
// verdict, media playback, message binding, Docker, real data or external URL.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceRoom, workspaceView, workspaceAccountAction } from './local-workspace-browser-helpers.mjs';
import { syntheticVideoBytes } from './browser-media-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=', 'base64');
async function sources() {
  const names = ['tests/local-media-browser.mjs', 'tests/browser-media-fixture.mjs', 'tests/local-workspace-browser-helpers.mjs'];
  for (const directory of ['local-api', 'src', 'server', 'server/migrations']) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      if (entry.isDirectory() || !/\.(mjs|js|css|html|sql)$/.test(entry.name)) continue;
      assert(entry.isFile() && !entry.isSymbolicLink()); names.push(`${directory}/${entry.name}`);
    }
  }
  const files = [];
  for (const name of names.sort()) files.push({ name, sha256: sha(await readFile(path.join(root, name))) });
  return { sha256: sha(JSON.stringify(files)), files };
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)); }
  assert.fail('LOCAL_MEDIA_CONDITION_TIMEOUT');
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('LOCAL_MEDIA_CLEANUP_TIMEOUT')), 15000);
  })]); } finally { clearTimeout(timer); }
}

export async function runLocalMediaBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args), source = await sources();
  for (const file of [options.module, options.executable]) assert((await lstat(file)).isFile());
  const { chromium } = await import(pathToFileURL(options.module).href);
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-media-${runId}`);
  await mkdir(folder);
  const report = { runId, at: new Date().toISOString(), source, passed: false, checks: [], screenshots: [], errors: [], unexpectedRequests: [],
    cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false, privateRootsRemoved: false },
    limitations: ['Synthetic quarantine upload only; no malware approval, metadata processing, authorized playback or attachment delivery.',
      'Memory-only PGlite plus owned private OS temporary bytes; no E drive, user browser, actual child data, hosted deployment or physical-device evidence.',
      'Lost responses are real committed HTTP responses deliberately withheld, not fabricated server results.'] };
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2));
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, finished: false };
  await save('ownership.json', ownership);
  let browserServer, browser, phase = 'START';
  const contexts = new Set(), sandboxes = new Set(), mediaRoots = new Set();
  try {
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable, host: '127.0.0.1', port: 0,
      env: studyChildEnvironment(), timeout: 30000 });
    ownership.browserProcessId = browserServer.process().pid; await save('ownership.json', ownership);
    browser = await chromium.connect(browserServer.wsEndpoint());
    for (const width of [390, 1440, 320]) {
      phase = `${width}:SETUP`;
      const sandbox = await createLocalApiSandbox(); sandboxes.add(sandbox); mediaRoots.add(sandbox.mediaRoot);
      const { ids, database } = sandbox, origin = sandbox.origin;
      const extra = { childId: `media-child-${randomUUID()}`, roomId: `media-room-${randomUUID()}` };
      await database.transaction(async (tx) => {
        await tx.query('INSERT INTO cb_children(center_id,id) VALUES ($1,$2)', [ids.centerId, extra.childId]);
        await tx.query('INSERT INTO cb_conversations(center_id,id,child_id) VALUES ($1,$2,$3)', [ids.centerId, extra.roomId, extra.childId]);
        await tx.query(`INSERT INTO cb_participants(center_id,conversation_id,user_id,role,active,first_sequence)
          VALUES ($1,$2,$3,'therapist',true,1),($1,$2,$4,'guardian',true,1)`, [ids.centerId, extra.roomId, ids.therapistId, ids.guardianId]);
        await tx.query(`INSERT INTO cb_child_profiles(center_id,child_id,name,revision,updated_by)
          VALUES ($1,$2,'가상 두 번째 아동',1,$3)`, [ids.centerId, extra.childId, ids.therapistId]);
      });
      const base = `/api/local/centers/${ids.centerId}/conversations/${ids.conversationId}`;
      const result = { width, photoQuarantine: false, videoQuarantine: false, lostReserve: false, lostReceive: false,
        navigationPreserves: false, otherActorPrivate: false, cancelRetry: false, revocationWipes: false, nonSelectedRevocation: false,
        keyboardFocus: false, noBindings: false, layout: false };
      const actor = async (role) => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR', serviceWorkers: 'block',
          isMobile: width <= 640, hasTouch: width <= 640, permissions: [], acceptDownloads: false }); contexts.add(context);
        await context.route('**/*', (route) => {
          const url = new URL(route.request().url());
          const asset = ['/', '/favicon.ico', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/client.js', '/local-api/care-client.js', '/local-api/care-ui.js',
            '/local-api/workspace-ui.js', '/local-api/media-client.js', '/local-api/media-ui.js', '/local-api/media-viewer.js', '/local-api/styles.css',
            '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js'].includes(url.pathname) && ['GET', 'HEAD'].includes(route.request().method());
          if (url.origin !== origin || (!asset && !url.pathname.startsWith('/api/local/')) || !['GET', 'POST'].includes(route.request().method())) {
            report.unexpectedRequests.push({ width, role, phase }); return route.abort();
          }
          return route.continue();
        });
        const page = await context.newPage();
        page.on('pageerror', () => report.errors.push({ width, role, phase }));
        const credential = sandbox.credentials.find((c) => c.role === role);
        await page.goto(origin); await page.locator('#email').fill(credential.email); await page.locator('#password').fill(credential.password);
        await page.locator('[data-testid="login-form"] button').click(); await workspaceRoom(page, ids.conversationId);
        return { context, page };
      };
      const therapist = await actor('therapist'), guardian = await actor('guardian');
      const page = therapist.page, panel = page.locator('[data-testid="media-upload-panel"]');
      const rows = panel.locator('[data-testid="media-upload-row"]');
      await panel.locator('[data-media-details] > summary').click();
      await panel.locator('input').setInputFiles([{ name: '가상사진-<표시검사>.png', mimeType: 'image/png', buffer: png },
        { name: '가상영상.webm', mimeType: 'video/webm', buffer: syntheticVideoBytes() }]);
      await until(async () => await rows.count() === 2);
      const photo = rows.nth(0), video = rows.nth(1);
      let reserveLost = false, received = 0, receiveLost = false;
      await therapist.context.route(`**${base}/uploads`, async (route) => {
        if (route.request().method() === 'POST' && !reserveLost) { reserveLost = true; await route.fetch(); await route.abort('failed'); }
        else await route.fallback();
      });
      phase = `${width}:LOST_RESERVE`;
      await photo.locator('[data-media-action="upload"]').focus();
      await page.keyboard.press('Enter');
      await until(async () => (await panel.textContent()).includes('이전 결과를 확인해야'));
      await until(async () => await page.evaluate(() => document.activeElement?.dataset.mediaAction === 'upload' && !document.activeElement.disabled));
      const reserved = (await database.query('SELECT id FROM cb_media_uploads')).rows;
      assert.equal(reserved.length, 1);
      await photo.locator('[data-media-action="upload"]').click();
      await until(async () => (await photo.textContent()).includes('격리 보관됨'));
      assert.equal((await database.query('SELECT id FROM cb_media_uploads')).rows.length, 1);
      result.lostReserve = reserveLost;
      const savedPhoto = (await database.query('SELECT id,object_key,state,sha256 FROM cb_media_uploads')).rows[0];
      assert.equal(savedPhoto.id, reserved[0].id); assert.equal(savedPhoto.state, 'quarantined');
      assert.equal(sha(await readFile(path.join(sandbox.mediaRoot, `${savedPhoto.object_key}.blob`))), sha(png));
      result.photoQuarantine = true;
      assert(await panel.locator('[data-media-details] > summary').evaluate((node) => node === document.activeElement)); result.keyboardFocus = true;
      phase = `${width}:LOST_RECEIVE`;
      await therapist.context.route(`**${base}/uploads/*/content`, async (route) => {
        received++;
        if (!receiveLost) { receiveLost = true; await route.fetch(); await route.abort('failed'); }
        else await route.fallback();
      });
      await video.locator('[data-media-action="upload"]').click();
      await until(async () => (await video.textContent()).includes('이전 결과를 확인해야'));
      await video.locator('[data-media-action="upload"]').click();
      await until(async () => (await video.textContent()).includes('격리 보관됨'));
      assert.equal(received, 1);
      const savedVideo = (await database.query("SELECT object_key,state FROM cb_media_uploads WHERE type='video/webm'")).rows[0];
      assert.equal(savedVideo.state, 'quarantined');
      assert.equal(sha(await readFile(path.join(sandbox.mediaRoot, `${savedVideo.object_key}.blob`))), sha(syntheticVideoBytes()));
      result.lostReceive = receiveLost; result.videoQuarantine = true;
      phase = `${width}:NAVIGATION`;
      await workspaceView(page, 'home'); assert.equal(await rows.count(), 0);
      await workspaceRoom(page, ids.conversationId); assert.equal(await rows.count(), 2);
      assert((await rows.nth(0).textContent()).includes('격리 보관됨'));
      result.navigationPreserves = true;
      await workspaceAccountAction(guardian.page, 'refresh');
      assert.equal(await guardian.page.locator('[data-testid="media-upload-row"]').count(), 0);
      assert(!(await guardian.page.locator('body').textContent()).includes('가상사진-'));
      result.otherActorPrivate = true;
      assert.equal(await panel.locator('img,video,a[download]').count(), 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const screenshot = `${width}-quarantine.png`; await panel.screenshot({ path: path.join(folder, screenshot) });
      report.screenshots.push(screenshot); result.layout = true;
      phase = `${width}:CANCEL_RETRY`;
      await rows.nth(0).locator('[data-media-action="cancel"]').click();
      await until(async () => await rows.count() === 1);
      await assert.rejects(lstat(path.join(sandbox.mediaRoot, `${savedPhoto.object_key}.blob`)), { code: 'ENOENT' });
      let cancelLost = false;
      await therapist.context.route(`**${base}/uploads/*/cancel`, async (route) => {
        if (!cancelLost) { cancelLost = true; await route.fetch(); await route.abort('failed'); } else await route.fallback();
      });
      await rows.nth(0).locator('[data-media-action="cancel"]').click();
      await until(async () => (await rows.nth(0).textContent()).includes('이전 결과를 확인해야'));
      await rows.nth(0).locator('[data-media-action="cancel"]').click();
      await until(async () => await rows.count() === 0);
      assert.equal((await database.query('SELECT count(*)::int n FROM cb_media_uploads')).rows[0].n, 2);
      assert.equal((await readdir(sandbox.mediaRoot)).filter((name) => name.endsWith('.blob')).length, 0);
      result.cancelRetry = cancelLost;
      phase = `${width}:REVOKED`;
      await panel.locator('input').setInputFiles({ name: '가상-권한회수.png', mimeType: 'image/png', buffer: png });
      await until(async () => await rows.count() === 1);
      await rows.nth(0).locator('[data-media-action="upload"]').click();
      await until(async () => (await rows.nth(0).textContent()).includes('격리 보관됨'));
      await workspaceAccountAction(page, 'refresh');
      await workspaceRoom(page, extra.roomId); assert.equal(await rows.count(), 0);
      await database.query('UPDATE cb_participants SET active=false WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3',
        [ids.centerId, ids.conversationId, ids.therapistId]);
      await workspaceAccountAction(page, 'refresh');
      await until(async () => await page.locator(`[data-room-id="${ids.conversationId}"]`).count() === 0);
      await database.query(`UPDATE cb_participants SET active=true,first_sequence=(SELECT last_sequence+1 FROM cb_conversations WHERE center_id=$1 AND id=$2)
        WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3`, [ids.centerId, ids.conversationId, ids.therapistId]);
      await workspaceAccountAction(page, 'refresh');
      await workspaceRoom(page, ids.conversationId); assert.equal(await rows.count(), 0);
      assert(!(await page.locator('body').textContent()).includes('가상-권한회수.png'));
      result.nonSelectedRevocation = true;
      await panel.locator('input').setInputFiles({ name: '가상-현재권한회수.png', mimeType: 'image/png', buffer: png });
      await until(async () => await rows.count() === 1);
      await database.query('UPDATE cb_participants SET active=false WHERE center_id=$1 AND conversation_id=$2 AND user_id=$3',
        [ids.centerId, ids.conversationId, ids.therapistId]);
      await workspaceAccountAction(page, 'refresh');
      await until(async () => await rows.count() === 0);
      assert(!(await page.locator('body').textContent()).includes('가상-현재권한회수.png'));
      result.revocationWipes = true;
      assert.equal((await database.query("SELECT count(*)::int n FROM cb_media_uploads WHERE state IN ('ready','bound')")).rows[0].n, 0);
      assert.equal((await database.query('SELECT count(*)::int n FROM cb_messages')).rows[0].n, 1);
      result.noBindings = true;
      for (const item of [therapist, guardian]) { await item.context.close(); contexts.delete(item.context); }
      await sandbox.close(); sandboxes.delete(sandbox);
      await assert.rejects(lstat(sandbox.mediaRoot), { code: 'ENOENT' }); mediaRoots.delete(sandbox.mediaRoot);
      report.checks.push(result); await save('progress.json', { phase, checks: report.checks });
    }
    report.sourceAfter = await sources(); assert.equal(report.sourceAfter.sha256, source.sha256);
    assert.equal(report.errors.length, 0); assert.equal(report.unexpectedRequests.length, 0); report.passed = true;
  } catch (error) { report.failure = { phase, message: String(error.message).slice(0, 700) }; }
  finally {
    try {
      for (const context of contexts) await bounded(context.close()); contexts.clear(); report.cleanup.contextsClosed = true;
      await bounded(browser?.close()); await bounded(browserServer?.close()); report.cleanup.browserStopped = true;
      for (const sandbox of sandboxes) await bounded(sandbox.close()); sandboxes.clear(); report.cleanup.sandboxesClosed = true;
      for (const folder of mediaRoots) await assert.rejects(lstat(folder), { code: 'ENOENT' }); report.cleanup.privateRootsRemoved = true;
    } catch { report.passed = false; report.cleanupFailure = true; }
    ownership.finished = Object.values(report.cleanup).every(Boolean); await save('ownership.json', ownership); await save('results.json', report);
  }
  process.stdout.write(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length, failure: report.failure, cleanup: report.cleanup }) + '\n');
  if (!report.passed) process.exitCode = 1;
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runLocalMediaBrowser();

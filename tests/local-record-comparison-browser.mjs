// R03: visible UI -> authenticated loopback HTTP -> owned, memory-only PGlite.
// This test owns its Chromium and synthetic accounts; it never uses E/native data.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { workspaceRecords, workspaceView, workspaceAccountAction } from './local-workspace-browser-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const code = 'LOCAL_RECORD_COMPARISON_FAILED';
const assets = new Set(['/', '/favicon.ico', '/local-api/app.js', '/local-api/care-recipient-client.js', '/local-api/approval-pending-ui.js', '/local-api/client.js', '/local-api/care-client.js',
  '/local-api/care-ui.js', '/local-api/workspace-ui.js', '/local-api/styles.css', '/local-api/media-client.js',
  '/local-api/media-ui.js', '/local-api/media-viewer.js', '/src/media-policy.js', '/src/record-fields.js', '/src/feedback-fields.js']);
const measurementKeys = ['recordId', 'recordRevision', 'date', 'title', 'goalId', 'goalTitle', 'ordinal', 'tool', 'item', 'value', 'unit', 'context'].sort();
async function sources() {
  const names = ['tests/local-record-comparison-browser.mjs', 'tests/local-workspace-browser-helpers.mjs',
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
async function reachable(button) {
  await button.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await button.click({ trial: true });
  assert.equal(await button.evaluate(element => {
    const rect = element.getBoundingClientRect(), nav = document.querySelector('.main-nav');
    const footer = nav && getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect() : null;
    const x = Math.min(12, rect.width / 4), y = Math.min(12, rect.height / 4);
    const points = [[rect.left + rect.width / 2, rect.top + rect.height / 2], [rect.left + x, rect.top + y],
      [rect.right - x, rect.top + y], [rect.left + x, rect.bottom - y], [rect.right - x, rect.bottom - y]];
    return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight &&
      (!footer || rect.bottom <= footer.top || rect.top >= footer.bottom || rect.right <= footer.left || rect.left >= footer.right) &&
      points.every(([px, py]) => element.contains(document.elementFromPoint(px, py)));
  }), true, code);
}

export async function runLocalRecordComparisonBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const filename of [options.module, options.executable]) {
    const info = await lstat(filename); assert(info.isFile() && !info.isSymbolicLink(), code);
  }
  const source = await sources(), { chromium } = await import(pathToFileURL(options.module).href);
  const { createLocalApiSandbox } = await import('../server/local-api-sandbox.mjs');
  const runId = randomUUID(), folder = path.join(root, 'test-results', `local-record-comparison-${runId}`);
  await mkdir(folder);
  const report = { runId, startedAt: new Date().toISOString(), source, passed: false, checks: [], screenshots: [],
    errors: [], unexpectedRequests: [], failure: null, cleanupObservationTimedOut: false,
    cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false },
    limitations: ['Synthetic accounts and real authenticated loopback HTTP with memory-only PGlite, not persistent PostgreSQL or E/native storage.',
      '390/768/1440 Chromium viewports are not physical devices or human usability evidence.',
      'All clinical record writes use visible UI; exact record/DB verification is read-only.',
      'The second therapist context is a new authenticated session of the same synthetic therapist, not a different clinician identity.',
      'Delayed comparison uses the real server response and only delays transport; it is not an API or approval double.',
      'No upload or new clinical scoring, interpretation, averaging or AI is involved.'] };
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, finished: false };
  const contexts = new Set(), sandboxes = new Set(), pages = new Map(), releases = new Set(), routeWork = new Set();
  const save = (name, value) => writeFile(path.join(folder, name), JSON.stringify(value, null, 2) + '\n');
  const note = (collection, value) => { if (collection.length < 32) collection.push(value); };
  let browserServer, browser, lifetime, phase = 'STARTUP';
  await save('ownership.json', ownership);
  try {
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    lifetime = processLifetime(browserServer.process()); ownership.browserProcessId = browserServer.process().pid;
    await save('ownership.json', ownership); browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    for (const width of [390, 768, 1440]) {
      phase = `${width}:SANDBOX`; const sandbox = await createLocalApiSandbox({ port: 0 }); sandboxes.add(sandbox);
      const { origin, ids } = sandbox, url = new URL(origin);
      assert(url.origin === origin && url.hostname === '127.0.0.1' && url.protocol === 'http:' && url.port && !url.username && !url.password, code);
      const base = `/api/local/centers/${ids.centerId}/conversations/${ids.conversationId}`, endpoint = base + '/measurements';
      const result = { width, sourceCreated: false, minimalDto: false, grouping: false, chronological: false,
        zeroAndDuplicate: false, draftExcluded: false, sourceUnchanged: false, currentHeadOnly: false,
        staleCleared: false, lateResponseDiscarded: false, draftIndependent: false, guardianPrivate: false,
        keyboard: false, reachability: false, layout: false, cleanup: false };
      report.currentCheck = result;
      // Bodies and authentication details are in memory only, never written to reports.
      const measurementResponses = [], guardianPrivate = [];
      const actor = async (role, label = role) => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'ko-KR',
          isMobile: width <= 640, hasTouch: width <= 640, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context); context.once('close', () => contexts.delete(context)); assert.equal((await context.cookies()).length, 0, code);
        const fault = { next: null };
        await context.route('**/*', async route => {
          const request = route.request(), target = new URL(request.url()), method = request.method();
          const primaryRead = method === 'GET' && target.pathname === `/api/local/centers/${ids.centerId}/primary-communicator` &&
            [...target.searchParams].length === 1 && target.searchParams.get('conversationId') === ids.conversationId;
          const api = /^\/api\/local\/(?:auth\/(?:login|session|logout)|centers\/[A-Za-z0-9_-]+\/(?:inbox|conversations\/[A-Za-z0-9_-]+\/(?:profile|read|goals|measurements|appointments(?:\/[A-Za-z0-9_-]+)?|messages(?:\/[A-Za-z0-9_-]+)?|records(?:\/[A-Za-z0-9_-]+(?:\/(?:preview|publish))?)?)))$/.test(target.pathname);
          if (target.origin !== origin || !['GET', 'POST', 'HEAD'].includes(method) || !((assets.has(target.pathname) && ['GET', 'HEAD'].includes(method)) || api || primaryRead)) {
            note(report.unexpectedRequests, { width, role, phase, sameOrigin: target.origin === origin,
              method: ['GET', 'POST', 'HEAD'].includes(method) ? method : 'OTHER' }); return route.abort().catch(() => {});
          }
          if (role === 'guardian' && (target.pathname.startsWith(base + '/records') || target.pathname === endpoint)) guardianPrivate.push(method);
          if (target.pathname !== endpoint || method !== 'GET') return route.continue().catch(() => {});
          const held = fault.next; fault.next = null;
          const work = (async () => {
            let response;
            try {
              response = await route.fetch({ maxRedirects: 0, timeout: 15_000 }); assert.equal(response.status(), 200, code);
              const body = await response.json();
              assert.deepEqual(Object.keys(body).sort(), ['hasMore', 'measurements', 'nextCursor', 'resetRequired', 'revision'].sort(), code);
              assert.equal(body.resetRequired, false, code);
              for (const row of body.measurements) assert.deepEqual(Object.keys(row).sort(), measurementKeys, code);
              measurementResponses.push({ label, body });
              if (held) { held.entered.resolve(); await held.release.promise; }
              try { await route.fulfill({ response }); }
              catch (error) { if (!held) throw error; }
            } catch { note(report.errors, { width, role, phase, type: 'measurement-response' }); await route.abort().catch(() => {}); }
            finally { await response?.dispose().catch(() => {}); held?.done.resolve(); }
          })();
          routeWork.add(work); try { await work; } finally { routeWork.delete(work); }
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
        return { page, context, role, label, userId: ids[role + 'Id'], fault };
      };
      const therapist = await actor('therapist'), guardian = await actor('guardian');
      const dialog = who => who.page.getByTestId('care-dialog');
      const input = (who, name) => dialog(who).locator(`[name="${name}"]`);
      const fill = async (who, name, value) => { const field = input(who, name); await reveal(field); await field.fill(String(value)); };
      const comparison = who => who.page.getByTestId('measurement-comparison');
      const rows = who => comparison(who).locator('[data-measurement-row]');
      const row = (who, recordId, ordinal) => comparison(who).locator(`[data-measurement-row][data-record-id="${recordId}"][data-measurement-ordinal="${ordinal}"]`);
      const capture = async (who, label) => {
        assert.equal(await who.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, code);
        for (const group of await comparison(who).locator('[data-measurement-group]').all())
          assert.equal(await group.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, code);
        const filename = `${width}-${label}.png`;
        await who.page.screenshot({ path: path.join(folder, filename), fullPage: false,
          mask: [who.page.locator('input[type="email"]'), who.page.locator('input[type="password"]'), who.page.locator('.workspace-head .account')] });
        report.screenshots.push({ filename, width, syntheticOnly: true });
      };
      const get = async (who, recordId, revision) => {
        const response = await who.context.request.get(`${origin}${base}/records/${recordId}?revision=${revision}`, {
          maxRedirects: 0, timeout: 15_000, headers: { 'X-Carebridge-Account': who.userId } });
        try { assert.equal(response.status(), 200, code); return (await response.json()).record; } finally { await response.dispose(); }
      };
      const dbRecord = async recordId => {
        const params = [ids.centerId, ids.conversationId, recordId], values = {};
        for (const [key, query] of Object.entries({ head: 'SELECT * FROM cb_records WHERE center_id=$1 AND conversation_id=$2 AND id=$3',
          revisions: 'SELECT * FROM cb_record_revisions WHERE center_id=$1 AND conversation_id=$2 AND record_id=$3 ORDER BY revision',
          assessments: 'SELECT * FROM cb_record_assessments WHERE center_id=$1 AND conversation_id=$2 AND record_id=$3 ORDER BY revision,ordinal' }))
          values[key] = (await sandbox.database.query(query, params)).rows;
        return values;
      };
      const saveRecord = async (who, draft = false) => {
        const [response] = await Promise.all([who.page.waitForResponse(response => {
          const target = new URL(response.url()); return target.origin === origin && target.pathname.startsWith(base + '/records/') &&
            !target.pathname.slice((base + '/records/').length).includes('/') && response.request().method() === 'POST' && response.status() === 201;
        }), dialog(who).getByRole('button', { name: draft ? '임시저장' : '기록 저장', exact: true }).click()]);
        const receipt = (await response.json()).receipt; await dialog(who).waitFor({ state: 'hidden' }); return receipt;
      };
      const openRecord = async (who, recordId) => {
        await workspaceRecords(who.page, ids.conversationId);
        await who.page.locator(`[data-care-action="edit-record"][data-record-id="${recordId}"]`).click(); await dialog(who).waitFor();
      };
      const compare = async (who, keyboard = false) => {
        const button = who.page.locator('[data-care-action="compare-records"]'); await reachable(button);
        if (keyboard) { await button.focus(); await button.press('Enter'); } else await button.click();
        await rows(who).first().waitFor();
      };
      const refresh = async who => {
        await workspaceAccountAction(who.page, 'refresh');
        await who.page.getByRole('button', { name: '새로고침', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
        await who.page.waitForFunction(() => !document.querySelector('#child-select')?.disabled);
      };

      phase = `${width}:SOURCE_UI_WRITES`; await therapist.page.bringToFront();
      const measure = (value, context = '가상 조건 A', unit = '회') => ({ tool: '가상 측정 도구 <b>문자</b>', item: '가상 동일 항목', value, unit, context });
      const fixtures = [
        { date: '2026-03-03', title: '가상 늦은 날짜', assessments: [measure(0), measure(4)] },
        { date: '2026-02-02', title: '가상 중간 날짜', assessments: [measure(2), measure(20, '가상 조건 B')] },
        { date: '2026-01-01', title: '가상 이른 날짜', assessments: [measure(1), measure(30, '가상 조건 A', '초')] },
        { date: '2026-04-04', title: '가상 임시 측정', assessments: [measure(999)], draft: true },
      ];
      const originals = [];
      for (const [index, fixture] of fixtures.entries()) {
        await workspaceRecords(therapist.page, ids.conversationId);
        await therapist.page.locator('[data-care-action="new-record"]').click(); await dialog(therapist).waitFor();
        for (const [name, value] of Object.entries({ date: fixture.date, title: fixture.title, performed: `가상 비공개 수행 ${index}`,
          response: `가상 비공개 반응 ${index}`, privateNote: `가상 비교 제외 메모 ${index}`, summary: `가상 비교 제외 요약 ${index}` }))
          await fill(therapist, name, value);
        for (const [ordinal, assessment] of fixture.assessments.entries()) {
          const add = dialog(therapist).locator('[data-care-action="add-assessment"]'); await reveal(add); await add.click();
          for (const [key, value] of Object.entries(assessment)) await fill(therapist, `assessment-${ordinal}-${key}`, value);
        }
        const receipt = await saveRecord(therapist, fixture.draft); assert.equal(receipt.revision, 1, code);
        originals.push({ id: receipt.recordId, dto: await get(therapist, receipt.recordId, 1), db: await dbRecord(receipt.recordId) });
      }
      result.sourceCreated = true; result.originalHashes = originals.map(original => hash(JSON.stringify(original.dto)));

      phase = `${width}:INITIAL_COMPARISON`;
      await workspaceRecords(therapist.page, ids.conversationId); await compare(therapist, true);
      assert.equal(await comparison(therapist).getAttribute('aria-label'), '측정값 비교', code);
      assert.equal(await rows(therapist).count(), 6, code); assert.equal(await comparison(therapist).locator('[data-measurement-group]').count(), 3, code);
      const primary = row(therapist, originals[0].id, 0).locator('xpath=ancestor::*[@data-measurement-group][1]');
      const primaryOrder = await primary.locator('[data-measurement-row]').evaluateAll(elements => elements.map(element =>
        ({ recordId: element.dataset.recordId, revision: element.dataset.recordRevision, ordinal: element.dataset.measurementOrdinal })));
      assert.deepEqual(primaryOrder, [{ recordId: originals[2].id, revision: '1', ordinal: '0' },
        { recordId: originals[1].id, revision: '1', ordinal: '0' }, { recordId: originals[0].id, revision: '1', ordinal: '0' },
        { recordId: originals[0].id, revision: '1', ordinal: '1' }], code);
      for (const [index, original] of originals.entries()) {
        if (index === 3) { assert.equal(await row(therapist, original.id, 0).count(), 0, code); continue; }
        for (const [ordinal, assessment] of fixtures[index].assessments.entries()) {
          const element = row(therapist, original.id, ordinal);
          assert.equal(await element.locator('[data-measurement-value]').textContent(), `${assessment.value} ${assessment.unit}`, code);
          assert.equal(await element.locator('time').textContent(), fixtures[index].date, code);
        }
      }
      const observed = measurementResponses.filter(item => item.label === 'therapist').at(-1).body;
      assert.equal(observed.measurements.length, 6, code); assert.equal(observed.hasMore, false, code);
      for (const item of observed.measurements) assert.deepEqual(item, {
        recordId: item.recordId, recordRevision: 1, date: originals.find(original => original.id === item.recordId).dto.date,
        title: originals.find(original => original.id === item.recordId).dto.title, goalId: ids.goalId,
        goalTitle: originals.find(original => original.id === item.recordId).dto.goalSnapshot.title,
        ordinal: item.ordinal, ...originals.find(original => original.id === item.recordId).dto.assessments[item.ordinal],
      }, code);
      const text = await comparison(therapist).innerText();
      for (const original of originals) for (const key of ['performed', 'response', 'privateNote', 'summary']) assert(!text.includes(original.dto[key]), code);
      assert.equal(await comparison(therapist).locator('b').count(), 0, code);
      for (const original of originals) { assert.deepEqual(await get(therapist, original.id, 1), original.dto, code); assert.deepEqual(await dbRecord(original.id), original.db, code); }
      result.minimalDto = result.grouping = result.chronological = result.zeroAndDuplicate = result.draftExcluded = result.sourceUnchanged = result.keyboard = true;
      await comparison(therapist).evaluate(element => element.scrollIntoView({ block: 'start' })); await capture(therapist, 'comparison-groups');
      await reachable(therapist.page.locator('[data-care-action="clear-comparison"]')); await capture(therapist, 'comparison-controls'); result.reachability = true;

      phase = `${width}:DRAFT_INDEPENDENCE`;
      await therapist.page.locator('[data-care-action="new-record"]').click(); await dialog(therapist).waitFor();
      const unsaved = '가상 비교와 독립적인 작성 중 입력'; await fill(therapist, 'performed', unsaved);
      await dialog(therapist).getByRole('button', { name: '닫기', exact: true }).click(); await dialog(therapist).waitFor({ state: 'hidden' });
      await therapist.page.locator('[data-care-action="clear-comparison"]').click(); assert.equal(await rows(therapist).count(), 0, code);
      await compare(therapist); assert.equal(await rows(therapist).count(), 6, code);
      await therapist.page.locator('[data-care-action="new-record"]').click(); await dialog(therapist).waitFor();
      assert.equal(await input(therapist, 'performed').inputValue(), unsaved, code);
      await dialog(therapist).getByRole('button', { name: '입력 취소', exact: true }).click(); await dialog(therapist).waitFor({ state: 'hidden' });
      result.draftIndependent = true;

      phase = `${width}:SECOND_SESSION_EDIT`;
      const peer = await actor('therapist', 'peer-therapist'); await peer.page.bringToFront(); await openRecord(peer, originals[0].id);
      await fill(peer, 'assessment-0-value', '17'); const edited = await saveRecord(peer);
      assert.equal(edited.recordId, originals[0].id, code); assert.equal(edited.revision, 2, code);
      await therapist.page.bringToFront(); await refresh(therapist);
      await comparison(therapist).locator('[data-comparison-notice]').filter({ hasText: '다시 조회해 주세요.' }).waitFor();
      assert.equal(await rows(therapist).count(), 0, code);
      await capture(therapist, 'stale-comparison-cleared'); result.staleCleared = true;
      await compare(therapist); assert.equal(await rows(therapist).count(), 6, code);
      assert.equal(await row(therapist, originals[0].id, 0).getAttribute('data-record-revision'), '2', code);
      assert.equal(await row(therapist, originals[0].id, 0).locator('[data-measurement-value]').textContent(), '17 회', code);
      const latest = measurementResponses.filter(item => item.label === 'therapist').at(-1).body;
      assert.equal(latest.measurements.filter(item => item.recordId === originals[0].id).length, 2, code);
      assert(latest.measurements.filter(item => item.recordId === originals[0].id).every(item => item.recordRevision === 2), code);
      assert.deepEqual(await get(therapist, originals[0].id, 1), originals[0].dto, code);
      result.currentHeadOnly = true;
      await row(therapist, originals[0].id, 0).evaluate(element => element.scrollIntoView({ block: 'center' })); await capture(therapist, 'updated-head');

      phase = `${width}:DELAYED_RESPONSE_AFTER_MENU_CHANGE`;
      const held = { entered: Promise.withResolvers(), release: Promise.withResolvers(), done: Promise.withResolvers() };
      const release = () => held.release.resolve(); releases.add(release); therapist.fault.next = held;
      try {
        await therapist.page.locator('[data-care-action="compare-records"]').click(); await bounded(held.entered.promise, 15_000);
        await workspaceView(therapist.page, 'home'); await therapist.page.getByTestId('home').waitFor();
        release(); await bounded(held.done.promise, 15_000);
        await therapist.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await rows(therapist).count(), 0, code); assert.equal(await dialog(therapist).isVisible(), false, code);
        assert.equal(await therapist.page.locator('[data-view="home"]').getAttribute('aria-current'), 'page', code);
        await workspaceRecords(therapist.page, ids.conversationId); assert.equal(await rows(therapist).count(), 0, code);
        await capture(therapist, 'late-response-discarded'); result.lateResponseDiscarded = true;
      } finally { release(); releases.delete(release); }

      phase = `${width}:GUARDIAN_BOUNDARY`;
      await guardian.page.bringToFront(); await workspaceRecords(guardian.page, ids.conversationId);
      assert.equal(await guardian.page.locator('[data-care-action="compare-records"],[data-care-action="clear-comparison"],[data-measurement-row]').count(), 0, code);
      assert.equal(guardianPrivate.length, 0, code);
      const guardianText = await guardian.page.locator('body').innerText();
      for (const original of originals) for (const key of ['privateNote', 'performed', 'title']) assert(!guardianText.includes(original.dto[key]), code);
      for (const who of [therapist, guardian, peer]) assert.deepEqual(await who.page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, ''], code);
      await capture(guardian, 'guardian-no-comparison'); result.guardianPrivate = result.layout = true;
      assert.equal(report.errors.length, 0, code); assert.equal(report.unexpectedRequests.length, 0, code);
      for (const who of [therapist, guardian, peer]) await who.context.close(); pages.clear();
      await sandbox.close(); assert.equal(sandbox.database.closed, true, code); assert.equal(sandbox.credentials.length, 0, code); sandboxes.delete(sandbox);
      result.cleanup = true; report.checks.push(result); delete report.currentCheck;
      console.log(JSON.stringify({ width, passed: true, boundaries: 15 }));
    }
    report.finalSource = await sources(); assert.equal(report.finalSource.sha256, source.sha256, code);
  } catch (error) {
    report.failure = { code, phase, kind: ['AssertionError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error',
      testLine: Number(error?.stack?.match(/local-record-comparison-browser\.mjs:(\d+):\d+/)?.[1]) || null,
      workspaceHelperLine: Number(error?.stack?.match(/local-workspace-browser-helpers\.mjs:(\d+):\d+/)?.[1]) || null };
    for (const [role, page] of [...pages].slice(0, 2)) try {
      const filename = `failure-${role}.png`; await page.screenshot({ path: path.join(folder, filename), fullPage: false,
        mask: [page.locator('input[type="email"]'), page.locator('input[type="password"]'), page.locator('.workspace-head .account')] });
      report.screenshots.push({ filename, syntheticOnly: true, failure: true });
    } catch { note(report.errors, { phase, type: 'failure-screenshot' }); }
  } finally {
    for (const release of releases) release();
    try { await bounded(Promise.all([...routeWork])); } catch { report.cleanupObservationTimedOut = true; }
    for (const context of contexts) try { await bounded(context.close()); contexts.delete(context); } catch { report.cleanupObservationTimedOut = true; }
    report.cleanup.contextsClosed = contexts.size === 0;
    if (browserServer) {
      try { await bounded(browser?.close()); await bounded(browserServer.close()); await bounded(lifetime.done); }
      catch { report.cleanupObservationTimedOut = true; try { await bounded(browserServer.kill()); await bounded(lifetime.done); } catch {} }
      report.cleanup.browserStopped = lifetime?.terminal() === true;
    } else report.cleanup.browserStopped = true;
    if (report.cleanup.browserStopped) for (const sandbox of sandboxes) try {
      await bounded(sandbox.close()); assert.equal(sandbox.database.closed, true, code); sandboxes.delete(sandbox);
    } catch { report.failure ??= { code, phase: 'SANDBOX_CLEANUP', kind: 'Error' }; }
    report.cleanup.sandboxesClosed = sandboxes.size === 0; report.finishedAt = new Date().toISOString();
    report.passed = !report.failure && !report.cleanupObservationTimedOut && report.checks.length === 3 &&
      report.errors.length === 0 && report.unexpectedRequests.length === 0 && Object.values(report.cleanup).every(Boolean);
    ownership.finished = Object.values(report.cleanup).every(Boolean); ownership.cleanup = report.cleanup;
    await save('ownership.json', ownership); await save('results.json', report);
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length, failure: report.failure, cleanup: report.cleanup }));
  return report.passed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runLocalRecordComparisonBrowser()) process.exitCode = 1; }
  catch { console.error('LOCAL_RECORD_COMPARISON_CONFIGURATION_OR_STARTUP_FAILED'); process.exitCode = 1; }
}

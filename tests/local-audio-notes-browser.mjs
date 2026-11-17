// Real Chrome -> owned local HTTP -> new memory DB; the audio model response is
// an explicit fixture. No real people, keys, paid calls or public deployment.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { messageBrowserOptions } from './message-browser-policy.mjs';
import { studyChildEnvironment } from '../scripts/p0-study-policy.mjs';
import { workspaceRoom } from './local-workspace-browser-helpers.mjs';
import { createLocalAiApiSandbox } from '../server/local-api-sandbox.mjs';
import { Records } from '../server/records.mjs';
import { audioNoteFields } from '../src/audio-note-contract.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const analysis = {
  transcript: { text: '가상 시험입니다. 블록 놀이를 했고 아이가 블록을 골랐습니다. 다음에는 같은 블록을 준비합니다.',
    durationSeconds: 3, segments: [
      { id: 0, start: 0, end: 1, text: '가상 시험입니다. 블록 놀이를 했고' },
      { id: 1, start: 1, end: 2, text: '아이가 블록을 골랐습니다.' },
      { id: 2, start: 2, end: 3, text: '다음에는 같은 블록을 준비합니다.' }] },
  analysis: {
    performed: [{ text: '블록 놀이를 진행함.', segmentIds: [0] }],
    response: [{ text: '아이가 블록을 선택함.', segmentIds: [1] }],
    reflection: [{ text: '가상 내부 확인: 선택할 시간을 충분히 주었는지 확인할까요?', segmentIds: [1] }],
    nextPlan: [{ text: '다음 수업에는 같은 블록을 준비함.', segmentIds: [2] }],
    summary: [{ text: '블록 놀이를 했고, 아이가 사용할 블록을 골랐어요.', segmentIds: [0, 1] }],
    warnings: ['합성 응답이며 실제 전사 정확도 검사가 아닙니다.'],
  },
};
const fields = audioNoteFields(analysis);
function syntheticWav() {
  const bytes = Buffer.alloc(44 + 16000 * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
async function manifest() {
  const files = ['tests/local-audio-notes-browser.mjs', 'tests/local-workspace-browser-helpers.mjs'];
  for (const dir of ['src', 'local-api', 'server'])
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true }))
      if (entry.isFile() && /\.(js|mjs|css|html)$/.test(entry.name)) files.push(dir + '/' + entry.name);
  const hashes = await Promise.all(files.sort().map(async name => ({ name, sha256: digest(await readFile(path.join(root, name))) })));
  return { sha256: digest(JSON.stringify(hashes)), files: hashes };
}
async function bounded(work) {
  let timer; try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CLEANUP_TIMEOUT')), 15000); })]); }
  finally { clearTimeout(timer); }
}
export async function run(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  const { chromium } = await import(pathToFileURL(options.module).href);
  const runId = randomUUID(), folder = path.join(root, 'test-results', 'local-audio-notes-' + runId);
  await mkdir(folder, { recursive: true });
  const report = { runId, source: await manifest(), passed: false, checks: [], errors: [], unexpectedRequests: [],
    screenshots: [], actualModelCalls: 0, syntheticOnly: true,
    limitations: ['Timestamped model response is a fixture, not acoustic transcription proof.',
      'Memory DB and source buffers are ephemeral; no real retention, durable audit, physical iPhone or deployment proof.'],
    cleanup: { contextsClosed: false, browserStopped: false, sandboxesClosed: false } };
  let browserServer, browser, browserProcess, phase = 'START';
  const contexts = new Set(), sandboxes = new Set();
  const ownership = { runId, testProcessId: process.pid, browserProcessId: null, origins: [], finished: false };
  const saveOwnership = () => writeFile(path.join(folder, 'ownership.json'), JSON.stringify(ownership, null, 2));
  await saveOwnership();
  try {
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: '127.0.0.1', port: 0, env: studyChildEnvironment(), timeout: 30000 });
    browserProcess = browserServer.process(); ownership.browserProcessId = browserProcess.pid; await saveOwnership();
    browser = await chromium.connect(browserServer.wsEndpoint());
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
      phase = viewport.width + ':START'; let modelCalls = 0;
      const sandbox = await createLocalAiApiSandbox({
        summaryProvider: { mode: 'fixture', model: 'fixture-text', generate: async () => { assert.fail('Unexpected summary provider'); } },
        chatProvider: { mode: 'fixture', model: 'fixture-chat', respond: async () => { assert.fail('Unexpected chat provider'); } },
        audioProvider: { mode: 'fixture', model: 'fixture-audio-analysis', transcriptionModel: 'fixture-transcript',
          generate: async ({ bytes, type }, { signal, authorizeStage }) => {
            assert.equal(type, 'audio/wav'); assert.equal(digest(bytes), digest(syntheticWav())); assert(!signal.aborted);
            await authorizeStage?.('transcription'); await authorizeStage?.('analysis');
            modelCalls++; return structuredClone(analysis);
          } },
      });
      sandboxes.add(sandbox); ownership.origins.push(sandbox.origin); await saveOwnership();
      const ids = sandbox.ids, records = new Records(sandbox.database);
      const actor = { userId: ids.therapistId, centerId: ids.centerId }, recordId = 'audio-record-' + randomUUID();
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const originalContent = { date: today, title: '가상 녹음 수업 보고서', goalId: ids.goalId, status: 'saved',
        performed: '직접 작성한 관찰은 유지합니다.', response: '', privateNote: '', nextPlan: '', summary: '',
        assessments: [], observation: null, activity: null };
      await records.save(actor, { conversationId: ids.conversationId, recordId, clientId: randomUUID(), expectedRevision: 0, content: originalContent });
      const record = () => records.get(actor, { conversationId: ids.conversationId, recordId });
      const original = await record();
      const createContext = async () => {
        const context = await browser.newContext({ viewport, locale: 'ko-KR', isMobile: viewport.width < 600,
          hasTouch: viewport.width < 600, serviceWorkers: 'block', permissions: [], acceptDownloads: false });
        contexts.add(context);
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin !== sandbox.origin || !['GET', 'POST'].includes(route.request().method())) {
            report.unexpectedRequests.push({ phase, method: route.request().method() }); return route.abort('blockedbyclient');
          }
          return route.continue();
        });
        context.on('page', page => {
          page.setDefaultTimeout(15000);
          page.on('pageerror', () => report.errors.push({ phase, kind: 'PAGE_ERROR' }));
          page.on('console', message => { if (message.type() === 'error' && !/status of 401/.test(message.text()))
            report.errors.push({ phase, kind: 'CONSOLE_ERROR' }); });
          page.on('dialog', prompt => void prompt.accept());
        });
        return context;
      };
      const login = async (page, role) => {
        await page.goto(sandbox.origin); await page.getByTestId('login-form').waitFor();
        const credential = sandbox.credentials.find(item => item.role === role);
        assert(credential.email.endsWith('.test'));
        await page.getByLabel('시험 이메일', { exact: true }).fill(credential.email);
        await page.getByLabel('시험 비밀번호', { exact: true }).fill(credential.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click(); await page.getByTestId('home').waitFor();
        await workspaceRoom(page, ids.conversationId);
      };
      const capture = async (page, label) => {
        const name = viewport.width + '-' + label + '.png';
        await page.screenshot({ path: path.join(folder, name), mask: [page.locator('input[type=password]'), page.locator('input[type=email]'), page.locator('.account-panel')] });
        report.screenshots.push(name);
      };
      const context = await createContext(), page = await context.newPage();
      await login(page, 'therapist');
      phase = viewport.width + ':UPLOAD';
      await page.locator('[data-action="ai-assistant"]').click();
      await page.locator('[data-ai-action="audio"]').click();
      await page.locator('[data-audio-record] option[value="' + recordId + '"]').waitFor({ state: 'attached' });
      await page.locator('[data-audio-record]').selectOption(recordId);
      await page.locator('[data-audio-file]').setInputFiles({ name: 'synthetic.wav', mimeType: 'audio/wav', buffer: syntheticWav() });
      await page.locator('[data-audio-check="syntheticConfirmed"]').check();
      await page.locator('[data-audio-check="processingConfirmed"]').check();
      await page.locator('[data-audio-action="upload"]').click();
      await page.locator('[data-audio-action="start"]').waitFor(); assert.equal(modelCalls, 0);
      await capture(page, 'uploaded-no-ai-call');
      phase = viewport.width + ':ANALYZE';
      await page.locator('[data-audio-action="start"]').click();
      await page.locator('[data-audio-check="reviewed"]').waitFor();
      assert.equal(modelCalls, 1); assert.deepEqual(await record(), original);
      assert.equal(await page.locator('[data-audio-field="performed"]').isChecked(), false);
      assert.equal(await page.locator('[data-audio-field="summary"]').isChecked(), true);
      await page.locator('[data-audio-details="transcript"] > summary').click();
      await page.locator('[data-audio-segment="0"]').waitFor({ state: 'visible' });
      assert((await page.locator('.audio-transcript').innerText()).includes('가상 시험'));
      await page.locator('[data-audio-check="reviewed"]').check();
      await page.setViewportSize({ width: viewport.width, height: 420 });
      const apply = page.locator('[data-audio-action="apply"]');
      await apply.scrollIntoViewIfNeeded();
      const layout = await apply.evaluate(node => {
        const r = node.getBoundingClientRect(), dialog = node.closest('dialog'), d = dialog.getBoundingClientRect();
        const body = dialog.querySelector('.audio-body').getBoundingClientRect(), f = dialog.querySelector('footer').getBoundingClientRect();
        const points = [[r.left + 4, r.top + 4], [r.right - 4, r.top + 4], [r.left + 4, r.bottom - 4],
          [r.right - 4, r.bottom - 4], [r.left + r.width / 2, r.top + r.height / 2]];
        return { inside: d.top >= -1 && d.bottom <= innerHeight + 1 && r.top >= body.top - 1 && r.bottom <= Math.min(body.bottom, f.top) + 1,
          noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1 && dialog.scrollWidth <= dialog.clientWidth + 1,
          tappable: r.height >= 44 && points.every(([x, y]) => node.contains(document.elementFromPoint(x, y))) };
      });
      assert(layout.inside && layout.noHorizontalOverflow && layout.tappable, 'AUDIO_BROWSER_LAYOUT');
      await capture(page, 'review-short'); await page.setViewportSize(viewport);
      phase = viewport.width + ':APPLY_SAVE_SHARE';
      await apply.click(); await page.locator('dialog.audio-notes').waitFor({ state: 'detached' });
      const form = page.locator('[data-care-form="record"]'); await form.waitFor();
      assert.equal(await form.locator('[name="performed"]').inputValue(), originalContent.performed);
      for (const field of ['response', 'privateNote', 'nextPlan', 'summary'])
        assert.equal(await form.locator('[name="' + field + '"]').inputValue(), fields[field]);
      assert.deepEqual(await record(), original, 'AUDIO_APPLY_IS_UNSAVED');
      await form.getByRole('button', { name: '보호자 공유 준비', exact: true }).click();
      const publish = page.locator('[data-care-form="publish"]'); await publish.waitFor();
      const saved = await record(); assert.equal(saved.revision, original.revision + 1);
      assert.equal(saved.privateNote, fields.privateNote); assert.equal(saved.performed, originalContent.performed);
      const preview = await publish.innerText();
      assert(preview.includes(fields.summary)); assert(!preview.includes(fields.privateNote)); assert(!preview.includes(analysis.transcript.text));
      await publish.locator('[name="confirmed"]').check();
      await publish.getByRole('button', { name: '확인하고 공유', exact: true }).click();
      await page.getByTestId('care-dialog').waitFor({ state: 'hidden' });
      await page.reload(); await page.getByTestId('home').waitFor(); await workspaceRoom(page, ids.conversationId);
      assert.equal((await record()).summary, fields.summary);
      phase = viewport.width + ':GUARDIAN_CALENDAR';
      const guardianContext = await createContext(), guardian = await guardianContext.newPage(); await login(guardian, 'guardian');
      await guardian.locator('[data-view="child"]').click();
      const calendar = guardian.locator('[data-calendar-reports]'); await calendar.waitFor();
      const reportLink = calendar.locator('[data-calendar-report]').filter({ hasText: originalContent.title });
      assert.equal(await reportLink.count(), 1); await reportLink.click();
      await guardian.locator('.care-publication').filter({ hasText: fields.summary }).waitFor();
      const visible = await guardian.locator('body').innerText();
      assert(!visible.includes(fields.privateNote)); assert(!visible.includes(fields.nextPlan)); assert(!visible.includes(analysis.transcript.text));
      await guardian.locator('[data-action="ai-assistant"]').click();
      await guardian.locator('.ai-assistant[open]').waitFor();
      assert.equal(await guardian.locator('[data-ai-action="audio"]').count(), 0);
      await guardian.locator('[data-ai-action="close"]').click();
      await capture(guardian, 'guardian-report');
      assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
      assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedRequests, []);
      await context.close(); contexts.delete(context); await guardianContext.close(); contexts.delete(guardianContext);
      await sandbox.close(); assert(sandbox.database.closed); sandboxes.delete(sandbox);
      report.checks.push({ ...viewport, layout, uploadBeforeModel: true, fixtureModelCalls: modelCalls, reviewedApplyOnly: true,
        manualTextPreserved: true, savedAndReloaded: true, guardianCalendarReport: true, privateDataExcluded: true });
      console.log(JSON.stringify({ width: viewport.width, passed: true, fixtureModelCalls: modelCalls }));
    }
    report.finalSource = await manifest(); assert.equal(report.source.sha256, report.finalSource.sha256, 'AUDIO_SOURCE_CHANGED');
  } catch (error) {
    report.failure = { phase, kind: error?.name, line: Number(error?.stack?.match(/local-audio-notes-browser\.mjs:(\d+):/)?.[1]) || null };
    for (const context of contexts) for (const page of context.pages()) try {
      const name = 'failure-' + report.screenshots.length + '.png';
      await page.screenshot({ path: path.join(folder, name), mask: [page.locator('input[type=password]'), page.locator('input[type=email]'), page.locator('.account-panel')] });
      report.screenshots.push(name);
    } catch {}
  } finally {
    for (const context of contexts) try { await bounded(context.close()); contexts.delete(context); } catch {}
    report.cleanup.contextsClosed = contexts.size === 0;
    if (browserServer) { try { await bounded(browserServer.close()); } catch { try { await bounded(browserServer.kill()); } catch {} } }
    report.cleanup.browserStopped = typeof browserProcess?.exitCode === 'number' || typeof browserProcess?.signalCode === 'string';
    for (const sandbox of sandboxes) try { await bounded(sandbox.close()); sandboxes.delete(sandbox); } catch {}
    report.cleanup.sandboxesClosed = sandboxes.size === 0;
    report.passed = !report.failure && report.checks.length === 3 && Object.values(report.cleanup).every(Boolean);
    ownership.finished = true; ownership.cleanup = report.cleanup; await saveOwnership();
    await writeFile(path.join(folder, 'results.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length, failure: report.failure, cleanup: report.cleanup }));
  return report.passed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await run()) process.exitCode = 1; }
  catch { console.error('AUDIO_BROWSER_CONFIGURATION_FAILED'); process.exitCode = 1; }
}

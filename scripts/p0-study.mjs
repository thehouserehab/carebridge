import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { captureStudyVersions, serveStudySnapshot } from './p0-study-snapshots.mjs';
import { STUDY_STORAGE_KEY, STUDY_MARKER, TASK_A, TASK_B, LEGACY_NOTE, sha256,
  studyChildEnvironment, studyOptions, seedStudyStorage } from './p0-study-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const readState = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key)), STUDY_STORAGE_KEY);
async function fill(page, name, value) {
  const input = page.locator(`#edit-form [name="${name}"]`);
  for (const details of await input.locator('xpath=ancestor::details').all())
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
  await input.fill(String(value));
}

async function automaticTask(page, version, task, day, fixture, initial) {
  if (task === 'A') {
    if (version === 'revised') {
      await page.locator('.conversation-row[data-id="c1"]').click();
      assert.ok((await page.locator('#main').innerText()).includes(fixture.publications[0].summary));
    }
    else {
      const shared = page.locator('.record-card').filter({ hasText: '놀이 참여 관찰' });
      assert.ok((await shared.innerText()).includes(fixture.publications[0].summary));
      await shared.getByRole('button', { name: '연결된 가정 활동', exact: true }).click();
    }
    assert.ok((await page.locator('#main').innerText()).includes('좋아하는 놀이 함께 고르기'));
    await page.getByRole('button', { name: '활동 경험 남기기', exact: true }).click();
    await fill(page, 'date', day);
    await page.locator('#edit-form [name=result]').selectOption(TASK_A.result);
    await fill(page, 'reaction', TASK_A.reaction); await fill(page, 'difficulty', TASK_A.difficulty);
    await page.locator('#edit-form button[type=submit]').click();
  } else {
    await page.getByRole('button', { name: '기록하기', exact: true }).first().click();
    await fill(page, 'date', day);
    await page.locator('#edit-form [name=goalId]').selectOption('g1');
    for (const key of ['title', 'summary', 'nextPlan']) await fill(page, key, TASK_B[key]);
    if (version === 'revised') {
      await fill(page, 'performed', TASK_B.performed); await fill(page, 'response', TASK_B.response);
      await page.locator('#dialog summary').filter({ hasText: /^상세 관찰·측정값$/ }).click();
      for (let index = 0; index < 2; index++) {
        await page.getByRole('button', { name: '측정값 추가', exact: true }).click();
        for (const [key, value] of Object.entries(TASK_B.assessments[index])) await fill(page, `assessment-${index}-${key}`, value);
      }
    } else {
      await fill(page, 'privateNote', LEGACY_NOTE);
      await page.getByLabel('평가값 직접 입력', { exact: true }).check();
      for (const [key, value] of Object.entries(TASK_B.assessments[0])) await fill(page, key, value);
    }
    await page.getByRole('button', { name: '기록 저장', exact: true }).click();
  }
  await page.locator('#dialog').waitFor({ state: 'hidden' });
  const saved = await readState(page);
  if (task === 'A') {
    assert.equal(saved.feedback.length, 1);
    for (const [key, value] of Object.entries({ ...TASK_A, date: day, childId: 'c1', publicationId: 'pub1' })) assert.equal(saved.feedback[0][key], value);
    assert.deepEqual(saved.records, initial.records);
  } else {
    assert.equal(saved.records.length, fixture.records.length + 1);
    const record = saved.records.at(-1);
    for (const [key, value] of Object.entries({ title: TASK_B.title, summary: TASK_B.summary, nextPlan: TASK_B.nextPlan,
      childId: 'c1', goalId: 'g1', date: day })) assert.equal(record[key], value);
    if (version === 'revised') {
      assert.equal(record.status, 'saved'); assert.equal(record.performed, TASK_B.performed); assert.equal(record.response, TASK_B.response);
      assert.deepEqual(record.assessments, TASK_B.assessments);
    } else { assert.deepEqual(record.assessment, TASK_B.assessments[0]); assert.equal(record.privateNote, LEGACY_NOTE); }
    assert.deepEqual(saved.records.slice(0, -1), initial.records);
    assert.equal(saved.feedback.length, 0);
  }
  assert.deepEqual(saved.publications, initial.publications);
  await page.reload(); await page.getByLabel('사용자 역할', { exact: true }).waitFor();
  assert.deepEqual(await readState(page), saved, 'Actual saved information must survive reload; no automatic reseed');
  const visible = await page.locator('#main').innerText();
  if (task === 'A') {
    assert.ok(visible.includes(TASK_A.reaction) && visible.includes(TASK_A.difficulty), 'Saved feedback must render again');
    if (version === 'revised') {
      // The saved instant must agree with the displayed browser-local clock,
      // including a Korean early-morning message on the previous UTC date.
      const message = saved.messages.find((item) => item.type === 'feedback' && item.sourceId === saved.feedback[0].id);
      assert.ok(message, 'Saved feedback has a conversation message');
      const expected = await page.evaluate((instant) => ({
        divider: new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(instant)),
        listDate: new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric' }).format(new Date(instant)),
        time: new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(new Date(instant)),
      }), message.createdAt);
      const card = page.locator(`[data-message-id="${message.id}"]`);
      assert.equal(await card.locator('xpath=preceding-sibling::p[@class="chat-date"][1]').textContent(), expected.divider);
      assert.equal(await card.locator('.message-meta time').textContent(), expected.time);
      assert.equal(await page.locator('.conversation-row[data-id="c1"] .conversation-meta time').textContent(), `${expected.listDate} ${expected.time}`);
    }
  } else {
    assert.ok(visible.includes(TASK_B.title) && visible.includes(TASK_B.summary), 'Saved record must render again');
    const record = saved.records.at(-1);
    await page.locator(`[data-action="record"][data-id="${record.id}"]`).click();
    const expected = { date: day, goalId: 'g1', title: TASK_B.title, summary: TASK_B.summary, nextPlan: TASK_B.nextPlan };
    if (version === 'revised') {
      Object.assign(expected, { performed: TASK_B.performed, response: TASK_B.response });
      TASK_B.assessments.forEach((measurement, index) => {
        for (const [key, value] of Object.entries(measurement)) expected[`assessment-${index}-${key}`] = String(value);
      });
    } else Object.assign(expected, { privateNote: LEGACY_NOTE, ...Object.fromEntries(Object.entries(TASK_B.assessments[0]).map(([key, value]) => [key, String(value)])) });
    for (const [name, value] of Object.entries(expected))
      assert.equal(await page.locator(`#edit-form [name="${name}"]`).inputValue(), value, `Reopened saved ${name}`);
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await page.locator('#dialog').waitFor({ state: 'hidden' });
    assert.deepEqual(await readState(page), saved);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
}

export async function runStudy(args = process.argv.slice(2)) {
  const options = studyOptions(args);
  if (options.interactive && !process.stdin.isTTY) throw new Error('Interactive study requires an owned interactive terminal');
  if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright index.mjs; no automatic installation');
  const executablePath = process.env.STUDY_CHROMIUM_EXECUTABLE;
  if (executablePath && (!path.isAbsolute(executablePath) || !(await lstat(executablePath)).isFile()))
    throw new Error('STUDY_CHROMIUM_EXECUTABLE must be an existing absolute browser executable path');
  const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
  const snapshots = await captureStudyVersions(root);
  const runId = randomUUID(), folder = fileURLToPath(new URL(`../test-results/p0-study-${runId}/`, import.meta.url));
  await mkdir(folder, { recursive: true });
  const servers = {}, contexts = [], problems = [], checks = [];
  const result = { runId, at: new Date().toISOString(), mode: options.interactive ? 'interactive-preparation' : 'automatic-preparation',
    humanValidation: 'not-recorded-by-this-tool', humanMetricsCollected: false, physicalDeviceValidation: 'not-run',
    versions: Object.fromEntries(Object.entries(snapshots).map(([key, snapshot]) => [key, snapshot.manifest])), checks, problems,
    limitations: 'Synthetic local browser state only; not human timing, comprehension, physical devices, actual login, API, cross-device delivery or independent backup.' };
  let browser, prompt, interrupted = false;
  const onSignal = () => { interrupted = true; prompt?.close(); void browser?.close().catch(() => {}); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    for (const version of ['baseline', 'revised']) servers[version] = await serveStudySnapshot(snapshots[version]);
    result.origins = Object.fromEntries(Object.entries(servers).map(([key, server]) => [key, server.origin]));
    browser = await chromium.launch({ headless: true, executablePath, env: studyChildEnvironment(), timeout: 30_000 });
    result.browserVersion = browser.version();
    const newContext = async (version, width) => {
      const origin = servers[version].origin;
      const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', serviceWorkers: 'block' });
      contexts.push(context);
      await context.route('**/*', async (route) => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method()) || url.pathname.startsWith('/api/')) {
          problems.push({ kind: 'blocked-request', version }); await route.abort();
        } else await route.continue();
      });
      context.on('page', (page) => {
        page.setDefaultTimeout(12_000);
        page.on('pageerror', () => problems.push({ kind: 'page-error', version }));
        page.on('console', (message) => { if (message.type() === 'error') problems.push({ kind: 'console-error', version }); });
        page.on('response', (response) => { if (response.status() >= 400) problems.push({ kind: 'http-error', version, status: response.status() }); });
      });
      return context;
    };
    // Read the synthetic seed from the pinned public module in a throwaway
    // context, never from a user's storage or the mutable product dev server.
    const preparation = await newContext('baseline', 1440), preparePage = await preparation.newPage();
    await preparePage.goto(servers.baseline.origin);
    await preparePage.locator('#main h2').first().waitFor();
    const fixture = await preparePage.evaluate(async () => (await import('/src/seed.js')).seed());
    assert.equal(fixture.schema, 2); assert.equal(fixture.feedback.length, 0);
    const day = fixture.appointments.find((item) => item.id === 'a1').date;
    result.fixture = { sha256: sha256(JSON.stringify(fixture)), schema: 2, day, childId: 'c1', goalId: 'g1', publicationId: 'pub1' };
    await preparation.close();
    const pages = [];
    // Always complete the same captured versions/tasks before the optional
    // human session; a render-only check is not sufficient preparation.
    for (const width of [1440, 390])
      for (const task of ['A', 'B'])
        for (const version of options.versions) {
          result.activeCheck = { version, task, width };
          const context = await newContext(version, width);
          await context.addInitScript(seedStudyStorage, { origin: servers[version].origin, fixture, task,
            storageKey: STUDY_STORAGE_KEY, marker: STUDY_MARKER });
          const page = await context.newPage(); await page.goto(servers[version].origin);
          await page.locator('#main h2').first().waitFor();
          const initial = await readState(page);
          assert.equal(initial.children.find((item) => item.id === 'c1').name, '하루');
          assert.equal(initial.goals.find((item) => item.id === 'g1').title, '놀이에 스스로 참여하기');
          assert.equal(initial.records.length, fixture.records.length); assert.equal(initial.feedback.length, 0);
          assert.equal(initial.publications[0].id, 'pub1'); assert.equal(initial.publications[0].summary, fixture.publications[0].summary);
          await page.screenshot({ path: `${folder}${version}-${task}-${width}-home.png`, fullPage: true });
          await automaticTask(page, version, task, day, fixture, initial);
          await page.screenshot({ path: `${folder}${version}-${task}-${width}-saved.png`, fullPage: true });
          checks.push({ version, task, width, status: 'passed', storedInformationComplete: true, reloadPreserved: true, savedInformationRendered: true,
            secondMeasurement: task === 'B' ? (version === 'baseline' ? 'explicit-private-text' : 'structured-row-with-zero') : 'not-applicable' });
          await context.close();
        }
    assert.deepEqual(problems, [], 'Preparation must be error-free before inviting a participant');
    delete result.activeCheck;
    if (options.interactive) {
      await browser.close();
      browser = await chromium.launch({ headless: false, executablePath, env: studyChildEnvironment(), timeout: 30_000 });
      for (const version of options.versions) {
        const context = await newContext(version, 1440);
        await context.addInitScript(seedStudyStorage, { origin: servers[version].origin, fixture, task: options.task,
          storageKey: STUDY_STORAGE_KEY, marker: STUDY_MARKER });
        const page = await context.newPage(); await page.goto(servers[version].origin);
        await page.locator('#main h2').first().waitFor();
        const label = () => page.evaluate(({ version, task }) => {
          document.title = `${version === 'baseline' ? '기존' : '개편'} · Carebridge · 과제 ${task}`;
        }, { version, task: options.task });
        page.on('load', () => { void label().catch(() => {}); });
        await label();
        pages.push(page);
      }
      assert.deepEqual(problems, [], 'Human session must start error-free');
      console.log(`가상 PC 비교 준비됨. 과제 ${options.task}; 순서 ${options.versions.join(' → ')}; 시험일 ${day}.`);
      console.log('docs/p0-user-validation.md의 과제와 관측 규칙을 사용하세요. 실제 자료 입력/첨부 금지. 시간·이동 수·이해도는 진행자가 별도 기록합니다.');
      if (options.task === 'B') console.log(`기존 화면의 내부 메모에는 다음 내용을 남깁니다:\n${LEGACY_NOTE}`);
      console.log(`버전 체크섬/시험 준비 기록: ${folder}results.json`);
      await pages[0].bringToFront();
      prompt = createInterface({ input: process.stdin, output: process.stdout });
      await Promise.race([
        prompt.question('체험을 마쳤으면 터미널에서 Enter. 두 시험 창과 가상 저장소가 종료됩니다. '),
        new Promise((resolve) => browser.once('disconnected', resolve)),
      ]);
      result.interactiveTask = options.task; result.order = options.versions;
    }
    if (interrupted) throw new Error('Study interrupted');
    result.status = options.interactive ? 'interactive-session-ended-no-human-results-collected' : 'preparation-passed';
  } catch (error) {
    result.status = 'preparation-failed'; result.failure = String(error.message).slice(0, 1200);
    throw error;
  } finally {
    prompt?.close();
    for (const context of contexts) await context.close().catch(() => {});
    const cleanupFailures = [];
    if (browser) await browser.close().catch(() => cleanupFailures.push('browser-close'));
    const closed = await Promise.allSettled(Object.values(servers).map((server) => server.close()));
    if (closed.some((entry) => entry.status === 'rejected')) cleanupFailures.push('snapshot-server-close');
    result.resourcesClosed = cleanupFailures.length === 0;
    if (!result.resourcesClosed) { result.status = 'preparation-failed'; result.cleanupFailures = cleanupFailures; }
    await writeFile(`${folder}results.json`, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    console.log(JSON.stringify({ runId, status: result.status, checks: checks.length, problems: problems.length,
      result: `${folder}results.json`, resourcesClosed: result.resourcesClosed, humanMetricsCollected: false }));
    if (!result.resourcesClosed) throw new Error('Study resources did not close successfully; see retained preparation result');
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await runStudy();

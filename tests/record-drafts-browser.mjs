import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { messageBrowserConnection } from './message-browser-policy.mjs';
assert.ok(process.env.PLAYWRIGHT_MODULE, 'Use an owned test browser');
const base = new URL(process.env.APP_URL || 'http://127.0.0.1:4176');
assert.ok(['http:','https:'].includes(base.protocol) && ['127.0.0.1','localhost','[::1]'].includes(base.hostname), 'Synthetic loopback tests only');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const connection = messageBrowserConnection({ wsEndpoint: process.env.PLAYWRIGHT_WS_ENDPOINT, cdpUrl: process.env.CDP_URL });
const browser = connection.kind === 'playwright' ? await chromium.connect(connection.url) : await chromium.connectOverCDP(connection.url);
const root = fileURLToPath(new URL('../test-results/', import.meta.url));
await mkdir(root, { recursive:true });
const runId = crypto.randomUUID(), checks = [], errors = [], unexpectedRequests = [];
const photo = { name:'가상-기록-초안.png', mimeType:'image/png', buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=', 'base64') };
let failure = null;
const data = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('child-development-demo-v2')));
const nav = (page, name) => page.getByRole('navigation', { name:page.viewportSize().width <= 640 ? '모바일 메뉴' : '주요 메뉴', exact:true }).getByRole('button', { name, exact:true }).click();
const dialog = (page) => page.locator('#dialog');
async function reveal(locator) {
  for (const details of await locator.locator('xpath=ancestor::details').all())
    if (await details.getAttribute('open') === null) await details.locator(':scope > summary').click();
}
async function fill(page, name, value) {
  const locator = dialog(page).locator(`[name="${name}"]`);
  await reveal(locator); await locator.fill(value);
}
async function row(page, index, values) {
  for (const [key,value] of Object.entries(values)) await fill(page, `assessment-${index}-${key}`, String(value));
}
async function save(page, name) {
  const button = dialog(page).getByRole('button', { name, exact:true });
  await button.focus(); await button.press('Enter');
  await dialog(page).waitFor({ state:'hidden' });
}
async function file(page) {
  const input = dialog(page).locator('input[type=file]');
  await reveal(input); await input.setInputFiles(photo);
  await page.waitForFunction(() => document.querySelector('#dialog .attachment-row') && !document.querySelector('#dialog input[type=file]').disabled);
}
async function bytes(page, id) {
  return page.evaluate(async (id) => { const { MediaStore } = await import('/src/media-store.js'); const blob = await new MediaStore().read(id); return blob ? [...new Uint8Array(await blob.arrayBuffer())] : null; }, id);
}
async function screenshot(page, width, kind) {
  await page.bringToFront(); await page.screenshot({ path:`${root}/record-drafts-${width}-${kind}.png`, fullPage:true, timeout:15000 });
}
async function template(page, width) {
  await nav(page, '기록');
  await page.getByRole('button', { name:'기록 작성', exact:true }).click();
  await fill(page, 'performed', '가상 이전 회기 활동');
  await fill(page, 'response', '이전 회기 결과를 새 관찰로 복사하지 않음');
  await fill(page, 'nextPlan', '가상 이전 계획');
  await fill(page, 'summary', '가상 이전 요약');
  await fill(page, 'privateNote', '가상 이전 내부 메모');
  await fill(page, 'observation-task', '가상 이전 관찰');
  await dialog(page).locator('[name="observation-status"]').selectOption('observed');
  await dialog(page).getByRole('button', { name:'측정값 추가', exact:true }).click();
  await row(page, 0, { tool:'가상 반복 관찰', item:'가상 시도', value:43, unit:'회', context:'가상 조건 A' });
  await dialog(page).getByRole('button', { name:'측정값 추가', exact:true }).click();
  await row(page, 1, { tool:'가상 시간 관찰', item:'가상 시간', value:0, unit:'분', context:'가상 조건 B' });
  await save(page, '기록 저장');
  const previous = await data(page), source = previous.records.at(-1);
  await page.getByRole('button', { name:'기록 작성', exact:true }).click();
  await dialog(page).getByRole('button', { name:'이전 목표·측정 항목만 가져오기', exact:true }).click();
  assert.equal(await dialog(page).locator('[name="goalId"]').inputValue(), source.goalId);
  for (const name of ['performed','response','nextPlan','summary','privateNote','observation-task'])
    assert.equal(await dialog(page).locator(`[name="${name}"]`).inputValue(), '');
  for (let i = 0; i < 2; i++) {
    assert.equal(await dialog(page).locator(`[name="assessment-${i}-value"]`).inputValue(), '');
    for (const key of ['tool','item','unit','context']) assert.equal(await dialog(page).locator(`[name="assessment-${i}-${key}"]`).inputValue(), source.assessments[i][key]);
  }
  await row(page, 1, { unit:'' });
  await dialog(page).getByRole('button', { name:'측정값 추가', exact:true }).click();
  await fill(page, 'observation-task', '가상 작성 중 과제');
  const activity = dialog(page).locator('[name="hasActivity"]'); await reveal(activity); await activity.check();
  await fill(page, 'activityTitle', '가상 작성 중 활동');
  await file(page);
  await save(page, '초안 저장');
  const stored = await data(page), draft = stored.records.at(-1);
  assert.equal(draft.status, 'draft'); assert.notEqual(draft.id, source.id);
  assert.equal(draft.assessments.length, 3);
  assert.ok(draft.assessments.every((a) => a.value === null));
  assert.equal(draft.assessments[1].unit, '');
  assert.equal(draft.observation.status, ''); assert.equal(draft.observation.task, '가상 작성 중 과제');
  assert.equal(draft.activity.instruction, ''); assert.equal(draft.activity.title, '가상 작성 중 활동');
  assert.equal(draft.attachments[0].share, false);
  assert.deepEqual(stored.records.slice(0,-1), previous.records); assert.deepEqual(stored.publications, previous.publications);
  assert.deepEqual(await bytes(page, draft.attachments[0].id), [...photo.buffer]);
  await page.reload(); await nav(page, '기록');
  assert.deepEqual((await data(page)).records.at(-1), draft);
  const comparisons = page.locator('.comparison').filter({ hasText:'가상 시도' });
  assert.equal(await comparisons.locator('b').count(), 1, 'Draft rows do not appear as new measurement results');
  assert.equal(await comparisons.locator('b').innerText(), '43 회');
  await page.locator(`[data-action="record"][data-id="${draft.id}"]`).click();
  for (let i = 0; i < 3; i++) assert.equal(await dialog(page).locator(`[name="assessment-${i}-value"]`).inputValue(), '');
  assert.equal(await dialog(page).locator('[name="observation-task"]').inputValue(), '가상 작성 중 과제');
  assert.equal(await dialog(page).locator('[name="activityTitle"]').inputValue(), '가상 작성 중 활동');
  await dialog(page).getByRole('button', { name:'기록 저장', exact:true }).click();
  assert.equal(await dialog(page).isVisible(), true);
  assert.deepEqual(await data(page), stored, 'Native completion validation must not partially commit');
  assert.ok(await dialog(page).locator(':invalid').count() > 0);
  await screenshot(page, width, 'unfinished');
  await row(page, 0, { value:0 }); await row(page, 1, { value:9, unit:'분' });
  await dialog(page).locator('[data-assessment]').nth(2).getByRole('button', { name:'이 측정값 제거', exact:true }).click();
  await dialog(page).locator('[name="observation-status"]').selectOption('observed');
  await fill(page, 'performed', '가상 새로운 활동'); await fill(page, 'response', '가상 새 관찰');
  await fill(page, 'nextPlan', 'PRIVATE-NEXT-FIXTURE'); await fill(page, 'privateNote', 'PRIVATE-DRAFT-FIXTURE');
  await fill(page, 'instruction', '가상 활동 안내'); await fill(page, 'frequency', '가상 활동 빈도');
  await fill(page, 'summary', '가상 보호자용 요약');
  await dialog(page).locator('[data-share-media]').check();
  await save(page, '기록 저장');
  const completed = await data(page), saved = completed.records.at(-1);
  assert.equal(saved.status, 'saved'); assert.deepEqual(saved.assessments.map((a) => a.value), [0,9]);
  assert.deepEqual(completed.records.slice(0,-1), previous.records);
  await page.locator(`[data-action="preview"][data-id="${draft.id}"]`).click();
  const preview = await dialog(page).innerText();
  assert.ok(preview.includes('수신자') && preview.includes('가상 보호자용 요약'));
  assert.ok(!preview.includes('PRIVATE-DRAFT-FIXTURE') && !preview.includes('PRIVATE-NEXT-FIXTURE') && !preview.includes('가상 시도'));
  assert.equal(await dialog(page).locator('.media-item').count(), 1);
  await screenshot(page, width, 'preview');
  await save(page, '보호자에게 공유');
  await page.getByLabel('사용자 역할', { exact:true }).selectOption('guardian');
  await nav(page, '기록');
  const guardianText = await page.locator('#main').innerText();
  assert.ok(guardianText.includes('가상 보호자용 요약'));
  assert.ok(!guardianText.includes('PRIVATE-DRAFT-FIXTURE') && !guardianText.includes('PRIVATE-NEXT-FIXTURE') && !guardianText.includes('가상 시도'));
  assert.deepEqual(await bytes(page, draft.attachments[0].id), [...photo.buffer]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  checks.push(`${width}px template/draft/reload/final/share: no copied results, incomplete fields and PNG bytes preserved, drafts excluded from comparisons, keyboard save, guardian privacy`);
}
async function retry(page, width) {
  await nav(page, '기록');
  await page.getByRole('button', { name:'기록 작성', exact:true }).click();
  await fill(page, 'observation-task', '가상 저장 실패 과제');
  await dialog(page).getByRole('button', { name:'측정값 추가', exact:true }).click();
  await row(page, 0, { tool:'작성 중 도구', item:'미완성 항목', unit:'회', context:'가상 조건' });
  await file(page);
  const attachmentId = await dialog(page).locator('[data-share-media]').getAttribute('data-share-media');
  const oldRaw = await page.evaluate(() => localStorage.getItem('child-development-demo-v2'));
  const numericInput = dialog(page).locator('[name="assessment-0-value"]');
  await numericInput.pressSequentially('-');
  assert.equal(await numericInput.evaluate((input) => input.validity.badInput), true);
  await dialog(page).getByRole('button', { name:'초안 저장', exact:true }).click();
  assert.equal(await dialog(page).isVisible(), true);
  assert.equal(await numericInput.evaluate((input) => input.validity.badInput), true, 'Unfinished numeric text stays in the editor');
  assert.equal(await page.evaluate(() => localStorage.getItem('child-development-demo-v2')), oldRaw);
  await numericInput.fill('');
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key,value) {
      if (this === localStorage && key === 'child-development-demo-v2') { Storage.prototype.setItem = original; throw new DOMException('Synthetic quota failure', 'QuotaExceededError'); }
      return original.call(this,key,value);
    };
  });
  await dialog(page).getByRole('button', { name:'초안 저장', exact:true }).click();
  await dialog(page).locator('#form-error:not([hidden])').filter({ hasText:'입력은 유지됩니다' }).waitFor();
  assert.equal(await dialog(page).locator('[name="assessment-0-tool"]').inputValue(), '작성 중 도구');
  assert.equal(await dialog(page).locator('[name="assessment-0-value"]').inputValue(), '');
  assert.equal(await dialog(page).locator('[name="observation-task"]').inputValue(), '가상 저장 실패 과제');
  assert.equal(await dialog(page).locator('[data-share-media]').getAttribute('data-share-media'), attachmentId);
  assert.equal(await page.evaluate(() => localStorage.getItem('child-development-demo-v2')), oldRaw);
  await screenshot(page, width, 'retry');
  await save(page, '초안 저장');
  const stored = await data(page); assert.equal(stored.records.at(-1).assessments[0].value, null);
  assert.equal(stored.records.filter((r) => r.assessments.some((a) => a.tool === '작성 중 도구')).length, 1);
  assert.deepEqual(await bytes(page, attachmentId), [...photo.buffer]);
  await page.reload(); await nav(page, '기록');
  assert.equal((await data(page)).records.at(-1).observation.task, '가상 저장 실패 과제');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  checks.push(`${width}px invalid-number/quota failure/retry/reload: same incomplete input/file ID/PNG bytes, unchanged failed workspace, one saved draft`);
}
try {
  for (const width of [1440,390,320]) for (const kind of ['template','retry']) {
    const context = await browser.newContext({ viewport:{ width,height:width <= 640 ? 844 : 1000 }, locale:'ko-KR', isMobile:width <= 640, hasTouch:width <= 640 });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('request', (r) => { const url = new URL(r.url()); if (url.origin !== base.origin || url.pathname.startsWith('/api/')) unexpectedRequests.push(r.url()); });
    try { await page.goto(base.href); await (kind === 'template' ? template : retry)(page,width); console.log('PASS ' + checks.at(-1)); }
    catch (error) { await screenshot(page,width,'failure-' + kind).catch(() => {}); throw error; }
    finally { await context.close(); }
  }
  assert.equal(checks.length, 6); assert.deepEqual(errors, []); assert.deepEqual(unexpectedRequests, []);
} catch (error) { failure = { name:error.name,message:error.message }; console.error(error); process.exitCode = 1; }
finally {
  await writeFile(`${root}/record-drafts-results.json`, JSON.stringify({ runId,at:new Date().toISOString(),passed:!failure,checks,errors,unexpectedRequests,failure,
    limitations:['Synthetic local roles/storage only; API and cross-device synchronization are not connected','Explicit draft save only, not automatic durable form autosave','Chromium emulation, not physical devices or a human usability study'] }, null, 2));
  await browser.close();
}

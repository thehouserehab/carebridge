// Owned synthetic UI regression only. All mutations use the rendered product;
// no existing tabs, profiles, accounts, API, or real child data are involved.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureWorkingSnapshot, serveStudySnapshot } from "../scripts/p0-study-snapshots.mjs";
import { studyChildEnvironment, PUBLIC_ASSET } from "../scripts/p0-study-policy.mjs";
import { messageBrowserOptions } from "./message-browser-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const photo = { name: "synthetic-feedback-F1-original.png", mimeType: "image/png",
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=", "base64") };
const bounded = (operation, milliseconds = 10_000) => {
  let timer;
  return Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("FEEDBACK_BROWSER_TIMEOUT")), milliseconds);
  })]).finally(() => clearTimeout(timer));
};
const reveal = async (locator) => {
  for (const details of await locator.locator("xpath=ancestor::details").all())
    if (await details.getAttribute("open") === null) await details.locator(":scope > summary").click();
};

export async function runFeedbackHistoryBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const file of [options.module, options.executable]) assert((await lstat(file)).isFile());
  const { chromium } = await import(pathToFileURL(options.module).href);
  const snapshot = await captureWorkingSnapshot(root), runId = randomUUID();
  const folder = path.join(root, "test-results", `feedback-history-${runId}`);
  await mkdir(folder);
  const report = { runId, at: new Date().toISOString(), source: snapshot.manifest, passed: false,
    checks: [], screenshots: [], errors: [], unexpectedRequests: [], failure: null,
    cleanup: { contextsClosed: false, browserStopped: false, serverClosed: false },
    limitations: ["Synthetic local roles and localStorage/IndexedDB only; not server authentication, API or cross-device evidence.",
      "Chromium viewport emulation, not physical devices or human performance evidence.",
      "History begins with available source data; previously overwritten versions cannot be reconstructed."] };
  let server, browserServer, browserProcess, browser, context, page, phase = "STARTUP";
  try {
    server = await serveStudySnapshot(snapshot);
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: "127.0.0.1", port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    browserProcess = browserServer.process(); browser = await chromium.connect(browserServer.wsEndpoint());
    report.browserVersion = browser.version();
    for (const width of [320, 390, 1440]) {
      phase = `${width}:CREATE_F1_WITH_ORIGINAL_FILE`;
      context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ko-KR",
        hasTouch: width <= 640, isMobile: width <= 640, serviceWorkers: "block", permissions: [] });
      page = await context.newPage(); page.setDefaultTimeout(8_000);
      page.on("pageerror", () => report.errors.push({ width, phase, type: "pageerror" }));
      page.on("console", (message) => { if (message.type() === "error") report.errors.push({ width, phase, type: "console" }); });
      await context.route("**/*", (route) => {
        const request = route.request(), url = new URL(request.url());
        const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (url.origin === server.origin && !url.search && !url.hash && ["GET", "HEAD"].includes(request.method()) &&
          PUBLIC_ASSET.test(name) && snapshot.read(name)) return route.continue();
        report.unexpectedRequests.push({ width, phase, sameOrigin: url.origin === server.origin, method: request.method() });
        return route.abort();
      });
      const f1 = `F1 합성 활동 반응 ${width}`, d1 = `F1 합성 어려움 ${width}`;
      const f2 = `F2 합성 활동 반응 ${width}`, d2 = `F2 합성 어려움 ${width}`;
      const title = `합성 피드백 참고 기록 ${width}`, summary = `합성 보호자 공유 요약 ${width}`;
      const privatePlan = `SYNTHETIC_PRIVATE_FEEDBACK_PLAN_${width}`;
      const dialog = page.locator("#dialog");
      const nav = (name) => page.getByRole("navigation", { name: width <= 640 ? "모바일 메뉴" : "주요 메뉴", exact: true })
        .getByRole("button", { name, exact: true }).click();
      const role = (value) => page.getByLabel("사용자 역할", { exact: true }).selectOption(value);
      const data = () => page.evaluate(() => JSON.parse(localStorage.getItem("child-development-demo-v2")));
      const ready = () => page.waitForFunction(() => document.querySelector("#message-body") && !document.querySelector("#message-body").disabled);
      const message = (id) => page.locator(`[data-message-id="${id}"]`);
      const fill = async (name, value) => {
        const input = dialog.locator(`[name="${name}"]`); await reveal(input); await input.fill(value);
      };
      const save = async (name) => {
        const submit = dialog.getByRole("button", { name, exact: true }); await submit.focus(); await page.keyboard.press("Enter");
        await dialog.waitFor({ state: "hidden" });
      };
      const openChat = async () => {
        await nav("대화");
        const row = page.locator('.conversation-row[data-id="c1"]');
        if (await row.isVisible()) await row.click();
        await ready();
      };
      const activities = async () => {
        await nav("아이 정보"); await page.getByRole("button", { name: "가정 활동", exact: true }).click();
      };
      const capture = async (flow) => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "FEEDBACK_PAGE_OVERFLOW");
        if (await dialog.isVisible()) assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, "FEEDBACK_DIALOG_OVERFLOW");
        const filename = `${width}-${flow}.png`;
        await page.screenshot({ path: path.join(folder, filename), fullPage: true });
        report.screenshots.push({ width, flow, filename, syntheticOnly: true });
      };
      const originalBytes = (id) => page.evaluate(async (id) => {
        const { MediaStore } = await import("/src/media-store.js"), store = new MediaStore();
        try { const blob = await store.read(id); return blob ? [...new Uint8Array(await blob.arrayBuffer())] : null; }
        finally { (await store.open()).close(); }
      }, id);

      await page.goto(server.origin); await page.getByRole("heading", { name: "소식에서 다음 만남으로", exact: true }).waitFor();
      // The existing demo seed is the only initial data. No fixture mutation or
      // storage injection creates feedback, replies, records or revisions.
      await role("guardian"); await activities();
      await page.locator('[data-action="feedback"][data-id="pub1"]').click();
      await dialog.getByRole("heading", { name: "우리 가족의 활동 경험", exact: true }).waitFor();
      await fill("reaction", f1); await fill("difficulty", d1);
      await dialog.locator('[name="result"]').selectOption("partial");
      const files = dialog.locator('input[type="file"]'); await reveal(files); await files.setInputFiles(photo);
      await page.waitForFunction(() => document.querySelector("#dialog .attachment-row") && !document.querySelector('#dialog input[type="file"]').disabled);
      await save("경험 전달하기"); await ready();
      const initial = await data(), feedback = initial.feedback.find((row) => row.reaction === f1);
      assert.ok(feedback, "FEEDBACK_F1_PERSISTED"); assert.equal(feedback.attachments.length, 1);
      const original = initial.messages.find((row) => row.type === "feedback" && row.sourceId === feedback.id);
      assert.ok(original, "FEEDBACK_EVENT_CREATED");
      const file = feedback.attachments[0]; assert.deepEqual(await originalBytes(file.id), [...photo.buffer]);

      phase = `${width}:THERAPIST_REPLY_AND_REFERENCE_F1`;
      await role("therapist"); await openChat();
      await message(original.id).getByRole("button", { name: "답하기", exact: true }).click();
      assert((await page.locator("#reply-preview").innerText()).includes(f1), "FEEDBACK_REPLY_SELECTION_F1");
      const replyBody = `합성 피드백 F1 답변 ${width}`;
      await page.getByLabel("소식 내용", { exact: true }).fill(replyBody);
      await page.getByRole("button", { name: "보내기", exact: true }).click();
      await page.waitForFunction((body) => JSON.parse(localStorage.getItem("child-development-demo-v2")).messages.some((row) => row.body === body), replyBody);
      await ready();
      const reply = (await data()).messages.find((row) => row.body === replyBody);
      assert.equal(reply.replyTo, original.id); assert.equal(reply.replyVersion, 1);
      await message(original.id).getByRole("button", { name: "기록에 참고", exact: true }).click();
      assert((await dialog.locator(".reference-note").innerText()).includes(f1));
      await fill("performed", "합성 회기 관찰: 피드백과 직접 관찰을 구분합니다.");
      await fill("title", title); await fill("summary", summary); await fill("nextPlan", privatePlan);
      await save("기록 저장");
      const saved = await data(), record = saved.records.find((row) => row.title === title);
      const captured = structuredClone(record.referenceSources);
      assert.equal(captured.length, 1); assert.equal(captured[0].messageId, original.id);
      assert.equal(captured[0].body, f1); assert.equal(captured[0].version, 1);
      assert.deepEqual(captured[0].attachments, feedback.attachments);

      phase = `${width}:GUARDIAN_EDITS_F2_AND_REMOVES_CURRENT_FILE`;
      await role("guardian"); await activities();
      await page.locator(`[data-action="feedback-edit"][data-id="${feedback.id}"]`).click();
      assert.equal(await dialog.locator('[name="reaction"]').inputValue(), f1);
      await fill("reaction", f2); await fill("difficulty", d2);
      await dialog.locator('[name="result"]').selectOption("done");
      const remove = dialog.locator(`[data-remove-media="${file.id}"]`); await reveal(remove); await remove.click();
      assert.equal(await dialog.locator(".attachment-row").count(), 0);
      await save("경험 전달하기"); await ready();
      const revised = await data(), current = revised.feedback.find((row) => row.id === feedback.id);
      assert.equal(current.reaction, f2); assert.equal(current.difficulty, d2); assert.equal(current.result, "done");
      assert.deepEqual(current.attachments, []);
      assert.equal(revised.messages.filter((row) => row.type === "feedback" && row.sourceId === feedback.id).length, 1);
      const sameEvent = revised.messages.find((row) => row.id === original.id);
      for (const key of ["id", "sequence", "createdAt", "conversationId", "childId", "sourceId", "authorId"])
        assert.equal(sameEvent[key], original[key], "FEEDBACK_ANCHOR_PRESERVED");
      assert.deepEqual(await originalBytes(file.id), [...photo.buffer], "FEEDBACK_ORIGINAL_BLOB_PRESERVED");

      phase = `${width}:OLD_QUOTE_AND_RECORD_SURVIVE_F2`;
      await role("therapist"); await openChat();
      const quote = message(reply.id).locator(".message-quote");
      assert((await quote.innerText()).includes(f1), "FEEDBACK_QUOTE_RETAINS_F1");
      assert(!(await quote.innerText()).includes(f2), "FEEDBACK_QUOTE_NOT_REWRITTEN");
      assert((await quote.innerText()).includes("답변 당시 내용 · 원문 수정됨"), "FEEDBACK_QUOTE_CHANGE_NOTICE");
      assert((await message(original.id).innerText()).includes(f2));
      assert.equal(await message(original.id).locator(".media-item").count(), 0);
      await quote.focus(); await page.keyboard.press("Enter");
      assert.equal(await message(original.id).evaluate((element) => element === document.activeElement), true, "FEEDBACK_QUOTE_KEYBOARD_ANCHOR");
      await capture("f2-current-f1-quote");
      const reopen = async () => {
        await nav("기록"); await page.locator(`[data-action="record"][data-id="${record.id}"]`).click();
        await dialog.getByRole("heading", { name: "세션 기록 수정", exact: true }).waitFor();
      };
      const checkReference = async () => {
        const text = await dialog.locator(".reference-note").innerText();
        assert(text.includes(f1) && !text.includes(f2), "FEEDBACK_RECORD_RETAINS_F1");
        assert(text.includes("기록 당시 내용 보존"), "FEEDBACK_RECORD_PRESERVED_LABEL");
        assert(text.includes("원문이 수정됐어요"), "FEEDBACK_RECORD_CHANGE_NOTICE");
      };
      await reopen(); await checkReference(); await capture("record-f1-preserved");
      await fill("nextPlan", `${privatePlan}_UPDATED`); await save("기록 저장");
      assert.deepEqual((await data()).records.find((row) => row.id === record.id).referenceSources, captured);
      await page.reload(); await reopen(); await checkReference();
      assert.equal(await dialog.locator('[name="nextPlan"]').inputValue(), `${privatePlan}_UPDATED`);
      await dialog.getByRole("button", { name: "취소", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
      await openChat();
      assert((await message(reply.id).locator(".message-quote").innerText()).includes(f1));
      assert((await message(original.id).innerText()).includes(f2));
      await capture("reload-f1-quote-f2-current");

      phase = `${width}:SHARE_EXCLUDES_PRIVATE_REFERENCE`;
      await nav("기록"); await page.locator(`[data-action="preview"][data-id="${record.id}"]`).click();
      const preview = await dialog.innerText();
      assert(preview.includes(summary));
      for (const excluded of [f1, f2, d1, d2, privatePlan, photo.name]) assert(!preview.includes(excluded), "FEEDBACK_PREVIEW_PRIVATE");
      assert.equal(await dialog.locator(".media-item").count(), 0);
      await capture("share-private-reference-excluded"); await save("보호자에게 공유");
      await role("guardian"); await nav("기록");
      const publicText = await page.locator("#view-content").innerText(); assert(publicText.includes(summary));
      // The separate family timeline may show the guardian's current F2. The
      // shared clinical card must not acquire either historical reference.
      const sharedCard = await page.locator(".record-card").filter({ has: page.getByRole("heading", { name: title, exact: true }) }).innerText();
      for (const excluded of [f1, f2, d1, d2, privatePlan, photo.name]) assert(!sharedCard.includes(excluded), "FEEDBACK_GUARDIAN_RECORD_PRIVATE");
      for (const excluded of [f1, d1, privatePlan, photo.name]) assert(!publicText.includes(excluded), "FEEDBACK_GUARDIAN_HISTORY_PRIVATE");
      const final = await data(), finalRecord = final.records.find((row) => row.id === record.id);
      assert.deepEqual(finalRecord.referenceSources, captured);
      assert.deepEqual(final.records.filter((row) => row.id !== record.id), initial.records);
      assert.deepEqual(final.publications.filter((row) => row.id !== finalRecord.publicationId), initial.publications);
      assert.deepEqual(await originalBytes(file.id), [...photo.buffer]);
      await capture("guardian-record-privacy");
      report.checks.push({ width, uiCreatesF1ReplyAndReference: true, uiEditsF2: true,
        oneCurrentCardAndStableAnchor: true, historicalQuoteWithChangedNotice: true, keyboardOriginalJump: true,
        recordSnapshotSurvivesPlanEditAndReload: true, removedOriginalBytesRetained: true,
        sharingExcludesPrivateReference: true, unrelatedRecordsAndSharesPreserved: true });
      await bounded(context.close()); context = null; page = null;
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedRequests, []); report.cleanup.contextsClosed = true;
  } catch (error) {
    const firstLine = error?.message?.split("\n")[0];
    report.failure = { code: "FEEDBACK_HISTORY_BROWSER_FAILED", phase,
      type: error?.name === "AssertionError" ? "assertion" : "runtime-or-timeout",
      criterion: /^FEEDBACK_[A-Z_]+$/.test(firstLine ?? "") ? firstLine : null };
    await page?.screenshot({ path: path.join(folder, "failure.png"), fullPage: true }).catch(() => {});
  } finally {
    if (context) try { await bounded(context.close()); report.cleanup.contextsClosed = true; } catch { /* Unverified. */ }
    if (browser) try { await bounded(browser.close()); } catch { /* Owned server remains below. */ }
    if (browserServer) {
      try { await bounded(browserServer.close()); } catch { try { await bounded(browserServer.kill()); } catch { /* Unverified. */ } }
      report.cleanup.browserStopped = typeof browserProcess?.exitCode === "number" || typeof browserProcess?.signalCode === "string";
    }
    if (server) try { await bounded(server.close()); report.cleanup.serverClosed = true; } catch { /* Unverified. */ }
    report.passed = !report.failure && report.checks.length === 3 && Object.values(report.cleanup).every(Boolean);
    await writeFile(path.join(folder, "results.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length,
    cleanup: report.cleanup, failure: report.failure }));
  return report.passed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runFeedbackHistoryBrowser()) process.exitCode = 1; }
  catch { console.error("FEEDBACK_HISTORY_CONFIGURATION_OR_STARTUP_FAILED"); process.exitCode = 1; }
}

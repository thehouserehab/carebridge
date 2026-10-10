// Frozen public source, owned loopback/Chromium and fresh synthetic contexts.
// All references, source edits, sharing and relationship changes use real UI.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureWorkingSnapshot, serveStudySnapshot } from "../scripts/p0-study-snapshots.mjs";
import { studyChildEnvironment, PUBLIC_ASSET } from "../scripts/p0-study-policy.mjs";
import { messageBrowserOptions } from "./message-browser-policy.mjs";
import { syntheticMedia } from "./browser-media.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const alternativePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=", "base64");
const bounded = (operation, milliseconds = 10_000) => {
  let timer;
  return Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("REFERENCE_MEDIA_TIMEOUT")), milliseconds);
  })]).finally(() => clearTimeout(timer));
};
const reveal = async (locator) => {
  for (const details of await locator.locator("xpath=ancestor::details").all())
    if (await details.getAttribute("open") === null) await details.locator(":scope > summary").click();
};

export async function runRecordReferenceMediaBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const file of [options.module, options.executable]) assert((await lstat(file)).isFile());
  const { chromium } = await import(pathToFileURL(options.module).href);
  const snapshot = await captureWorkingSnapshot(root), runId = randomUUID();
  const folder = path.join(root, "test-results", `record-reference-media-${runId}`);
  await mkdir(folder);
  const report = { runId, at: new Date().toISOString(), source: snapshot.manifest, passed: false,
    checks: [], screenshots: [], errors: [], unexpectedRequests: [], failure: null,
    cleanup: { contextsClosed: false, browserStopped: false, serverClosed: false },
    limitations: ["Synthetic local roles/localStorage/IndexedDB only; no authentication, API or actual child data.",
      "Ordinary message attachments are immutable; attachment replacement is tested through supported feedback editing.",
      "Chromium viewport emulation is not physical device or human usability evidence."] };
  let server, browserServer, browserProcess, browser, context, page, phase = "STARTUP";
  try {
    server = await serveStudySnapshot(snapshot);
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: "127.0.0.1", port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    browserProcess = browserServer.process(); browser = await chromium.connect(browserServer.wsEndpoint());
    report.browserVersion = browser.version();
    for (const width of [320, 390, 1440]) for (const kind of ["message", "feedback"]) {
      phase = `${width}:${kind}:CREATE_ORIGINAL`;
      context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ko-KR",
        hasTouch: width <= 640, isMobile: width <= 640, serviceWorkers: "block", permissions: [], acceptDownloads: true });
      page = await context.newPage(); page.setDefaultTimeout(8_000);
      page.on("pageerror", () => report.errors.push({ width, kind, phase, type: "pageerror" }));
      page.on("console", (message) => { if (message.type() === "error") report.errors.push({ width, kind, phase, type: "console", diagnostic: message.text().slice(0, 600) }); });
      await context.route("**/*", (route) => {
        const request = route.request(), url = new URL(request.url());
        const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (url.origin === server.origin && !url.search && !url.hash && ["GET", "HEAD"].includes(request.method()) &&
          PUBLIC_ASSET.test(name) && snapshot.read(name)) return route.continue();
        report.unexpectedRequests.push({ width, kind, phase, sameOrigin: url.origin === server.origin, method: request.method() });
        return route.abort();
      });
      const dialog = page.locator("#dialog"), role = (value) => page.getByLabel("사용자 역할", { exact: true }).selectOption(value);
      const nav = (name) => page.getByRole("navigation", { name: width <= 640 ? "모바일 메뉴" : "주요 메뉴", exact: true })
        .getByRole("button", { name, exact: true }).click();
      const data = () => page.evaluate(() => JSON.parse(localStorage.getItem("child-development-demo-v2")));
      const message = (id) => page.locator(`[data-message-id="${id}"]`);
      const ready = () => page.waitForFunction(() => document.querySelector("#message-body") && !document.querySelector("#message-body").disabled);
      const chat = async () => { await nav("대화"); const row = page.locator('.conversation-row[data-id="c1"]'); if (await row.isVisible()) await row.click(); await ready(); };
      const activities = async () => { await nav("아이 정보"); await page.getByRole("button", { name: "가정 활동", exact: true }).click(); };
      const fill = async (name, value) => { const input = dialog.locator(`[name="${name}"]`); await reveal(input); await input.fill(value); };
      const save = async (name) => { await dialog.getByRole("button", { name, exact: true }).click(); await dialog.waitFor({ state: "hidden" }); };
      const cancel = async (dirty = false) => {
        if (dirty) page.once("dialog", (prompt) => prompt.accept());
        await dialog.getByRole("button", { name: "취소", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
      };
      const upload = async (scope, files) => {
        const input = scope.locator('input[type="file"]'); await reveal(input); await input.setInputFiles(files);
        await page.waitForFunction(() => [...document.querySelectorAll('input[type="file"]')].every((input) => !input.disabled));
        await scope.locator(".attachment-row").first().waitFor();
      };
      const fileBytes = (id) => page.evaluate(async (id) => {
        const { MediaStore } = await import("/src/media-store.js"), store = new MediaStore();
        try { const blob = await store.read(id); return blob ? [...new Uint8Array(await blob.arrayBuffer())] : null; }
        finally { (await store.open()).close(); }
      }, id);
      const capture = async (flow) => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "REFERENCE_MEDIA_PAGE_OVERFLOW");
        if (await dialog.isVisible()) assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, "REFERENCE_MEDIA_DIALOG_OVERFLOW");
        const filename = `${width}-${kind}-${flow}.png`;
        await page.screenshot({ path: path.join(folder, filename), fullPage: true });
        report.screenshots.push({ width, kind, flow, filename, syntheticOnly: true });
      };
      const f1 = `합성 당시 참고 ${kind} ${width}`, f2 = `합성 현재 내용 ${kind} ${width}`;
      const title = `합성 당시 첨부 기록 ${kind} ${width}`, summary = `합성 보호자 공개 요약 ${kind} ${width}`;
      await page.goto(server.origin); await page.getByRole("heading", { name: "소식에서 다음 만남으로", exact: true }).waitFor();
      const media = await syntheticMedia(page);
      const originals = [{ name: `synthetic-${kind}-original.png`, mimeType: "image/png", buffer: Buffer.from(media.png) },
        { name: `synthetic-${kind}-original.webm`, mimeType: "video/webm", buffer: Buffer.from(media.video) }];
      await role("guardian");
      let source, feedbackId;
      if (kind === "message") {
        await chat(); await page.getByRole("button", { name: "＋ 사진·동영상", exact: true }).click();
        await upload(page.locator("#chat-attachment-editor"), originals);
        await page.getByLabel("소식 내용", { exact: true }).fill(f1); await page.getByRole("button", { name: "보내기", exact: true }).click();
        await page.waitForFunction((body) => JSON.parse(localStorage.getItem("child-development-demo-v2")).messages.some((row) => row.body === body), f1);
        source = (await data()).messages.find((row) => row.body === f1);
      } else {
        await activities(); await page.locator('[data-action="feedback"][data-id="pub1"]').click();
        await fill("reaction", f1); await fill("difficulty", "합성 당시 어려움");
        await dialog.locator('[name="result"]').selectOption("partial"); await upload(dialog, originals); await save("경험 전달하기");
        const current = await data(), feedback = current.feedback.find((row) => row.reaction === f1); feedbackId = feedback.id;
        source = { ...current.messages.find((row) => row.type === "feedback" && row.sourceId === feedback.id), attachments: feedback.attachments };
      }
      assert.equal(source.attachments.length, 2, "REFERENCE_MEDIA_ORIGINAL_TWO_FILES");
      for (let index = 0; index < 2; index++) assert.deepEqual(await fileBytes(source.attachments[index].id), [...originals[index].buffer]);
      await role("therapist"); await chat(); await message(source.id).getByRole("button", { name: "기록에 참고", exact: true }).click();
      assert.equal(await dialog.locator('[data-action="view-reference-media"]').count(), 0, "REFERENCE_MEDIA_UNSAVED_NOT_HISTORICAL");
      await fill("performed", "합성 직접 관찰과 보호자 참고 내용을 구분합니다."); await fill("title", title); await fill("summary", summary);
      await save("기록 저장");
      const saved = await data(), record = saved.records.find((row) => row.title === title), snapshotReference = structuredClone(record.referenceSources);
      assert.deepEqual(snapshotReference[0].attachments, source.attachments); assert.equal(snapshotReference[0].version, 1);
      assert.deepEqual(record.attachments, [], "REFERENCE_MEDIA_NOT_COPIED_TO_RECORD_ATTACHMENTS");
      const selector = `[data-action="view-reference-media"][data-id="${record.id}"][data-reference="${source.id}"]`;
      const reopen = async () => { await nav("기록"); await page.locator(`[data-action="record"][data-id="${record.id}"]`).click(); await dialog.getByRole("heading", { name: "세션 기록 수정", exact: true }).waitFor(); };
      const toggleArea = (scope) => scope.locator(".reference-attachments").filter({ has: page.locator(selector) });
      const verifyMedia = async (scope, { download = false } = {}) => {
        const button = scope.locator(selector); await reveal(button); assert.equal(await button.getAttribute("aria-expanded"), "false");
        assert.equal(await button.innerText(), "당시 사진·영상 2개 보기"); await button.focus(); await page.keyboard.press("Enter");
        assert.equal(await button.getAttribute("aria-expanded"), "true"); assert.equal(await button.innerText(), "당시 사진·영상 닫기");
        const area = toggleArea(scope).locator(".reference-media"); await area.waitFor({ state: "visible" });
        assert.deepEqual(await area.locator("[data-media-id]").evaluateAll((slots) => slots.map((slot) => slot.dataset.mediaId)), source.attachments.map((file) => file.id));
        assert.equal(await area.locator('[data-remove-media], [data-share-media]').count(), 0, "REFERENCE_MEDIA_READ_ONLY");
        const image = area.locator("img"); await image.waitFor();
        // Visibility does not mean a lazy image's request has committed yet.
        // Wait on this actual image, not a sleep or a different same-ID slot.
        await image.scrollIntoViewIfNeeded();
        const imageHandle = await image.elementHandle();
        try { await page.waitForFunction((element) => element.isConnected && element.complete && element.naturalWidth > 0, imageHandle); }
        finally { await imageHandle.dispose(); }
        assert.equal(await image.evaluate(async (element) => { await element.decode(); return element.naturalWidth; }), 160, "REFERENCE_MEDIA_PHOTO_DECODED");
        const video = area.locator("video"); await video.waitFor();
        const decoded = await video.evaluate(async (element) => {
          element.muted = true; await element.play();
          return { width: element.videoWidth, height: element.videoHeight, duration: element.duration };
        });
        assert.equal(decoded.width, 160); assert.equal(decoded.height, 90); assert(decoded.duration > 0 && Number.isFinite(decoded.duration));
        const videoHandle = await video.elementHandle();
        try { await page.waitForFunction((element) => element.currentTime > 0, videoHandle); }
        finally { await videoHandle.dispose(); }
        await video.evaluate((element) => element.pause());
        if (download) for (let index = 0; index < 2; index++) {
          const link = area.locator(`[data-media-id="${source.attachments[index].id}"]`).getByRole("link", { name: "원본 다운로드", exact: true });
          const pending = page.waitForEvent("download"); await link.focus(); await page.keyboard.press("Enter"); const delivered = await pending;
          assert.equal(delivered.suggestedFilename(), originals[index].name);
          const stream = await delivered.createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk);
          assert.deepEqual(Buffer.concat(chunks), originals[index].buffer, "REFERENCE_MEDIA_DOWNLOAD_ORIGINAL_BYTES");
        }
        return area;
      };

      phase = `${width}:${kind}:PENDING_RECORD_FILE_SURVIVES_REFERENCE_HYDRATION`;
      await reopen();
      const pendingFile = { name: "synthetic-unsaved-record.png", mimeType: "image/png", buffer: alternativePng };
      await upload(dialog.locator(".attachment-editor"), [pendingFile]);
      const pendingImage = dialog.locator(".attachment-editor img"); await pendingImage.waitFor();
      assert.equal(await pendingImage.evaluate(async (element) => { await element.decode(); return element.naturalWidth; }), 1);
      const pendingSrc = await pendingImage.getAttribute("src");
      const pendingId = await dialog.locator(".attachment-editor [data-remove-media]").getAttribute("data-remove-media");
      assert.equal(await fileBytes(pendingId), null, "REFERENCE_MEDIA_PENDING_NOT_PERSISTED");
      await verifyMedia(dialog, { download: true });
      await dialog.getByRole("button", { name: "현재 원문 보기", exact: true }).click();
      assert.equal(await pendingImage.getAttribute("src"), pendingSrc, "REFERENCE_MEDIA_PENDING_URL_UNCHANGED");
      assert.equal(await pendingImage.evaluate(async (element) => { await element.decode(); return element.naturalWidth; }), 1, "REFERENCE_MEDIA_PENDING_STILL_DECODES");
      assert.equal(await dialog.locator(".attachment-editor .attachment-row").count(), 1);
      await dialog.locator(selector).click(); assert.equal(await dialog.locator(selector).getAttribute("aria-expanded"), "false");
      assert.equal(await toggleArea(dialog).locator(".reference-media").isVisible(), false);
      await verifyMedia(dialog); await capture("pending-file-and-reference"); await cancel(true);
      assert.deepEqual((await data()).records.find((row) => row.id === record.id), record, "REFERENCE_MEDIA_CANCEL_RECORD_UNCHANGED");
      assert.equal(await fileBytes(pendingId), null);

      phase = `${width}:${kind}:SOURCE_CHANGE_OR_DELETE`;
      await role("guardian");
      if (kind === "feedback") {
        await activities(); await page.locator(`[data-action="feedback-edit"][data-id="${feedbackId}"]`).click();
        await fill("reaction", f2);
        for (const file of source.attachments) { const remove = dialog.locator(`[data-remove-media="${file.id}"]`); await reveal(remove); await remove.click(); }
        await upload(dialog, [{ name: "synthetic-current-replacement.png", mimeType: "image/png", buffer: alternativePng }]);
        await save("경험 전달하기"); await ready();
        const current = (await data()).feedback.find((row) => row.id === feedbackId);
        assert.equal(current.attachments.length, 1); assert(!source.attachments.some((old) => old.id === current.attachments[0].id));
        assert.deepEqual(await fileBytes(current.attachments[0].id), [...alternativePng]);
      } else {
        await chat(); await message(source.id).getByLabel("소식 관리", { exact: true }).click();
        await message(source.id).getByRole("button", { name: "본문 수정", exact: true }).click();
        await page.getByLabel("수정할 소식", { exact: true }).fill(f2); await save("수정 저장");
        assert.deepEqual((await data()).messages.find((row) => row.id === source.id).attachments, source.attachments);
        for (const [who, scope] of [["guardian", "all"], ["therapist", "self"]]) {
          await role(who); await chat(); await message(source.id).getByLabel("소식 관리", { exact: true }).click();
          await message(source.id).getByRole("button", { name: "삭제", exact: true }).click();
          await page.getByLabel("삭제 범위", { exact: true }).selectOption(scope);
          await page.getByLabel("선택한 범위에서 삭제할 것을 확인했어요.", { exact: true }).check(); await save("선택한 범위로 삭제");
        }
      }
      await role("therapist"); await reopen();
      assert((await dialog.locator(".reference-note").innerText()).includes(f1));
      assert(!(await dialog.locator(".reference-note").innerText()).includes(f2));
      await verifyMedia(dialog); await capture("historical-after-source-change");
      if (kind === "feedback") {
        await dialog.getByRole("button", { name: "현재 원문 보기", exact: true }).click();
        const current = dialog.locator(".reference-original");
        assert((await current.innerText()).includes(f2)); assert.equal(await current.locator("[data-media-id]").count(), 1);
        for (const file of source.attachments) assert.equal(await current.locator(`[data-media-id="${file.id}"]`).count(), 0);
        await cancel(); await nav("기록");
        await page.locator('[data-action="unpublish"][data-id="r1"]').click(); await save("공유 철회");
        assert.equal((await data()).records.find((row) => row.id === "r1").publicationId, null);
        await reopen(); await verifyMedia(dialog); await capture("source-share-withdrawn-original-retained");
      } else assert.equal(await dialog.getByRole("button", { name: "현재 원문 보기", exact: true }).count(), 0);
      await fill("nextPlan", "합성 후속 계획: 당시 참고 파일을 보존합니다."); await save("기록 저장"); await page.reload(); await reopen();
      assert.deepEqual((await data()).records.find((row) => row.id === record.id).referenceSources, snapshotReference);
      await verifyMedia(dialog); await cancel(); await nav("기록");
      const card = page.locator(".record-card").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
      await verifyMedia(card, { download: true }); await capture("saved-detail-and-download");

      phase = `${width}:${kind}:SHARING_AND_RELATIONSHIP_PRIVACY`;
      await page.locator(`[data-action="preview"][data-id="${record.id}"]`).click();
      assert((await dialog.innerText()).includes(summary)); assert(!(await dialog.innerText()).includes(f1));
      assert.equal(await dialog.locator('[data-action="view-reference-media"], [data-media-id], .media-download').count(), 0, "REFERENCE_MEDIA_NOT_AUTOSHARED");
      await save("보호자에게 공유"); await role("guardian"); await nav("기록");
      const shared = page.locator(".record-card").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
      assert(!(await shared.innerText()).includes(f1));
      assert.equal(await shared.locator('[data-action="view-reference-media"], [data-media-id], .media-download').count(), 0);
      const relationship = async (therapist, guardian, all = false) => {
        await role("center"); await nav("아동"); await page.locator('.child-row[data-id="c1"]').click();
        const visible = await page.locator("#main").innerText(); assert(!visible.includes(f1));
        for (const file of originals) assert(!visible.includes(file.name));
        assert.equal(await page.locator('#main [data-action="view-reference-media"], #main [data-media-id], #main .media-download').count(), 0);
        await page.getByRole("button", { name: "담당 관계 관리", exact: true }).click();
        await dialog.locator('[name="therapistId"]').selectOption(therapist);
        for (const id of ["p1", "p2", "p3"]) await dialog.locator(`[name="guardianIds"][value="${id}"]`).setChecked(id === guardian);
        await dialog.locator('[name="historyConfirmed"]').check();
        if (all) {
          await dialog.locator('[name="therapistHistory"]').selectOption("all"); await dialog.locator(`[name="history-${guardian}"]`).selectOption("all");
          const before = await data(); await dialog.getByRole("button", { name: "관계 저장", exact: true }).click();
          await dialog.locator("#form-error").waitFor({ state: "visible" }); assert.deepEqual(await data(), before);
          await dialog.locator('[name="pastHistoryConfirmed"]').check();
        }
        await save("관계 저장");
      };
      const beforeRelations = await data();
      await relationship("t2", "p2"); await relationship("t1", "p1");
      for (const who of ["therapist", "guardian"]) {
        await role(who); await nav("기록");
        assert.equal(await page.getByRole("heading", { name: title, exact: true }).count(), 0, "REFERENCE_MEDIA_FUTURE_ONLY_RECORD_HIDDEN");
        assert.equal(await page.locator(`#main ${selector}`).count(), 0);
        for (const file of source.attachments) assert.equal(await page.locator(`#main [data-media-id="${file.id}"]`).count(), 0);
      }
      await capture("future-only-private"); await relationship("t1", "p1", true);
      await role("therapist"); await reopen(); await verifyMedia(dialog); await capture("past-confirmed-original"); await cancel();
      if (kind === "message") {
        phase = `${width}:${kind}:ACTUAL_PEER_TAB_REVOKES_REFERENCE_ONLY`;
        await reopen(); await verifyMedia(dialog); await fill("nextPlan", "합성 미저장 계획은 관계 변경에도 유지");
        await upload(dialog.locator(".attachment-editor"), [pendingFile]);
        const draftImage = dialog.locator(".attachment-editor img"); await draftImage.waitFor();
        assert.equal(await draftImage.evaluate(async (element) => { await element.decode(); return element.naturalWidth; }), 1);
        const draftUrl = await draftImage.getAttribute("src");
        const draftFileId = await dialog.locator(".attachment-editor [data-remove-media]").getAttribute("data-remove-media");
        const peer = await context.newPage(); peer.setDefaultTimeout(8_000);
        peer.on("pageerror", () => report.errors.push({ width, kind, phase, type: "peer-pageerror" }));
        peer.on("console", (message) => { if (message.type() === "error") report.errors.push({ width, kind, phase, type: "peer-console" }); });
        await peer.goto(server.origin); await peer.getByLabel("사용자 역할", { exact: true }).selectOption("center");
        await peer.getByRole("navigation", { name: width <= 640 ? "모바일 메뉴" : "주요 메뉴", exact: true })
          .getByRole("button", { name: "아동", exact: true }).click();
        await peer.locator('.child-row[data-id="c1"]').click();
        await peer.getByRole("button", { name: "담당 관계 관리", exact: true }).click();
        const peerDialog = peer.locator("#dialog");
        await peerDialog.locator('[name="therapistId"]').selectOption("t2");
        for (const id of ["p1", "p2", "p3"]) await peerDialog.locator(`[name="guardianIds"][value="${id}"]`).setChecked(id === "p2");
        await peerDialog.locator('[name="historyConfirmed"]').check();
        await peerDialog.getByRole("button", { name: "관계 저장", exact: true }).click(); await peerDialog.waitFor({ state: "hidden" });
        await dialog.locator("[data-workspace-change]").waitFor({ state: "visible" });
        assert.equal(await toggleArea(dialog).locator(".reference-media").isVisible(), false, "REFERENCE_MEDIA_STALE_PREVIEW_REMOVED");
        assert.equal(await dialog.locator('.record-references [data-media-id], .record-references .reference-original').count(), 0);
        assert.equal(await dialog.locator(selector).isDisabled(), true);
        assert.equal(await dialog.locator(selector).getAttribute("aria-expanded"), "false");
        assert.equal(await dialog.locator('[name="nextPlan"]').inputValue(), "합성 미저장 계획은 관계 변경에도 유지");
        assert.equal(await draftImage.getAttribute("src"), draftUrl, "REFERENCE_MEDIA_STALE_PENDING_URL_PRESERVED");
        assert.equal(await draftImage.evaluate(async (element) => { await element.decode(); return element.naturalWidth; }), 1);
        const current = await data(); await dialog.getByRole("button", { name: "기록 저장", exact: true }).click();
        await dialog.locator("#form-error").waitFor({ state: "visible" }); assert.deepEqual(await data(), current);
        assert.equal(await fileBytes(draftFileId), null, "REFERENCE_MEDIA_STALE_PENDING_NOT_WRITTEN");
        await page.bringToFront(); await capture("peer-revocation-keeps-pending-input"); await cancel(true);
        // dialog.close queues its close handler; await its actual re-projection.
        await page.waitForFunction(() => document.querySelector("#child")?.value === "c2");
        assert.equal(await page.locator('#child option[value="c1"]').count(), 0);
        await bounded(peer.close());
      }
      const final = await data();
      assert.deepEqual(final.records, beforeRelations.records, "REFERENCE_MEDIA_RELATIONS_PRESERVE_RECORDS");
      assert.deepEqual(final.publications, beforeRelations.publications, "REFERENCE_MEDIA_RELATIONS_PRESERVE_SHARES");
      assert.deepEqual(final.records.find((row) => row.id === record.id).referenceSources, snapshotReference);
      assert.deepEqual(final.records.find((row) => row.id === record.id).attachments, []);
      for (let index = 0; index < 2; index++) assert.deepEqual(await fileBytes(source.attachments[index].id), [...originals[index].buffer]);
      report.checks.push({ width, kind, sourceAndReferenceCreatedWithUi: true, historicalMediaDecodePlayAndDownload: true,
        pendingUnsavedAttachmentPreviewPreserved: true, sourceChangeSeparatedFromSnapshot: true, planSaveAndReloadPreserveSnapshot: true,
        editorAndRecordDetailKeyboardToggle: true, noAutomaticSharing: true, guardianAndCenterPrivate: true,
        defaultReconnectFutureOnly: true, separatelyConfirmedPastAccess: true, originalMetadataAndBytesPreserved: true,
        withdrawnSourceShareKeepsReferenceMedia: kind === "feedback" ? true : "not-applicable-to-ordinary-message",
        actualPeerRevocationKeepsPendingInput: kind === "message" ? true : "covered-by-message-scenario-at-same-width" });
      await bounded(context.close()); context = null; page = null;
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedRequests, []); report.cleanup.contextsClosed = true;
  } catch (error) {
    const firstLine = error?.message?.split("\n")[0];
    report.failure = { code: "RECORD_REFERENCE_MEDIA_BROWSER_FAILED", phase,
      type: error?.name === "AssertionError" ? "assertion" : "runtime-or-timeout",
      criterion: /^REFERENCE_MEDIA_[A-Z_]+$/.test(firstLine ?? "") ? firstLine : null,
      diagnostic: String(error?.message ?? error).slice(0, 1500),
      location: String(error?.stack ?? "").split("\n").find((line) => line.includes("record-reference-media-browser.mjs"))?.trim() ?? null,
      imageState: await page?.locator("img").evaluateAll((elements) => elements.map((element) => ({
        connected: element.isConnected, complete: element.complete, width: element.naturalWidth,
        src: element.getAttribute("src"), currentSrc: element.currentSrc,
        historical: Boolean(element.closest(".reference-media")), inDialog: Boolean(element.closest("#dialog")),
      }))).catch(() => null),
      mediaState: await page?.locator("video").evaluateAll((elements) => elements.map((element) => ({
        connected: element.isConnected, readyState: element.readyState, networkState: element.networkState,
        currentTime: element.currentTime, paused: element.paused, error: element.error?.code ?? null,
        src: element.getAttribute("src"), currentSrc: element.currentSrc,
        historical: Boolean(element.closest(".reference-media")), inDialog: Boolean(element.closest("#dialog")),
      }))).catch(() => null) };
    await page?.screenshot({ path: path.join(folder, "failure.png"), fullPage: true }).catch(() => {});
  } finally {
    if (context) try { await bounded(context.close()); report.cleanup.contextsClosed = true; } catch { /* Unverified. */ }
    if (browser) try { await bounded(browser.close()); } catch { /* Owned server remains below. */ }
    if (browserServer) {
      try { await bounded(browserServer.close()); } catch { try { await bounded(browserServer.kill()); } catch { /* Unverified. */ } }
      report.cleanup.browserStopped = typeof browserProcess?.exitCode === "number" || typeof browserProcess?.signalCode === "string";
    }
    if (server) try { await bounded(server.close()); report.cleanup.serverClosed = true; } catch { /* Unverified. */ }
    report.passed = !report.failure && report.checks.length === 6 && Object.values(report.cleanup).every(Boolean);
    await writeFile(path.join(folder, "results.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  }
  console.log(JSON.stringify({ runId, sourceSha256: report.source.sha256, passed: report.passed, checks: report.checks.length,
    cleanup: report.cleanup, failure: report.failure }));
  return report.passed;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runRecordReferenceMediaBrowser()) process.exitCode = 1; }
  catch { console.error("REFERENCE_MEDIA_CONFIGURATION_OR_STARTUP_FAILED"); process.exitCode = 1; }
}

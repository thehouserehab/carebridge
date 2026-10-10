// Owned synthetic schema-2 migration and UI editing only. Never uses an
// existing profile/tab, authenticated service, actual child data, or API.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureWorkingSnapshot, serveStudySnapshot } from "../scripts/p0-study-snapshots.mjs";
import { studyChildEnvironment, PUBLIC_ASSET } from "../scripts/p0-study-policy.mjs";
import { messageBrowserOptions } from "./message-browser-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const photo = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=", "base64");
const bounded = (operation, milliseconds = 10_000) => {
  let timer;
  return Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("LEGACY_BROWSER_TIMEOUT")), milliseconds);
  })]).finally(() => clearTimeout(timer));
};

export async function runLegacyAssessmentBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const file of [options.module, options.executable]) assert((await lstat(file)).isFile());
  const { chromium } = await import(pathToFileURL(options.module).href);
  const snapshot = await captureWorkingSnapshot(root), runId = randomUUID();
  const folder = path.join(root, "test-results", `legacy-assessment-${runId}`);
  await mkdir(folder);
  const report = { runId, at: new Date().toISOString(), source: snapshot.manifest, passed: false,
    checks: [], screenshots: [], errors: [], unexpectedRequests: [], failure: null,
    cleanup: { contextsClosed: false, browserStopped: false, serverClosed: false },
    limitations: ["Synthetic localStorage/IndexedDB migration only, not server/API or backup-device evidence.",
      "Chromium viewport emulation is not a physical device or human usability observation.",
      "Historical reading preserves original metadata; explicit new saves still require complete measurements."] };
  let server, browserServer, browserProcess, browser, context, page, phase = "STARTUP";
  try {
    server = await serveStudySnapshot(snapshot);
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: "127.0.0.1", port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    browserProcess = browserServer.process(); browser = await chromium.connect(browserServer.wsEndpoint());
    report.browserVersion = browser.version();
    for (const width of [320, 390, 1440]) {
      phase = `${width}:PREPARE_SCHEMA_TWO_ONLY`;
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
      // This public source document has no app bootstrap. Prepare the fixture
      // exactly once in an empty, owned origin before the product's first load.
      await page.goto(`${server.origin}/src/seed.js`);
      const fixture = await page.evaluate(async ({ bytes, width }) => {
        if (localStorage.length || sessionStorage.length) throw new Error("LEGACY_FIXTURE_NOT_EMPTY");
        const { seed } = await import("/src/seed.js");
        const { validateState } = await import("/src/domain.js");
        const { MediaStore } = await import("/src/media-store.js");
        const db = seed(), record = db.records.find((row) => row.id === "r2");
        record.title = `합성 기존 평가 기록 ${width}`;
        record.privateNote = "합성 원문 첫째 줄\n둘째 줄의  두 칸 공백과 기록을 보존합니다.";
        record.assessment = { tool: "  합성 관찰 도구  ", item: "  합성 측정 항목  ", value: 0, unit: "  회  ", context: "" };
        record.attachments = [{ id: `synthetic-legacy-original-${width}`, name: "synthetic-legacy-original.png",
          type: "image/png", size: bytes.length, share: false }];
        const spaced = structuredClone(record);
        spaced.id = "r3"; spaced.title = `합성 공백 조건 보존 ${width}`;
        spaced.assessment.context = "  합성 같은 위치 · 당시 조건  "; spaced.assessment.value = 7;
        spaced.attachments = [];
        db.records.push(spaced);
        if (db.schema !== 2 || !validateState(db)) throw new Error("LEGACY_FIXTURE_SCHEMA_TWO_INVALID");
        const store = new MediaStore();
        try { await store.write([[record.attachments[0].id, new Blob([new Uint8Array(bytes)], { type: "image/png" })]]); }
        finally { (await store.open()).close(); }
        const raw = `${JSON.stringify(db, null, 2)}\n`;
        localStorage.setItem("child-development-demo-v2", raw);
        return { db, raw };
      }, { bytes: [...photo], width });
      const original = fixture.db.records.find((row) => row.id === "r2");
      const dialog = page.locator("#dialog");
      const data = () => page.evaluate(() => JSON.parse(localStorage.getItem("child-development-demo-v2")));
      const backup = () => page.evaluate(() => localStorage.getItem("child-development-demo-v2-backup-schema-2"));
      const nav = (name) => page.getByRole("navigation", { name: width <= 640 ? "모바일 메뉴" : "주요 메뉴", exact: true })
        .getByRole("button", { name, exact: true }).click();
      const bytes = (id) => page.evaluate(async (id) => {
        const { MediaStore } = await import("/src/media-store.js"), store = new MediaStore();
        try { const blob = await store.read(id); return blob ? [...new Uint8Array(await blob.arrayBuffer())] : null; }
        finally { (await store.open()).close(); }
      }, id);
      const preserved = async () => {
        const db = await data(); assert.equal(db.schema, 3, "LEGACY_MIGRATED_SCHEMA");
        for (const old of fixture.db.records) {
          const record = db.records.find((row) => row.id === old.id);
          for (const key of Object.keys(old)) assert.deepEqual(record[key], old[key], "LEGACY_ORIGINAL_FIELDS_PRESERVED");
          assert.deepEqual(record.assessments, old.assessment ? [old.assessment] : [], "LEGACY_EXACT_ASSESSMENT_MIRROR");
        }
        assert.deepEqual(db.publications, fixture.db.publications, "LEGACY_PUBLICATIONS_PRESERVED");
        assert.equal(await backup(), fixture.raw, "LEGACY_BACKUP_BYTE_EXACT");
        assert.deepEqual(await bytes(original.attachments[0].id), [...photo], "LEGACY_ORIGINAL_BYTES_PRESERVED");
        return db;
      };
      const capture = async (flow) => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "LEGACY_PAGE_OVERFLOW");
        if (await dialog.isVisible()) assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, "LEGACY_DIALOG_OVERFLOW");
        const filename = `${width}-${flow}.png`;
        await page.screenshot({ path: path.join(folder, filename), fullPage: true });
        report.screenshots.push({ width, flow, filename, syntheticOnly: true });
      };

      phase = `${width}:INITIAL_MIGRATION_READS_BLANK_ZERO_AND_SPACES`;
      await page.goto(server.origin); await page.getByRole("heading", { name: "소식에서 다음 만남으로", exact: true }).waitFor();
      await preserved(); await nav("기록");
      const card = page.locator(".record-card").filter({ has: page.getByRole("heading", { name: original.title, exact: true }) });
      await card.getByText("내부 기록과 평가 보기", { exact: true }).click();
      assert.match(await card.innerText(), /(?:^|\s)0\s+회/u, "LEGACY_ZERO_VISIBLE");
      assert((await card.innerText()).includes("기존 형식 기록 · 원문 보존"), "LEGACY_ORIGINAL_LABEL");
      const image = card.locator("img"); await image.waitFor();
      assert.equal(await image.evaluate(async (element) => { await element.decode(); return element.naturalWidth; }), 1, "LEGACY_ORIGINAL_IMAGE_DECODED");
      await capture("migrated-original-visible");

      phase = `${width}:UNRELATED_MESSAGE_SAVE_AND_RELOAD`;
      await nav("대화");
      const conversation = page.locator('.conversation-row[data-id="c1"]');
      if (await conversation.isVisible()) await conversation.click();
      await page.waitForFunction(() => document.querySelector("#message-body") && !document.querySelector("#message-body").disabled);
      const body = `합성 마이그레이션 뒤 별도 소식 ${width}`;
      await page.getByLabel("소식 내용", { exact: true }).fill(body);
      await page.getByRole("button", { name: "보내기", exact: true }).click();
      await page.waitForFunction((text) => JSON.parse(localStorage.getItem("child-development-demo-v2")).messages.some((row) => row.body === text), body);
      const withMessage = await preserved(), sent = withMessage.messages.find((row) => row.body === body);
      assert.equal(withMessage.messages.filter((row) => row.body === body).length, 1, "LEGACY_UNRELATED_SEND_ONCE");
      await page.reload(); await preserved(); await nav("기록");
      await page.locator('[data-action="record"][data-id="r2"]').click();
      await dialog.getByRole("heading", { name: "세션 기록 수정", exact: true }).waitFor();
      for (const key of ["tool", "item", "value", "unit", "context"])
        assert.equal(await dialog.locator(`[name="assessment-0-${key}"]`).inputValue(), String(original.assessment[key]), "LEGACY_EDITOR_ORIGINAL_VALUES");
      assert.equal(await dialog.locator('[name="privateNote"]').inputValue(), original.privateNote, "LEGACY_EDITOR_ORIGINAL_TEXT");
      await capture("original-editor-after-reload");

      phase = `${width}:BLANK_CONDITION_STILL_BLOCKS_NEW_SAVE`;
      const beforeInvalid = await data(), condition = dialog.locator('[name="assessment-0-context"]');
      await dialog.getByRole("button", { name: "기록 저장", exact: true }).click();
      assert.equal(await dialog.isVisible(), true, "LEGACY_INVALID_FORM_REMAINS");
      assert.equal(await condition.evaluate((element) => element.validity.valueMissing), true, "LEGACY_CONDITION_REQUIRED");
      assert.deepEqual(await data(), beforeInvalid, "LEGACY_INVALID_SAVE_UNCHANGED");
      assert.equal(await backup(), fixture.raw, "LEGACY_INVALID_SAVE_BACKUP_UNCHANGED");
      await capture("blank-condition-blocked");

      phase = `${width}:EXPLICIT_CONDITION_ALLOWS_VALID_SAVE`;
      const confirmedCondition = "합성 편집에서 직접 확인한 조건";
      await condition.fill(confirmedCondition);
      await dialog.getByRole("button", { name: "기록 저장", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
      await page.reload(); await nav("기록");
      const final = await data(), edited = final.records.find((row) => row.id === "r2");
      assert.equal(edited.assessment, null, "LEGACY_EDIT_ENDS_PRESERVED_MIRROR");
      assert.deepEqual(edited.assessments, [{ tool: original.assessment.tool.trim(), item: original.assessment.item.trim(),
        value: 0, unit: original.assessment.unit.trim(), context: confirmedCondition }], "LEGACY_EDIT_REQUIRES_EXPLICIT_CONDITION");
      for (const key of ["id", "childId", "goalId", "date", "title", "privateNote", "summary", "nextPlan", "attachments", "activity", "publicationId", "appointmentId"])
        assert.deepEqual(edited[key], original[key], "LEGACY_UNEDITED_CONTENT_PRESERVED");
      assert.deepEqual(final.records.filter((row) => row.id !== "r2"), beforeInvalid.records.filter((row) => row.id !== "r2"), "LEGACY_OTHER_RECORDS_PRESERVED");
      assert.deepEqual(final.publications, fixture.db.publications, "LEGACY_OTHER_SHARES_PRESERVED");
      assert.deepEqual(final.messages.find((row) => row.id === sent.id), sent, "LEGACY_UNRELATED_MESSAGE_PRESERVED");
      assert.equal(await backup(), fixture.raw, "LEGACY_FINAL_BACKUP_BYTE_EXACT");
      assert.deepEqual(await bytes(original.attachments[0].id), [...photo], "LEGACY_FINAL_FILE_BYTE_EXACT");
      await page.locator('[data-action="record"][data-id="r2"]').click();
      assert.equal(await dialog.locator('[name="assessment-0-value"]').inputValue(), "0");
      assert.equal(await dialog.locator('[name="assessment-0-context"]').inputValue(), confirmedCondition);
      await capture("valid-edited-record-reopened");
      report.checks.push({ width, schemaTwoAcceptedWithoutInference: true, blankConditionAndWhitespaceAndZeroReadable: true,
        exactOriginalFieldsAndBackupPreserved: true, imageDecodedAndBytesPreserved: true, unrelatedMessageSaveAndReload: true,
        editorShowsHistoricalValues: true, missingConditionStillBlocksSave: true, explicitConditionAllowsSave: true,
        otherRecordsAndSharesAndMessagePreserved: true });
      await bounded(context.close()); context = null; page = null;
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedRequests, []); report.cleanup.contextsClosed = true;
  } catch (error) {
    const firstLine = error?.message?.split("\n")[0];
    report.failure = { code: "LEGACY_ASSESSMENT_BROWSER_FAILED", phase,
      type: error?.name === "AssertionError" ? "assertion" : "runtime-or-timeout",
      criterion: /^LEGACY_[A-Z_]+$/.test(firstLine ?? "") ? firstLine : null };
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
  console.log(JSON.stringify({ runId, passed: report.passed, sourceSha256: report.source.sha256, checks: report.checks.length,
    cleanup: report.cleanup, failure: report.failure }));
  return report.passed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runLegacyAssessmentBrowser()) process.exitCode = 1; }
  catch { console.error("LEGACY_ASSESSMENT_CONFIGURATION_OR_STARTUP_FAILED"); process.exitCode = 1; }
}

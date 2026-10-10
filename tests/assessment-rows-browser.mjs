// Synthetic saved-record editing in a fresh owned browser. No existing tab,
// profile, production data, API, or authenticated service is involved.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureWorkingSnapshot, serveStudySnapshot } from "../scripts/p0-study-snapshots.mjs";
import { studyChildEnvironment, PUBLIC_ASSET } from "../scripts/p0-study-policy.mjs";
import { messageBrowserOptions } from "./message-browser-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fields = ["tool", "item", "value", "unit", "context"];
const photo = { name: "synthetic-assessment-original.png", mimeType: "image/png",
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=", "base64") };
const bounded = (operation, milliseconds = 10_000) => {
  let timer;
  return Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("ASSESSMENT_BROWSER_TIMEOUT")), milliseconds);
  })]).finally(() => clearTimeout(timer));
};
const reveal = async (locator) => {
  for (const details of await locator.locator("xpath=ancestor::details").all())
    if (await details.getAttribute("open") === null) await details.locator(":scope > summary").click();
};

export async function runAssessmentRowsBrowser(args = process.argv.slice(2), configuration = {}) {
  const options = messageBrowserOptions(args);
  for (const file of [options.module, options.executable]) assert((await lstat(file)).isFile());
  const { chromium } = await import(pathToFileURL(options.module).href);
  // A trusted test caller can retain the pre-edit snapshot in memory while
  // this regression is authored; this is not an arbitrary remote-server hook.
  const snapshot = configuration.snapshot ?? await captureWorkingSnapshot(root);
  const runId = randomUUID(), folder = path.join(root, "test-results", `assessment-rows-${runId}`);
  await mkdir(folder);
  const report = { runId, at: new Date().toISOString(), source: snapshot.manifest, passed: false,
    checks: [], observations: [], errors: [], unexpectedRequests: [], failure: null,
    cleanup: { contextsClosed: false, browserStopped: false, serverClosed: false },
    limitations: ["Synthetic UI/local storage only, not authenticated server or cross-device evidence.",
      "Chromium viewport emulation, not physical devices or human performance evidence.",
      "The defect concerns duplicate input names and fieldset legends; original inputs use wrapping labels, not duplicate IDs."] };
  let server, browserServer, browserProcess, browser, context, page, phase = "STARTUP";
  try {
    server = await serveStudySnapshot(snapshot);
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: "127.0.0.1", port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    browserProcess = browserServer.process(); browser = await chromium.connect(browserServer.wsEndpoint());
    report.browserVersion = browser.version();
    for (const width of [320, 390, 1440]) {
      phase = `${width}:CREATE_SAVED_THREE_ROWS`;
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
      const dialog = page.locator("#dialog"), rows = dialog.locator("[data-assessment]");
      const add = dialog.locator('[data-action="add-assessment"]');
      const rowInput = (index, key) => rows.nth(index).locator(`[name$="-${key}"]`);
      const nav = (name) => page.getByRole("navigation", { name: width <= 640 ? "모바일 메뉴" : "주요 메뉴", exact: true })
        .getByRole("button", { name, exact: true }).click();
      const data = () => page.evaluate(() => JSON.parse(localStorage.getItem("child-development-demo-v2")));
      const fill = async (name, value) => {
        const input = dialog.locator(`[name="${name}"]`); await reveal(input); await input.fill(value);
      };
      const fillRow = async (index, label, value) => {
        for (const [key, content] of Object.entries({ tool: `SYNTHETIC_PRIVATE_TOOL_${label}`, item: `SYNTHETIC_PRIVATE_ITEM_${label}`,
          value, unit: "회", context: `SYNTHETIC_PRIVATE_CONTEXT_${label}` })) await rowInput(index, key).fill(String(content));
      };
      const rowState = () => rows.evaluateAll((elements) => elements.map((element) => ({
        legend: element.querySelector("legend").textContent,
        names: Array.from(element.querySelectorAll("input"), (input) => input.name),
        values: Array.from(element.querySelectorAll("input"), (input) => input.value),
        badInput: Array.from(element.querySelectorAll("input"), (input) => input.validity.badInput),
      })));
      const numbered = async () => {
        const state = await rowState();
        assert.deepEqual(state.map((row) => row.legend), state.map((_, index) => `측정값 ${index + 1}`), "ASSESSMENT_LEGENDS_SEQUENTIAL");
        assert.deepEqual(state.map((row) => row.names), state.map((_, index) => fields.map((field) => `assessment-${index}-${field}`)), "ASSESSMENT_NAMES_SEQUENTIAL");
        assert.equal(new Set(state.flatMap((row) => row.names)).size, state.length * fields.length, "ASSESSMENT_NAMES_UNIQUE");
        return state;
      };
      const focusState = () => page.evaluate(() => ({ tag: document.activeElement?.tagName,
        name: document.activeElement?.getAttribute("name"), action: document.activeElement?.getAttribute("data-action") }));
      const addRow = async () => {
        const count = await rows.count(); await reveal(add); await add.focus(); await page.keyboard.press("Enter");
        assert.equal(await rows.count(), count + 1);
        assert.deepEqual((await rowState()).at(-1).values, fields.map(() => ""), "ASSESSMENT_NEW_ROW_EMPTY");
        assert.equal(await rowInput(count, "tool").evaluate((input) => input === document.activeElement), true);
      };
      const removeRow = async (index, { deferAssertions = false } = {}) => {
        const before = await rowState(), handles = await rows.locator("input").elementHandles();
        const target = rows.nth(index).getByRole("button", { name: "이 측정값 제거", exact: true });
        await target.focus(); await page.keyboard.press("Enter");
        const focus = await focusState(), after = await rowState();
        const expectedFocus = after.length ? { tag: "INPUT", name: `assessment-${Math.min(index, after.length - 1)}-tool`, action: null }
          : { tag: "BUTTON", name: null, action: "add-assessment" };
        const survivors = handles.filter((_, at) => Math.floor(at / fields.length) !== index);
        let nodesPreserved = true;
        for (let at = 0; at < survivors.length; at++) nodesPreserved &&= await survivors[at].evaluate((input, offset) =>
          input === document.querySelectorAll("#assessment-rows input")[offset], at);
        for (const handle of handles) await handle.dispose();
        const expectedRows = before.filter((_, at) => at !== index);
        const valuesPreserved = JSON.stringify(after.map((row) => [row.values, row.badInput])) ===
          JSON.stringify(expectedRows.map((row) => [row.values, row.badInput]));
        if (!deferAssertions) {
          assert.deepEqual(focus, expectedFocus, "ASSESSMENT_REMOVE_FOCUS");
          assert(nodesPreserved && valuesPreserved, "ASSESSMENT_SURVIVING_INPUT_STATE"); await numbered();
        }
        return { focus, expectedFocus, nodesPreserved, valuesPreserved, after };
      };
      const save = async (name) => {
        const submit = dialog.getByRole("button", { name, exact: true }); await submit.focus(); await page.keyboard.press("Enter");
        await dialog.waitFor({ state: "hidden" });
      };
      const screenshot = async (name) => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        if (await dialog.isVisible()) assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
        await page.screenshot({ path: path.join(folder, `${width}-${name}.png`), fullPage: true });
      };
      const readBlob = (id) => page.evaluate(async (id) => {
        const { MediaStore } = await import("/src/media-store.js"); const store = new MediaStore();
        try { const blob = await store.read(id); return blob ? [...new Uint8Array(await blob.arrayBuffer())] : null; }
        finally { (await store.open()).close(); }
      }, id);

      await page.goto(server.origin); await page.getByRole("heading", { name: "소식에서 다음 만남으로", exact: true }).waitFor();
      await nav("기록"); await page.locator('.page-heading [data-action="record"]').click();
      await fill("performed", "합성 복수 측정 행 편집");
      await fill("title", `SYNTHETIC_ASSESSMENT_RECORD_${width}`);
      await fill("summary", "합성 보호자 공유 요약: 함께한 활동을 안내합니다.");
      for (const [index, value] of [8, 0, 6].entries()) { await addRow(); await fillRow(index, `ORIGINAL_${index}`, value); }
      const fileInput = dialog.locator('input[type="file"]'); await reveal(fileInput); await fileInput.setInputFiles(photo);
      await page.waitForFunction(() => document.querySelector("#dialog .attachment-row") && !document.querySelector('#dialog input[type="file"]').disabled);
      await save("기록 저장");
      const saved = await data(), original = saved.records.at(-1), originalOtherRecords = saved.records.slice(0, -1);
      assert.deepEqual(original.assessments.map((row) => row.value), [8, 0, 6]); assert.equal(original.attachments.length, 1);
      const originalFile = original.attachments[0]; assert.deepEqual(await readBlob(originalFile.id), [...photo.buffer]);
      const reopen = async () => {
        await nav("기록"); await page.locator(`[data-action="record"][data-id="${original.id}"]`).click();
        await dialog.getByRole("heading", { name: "세션 기록 수정", exact: true }).waitFor();
      };
      await page.reload(); await reopen();
      phase = `${width}:SAVED_REMOVE_FIRST_THEN_ADD`;
      const removed = await removeRow(0, { deferAssertions: true });
      // Capture the removal focus before adding steals focus again. Observe
      // both original failures before stopping at this broken edit boundary.
      await addRow();
      const afterAdd = await rowState(), names = afterAdd.flatMap((row) => row.names);
      report.observations.push({ width, stage: "saved-remove-first-add", removeFocus: removed.focus,
        expectedRemoveFocus: removed.expectedFocus, survivingNodes: removed.nodesPreserved,
        survivingValues: removed.valuesPreserved, legends: afterAdd.map((row) => row.legend),
        duplicateNameCount: names.length - new Set(names).size });
      await screenshot("saved-remove-first-add");
      await numbered(); assert.deepEqual(removed.focus, removed.expectedFocus, "ASSESSMENT_REMOVE_FOCUS");
      assert(removed.nodesPreserved && removed.valuesPreserved, "ASSESSMENT_SURVIVING_INPUT_STATE");
      assert.equal(await rowInput(0, "value").inputValue(), "0");

      phase = `${width}:MIDDLE_LAST_KEEP_INVALID_NUMBER_AND_ZERO`;
      await rowInput(1, "value").fill(""); await rowInput(1, "value").pressSequentially("-");
      assert.equal(await rowInput(1, "value").evaluate((input) => input.validity.badInput), true);
      await addRow(); await removeRow(2); await addRow(); await removeRow(3);
      assert.equal(await rowInput(0, "value").inputValue(), "0");
      assert.equal(await rowInput(1, "value").evaluate((input) => input.validity.badInput), true);
      assert.equal(await rowInput(2, "value").inputValue(), "");
      const beforeInvalidSave = await data();
      await dialog.getByRole("button", { name: "초안 저장", exact: true }).click();
      assert.equal(await dialog.isVisible(), true); assert.deepEqual(await data(), beforeInvalidSave);
      assert.equal(await rowInput(1, "value").evaluate((input) => input.validity.badInput), true);
      await screenshot("invalid-number-retained"); await rowInput(1, "value").fill("");
      await save("초안 저장");
      let current = (await data()).records.find((row) => row.id === original.id);
      assert.deepEqual(current.assessments.map((row) => row.value), [0, null, null]);
      await page.reload(); await reopen(); await numbered();
      assert.deepEqual((await rowState()).map((row) => row.values[2]), ["0", "", ""]);

      phase = `${width}:TWENTY_ROW_LIMIT_AND_REMOVE_ALL`;
      while (await rows.count() < 20) await addRow();
      await numbered();
      if (await add.isEnabled()) { await add.focus(); await page.keyboard.press("Enter"); }
      assert.equal(await rows.count(), 20); await numbered();
      while (await rows.count()) await removeRow(0);
      assert.deepEqual(await focusState(), { tag: "BUTTON", name: null, action: "add-assessment" });
      for (const [index, value] of [0, "", 5].entries()) { await addRow(); await fillRow(index, `FINAL_${index}`, value); }
      await numbered(); await save("초안 저장");
      current = (await data()).records.find((row) => row.id === original.id);
      assert.deepEqual(current.assessments.map((row) => row.value), [0, null, 5]);
      const draftOrder = structuredClone(current.assessments);
      await page.reload(); await reopen(); await numbered();
      for (let index = 0; index < draftOrder.length; index++) for (const field of fields)
        assert.equal(await rowInput(index, field).inputValue(), String(draftOrder[index][field] ?? ""));
      await rowInput(1, "value").fill("2"); await save("기록 저장");
      const final = await data(); current = final.records.find((row) => row.id === original.id);
      assert.deepEqual(current.assessments.map((row) => row.value), [0, 2, 5]);
      assert.deepEqual(current.attachments, original.attachments);
      assert.deepEqual(final.records.filter((row) => row.id !== original.id), originalOtherRecords);
      assert.deepEqual(await readBlob(originalFile.id), [...photo.buffer]);

      phase = `${width}:PUBLIC_PREVIEW_EXCLUDES_ASSESSMENTS`;
      await page.locator(`[data-action="preview"][data-id="${original.id}"]`).click();
      const preview = await dialog.textContent();
      assert(preview.includes(current.summary)); assert(!preview.includes("SYNTHETIC_PRIVATE_"));
      assert.equal(await dialog.locator(".media-item").count(), 0, "Unshared original remains private");
      await screenshot("share-preview"); await save("보호자에게 공유");
      await page.getByLabel("사용자 역할", { exact: true }).selectOption("guardian"); await nav("기록");
      const guardian = await page.locator("#main").textContent();
      assert(guardian.includes(current.summary)); assert(!guardian.includes("SYNTHETIC_PRIVATE_"));
      assert(!guardian.includes(photo.name)); assert.deepEqual(await readBlob(originalFile.id), [...photo.buffer]);
      await screenshot("guardian-privacy");
      report.checks.push({ width, savedReopenFirstMiddleLastAllRemoval: true, sequentialNamesAndLegends: true,
        survivingInputNodesAndInvalidNumberRetained: true, keyboardFocus: true, newRowsEmpty: true,
        twentyRowLimit: true, zeroAndMissingDistinct: true, storedOrderAndOriginalBytesPreserved: true,
        unrelatedRecordsPreserved: true, assessmentsExcludedFromSharing: true });
      await bounded(context.close()); context = null; page = null;
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedRequests, []); report.cleanup.contextsClosed = true;
  } catch (error) {
    const firstLine = error?.message?.split("\n")[0];
    report.failure = { code: "ASSESSMENT_ROWS_BROWSER_FAILED", phase,
      type: error?.name === "AssertionError" ? "assertion" : "runtime-or-timeout",
      criterion: /^ASSESSMENT_[A-Z_]+$/.test(firstLine ?? "") ? firstLine : null };
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
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length, observations: report.observations,
    cleanup: report.cleanup, failure: report.failure }));
  return report.passed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runAssessmentRowsBrowser()) process.exitCode = 1; }
  catch { console.error("ASSESSMENT_ROWS_CONFIGURATION_OR_STARTUP_FAILED"); process.exitCode = 1; }
}

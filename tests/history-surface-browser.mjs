// Synthetic role/history regression using a fresh owned browser and frozen
// public assets. Domain mutations prepare fixtures; relationship changes and
// disclosure checks use the actual user interface. No real account or API.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureWorkingSnapshot, serveStudySnapshot } from "../scripts/p0-study-snapshots.mjs";
import { studyChildEnvironment, PUBLIC_ASSET } from "../scripts/p0-study-policy.mjs";
import { messageBrowserOptions } from "./message-browser-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const bounded = (operation, milliseconds = 10_000) => {
  let timer;
  return Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("HISTORY_SURFACE_TIMEOUT")), milliseconds);
  })]).finally(() => clearTimeout(timer));
};
const marker = (generation, kind, field) => `SYNTHETIC_${generation}_${kind}_${field}`;

async function prepare(page, generation) {
  return page.evaluate(async (generation) => {
    const { mutate, validateState } = await import("/src/domain.js");
    const { load, persist } = await import("/src/repository.js");
    const { STORAGE_KEY, today } = await import("/src/config.js");
    const loaded = load(localStorage);
    if (loaded.error) throw new Error("SYNTHETIC_HISTORY_FIXTURE_LOAD");
    let db = loaded.db; const previous = db.revision;
    const therapist = { id: "t1", role: "therapist" }, guardian = { id: "p1", role: "guardian" };
    const mark = (kind, field) => `SYNTHETIC_${generation}_${kind}_${field}`;
    const record = (kind, id = "") => {
      db = mutate(db, therapist, "record", { childId: "c1", ...(id ? { id } : {}), goalId: "g1", date: today(),
        title: mark(kind, "RECORD"), summary: mark(kind, "SUMMARY"), performed: "합성 관찰 입력",
        response: "합성 반응", nextPlan: "", privateNote: "", status: "saved", format: "structured",
        activity: { title: mark(kind, "TITLE"), instruction: mark(kind, "INSTRUCTION"), frequency: "합성 빈도",
          caution: mark(kind, "CAUTION") }, attachments: [], assessments: [] });
      const currentId = id || db.records.at(-1).id;
      db = mutate(db, therapist, "publish", { childId: "c1", id: currentId });
      return currentId;
    };
    const current = record("CURRENT"), replaced = record("PREVIOUS");
    record("LATEST", replaced);
    const withdrawn = record("WITHDRAWN");
    db = mutate(db, therapist, "unpublish", { childId: "c1", id: withdrawn });
    const messageId = `synthetic-history-${generation.toLowerCase()}-message`;
    db = mutate(db, guardian, "message", { childId: "c1", clientId: messageId, body: mark("MESSAGE", "BODY"), attachments: [] });
    db = mutate(db, therapist, "message-review", { childId: "c1", id: messageId, reviewNote: mark("MESSAGE", "REVIEW") });
    if (!validateState(db)) throw new Error("SYNTHETIC_HISTORY_FIXTURE_INVALID");
    persist(localStorage, db, previous);
    if (!localStorage.getItem(STORAGE_KEY)) throw new Error("SYNTHETIC_HISTORY_FIXTURE_MISSING");
    return { recordIds: [current, replaced, withdrawn], messageId,
      records: db.records.filter((row) => [current, replaced, withdrawn].includes(row.id)),
      publications: db.publications.filter((row) => [current, replaced, withdrawn].includes(row.recordId)),
      message: db.messages.find((row) => row.id === messageId) };
  }, generation);
}

export async function runHistorySurfaceBrowser(args = process.argv.slice(2), configuration = {}) {
  const options = messageBrowserOptions(args);
  const surfaces = configuration.surfaces ?? ["guardian", "therapist"];
  assert(Array.isArray(surfaces) && surfaces.length > 0 && surfaces.length <= 2 &&
    new Set(surfaces).size === surfaces.length && surfaces.every((value) => ["guardian", "therapist"].includes(value)));
  for (const file of [options.module, options.executable]) assert((await lstat(file)).isFile());
  const { chromium } = await import(pathToFileURL(options.module).href);
  // An internal caller may supply an already captured baseline in memory, so
  // product edits during test authoring cannot replace the reproduction source.
  const snapshot = configuration.snapshot ?? await captureWorkingSnapshot(root);
  const runId = randomUUID(), folder = path.join(root, "test-results", `history-surface-${runId}`);
  await mkdir(folder);
  const report = { runId, at: new Date().toISOString(), source: snapshot.manifest, surfaces, passed: false,
    checks: [], errors: [], unexpectedRequests: [], observations: [], failure: null,
    cleanup: { contextsClosed: false, browserStopped: false, serverClosed: false },
    limitations: ["Synthetic browser role/history projection only; no actual authentication, API, cross-device or human evidence.",
      "Domain functions prepare synthetic records; actual center UI changes and separately confirms past-history access."] };
  let server, browserServer, browserProcess, browser, context, page, phase = "STARTUP";
  try {
    server = await serveStudySnapshot(snapshot);
    browserServer = await chromium.launchServer({ headless: true, executablePath: options.executable,
      host: "127.0.0.1", port: 0, env: studyChildEnvironment(), timeout: 30_000 });
    browserProcess = browserServer.process();
    browser = await chromium.connect(browserServer.wsEndpoint()); report.browserVersion = browser.version();
    for (const width of [320, 390, 1440]) for (const surface of surfaces) {
      phase = `${width}:${surface}:INITIAL_FIXTURE`;
      context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ko-KR",
        hasTouch: width <= 640, isMobile: width <= 640, serviceWorkers: "block", permissions: [] });
      page = await context.newPage(); page.setDefaultTimeout(8_000);
      page.on("pageerror", () => report.errors.push({ width, surface, phase, type: "pageerror" }));
      page.on("console", (message) => { if (message.type() === "error") report.errors.push({ width, surface, phase, type: "console" }); });
      await context.route("**/*", (route) => {
        const request = route.request(), url = new URL(request.url());
        const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (url.origin === server.origin && !url.search && !url.hash && ["GET", "HEAD"].includes(request.method()) &&
          PUBLIC_ASSET.test(name) && snapshot.read(name)) return route.continue();
        report.unexpectedRequests.push({ width, surface, phase, sameOrigin: url.origin === server.origin, method: request.method() });
        return route.abort();
      });
      const dialog = page.locator("#dialog");
      const role = (value) => page.getByLabel("사용자 역할", { exact: true }).selectOption(value);
      const nav = (name) => page.getByRole("navigation", { name: width <= 640 ? "모바일 메뉴" : "주요 메뉴", exact: true })
        .getByRole("button", { name, exact: true }).click();
      const close = async () => { await dialog.getByRole("button", { name: "닫기", exact: true }).click(); await dialog.waitFor({ state: "hidden" }); };
      const data = () => page.evaluate(() => JSON.parse(localStorage.getItem("child-development-demo-v2")));
      const relationship = async (therapist, guardian, all = false) => {
        await role("center"); await nav("아동");
        await page.locator('.child-row[data-id="c1"]').click();
        await page.getByRole("button", { name: "담당 관계 관리", exact: true }).click();
        await dialog.locator('[name="therapistId"]').selectOption(therapist);
        for (const id of ["p1", "p2", "p3"]) await dialog.locator(`[name="guardianIds"][value="${id}"]`).setChecked(id === guardian);
        assert.equal(await dialog.locator('[name="pastHistoryConfirmed"]').isChecked(), false);
        await dialog.locator('[name="historyConfirmed"]').check();
        if (all) {
          await dialog.locator('[name="therapistHistory"]').selectOption("all");
          await dialog.locator(`[name="history-${guardian}"]`).selectOption("all");
          // The separate past-history acknowledgement must be required even
          // when the ordinary relationship confirmation was already checked.
          const before = await data();
          await dialog.getByRole("button", { name: "관계 저장", exact: true }).click();
          await dialog.locator("#form-error").waitFor({ state: "visible" });
          assert.deepEqual(await data(), before);
          await dialog.locator('[name="pastHistoryConfirmed"]').check();
        }
        await dialog.getByRole("button", { name: "관계 저장", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
      };
      const openSurface = async () => {
        await role(surface);
        if (surface === "guardian") {
          await nav("아이 정보");
          await page.getByRole("button", { name: "가정 활동", exact: true }).click();
          await page.getByRole("heading", { name: "함께 해볼 활동", exact: true }).waitFor();
          for (const item of await page.locator(".activity-card details summary").all()) await item.click();
        } else {
          await nav("기록");
          await page.getByRole("combobox", { name: "선택한 아동", exact: true }).selectOption("c1");
          await page.locator('.page-heading [data-action="record"]').click();
          await dialog.getByRole("heading", { name: "오늘의 세션 기록", exact: true }).waitFor();
          const prior = dialog.locator("details.previous-context > summary");
          if (await prior.count()) await prior.click();
        }
      };
      const inspect = async (oldAllowed, stage) => {
        await openSurface();
        const text = await (surface === "guardian" ? page.locator("#view-content") : dialog).textContent();
        const oldMarkers = surface === "guardian" ? ["TITLE", "INSTRUCTION", "CAUTION"].map((field) => marker("OLD", "CURRENT", field))
          : [marker("OLD", "MESSAGE", "REVIEW")];
        const futureMarkers = surface === "guardian" ? ["TITLE", "INSTRUCTION", "CAUTION"].map((field) => marker("NEW", "CURRENT", field))
          : [marker("NEW", "MESSAGE", "REVIEW")];
        const forbidden = surface === "guardian" ? ["OLD", "NEW"].flatMap((generation) => ["PREVIOUS", "WITHDRAWN"].flatMap((kind) =>
          ["TITLE", "INSTRUCTION", "CAUTION"].map((field) => marker(generation, kind, field)))) : [];
        const observed = { width, surface, stage, oldContentPresent: oldMarkers.map((value) => text.includes(value)),
          newContentPresent: futureMarkers.map((value) => text.includes(value)), supersededOrWithdrawnPresent: forbidden.map((value) => text.includes(value)) };
        report.observations.push(observed);
        await page.screenshot({ path: path.join(folder, `${width}-${surface}-${stage}.png`), fullPage: true });
        assert.deepEqual(observed.oldContentPresent, oldMarkers.map(() => oldAllowed), "HISTORY_SURFACE_OLD_DISCLOSURE");
        assert(observed.newContentPresent.every(Boolean), "HISTORY_SURFACE_NEW_MISSING");
        assert(observed.supersededOrWithdrawnPresent.every((value) => !value), "HISTORY_SURFACE_NONCURRENT_DISCLOSURE");
        if (surface === "guardian") assert(text.includes(marker("NEW", "LATEST", "TITLE")));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        if (surface === "therapist") {
          await close();
          // Therapist projections intentionally retain historical shares for
          // clinical history; the activity list must still intersect CURRENT
          // share IDs rather than rendering every permitted old publication.
          await nav("아이 정보");
          await page.getByRole("button", { name: "가정 활동", exact: true }).click();
          await page.getByRole("heading", { name: "공유 중인 가정 활동", exact: true }).waitFor();
          for (const item of await page.locator(".activity-card details summary").all()) await item.click();
          const activities = await page.locator("#view-content").textContent();
          const fields = ["TITLE", "INSTRUCTION", "CAUTION"];
          const prior = fields.map((field) => activities.includes(marker("OLD", "CURRENT", field)));
          const current = fields.map((field) => activities.includes(marker("NEW", "CURRENT", field)));
          const noncurrent = ["OLD", "NEW"].flatMap((generation) => ["PREVIOUS", "WITHDRAWN"].flatMap((kind) =>
            fields.map((field) => activities.includes(marker(generation, kind, field)))));
          report.observations.push({ width, surface, stage: `${stage}:activities`, oldContentPresent: prior,
            newContentPresent: current, supersededOrWithdrawnPresent: noncurrent });
          await page.screenshot({ path: path.join(folder, `${width}-${surface}-${stage}-activities.png`), fullPage: true });
          assert.deepEqual(prior, fields.map(() => oldAllowed), "HISTORY_SURFACE_OLD_DISCLOSURE");
          assert(current.every(Boolean), "HISTORY_SURFACE_NEW_MISSING");
          assert(noncurrent.every((value) => !value), "HISTORY_SURFACE_NONCURRENT_DISCLOSURE");
          assert(activities.includes(marker("NEW", "LATEST", "TITLE")));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        }
      };

      await page.goto(server.origin);
      await page.getByRole("heading", { name: "소식에서 다음 만남으로", exact: true }).waitFor();
      const original = await prepare(page, "OLD");
      await page.reload();
      phase = `${width}:${surface}:FUTURE_ONLY_RECONNECT`;
      await relationship("t2", "p2"); await relationship("t1", "p1");
      const reconnect = await data(), child = reconnect.children.find((row) => row.id === "c1");
      assert.equal(child.therapistId, "t1"); assert.deepEqual(child.guardianIds, ["p1"]);
      for (const id of ["t1", "p1"]) {
        const access = child.historyAccess.find((entry) => entry.userId === id);
        assert(access.firstSequence > original.message.sequence);
        assert(access.firstRecordRevision > Math.max(...original.records.map((row) => row.createdRevision)));
      }
      await prepare(page, "NEW"); await page.reload();
      phase = `${width}:${surface}:FUTURE_ONLY_DISCLOSURE`;
      await inspect(false, "future-only");
      phase = `${width}:${surface}:EXPLICIT_PAST_CONFIRMATION`;
      await relationship("t1", "p1", true);
      phase = `${width}:${surface}:PAST_ALLOWED_CURRENT_ONLY`;
      await inspect(true, "past-confirmed");
      const final = await data();
      assert.deepEqual(final.records.filter((row) => original.recordIds.includes(row.id)), original.records);
      assert.deepEqual(final.publications.filter((row) => original.recordIds.includes(row.recordId)), original.publications);
      assert.deepEqual(final.messages.find((row) => row.id === original.messageId), original.message);
      if (surface === "therapist") {
        phase = `${width}:${surface}:HIDDEN_DELETED_NOTE_RETENTION`;
        const retained = await page.evaluate(async (messageId) => {
          const { mutate } = await import("/src/domain.js");
          const { load, persist } = await import("/src/repository.js");
          let db = load(localStorage).db; const previous = db.revision;
          db = mutate(db, { id: "t1", role: "therapist" }, "message-delete", { childId: "c1", id: messageId,
            clientId: "synthetic-history-self-hide", scope: "self", confirmed: true });
          db = mutate(db, { id: "p1", role: "guardian" }, "message-delete", { childId: "c1", id: messageId,
            clientId: "synthetic-history-all-delete", scope: "all", confirmed: true, expectedVersion: 1 });
          persist(localStorage, db, previous);
          const row = db.messages.find((item) => item.id === messageId);
          return { deleted: Boolean(row.deletedAt), hidden: row.hiddenFor.some((item) => item.userId === "t1"),
            body: row.body, sentBody: row.sentBody, reviewNote: row.reviewNote };
        }, original.messageId);
        assert.deepEqual(retained, { deleted: true, hidden: true, body: original.message.body,
          sentBody: original.message.body, reviewNote: original.message.reviewNote });
        await page.reload();
        await inspect(true, "hidden-deleted-note-retained");
      }
      report.checks.push({ width, surface, defaultReconnectFutureOnly: true, newContentVisible: true,
        explicitPastConfirmationRequired: true, originalDataPreserved: true, currentOnly: true,
        hiddenDeletedReviewRetained: surface === "therapist" });
      await bounded(context.close()); context = null; page = null;
    }
    assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedRequests, []);
    report.cleanup.contextsClosed = true;
  } catch (error) {
    report.failure = { code: "HISTORY_SURFACE_BROWSER_FAILED", phase,
      type: error?.name === "AssertionError" ? "assertion" : "runtime-or-timeout",
      criterion: /^HISTORY_SURFACE_[A-Z_]+$/.test(error?.message?.split("\n")[0] ?? "") ? error.message.split("\n")[0] : null };
    await page?.screenshot({ path: path.join(folder, "failure.png"), fullPage: true }).catch(() => {});
  } finally {
    if (context) try { await bounded(context.close()); report.cleanup.contextsClosed = true; } catch { /* Not verified. */ }
    if (browser) try { await bounded(browser.close()); } catch { /* Owned server remains below. */ }
    if (browserServer) {
      try { await bounded(browserServer.close()); } catch { try { await bounded(browserServer.kill()); } catch { /* Not verified. */ } }
      report.cleanup.browserStopped = typeof browserProcess?.exitCode === "number" || typeof browserProcess?.signalCode === "string";
    }
    if (server) try { await bounded(server.close()); report.cleanup.serverClosed = true; } catch { /* Not verified. */ }
    report.passed = !report.failure && report.checks.length === 3 * surfaces.length && Object.values(report.cleanup).every(Boolean);
    await writeFile(path.join(folder, "results.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length, observations: report.observations,
    cleanup: report.cleanup, failure: report.failure }));
  return report.passed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runHistorySurfaceBrowser()) process.exitCode = 1; }
  catch { console.error("HISTORY_SURFACE_CONFIGURATION_OR_STARTUP_FAILED"); process.exitCode = 1; }
}

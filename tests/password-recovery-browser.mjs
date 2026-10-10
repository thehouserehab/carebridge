// Explicit synthetic UI rehearsal, using a frozen public snapshot and a fresh
// owned browser. No existing tab/profile, real account, API or mail delivery.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureWorkingSnapshot, serveStudySnapshot } from "../scripts/p0-study-snapshots.mjs";
import { studyChildEnvironment, PUBLIC_ASSET } from "../scripts/p0-study-policy.mjs";
import { messageBrowserOptions } from "./message-browser-policy.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const PASSWORD = "Synthetic recovery rehearsal only";
const CONFIRMATION = "Synthetic mismatch rehearsal only";
const bounded = (operation, milliseconds = 10_000) => {
  let timer;
  return Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("RECOVERY_BROWSER_CHECK_TIMEOUT")), milliseconds);
  })]).finally(() => clearTimeout(timer));
};

// Read every existing object store, including Blob bytes, rather than proving
// persistence only by a count or by localStorage's clinical JSON. Opens abort
// any unexpected upgrade so this inspection cannot silently create a DB.
const stored = (page) => page.evaluate(async () => {
  const requestValue = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("SYNTHETIC_STORAGE_READ_FAILED"));
  });
  const normalize = async (value) => {
    if (value instanceof Blob) {
      const digest = await crypto.subtle.digest("SHA-256", await value.arrayBuffer());
      return { blob: true, type: value.type, size: value.size,
        sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") };
    }
    if (value instanceof Date) return { date: value.toISOString() };
    if (value instanceof ArrayBuffer) return { bytes: Array.from(new Uint8Array(value)) };
    if (ArrayBuffer.isView(value)) return { bytes: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    if (Array.isArray(value)) return Promise.all(value.map(normalize));
    if (value && typeof value === "object") return Object.fromEntries(await Promise.all(
      Object.keys(value).sort().map(async (key) => [key, await normalize(value[key])])));
    return value;
  };
  const databases = [];
  for (const entry of (await indexedDB.databases()).sort((a, b) => a.name.localeCompare(b.name))) {
    const request = indexedDB.open(entry.name, entry.version);
    request.onupgradeneeded = () => request.transaction.abort();
    const db = await requestValue(request);
    try {
      const stores = [];
      for (const name of Array.from(db.objectStoreNames).sort()) {
        const transaction = db.transaction(name, "readonly"), store = transaction.objectStore(name);
        const completed = new Promise((resolve, reject) => {
          transaction.oncomplete = resolve;
          transaction.onerror = transaction.onabort = () => reject(new Error("SYNTHETIC_STORAGE_READ_FAILED"));
        });
        const keys = requestValue(store.getAllKeys()), values = requestValue(store.getAll());
        const indexes = Array.from(store.indexNames).sort().map((index) => {
          const item = store.index(index);
          return { name: index, keyPath: item.keyPath, unique: item.unique, multiEntry: item.multiEntry };
        });
        const rows = await Promise.all([keys, values, completed]);
        stores.push({ name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes,
          keys: await normalize(rows[0]), values: await normalize(rows[1]) });
      }
      databases.push({ name: entry.name, version: db.version, stores });
    } finally { db.close(); }
  }
  const storage = (item) => Object.fromEntries(Object.keys(item).sort().map((key) => [key, item.getItem(key)]));
  return { local: storage(localStorage), session: storage(sessionStorage), databases };
});

export async function runPasswordRecoveryBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const file of [options.module, options.executable])
    assert((await lstat(file)).isFile(), "Existing local runtime required; no installation");
  const { chromium } = await import(pathToFileURL(options.module).href);
  const snapshot = await captureWorkingSnapshot(root);
  const runId = randomUUID(), folder = path.join(root, "test-results", `password-recovery-${runId}`);
  await mkdir(folder);
  const report = {
    runId, at: new Date().toISOString(), passed: false, source: snapshot.manifest,
    checks: [], errors: [], unexpectedRequests: [], permissionRequests: [], failure: null,
    cleanup: { contextsClosed: false, browserStopped: false, serverClosed: false },
    limitations: [
      "Synthetic UI rehearsal only: no actual authentication, password update, token, mail, API or server recovery verification.",
      "Chromium viewport emulation is not physical mobile devices or human usability evidence.",
    ],
  };
  let server, browserServer, browserProcess, browser, context, page, phase = "STARTUP";
  try {
    server = await serveStudySnapshot(snapshot);
    browserServer = await chromium.launchServer({
      headless: true, executablePath: options.executable, host: "127.0.0.1", port: 0,
      env: studyChildEnvironment(), timeout: 30_000,
    });
    browserProcess = browserServer.process();
    browser = await chromium.connect(browserServer.wsEndpoint());
    report.browserVersion = browser.version();
    for (const width of [320, 390, 1440]) {
      phase = `${width}:INITIAL_UI`;
      context = await browser.newContext({
        viewport: { width, height: 900 }, locale: "ko-KR", hasTouch: width <= 640,
        isMobile: width <= 640, serviceWorkers: "block", permissions: [],
      });
      await context.exposeBinding("syntheticPermissionRequested", (_source, kind) => {
        report.permissionRequests.push({ width, phase, kind });
      });
      await context.addInitScript(() => {
        const deny = (kind) => {
          void window.syntheticPermissionRequested(kind);
          return Promise.reject(new DOMException("Synthetic check forbids permission requests", "NotAllowedError"));
        };
        if (window.Notification) Notification.requestPermission = () => deny("notification");
        if (navigator.mediaDevices) {
          navigator.mediaDevices.getUserMedia = () => deny("media");
          navigator.mediaDevices.getDisplayMedia = () => deny("display");
        }
        if (navigator.geolocation) for (const name of ["getCurrentPosition", "watchPosition"])
          navigator.geolocation[name] = () => { void window.syntheticPermissionRequested("geolocation"); return 0; };
      });
      page = await context.newPage();
      page.setDefaultTimeout(8_000);
      page.on("pageerror", () => report.errors.push({ width, phase, type: "pageerror" }));
      page.on("console", (message) => {
        if (message.type() === "error") report.errors.push({ width, phase, type: "console" });
      });
      await context.route("**/*", (route) => {
        const request = route.request(), url = new URL(request.url());
        const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const allowed = url.origin === server.origin && !url.search && !url.hash &&
          ["GET", "HEAD"].includes(request.method()) && PUBLIC_ASSET.test(name) && snapshot.read(name);
        if (allowed) return route.continue();
        report.unexpectedRequests.push({ width, phase, method: request.method(), sameOrigin: url.origin === server.origin });
        return route.abort();
      });
      const dialog = page.locator("#account-dialog");
      const button = (name) => dialog.getByRole("button", { name, exact: true });
      const action = (name) => dialog.locator(`[data-onboarding="${name}"]`);
      const heading = (name) => dialog.getByRole("heading", { name, exact: true }).waitFor();
      const password = () => dialog.locator('[name="password"]');
      const confirmation = () => dialog.locator('[name="confirmation"]');
      const loginEntry = page.getByRole("button", { name: "로그인 화면", exact: true });
      const closed = async () => {
        await dialog.waitFor({ state: "hidden" });
        await page.waitForFunction(() => !document.querySelector("#account-dialog input"));
      };
      const geometry = async () => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
        for (const input of await dialog.locator("input, button").all()) {
          if (!await input.isVisible()) continue;
          const bounds = await input.boundingBox();
          assert(bounds && bounds.width > 0 && bounds.x >= -1 && bounds.x + bounds.width <= width + 1);
        }
      };
      const screenshot = async (name) => {
        await geometry();
        await page.screenshot({ path: path.join(folder, `${width}-${name}.png`), fullPage: true,
          mask: [dialog.locator('[name="password"], [name="confirmation"]')] });
      };
      const request = async (email) => {
        await action("recovery").click();
        await heading("비밀번호 찾기");
        assert.equal(await dialog.locator('[name="email"]').inputValue(), "");
        await dialog.locator('[name="email"]').fill(email);
        await button("안내 확인 · 체험").focus();
        await page.keyboard.press("Enter");
        await heading("복구 안내를 확인해 주세요");
        assert.equal(await dialog.locator("input").count(), 0);
        return dialog.innerText();
      };
      const reset = async () => {
        await action("recovery-reset").click();
        await heading("새 비밀번호 설정");
        assert.equal(await password().inputValue(), "");
        assert.equal(await confirmation().inputValue(), "");
        assert.equal(await dialog.locator('[name="understood"]').isChecked(), false);
      };

      await page.goto(server.origin);
      await page.getByRole("heading", { name: "소식에서 다음 만남으로", exact: true }).waitFor();
      // Fresh synthetic sentinel values make unchanged storage meaningful even
      // when a pristine demo home has not yet persisted its default data.
      await page.evaluate(async () => {
        localStorage.setItem("synthetic-recovery-sentinel", "synthetic clinical storage sentinel");
        sessionStorage.setItem("synthetic-recovery-sentinel", "synthetic session sentinel");
        const request = indexedDB.open("synthetic-recovery-sentinel", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("retained", { keyPath: "id" });
        const db = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result); request.onerror = reject;
        });
        try {
          const transaction = db.transaction("retained", "readwrite");
          transaction.objectStore("retained").put({ id: "synthetic-only", note: "retain exactly",
            blob: new Blob(["synthetic retained bytes"], { type: "text/plain" }) });
          await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = transaction.onabort = reject; });
        } finally { db.close(); }
      });
      const before = await stored(page);
      await loginEntry.click();
      await action("recovery").click();
      await heading("비밀번호 찾기");
      await screenshot("request");
      phase = `${width}:REAL_DOMAIN_REFUSED`;
      // Reserved .invalid is synthetic and outside the example-domain
      // rehearsal allowlist. No actual person's address is supplied.
      await dialog.locator('[name="email"]').fill("synthetic-recovery@real-domain.invalid");
      await button("안내 확인 · 체험").click();
      await dialog.locator("#account-error").waitFor({ state: "visible" });
      await heading("비밀번호 찾기");
      assert.equal(await dialog.locator('[name="email"]').inputValue(), "synthetic-recovery@real-domain.invalid");
      await button("취소").click();
      await closed();
      await loginEntry.click();
      assert.equal(await dialog.locator('[name="email"]').inputValue(), "");
      assert.equal(await password().inputValue(), "");

      phase = `${width}:UNIFORM_REQUEST_RESULT`;
      const known = await request("existing.guardian@example.test");
      await action("login").click();
      const unknown = await request("synthetic-unregistered@example.test");
      assert.equal(known, unknown);
      assert(!known.includes("existing.guardian@example.test"));
      assert(!unknown.includes("synthetic-unregistered@example.test"));
      await reset();
      phase = `${width}:SEPARATE_PASSWORD_CONTROLS`;
      await password().fill(PASSWORD);
      await confirmation().fill(CONFIRMATION);
      const passwordId = await password().getAttribute("id"), confirmationId = await confirmation().getAttribute("id");
      assert(passwordId && confirmationId && passwordId !== confirmationId);
      const firstToggle = dialog.locator(`[data-onboarding="password"][data-id="${passwordId}"]`);
      const secondToggle = dialog.locator(`[data-onboarding="password"][data-id="${confirmationId}"]`);
      for (const [toggle, input, peer] of [[firstToggle, password(), confirmation()], [secondToggle, confirmation(), password()]]) {
        assert.equal(await toggle.innerText(), "표시");
        await toggle.click();
        assert.equal(await input.getAttribute("type"), "text");
        assert.equal(await peer.getAttribute("type"), "password");
        assert.equal(await toggle.innerText(), "숨김");
        await toggle.click();
        assert.equal(await input.getAttribute("type"), "password");
      }
      await screenshot("reset");
      phase = `${width}:VALIDATION_RETAINS_INPUTS`;
      await dialog.locator('[name="understood"]').check();
      await button("입력 확인 · 체험").focus();
      await page.keyboard.press("Enter");
      await dialog.locator("#account-error").waitFor({ state: "visible" });
      await heading("새 비밀번호 설정");
      assert.equal(await password().inputValue(), PASSWORD);
      assert.equal(await confirmation().inputValue(), CONFIRMATION);
      assert.equal(await dialog.locator('[name="understood"]').isChecked(), true);
      assert.equal(await dialog.locator("#account-error").evaluate((element) => element === document.activeElement), true);
      await screenshot("error");
      await confirmation().fill(PASSWORD);
      await button("입력 확인 · 체험").focus();
      await page.keyboard.press("Enter");
      await heading("입력 흐름을 확인했어요");
      assert.equal(await dialog.locator("input").count(), 0);
      await screenshot("completed");
      await action("login").click();
      assert.equal(await dialog.locator('[name="email"]').inputValue(), "");
      assert.equal(await password().inputValue(), "");
      assert.deepEqual(await stored(page), before);

      phase = `${width}:EXPIRED_BRANCH_DISCARDS_SECRETS`;
      await request("synthetic-expiry@example.test");
      await reset();
      await password().fill(PASSWORD);
      await confirmation().fill(PASSWORD);
      const unavailable = action("recovery-unavailable");
      if (!await unavailable.isVisible()) await unavailable.locator("xpath=ancestor::details[1]").locator("summary").click();
      await unavailable.click();
      await heading("다시 복구 안내를 요청해 주세요");
      assert.equal(await dialog.locator("input").count(), 0);
      await screenshot("unavailable");
      await action("recovery").click();
      await heading("비밀번호 찾기");
      assert.equal(await dialog.locator('[name="email"]').inputValue(), "");
      await dialog.locator('[name="email"]').fill("synthetic-cancel@example.test");
      await button("취소").click();
      await closed();
      assert.equal(await dialog.locator("input").count(), 0);
      assert.equal(await loginEntry.evaluate((element) => document.activeElement === element), true);

      phase = `${width}:ESCAPE_AND_NAVIGATION_CLEAR_INPUTS`;
      await loginEntry.click();
      await request("synthetic-navigation@example.test");
      await reset();
      await password().fill(PASSWORD);
      await confirmation().fill(PASSWORD);
      const discardedPassword = await password().elementHandle(), discardedConfirmation = await confirmation().elementHandle();
      await dialog.locator('[data-onboarding="password"][data-id="recovery-password"]').click();
      assert.equal(await password().getAttribute("type"), "text");
      await button("취소").click();
      await closed();
      assert.equal(await discardedPassword.evaluate((element) => element.value), "");
      assert.equal(await discardedConfirmation.evaluate((element) => element.value), "");
      await discardedPassword.dispose(); await discardedConfirmation.dispose();
      await loginEntry.click();
      assert.equal(await password().inputValue(), "");
      await password().fill(PASSWORD);
      const discardedLoginPassword = await password().elementHandle();
      await dialog.locator('[data-onboarding="password"][data-id="login-password"]').click();
      await request("synthetic-escape@example.test");
      assert.equal(await discardedLoginPassword.evaluate((element) => element.value), "");
      await discardedLoginPassword.dispose();
      await reset();
      await password().fill(PASSWORD);
      await confirmation().fill(PASSWORD);
      await page.keyboard.press("Escape");
      await closed();
      assert.equal(await dialog.locator("input").count(), 0);
      assert.equal(await loginEntry.evaluate((element) => document.activeElement === element), true);
      assert.deepEqual(await stored(page), before);

      phase = `${width}:RELOAD_STARTS_EMPTY`;
      await loginEntry.click();
      await request("synthetic-reload@example.test");
      await reset();
      await password().fill(PASSWORD);
      await confirmation().fill(PASSWORD);
      await page.reload();
      await page.getByRole("heading", { name: "소식에서 다음 만남으로", exact: true }).waitFor();
      assert.equal(await page.locator('[name="password"], [name="confirmation"]').count(), 0);
      assert.deepEqual(await stored(page), before);
      await loginEntry.click();
      assert.equal(await dialog.locator('[name="email"]').inputValue(), "");
      assert.equal(await password().inputValue(), "");
      await request("synthetic-empty-again@example.test");
      await reset();
      assert.equal(await password().inputValue(), "");
      assert.equal(await confirmation().inputValue(), "");
      await page.keyboard.press("Escape");
      await closed();
      assert.deepEqual(await stored(page), before);
      report.checks.push({ width, uniformKnownUnknown: true, syntheticDomainOnly: true,
        independentPasswordControls: true, validationRetainsInputs: true, successfulRehearsalClearsInputs: true,
        expiryNavigationCancelEscapeReloadClearInputs: true, keyboardAndDialogGeometry: true,
        localSessionIndexedDbIncludingBlobUnchanged: true });
      await bounded(context.close());
      context = null; page = null;
    }
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.unexpectedRequests, []);
    assert.deepEqual(report.permissionRequests, []);
    report.cleanup.contextsClosed = true;
  } catch (error) {
    report.failure = { code: "PASSWORD_RECOVERY_BROWSER_FAILED", phase,
      type: error?.name === "AssertionError" ? "assertion" : "runtime-or-timeout" };
    await page?.screenshot({ path: path.join(folder, "failure.png"), fullPage: true,
      mask: [page.locator('[name="password"], [name="confirmation"]')] }).catch(() => {});
  } finally {
    if (context) try { await bounded(context.close()); context = null; report.cleanup.contextsClosed = true; } catch { /* No false cleanup success. */ }
    if (browser) try { await bounded(browser.close()); } catch { /* Server ownership retained below. */ }
    if (browserServer) {
      try { await bounded(browserServer.close()); }
      catch { try { await bounded(browserServer.kill()); } catch { /* Remains failed. */ } }
      report.cleanup.browserStopped = typeof browserProcess?.exitCode === "number" || typeof browserProcess?.signalCode === "string";
    }
    if (server) try { await bounded(server.close()); report.cleanup.serverClosed = true; } catch { /* Remains failed. */ }
    report.passed = !report.failure && report.checks.length === 3 && Object.values(report.cleanup).every(Boolean);
    await writeFile(path.join(folder, "results.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length,
    cleanup: report.cleanup, failure: report.failure }));
  return report.passed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runPasswordRecoveryBrowser()) process.exitCode = 1; }
  catch { console.error("PASSWORD_RECOVERY_BROWSER_CONFIGURATION_OR_STARTUP_FAILED"); process.exitCode = 1; }
}

// Owned, synthetic, frozen-snapshot browser check. No existing browser, profile,
// application server, credentials, API, or real child data is used.
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
    timer = setTimeout(() => reject(new Error("READ_STATE_CHECK_TIMEOUT")), milliseconds);
  })]).finally(() => clearTimeout(timer));
};

export async function runMessageReadStateBrowser(args = process.argv.slice(2)) {
  const options = messageBrowserOptions(args);
  for (const file of [options.module, options.executable])
    assert((await lstat(file)).isFile(), "Existing local browser runtime required; no installation");
  const { chromium } = await import(pathToFileURL(options.module).href);
  const snapshot = await captureWorkingSnapshot(root);
  const runId = randomUUID(), folder = path.join(root, "test-results", `message-read-state-${runId}`);
  await mkdir(folder);
  const report = {
    runId, at: new Date().toISOString(), passed: false, source: snapshot.manifest,
    checks: [], errors: [], unexpectedRequests: [], failure: null,
    cleanup: { contextsClosed: false, browserStopped: false, serverClosed: false },
    limitations: [
      "Synthetic local demo UI, domain logic and browser storage only; no actual authentication, API or cross-device proof.",
      "The p2 peer is not offered by the demo role selector; its visibility/unread evidence is an explicit read-only domain projection of saved browser data.",
      "Chromium viewport emulation, not physical mobile devices or human usability evidence.",
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
        isMobile: width <= 640, serviceWorkers: "block",
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
      const role = (value) => page.getByLabel("사용자 역할", { exact: true }).selectOption(value);
      const nav = (name) => page.getByRole("navigation", {
        name: width <= 640 ? "모바일 메뉴" : "주요 메뉴", exact: true,
      }).getByRole("button", { name, exact: true }).click();
      const data = () => page.evaluate(() => JSON.parse(localStorage.getItem("child-development-demo-v2")));
      const message = (id) => page.locator(`[data-message-id="${id}"]`);
      const receipt = (id) => message(id).locator(".message-actions > small").innerText();
      const chat = async () => {
        await nav("대화");
        const row = page.locator('.conversation-row[data-id="c1"]');
        if (await row.isVisible()) await row.click();
        await page.waitForFunction(() => document.querySelector("#message-body")?.disabled === false);
      };
      const send = async (body) => {
        await page.getByLabel("소식 내용", { exact: true }).fill(body);
        await page.getByRole("button", { name: "보내기", exact: true }).click();
        await page.waitForFunction((body) => {
          const db = JSON.parse(localStorage.getItem("child-development-demo-v2"));
          return db?.messages.some((m) => m.body === body) &&
            document.querySelector("#message-body")?.value === "" &&
            document.querySelector("#message-body")?.disabled === false;
        }, body);
        return (await data()).messages.at(-1).id;
      };
      const waitRead = (id) => page.waitForFunction((id) => {
        const db = JSON.parse(localStorage.getItem("child-development-demo-v2"));
        const message = db?.messages.find((m) => m.id === id);
        return !!message && db.readStates.some((r) => r.conversationId === message.conversationId &&
          r.userId === "p1" && r.sequence >= message.sequence);
      }, id);

      await page.goto(server.origin);
      await role("therapist");
      await chat();
      phase = `${width}:THERAPIST_SEND`;
      const oldId = await send(`합성 읽음 회귀 이전 소식 ${width}`);
      assert.equal(await receipt(oldId), "아직 읽지 않음");
      phase = `${width}:GUARDIAN_READ`;
      await role("guardian");
      await chat();
      await message(oldId).scrollIntoViewIfNeeded();
      await waitRead(oldId);
      await role("therapist");
      await chat();
      assert.equal(await receipt(oldId), "읽음");

      phase = `${width}:CENTER_CONNECT_FUTURE_ONLY`;
      await role("center");
      await nav("아동");
      await page.getByRole("button", { name: "담당 관계 관리", exact: true }).click();
      assert.equal(await page.locator('[name="guardianIds"][value="p1"]').isChecked(), true);
      assert.equal(await page.locator('[name="history-p2"]').inputValue(), "default");
      assert.equal(await page.locator('[name="pastHistoryConfirmed"]').isChecked(), false);
      await page.locator('[name="guardianIds"][value="p2"]').check();
      await page.locator('[name="historyConfirmed"]').check();
      await page.getByRole("button", { name: "관계 저장", exact: true }).click();
      await page.locator("#dialog").waitFor({ state: "hidden" });
      const connected = await data(), child = connected.children.find((c) => c.id === "c1");
      assert.deepEqual(child.guardianIds, ["p1", "p2"]);
      assert(child.historyAccess.find((entry) => entry.userId === "p2").firstSequence >
        connected.messages.find((m) => m.id === oldId).sequence);
      phase = `${width}:PRIOR_READ_RELOAD`;
      await page.reload();
      await role("therapist");
      await chat();
      assert.equal(await receipt(oldId), "읽음");

      phase = `${width}:LATER_MESSAGE_WAITS_FOR_PEER`;
      const newId = await send(`합성 읽음 회귀 이후 소식 ${width}`);
      assert.equal(await receipt(newId), "아직 읽지 않음");
      await role("guardian");
      await chat();
      await message(newId).scrollIntoViewIfNeeded();
      await waitRead(newId);
      await role("therapist");
      await chat();
      assert.equal(await receipt(newId), "아직 읽지 않음");
      assert.equal(await receipt(oldId), "읽음");
      const peerEvidence = await page.evaluate(async ({ oldId, newId }) => {
        const { conversationView } = await import("/src/conversations.js");
        const { validateState } = await import("/src/domain.js");
        const db = JSON.parse(localStorage.getItem("child-development-demo-v2"));
        const peer = conversationView(db, { id: "p2", role: "guardian" }, "c1");
        return { valid: validateState(db), oldVisible: peer.messages.some((m) => m.id === oldId),
          newVisible: peer.messages.some((m) => m.id === newId), unread: peer.unread };
      }, { oldId, newId });
      assert.deepEqual(peerEvidence, { valid: true, oldVisible: false, newVisible: true, unread: 1 });
      phase = `${width}:FINAL_RELOAD_RENDER`;
      await page.reload();
      await chat();
      assert.equal(await receipt(oldId), "읽음");
      assert.equal(await receipt(newId), "아직 읽지 않음");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.screenshot({ path: path.join(folder, `${width}-read-state.png`), fullPage: true });
      report.checks.push({ width, uiFlow: "send → recipient read → future-only peer connection → reload → older receipt retained → later receipt waits for peer",
        oldReceipt: "읽음", newReceipt: "아직 읽지 않음", peerSavedDataProjection: peerEvidence });
      await bounded(context.close());
      context = null;
      page = null;
    }
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.unexpectedRequests, []);
    report.cleanup.contextsClosed = true;
  } catch (error) {
    report.failure = { code: "MESSAGE_READ_STATE_BROWSER_FAILED", phase,
      type: error?.name === "AssertionError" ? "assertion" : "runtime-or-timeout" };
    await page?.screenshot({ path: path.join(folder, "failure.png"), fullPage: true }).catch(() => {});
  } finally {
    if (context) try { await bounded(context.close()); context = null; report.cleanup.contextsClosed = true; } catch { /* No false cleanup success. */ }
    if (browser) try { await bounded(browser.close()); } catch { /* Server ownership is retained below. */ }
    if (browserServer) {
      try { await bounded(browserServer.close()); }
      catch { try { await bounded(browserServer.kill()); } catch { /* Failure remains in cleanup. */ } }
      report.cleanup.browserStopped = typeof browserProcess?.exitCode === "number" || typeof browserProcess?.signalCode === "string";
    }
    if (server) try { await bounded(server.close()); report.cleanup.serverClosed = true; } catch { /* No false cleanup success. */ }
    report.passed = !report.failure && report.checks.length === 3 && Object.values(report.cleanup).every(Boolean);
    await writeFile(path.join(folder, "results.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  }
  console.log(JSON.stringify({ runId, passed: report.passed, checks: report.checks.length,
    cleanup: report.cleanup, failure: report.failure }));
  return report.passed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!await runMessageReadStateBrowser()) process.exitCode = 1; }
  catch { console.error("MESSAGE_READ_STATE_CONFIGURATION_OR_STARTUP_FAILED"); process.exitCode = 1; }
}

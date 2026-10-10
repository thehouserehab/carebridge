import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.ok(process.env.PLAYWRIGHT_MODULE && process.env.CDP_URL, "Use an owned test browser");
const base = new URL(process.env.APP_URL || "http://127.0.0.1:4176");
assert.ok(["http:", "https:"].includes(base.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "Synthetic loopback tests only");
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser = await chromium.connectOverCDP(process.env.CDP_URL);
const root = fileURLToPath(new URL("../test-results/", import.meta.url));
await mkdir(root, { recursive: true });
const runId = crypto.randomUUID(), checks = [], errors = [], unexpectedRequests = [];
const photo = { name: "가상-충돌-입력.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=", "base64") };
let failure = null;
const data = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("child-development-demo-v2")));
const nav = (page, name) => page.getByRole("navigation", { name: page.viewportSize().width <= 640 ? "모바일 메뉴" : "주요 메뉴", exact: true }).getByRole("button", { name, exact: true });
const close = async (page) => {
  await page.locator("#dialog").getByRole("button", { name: "닫기", exact: true }).click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
};
function observe(page) {
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== base.origin || url.pathname.startsWith("/api/")) unexpectedRequests.push(request.url());
  });
  page.on("dialog", (dialog) => dialog.accept()); // Discard confirmation in synthetic contexts only.
}
async function centerChange(page, therapistId, guardianIds) {
  await page.getByLabel("사용자 역할", { exact: true }).selectOption("center");
  await nav(page, "아동").click();
  await page.locator("#child").selectOption("c1");
  await page.getByRole("button", { name: "담당 관계 관리", exact: true }).click();
  await page.locator('[name="therapistId"]').selectOption(therapistId);
  for (const id of ["p1", "p2", "p3"])
    await page.locator(`[name="guardianIds"][value="${id}"]`).setChecked(guardianIds.includes(id));
  await page.getByLabel(/기존 기록 열람 범위를 확인했어요/).check();
  await page.getByRole("button", { name: "관계 저장", exact: true }).click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
}
async function notification(page) {
  await page.waitForFunction(() => document.querySelector("#toast")?.textContent.includes("다른 탭에서 데이터가 변경"));
}
async function editorSnapshot(page) {
  return page.evaluate(async () => ({
    metadata: window.syntheticEditor.metadata(),
    blobs: await Promise.all(window.syntheticEditor.entries().map(async ([id, blob]) => ({ id, type: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())] }))),
  }));
}
async function screenshot(page, width, kind) {
  await page.bringToFront();
  await page.screenshot({ path: `${root}/dialog-sync-${width}-${kind}.png`, fullPage: true, timeout: 15000 });
}
async function clearAndObserve(page, peer) {
  await page.evaluate(() => {
    window.syntheticClearRendered = false;
    const observer = new MutationObserver(() => { observer.disconnect(); window.syntheticClearRendered = true; });
    observer.observe(document.querySelector("#app"), { childList: true });
  });
  // Only the fresh synthetic context is cleared. Observe its real key=null event.
  await peer.evaluate(() => { localStorage.setItem("synthetic-clear-marker", "owned-fixture"); localStorage.clear(); });
  await page.waitForFunction(() => window.syntheticClearRendered);
  await page.getByRole("heading", { name: "기록을 불러오지 못했어요", exact: true }).waitFor();
  assert.equal(await page.locator("#role, #child, .record-card").count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem("child-development-demo-v2")), null);
}
async function revoke(page, peer, width) {
  await nav(page, "기록").click();
  await page.evaluate(async () => {
    const { AttachmentEditor } = await import("/src/media-ui.js");
    const draw = AttachmentEditor.prototype.draw;
    AttachmentEditor.prototype.draw = function (...args) { window.syntheticEditor = this; return draw.apply(this, args); };
    const { MediaStore } = await import("/src/media-store.js");
    const write = MediaStore.prototype.write;
    window.syntheticWrites = [];
    MediaStore.prototype.write = function (entries) { window.syntheticWrites.push(entries.map(([id]) => id)); return write.call(this, entries); };
  });
  await page.getByRole("button", { name: "기록 작성", exact: true }).click();
  const dialog = page.locator("#dialog");
  await dialog.locator('[name="performed"]').fill("가상 보관 활동");
  await dialog.getByLabel("아이의 반응", { exact: true }).fill("가상 보관 반응");
  await dialog.locator('[name="nextPlan"]').fill("가상 보관 다음 계획");
  await dialog.locator("summary").filter({ hasText: /^사진·동영상$/ }).click();
  await dialog.locator("input[type=file]").setInputFiles(photo);
  await page.waitForFunction(() => document.querySelector("#dialog .attachment-row") && !document.querySelector("#dialog input[type=file]").disabled);
  const originalEditor = await editorSnapshot(page);
  assert.deepEqual(originalEditor.blobs[0].bytes, [...photo.buffer]);
  await centerChange(peer, "t2", ["p2"]);
  await notification(page);
  const latest = await data(peer);
  await dialog.getByRole("button", { name: "초안 저장", exact: true }).click();
  await dialog.locator("#form-error:not([hidden])").filter({ hasText: "다른 탭에서 변경되었어요." }).waitFor();
  assert.equal(await dialog.locator('[name="performed"]').inputValue(), "가상 보관 활동");
  assert.equal(await dialog.getByLabel("아이의 반응", { exact: true }).inputValue(), "가상 보관 반응");
  assert.equal(await dialog.locator('[name="nextPlan"]').inputValue(), "가상 보관 다음 계획");
  assert.deepEqual(await editorSnapshot(page), originalEditor);
  assert.deepEqual(await data(page), latest);
  const pendingNotice = await dialog.locator("[data-workspace-change]").count();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await screenshot(page, width, "conflict-input");
  await close(page);
  // Regression: the original code drops the storage event while a dialog is open.
  await page.waitForFunction(() => document.querySelector("#child")?.value === "c2");
  assert.equal(await page.locator('#child option[value="c1"]').count(), 0);
  assert.equal(pendingNotice, 1, "The conflict warning persists inside the modal");
  assert.deepEqual(await page.evaluate(() => window.syntheticWrites), [], "Stale input must be rejected before writing new files");
  assert.deepEqual(await data(page), latest);
  const persisted = await page.evaluate(async (id) => {
    const { MediaStore } = await import("/src/media-store.js");
    return await new MediaStore().read(id);
  }, originalEditor.metadata[0].id);
  assert.equal(persisted, null);
  await screenshot(page, width, "revoked-after-close");
}
async function recipients(page, peer, width) {
  await nav(page, "기록").click();
  await page.locator('[data-action="preview"][data-id="r1"]').click();
  const dialog = page.locator("#dialog");
  const before = await dialog.locator(".notice").innerText();
  await centerChange(peer, "t1", ["p2"]);
  await notification(page);
  const latest = await data(peer);
  await dialog.getByRole("button", { name: "수정 내용 공유하기", exact: true }).click();
  await dialog.locator("#form-error:not([hidden])").filter({ hasText: "다른 탭에서 변경되었어요." }).waitFor();
  assert.deepEqual(await data(page), latest, "A stale recipient preview must not publish");
  await close(page);
  await page.waitForFunction(() => !document.querySelector("#dialog [data-workspace-change]"));
  await page.waitForFunction(() => document.querySelector("#child")?.value === "c1");
  await page.locator('[data-action="preview"][data-id="r1"]').click();
  const expectedName = await page.evaluate(async () => { const { memberName } = await import("/src/member-profiles.js"); return memberName(JSON.parse(localStorage.getItem("child-development-demo-v2")), "p2"); });
  const after = await dialog.locator(".notice").innerText();
  assert.ok(after.includes(expectedName)); assert.notEqual(after, before);
  assert.equal(await dialog.locator("[data-workspace-change]").count(), 0);
  await screenshot(page, width, "fresh-recipients");
  await dialog.getByRole("button", { name: "수정 내용 공유하기", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal((await data(page)).publications.length, latest.publications.length + 1);
}
async function invalid(page, peer, width, kind) {
  // Persist a valid state through the actual center UI before removing/corrupting it.
  await centerChange(peer, "t1", ["p1"]);
  await page.waitForFunction(() => document.querySelector("#toast")?.textContent.includes("다른 탭의 변경을 반영"));
  await nav(page, "기록").click();
  await page.getByRole("button", { name: "내 표시 이름", exact: true }).click();
  await peer.evaluate((kind) => {
    if (kind === "missing") localStorage.removeItem("child-development-demo-v2");
    else localStorage.setItem("child-development-demo-v2", "synthetic damaged JSON");
  }, kind);
  await notification(page);
  await close(page);
  await page.getByRole("heading", { name: "기록을 불러오지 못했어요", exact: true }).waitFor();
  assert.equal(await page.locator("#child, .record-card, #chat-compose").count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem("child-development-demo-v2")), kind === "missing" ? null : "synthetic damaged JSON");
  await screenshot(page, width, kind);
  await clearAndObserve(page, peer);
}
async function scenario(width, kind) {
  const context = await browser.newContext({ viewport: { width, height: width <= 640 ? 844 : 1000 }, locale: "ko-KR", isMobile: width <= 640, hasTouch: width <= 640 });
  const page = await context.newPage(), peer = await context.newPage();
  observe(page); observe(peer);
  try {
    if (kind === "initial-damaged")
      await context.addInitScript(() => localStorage.setItem("child-development-demo-v2", "synthetic damaged JSON"));
    await page.goto(base.href); await peer.goto(base.href);
    if (kind === "revoke") await revoke(page, peer, width);
    else if (kind === "recipients") await recipients(page, peer, width);
    else if (kind === "initial-damaged") {
      await page.getByRole("heading", { name: "기록을 불러오지 못했어요", exact: true }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem("child-development-demo-v2")), "synthetic damaged JSON");
      await clearAndObserve(page, peer);
      await screenshot(page, width, kind);
    }
    else await invalid(page, peer, width, kind);
    const evidence = kind === "revoke" ? "real center revoke, same input/PNG bytes, zero stale file writes, current child on close"
      : kind === "recipients" ? "stale preview rejected, current recipients confirmed before new publication"
        : "real removal/corruption/clear events stay fail-closed without sample replacement or writes";
    checks.push(`${width}px ${kind}: ${evidence}`);
    console.log("PASS " + checks.at(-1));
  } catch (error) {
    await screenshot(page, width, `failure-${kind}`).catch(() => {});
    throw error;
  } finally { await context.close(); }
}
try {
  for (const width of [1440, 390, 320]) for (const kind of ["revoke", "recipients", "missing", "damaged", "initial-damaged"]) await scenario(width, kind);
  assert.equal(checks.length, 15); assert.deepEqual(errors, []); assert.deepEqual(unexpectedRequests, []);
} catch (error) {
  failure = { name: error.name, message: error.message }; console.error(error); process.exitCode = 1;
} finally {
  await writeFile(`${root}/dialog-sync-results.json`, JSON.stringify({ runId, at: new Date().toISOString(), passed: !failure, checks, errors, unexpectedRequests, failure,
    limitations: ["Synthetic local roles/storage only, not operational authorization or cross-device delivery", "Explicit close confirms discard; no automatic merging or durable record-form autosave", "Chromium emulation, not a physical device or human study"] }, null, 2));
  await browser.close();
}

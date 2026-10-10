import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syntheticMedia } from "./browser-media.mjs";

assert.ok(process.env.PLAYWRIGHT_MODULE && process.env.CDP_URL, "Use an owned test browser");
const base = new URL(process.env.APP_URL || "http://127.0.0.1:4176");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "Synthetic loopback tests only");
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser = await chromium.connectOverCDP(process.env.CDP_URL);
const root = fileURLToPath(new URL("../test-results/", import.meta.url));
await mkdir(root, { recursive: true });
const runId = crypto.randomUUID(), checks = [], errors = [], unexpectedRequests = [];
let fixtureMedia, failure = null;
const widths = [1440, 390, 320];
const body = "가상 전송 경계 시험 소식";
const data = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("child-development-demo-v2")));
const status = (page, phase) => page.waitForFunction((phase) => document.querySelector("#draft-status")?.dataset.state === phase, phase);
async function openChat(page, childId = "c1") {
  const row = page.locator(`.conversation-row[data-id="${childId}"]`);
  if (!(await row.isVisible())) await page.getByRole("button", { name: "‹ 목록", exact: true }).click();
  await row.click();
  await page.waitForFunction(() => document.querySelector("#message-body") && !document.querySelector("#message-body").disabled);
}
async function stored(page, childId = "c1") {
  return page.evaluate(async (childId) => {
    const request = indexedDB.open("carebridge-chat-drafts-v1", 1);
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = reject; });
    const key = `${sessionStorage.getItem("carebridge-draft-tab")}/t1/${childId}`;
    const tx = db.transaction("drafts"), get = tx.objectStore("drafts").get(key);
    const result = await new Promise((resolve, reject) => { tx.oncomplete = () => resolve(get.result); tx.onabort = reject; });
    db.close();
    return result ? { clientId: result.clientId, body: result.body, attachments: result.attachments,
      blobs: await Promise.all(result.entries.map(async ([id, blob]) => ({ id, type: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())] }))) } : null;
  }, childId);
}
async function files(page, ids) {
  return page.evaluate(async (ids) => {
    const { MediaStore } = await import("/src/media-store.js");
    const store = new MediaStore();
    return Promise.all(ids.map(async (id) => {
      const blob = await store.read(id);
      return blob ? { id, type: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())] } : null;
    }));
  }, ids);
}
async function peerChange(peer, kind = "notice") {
  await peer.evaluate(async (kind) => {
    const { load, persist } = await import("/src/repository.js");
    const { mutate } = await import("/src/domain.js");
    const db = load(localStorage).db;
    const child = db.children.find((child) => child.id === "c1");
    const next = kind === "notice"
      ? mutate(db, { id: "p1", role: "guardian" }, "message", { childId: "c1", clientId: crypto.randomUUID(), body: "가상 다른 탭 소식", attachments: [] })
      : mutate(db, { id: "m1", role: "center" }, "relationships", { childId: "c1", therapistId: kind === "revoke" ? "t2" : "t1", guardianIds: child.guardianIds, historyConfirmed: true });
    persist(localStorage, next, db.revision);
  }, kind);
}
async function holdSend(page, reject = false) {
  await page.evaluate(async (reject) => {
    const { MediaStore } = await import("/src/media-store.js");
    const { ChatController } = await import("/src/chat-controller.js");
    const original = MediaStore.prototype.write;
    const originalSend = ChatController.prototype.send;
    window.sendGate = { entered: false, used: false };
    ChatController.prototype.send = function (...args) {
      window.sendSettled = false;
      const completion = originalSend.apply(this, args);
      completion.then(() => { window.sendSettled = true; }, () => { window.sendSettled = true; });
      return completion;
    };
    MediaStore.prototype.write = async function (entries) {
      if (entries.length && !window.sendGate.used) {
        window.sendGate.used = true;
        window.sendGate.entered = true;
        await new Promise((resolve) => { window.sendGate.release = resolve; });
        if (reject) throw new Error("가상 파일 전송 실패. 입력과 첨부를 유지했어요.");
      }
      return original.call(this, entries);
    };
    window.originalComposer = document.querySelector("#chat-compose");
  }, reject);
  await page.getByRole("button", { name: "보내기", exact: true }).click();
  await page.waitForFunction(() => window.sendGate.entered && !!window.sendGate.release);
  await status(page, "saved");
}
async function release(page) {
  await page.evaluate(() => window.sendGate.release());
}
async function assertSent(page, original) {
  await page.waitForFunction((id) => JSON.parse(localStorage.getItem("child-development-demo-v2"))?.messages.some((m) => m.id === id), original.clientId);
  await page.waitForFunction(() => document.querySelector("#message-body")?.value === "" && !document.querySelector("#message-body").disabled);
  const messages = (await data(page)).messages.filter((m) => m.id === original.clientId);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].childId, "c1"); assert.equal(messages[0].authorId, "t1");
  assert.equal(messages[0].body, original.body); assert.deepEqual(messages[0].attachments, original.attachments);
  assert.deepEqual(await files(page, original.attachments.map((a) => a.id)), original.blobs);
  assert.equal(await page.locator("#chat-error").isHidden(), true);
}
async function attach(page) {
  // Canvas capture must run on the active synthetic tab, not the peer tab's
  // background page (which Chromium may stop producing frames for).
  await page.bringToFront();
  fixtureMedia ||= await syntheticMedia(page);
  await page.getByLabel("소식 내용", { exact: true }).fill(body);
  await page.getByRole("button", { name: "＋ 사진·동영상", exact: true }).click();
  await page.locator("#chat-attachment-editor input[type=file]").setInputFiles([
    { name: "가상-지연.png", mimeType: "image/png", buffer: Buffer.from(fixtureMedia.png) },
    { name: "가상-지연.webm", mimeType: "video/webm", buffer: Buffer.from(fixtureMedia.video) },
  ]);
  await page.waitForFunction(() => document.querySelectorAll("#chat-attachment-editor .attachment-row").length === 2 && !document.querySelector("#chat-attachment-editor input[type=file]").disabled);
  await status(page, "saved");
  return stored(page);
}
async function readableError(page, selector) {
  const error = page.locator(selector);
  await error.scrollIntoViewIfNeeded();
  const bounds = await error.boundingBox(), composer = await page.locator("#chat-compose").boundingBox();
  assert.ok(bounds && composer && bounds.y >= composer.y - 1 && bounds.y + bounds.height <= composer.y + composer.height + 1,
    "The full error must be reachable by scrolling the composer, not clipped permanently");
}
async function scenario(width, kind) {
  const context = await browser.newContext({ viewport: { width, height: width <= 640 ? 844 : 1000 }, isMobile: width <= 640, hasTouch: width <= 640, locale: "ko-KR" });
  const page = await context.newPage(), peer = await context.newPage();
  for (const tab of [page, peer]) {
    tab.setDefaultTimeout(8000);
    tab.on("pageerror", (error) => errors.push(error.message));
    tab.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    tab.on("request", (request) => { const url = new URL(request.url());
      if (url.origin !== base.origin || url.pathname.startsWith("/api/")) unexpectedRequests.push(request.url()); });
    tab.on("dialog", (dialog) => dialog.accept()); // Synthetic context only.
  }
  try {
    await page.goto(base.href); await peer.goto(base.href);
    if (kind === "revoke") {
      await openChat(page, "c2"); await page.getByLabel("소식 내용", { exact: true }).fill("가상 다른 아이의 미전송 초안"); await status(page, "saved");
    }
    await openChat(page);
    const original = await attach(page);
    assert.equal(original.blobs.length, 2);
    const other = kind === "revoke" ? await stored(page, "c2") : null;
    await holdSend(page, kind === "failure");
    await peerChange(peer, kind === "revoke" ? "revoke" : "notice");
    await page.waitForFunction(() => document.querySelector("#chat-compose") !== window.originalComposer && !!document.querySelector("#chat-attachment-editor .attachment-editor"));
    if (kind === "revoke") {
      await page.getByRole("region", { name: "나무 대화", exact: true }).waitFor();
      assert.equal(await page.getByLabel("소식 내용", { exact: true }).inputValue(), other.body);
      await page.getByLabel("소식 내용", { exact: true }).fill("가상 다른 방에서 계속 작성"); await status(page, "saved");
      await release(page);
      await page.waitForFunction(() => window.sendSettled === true);
      await page.waitForFunction((ids) => {
        const db = JSON.parse(localStorage.getItem("child-development-demo-v2"));
        return !db.messages.some((m) => m.id === ids.original) && !document.querySelector("#chat-compose").hasAttribute("aria-busy");
      }, { original: original.clientId });
      // Wait for the real rollback (not merely the other form's initial state).
      await page.waitForFunction(async (ids) => {
        const { MediaStore } = await import("/src/media-store.js");
        const store = new MediaStore(); return (await Promise.all(ids.map((id) => store.read(id)))).every((blob) => blob === null);
      }, original.attachments.map((a) => a.id));
      assert.equal(await page.getByLabel("소식 내용", { exact: true }).inputValue(), "가상 다른 방에서 계속 작성");
      assert.equal(await page.locator("#chat-error").isHidden(), true);
      assert.deepEqual(await stored(page), original);
      assert.equal((await stored(page, "c2")).clientId, other.clientId);
      // The c1 rows reappear only after an explicit, domain-authorized restore.
      await peerChange(peer, "restore");
      await page.locator('.conversation-row[data-id="c1"]').waitFor({ state: width <= 640 ? "attached" : "visible" });
      await openChat(page); await page.locator("#chat-error:not([hidden])").waitFor();
      assert.equal(await page.getByLabel("소식 내용", { exact: true }).inputValue(), original.body);
      await page.getByRole("button", { name: "보내기", exact: true }).click(); await assertSent(page, original);
    } else {
      assert.equal(await page.getByLabel("소식 내용", { exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "보내기", exact: true }).isDisabled(), true);
      assert.equal(await page.getByLabel("소식 내용", { exact: true }).inputValue(), original.body);
      if (kind === "cleanup-failure") await page.evaluate(() => {
        const transaction = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (name, mode, ...rest) {
          if (this.name === "carebridge-chat-drafts-v1" && mode === "readwrite") throw new Error("PRIVATE synthetic draft cleanup error");
          return transaction.call(this, name, mode, ...rest);
        };
      });
      await release(page);
      if (kind === "failure") {
        await page.locator("#chat-error:not([hidden])").waitFor();
        await readableError(page, "#chat-error");
        assert.equal(await page.getByLabel("소식 내용", { exact: true }).isDisabled(), false);
        assert.deepEqual(await stored(page), original);
        await page.evaluate(() => { window.failedComposer = document.querySelector("#chat-compose"); });
        await peerChange(peer);
        await page.waitForFunction(() => document.querySelector("#chat-compose") !== window.failedComposer && !document.querySelector("#message-body")?.disabled);
        await page.locator("#chat-error:not([hidden])").waitFor();
        assert.deepEqual(await stored(page), original);
        await page.getByRole("button", { name: "보내기", exact: true }).focus(); await page.keyboard.press("Enter");
      }
      await assertSent(page, original);
      if (kind === "cleanup-failure") {
        await status(page, "failed");
        await readableError(page, "#draft-error");
        assert.equal((await page.locator("#chat-compose").innerText()).includes("PRIVATE"), false);
        assert.equal((await stored(page)).clientId, original.clientId);
      } else {
        await status(page, "saved");
        assert.equal((await stored(page)).body, "");
        assert.notEqual((await stored(page)).clientId, original.clientId);
      }
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.screenshot({ path: `${root}/chat-send-${width}-${kind}.png`, fullPage: true });
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#message-body") && !document.querySelector("#message-body").disabled);
    await status(page, "saved");
    assert.equal(await page.getByLabel("소식 내용", { exact: true }).inputValue(), "");
    assert.equal((await stored(page)).body, "");
    assert.notEqual((await stored(page)).clientId, original.clientId);
    assert.equal((await data(page)).messages.filter((m) => m.id === original.clientId).length, 1);
    assert.deepEqual(await files(page, original.attachments.map((a) => a.id)), original.blobs);
    const label = `${width}px ${kind}: real storage event, send identity, PNG/video bytes, reload`;
    checks.push(label); console.log("PASS " + label);
  } catch (error) {
    await page.screenshot({ path: `${root}/chat-send-failure-${width}-${kind}.png`, fullPage: true }).catch(() => {});
    throw error;
  } finally { await context.close(); }
}
try {
  for (const width of widths) for (const kind of ["success", "failure", "revoke", "cleanup-failure"]) await scenario(width, kind);
  assert.equal(checks.length, 12); assert.deepEqual(errors, []); assert.deepEqual(unexpectedRequests, []);
} catch (error) {
  failure = { name: error.name, message: error.message }; console.error(error); process.exitCode = 1;
} finally {
  await writeFile(`${root}/chat-send-lifecycle-results.json`, JSON.stringify({ runId, at: new Date().toISOString(), passed: !failure,
    checks, errors, unexpectedRequests, failure, limitations: ["Synthetic local roles and browser storage only; no API/cross-device proof", "Chromium emulation, not physical devices or a human study"] }, null, 2));
  await browser.close();
}

import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser = await chromium.connectOverCDP(process.env.CDP_URL);
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "ko-KR" });
const page = await context.newPage();
const base = process.env.APP_URL || "http://127.0.0.1:4173";
const root = fileURLToPath(new URL("../test-results/", import.meta.url));
await mkdir(root, { recursive: true });
const checks = [], errors = [], requests = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("request", (request) => requests.push(request.url()));
page.on("dialog", (dialog) => dialog.accept()); // Only this synthetic context.
const check = (label) => { checks.push(label); console.log("PASS " + label); };
const status = (phase) => page.waitForFunction((phase) => document.querySelector("#draft-status")?.dataset.state === phase, phase);
const open = async (child = "c1") => {
  await page.locator(`.conversation-row[data-id="${child}"]`).click();
  await page.waitForFunction(() => document.querySelector("#message-body") && !document.querySelector("#message-body").disabled);
};
const stored = () => page.evaluate(async () => {
  const request = indexedDB.open("carebridge-chat-drafts-v1", 1);
  const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(); });
  const key = `${sessionStorage.getItem("carebridge-draft-tab")}/t1/c1`;
  const tx = db.transaction("drafts"), read = tx.objectStore("drafts").get(key);
  const result = await new Promise((resolve, reject) => { tx.oncomplete = () => resolve(read.result); tx.onabort = () => reject(); }); db.close();
  return result ? { clientId: result.clientId, body: result.body, replyTo: result.replyTo, attachments: result.attachments,
    blobs: await Promise.all(result.entries.map(async ([id, blob]) => ({ id, type: blob.type, size: blob.size, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) }))) } : null;
});
const json = () => page.evaluate(() => JSON.parse(localStorage.getItem("child-development-demo-v2")));
let failure = null;
try {
  await page.goto(base); await open(); await status("empty");
  assert.equal(await stored(), null);
  assert.equal(await page.locator("#draft-status").innerText(), "아직 작성한 소식이 없어요");
  const photo = { name: "가상-초안.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=", "base64") };
  await page.getByLabel("소식 내용", { exact: true }).fill("가상 저장 상태 시험");
  await page.getByRole("button", { name: "＋ 사진·동영상", exact: true }).click();
  await page.locator("#chat-attachment-editor input[type=file]").setInputFiles(photo);
  await page.waitForFunction(() => document.querySelector("#chat-attachment-editor .attachment-row") && !document.querySelector("#chat-attachment-editor input[type=file]").disabled);
  await status("saved"); const original = await stored();
  assert.equal(original.body, "가상 저장 상태 시험"); assert.equal(original.blobs.length, 1);
  await page.reload(); await status("saved");
  assert.equal(await page.getByLabel("소식 내용", { exact: true }).inputValue(), original.body);
  assert.deepEqual(await stored(), original);
  check("실제 IndexedDB 커밋·사진 바이트/발신 ID·새로고침 복원과 미작성/저장 완료 구분");

  await page.evaluate(() => {
    window.draftOriginalTransaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (name, mode, ...rest) {
      if (this.name === "carebridge-chat-drafts-v1" && mode === "readwrite") throw new Error("PRIVATE-DRAFT internal path");
      return window.draftOriginalTransaction.call(this, name, mode, ...rest);
    };
  });
  await page.getByLabel("소식 내용", { exact: true }).fill("가상 저장 실패 후 유지"); await status("failed");
  await page.locator("#draft-error:not([hidden])").waitFor();
  assert.equal((await page.locator("#chat-compose").innerText()).includes("PRIVATE-DRAFT"), false);
  assert.equal(await page.getByLabel("소식 내용", { exact: true }).inputValue(), "가상 저장 실패 후 유지");
  assert.deepEqual(await stored(), original);
  assert.equal(await page.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
  await open("c2");
  await page.getByLabel("소식 내용", { exact: true }).fill("가상 다른 방"); await status("failed");
  await open("c1"); await status("failed");
  assert.equal(await page.getByLabel("소식 내용", { exact: true }).inputValue(), "가상 저장 실패 후 유지");
  assert.equal(await page.locator("#chat-attachment-editor .attachment-row").count(), 1);
  check("저장소 오류 원문 비노출·종료 경고·실패 입력/사진 보존·다른 방 혼입 없음");

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 720 });
    await page.locator("#draft-status").waitFor({ state: "visible" });
    await page.getByRole("button", { name: "초안 다시 저장", exact: true }).click({ trial: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    await page.screenshot({ path: `${root}/chat-drafts-failed-${width}.png` });
  }
  await page.evaluate(() => { IDBDatabase.prototype.transaction = window.draftOriginalTransaction; });
  await page.getByRole("button", { name: "초안 다시 저장", exact: true }).focus(); await page.keyboard.press("Enter"); await status("saved");
  assert.equal(await page.locator("#draft-error").isHidden(), true);
  assert.equal(await page.getByLabel("소식 내용", { exact: true }).evaluate((el) => el === document.activeElement), true);
  const retried = await stored(); assert.equal(retried.clientId, original.clientId); assert.equal(retried.body, "가상 저장 실패 후 유지"); assert.deepEqual(retried.blobs, original.blobs);
  assert.equal((await json()).messages.some((message) => message.body === retried.body), false);
  check("320/390px 상태·재시도 접근 및 Enter로 초안만 재저장·사진/ID 보존·오류 해제");

  await page.getByRole("button", { name: "보내기", exact: true }).click();
  await page.waitForFunction((id) => JSON.parse(localStorage.getItem("child-development-demo-v2")).messages.some((m) => m.id === id), original.clientId);
  await page.waitForFunction(() => document.querySelector("#message-body")?.value === "");
  await page.reload(); await page.waitForFunction(() => document.querySelector("#message-body") && !document.querySelector("#message-body").disabled);
  const sent = (await json()).messages.filter((m) => m.id === original.clientId);
  assert.equal(sent.length, 1); assert.equal(sent[0].childId, "c1"); assert.deepEqual(sent[0].attachments, retried.attachments);
  assert.equal(await page.getByLabel("소식 내용", { exact: true }).inputValue(), "");
  check("초안 재저장 이후 명시적 보내기는 기존 ID로 1회만 발신·재접속 중복 없음");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel("소식 내용", { exact: true }).fill("가상 손상 원문 보호"); await status("saved");
  await page.evaluate(async () => {
    const r = indexedDB.open("carebridge-chat-drafts-v1"); const db = await new Promise((resolve) => { r.onsuccess = () => resolve(r.result); });
    const key = `${sessionStorage.getItem("carebridge-draft-tab")}/t1/c1`;
    const tx = db.transaction("drafts", "readwrite"), store = tx.objectStore("drafts"), get = store.get(key);
    get.onsuccess = () => { store.put({ ...get.result, attachments: [{ id: "file-bad", name: "가상.png", type: "image/png", size: 1, share: true }], entries: [null] }, key); };
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = reject; }); db.close();
  });
  await page.reload(); await status("unavailable");
  assert.equal(await page.getByLabel("소식 내용", { exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "보내기", exact: true }).isDisabled(), true);
  const damaged = await page.evaluate(async () => {
    const r = indexedDB.open("carebridge-chat-drafts-v1"), db = await new Promise((resolve) => { r.onsuccess = () => resolve(r.result); });
    const key = `${sessionStorage.getItem("carebridge-draft-tab")}/t1/c1`, tx = db.transaction("drafts"), get = tx.objectStore("drafts").get(key);
    const value = await new Promise((resolve) => { tx.oncomplete = () => resolve(get.result); }); db.close(); return value;
  });
  assert.equal(damaged.body, "가상 손상 원문 보호"); assert.deepEqual(damaged.entries, [null]);
  await page.getByRole("button", { name: "초안 다시 불러오기", exact: true }).click(); await status("unavailable");
  assert.equal(await page.getByLabel("소식 내용", { exact: true }).isDisabled(), true);
  check("손상된 첨부 튜플은 안전한 안내·쓰기 차단·재불러오기에도 기존 원문 보존");
  const unavailableContext = await browser.newContext({ viewport: { width: 390, height: 720 }, locale: "ko-KR" });
  try {
    await unavailableContext.addInitScript(() => {
      const native = window.indexedDB;
      window.syntheticStorageDenied = true;
      Object.defineProperty(window, "indexedDB", { configurable: true, get() {
        if (window.syntheticStorageDenied) throw new Error("PRIVATE permission detail");
        return native;
      } });
    });
    const blocked = await unavailableContext.newPage();
    blocked.on("pageerror", (error) => errors.push(error.message));
    blocked.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    blocked.on("request", (request) => requests.push(request.url()));
    await blocked.goto(base);
    await blocked.getByRole("heading", { name: "소식에서 다음 만남으로", exact: true }).waitFor();
    await blocked.locator('.conversation-row[data-id="c1"]').click();
    await blocked.waitForFunction(() => document.querySelector("#draft-status")?.dataset.state === "unavailable");
    assert.equal((await blocked.locator("#chat-compose").innerText()).includes("PRIVATE"), false);
    assert.equal(await blocked.getByLabel("소식 내용", { exact: true }).isDisabled(), true);
    await blocked.evaluate(() => { window.syntheticStorageDenied = false; });
    await blocked.getByRole("button", { name: "초안 다시 불러오기", exact: true }).click();
    await blocked.waitForFunction(() => document.querySelector("#draft-status")?.dataset.state === "empty" && !document.querySelector("#message-body").disabled);
    assert.equal(await blocked.locator("#draft-error").isHidden(), true);
    check("IndexedDB 접근 거부도 홈을 중단하지 않으며 복구 후 원문 비노출·재불러오기 성공");
  } finally { await unavailableContext.close(); }
  const partial = await page.evaluate(async () => {
    const { MediaStore } = await import("/src/media-store.js");
    const store = new MediaStore(), blob = new Blob(["synthetic"], { type: "image/png" });
    const ids = ["synthetic-partial-one", "synthetic-partial-two"], original = IDBObjectStore.prototype.add;
    let calls = 0, message = "";
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === "files" && ++calls === 2) throw new Error("PRIVATE-partial-detail");
      return original.apply(this, args);
    };
    try { await store.write(ids.map((id) => [id, blob])); }
    catch (error) { message = error.message; }
    finally { IDBObjectStore.prototype.add = original; }
    return { calls, message, missing: await Promise.all(ids.map(async (id) => (await store.read(id)) === null)) };
  });
  assert.equal(partial.calls, 2); assert.equal(partial.message.includes("PRIVATE"), false);
  assert.match(partial.message, /첨부파일을 저장하지/); assert.deepEqual(partial.missing, [true, true]);
  check("실제 IndexedDB 부분 파일 추가 오류는 전체 취소·임시 원본 미잔존·공개 오류만 반환");
  const tabContext = await browser.newContext({ viewport: { width: 390, height: 720 }, locale: "ko-KR" });
  try {
    await tabContext.addInitScript(() => {
      Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw new Error("PRIVATE-tab-permission"); } });
    });
    const tab = await tabContext.newPage();
    tab.on("pageerror", (error) => errors.push(error.message));
    tab.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    tab.on("request", (request) => requests.push(request.url()));
    tab.on("dialog", (dialog) => dialog.accept());
    await tab.goto(base); await tab.locator('.conversation-row[data-id="c1"]').click();
    await tab.waitForFunction(() => document.querySelector("#message-body") && !document.querySelector("#message-body").disabled);
    await tab.getByLabel("소식 내용", { exact: true }).fill("가상 탭 복원 제한");
    await tab.waitForFunction(() => document.querySelector("#draft-status")?.textContent === "새로고침하면 복원이 어려워요");
    await tab.locator("#draft-error:not([hidden])").waitFor();
    assert.equal((await tab.locator("#chat-compose").innerText()).includes("PRIVATE"), false);
    assert.equal(await tab.evaluate(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
    assert.equal(await tab.getByLabel("소식 내용", { exact: true }).inputValue(), "가상 탭 복원 제한");
    check("탭 저장소 제한은 복원 한계 안내·미전송 입력 보존·저장 완료 후에도 종료 경고 유지");
  } finally { await tabContext.close(); }
  assert.deepEqual(errors, []);
  assert.equal(requests.some((url) => new URL(url).pathname.startsWith("/api/")), false);
  assert.equal(requests.some((url) => new URL(url).origin !== new URL(base).origin), false);
} catch (error) {
  failure = error.message; await page.screenshot({ path: `${root}/chat-drafts-failure.png` }).catch(() => {}); throw error;
} finally {
  await writeFile(`${root}/chat-drafts-browser.json`, JSON.stringify({ checks, errors, failure }, null, 2));
  await context.close(); await browser.close();
}

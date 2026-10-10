import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

assert.ok(process.env.PLAYWRIGHT_MODULE && process.env.CDP_URL, "Use an owned test browser");
const base = new URL(process.env.APP_URL || "http://127.0.0.1:4176");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "Synthetic loopback tests only");
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser = await chromium.connectOverCDP(process.env.CDP_URL);
const root = fileURLToPath(new URL("../test-results/", import.meta.url));
await mkdir(root, { recursive: true });
const runId = crypto.randomUUID(), checks = [], errors = [], unexpectedRequests = [];
let failure = null;
const photo = { name: "가상-연결-초안.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=", "base64") };
const data = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("child-development-demo-v2")));
const role = (page, role) => page.getByLabel("사용자 역할", { exact: true }).selectOption(role);
const nav = (page, name) => page.getByRole("navigation", { name: page.viewportSize().width <= 640 ? "모바일 메뉴" : "주요 메뉴", exact: true }).getByRole("button", { name, exact: true });
const status = (page, phase) => page.waitForFunction((phase) => document.querySelector("#draft-status")?.dataset.state === phase, phase);
function observe(page) {
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("request", (request) => { const url = new URL(request.url());
    if (url.origin !== base.origin || url.pathname.startsWith("/api/")) unexpectedRequests.push(request.url()); });
  page.on("dialog", (dialog) => dialog.accept()); // Synthetic contexts only.
}
async function stored(page) {
  return page.evaluate(async () => {
    const r = indexedDB.open("carebridge-chat-drafts-v1", 1);
    const db = await new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = reject; });
    const key = `${sessionStorage.getItem("carebridge-draft-tab")}/t1/c1`;
    const tx = db.transaction("drafts"), get = tx.objectStore("drafts").get(key);
    const value = await new Promise((resolve, reject) => { tx.oncomplete = () => resolve(get.result); tx.onabort = reject; });
    db.close();
    return value ? { clientId: value.clientId, body: value.body, attachments: value.attachments,
      blobs: await Promise.all(value.entries.map(async ([id, blob]) => ({ id, type: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())] }))) } : null;
  });
}
async function centerChange(page, childId, therapistId, guardianIds) {
  await page.locator("#child").selectOption(childId);
  await page.getByRole("button", { name: "담당 관계 관리", exact: true }).click();
  await page.locator('[name="therapistId"]').selectOption(therapistId);
  for (const id of ["p1", "p2", "p3"]) await page.locator(`[name="guardianIds"][value="${id}"]`).setChecked(guardianIds.includes(id));
  await page.getByLabel(/기존 기록 열람 범위를 확인했어요/).check();
  await page.getByRole("button", { name: "관계 저장", exact: true }).click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
}
async function empty(page, currentRole) {
  // Fail promptly on the original fatal state instead of waiting past it.
  await page.waitForFunction(() => document.querySelector(".fatal, [data-empty-assignment]"));
  assert.equal(await page.locator(".fatal").count(), 0, "A valid zero-assignment state is not corrupt data");
  await page.getByRole("heading", { name: "연결된 아이가 아직 없어요", exact: true }).waitFor();
  assert.equal(await page.getByLabel("사용자 역할", { exact: true }).inputValue(), currentRole);
  assert.equal(await page.locator("#child, #chat-compose, .record-card, .conversation-row, .child-row").count(), 0);
  assert.equal(await page.locator('[data-action="record"], [data-action="start-chat"], [data-action="open-chat"], [data-action="session-record"]').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
}
async function scenario(width) {
  const context = await browser.newContext({ viewport: { width, height: width <= 640 ? 844 : 1000 }, isMobile: width <= 640, hasTouch: width <= 640, locale: "ko-KR" });
  const page = await context.newPage(), center = await context.newPage();
  observe(page); observe(center);
  try {
    await page.goto(base.href); await center.goto(base.href);
    await page.locator('.conversation-row[data-id="c1"]').click();
    await page.waitForFunction(() => document.querySelector("#message-body") && !document.querySelector("#message-body").disabled);
    await page.getByLabel("소식 내용", { exact: true }).fill("가상 담당 연결 이전의 미전송 소식");
    await page.getByRole("button", { name: "＋ 사진·동영상", exact: true }).click();
    await page.locator("#chat-attachment-editor input[type=file]").setInputFiles(photo);
    await page.waitForFunction(() => document.querySelector("#chat-attachment-editor .attachment-row") && !document.querySelector("#chat-attachment-editor input[type=file]").disabled);
    await status(page, "saved"); const draft = await stored(page);
    await role(center, "center"); await nav(center, "아동").click();
    const original = await data(center);
    assert.ok(original);
    for (const child of original.children.filter((child) => child.therapistId === "t1" || child.guardianIds.includes("p1")))
      await centerChange(center, child.id, "t2", child.guardianIds.filter((id) => id !== "p1"));
    const revoked = await data(center);
    assert.equal(revoked.children.some((child) => child.therapistId === "t1" || child.guardianIds.includes("p1")), false);
    for (const key of ["records", "publications", "messages", "feedback", "goals", "appointments"])
      assert.deepEqual(revoked[key], original[key]);
    await empty(page, "therapist");
    assert.deepEqual(await stored(page), draft);
    for (const currentRole of ["therapist", "guardian"]) {
      await role(page, currentRole);
      for (const name of ["홈", "대화", "기록", "아이 정보"]) {
        await nav(page, name).focus(); await page.keyboard.press("Enter"); await empty(page, currentRole);
        assert.equal(await nav(page, name).getAttribute("aria-current"), "page");
        const contents = await page.locator("#app").innerText();
        assert.equal(contents.includes(original.records[0].title), false);
        assert.equal(contents.includes(original.records[0].privateNote), false);
      }
      await page.bringToFront();
      await page.screenshot({ path: `${root}/empty-assignment-${width}-${currentRole}.png`, fullPage: true, timeout: 15000 });
      await page.reload(); await empty(page, currentRole);
      const unchanged = await data(page);
      for (const key of ["records", "publications", "messages", "feedback", "goals", "appointments"])
        assert.deepEqual(unchanged[key], original[key]);
      await page.getByRole("button", { name: "로그인 화면", exact: true }).click();
      await page.locator("#account-dialog[open]").waitFor();
      await page.getByRole("button", { name: "계정 화면 닫기", exact: true }).click();
      await page.getByRole("button", { name: "내 표시 이름", exact: true }).click();
      await page.getByRole("heading", { name: "내 표시 이름", exact: true }).waitFor();
      await page.getByRole("button", { name: "취소", exact: true }).click();
      await empty(page, currentRole);
    }
    await role(page, "therapist"); await nav(page, "대화").click();
    for (const child of original.children.filter((child) => child.therapistId === "t1" || child.guardianIds.includes("p1")))
      await centerChange(center, child.id, child.therapistId, child.guardianIds);
    await page.locator('.conversation-row[data-id="c1"]').waitFor({ state: "attached" });
    const c1 = page.locator('.conversation-row[data-id="c1"]');
    if (!(await c1.isVisible())) await page.getByRole("button", { name: "‹ 목록", exact: true }).click();
    await c1.click(); await status(page, "saved");
    assert.equal(await page.getByLabel("소식 내용", { exact: true }).inputValue(), draft.body);
    assert.deepEqual(await stored(page), draft);
    assert.equal(await page.locator("#chat-attachment-editor .attachment-row").count(), 1);
    await page.getByRole("button", { name: "보내기", exact: true }).click();
    await page.waitForFunction((id) => JSON.parse(localStorage.getItem("child-development-demo-v2")).messages.some((m) => m.id === id), draft.clientId);
    const sent = (await data(page)).messages.filter((message) => message.id === draft.clientId);
    assert.equal(sent.length, 1); assert.equal(sent[0].childId, "c1"); assert.equal(sent[0].authorId, "t1");
    const bytes = await page.evaluate(async (id) => { const { MediaStore } = await import("/src/media-store.js");
      return [...new Uint8Array(await (await new MediaStore().read(id)).arrayBuffer())]; }, draft.attachments[0].id);
    assert.deepEqual(bytes, draft.blobs[0].bytes);
    checks.push(`${width}px: actual center changes, both roles/four keyboard menus, reload, account entry, clinical preservation, same-ID/photo restoration`);
    console.log("PASS " + checks.at(-1));
  } catch (error) {
    await page.bringToFront().catch(() => {});
    await page.screenshot({ path: `${root}/empty-assignment-failure-${width}.png`, fullPage: true, timeout: 15000 }).catch(() => {});
    throw error;
  } finally { await context.close(); }
}
async function damaged(width) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: "ko-KR" });
  try {
    await context.addInitScript(() => localStorage.setItem("child-development-demo-v2", "synthetic damaged JSON"));
    const page = await context.newPage(); observe(page); await page.goto(base.href);
    await page.getByRole("heading", { name: "기록을 불러오지 못했어요", exact: true }).waitFor();
    assert.equal(await page.locator("[data-empty-assignment]").count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem("child-development-demo-v2")), "synthetic damaged JSON");
    checks.push(`${width}px: damaged data still fails closed and is not overwritten`); console.log("PASS " + checks.at(-1));
  } finally { await context.close(); }
}
try {
  for (const width of [1440, 390, 320]) { await scenario(width); await damaged(width); }
  assert.equal(checks.length, 6); assert.deepEqual(errors, []); assert.deepEqual(unexpectedRequests, []);
} catch (error) {
  failure = { name: error.name, message: error.message }; console.error(error); process.exitCode = 1;
} finally {
  await writeFile(`${root}/empty-assignment-results.json`, JSON.stringify({ runId, at: new Date().toISOString(), passed: !failure,
    checks, errors, unexpectedRequests, failure, limitations: ["Synthetic local roles/browser storage only, not real authentication or cross-device delivery", "Chromium emulation, not physical devices or a human study"] }, null, 2));
  await browser.close();
}

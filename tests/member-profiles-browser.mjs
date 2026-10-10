import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser = await chromium.connectOverCDP(process.env.CDP_URL);
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: "ko-KR" });
const page = await context.newPage();
page.setDefaultTimeout(7000);
const base = process.env.APP_URL || "http://127.0.0.1:4173";
const root = fileURLToPath(new URL("../test-results/", import.meta.url));
await mkdir(root, { recursive: true });
const errors = [], requests = [], checks = [], automationWarnings = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("request", (request) => requests.push(request.url()));
// Native dialogs can disappear before the asynchronous reply is delivered.
// Record that condition; do not infer its cause. Every close,
// reload and stored-state assertion below must still prove the intended result.
page.on("dialog", (dialog) => dialog.accept().catch((error) => {
  if (error.message.includes("Page.handleJavaScriptDialog): No dialog is showing"))
    automationWarnings.push({ type: dialog.type(), message: "응답 전에 확인창이 종료됨" });
  else errors.push("자동화 대화상자 응답 실패");
})); // Only this synthetic context, never the user's browser.
const dialog = page.locator("#dialog"), field = dialog.getByLabel("체험 표시 이름", { exact: false });
const open = () => page.getByRole("button", { name: "내 표시 이름", exact: true }).click();
const save = async () => { await dialog.getByRole("button", { name: "표시 이름 저장", exact: true }).click(); };
const close = async () => {
  const memberEdit = await dialog.getAttribute("data-action") === "member-profile";
  await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
  if (memberEdit) await dialog.locator("form").waitFor({ state: "detached" });
};
const role = (value) => page.getByLabel("사용자 역할", { exact: true }).selectOption(value);
const nav = (name) => page.getByRole("navigation", { name: page.viewportSize().width <= 640 ? "모바일 메뉴" : "주요 메뉴", exact: true }).getByRole("button", { name, exact: true }).click();
const state = () => page.evaluate(async () => {
  const raw = localStorage.getItem("child-development-demo-v2");
  if (raw) return JSON.parse(raw);
  const [{ seed }, { upgradeState }] = await Promise.all([import("/src/seed.js"), import("/src/conversations.js")]);
  return upgradeState(seed());
});
const preserved = (after, before) => {
  const withoutProfile = ({ revision, memberProfiles, ...rest }) => rest;
  assert.deepEqual(withoutProfile(after), withoutProfile(before));
};
const name = (db, userId) => db.memberProfiles?.find((row) => row.userId === userId)?.displayName;
const noOverflow = async () => {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(await page.evaluate(() => {
    const faults = [];
    for (const el of document.querySelectorAll("#app *, #dialog[open] *")) {
      if (!el.getClientRects().length || !el.clientWidth || el.closest("svg, .sr-only") || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) continue;
      if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === "visible") faults.push(el.className);
    }
    return faults;
  }), []);
};
const check = (label) => { checks.push(label); console.log("PASS " + label); };
let failure = null;
try {
  await page.goto(base);
  await page.getByRole("heading", { name: "소식에서 다음 만남으로", exact: true }).waitFor();
  const original = await state(), literal = "<b>가상 치료사</b>";
  await open();
  assert.equal(await field.inputValue(), "");
  await dialog.getByText("Carebridge 체험 센터에서 표시할 이름이에요.", { exact: false }).waitFor();
  assert.equal((await dialog.locator(".eyebrow").innerText()).includes("하루"), false);
  await field.fill(literal); await save(); await dialog.waitFor({ state: "hidden" });
  const renamed = await state(); preserved(renamed, original);
  assert.equal(name(renamed, "t1"), literal);
  assert.equal(renamed.revision, original.revision + 1);
  await page.reload();
  assert.equal((await page.locator('.conversation-row[data-id="c1"]').innerText()).includes(literal), true);
  await open();
  assert.equal(await field.inputValue(), literal);
  await dialog.getByText("기본 표시: 담당 치료사", { exact: false }).waitFor(); await close();
  await role("guardian"); await nav("대화");
  await page.locator('.conversation-row[data-id="c1"]').click();
  assert.equal(await page.locator(".message-meta strong").first().innerText(), `${literal} · 담당 치료사`);
  assert.equal(await page.locator(".message-meta strong b").count(), 0);
  check("본인 설정·센터 안내·새로고침·홈/대화 반영·문자열 이스케이프와 기존 ID/원본 보존");

  const beforeGuardian = await state();
  await open(); assert.equal(await field.inputValue(), "");
  await field.fill("가상 보호자 표시"); await save(); await dialog.waitFor({ state: "hidden" });
  preserved(await state(), beforeGuardian);
  assert.equal(name(await state(), "t1"), literal);
  await page.getByLabel("소식 내용", { exact: true }).fill("가상 표시 이름과 첨부 보존 확인");
  await page.getByRole("button", { name: "＋ 사진·동영상", exact: true }).click();
  const photo = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=", "base64");
  await page.locator("#chat-attachment-editor input[type=file]").setInputFiles({ name: "가상-이름-검증.png", mimeType: "image/png", buffer: photo });
  await page.waitForFunction(() => document.querySelector("#chat-attachment-editor .attachment-row") && !document.querySelector("#chat-attachment-editor input[type=file]").disabled);
  await page.locator("#chat-compose").getByRole("button", { name: "보내기", exact: true }).click();
  const message = page.locator(".chat-message").filter({ hasText: "가상 표시 이름과 첨부 보존 확인" });
  await message.waitFor();
  assert.equal(await message.locator(".message-meta strong").innerText(), "가상 보호자 표시 · 보호자");
  const withFile = await state(), sent = withFile.messages.at(-1), fileId = sent.attachments[0].id;
  const bytes = () => page.evaluate(async (id) => { const { MediaStore } = await import("/src/media-store.js"); return Array.from(new Uint8Array(await (await new MediaStore().read(id)).arrayBuffer())); }, fileId);
  assert.deepEqual(await bytes(), [...photo]);
  await open(); await field.fill(""); await save(); await dialog.waitFor({ state: "hidden" });
  preserved(await state(), withFile);
  assert.equal(name(await state(), "p1"), null);
  assert.deepEqual(await bytes(), [...photo]);
  await page.reload(); await message.waitFor();
  assert.equal(await message.locator(".message-meta strong").innerText(), "보호자");
  check("보호자 별도 설정·이름 해제 후 기본 표시·사진 원본/발신 ID/공유 내용과 기록 보존");

  await role("therapist"); await nav("아이 정보");
  assert.equal((await page.locator(".profile-facts").innerText()).includes(literal), true);
  await role("center"); await nav("구성원");
  assert.equal((await page.locator(".account-person").filter({ hasText: literal }).count()), 1);
  await nav("아동"); await page.getByRole("button", { name: "담당 관계 관리", exact: true }).click();
  assert.equal(await dialog.locator('[name="therapistId"] option:checked').textContent(), literal);
  await close();
  await role("guardian"); await open();
  await field.fill("가상 미저장 입력");
  const savedRaw = await page.evaluate(() => localStorage.getItem("child-development-demo-v2"));
  await page.evaluate(() => { window.memberSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key === "child-development-demo-v2") throw new Error("PRIVATE-WRITE"); return window.memberSetItem.call(this, key, value); }; });
  try {
    await save(); await dialog.locator("#form-error:not([hidden])").waitFor();
    assert.equal(await field.inputValue(), "가상 미저장 입력");
    assert.equal((await dialog.innerText()).includes("PRIVATE-WRITE"), false);
    assert.equal(await page.evaluate(() => localStorage.getItem("child-development-demo-v2")), savedRaw);
  } finally { await page.evaluate(() => { Storage.prototype.setItem = window.memberSetItem; delete window.memberSetItem; }); }
  await field.fill("가상 재시도 이름"); await field.press("Enter"); await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-action") === "member-profile");
  assert.equal(name(await state(), "p1"), "가상 재시도 이름");
  check("아이 정보/명단/관계 화면의 일관된 표시·저장 실패의 원문/입력 보존·Enter 재시도·포커스 복귀");

  await open(); await field.fill("가상 읽기 실패 입력");
  const beforeRead = await state();
  await page.evaluate(() => { window.memberGetItem = Storage.prototype.getItem; Storage.prototype.getItem = function (key) { if (key === "child-development-demo-v2") throw new Error("PRIVATE-READ"); return window.memberGetItem.call(this, key); }; });
  try {
    await save(); await dialog.getByText("브라우저 저장소를 확인하지 못했어요. 입력을 유지했어요.", { exact: true }).waitFor();
    assert.equal((await dialog.innerText()).includes("PRIVATE-READ"), false);
    assert.equal(await field.inputValue(), "가상 읽기 실패 입력");
  } finally { await page.evaluate(() => { Storage.prototype.getItem = window.memberGetItem; delete window.memberGetItem; }); }
  assert.deepEqual(await state(), beforeRead); await close();
  check("저장 전 읽기 접근 거부도 내부 오류를 숨기고 입력·이전 데이터 유지");

  await open(); await field.fill("가상 충돌 후 남길 입력");
  const other = await context.newPage();
  try {
    await other.goto(base); await other.getByLabel("사용자 역할", { exact: true }).selectOption("guardian");
    await other.getByRole("button", { name: "내 표시 이름", exact: true }).click();
    await other.locator('#dialog [name="displayName"]').fill("다른 탭 최신 가상명");
    await other.locator("#dialog").getByRole("button", { name: "표시 이름 저장", exact: true }).click();
    await other.locator("#dialog").waitFor({ state: "hidden" });
  } finally { await other.close(); }
  await save(); await dialog.getByText("다른 탭에서 변경되었어요.", { exact: false }).waitFor();
  assert.equal(await field.inputValue(), "가상 충돌 후 남길 입력");
  assert.equal(name(await state(), "p1"), "다른 탭 최신 가상명");
  await close(); await page.reload(); await open(); assert.equal(await field.inputValue(), "다른 탭 최신 가상명"); await close();
  check("다른 탭 수정 충돌 시 최신 원문 비덮어쓰기·입력 보존·새로고침으로 최신 이름 복원");

  await open(); await field.fill("잘못된 계정에 쓰면 안 되는 값");
  const beforeSwitch = await state();
  await page.evaluate(() => { const select = document.getElementById("role"); select.value = "therapist"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await save(); await dialog.getByText("체험 계정이 변경됐어요.", { exact: false }).waitFor();
  assert.equal(await field.inputValue(), "잘못된 계정에 쓰면 안 되는 값");
  assert.deepEqual(await state(), beforeSwitch); await close();
  check("설정 중 체험 계정 변경을 감지해 다른 사용자에 저장하지 않음");

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 720 });
    for (const value of ["therapist", "guardian", "center"]) {
      await role(value); await open(); await field.fill("가상긴표시이름".repeat(4) + "가상");
      await noOverflow();
      assert.equal((await page.getByRole("button", { name: "내 표시 이름", exact: true }).boundingBox()).width >= 44, true);
      await dialog.getByRole("button", { name: "표시 이름 저장", exact: true }).focus(); await page.keyboard.press("Enter"); await dialog.waitFor({ state: "hidden" });
      await nav(value === "center" ? "구성원" : "홈"); await noOverflow();
      if (value !== "center") { await nav("대화"); await page.locator('.conversation-row[data-id="c1"]').click(); await noOverflow(); }
    }
    await page.screenshot({ path: `${root}/member-profiles-mobile-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 960 }); await role("therapist"); await nav("홈"); await open();
  await page.screenshot({ path: `${root}/member-profiles-desktop.png` }); await close();
  check("320/390px 모든 역할의 긴 이름·대화/명단·44px 설정 버튼·Enter/Escape 접근과 데스크톱 화면");
  assert.equal(requests.some((url) => new URL(url).pathname.startsWith("/api/")), false);
  assert.equal(requests.some((url) => new URL(url).origin !== new URL(base).origin), false);
  assert.deepEqual(errors, []);
  check("브라우저 오류·API/외부 요청 없음: 로컬 체험 경계 유지");
} catch (error) {
  failure = error.message;
  await page.screenshot({ path: `${root}/member-profiles-failure.png` }).catch(() => {});
  throw error;
} finally {
  await writeFile(`${root}/member-profiles-browser.json`, JSON.stringify({ checks, errors, automationWarnings, failure }, null, 2));
  await context.close(); await browser.close();
}

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser = await chromium.connectOverCDP(process.env.CDP_URL);
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: "ko-KR" });
const page = await context.newPage();
page.setDefaultTimeout(7000);
const errors = [], requests = [], checks = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("request", (request) => requests.push(request.url()));
page.on("dialog", (dialog) => dialog.accept()); // only this synthetic context
const base = process.env.APP_URL || "http://127.0.0.1:4173";
const root = fileURLToPath(new URL("../test-results/", import.meta.url));
await mkdir(root, { recursive: true });
const dialog = page.locator("#dialog");
const save = () => dialog.getByRole("button", { name: "기본정보 저장", exact: true }).click();
const close = async () => { await dialog.getByRole("button", { name: "닫기", exact: true }).click(); await dialog.waitFor({ state: "hidden" }); };
const role = (value) => page.getByLabel("사용자 역할", { exact: true }).selectOption(value);
const nav = (name) => page.getByRole("navigation", { name: page.viewportSize().width <= 640 ? "모바일 메뉴" : "주요 메뉴", exact: true }).getByRole("button", { name, exact: true }).click();
const open = () => page.getByRole("button", { name: "기본정보 수정", exact: true }).click();
const state = () => page.evaluate(async () => {
  const raw = localStorage.getItem("child-development-demo-v2");
  if (raw) return JSON.parse(raw);
  const [{ seed }, { upgradeState }] = await Promise.all([import("/src/seed.js"), import("/src/conversations.js")]);
  return upgradeState(seed());
});
const preserved = (after, before) => {
  for (const key of ["goals", "records", "publications", "feedback", "appointments", "messages", "conversations", "readStates"])
    assert.deepEqual(after[key], before[key], `${key} must remain unchanged`);
  assert.deepEqual(after.children.slice(1), before.children.slice(1));
  const exclude = ({ name, age, ageAsOf, ...rest }) => rest;
  assert.deepEqual(exclude(after.children[0]), exclude(before.children[0]));
};
const check = (label) => { checks.push(label); console.log("PASS " + label); };
const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
let failure = null;
try {
  await page.goto(base);
  await page.getByRole("heading", { name: "소식에서 다음 만남으로", exact: true }).waitFor();
  const original = await state();
  await role("center");
  await nav("아동");
  await page.locator(".profile").getByText("기준일 미확인", { exact: false }).waitFor();
  await open();
  assert.equal(await dialog.locator('[name="ageAsOf"]').inputValue(), "");
  await dialog.locator('[name="name"]').fill("가상 이름 수정");
  await save();
  await dialog.waitFor({ state: "hidden" });
  let saved = await state();
  assert.equal(saved.children[0].name, "가상 이름 수정");
  assert.equal(saved.children[0].age, original.children[0].age);
  assert.equal(Object.hasOwn(saved.children[0], "ageAsOf"), false);
  preserved(saved, original);
  check("이름만 수정하면 기존 날짜 없는 연령·기록·대화·첨부·담당 관계를 보존");

  await open();
  await dialog.locator('[name="age"]').fill("0");
  await save();
  await dialog.getByText("연령과 기준일을 함께 입력하거나 두 칸 모두 비워 주세요.", { exact: true }).waitFor();
  assert.equal(await dialog.locator('[name="age"]').inputValue(), "0");
  assert.deepEqual(await state(), saved);
  await dialog.locator('[name="ageAsOf"]').fill("2026-01-01");
  await dialog.getByRole("button", { name: "기본정보 저장", exact: true }).focus();
  await page.keyboard.press("Enter");
  await dialog.waitFor({ state: "hidden" });
  saved = await state();
  assert.equal(saved.children[0].age, 0);
  assert.equal(saved.children[0].ageAsOf, "2026-01-01");
  preserved(saved, original);
  for (const account of ["guardian", "therapist"]) {
    await role(account);
    await nav("아이 정보");
    await page.locator(".profile").getByText("0세 · 2026-01-01 기준", { exact: false }).waitFor();
    assert.equal(await page.getByRole("button", { name: "기본정보 수정", exact: true }).count(), 0);
  }
  await role("center");
  await nav("아동");
  assert.equal(await page.locator("#view-content").getByText(original.children[0].concern, { exact: true }).count(), 0);
  check("실제 0세·명시적 기준일 표시, 보호자/치료사 편집 제외·센터 가족 관심사 비노출");

  await open();
  await dialog.locator('[name="name"]').fill("가상 미저장 이름");
  await page.evaluate(() => {
    window.__profileTestSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "child-development-demo-v2") throw new DOMException("Synthetic blocked write", "QuotaExceededError");
      return window.__profileTestSetItem.call(this, key, value);
    };
  });
  try {
    await save();
    await dialog.locator("#form-error:not([hidden])").waitFor();
    assert.equal(await dialog.locator('[name="name"]').inputValue(), "가상 미저장 이름");
    assert.deepEqual(await state(), saved);
  } finally {
    await page.evaluate(() => { Storage.prototype.setItem = window.__profileTestSetItem; delete window.__profileTestSetItem; });
  }
  await save();
  await dialog.waitFor({ state: "hidden" });
  saved = await state();
  assert.equal(saved.children[0].name, "가상 미저장 이름");
  preserved(saved, original);
  check("저장소 쓰기 실패는 입력/원문을 유지하며 복구 후 재시도로 한 번 저장");

  await open();
  await dialog.locator('[name="name"]').fill("충돌 후 남길 입력");
  const other = await context.newPage();
  other.setDefaultTimeout(7000);
  try {
    await other.goto(base);
    await other.getByLabel("사용자 역할", { exact: true }).selectOption("center");
    await other.getByRole("navigation", { name: "주요 메뉴", exact: true }).getByRole("button", { name: "아동", exact: true }).click();
    await other.getByRole("button", { name: "기본정보 수정", exact: true }).click();
    await other.locator('#dialog [name="name"]').fill("다른 탭 최신 이름");
    await other.locator("#dialog").getByRole("button", { name: "기본정보 저장", exact: true }).click();
    await other.locator("#dialog").waitFor({ state: "hidden" });
  } finally { await other.close(); }
  const latest = await state();
  assert.equal(latest.children[0].name, "다른 탭 최신 이름");
  await save();
  await dialog.getByText("다른 탭에서 변경되었어요.", { exact: false }).waitFor();
  assert.equal(await dialog.locator('[name="name"]').inputValue(), "충돌 후 남길 입력");
  assert.deepEqual(await state(), latest);
  await close();
  await page.reload();
  await page.locator(".profile").getByRole("heading", { name: "다른 탭 최신 이름", exact: true }).waitFor();
  preserved(await state(), original);
  check("다른 탭의 최신 변경을 덮어쓰지 않고 충돌 입력 유지·새로고침 복원");

  await page.getByRole("button", { name: "아동 등록", exact: false }).click();
  assert.equal(await dialog.locator('[name="age"]').inputValue(), "");
  assert.equal(await dialog.locator('[name="ageAsOf"]').inputValue(), "");
  await dialog.locator('[name="name"]').fill("가상 연령 미입력");
  await dialog.getByRole("button", { name: "아동 등록", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const unknown = (await state()).children.at(-1);
  assert.equal(unknown.age, null);
  assert.equal(unknown.ageAsOf, null);
  assert.deepEqual(unknown.guardianIds, []);
  await page.locator(".profile").getByText("연령 미입력 · 가상 아동", { exact: true }).waitFor();
  await page.reload();
  await page.locator(".profile").getByText("연령 미입력 · 가상 아동", { exact: true }).waitFor();
  await role("guardian");
  assert.equal(await page.locator(`#child option[value="${unknown.id}"]`).count(), 0);
  await role("center");
  await nav("아동");
  await page.getByLabel("선택한 아동", { exact: true }).selectOption(unknown.id);
  check("신규 등록은 연령 미입력을 null로 보존·새로고침 복원·보호자 자동 연결 없음");

  await open();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 720 });
    await noOverflow();
    assert.ok((await dialog.locator('[name="ageAsOf"]').boundingBox()).width >= 180);
    await dialog.getByRole("button", { name: "기본정보 저장", exact: true }).click({ trial: true });
    await dialog.evaluate((el) => { el.scrollTop = 0; });
    await page.screenshot({ path: `${root}/profiles-edit-${width}.png` });
  }
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(requests.some((url) => new URL(url).pathname.startsWith("/api/")), false);
  assert.equal(requests.some((url) => new URL(url).origin !== new URL(base).origin), false);
  assert.deepEqual(errors, []);
  check("320/390px 입력·버튼·Escape 접근, 브라우저 오류·API/외부 요청 없음");
} catch (error) {
  failure = error.message;
  await page.screenshot({ path: `${root}/profiles-failure.png` }).catch(() => {});
  throw error;
} finally {
  await writeFile(`${root}/profiles-browser.json`, JSON.stringify({ checks, errors, failure }, null, 2));
  await context.close();
  await browser.close();
}

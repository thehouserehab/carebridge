import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";

const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser = await chromium.connectOverCDP(process.env.CDP_URL);
const context = await browser.newContext({ locale: "ko-KR" });
const page = await context.newPage();
page.setDefaultTimeout(7000);
const root = fileURLToPath(new URL("../test-results/", import.meta.url));
await mkdir(root, { recursive: true });
const issues = [], checks = [], errors = [];
let failure = null;
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
const nav = (name) => page.getByRole("navigation", { name: page.viewportSize().width <= 640 ? "모바일 메뉴" : "주요 메뉴", exact: true }).getByRole("button", { name, exact: true }).click();
const role = (value) => page.getByLabel("사용자 역할", { exact: true }).selectOption(value);
const close = async () => {
  await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close()));
  await page.locator("dialog[open]").waitFor({ state: "detached", timeout: 1000 }).catch(() => {});
};
async function audit(label, screenshot = false) {
  const faults = await page.evaluate(() => {
    const result = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) result.push("page: horizontal overflow");
    const scope = document.querySelector("dialog[open]") || document.querySelector("#app");
    for (const el of scope.querySelectorAll("*")) {
      const style = getComputedStyle(el);
      if (!el.getClientRects().length || !el.clientWidth || el.closest("svg, .sr-only") || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) continue;
      if (el.scrollWidth > el.clientWidth + 2 && style.overflowX === "visible") result.push(`${el.tagName}.${el.className}: ${el.scrollWidth} > ${el.clientWidth} (${el.textContent.trim().slice(0, 55)})`);
    }
    return result;
  });
  issues.push(...faults.map((fault) => `${label}: ${fault}`));
  checks.push(label);
  if (screenshot) await page.screenshot({ path: `${root}/layout-${process.env.LAYOUT_STAGE || "after"}-${label}.png`, fullPage: !await page.locator("dialog[open]").count() });
}
try {
  await page.goto(process.env.APP_URL || "http://127.0.0.1:4198");
  await page.getByRole("heading", { name: "소식에서 다음 만남으로" }).waitFor();
  for (const width of [320, 390, 640, 641, 720, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await role("therapist");
    await nav("홈");
    await audit(`${width}-home`, [320, 1440].includes(width));
    await page.getByRole("button", { name: "내 표시 이름", exact: true }).click();
    await page.locator('#dialog [name="displayName"]').fill("가상긴표시이름".repeat(4) + "가상");
    await audit(`${width}-member-profile`, width === 320);
    await close();
    await page.getByRole("button", { name: "로그인 화면", exact: true }).click();
    await audit(`${width}-login`);
    await close();
    await nav("기록");
    await audit(`${width}-records`);
    await page.locator('.page-heading [data-action="record"]').click();
    for (const summary of await page.locator("#dialog details > summary").all()) await summary.click();
    await page.getByRole("button", { name: "측정값 추가", exact: true }).click();
    await audit(`${width}-record-form`, [320, 390].includes(width));
    await page.locator("#dialog").evaluate((el) => el.scrollTop = 0);
    if (width === 320) await page.screenshot({ path: `${root}/layout-${process.env.LAYOUT_STAGE || "after"}-320-record-top.png` });
    if (process.env.LAYOUT_STAGE !== "before" && width <= 390) {
      for (const input of await page.locator('dialog[open] input[type="date"]').all()) assert.ok((await input.boundingBox()).width >= 180, "Date input must show the complete value");
    }
    await close();
    await nav("아이 정보");
    await audit(`${width}-children`);
    await nav("대화");
    await page.locator('.conversation-row[data-id="c1"]').click();
    await audit(`${width}-chat`, [320, 641, 768].includes(width));
    await role("guardian");
    await nav("홈");
    await audit(`${width}-guardian-home`);
    await nav("기록");
    await audit(`${width}-guardian-records`);
    await nav("아이 정보");
    await audit(`${width}-guardian-child`);
    await role("center");
    await nav("운영 현황");
    await audit(`${width}-center`);
    await nav("일정");
    await audit(`${width}-schedule`, [320, 768].includes(width));
    await page.locator('.view-toolbar [data-action="appointment"]').click();
    await audit(`${width}-appointment`, width === 320);
    await close();
    await nav("아동");
    await page.getByRole("button", { name: "기본정보 수정", exact: true }).click();
    await audit(`${width}-child-profile`, width === 320);
    await close();
    await page.getByRole("button", { name: "아동 등록", exact: false }).click();
    await audit(`${width}-child-registration`, width === 320);
    await close();
    await nav("구성원");
    await audit(`${width}-members`, width === 320);
    await page.getByRole("button", { name: "구성원 초대", exact: false }).click();
    await audit(`${width}-invite`, width === 320);
    await close();
  }
  // Existing-account confirmation must expose the full selected address even
  // when a narrow native select truncates its option label.
  await page.getByRole("button", { name: "구성원 초대", exact: false }).click();
  await page.locator('#account-dialog input[value="guardian"]').check();
  await page.locator('#account-dialog [name="email"]').fill("existing.guardian@example.test");
  await page.getByRole("button", { name: "초대 만들기 · 체험", exact: true }).click();
  await page.getByRole("button", { name: "받는 분의 화면 보기", exact: true }).click();
  await page.getByRole("button", { name: "기존 계정으로 연결", exact: true }).click();
  for (const width of [320, 390, 640, 641, 720, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 720 });
    await page.locator('#account-dialog [name="accountId"]').selectOption("outside-therapist");
    await audit(`${width}-existing-other-account`);
    await page.locator('#account-dialog [name="accountId"]').selectOption("outside-guardian");
    assert.equal(await page.locator("#existing-account-selection").textContent(), "기존 보호자 · existing.guardian@example.test");
    await audit(`${width}-existing-account`, [320, 1440].includes(width));
  }
  await close();
  // Stress only this isolated browser context with synthetic, valid-length data.
  await page.evaluate(async () => {
    const { seed } = await import("/src/seed.js");
    const { upgradeState } = await import("/src/conversations.js");
    const { validateState, mutate } = await import("/src/domain.js");
    const db = seed();
    db.children[0].name = "가상아동이름줄바꿈확인용".repeat(2);
    db.appointments.forEach((a) => { a.title = "가상일정제목줄바꿈확인".repeat(4); a.room = "긴장소이름표시확인용".repeat(4); });
    db.goals[0].title = "LongGoalWithoutSpaces".repeat(4);
    db.records[0].title = "LongRecordWithoutSpaces".repeat(4);
    db.records[0].privateNote = "SyntheticPrivateNoteWithoutSpaces".repeat(30);
    db.records[0].assessment = {
      ...db.records[1].assessment, unit: "SyntheticUnit".repeat(7), context: "SyntheticCondition".repeat(15),
    };
    db.records[1].assessment = { ...db.records[0].assessment, value: 0 };
    db.publications[0].title = db.records[0].title;
    db.publications[0].activity.title = "SyntheticActivityWithoutSpaces".repeat(3);
    db.publications[0].activity.frequency = "SyntheticFrequencyWithoutSpaces".repeat(3);
    let upgraded = upgradeState(db);
    upgraded = mutate(upgraded, { id: "t1", role: "therapist" }, "member-profile", { displayName: "가상치료사이름".repeat(4) + "가상" });
    upgraded = mutate(upgraded, { id: "p1", role: "guardian" }, "member-profile", { displayName: "가상보호자이름".repeat(4) + "가상" });
    upgraded = mutate(upgraded, { id: "p1", role: "guardian" }, "message", {
      childId: "c1", clientId: "layout-long-message", body: "SyntheticMessageWithoutSpaces".repeat(40),
    });
    upgraded = mutate(upgraded, { id: "p1", role: "guardian" }, "feedback", {
      childId: "c1", publicationId: "pub1", date: db.appointments[0].date, result: "done",
      reaction: "SyntheticReactionWithoutSpaces".repeat(20), difficulty: "SyntheticDifficultyWithoutSpaces".repeat(15),
    });
    upgraded = mutate(upgraded, { id: "t1", role: "therapist" }, "review", {
      childId: "c1", id: upgraded.feedback[0].id, reviewNote: "SyntheticReviewWithoutSpaces".repeat(30),
    });
    if (!validateState(upgraded)) throw new Error("Invalid layout fixture");
    localStorage.setItem("child-development-demo-v2", JSON.stringify(upgraded));
  });
  await page.reload();
  for (const width of [320, 641, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await role("therapist");
    for (const [name, label] of [["홈", "home"], ["기록", "records"], ["아이 정보", "children"]]) {
      await nav(name);
      await audit(`${width}-long-${label}`);
    }
    await nav("기록");
    await page.locator(".record-card details").first().locator("summary").click();
    await audit(`${width}-long-record-details`, width === 320);
    await page.locator('.record-card [data-action="preview"]').first().click();
    await audit(`${width}-long-share-preview`);
    await close();
    await nav("아이 정보");
    await page.locator('.child-shortcuts [data-id="activities"]').click();
    await audit(`${width}-long-activities`, width === 320);
    await nav("대화");
    await page.locator('.conversation-row[data-id="c1"]').click();
    await page.locator(".chat-activity > summary").click();
    await audit(`${width}-long-chat`, width === 320);
    const message = page.locator('[data-message-id="layout-long-message"]');
    await message.locator('[data-action="message-review"]').click();
    await audit(`${width}-long-review-quote`);
    await close();
    await message.locator('[data-action="reference-message"]').click();
    await audit(`${width}-long-reference`);
    await page.locator('.reference-note [data-action="view-reference"]').click();
    await audit(`${width}-long-reference-original`);
    await close();
    await role("center");
    await nav("아동");
    await page.getByRole("button", { name: "담당 관계 관리", exact: true }).click();
    await audit(`${width}-long-relationships`);
    await close();
    await nav("구성원");
    await page.getByRole("button", { name: "구성원 초대", exact: false }).click();
    await page.locator('#account-dialog [name="email"]').fill(`layout${width}.${"long".repeat(10)}@example.test`);
    await page.getByRole("button", { name: "초대 만들기 · 체험", exact: true }).click();
    await close();
    await audit(`${width}-long-invitation`, width === 320);
  }
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 420 });
    await role("therapist");
    await nav("대화");
    await page.locator('.conversation-row[data-id="c1"]').click();
    await page.waitForFunction(() => !document.querySelector("#message-body").disabled);
    await page.getByLabel("소식 내용", { exact: true }).focus();
    const send = page.getByRole("button", { name: "보내기", exact: true });
    const sendBounds = await send.boundingBox();
    const navBounds = await page.getByRole("navigation", { name: "모바일 메뉴", exact: true }).boundingBox();
    assert.ok(sendBounds.y >= 0 && sendBounds.y + sendBounds.height <= navBounds.y, "Short viewport must not hide Send behind the mobile menu");
    assert.ok((await page.locator(".chat-log").boundingBox()).height >= 44, "A long child name must leave readable conversation space");
    assert.equal(await page.locator(".chat-header").getByRole("heading", { name: "가상아동이름줄바꿈확인용".repeat(2), exact: true }).count(), 1, "Compact text must retain the full accessible child name");
    await send.click({ trial: true });
    await audit(`${width}-short-long-chat`, width === 320);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    // Simulate a keyboard changing visualViewport while CSS layout height stays unchanged.
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 420 });
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
    const sendBounds = await page.getByRole("button", { name: "보내기", exact: true }).boundingBox();
    assert.ok(sendBounds.y >= 0 && sendBounds.y + sendBounds.height <= 420, "Send must fit the visual viewport, not the unchanged CSS viewport");
    assert.equal(await page.locator("html").getAttribute("data-compact-viewport"), "");
    assert.ok((await page.locator(".chat-log").boundingBox()).height >= 44);
    await audit("390-visual-viewport-keyboard", true);
  } finally {
    await page.evaluate(() => {
      delete window.visualViewport.height;
      window.visualViewport.dispatchEvent(new Event("resize"));
    });
  }
  assert.equal(await page.locator("html").getAttribute("data-compact-viewport"), null);
  assert.equal(await page.locator(".chat-header p").isVisible(), true);
  assert.deepEqual(errors, []);
  if (process.env.LAYOUT_STAGE !== "before") assert.deepEqual(issues, []);
  console.log(JSON.stringify({ checks: checks.length, issues, errors }, null, 2));
} catch (error) {
  failure = error.message;
  await page.screenshot({ path: `${root}/layout-${process.env.LAYOUT_STAGE || "after"}-failure.png` }).catch(() => {});
  throw error;
} finally {
  await writeFile(`${root}/layout-${process.env.LAYOUT_STAGE || "after"}-report.json`, JSON.stringify({ checks, issues, errors, failure }, null, 2));
  await context.close();
  await browser.close();
}

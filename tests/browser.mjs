// Run against a dedicated local browser. PLAYWRIGHT_MODULE points to an installed
// Playwright module; CDP_URL comes from `agent-browser get cdp-url`.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
const { chromium } = await import(
  pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
);
const browser = await chromium.connectOverCDP(process.env.CDP_URL);
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "ko-KR",
});
const page = await context.newPage();
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(`${root}/test-results`, { recursive: true });
const errors = [],
  network = [],
  checks = [];
page.on("pageerror", (err) => errors.push(err.message));
page.on("request", (req) => network.push(req.url()));
page.setDefaultTimeout(7000);
const base = process.env.APP_URL || "http://127.0.0.1:4173";
const role = async (value) =>
  page.getByLabel("사용자 역할", { exact: true }).selectOption(value);
const nav = async (name) => {
  const isCenter =
    (await page.getByLabel("사용자 역할", { exact: true }).inputValue()) ===
    "center";
  if (name === "가정 활동" || (name === "일정" && !isCenter)) {
    await nav("아이 정보");
    await page
      .getByRole("button", {
        name: name === "일정" ? "전체 일정" : "가정 활동",
        exact: true,
      })
      .click();
    return;
  }
  const label =
    { 오늘: "홈", "공유 기록": "기록", "아이·목표": "아이 정보" }[name] ||
    (name === "아동" && !isCenter ? "아이 정보" : name);
  await page
    .getByRole("navigation", {
      name: page.viewportSize().width <= 640 ? "모바일 메뉴" : "주요 메뉴",
      exact: true,
    })
    .getByRole("button", { name: label, exact: true })
    .click();
};
async function reveal(locator) {
  for (const details of await locator.locator("xpath=ancestor::details").all())
    if ((await details.getAttribute("open")) === null)
      await details.locator(":scope > summary").click();
}
const fill = async (name, value) => {
  if (["tool", "item", "value", "unit", "context"].includes(name))
    name = "assessment-0-" + name;
  const input = page.locator(`#edit-form [name="${name}"]`);
  await reveal(input);
  await input.fill(value);
};
const submit = async () =>
  page.locator("#edit-form button[type=submit]:not([name=intent])").click();
const text = () => page.locator("#view-content").innerText();
const closed = async () =>
  assert.equal(await page.locator("#dialog").evaluate((d) => d.open), false);
const recordTitle = "가상 놀이 기록 E2E";
try {
  await page.goto(base);
  await page.getByRole("heading", { name: "소식에서 다음 만남으로" }).waitFor();
  await page.screenshot({
    path: `${root}/test-results/desktop-home.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "기록하기", exact: true })
    .first()
    .click();
  await fill("title", recordTitle);
  await fill(
    "summary",
    "가족이 고른 놀이에 참여했어요. <script>unsafe</script>",
  );
  await page
    .locator("#edit-form summary")
    .filter({ hasText: "치료사 내부 메모" })
    .click();
  await fill("privateNote", "NEVER SHARE THIS PRIVATE NOTE");
  await fill("nextPlan", "다음 회기 관찰 메모");
  await page
    .locator("#dialog summary")
    .filter({ hasText: /^상세 관찰·측정값$/ })
    .click();
  await page.getByRole("button", { name: "측정값 추가", exact: true }).click();
  for (const [k, v] of Object.entries({
    tool: "직접 관찰",
    item: "참여 시간",
    value: "7",
    unit: "분",
    context: "같은 놀이 공간",
  }))
    await fill(k, v);
  await reveal(
    page.getByLabel("목표에 연결된 가정 활동 추가", { exact: true }),
  );
  await page
    .getByLabel("목표에 연결된 가정 활동 추가", { exact: true })
    .check();
  for (const [k, v] of Object.entries({
    activityTitle: "함께 놀이 선택하기 E2E",
    instruction: "아이가 고른 놀이의 경험을 알려주세요.",
    frequency: "편한 시간에 한 번",
    caution: "가상 안내입니다.",
  }))
    await fill(k, v);
  await submit();
  await closed();
  assert.ok((await text()).includes(recordTitle));
  checks.push("세션 일정과 연결된 기록·평가·활동 생성");
  let card = page.locator(".record-card").filter({
    has: page.getByRole("heading", { name: recordTitle, exact: true }),
  });
  await card.getByRole("button", { name: "공유 미리보기" }).click();
  assert.ok(
    !(await page.locator("#dialog").innerText()).includes("NEVER SHARE"),
  );
  await submit();
  await closed();
  await role("guardian");
  await nav("공유 기록");
  assert.ok((await text()).includes(recordTitle));
  assert.ok(!(await page.locator("body").innerText()).includes("NEVER SHARE"));
  assert.equal(await page.locator("#view-content script").count(), 0);
  assert.equal(await page.locator("#child option").count(), 1);
  checks.push("공유 미리보기·보호자 표시·아동 관계·HTML 이스케이프");
  await nav("가정 활동");
  let activity = page.locator(".activity-card").filter({
    has: page.getByRole("heading", {
      name: "함께 놀이 선택하기 E2E",
      exact: true,
    }),
  });
  await activity.getByRole("button", { name: "활동 경험 남기기" }).click();
  await page.locator("[name=result]").selectOption("partial");
  await fill("reaction", "스스로 놀이를 골랐어요 E2E");
  await fill("difficulty", "오래 하기는 어려웠어요");
  await submit();
  await closed();
  await page.reload();
  assert.ok((await text()).includes("스스로 놀이를 골랐어요 E2E"));
  checks.push("보호자 피드백 입력·새로고침 보존");
  await role("therapist");
  await nav("가정 활동");
  await page.getByRole("button", { name: "확인하고 다음 회기 준비" }).click();
  await fill("reviewNote", "다음 만남에 놀이 시간을 함께 조정 E2E");
  await submit();
  await closed();
  await nav("기록");
  await page.getByRole("button", { name: "기록 작성", exact: true }).click();
  await page.locator(".previous-context summary").click();
  assert.ok(
    (await page.locator(".previous-context").innerText()).includes(
      "다음 만남에 놀이 시간을 함께 조정 E2E",
    ),
  );
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  checks.push("치료사 피드백 검토와 다음 기록 문맥 연결");
  await nav("기록");
  card = page.locator(".record-card").filter({
    has: page.getByRole("heading", { name: recordTitle, exact: true }),
  });
  await card.getByRole("button", { name: "수정", exact: true }).click();
  await fill("summary", "새로 수정한 보호자용 초안 E2E");
  await submit();
  await closed();
  await role("guardian");
  await nav("공유 기록");
  assert.ok((await text()).includes("가족이 고른 놀이"));
  assert.ok(!(await text()).includes("새로 수정한 보호자용 초안"));
  await role("therapist");
  await nav("기록");
  card = page.locator(".record-card").filter({
    has: page.getByRole("heading", { name: recordTitle, exact: true }),
  });
  await card.getByRole("button", { name: "공유 미리보기" }).click();
  await submit();
  await closed();
  await role("guardian");
  await nav("공유 기록");
  assert.ok((await text()).includes("새로 수정한 보호자용 초안"));
  checks.push("초안 수정은 공유본 유지, 재공유 후 갱신");
  await role("therapist");
  await nav("기록");
  card = page.locator(".record-card").filter({
    has: page.getByRole("heading", { name: recordTitle, exact: true }),
  });
  await card.getByRole("button", { name: "공유 철회", exact: true }).click();
  await submit();
  await closed();
  await role("guardian");
  await nav("공유 기록");
  assert.ok(!(await text()).includes(recordTitle));
  await role("therapist");
  await nav("가정 활동");
  assert.ok((await text()).includes("스스로 놀이를 골랐어요 E2E"));
  await page.getByLabel("선택한 아동", { exact: true }).selectOption("c2");
  assert.ok(!(await text()).includes("스스로 놀이를 골랐어요"));
  checks.push("공유 철회·과거 피드백 보존·아동 분리");
  await role("guardian");
  await nav("아이·목표");
  await page.getByRole("button", { name: "수정", exact: true }).click();
  await fill("concern", "함께 산책하고 싶어요 E2E");
  await submit();
  await closed();
  await role("therapist");
  await nav("아동");
  assert.ok((await text()).includes("함께 산책하고 싶어요 E2E"));
  await page.getByRole("button", { name: "목표 추가" }).click();
  await fill("title", "가족 산책 참여 E2E");
  await fill("description", "함께 정한 생활 목표");
  await submit();
  await closed();
  const goal = page
    .locator(".goal-card")
    .filter({ has: page.getByRole("heading", { name: "가족 산책 참여 E2E" }) });
  await goal.getByRole("button", { name: "목표 수정" }).click();
  await page.locator("[name=status]").selectOption("achieved");
  await submit();
  await closed();
  assert.ok((await goal.innerText()).includes("달성"));
  checks.push("보호자 관심사·공동 목표 생성과 상태 수정");
  await role("center");
  assert.ok(!(await page.locator("body").innerText()).includes("NEVER SHARE"));
  await nav("아동");
  await page.getByRole("button", { name: "아동 등록" }).click();
  await fill("name", "가상 별 E2E");
  await fill("age", "6");
  await submit();
  await closed();
  assert.ok((await text()).includes("가상 별 E2E"));
  await page
    .getByRole("button", { name: "일정 등록", exact: true })
    .first()
    .click();
  await fill("time", "16:00");
  await fill("title", "새 아동 상담 E2E");
  await submit();
  await closed();
  assert.ok((await text()).includes("새 아동 상담 E2E"));
  await page
    .getByRole("button", { name: "가상 별 E2E 16:00 일정 수정" })
    .click();
  await page.locator("[name=status]").selectOption("attended");
  await submit();
  await closed();
  assert.ok((await text()).includes("출석"));
  checks.push("센터 아동 등록·일정 생성·출결 수정");
  await role("therapist");
  await nav("기록");
  await page.getByLabel("선택한 아동", { exact: true }).selectOption("c1");
  await nav("기록");
  await page.getByRole("button", { name: "기록 작성", exact: true }).click();
  await fill("title", "실패 시 입력 유지");
  await fill("summary", "저장 실패 검증");
  await page.evaluate(() => {
    window._originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function () {
      throw new DOMException("quota", "QuotaExceededError");
    };
  });
  await submit();
  assert.ok(
    (await page.locator("#form-error").innerText()).includes("저장 공간"),
  );
  assert.equal(
    await page.locator("[name=title]").inputValue(),
    "실패 시 입력 유지",
  );
  await page.evaluate(() => {
    Storage.prototype.setItem = window._originalSetItem;
  });
  await submit();
  await closed();
  checks.push("저장 실패 안내·입력 유지·재시도 성공");
  await page.reload();
  assert.ok((await text()).includes("실패 시 입력 유지"));
  assert.equal(
    (await page.request.get(`${base}/docs/product.md`)).status(),
    404,
  );
  assert.equal((await page.request.post(base)).status(), 405);
  checks.push("로컬 서버 문서 비노출·잘못된 메서드 차단");
  for (const r of ["therapist", "guardian", "center"]) {
    await role(r);
    await page.setViewportSize({ width: 390, height: 844 });
    const names =
      r === "center"
        ? ["운영 현황", "아동", "일정"]
        : r === "guardian"
          ? ["홈", "대화", "기록", "아이 정보"]
          : ["홈", "대화", "기록", "아이 정보"];
    for (const name of names) {
      await page
        .getByRole("navigation", { name: "모바일 메뉴", exact: true })
        .getByRole("button", { name, exact: true })
        .click();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        `${r} ${name}: horizontal overflow`,
      );
    }
    await page
      .getByRole("navigation", { name: "모바일 메뉴", exact: true })
      .getByRole("button", { name: names[0], exact: true })
      .click();
    await page.screenshot({
      path: `${root}/test-results/mobile-${r}.png`,
      fullPage: true,
    });
  }
  checks.push("390px 모바일 전 역할·11개 화면 가로 넘침 없음");
  await role("therapist");
  await nav("기록");
  await page.getByRole("button", { name: "기록 작성", exact: true }).click();
  assert.ok(
    await page
      .locator("#dialog")
      .evaluate((d) => d.scrollWidth <= d.clientWidth),
  );
  await page.screenshot({ path: `${root}/test-results/mobile-form.png` });
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await role("therapist");
  await page.screenshot({
    path: `${root}/test-results/desktop-final.png`,
    fullPage: true,
  });
  const raw = await page.evaluate(() =>
    localStorage.getItem("child-development-demo-v2"),
  );
  const other = await context.newPage();
  await other.goto(base);
  await other
    .getByRole("heading", { name: "소식에서 다음 만남으로" })
    .waitFor();
  await nav("기록");
  await page.getByRole("button", { name: "기록 작성", exact: true }).click();
  await fill("title", "다른 탭 충돌 검증");
  await fill("summary", "현재 입력 보존");
  await other
    .getByRole("navigation", { name: "주요 메뉴", exact: true })
    .getByRole("button", { name: "기록", exact: true })
    .click();
  await other.getByRole("button", { name: "기록 작성", exact: true }).click();
  await other
    .locator("#dialog summary")
    .filter({ hasText: "공유 요약·제목" })
    .click();
  await other.locator("[name=title]").fill("다른 탭 저장");
  await other.locator("[name=summary]").fill("갱신됨");
  await other
    .locator("#edit-form button[type=submit]:not([name=intent])")
    .click();
  await submit();
  assert.ok(
    (await page.locator("#form-error").innerText()).includes("다른 탭"),
  );
  assert.equal(
    await page.locator("[name=title]").inputValue(),
    "다른 탭 충돌 검증",
  );
  checks.push("동시 탭의 오래된 편집 저장 거부");
  // Corrupt only this isolated test context, then check that the raw data survives.
  await other.evaluate(() =>
    localStorage.setItem("child-development-demo-v2", "broken-test-data"),
  );
  await other.reload();
  assert.ok(
    (await other.locator("body").innerText()).includes("덮어쓰지 않았습니다"),
  );
  assert.equal(
    await other.evaluate(() =>
      localStorage.getItem("child-development-demo-v2"),
    ),
    "broken-test-data",
  );
  checks.push("손상 데이터 자동 초기화 방지");
  assert.ok(raw);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.ok(
    network.every((url) => url.startsWith(base)),
    "Unexpected external request",
  );
  checks.push("페이지 오류 0건·외부 요청 0건");
  await writeFile(
    `${root}/test-results/browser-results.json`,
    JSON.stringify(
      {
        passed: true,
        at: new Date().toISOString(),
        checks,
        errors,
        requests: network.length,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  await page
    .screenshot({ path: `${root}/test-results/failure.png`, fullPage: true })
    .catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}

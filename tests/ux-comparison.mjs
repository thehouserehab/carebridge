// Synthetic timings are not human usability outcomes. Run while the unchanged
// baseline is still available; use isolated contexts and identical content.
import { pathToFileURL, fileURLToPath } from "node:url";
import { writeFile, mkdir } from "node:fs/promises";
const { chromium } = await import(
  pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
);
const browser = await chromium.connectOverCDP(process.env.CDP_URL);
const rows = [];
const folder = fileURLToPath(new URL("../test-results/", import.meta.url));
await mkdir(folder, { recursive: true });
try {
  for (const version of ["baseline", "revised"]) {
    for (let run = 1; run <= 3; run++) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        locale: "ko-KR",
      });
      const page = await context.newPage();
      const revised = version === "revised";
      await page.goto(
        revised
          ? process.env.APP_URL || "http://127.0.0.1:4174"
          : process.env.BASELINE_URL || "http://127.0.0.1:4173",
      );
      await page.getByRole("heading", { name: revised ? "소식에서 다음 만남으로" : "오늘도 한 걸음, 함께 이어가요", exact: true }).waitFor();
      const role = (value) =>
        page.getByLabel("사용자 역할", { exact: true }).selectOption(value);
      const fill = async (name, value) => {
        const input = page.locator(`#edit-form [name="${name}"]`);
        for (const details of await input
          .locator("xpath=ancestor::details")
          .all())
          if ((await details.getAttribute("open")) === null)
            await details.locator(":scope > summary").click();
        await input.fill(value);
      };
      await role("guardian");
      const activityStart = performance.now();
      if (revised) {
        await page.locator('.conversation-row[data-id="c1"]').click();
      } else
        await page
          .getByRole("button", { name: "가정 활동 확인하기", exact: true })
          .click();
      await page
        .getByRole("button", { name: "활동 경험 남기기", exact: true })
        .click();
      await fill("reaction", "가상 사례: 놀이를 직접 골랐어요.");
      await fill("difficulty", "가상 사례: 어려움은 관찰하지 못했어요.");
      await page.locator("#edit-form button[type=submit]").click();
      await page.locator("#dialog").waitFor({ state: "hidden" });
      const activityMs = Math.round(performance.now() - activityStart);
      await role("therapist");
      const recordStart = performance.now();
      await page
        .getByRole("button", { name: "기록하기", exact: true })
        .first()
        .click();
      await fill("title", "비교용 가상 기록");
      await fill("summary", "가상 놀이를 선택해 참여했어요.");
      if (revised) {
        await fill("performed", "가상 놀이 두 가지 중 선택");
        await fill("response", "가상 관찰: 손으로 가리킴");
        await page
          .locator("#dialog summary")
          .filter({ hasText: /^상세 관찰·측정값$/ })
          .click();
        await page
          .getByRole("button", { name: "측정값 추가", exact: true })
          .click();
      } else {
        await fill(
          "privateNote",
          "활동: 가상 놀이 두 가지 중 선택\n반응: 가상 관찰: 손으로 가리킴",
        );
        await page.getByLabel("평가값 직접 입력", { exact: true }).check();
      }
      await fill("nextPlan", "다음 회기에 가상 관찰 조건 재확인");
      for (const [key, value] of Object.entries({
        tool: "직접 관찰",
        item: "참여 시간",
        value: "3",
        unit: "분",
        context: "동일한 가상 놀이 공간",
      }))
        await fill(revised ? `assessment-0-${key}` : key, value);
      await page
        .locator("#edit-form button[type=submit]:not([name=intent])")
        .click();
      await page.locator("#dialog").waitFor({ state: "hidden" });
      rows.push({
        version,
        run,
        activityMs,
        recordMs: Math.round(performance.now() - recordStart),
        activityViewTransitions: 2,
        activityOpenClicks: 2,
      });
      await context.close();
    }
  }
  const result = {
    at: new Date().toISOString(),
    method:
      "Desktop browser automation, 3 isolated runs per version; same synthetic activity feedback and same information in a one-measurement record. Old activity/response uses free text; new uses separate fields.",
    limitations:
      "Not human task completion times. Public therapist reply has no baseline equivalent (old review memo was internal), so no direct percentage improvement is calculated. Caregiver comprehension and real-device keyboard testing require participants/devices.",
    rows,
    medians: ["baseline", "revised"].map((version) => ({
      version,
      activityMs: rows
        .filter((r) => r.version === version)
        .map((r) => r.activityMs)
        .sort((a, b) => a - b)[1],
      recordMs: rows
        .filter((r) => r.version === version)
        .map((r) => r.recordMs)
        .sort((a, b) => a - b)[1],
    })),
  };
  await writeFile(
    folder + "ux-comparison.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}

import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
const { chromium } = await import(
  pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
);
const browser = await chromium.connectOverCDP(process.env.CDP_URL);
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "ko-KR",
});
const page = await context.newPage();
page.setDefaultTimeout(8000);
const base = process.env.APP_URL || "http://127.0.0.1:4174";
const root = fileURLToPath(new URL("../test-results/", import.meta.url));
await mkdir(root, { recursive: true });
const errors = [],
  checks = [];
page.on("pageerror", (err) => errors.push(err.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
const role = (value) =>
  page.getByLabel("사용자 역할", { exact: true }).selectOption(value);
const nav = (name) =>
  page
    .getByRole("navigation", {
      name: page.viewportSize().width <= 640 ? "모바일 메뉴" : "주요 메뉴",
      exact: true,
    })
    .getByRole("button", { name, exact: true })
    .click();
const data = () =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("child-development-demo-v2")),
  );
const check = (label) => {
  checks.push(label);
  console.log("PASS " + label);
};
async function reveal(locator) {
  for (const details of await locator.locator("xpath=ancestor::details").all())
    if ((await details.getAttribute("open")) === null)
      await details.locator(":scope > summary").click();
}
async function fill(name, value) {
  const locator = page.locator(`#edit-form [name="${name}"]`);
  await reveal(locator);
  await locator.fill(value);
}
async function submit(name) {
  await page
    .locator("#edit-form")
    .getByRole("button", { name, exact: true })
    .click();
}
async function closed() {
  await page.locator("#dialog").waitFor({ state: "hidden" });
}
async function openChat(child = "c1") {
  await page.locator(`.conversation-row[data-id="${child}"]`).click();
  await page
    .getByLabel("소식 내용", { exact: true })
    .waitFor({ state: "visible" });
  await page.waitForFunction(
    () => !document.querySelector("#message-body").disabled,
  );
}
async function send(body) {
  await page.getByLabel("소식 내용", { exact: true }).fill(body);
  await page.getByRole("button", { name: "보내기", exact: true }).click();
  await page.waitForFunction(
    (body) =>
      JSON.parse(
        localStorage.getItem("child-development-demo-v2"),
      ).messages.some((m) => m.body === body),
    body,
  );
  await page.waitForFunction(
    () =>
      document.querySelector("#message-body")?.value === "" &&
      !document.querySelector("#message-body").disabled,
  );
}
try {
  await page.goto(base);
  await page.getByRole("heading", { name: "소식에서 다음 만남으로" }).waitFor();
  assert.equal(await page.locator(".conversation-row").count(), 2);
  assert.equal(await data(), null); // Home alone must not mark messages read.
  await page.screenshot({ path: root + "ux-home-desktop.png", fullPage: true });
  await role("guardian");
  assert.equal(await page.locator(".conversation-row").count(), 1);
  const target = await page
    .locator(".conversation-row")
    .getAttribute("data-message");
  await openChat();
  assert.equal(target, "publication-pub1");
  await page.waitForFunction(() =>
    JSON.parse(
      localStorage.getItem("child-development-demo-v2"),
    )?.readStates.some((r) => r.userId === "p1"),
  );
  assert.ok(!(await data()).readStates.some((r) => r.userId === "t1"));
  check("홈의 아이·메시지 연결과 사용자별 읽음 분리");
  const media = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 40;
    c.height = 40;
    c.getContext("2d").fillRect(0, 0, 40, 40);
    const png = await new Promise((resolve) => c.toBlob(resolve, "image/png"));
    const stream = c.captureStream(0);
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8",
    });
    const chunks = [];
    const finished = new Promise((resolve) => {
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
    });
    recorder.start();
    for (let i = 0; i < 8; i++) {
      c.getContext("2d").fillStyle = i % 2 ? "#4285ff" : "#75a9ff";
      c.getContext("2d").fillRect(0, 0, 40, 40);
      stream.getVideoTracks()[0].requestFrame();
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    recorder.stop();
    const video = await finished;
    stream.getTracks().forEach((track) => track.stop());
    return {
      png: [...new Uint8Array(await png.arrayBuffer())],
      video: [...new Uint8Array(await video.arrayBuffer())],
    };
  });
  const photo = {
    name: "가상-소식.png",
    mimeType: "image/png",
    buffer: Buffer.from(media.png),
  };
  const video = {
    name: "가상-소식.webm",
    mimeType: "video/webm",
    buffer: Buffer.from(media.video),
  };
  await page
    .getByRole("button", { name: "이 기록에 답하기", exact: true })
    .click();
  await page
    .locator("#chat-attachment-editor input[type=file]")
    .setInputFiles([photo, video]);
  await page.waitForFunction(
    () => !document.querySelector("#chat-attachment-editor input").disabled,
  );
  await send("가정에서 놀이를 골랐어요 <script>not-code</script>");
  const parentMessage = (await data()).messages.at(-1);
  assert.equal(parentMessage.replyTo, "publication-pub1");
  assert.equal(parentMessage.attachments.length, 2);
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector(".chat-message img")?.naturalWidth > 0,
  );
  assert.equal(await page.locator(".chat-message script").count(), 0);
  await page.locator(".chat-message video").evaluate(async (video) => {
    video.muted = true;
    await video.play();
  });
  await page.waitForFunction(
    () => document.querySelector(".chat-message video")?.currentTime > 0,
  );
  await page.locator(".chat-message video").evaluate((video) => video.pause());
  check("공유본 답변·사진/영상 재생·원문 인용·새로고침 복원·이스케이프");
  await role("therapist");
  assert.ok(
    (await page.locator(".news-panel").innerText()).includes("새 소식 1"),
  );
  await openChat();
  const parentCard = page.locator(`[data-message-id="${parentMessage.id}"]`);
  await parentCard.getByRole("button", { name: "답하기", exact: true }).click();
  await send("보내주신 소식을 다음 시간에 함께 살펴볼게요.");
  await parentCard
    .getByRole("button", { name: "반영 메모", exact: true })
    .click();
  await fill("reviewNote", "PRIVATE CLINICAL MEMO");
  await submit("확인하고 저장");
  await closed();
  await parentCard
    .getByRole("button", { name: "기록에 참고", exact: true })
    .click();
  assert.ok(
    (await page.locator(".reference-note").innerText()).includes(
      "가정에서 놀이",
    ),
  );
  await page.getByRole("button", { name: "원문 보기", exact: true }).click();
  await page.locator(".reference-original img").waitFor();
  await fill("performed", "두 가지 놀이를 제시하고 선택하도록 진행");
  await fill("response", "손으로 가리키며 선택하는 모습을 관찰");
  await fill("nextPlan", "PRIVATE NEXT PLAN");
  await fill("privateNote", "PRIVATE RECORD NOTE");
  await fill("title", "소통에서 이어진 세션");
  await fill("summary", "스스로 고른 놀이를 함께 이어갔어요.");
  await page
    .locator("#dialog summary")
    .filter({ hasText: /^상세 관찰·측정값$/ })
    .click();
  await page.locator("[name=observation-status]").selectOption("observed");
  await fill("observation-task", "놀이 선택");
  for (let i = 0; i < 2; i++) {
    await page
      .getByRole("button", { name: "측정값 추가", exact: true })
      .click();
    for (const [key, value] of Object.entries({
      tool: "직접 관찰",
      item: i ? "시간" : "횟수",
      value: i ? "3" : "0",
      unit: i ? "분" : "회",
      context: "동일한 놀이 공간",
    }))
      await fill(`assessment-${i}-${key}`, value);
  }
  await page.screenshot({
    path: root + "ux-record-desktop.png",
    fullPage: true,
  });
  await submit("보호자 공유 준비");
  await page.getByRole("heading", { name: "보호자에게 보이는 내용" }).waitFor();
  assert.ok(
    (await page.locator("#dialog").innerText()).includes(
      "하루의 연결된 보호자",
    ),
  );
  assert.ok(!(await page.locator("#dialog").innerText()).includes("PRIVATE"));
  await submit("보호자에게 공유");
  await closed();
  const record = (await data()).records.at(-1);
  assert.equal(record.assessments.length, 2);
  assert.equal(record.assessments[0].value, 0);
  assert.deepEqual(record.referenceMessageIds, [parentMessage.id]);
  check("공개 답변·내부 반영·참고 대화→3항목·복수 평가→수신자 미리보기→공유");
  await role("guardian");
  await openChat();
  assert.ok(
    (await page.locator(".chat-log").innerText()).includes("보내주신 소식을"),
  );
  assert.ok(!(await page.locator("body").innerText()).includes("PRIVATE"));
  await page
    .locator(`[data-message-id="publication-${record.publicationId}"]`)
    .getByRole("button", { name: "이 기록에 답하기" })
    .click();
  await send("새 기록에 답한 소식");
  const linkedId = (await data()).messages.at(-1).id;
  await role("therapist");
  await nav("기록");
  let card = page.locator(".record-card").filter({
    has: page.getByRole("heading", {
      name: "소통에서 이어진 세션",
      exact: true,
    }),
  });
  await card.getByRole("button", { name: "수정", exact: true }).click();
  await fill("summary", "재공유한 새 요약");
  await submit("기록 저장");
  await closed();
  await card.getByRole("button", { name: "공유 미리보기" }).click();
  await submit("수정 내용 공유하기");
  await closed();
  await role("guardian");
  await openChat();
  assert.ok(
    (
      await page
        .locator(`[data-message-id="publication-${record.publicationId}"]`)
        .innerText()
    ).includes("공유가 종료"),
  );
  assert.equal(
    await page
      .locator(`[data-message-id="publication-${record.publicationId}"] button`)
      .count(),
    0,
  );
  assert.ok(
    (
      await page.locator(`[data-message-id="${linkedId}"]`).innerText()
    ).includes("새 기록에 답한 소식"),
  );
  await role("therapist");
  await nav("기록");
  await card.getByRole("button", { name: "공유 철회", exact: true }).click();
  await submit("공유 철회");
  await closed();
  await role("guardian");
  await openChat();
  await page.reload();
  assert.ok(
    !(await page.locator(".chat-log").innerText()).includes("재공유한 새 요약"),
  );
  assert.ok(
    (await page.locator(".chat-log").innerText()).includes(
      "새 기록에 답한 소식",
    ),
  );
  check("재공유·철회·새로고침 시 공유본 비노출과 당시 답변 보존");
  await role("therapist");
  await openChat();
  await page
    .getByLabel("소식 내용", { exact: true })
    .fill("하루 방 미전송 초안");
  await page
    .locator("#chat-attachment-editor input[type=file]")
    .setInputFiles(photo);
  await page.waitForFunction(
    () => !document.querySelector("#chat-attachment-editor input").disabled,
  );
  await openChat("c2");
  assert.equal(
    await page.getByLabel("소식 내용", { exact: true }).inputValue(),
    "",
  );
  await page
    .getByLabel("소식 내용", { exact: true })
    .fill("나무 방 미전송 초안");
  await openChat("c1");
  assert.equal(
    await page.getByLabel("소식 내용", { exact: true }).inputValue(),
    "하루 방 미전송 초안",
  );
  assert.equal(
    await page.locator("#chat-attachment-editor .attachment-row").count(),
    1,
  );
  await page.reload();
  await page.waitForFunction(
    () =>
      document.querySelector("#message-body")?.value === "하루 방 미전송 초안",
  );
  assert.equal(
    await page.locator("#chat-attachment-editor .attachment-row").count(),
    1,
  );
  await page.evaluate(() => {
    window.originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "child-development-demo-v2")
        throw new DOMException("quota", "QuotaExceededError");
      return window.originalSet.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "보내기", exact: true }).click();
  await page.locator("#chat-error:not([hidden])").waitFor();
  assert.equal(
    await page.getByLabel("소식 내용", { exact: true }).inputValue(),
    "하루 방 미전송 초안",
  );
  assert.equal(
    await page.locator("#chat-attachment-editor .attachment-row").count(),
    1,
  );
  await page.evaluate(() => {
    Storage.prototype.setItem = window.originalSet;
  });
  await page.getByRole("button", { name: "보내기", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("#message-body")?.value === "",
  );
  const sent = (await data()).messages.filter(
    (m) => m.body === "하루 방 미전송 초안",
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].childId, "c1");
  assert.equal(sent[0].attachments.length, 1);
  await openChat("c2");
  assert.equal(
    await page.getByLabel("소식 내용", { exact: true }).inputValue(),
    "나무 방 미전송 초안",
  );
  check(
    "대화별 텍스트·사진 초안의 방 전환·새로고침 보존과 실패 재시도 1회 발신",
  );
  await nav("기록");
  await page.getByLabel("선택한 아동", { exact: true }).selectOption("c1");
  await page.getByRole("button", { name: "기록 작성", exact: true }).click();
  await submit("초안 저장");
  await closed();
  await nav("홈");
  assert.equal(
    await page.getByRole("button", { name: "이어 쓰기", exact: true }).count(),
    1,
  );
  check("빈 초안 저장과 홈의 이어 쓰기");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const r of ["therapist", "guardian", "center"]) {
      await role(r);
      for (const name of r === "center"
        ? ["운영 현황", "아동", "일정"]
        : ["홈", "대화", "기록", "아이 정보"]) {
        await nav(name);
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          `${width} ${r} ${name} overflow`,
        );
      }
    }
    await role("guardian");
    await openChat();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.getByLabel("소식 내용", { exact: true }).focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(":focus").innerText(), "＋ 사진·동영상");
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(":focus").innerText(), "보내기");
    await page.screenshot({
      path: root + `ux-chat-${width}.png`,
      fullPage: true,
    });
  }
  check(
    "320/390px 전 역할 주요 화면·대화 가로 넘침 없음, 키보드 첨부→보내기 접근",
  );
  await page.setViewportSize({ width: 390, height: 420 });
  await page.getByLabel("소식 내용", { exact: true }).focus();
  const composeBounds = await page
    .getByRole("button", { name: "보내기", exact: true })
    .boundingBox();
  const navBounds = await page
    .getByRole("navigation", { name: "모바일 메뉴", exact: true })
    .boundingBox();
  assert.ok(
    composeBounds.y >= 0 &&
      composeBounds.y + composeBounds.height <= navBounds.y,
    "축소된 뷰포트에서도 보내기 버튼이 하단 메뉴에 가려지지 않아야 합니다.",
  );
  await page.screenshot({
    path: root + "ux-keyboard-viewport.png",
    fullPage: true,
  });
  check(
    "높이 420px의 축소 뷰포트에서도 입력·보내기 접근 유지(실물 키보드 테스트는 별도)",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await role("therapist");
  await openChat();
  await page.screenshot({ path: root + "ux-chat-desktop.png", fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(
    root + "communication-results.json",
    JSON.stringify(
      { passed: true, at: new Date().toISOString(), checks, errors },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  await page
    .screenshot({ path: root + "communication-failure.png", fullPage: true })
    .catch(() => {});
  console.error(error);
  console.error("Page errors:", errors);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}

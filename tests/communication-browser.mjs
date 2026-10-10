import assert from "node:assert/strict";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { syntheticMedia } from "./browser-media.mjs";
import { messageBrowserConnection } from "./message-browser-policy.mjs";
const { chromium } = await import(
  pathToFileURL(process.env.PLAYWRIGHT_MODULE).href
);
const connection = messageBrowserConnection({ wsEndpoint: process.env.PLAYWRIGHT_WS_ENDPOINT, cdpUrl: process.env.CDP_URL });
const browser = connection.kind === "playwright" ? await chromium.connect(connection.url) : await chromium.connectOverCDP(connection.url);
const width = Number(process.env.TEST_VIEWPORT_WIDTH || 1440);
const height = Number(process.env.TEST_VIEWPORT_HEIGHT || 1000);
assert.ok(Number.isInteger(width) && width >= 320 && width <= 1920);
assert.ok(Number.isInteger(height) && height >= 420 && height <= 1200);
const suffix = process.env.TEST_VIEWPORT_WIDTH ? `-${width}` : "";
const context = await browser.newContext({
  viewport: { width, height },
  isMobile: width <= 640,
  hasTouch: width <= 640,
  locale: "ko-KR",
});
const page = await context.newPage();
page.setDefaultTimeout(8000);
const base = process.env.APP_URL || "http://127.0.0.1:4174";
const root = fileURLToPath(new URL("../test-results/", import.meta.url));
await mkdir(root, { recursive: true });
const errors = [],
  checks = [],
  requirements = new Set(),
  unexpectedRequests = [];
page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.origin !== new URL(base).origin || url.pathname.startsWith("/api/"))
    unexpectedRequests.push(request.url());
});
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
const check = (label, ...ids) => {
  checks.push(label);
  ids.forEach((id) => requirements.add(id));
  console.log(`PASS ${width}px ${label}`);
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
  // Mobile rooms intentionally hide the list. Use the user's back path,
  // never a forced click on a hidden conversation row.
  const row = page.locator(`.conversation-row[data-id="${child}"]`);
  if (!(await row.isVisible()))
    await page.getByRole("button", { name: "‹ 목록", exact: true }).click();
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
async function storedDraft(child = "c1") {
  return page.evaluate(async (child) => {
    const opened = indexedDB.open("carebridge-chat-drafts-v1", 1);
    const db = await new Promise((resolve, reject) => {
      opened.onsuccess = () => resolve(opened.result);
      opened.onerror = () => reject(new Error("Synthetic draft read failed"));
    });
    try {
      const tx = db.transaction("drafts");
      const request = tx
        .objectStore("drafts")
        .get(`${sessionStorage.getItem("carebridge-draft-tab")}/t1/${child}`);
      const draft = await new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () =>
          reject(new Error("Synthetic draft transaction failed"));
      });
      return draft
        ? {
            clientId: draft.clientId,
            body: draft.body,
            replyTo: draft.replyTo,
            attachments: draft.attachments,
            files: await Promise.all(
              draft.entries.map(async ([id, blob]) => ({
                id,
                type: blob.type,
                bytes: [...new Uint8Array(await blob.arrayBuffer())],
              })),
            ),
          }
        : null;
    } finally {
      db.close();
    }
  }, child);
}
async function storedFile(id) {
  return page.evaluate(async (id) => {
    const { MediaStore } = await import("/src/media-store.js");
    const store = new MediaStore();
    const blob = await store.read(id);
    const result = blob
      ? {
          type: blob.type,
          bytes: [...new Uint8Array(await blob.arrayBuffer())],
        }
      : null;
    (await store.open()).close();
    return result;
  }, id);
}
async function chooseRecordFiles(files) {
  const input = page.locator("#edit-form input[type=file]");
  await reveal(input);
  await input.setInputFiles(files);
  await page.waitForFunction(
    () => !document.querySelector("#edit-form input[type=file]").disabled,
  );
}
async function chooseChatFiles(files) {
  if ((await page.locator("#chat-files").getAttribute("open")) === null)
    await page
      .getByRole("button", { name: "＋ 사진·동영상", exact: true })
      .click();
  await page
    .locator("#chat-attachment-editor input[type=file]")
    .setInputFiles(files);
  await page.waitForFunction(
    () => !document.querySelector("#chat-attachment-editor input").disabled,
  );
}
let failure = null;
try {
  await page.goto(base);
  await page.getByRole("heading", { name: "소식에서 다음 만남으로" }).waitFor();
  assert.equal(await page.locator(".conversation-row").count(), 2);
  assert.equal(await data(), null); // Home alone must not mark messages read.
  await page.screenshot({
    path: root + `ux-home${suffix || "-desktop"}.png`,
    fullPage: true,
  });
  await role("guardian");
  assert.equal(await page.locator(".conversation-row").count(), 1);
  const target = await page
    .locator(".conversation-row")
    .getAttribute("data-message");
  await openChat();
  assert.equal(target, "publication-pub1");
  assert.equal(
    await page.getByRole("region", { name: "하루 대화", exact: true }).count(),
    1,
  );
  assert.equal(
    await page.locator(`[data-message-id="${target}"].highlight`).count(),
    1,
  );
  await page.waitForFunction(() =>
    JSON.parse(
      localStorage.getItem("child-development-demo-v2"),
    )?.readStates.some((r) => r.userId === "p1"),
  );
  assert.ok(!(await data()).readStates.some((r) => r.userId === "t1"));
  check("홈의 아이·메시지 연결과 사용자별 읽음 분리", 1);
  const media = await syntheticMedia(page);
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
  // All data below lives in this fresh context. Start from an actual v2 JSON
  // record plus an IndexedDB blob, rather than proving preservation by IDs alone.
  const legacy = await page.evaluate(async (bytes) => {
    const { seed } = await import("/src/seed.js");
    const { MediaStore } = await import("/src/media-store.js");
    const source = seed();
    source.records[1].assessment.value = 0;
    const file = {
      id: crypto.randomUUID(),
      name: "가상-기존첨부.png",
      type: "image/png",
      size: bytes.length,
      share: true,
    };
    source.records[0].attachments = [file];
    source.publications[0].attachments = [file];
    const store = new MediaStore();
    await store.write([
      [file.id, new Blob([new Uint8Array(bytes)], { type: file.type })],
    ]);
    (await store.open()).close();
    const raw = JSON.stringify(source);
    localStorage.setItem("child-development-demo-v2", raw);
    return {
      raw,
      records: source.records,
      publications: source.publications,
      file,
    };
  }, media.png);
  await page.reload();
  await page.waitForFunction(
    () =>
      document.querySelector("#message-body") &&
      !document.querySelector("#message-body").disabled,
  );
  assert.equal((await data()).schema, 3);
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem("child-development-demo-v2-backup-schema-2"),
    ),
    legacy.raw,
  );
  assert.equal(
    await page
      .getByRole("region", { name: "하루 대화", exact: true })
      .isVisible(),
    true,
  );
  await page
    .getByRole("button", { name: "활동 경험 남기기", exact: true })
    .click();
  await page.locator("[name=result]").selectOption("partial");
  await fill("reaction", "가상 가정 활동에서 놀이를 골랐어요.");
  await fill("difficulty", "가상 경험: 활동을 오래 이어가기 어려웠어요.");
  await submit("경험 전달하기");
  await closed();
  const feedback = (await data()).feedback.at(-1);
  assert.equal(
    (await data()).messages.filter((m) => m.sourceId === feedback.id).length,
    1,
  );
  assert.equal(
    (await data()).records.length,
    2,
    "활동 경험도 임상 기록으로 자동 등록하지 않는다.",
  );
  await page
    .getByRole("button", { name: "이 기록에 답하기", exact: true })
    .click();
  await chooseChatFiles([photo, video]);
  await send("가정에서 놀이를 골랐어요 <script>not-code</script>");
  const parentMessage = (await data()).messages.at(-1);
  assert.equal(parentMessage.replyTo, "publication-pub1");
  assert.equal(parentMessage.attachments.length, 2);
  assert.equal(
    (await data()).records.length,
    2,
    "일반 답변·첨부는 임상 기록이 아니다.",
  );
  await page.reload();
  await page
    .locator(`[data-message-id="${parentMessage.id}"] img`)
    .scrollIntoViewIfNeeded();
  await page.waitForFunction(
    (id) =>
      document.querySelector(`[data-message-id="${id}"] img`)?.naturalWidth > 0,
    parentMessage.id,
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
    (await page.locator(".news-panel").innerText()).includes("새 소식 2"),
  );
  await openChat();
  assert.equal(
    (await data()).feedback.find((f) => f.id === feedback.id).reviewed,
    false,
  );
  assert.equal(
    (await data()).messages.find((m) => m.id === parentMessage.id).reviewed,
    undefined,
    "열람은 임상 반영 확인이 아니다.",
  );
  await page
    .locator(`[data-message-id="feedback-${feedback.id}"]`)
    .getByRole("button", { name: "반영 메모", exact: true })
    .click();
  await fill("reviewNote", "PRIVATE ACTIVITY REVIEW");
  await submit("확인하고 저장");
  await closed();
  assert.equal(
    (await data()).feedback.find((f) => f.id === feedback.id).reviewed,
    true,
  );
  assert.equal(
    (await data()).messages.filter((m) => m.sourceId === feedback.id).length,
    1,
  );
  check("활동 카드→보호자 경험→대화 카드 1개→치료사의 명시적 반영 확인");
  const parentCard = page.locator(`[data-message-id="${parentMessage.id}"]`);
  await parentCard.getByRole("button", { name: "답하기", exact: true }).click();
  await send("보내주신 소식을 다음 시간에 함께 살펴볼게요.");
  await parentCard
    .getByRole("button", { name: "반영 메모", exact: true })
    .click();
  await fill("reviewNote", "PRIVATE CLINICAL MEMO");
  await submit("확인하고 저장");
  await closed();
  assert.equal(
    (await data()).messages.find((m) => m.id === parentMessage.id).reviewNote,
    "PRIVATE CLINICAL MEMO",
  );
  await parentCard
    .getByRole("button", { name: "기록에 참고", exact: true })
    .click();
  assert.ok(
    (await page.locator(".reference-note").innerText()).includes(
      "가정에서 놀이",
    ),
  );
  await page.getByRole("button", { name: "원문 보기", exact: true }).click();
  await page.locator(".reference-original img").scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () => document.querySelector(".reference-original img")?.naturalWidth > 0,
  );
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
  await chooseRecordFiles([
    { ...photo, name: "가상-공유선택.png" },
    { ...video, name: "가상-내부전용.webm" },
  ]);
  assert.equal(
    await page.locator("#edit-form [data-share-media]:checked").count(),
    0,
  );
  await page.locator("#edit-form [data-share-media]").first().check();
  await page.screenshot({
    path: root + `ux-record${suffix || "-desktop"}.png`,
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
  const preview = page.locator(".share-preview");
  assert.equal(await preview.locator("[data-media-id]").count(), 1);
  assert.ok((await preview.innerText()).includes("가상-공유선택.png"));
  assert.ok(!(await preview.innerText()).includes("가상-내부전용.webm"));
  await preview.locator("img").scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () => document.querySelector(".share-preview img")?.naturalWidth > 0,
  );
  await page.screenshot({
    path: root + `ux-share-preview${suffix}.png`,
    fullPage: true,
  });
  await submit("보호자에게 공유");
  await closed();
  const record = (await data()).records.at(-1);
  assert.equal(record.assessments.length, 2);
  assert.equal(record.assessments[0].value, 0);
  assert.equal(record.assessments[1].unit, "분");
  assert.equal(record.attachments.length, 2);
  assert.deepEqual(record.referenceMessageIds, [parentMessage.id]);
  check(
    "공개 답변·내부 반영·참고 대화→3항목·복수 평가→수신자/선택 첨부 미리보기→공유",
    3,
  );
  await role("guardian");
  await openChat();
  assert.ok(
    (await page.locator(".chat-log").innerText()).includes("보내주신 소식을"),
  );
  assert.ok(!(await page.locator("body").innerText()).includes("PRIVATE"));
  const sharedCard = page.locator(
    `[data-message-id="publication-${record.publicationId}"]`,
  );
  assert.equal(await sharedCard.locator("[data-media-id]").count(), 1);
  assert.equal(await sharedCard.locator("video").count(), 0);
  assert.ok(!(await sharedCard.innerText()).includes("가상-내부전용"));
  check("보호자 답변·사진/영상·공개 답변과 내부 임상 계획 비노출", 2);
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
  await role("guardian");
  await openChat();
  assert.ok(
    (await sharedCard.innerText()).includes(record.summary),
    "내부 수정만으로 기존 공유본을 바꾸지 않는다.",
  );
  assert.ok(!(await sharedCard.innerText()).includes("재공유한 새 요약"));
  await role("therapist");
  await nav("기록");
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
  assert.equal(await sharedCard.locator("[data-media-id]").count(), 0);
  assert.ok(
    (
      await page.locator(`[data-message-id="${linkedId}"]`).innerText()
    ).includes("새 기록에 답한 소식"),
  );
  assert.equal(
    (await data()).messages.find((m) => m.id === linkedId).replyTo,
    `publication-${record.publicationId}`,
  );
  assert.deepEqual(
    (await data()).publications.find((p) => p.id === record.publicationId)
      .attachments,
    record.attachments.filter((file) => file.share),
  );
  for (const attachment of record.attachments) {
    assert.deepEqual(
      (await storedFile(attachment.id)).bytes,
      attachment.type.startsWith("image/") ? media.png : media.video,
    );
  }
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
  assert.deepEqual(
    (await storedFile(parentMessage.attachments[0].id)).bytes,
    media.png,
  );
  const preserved = await data();
  for (const original of legacy.records) {
    const current = preserved.records.find((r) => r.id === original.id);
    for (const [key, value] of Object.entries(original))
      assert.deepEqual(
        current[key],
        value,
        `기존 기록 ${original.id}.${key} 보존`,
      );
    assert.equal(current.format, "legacy");
    assert.equal(current.performed, "");
    assert.equal(current.response, "");
    assert.deepEqual(
      current.assessments,
      original.assessment ? [original.assessment] : [],
    );
  }
  for (const original of legacy.publications)
    assert.deepEqual(
      preserved.publications.find((p) => p.id === original.id),
      original,
    );
  assert.deepEqual((await storedFile(legacy.file.id)).bytes, media.png);
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem("child-development-demo-v2-backup-schema-2"),
    ),
    legacy.raw,
  );
  check("재공유·철회·새로고침과 v2 원문/백업·측정 0·ID/첨부 바이트 보존", 4);
  await role("therapist");
  await openChat();
  await page
    .getByLabel("소식 내용", { exact: true })
    .fill("하루 방 미전송 초안");
  await chooseChatFiles(photo);
  await page.waitForFunction(
    () => document.querySelector("#draft-status")?.dataset.state === "saved",
  );
  const originalDraft = await storedDraft();
  assert.deepEqual(originalDraft.files[0].bytes, media.png);
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
    await page
      .getByRole("region", { name: "하루 대화", exact: true })
      .isVisible(),
    true,
  );
  assert.deepEqual(await storedDraft(), originalDraft);
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
  assert.deepEqual(await storedDraft(), originalDraft);
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
  assert.equal(sent[0].id, originalDraft.clientId);
  assert.deepEqual(
    (await storedFile(sent[0].attachments[0].id)).bytes,
    media.png,
  );
  await openChat("c2");
  assert.equal(
    await page.getByLabel("소식 내용", { exact: true }).inputValue(),
    "나무 방 미전송 초안",
  );
  check(
    "대화별 텍스트·사진/발신 ID의 방 전환·새로고침 보존과 실패 재시도 1회 발신",
    5,
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
  for (const width of [page.viewportSize().width]) {
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
    if (width <= 640) {
      await page.getByRole("button", { name: "‹ 목록", exact: true }).click();
      await page.reload();
      assert.equal(await page.locator(".chat-list").isVisible(), true);
      assert.equal(await page.locator(".chat-room").isVisible(), false);
      await openChat();
    }
  }
  check(
    `${width}px 전 역할 주요 화면·대화 가로 넘침 없음, 키보드 첨부→보내기 접근`,
    6,
  );
  if (width <= 640) {
    await page.setViewportSize({ width, height: 420 });
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
      path: root + `ux-keyboard-viewport${suffix}.png`,
      fullPage: true,
    });
    check(
      "높이 420px의 축소 뷰포트에서도 입력·보내기 접근 유지(실물 키보드 테스트는 별도)",
    );
  }
  await page.setViewportSize({ width, height });
  await role("therapist");
  await openChat();
  await page.screenshot({
    path: root + `ux-chat${suffix || "-desktop"}.png`,
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    unexpectedRequests,
    [],
    "로컬 P0는 API/외부로 자료를 전송하지 않는다.",
  );
  assert.deepEqual([...requirements].sort(), [1, 2, 3, 4, 5, 6]);
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} catch (error) {
  failure = { name: error.name, message: error.message };
  await page
    .screenshot({
      path: root + `communication-failure${suffix}.png`,
      fullPage: true,
    })
    .catch(() => {});
  console.error(error);
  console.error("Page errors:", errors);
  process.exitCode = 1;
} finally {
  await writeFile(
    root + `communication-results${suffix}.json`,
    JSON.stringify(
      {
        passed: !failure,
        runId: process.env.TEST_RUN_ID || null,
        at: new Date().toISOString(),
        viewport: { width, height },
        checks,
        requirements: [...requirements].sort(),
        errors,
        unexpectedRequests,
        failure,
      },
      null,
      2,
    ),
  );
  await context.close();
  await browser.close();
}

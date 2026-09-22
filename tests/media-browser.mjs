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
page.setDefaultTimeout(10000);
const errors = [],
  checks = [];
page.on("pageerror", (error) => errors.push(error.message));
const root = fileURLToPath(new URL("../test-results/", import.meta.url));
await mkdir(root, { recursive: true });
const role = (value) =>
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
const save = async () => {
  await page.locator("#edit-form [type=submit]:not([name=intent])").click();
  await page.locator("#dialog").waitFor({ state: "hidden" });
};
const choose = async (files) => {
  await reveal(page.getByLabel("사진·동영상 선택", { exact: true }));
  await page
    .getByLabel("사진·동영상 선택", { exact: true })
    .setInputFiles(files);
  await page.waitForFunction(
    () => !document.querySelector("input[type=file]").disabled,
  );
};
const data = () =>
  page.evaluate(() =>
    JSON.parse(localStorage.getItem("child-development-demo-v2")),
  );
const mediaCount = () =>
  page.evaluate(async () => {
    const { MediaStore } = await import("/src/media-store.js");
    const db = await new MediaStore().open();
    return new Promise((resolve) => {
      const r = db.transaction("files").objectStore("files").count();
      r.onsuccess = () => resolve(r.result);
    });
  });
try {
  await page.goto(process.env.APP_URL || "http://127.0.0.1:4173/");
  assert.match(await page.title(), /^Carebridge/);
  const payload = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#4285ff";
    ctx.fillRect(0, 0, 160, 90);
    const png = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    const stream = canvas.captureStream(0);
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8",
    });
    const chunks = [];
    const recorded = new Promise((resolve) => {
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
    });
    recorder.start();
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? "#4285ff" : "#75a9ff";
      ctx.fillRect(0, 0, 160, 90);
      stream.getVideoTracks()[0].requestFrame();
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    recorder.stop();
    const video = await recorded;
    stream.getTracks().forEach((t) => t.stop());
    return {
      png: [...new Uint8Array(await png.arrayBuffer())],
      video: [...new Uint8Array(await video.arrayBuffer())],
    };
  });
  const photo = {
    name: "가상-사진.png",
    mimeType: "image/png",
    buffer: Buffer.from(payload.png),
  };
  const video = {
    name: "가상-영상.webm",
    mimeType: "video/webm",
    buffer: Buffer.from(payload.video),
  };
  await nav("기록");
  await page.getByRole("button", { name: "기록 작성", exact: true }).click();
  await fill("title", "미디어 검증 기록");
  await fill("summary", "가상 관찰 내용");
  await choose([photo, video]);
  assert.equal(await page.locator(".attachment-row").count(), 2);
  await page.locator("#dialog .attachment-list").scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () =>
      document.querySelector("#dialog img")?.naturalWidth > 0 &&
      document.querySelector("#dialog video")?.readyState >= 1,
  );
  await page.locator("#dialog video").evaluate(async (video) => {
    video.muted = true;
    await video.play();
  });
  await page.waitForFunction(
    () => document.querySelector("#dialog video")?.currentTime > 0,
  );
  await page.locator("#dialog video").evaluate((video) => video.pause());
  await page.locator("[data-share-media]").first().check();
  await page.screenshot({
    path: root + "media-editor-desktop.png",
    fullPage: true,
  });
  await save();
  await page.reload();
  let db = await data();
  const recordId = db.records.at(-1).id;
  assert.equal(db.records.at(-1).attachments.length, 2);
  assert.equal(await mediaCount(), 2);
  const card = () =>
    page.locator(".record-card").filter({
      has: page.getByRole("heading", {
        name: "미디어 검증 기록",
        exact: true,
      }),
    });
  await page.waitForFunction(
    () => document.querySelector(".record-card video")?.readyState >= 1,
  );
  checks.push("이름·사진/동영상 선택·미리보기·IndexedDB 저장·새로고침 유지");
  await card()
    .getByRole("button", { name: "공유 미리보기", exact: true })
    .click();
  assert.equal(await page.locator("#dialog [data-media-id]").count(), 1);
  await save();
  await role("guardian");
  await nav("공유 기록");
  assert.equal(await card().locator("img").count(), 1);
  assert.equal(await card().locator("video").count(), 0);
  checks.push("보호자 공유 미리보기 및 비공유 영상 제외");
  await role("therapist");
  await nav("기록");
  await card().getByRole("button", { name: "수정", exact: true }).click();
  await page.locator("[data-remove-media]").first().click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "취소", exact: true }).click();
  assert.equal(
    (await data()).records.find((r) => r.id === recordId).attachments.length,
    2,
  );
  await card().getByRole("button", { name: "수정", exact: true }).click();
  await page.locator("[data-remove-media]").first().click();
  await save();
  await role("guardian");
  await nav("공유 기록");
  await card().locator("img").waitFor();
  assert.equal(await mediaCount(), 2);
  checks.push("첨부 제거 취소 및 초안 수정 후 기존 공유본 보존");
  await nav("가정 활동");
  await page
    .getByRole("button", { name: "활동 경험 남기기", exact: true })
    .first()
    .click();
  await fill("reaction", "가상 가족 경험");
  await choose([photo, video]);
  await save();
  await role("therapist");
  await nav("가정 활동");
  const feedback = page
    .locator(".feedback-card")
    .filter({ hasText: "가상 가족 경험" });
  await feedback.locator("video").waitFor();
  assert.equal(await feedback.locator("img").count(), 1);
  await page.reload();
  await feedback.locator("video").waitFor();
  checks.push("보호자 사진/영상 피드백 저장 및 치료사 확인");
  await nav("기록");
  await page.getByRole("button", { name: "기록 작성", exact: true }).click();
  await fill("title", "실패 후 재시도");
  await fill("summary", "보존 검사");
  await choose([
    {
      name: "잘못된.png",
      mimeType: "image/png",
      buffer: Buffer.from("not an image"),
    },
  ]);
  assert.match(await page.locator(".attachment-message").innerText(), /형식/);
  assert.equal(await page.locator(".attachment-row").count(), 0);
  await choose(Array.from({ length: 7 }, () => photo));
  assert.match(await page.locator(".attachment-message").innerText(), /6개/);
  await choose([
    {
      name: "unsupported.svg",
      mimeType: "image/svg+xml",
      buffer: Buffer.from("<svg/>"),
    },
  ]);
  assert.equal(await page.locator(".attachment-row").count(), 0);
  await choose([
    {
      name: "large.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(10 * 1024 ** 2 + 1),
    },
  ]);
  assert.equal(await page.locator(".attachment-row").count(), 0);
  await choose([photo]);
  checks.push("잘못된 형식·지원 외 파일·용량·개수 제한");
  const countBefore = await mediaCount(),
    revisionBefore = (await data()).revision;
  await page.evaluate(async () => {
    const { MediaStore } = await import("/src/media-store.js");
    window.originalWrite = MediaStore.prototype.write;
    MediaStore.prototype.write = async () => {
      throw new Error("테스트 저장공간 부족");
    };
  });
  await page.locator("#edit-form [type=submit]:not([name=intent])").click();
  await page.locator("#form-error").waitFor();
  assert.match(await page.locator("#form-error").innerText(), /저장공간/);
  assert.equal((await data()).revision, revisionBefore);
  assert.equal(await page.locator(".attachment-row").count(), 1);
  await page.evaluate(async () => {
    const { MediaStore } = await import("/src/media-store.js");
    MediaStore.prototype.write = window.originalWrite;
    window.originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) {
      if (k === "child-development-demo-v2")
        throw new Error("테스트 metadata quota");
      return window.originalSet.call(this, k, v);
    };
  });
  await page.locator("#edit-form [type=submit]:not([name=intent])").click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#edit-form [type=submit]:not([name=intent])")
        .disabled,
  );
  assert.equal(await mediaCount(), countBefore);
  assert.equal((await data()).revision, revisionBefore);
  await page.evaluate(() => {
    Storage.prototype.setItem = window.originalSet;
  });
  await save();
  assert.equal(await mediaCount(), countBefore + 1);
  checks.push("파일 및 기록 저장 실패 시 입력 유지·새 파일 롤백·재시도");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await nav("기록");
  await page.getByRole("button", { name: "기록 작성", exact: true }).click();
  await choose([photo, video]);
  await page.locator("#dialog .attachment-list").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: root + "media-editor-mobile.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.ok(
    await page
      .locator(".dialog-body")
      .evaluate((e) => e.scrollWidth <= e.clientWidth),
  );
  checks.push("390px 모바일 첨부 화면 가로 넘침 없음");
  assert.deepEqual(errors, []);
  await writeFile(
    root + "media-browser-results.json",
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(
    JSON.stringify({ passed: checks.length, checks, errors }, null, 2),
  );
} catch (error) {
  await page.screenshot({ path: root + "media-failure.png", fullPage: true });
  throw error;
} finally {
  await context.close();
  await browser.close();
}

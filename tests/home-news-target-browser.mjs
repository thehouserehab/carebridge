import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syntheticMedia } from "./browser-media.mjs";
import { messageBrowserConnection } from "./message-browser-policy.mjs";

assert.ok(process.env.PLAYWRIGHT_MODULE, "Use an owned test browser");
const connection = messageBrowserConnection({ wsEndpoint: process.env.PLAYWRIGHT_WS_ENDPOINT, cdpUrl: process.env.CDP_URL });
const base = new URL(process.env.APP_URL || "http://127.0.0.1:4176");
assert.ok(["http:", "https:"].includes(base.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "Synthetic loopback tests only");
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser = connection.kind === "playwright" ? await chromium.connect(connection.url) : await chromium.connectOverCDP(connection.url);
const folder = fileURLToPath(new URL("../test-results/", import.meta.url));
await mkdir(folder, { recursive: true });
const runId = crypto.randomUUID(), checks = [], errors = [], unexpectedRequests = [], screenshots = [];
const runFolder = `${folder}/home-news-target-${runId}`;
await mkdir(runFolder);
let failure = null;
async function observe(context, page) {
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await context.route("**/*", (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === base.origin && ["GET", "HEAD"].includes(request.method()) && !url.pathname.startsWith("/api/"))
      return route.continue();
    unexpectedRequests.push({ sameOrigin: url.origin === base.origin, method: request.method() });
    return route.abort();
  });
}
async function capture(page, width, flow) {
  const filename = `${width}-${flow}.png`;
  await page.screenshot({ path: `${runFolder}/${filename}`, fullPage: true });
  screenshots.push({ width, flow, filename, syntheticOnly: true });
}
try {
  for (const width of [1440, 390, 320]) {
    for (const ownLatest of [false, true]) {
      const context = await browser.newContext({
        viewport: { width, height: width === 1440 ? 1000 : width === 390 ? 844 : 720 },
        isMobile: width <= 640, hasTouch: width <= 640, locale: "ko-KR",
        serviceWorkers: "block", permissions: [],
      });
      try {
        const page = await context.newPage();
        await observe(context, page);
        await page.goto(base.href);
        await page.getByRole("heading", { name: "소식에서 다음 만남으로", exact: true }).waitFor();
        // Only seed this new, non-persistent context. Never touch the user's tab.
        const fixture = await page.evaluate(async (ownLatest) => {
          const { seed } = await import("/src/seed.js");
          const { upgradeState } = await import("/src/conversations.js");
          const { mutate } = await import("/src/domain.js");
          let db = upgradeState(seed());
          const send = (actor, childId, body) => {
            const id = crypto.randomUUID();
            db = mutate(db, actor, "message", { childId, clientId: id, body, attachments: [] });
            return id;
          };
          const firstId = send({ id: "p1", role: "guardian" }, "c1", "가상 첫 번째 미확인 소식");
          const incomingId = send({ id: "p1", role: "guardian" }, "c1", "가상 두 번째 미확인 소식");
          send({ id: "p2", role: "guardian" }, "c2", "가상 다른 아이의 최근 소식");
          const targetId = ownLatest ? send({ id: "t1", role: "therapist" }, "c1", "가상 치료사의 최신 답변") : incomingId;
          const raw = JSON.stringify(db);
          localStorage.setItem("child-development-demo-v2", raw);
          return { firstId, targetId, raw, body: ownLatest ? "가상 치료사의 최신 답변" : "가상 두 번째 미확인 소식" };
        }, ownLatest);
        await page.reload();
        await page.bringToFront();
        await page.getByRole("heading", { name: "소식에서 다음 만남으로", exact: true }).waitFor();
        const rows = page.locator(".conversation-row");
        assert.equal(await rows.count(), 2);
        assert.equal(await rows.first().getAttribute("data-id"), ownLatest ? "c1" : "c2");
        const row = page.locator('.conversation-row[data-id="c1"]');
        assert.ok((await row.innerText()).includes(fixture.body));
        assert.equal(await row.getAttribute("data-message"), fixture.targetId);
        assert.equal(await row.locator(".unread").innerText(), "2");
        assert.equal(await page.evaluate(() => localStorage.getItem("child-development-demo-v2")), fixture.raw);
        await row.click();
        await page.waitForFunction(() => document.querySelector("#message-body") && !document.querySelector("#message-body").disabled);
        const target = page.locator(`[data-message-id="${fixture.targetId}"]`);
        assert.equal(await target.isVisible(), true);
        assert.equal(await target.evaluate((el) => el.classList.contains("highlight")), true);
        assert.equal(await page.locator(`[data-message-id="${fixture.firstId}"].highlight`).count(), 0);
        assert.equal(await page.getByRole("region", { name: "하루 대화", exact: true }).count(), 1);
        await page.waitForFunction(() => JSON.parse(localStorage.getItem("child-development-demo-v2")).readStates.some((r) => r.userId === "t1"));
        const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("child-development-demo-v2")));
        const before = JSON.parse(fixture.raw);
        for (const key of ["records", "publications", "feedback", "messages"]) assert.deepEqual(saved[key], before[key]);
        assert.equal(saved.readStates.some((r) => r.userId === "p1"), false);
        assert.equal(saved.readStates.some((r) => r.conversationId === "room-c2"), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
        await capture(page, width, ownLatest ? "own-reply-target" : "incoming-news-target");
        checks.push({ width, ownLatest, targetId: fixture.targetId, passed: true });
        console.log(`PASS ${width}px latest ${ownLatest ? "own reply" : "incoming news"} matches home target`);
      } finally {
        await context.close();
      }
    }
  }
  for (const width of [320, 390, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ko-KR",
      isMobile: width <= 640, hasTouch: width <= 640, serviceWorkers: "block", permissions: [] });
    try {
      const page = await context.newPage(); await observe(context, page);
      const data = () => page.evaluate(() => JSON.parse(localStorage.getItem("child-development-demo-v2")));
      const nav = (name) => page.getByRole("navigation", { name: width <= 640 ? "모바일 메뉴" : "주요 메뉴", exact: true })
        .getByRole("button", { name, exact: true }).click();
      const ready = () => page.waitForFunction(() => document.querySelector("#message-body") && !document.querySelector("#message-body").disabled);
      const message = (id) => page.locator(`[data-message-id="${id}"]`);
      const bytes = (ids) => page.evaluate(async (ids) => {
        const { MediaStore } = await import("/src/media-store.js"), store = new MediaStore();
        try { return await Promise.all(ids.map(async (id) => {
          const blob = await store.read(id);
          return { id, type: blob?.type, bytes: blob ? [...new Uint8Array(await blob.arrayBuffer())] : null };
        })); } finally { (await store.open()).close(); }
      }, ids);
      await page.goto(base.href);
      await page.getByRole("heading", { name: "소식에서 다음 만남으로", exact: true }).waitFor();
      await page.getByLabel("사용자 역할", { exact: true }).selectOption("guardian");
      await nav("대화");
      const guardianRoom = page.locator('.conversation-row[data-id="c1"]');
      if (await guardianRoom.isVisible()) await guardianRoom.click();
      await ready();
      const media = await syntheticMedia(page);
      await page.getByRole("button", { name: "＋ 사진·동영상", exact: true }).click();
      await page.locator('#chat-attachment-editor input[type="file"]').setInputFiles([
        { name: "가상-첨부전용-사진.png", mimeType: "image/png", buffer: Buffer.from(media.png) },
        { name: "가상-첨부전용-영상.webm", mimeType: "video/webm", buffer: Buffer.from(media.video) },
      ]);
      await page.waitForFunction(() => document.querySelectorAll("#chat-attachment-editor .attachment-row").length === 2 &&
        !document.querySelector('#chat-attachment-editor input[type="file"]').disabled);
      assert.equal(await page.getByLabel("소식 내용", { exact: true }).inputValue(), "");
      await page.getByRole("button", { name: "보내기", exact: true }).click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("child-development-demo-v2"))?.messages.some((m) =>
        m.authorId === "p1" && m.body === "" && m.attachments.length === 2 && m.attachments[0].name === "가상-첨부전용-사진.png"));
      await ready();
      const before = await data(), original = before.messages.at(-1), ids = original.attachments.map((file) => file.id);
      assert.equal(original.body, ""); assert.equal(original.authorId, "p1");
      const originalBytes = await bytes(ids);
      assert.deepEqual(originalBytes.map((file) => [file.type, file.bytes]), [["image/png", media.png], ["video/webm", media.video]]);
      await page.getByLabel("사용자 역할", { exact: true }).selectOption("therapist"); await nav("홈");
      const row = page.locator('.conversation-row[data-id="c1"]'), label = "사진 1장 · 동영상 1개";
      assert.equal(await row.locator(".conversation-summary > span").innerText(), label);
      assert.equal(await row.getAttribute("data-message"), original.id);
      await row.focus(); await page.keyboard.press("Enter"); await ready();
      assert.equal(await message(original.id).isVisible(), true);
      assert.equal(await message(original.id).evaluate((element) => element.classList.contains("highlight")), true);
      await message(original.id).getByRole("button", { name: "답하기", exact: true }).click();
      assert.equal(await page.locator("#reply-preview .reply-preview > span").innerText(), `답변할 소식 · ${label}`);
      const replyBody = `가상 첨부 전용 소식 답변 ${width}`;
      await page.getByLabel("소식 내용", { exact: true }).fill(replyBody);
      await page.getByRole("button", { name: "보내기", exact: true }).click();
      await page.waitForFunction((body) => JSON.parse(localStorage.getItem("child-development-demo-v2")).messages.some((m) => m.body === body), replyBody);
      await ready();
      const reply = (await data()).messages.find((m) => m.body === replyBody);
      assert.equal(reply.replyTo, original.id);
      const quoted = message(reply.id).getByRole("button", { name: label, exact: true });
      assert.equal(await quoted.getAttribute("data-id"), original.id);
      await quoted.focus(); await page.keyboard.press("Enter");
      assert.equal(await message(original.id).evaluate((element) => element === document.activeElement), true);
      await page.reload(); await ready();
      assert.equal(await message(reply.id).getByRole("button", { name: label, exact: true }).isVisible(), true);
      const after = await data();
      assert.deepEqual(after.messages.find((m) => m.id === original.id), original);
      assert.deepEqual(after.messages.filter((m) => m.id !== reply.id), before.messages);
      for (const key of ["records", "publications", "feedback"]) assert.deepEqual(after[key], before[key]);
      assert.deepEqual(await bytes(ids), originalBytes);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await capture(page, width, "attachment-only-home-reply-reload");
      checks.push({ width, attachmentOnly: true, targetId: original.id, replyId: reply.id, passed: true,
        flow: "synthetic PNG/WebM UI send → home label/target → reply preview → named quote/keyboard jump → reload → empty body and original bytes retained" });
      console.log(`PASS ${width}px attachment-only home and reply labels preserve source/bytes`);
    } finally { await context.close(); }
  }
  assert.equal(checks.length, 9);
  assert.equal(screenshots.length, 9);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedRequests, []);
} catch (error) {
  failure = { name: error.name, message: error.message };
  console.error(error);
  process.exitCode = 1;
} finally {
  const report = {
    runId, at: new Date().toISOString(), passed: !failure, checks, errors, unexpectedRequests, failure,
    screenshots: { directory: runFolder, items: screenshots, syntheticOnly: true },
    limitations: ["Synthetic local roles, no authentication/API/cross-device proof", "Chromium viewport emulation, not physical phones or human task times"],
  };
  await writeFile(`${runFolder}/results.json`, JSON.stringify(report, null, 2), { flag: "wx" });
  await writeFile(`${folder}/home-news-target-results.json`, JSON.stringify(report, null, 2));
  await browser.close();
}

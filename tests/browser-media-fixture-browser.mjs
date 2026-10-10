import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { syntheticMedia } from "./browser-media.mjs";
import { decodeSyntheticVideo, syntheticVideoBytes, SYNTHETIC_VIDEO } from "./browser-media-fixture.mjs";

assert.ok(process.env.PLAYWRIGHT_MODULE && process.env.CDP_URL, "Use an owned test browser");
const base = new URL(process.env.APP_URL);
assert.ok(["127.0.0.1", "[::1]"].includes(base.hostname), "Synthetic loopback tests only");
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const browser = await chromium.connectOverCDP(process.env.CDP_URL);
const folder = fileURLToPath(new URL("../test-results/", import.meta.url));
await mkdir(folder, { recursive: true });
const runId = crypto.randomUUID(), checks = [], errors = [], unexpectedRequests = [];
let failure = null;
try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "ko-KR" });
    try {
      // Recording is not the app feature under test and must not be required.
      await context.addInitScript(() => {
        Object.defineProperty(globalThis, "MediaRecorder", { value: undefined, configurable: true });
        HTMLCanvasElement.prototype.captureStream = () => { throw new Error("Unexpected live recording"); };
      });
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.origin !== base.origin || url.pathname.startsWith("/api/")) unexpectedRequests.push(request.url());
      });
      await page.goto(base.href);
      const media = await syntheticMedia(page);
      assert.deepEqual(Buffer.from(media.video), syntheticVideoBytes());
      assert.equal(media.decoded.width, 160); assert.equal(media.decoded.height, 90);
      assert.ok(Math.abs(media.decoded.duration - SYNTHETIC_VIDEO.duration) < 0.01);
      for (const end of [32, syntheticVideoBytes().indexOf(Buffer.from("1f43b675", "hex"))]) {
        assert.ok(end > 0);
        await assert.rejects(page.evaluate(decodeSyntheticVideo, media.video.slice(0, end)),
          /Synthetic video (is not decodable|decode timed out)/);
      }
      const after = await page.evaluate(decodeSyntheticVideo, media.video);
      assert.deepEqual(after, media.decoded, "A rejected decode must not poison the next complete decode");
      checks.push(`${width}px pinned VP8 decodes without a recorder; truncated/header-only rejected; healthy next decode`);
      console.log("PASS " + checks.at(-1));
    } finally { await context.close(); }
  }
  assert.equal(checks.length, 3); assert.deepEqual(errors, []); assert.deepEqual(unexpectedRequests, []);
} catch (error) {
  failure = { name: error.name, message: error.message }; console.error(error); process.exitCode = 1;
} finally {
  await writeFile(`${folder}/browser-media-fixture-results.json`, JSON.stringify({ runId, at: new Date().toISOString(),
    passed: !failure, checks, errors, unexpectedRequests, failure,
    limitations: ["Synthetic VP8 attachment fixture only; not camera recording, all codecs, physical devices, API or human usability"] }, null, 2));
  await browser.close();
}

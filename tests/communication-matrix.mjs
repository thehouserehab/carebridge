import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { messageBrowserConnection } from "./message-browser-policy.mjs";

// Each child creates a fresh, non-persistent browser context. It never adopts
// the user's open tab or storage. A failed viewport stops the matrix.
const root = fileURLToPath(new URL("../test-results/", import.meta.url));
const test = fileURLToPath(
  new URL("./communication-browser.mjs", import.meta.url),
);
const runId = crypto.randomUUID();
const viewports = [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
  { width: 320, height: 720 },
];
const results = [];
let failure = null;
await mkdir(root, { recursive: true });
try {
  assert.ok(process.env.PLAYWRIGHT_MODULE, "PLAYWRIGHT_MODULE is required");
  messageBrowserConnection({ wsEndpoint: process.env.PLAYWRIGHT_WS_ENDPOINT, cdpUrl: process.env.CDP_URL });
  const app = new URL(process.env.APP_URL || "http://127.0.0.1:4174");
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(app.hostname),
    "Run the synthetic P0 matrix against a loopback prototype, not production",
  );
  for (const viewport of viewports) {
    console.log(`VERIFY P0 full workflow ${viewport.width}x${viewport.height}`);
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [test], {
        stdio: "inherit",
        env: {
          ...process.env,
          TEST_VIEWPORT_WIDTH: String(viewport.width),
          TEST_VIEWPORT_HEIGHT: String(viewport.height),
          TEST_RUN_ID: runId,
        },
        timeout: 180000,
      });
      child.once("error", reject);
      child.once("close", (code, signal) => resolve(signal ? null : code));
    });
    const result = JSON.parse(
      await readFile(
        `${root}/communication-results-${viewport.width}.json`,
        "utf8",
      ),
    );
    assert.equal(
      result.runId,
      runId,
      "A stale result is not proof of this run",
    );
    results.push(result);
    assert.equal(exitCode, 0, `Workflow failed at ${viewport.width}px`);
    assert.equal(result.passed, true);
    assert.deepEqual(result.requirements, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.unexpectedRequests, []);
  }
  assert.equal(results.length, viewports.length);
  console.log("PASS P0 matrix: all six requirements at 1440/390/320px");
} catch (error) {
  failure = { name: error.name, message: error.message };
  console.error(error);
  process.exitCode = 1;
} finally {
  await writeFile(
    `${root}/communication-matrix-results.json`,
    JSON.stringify(
      {
        passed: !failure,
        runId,
        at: new Date().toISOString(),
        expectedViewports: viewports,
        results,
        failure,
        limitations: [
          "Synthetic roles/local browser storage only; no server/API proof",
          "Chromium emulation is not physical iOS/Android or a human usability study",
        ],
      },
      null,
      2,
    ),
  );
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { syntheticVideoBytes, SYNTHETIC_VIDEO } from "./browser-media-fixture.mjs";

test("test-only video has pinned provenance, exact bytes, WebM and VP8 content", () => {
  const bytes = syntheticVideoBytes();
  assert.equal(bytes.length, SYNTHETIC_VIDEO.size);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SYNTHETIC_VIDEO.sha256);
  assert.equal(bytes.subarray(0, 4).toString("hex"), "1a45dfa3");
  assert.ok(bytes.includes(Buffer.from("V_VP8")));
  assert.ok(bytes.includes(Buffer.from("1f43b675", "hex")));
  assert.equal(Object.isFrozen(SYNTHETIC_VIDEO), true);
  assert.ok(Number.isFinite(SYNTHETIC_VIDEO.duration) && SYNTHETIC_VIDEO.duration > 0);
  // These are fixture integrity checks; actual decoding is a browser check.
});

test("each synthetic video call owns its bytes instead of sharing mutable fixture memory", () => {
  const first = syntheticVideoBytes(), second = syntheticVideoBytes();
  assert.notEqual(first, second);
  assert.deepEqual(first, second);
  first.fill(0);
  assert.deepEqual(syntheticVideoBytes(), second);
});

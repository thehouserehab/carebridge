import assert from "node:assert/strict";
import { decodeSyntheticVideo, syntheticVideoBytes, SYNTHETIC_VIDEO } from "./browser-media-fixture.mjs";

export async function syntheticMedia(page) {
  await page.bringToFront();
  await page.waitForFunction(() => document.visibilityState === "visible", null, { timeout: 5000 });
  const video = [...syntheticVideoBytes()];
  const decoded = await page.evaluate(decodeSyntheticVideo, video);
  assert.equal(decoded.width, SYNTHETIC_VIDEO.width);
  assert.equal(decoded.height, SYNTHETIC_VIDEO.height);
  assert.ok(Number.isFinite(decoded.duration) && decoded.duration > 0,
    "The fixture must contain decoded frames and a finite positive duration");
  const png = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const context = canvas.getContext("2d");
    context.fillStyle = "#4285ff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Synthetic image generation failed");
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  return { png, video, decoded };
}

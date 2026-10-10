import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Test-only, self-generated alternating blue 160x90 canvas. No camera,
// microphone, person, user file, network fetch or external media licence.
// Generated once with Chromium 149.0.7827.55 VP8 MediaRecorder on 2026-10-08.
// The attachment tests exercise file delivery/decoding, not live recording.
// Eight requested frames at 10fps; actual browser-decoded duration below.
export const SYNTHETIC_VIDEO = Object.freeze({
  width: 160, height: 90, duration: 0.909143, size: 1101,
  sha256: "f22807c2d03a4ead3a68496512787adde61fa507e8ae7f8fdf47a7400ca22cdd",
});
const VIDEO_BASE64 = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAQdEU2bdLlNu4tTq4QVSalmU6yBbk27i1OrhBZUrmtTrIGTTbuLU6uEH0O2dVOsgcFNu4xTq4QcU7trU6yCBAvsrgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmoCrXsYMPQkBEiYREY0knTYCGQ2hyb21lV0GGQ2hyb21lFlSua6mup9eBAXPFh6CoWYds5qaDgQFV7oEBhoVWX1ZQOOCKsIGguoFaU8CBAR9DtnUBAAAAAAADPueBAKBAnKHXgQAAAFAGAJ0BKqAAWgAABwiFhYiZhIgBJBATrVAfwB/QEDZUtSc9ejLxHPXoy8Rz16MvEc9ejLxHPXoy8RygAP75Km//t8H8wZv/9vh//lPY4r6P/KBAdaHApr7ugQGluVAFAJ0BKqAAWgAARwiFhYiZhIgCAgAGKA8IdVSa7iHVUmu4h1VJruIdVSa7iHVUmu4hvAD+/7qDAKDdobqBAIIAkQMAABAJIADAAMW/oGAAINAAWAAsABYACwAFgAK/wP7Xlf/6CAE65wn/oIH/7ACGIvSf+vhgdaGbppnugQGllBECAAEQGAAYABhYL/QACICBAAAA+4EAoN2huoEA/QCRAwAAEAkgAMAAxb+gYAAg0ABYACwAFgALAAWAAr/A/vkqb/+3wfzBm//2+H/+U9jivo/8oEB1oZumme6BAaWUEQIAARAQABgAGFgv9AAIgIEAAAD7gYKg3aG6gQF3AJEDAAAQCSAAwADFv6BgACDQAFgALAAWAAsABYACv8D+15X/+ggBOucJ/6CB/+wAhiL0n/r4YHWhm6aZ7oEBpZQRAgABEAkgAMAAwsF/oABEBAgAAPuB/aDeobqBAf8AkQMAABAJIADAAMW/oGAAINAAWAAsABYACwAFgAK/wP75Km//t8H8wZv/9vh//lPY4r6P/KBAdaGbppnugQGllBECAAEQCSAAwADCwX+gAEQECAAA+4IBd6DeobqBAoAAkQMAABAJIADAAMW/oGAAINAAWAAsABYACwAFgAK/wP7Xlf/6CAE65wn/oIH/7ACGIvSf+vhgdaGbppnugQGllBECAAEQCSAAwADCwX+gAEQECAAA+4IB/6DeobqBAwoAkQMAABAJIADAAMW/oGAAINAAWAAsABYACwAFgAK/wP75Km//t8H8wZv/9vh//lPY4r6P/KBAdaGbppnugQGllBECAAEQCSAAwADCwX+gAEQECAAA+4ICgKDdobqBA40AkQMAABAJIADAAMW/oGAAINAAWAAsABYACwAFgAK/wP7Xlf/6CAE65wn/oIH/7ACGIvSf+vhgdaGappjugQGlk/EBAAEQEBRgAGFgv9AAIgIEAAD7ggMKHFO7a427i7OBALeG94EB8YHB";

export function syntheticVideoBytes() {
  const bytes = Buffer.from(VIDEO_BASE64, "base64");
  assert.equal(bytes.length, SYNTHETIC_VIDEO.size);
  assert.equal(bytes.toString("base64"), VIDEO_BASE64);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), SYNTHETIC_VIDEO.sha256);
  return bytes; // Independent copy; one test cannot corrupt later fixtures.
}

// Evaluated inside an owned test page. A header check is not decode evidence.
export async function decodeSyntheticVideo(bytes) {
  const element = document.createElement("video");
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "video/webm" }));
  let timeout;
  try {
    return await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Synthetic video decode timed out")), 5000);
      element.onloadeddata = () => resolve({
        width: element.videoWidth, height: element.videoHeight, duration: element.duration,
      });
      element.onerror = () => reject(new Error("Synthetic video is not decodable"));
      element.src = url;
    });
  } finally {
    clearTimeout(timeout);
    element.onloadeddata = null;
    element.onerror = null;
    element.removeAttribute("src");
    element.load();
    URL.revokeObjectURL(url);
  }
}

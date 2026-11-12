// Checks what the Worker accepts: node cloudflare/usage-counts/test.mjs
import assert from "node:assert/strict";
import { countFields } from "./worker.js";

assert.deepEqual(
  countFields({ event: "generate_finished", browser: "chrome", device: "desktop", version: "0.2.0", model: "fretformer.v2-onnx", difficulty: "expert", engine: "webgpu", minutes: "2-5", length: "3-5" }),
  { browser: "chrome", device: "desktop", difficulty: "expert", engine: "webgpu", length: "3-5", minutes: "2-5", model: "fretformer.v2-onnx", version: "0.2.0" },
);
// A failed decode carries the file's kind, and runs carry the OS family.
assert.deepEqual(
  countFields({ event: "generate_failed", browser: "chrome", device: "desktop", version: "0.2.0", model: "fretformer.v2-onnx", difficulty: "expert", stage: "prepare", reason: "decode_failed", format: "mp4", os: "linux" }),
  { browser: "chrome", device: "desktop", difficulty: "expert", format: "mp4", model: "fretformer.v2-onnx", os: "linux", reason: "decode_failed", stage: "prepare", version: "0.2.0" },
);
// A run cut short says how, and what it was running on, once known.
assert.deepEqual(
  countFields({ event: "run_interrupted", browser: "chrome", device: "mobile", version: "0.2.0", kind: "generate", model: "fretformer.v2-onnx", stage: "demucs", engine: "webgpu", length: "3-5", how: "stopped" }),
  { browser: "chrome", device: "mobile", engine: "webgpu", how: "stopped", kind: "generate", length: "3-5", model: "fretformer.v2-onnx", stage: "demucs", version: "0.2.0" },
);
// A day the browser version was open carries only the common fields.
assert.deepEqual(countFields({ event: "active", browser: "edge", device: "desktop", version: "0.2.0", os: "windows" }), { browser: "edge", device: "desktop", version: "0.2.0" });
// Fields the event doesn't list are dropped, not stored.
assert.deepEqual(countFields({ event: "exported", format: "sng", title: "some song", browser: "firefox" }), { browser: "firefox", format: "sng" });
// Unknown events and odd values are refused.
assert.equal(countFields({ event: "song_title", browser: "chrome" }), null);
assert.equal(countFields({ event: "exported", format: "My Song.sng" }), null);
assert.equal(countFields({ event: "exported", format: 3 }), null);
assert.equal(countFields(null), null);
// Inherited names aren't events.
for (const event of ["constructor", "toString", "__proto__", "hasOwnProperty"]) assert.equal(countFields({ event, browser: "chrome" }), null);
console.log("usage counts worker: passed");

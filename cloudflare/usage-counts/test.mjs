// Checks what the Worker accepts: node cloudflare/usage-counts/test.mjs
import assert from "node:assert/strict";
import { countFields } from "./worker.js";

assert.deepEqual(
  countFields({ event: "generate_finished", browser: "chrome", device: "desktop", version: "0.2.0", model: "fretformer.v2-onnx", difficulty: "expert", engine: "webgpu", minutes: "2-5", length: "3-5" }),
  { browser: "chrome", device: "desktop", difficulty: "expert", engine: "webgpu", length: "3-5", minutes: "2-5", model: "fretformer.v2-onnx", version: "0.2.0" },
);
// Fields the event doesn't list are dropped, not stored.
assert.deepEqual(countFields({ event: "exported", format: "sng", title: "some song", browser: "firefox" }), { browser: "firefox", format: "sng" });
// Unknown events and odd values are refused.
assert.equal(countFields({ event: "song_title", browser: "chrome" }), null);
assert.equal(countFields({ event: "exported", format: "My Song.sng" }), null);
assert.equal(countFields({ event: "exported", format: 3 }), null);
assert.equal(countFields(null), null);
console.log("usage counts worker: passed");

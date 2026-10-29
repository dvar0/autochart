// The usage counts the browser version may send, and the fields each one may
// carry besides the three every count has (browser, device, version). Shared
// by the page (src/web/usageCounts.js) and the server that adds them up
// (cloudflare/usage-counts/worker.js), which drops anything not listed here.
// docs/privacy.md lists the same events in words: change both together.
export const COMMON_FIELDS = Object.freeze(["browser", "device", "version"]);

export const USAGE_EVENTS = Object.freeze({
  generate_started: ["model", "difficulty"],
  generate_finished: ["model", "difficulty", "engine", "minutes", "length"],
  generate_failed: ["model", "difficulty", "engine", "stage", "reason"],
  inpaint_finished: ["model", "engine", "minutes"],
  inpaint_failed: ["model", "engine", "stage", "reason"],
  run_interrupted: ["kind", "model", "stage", "how"],
  exported: ["format"],
  model_downloaded: ["model"],
  lite_offered: [],
  lite_switched: [],
  lite_declined: [],
});

// Every value is a short lowercase word, range or version: "webgpu", "2-5",
// "20+", "fretformer.v2-onnx", "0.2.0".
export const FIELD_VALUE = /^[a-z0-9][a-z0-9._+-]{0,39}$/;

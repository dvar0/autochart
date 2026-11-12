// Usage counts for the browser version. Each count is an event name and a few
// coarse fields, added to a per-day total on the server; single events are
// never stored. No IDs, no cookies, nothing about the song or its file.
// docs/privacy.md lists every event and field, and cloudflare/usage-counts/
// is the server side.
//
// Nothing is sent when the build has no endpoint (VITE_AUTOCHART_COUNTS_URL),
// when Settings > Share usage counts is off, or when the browser asks not to
// be tracked (Do Not Track, Global Privacy Control). Sending never waits or
// throws: a blocked or failed count changes nothing in the app.

import { getAppSettings } from "../services/appSettings.js";
import { FIELD_VALUE, USAGE_EVENTS } from "../../shared/usageEvents.js";

const ENDPOINT = import.meta.env.VITE_AUTOCHART_COUNTS_URL || "";
const VERSION = typeof __AUTOCHART_VERSION__ === "string" ? __AUTOCHART_VERSION__ : "";

function browserAsksNotToTrack() {
  return navigator.globalPrivacyControl === true || navigator.doNotTrack === "1" || window.doNotTrack === "1";
}

export async function countsEnabled() {
  if (!ENDPOINT || browserAsksNotToTrack()) return false;
  const settings = await getAppSettings().catch(() => ({}));
  return settings.shareUsageCounts !== false;
}

// Browser family only: no versions.
function browserFamily(ua = navigator.userAgent) {
  if (/Edg\//.test(ua)) return "edge";
  if (/Firefox\/|FxiOS\//.test(ua)) return "firefox";
  if (/Chrome\/|CriOS\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}

// Operating system family only, for runs: whether WebGPU is on by default
// depends on it. "windows", "mac", "linux", "chromeos", "android", "ios".
function osFamily(ua = navigator.userAgent) {
  if (/iPhone|iPad|iPod/.test(ua) || navigator.maxTouchPoints > 1 && /Macintosh/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/CrOS/.test(ua)) return "chromeos";
  if (/Windows/.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/.test(ua)) return "mac";
  if (/Linux|X11/.test(ua)) return "linux";
  return "other";
}

function deviceKind(ua = navigator.userAgent) {
  return /Android|iPhone|iPad|Mobile/.test(ua) || navigator.maxTouchPoints > 1 && /Macintosh/.test(ua) ? "mobile" : "desktop";
}

// "fretformer.v2-onnx" from "autochart.fretformer.v2-onnx".
export function modelName(generatorId = "") {
  return String(generatorId).replace(/^autochart\./, "").toLowerCase() || "unknown";
}

// Rounded ranges, never exact times: "2-5" minutes, "20+".
export function minutesRange(seconds) {
  const minutes = Number(seconds) / 60;
  if (!Number.isFinite(minutes) || minutes < 0) return "unknown";
  const edges = [1, 2, 5, 10, 20];
  const upper = edges.findIndex((edge) => minutes < edge);
  if (upper < 0) return "20+";
  return `${upper ? edges[upper - 1] : 0}-${edges[upper]}`;
}

export function songLengthRange(seconds) {
  const minutes = Number(seconds) / 60;
  if (!Number.isFinite(minutes) || minutes <= 0) return "unknown";
  const edges = [1, 3, 5, 8];
  const upper = edges.findIndex((edge) => minutes < edge);
  if (upper < 0) return "8+";
  return `${upper ? edges[upper - 1] : 0}-${edges[upper]}`;
}

// What went wrong, as one of a few fixed codes. The error's own message never
// leaves the page: it can name the song's file.
export function failureReason(error) {
  const code = String(error?.code || "");
  const text = `${error?.name || ""} ${error?.message || error || ""}`;
  if (code === "storage_full" || /quota/i.test(text)) return "storage_full";
  if (code === "decode_failed") return "decode_failed";
  if (/out of memory|allocation failed|bad_alloc|RangeError|OOM/i.test(text)) return "out_of_memory";
  if (/device (was )?lost|lost the device|GPUDevice|context lost/i.test(text)) return "gpu_lost";
  if (/no usable WebGPU|WebGPU is not|webgpu.*(unavailable|not supported)/i.test(text)) return "no_webgpu";
  if (/can't decode|unable to decode|decodeAudioData/i.test(text)) return "decode_failed";
  if (/fetch|network|download|HTTP \d{3}|sha256|checksum/i.test(text)) return "download_failed";
  if (/engine stopped unexpectedly/i.test(text)) return "engine_crashed";
  return "other";
}

export function stageName(stage) {
  const value = String(stage || "").toLowerCase();
  return /^[a-z][a-z0-9_-]{0,23}$/.test(value) ? value : "unknown";
}

// Sends one count. Fields not listed for the event are dropped here, and the
// server checks again.
export function count(event, fields = {}) {
  const allowed = USAGE_EVENTS[event];
  if (!allowed || !ENDPOINT) return;
  void countsEnabled().then((enabled) => {
    if (!enabled) return;
    const body = { event, browser: browserFamily(), device: deviceKind(), ...(VERSION ? { version: VERSION } : {}) };
    const filled = allowed.includes("os") ? { os: osFamily(), ...fields } : fields;
    for (const key of allowed) {
      const value = String(filled[key] ?? "").toLowerCase();
      if (FIELD_VALUE.test(value)) body[key] = value;
    }
    const text = JSON.stringify(body);
    try {
      if (!navigator.sendBeacon?.(ENDPOINT, text)) {
        fetch(ENDPOINT, { method: "POST", body: text, keepalive: true }).catch(() => {});
      }
    } catch {
      // Counting is best-effort.
    }
  }).catch(() => {});
}

// ----- days the browser version was open -----
// One "active" count per browser per UTC day (the server's days are UTC too),
// so the totals give how many browsers used it each day. The only thing kept
// here is the last day counted.

const ACTIVE_KEY = "autochart.activeDay";

async function countActiveDay() {
  if (!(await countsEnabled().catch(() => false))) return;
  const store = storage();
  if (!store) return;
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (store.getItem(ACTIVE_KEY) === today) return;
    store.setItem(ACTIVE_KEY, today);
  } catch {
    return; // Storage blocked: without the note this browser would count every load.
  }
  count("active");
}

// ----- runs that never finished -----
// Each run leaves a small note in this browser while it works, so a run that
// a crashed or closed tab cut short is counted later, by this tab or the next
// one. A run stopped with Stop is counted at once. The note holds only what
// the count sends, and is deleted once counted.

const RUN_PREFIX = "autochart.run.";
const OLD_RUN_KEY = "autochart.run";
const BEAT_MS = 10_000;
// A live tab keeps its notes fresh; only a stale one was cut short. Generous,
// since a hidden tab's timers can run as rarely as once a minute.
const STALE_MS = 3 * 60_000;

// This page's runs, by job id.
const runs = new Map();
let beat = null;

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null; // Storage blocked: interrupted runs just aren't counted.
  }
}

function writeRun(jobId) {
  const note = runs.get(jobId);
  if (!note) return;
  try {
    storage()?.setItem(RUN_PREFIX + jobId, JSON.stringify({ ...note, at: Date.now() }));
  } catch {
    // Storage full or blocked.
  }
}

function writeRuns() {
  for (const jobId of runs.keys()) writeRun(jobId);
}

function forgetRun(jobId) {
  runs.delete(jobId);
  try {
    storage()?.removeItem(RUN_PREFIX + jobId);
  } catch {
    // Nothing to clean up.
  }
  if (!runs.size) {
    clearInterval(beat);
    beat = null;
  }
}

function countInterrupted(note, how) {
  count("run_interrupted", {
    kind: note.kind === "inpaint" ? "inpaint" : "generate",
    model: note.model,
    stage: stageName(note.stage),
    engine: note.engine,
    length: note.length,
    how,
  });
}

// Counts the notes no live run is keeping fresh, once each.
function countStaleRuns() {
  const store = storage();
  if (!store) return;
  let keys = [];
  try {
    keys = Array.from({ length: store.length }, (_, index) => store.key(index));
  } catch {
    return;
  }
  for (const key of keys) {
    if (key !== OLD_RUN_KEY && !key?.startsWith(RUN_PREFIX)) continue;
    if (runs.has(key.slice(RUN_PREFIX.length))) continue;
    let note = null;
    try {
      note = JSON.parse(store.getItem(key) || "null");
    } catch {
      note = null;
    }
    if (note && Date.now() - Number(note.at || 0) < STALE_MS) continue;
    try {
      store.removeItem(key);
    } catch {
      continue;
    }
    if (note) countInterrupted(note, note.closed ? "closed" : "crashed");
  }
}

export function runStarted(jobId, { kind, model }) {
  runs.set(jobId, { kind, model, stage: "queued", engine: "", length: "", closed: false });
  writeRun(jobId);
  countStaleRuns();
  beat ??= setInterval(() => {
    writeRuns();
    countStaleRuns();
  }, BEAT_MS);
}

// What's known about a run so far: its stage, then WebGPU or CPU, the song's length.
export function runUpdate(jobId, { stage, engine, length } = {}) {
  const note = runs.get(jobId);
  if (!note) return;
  if (stage) note.stage = stageName(stage);
  if (engine) note.engine = engine;
  if (length) note.length = length;
  writeRun(jobId);
}

// A run that ended. One stopped with Stop counts as cut short.
export function runEnded(jobId, { stopped = false } = {}) {
  const note = runs.get(jobId);
  if (note && stopped) countInterrupted(note, "stopped");
  forgetRun(jobId);
}

// A tab closed on purpose fires pagehide first; one the browser killed doesn't.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const note of runs.values()) note.closed = true;
    writeRuns();
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    for (const note of runs.values()) note.closed = false;
    writeRuns();
  });
  countStaleRuns();
  void countActiveDay();
  // A tab left open past midnight counts the new day when it's looked at again.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void countActiveDay();
  });
  // A note left by a crash just before this load is still fresh now.
  setTimeout(countStaleRuns, STALE_MS + BEAT_MS);
}

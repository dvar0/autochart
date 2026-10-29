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

// Browser family only: no versions, no OS.
function browserFamily(ua = navigator.userAgent) {
  if (/Edg\//.test(ua)) return "edge";
  if (/Firefox\/|FxiOS\//.test(ua)) return "firefox";
  if (/Chrome\/|CriOS\//.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
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
    for (const key of allowed) {
      const value = String(fields[key] ?? "").toLowerCase();
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

// ----- runs that never finished -----
// A run leaves a small note in this browser while it works, so a run that a
// crashed or closed tab cut short is counted on the next visit. The note
// holds only what the count sends, and is deleted once counted.

const RUN_KEY = "autochart.run";
const BEAT_MS = 10_000;
// Another tab's run keeps its note fresh; only a stale one was cut short.
const STALE_MS = 3 * BEAT_MS;

let running = null;
let beat = null;

function writeRun() {
  if (!running) return;
  try {
    localStorage.setItem(RUN_KEY, JSON.stringify({ ...running, at: Date.now() }));
  } catch {
    // Storage blocked: interrupted runs just aren't counted.
  }
}

export function runStarted({ kind, model }) {
  running = { kind, model, stage: "queued", closed: false };
  writeRun();
  clearInterval(beat);
  beat = setInterval(writeRun, BEAT_MS);
}

export function runStage(stage) {
  if (!running) return;
  running.stage = stageName(stage);
  writeRun();
}

export function runEnded() {
  running = null;
  clearInterval(beat);
  beat = null;
  try {
    localStorage.removeItem(RUN_KEY);
  } catch {
    // Nothing to clean up.
  }
}

function countLastRun() {
  let note = null;
  try {
    note = JSON.parse(localStorage.getItem(RUN_KEY) || "null");
  } catch {
    note = null;
  }
  if (!note || Date.now() - Number(note.at || 0) < STALE_MS) return;
  try {
    localStorage.removeItem(RUN_KEY);
  } catch {
    return;
  }
  count("run_interrupted", {
    kind: note.kind === "inpaint" ? "inpaint" : "generate",
    model: note.model,
    stage: stageName(note.stage),
    how: note.closed ? "closed" : "crashed",
  });
}

// A tab closed on purpose fires pagehide first; one the browser killed doesn't.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (!running) return;
    running.closed = true;
    writeRun();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && running) {
      running.closed = false;
      writeRun();
    }
  });
  countLastRun();
}

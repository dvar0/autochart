// The browser version's engine: the same bridge the desktop app gets from
// Electron (window.autochart.engine / modelSetup / hardware), backed by the
// ONNX engine in a worker. Audio comes in as the file itself; models stream
// from the model host into Cache Storage on first use; stems and lead-in audio
// live in the origin private file system.

import engineManifest from "../../engine/manifest.json";
import { decodeAudioFile } from "../../engine/web/audio.mjs";
import {
  cachedModelSummary, clearModelCache, ensureModelFiles, fitsInRoom, loadModelManifest, modelFolderStatus,
  removeModelFolder, storageRoom,
} from "../../engine/web/modelStore.mjs";
import {
  clearLeftovers, clearStems, hasMelTables, readStoredAudio, removeStemsExcept, removeStoredStems, saveAnalysisAudio,
  saveMelTables, stemKey, stemPaths, storedStemBytes, storedStemNames,
} from "../../engine/web/stemStore.mjs";
import { getAppSettings } from "../services/appSettings.js";
import { tablesFileHeader } from "../../shared/projectFile.js";
import { MODEL_FAMILIES } from "../data/modelFamilies.js";
import { LITE_FAMILY, browserNeedsLite } from "../pages/generate/liteOffer.js";
import { deviceFromProbe } from "../components/DeviceFacts.jsx";

const DEFAULT_DEMUCS_ID = "demucs_default";

// The browser offers the Fretformer 2 family, plus Lite where it's needed;
// Fretformer 1 stays in the desktop app.
const WEB_FAMILY = MODEL_FAMILIES.find((family) => family.id === "fretformer-2");
const WEB_GENERATORS = engineManifest.generators.filter((generator) =>
  [WEB_FAMILY.generatorId, WEB_FAMILY.inpaintGeneratorId, LITE_FAMILY.generatorId].includes(generator.id));
const MAX_LEAD_IN_MS = 30_000;

// Where model folders are served from: the dev server's /models/ (your
// installed models), or in a build the model host revision the desktop app
// downloads from, so a model update reaches the browser with an app update.
const MODELS_BASE = new URL(
  import.meta.env.VITE_AUTOCHART_MODELS_URL || (import.meta.env.DEV ? "models/" : __AUTOCHART_MODEL_HOST__),
  document.baseURI,
).href;
// See vite.web.config.js: only the dev server needs onnxruntime's files pointed at.
const WASM_BASE = import.meta.env.DEV ? new URL("/ort/", document.baseURI).href : null;

const listeners = new Set();
const installListeners = new Set();

function emit(jobId, event) {
  const payload = { jobId, ...event, updatedAt: Date.now() };
  for (const listener of listeners) {
    try { listener(payload); } catch (err) { console.error("[webEngine] listener failed", err); }
  }
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function modelUrl(generator) {
  return new URL(`${generator.models?.onnxFolder || "fretformer-v1"}/`, MODELS_BASE).href;
}

function generatorById(generatorId) {
  return WEB_GENERATORS.find((g) => g.id === generatorId) || WEB_GENERATORS[0];
}

function stemSetOf(generator) {
  const separation = plainObject(generator?.separation);
  return separation.cacheSubdir ? String(separation.stemSet || separation.cacheSubdir) : "htdemucs";
}

function sourceTransformFrom(value) {
  const input = plainObject(value);
  const fromSeconds = Number(input.leadInSilenceSeconds) * 1000;
  const raw = Number(input.leadInSilenceMs ?? fromSeconds);
  const ms = Number.isFinite(raw) ? Math.max(0, Math.min(MAX_LEAD_IN_MS, Math.round(raw))) : 0;
  const seconds = ms / 1000;
  return {
    kind: ms > 0 ? "lead-in-silence" : "original",
    leadInSilenceSeconds: seconds,
    leadInSilenceMs: ms,
    key: `lead-in:${ms}`,
    label: ms > 0 ? `+${seconds}s lead-in` : "No lead-in",
  };
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSeed() {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return 1 + (value[0] % (2 ** 31 - 2));
}

// A random-seed run gets its seed here so the take records the one it used.
function generationWithSeed(generation) {
  const value = plainObject(generation);
  const controls = plainObject(value.controls);
  const resolved = plainObject(value.resolved);
  if (controls.seedMode !== "random" || resolved.seed != null) return value;
  return { ...value, controls: { ...controls, seed: null }, resolved: { ...resolved, seed: randomSeed() } };
}

async function hardwareDevice(payload) {
  if (payload.hardwareMode === "cpu") return "cpu";
  const settings = await getAppSettings().catch(() => ({}));
  const mode = String(settings.hardwareMode || "auto");
  return mode === "cpu" ? "cpu" : mode === "webgpu" ? "webgpu" : "auto";
}

// "Safari 26.1 on Mac" and the like, for the engine log.
function browserName(ua = "") {
  const browser = [[/Edg\/([\d.]+)/, "Edge"], [/Firefox\/([\d.]+)/, "Firefox"], [/FxiOS\/([\d.]+)/, "Firefox"], [/CriOS\/([\d.]+)/, "Chrome"],
    [/Chrome\/([\d.]+)/, "Chrome"], [/Version\/([\d.]+).*Safari/, "Safari"]]
    .map(([re, name]) => { const m = re.exec(ua); return m && `${name} ${m[1].split(".").slice(0, 2).join(".")}`; })
    .find(Boolean) || "unknown browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "unknown OS";
  return `${browser} on ${os}`;
}

// ----- the worker and its job queue -----

let worker = null;
let active = null; // { id, resolve, reject, stage }
const queue = [];

function startWorker() {
  worker = new Worker(new URL("../../engine/web/engine.worker.mjs", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    if (!active || data?.id !== active.id) return;
    if (data.type === "event") {
      const event = data.event;
      if (event.type === "runtime") {
        const gpu = event.webgpu ? `WebGPU on (readback ${Math.round(event.readbackMs ?? 0)} ms)` : "WebGPU off";
        const threads = event.crossOriginIsolated ? "multithreaded CPU" : "single-threaded CPU";
        emit(active.id, { type: "log", stage: "queued", stream: "stdout", message: `Browser engine: ${gpu}, ${threads} (${browserName(event.userAgent)})` });
        return;
      }
      if (event.type === "stage" && event.status === "running") active.stage = event.stage;
      emit(active.id, event);
    } else if (data.type === "result") {
      finish(null, data.result);
    } else if (data.type === "error") {
      if (data.stack) console.error("[webEngine]", data.stack);
      finish(Object.assign(new Error(data.message), { stage: active.stage, code: data.code || undefined }));
    }
  };
  worker.onerror = (event) => {
    if (active) finish(new Error(event.message || "The engine stopped unexpectedly."));
  };
}

function finish(error, result = null) {
  const job = active;
  active = null;
  if (error) job.reject(error);
  else job.resolve(result);
  next();
}

function next() {
  if (active || !queue.length) return;
  const job = queue.shift();
  active = job;
  if (!worker) startWorker();
  worker.postMessage(
    { type: "job", id: job.id, kind: job.kind, job: job.job, wasmPaths: WASM_BASE },
    // Mono audio shares one buffer between channels; each goes once.
    [...new Set(job.transfer)]
  );
}

function runJob(kind, id, job, transfer = []) {
  return new Promise((resolve, reject) => {
    queue.push({ id, kind, job, transfer, resolve, reject, stage: "queued" });
    next();
  });
}

function canceledError() {
  return Object.assign(new Error("Canceled."), { code: "CANCELED" });
}

async function cancelJob({ jobId } = {}) {
  const queued = queue.findIndex((job) => job.id === jobId);
  if (queued >= 0) {
    const [job] = queue.splice(queued, 1);
    job.reject(canceledError());
    emit(jobId, { type: "canceled" });
    return { ok: true, jobId, status: "canceled" };
  }
  if (active?.id !== jobId) return { ok: true, jobId, status: "idle" };
  // A run can't be interrupted mid-inference: drop the worker (and its models).
  worker?.terminate();
  worker = null;
  emit(jobId, { type: "canceled" });
  finish(canceledError());
  return { ok: true, jobId, status: "canceled" };
}

// ----- shared steps -----

// The run's audio, decoded, plus what identifies it. The decoded channels are
// transferred to the worker, so each run decodes its own copy.
async function prepareAudio(jobId, payload) {
  const blob = payload.audio?.blob;
  if (!(blob instanceof Blob)) throw new Error("Choose a song file first.");
  emit(jobId, { type: "stage", stage: "queued", status: "running" });
  const bytes = await blob.arrayBuffer();
  const audioSha256 = await sha256Hex(bytes);
  let audio;
  try {
    audio = await decodeAudioFile(bytes);
  } catch {
    throw new Error("This browser can't decode that file. Try an MP3, OGG, FLAC or WAV.");
  }
  return { audio, audioSha256, sourceTransform: sourceTransformFrom(payload.sourceTransform || payload.generation?.controls) };
}

// The song file of recent runs, for the live board to play while they run.
const RUN_AUDIO_PREFIX = "run-audio:";
const runAudio = new Map();

function keepRunAudio(jobId, blob) {
  runAudio.set(jobId, blob);
  while (runAudio.size > 2) runAudio.delete(runAudio.keys().next().value);
  return `${RUN_AUDIO_PREFIX}${jobId}`;
}

// The audio the run charts, announced so the live board can play along. Lead-in
// runs chart a padded copy of the song, which is kept so the take plays on the
// timeline it was charted on; other runs chart the song file as it is.
async function storeAnalysisAudio(jobId, blob, audio, audioSha256, sourceTransform) {
  const ms = sourceTransform.leadInSilenceMs;
  if (!ms) {
    emit(jobId, { type: "analysis_audio", path: keepRunAudio(jobId, blob), leadInSilenceMs: 0 });
    return null;
  }
  const pad = Math.round((ms / 1000) * audio.sampleRate);
  const left = new Float32Array(pad + audio.left.length);
  const right = new Float32Array(pad + audio.right.length);
  left.set(audio.left, pad);
  right.set(audio.right, pad);
  const path = await saveAnalysisAudio(`${audioSha256}__${sourceTransform.key}`, { left, right, sampleRate: audio.sampleRate });
  if (path) emit(jobId, { type: "analysis_audio", path, leadInSilenceMs: ms });
  return path;
}

// Every stem set this song's separation has stored, as the app records them:
// its mel tables, and its stems when they were kept to play.
async function separationStemSets(audioSha256, sourceTransform, separationId) {
  const sets = [...new Set(WEB_GENERATORS.map(stemSetOf))];
  const stemSets = {};
  for (const stemSet of sets) {
    const key = stemKey({ audioSha256, sourceVariantKey: sourceTransform.key, separationId, stemSet });
    const names = await storedStemNames(key);
    const melTables = await hasMelTables(key);
    if (names?.length || melTables) {
      stemSets[stemSet] = {
        stems: names?.length ? stemPaths(key, names) : {},
        ...(melTables ? { melTables: { path: `opfs:${key}` } } : {}),
      };
    }
  }
  return { stems: stemSets.htdemucs?.stems || {}, stemSets };
}

// The separation a run uses: the one the take picked when it was made for
// this lead-in, else the lead-in's default.
function runSeparation(payload, sourceTransform) {
  const picked = plainObject(payload.demucsSeparation);
  const id = String(picked.engineId || picked.id || DEFAULT_DEMUCS_ID);
  const pickedKey = picked.sourceTransform?.key || picked.sourceVariantKey || "lead-in:0";
  const compatible = picked.id && (id === DEFAULT_DEMUCS_ID || pickedKey === sourceTransform.key);
  if (!compatible) return { separationId: DEFAULT_DEMUCS_ID, demucsSeparation: null };
  return {
    separationId: id,
    demucsSeparation: {
      id,
      name: picked.name || "Selected separation",
      profile: picked.profile || "Standard Demucs",
      sourceTransform,
      sourceVariantKey: sourceTransform.key,
    },
  };
}

// Stems are big (raw float32, hundreds of MB a song) and are only stored to
// play them; the browser works on one song at a time, so a job for one song
// removes every other song's stems. Mel tables stay. Each run's analysis audio
// stays until the page is next opened (a finished take still exports from it).
const songsInUse = new Map();

async function keepOnlyStemsInUse(jobId, audioSha256) {
  songsInUse.set(jobId, audioSha256);
  await removeStemsExcept(new Set(songsInUse.values()));
}

// Left over from a closed tab (stems, analysis audio): nothing can point at
// it any more. Mel tables stay. Skipped while another tab of the app is open
// (it may be using them); each tab holds a shared lock so the others can tell.
const TAB_LOCK = "autochart-open-tab";
async function clearLeftoverStems() {
  const locks = globalThis.navigator?.locks;
  if (!locks) return;
  try {
    const { held = [] } = await locks.query();
    const otherTabOpen = held.some((lock) => lock.name === TAB_LOCK);
    locks.request(TAB_LOCK, { mode: "shared" }, () => new Promise(() => {})).catch(() => {});
    if (!otherTabOpen) await clearLeftovers();
  } catch { /* leave it */ }
}

async function baseJob(jobId, payload) {
  const generator = generatorById(payload.generatorId);
  const { audio, audioSha256, sourceTransform } = await prepareAudio(jobId, payload);
  await keepOnlyStemsInUse(jobId, audioSha256);
  const { separationId, demucsSeparation } = runSeparation(payload, sourceTransform);
  const metadata = plainObject(payload.metadata);
  const job = {
    schemaVersion: 1,
    generatorId: generator.id,
    generatorLabel: generator.label,
    generator,
    engineVersion: engineManifest.engineVersion,
    modelUrl: modelUrl(generator),
    audio,
    audioSha256,
    sourceTransform,
    separationId,
    ...(demucsSeparation ? { demucsSeparation } : {}),
    title: payload.title || metadata.title || "",
    metadata,
    difficulty: payload.difficulty || "expert",
    generation: generationWithSeed(payload.generation),
    device: await hardwareDevice(payload),
  };
  return { job, generator, transfer: [audio.left.buffer, ...(audio.right.buffer !== audio.left.buffer ? [audio.right.buffer] : [])] };
}

function failedMessage(error, verb) {
  // Both already say what happened and what to do.
  if (error?.code === "CANCELED" || error?.code === "storage_full") return error;
  const stage = error?.stage && error.stage !== "queued" ? ` at ${error.stage}` : "";
  return new Error(`${verb} failed${stage}: ${error?.message || error}`);
}

// ----- the engine bridge -----

async function generateChart(payload = {}) {
  const jobId = payload.jobId || crypto.randomUUID();
  try {
    const { job, generator, transfer } = await baseJob(jobId, payload);
    const sourceChartText = String(payload.sourceChart?.text || "");
    if (sourceChartText.trim()) {
      job.sourceChartText = sourceChartText;
      job.sourceChart = {
        sha256: await sha256Hex(new TextEncoder().encode(sourceChartText)),
        versionId: String(payload.sourceChart?.versionId || ""),
        name: String(payload.sourceChart?.name || "Imported Clone Hero"),
      };
    }
    const analysisAudioPath = await storeAnalysisAudio(jobId, payload.audio.blob, job.audio, job.audioSha256, job.sourceTransform);
    void keepModelsIfDownloading(generator);
    const result = await runJob("generate", jobId, job, transfer);
    const stems = await separationStemSets(job.audioSha256, job.sourceTransform, job.separationId);
    const base = result.sourceSeparation || job.demucsSeparation || null;
    const sourceSeparation = base
      ? {
          ...base,
          sourceTransform: base.sourceTransform || job.sourceTransform,
          sourceVariantKey: base.sourceVariantKey || job.sourceTransform.key,
          cache: { workspace: stemKey({ audioSha256: job.audioSha256, sourceVariantKey: job.sourceTransform.key, separationId: job.separationId, stemSet: stemSetOf(generator) }) },
          ...(Object.keys(stems.stems).length ? { stems: stems.stems } : {}),
          ...(Object.keys(stems.stemSets).length ? { stemSets: stems.stemSets } : {}),
        }
      : null;
    emit(jobId, { type: "stage", stage: "saved", status: "completed" });
    return {
      ...result,
      jobId,
      status: "completed",
      generatorId: generator.id,
      generatorLabel: generator.label,
      audioSha256: job.audioSha256,
      originalAudioSha256: job.audioSha256,
      analysisAudioSha256: job.audioSha256,
      analysisAudioPath,
      sourceTransform: job.sourceTransform,
      sourceSeparation,
    };
  } catch (err) {
    if (err?.code === "CANCELED") return { jobId, status: "canceled" };
    emit(jobId, { type: "error", message: err?.message || String(err) });
    throw failedMessage(err, "Generation");
  } finally {
    songsInUse.delete(jobId);
  }
}

async function prepareDemucs(payload = {}) {
  const jobId = payload.jobId || crypto.randomUUID();
  try {
    const { job, generator, transfer } = await baseJob(jobId, payload);
    const separationId = String(payload.separationId || DEFAULT_DEMUCS_ID);
    const name = String(payload.name || (separationId === DEFAULT_DEMUCS_ID ? "Default separation" : "Regenerated separation"));
    job.separationId = separationId;
    job.demucsSeparation = { id: separationId, name, profile: "Standard Demucs" };
    job.needStems = Boolean(payload.needStems);
    void keepModelsIfDownloading(generator);
    const result = await runJob("prepareDemucs", jobId, job, transfer);
    const stems = await separationStemSets(job.audioSha256, job.sourceTransform, separationId);
    emit(jobId, { type: "stage", stage: "saved", status: "completed" });
    return {
      ...result,
      id: separationId,
      name,
      jobId,
      status: "completed",
      generatorId: generator.id,
      generatorLabel: generator.label,
      audioSha256: job.audioSha256,
      originalAudioSha256: job.audioSha256,
      sourceTransform: job.sourceTransform,
      profile: "Standard Demucs",
      stems: stems.stems,
      stemSets: stems.stemSets,
      cache: result.cache,
    };
  } catch (err) {
    if (err?.code !== "CANCELED") emit(jobId, { type: "error", message: err?.message || String(err) });
    throw failedMessage(err, "Demucs preparation");
  } finally {
    songsInUse.delete(jobId);
  }
}

async function inpaintChart(payload = {}) {
  const jobId = payload.jobId || crypto.randomUUID();
  if (!payload.inpaint) throw new Error("Inpaint needs bars to rewrite.");
  try {
    const { job, generator, transfer } = await baseJob(jobId, payload);
    if (!generator.capabilities?.inpaint) throw new Error(`${generator.label} can't regenerate part of a chart.`);
    job.inpaint = payload.inpaint;
    void keepModelsIfDownloading(generator);
    const result = await runJob("inpaint", jobId, job, transfer);
    return { jobId, status: result.status, chartText: result.chartText, inpaint: result.inpaint };
  } catch (err) {
    if (err?.code === "CANCELED") return { jobId, status: "canceled" };
    throw failedMessage(err, "Inpaint");
  } finally {
    songsInUse.delete(jobId);
  }
}

// Stores mel tables brought in with a song (an exported project) as that
// song's default separation, so its takes regenerate without separating.
// tables: [{ stemSet, bytes }]. Tables already stored for the song stay.
async function seedSeparation(payload = {}) {
  const blob = payload.audio?.blob;
  if (!(blob instanceof Blob)) throw new Error("Choose a song file first.");
  const audioSha256 = await sha256Hex(await blob.arrayBuffer());
  const transform = sourceTransformFrom({});
  const known = new Set(WEB_GENERATORS.map(stemSetOf));
  for (const table of Array.isArray(payload.tables) ? payload.tables : []) {
    const stemSet = String(table?.stemSet || "");
    if (!known.has(stemSet) || !(await tablesFileHeader(table.bytes))) continue;
    const key = stemKey({ audioSha256, sourceVariantKey: transform.key, separationId: DEFAULT_DEMUCS_ID, stemSet });
    if (!(await hasMelTables(key))) await saveMelTables(key, table.bytes);
  }
  const stems = await separationStemSets(audioSha256, transform, DEFAULT_DEMUCS_ID);
  return { audioSha256, stems: stems.stems, stemSets: stems.stemSets, cache: {} };
}

async function readDemucsStem({ path } = {}) {
  if (String(path).startsWith(RUN_AUDIO_PREFIX)) {
    const blob = runAudio.get(String(path).slice(RUN_AUDIO_PREFIX.length));
    if (!blob) throw new Error("This run's audio is no longer loaded.");
    return blob.arrayBuffer();
  }
  return readStoredAudio(path);
}

// ----- models: which generators the model host has, and what's downloaded -----

let generatorStatusCache = null;
let needsLitePromise = null;

// Whether this browser can't separate stems in reasonable time, so Lite is
// offered (and preselected) before anything downloads.
function deviceNeedsLite() {
  needsLitePromise ??= probeHardware().then((probe) => browserNeedsLite(deviceFromProbe(probe))).catch(() => false);
  return needsLitePromise;
}

// Lite is listed only on a device that needs it, once it's picked, or once
// it's downloaded; elsewhere it stays out of the model picker.
async function liteOffered(status) {
  if (status.downloaded || status.status === "partial") return true;
  const settings = await getAppSettings().catch(() => ({}));
  return settings.defaultGeneratorId === LITE_FAMILY.generatorId || (await deviceNeedsLite());
}

// Bytes of each cached model folder, by folder URL.
function folderBytes(sizes, folderUrl) {
  return Object.entries(sizes).reduce((sum, [url, bytes]) => sum + (url.startsWith(folderUrl) ? bytes : 0), 0);
}

async function generatorStatuses({ fresh = false } = {}) {
  if (generatorStatusCache && !fresh) return generatorStatusCache;
  const [{ sizes }, room] = await Promise.all([cachedModelSummary(), storageRoom()]);
  const entries = await Promise.all(WEB_GENERATORS.map(async (generator) => {
    let manifest = null;
    try {
      manifest = await loadModelManifest(modelUrl(generator));
    } catch {
      manifest = null;
    }
    if (!manifest) {
      return [generator.id, { ready: false, status: "unsupported", message: "Not available in the browser yet." }];
    }
    const { files, cachedFiles } = await modelFolderStatus(manifest);
    const downloaded = cachedFiles === files;
    const status = {
      // Usable either way: a model that isn't downloaded yet downloads on first use.
      ready: true,
      status: downloaded ? "ready" : cachedFiles ? "partial" : "missing",
      downloaded,
      bytes: folderBytes(sizes, modelUrl(generator)),
      message: downloaded ? "Downloaded." : "Downloads the first time you use it.",
    };
    // A model that won't fit says so before its download starts.
    const neededMb = !cachedFiles && MODEL_FAMILIES.find((family) => family.generatorId === generator.id)?.downloadMb;
    if (neededMb && !fitsInRoom(neededMb * 1e6, room)) {
      status.spaceShort = { neededMb, freeMb: Math.floor(room.free / 1e6) };
    }
    if (generator.id === LITE_FAMILY.generatorId && !(await liteOffered(status))) {
      return [generator.id, { ...status, ready: false, message: "Offered on slower devices." }];
    }
    return [generator.id, status];
  }));
  generatorStatusCache = Object.fromEntries(entries);
  return generatorStatusCache;
}

async function getManifest() {
  const statuses = await generatorStatuses({ fresh: true });
  const settings = await getAppSettings().catch(() => ({}));
  const generators = WEB_GENERATORS.map((generator) => ({
    ...generator,
    setup: statuses[generator.id],
  }));
  const ready = generators.some((generator) => generator.setup.ready);
  return {
    ...engineManifest,
    available: true,
    generators,
    supportedPlatform: true,
    setup: {
      ready,
      setupComplete: true,
      standardReady: ready,
      status: ready ? "ready" : "missing",
      message: ready ? "At least one generator is ready." : "No model is reachable right now.",
    },
    preferences: {
      defaultGeneratorId: settings.defaultGeneratorId
        || ((await deviceNeedsLite()) ? LITE_FAMILY.generatorId : WEB_FAMILY.generatorId),
      fillInDrafts: settings.fillInDrafts === true,
      liteOfferDeclined: settings.liteOfferDeclined === true,
    },
  };
}

// The family the Models card offers to download, when the model host has it.
function downloadFamily(statuses) {
  return statuses[WEB_FAMILY.generatorId]?.status !== "unsupported" ? WEB_FAMILY : null;
}

async function scanModels({ fresh = false } = {}) {
  const statuses = await generatorStatuses({ fresh });
  const family = downloadFamily(statuses);
  const [{ bytes }, stemBytes] = await Promise.all([cachedModelSummary(), storedStemBytes()]);
  return {
    schemaVersion: 1,
    scannedAt: Date.now(),
    platform: "web",
    sourceRoots: [],
    components: [],
    packs: [],
    standardPack: family
      ? {
          id: family.id,
          label: family.label,
          defaultGeneratorId: family.generatorId,
          ready: Boolean(statuses[family.generatorId]?.downloaded),
        }
      : null,
    generatorReadiness: statuses,
    readyGeneratorIds: Object.keys(statuses).filter((id) => statuses[id].ready),
    generationReady: Object.values(statuses).some((status) => status.ready),
    combinedStatus: Object.values(statuses).some((status) => status.ready) ? "ready" : "missing",
    supportedPlatform: true,
    cachedBytes: bytes,
    stemBytes,
    message: "Models download into this browser the first time they're used.",
  };
}

function emitInstall(event) {
  for (const listener of installListeners) {
    try { listener(event); } catch { /* ignore */ }
  }
}

// Downloads a chart model now instead of on first use: Fretformer 2 by
// default, or the family a pack id names (Settings passes one). The Inpaint
// model is a separate, opt-in download: pass inpaint to get it.
async function installModels(request = {}) {
  const { inpaint = false } = plainObject(request);
  const statuses = await generatorStatuses({ fresh: true });
  const named = typeof request === "string" && MODEL_FAMILIES.find((item) => item.packId === request);
  const family = named && statuses[named.generatorId] && statuses[named.generatorId].status !== "unsupported"
    ? named
    : downloadFamily(statuses);
  if (!family) throw new Error("No model is reachable right now.");
  const ids = [inpaint ? family.inpaintGeneratorId : family.generatorId];
  emitInstall({ phase: "starting", percent: 0, message: "Preparing download." });
  keepModelsStored();
  for (const [index, id] of ids.entries()) {
    const manifest = await loadModelManifest(modelUrl(generatorById(id)));
    await ensureModelFiles(manifest, {
      onProgress: ({ loaded, total }) => {
        const part = total ? loaded / total : 0;
        emitInstall({
          phase: "downloading",
          percent: Math.floor(((index + part) / ids.length) * 100),
          message: `Downloading ${family.label}.`,
        });
      },
    });
  }
  emitInstall({ phase: "complete", percent: 100, message: "Downloaded." });
  return { setup: await scanModels({ fresh: true }) };
}

async function probeHardware() {
  let adapter = null;
  try {
    adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
  } catch {
    adapter = null;
  }
  const webgpu = Boolean(adapter) && !adapter.info?.isFallbackAdapter;
  const info = adapter?.info || {};
  const settings = await getAppSettings().catch(() => ({}));
  const requestedMode = String(settings.hardwareMode || "auto");
  const selectedMode = requestedMode === "cpu" || !webgpu ? "cpu" : "webgpu";
  return {
    platform: "web",
    platformLabel: "Browser",
    arch: "",
    supportedPlatform: true,
    supportLabel: "Runs in this browser.",
    cpu: "",
    cpuCount: navigator.hardwareConcurrency || null,
    totalMemoryMb: navigator.deviceMemory ? navigator.deviceMemory * 1024 : null,
    appleSilicon: false,
    nvidia: { detected: false, cudaAvailable: false, gpus: [] },
    gpu: webgpu ? [info.vendor, info.architecture || info.device].filter(Boolean).join(" ") || "WebGPU" : "",
    // Firefox-based browsers often leave these empty: they don't name the card.
    gpuDetails: webgpu ? [...new Set([info.vendor, info.architecture, info.device, info.description].filter(Boolean))].join(" · ") : "",
    webgpuAvailable: webgpu,
    requestedMode,
    selectedMode,
    effectiveHardwareMode: selectedMode,
    selectedModeLabel: selectedMode === "webgpu" ? "WebGPU" : "CPU mode",
    selectedRuntimePack: "onnxruntime-web",
    fallbackReason: webgpu ? "" : "This browser has no usable WebGPU, so models run on the CPU.",
    crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
    smokeTest: { status: "skipped", message: "Checked when a chart is generated." },
  };
}

async function clearBrowserCaches() {
  await Promise.all([clearModelCache(), clearStems()]);
  generatorStatusCache = null;
}

// Frees room: one family's models ({ packId }: its generator and Inpaint
// model), or every model and stored separation ({ all: true }). Songs, charts
// and the audio takes play on stay.
async function removeModels(request = {}) {
  const { packId = "", all = false } = plainObject(request);
  if (all) {
    await Promise.all([clearModelCache(), removeStoredStems()]);
  } else {
    const family = MODEL_FAMILIES.find((item) => item.packId === packId);
    if (!family) throw new Error("Unknown model.");
    const ids = [...new Set([family.generatorId, family.inpaintGeneratorId].filter(Boolean))];
    await Promise.all(ids.map((id) => removeModelFolder(modelUrl(generatorById(id)))));
  }
  generatorStatusCache = null;
  return { setup: await scanModels({ fresh: true }) };
}

// Asks the browser to keep downloaded models when the device runs low on
// space, instead of clearing them (and downloading 500 MB again). Chrome
// decides on its own; Firefox may ask once. Asked when a download starts
// (Settings, or a run that downloads its model first), while the page shows
// it, never out of the blue after a run.
let keepRequested = false;
function keepModelsStored() {
  if (keepRequested || !globalThis.navigator?.storage?.persist) return;
  keepRequested = true;
  navigator.storage.persisted()
    .then((persisted) => (persisted ? true : navigator.storage.persist()))
    .catch(() => {});
}

async function keepModelsIfDownloading(generator) {
  const status = (await generatorStatuses().catch(() => ({})))[generator.id];
  if (status && !status.downloaded) keepModelsStored();
}

export function createWebBridge() {
  void clearLeftoverStems();
  return {
    platform: "web",
    engine: {
      isAvailable: () => true,
      acceptsAudioBlobs: true,
      getManifest,
      generateChart,
      inpaintChart,
      cancelJob,
      prepareDemucs,
      readDemucsStem,
      seedSeparation,
      onJobEvent: (callback) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    },
    modelSetup: {
      isAvailable: () => true,
      scan: scanModels,
      install: installModels,
      remove: removeModels,
      clear: clearBrowserCaches,
      onInstallEvent: (callback) => {
        installListeners.add(callback);
        return () => installListeners.delete(callback);
      },
    },
    hardware: {
      isAvailable: () => true,
      probe: probeHardware,
    },
  };
}

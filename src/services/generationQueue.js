import { isMissingLibraryFolderError } from "../hooks/useLibraryFolderGate.js";
import {
  DEFAULT_GENERATION_CONTROLS,
  DEFAULT_TIMING_DETECTOR_ID,
  GENERATION_PRESETS,
  SOURCE_CHART_TIMING_DETECTOR_ID,
  buildGenerationSettings,
  controlsForGenerationPreset,
  generationVersionName,
} from "../data/generationSettings.js";
import { canRetryUsingCpu } from "../pages/generate/hardwareRecovery.js";
import { FINAL_SLOT_ORDER } from "./finalChart.js";
import { ensureFinalVersionSaved } from "./finalChartSave.js";
import {
  cancelGeneration,
  chooseExportFolder,
  exportChartToChosenFolder,
  generateQueueChart,
  keepAwake,
  projectRunsActive,
  saveChartToCloneHeroLibrary,
  subscribeGenerationEvents,
  whenProjectsIdle,
} from "./generation.js";
import { generatorDifficultyIds, generatorStemSetId, readsStems, sourceChartPayloadFromVersions } from "./projectRun.js";
import { hasElectronEngine, isWebApp } from "./runtimeBridge.js";
import { getSongRecord, getStoredAssetSource, readSongAudioSeconds } from "./songLibrary.js";
import { DEFAULT_DEMUCS_ID } from "./songSchema.js";

// The desktop Library's queue: songs charted one job at a time, each start to
// finish, with its own run logic and the same engine contract as a project's
// Generate. It lives outside the page so it carries on while the Library is
// closed. Items and runs are mutated in place; emit() publishes a new state
// object so subscribers see the change.
//
// State: { open, items, settings, generator, running, stopping, saving, note }
// Item: { songId, title, artist, durationSec, lengthKnown, separated, runs, stage,
//         onCpu, hardwareMode, saved, saveError }
// Run: { difficulty, status, separates, sep, beats, chart, error, canUseCpu, jobId }
//      where status is "waiting", "running", "done" or "failed".

const STORAGE_KEY = "autochart.generationQueue.v1";
const NO_LEAD_IN = { kind: "original", leadInSilenceSeconds: 0, leadInSilenceMs: 0, key: "lead-in:0", label: "No lead-in" };
const STAGE_LABELS = {
  audio: "Getting ready",
  demucs: "Separating",
  timing: "Finding the beat",
  smoothing: "Finding the beat",
  transcription: "Charting",
  chart: "Charting",
  done: "Charting",
};
// How long each step takes against the song's length, near enough to weigh a
// song that still needs separating against one that doesn't.
const WORK = { sep: 0.3, beats: 0.03, chart: 0.67 };
// A song with no length saved yet counts as a typical one.
const FALLBACK_SECONDS = 240;

let state = {
  open: false,
  items: [],
  settings: { generatorId: "", difficulties: ["expert"], presetId: "standard", saveWhenDone: false },
  generator: null,
  running: false,
  stopping: false,
  saving: null,
  note: "",
};
let loaded = false;
let current = null;
let stopRequested = false;
let stopSignal = null;
let wakeStop = null;
const listeners = new Set();

function emit() {
  state = { ...state };
  listeners.forEach((listener) => listener());
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      settings: state.settings,
      items: state.items.map((item) => ({
        songId: item.songId,
        title: item.title,
        artist: item.artist,
        durationSec: item.durationSec,
        lengthKnown: item.lengthKnown,
        separated: item.separated,
        hardwareMode: item.hardwareMode,
        saved: item.saved,
        runs: item.runs.map(({ difficulty, status, separates, error, canUseCpu }) => ({
          difficulty,
          // A run the app closed on starts over.
          status: status === "running" ? "waiting" : status,
          separates,
          error,
          canUseCpu,
        })),
      })),
    }));
  } catch {
    // Without storage the queue just doesn't survive a restart.
  }
}

function changed() {
  persist();
  emit();
}

function restored(run) {
  const done = run.status === "done";
  return { ...newRun(run.difficulty), ...run, sep: done ? 1 : 0, beats: done ? 1 : 0, chart: done ? 1 : 0 };
}

// The queue comes back after a restart, waiting to be started again.
function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  if (!hasElectronEngine() || isWebApp()) return;
  keepAwake(false);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!saved) return;
    const items = (saved.items || []).map((item) => ({
      ...newItem(item),
      lengthKnown: Boolean(item.lengthKnown),
      saved: Boolean(item.saved),
      hardwareMode: item.hardwareMode === "cpu" ? "cpu" : "auto",
      runs: (item.runs || []).map(restored),
    }));
    state = {
      ...state,
      items,
      settings: { ...state.settings, ...saved.settings },
      open: items.some((item) => item.runs.some((run) => run.status === "waiting")),
    };
  } catch {
    // A damaged saved queue starts empty.
  }
}

export function subscribeQueue(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getQueue() {
  ensureLoaded();
  return state;
}

function newRun(difficulty) {
  return { difficulty, status: "waiting", separates: false, sep: 0, beats: 0, chart: 0, error: "", canUseCpu: false, jobId: "" };
}

function newItem({ songId, title, artist, durationSec, separated }) {
  return {
    songId,
    title: title || "Untitled",
    artist: artist || "",
    durationSec: Number(durationSec) > 0 ? Number(durationSec) : FALLBACK_SECONDS,
    lengthKnown: Number(durationSec) > 0,
    separated: Array.isArray(separated) ? separated : [],
    runs: [],
    stage: "",
    onCpu: false,
    hardwareMode: "auto",
    saved: false,
    saveError: "",
  };
}

// The stem sets a project already has for its unpadded audio.
function separatedStemSets(record) {
  const stemSets = new Set();
  for (const artifact of record?.sourceArtifacts?.demucs?.items || []) {
    if ((artifact.sourceVariantKey || artifact.sourceTransform?.key || "lead-in:0") !== "lead-in:0") continue;
    for (const id of Object.keys(artifact.stemSets || {})) stemSets.add(id);
    if (artifact.cache?.workspace || Object.values(artifact.stems || {}).some((stem) => stem?.path)) stemSets.add("htdemucs");
  }
  return [...stemSets];
}

function itemFromRecord(record) {
  return newItem({
    songId: record.id,
    title: record.meta?.title,
    artist: record.meta?.artist,
    durationSec: record.meta?.durationSec,
    separated: separatedStemSets(record),
  });
}

// Waiting runs follow the settings; runs already underway or finished stay.
// Only a song's first run separates it, and a song that has stems skips it.
function plan(item) {
  const generator = state.generator;
  const kept = item.runs.filter((run) => run.status !== "waiting");
  const waiting = FINAL_SLOT_ORDER
    .filter((difficulty) => state.settings.difficulties.includes(difficulty))
    .filter((difficulty) => !kept.some((run) => run.difficulty === difficulty))
    .map((difficulty) => item.runs.find((run) => run.status === "waiting" && run.difficulty === difficulty) || newRun(difficulty));
  let separates = (!generator || readsStems(generator))
    && !item.separated.includes(generatorStemSetId(generator))
    && !kept.some((run) => run.status === "running");
  for (const run of waiting) {
    run.separates = separates;
    separates = false;
  }
  item.runs = [...kept, ...waiting];
}

function runWork(item, run) {
  return item.durationSec * (WORK.beats + WORK.chart + (run.separates ? WORK.sep : 0));
}

function runWorkDone(item, run) {
  if (run.status === "done") return runWork(item, run);
  if (run.status !== "running") return 0;
  return item.durationSec * (WORK.beats * run.beats + WORK.chart * run.chart + (run.separates ? WORK.sep * run.sep : 0));
}

export function itemPercent(item) {
  let total = 0;
  let done = 0;
  for (const run of item.runs) {
    if (run.status === "failed") continue;
    total += runWork(item, run);
    done += runWorkDone(item, run);
  }
  return total ? Math.round((done / total) * 100) : 0;
}

export function queueSummary(queue = getQueue()) {
  const summary = { songs: queue.items.length, charts: 0, done: 0, waiting: 0, running: 0, failed: 0, toSave: 0, percent: 0 };
  let total = 0;
  let done = 0;
  for (const item of queue.items) {
    for (const run of item.runs) {
      summary.charts += 1;
      summary[run.status === "waiting" ? "waiting" : run.status === "running" ? "running" : run.status === "done" ? "done" : "failed"] += 1;
      if (run.status === "failed") continue;
      total += runWork(item, run);
      done += runWorkDone(item, run);
    }
    if (!item.saved && item.runs.some((run) => run.status === "done")) summary.toSave += 1;
  }
  const finished = !summary.waiting && !summary.running && summary.done > 0;
  summary.percent = finished ? 100 : total ? Math.min(99, Math.round((done / total) * 100)) : 0;
  return summary;
}

// What a song's tile shows: "waiting:3", "running:42", "done" or "failed".
export function queueMarks(queue = getQueue()) {
  const marks = new Map();
  queue.items.forEach((item, index) => {
    const statuses = item.runs.map((run) => run.status);
    marks.set(item.songId, statuses.includes("running")
      ? `running:${itemPercent(item)}`
      : statuses.includes("waiting")
        ? `waiting:${index + 1}`
        : statuses.includes("failed")
          ? "failed"
          : "done");
  });
  return marks;
}

// Songs are weighed by length, and most projects don't have theirs saved.
let readingLengths = false;
async function readLengths() {
  if (readingLengths) return;
  readingLengths = true;
  for (let item; (item = state.items.find((candidate) => !candidate.lengthKnown));) {
    item.lengthKnown = true;
    try {
      const seconds = await readSongAudioSeconds(await getSongRecord(item.songId));
      if (seconds > 0) {
        item.durationSec = seconds;
        changed();
      }
    } catch {
      // Keeps the typical length.
    }
  }
  readingLengths = false;
}

export function setQueueOpen(open) {
  getQueue();
  if (state.open === Boolean(open)) return;
  state.open = Boolean(open);
  emit();
}

export function addToQueue(records) {
  getQueue();
  const fresh = records
    .filter((record) => record && !state.items.some((item) => item.songId === record.id))
    .map(itemFromRecord);
  if (!fresh.length) return;
  fresh.forEach(plan);
  state.items = [...state.items, ...fresh];
  state.note = "";
  changed();
  readLengths();
}

function isRunning(item) {
  return item.runs.some((run) => run.status === "running");
}

// A song being charted stays until it's finished or stopped.
export function removeFromQueue(songIds) {
  getQueue();
  const ids = new Set(songIds);
  const next = state.items.filter((item) => !ids.has(item.songId) || isRunning(item));
  if (next.length === state.items.length) return;
  state.items = next;
  state.note = "";
  changed();
}

export function toggleInQueue(record) {
  if (getQueue().items.some((item) => item.songId === record?.id)) removeFromQueue([record.id]);
  else addToQueue([record]);
}

export function clearQueue() {
  if (getQueue().running) return;
  state.items = [];
  state.note = "";
  changed();
}

export function setQueueSettings(patch) {
  getQueue();
  state.settings = { ...state.settings, ...patch };
  if (!state.running) state.items.forEach(plan);
  changed();
}

// The model the queue charts with, as listed by the engine.
export function setQueueGenerator(generator) {
  getQueue();
  const supported = generatorDifficultyIds(generator);
  const difficulties = state.settings.difficulties.filter((difficulty) => supported.includes(difficulty));
  state.generator = generator;
  state.settings = {
    ...state.settings,
    generatorId: generator?.id || "",
    difficulties: difficulties.length ? difficulties : [supported.includes("expert") ? "expert" : supported[supported.length - 1]],
  };
  if (!state.running) state.items.forEach(plan);
  changed();
  readLengths();
}

const WATCHED_EVENTS = new Set(["stage", "log", "partial_chart", "analysis_audio", "runtime_fallback", "song_map"]);

// The job charting this song right now, for its project page to show.
export function queueJobIdFor(songId) {
  return current && current.item.songId === songId ? current.run.jobId : "";
}

export function queueJobFor(songId) {
  if (!queueJobIdFor(songId)) return null;
  const { item, run, seen, startedAt } = current;
  return {
    jobId: run.jobId,
    startedAt,
    difficulty: run.difficulty,
    hardwareMode: item.hardwareMode,
    generatorId: state.generator?.id || "",
    generatorLabel: state.generator?.label || "",
    presetName: GENERATION_PRESETS.find((preset) => preset.id === state.settings.presetId)?.name || "",
    title: item.title,
    artist: item.artist,
    events: [...seen.values()],
  };
}

export function queueRunByJob(jobId) {
  return state.items.flatMap((item) => item.runs).find((run) => run.jobId === jobId) || null;
}

function handleEvent(event) {
  if (!current || event?.jobId !== current.run.jobId) return;
  const { item, run, seen } = current;
  // What a project opened mid-run needs to catch up. A chart's notes arrive whole
  // each time, so the latest event of each kind is enough; the song map comes in
  // pieces, so each piece is kept.
  if (WATCHED_EVENTS.has(event.type)) {
    const key = event.type === "song_map"
      ? `song_map:${event.kind}:${event.final ? "final" : event.from || 0}`
      : `${event.type}:${event.stage || ""}`;
    const earlier = seen.get(key);
    seen.set(key, { ...earlier, ...event, ...(earlier?.time ? { since: earlier.since || earlier.time } : {}) });
  }
  const before = `${itemPercent(item)}:${item.stage}:${item.onCpu}`;
  if (event.type === "stage") {
    const label = STAGE_LABELS[event.stage];
    if (label && event.status !== "completed") item.stage = label;
    const finished = event.status === "completed" || event.cache === "hit";
    if (event.stage === "demucs") {
      if (finished) run.sep = 1;
      else if (Number.isFinite(event.progress)) run.sep = Math.max(run.sep, Math.min(1, event.progress));
    } else if (event.stage === "timing" || event.stage === "smoothing") {
      run.sep = 1;
      if (finished) run.beats = 1;
    } else if (event.stage === "transcription" && finished) {
      run.chart = 1;
    }
  } else if (event.type === "partial_chart") {
    const total = Number(event.totalBeats) || 0;
    if (total > 0) {
      run.beats = 1;
      run.chart = Math.max(run.chart, Math.min(1, (Number(event.committedBeats) || 0) / total));
    }
  } else if (event.type === "runtime_fallback") {
    item.onCpu = true;
  }
  if (before !== `${itemPercent(item)}:${item.stage}:${item.onCpu}`) emit();
}

function cleanError(error) {
  const message = String(error?.message || error || "Generation failed.")
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  return /\bENOENT\b/.test(message) ? "This project's song file is missing." : message;
}

// The saved default separation, or the one the project picked if it can be reused.
function separationFor(record) {
  const demucs = record.sourceArtifacts?.demucs || {};
  const activeId = demucs.activeBySourceVariant?.[NO_LEAD_IN.key] || demucs.activeId || DEFAULT_DEMUCS_ID;
  const stored = (demucs.items || []).find((artifact) => artifact.id === activeId);
  if (stored && ((stored.engineId || stored.id) === DEFAULT_DEMUCS_ID || stored.cache?.workspace)) return stored;
  return { id: DEFAULT_DEMUCS_ID, name: "Default separation", sourceTransform: NO_LEAD_IN, sourceVariantKey: NO_LEAD_IN.key };
}

async function chartInput(item, run) {
  const record = await getSongRecord(item.songId);
  if (!record) throw new Error("This project is gone from the library.");
  const audioSource = await getStoredAssetSource(item.songId, record.assets?.audio);
  if (audioSource?.kind !== "project-asset") throw new Error("This project has no saved song file.");
  const generator = state.generator;
  const versions = record.versions || [];
  const sourceChart = sourceChartPayloadFromVersions(versions, record);
  const timingDetector = sourceChart ? SOURCE_CHART_TIMING_DETECTOR_ID : DEFAULT_TIMING_DETECTOR_ID;
  const settings = buildGenerationSettings({
    generatorId: generator.id,
    generator,
    defaultTimingDetector: timingDetector,
    controls: controlsForGenerationPreset(state.settings.presetId, {
      ...DEFAULT_GENERATION_CONTROLS,
      difficulty: run.difficulty,
      timingDetector,
    }),
  });
  const { title, artist, album, year, genre } = record.meta || {};
  return {
    jobId: run.jobId,
    hardwareMode: item.hardwareMode,
    generatorId: generator.id,
    audioSource,
    audioName: audioSource.name,
    difficulty: settings.difficulty,
    generation: { ...settings.generation, sourceTransform: NO_LEAD_IN, modelPicked: true },
    stripSustains: settings.generation.resolved.stripSustains,
    demucsSeparation: separationFor(record),
    sourceTransform: NO_LEAD_IN,
    sourceChart,
    metadata: { title, artist, album, year, genre, charter: "Autochart" },
    versionName: generationVersionName(
      generator.label,
      settings.generation,
      versions.filter((version) => version.source === "generated").length + 1
    ),
    replaceFinal: true,
  };
}

// A project's run goes first; the queue carries on once it's over.
async function waitForProjects(item) {
  while (projectRunsActive() && !stopRequested) {
    item.stage = "Waiting for your project";
    emit();
    await Promise.race([whenProjectsIdle(), stopSignal]);
  }
}

async function runChart(item, run) {
  Object.assign(run, { status: "running", sep: 0, beats: 0, chart: 0, error: "", canUseCpu: false, jobId: crypto.randomUUID() });
  item.stage = STAGE_LABELS.audio;
  item.onCpu = false;
  item.saved = false;
  item.saveError = "";
  current = { item, run, seen: new Map(), startedAt: Date.now() };
  emit();
  try {
    const input = await chartInput(item, run);
    await waitForProjects(item);
    if (stopRequested) {
      run.status = "waiting";
      return;
    }
    item.stage = STAGE_LABELS.audio;
    emit();
    const result = await generateQueueChart(input);
    if (result?.status === "canceled") {
      run.status = "waiting";
    } else if (result?.savedVersion) {
      run.status = "done";
      if (readsStems(state.generator)) {
        const stemSet = generatorStemSetId(state.generator);
        if (!item.separated.includes(stemSet)) item.separated.push(stemSet);
      }
    } else {
      throw new Error("The engine didn't return a chart.");
    }
  } catch (error) {
    run.status = "failed";
    run.error = cleanError(error);
    run.canUseCpu = canRetryUsingCpu({
      finishedAt: 1,
      ok: false,
      canceled: false,
      hardwareMode: item.hardwareMode,
      runtimeFallback: item.onCpu ? {} : null,
      error: run.error,
    });
  } finally {
    current = null;
    item.stage = "";
    plan(item);
    changed();
  }
}

async function saveItem(item) {
  const record = await getSongRecord(item.songId);
  if (!record) throw new Error("This project is gone from the library.");
  const finalVersion = await ensureFinalVersionSaved(record);
  await saveChartToCloneHeroLibrary(item.songId, finalVersion.id);
  item.saved = true;
  item.saveError = "";
}

// Each song saves as it finishes, with every chart it's going to get.
async function autoSave(item) {
  if (!state.settings.saveWhenDone || item.saved) return;
  if (item.runs.some((run) => run.status === "waiting" || run.status === "running")) return;
  if (!item.runs.some((run) => run.status === "done")) return;
  try {
    await saveItem(item);
  } catch (error) {
    item.saveError = cleanError(error);
  }
  changed();
}

export async function startQueue() {
  getQueue();
  if (state.running || !state.generator) return;
  stopRequested = false;
  stopSignal = new Promise((resolve) => {
    wakeStop = resolve;
  });
  state.running = true;
  state.stopping = false;
  state.note = "";
  emit();
  keepAwake(true);
  const unsubscribe = subscribeGenerationEvents(handleEvent);
  try {
    while (!stopRequested) {
      const item = state.items.find((candidate) => candidate.runs.some((run) => run.status === "waiting"));
      if (!item) break;
      await runChart(item, item.runs.find((run) => run.status === "waiting"));
      await autoSave(item);
    }
  } finally {
    unsubscribe();
    keepAwake(false);
    state.running = false;
    state.stopping = false;
    changed();
  }
}

// Stops the song being charted; everything not finished stays waiting.
export function stopQueue() {
  if (!state.running || state.stopping) return;
  stopRequested = true;
  state.stopping = true;
  emit();
  wakeStop?.();
  if (current?.run.jobId) cancelGeneration(current.run.jobId).catch(() => {});
}

export function retryQueueItem(songId, { cpu = false } = {}) {
  const item = getQueue().items.find((candidate) => candidate.songId === songId);
  if (!item) return;
  if (cpu) item.hardwareMode = "cpu";
  for (const run of item.runs) {
    if (run.status === "failed") Object.assign(run, newRun(run.difficulty));
  }
  plan(item);
  changed();
  startQueue();
}

// Saving and exporting take whatever has finished, and can run while the queue does.
export async function saveQueueToGame() {
  const targets = getQueue().items.filter((item) => !item.saved && item.runs.some((run) => run.status === "done"));
  if (!targets.length || state.saving) return;
  state.note = "";
  let done = 0;
  state.saving = { kind: "save", done, total: targets.length };
  emit();
  try {
    for (const item of targets) {
      try {
        await saveItem(item);
      } catch (error) {
        if (isMissingLibraryFolderError(error)) throw error;
        item.saveError = cleanError(error);
      }
      done += 1;
      state.saving = { kind: "save", done, total: targets.length };
      changed();
    }
  } finally {
    state.saving = null;
    changed();
  }
}

export async function exportQueue() {
  const targets = getQueue().items.filter((item) => item.runs.some((run) => run.status === "done"));
  if (!targets.length || state.saving) return;
  state.note = "";
  emit();
  const folder = await chooseExportFolder();
  if (folder?.canceled || !folder?.grant) return;
  let done = 0;
  let exported = 0;
  state.saving = { kind: "export", done, total: targets.length };
  emit();
  try {
    for (const item of targets) {
      try {
        const record = await getSongRecord(item.songId);
        if (!record) throw new Error("This project is gone from the library.");
        const finalVersion = await ensureFinalVersionSaved(record);
        await exportChartToChosenFolder(item.songId, finalVersion.id, folder.grant);
        item.saveError = "";
        exported += 1;
      } catch (error) {
        item.saveError = cleanError(error);
      }
      done += 1;
      state.saving = { kind: "export", done, total: targets.length };
      emit();
    }
    state.note = `Exported ${exported} ${exported === 1 ? "song" : "songs"} to ${folder.path}`;
  } finally {
    state.saving = null;
    emit();
  }
}

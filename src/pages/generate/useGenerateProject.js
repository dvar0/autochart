import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import chartWriter from "@autochart/chart-writer";
import { DIFF } from "../../data/difficultyMetadata.js";
import { GAME_LIBRARY_NAME } from "../../data/gameLibrary.js";
import { parseChart } from "../../lib/chart/parseChart.js";
import { buildPlayableTrack } from "../../lib/chart/tempoMap.js";
import {
  buildEditorPreviewTrack,
  makeEditedVersion,
  nextEditName,
  parseEditableChart,
  updateEditedVersion,
  writeEditableChart,
} from "./edit/chartEditor.js";
import { isUnsupportedGenerationTarget } from "./generationGate.js";
import { canRetryUsingCpu } from "./hardwareRecovery.js";
import {
  beginExclusiveMediaTransaction,
  beginMediaRequest,
  buildSourceReplacementRecord,
} from "./sourceReplacement.js";
import { createEditorState, editorReducer } from "./edit/editorReducer.js";
import {
  DEFAULT_GENERATION_CONTROLS,
  DEFAULT_GENERATOR_ID,
  DEFAULT_TIMING_DETECTOR_ID,
  SOURCE_CHART_TIMING_DETECTOR_ID,
  TRANSCRIBER_MODEL,
  buildGenerationSettings,
  controlsForGenerationPreset,
  controlsFromSavedGeneration,
  getGenerationPreset,
  generationVersionName,
  normalizeLeadInSilenceSeconds,
  timingDetectorLabel,
} from "../../data/generationSettings.js";
import { createGeneratedVersionFromResult } from "../../services/chartVersions.js";
import {
  FINAL_ARRANGEMENT_ID,
  FINAL_SLOT_ORDER,
  FINAL_VERSION_ID,
  buildFinalArrangementList as buildFinalArrangementListForRecord,
  buildFinalChartVersion,
  buildFinalSlotVersions,
  cleanFinalSlots,
  emptyFinalSlots,
  finalSlotsFromRecord,
  finalValidationMessage,
  versionSourceVariantKey,
} from "../../services/finalChart.js";
import {
  exportChart,
  cancelGeneration,
  generateChart,
  listGenerators,
  prepareDemucs,
  requiresPathBackedAudio,
  readEngineCacheFile,
  readDemucsStem,
  saveChartToCloneHeroLibrary,
  subscribeGenerationEvents,
} from "../../services/generation.js";
import { isVideoMedia, makeVideoThumbnail, readMediaFileMetadata } from "../../services/mediaMetadata.js";
import { resolveVideoBackground } from "../../services/videoPreview.js";
import useLibraryFolderGate, { isMissingLibraryFolderError } from "../../hooks/useLibraryFolderGate.js";
import {
  getSongRecord,
  getStoredAssetSource,
  playableVersionsFromRecord,
  recordToImported,
  saveSongRecord,
  updateSongRecord,
} from "../../services/songLibrary.js";
import { DEFAULT_DEMUCS_ID, newSongId } from "../../services/songSchema.js";

const EMPTY_DETAILS = { title: "", artist: "", album: "", year: "", genre: "", charter: "Autochart" };
export const MIN_COMPARE_CHARTS = 2;
export const MAX_COMPARE_CHARTS = 4;
export const COMPARE_SLOT_LABELS = ["A", "B", "C", "D"];
// Per-slot histogram colors for the compare timeline (A purple, B orange, …).
export const COMPARE_LANE_COLORS = ["#6860b5", "#ea76cb", "#5a9e7a", "#c49030"];

function emptySourceArtifacts() {
  return { demucs: { activeId: DEFAULT_DEMUCS_ID, activeBySourceVariant: {}, items: [] } };
}

function normalizeSourceArtifactsState(sourceArtifacts = {}) {
  const demucs = sourceArtifacts.demucs || {};
  return {
    ...sourceArtifacts,
    demucs: {
      activeId: demucs.activeId || DEFAULT_DEMUCS_ID,
      activeBySourceVariant: demucs.activeBySourceVariant || {},
      items: Array.isArray(demucs.items) ? demucs.items.filter(Boolean) : [],
    },
  };
}

function sourceTransformFromKey(key = "lead-in:0") {
  const ms = Number(String(key).match(/lead-in:(\d+)/)?.[1] || 0);
  const leadInSilenceMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const leadInSilenceSeconds = leadInSilenceMs / 1000;
  return {
    kind: leadInSilenceMs > 0 ? "lead-in-silence" : "original",
    leadInSilenceSeconds,
    leadInSilenceMs,
    key: `lead-in:${leadInSilenceMs}`,
    label: leadInSilenceMs > 0 ? `+${leadInSilenceSeconds}s lead-in` : "No lead-in",
  };
}

function defaultDemucsIdForSourceVariant(sourceVariantKey = "lead-in:0") {
  return sourceVariantKey === "lead-in:0"
    ? DEFAULT_DEMUCS_ID
    : `${DEFAULT_DEMUCS_ID}__${sourceVariantKey.replace(/[^a-z0-9]+/gi, "_")}`;
}

function compactSourceVariantLabel(sourceTransform = null) {
  const ms = Number(sourceTransform?.leadInSilenceMs || 0);
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = ms / 1000;
  return `+${Number.isInteger(seconds) ? seconds : seconds.toFixed(2).replace(/0+$/g, "").replace(/\.$/, "")}s`;
}

function defaultDemucsName(sourceTransform = null) {
  const ms = Number(sourceTransform?.leadInSilenceMs || 0);
  return Number.isFinite(ms) && ms > 0 ? `Default separation (${sourceTransform.label || compactSourceVariantLabel(sourceTransform)})` : "Default separation";
}

function defaultDemucsArtifact(stored = null, sourceTransform = null) {
  const transform = sourceTransform || stored?.sourceTransform || sourceTransformFromKey(stored?.sourceVariantKey);
  const sourceVariantKey = transform.key || "lead-in:0";
  return {
    id: stored?.id || defaultDemucsIdForSourceVariant(sourceVariantKey),
    engineId: stored?.engineId || DEFAULT_DEMUCS_ID,
    name: defaultDemucsName(transform),
    status: stored?.status || "on-demand",
    createdAt: stored?.createdAt || 0,
    updatedAt: stored?.updatedAt || 0,
    profile: stored?.profile || "Standard Demucs",
    audioSha256: stored?.audioSha256 || null,
    stems: stored?.stems || {},
    cache: stored?.cache || {},
    provenance: stored?.provenance || null,
    metrics: stored?.metrics || null,
    sourceTransform: transform,
    sourceVariantKey,
    source: "default",
  };
}

function sourceTransformFromControls(controls = {}) {
  const leadInSilenceSeconds = normalizeLeadInSilenceSeconds(controls.leadInSilenceSeconds);
  const leadInSilenceMs = Math.round(leadInSilenceSeconds * 1000);
  return {
    kind: leadInSilenceMs > 0 ? "lead-in-silence" : "original",
    leadInSilenceSeconds,
    leadInSilenceMs,
    key: `lead-in:${leadInSilenceMs}`,
    label: leadInSilenceMs > 0 ? `+${leadInSilenceSeconds}s lead-in` : "No lead-in",
  };
}

function sourceTransformFromVersion(version = null) {
  const transform = version?.provenance?.sourceTransform;
  if (transform?.key) return transform;
  return sourceTransformFromKey(versionSourceVariantKey(version));
}

function leadInSilenceMsFromVersion(version = null) {
  const values = [
    version?.meta?.leadInSilenceMs,
    version?.provenance?.sourceTransform?.leadInSilenceMs,
    version?.settings?.generation?.sourceTransform?.leadInSilenceMs,
  ];
  for (const value of values) {
    const ms = Number(value);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  const transform = sourceTransformFromVersion(version);
  const ms = Number(transform?.leadInSilenceMs || 0);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function demucsArtifactsFromSource(sourceArtifacts = {}, sourceTransforms = []) {
  const normalized = normalizeSourceArtifactsState(sourceArtifacts);
  const items = normalized.demucs.items || [];
  const transforms = new Map();
  for (const transform of [sourceTransformFromKey(), ...sourceTransforms]) {
    if (transform?.key) transforms.set(transform.key, transform);
  }
  for (const item of items) {
    const transform = item.sourceTransform || sourceTransformFromKey(item.sourceVariantKey);
    if (transform?.key) transforms.set(transform.key, transform);
  }
  const defaultArtifacts = [...transforms.values()].map((transform) => {
    const defaultId = defaultDemucsIdForSourceVariant(transform.key);
    const stored = items.find(
      (item) =>
        (item.id === defaultId || item.id === DEFAULT_DEMUCS_ID || item.engineId === DEFAULT_DEMUCS_ID) &&
        (item.sourceVariantKey || item.sourceTransform?.key || "lead-in:0") === transform.key
    );
    return defaultDemucsArtifact(stored, transform);
  });
  const generatedArtifacts = items.filter((item) => (item.engineId || item.id) !== DEFAULT_DEMUCS_ID);
  return [...defaultArtifacts, ...generatedArtifacts];
}

function upsertDemucsArtifact(sourceArtifacts, artifact, activeId = null) {
  const normalized = normalizeSourceArtifactsState(sourceArtifacts);
  const items = normalized.demucs.items || [];
  const nextItems = [artifact, ...items.filter((item) => item.id !== artifact.id)];
  const sourceVariantKey = artifact.sourceVariantKey || artifact.sourceTransform?.key || "lead-in:0";
  const activeBySourceVariant = {
    ...normalized.demucs.activeBySourceVariant,
    ...(activeId ? { [sourceVariantKey]: activeId } : {}),
  };
  return {
    ...normalized,
    demucs: {
      activeId: sourceVariantKey === "lead-in:0"
        ? activeId || normalized.demucs.activeId || artifact.id || DEFAULT_DEMUCS_ID
        : normalized.demucs.activeId || DEFAULT_DEMUCS_ID,
      activeBySourceVariant,
      items: nextItems,
    },
  };
}

// Whether a separation already has cached stems on disk. When it does, a
// generation reuses them and never re-runs Demucs, so the live card must not
// claim it's "separating stems" — that only happens for a fresh separation
// (e.g. a new lead-in variant).
function separationIsCached(artifact) {
  if (!artifact) return false;
  if (artifact.cache?.workspace) return true;
  return Object.values(artifact.stems || {}).some((stem) => stem?.path);
}

function demucsArtifactFromResult(result, fallback = {}) {
  const now = Date.now();
  return {
    id: fallback.id || result.id || DEFAULT_DEMUCS_ID,
    engineId: result.engineId || fallback.engineId || result.id || fallback.id || DEFAULT_DEMUCS_ID,
    name: result.name || fallback.name || "Demucs separation",
    status: "ready",
    createdAt: result.createdAt || fallback.createdAt || now,
    updatedAt: now,
    profile: result.profile || fallback.profile || "Standard Demucs",
    audioSha256: result.audioSha256 || fallback.audioSha256 || null,
    stems: result.stems || fallback.stems || {},
    cache: result.cache || fallback.cache || {},
    provenance: result.provenance || fallback.provenance || null,
    metrics: result.metrics || fallback.metrics || null,
    sourceTransform: result.sourceTransform || fallback.sourceTransform || null,
    sourceVariantKey: result.sourceTransform?.key || fallback.sourceVariantKey || "lead-in:0",
  };
}

function sourceVariantKeyFromArtifact(artifact = null) {
  return artifact?.sourceVariantKey || artifact?.sourceTransform?.key || "lead-in:0";
}

function newDemucsId() {
  return `demucs_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function generatorDifficultyIds(generator) {
  const raw = Array.isArray(generator?.capabilities?.difficulties)
    ? generator.capabilities.difficulties
    : [];
  const supported = raw
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => FINAL_SLOT_ORDER.includes(value));
  return supported.length ? supported : FINAL_SLOT_ORDER;
}

function preferredGeneratorDifficulty(generator) {
  const supported = generatorDifficultyIds(generator);
  return supported.includes("expert") ? "expert" : supported[supported.length - 1] || "expert";
}

function stageStatusMessage(event) {
  const names = {
    queued: "Queued generation job",
    timing: "Detecting timing grid",
    smoothing: "Smoothing timing grid",
    demucs: "Preparing Demucs separation",
    features: "Building stem features",
    chart: "Generating chart",
    done: "Finalizing chart",
    saved: "Loading generated chart",
  };
  const name = names[event.stage] || event.stage || "Generation";
  if (event.cache === "hit") return `${name} cache hit.`;
  if (event.status === "completed") return `${name} complete.`;
  if (event.status === "failed") return `${name} failed.`;
  return `${name}…`;
}

// Scrape a percentage out of an engine log line (tqdm bars, "45.2%", etc).
// Returns the last percent mentioned, or null when the line has none.
function parseLogPercent(message = "") {
  const matches = String(message).match(/(\d{1,3}(?:\.\d+)?)\s*%/g);
  if (!matches) return null;
  const value = Number.parseFloat(matches[matches.length - 1]);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function initialCompareVersionIds(versions, importedVersion, generatedVersion) {
  const first = importedVersion?.id || versions[0]?.id || "imported";
  const second = generatedVersion?.id || versions[1]?.id || first;
  return [first, second];
}

function fileBaseName(name) {
  return name.replace(/\.[^/.]+$/, "").replace(/[_.-]+/g, " ").trim();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function cleanPartialNoteLines(lines = []) {
  return lines
    .map((line) => Array.isArray(line) ? line.slice(0, 3).map((value) => Number(value)) : null)
    .filter((line) => line && line.every(Number.isFinite));
}

function mergePartialChartEvent(previous = null, event = {}) {
  const timing = event.timing || previous?.timing || null;
  const noteLines = Array.isArray(event.noteLines)
    ? cleanPartialNoteLines(event.noteLines)
    : previous?.noteLines || [];
  return {
    ...(previous || {}),
    timing,
    noteLines,
    sequence: Number(event.sequence) || previous?.sequence || 0,
    complete: Boolean(event.complete),
    committedBeats: Number(event.committedBeats) || 0,
    totalBeats: Number(event.totalBeats) || previous?.totalBeats || 0,
    tokenCount: Number(event.tokenCount) || previous?.tokenCount || 0,
    eventCount: Number(event.eventCount) || previous?.eventCount || 0,
    noteLineCount: Number(event.noteLineCount) || noteLines.length,
    decodeIssues: event.decodeIssues || previous?.decodeIssues || null,
    updatedAt: Date.now(),
  };
}

function chartTextFromPartial(live, difficulty = "expert", metadata = {}) {
  const timing = live?.timing;
  const syncLines = Array.isArray(timing?.syncLines) ? timing.syncLines : [];
  if (!syncLines.length) return "";
  return chartWriter.writeChartText(cleanPartialNoteLines(live.noteLines), {
    title: metadata.title || "Live Transcription",
    artist: metadata.artist || "Unknown Artist",
    charter: "Autochart",
    genre: metadata.genre || "",
    difficulty,
    resolution: Number(timing.resolution) || 192,
    offset: Number(timing.offset) || 0,
    syncLines,
  }).text;
}

function buildLiveGenerationPreview(live, difficulty, metadata) {
  if (!live) return null;
  const chartText = chartTextFromPartial(live, difficulty, metadata);
  const committedBeats = Number(live.committedBeats) || 0;
  const totalBeats = Number(live.totalBeats) || 0;
  const percent = totalBeats ? Math.min(100, Math.max(0, (committedBeats / totalBeats) * 100)) : 0;
  if (!chartText) {
    return { ...live, chartText: "", track: null, percent, noteCount: 0, durationSec: 0, committedSeconds: 0 };
  }
  try {
    const chart = parseChart(chartText);
    const track = buildPlayableTrack(chart, difficulty);
    const resolution = Number(chart.song?.resolution) || Number(live.timing?.resolution) || 192;
    const lastNote = track.notes[track.notes.length - 1];
    const durationSec = totalBeats ? track.tempoMap.tickToSeconds(totalBeats * resolution) : lastNote?.endTime || 0;
    const committedSeconds = committedBeats ? track.tempoMap.tickToSeconds(committedBeats * resolution) : 0;
    track.visualDuration = Math.max(durationSec, committedSeconds, lastNote?.endTime || 0);
    return {
      ...live,
      chartText,
      track,
      percent,
      durationSec,
      committedSeconds,
      noteCount: track.notes.length,
    };
  } catch {
    return { ...live, chartText, track: null, percent, noteCount: 0, durationSec: 0, committedSeconds: 0 };
  }
}

export function fmtTime(seconds) {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function revokeObjectUrlRef(ref) {
  if (ref.current) {
    URL.revokeObjectURL(ref.current);
    ref.current = null;
  }
}

function stemDisplayName(stem) {
  const names = {
    other: "Guitar / other stem",
    drums: "Drums stem",
    bass: "Bass stem",
    vocals: "Vocals stem",
  };
  return names[stem] || `${stem} stem`;
}

function versionForSave(version) {
  if (!version) return null;
  const { track, difficulty, noteCount, ...rest } = version;
  return rest;
}

function randomSeedValue() {
  return String(Math.floor(1000 + Math.random() * 9999000));
}

function sourceChartPayloadFromVersions(versions = [], importedSong = null) {
  const sourceVersion = versions.find((v) => v.source === "imported-chart" && v.chart?.text) || null;
  const chartText = sourceVersion?.chart?.text || (importedSong?.source !== "generated" ? importedSong?.chart?.text : "") || "";
  if (!chartText) return null;
  return {
    text: chartText,
    versionId: sourceVersion?.id || "imported",
    name: sourceVersion?.name || "Imported Clone Hero",
  };
}

// A project that ships a human-charted notes.chart reuses its sync track by
// default; songs generated from bare audio have nothing to reuse.
function defaultTimingDetectorFor(versions, importedSong) {
  return sourceChartPayloadFromVersions(versions, importedSong)?.text
    ? SOURCE_CHART_TIMING_DETECTOR_ID
    : DEFAULT_TIMING_DETECTOR_ID;
}

export default function useGenerateProject({ importedSong, onSaved, onGeneratedSong, onProjectIdentified, visible = true }) {
  const songId = importedSong?.id ?? null;
  const [generationControls, setGenerationControls] = useState(DEFAULT_GENERATION_CONTROLS);
  // Id of the take that just finished generating, so the deck can flash it as
  // new for a beat. Cleared on a timer.
  const [justGeneratedId, setJustGeneratedId] = useState("");
  const justGeneratedTimer = useRef(null);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [generators, setGenerators] = useState([]);
  const [generatorId, setGeneratorId] = useState(DEFAULT_GENERATOR_ID);
  const [setupStatus, setSetupStatus] = useState(null);
  const [engineError, setEngineError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const generationInFlightRef = useRef(false);
  const cpuRetryRef = useRef(null);
  const [statusMsg, setStatusMsg] = useState("");
  // Bumped on each successful library save so the deck button can flash a
  // confirmation. A timestamp (not a bool) lets repeat saves re-trigger it.
  const [librarySavedAt, setLibrarySavedAt] = useState(0);
  // Asks for the songs folder (instead of a status line) when Save hits a
  // missing library folder, then resumes the save.
  const libraryFolderGate = useLibraryFolderGate();
  const [genRun, setGenRun] = useState(null);
  const genRunRef = useRef(null);
  genRunRef.current = genRun;
  // The in-flight run's analysis audio. Loaded when the run uses lead-in
  // silence (the analysis audio is the PADDED source — see below) OR when the
  // source buffer isn't in memory yet (first-time songs have no importedSong
  // until the run saves; without this the live board gets audioBuffer=null and
  // play is silent). For lead-in runs this lets the live board play the same
  // padded timeline the chart is being written in — so 0:00 includes the
  // lead-in, matching the final take — instead of the unpadded source with a
  // negative chart offset. Skipped when lead-in is 0 AND a source buffer
  // already exists (byte-identical duplicate).
  const [liveAnalysisAudioBuffer, setLiveAnalysisAudioBuffer] = useState(null);
  // Whether the preview area should show the live generation board vs the
  // selected version's chart while a run is in flight. Defaults true at the
  // start of each generate (handleGenerate). Selecting any version in the
  // deck clears it so the user can get back to their existing chart; the live
  // stage's own "Chart" pill does the same.
  const [liveStageFocused, setLiveStageFocused] = useState(false);
  // Whether the single-take preview is audibly playing right now. A ref, not
  // state: it's only read at generate time to decide whether the live board
  // may take over the stage — starting a generation must not interrupt a
  // listen (the live take card in the deck stays available to focus it).
  const previewPlayingRef = useRef(false);
  const reportPreviewPlaying = useCallback((playing) => {
    previewPlayingRef.current = Boolean(playing);
  }, []);
  // Ref mirror of previewMode so the async generate flow can read the mode at
  // COMPLETION time (the closure only has the value from when it started).
  const previewModeRef = useRef("single");
  const [details, setDetails] = useState(EMPTY_DETAILS);
  const [pendingAudioFile, setPendingAudioFile] = useState(null);
  const [pendingAlbumFile, setPendingAlbumFile] = useState(null);
  const [pendingAlbumUrl, setPendingAlbumUrl] = useState(null);
  const [background, setBackground] = useState(null);
  const [pendingBgFile, setPendingBgFile] = useState(null);
  const [pendingBgFromAudio, setPendingBgFromAudio] = useState(false);
  const [previewMode, setPreviewMode] = useState("single");
  useEffect(() => {
    previewModeRef.current = previewMode;
  }, [previewMode]);
  const pendingSeedSongIdRef = useRef(null);
  const [deckTab, setDeckTab] = useState("takes");
  const [editorState, dispatchEditor] = useReducer(editorReducer, undefined, () => createEditorState(null));
  const [editorSourceVersionId, setEditorSourceVersionId] = useState("");
  const [editorDraftVersionId, setEditorDraftVersionId] = useState("");
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorSavedAt, setEditorSavedAt] = useState(0);
  const [editorTool, setEditorTool] = useState("select");
  const [editorSnap, setEditorSnap] = useState("1/16");
  const [editorPlayhead, setEditorPlayhead] = useState({ time: 0, duration: 0 });
  const [editorSeekRequest, setEditorSeekRequest] = useState(null);
  const [editorPlayRequest, setEditorPlayRequest] = useState(null);
  const [editorPlaying, setEditorPlaying] = useState(false);
  const [localVersions, setLocalVersions] = useState([]);
  const [finalSlots, setFinalSlots] = useState(() => emptyFinalSlots());
  const [singleVersion, setSingleVersion] = useState("imported");
  const [compareVersionIds, setCompareVersionIds] = useState(["imported"]);
  const [compareSelection, setCompareSelection] = useState([]);
  const [sourceArtifacts, setSourceArtifacts] = useState(() => emptySourceArtifacts());
  const [previewAudioBuffer, setPreviewAudioBuffer] = useState(null);
  const [previewAudioError, setPreviewAudioError] = useState("");
  const [demucsAudition, setDemucsAudition] = useState(null);
  const [demucsAuditionLoadingKey, setDemucsAuditionLoadingKey] = useState("");
  const [demucsAuditionMode, setDemucsAuditionMode] = useState("single");
  const pendingAlbumUrlRef = useRef(null);
  const pendingBgUrlRef = useRef(null);
  const demucsAuditionUrlRef = useRef(null);
  const mediaRequestRef = useRef(0);
  const mediaTransactionRef = useRef(false);
  const busy = Boolean(busyAction);

  useEffect(() => {
    if (!visible) {
      previewPlayingRef.current = false;
      setEditorPlaying(false);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    listGenerators()
      .then((manifest) => {
        if (!active) return;
        const nextGenerators = manifest.generators || [];
        setGenerators(nextGenerators);
        setSetupStatus(
          manifest.setup || manifest.supportedPlatform === false
            ? {
                ...(manifest.setup || {}),
                supportedPlatform: manifest.supportedPlatform,
                platform: manifest.platform,
                arch: manifest.arch,
                ready: Boolean(manifest.setup?.ready),
                message: manifest.error || manifest.setup?.message || "",
                status: manifest.status || manifest.setup?.status || "",
              }
            : null
        );
        setEngineError(manifest.available === false ? manifest.error || "Generator engine is unavailable." : "");
        setGeneratorId(nextGenerators[0]?.id || DEFAULT_GENERATOR_ID);
      })
      .catch((err) => {
        if (!active) return;
        setGenerators([]);
        setSetupStatus(null);
        setEngineError(err.message || "Generator engine is unavailable.");
      });
    return () => {
      active = false;
    };
  }, [visible]);

  useEffect(() => {
    const selected = generators.find((item) => item.id === generatorId) || generators[0] || null;
    if (!selected) return;
    const supported = generatorDifficultyIds(selected);
    setGenerationControls((current) =>
      supported.includes(current.difficulty)
        ? current
        : { ...current, difficulty: preferredGeneratorDifficulty(selected) }
    );
  }, [generatorId, generators, generationControls.difficulty]);

  useEffect(() => {
    return subscribeGenerationEvents((event) => {
      if (!event) return;
      const activeRun = genRunRef.current;
      if (!activeRun || activeRun.finishedAt) return;
      if (event.jobId && event.jobId !== activeRun.jobId) return;
      const forActiveRun = (run) => {
        if (!run || run.finishedAt) return false;
        if (event.jobId && run.jobId && event.jobId !== run.jobId) return false;
        return true;
      };
      if (event.type === "canceled") {
        let matched = false;
        setGenRun((run) => {
          if (!forActiveRun(run)) return run;
          matched = true;
          return { ...run, finishedAt: Date.now(), ok: false, canceled: true, error: "", stopping: false };
        });
        if (matched) setStatusMsg("Stopped.");
        return;
      }
      if (event.type === "stage") {
        setStatusMsg(stageStatusMessage(event));
        setGenRun((run) => {
          if (!forActiveRun(run)) return run;
          const next = {
            ...run,
            stages: {
              ...run.stages,
              [event.stage]: { status: event.status || "running", cache: event.cache === "hit" },
            },
          };
          // The ONNX demucs stage emits a `progress` field as an index/total
          // fraction. Capture it as a 0..100 in-stage percent so the canonical
          // progress function can map it into the demucs stage range only — it
          // must never leak as the whole-run percent.
          if (typeof event.progress === "number" && Number.isFinite(event.progress) && event.stage) {
            const frac = Math.max(0, Math.min(1, event.progress));
            next.stageProgress = { ...(run.stageProgress || {}), [event.stage]: frac * 100 };
          }
          return next;
        });
      } else if (event.type === "partial_chart") {
        setGenRun((run) =>
          forActiveRun(run)
            ? {
                ...run,
                live: mergePartialChartEvent(run.live, event),
              }
            : run
        );
      } else if (event.type === "analysis_audio") {
        // The engine cached the run's analysis audio (padded when the run uses
        // lead-in silence). The live board plays this instead of the unpadded
        // source so in-flight playback matches the final take's timeline. The
        // event's lead-in is authoritative — the main process normalizes and
        // clamps it, and it is what's actually baked into the audio file.
        setGenRun((run) => {
          if (!forActiveRun(run)) return run;
          const ms = Number(event.leadInSilenceMs);
          return {
            ...run,
            analysisAudioPath: event.path || "",
            ...(Number.isFinite(ms) ? { leadInSilenceMs: ms, leadInSeconds: ms / 1000 } : {}),
          };
        });
      } else if (event.type === "runtime_fallback") {
        // The ONNX session loader latched a failed GPU EP (webgpu/cuda/coreml)
        // to CPU for the rest of this run. Surface it once on the run so the
        // progress panel can show a quiet inline notice.
        setGenRun((run) =>
          forActiveRun(run) && !run.runtimeFallback
            ? { ...run, runtimeFallback: { from: event.from || "", reason: event.reason || "" } }
            : run
        );
      } else if (event.type === "log") {
        setGenRun((run) => {
          if (!forActiveRun(run)) return run;
          const logs = [...run.logs, { stream: event.stream || "stdout", message: event.message || "" }];
          const next = { ...run, logs: logs.length > 200 ? logs.slice(logs.length - 200) : logs };
          // Engine log events carry the stage they belong to; any percent in
          // the line (e.g. a tqdm bar) becomes real in-stage progress, mapped
          // into that stage's own range only — never shown raw.
          const percent = parseLogPercent(event.message);
          if (percent != null && event.stage) {
            next.stageProgress = { ...(run.stageProgress || {}), [event.stage]: percent };
          }
          return next;
        });
      } else if (event.type === "error") {
        setStatusMsg(event.message || "Generation failed.");
        setGenRun((run) =>
          forActiveRun(run) ? { ...run, error: event.message || "Generation failed." } : run
        );
      }
    });
  }, []);

  // Drop a stale progress report when the user moves to a different song.
  // The run's songId is updated when a fresh generation saves a new record,
  // so the report survives its own song appearing.
  useEffect(() => {
    setGenRun((run) => (run && run.songId !== songId ? null : run));
  }, [songId]);

  useEffect(() => {
    pendingSeedSongIdRef.current = null;
    mediaRequestRef.current += 1;
    setLiveAnalysisAudioBuffer(null);
    setLiveStageFocused(false);
    setPreviewAudioError("");
    setJustGeneratedId("");
    if (justGeneratedTimer.current) {
      clearTimeout(justGeneratedTimer.current);
      justGeneratedTimer.current = null;
    }
    if (!importedSong) {
      revokeObjectUrlRef(pendingAlbumUrlRef);
      revokeObjectUrlRef(pendingBgUrlRef);
      setDetails(EMPTY_DETAILS);
      setPendingAudioFile(null);
      setPendingAlbumFile(null);
      setPendingAlbumUrl(null);
      setBackground(null);
      setPendingBgFile(null);
      setPendingBgFromAudio(false);
      setGenerationControls(DEFAULT_GENERATION_CONTROLS);
      setAdvancedSettingsOpen(false);
      setStatusMsg("");
      setDeckTab("takes");
      resetEditorSession();
      setPreviewMode("single");
      setLocalVersions([]);
      setFinalSlots(emptyFinalSlots());
      setSingleVersion("imported");
      setCompareVersionIds(["imported"]);
      setCompareSelection([]);
      setSourceArtifacts(emptySourceArtifacts());
      setPreviewAudioBuffer(null);
      revokeObjectUrlRef(demucsAuditionUrlRef);
      setDemucsAudition(null);
      setDemucsAuditionLoadingKey("");
      setDemucsAuditionMode("single");
      return;
    }
    revokeObjectUrlRef(pendingAlbumUrlRef);
    revokeObjectUrlRef(pendingBgUrlRef);
    const m = importedSong.meta || {};
    setDetails({
      title: m.title || "",
      artist: m.artist || "",
      album: m.album || "",
      year: m.year || "",
      genre: m.genre || "",
      charter: importedSong.source === "generated" ? "Autochart" : m.charter || "",
    });
    setBackground(importedSong.background || null);
    setPendingAudioFile(null);
    setPendingAlbumFile(null);
    setPendingAlbumUrl(null);
    setPendingBgFromAudio(false);
    const versions = importedSong.versions || [];
    setGenerationControls(
      controlsFromSavedGeneration(
        importedSong.settings?.generation,
        m.difficulty || importedSong.settings?.difficulty || "expert",
        { fallbackTimingDetector: defaultTimingDetectorFor(versions, importedSong) }
      )
    );
    setAdvancedSettingsOpen(false);
    setPendingBgFile(null);
    setStatusMsg("");
    const importedVersion = versions.find((v) => v.source === "imported-chart") || versions[0];
    const activeVersion = versions.find((v) => v.id === importedSong.activeVersionId);
    const generatedVersion =
      activeVersion?.source === "generated" && activeVersion.status !== "draft"
        ? activeVersion
        : [...versions].reverse().find((v) => v.source === "generated" && v.status !== "draft");
    setLocalVersions(versions);
    setFinalSlots(finalSlotsFromRecord(importedSong, versions));
    setSourceArtifacts(normalizeSourceArtifactsState(importedSong.sourceArtifacts));
    setSingleVersion(importedSong.activeVersionId || importedVersion?.id || "imported");
    setCompareVersionIds(initialCompareVersionIds(versions, importedVersion, generatedVersion));
    setCompareSelection([]);
    setDeckTab("takes");
    resetEditorSession();
    revokeObjectUrlRef(demucsAuditionUrlRef);
    setDemucsAudition(null);
    setDemucsAuditionLoadingKey("");
    setDemucsAuditionMode("single");
    setPreviewMode("single");
  }, [importedSong]);

  useEffect(() => {
    return () => {
      revokeObjectUrlRef(pendingAlbumUrlRef);
      revokeObjectUrlRef(pendingBgUrlRef);
      mediaRequestRef.current += 1;
      revokeObjectUrlRef(demucsAuditionUrlRef);
    };
  }, []);

  const setField = (key) => (e) =>
    setDetails((d) => ({ ...d, [key]: e.target.value }));

  // Cover extraction follows video readiness without holding up import,
  // playback, or generation. A source change/unmount discards stale results.
  useEffect(() => {
    if (background?.type !== "video" || importedSong?.albumUrl || pendingAlbumUrlRef.current) return;
    let active = true;
    (async () => {
      try {
        const url = await resolveVideoBackground(background);
        if (!active || !url) return;
        const cover = await makeVideoThumbnail(background.file || { name: "video" }, url);
        if (!active || !cover || pendingAlbumUrlRef.current) return;
        const coverUrl = URL.createObjectURL(cover);
        pendingAlbumUrlRef.current = coverUrl;
        setPendingAlbumFile(cover);
        setPendingAlbumUrl(coverUrl);
        // Generation may have already saved the source while video was being
        // prepared. Patch only the cover so its take/settings remain current.
        const projectId = songId || pendingSeedSongIdRef.current;
        if (projectId) {
          await updateSongRecord(projectId, { _blobs: { albumArt: cover } });
          if (active) onSaved?.();
        }
      } catch {
        // The highway reports preview errors; a missing cover cannot block audio.
      }
    })();
    return () => { active = false; };
  }, [background, importedSong?.albumUrl, songId]);

  const pickBackground = (kind) => (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f || busy) return;
    const type = kind === "video" || isVideoMedia(f) ? "video" : "image";
    const url = URL.createObjectURL(f);
    revokeObjectUrlRef(pendingBgUrlRef);
    pendingBgUrlRef.current = url;
    setPendingBgFile(f);
    setPendingBgFromAudio(false);
    setBackground({ type, url, file: f });
  };

  const clearBackground = () => {
    if (busy) return;
    revokeObjectUrlRef(pendingBgUrlRef);
    setPendingBgFile(null);
    setPendingBgFromAudio(false);
    setBackground(null);
  };

  const pickAudio = (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    handleMediaFile(f);
  };

  const handleMediaFile = async (f) => {
    if (!f) return;
    const transaction = songId ? beginExclusiveMediaTransaction(mediaTransactionRef) : null;
    if (songId && !transaction) return;
    const request = beginMediaRequest(mediaRequestRef);
    setStatusMsg("Reading media metadata…");
    if (songId) setBusyAction("replacing-source");
    try {
      const [info, previewBuffer] = await Promise.all([
        readMediaFileMetadata(f, { skipVideoThumbnail: true }),
        songId ? f.arrayBuffer() : Promise.resolve(null),
      ]);
      if (!request.isCurrent()) return;

      if (songId) {
        const replacementRecord = buildSourceReplacementRecord({
          file: f,
          mediaInfo: info,
          backgroundType: isVideoMedia(f) ? "video" : null,
        });
        const saved = await saveSongRecord(replacementRecord);
        if (!request.isCurrent()) return;
        const persisted = await getSongRecord(saved.id);
        if (!persisted) throw new Error("The replacement project could not be reloaded.");
        const payload = await recordToImported(persisted, { audioBuffer: previewBuffer });
        if (!request.isCurrent()) return;
        pendingSeedSongIdRef.current = null;
        onGeneratedSong?.(payload);
        onSaved?.();
        return;
      }

      setPendingAudioFile(f);
      setPreviewAudioBuffer(null);
      setLiveAnalysisAudioBuffer(null);
      setGenRun(null);
      setLocalVersions([]);
      setFinalSlots(emptyFinalSlots());
      setSingleVersion("imported");
      setCompareVersionIds(["imported"]);
      setCompareSelection([]);
      setSourceArtifacts(emptySourceArtifacts());
      resetEditorSession();
      setPreviewMode("single");
      setDeckTab("takes");
      revokeObjectUrlRef(demucsAuditionUrlRef);
      setDemucsAudition(null);
      setDemucsAuditionLoadingKey("");
      revokeObjectUrlRef(pendingAlbumUrlRef);
      if (info.albumBlob) {
        const albumUrl = URL.createObjectURL(info.albumBlob);
        pendingAlbumUrlRef.current = albumUrl;
        setPendingAlbumFile(info.albumBlob);
        setPendingAlbumUrl(albumUrl);
      } else {
        setPendingAlbumFile(null);
        setPendingAlbumUrl(null);
      }

      if (isVideoMedia(f)) {
        revokeObjectUrlRef(pendingBgUrlRef);
        const url = URL.createObjectURL(f);
        pendingBgUrlRef.current = url;
        setPendingBgFile(f);
        setPendingBgFromAudio(true);
        setBackground({ type: "video", url, file: f });
      } else {
        revokeObjectUrlRef(pendingBgUrlRef);
        setPendingBgFile(null);
        setPendingBgFromAudio(false);
        setBackground(null);
      }
      setDetails({
        title: info.meta.title || fileBaseName(f.name),
        artist: info.meta.artist || "",
        album: info.meta.album || "",
        year: info.meta.year || "",
        genre: info.meta.genre || "",
        charter: "Autochart",
      });
      setStatusMsg(info.albumBlob || isVideoMedia(f)
        ? "Media metadata loaded."
        : "Media loaded. No embedded cover found.");
    } catch (err) {
      if (!request.isCurrent()) return;
      setStatusMsg(err.message || "Could not read or save source media.");
    } finally {
      transaction?.release();
      if (request.isCurrent() && songId) setBusyAction("");
    }
  };

  const refreshImportedSong = async (preferredVersionId = null) => {
    if (!songId) return null;
    const savedRecord = await getSongRecord(songId);
    if (!savedRecord) return null;
    setLocalVersions(playableVersionsFromRecord(savedRecord));
    if (preferredVersionId) setSingleVersion(preferredVersionId);
    return savedRecord;
  };

  const buildRunSettings = (activeId = null) => {
    const selectedRunGenerator = generators.find((g) => g.id === generatorId) || generators[0] || null;
    const generationSettings = buildGenerationSettings({
      generatorId: selectedRunGenerator?.id || generatorId || DEFAULT_GENERATOR_ID,
      controls: generationControls,
      generator: selectedRunGenerator,
      defaultTimingDetector: projectDefaultTimingDetector,
    });
    const sourceTransform = generationSettings.generation.resolved.timingDetector === SOURCE_CHART_TIMING_DETECTOR_ID
      ? sourceTransformFromKey()
      : sourceTransformFromControls(generationControls);
    return {
      difficulty: generationSettings.difficulty,
      generation: { ...generationSettings.generation, sourceTransform },
      sourceTransform,
      demucsSeparation: activeDemucsArtifact,
      ...(activeId ? { activeVersionId: activeId } : {}),
    };
  };

  const baseTrack = importedSong?.track || null;
  const sourceChartPayload = sourceChartPayloadFromVersions(localVersions, importedSong);
  const hasSourceChartSync = Boolean(sourceChartPayload?.text);
  const projectDefaultTimingDetector = hasSourceChartSync
    ? SOURCE_CHART_TIMING_DETECTOR_ID
    : DEFAULT_TIMING_DETECTOR_ID;
  const usesSourceChartSync = generationControls.timingDetector === SOURCE_CHART_TIMING_DETECTOR_ID;
  const sourceAudioBuffer = importedSong?.audioBuffer || null;
  const albumUrl = pendingAlbumUrl || importedSong?.albumUrl || null;
  const sourceAudioFile = pendingAudioFile || importedSong?.audioFile || null;
  const sourceAudioName = pendingAudioFile?.name || importedSong?.audioName || "";
  const sourceAudioMeta = pendingAudioFile
    ? `${formatBytes(pendingAudioFile.size)}${pendingBgFromAudio ? " · video background" : ""}`
    : importedSong?.audioName
      ? "Imported media"
      : "";
  const normalizedSourceArtifacts = normalizeSourceArtifactsState(sourceArtifacts);
  const currentSourceTransform = usesSourceChartSync ? sourceTransformFromKey() : sourceTransformFromControls(generationControls);
  const knownSourceTransforms = [
    currentSourceTransform,
    ...localVersions.filter((version) => version.source === "generated").map(sourceTransformFromVersion),
  ];
  const demucsArtifacts = demucsArtifactsFromSource(normalizedSourceArtifacts, knownSourceTransforms);
  const compatibleDemucsArtifacts = demucsArtifacts.filter(
    (artifact) => sourceVariantKeyFromArtifact(artifact) === currentSourceTransform.key
  );
  const defaultCurrentDemucsId = defaultDemucsIdForSourceVariant(currentSourceTransform.key);
  const preferredDemucsId =
    normalizedSourceArtifacts.demucs.activeBySourceVariant?.[currentSourceTransform.key] ||
    (currentSourceTransform.key === "lead-in:0" ? normalizedSourceArtifacts.demucs.activeId : "") ||
    defaultCurrentDemucsId;
  const activeDemucsArtifact =
    compatibleDemucsArtifacts.find((artifact) => artifact.id === preferredDemucsId) ||
    compatibleDemucsArtifacts.find((artifact) => artifact.id === defaultCurrentDemucsId) ||
    defaultDemucsArtifact(null, currentSourceTransform);
  const activeDemucsId = activeDemucsArtifact.id;

  const versionOptions = localVersions.length
    ? localVersions
    : baseTrack
      ? [
          {
            id: "imported",
            name: "Imported Clone Hero",
            source: "imported-chart",
            status: "charted",
            settings: buildRunSettings(),
            meta: {
              noteCount: importedSong?.meta?.noteCount ?? baseTrack.notes?.length ?? 0,
              durationSec: importedSong?.meta?.durationSec ?? 0,
            },
            track: baseTrack,
            chart: { text: "" },
          },
        ]
      : [];

  const buildSongFinalArrangementList = (slots = finalSlots, versions = versionOptions) =>
    buildFinalArrangementListForRecord(importedSong, slots, versions);

  const persistFinalSlots = async (slots, { quiet = true } = {}) => {
    if (!songId) return;
    try {
      await updateSongRecord(songId, {
        arrangements: buildSongFinalArrangementList(slots),
        meta: {
          availableDifficulties: FINAL_SLOT_ORDER.filter((difficulty) => slots[difficulty]),
        },
      });
      if (!quiet) setStatusMsg("Final chart assignment saved.");
      onSaved?.();
    } catch (err) {
      setStatusMsg(err.message || "Could not save final chart assignment.");
    }
  };

  const updateFinalSlot = (difficulty, versionId, { persist = true } = {}) => {
    const draft = { ...finalSlots };
    // A generated take fills at most one final slot: assigning moves it, never
    // copies it. An imported chart is different — one version legitimately
    // holds several difficulty sections, so assigning it keeps its other slots.
    if (versionId && versionOptions.find((v) => v.id === versionId)?.source !== "imported-chart") {
      for (const slot of FINAL_SLOT_ORDER) {
        if (draft[slot] === versionId) draft[slot] = "";
      }
    }
    draft[difficulty] = versionId;
    const nextSlots = cleanFinalSlots(draft, versionOptions);
    setFinalSlots(nextSlots);
    if (persist) void persistFinalSlots(nextSlots);
  };

  const removeCandidate = async (version) => {
    if (!songId || !version || version.source === "imported-chart") return;
    setBusyAction("removing");
    setStatusMsg("");
    try {
      const sourceVersions = versionOptions.filter(
        (item) => item.id !== version.id && item.id !== FINAL_VERSION_ID
      );
      const nextSlots = FINAL_SLOT_ORDER.reduce((slots, difficulty) => {
        slots[difficulty] = finalSlots[difficulty] === version.id ? "" : finalSlots[difficulty] || "";
        return slots;
      }, {});
      const cleanSlots = cleanFinalSlots(nextSlots, sourceVersions);
      const fallbackVersion =
        sourceVersions.find((item) => item.source === "generated") ||
        sourceVersions.find((item) => item.source === "imported-chart") ||
        sourceVersions[0] ||
        null;
      const nextActiveId = activeVersionId === version.id || activeVersionId === FINAL_VERSION_ID
        ? fallbackVersion?.id || null
        : activeVersionId;

      await updateSongRecord(songId, {
        versions: sourceVersions.map(versionForSave).filter(Boolean),
        arrangements: buildSongFinalArrangementList(cleanSlots, sourceVersions),
        settings: {
          ...(importedSong?.settings || {}),
          activeVersionId: nextActiveId,
        },
        meta: {
          availableDifficulties: FINAL_SLOT_ORDER.filter((difficulty) => cleanSlots[difficulty]),
        },
      });
      setFinalSlots(cleanSlots);
      setSingleVersion(nextActiveId || fallbackVersion?.id || "imported");
      setCompareVersionIds((ids) =>
        ids.map((id) => (id === version.id || id === FINAL_VERSION_ID ? fallbackVersion?.id || ids[0] : id))
      );
      const remainingSelection = compareSelection.filter((id) => id !== version.id);
      setCompareSelection(remainingSelection);
      if (previewMode === "compare" && remainingSelection.length < MIN_COMPARE_CHARTS) {
        setPreviewMode("single");
      }
      await refreshImportedSong(nextActiveId || fallbackVersion?.id || null);
      // Removing the take that is being edited closes the editor cleanly.
      if (version.id === editorDraftVersionId || version.id === editorSourceVersionId) {
        resetEditorSession();
        setDeckTab("takes");
      }
      setStatusMsg(`Removed ${version.name}.`);
      onSaved?.();
    } catch (err) {
      setStatusMsg(err.message || "Could not remove take.");
    } finally {
      setBusyAction("");
    }
  };

  const updateGenerationControl = (key, value) => {
    setGenerationControls((current) => ({ ...current, [key]: value }));
  };

  const updateAdvancedNumberControl = (key, value) => {
    updateGenerationControl(key, value.replace(/[^\d.]/g, ""));
  };

  const applyGenerationPreset = (presetId) => {
    setGenerationControls((current) => controlsForGenerationPreset(presetId, current));
  };

  const resetCurrentGenerationPreset = () => {
    setGenerationControls((current) =>
      controlsForGenerationPreset(current.presetId, {
        ...DEFAULT_GENERATION_CONTROLS,
        presetId: current.presetId,
        timingDetector: projectDefaultTimingDetector,
      })
    );
  };

  const handleSave = async () => {
    if (!songId) {
      setStatusMsg("Import a song from the Library before saving.");
      return;
    }
    const saveVersionId = activeVersionId || singleVersion;
    setBusyAction("saving");
    setStatusMsg("");
    try {
      const patch = {
        meta: {
          title: details.title,
          artist: details.artist,
          album: details.album,
          year: details.year,
          genre: details.genre,
          charter: details.charter,
        },
        settings: buildRunSettings(saveVersionId),
        arrangements: buildSongFinalArrangementList(),
        sourceArtifacts: normalizedSourceArtifacts,
      };
      const blobPatch = {};
      const assetPatch = {};
      if (pendingAudioFile) {
        blobPatch.audio = pendingAudioFile;
        assetPatch.audio = pendingAudioFile.name || "song.bin";
      }
      if (pendingAlbumFile) {
        blobPatch.albumArt = pendingAlbumFile;
        assetPatch.albumArt = pendingAlbumFile.name || "album.bin";
      }
      if (pendingBgFile) {
        const bgType = isVideoMedia(pendingBgFile) ? "video" : "image";
        blobPatch.background = { type: bgType, blob: pendingBgFile };
        assetPatch.background = { type: bgType, file: pendingBgFile.name || "background.bin" };
      } else if (!background) {
        blobPatch.background = null;
        assetPatch.background = null;
      }
      if (Object.keys(blobPatch).length) {
        patch._blobs = blobPatch;
        patch.assets = assetPatch;
      }
      await updateSongRecord(songId, patch);
      await refreshImportedSong(saveVersionId);
      setPendingAlbumFile(null);
      setPendingBgFile(null);
      setPendingBgFromAudio(false);
      onSaved?.();
      setStatusMsg("Project saved.");
    } catch (err) {
      setStatusMsg(err.message || "Save failed");
    } finally {
      setBusyAction("");
    }
  };

  const persistSourceArtifacts = async (nextArtifacts, { quiet = true } = {}) => {
    if (!songId) return;
    try {
      await updateSongRecord(songId, { sourceArtifacts: nextArtifacts });
      if (!quiet) setStatusMsg("Separation choice saved.");
      onSaved?.();
    } catch (err) {
      setStatusMsg(err.message || "Could not save separation choice.");
    }
  };
  const ensurePathBackedAudioSource = (_audioFile, storedSource = null) => {
    if (!requiresPathBackedAudio()) return { source: null, persisted: false };
    if (storedSource?.kind === "project-asset") {
      return { source: storedSource, persisted: true };
    }
    if (!pendingAudioFile && importedSong?.audioSource?.kind === "project-asset") {
      return { source: importedSong.audioSource, persisted: false };
    }
    return { source: null, persisted: false };
  };

  const selectDemucsSeparation = async (id) => {
    const nextId = id || defaultDemucsIdForSourceVariant(currentSourceTransform.key);
    const artifact = demucsArtifacts.find((item) => item.id === nextId) || null;
    const sourceVariantKey = artifact?.sourceVariantKey || currentSourceTransform.key;
    const nextArtifacts = {
      ...normalizedSourceArtifacts,
      demucs: {
        ...normalizedSourceArtifacts.demucs,
        activeId: sourceVariantKey === "lead-in:0" ? nextId : normalizedSourceArtifacts.demucs.activeId,
        activeBySourceVariant: {
          ...(normalizedSourceArtifacts.demucs.activeBySourceVariant || {}),
          [sourceVariantKey]: nextId,
        },
      },
    };
    setSourceArtifacts(nextArtifacts);
    await persistSourceArtifacts(nextArtifacts);
    setStatusMsg(`${artifact?.name || "Selected separation"} ${compactSourceVariantLabel(artifact?.sourceTransform || currentSourceTransform)} is active for matching charts.`);
  };

  const prepareDemucsSeparation = async ({ id = "", name = "", makeActive = true, sourceTransform = null } = {}) => {
    const runAudioFile = pendingAudioFile || importedSong?.audioFile || null;
    if (!runAudioFile) {
      setStatusMsg("Choose a media file before preparing Demucs.");
      return null;
    }
    const generatorSetup = selectedGenerator?.setup;
    if (generatorSetup && !generatorSetup.ready) {
      setStatusMsg(generatorSetup.message || "Demucs preparation needs setup before this generator can run.");
      return null;
    }

    const runSourceTransform = sourceTransform || currentSourceTransform;
    const separationId = id || newDemucsId();
    const existing = demucsArtifacts.find((artifact) => artifact.id === separationId) || null;
    const generatedIndex = demucsArtifacts.filter(
      (artifact) => (artifact.engineId || artifact.id) !== DEFAULT_DEMUCS_ID && artifact.sourceVariantKey === runSourceTransform.key
    ).length + 1;
    const separationName =
      name ||
      existing?.name ||
      ((existing?.engineId || separationId) === DEFAULT_DEMUCS_ID
        ? defaultDemucsName(runSourceTransform)
        : `Regenerated separation ${generatedIndex}${runSourceTransform.leadInSilenceMs ? ` (${runSourceTransform.label})` : ""}`);

    setBusyAction("separating");
    setStatusMsg("Preparing Demucs separation…");
    try {
      const runAudioResolution = ensurePathBackedAudioSource(
        runAudioFile,
        pendingAudioFile ? null : importedSong?.audioSource
      );
      const result = await prepareDemucs({
        audioFile: runAudioFile,
        audioName: sourceAudioName,
        audioSource: runAudioResolution.source,
        generatorId,
        separationId: existing?.engineId || separationId,
        name: separationName,
        metadata: details,
        sourceTransform: runSourceTransform,
      });
      const artifact = demucsArtifactFromResult(result, {
        ...existing,
        id: separationId,
        name: separationName,
        sourceTransform: runSourceTransform,
        sourceVariantKey: runSourceTransform.key,
      });
      const nextArtifacts = upsertDemucsArtifact(
        normalizedSourceArtifacts,
        artifact,
        makeActive ? artifact.id : null
      );
      setSourceArtifacts(nextArtifacts);
      if (songId) await persistSourceArtifacts(nextArtifacts);
      setStatusMsg(`${artifact.name} ${compactSourceVariantLabel(artifact.sourceTransform)} is ready${makeActive ? " and active for matching charts" : ""}.`);
      return artifact;
    } catch (err) {
      setStatusMsg(err.message || "Demucs preparation failed.");
      throw err;
    } finally {
      setBusyAction("");
    }
  };

  const loadDemucsStem = async (artifact, stem, { activate = false } = {}) => {
    if (!artifact) return null;
    const key = `${artifact.id}:${stem}`;
    setDeckTab("demucs");
    setDemucsAuditionLoadingKey(key);
    setStatusMsg("");
    try {
      let readyArtifact = artifact;
      if (!readyArtifact?.stems?.[stem]?.path) {
        readyArtifact = await prepareDemucsSeparation({
          id: artifact.id,
          name: artifact.name,
          makeActive: artifact.id === activeDemucsId,
          sourceTransform: artifact.sourceTransform || sourceTransformFromKey(artifact.sourceVariantKey),
        });
      }
      const stemInfo = readyArtifact?.stems?.[stem];
      if (!stemInfo?.path) throw new Error(`No ${stemDisplayName(stem).toLowerCase()} was found for ${readyArtifact?.name || "this separation"}.`);
      const data = await readDemucsStem(stemInfo.path);
      const mime = stemInfo.mime || (stemInfo.format === "wav" ? "audio/wav" : "audio/flac");
      const url = URL.createObjectURL(new Blob([data], { type: mime }));
      const nextAudition = {
        id: readyArtifact.id,
        name: readyArtifact.name,
        stem,
        stemName: stemDisplayName(stem),
        label: `${readyArtifact.name} · ${stemDisplayName(stem)}`,
        url,
        data,
        mime,
      };
      if (activate) {
        revokeObjectUrlRef(demucsAuditionUrlRef);
        demucsAuditionUrlRef.current = url;
        setDemucsAudition(nextAudition);
      }
      return nextAudition;
    } catch (err) {
      setStatusMsg(err.message || "Could not audition separated audio.");
      throw err;
    } finally {
      setDemucsAuditionLoadingKey("");
    }
  };

  const auditionDemucsStem = (artifact, stem) => loadDemucsStem(artifact, stem, { activate: true });

  const handleGenerate = async ({ hardwareMode, settingsSnapshot, sourceSnapshot } = {}) => {
    if (generationInFlightRef.current) return;
    const runAudioFile = pendingAudioFile || importedSong?.audioFile || null;
    if (!runAudioFile) {
      setStatusMsg("Choose a media file before generating a chart.");
      return;
    }
    const generatorSetup = selectedGenerator?.setup;
    if (generatorSetup && !generatorSetup.ready) {
      setStatusMsg(generatorSetup.message || "Chart generation needs setup before this generator can run.");
      return;
    }
    if ((activeDemucsArtifact?.engineId || activeDemucsArtifact?.id) !== DEFAULT_DEMUCS_ID && !activeDemucsArtifact?.cache?.workspace) {
      setDeckTab("demucs");
      setStatusMsg("Prepare or reselect the Demucs separation before generating a chart.");
      return;
    }
    generationInFlightRef.current = true;
    cpuRetryRef.current = null;
    setGenRun(null);
    setBusyAction("generating");
    // Surface the live board only when it doesn't interrupt anything: never
    // yank the stage away from an open compare view or a take that's audibly
    // playing. The live take card in the deck shows run progress either way
    // and focuses the board on click.
    setLiveStageFocused(previewMode !== "compare" && !previewPlayingRef.current);
    setStatusMsg("");
    let runSettings;
    let retrySource;
    try {
      runSettings = settingsSnapshot || buildRunSettings();
      const runUsesSourceChartSync = runSettings.generation.resolved.timingDetector === SOURCE_CHART_TIMING_DETECTOR_ID;
      if (runUsesSourceChartSync && !sourceChartPayload?.text) {
        setStatusMsg("Imported chart sync needs a source notes.chart.");
        return;
      }
      const runSeed = runSettings.generation.resolved.seed;
      const runTimingDetector = runSettings.generation.controls.timingDetector;
      const runTimingSmoothing = Boolean(runSettings.generation.resolved.timingSmoothing?.enabled);
      const runDemucsSeparation = activeDemucsArtifact;
      const runSourceTransform = runSettings.sourceTransform;
      const runLeadInSilenceMs = Number(runSourceTransform?.leadInSilenceMs) || 0;
      let runSongId = sourceSnapshot?.songId || songId || pendingSeedSongIdRef.current || null;
      let runAudioSource = sourceSnapshot?.audioSource || (pendingAudioFile ? null : importedSong?.audioSource || null);
      let runAudioWasPersisted = Boolean(sourceSnapshot?.audioWasPersisted);
      if (!runSongId) {
        const now = Date.now();
        const seedRecord = {
          schemaVersion: 2,
          id: newSongId(),
          createdAt: now,
          updatedAt: now,
          source: "generated",
          status: "generating",
          meta: {
            title: details.title || fileBaseName(sourceAudioName || "Generated Song"),
            artist: details.artist || "Unknown Artist",
            album: details.album || "",
            year: details.year || "",
            genre: details.genre || "",
            charter: "Autochart",
            noteCount: 0,
            durationSec: 0,
            availableDifficulties: [],
          },
          settings: buildRunSettings(),
          chart: { text: "" },
          versions: [],
          arrangements: [],
          sourceArtifacts: emptySourceArtifacts(),
          assets: {
            audio: "audio.bin",
            albumArt: pendingAlbumFile ? "album.bin" : null,
            background: pendingBgFile
              ? { type: isVideoMedia(pendingBgFile) ? "video" : "image", file: "background.bin" }
              : null,
          },
          _blobs: {
            audio: runAudioFile,
            albumArt: pendingAlbumFile || null,
            background: pendingBgFile
              ? { type: isVideoMedia(pendingBgFile) ? "video" : "image", blob: pendingBgFile }
              : null,
          },
        };
        const saved = await saveSongRecord(seedRecord);
        runSongId = saved.id;
        runAudioWasPersisted = true;
        if (requiresPathBackedAudio()) {
          runAudioSource = await getStoredAssetSource(saved.id, saved.assets?.audio);
          if (runAudioSource?.kind !== "project-asset") {
            throw new Error("Saved project audio has no valid asset reference.");
          }
        }
        pendingSeedSongIdRef.current = runSongId;
        onProjectIdentified?.(runSongId);
        onSaved?.();
      }
      if (songId) {
        const mediaPatch = { meta: { ...details }, _blobs: {}, assets: {} };
        if (pendingAlbumFile) {
          mediaPatch._blobs.albumArt = pendingAlbumFile;
          mediaPatch.assets.albumArt = pendingAlbumFile.name || "album.bin";
        }
        if (pendingBgFile) {
          const type = isVideoMedia(pendingBgFile) ? "video" : "image";
          mediaPatch._blobs.background = { type, blob: pendingBgFile };
          mediaPatch.assets.background = { type, file: pendingBgFile.name || "background.bin" };
        } else if (!background) {
          mediaPatch._blobs.background = null;
          mediaPatch.assets.background = null;
        }
        await updateSongRecord(songId, mediaPatch);
      }
      const runAudioResolution = ensurePathBackedAudioSource(runAudioFile, runAudioSource);
      runAudioSource = runAudioResolution.source || runAudioSource;
      runAudioWasPersisted = runAudioWasPersisted || runAudioResolution.persisted;
      retrySource = { songId: runSongId, audioSource: runAudioSource, audioWasPersisted: runAudioWasPersisted };
      const runJobId = crypto.randomUUID();
      setGenRun({
        songId: runSongId,
        jobId: runJobId,
        startedAt: Date.now(),
        finishedAt: 0,
        ok: false,
        canceled: false,
        stopping: false,
        error: "",
        stages: {},
        logs: [],
        live: null,
        runtimeFallback: null,
        hardwareMode: hardwareMode === "cpu" ? "cpu" : "auto",
        willSeparate: !separationIsCached(runDemucsSeparation),
        difficulty: runSettings.difficulty,
        // Source-transform lead-in, in ms + seconds, used by the live board to
        // align in-flight chart playback against the (usually unpadded) source
        // audio buffer. See LiveGeneration.jsx compareOffset.
        leadInSilenceMs: runLeadInSilenceMs,
        leadInSeconds: runLeadInSilenceMs / 1000,
        metadata: {
          title: details.title || fileBaseName(sourceAudioName || "Generated Song"),
          artist: details.artist || "Unknown Artist",
          charter: "Autochart",
          genre: details.genre || "",
        },
        summary: [
          selectedGeneratorLabel,
          DIFF[runSettings.difficulty]?.name || runSettings.difficulty,
          runTimingDetector === DEFAULT_TIMING_DETECTOR_ID ? null : timingDetectorLabel(runTimingDetector),
          runUsesSourceChartSync ? null : runTimingSmoothing ? "smoothing on" : "smoothing off",
          runSourceTransform.label,
          runDemucsSeparation?.name || "Default separation",
          selectedPreset.name,
          runSeed == null ? "random seed" : `seed ${runSeed}`,
        ].filter(Boolean).join(" · "),
      });
      const result = await generateChart({
        hardwareMode: hardwareMode === "cpu" ? "cpu" : undefined,
        jobId: runJobId,
        audioFile: runAudioFile,
        audioSource: runAudioSource,
        audioName: sourceAudioName,
        generatorId: runSettings.generation.generatorId,
        difficulty: runSettings.difficulty,
        generation: runSettings.generation,
        stripSustains: runSettings.generation.resolved.stripSustains,
        demucsSeparation: runDemucsSeparation,
        sourceTransform: runSourceTransform,
        sourceChart: runUsesSourceChartSync ? sourceChartPayload : null,
        metadata: { ...details, charter: "Autochart" },
        versionName: generationVersionName(selectedGeneratorLabel, runSettings.generation, versionOptions.filter(v => v.source === "generated").length + 1),
        parentVersionId: selectedSingleVersion?.id || null,
      });
      if (result.status === "canceled") {
        setStatusMsg("Stopped.");
        setGenRun((run) =>
          run
            ? { ...run, finishedAt: Date.now(), ok: false, canceled: true, error: "", stopping: false }
            : run
        );
        return;
      }
      if (result.chartText) {
        const resultSeparation = result.sourceSeparation || runDemucsSeparation;
        const sourceArtifact = resultSeparation
          ? demucsArtifactFromResult(resultSeparation, {
              ...runDemucsSeparation,
              sourceTransform: result.sourceTransform || runSourceTransform,
              sourceVariantKey: (result.sourceTransform || runSourceTransform).key,
            })
          : null;
        const nextSourceArtifacts = sourceArtifact
          ? upsertDemucsArtifact(normalizedSourceArtifacts, sourceArtifact, sourceArtifact.id)
          : normalizedSourceArtifacts;
        const generatedCount = versionOptions.filter((v) => v.source === "generated").length + 1;
        const generated = result.savedVersion || createGeneratedVersionFromResult(
          result,
          selectedSingleVersion?.chart?.text ? selectedSingleVersion : null,
          {
            ...runSettings,
            model: result.generatorLabel || selectedGenerator?.label || "Generated",
            demucsSeparation: sourceArtifact || resultSeparation,
            sourceTransform: result.sourceTransform || runSourceTransform,
          },
          generatedCount
        );
        const versionsWithGenerated = [...versionOptions, generated];
        const currentFinalSlots = cleanFinalSlots(finalSlots, versionOptions);
        const nextFinalSlots = cleanFinalSlots(
          {
            ...currentFinalSlots,
            [runSettings.difficulty]: currentFinalSlots[runSettings.difficulty] || generated.id,
          },
          versionsWithGenerated
        );
        const nextVersions = [...versionOptions.map(versionForSave), generated].filter(Boolean);
        const patch = {
          versions: nextVersions,
          settings: buildRunSettings(generated.id),
          arrangements: buildSongFinalArrangementList(nextFinalSlots, versionsWithGenerated),
          sourceArtifacts: nextSourceArtifacts,
          status: "charted",
          ...(songId ? {} : {
            meta: {
              noteCount: generated.meta?.noteCount || 0,
              durationSec: generated.meta?.durationSec || 0,
              availableDifficulties: [runSettings.difficulty],
            },
            chart: { text: result.chartText },
          }),
        };
        const blobPatch = {};
        const assetPatch = {};
        if (pendingAudioFile && !runAudioWasPersisted) {
          blobPatch.audio = pendingAudioFile;
          assetPatch.audio = pendingAudioFile.name || "song.bin";
        }
        if (pendingAlbumFile) {
          blobPatch.albumArt = pendingAlbumFile;
          assetPatch.albumArt = pendingAlbumFile.name || "album.bin";
        }
        if (pendingBgFile) {
          const bgType = isVideoMedia(pendingBgFile) ? "video" : "image";
          blobPatch.background = { type: bgType, blob: pendingBgFile };
          assetPatch.background = { type: bgType, file: pendingBgFile.name || "background.bin" };
        } else if (!background) {
          blobPatch.background = null;
          assetPatch.background = null;
        }
        if (Object.keys(blobPatch).length) {
          patch._blobs = blobPatch;
          patch.assets = assetPatch;
        }
        if (!result.savedVersion) await updateSongRecord(runSongId, patch);
        const keepListening =
          previewPlayingRef.current || previewModeRef.current === "compare";
        if (songId) {
          await refreshImportedSong(keepListening ? null : generated.id);
        } else {
          const savedRecord = await getSongRecord(runSongId);
          const payload = await recordToImported(savedRecord);
          setLocalVersions(payload.versions || []);
          setSingleVersion(generated.id);
          pendingSeedSongIdRef.current = null;
          onGeneratedSong?.(payload);
        }
        setSourceArtifacts(nextSourceArtifacts);
        setFinalSlots(nextFinalSlots);
        setCompareVersionIds((ids) => {
          const next = [...ids];
          while (next.length < MIN_COMPARE_CHARTS) next.push(generated.id);
          next[1] = generated.id;
          return next.slice(0, MAX_COMPARE_CHARTS);
        });
        setJustGeneratedId(generated.id);
        if (justGeneratedTimer.current) clearTimeout(justGeneratedTimer.current);
        justGeneratedTimer.current = setTimeout(() => setJustGeneratedId(""), 1700);
        setStatusMsg(`Generated ${generated.name} as a new version.`);
        onSaved?.();
      } else {
        setStatusMsg(result.chartPath ? `Generated chart at ${result.chartPath}` : result.message || `Job ${result.jobId}: ${result.status}`);
      }
      setGenRun((run) => (run ? { ...run, finishedAt: Date.now(), ok: true } : run));
    } catch (err) {
      // Retain this render's song, media, metadata, and options, even if the
      // controls change before retry. The retry receives a fresh job ID.
      if (runSettings && retrySource && hardwareMode !== "cpu") {
        cpuRetryRef.current = () => handleGenerate({ hardwareMode: "cpu", settingsSnapshot: runSettings, sourceSnapshot: retrySource });
      }
      setStatusMsg(err.message || "Generation failed");
      setGenRun((run) =>
        run
          ? { ...run, finishedAt: Date.now(), ok: false, error: run.error || err.message || "Generation failed" }
          : run
      );
    } finally {
      generationInFlightRef.current = false;
      setBusyAction("");
    }
  };

  const handleStopGenerate = async () => {
    if (!genRun || genRun.finishedAt || genRun.stopping || !genRun.jobId) return;
    const jobId = genRun.jobId;
    setGenRun((run) => (run && !run.finishedAt ? { ...run, stopping: true } : run));
    try {
      const result = await cancelGeneration(jobId);
      if (!result?.ok || result.status === "idle") {
        setGenRun((run) =>
          run && run.jobId === jobId && !run.finishedAt ? { ...run, stopping: false } : run
        );
      }
    } catch {
      setGenRun((run) =>
        run && run.jobId === jobId && !run.finishedAt ? { ...run, stopping: false } : run
      );
    }
  };

  const ensureFinalVersionSaved = async () => {
    if (!songId) throw new Error("Generate or open a saved song before building the final chart.");
    const previousFinalVersion = versionOptions.find((version) => version.id === FINAL_VERSION_ID) || null;
    const { slots: cleanSlots, finalVersion, versionsWithFinal } = buildFinalChartVersion({
      versions: versionOptions,
      slots: finalSlots,
      previousVersion: previousFinalVersion,
    });
    const nextVersions = versionsWithFinal.map(versionForSave).filter(Boolean);
    await updateSongRecord(songId, {
      ...(!background ? { assets: { background: null }, _blobs: { background: null } } : {}),
      versions: nextVersions,
      arrangements: buildSongFinalArrangementList(cleanSlots, versionsWithFinal),
      settings: {
        ...buildRunSettings(finalVersion.id),
        activeArrangementId: FINAL_ARRANGEMENT_ID,
      },
      meta: {
        ...details,
        availableDifficulties: finalVersion.meta.availableDifficulties || [],
        noteCount: finalVersion.meta.noteCount || 0,
        durationSec: finalVersion.meta.durationSec || importedSong?.meta?.durationSec || 0,
      },
    });
    setFinalSlots(cleanSlots);
    await refreshImportedSong(finalVersion.id);
    onSaved?.();
    return finalVersion;
  };

  const handleExportFinal = async () => {
    if (!songId) {
      setStatusMsg("Open or generate a saved song before exporting.");
      return;
    }
    if (finalTimingIssue) {
      setStatusMsg(finalTimingIssue);
      return;
    }
    setBusyAction("exporting");
    setStatusMsg("");
    try {
      const finalVersion = await ensureFinalVersionSaved();
      const result = await exportChart(songId, finalVersion.id);
      if (result.canceled) {
        setStatusMsg(result.message || "Export canceled.");
        return;
      }
      setStatusMsg(result.message || `Exported final chart to ${result.path}`);
    } catch (err) {
      setStatusMsg(err.message || "Final chart export failed");
    } finally {
      setBusyAction("");
    }
  };

  const saveFinalToLibrary = async () => {
    setBusyAction("saving-library");
    setStatusMsg("");
    try {
      const finalVersion = await ensureFinalVersionSaved();
      const result = await saveChartToCloneHeroLibrary(songId, finalVersion.id);
      setStatusMsg(result.message || `Saved final chart to ${GAME_LIBRARY_NAME}: ${result.path}`);
      setLibrarySavedAt(Date.now());
    } catch (err) {
      if (isMissingLibraryFolderError(err)) libraryFolderGate.request(saveFinalToLibrary);
      else setStatusMsg(err.message || `Could not save final chart to ${GAME_LIBRARY_NAME}.`);
    } finally {
      setBusyAction("");
    }
  };

  const handleSaveFinalToLibrary = async (event) => {
    if (!songId) {
      setStatusMsg(`Open or generate a saved song before saving to ${GAME_LIBRARY_NAME}.`);
      return;
    }
    if (finalTimingIssue) {
      setStatusMsg(finalTimingIssue);
      return;
    }
    await libraryFolderGate.run(saveFinalToLibrary, event?.currentTarget);
  };


  const decoratedVersions = versionOptions.map((v, index) => ({
    ...v,
    badge:
      v.source === "imported-chart"
        ? "A"
        : v.id === FINAL_VERSION_ID
          ? "F"
        : v.meta?.edited
          ? "E"
        : v.status === "draft"
          ? "M"
          : String(index),
    noteCount: v.noteCount ?? v.meta?.noteCount ?? v.track?.notes?.length ?? 0,
  }));
  const candidateVersions = decoratedVersions.filter((v) => v.id !== FINAL_VERSION_ID);
  const assignableVersions = candidateVersions.filter((v) => v.chart?.text);
  const cleanedFinalSlots = cleanFinalSlots(finalSlots, assignableVersions);
  const finalSlotVersions = buildFinalSlotVersions(cleanedFinalSlots, assignableVersions);
  const finalFilledCount = FINAL_SLOT_ORDER.filter((difficulty) => finalSlotVersions[difficulty]).length;
  const finalReadyLabel = `${finalFilledCount}/${FINAL_SLOT_ORDER.length}`;
  const finalTimingIssue = finalValidationMessage(finalSlotVersions);
  const selectedSingleVersion =
    decoratedVersions.find((v) => v.id === singleVersion) || decoratedVersions[0];
  const selectedCompareVersions = compareVersionIds
    .map((id, index) => decoratedVersions.find((v) => v.id === id) || decoratedVersions[index] || decoratedVersions[0])
    .filter(Boolean);
  const compareAudioVersion = selectedCompareVersions.reduce(
    (best, version) =>
      leadInSilenceMsFromVersion(version) > leadInSilenceMsFromVersion(best) ? version : best,
    selectedCompareVersions[0]
  );
  const previewAudioVersion = previewMode === "compare" ? compareAudioVersion : selectedSingleVersion;
  const previewAudioLeadInSeconds = leadInSilenceMsFromVersion(previewAudioVersion) / 1000;
  const previewAnalysisAudioPath = previewAudioLeadInSeconds > 0
    ? previewAudioVersion?.meta?.analysisAudioPath || ""
    : "";
  const track = selectedSingleVersion?.track || baseTrack;
  const audioBuffer = previewAnalysisAudioPath ? previewAudioBuffer : sourceAudioBuffer;
  const activeVideoOffset = previewAnalysisAudioPath ? previewAudioLeadInSeconds : 0;
  // Lead-in seconds baked into whichever audio buffer is currently mounted
  // (0 for the original/unpadded source, >0 when the padded analysis audio is
  // in use). LiveGeneration pairs this with genRun.leadInSeconds to align the
  // streaming chart against the audio clock via HighwayPreview's compareOffset.
  const audioLeadInSeconds = previewAnalysisAudioPath ? previewAudioLeadInSeconds : 0;
  const noteCount = selectedSingleVersion?.noteCount ?? importedSong?.meta?.noteCount ?? track?.notes?.length ?? 0;
  const diff = generationControls.difficulty || "expert";
  const difficultyName = DIFF[diff]?.name || "Expert";
  const difficultyTone = DIFF[diff]?.color || "red";
  const activeCompareVersionId = selectedCompareVersions[1]?.id || selectedCompareVersions[0]?.id;
  const activeVersionId = previewMode === "single" ? singleVersion : activeCompareVersionId;
  const selectedGenerator = generators.find((g) => g.id === generatorId) || generators[0];
  const currentRunSettings = buildRunSettings();
  const currentGeneration = currentRunSettings.generation;
  const resolvedSettings = currentGeneration.resolved;
  const selectedGeneratorLabel = selectedGenerator?.label || TRANSCRIBER_MODEL.label;
  const selectedGeneratorSetup = selectedGenerator?.setup || null;
  const liveGeneration = useMemo(
    () => buildLiveGenerationPreview(
      genRun?.live,
      genRun?.difficulty || diff,
      genRun?.metadata || {
        title: details.title || "Live Transcription",
        artist: details.artist || "Unknown Artist",
        charter: "Autochart",
        genre: details.genre || "",
      }
    ),
    [genRun?.live, genRun?.difficulty, genRun?.metadata, diff, details.title, details.artist, details.genre]
  );
  const supportedDifficultyIds = generatorDifficultyIds(selectedGenerator);
  const selectedPreset = getGenerationPreset(generationControls.presetId);
  const hasMedia = Boolean(sourceAudioFile || track);
  const unsupportedTarget = isUnsupportedGenerationTarget(setupStatus);
  const setupBlocking = Boolean(
    setupStatus && !setupStatus.ready && !unsupportedTarget
  );
  const setupMessage =
    selectedGeneratorSetup?.status === "missing"
      ? "The chart generation package is not installed. Open Setup to download it."
      : setupStatus?.message ||
        selectedGeneratorSetup?.message ||
        (engineError ? engineError : "");

  useEffect(() => {
    let cancelled = false;
    if (!previewAnalysisAudioPath) {
      setPreviewAudioBuffer(null);
      setPreviewAudioError("");
      return undefined;
    }
    setPreviewAudioBuffer(null);
    setPreviewAudioError("");
    readEngineCacheFile(previewAnalysisAudioPath)
      .then((buffer) => {
        if (!cancelled) setPreviewAudioBuffer(buffer);
      })
      .catch(() => {
        // The cached padded analysis audio is missing or unreadable. Without
        // it the chart can't be aligned to the original (unpadded) source —
        // falling back would put notes `leadInSeconds` late — so surface a
        // hard error instead of silently hanging on "Loading chart…".
        if (!cancelled) {
          setPreviewAudioBuffer(null);
          setPreviewAudioError(
            "This chart was generated with lead-in silence, but its padded audio cache is missing. Regenerate the chart before previewing."
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [previewAnalysisAudioPath]);

  // Load the in-flight run's analysis audio for the live board. Needed when the
  // run uses lead-in silence (the analysis audio is the PADDED source, so live
  // playback shares the final take's timeline) AND when there's no source
  // buffer in memory yet (first-time generations have no importedSong until the
  // run completes and saves — without this, the live board gets audioBuffer=null
  // and play is a silent no-op). Skipped when lead-in is 0 AND a source buffer
  // exists, since the analysis audio is byte-identical to what's in memory and
  // loading it would just duplicate memory. Cleared when the run finishes so the
  // buffer doesn't outlive the board. On a read failure the board falls back to
  // the unpadded source + negative chart offset (see LiveGeneration.jsx).
  useEffect(() => {
    const analysisPath = genRun?.analysisAudioPath || "";
    const runNeedsPadded = (Number(genRun?.leadInSilenceMs) || 0) > 0;
    const needsRunAudio = runNeedsPadded || !sourceAudioBuffer;
    if (!analysisPath || !needsRunAudio || genRun?.finishedAt) {
      setLiveAnalysisAudioBuffer(null);
      return undefined;
    }
    let cancelled = false;
    readEngineCacheFile(analysisPath)
      .then((buffer) => {
        if (!cancelled) setLiveAnalysisAudioBuffer(buffer);
      })
      .catch(() => {
        if (!cancelled) setLiveAnalysisAudioBuffer(null);
      });
    return () => {
      cancelled = true;
    };
  }, [genRun?.analysisAudioPath, genRun?.leadInSilenceMs, genRun?.finishedAt, sourceAudioBuffer]);

  useEffect(() => () => {
    if (justGeneratedTimer.current) clearTimeout(justGeneratedTimer.current);
  }, []);

  // ----- takes deck orchestration -----

  const previewVersion = (versionId) => {
    setSingleVersion(versionId);
    setPreviewMode("single");
    // Selecting a version is an explicit "take me to that chart" gesture —
    // drop out of the live generation board.
    setLiveStageFocused(false);
  };

  const toggleCompareSelection = (versionId) => {
    const has = compareSelection.includes(versionId);
    let next = has
      ? compareSelection.filter((id) => id !== versionId)
      : [...compareSelection, versionId];
    if (next.length > MAX_COMPARE_CHARTS) next = next.slice(next.length - MAX_COMPARE_CHARTS);
    setCompareSelection(next);
    if (previewMode === "compare") {
      if (next.length >= MIN_COMPARE_CHARTS) setCompareVersionIds(next);
      else setPreviewMode("single");
    }
  };

  const toggleCompareMode = () => {
    if (previewMode === "compare") {
      setPreviewMode("single");
      return;
    }
    if (compareSelection.length < MIN_COMPARE_CHARTS) return;
    setCompareVersionIds(compareSelection.slice(0, MAX_COMPARE_CHARTS));
    setPreviewMode("compare");
  };

  const exitCompare = () => setPreviewMode("single");

  // ----- editor (non-destructive take editing) -----

  // Action types that mutate the chart and therefore need a draft + dirty flag.
  const EDITOR_MUTATING = new Set([
    "moveNotes", "deleteNotes", "addNote", "toggleTap", "toggleForce", "paintNoteFlag", "setSustain",
    "quantizeSelection", "splitChords", "eraseGesture", "addRange", "updateRange", "deleteRanges", "deleteSelection",
    "undo", "redo",
  ]);

  const editorChangeCanMutate = (change) => {
    if (change.type === "undo") return editorState.past.length > 0;
    if (change.type === "redo") return editorState.future.length > 0;
    if (change.type === "deleteSelection") {
      return editorState.selectedNoteIds.length > 0 || editorState.selectedRangeIds.length > 0;
    }
    if (change.type === "deleteNotes" || change.type === "toggleTap" || change.type === "toggleForce" || change.type === "paintNoteFlag") {
      return Boolean(change.ids?.length);
    }
    if (change.type === "eraseGesture") return Boolean(change.ids?.length || change.rangeIds?.length || change.sustainCuts?.length || change.rangeCuts?.length);
    if (change.type === "splitChords") {
      const ids = new Set(change.ids || []);
      return Boolean(editorState.doc?.notes.some((note) => ids.has(note.id) && !note.open && note.lanes.length > 1));
    }
    if (change.type === "deleteRanges") return Boolean(change.ids?.length);
    if (change.type === "moveNotes") return Boolean(change.ids?.length && (change.deltaTick || change.deltaLane));
    if (change.type === "setSustain") return Boolean(change.id);
    return true;
  };

  function resetEditorSession() {
    dispatchEditor({ type: "replaceDoc", doc: null });
    setEditorSourceVersionId("");
    setEditorDraftVersionId("");
    setEditorDirty(false);
    setEditorSavedAt(0);
    setEditorTool("select");
    setEditorPlayhead({ time: 0, duration: 0 });
    setEditorSeekRequest(null);
    setEditorPlayRequest(null);
    setEditorPlaying(false);
  }

  const editorVersionOptions = localVersions.length ? localVersions : versionOptions;

  const startEditingVersion = (versionId) => {
    const version = editorVersionOptions.find((v) => v.id === versionId);
    if (!version?.chart?.text) {
      setStatusMsg("This take has no chart text to edit.");
      return;
    }
    const difficulty = version.settings?.difficulty || version.difficulty || "expert";
    let doc;
    try {
      doc = parseEditableChart(version.chart.text, difficulty);
    } catch (err) {
      setStatusMsg(err.message || "Could not open this take in the editor.");
      return;
    }
    const editingExistingDraft = version.status === "draft" && version.meta?.edited;
    dispatchEditor({ type: "replaceDoc", doc });
    setEditorSourceVersionId(editingExistingDraft ? version.parentId || version.id : version.id);
    setEditorDraftVersionId(editingExistingDraft ? version.id : "");
    setEditorDirty(false);
    setEditorSavedAt(editingExistingDraft ? version.updatedAt || 0 : 0);
    setEditorTool("select");
    setEditorPlayhead({ time: 0, duration: doc.durationSec || 0 });
    setEditorSeekRequest(null);
    setSingleVersion(versionId);
    setPreviewMode("single");
    setDeckTab("edit");
  };

  const ensureEditorDraft = () => {
    if (editorDraftVersionId) return editorDraftVersionId;
    const source = editorVersionOptions.find((v) => v.id === editorSourceVersionId);
    if (!source) return "";
    const doc = editorState.doc;
    const chartText = doc ? writeEditableChart(doc.chartText, doc.difficulty, doc) : source.chart.text;
    const draft = makeEditedVersion(source, chartText, nextEditName(source, editorVersionOptions.map((v) => v.name)), doc, editorVersionOptions);
    setLocalVersions((prev) => [...(prev.length ? prev : versionOptions), draft]);
    setEditorDraftVersionId(draft.id);
    setSingleVersion(draft.id);
    return draft.id;
  };

  const applyEditorChange = (change) => {
    const mutating = EDITOR_MUTATING.has(change.type) && editorChangeCanMutate(change);
    if (mutating) ensureEditorDraft();
    dispatchEditor(change);
    if (mutating) setEditorDirty(true);
  };

  const undoEditorChange = () => applyEditorChange({ type: "undo" });
  const redoEditorChange = () => applyEditorChange({ type: "redo" });
  const requestEditorSeek = (seconds) =>
    setEditorSeekRequest({ seconds: Math.max(0, Number(seconds) || 0), nonce: Date.now() + Math.random() });
  const requestEditorPlayToggle = () => setEditorPlayRequest({ nonce: Date.now() + Math.random() });

  const saveEditorDraft = async () => {
    const doc = editorState.doc;
    if (!doc) return false;
    const source = editorVersionOptions.find((v) => v.id === editorSourceVersionId) || null;
    const chartText = writeEditableChart(doc.chartText, doc.difficulty, doc);
    setBusyAction("saving-edit");
    setStatusMsg("");
    try {
      let draftId = editorDraftVersionId;
      const existing = draftId ? editorVersionOptions.find((v) => v.id === draftId) : null;
      const draft = existing
        ? updateEditedVersion(existing, chartText, doc)
        : makeEditedVersion(source, chartText, nextEditName(source, editorVersionOptions.map((v) => v.name)), doc, editorVersionOptions);
      draftId = draft.id;
      const nextVersions = existing
        ? editorVersionOptions.map((v) => (v.id === draftId ? draft : v))
        : [...editorVersionOptions, draft];
      if (songId) {
        await updateSongRecord(songId, {
          versions: nextVersions.map(versionForSave).filter(Boolean),
          settings: { ...(importedSong?.settings || {}), activeVersionId: draftId },
        });
        await refreshImportedSong(draftId);
      } else {
        setLocalVersions(nextVersions);
      }
      setEditorDraftVersionId(draftId);
      setSingleVersion(draftId);
      setDeckTab("edit");
      setEditorDirty(false);
      setEditorSavedAt(Date.now());
      setStatusMsg("Edit saved as draft.");
      onSaved?.();
      return true;
    } catch (err) {
      // Keep dirty editor state in memory so nothing is lost on a failed save.
      setStatusMsg(err.message || "Could not save edit.");
      return false;
    } finally {
      setBusyAction("");
    }
  };

  const discardEditorDraft = () => {
    if (editorDraftVersionId && editorSavedAt === 0) {
      setLocalVersions((prev) => prev.filter((v) => v.id !== editorDraftVersionId));
    }
    resetEditorSession();
    setDeckTab("takes");
  };

  const finishEditing = async () => {
    if (editorDirty) {
      const ok = await saveEditorDraft();
      if (!ok) return;
    }
    resetEditorSession();
    setDeckTab("takes");
  };

  const editorSourceVersion = decoratedVersions.find((v) => v.id === editorSourceVersionId) || null;
  const editorDraftVersion = decoratedVersions.find((v) => v.id === editorDraftVersionId) || null;
  const hasEditorSession = Boolean(editorSourceVersionId && editorState.doc);
  const editorPreviewTrack = useMemo(
    () => (editorState.doc ? buildEditorPreviewTrack(editorState.doc) : null),
    [editorState.doc]
  );

  const editor = {
    doc: editorState.doc,
    selectedNoteIds: editorState.selectedNoteIds,
    selectedRangeIds: editorState.selectedRangeIds,
    revision: editorState.revision,
    canUndo: editorState.past.length > 0,
    canRedo: editorState.future.length > 0,
    tool: editorTool,
    snap: editorSnap,
    dirty: editorDirty,
    savedAt: editorSavedAt,
    playhead: editorPlayhead,
    seekRequest: editorSeekRequest,
    playRequest: editorPlayRequest,
    playing: editorPlaying,
    sourceVersion: editorSourceVersion,
    draftVersion: editorDraftVersion,
    previewTrack: editorPreviewTrack,
    hasSession: hasEditorSession,
  };

  return {
    // song & media
    songId,
    importedSong,
    hasMedia,
    details,
    setField,
    background,
    albumUrl,
    sourceAudioFile,
    sourceAudioName,
    sourceAudioMeta,
    pickAudio,
    pickBackground,
    clearBackground,
    handleMediaFile,
    // status
    busy,
    busyAction,
    statusMsg,
    engineError,
    setupStatus,
    setupBlocking,
    setupMessage,
    unsupportedTarget,
    targetPlatform: setupStatus?.platform || "",
    targetArch: setupStatus?.arch || "",
    // engine & controls
    generators,
    generatorId,
    selectedGenerator,
    selectedGeneratorSetup,
    selectedGeneratorLabel,
    supportedDifficultyIds,
    selectedPreset,
    currentGeneration,
    resolvedSettings,
    generationControls,
    hasSourceChartSync,
    usesSourceChartSync,
    setGenerationControls,
    updateGenerationControl,
    updateAdvancedNumberControl,
    applyGenerationPreset,
    resetCurrentGenerationPreset,
    advancedSettingsOpen,
    setAdvancedSettingsOpen,
    randomSeedValue,
    // run & actions
    genRun,
    liveGeneration,
    liveAnalysisAudioBuffer,
    liveStageFocused,
    showingLiveStage: busyAction === "generating" && (liveStageFocused || !track),
    setLiveStageFocused,
    reportPreviewPlaying,
    handleGenerate,
    canRetryUsingCpu: !busy && genRun?.songId === (songId || pendingSeedSongIdRef.current) && Boolean(cpuRetryRef.current) && canRetryUsingCpu(genRun),
    handleRetryUsingCpu: () => {
      if (!busy && canRetryUsingCpu(genRun)) cpuRetryRef.current?.();
    },
    handleStopGenerate,
    handleSave,
    handleExportFinal,
    handleSaveFinalToLibrary,
    librarySavedAt,
    libraryFolderGate,
    deckTab,
    setDeckTab,
    // editor
    editor,
    startEditingVersion,
    applyEditorChange,
    saveEditorDraft,
    discardEditorDraft,
    finishEditing,
    requestEditorSeek,
    requestEditorPlayToggle,
    setEditorPlaying,
    undoEditorChange,
    redoEditorChange,
    setEditorTool,
    setEditorSnap,
    setEditorPlayhead,
    demucsArtifacts,
    activeDemucsId,
    activeDemucsArtifact,
    currentSourceVariantKey: currentSourceTransform.key,
    currentSourceVariantLabel: compactSourceVariantLabel(currentSourceTransform),
    demucsAudition,
    demucsAuditionLoadingKey,
    demucsAuditionMode,
    setDemucsAuditionMode,
    loadDemucsStem,
    auditionDemucsStem,
    prepareDemucsSeparation,
    selectDemucsSeparation,
    // versions
    baseTrack,
    audioBuffer,
    audioLeadInSeconds,
    previewAudioError,
    activeVideoOffset,
    track,
    noteCount,
    decoratedVersions,
    candidateVersions,
    justGeneratedId,
    selectedSingleVersion,
    selectedCompareVersions,
    removeCandidate,
    // preview & compare orchestration
    previewMode,
    previewVersion,
    compareSelection,
    toggleCompareSelection,
    toggleCompareMode,
    exitCompare,
    // final slots
    cleanedFinalSlots,
    finalSlotVersions,
    finalFilledCount,
    finalReadyLabel,
    finalTimingIssue,
    updateFinalSlot,
    // difficulty summary
    diff,
    difficultyName,
    difficultyTone,
  };
}

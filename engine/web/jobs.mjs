// The browser engine's jobs, run in the engine worker: generate a chart,
// prepare a separation, inpaint part of a chart. Each mirrors its desktop
// counterpart in engine/bin/autochart-engine.cjs (same stages, events and
// result fields) over audio held in memory instead of files on disk.

import { demucsOrchestration } from "../lib/onnx/manifest.mjs";
import { beatOrchestration, medianBpm } from "../lib/onnx/beatDetect.mjs";
import {
  separateStems, detectTiming, transcribe, transcriberChannels, needsStems, chartFromTokens, prefixBiasMaker,
  makeMelTables, melTableSpec,
} from "../lib/onnx/pipeline.mjs";
import { encodeMelTables, decodeMelTables, tablesMatch } from "../lib/onnx/melTables.mjs";
import { sessionDevice } from "../lib/onnx/runtime.mjs";
import { loadMelSession, buildBeatMel, DEFAULT_REF_ONLY_MIXES } from "../lib/onnx/buildBeatMel.mjs";
import { loadEncoderSessions, runEncoder, makeRng, disposeGpuTensor } from "../lib/onnx/transcribe.mjs";
import { readChartStream, encodeStream, spliceTrackNotes } from "../lib/onnx/chartTokens.mjs";
import { eventsToChartNotes, flattenNoteLines, DESC_AUTO_BIN } from "../lib/onnx/chartEventStream.mjs";
import { loadFimDecoderSession, inpaint, fillEvents } from "../lib/onnx/inpaint.mjs";
import { sourceChartBeatGrid } from "../lib/chartTiming.mjs";
import {
  SOURCE_CHART_DETECTOR, descriptorKnobNames, effectiveTranscriberGeneration, integerValue,
  normalizeDifficulty, normalizeTranscriberSettings,
} from "../lib/transcriberSettings.mjs";
import { loadManifest, releaseSessions, transcriberDevice as pickTranscriberDevice } from "./host.mjs";
import { checkStorageRoom, ensureModelFiles, missingModelFiles, separationFiles } from "./modelStore.mjs";
import { stemKey, loadStems, saveStems, loadMelTables, saveMelTables } from "./stemStore.mjs";
import { stereoAt, ffmpegMonoAt, averageMonoAt } from "./audio.mjs";

const TRANSCRIBER_RATE = 22050;
const CHART_OUTPUT_RESOLUTION = 192;
const DEFAULT_DEMUCS_ID = "demucs_default";
const BACKEND = "onnxruntime-web";

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stemSetOf(generator) {
  const separation = plainObject(generator?.separation);
  return separation.cacheSubdir ? String(separation.stemSet || separation.cacheSubdir) : "htdemucs";
}

// The run's audio with the source transform's lead-in silence in front.
function withLeadIn(audio, sourceTransform) {
  const ms = Number(sourceTransform?.leadInSilenceMs) || 0;
  const pad = Math.round((ms / 1000) * audio.sampleRate);
  if (!pad) return audio;
  const left = new Float32Array(pad + audio.left.length);
  const right = new Float32Array(pad + audio.right.length);
  left.set(audio.left, pad);
  right.set(audio.right, pad);
  return { left, right, sampleRate: audio.sampleRate };
}

// Downloads the model folder's files that aren't cached yet (or only the
// listed ones), reported as the given stage so the progress card shows the
// download in place of that step.
async function downloadModels(manifest, emit, { stage = "queued", only = null } = {}) {
  let lastPercent = -1;
  const result = await ensureModelFiles(manifest, {
    only,
    onProgress: ({ loaded, total, file }) => {
      const percent = total ? Math.floor((loaded / total) * 100) : 0;
      if (percent === lastPercent) return;
      lastPercent = percent;
      emit({ type: "stage", stage, status: "running", progress: total ? loaded / total : 0, downloading: true });
      emit({ type: "log", stage, stream: "stdout", message: `Downloading models: ${percent}% (${file})` });
    },
  });
  if (result.downloaded) {
    emit({ type: "log", stage, stream: "stdout", message: `Downloaded ${result.downloaded} model files` });
  }
}

function separationKey(job) {
  return stemKey({
    audioSha256: job.audioSha256,
    sourceVariantKey: job.sourceTransform?.key || "lead-in:0",
    separationId: String(job.separationId || DEFAULT_DEMUCS_ID),
    stemSet: stemSetOf(job.generator),
  });
}

// The model files a run needs before its first step. When the run separates,
// only Demucs downloads first and the rest follows separation (downloadRest),
// so a device too slow to separate can switch to Lite without having fetched
// the rest of the model. Inpaint downloads everything up front.
async function prepareModels(job, emit, { separationFirst = true } = {}) {
  const manifest = await loadManifest(job.modelUrl);
  const separating = separationFirst && needsStems(manifest) && !(await storedSeparation(job, manifest));
  // Checked for the whole model up front, so a full device finds out before
  // separating rather than after.
  if (separating) await checkStorageRoom((await missingModelFiles(manifest)).total);
  await downloadModels(manifest, emit, { only: separating ? separationFiles(manifest) : null });
  emit({ type: "stage", stage: "queued", status: "completed" });
  return manifest;
}

// After separation: whatever the model still needs, shown as the timing step.
async function downloadRest(manifest, emit) {
  await downloadModels(manifest, emit, { stage: "timing" });
}

// The stored separation this run can use: its mel tables, plus its stems when
// the run needs them (job.needStems, to play them). Null when it must separate.
async function storedSeparation(job, manifest) {
  const melTables = await storedMelTables(job, manifest);
  if (!melTables) return null;
  if (!job.needStems) return { melTables, stems: null };
  const stems = await loadStems(separationKey(job), demucsOrchestration(manifest).stems);
  return stems ? { melTables, stems } : null;
}

async function storedMelTables(job, manifest) {
  const bytes = await loadMelTables(separationKey(job));
  if (!bytes) return null;
  try {
    const melTables = await decodeMelTables(bytes);
    return tablesMatch(melTables, melTableSpec(manifest)) ? melTables : null;
  } catch {
    return null;
  }
}

// Each stem the transcriber reads, as mono 22.05 kHz.
function stemMonosOf(manifest, separated) {
  const stemMonos = {};
  for (const name of transcriberChannels(manifest).filter((channel) => channel !== "full")) {
    const stem = separated.stems.find((s) => s.name === name);
    if (!stem) throw new Error(`transcription: missing ${name} stem`);
    stemMonos[name] = averageMonoAt(stem.left, stem.right, separated.sampleRate, TRANSCRIBER_RATE);
  }
  return stemMonos;
}

function fullMonoOf(audio) {
  return averageMonoAt(audio.left, audio.right, audio.sampleRate, TRANSCRIBER_RATE);
}

// This run's separation as mel tables: stored when this song, lead-in and
// separation were separated before, else Demucs, then the tables are made
// and stored in place of the stems (kept too when job.needStems).
async function separation(job, manifest, audio, emit) {
  if (!needsStems(manifest)) {
    emit({ type: "stage", stage: "demucs", status: "skipped", backend: BACKEND });
    return { melTables: null, key: null, cacheHit: false, device: null, skipped: true };
  }
  const orch = demucsOrchestration(manifest);
  const key = separationKey(job);
  const stored = await storedSeparation(job, manifest);
  if (stored) {
    emit({ type: "stage", stage: "demucs", status: "completed", cache: "hit", backend: BACKEND });
    emit({ type: "log", stage: "demucs", stream: "stdout", message: "reusing the stored separation" });
    return { melTables: stored.melTables, key, cacheHit: true, device: null };
  }
  emit({ type: "stage", stage: "demucs", status: "running", backend: BACKEND });
  const log = (message) => emit({ type: "log", stage: "demucs", stream: "stdout", message });
  const stereo = stereoAt(audio, orch.sampleRate);
  const out = await separateStems({
    manifest, device: job.device, left: stereo.left, right: stereo.right,
    log,
    onDevice: (device) => emit({ type: "stage", stage: "demucs", status: "running", backend: BACKEND, device }),
    onProgress: ({ index, total }) => emit({
      type: "stage", stage: "demucs", status: "running", progress: total ? index / total : 0,
      audioSeconds: stereo.left.length / orch.sampleRate,
    }),
  });
  await releaseSessions();
  // Stored tables stay as they were (separating again only to play the
  // stems), so later charts match earlier ones.
  let melTables = await storedMelTables(job, manifest);
  if (!melTables) {
    melTables = await makeMelTables({ manifest, fullMono: fullMonoOf(audio), stemMonos: stemMonosOf(manifest, out), log });
    await releaseSessions();
    const bytes = await encodeMelTables(melTables);
    await saveMelTables(key, bytes);
    log(`mel tables: stored ${(bytes.byteLength / 1e6).toFixed(1)} MB`);
  }
  if (job.needStems) await saveStems(key, out);
  emit({ type: "stage", stage: "demucs", status: "completed", backend: BACKEND, device: out.device });
  return { melTables, key, cacheHit: false, device: out.device };
}

async function timing(job, manifest, settings, audio, emit) {
  const audioDuration = audio.left.length / audio.sampleRate;
  if (settings.detector === SOURCE_CHART_DETECTOR) {
    if (!job.sourceChartText) throw new Error("Imported chart sync was selected, but no source notes.chart was provided.");
    emit({ type: "stage", stage: "timing", status: "running", backend: "source-chart", detector: SOURCE_CHART_DETECTOR });
    const grid = sourceChartBeatGrid(job.sourceChartText, { audioDuration });
    const beatTimes = Float64Array.from(grid.beatTimes);
    const beats = {
      beatTimes,
      downbeatTimes: Float64Array.from(grid.downbeatTimes),
      rawBeatTimes: beatTimes,
      smoothedBeatTimes: new Float64Array(0),
      nLeadIn: 0,
      tempoBpm: medianBpm(beatTimes),
      timingMode: "source-chart",
      detector: SOURCE_CHART_DETECTOR,
      syncLines: grid.syncLines,
      resolution: grid.resolution,
      offset: grid.offset,
    };
    emit({ type: "log", stage: "timing", stream: "stdout", message: `beat: imported chart sync grid (${beatTimes.length} beats)` });
    emit({ type: "stage", stage: "timing", status: "completed", backend: "source-chart", beats: beatTimes.length, tempoBpm: beats.tempoBpm });
    return { beats, device: null };
  }
  const smooth = Boolean(settings.smoothing?.enabled);
  emit({ type: "stage", stage: "timing", status: "running", backend: BACKEND, smoothing: smooth });
  const mono = ffmpegMonoAt(audio, beatOrchestration(manifest).sampleRate);
  const out = await detectTiming({
    manifest, device: job.device, mono, smooth,
    log: (message) => emit({ type: "log", stage: "timing", stream: "stdout", message }),
    onDevice: (device) => emit({ type: "stage", stage: "timing", status: "running", backend: BACKEND, device }),
    onSmoothingStart: () => emit({ type: "stage", stage: "smoothing", status: "running", backend: BACKEND }),
  });
  await releaseSessions();
  const { beats } = out;
  emit({
    type: "stage", stage: "timing", status: "completed", backend: BACKEND, device: out.device,
    beats: beats.beatTimes.length, downbeats: beats.downbeatTimes.length, nLeadIn: beats.nLeadIn, tempoBpm: beats.tempoBpm,
    timingMode: beats.timingMode, smoothing: smooth,
  });
  if (smooth) emit({ type: "stage", stage: "smoothing", status: "completed", backend: BACKEND, device: out.device });
  return out;
}

export async function runGenerate(job, emit, runtime) {
  const generator = job.generator;
  const settings = normalizeTranscriberSettings(job, generator);
  const manifest = await prepareModels(job, emit);

  emit({ type: "stage", stage: "audio", status: "running", backend: BACKEND });
  const audio = withLeadIn(job.audio, job.sourceTransform);
  emit({ type: "stage", stage: "audio", status: "completed", backend: BACKEND });

  const stems = await separation(job, manifest, audio, emit);
  await downloadRest(manifest, emit);
  const timed = await timing(job, manifest, settings, audio, emit);
  const { beats } = timed;

  const transcriberDevice = pickTranscriberDevice(job.transcriberDevice || job.device, runtime);
  emit({ type: "stage", stage: "transcription", status: "running", backend: BACKEND, requestedDevice: transcriberDevice });
  const fullMono = fullMonoOf(audio);
  const audioDuration = fullMono.length / TRANSCRIBER_RATE;
  const resolution = beats.resolution || CHART_OUTPUT_RESOLUTION;
  const offset = beats.offset || 0;
  let transcriberProvider = null;
  const transcription = await transcribe({
    manifest,
    device: transcriberDevice,
    settings,
    knobNames: descriptorKnobNames(generator),
    fullMono,
    melTables: stems.melTables,
    audioDuration,
    beatTimes: Float64Array.from(beats.beatTimes),
    resolution,
    offset,
    syncLines: beats.syncLines,
    log: (message) => emit({ type: "log", stage: "transcription", stream: "stdout", message }),
    onDevice: (device) => {
      transcriberProvider = device;
      emit({ type: "stage", stage: "transcription", status: "running", backend: BACKEND, device, requestedDevice: transcriberDevice });
    },
    onPartial: (partial) => emit({
      type: "partial_chart",
      schemaVersion: 1,
      stage: "transcription",
      songKey: job.jobId,
      songName: job.metadata?.title || "Autochart",
      ...partial,
    }),
  });
  await releaseSessions();
  const { tokens, structure, forceSolo, forcedSolo, nBeats, descNames, bins, useCfg } = transcription;
  emit({ type: "stage", stage: "transcription", status: "completed", backend: BACKEND, device: transcriberProvider, nTokens: tokens.length });

  emit({ type: "stage", stage: "chart", status: "running", backend: BACKEND });
  const chart = chartFromTokens({
    tokens,
    structure,
    nBeats,
    resolution,
    syncLines: transcription.syncLines,
    offset,
    metadata: {
      title: String(job.metadata?.title || "Untitled").trim() || "Untitled",
      artist: String(job.metadata?.artist || "Unknown Artist").trim() || "Unknown Artist",
      charter: String(job.metadata?.charter || "Autochart").trim() || "Autochart",
    },
    difficulty: settings.difficulty,
  });
  emit({ type: "stage", stage: "chart", status: "completed", backend: BACKEND, noteLineCount: chart.noteLineCount, eventCount: chart.events.length });

  const generation = effectiveTranscriberGeneration(job, settings);
  const devices = { demucs: stems.device, timing: timed.device || null, transcriber: transcriberProvider };
  const decoderSettings = {
    difficulty: settings.difficulty,
    temperature: settings.temperature,
    topP: settings.topP,
    seed: settings.seed,
    guidanceScale: settings.guidanceScale,
    knobs: settings.knobs,
    knobsActive: settings.knobsActive,
    descriptorTrained: transcription.descriptorTrained,
  };
  const report = {
    schemaVersion: 1,
    generatorId: job.generatorId,
    generatorLabel: generator.label,
    backend: BACKEND,
    model: manifest.profileId || null,
    difficulty: settings.difficulty,
    temperature: settings.temperature,
    top_p: settings.topP,
    seed: settings.seed,
    descriptor_knobs: transcription.descriptorTrained && descNames
      ? Object.fromEntries(descNames.map((name, i) => [name, bins[i] === DESC_AUTO_BIN ? "auto" : bins[i]]))
      : null,
    guidance_scale: useCfg ? settings.guidanceScale : null,
    structure: structure
      ? { solos_flag: settings.solos, force_solo: forceSolo, forced_solo: forcedSolo, solos: chart.structureMarks.solos, sections: chart.structureMarks.sections }
      : null,
    event_count: chart.events.length,
    note_line_count: chart.noteLineCount,
    token_stats: { n_tokens: tokens.length, generation_seconds: transcription.stats?.generationSeconds, n_beats: nBeats },
    timing: {
      detector: beats.detector,
      timingMode: beats.timingMode,
      smoothing: settings.smoothing,
      nBeats: beats.beatTimes.length - 1,
      nLeadIn: beats.nLeadIn,
      tempoBpm: beats.tempoBpm,
      audioDuration,
    },
  };
  const separationResult = job.demucsSeparation || null;
  return {
    schemaVersion: 1,
    jobId: job.jobId,
    status: "completed",
    generatorId: job.generatorId,
    generatorLabel: generator.label,
    engineVersion: job.engineVersion || "",
    generation,
    chartText: chart.text,
    report,
    provenance: {
      kind: "autochart-engine-onnx",
      generatorId: job.generatorId,
      generatorLabel: generator.label,
      engineVersion: job.engineVersion || "",
      runtime: {
        platform: "web",
        backend: BACKEND,
        executionProvider: transcriberProvider,
        requestedDevice: String(job.device || "auto"),
        devices,
        cachedStages: stems.cacheHit ? ["demucs"] : [],
      },
      stages: ["demucs", "timing", "transcription", "chart"],
      settings,
      decoderSettings,
      generation,
      sourceSeparation: separationResult,
      sourceTransform: job.sourceTransform || null,
      sourceChart: settings.detector === SOURCE_CHART_DETECTOR ? job.sourceChart || null : null,
    },
    metrics: {
      tokenStats: report.token_stats,
      eventCount: report.event_count,
      noteLineCount: report.note_line_count,
      timing: report.timing,
    },
    audioSha256: job.audioSha256,
    sourceTransform: job.sourceTransform || null,
    sourceSeparation: separationResult,
    createdAt: Date.now(),
  };
}

export async function runPrepareDemucs(job, emit) {
  const manifest = await prepareModels(job, emit);
  emit({ type: "stage", stage: "audio", status: "completed", backend: BACKEND });
  const audio = withLeadIn(job.audio, job.sourceTransform);
  const stems = await separation(job, manifest, audio, emit);
  return {
    schemaVersion: 1,
    jobId: job.jobId,
    status: "completed",
    id: job.demucsSeparation?.id || DEFAULT_DEMUCS_ID,
    name: job.demucsSeparation?.name || "Default separation",
    generatorId: job.generatorId,
    generatorLabel: job.generator.label,
    audioSha256: job.audioSha256,
    sourceTransform: job.sourceTransform || null,
    profile: "Standard Demucs",
    cache: { workspace: stems.key },
    provenance: { kind: "autochart-engine-onnx", runtime: { platform: "web", backend: BACKEND, devices: { demucs: stems.device } } },
    createdAt: Date.now(),
  };
}

// New notes for bar spans of a take, on the take's own tempo map.
export async function runInpaint(job, emit, runtime) {
  const generator = job.generator;
  const request = plainObject(job.inpaint);
  const chartText = String(request.chartText || "");
  const difficulty = normalizeDifficulty(request.difficulty);
  const settings = normalizeTranscriberSettings(job, generator);
  const seed = integerValue(request.seed, settings.seed, { min: 0, max: 2 ** 31 - 2 });
  const manifest = await prepareModels(job, emit, { separationFirst: false });
  const stage = manifest.stages.transcriber;
  if (!stage.fim) throw new Error(`${generator.label} can't regenerate part of a chart.`);

  emit({ type: "stage", stage: "audio", status: "completed", backend: BACKEND });
  const audio = withLeadIn(job.audio, job.sourceTransform);
  const stems = await separation(job, manifest, audio, emit);

  emit({ type: "stage", stage: "transcription", status: "running", backend: BACKEND });
  const log = (message) => emit({ type: "log", stage: "transcription", stream: "stdout", message });
  const modelConfig = stage.modelConfig || {};
  const structure = stage.structure || null;
  const channelOrder = stage.channelOrder.map(String);
  const fullMono = fullMonoOf(audio);
  const audioDuration = fullMono.length / TRANSCRIBER_RATE;
  const grid = sourceChartBeatGrid(chartText, { audioDuration });
  const resolution = grid.resolution;
  const device = pickTranscriberDevice(job.transcriberDevice || job.device, runtime);
  const melSession = await loadMelSession(manifest, device);
  const { beatMel, beatMask, nBeats } = await buildBeatMel({
    melSession,
    fullMono22050: fullMono,
    melTables: stems.melTables,
    beatTimes: Float64Array.from(grid.beatTimes),
    maxBeats: Number(modelConfig.maxBeats || 1280),
    audioDuration,
    channelOrder,
    refOnlyMixes: stage.refOnlyMixes || DEFAULT_REF_ONLY_MIXES,
    log,
  });

  // Bar spans in ticks -> merged beat holes inside the song.
  const holes = [];
  const spans = (Array.isArray(request.regions) ? request.regions : [])
    .map((r) => [Math.max(0, Math.floor(Number(r.startTick) / resolution)), Math.min(nBeats, Math.ceil(Number(r.endTick) / resolution))])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0]);
  for (const span of spans) {
    const last = holes[holes.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else holes.push(span.slice());
  }
  if (!holes.length) throw new Error("Pick bars inside the song to regenerate.");

  const stream = readChartStream(chartText, difficulty, {
    sectionTypes: structure ? structure.SECTION_TYPES : [],
    sectionLabels: stage.fim.sectionLabels,
  });
  const tokens = encodeStream(stream.events, nBeats, {
    difficulty,
    solos: stream.solos,
    sections: stream.sections,
    structure,
    sectionFlag: Boolean(structure && structure.mode === "solo_sections"),
  });
  const { prefixBiasOf } = await prefixBiasMaker(manifest);
  const encoderSession = await loadEncoderSessions(manifest, device);
  const session = await loadFimDecoderSession(manifest, device);
  const executionProvider = sessionDevice(session, device);
  emit({ type: "stage", stage: "transcription", status: "running", backend: BACKEND, device: executionProvider });
  const encoderCtx = await runEncoder(encoderSession, beatMel, beatMask, nBeats);

  const candidates = integerValue(request.tries, 1, { min: 1, max: 8 });
  const holeBeats = holes.map(([a, b]) => b - a);
  const totalWork = holeBeats.reduce((sum, n) => sum + n, 0) * candidates;
  const kept = [];
  const linesOf = (fillTokens, startBeat) => flattenNoteLines(eventsToChartNotes(fillEvents(fillTokens, startBeat), resolution));
  const regionOf = (hole, noteLines) => ({ startTick: hole[0] * resolution, endTick: hole[1] * resolution, noteLines });
  let lastSent = 0;
  let decoded;
  try {
    log(`inpaint: ${holes.length} span(s) over ${nBeats} beats, ${candidates} tries each, seed ${seed}, device ${executionProvider}`);
    decoded = await inpaint({
      manifest,
      session,
      encoderCtx,
      nBeats,
      tokens,
      holes,
      knobs: plainObject(request.knobs),
      knobNames: descriptorKnobNames(generator),
      makePrefixBias: prefixBiasOf,
      guidanceScale: settings.guidanceScale,
      temperature: Number(stage.fim.temperature ?? settings.temperature),
      topP: Number(stage.fim.topP ?? settings.topP),
      rng: makeRng(seed),
      candidates,
      onProgress: ({ hole, candidate, beats, fill }) => {
        const now = Date.now();
        if (now - lastSent < 150) return;
        lastSent = now;
        const before = holeBeats.slice(0, hole).reduce((sum, n) => sum + n, 0) * candidates;
        emit({
          type: "inpaint_progress",
          done: before + candidate * holeBeats[hole] + beats,
          total: totalWork,
          hole,
          holes: holes.length,
          candidate,
          candidates,
          regions: [...kept, regionOf(holes[hole], linesOf(fill, holes[hole][0]))],
        });
      },
      onHole: (fill) => kept.push(regionOf([fill.startBeat, fill.endBeat], linesOf(fill.fills[fill.chosen], fill.startBeat))),
      log,
    });
  } finally {
    for (const t of [encoderCtx.alignedMemory, encoderCtx.crossK, encoderCtx.crossV]) disposeGpuTensor(t);
    await releaseSessions();
  }
  emit({ type: "stage", stage: "transcription", status: "completed", backend: BACKEND, device: executionProvider });

  const regions = decoded.holes.map((hole) => ({
    startTick: hole.startBeat * resolution,
    endTick: hole.endBeat * resolution,
    chosen: hole.chosen,
    tries: hole.fills.map((fill, i) => ({ noteLines: linesOf(fill, hole.startBeat), seam: hole.seams[i] })),
  }));
  return {
    schemaVersion: 1,
    jobId: job.jobId,
    status: "completed",
    generatorId: job.generatorId,
    generatorLabel: generator.label,
    chartText: spliceTrackNotes(chartText, difficulty, regions.map((r) => ({ ...r, noteLines: r.tries[r.chosen].noteLines }))),
    inpaint: {
      difficulty,
      resolution,
      seed,
      regions,
      holes: decoded.holes.map(({ startBeat, endBeat, chosen, seams, cfg, bins }) => ({ startBeat, endBeat, chosen, seams, cfg, bins })),
      tries: candidates,
    },
    provenance: {
      kind: "autochart-engine-onnx-inpaint",
      generatorId: job.generatorId,
      runtime: { platform: "web", backend: BACKEND, executionProvider, cachedStages: stems.cacheHit ? ["demucs"] : [] },
    },
    createdAt: Date.now(),
  };
}

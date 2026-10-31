// The generation pipeline both engines run: separate stems, find the beats,
// transcribe, write the chart. Inputs and outputs are plain arrays; decoding
// audio, caching, files and progress events stay with the caller (the desktop
// engine in engine/bin, the browser engine in engine/web).

import { demucsOrchestration } from "./manifest.mjs";
import { loadTables, sessionDevice } from "./runtime.mjs";
import { loadDemucsSessions, separate, foldStems } from "./demucsSeparate.mjs";
import { beatOrchestration, loadBeatSessions, detectBeats, medianBpm } from "./beatDetect.mjs";
import { CHANNEL_ORDER, DEFAULT_REF_ONLY_MIXES, loadMelSession, buildBeatMel, stemMelTables } from "./buildBeatMel.mjs";
import { melRecipe, tableChannels } from "./melTables.mjs";
import { computePrefixBias } from "./prefixTables.mjs";
import { loadEncoderSessions, loadDecoderSession, generate, makeRng } from "./transcribe.mjs";
import { generateWithForcedSolo } from "./forceSolo.mjs";
import * as stream from "./chartEventStream.mjs";
import { stemLevels } from "./songMap.mjs";

const VOCAB_KEYS = ["DIFF_BASE", "DESC_BASE", "N_DESCRIPTORS", "DESCRIPTOR_BIN_COUNT", "VOCAB_SIZE"];

// Demucs over stereo audio at orch.sampleRate. Returns the folded stems.
// onStems gets each finished stretch's stem levels (songMap.mjs).
export async function separateStems({ manifest, device, left, right, log = null, onDevice = null, onProgress = null, onStems = null }) {
  const orch = demucsOrchestration(manifest);
  const length = left.length;
  if (log) log("loading separation models");
  const t0 = Date.now();
  const sessions = await loadDemucsSessions(manifest, device, log);
  const executionProvider = sessions.device || device;
  if (log) log(`separation models loaded on ${executionProvider} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (onDevice) onDevice(executionProvider);
  const planar = new Float32Array(2 * length);
  planar.set(left, 0);
  planar.set(right, length);
  if (log) log(`running ${orch.sources.length}-stem separation`);
  const sourceStems = await separate(planar, length, sessions, orch, {
    log,
    onProgress,
    onPower: onStems && (({ first, power }) => onStems({ from: first, levels: stemLevels(power, orch) })),
  });
  return { stems: foldStems(sourceStems, orch), device: executionProvider, model: orch.model, sampleRate: orch.sampleRate };
}

// Beat This over mono audio at the beat stage's rate (22.05 kHz).
export async function detectTiming({
  manifest, device, mono, smooth, log = null, onDevice = null, onSmoothingStart = null, onSmoothingError = null, onChunk = null,
}) {
  const orch = beatOrchestration(manifest);
  const sessions = await loadBeatSessions(manifest, device);
  const executionProvider = sessions.device || device;
  if (onDevice) onDevice(executionProvider);
  const detected = await detectBeats(mono, manifest, sessions, orch, {
    log, smooth, onSmoothingStart, onSmoothingError, onChunk,
  });
  const activeBeatTimes = smooth ? detected.beatTimes : detected.rawBeatTimes;
  const timingMode = smooth ? "smoothed" : "raw";
  const beats = {
    beatTimes: Float64Array.from(activeBeatTimes),
    downbeatTimes: Float64Array.from(detected.downbeatTimes),
    rawBeatTimes: Float64Array.from(detected.rawBeatTimes),
    smoothedBeatTimes: smooth ? Float64Array.from(detected.beatTimes) : new Float64Array(0),
    nLeadIn: smooth ? detected.nLeadIn : 0,
    tempoBpm: medianBpm(activeBeatTimes),
    timingMode,
    detector: "beat_this_ft_v4_onnx",
    syncLines: null,
  };
  if (log) log(`beat: using ${timingMode} timing grid (${beats.beatTimes.length} beats)`);
  return { beats, device: executionProvider, orch };
}

function transcriberStageOf(manifest) {
  return manifest.stages && manifest.stages.transcriber ? manifest.stages.transcriber : {};
}

// The channels the transcriber reads, in order: "full" is the mix, the rest are stems.
export function transcriberChannels(manifest) {
  const stage = transcriberStageOf(manifest);
  return Array.isArray(stage.channelOrder) && stage.channelOrder.length
    ? stage.channelOrder.map(String)
    : CHANNEL_ORDER;
}

function transcriberRefMixes(manifest) {
  const stage = transcriberStageOf(manifest);
  return stage.refOnlyMixes && typeof stage.refOnlyMixes === "object" ? stage.refOnlyMixes : DEFAULT_REF_ONLY_MIXES;
}

// The mel tables a model reads (see melTables.mjs): its mel recipe over these channels.
export function melTableSpec(manifest) {
  const channelOrder = transcriberChannels(manifest);
  const refOnlyMixes = transcriberRefMixes(manifest);
  return {
    channelOrder,
    refOnlyMixes,
    recipe: melRecipe(transcriberStageOf(manifest)),
    channels: tableChannels(channelOrder, refOnlyMixes),
  };
}

// A separation's mel tables from its stems (22.05 kHz mono), made on the CPU
// so every device stores the same ones.
export async function makeMelTables({ manifest, fullMono, stemMonos, log = null }) {
  const { channelOrder, refOnlyMixes, recipe } = melTableSpec(manifest);
  const melSession = await loadMelSession(manifest, "cpu");
  return stemMelTables({ melSession, fullMono22050: fullMono, stemMonos22050: stemMonos, channelOrder, refOnlyMixes, recipe, log });
}

// A model that reads only the mix (Lite) skips separation.
export function needsStems(manifest) {
  return transcriberChannels(manifest).some((channel) => channel !== "full");
}

// The decoder's prefix bias for a header (BOS, difficulty, knobs, flags).
export async function prefixBiasMaker(manifest) {
  const transcriberStage = transcriberStageOf(manifest);
  const conditioning = transcriberStage.prefixConditioning;
  const tables = await loadTables(manifest, conditioning.file);
  const dModel = Number((transcriberStage.modelConfig && transcriberStage.modelConfig.dModel) || 512);
  const descPrefixScan = Number(conditioning.descPrefixScan || 8);
  // v1's manifest has no descriptorTokenBase, which keeps its original knob
  // lookup (see computePrefixBias); six-stem models declare the model's DESC_BASE.
  const descriptorTokenBase = Number(conditioning.descriptorTokenBase || 0);
  const prefixBiasOf = (prefixTokens) => computePrefixBias(prefixTokens, {
    descPrefixScan,
    pervasiveDifficulty: Boolean(conditioning.pervasiveDifficulty),
    pervasiveDescriptors: Boolean(conditioning.pervasiveDescriptors),
    dModel, tables, descriptorTokenBase,
  });
  return { prefixBiasOf, descPrefixScan };
}

// Mel features, prefix, then the autoregressive decode. fullMono and
// stemMonos are 22.05 kHz mono (melTables, when stored, stand in for
// stemMonos); beats carries the grid the chart is built on.
// onPartial gets the notes committed so far every few beats.
export async function transcribe({
  manifest, device, settings, knobNames,
  fullMono, stemMonos = null, melTables = null, audioDuration,
  beatTimes, resolution, offset = 0, syncLines = null,
  log = null, onDevice = null, onPartial = null,
}) {
  const transcriberStage = transcriberStageOf(manifest);
  const modelConfig = (transcriberStage && transcriberStage.modelConfig) || {};
  const maxBeats = Number(modelConfig.maxBeats || 1280);
  const channelOrder = transcriberChannels(manifest);
  const refOnlyMixes = transcriberRefMixes(manifest);
  if (modelConfig.inChannels != null && Number(modelConfig.inChannels) !== channelOrder.length) {
    throw new Error(`transcription: model expects ${modelConfig.inChannels} channels but the manifest orders ${channelOrder.length}`);
  }
  const vocab = transcriberStage.vocab || {};
  // The token layout is compiled into chartEventStream.mjs; refuse a model
  // whose manifest disagrees instead of feeding it the wrong prefix ids.
  for (const key of VOCAB_KEYS) {
    if (vocab[key] != null && Number(vocab[key]) !== stream[key]) {
      throw new Error(`transcription: model vocab ${key}=${vocab[key]} does not match the engine (${stream[key]})`);
    }
  }
  const descNames = Array.isArray(vocab.DESCRIPTOR_NAMES) && vocab.DESCRIPTOR_NAMES.length
    ? vocab.DESCRIPTOR_NAMES.map(String)
    : stream.DESCRIPTOR_NAMES;
  if (descNames.join(",") !== knobNames.join(",")) {
    throw new Error(`transcription: model knobs (${descNames.join(", ")}) do not match generator knobs (${knobNames.join(", ")})`);
  }
  const descriptorTrained = Boolean(transcriberStage && transcriberStage.prefixConditioning);

  const melSession = await loadMelSession(manifest, device);
  if (onDevice) onDevice(sessionDevice(melSession, device));
  const finalSyncLines = Array.isArray(syncLines) && syncLines.length
    ? syncLines
    : stream.beatsToSyncLines(beatTimes, resolution, 0.5);
  if (log) log(`transcription: building beat_mel (${beatTimes.length - 1} beats, audio ${audioDuration.toFixed(1)}s)`);
  const { beatMel, beatMask, nBeats, nFramesFinal, refDb } = await buildBeatMel({
    melSession,
    fullMono22050: fullMono,
    stemMonos22050: stemMonos,
    melTables,
    beatTimes,
    maxBeats,
    audioDuration,
    channelOrder,
    refOnlyMixes,
    log,
  });
  const beatMelShape = [1, nBeats, channelOrder.length, 80, 32];
  if (log) log(`transcription: beat_mel shape [${beatMelShape.join(", ")}] nFrames=${nFramesFinal} refDb=${refDb.toFixed(3)}`);

  const knobs = settings.knobs || {};
  const bins = descNames.map((name) => {
    const v = knobs[name];
    if (v == null) return stream.DESC_AUTO_BIN; // auto
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n)) return stream.DESC_AUTO_BIN;
    return Math.max(0, Math.min(6, n));
  });
  const prefixTokens = [stream.BOS_TOKEN, stream.difficultyToken(settings.difficulty)];
  for (let knex = 0; knex < descNames.length; knex += 1) {
    prefixTokens.push(stream.descriptorToken(knex, bins[knex]));
  }
  // Structure-marker models take solo/section flags after the knobs.
  const structure = transcriberStage.structure || null;
  const structurePrefix = stream.structurePrefixTokens(structure, { solos: settings.solos });
  prefixTokens.push(...structurePrefix);
  const { prefixBiasOf, descPrefixScan } = await prefixBiasMaker(manifest);
  const prefixBias = prefixBiasOf(prefixTokens);

  // All-Auto CFG reproduces the unguided logits exactly (cond == uncond), so
  // models that opt in skip the second decoder stream when no knob is set.
  const conditioning = transcriberStage.prefixConditioning;
  const cfgNeedsSetKnob = Boolean(conditioning && conditioning.cfgOnlyWithSetKnobs);
  const useCfg = settings.guidanceScale > 1.0 &&
    Boolean(conditioning && conditioning.pervasiveDescriptors) &&
    (!cfgNeedsSetKnob || settings.knobsActive);
  let uncondPrefixTokens = null, uncondPrefixBias = null;
  if (useCfg) {
    uncondPrefixTokens = [stream.BOS_TOKEN, stream.difficultyToken(settings.difficulty)];
    for (let knex = 0; knex < descNames.length; knex += 1) {
      uncondPrefixTokens.push(stream.descriptorToken(knex, stream.DESC_AUTO_BIN));
    }
    uncondPrefixTokens.push(...structurePrefix);
    uncondPrefixBias = prefixBiasOf(uncondPrefixTokens);
    if (log) log(`transcription: CFG w=${settings.guidanceScale} uncond prefix len ${uncondPrefixTokens.length}`);
  } else if (log) {
    log(`transcription: single-stream (no CFG; guidance=${settings.guidanceScale})`);
  }

  const encoderSession = await loadEncoderSessions(manifest, device);
  const decoderSession = await loadDecoderSession(manifest, device);
  const sessionDevices = [melSession, encoderSession, decoderSession].map((session) => sessionDevice(session, device));
  const executionProvider = sessionDevices.includes("cpu") ? "cpu" : sessionDevices[0] || device;
  if (onDevice) onDevice(executionProvider);
  const greedy = settings.temperature <= 0;
  const rng = greedy ? null : makeRng(settings.seed);
  if (log) log(`transcription: decode loop (device=${executionProvider}, requestedDevice=${device}, mode=${greedy ? "greedy" : "sampled"}, T=${settings.temperature}, top_p=${settings.topP}, seed=${settings.seed}, max_tokens=${Number(modelConfig.maxTokens || 8192)})`);

  let sequence = 0;
  const forceSolo = Boolean(structure && settings.solos && settings.forceSolo);
  const generateOptions = {
    manifest,
    encoderSession,
    decoderSession,
    beatMel,
    beatMask,
    nBeats,
    prefixTokens,
    prefixBias,
    temperature: settings.temperature,
    topP: settings.topP,
    rng,
    guidanceScale: useCfg ? settings.guidanceScale : 1.0,
    uncondPrefixTokens,
    uncondPrefixBias,
    sampleOnlyAfterPrefix: Boolean(transcriberStage.decode && transcriberStage.decode.sampleOnlyAfterPrefix),
    progressIntervalBeats: 4,
    onProgress: ({ tokens, committedBeats, totalBeats, done }) => {
      if (!onPartial || (committedBeats <= 0 && !done)) return;
      const { events, issues } = stream.decodeTokens(tokens);
      const filtered = done ? events : events.filter((e) => e.beat < committedBeats);
      const noteLines = stream.flattenNoteLines(stream.eventsToChartNotes(filtered, resolution));
      sequence += 1;
      onPartial({
        sequence,
        complete: done,
        done,
        committedBeats,
        totalBeats,
        tokenCount: tokens.length,
        eventCount: filtered.length,
        noteLineCount: noteLines.length,
        noteLines,
        decodeIssues: {
          orphanModifiers: issues.orphan_modifiers,
          orphanPositions: issues.orphan_positions,
          notesWithoutPosition: issues.notes_without_position,
          duplicatePositions: issues.duplicate_positions,
        },
        ...(sequence === 1 ? { timing: { resolution, syncLines: finalSyncLines, offset } } : {}),
      });
    },
    log,
  };
  let decodeResult;
  let forcedSolo = null;
  if (forceSolo) {
    ({ result: decodeResult, forcedSolo } = await generateWithForcedSolo(generateOptions, {
      structure,
      seed: settings.seed,
      log,
    }));
  } else {
    decodeResult = await generate(generateOptions);
  }
  const tokens = Array.from(decodeResult.tokens);
  if (log) log(`transcription: decoded ${tokens.length} tokens in ${decodeResult.stats.generationSeconds}s`);
  return {
    tokens,
    stats: decodeResult.stats,
    device: executionProvider,
    structure,
    forceSolo,
    forcedSolo,
    syncLines: finalSyncLines,
    nBeats,
    descNames,
    bins,
    descriptorTrained,
    useCfg,
    prefix: {
      cond: prefixTokens,
      uncond: uncondPrefixTokens,
      descPrefixScan,
      pervasiveDifficulty: Boolean(conditioning && conditioning.pervasiveDifficulty),
      pervasiveDescriptors: Boolean(conditioning && conditioning.pervasiveDescriptors),
    },
    featureBuild: { refDb, nFramesFinal, nBeats, maxBeats, channelOrder, beatMelShape },
  };
}

// Tokens -> .chart text on the transcription's tempo map.
export function chartFromTokens({ tokens, structure, nBeats, resolution, syncLines, offset = 0, metadata, difficulty }) {
  const { events, issues } = stream.decodeTokens(tokens);
  const rows = stream.eventsToChartNotes(events, resolution);
  const structureMarks = stream.decodeStructure(tokens, structure);
  const { trackEvents, globalEvents } = stream.structureChartLines(structureMarks, resolution, nBeats);
  const { text, noteLineCount } = stream.writeChartText(rows, {
    ...metadata,
    difficulty,
    resolution,
    syncLines,
    offset,
    globalEvents,
    trackEvents,
  });
  return { text, noteLineCount, events, issues, structureMarks };
}

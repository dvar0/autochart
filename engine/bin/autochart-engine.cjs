#!/usr/bin/env node
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");
const demucsWorkspaceSafety = require("../../electron/demucsWorkspace.cjs");
const { inspectVerifiedFile, readVerifiedFile, writeVerifiedAtomic } = require("../../electron/fileSafety.cjs");
const { createGenerationLifecycle, createResultPersistence, failureStageDetails } = require("../lib/generationStages.cjs");
const {
  chartBpms,
  chartKeyValue,
  chartResolution,
  parseChartSections,
  sourceChartBeatGrid,
  tickToSeconds,
} = require("../lib/chartTiming.cjs");
const { finishProcess } = require("../lib/finishProcess.cjs");

const ENGINE_ROOT = path.resolve(__dirname, "..");
// Single source of truth: read engineVersion from the manifest so the engine
// child and manifest.engineVersion can never drift. (was a hardcoded string)
const ENGINE_VERSION = (() => {
  try {
    return JSON.parse(fsSync.readFileSync(path.join(ENGINE_ROOT, "manifest.json"), "utf8")).engineVersion || "";
  } catch {
    return "";
  }
})();
const CURRENT_PLATFORM = process.platform;
const CURRENT_ARCH = process.arch;
const {
  isSupportedTarget,
  unsupportedTargetMessage: sharedUnsupportedTargetMessage,
} = require("../../config/supported-targets.cjs");
const DEFAULT_TRANSCRIBER_SETTINGS = {
  timingDetector: "beat_this_custom_timing",
  detector: "beat_this_custom_timing",
  timingRaw: true,
  bpmTolerance: 0,
  difficulty: "expert",
  temperature: 0.95,
  topP: 0.98,
  stripSustains: false,
  seed: 20260609,
  smoothing: {
    enabled: true,
    gain: 0.15,
    window: 9,
    bpmRound: 0.5,
  },
};
const DEFAULT_DEMUCS_ID = "demucs_default";
const DEMUCS_STEMS = ["other", "drums", "bass", "vocals"];
const SOURCE_CHART_DETECTOR = "source_chart";
const SOURCE_CHART_TIMING_DETECTOR = "source_chart_sync";
// Detected timing uses 192 ticks per beat; imported charts retain their resolution.
const CHART_OUTPUT_RESOLUTION = 192;
const DESCRIPTOR_KNOB_NAMES = ["speed", "chords", "technique", "movement", "repetition"];
const DESCRIPTOR_KNOB_MAX = 6;
const DEFAULT_GUIDANCE_SCALE = 2;
const ONNX_GENERATOR_ID = "autochart.fretformer.v1-onnx";

function emit(event) {
  process.stdout.write(`${JSON.stringify({ time: Date.now(), ...event })}\n`);
}

function shortStableKey(job) {
  if (job.audioSha256) return String(job.audioSha256);
  return crypto.createHash("sha1").update(String(job.audioPath || "audio")).digest("hex");
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function platformObject(value) {
  const object = plainObject(value);
  const current = plainObject(object[CURRENT_PLATFORM]);
  if (Object.keys(current).length) return current;
  return plainObject(object.default);
}

function platformValue(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "string") return value;
  const object = plainObject(value);
  return object[CURRENT_PLATFORM] ?? object.default ?? fallback;
}

function platformList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function supportsCurrentPlatform(generator) {
  const platforms = platformList(generator?.platforms);
  return isSupportedTarget(CURRENT_PLATFORM, CURRENT_ARCH) &&
    (platforms.length === 0 || platforms.includes(CURRENT_PLATFORM));
}

function textValue(value, fallback) {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function numberValue(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value == null || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function integerValue(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value == null || String(value).trim() === "") return fallback;
  const number = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function booleanValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function normalizeDifficulty(value, fallback = DEFAULT_TRANSCRIBER_SETTINGS.difficulty) {
  const text = String(value ?? "").trim().toLowerCase();
  return ["easy", "medium", "hard", "expert"].includes(text) ? text : fallback;
}

// Descriptor knobs: null/"auto" or integer bin 0..6 in resolved.knobs or controls.knobs.
function resolveDescriptorKnob(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (text === "" || text === "auto") return null;
  const num = Number.parseInt(text, 10);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(DESCRIPTOR_KNOB_MAX, Math.trunc(num)));
}

function resolveDescriptorKnobsFrom(generation) {
  const resolved = plainObject(generation.resolved);
  const controls = plainObject(generation.controls);
  const resolvedKnobs = plainObject(resolved.knobs);
  const controlKnobs = plainObject(controls.knobs);
  const knobs = {};
  for (const name of DESCRIPTOR_KNOB_NAMES) {
    knobs[name] = resolveDescriptorKnob(resolvedKnobs[name] ?? controlKnobs[name]);
  }
  return knobs;
}

function safeKeyPart(value) {
  return String(value ?? "")
    .replace(/[^a-zA-Z0-9_.-]+/g, "_")
    .replace(/\./g, "p");
}

function safeDemucsSlug(value, maxLen = 96) {
  const cleaned = String(value ?? "")
    .replace(/[^a-zA-Z0-9_. -]+/g, "_")
    .trim()
    .split(/\s+/)
    .join("_")
    .slice(0, maxLen)
    .replace(/^[._-]+|[._-]+$/g, "");
  return cleaned || "song";
}

function demucsCacheSlug(job) {
  const maxLen = CURRENT_PLATFORM === "win32" ? 32 : 96;
  return safeDemucsSlug(`audio_${job.audioSha256 || shortStableKey(job)}`, maxLen);
}

function timingCacheKey(settings) {
  const detector = safeKeyPart(settings.timingDetector || settings.detector || DEFAULT_TRANSCRIBER_SETTINGS.timingDetector);
  const bpm = safeKeyPart(settings.bpmTolerance ?? 0);
  const raw = settings.timingRaw ? "_rawdet" : "";
  return `${detector}${raw}_refiner_v1_bpm${bpm}`;
}

function transcriberTimingCacheKey(settings, sourceChartKey = "") {
  const scoped = sourceChartKey ? `${timingCacheKey(settings)}_src${safeKeyPart(sourceChartKey)}` : timingCacheKey(settings);
  if (!settings.smoothing?.enabled) return `${scoped}_rawgrid`;
  return [
    scoped,
    "smoothgrid",
    `g${safeKeyPart(settings.smoothing.gain)}`,
    `w${safeKeyPart(settings.smoothing.window)}`,
    `r${safeKeyPart(settings.smoothing.bpmRound)}`,
  ].join("_");
}
function unsupportedTargetMessage() {
  return sharedUnsupportedTargetMessage(CURRENT_PLATFORM, CURRENT_ARCH);
}

async function loadEngineManifest() {
  const manifestPath = path.join(ENGINE_ROOT, "manifest.json");
  return JSON.parse(await fs.readFile(manifestPath, "utf8"));
}

async function resolveGeneratorConfig(generatorId, job = null) {
  const passed = plainObject(job?.generator);
  if (passed && passed.id && (!generatorId || passed.id === generatorId)) {
    if (!supportsCurrentPlatform(passed)) {
      throw new Error(`${unsupportedTargetMessage()} Generator ${passed.id} is unavailable.`);
    }
    return passed;
  }
  const manifest = await loadEngineManifest();
  const generators = Array.isArray(manifest.generators) ? manifest.generators : [];
  const generator = generators.find((item) => item.id === generatorId);
  if (!generator) throw new Error(`Unsupported generatorId: ${generatorId}`);
  if (!supportsCurrentPlatform(generator)) {
    throw new Error(`${unsupportedTargetMessage()} Generator ${generatorId} is unavailable.`);
  }
  return generator;
}

function normalizeTranscriberSettings(job, generator) {
  const generation = plainObject(job.generation);
  const controls = plainObject(generation.controls);
  const resolved = plainObject(generation.resolved);
  const timing = plainObject(generator.timing);
  const smoothingDefaults = {
    ...DEFAULT_TRANSCRIBER_SETTINGS.smoothing,
    ...plainObject(timing.smoothing),
  };
  const smoothing = plainObject(resolved.timingSmoothing ?? job.timingSmoothing);
  const smoothingEnabled = smoothing.enabled ?? controls.timingSmoothing ?? job.timingSmoothingEnabled;
  const randomSeed = controls.seedMode === "random";
  const requestedTimingDetector = textValue(
    resolved.timingDetector ?? controls.timingDetector ?? job.timingDetector,
    DEFAULT_TRANSCRIBER_SETTINGS.timingDetector
  );
  const detectorIn = textValue(resolved.detector ?? timing.detector ?? job.detector, DEFAULT_TRANSCRIBER_SETTINGS.detector);
  const usesSourceChartTiming = requestedTimingDetector === SOURCE_CHART_TIMING_DETECTOR || detectorIn === SOURCE_CHART_DETECTOR;
  const detector = usesSourceChartTiming ? SOURCE_CHART_DETECTOR : detectorIn;
  const timingRaw = booleanValue(
    usesSourceChartTiming ? false : resolved.timingRaw ?? job.timingRaw ?? timing.raw,
    DEFAULT_TRANSCRIBER_SETTINGS.timingRaw
  );
  const seed = integerValue(
    resolved.seed ?? controls.seed ?? job.seed,
    randomSeed ? crypto.randomInt(1, 2 ** 31 - 1) : DEFAULT_TRANSCRIBER_SETTINGS.seed,
    { min: 0, max: 2 ** 31 - 2 }
  );

  const knobs = resolveDescriptorKnobsFrom(generation);
  const knobsActive = DESCRIPTOR_KNOB_NAMES.some((name) => knobs[name] != null);
  const guidanceScale = numberValue(
    resolved.guidanceScale ?? controls.guidanceScale ?? job.guidanceScale,
    DEFAULT_GUIDANCE_SCALE,
    { min: 1, max: 8 }
  );

  return {
    timingDetector: usesSourceChartTiming
      ? SOURCE_CHART_TIMING_DETECTOR
      : textValue(
          requestedTimingDetector,
          timingRaw && detector === "beat_this_custom_timing" ? "beat_this_custom_timing" : DEFAULT_TRANSCRIBER_SETTINGS.timingDetector
        ),
    detector,
    timingRaw,
    bpmTolerance: numberValue(
      resolved.bpmTolerance ?? timing.bpmTolerance ?? job.bpmTolerance,
      DEFAULT_TRANSCRIBER_SETTINGS.bpmTolerance,
      { min: 0 }
    ),
    difficulty: normalizeDifficulty(resolved.difficulty ?? controls.difficulty ?? job.difficulty),
    temperature: numberValue(
      resolved.temperature ?? controls.temperature ?? job.temperature,
      DEFAULT_TRANSCRIBER_SETTINGS.temperature,
      { min: 0.05, max: 2 }
    ),
    topP: numberValue(resolved.topP ?? controls.topP ?? job.topP, DEFAULT_TRANSCRIBER_SETTINGS.topP, {
      min: 0.01,
      max: 1,
    }),
    stripSustains: booleanValue(
      resolved.stripSustains ?? controls.stripSustains ?? job.stripSustains,
      DEFAULT_TRANSCRIBER_SETTINGS.stripSustains
    ),
    seed,
    smoothing: {
      enabled: usesSourceChartTiming ? false : booleanValue(smoothingEnabled, smoothingDefaults.enabled),
      gain: numberValue(smoothing.gain, smoothingDefaults.gain, { min: 0, max: 1 }),
      window: integerValue(smoothing.window, smoothingDefaults.window, { min: 1 }),
      bpmRound: numberValue(smoothing.bpmRound, smoothingDefaults.bpmRound, { min: 0.001 }),
    },
    knobs,
    knobsActive,
    guidanceScale,
  };
}

function effectiveTranscriberGeneration(job, settings) {
  const generation = plainObject(job.generation);
  const controls = plainObject(generation.controls);
  const fixedSeed = controls.seedMode !== "random";
  return {
    generatorId: job.generatorId,
    presetId: textValue(generation.presetId, "standard"),
    presetName: textValue(generation.presetName, "Standard"),
    modified: Boolean(generation.modified),
    controls: {
      difficulty: settings.difficulty,
      temperature: settings.temperature,
      topP: settings.topP,
      timingDetector: settings.timingDetector,
      timingSmoothing: settings.smoothing.enabled,
      seedMode: fixedSeed ? "fixed" : "random",
      seed: fixedSeed ? settings.seed : null,
      stripSustains: settings.stripSustains,
      knobs: settings.knobs,
      guidanceScale: settings.guidanceScale,
    },
    resolved: {
      ...(plainObject(generation.resolved)),
      difficulty: settings.difficulty,
      temperature: settings.temperature,
      topP: settings.topP,
      stripSustains: settings.stripSustains,
      detector: settings.detector,
      timingDetector: settings.timingDetector,
      timingRaw: settings.timingRaw,
      bpmTolerance: settings.bpmTolerance,
      seed: settings.seed,
      timingSmoothing: settings.smoothing,
      knobs: settings.knobs,
      guidanceScale: settings.guidanceScale,
    },
  };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfExists(filePath) {
  try {
    const read = await readVerifiedFile(filePath, { label: "Engine cache JSON", maxBytes: 64 * 1024 * 1024 });
    return JSON.parse(read.data.toString("utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function copyFileIfExists(source, destination) {
  if (!(await exists(source))) return false;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
  return true;
}

async function assertFileExists(filePath, label) {
  if (!(await exists(filePath))) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

async function demucsStemMap(cacheDir, stemDir) {
  if (!stemDir) return {};
  const canonicalStemDir = await demucsWorkspaceSafety.ensureContainedDirectory(
    cacheDir,
    stemDir,
    { create: false }
  );
  const stems = {};
  for (const stem of DEMUCS_STEMS) {
    for (const ext of ["flac", "wav"]) {
      const stemPath = path.join(canonicalStemDir, `${stem}.${ext}`);
      try {
        const read = await inspectVerifiedFile(stemPath, {
          label: `Demucs ${stem} stem`,
        });
        stems[stem] = {
          path: read.path,
          identity: read.identity,
          format: ext,
          mime: ext === "flac" ? "audio/flac" : "audio/wav",
        };
        break;
      } catch (err) {
        if (err?.code !== "ENOENT") {
          // Unsafe or replaced leaves are cache misses, never trusted inputs.
        }
      }
    }
  }
  return stems;
}

async function chartTimingStats(chartPath) {
  if (!(await exists(chartPath))) return null;
  const text = await fs.readFile(chartPath, "utf8");
  const sections = parseChartSections(text);
  const noteSectionName = sections.ExpertSingle
    ? "ExpertSingle"
    : Object.keys(sections).find((name) => /Single$/.test(name));
  const noteLines = noteSectionName ? sections[noteSectionName] || [] : [];
  const playableTicks = new Set();
  for (const line of noteLines) {
    const kv = chartKeyValue(line);
    if (!kv) continue;
    const parts = kv.value.split(/\s+/);
    if (parts[0] !== "N") continue;
    const fret = Number(parts[1]);
    if ((fret >= 0 && fret <= 4) || fret === 7) playableTicks.add(Number(kv.key));
  }
  const firstNoteTick = [...playableTicks]
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  const resolution = chartResolution(sections.Song);
  const bpms = chartBpms(sections.SyncTrack);
  return {
    noteCount: playableTicks.size,
    firstNoteTick: firstNoteTick ?? null,
    firstNoteSeconds: firstNoteTick == null ? null : tickToSeconds(firstNoteTick, bpms, resolution),
    resolution,
    firstTempoBpm: bpms[0]?.bpm ?? null,
  };
}

function failedEngineResult(job, jobPath, error, failedStage = "audio") {
  const message = String(error && error.message || error);
  return {
    schemaVersion: 1,
    jobId: job.jobId,
    status: "failed",
    error: message,
    failedStage,
    generatorId: job.generatorId || null,
    generatorLabel: job.generatorLabel || null,
    engineVersion: job.engineVersion || ENGINE_VERSION,
    outputDir: path.resolve(job.outputDir),
    chartPath: null,
    reportPath: null,
    logPath: path.join(path.resolve(job.outputDir), "engine.log"),
    provenance: {
      kind: "autochart-engine-onnx",
      jobPath,
      generatorId: job.generatorId || null,
      generatorLabel: job.generatorLabel || null,
      engineVersion: job.engineVersion || ENGINE_VERSION,
      runtime: {
        platform: CURRENT_PLATFORM,
        backend: "onnxruntime-node",
        executionProvider: null,
        requestedDevice: String(job.requestedHardwareMode || job.hardwareMode || "auto"),
        notRunStages: ["audio", "demucs", "timing", "smoothing", "transcription", "chart"],
      },
      error: message,
    },
    createdAt: Date.now(),
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!["generate", "prepare-demucs"].includes(command)) {
    throw new Error("Usage: autochart-engine <generate|prepare-demucs> --job <job.json>");
  }
  const jobIndex = args.indexOf("--job");
  if (jobIndex === -1 || !args[jobIndex + 1]) {
    throw new Error("Missing --job <job.json>");
  }
  const jobPath = path.resolve(args[jobIndex + 1]);
  const job = JSON.parse(await fs.readFile(jobPath, "utf8"));
  emit({ type: "stage", stage: "queued", status: "completed", jobId: job.jobId });

  const onnxLib = require("../lib/onnx");
  if (typeof onnxLib.setRuntimeFallbackCallback === "function") {
    onnxLib.setRuntimeFallbackCallback(({ from, reason }) => {
      emit({ type: "runtime_fallback", from, to: "cpu", reason });
    });
  }

  const lifecycle = createGenerationLifecycle({ emit });
  let result;
  try {
    result = command === "prepare-demucs"
      ? await prepareDemucsOnnx(job, jobPath, { lifecycle })
      : await generateOnnx(job, jobPath, { lifecycle });
  } catch (error) {
    const failedStage = lifecycle.stage;
    lifecycle.fail(error, failedStage);
    result = failedEngineResult(job, jobPath, error, failedStage);
  }

  const outputDir = path.resolve(job.outputDir);
  const resultPath = path.join(outputDir, "result.json");
  const persistence = createResultPersistence((value) =>
    writeVerifiedAtomic(
      resultPath,
      `${JSON.stringify(value, null, 2)}\n`,
      { rootDirectory: outputDir, label: "Generation result" }
    )
  );
  try {
    await lifecycle.finalize(result, (value) => persistence.persist(value), resultPath);
  } catch (error) {
    process.exitCode = 1;
    throw error;
  }
  return result;
}

async function onnxSeparate(job, jobPath, { command }) {
  const onnxLib = require("../lib/onnx");
  const manifest = await onnxLib.loadModelsManifest(ENGINE_ROOT, job);
  const orch = onnxLib.demucsOrchestration(manifest);
  const requestedDevice = await onnxLib.resolveDevice(
    resolveOnnxDevice(job), onnxLib.graphPath(manifest, "demucs-analysis-stft")
  );

  const outputDir = path.resolve(job.outputDir);
  const cacheDir = path.resolve(job.cacheDir);
  if (!job.demucsWorkspace) throw new Error("Electron did not provide a Demucs workspace.");
  const workspace = await demucsWorkspaceSafety.ensureContainedDirectory(
    cacheDir,
    path.resolve(String(job.demucsWorkspace))
  );
  const cacheSlug = demucsCacheSlug(job);
  const stemDir = await demucsWorkspaceSafety.ensureContainedDirectory(
    cacheDir,
    path.join(workspace, "stems", cacheSlug)
  );
  const prepareResultPath = path.join(outputDir, "demucs_prepare.json");
  const logPath = path.join(outputDir, "engine.log");

  await fs.mkdir(outputDir, { recursive: true });
  await demucsWorkspaceSafety.ensureContainedDirectory(cacheDir, workspace, { create: false });
  await demucsWorkspaceSafety.ensureContainedDirectory(cacheDir, stemDir, { create: false });
  emit({ type: "log", stage: "demucs", stream: "stdout", message: `demucs: sessions requested on ${requestedDevice}` });

  const sourceSeparation = {
    id: job.demucsSeparation?.id || DEFAULT_DEMUCS_ID,
    name: job.demucsSeparation?.name || "Default separation",
    profile: job.demucsSeparation?.profile || "Standard Demucs (ONNX htdemucs)",
    sourceTransform: job.sourceTransform || job.demucsSeparation?.sourceTransform || null,
    sourceVariantKey: job.sourceTransform?.key || job.demucsSeparation?.sourceVariantKey || "lead-in:0",
  };

  if (!job.forceDemucs) {
    const cachedStems = await demucsStemMap(cacheDir, stemDir);
    if (orch.sources.every((name) => cachedStems[name])) {
      const prepareOutput = {
        detail: "cached",
        demucsRan: false,
        featuresWritten: false,
        stems: cachedStems,
        executionProvider: null,
        cacheHit: true,
        requestedDevice,
        cache: { workspace, stemDir, featurePath: null, featureMetaPath: null },
      };
      await writeVerifiedAtomic(
        prepareResultPath,
        `${JSON.stringify(prepareOutput, null, 2)}\n`,
        { rootDirectory: outputDir, label: "Demucs preparation metadata" }
      );
      emit({
        type: "stage",
        stage: "demucs",
        status: "completed",
        cache: "hit",
        backend: "onnxruntime-node",
        cacheHit: true,
        requestedDevice,
      });
      return { ...prepareOutput, stemArrays: {} };
    }
  }

  emit({
    type: "stage",
    stage: "demucs",
    status: "running",
    backend: "onnxruntime-node",
    requestedDevice,
  });
  emit({
    type: "log",
    stage: "demucs",
    stream: "stdout",
    message: `ONNX Demucs: requestedDevice=${requestedDevice} segment=${orch.segmentLength} overlap=${orch.overlap} stems=${orch.sources.join(",")}`,
  });

  const audioPath = path.resolve(job.audioPath);
  await assertFileExists(audioPath, "Audio for ONNX Demucs");

  emit({ type: "log", stage: "demucs", stream: "stdout", message: `decoding ${audioPath} -> ${orch.sampleRate}Hz stereo` });
  const decoded = await onnxLib.decodeStereoF32(audioPath, { sampleRate: orch.sampleRate });
  if (decoded.channels !== orch.audioChannels) {
    throw new Error(`ONNX Demucs requires ${orch.audioChannels}-channel audio; got ${decoded.channels}`);
  }
  const length = decoded.length;
  emit({ type: "log", stage: "demucs", stream: "stdout", message: `decoded ${length} samples (${(length / orch.sampleRate).toFixed(1)}s)` });

  const sessions = await onnxLib.loadDemucsSessions(manifest, requestedDevice);
  const executionProvider = sessions.device || requestedDevice;
  emit({
    type: "stage",
    stage: "demucs",
    status: "running",
    backend: "onnxruntime-node",
    device: executionProvider,
    requestedDevice,
  });
  const planar = new Float32Array(2 * length);
  planar.set(decoded.left, 0);
  planar.set(decoded.right, length);
  emit({ type: "log", stage: "demucs", stream: "stdout", message: `running ${orch.sources.length}-stem separation` });

  const stems = await onnxLib.separate(planar, length, sessions, orch, {
    log: (m) => emit({ type: "log", stage: "demucs", stream: "stdout", message: m }),
    onProgress: ({ index, total, offset, chunkLength }) => {
      emit({
        type: "log",
        stage: "demucs",
        stream: "stdout",
        message: `segment ${index}/${total} offset=${offset} chunk=${chunkLength}`,
      });
      emit({ type: "stage", stage: "demucs", status: "running", progress: total ? index / total : 0 });
    },
  });

  const stemsMap = {};
  const stemArrays = {};
  for (const stem of stems) {
    const outPath = path.join(stemDir, `${stem.name}.wav`);
    await demucsWorkspaceSafety.ensureContainedDirectory(cacheDir, stemDir, { create: false });
    await demucsWorkspaceSafety.assertSafeLeaf(stemDir, outPath);
    await onnxLib.writeStereoWav(outPath, stem.left, stem.right, orch.sampleRate, { bits: 32, rootDirectory: cacheDir });
    const writtenStem = await readVerifiedFile(outPath, { label: `Demucs ${stem.name} stem` });
    stemsMap[stem.name] = { path: outPath, identity: writtenStem.identity, format: "wav", mime: "audio/wav" };
    stemArrays[stem.name] = { left: stem.left, right: stem.right, sampleRate: orch.sampleRate };
  }

  const prepareOutput = {
    detail: "onnx-runtime",
    demucsRan: true,
    featuresWritten: false,
    stems: stemsMap,
    executionProvider,
    requestedDevice,
    cache: {
      workspace,
      stemDir,
      featurePath: null,
      featureMetaPath: null,
    },
  };
  await writeVerifiedAtomic(
    prepareResultPath,
    `${JSON.stringify(prepareOutput, null, 2)}\n`,
    { rootDirectory: outputDir, label: "Demucs preparation metadata" }
  );

  emit({
    type: "stage",
    stage: "demucs",
    status: "completed",
    backend: "onnxruntime-node",
    device: executionProvider,
    requestedDevice,
  });
  return { ...prepareOutput, stemArrays };
}

async function prepareDemucsOnnx(job, jobPath, { lifecycle = createGenerationLifecycle({ emit }) } = {}) {
  const generator = await resolveGeneratorConfig(job.generatorId, job);
  const outputDir = path.resolve(job.outputDir);
  if (!job.demucsWorkspace) throw new Error("Electron did not provide a Demucs workspace.");
  const workspace = await demucsWorkspaceSafety.ensureContainedDirectory(
    path.resolve(job.cacheDir),
    path.resolve(job.demucsWorkspace),
    { create: false }
  );
  const logPath = path.join(outputDir, "engine.log");
  const prepared = await lifecycle.runStage("demucs", () =>
    onnxSeparate(job, jobPath, { command: "prepare-demucs" })
  );
  const device = prepared.executionProvider ?? null;

  const sourceSeparation = {
    id: job.demucsSeparation?.id || DEFAULT_DEMUCS_ID,
    name: job.demucsSeparation?.name || "Default separation",
    profile: job.demucsSeparation?.profile || "Standard Demucs (ONNX htdemucs)",
    sourceTransform: job.sourceTransform || job.demucsSeparation?.sourceTransform || null,
    sourceVariantKey: job.sourceTransform?.key || job.demucsSeparation?.sourceVariantKey || "lead-in:0",
  };

  const result = {
    schemaVersion: 1,
    jobId: job.jobId,
    status: "completed",
    generatorId: job.generatorId,
    generatorLabel: generator.label,
    engineVersion: job.engineVersion || ENGINE_VERSION,
    outputDir,
    logPath,
    audioSha256: job.audioSha256 || null,
    originalAudioSha256: job.originalAudioSha256 || job.audioSha256 || null,
    sourceTransform: job.sourceTransform || null,
    id: sourceSeparation.id,
    name: sourceSeparation.name,
    profile: sourceSeparation.profile,
    sourceSeparation,
    provenance: {
      kind: "autochart-demucs-onnx",
      jobPath,
      generatorId: job.generatorId,
      generatorLabel: generator.label,
      engineVersion: job.engineVersion || ENGINE_VERSION,
      runtime: {
        platform: CURRENT_PLATFORM,
        backend: "onnxruntime-node",
        executionProvider: device,
        requestedDevice: String(prepared.requestedDevice || job.requestedHardwareMode || job.hardwareMode || job.demucsDevice || "auto"),
        devices: { demucs: device },
      },
      demucs: {
        model: "htdemucs",
        backend: "onnx",
        segment_samples: 343980,
        overlap: 0.25,
        format: "wav",
      },
      sourceSeparation,
      sourceTransform: job.sourceTransform || null,
    },
    stems: prepared.stems || {},
    cache: {
      cacheDir: path.resolve(job.cacheDir),
      workspace,
      ...(prepared.cache || {}),
    },
    metrics: {
      demucsRan: Boolean(prepared.demucsRan),
      featuresWritten: Boolean(prepared.featuresWritten),
      detail: prepared.detail || null,
    },
    createdAt: Date.now(),
  };
  return result;
}

// The source chart lives at <jobDir>/source_chart/notes.chart, written by
// Electron when a run asks for imported chart sync.
async function resolveSourceChartPath(job, jobPath) {
  const provided = String(job.sourceChart?.path || job.sourceChartPath || "").trim();
  if (!provided) {
    throw new Error("Imported chart sync was selected, but no source notes.chart was provided.");
  }
  const jobDir = path.dirname(path.resolve(jobPath));
  const sourceDir = await demucsWorkspaceSafety.ensureContainedDirectory(
    jobDir,
    path.dirname(path.resolve(provided)),
    { create: false }
  );
  return demucsWorkspaceSafety.assertSafeLeaf(
    sourceDir,
    path.join(sourceDir, path.basename(provided)),
    { allowMissing: false }
  );
}

async function loadSourceChart(job, jobPath) {
  const chartPath = await resolveSourceChartPath(job, jobPath);
  const chartFile = await readVerifiedFile(chartPath, {
    label: "Imported source chart",
    maxBytes: 64 * 1024 * 1024,
  });
  const expectedSha256 = String(job.sourceChart?.sha256 || "").trim().toLowerCase();
  if (expectedSha256 && chartFile.sha256 !== expectedSha256) {
    throw new Error("The imported notes.chart changed after this generation was queued.");
  }
  return { chartPath, chartFile };
}

// Timing straight from the imported chart: no beat model runs, and both the beat
// grid and the emitted tempo map come from the human-authored [SyncTrack].
async function beatsFromSourceChart(job, jobPath, { onnxLib, cacheDir, timingDir, beatsJsonPath, timingMode, sourceChart }) {
  const audioPath = path.resolve(job.audioPath);
  await assertFileExists(audioPath, "Audio for imported chart sync");
  const { chartPath, chartFile } = sourceChart;
  emit({
    type: "stage",
    stage: "timing",
    status: "running",
    backend: "source-chart",
    detector: SOURCE_CHART_DETECTOR,
  });
  emit({ type: "log", stage: "timing", stream: "stdout", message: `timing: reading [SyncTrack] from ${chartPath}` });
  const audioDuration = await onnxLib.decodeDurationSeconds(audioPath);
  const grid = sourceChartBeatGrid(chartFile.data.toString("utf8"), {
    audioDuration,
  });
  const beatTimes = Float64Array.from(grid.beatTimes);
  const beats = {
    beatTimes,
    downbeatTimes: Float64Array.from(grid.downbeatTimes),
    rawBeatTimes: beatTimes,
    smoothedBeatTimes: new Float64Array(0),
    nLeadIn: 0,
    tempoBpm: onnxLib.medianBpm(beatTimes),
    timingMode,
    detector: SOURCE_CHART_DETECTOR,
    syncLines: grid.syncLines,
    resolution: grid.resolution,
    offset: grid.offset,
  };
  emit({
    type: "log",
    stage: "timing",
    stream: "stdout",
    message: `beat: imported chart sync grid (${beats.beatTimes.length} beats, ${beats.downbeatTimes.length} downbeats, tempo≈${beats.tempoBpm.toFixed(2)} bpm over ${audioDuration.toFixed(1)}s)`,
  });

  const payload = {
    schemaVersion: 1,
    detector: SOURCE_CHART_DETECTOR,
    resolution: grid.resolution,
    offset: grid.offset,
    beatTimes: Array.from(beats.beatTimes),
    downbeatTimes: Array.from(beats.downbeatTimes),
    rawBeatTimes: Array.from(beats.rawBeatTimes),
    smoothedBeatTimes: [],
    syncLines: beats.syncLines,
    nLeadIn: 0,
    tempoBpm: beats.tempoBpm,
    timingMode,
    timingSmoothing: { enabled: false },
    audioPath,
    audioDuration,
    audioSha256: job.audioSha256 || null,
    sourceChart: {
      path: chartPath,
      sha256: chartFile.sha256,
      versionId: textValue(job.sourceChart?.versionId, ""),
      name: textValue(job.sourceChart?.name, ""),
    },
    createdAt: Date.now(),
  };
  await writeVerifiedAtomic(
    beatsJsonPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    { rootDirectory: cacheDir, label: "Demucs timing cache" }
  );

  emit({
    type: "stage",
    stage: "timing",
    status: "completed",
    backend: "source-chart",
    detector: SOURCE_CHART_DETECTOR,
    beats: beats.beatTimes.length,
    downbeats: beats.downbeatTimes.length,
    nLeadIn: 0,
    tempoBpm: beats.tempoBpm,
    timingMode,
    smoothing: false,
    path: beatsJsonPath,
  });

  return { beats, beatsJsonPath, timingDir, executionProvider: null, requestedDevice: null };
}

async function onnxDetectBeats(job, jobPath, opts = {}) {
  const onnxLib = require("../lib/onnx");
  const generator = opts.generator || await resolveGeneratorConfig(job.generatorId, job);
  const settings = opts.settings || normalizeTranscriberSettings(job, generator);
  // Imported chart sync runs no beat model, so it needs no device.
  const usesSourceChartTiming = settings.detector === SOURCE_CHART_DETECTOR;
  const manifest = usesSourceChartTiming ? null : await onnxLib.loadModelsManifest(ENGINE_ROOT, job);
  const orch = usesSourceChartTiming ? null : onnxLib.beatOrchestration(manifest);
  const requestedDevice = usesSourceChartTiming
    ? null
    : await onnxLib.resolveDevice(resolveOnnxDevice(job), onnxLib.graphPath(manifest, "beat-mel"));
  const smoothingEnabled = Boolean(settings.smoothing?.enabled);
  const timingMode = usesSourceChartTiming ? "source-chart" : smoothingEnabled ? "smoothed" : "raw";

  const outputDir = path.resolve(job.outputDir);
  if (!job.demucsWorkspace) throw new Error("Electron did not provide a Demucs workspace.");
  const cacheDir = path.resolve(job.cacheDir);
  const workspace = await demucsWorkspaceSafety.ensureContainedDirectory(
    cacheDir,
    path.resolve(job.demucsWorkspace),
    { create: false }
  );
  // Two source charts over the same audio must not share a timing cache entry.
  const sourceChart = usesSourceChartTiming ? await loadSourceChart(job, jobPath) : null;
  const sourceChartKey = sourceChart ? `v2_${sourceChart.chartFile.sha256}` : "";
  const timingDir = await demucsWorkspaceSafety.ensureContainedDirectory(
    cacheDir,
    path.join(workspace, "timing", transcriberTimingCacheKey(settings, sourceChartKey))
  );
  const beatsJsonPath = path.join(timingDir, "beats.json");
  const logPath = path.join(outputDir, "engine.log");

  await demucsWorkspaceSafety.ensureContainedDirectory(cacheDir, timingDir, { create: false });
  if (!usesSourceChartTiming) {
    emit({ type: "log", stage: "timing", stream: "stdout", message: `timing: sessions requested on ${requestedDevice}` });
  }
  if (!job.forceBeats && !job.forceDemucs) {
    await demucsWorkspaceSafety.ensureContainedDirectory(cacheDir, timingDir, { create: false });
    const cached = await readJsonIfExists(beatsJsonPath);
    const cachedSyncLines = Array.isArray(cached?.syncLines) && cached.syncLines.length ? cached.syncLines : null;
    if (
      cached && Array.isArray(cached.beatTimes) && cached.beatTimes.length && Array.isArray(cached.downbeatTimes) &&
      (!usesSourceChartTiming || cachedSyncLines)
    ) {
      const beats = {
        beatTimes: cached.beatTimes,
        downbeatTimes: cached.downbeatTimes,
        rawBeatTimes: Array.isArray(cached.rawBeatTimes) ? cached.rawBeatTimes : cached.beatTimes,
        smoothedBeatTimes: Array.isArray(cached.smoothedBeatTimes) ? cached.smoothedBeatTimes : (smoothingEnabled ? cached.beatTimes : []),
        nLeadIn: cached.nLeadIn,
        tempoBpm: cached.tempoBpm,
        timingMode: cached.timingMode || timingMode,
        detector: cached.detector || (usesSourceChartTiming ? SOURCE_CHART_DETECTOR : "beat_this_ft_v4_onnx"),
        syncLines: cachedSyncLines,
        resolution: cached.resolution,
        offset: cached.offset,
      };
      emit({
        type: "stage",
        stage: "timing",
        status: "completed",
        cache: "hit",
        backend: usesSourceChartTiming ? "source-chart" : "onnxruntime-node",
        cacheHit: true,
        requestedDevice,
        beats: beats.beatTimes.length,
        downbeats: beats.downbeatTimes.length,
        nLeadIn: beats.nLeadIn,
        tempoBpm: beats.tempoBpm,
        timingMode: beats.timingMode,
        smoothing: smoothingEnabled,
        path: beatsJsonPath,
      });
      if (smoothingEnabled) {
        emit({ type: "stage", stage: "smoothing", status: "completed", cache: "hit", backend: "onnxruntime-node" });
      }
      emit({ type: "log", stage: "timing", stream: "stdout", message: `reusing cached beats in ${beatsJsonPath}` });
      return { beats, beatsJsonPath, timingDir, executionProvider: null, cacheHit: true, requestedDevice };
    }
  }

  if (usesSourceChartTiming) {
    return beatsFromSourceChart(job, jobPath, { onnxLib, cacheDir, timingDir, beatsJsonPath, timingMode, sourceChart });
  }

  emit({
    type: "stage",
    stage: "timing",
    status: "running",
    backend: "onnxruntime-node",
    detector: "beat_this_ft_v4",
    requestedDevice,
    smoothing: smoothingEnabled,
  });
  const audioPath = path.resolve(job.audioPath);
  await assertFileExists(audioPath, "Audio for ONNX beat detection");
  emit({ type: "log", stage: "timing", stream: "stdout", message: `decoding ${audioPath} -> ${orch.sampleRate}Hz mono (requestedDevice=${requestedDevice})` });
  const mono = await onnxLib.decodeMono(audioPath, { sampleRate: orch.sampleRate });
  emit({ type: "log", stage: "timing", stream: "stdout", message: `decoded ${mono.length} samples (${(mono.length / orch.sampleRate).toFixed(1)}s)` });

  const beatSessions = await onnxLib.loadBeatSessions(manifest, requestedDevice);
  const executionProvider = beatSessions.device || requestedDevice;
  emit({
    type: "stage",
    stage: "timing",
    status: "running",
    backend: "onnxruntime-node",
    detector: "beat_this_ft_v4",
    device: executionProvider,
    requestedDevice,
    smoothing: smoothingEnabled,
  });
  const detected = await onnxLib.detectBeats(mono, manifest, beatSessions, orch, {
    log: (m) => emit({ type: "log", stage: "timing", stream: "stdout", message: m }),
    smooth: smoothingEnabled,
    onSmoothingStart: () => opts.lifecycle?.enter("smoothing"),
    onSmoothingError: (error) => opts.lifecycle?.fail(error, "smoothing"),
  });
  const activeBeatTimes = smoothingEnabled ? detected.beatTimes : detected.rawBeatTimes;
  const beats = {
    beatTimes: Float64Array.from(activeBeatTimes),
    downbeatTimes: Float64Array.from(detected.downbeatTimes),
    rawBeatTimes: Float64Array.from(detected.rawBeatTimes),
    smoothedBeatTimes: smoothingEnabled ? Float64Array.from(detected.beatTimes) : new Float64Array(0),
    nLeadIn: smoothingEnabled ? detected.nLeadIn : 0,
    tempoBpm: onnxLib.medianBpm(activeBeatTimes),
    timingMode,
    detector: "beat_this_ft_v4_onnx",
    syncLines: null,
  };
  emit({
    type: "log",
    stage: "timing",
    stream: "stdout",
    message: `beat: using ${timingMode} timing grid (${beats.beatTimes.length} beats)`,
  });

  const payload = {
    schemaVersion: 1,
    detector: "beat_this_ft_v4_onnx",
    sampleRate: orch.sampleRate,
    fps: orch.fps,
    chunkSize: orch.chunkSize,
    borderSize: orch.borderSize,
    overlapMode: orch.overlapMode,
    beatTimes: Array.from(beats.beatTimes),
    downbeatTimes: Array.from(beats.downbeatTimes),
    rawBeatTimes: Array.from(beats.rawBeatTimes),
    smoothedBeatTimes: Array.from(beats.smoothedBeatTimes),
    nLeadIn: beats.nLeadIn,
    tempoBpm: beats.tempoBpm,
    timingMode,
    timingSmoothing: settings.smoothing,
    audioPath,
    audioSha256: job.audioSha256 || null,
    createdAt: Date.now(),
  };
  await writeVerifiedAtomic(
    beatsJsonPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    { rootDirectory: cacheDir, label: "Demucs timing cache" }
  );

  emit({
    type: "stage",
    stage: "timing",
    status: "completed",
    backend: "onnxruntime-node",
    device: executionProvider,
    requestedDevice,
    beats: beats.beatTimes.length,
    downbeats: beats.downbeatTimes.length,
    nLeadIn: beats.nLeadIn,
    tempoBpm: beats.tempoBpm,
    timingMode,
    smoothing: smoothingEnabled,
    path: beatsJsonPath,
  });
  if (smoothingEnabled) {
    emit({ type: "stage", stage: "smoothing", status: "completed", backend: "onnxruntime-node", device: executionProvider });
  }

  return { beats, beatsJsonPath, timingDir, executionProvider, requestedDevice };
}

async function generateOnnx(job, jobPath, { lifecycle = createGenerationLifecycle({ emit }) } = {}) {
  const generator = await resolveGeneratorConfig(job.generatorId, job);
  const onnxLib = require("../lib/onnx");
  const outputDir = path.resolve(job.outputDir);
  const logPath = path.join(outputDir, "engine.log");
  let transcriberExecutionProvider = null;
  const device = resolveOnnxDevice(job);
  const settings = normalizeTranscriberSettings(job, generator);
  let demucsStage = null;
  let beatStage = null;
  let activeGenerationStage = "audio";
  const audioPath = path.resolve(job.audioPath);
  try {
    await lifecycle.runStage("audio", async () => {
      emit({ type: "stage", stage: "audio", status: "running", backend: "onnxruntime-node", device });
      await assertFileExists(audioPath, "Audio for ONNX generator");
      emit({ type: "stage", stage: "audio", status: "completed", backend: "onnxruntime-node", device });
    });
    activeGenerationStage = "demucs";
    demucsStage = await lifecycle.runStage("demucs", () =>
      onnxSeparate(job, jobPath, { command: "generate" })
    );
    activeGenerationStage = "timing";
    beatStage = await lifecycle.runStage("timing", () =>
      onnxDetectBeats(job, jobPath, { command: "generate", generator, settings, lifecycle })
    );
    const timingOutputPath = path.join(outputDir, "timing.json");
    const timingRead = await readVerifiedFile(beatStage.beatsJsonPath, {
      label: "Demucs timing cache",
      maxBytes: 64 * 1024 * 1024,
    });
    await writeVerifiedAtomic(timingOutputPath, timingRead.data, {
      rootDirectory: outputDir,
      label: "Generated timing cache",
    });
    beatStage = { ...beatStage, timingOutputPath };
    activeGenerationStage = "transcription";
    const transcriptionResult = await lifecycle.runStage("transcription", async () => {
    const manifest = await onnxLib.loadModelsManifest(ENGINE_ROOT, job);
    const transcriberRuntime = await resolveOnnxTranscriberDevice(job, onnxLib, manifest, device);
    const transcriberDevice = transcriberRuntime.device;
    emit({
      type: "log",
      stage: "transcription",
      stream: "stdout",
      message: `transcription: sessions requested on ${transcriberDevice}${transcriberRuntime.note ? ` (${transcriberRuntime.note})` : ""}`,
    });
    emit({
      type: "stage",
      stage: "transcription",
      status: "running",
      backend: "onnxruntime-node",
      requestedDevice: transcriberDevice,
    });
    const transcriberStage = manifest.stages && manifest.stages.transcriber ? manifest.stages.transcriber : {};
    const modelConfig = (transcriberStage && transcriberStage.modelConfig) || {};
    const maxBeats = Number(modelConfig.maxBeats || 1280);
    const decoderSettings = {
      difficulty: settings.difficulty,
      temperature: settings.temperature,
      topP: settings.topP,
      seed: settings.seed,
      guidanceScale: settings.guidanceScale,
      knobs: settings.knobs,
      knobsActive: settings.knobsActive,
      descriptorTrained: Boolean(transcriberStage && transcriberStage.prefixConditioning),
    };

    emit({ type: "log", stage: "transcription", stream: "stdout", message: `transcription: decoding 5 channels to mono 22050` });
    const melSession = await onnxLib.loadMelSession(manifest, transcriberDevice);
    transcriberExecutionProvider = onnxLib.sessionDevice
      ? onnxLib.sessionDevice(melSession, transcriberDevice)
      : transcriberDevice;
    emit({
      type: "stage",
      stage: "transcription",
      status: "running",
      backend: "onnxruntime-node",
      device: transcriberExecutionProvider,
      requestedDevice: transcriberDevice,
    });
    const fullStereo = await onnxLib.decodeStereoF32(audioPath, { sampleRate: 22050 });
    const fullMono = new Float32Array(fullStereo.length);
    for (let i = 0; i < fullStereo.length; i += 1) fullMono[i] = 0.5 * (fullStereo.left[i] + fullStereo.right[i]);
    const audioDuration = fullStereo.length / 22050;
    const stemMonos = {};
    for (const name of ["drums", "bass", "vocals", "other"]) {
      const stemPathObj = demucsStage.stems && demucsStage.stems[name];
      if (!stemPathObj || !stemPathObj.path) {
        throw new Error(`transcription: missing ${name} stem wav under ${demucsStage.cache && demucsStage.cache.stemDir}`);
      }
      const verifiedStem = await readVerifiedFile(stemPathObj.path, {
        expectedIdentity: stemPathObj.identity,
        label: `Demucs ${name} stem`,
        maxBytes: 2 * 1024 * 1024 * 1024,
      });
      const s = await onnxLib.decodeStereoF32Buffer(verifiedStem.data, { sampleRate: 22050 });
      const mono = new Float32Array(s.length);
      for (let i = 0; i < s.length; i += 1) mono[i] = 0.5 * (s.left[i] + s.right[i]);
      stemMonos[name] = mono;
    }
    const beatTimes = Float64Array.from(beatStage.beats.beatTimes);
    const resolution = beatStage.beats.resolution || CHART_OUTPUT_RESOLUTION;
    const offset = beatStage.beats.offset || 0;
    // Imported chart sync hands back the source tempo map so the chart keeps it
    // verbatim; a detected grid is turned back into tempo anchors here.
    const syncLines = Array.isArray(beatStage.beats.syncLines) && beatStage.beats.syncLines.length
      ? beatStage.beats.syncLines
      : onnxLib.beatsToSyncLines(beatTimes, resolution, 0.5);
    emit({ type: "log", stage: "transcription", stream: "stdout", message: `transcription: building beat_mel (${beatTimes.length - 1} beats, audio ${audioDuration.toFixed(1)}s)` });
    const { beatMel, beatMask, nBeats, nFramesFinal, refDb } = await onnxLib.buildBeatMel({
      melSession,
      fullMono22050: fullMono,
      stemMonos22050: stemMonos,
      beatTimes,
      maxBeats,
      audioDuration,
      log: (m) => emit({ type: "log", stage: "transcription", stream: "stdout", message: m }),
    });
    emit({ type: "log", stage: "transcription", stream: "stdout", message: `transcription: beat_mel shape [1, ${nBeats}, 5, 80, 32] nFrames=${nFramesFinal} refDb=${refDb.toFixed(3)}` });

    const descNames = onnxLib.DESCRIPTOR_NAMES;
    const knobs = settings.knobs || {};
    const bins = descNames.map((name) => {
      const v = knobs[name];
      if (v == null) return onnxLib.DESC_AUTO_BIN; // auto
      const n = Math.trunc(Number(v));
      if (!Number.isFinite(n)) return onnxLib.DESC_AUTO_BIN;
      return Math.max(0, Math.min(6, n));
    });
    const prefixTokens = [onnxLib.BOS_TOKEN, onnxLib.difficultyToken(settings.difficulty)];
    for (let knex = 0; knex < descNames.length; knex += 1) {
      prefixTokens.push(onnxLib.descriptorToken(knex, bins[knex]));
    }
    const prefixTablesPath = path.join(manifest.folder, transcriberStage.prefixConditioning.file);
    const tables = onnxLib.loadNpz(prefixTablesPath);
    const dModel = Number(modelConfig.dModel || 512);
    const descPrefixScan = Number((transcriberStage.prefixConditioning && transcriberStage.prefixConditioning.descPrefixScan) || 8);
    const prefixBias = onnxLib.computePrefixBias(prefixTokens, {
      descPrefixScan,
      pervasiveDifficulty: Boolean(transcriberStage.prefixConditioning.pervasiveDifficulty),
      pervasiveDescriptors: Boolean(transcriberStage.prefixConditioning.pervasiveDescriptors),
      dModel, tables,
    });

    const useCfg = settings.guidanceScale > 1.0 && Boolean(transcriberStage.prefixConditioning && transcriberStage.prefixConditioning.pervasiveDescriptors);
    let uncondPrefixTokens = null, uncondPrefixBias = null;
    if (useCfg) {
      uncondPrefixTokens = [onnxLib.BOS_TOKEN, onnxLib.difficultyToken(settings.difficulty)];
      for (let knex = 0; knex < descNames.length; knex += 1) {
        uncondPrefixTokens.push(onnxLib.descriptorToken(knex, onnxLib.DESC_AUTO_BIN));
      }
      uncondPrefixBias = onnxLib.computePrefixBias(uncondPrefixTokens, {
        descPrefixScan,
        pervasiveDifficulty: Boolean(transcriberStage.prefixConditioning.pervasiveDifficulty),
        pervasiveDescriptors: Boolean(transcriberStage.prefixConditioning.pervasiveDescriptors),
        dModel, tables,
      });
      emit({ type: "log", stage: "transcription", stream: "stdout", message: `transcription: CFG w=${settings.guidanceScale} uncond prefix len ${uncondPrefixTokens.length}` });
    } else {
      emit({ type: "log", stage: "transcription", stream: "stdout", message: `transcription: single-stream (no CFG; guidance=${settings.guidanceScale})` });
    }

    const encoderSession = await onnxLib.loadEncoderSessions(manifest, transcriberDevice);
    const decoderSession = await onnxLib.loadDecoderSession(manifest, transcriberDevice);
    const sessionDevices = [melSession, encoderSession, decoderSession].map((session) =>
      onnxLib.sessionDevice ? onnxLib.sessionDevice(session, transcriberDevice) : transcriberDevice
    );
    transcriberExecutionProvider = sessionDevices.includes("cpu")
      ? "cpu"
      : sessionDevices[0] || transcriberDevice;
    emit({
      type: "stage",
      stage: "transcription",
      status: "running",
      backend: "onnxruntime-node",
      device: transcriberExecutionProvider,
      requestedDevice: transcriberDevice,
    });
    const greedy = settings.temperature <= 0;
    const rng = greedy ? null : onnxLib.makeRng(settings.seed);
    emit({ type: "log", stage: "transcription", stream: "stdout", message: `transcription: decode loop (device=${transcriberExecutionProvider}, requestedDevice=${transcriberDevice}, mode=${greedy ? "greedy" : "sampled"}, T=${settings.temperature}, top_p=${settings.topP}, seed=${settings.seed}, max_tokens=${Number(modelConfig.maxTokens || 8192)})` });

    const partialState = { sequence: 0, sentTiming: false };

    const decodeResult = await onnxLib.generate({
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
      progressIntervalBeats: 4,
      onProgress: ({ tokens, committedBeats, totalBeats, done }) => {
        if (committedBeats <= 0 && !done) return;
        const { events, issues } = onnxLib.decodeTokens(tokens);
        const filtered = done ? events : events.filter((e) => e.beat < committedBeats);
        const noteLines = onnxLib.flattenNoteLines(onnxLib.eventsToChartNotes(filtered, resolution));
        partialState.sequence += 1;
        const event = {
          type: "partial_chart",
          schemaVersion: 1,
          stage: "transcription",
          songKey: job.jobId,
          songName: job.title || (job.metadata && job.metadata.title) || "Autochart",
          sequence: partialState.sequence,
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
        };
        if (!partialState.sentTiming) {
          event.timing = { resolution, syncLines, offset };
          partialState.sentTiming = true;
        }
        emit(event);
      },
      log: (m) => emit({ type: "log", stage: "transcription", stream: "stdout", message: m }),
    });
    const tokens = Array.from(decodeResult.tokens);
    emit({ type: "log", stage: "transcription", stream: "stdout", message: `transcription: decoded ${tokens.length} tokens in ${decodeResult.stats.generationSeconds}s` });
    emit({
      type: "stage",
      stage: "transcription",
      status: "completed",
      backend: "onnxruntime-node",
      device: transcriberExecutionProvider,
      requestedDevice: transcriberDevice,
      nTokens: tokens.length,
    });

    const result = await lifecycle.runStage("chart", async () => {
      activeGenerationStage = "chart";
      emit({ type: "stage", stage: "chart", status: "running", backend: "onnxruntime-node" });
    const { events, issues } = onnxLib.decodeTokens(tokens);
    const rows = onnxLib.eventsToChartNotes(events, resolution);
    const chartMetadata = {
      title: String(job.title || job.metadata?.title || "Untitled").trim() || "Untitled",
      artist: String(job.metadata?.artist || "Unknown Artist").trim() || "Unknown Artist",
      charter: String(job.metadata?.charter || "Autochart").trim() || "Autochart",
    };
    const chartDir = path.join(outputDir, "chart");
    const chartPath = path.join(chartDir, "notes.chart");
    await fs.mkdir(chartDir, { recursive: true });
    const { text: chartText, noteLineCount } = onnxLib.writeChartText(rows, {
      ...chartMetadata,
      difficulty: settings.difficulty,
      resolution,
      syncLines,
      offset,
    });
    await writeVerifiedAtomic(chartPath, chartText, {
      rootDirectory: outputDir,
      label: "Chart output",
    });
    emit({ type: "log", stage: "chart", stream: "stdout", message: `chart: wrote ${chartPath} (${noteLineCount} note lines, ${events.length} events)` });
    const reportPath = path.join(chartDir, "full_song_report.json");
    const fullReport = {
      schemaVersion: 1,
      generatorId: job.generatorId,
      generatorLabel: generator.label,
      backend: "onnxruntime-node",
      model: transcriberStage && transcriberStage.note ? "fretformer-v1" : null,
      difficulty: settings.difficulty,
      temperature: settings.temperature,
      top_p: settings.topP,
      seed: settings.seed,
      strip_sustains: false,
      descriptor_conditioning: decoderSettings.descriptorTrained,
      descriptor_knobs: decoderSettings.descriptorTrained
        ? descNames.reduce((map, name, idx) => {
            map[name] = bins[idx] === onnxLib.DESC_AUTO_BIN ? "auto" : bins[idx];
            return map;
          }, {})
        : null,
      guidance_scale: useCfg ? settings.guidanceScale : null,
      event_count: events.length,
      note_line_count: noteLineCount,
      token_stats: {
        n_tokens: tokens.length,
        generation_seconds: decodeResult.stats.generationSeconds,
        n_beats: nBeats,
      },
      decode_issues: {
        orphan_modifiers: issues.orphan_modifiers,
        orphan_positions: issues.orphan_positions,
        notes_without_position: issues.notes_without_position,
        duplicate_positions: issues.duplicate_positions,
        details: issues.details.slice(0, 5),
      },
      chart_validation: {
        has_notes_chart: await exists(chartPath),
        chart_path: chartPath,
        note_line_count: noteLineCount,
        event_count: events.length,
      },
      timing: {
        detector: beatStage.beats.detector || "beat_this_ft_v4_onnx",
        timingMode: beatStage.beats.timingMode,
        smoothing: settings.smoothing,
        nBeats: beatTimes.length - 1,
        rawBeatCount: beatStage.beats.rawBeatTimes.length,
        smoothedBeatCount: beatStage.beats.smoothedBeatTimes.length,
        nLeadIn: beatStage.beats.nLeadIn,
        tempoBpm: beatStage.beats.tempoBpm,
        downbeatCount: beatStage.beats.downbeatTimes.length,
        path: timingOutputPath,
        audioDuration,
      },
      prefix: {
        cond: prefixTokens,
        uncond: uncondPrefixTokens,
        descPrefixScan,
        pervasiveDifficulty: Boolean(transcriberStage.prefixConditioning.pervasiveDifficulty),
        pervasiveDescriptors: Boolean(transcriberStage.prefixConditioning.pervasiveDescriptors),
      },
      featureBuild: {
        refDb, nFramesFinal, nBeats, maxBeats,
        channelOrder: ["full", "drums", "bass", "vocals", "other"],
        beatMelShape: [1, nBeats, 5, 80, 32],
      },
      generatedStats: null,
    };
    fullReport.generatedStats = await chartTimingStats(chartPath);
    await writeVerifiedAtomic(
      reportPath,
      `${JSON.stringify(fullReport, null, 2)}\n`,
      { rootDirectory: outputDir, label: "Chart report" }
    );

    const generation = effectiveTranscriberGeneration(job, settings);
    const chartResult = {
      schemaVersion: 1,
      jobId: job.jobId,
      status: "completed",
      generatorId: job.generatorId,
      generatorLabel: generator.label,
      engineVersion: job.engineVersion || ENGINE_VERSION,
      outputDir,
      chartPath,
      reportPath,
      timingPath: beatStage.timingOutputPath,
      logPath,
      generation,
      provenance: {
        kind: "autochart-engine-onnx",
        jobPath,
        generatorId: job.generatorId,
        generatorLabel: generator.label,
        engineVersion: job.engineVersion || ENGINE_VERSION,
        runtime: {
          platform: CURRENT_PLATFORM,
          backend: "onnxruntime-node",
          executionProvider: transcriberExecutionProvider,
          requestedDevice: String(job.requestedHardwareMode || job.hardwareMode || job.transcriberDevice || "auto"),
          autoResolvedDevice: onnxLib.getAutoDeviceResolution && onnxLib.getAutoDeviceResolution(),
          devices: {
            demucs: demucsStage.executionProvider || null,
            timing: beatStage.executionProvider || null,
            transcriber: transcriberExecutionProvider,
          },
          cachedStages: [
            ...(demucsStage.cacheHit ? ["demucs"] : []),
            ...(beatStage.cacheHit ? ["timing"] : []),
          ],
        },
        milestone: 5,
        stages: ["demucs", "timing", "transcription", "chart"],
        settings,
        decoderSettings,
        generation,
        sourceSeparation: job.demucsSeparation || null,
        sourceTransform: job.sourceTransform || null,
        sourceChart: settings.detector === SOURCE_CHART_DETECTOR ? job.sourceChart || null : null,
      },
      cache: {
        cacheDir: path.resolve(job.cacheDir),
        workspace: path.resolve(
          job.demucsWorkspace || path.join(job.cacheDir, "features", "fretformer_demucs_v1", shortStableKey(job))
        ),
        timingMode: beatStage.beats.timingMode,
      },
      metrics: {
        tokenStats: fullReport.token_stats,
        chartValidation: fullReport.chart_validation,
        decodeIssues: fullReport.decode_issues,
        eventCount: fullReport.event_count,
        noteLineCount: fullReport.note_line_count,
        timing: fullReport.timing,
      },
      sourceSeparation: job.demucsSeparation || null,
      sourceTransform: job.sourceTransform || null,
      createdAt: Date.now(),
    };
    emit({ type: "stage", stage: "chart", status: "completed", backend: "onnxruntime-node", chartPath, noteLineCount, eventCount: events.length });
    return chartResult;
    });
    return result;
    });
    return transcriptionResult;
  } catch (err) {
    const message = String(err && err.message || err);
    const failure = lifecycle.fail(err, activeGenerationStage);
    const result = {
      schemaVersion: 1,
      jobId: job.jobId,
      status: "failed",
      error: message,
      failedStage: failure.stage,
      generatorId: job.generatorId,
      generatorLabel: generator.label,
      engineVersion: job.engineVersion || ENGINE_VERSION,
      outputDir,
      logPath,
      chartPath: null,
      reportPath: null,
      beatsPath: beatStage?.beatsJsonPath || null,
      beats: {
        nBeats: beatStage?.beats?.beatTimes?.length || 0,
        nDownbeats: beatStage?.beats?.downbeatTimes?.length || 0,
        nLeadIn: beatStage?.beats?.nLeadIn || 0,
        tempoBpm: beatStage?.beats?.tempoBpm || null,
        timingMode: beatStage?.beats?.timingMode || null,
        path: beatStage?.beatsJsonPath || null,
      },
      provenance: {
        kind: "autochart-engine-onnx",
        jobPath,
        generatorId: job.generatorId,
        generatorLabel: generator.label,
        engineVersion: job.engineVersion || ENGINE_VERSION,
        runtime: {
          platform: CURRENT_PLATFORM,
          backend: "onnxruntime-node",
          executionProvider: transcriberExecutionProvider,
          devices: {
            demucs: demucsStage?.executionProvider || null,
            timing: beatStage?.executionProvider || null,
            transcriber: transcriberExecutionProvider,
          },
          notRunStages: [
            ...(demucsStage ? [] : ["demucs"]),
            ...(beatStage ? [] : ["timing", "smoothing"]),
            ...(transcriberExecutionProvider ? [] : ["transcription"]),
            "chart",
          ],
        },
        milestone: 5,
        note: failure.note,
        stages: failure.completedStages,
        error: message,
      },
      createdAt: Date.now(),
    };
    return result;
  }
}

// Maps hardwareMode then legacy device fields -> ONNX EP (gpu alias -> webgpu; auto probes WebGPU).
function resolveOnnxDevice(job) {
  const hwMode = String(job && job.hardwareMode || "").trim().toLowerCase();
  if (process.env.ELECTRON_RUN_AS_NODE === "1") return "cpu";
  if (hwMode === "cpu") return "cpu";
  if (hwMode === "webgpu") return "webgpu";
  if (hwMode === "coreml") return "coreml";
  if (hwMode === "cuda") return "cuda";
  if (hwMode === "gpu") return "webgpu";
  const jobDev = String((job && (job.transcriberDevice || job.demucsDevice || job.timingDevice)) || "").trim().toLowerCase();
  if (jobDev === "cpu") return "cpu";
  if (jobDev === "webgpu") return "webgpu";
  if (jobDev === "coreml") return "coreml";
  if (jobDev === "cuda") return "cuda";
  if (jobDev === "gpu") return "webgpu";
  return "auto";
}
async function resolveOnnxTranscriberDevice(job, onnxLib, manifest, resolvedDevice) {
  if (process.env.ELECTRON_RUN_AS_NODE === "1") {
    return { device: "cpu", note: "forced to CPU because ELECTRON_RUN_AS_NODE cannot initialize Dawn" };
  }
  const override = String(process.env.AUTOCHART_ONNX_TRANSCRIBER_DEVICE || "").trim().toLowerCase();
  if (["cpu", "webgpu", "coreml", "cuda"].includes(override)) {
    return { device: override, note: `forced by AUTOCHART_ONNX_TRANSCRIBER_DEVICE` };
  }
  const encoderGraph = onnxLib.graphPath(manifest, "transcriber-encoder");
  if (resolvedDevice !== "cuda") {
    return { device: await onnxLib.resolveDevice(resolvedDevice, encoderGraph), note: "" };
  }
  const webgpuAvailable = await onnxLib.probeWebgpuAvailable(encoderGraph);
  return webgpuAvailable
    ? { device: "webgpu", note: "preferred over cuda" }
    : { device: "cuda", note: "webgpu unavailable; retaining cuda" };
}

module.exports = { onnxDetectBeats };

if (require.main === module) main().then(
  (result) => finishProcess(result?.status === "completed" ? 0 : 1),
  (err) => {
    emit({ type: "error", message: err.message || String(err) });
    return finishProcess(1);
  }
);

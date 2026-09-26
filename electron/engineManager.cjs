const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const runtimeSelection = require("./runtimeSelection.cjs");
const { resolveFfmpegPath } = require("./ffmpegPath.cjs");
const demucsWorkspace = require("./demucsWorkspace.cjs");
const modelManager = require("./modelManager.cjs");
const {
  ensureRealDirectoryTree,
  hashVerifiedFile,
  inspectVerifiedFile,
  openVerifiedFile,
  openVerifiedExclusiveOutput,
  promoteStagedFile,
  readHandle,
  removeVerifiedPath,
  readVerifiedFile,
  sameIdentity,
  verifyExclusiveOutput,
  streamVerifiedToStaging,
  writeVerifiedAtomic,
  fsyncHandle,
} = require("./fileSafety.cjs");

const MANIFEST_NAME = "manifest.json";
const CURRENT_PLATFORM = process.platform;

function defaultEngineRoot() {
  if (process.env.AUTOCHART_ENGINE_PATH) {
    return path.resolve(process.env.AUTOCHART_ENGINE_PATH);
  }
  return path.resolve(__dirname, "..", "engine");
}

function cacheRoot(userDataPath, settings = {}) {
  return path.join(
    settings.cacheFolder || path.join(userDataPath, "cache"),
    "engine"
  );
}

function jobsRoot(userDataPath, settings = {}) {
  return path.join(settings.cacheFolder || path.join(userDataPath, "generation"), "jobs");
}
async function directoryIdentityState(directory, label) {
  const requested = path.resolve(directory);
  const stat = await fs.lstat(requested);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory.`);
  const canonical = await fs.realpath(requested);
  if (canonical !== requested) throw new Error(`${label} escaped its configured path.`);
  return { path: requested, device: stat.dev, inode: stat.ino };
}

async function assertDirectoryIdentityState(state, label) {
  const current = await directoryIdentityState(state.path, label);
  if (current.device !== state.device || current.inode !== state.inode) {
    throw new Error(`${label} changed during generation.`);
  }
  return current;
}
async function assertJobPathState(state) {
  await assertDirectoryIdentityState(state.cacheParent, "Cache parent");
  await assertDirectoryIdentityState(state.jobs, "Jobs root");
  await assertDirectoryIdentityState(state.jobDir, "Job directory");
  await assertDirectoryIdentityState(state.outputDir, "Job output directory");
}

async function prepareJobPaths(userDataPath, jobId, settings = {}) {
  if (!isValidJobId(String(jobId || ""))) throw new Error("Invalid engine job ID.");
  const jobs = jobsRoot(userDataPath, settings);
  const cacheParent = path.dirname(jobs);
  await ensureRealDirectoryTree(cacheParent, jobs);
  const jobDir = path.join(jobs, jobId);
  try {
    await fs.mkdir(jobDir);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`Engine job directory already exists: ${jobDir}`);
    }
    throw error;
  }
  const outputDir = path.join(jobDir, "output");
  await ensureRealDirectoryTree(jobDir, outputDir);
  const state = {
    cacheParent: await directoryIdentityState(cacheParent, "Cache parent"),
    jobs: await directoryIdentityState(jobs, "Jobs root"),
    jobDir: await directoryIdentityState(jobDir, "Job directory"),
    outputDir: await directoryIdentityState(outputDir, "Job output directory"),
  };
  return { jobs, jobDir, outputDir, jobPath: path.join(jobDir, "job.json"), state };
}

const RECENT_JOB_EVENTS = new Map();
const MAX_RECENT_EVENTS = 80;
const MAX_RECENT_JOBS = 200;

// Active engine children keyed by jobId. Entries may exist before spawn (so
// cancel during audio caching / job prep can abort before the child starts).
const ACTIVE_JOBS = new Map();
// Cancels that arrived before the job registered (IPC transfer / model scan).
const PENDING_CANCELS = new Map();
const MAX_PENDING_CANCELS = 20;
const TERMINAL_JOBS = new Map();
const TERMINAL_JOB_TTL_MS = 60 * 60 * 1000;
const MAX_TERMINAL_JOBS = 200;
const CANCEL_KILL_ESCALATE_MS = 3000;
const JOB_ID_RE = /^[0-9a-fA-F-]{10,64}$/;

function canceledError() {
  const err = new Error("canceled");
  err.code = "CANCELED";
  return err;
}

function isValidJobId(jobId) {
  return typeof jobId === "string" && JOB_ID_RE.test(jobId);
}

function terminalJobRecord(jobId) {
  const record = TERMINAL_JOBS.get(jobId);
  if (!record) return null;
  if (Date.now() - record.completedAt > TERMINAL_JOB_TTL_MS) {
    TERMINAL_JOBS.delete(jobId);
    return null;
  }
  return record;
}

function rememberTerminalJob(jobId, entry) {
  PENDING_CANCELS.delete(jobId);
  TERMINAL_JOBS.set(jobId, {
    sender: entry?.sender || null,
    completedAt: Date.now(),
  });
  while (TERMINAL_JOBS.size > MAX_TERMINAL_JOBS) {
    const oldest = TERMINAL_JOBS.keys().next().value;
    if (oldest == null) break;
    TERMINAL_JOBS.delete(oldest);
  }
}

function registerActiveJob(jobId, commandName = "generate", sender = null) {
  const existing = ACTIVE_JOBS.get(jobId);
  if (existing) return existing;
  const pendingSender = PENDING_CANCELS.get(jobId);
  const pendingCancel = pendingSender != null && (!pendingSender || pendingSender === sender);
  if (pendingCancel) PENDING_CANCELS.delete(jobId);
  const entry = {
    child: null,
    commandName,
    sender,
    canceled: pendingCancel,
    createdAt: Date.now(),
    killTimer: null,
  };
  ACTIVE_JOBS.set(jobId, entry);
  return entry;
}

function deregisterActiveJob(jobId) {
  const entry = ACTIVE_JOBS.get(jobId);
  if (!entry) return;
  if (entry.killTimer) {
    clearTimeout(entry.killTimer);
    entry.killTimer = null;
  }
  ACTIVE_JOBS.delete(jobId);
  rememberTerminalJob(jobId, entry);
}

function isJobCanceled(jobId) {
  return Boolean(ACTIVE_JOBS.get(jobId)?.canceled);
}

function childStillAlive(child) {
  return Boolean(child) && child.exitCode === null && child.signalCode === null;
}

function killActiveChild(entry) {
  const child = entry?.child;
  if (!childStillAlive(child)) return;
  if (process.platform === "win32") {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  if (entry.killTimer) clearTimeout(entry.killTimer);
  entry.killTimer = setTimeout(() => {
    entry.killTimer = null;
    try {
      if (childStillAlive(entry.child)) entry.child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }, CANCEL_KILL_ESCALATE_MS);
  entry.killTimer.unref?.();
}
function cancelJob(jobId, sender = null) {
  const id = String(jobId || "").trim();
  if (!isValidJobId(id)) return { ok: false, status: "idle" };
  const entry = ACTIVE_JOBS.get(id);
  if (entry) {
    if (entry.sender && entry.sender !== sender) return { ok: false, status: "sender-mismatched" };
    entry.canceled = true;
    killActiveChild(entry);
    return { ok: true, jobId: id, status: "canceling" };
  }
  const terminal = terminalJobRecord(id);
  if (terminal) {
    if (terminal.sender && terminal.sender !== sender) return { ok: false, status: "sender-mismatched" };
    return { ok: false, jobId: id, status: "completed" };
  }
  const pendingSender = PENDING_CANCELS.get(id);
  if (pendingSender && pendingSender !== sender) return { ok: false, status: "sender-mismatched" };
  if (PENDING_CANCELS.size >= MAX_PENDING_CANCELS) PENDING_CANCELS.clear();
  PENDING_CANCELS.set(id, sender);
  return { ok: true, jobId: id, status: "canceling" };
}

const DEFAULT_GENERATION = {
  presetId: "standard",
  presetName: "Standard",
  modified: false,
  controls: {
    difficulty: "expert",
    temperature: 0.95,
    topP: 0.98,
    stripSustains: false,
    timingDetector: "beat_this_custom_timing",
    timingSmoothing: true,
    density: "normal",
    motifReuse: "normal",
    threshold: 0.88,
    eventCopyScoreThreshold: 0.75,
    seedMode: "random",
    seed: null,
    minFirstNoteSeconds: null,
  },
  resolved: {
    difficulty: "expert",
    temperature: 0.95,
    topP: 0.98,
    stripSustains: false,
    tokenDecodePreset: "v51_motif_consistency_light_v24_chords",
    threshold: 0.88,
    eventCopyScoreThreshold: 0.75,
    eventCopyWindowBeats: 4,
    eventCopyMinWindowGap: 2,
    eventCopyMinEvents: 3,
    eventCopyMaxEventRatio: 1.35,
    timingDetector: "beat_this_custom_timing",
    detector: "beat_this_custom_timing",
    timingRaw: true,
    bpmTolerance: 0,
    minFirstNoteSeconds: null,
    seed: 20260609,
    timingSmoothing: {
      enabled: true,
      gain: 0.15,
      window: 9,
      bpmRound: 0.5,
    },
  },
};

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
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
  const number = Number.parseInt(String(value ?? "").trim(), 10);
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

function supportsCurrentPlatform(generator) {
  return runtimeSelection.supportsPlatformAndArchitecture(
    generator,
    CURRENT_PLATFORM,
    process.arch
  );
}

function hardwareDeviceOverrides(settings = {}) {
  const mode = runtimeSelection.effectiveHardwareMode(settings, CURRENT_PLATFORM);
  if (mode === "cpu") {
    return { timingDevice: "cpu", transcriberDevice: "cpu", demucsDevice: "cpu" };
  }
  if (mode === "cuda") {
    return { timingDevice: "auto", transcriberDevice: "cuda", demucsDevice: "cuda" };
  }
  // These ONNX execution providers bypass the retired Python runtime entirely.
  if (mode === "webgpu") {
    return { timingDevice: "webgpu", transcriberDevice: "webgpu", demucsDevice: "webgpu" };
  }
  if (mode === "coreml") {
    return { timingDevice: "coreml", transcriberDevice: "coreml", demucsDevice: "coreml" };
  }
  return {};
}

function platformObject(value) {
  const object = plainObject(value);
  const current = plainObject(object[CURRENT_PLATFORM]);
  if (Object.keys(current).length) return current;
  return plainObject(object.default);
}

function generatorForCurrentPlatform(generator) {
  const runtime = plainObject(generator?.runtime);
  const devices = plainObject(runtime.devices);
  return {
    ...generator,
    currentPlatform: CURRENT_PLATFORM,
    runtime: {
      ...runtime,
      current: {
        devices: platformObject(devices),
      },
    },
  };
}

function normalizeDifficulty(value, fallback = DEFAULT_GENERATION.resolved.difficulty) {
  const text = String(value ?? "").trim().toLowerCase();
  return ["easy", "medium", "hard", "expert"].includes(text) ? text : fallback;
}

function timingDetectorPresetId(detector, raw, fallback = DEFAULT_GENERATION.resolved.timingDetector) {
  if (detector === "source_chart") return "source_chart_sync";
  if (detector === "beat_this_custom_timing" && raw) return "beat_this_custom_timing";
  return fallback;
}

function randomGenerationSeed() {
  return crypto.randomInt(1, 2 ** 31 - 1);
}

function normalizeGenerationPayload(payload, generatorId, generator = null) {
  const generation = plainObject(payload);
  const controlsIn = plainObject(generation.controls);
  const resolvedIn = plainObject(generation.resolved);
  const generatorTiming = plainObject(generator?.timing);
  const smoothingIn = plainObject(resolvedIn.timingSmoothing);
  const smoothingEnabledIn = smoothingIn.enabled ?? controlsIn.timingSmoothing;
  const smoothingDefaults = {
    ...DEFAULT_GENERATION.resolved.timingSmoothing,
    ...plainObject(generatorTiming.smoothing),
  };
  const controls = {
    ...DEFAULT_GENERATION.controls,
    ...controlsIn,
  };
  const fixedSeed = controls.seedMode !== "random";
  const requestedSeed = fixedSeed ? controls.seed ?? resolvedIn.seed : resolvedIn.seed;
  const seed = integerValue(requestedSeed, randomGenerationSeed(), { min: 0, max: 2 ** 31 - 2 });
  const difficulty = normalizeDifficulty(resolvedIn.difficulty ?? controls.difficulty);
  const temperature = numberValue(resolvedIn.temperature ?? controls.temperature, DEFAULT_GENERATION.resolved.temperature, {
    min: 0.05,
    max: 2,
  });
  const topP = numberValue(resolvedIn.topP ?? controls.topP, DEFAULT_GENERATION.resolved.topP, {
    min: 0.01,
    max: 1,
  });
  const stripSustains = booleanValue(
    resolvedIn.stripSustains ?? controls.stripSustains,
    DEFAULT_GENERATION.resolved.stripSustains
  );
  const minFirstNoteSeconds = numberValue(
    resolvedIn.minFirstNoteSeconds ?? controls.minFirstNoteSeconds,
    DEFAULT_GENERATION.resolved.minFirstNoteSeconds,
    { min: 0 }
  );
  const requestedTimingDetector = textValue(
    resolvedIn.timingDetector ?? controls.timingDetector,
    DEFAULT_GENERATION.resolved.timingDetector
  );
  const detectorIn = textValue(resolvedIn.detector ?? generatorTiming.detector, DEFAULT_GENERATION.resolved.detector);
  const usesSourceChartTiming = requestedTimingDetector === "source_chart_sync" || detectorIn === "source_chart";
  const detector = usesSourceChartTiming ? "source_chart" : detectorIn;
  const timingRaw = booleanValue(
    usesSourceChartTiming ? false : resolvedIn.timingRaw ?? generatorTiming.raw,
    DEFAULT_GENERATION.resolved.timingRaw
  );
  const timingDetector = textValue(
    usesSourceChartTiming ? "source_chart_sync" : requestedTimingDetector,
    timingDetectorPresetId(detector, timingRaw)
  );

  return {
    generatorId,
    presetId: textValue(generation.presetId || controls.presetId, DEFAULT_GENERATION.presetId),
    presetName: textValue(generation.presetName, DEFAULT_GENERATION.presetName),
    modified: Boolean(generation.modified),
    controls: {
      ...controlsIn,
      difficulty,
      temperature,
      topP,
      stripSustains,
      timingDetector,
      timingSmoothing: usesSourceChartTiming ? false : booleanValue(smoothingEnabledIn, smoothingDefaults.enabled),
      density: textValue(controls.density, DEFAULT_GENERATION.controls.density),
      motifReuse: textValue(controls.motifReuse, DEFAULT_GENERATION.controls.motifReuse),
      threshold: numberValue(
        controls.threshold ?? resolvedIn.threshold,
        DEFAULT_GENERATION.controls.threshold,
        { min: 0, max: 1 }
      ),
      eventCopyScoreThreshold: numberValue(
        controls.eventCopyScoreThreshold ?? resolvedIn.eventCopyScoreThreshold,
        DEFAULT_GENERATION.controls.eventCopyScoreThreshold,
        { min: 0, max: 1 }
      ),
      seedMode: fixedSeed ? "fixed" : "random",
      seed: fixedSeed ? seed : null,
      minFirstNoteSeconds,
    },
    resolved: {
      ...resolvedIn,
      difficulty,
      temperature,
      topP,
      stripSustains,
      tokenDecodePreset: textValue(resolvedIn.tokenDecodePreset, DEFAULT_GENERATION.resolved.tokenDecodePreset),
      threshold: numberValue(resolvedIn.threshold ?? controls.threshold, DEFAULT_GENERATION.resolved.threshold, { min: 0, max: 1 }),
      eventCopyScoreThreshold: numberValue(
        resolvedIn.eventCopyScoreThreshold ?? controls.eventCopyScoreThreshold,
        DEFAULT_GENERATION.resolved.eventCopyScoreThreshold,
        { min: 0, max: 1 }
      ),
      eventCopyWindowBeats: integerValue(
        resolvedIn.eventCopyWindowBeats,
        DEFAULT_GENERATION.resolved.eventCopyWindowBeats,
        { min: 1 }
      ),
      eventCopyMinWindowGap: integerValue(
        resolvedIn.eventCopyMinWindowGap,
        DEFAULT_GENERATION.resolved.eventCopyMinWindowGap,
        { min: 0 }
      ),
      eventCopyMinEvents: integerValue(
        resolvedIn.eventCopyMinEvents,
        DEFAULT_GENERATION.resolved.eventCopyMinEvents,
        { min: 1 }
      ),
      eventCopyMaxEventRatio: numberValue(
        resolvedIn.eventCopyMaxEventRatio,
        DEFAULT_GENERATION.resolved.eventCopyMaxEventRatio,
        { min: 0 }
      ),
      timingDetector,
      detector,
      timingRaw,
      bpmTolerance: numberValue(
        resolvedIn.bpmTolerance ?? generatorTiming.bpmTolerance,
        DEFAULT_GENERATION.resolved.bpmTolerance,
        { min: 0 }
      ),
      minFirstNoteSeconds,
      seed,
      timingSmoothing: {
        enabled: usesSourceChartTiming ? false : booleanValue(smoothingEnabledIn, smoothingDefaults.enabled),
        gain: numberValue(smoothingIn.gain, smoothingDefaults.gain, { min: 0, max: 1 }),
        window: integerValue(smoothingIn.window, smoothingDefaults.window, { min: 1 }),
        bpmRound: numberValue(smoothingIn.bpmRound, smoothingDefaults.bpmRound, { min: 0.001 }),
      },
    },
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readCacheMetadata(metaPath, expected) {
  let metadataRead;
  try {
    metadataRead = await readVerifiedFile(metaPath, { label: "Cached audio metadata", maxBytes: 64 * 1024 });
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  let metadata;
  try {
    metadata = JSON.parse(metadataRead.data.toString("utf8"));
  } catch {
    throw new Error(`Cached audio metadata is unreadable: ${metaPath}`);
  }
  if (
    metadata?.sha256 !== expected.sha256 ||
    path.resolve(String(metadata?.audioPath || "")) !== path.resolve(expected.audioPath) ||
    (expected.originalAudioSha256 && metadata?.originalAudioSha256 !== expected.originalAudioSha256) ||
    (expected.normalizedFrom && metadata?.normalizedFrom !== expected.normalizedFrom) ||
    (expected.sourceTransformKey && metadata?.sourceTransform?.key !== expected.sourceTransformKey)
  ) {
    throw new Error(`Cached audio metadata does not match its audio bytes: ${metaPath}`);
  }
  return metadata;
}

async function writeCacheMetadata(metaPath, metadata, rootDirectory = path.dirname(metaPath)) {
  await writeVerifiedAtomic(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, {
    rootDirectory,
    label: "Cached audio metadata",
  });
}

async function ensureGeneratedCacheFile(destination, bytes, expectedSha, label, rootDirectory = path.dirname(destination)) {
  let cached;
  try {
    cached = await readVerifiedFile(destination, { label: `Cached ${label.toLowerCase()}` });
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  if (!cached || cached.sha256 !== expectedSha) {
    await writeVerifiedAtomic(destination, bytes, {
      rootDirectory,
      label: `Cached ${label.toLowerCase()}`,
    });
    cached = await readVerifiedFile(destination, { label: `Cached ${label.toLowerCase()}` });
  }
  if (cached.sha256 !== expectedSha) {
    throw new Error(`Cached ${label.toLowerCase()} failed its SHA-256 identity check.`);
  }
}

const DEFAULT_DEMUCS_ID = "demucs_default";
const DEMUCS_STEMS = ["other", "drums", "bass", "vocals"];

function replacePlaceholders(value, vars) {
  return String(value).replace(/\{(engineRoot|jobPath|outputDir|cacheDir)\}/g, (_m, key) => vars[key] || "");
}

async function loadManifest() {
  const engineRoot = defaultEngineRoot();
  const manifestPath = path.join(engineRoot, MANIFEST_NAME);
  if (!(await fileExists(manifestPath))) {
    return {
      available: false,
      engineRoot,
      error: `Engine manifest not found: ${manifestPath}`,
      generators: [],
    };
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const allGenerators = Array.isArray(manifest.generators) ? manifest.generators : [];
  const supportedPlatform = runtimeSelection.isSupportedTarget(CURRENT_PLATFORM, process.arch);
  const generators = supportedPlatform
    ? allGenerators.filter(supportsCurrentPlatform).map(generatorForCurrentPlatform)
    : [];
  return {
    ...manifest,
    available: true,
    supportedPlatform,
    status: supportedPlatform ? "ready" : "unsupported",
    error: supportedPlatform ? "" : runtimeSelection.unsupportedTargetMessage(CURRENT_PLATFORM, process.arch),
    engineRoot,
    manifestPath,
    platform: CURRENT_PLATFORM,
    arch: process.arch,
    generators,
    allGenerators,
  };
}

function extensionFromAudio(audio) {
  const name = String(audio?.name || "").toLowerCase();
  const ext = path.extname(name);
  if (ext && ext.length <= 8) return ext;
  const mime = String(audio?.mime || "").toLowerCase();
  if (mime.includes("mpeg") || mime.includes("mp3")) return ".mp3";
  if (mime.includes("wav")) return ".wav";
  if (mime.includes("flac")) return ".flac";
  if (mime.includes("opus")) return ".opus";
  if (mime.includes("aac")) return ".aac";
  if (mime.includes("aiff") || mime.includes("aif")) return ".aiff";
  return ".ogg";
}

async function cacheAudio(userDataPath, audio, settings = {}) {
  const sourcePath = String(audio?.path || "").trim();
  if (!sourcePath) throw new Error("Audio payload is missing a file path.");
  const expectedIdentity = {};
  for (const key of ["device", "inode", "size", "lastModified"]) {
    if (audio?.[key] != null) expectedIdentity[key] = audio[key];
  }
  const root = cacheRoot(userDataPath, settings);
  const stagingDir = path.join(root, "audio", ".staging");
  const staged = await streamVerifiedToStaging(sourcePath, stagingDir, {
    rootDirectory: root,
    expectedIdentity: Object.keys(expectedIdentity).length ? expectedIdentity : null,
    label: "Selected audio",
  });
  const sha256 = staged.sha256;
  const ext = extensionFromAudio(audio);
  const dir = path.join(root, "audio", sha256.slice(0, 2), sha256);
  const audioPath = path.join(dir, `source${ext}`);
  await ensureRealDirectoryTree(root, dir);
  let stagedTemporary = staged.temporary;
  try {
    let cached = null;
    try {
      cached = await hashVerifiedFile(audioPath, { label: "Cached selected audio" });
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    if (!cached || cached.sha256 !== sha256) {
      await promoteStagedFile(staged.temporary, audioPath, {
        rootDirectory: root,
        label: "Cached selected audio",
      });
      stagedTemporary = null;
      cached = await hashVerifiedFile(audioPath, { label: "Cached selected audio" });
    }
    if (cached.sha256 !== sha256) throw new Error("Cached selected audio failed its SHA-256 identity check.");

    const metaPath = path.join(dir, "audio.json");
    const metadata = {
      sha256,
      originalName: audio?.name || "audio",
      mime: audio?.mime || "application/octet-stream",
      cachedAt: Date.now(),
      audioPath,
    };
    let existingMetadata = null;
    try {
      const metadataRead = await readVerifiedFile(metaPath, { label: "Cached audio metadata", maxBytes: 64 * 1024 });
      existingMetadata = JSON.parse(metadataRead.data.toString("utf8"));
    } catch (err) {
      if (err?.code !== "ENOENT" && /real regular file/.test(err.message || "")) throw err;
    }
    if (
      !existingMetadata ||
      existingMetadata.sha256 !== sha256 ||
      path.resolve(String(existingMetadata.audioPath || "")) !== path.resolve(audioPath)
    ) {
      await writeVerifiedAtomic(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, {
        rootDirectory: root,
        label: "Cached audio metadata",
      });
    }
    // Subsequent reads target the cache copy, which has its own inode and mtime.
    return { audioPath, sha256, identity: cached.identity };
  } finally {
    if (stagedTemporary) await fs.rm(stagedTemporary, { force: true });
  }
}

function normalizeSourceTransform(value = {}) {
  const rawSeconds = Number(value.leadInSilenceSeconds ?? value.leadInSeconds ?? 0);
  const rawMs = Number(value.leadInSilenceMs ?? Math.round((Number.isFinite(rawSeconds) ? rawSeconds : 0) * 1000));
  const leadInSilenceMs = Number.isFinite(rawMs) && rawMs > 0 ? Math.min(30000, Math.round(rawMs)) : 0;
  const leadInSilenceSeconds = Math.round(leadInSilenceMs) / 1000;
  return {
    kind: leadInSilenceMs > 0 ? "lead-in-silence" : "original",
    leadInSilenceSeconds,
    leadInSilenceMs,
    key: `lead-in:${leadInSilenceMs}`,
    label: leadInSilenceMs > 0 ? `+${leadInSilenceSeconds}s lead-in` : "No lead-in",
  };
}


function stereoizeMonoPcmWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) return null;
    if (id === "fmt ") {
      if (size < 16) return null;
      fmt = {
        start,
        size,
        chunk: Buffer.from(buffer.subarray(start, end)),
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = {
        start,
        size,
        chunk: buffer.subarray(start, end),
      };
    }
    offset = end + (size % 2);
  }

  if (!fmt || !data || fmt.channels !== 1) return null;
  if (![1, 3].includes(fmt.audioFormat)) return null;
  const bytesPerSample = fmt.blockAlign / fmt.channels;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample <= 0) return null;
  if (fmt.bitsPerSample && bytesPerSample !== Math.ceil(fmt.bitsPerSample / 8)) return null;
  if (data.size % fmt.blockAlign !== 0) return null;

  const frameCount = data.size / fmt.blockAlign;
  const stereoBlockAlign = bytesPerSample * 2;
  const stereoData = Buffer.alloc(frameCount * stereoBlockAlign);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sourceStart = frame * bytesPerSample;
    const targetStart = frame * stereoBlockAlign;
    data.chunk.copy(stereoData, targetStart, sourceStart, sourceStart + bytesPerSample);
    data.chunk.copy(stereoData, targetStart + bytesPerSample, sourceStart, sourceStart + bytesPerSample);
  }

  const fmtChunk = Buffer.from(fmt.chunk);
  fmtChunk.writeUInt16LE(2, 2);
  fmtChunk.writeUInt32LE(fmt.sampleRate * stereoBlockAlign, 8);
  fmtChunk.writeUInt16LE(stereoBlockAlign, 12);

  const riffSize = 4 + 8 + fmtChunk.length + 8 + stereoData.length;
  const out = Buffer.alloc(8 + riffSize);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(riffSize, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(fmtChunk.length, 16);
  fmtChunk.copy(out, 20);
  const dataHeader = 20 + fmtChunk.length;
  out.write("data", dataHeader, "ascii");
  out.writeUInt32LE(stereoData.length, dataHeader + 4);
  stereoData.copy(out, dataHeader + 8);
  return out;
}

function pcmWavLooksSilent(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return false;
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return false;

  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) return false;
    if (id === "fmt " && size >= 16) {
      fmt = {
        audioFormat: buffer.readUInt16LE(start),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = buffer.subarray(start, end);
    }
    offset = end + (size % 2);
  }

  if (!fmt || !data || data.length === 0) return true;
  if (fmt.audioFormat === 1) {
    if (fmt.bitsPerSample === 8) return data.every((byte) => byte === 128);
    return data.every((byte) => byte === 0);
  }
  if (fmt.audioFormat === 3) {
    const sampleBytes = fmt.bitsPerSample / 8;
    if (sampleBytes !== 4 && sampleBytes !== 8) return false;
    for (let i = 0; i + sampleBytes <= data.length; i += sampleBytes) {
      const sample = sampleBytes === 4 ? data.readFloatLE(i) : data.readDoubleLE(i);
      if (Number.isFinite(sample) && Math.abs(sample) > 1e-8) return false;
    }
    return true;
  }
  return false;
}

async function normalizeAnalysisAudio(userDataPath, cachedAudio, settings = {}) {
  if (path.extname(cachedAudio.audioPath).toLowerCase() !== ".wav") return cachedAudio;

  const input = (await readVerifiedFile(cachedAudio.audioPath, {
    expectedIdentity: cachedAudio.identity || null,
    label: "Cached selected audio",
  })).data;
  if (pcmWavLooksSilent(input)) {
    throw new Error("Selected audio appears to be silent. Choose a WAV, MP3, FLAC, or video file with audible audio and try again.");
  }

  const stereo = stereoizeMonoPcmWav(input);
  if (!stereo) return cachedAudio;
  const root = cacheRoot(userDataPath, settings);
  const variantDir = path.join(
    root,
    "audio-variants",
    cachedAudio.sha256.slice(0, 2),
    cachedAudio.sha256,
    "mono-wav-stereo"
  );
  const audioPath = path.join(variantDir, "source.wav");
  const metaPath = path.join(variantDir, "audio.json");
  await ensureRealDirectoryTree(root, variantDir);
  const sha256 = crypto.createHash("sha256").update(stereo).digest("hex");
  await ensureGeneratedCacheFile(audioPath, stereo, sha256, "normalized audio", root);
  const metadata = {
    sha256,
    originalAudioSha256: cachedAudio.sha256,
    mime: "audio/wav",
    audioPath,
    normalizedFrom: "mono-pcm-wav",
    cachedAt: Date.now(),
  };
  const existingMetadata = await readCacheMetadata(metaPath, {
    sha256,
    audioPath,
    originalAudioSha256: cachedAudio.sha256,
    normalizedFrom: "mono-pcm-wav",
  });
  if (!existingMetadata) await writeCacheMetadata(metaPath, metadata, root);
  return {
    audioPath,
    sha256,
    identity: cachedAudio.identity,
    originalAudioSha256: cachedAudio.sha256,
  };
}

function runFfmpeg(args) {
  const bin = resolveFfmpegPath();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (err.code === "ENOENT") reject(new Error("ffmpeg is required to add lead-in silence. Install ffmpeg or turn lead-in silence off."));
      else reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg lead-in audio transform failed.${stderr ? ` ${stderr.trim()}` : ""}`));
    });
  });
}

function sourceChartTextFromPayload(payload = {}) {
  const text = payload?.sourceChart?.text ?? payload?.sourceChartText ?? "";
  return typeof text === "string" ? text : "";
}

async function writeSourceChartForJob(jobDir, payload = {}) {
  const text = sourceChartTextFromPayload(payload);
  if (!text.trim()) return null;
  const sourceDir = path.join(jobDir, "source_chart");
  const chartPath = path.join(sourceDir, "notes.chart");
  await ensureRealDirectoryTree(jobDir, sourceDir);
  await writeVerifiedAtomic(chartPath, text, { rootDirectory: jobDir, label: "Source chart" });
  return {
    path: chartPath,
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
    versionId: textValue(payload.sourceChart?.versionId, ""),
    name: textValue(payload.sourceChart?.name, "Imported Clone Hero"),
  };
}

async function applySourceTransform(userDataPath, cachedAudio, transform, settings = {}) {
  if (!transform.leadInSilenceMs) {
    return {
      ...(await normalizeAnalysisAudio(userDataPath, cachedAudio, settings)),
      sourceTransform: transform,
      originalAudioSha256: cachedAudio.sha256,
    };
  }

  const root = cacheRoot(userDataPath, settings);
  const variantDir = path.join(
    root,
    "audio-variants",
    cachedAudio.sha256.slice(0, 2),
    cachedAudio.sha256,
    `lead-in-${transform.leadInSilenceMs}`
  );
  const audioPath = path.join(variantDir, "source.flac");
  const metaPath = path.join(variantDir, "audio.json");
  await ensureRealDirectoryTree(root, variantDir);
  let existingVariant;
  try {
    existingVariant = await readVerifiedFile(audioPath, { label: "Lead-in analysis audio" });
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
  if (!existingVariant) {
    const tmp = path.join(variantDir, `source.tmp-${process.pid}-${crypto.randomUUID()}.flac`);
    try {
      await runFfmpeg([
        "-y",
        "-hide_banner",
        "-i",
        cachedAudio.audioPath,
        "-filter_complex",
        `anullsrc=channel_layout=stereo:sample_rate=48000:d=${transform.leadInSilenceSeconds}[s];[0:a]aresample=48000,asetpts=PTS-STARTPTS[a];[s][a]concat=n=2:v=0:a=1[out]`,
        "-map",
        "[out]",
        "-c:a",
        "flac",
        "-compression_level",
        "8",
        tmp,
      ]);
      const generated = await readVerifiedFile(tmp, { label: "Generated lead-in analysis audio" });
      await writeVerifiedAtomic(audioPath, generated.data, {
        rootDirectory: root,
        label: "Lead-in analysis audio",
      });
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }
  const verifiedAudio = await readVerifiedFile(audioPath, { label: "Lead-in analysis audio" });
  const sha256 = verifiedAudio.sha256;
  const metadata = {
    sha256,
    originalAudioSha256: cachedAudio.sha256,
    mime: "audio/flac",
    audioPath,
    sourceTransform: transform,
    cachedAt: Date.now(),
  };
  const existingMetadata = await readCacheMetadata(metaPath, {
    sha256,
    audioPath,
    originalAudioSha256: cachedAudio.sha256,
    sourceTransformKey: transform.key,
  });
  if (!existingMetadata) await writeCacheMetadata(metaPath, metadata, root);
  return {
    audioPath,
    sha256,
    identity: cachedAudio.identity,
    originalAudioSha256: cachedAudio.sha256,
    sourceTransform: transform,
  };
}

async function cacheAnalysisAudio(userDataPath, audio, sourceTransform, settings = {}) {
  const cachedAudio = await cacheAudio(userDataPath, audio, settings);
  return applySourceTransform(
    userDataPath,
    cachedAudio,
    normalizeSourceTransform(sourceTransform),
    settings
  );
}

function sourceTransformFromPayload(payload = {}) {
  return (
    payload.sourceTransform ||
    payload.generation?.sourceTransform ||
    payload.generation?.resolved ||
    payload.generation?.controls ||
    {}
  );
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function sendJobEvent(sender, jobId, event) {
  const payload = { jobId, ...event, updatedAt: Date.now() };
  const current = RECENT_JOB_EVENTS.get(jobId) || { events: [] };
  const events = [...current.events, payload].slice(-MAX_RECENT_EVENTS);
  RECENT_JOB_EVENTS.set(jobId, {
    ...current,
    ...payload,
    events,
  });
  if (RECENT_JOB_EVENTS.size > MAX_RECENT_JOBS) {
    const [oldestJobId] = [...RECENT_JOB_EVENTS.entries()].sort(
      (a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0)
    )[0] || [];
    if (oldestJobId) RECENT_JOB_EVENTS.delete(oldestJobId);
  }
  if (!sender || sender.isDestroyed?.()) return;
  sender.send("engine:jobEvent", payload);
}

// ONNX WebGPU needs a standalone Node process; ELECTRON_RUN_AS_NODE cannot
// enumerate a GPU adapter. Release builds place a target-specific Node binary
// beside the app so a clean machine does not depend on a system installation.
function bundledNodeBinary() {
  if (!process.resourcesPath) return "";
  const executable = CURRENT_PLATFORM === "win32" ? "node.exe" : "node";
  const candidate = path.join(process.resourcesPath, "node-runtime", executable);
  return fsSync.existsSync(candidate) ? candidate : "";
}

let cachedRealNode; // undefined = not looked up yet, string|null after
function findRealNodeBinary() {
  if (cachedRealNode !== undefined) return cachedRealNode;
  cachedRealNode = null;
  const explicit = process.env.AUTOCHART_NODE_BIN;
  if (explicit && fsSync.existsSync(explicit)) {
    cachedRealNode = explicit;
    return cachedRealNode;
  }
  const bundled = bundledNodeBinary();
  if (bundled) {
    cachedRealNode = bundled;
    return cachedRealNode;
  }
  if (!process.versions?.electron) {
    cachedRealNode = process.execPath;
    return cachedRealNode;
  }
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const out = spawnSync(which, ["node"], { encoding: "utf8" });
    if (out.status === 0 && out.stdout) {
      const first = out.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first && fsSync.existsSync(first)) cachedRealNode = first;
    }
  } catch {
    /* ignore — fall through to common-location probe */
  }
  if (!cachedRealNode) {
    // Apps launched from Finder/Explorer inherit a sanitized PATH that excludes
    // Homebrew, nvm, and Program Files\nodejs, so `which node` often returns
    // nothing even when a real node is installed. Probe the well-known
    // absolute install locations before giving up and dropping WebGPU.
    const wellKnown = CURRENT_PLATFORM === "win32"
      ? [
        path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
        path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs", "node.exe"),
      ]
      : [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
      ];
    for (const candidate of wellKnown) {
      if (candidate && fsSync.existsSync(candidate)) {
        cachedRealNode = candidate;
        break;
      }
    }
  }
  return cachedRealNode;
}

const ELECTRON_NODE_CPU_FALLBACK_REASON =
  "WebGPU acceleration is unavailable because Electron-run-as-Node cannot initialize Dawn; using CPU.";

function resolveEntryProcess(command) {
  if (command === "node" && process.versions?.electron && process.execPath) {
    const realNode = findRealNodeBinary();
    if (realNode && path.resolve(realNode) !== path.resolve(process.execPath)) {
      return { command: realNode, env: {}, cpuOnly: false, fallbackReason: "" };
    }
    return {
      command: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: "1" },
      cpuOnly: true,
      fallbackReason: ELECTRON_NODE_CPU_FALLBACK_REASON,
    };
  }
  return { command, env: {}, cpuOnly: false, fallbackReason: "" };
}
function rewriteJobForCpu(job, reason) {
  const requestedHardwareMode = String(
    job.requestedHardwareMode || job.hardwareMode || job.transcriberDevice || job.demucsDevice || "auto"
  ).trim().toLowerCase() || "auto";
  return {
    ...job,
    requestedHardwareMode,
    hardwareMode: "cpu",
    transcriberDevice: "cpu",
    demucsDevice: "cpu",
    timingDevice: "cpu",
    hardwareFallback: {
      from: requestedHardwareMode,
      to: "cpu",
      reason,
    },
  };
}

function pushExistingDir(dirs, value) {
  const raw = String(value || "").trim();
  if (!raw) return;
  const resolved = path.resolve(raw);
  if (!dirs.includes(resolved) && fsSync.existsSync(resolved)) dirs.push(resolved);
}

function engineLibraryPathDirs(job = {}) {
  if (CURRENT_PLATFORM !== "linux") return [];
  const dirs = [];
  pushExistingDir(dirs, process.env.AUTOCHART_CUDNN_LIB_DIR);
  pushExistingDir(dirs, "/opt/cuda/lib64");
  pushExistingDir(dirs, "/usr/local/cuda/lib64");
  pushExistingDir(dirs, "/usr/local/cuda/targets/x86_64-linux/lib");
  return dirs;
}
function engineProcessEnv(manifest, job, entryEnv) {
  const env = {
    ...process.env,
    ...entryEnv,
    AUTOCHART_ENGINE_ROOT: manifest.engineRoot,
    AUTOCHART_JOB_ID: job.jobId,
  };
  if (!entryEnv?.ELECTRON_RUN_AS_NODE) delete env.ELECTRON_RUN_AS_NODE;
  // The engine child process resolves ffmpeg via AUTOCHART_FFMPEG_PATH first.
  if (!env.AUTOCHART_FFMPEG_PATH) {
    const ffmpegBin = resolveFfmpegPath();
    if (ffmpegBin && ffmpegBin !== "ffmpeg") env.AUTOCHART_FFMPEG_PATH = ffmpegBin;
  }
  const libraryDirs = engineLibraryPathDirs(job);
  if (libraryDirs.length) {
    env.LD_LIBRARY_PATH = [...libraryDirs, env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
  }
  return env;
}

async function runEngineProcess({ sender, manifest, job, jobPath, commandName = "generate", pathState = null }) {
  const parentOwnsActiveJob = ACTIVE_JOBS.has(job.jobId);
  const active = registerActiveJob(job.jobId, commandName, sender);
  const releaseChildOwnership = () => {
    if (!parentOwnsActiveJob) deregisterActiveJob(job.jobId);
  };
  if (active.canceled) {
    sendJobEvent(sender, job.jobId, { type: "canceled" });
    releaseChildOwnership();
    throw canceledError();
  }

  const entry = manifest.entry || {};
  const vars = {
    engineRoot: manifest.engineRoot,
    jobPath,
    outputDir: job.outputDir,
    cacheDir: job.cacheDir,
  };
  const rawCommand = replacePlaceholders(entry.command || "node", vars);
  const entryProcess = resolveEntryProcess(rawCommand);
  const effectiveJob = entryProcess.cpuOnly
    ? rewriteJobForCpu(job, entryProcess.fallbackReason)
    : job;
  if (entryProcess.cpuOnly) {
    await writeVerifiedAtomic(jobPath, `${JSON.stringify(effectiveJob, null, 2)}\n`, {
      rootDirectory: path.dirname(jobPath),
      label: "Engine job",
    });
    sendJobEvent(sender, job.jobId, {
      type: "runtime_fallback",
      from: effectiveJob.requestedHardwareMode,
      to: "cpu",
      reason: entryProcess.fallbackReason,
    });
  }
  const entryArgs = Array.isArray(entry.args) ? entry.args : [];
  const args = [
    ...entryArgs.map((arg) => replacePlaceholders(arg, vars)),
    commandName,
    "--job",
    jobPath,
  ];
  const processLog = path.join(effectiveJob.outputDir, "engine-process.log");

  if (active.canceled) {
    sendJobEvent(sender, job.jobId, { type: "canceled" });
    releaseChildOwnership();
    throw canceledError();
  }
  if (pathState) await assertDirectoryIdentityState(pathState.outputDir, "Job output directory");
  let logOutput;
  try {
    logOutput = await openVerifiedExclusiveOutput(processLog, {
      rootDirectory: effectiveJob.outputDir,
      label: "Engine process log",
    });
  } catch (error) {
    releaseChildOwnership();
    throw error;
  }

  if (active.canceled) {
    sendJobEvent(sender, job.jobId, { type: "canceled" });
    releaseChildOwnership();
    await logOutput.handle.close().catch(() => {});
    await removeVerifiedPath(logOutput.path, {
      rootDirectory: logOutput.root,
      rootIdentity: logOutput.rootIdentity,
      parentDirectory: logOutput.parent,
      parentIdentity: logOutput.parentIdentity,
      identity: logOutput.identity,
    });
    throw canceledError();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let logWriteError = null;
    let logQueue = Promise.resolve();
    const appendLog = (chunk) => {
      const data = Buffer.from(chunk);
      logQueue = logQueue
        .then(() => logOutput.handle.write(data))
        .catch((error) => {
          logWriteError ||= error;
        });
    };
    const finishLog = async () => {
      let validationError = null;
      try {
        await logQueue;
        if (logWriteError) throw logWriteError;
        await verifyExclusiveOutput(logOutput, "Engine process log");
        if (pathState) await assertDirectoryIdentityState(pathState.outputDir, "Job output directory");
        await fsyncHandle(logOutput.handle);
      } catch (error) {
        validationError = error;
      } finally {
        await logOutput.handle.close().catch(() => {});
        logOutput = null;
      }
      if (validationError) throw validationError;
    };
    const settle = async (finalize) => {
      if (settled) return;
      settled = true;
      try {
        await finishLog();
      } catch (error) {
        reject(error);
        return;
      }
      finalize();
    };
    let child;
    try {
      child = spawn(entryProcess.command, args, {
        cwd: manifest.engineRoot,
        env: engineProcessEnv(manifest, effectiveJob, entryProcess.env),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      releaseChildOwnership();
      settle(() => reject(error));
      return;
    }
    active.child = child;
    if (active.canceled) killActiveChild(active);
    let stdoutBuffer = "";
    let stderrBuffer = "";

    child.stdout.on("data", (chunk) => {
      appendLog(chunk);
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const event = parseJsonLine(line) || { type: "log", stream: "stdout", message: line };
        sendJobEvent(sender, job.jobId, event);
      }
    });

    child.stderr.on("data", (chunk) => {
      appendLog(chunk);
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || "";
      for (const raw of lines) {
        const line = raw.trim();
        if (line) sendJobEvent(sender, job.jobId, { type: "log", stream: "stderr", message: line });
      }
    });

    child.on("error", (err) => {
      const wasCanceled = active.canceled;
      releaseChildOwnership();
      if (wasCanceled) {
        settle(() => reject(canceledError()));
        return;
      }
      sendJobEvent(sender, job.jobId, {
        type: "error",
        stage: "engine-process",
        message: err.message || "Engine process failed to start.",
      });
      settle(() => reject(err));
    });
    child.on("close", (code) => {
      const wasCanceled = active.canceled;
      releaseChildOwnership();
      if (stdoutBuffer.trim()) {
        const event = parseJsonLine(stdoutBuffer.trim()) || { type: "log", stream: "stdout", message: stdoutBuffer.trim() };
        sendJobEvent(sender, job.jobId, event);
      }
      if (stderrBuffer.trim()) {
        sendJobEvent(sender, job.jobId, { type: "log", stream: "stderr", message: stderrBuffer.trim() });
      }
      if (wasCanceled) {
        settle(() => reject(canceledError()));
        return;
      }
      if (code === 0) {
        settle(resolve);
      } else {
        const err = new Error(`Engine exited with code ${code}. See ${processLog}`);
        sendJobEvent(sender, job.jobId, {
          type: "error",
          stage: "engine-process",
          message: err.message,
        });
        settle(() => reject(err));
      }
    });
  });
}


async function demucsWorkspaceForId(userDataPath, audioSha256, separationId, settings = {}) {
  return demucsWorkspace.resolveDemucsWorkspace(
    cacheRoot(userDataPath, settings),
    audioSha256,
    separationId
  );
}

function isInsidePath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function findDemucsStemDir(workspace) {
  const queue = [path.resolve(workspace)];
  while (queue.length) {
    const dir = queue.shift();
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name.toLowerCase()));
    const hasAllStems = ["drums", "bass", "vocals", "other"].every((stem) =>
      ["flac", "wav"].some((ext) => names.has(`${stem}.${ext}`))
    );
    if (hasAllStems) return dir;
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push(path.join(dir, entry.name));
    }
  }
  return null;
}

async function demucsStemMap(stemDir) {
  if (!stemDir) return {};
  const stems = {};
  for (const stem of DEMUCS_STEMS) {
    for (const ext of ["flac", "wav"]) {
      const stemPath = path.join(stemDir, `${stem}.${ext}`);
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
          // Missing or unsafe stems are not cache hits.
        }
      }
    }
  }
  return stems;
}
async function readContainedOutputFile(outputDir, filePath, label, maxBytes = 64 * 1024 * 1024, expectedState = null) {
  const root = expectedState
    ? (await assertDirectoryIdentityState(expectedState.outputDir, "Job output directory")).path
    : (await directoryIdentityState(outputDir, "Job output directory")).path;
  const candidate = path.resolve(String(filePath || ""));
  if (!isInsidePath(root, candidate) || candidate === root) {
    throw new Error(`${label} is outside the job output directory.`);
  }
  await ensureRealDirectoryTree(root, path.dirname(candidate));
  return readVerifiedFile(candidate, { label, maxBytes });
}

async function generateChart(userDataPath, sender, payload, options = {}) {
  runtimeSelection.assertSupportedTarget(CURRENT_PLATFORM, process.arch);
  // Recovery overrides only this job. The user's saved hardware preference is
  // unchanged, and renderer payloads cannot request arbitrary providers.
  const settings = payload?.hardwareMode === "cpu"
    ? { ...options.settings, hardwareMode: "cpu", effectiveHardwareMode: "cpu" }
    : options.settings || {};
  const manifest = await loadManifest();
  if (!manifest.available) throw new Error(manifest.error || "Autochart engine is unavailable.");
  const generatorId = payload?.generatorId || manifest.generators[0]?.id;
  const generator = manifest.generators.find((item) => item.id === generatorId);
  if (!generator) throw new Error(`Unknown or unsupported generator for ${CURRENT_PLATFORM}: ${generatorId}`);
  if (!payload?.audio?.path) throw new Error("Choose path-backed audio before generating.");

  const requestedJobId = typeof payload?.jobId === "string" ? payload.jobId.trim() : "";
  const jobId = isValidJobId(requestedJobId) ? requestedJobId : crypto.randomUUID();
  if (ACTIVE_JOBS.has(jobId)) {
    throw new Error(`Generation job ${jobId} is already active.`);
  }
  if (terminalJobRecord(jobId)) {
    throw new Error(`Generation job ${jobId} is already completed.`);
  }
  registerActiveJob(jobId, "generate", sender);
  try {
    if (isJobCanceled(jobId)) {
      sendJobEvent(sender, jobId, { type: "canceled" });
      return { jobId, status: "canceled" };
    }
    const cachedAudio = await cacheAnalysisAudio(
      userDataPath,
      payload.audio,
      sourceTransformFromPayload(payload),
      settings
    );
    if (isJobCanceled(jobId)) {
      sendJobEvent(sender, jobId, { type: "canceled" });
      return { jobId, status: "canceled" };
    }
    // Tell the renderer where the run's analysis audio lives as soon as it is
    // cached. When the run uses lead-in silence this is the PADDED source — the
    // timeline the chart is being written in — and the live generation board
    // needs it to play the in-flight chart on the same clock as the final take.
    sendJobEvent(sender, jobId, {
      type: "analysis_audio",
      path: cachedAudio.audioPath,
      leadInSilenceMs: Number(cachedAudio.sourceTransform?.leadInSilenceMs) || 0,
    });
    const { jobDir, outputDir, jobPath, state: pathState } = await prepareJobPaths(userDataPath, jobId, settings);
    if (isJobCanceled(jobId)) {
      sendJobEvent(sender, jobId, { type: "canceled" });
      return { jobId, status: "canceled" };
    }
    await assertJobPathState(pathState);
    const sourceChart = await writeSourceChartForJob(jobDir, payload);

    const metadata = payload.metadata || {};
    const title = payload.title || metadata.title || path.basename(payload.audio.name || "Untitled", path.extname(payload.audio.name || ""));
    const generation = normalizeGenerationPayload(payload.generation, generatorId, generator);
    const demucsSeparation = plainObject(payload.demucsSeparation);
    const separationId = demucsWorkspace.separationIdFromPayload(
      demucsSeparation,
      DEFAULT_DEMUCS_ID
    );
    const requestedDemucsSourceTransform = separationId === DEFAULT_DEMUCS_ID
      ? cachedAudio.sourceTransform
      : demucsSeparation.sourceTransform || cachedAudio.sourceTransform || null;
    const demucsCompatible = !demucsSeparation.id ||
      (requestedDemucsSourceTransform?.key || "lead-in:0") === (cachedAudio.sourceTransform?.key || "lead-in:0");
    const demucsSourceTransform = separationId === DEFAULT_DEMUCS_ID
      ? cachedAudio.sourceTransform
      : demucsCompatible
        ? requestedDemucsSourceTransform
        : cachedAudio.sourceTransform;
    const selectedDemucsWorkspace = await demucsWorkspaceForId(
      userDataPath,
      cachedAudio.sha256,
      separationId,
      settings
    );
    const demucsSeparationPayload = demucsSeparation.id && demucsCompatible
      ? {
          id: separationId,
          name: demucsSeparation.name || "Selected separation",
          profile: demucsSeparation.profile || "Standard Demucs",
          sourceTransform: demucsSourceTransform,
          sourceVariantKey: demucsSourceTransform?.key || demucsSeparation.sourceVariantKey || "lead-in:0",
        }
      : null;
    const job = {
      schemaVersion: 1,
      jobId,
      generatorId,
      generatorLabel: generator.label,
      generator,
      engineVersion: manifest.engineVersion,
      audioPath: cachedAudio.audioPath,
      audioSha256: cachedAudio.sha256,
      originalAudioSha256: cachedAudio.originalAudioSha256 || cachedAudio.sha256,
      audioIdentity: cachedAudio.identity || null,
      sourceTransform: cachedAudio.sourceTransform,
      ...(sourceChart ? { sourceChart } : {}),
      outputDir,
      cacheDir: cacheRoot(userDataPath, settings),
      title,
      metadata,
      difficulty: payload.difficulty || "expert",
      stripSustains: booleanValue(payload.stripSustains, generation.resolved.stripSustains),
      generation,
      ...hardwareDeviceOverrides(settings),
      hardwareMode: settings.hardwareMode || "auto",
      ...(demucsSeparationPayload ? { demucsSeparation: demucsSeparationPayload } : {}),
      demucsWorkspace: selectedDemucsWorkspace,
      engine: {
        platform: CURRENT_PLATFORM,
        runtime: generator.runtime?.current || null,
        modelsFolder: settings.modelsFolder || "",
        modelRoots: modelManager.rootCandidates(settings, manifest),
      },
      createdAt: Date.now(),
    };
    await writeVerifiedAtomic(jobPath, `${JSON.stringify(job, null, 2)}\n`, {
      rootDirectory: jobDir,
      label: "Engine job",
    });
    if (isJobCanceled(jobId)) {
      sendJobEvent(sender, jobId, { type: "canceled" });
      return { jobId, status: "canceled" };
    }
    sendJobEvent(sender, jobId, { type: "stage", stage: "queued", status: "completed" });

    await runEngineProcess({ sender, manifest, job, jobPath, pathState });
    await assertJobPathState(pathState);

    const resultPath = path.join(outputDir, "result.json");
    let resultRead;
    try {
      resultRead = await readContainedOutputFile(
        outputDir,
        resultPath,
        "Engine result JSON",
        64 * 1024 * 1024,
        pathState
      );
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    const result = resultRead ? JSON.parse(resultRead.data.toString("utf8")) : null;
    if (!result) throw new Error(`Engine did not write result.json: ${resultPath}`);
    if (isJobCanceled(jobId)) return { jobId, status: "canceled" };
    if (result.status !== "completed") {
      throw new Error(
        `Engine generation failed${result.failedStage ? ` at ${result.failedStage}` : ""}: ${result.error || "unknown error"}`
      );
    }
    let chartRead;
    try {
      chartRead = await readContainedOutputFile(
        outputDir,
        result.chartPath,
        "Generated chart",
        128 * 1024 * 1024,
        pathState
      );
    } catch {
      throw new Error(`Engine result has no readable chart: ${result.chartPath || "missing"}`);
    }
    const chartText = chartRead.data.toString("utf8");
    let report = null;
    if (result.reportPath) {
      const reportRead = await readContainedOutputFile(
        outputDir,
        result.reportPath,
        "Generated chart report",
        64 * 1024 * 1024,
        pathState
      );
      report = JSON.parse(reportRead.data.toString("utf8"));
    }
    if (result.timingPath) {
      await readContainedOutputFile(outputDir, result.timingPath, "Generated timing cache", 64 * 1024 * 1024, pathState);
    }
    const demucsWorkspacePath = await demucsWorkspaceForId(
      userDataPath,
      cachedAudio.sha256,
      separationId,
      settings
    );
    const demucsStemDir = await findDemucsStemDir(demucsWorkspacePath);
    const demucsStems = await demucsStemMap(demucsStemDir);
    const sourceSeparationBase = result.sourceSeparation || result.provenance?.sourceSeparation || job.demucsSeparation || null;
    const sourceSeparation = sourceSeparationBase
      ? {
          ...sourceSeparationBase,
          sourceTransform: sourceSeparationBase.sourceTransform || cachedAudio.sourceTransform || null,
          sourceVariantKey: sourceSeparationBase.sourceVariantKey || cachedAudio.sourceTransform?.key || "lead-in:0",
          cache: {
            workspace: demucsWorkspacePath,
            ...(demucsStemDir ? { stemDir: demucsStemDir } : {}),
          },
          ...(Object.keys(demucsStems).length ? { stems: demucsStems } : {}),
        }
      : null;
    sendJobEvent(sender, jobId, { type: "stage", stage: "saved", status: "completed" });
    return {
      ...result,
      jobId,
      status: "completed",
      generatorId,
      generatorLabel: generator.label,
      audioSha256: cachedAudio.sha256,
      originalAudioSha256: cachedAudio.originalAudioSha256 || cachedAudio.sha256,
      analysisAudioSha256: cachedAudio.sha256,
      analysisAudioPath: cachedAudio.audioPath,
      sourceTransform: cachedAudio.sourceTransform,
      chartText,
      report,
      sourceSeparation,
    };
  } catch (err) {
    if (err?.code === "CANCELED" || isJobCanceled(jobId)) {
      return { jobId, status: "canceled" };
    }
    throw err;
  } finally {
    deregisterActiveJob(jobId);
  }
}

async function prepareDemucs(userDataPath, sender, payload, options = {}) {
  runtimeSelection.assertSupportedTarget(CURRENT_PLATFORM, process.arch);
  const settings = options.settings || {};
  const manifest = await loadManifest();
  if (!manifest.available) throw new Error(manifest.error || "Autochart engine is unavailable.");
  const generatorId = payload?.generatorId || manifest.generators[0]?.id;
  const generator = manifest.generators.find((item) => item.id === generatorId) || manifest.generators[0];
  if (!generator) throw new Error(`Unknown or unsupported generator for ${CURRENT_PLATFORM}: ${generatorId}`);
  if (!payload?.audio?.path) throw new Error("Choose path-backed audio before preparing Demucs.");

  const requestedJobId = typeof payload?.jobId === "string" ? payload.jobId.trim() : "";
  const jobId = isValidJobId(requestedJobId) ? requestedJobId : crypto.randomUUID();
  if (ACTIVE_JOBS.has(jobId)) {
    throw new Error(`Preparation job ${jobId} is already active.`);
  }
  if (terminalJobRecord(jobId)) {
    throw new Error(`Preparation job ${jobId} is already completed.`);
  }
  registerActiveJob(jobId, "prepare-demucs", sender);
  try {
    if (isJobCanceled(jobId)) throw canceledError();
  const cachedAudio = await cacheAnalysisAudio(
    userDataPath,
    payload.audio,
    sourceTransformFromPayload(payload),
    settings
  );
  if (isJobCanceled(jobId)) throw canceledError();
  const separationId = demucsWorkspace.assertSeparationId(
    textValue(payload.separationId, DEFAULT_DEMUCS_ID)
  );
  const separationName = textValue(
    payload.name,
    separationId === DEFAULT_DEMUCS_ID ? "Default separation" : "Regenerated separation"
  );
  const workspace = await demucsWorkspaceForId(
    userDataPath,
    cachedAudio.sha256,
    separationId,
    settings
  );
  const { jobDir, outputDir, jobPath, state: pathState } = await prepareJobPaths(userDataPath, jobId, settings);
  await assertJobPathState(pathState);
  if (isJobCanceled(jobId)) throw canceledError();

  const metadata = payload.metadata || {};
  const title = payload.title || metadata.title || path.basename(payload.audio.name || "Untitled", path.extname(payload.audio.name || ""));
  const job = {
    schemaVersion: 1,
    jobId,
    command: "prepare-demucs",
    generatorId: generator.id,
    generatorLabel: generator.label,
    generator,
    engineVersion: manifest.engineVersion,
    audioPath: cachedAudio.audioPath,
    audioSha256: cachedAudio.sha256,
    originalAudioSha256: cachedAudio.originalAudioSha256 || cachedAudio.sha256,
    audioIdentity: cachedAudio.identity || null,
    sourceTransform: cachedAudio.sourceTransform,
    outputDir,
    cacheDir: cacheRoot(userDataPath, settings),
    title,
    metadata,
    demucsWorkspace: workspace,
    ...hardwareDeviceOverrides(settings),
    hardwareMode: settings.hardwareMode || "auto",
    demucsSeparation: {
      id: separationId,
      name: separationName,
      profile: "Standard Demucs",
    },
    engine: {
      platform: CURRENT_PLATFORM,
      runtime: generator.runtime?.current || null,
      modelsFolder: settings.modelsFolder || "",
      modelRoots: modelManager.rootCandidates(settings, manifest),
    },
    createdAt: Date.now(),
  };
  await writeVerifiedAtomic(jobPath, `${JSON.stringify(job, null, 2)}\n`, {
    rootDirectory: jobDir,
    label: "Engine job",
  });
  await assertJobPathState(pathState);
  if (isJobCanceled(jobId)) throw canceledError();
  sendJobEvent(sender, jobId, { type: "stage", stage: "queued", status: "completed" });

    await runEngineProcess({ sender, manifest, job, jobPath, commandName: "prepare-demucs", pathState });
    await assertJobPathState(pathState);

    const resultPath = path.join(outputDir, "result.json");
    let resultRead;
    try {
      resultRead = await readContainedOutputFile(
        outputDir,
        resultPath,
        "Engine result JSON",
        64 * 1024 * 1024,
        pathState
      );
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
    const result = resultRead ? JSON.parse(resultRead.data.toString("utf8")) : null;
    if (!result) throw new Error(`Engine did not write result.json: ${resultPath}`);
  if (isJobCanceled(jobId)) throw canceledError();
  if (result.status !== "completed") {
    throw new Error(
      `Demucs preparation failed${result.failedStage ? ` at ${result.failedStage}` : ""}: ${result.error || "unknown error"}`
    );
  }
  await demucsWorkspace.ensureContainedDirectory(
    cacheRoot(userDataPath, settings),
    workspace,
    { create: false }
  );
  const stemDir = await findDemucsStemDir(workspace);
  const stems = await demucsStemMap(stemDir);
  if (isJobCanceled(jobId)) throw canceledError();
  sendJobEvent(sender, jobId, { type: "stage", stage: "saved", status: "completed" });
  return {
    ...result,
    id: separationId,
    name: separationName,
    jobId,
    status: "completed",
    generatorId: generator.id,
    generatorLabel: generator.label,
    audioSha256: cachedAudio.sha256,
    originalAudioSha256: cachedAudio.originalAudioSha256 || cachedAudio.sha256,
    sourceTransform: cachedAudio.sourceTransform,
    profile: "Standard Demucs",
    stems,
    cache: {
      workspace,
      stemDir,
    },
  };
  } catch (err) {
    if (err?.code === "CANCELED" || isJobCanceled(jobId)) {
      sendJobEvent(sender, jobId, { type: "canceled" });
      throw canceledError();
    }
    throw err;
  } finally {
    deregisterActiveJob(jobId);
  }
}

async function readDemucsStem(userDataPath, stemPath, options = {}) {
  const raw = String(stemPath || "").trim();
  if (!raw) throw new Error("No stem path was provided.");
  const candidate = path.resolve(raw);
  const roots = [
    cacheRoot(userDataPath, options.settings),
    options.settings?.legacyCacheFolder
      ? path.join(options.settings.legacyCacheFolder, "engine")
      : "",
    path.join(userDataPath, "cache", "engine"),
  ].filter(Boolean);
  const canonicalRoots = [];
  for (const root of [...new Set(roots.map((item) => path.resolve(item)))]) {
    try {
      canonicalRoots.push(await fs.realpath(root));
    } catch {
      /* unavailable cache root */
    }
  }
  const opened = await openVerifiedFile(candidate, { label: "Engine cache stem" });
  try {
    const canonicalFile = await fs.realpath(opened.path);
    if (!canonicalRoots.some((root) => isInsidePath(root, canonicalFile) && root !== canonicalFile)) {
      throw new Error("Stem path is outside the Autochart engine cache.");
    }
    const read = await readHandle(opened.handle, { label: "Engine cache stem" });
    if (!sameIdentity(opened.identity, read.identity)) {
      throw new Error("Engine cache stem changed while it was being read.");
    }
    return read.data;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

module.exports = {
  loadManifest,
  generateChart,
  cancelJob,
  prepareDemucs,
  readDemucsStem,
  cacheAudio,
  cacheAnalysisAudio,
  resolveEntryProcess,
  rewriteJobForCpu,
};

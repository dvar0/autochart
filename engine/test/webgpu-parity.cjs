"use strict";

// Autochart ONNX WebGPU parity gate (milestone 5).
//
// Standalone, no test framework. Drives the real ONNX graphs through the
// device-resident WebGPU path and compares against the CPU path.
//
// Sections:
//   A) WebGPU availability: assert ort.listSupportedBackends() includes a
//      bundled webgpu EP and a real WebGPU session creates. If WebGPU is NOT
//      available in this environment, SKIP with a clear message and exit 0
//      (the wiring + CPU fallback are still correct; the separate CPU gates
//      cover the CPU path).
//   B) Demucs WebGPU vs CPU: separate the SAME decoded wav on both devices;
//      per-stem SDR with CPU as ref. PASS if every stem >= 40 dB.
//   C) Decoder per-step logit closeness: encoder+decoder on WebGPU and CPU
//      with the SAME beat_mel and SAME forced token sequence (~200 steps).
//      PASS if max|Δlogits| <= 5e-2. Also report greedy argmax divergence
//      (informational only -- divergence is allowed, just quantified).
//   D) End-to-end WebGPU generate: run the real generateOnnx on WebGPU
//      (via a job.json), assert all stage events + valid non-empty
//      notes.chart + status completed. Compare wall time + note count to a
//      CPU run of the same song (the payoff number).
//
// Usage:
//   node engine/test/webgpu-parity.cjs [--audio <path>] [--models-folder <path>]
//                                     [--tmp-dir <path>]
//                                     [--steps <int>] [--skip-e2e]
//
// Default audio: shortest song.ogg under $AUTOCHART_TEST_AUDIO_ROOT if set,
// else the repo demo fixture.
//
// Exit 0 if A passed and B+C+D pass (or A skipped on a WebGPU-less box);
// exit 1 on any required failure.

const path = require("path");
const fs = require("fs");
const fsPromises = require("fs/promises");
const os = require("os");
const { spawn } = require("child_process");
const crypto = require("crypto");

const REPO = path.resolve(__dirname, "..", "..");
const ENGINE_ROOT = path.resolve(__dirname, "..");
const ENGINE_BIN = path.join(ENGINE_ROOT, "bin", "autochart-engine.cjs");
// Optional local library of <song>/song.ogg folders to pick test audio from.
const MODEL_REPO_CUSTOMS = process.env.AUTOCHART_TEST_AUDIO_ROOT || "";
const REPO_DEMO_AUDIO = path.join(REPO, "fixtures", "demo", "autochart-demo-30s.wav");
const E2E_DIFFICULTY = "hard";
const E2E_NOTE_SECTION = "HardSingle";

const onnxLib = require(path.join(ENGINE_ROOT, "lib", "onnx"));
const demucsWorkspace = require(path.join(REPO, "electron", "demucsWorkspace.cjs"));

function log(...args) {
  process.stderr.write(args.map((a) => (typeof a === "string" ? a : String(a))).join(" ") + "\n");
}

function parseArgs(argv) {
  const out = { audio: "", modelsFolder: "", tmpDir: "", steps: 200, skipE2e: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--audio") out.audio = argv[++i];
    else if (a === "--models-folder") out.modelsFolder = path.resolve(argv[++i]);
    else if (a === "--tmp-dir") out.tmpDir = argv[++i];
    else if (a === "--steps") out.steps = Number.parseInt(argv[++i], 10) || 200;
    else if (a === "--skip-e2e") out.skipE2e = true;
  }
  return out;
}

function assertSelectedModelsFolder(modelsFolder) {
  if (!modelsFolder) return;
  const nested = path.join(modelsFolder, "fretformer-v1", "manifest.json");
  const direct = path.join(modelsFolder, "manifest.json");
  if (!fs.existsSync(nested) && !fs.existsSync(direct)) {
    throw new Error(
      `--models-folder does not contain a Fretformer manifest: ${modelsFolder}. ` +
      "Refusing to fall back to development models."
    );
  }
}

function ffprobePath() {
  const override = String(process.env.AUTOCHART_FFPROBE_PATH || "").trim();
  if (override) return override;
  const ffmpeg = onnxLib.resolveFfmpegPath();
  const candidate = ffmpeg.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
  try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  return "ffprobe";
}

function ffprobeDuration(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath(), [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", file,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => { out += c.toString(); });
    child.on("error", reject);
    child.on("close", () => resolve(parseFloat(out.trim())));
  });
}

async function pickShortestAudio(root) {
  const candidates = [];
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name, "song.ogg");
    if (fs.existsSync(full)) candidates.push(full);
  }
  if (!candidates.length) return null;
  let best = null, bestDur = Infinity;
  for (const c of candidates) {
    const d = await ffprobeDuration(c);
    if (Number.isFinite(d) && d < bestDur) { bestDur = d; best = c; }
  }
  return best ? { path: best, duration: bestDur } : null;
}

function resolveTmpDir(arg) {
  if (arg) { fs.mkdirSync(arg, { recursive: true }); return fs.realpathSync(arg); }
  const candidates = [
    path.join(os.tmpdir(), "autochart-webgpu-parity"),
    path.join(REPO, "node_modules", ".cache", "webgpu-parity"),
  ];
  for (const c of candidates) {
    try { fs.mkdirSync(c, { recursive: true }); fs.accessSync(c, fs.constants.W_OK); return fs.realpathSync(c); } catch { /* */ }
  }
  return path.join(REPO, "node_modules", ".cache", "webgpu-parity");
}

function printTable(cols, rows) {
  const widths = cols.map((c, i) => Math.max(String(c).length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (cells) => "| " + cells.map((c, i) => String(c).padEnd(widths[i])).join(" | ") + " |";
  const sep = "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|";
  log("");
  log(line(cols));
  log(sep);
  for (const row of rows) log(line(row));
  log(sep);
  log("");
}

// ----------------------------- Section A ---------------------------------

async function sectionA(modelsFolder) {
  log("\n========== Section A: WebGPU availability ==========");
  const backends = onnxLib.webgpuBackendBundled();
  log(`[A] listSupportedBackends reports webgpu bundled: ${backends}`);
  if (!backends) {
    log("[A] webgpu backend NOT bundled in this onnxruntime-node build.");
    return { ok: false, skip: true, reason: "webgpu not bundled" };
  }
  // Try to create a real WebGPU session (compile-time support != runtime device).
  const manifest = await onnxLib.loadModelsManifest(ENGINE_ROOT, {
    engine: { modelsFolder: modelsFolder || "" },
  });
  const encPath = onnxLib.graphPath(manifest, "transcriber-encoder");
  try {
    const probe = await onnxLib.createSession(encPath, {
      device: "webgpu",
      preferredOutputLocation: { aligned_memory: "gpu-buffer", cross_k: "gpu-buffer", cross_v: "gpu-buffer" },
    });
    const actual = onnxLib.sessionDevice ? onnxLib.sessionDevice(probe, "unknown") : "unknown";
    if (actual !== "webgpu") {
      const reason = `requested WebGPU initialized ${actual || "unknown"} provider`;
      log(`[A] WebGPU provider gate FAILED: ${reason}`);
      return { ok: false, skip: true, reason };
    }
    log("[A] WebGPU encoder session created with actual WebGPU provider.");
    return { ok: true, skip: false, manifest };
  } catch (err) {
    log(`[A] WebGPU session creation FAILED: ${err && err.message ? err.message : err}`);
    log("[A] WebGPU is bundled but no usable GPU device at runtime -- skipping WebGPU sections.");
    return { ok: false, skip: true, reason: err && err.message ? err.message : String(err) };
  }
}

// ----------------------------- Section B ---------------------------------

async function sectionB(manifest, audioPath, work) {
  log("\n========== Section B: Demucs WebGPU vs CPU (per-stem SDR) ==========");
  const orch = onnxLib.demucsOrchestration(manifest);
  log(`[B] decoding ${audioPath} -> ${orch.sampleRate}Hz stereo`);
  const decoded = await onnxLib.decodeStereoF32(audioPath, { sampleRate: orch.sampleRate });
  const L = decoded.length;
  const planar = new Float32Array(2 * L);
  planar.set(decoded.left, 0);
  planar.set(decoded.right, L);
  log(`[B] ${L} samples (${(L / orch.sampleRate).toFixed(1)}s)`);
  log("[B] loading CPU demucs sessions...");
  const cpuSessions = await onnxLib.loadDemucsSessions(manifest, "cpu");
  if (cpuSessions.device !== "cpu") {
    throw new Error(`CPU control initialized ${cpuSessions.device || "unknown"} provider.`);
  }
  const tCpu = Date.now();
  const cpuStems = await onnxLib.separate(planar, L, cpuSessions, orch, { log: (m) => log(`  [cpu]  ${m}`) });
  const cpuSecs = (Date.now() - tCpu) / 1000;
  log(`[B] CPU demucs: ${cpuSecs.toFixed(1)}s (actual provider=cpu)`);

  log("[B] loading WebGPU demucs sessions...");
  const gpuSessions = await onnxLib.loadDemucsSessions(manifest, "webgpu");
  if (gpuSessions.device !== "webgpu") {
    throw new Error(`WebGPU run initialized ${gpuSessions.device || "unknown"} provider; fallback is not a parity pass.`);
  }
  const tGpu = Date.now();
  const gpuStems = await onnxLib.separate(planar, L, gpuSessions, orch, { log: (m) => log(`  [gpu]  ${m}`) });
  const gpuSecs = (Date.now() - tGpu) / 1000;
  log(`[B] WebGPU demucs: ${gpuSecs.toFixed(1)}s (actual provider=webgpu)`);


  // Per-stem SDR with CPU as ref. SDR = 10*log10(Σref²/Σ(ref−est)²).
  const names = orch.sources.slice();
  const rows = [];
  let allPass = true;
  for (const name of names) {
    const ref = cpuStems.find((s) => s.name === name);
    const est = gpuStems.find((s) => s.name === name);
    if (!ref || !est) { rows.push([name, "MISSING", "-", "FAIL"]); allPass = false; continue; }
    const n = Math.min(ref.left.length, est.left.length, ref.right.length, est.right.length);
    let sumRefSq = 0, sumErrSq = 0, maxAbs = 0;
    for (const ch of ["left", "right"]) {
      for (let i = 0; i < n; i += 1) {
        const r = ref[ch][i], e = est[ch][i];
        sumRefSq += r * r;
        const err = r - e;
        sumErrSq += err * err;
        const d = Math.abs(err);
        if (d > maxAbs) maxAbs = d;
      }
    }
    const sdr = sumErrSq > 0 ? 10 * Math.log10(sumRefSq / sumErrSq) : Infinity;
    const ok = sdr >= 40;
    if (!ok) allPass = false;
    rows.push([name, maxAbs.toExponential(3), isFinite(sdr) ? sdr.toFixed(3) : "inf", ok ? "PASS" : "FAIL"]);
  }
  printTable(["stem", "max|Δ|", "SDR (dB)", "≥40dB"], rows);
  log(`[B] CPU ${cpuSecs.toFixed(1)}s vs WebGPU ${gpuSecs.toFixed(1)}s (speedup ${(cpuSecs / Math.max(gpuSecs, 0.001)).toFixed(2)}x)`);
  log(`[B] PASS bar: every stem SDR >= 40 dB -> ${allPass ? "PASS" : "FAIL"}`);

  // Persist CPU stems as wavs for section C (beat_mel build reuses them).
  const stemsDir = path.join(work, "stems_cpu");
  fs.mkdirSync(stemsDir, { recursive: true });
  const stemPaths = {};
  for (const stem of cpuStems) {
    const p = path.join(stemsDir, `${stem.name}.wav`);
    await onnxLib.writeStereoWav(p, stem.left, stem.right, orch.sampleRate, { bits: 32 });
    stemPaths[stem.name] = p;
  }
  return { pass: allPass, cpuSecs, gpuSecs, stemPaths };
}

// ----------------------------- Section C ---------------------------------

// stepBeatIdx mirrors generate()'s beat-index selection.
function stepBeatIdx(beatsEmitted, nBeats) {
  return Math.min(Math.max(beatsEmitted - 1, 0), Math.max(nBeats - 1, 0));
}

// Greedy single-stream decode for `nSteps` steps. Records the FED token at each
// step (prefix for step<prefixLen, else the previous argmax) plus the per-step
// logits and the masked argmax. Uses the device-resident runDecoderStep +
// dispose lifecycle, so WebGPU exercises gpu-buffer K/V reuse.
async function greedyDecode({ encoderSession, decoderSession, beatMel, beatMask, nBeats, prefixTokens, prefixBias, nSteps, modelConfig }) {
  const nLayers = Number(modelConfig.nLayers || 10);
  const nHead = Number(modelConfig.nhead || 8);
  const headDim = Number(modelConfig.headDim || 64);
  const encCtx = await onnxLib.runEncoder(encoderSession, beatMel, beatMask, nBeats);
  const ctx = { nLayers, nHead, headDim, alignedMemory: encCtx.alignedMemory, crossK: encCtx.crossK, crossV: encCtx.crossV, memInvalid: encCtx.memInvalid };
  const fedTokens = [];
  const argmaxTokens = [];
  const perStepLogits = [];
  const beatsEmittedPerStep = [];
  let pk = new Float32Array(0), pv = new Float32Array(0);
  let beatsEmitted = 0;
  let nextToken = null;
  try {
    for (let step = 0; step < nSteps; step += 1) {
      const beatIdx = stepBeatIdx(beatsEmitted, nBeats);
      const token = step < prefixTokens.length ? prefixTokens[step] : nextToken;
      fedTokens.push(token);
      const r = await onnxLib.runDecoderStep(decoderSession, token, step, beatIdx, ctx, prefixBias, pk, pv);
      onnxLib.disposeGpuTensor(pk); onnxLib.disposeGpuTensor(pv);
      pk = r.presentK; pv = r.presentV;
      perStepLogits.push(r.logits);
      beatsEmittedPerStep.push(beatsEmitted);
      const picked = onnxLib.greedyArgmax(r.logits, nBeats, beatsEmitted);
      argmaxTokens.push(picked);
      if (picked === onnxLib.BEAT_TOKEN) beatsEmitted += 1;
      nextToken = picked;
    }
  } finally {
    onnxLib.disposeGpuTensor(pk); onnxLib.disposeGpuTensor(pv);
    onnxLib.disposeGpuTensor(ctx.alignedMemory); onnxLib.disposeGpuTensor(ctx.crossK);
    onnxLib.disposeGpuTensor(ctx.crossV); onnxLib.disposeGpuTensor(ctx.memInvalid);
  }
  return { fedTokens, argmaxTokens, perStepLogits, beatsEmittedPerStep };
}

// Forced single-stream decode: feed `forcedTokens[step]` at each step, record
// logits. `beatsEmittedPerStep` must match the greedy run so masked argmax uses
// the same per-step state.
async function forcedDecode({ encoderSession, decoderSession, beatMel, beatMask, nBeats, prefixTokens, prefixBias, forcedTokens, beatsEmittedPerStep, modelConfig }) {
  const nLayers = Number(modelConfig.nLayers || 10);
  const nHead = Number(modelConfig.nhead || 8);
  const headDim = Number(modelConfig.headDim || 64);
  const encCtx = await onnxLib.runEncoder(encoderSession, beatMel, beatMask, nBeats);
  const ctx = { nLayers, nHead, headDim, alignedMemory: encCtx.alignedMemory, crossK: encCtx.crossK, crossV: encCtx.crossV, memInvalid: encCtx.memInvalid };
  const perStepLogits = [];
  const argmaxTokens = [];
  let pk = new Float32Array(0), pv = new Float32Array(0);
  try {
    for (let step = 0; step < forcedTokens.length; step += 1) {
      const beatsEmitted = beatsEmittedPerStep[step] != null ? beatsEmittedPerStep[step] : 0;
      const beatIdx = stepBeatIdx(beatsEmitted, nBeats);
      const r = await onnxLib.runDecoderStep(decoderSession, forcedTokens[step], step, beatIdx, ctx, prefixBias, pk, pv);
      onnxLib.disposeGpuTensor(pk); onnxLib.disposeGpuTensor(pv);
      pk = r.presentK; pv = r.presentV;
      perStepLogits.push(r.logits);
      argmaxTokens.push(onnxLib.greedyArgmax(r.logits, nBeats, beatsEmitted));
    }
  } finally {
    onnxLib.disposeGpuTensor(pk); onnxLib.disposeGpuTensor(pv);
    onnxLib.disposeGpuTensor(ctx.alignedMemory); onnxLib.disposeGpuTensor(ctx.crossK);
    onnxLib.disposeGpuTensor(ctx.crossV); onnxLib.disposeGpuTensor(ctx.memInvalid);
  }
  return { perStepLogits, argmaxTokens };
}

async function buildBeatMelForCompare(manifest, audioPath, stemPaths, device = "cpu") {
  // Mirror generateOnnx's feature-build: decode full mix + 4 stems to mono 22050,
  // run beat detect (CPU), build beat_mel.
  const melSession = await onnxLib.loadMelSession(manifest, device);
  const beatSessions = await onnxLib.loadBeatSessions(manifest, device);
  const orch = onnxLib.beatOrchestration(manifest);
  const fullStereo = await onnxLib.decodeStereoF32(audioPath, { sampleRate: 22050 });
  const fullMono = new Float32Array(fullStereo.length);
  for (let i = 0; i < fullStereo.length; i += 1) fullMono[i] = 0.5 * (fullStereo.left[i] + fullStereo.right[i]);
  const audioDuration = fullStereo.length / 22050;
  const stemMonos = {};
  for (const name of ["drums", "bass", "vocals", "other"]) {
    const s = await onnxLib.decodeStereoF32(stemPaths[name], { sampleRate: 22050 });
    const mono = new Float32Array(s.length);
    for (let i = 0; i < s.length; i += 1) mono[i] = 0.5 * (s.left[i] + s.right[i]);
    stemMonos[name] = mono;
  }
  const mono22050 = await onnxLib.decodeMono(audioPath, { sampleRate: orch.sampleRate });
  const beats = await onnxLib.detectBeats(mono22050, manifest, beatSessions, orch, { log: () => {} });
  const beatTimes = Float64Array.from(beats.beatTimes);
  const stage = manifest.stages && manifest.stages.transcriber ? manifest.stages.transcriber : {};
  const modelConfig = (stage && stage.modelConfig) || {};
  const maxBeats = Number(modelConfig.maxBeats || 1280);
  const { beatMel, beatMask, nBeats } = await onnxLib.buildBeatMel({
    melSession, fullMono22050: fullMono, stemMonos22050: stemMonos,
    beatTimes, maxBeats, audioDuration, log: () => {},
  });
  return { beatMel, beatMask, nBeats, modelConfig, audioDuration };
}

function buildSimplePrefix(manifest) {
  // Single-stream (guidanceScale=1, no CFG): BOS + difficulty(expert) +
  // descriptors all-auto. Exercises the full decoder + device-resident cache.
  const stage = manifest.stages && manifest.stages.transcriber ? manifest.stages.transcriber : {};
  const prefixConditioning = stage && stage.prefixConditioning ? stage.prefixConditioning : null;
  const descNames = onnxLib.DESCRIPTOR_NAMES;
  const prefixTokens = [onnxLib.BOS_TOKEN, onnxLib.difficultyToken("expert")];
  for (let k = 0; k < descNames.length; k += 1) prefixTokens.push(onnxLib.descriptorToken(k, onnxLib.DESC_AUTO_BIN));
  let prefixBias = new Float32Array(Number((stage && stage.modelConfig && stage.modelConfig.dModel) || 512));
  if (prefixConditioning && prefixConditioning.file) {
    const tablesPath = path.join(manifest.folder, prefixConditioning.file);
    const tables = onnxLib.loadNpz(tablesPath);
    const dModel = Number((stage && stage.modelConfig && stage.modelConfig.dModel) || 512);
    const descPrefixScan = Number(prefixConditioning.descPrefixScan || 8);
    prefixBias = onnxLib.computePrefixBias(prefixTokens, {
      descPrefixScan,
      pervasiveDifficulty: Boolean(prefixConditioning.pervasiveDifficulty),
      pervasiveDescriptors: Boolean(prefixConditioning.pervasiveDescriptors),
      dModel, tables,
    });
  }
  return { prefixTokens, prefixBias };
}

async function sectionC(manifest, audioPath, stemPaths, nSteps) {
  log("\n========== Section C: Decoder per-step logit closeness (WebGPU vs CPU) ==========");
  log("[C] building beat_mel on CPU (shared input for both devices)...");
  const { beatMel, beatMask, nBeats, modelConfig } = await buildBeatMelForCompare(manifest, audioPath, stemPaths, "cpu");
  log(`[C] beat_mel [1, ${nBeats}, 5, 80, 32]; ${nSteps} decode steps`);

  const { prefixTokens, prefixBias } = buildSimplePrefix(manifest);

  log("[C] loading CPU encoder+decoder...");
  const cpuEnc = await onnxLib.loadEncoderSessions(manifest, "cpu");
  const cpuDec = await onnxLib.loadDecoderSession(manifest, "cpu");
  if (
    (onnxLib.sessionDevice && onnxLib.sessionDevice(cpuEnc, "unknown") !== "cpu") ||
    (onnxLib.sessionDevice && onnxLib.sessionDevice(cpuDec, "unknown") !== "cpu")
  ) {
    throw new Error("CPU control did not initialize CPU execution providers.");
  }
  log("[C] CPU greedy decode (actual provider=cpu)...");
  const tCpu = Date.now();
  const cpuRun = await greedyDecode({
    encoderSession: cpuEnc, decoderSession: cpuDec,
    beatMel, beatMask, nBeats, prefixTokens, prefixBias, nSteps, modelConfig,
  });
  const cpuSecs = (Date.now() - tCpu) / 1000;
  log(`[C] CPU: ${nSteps} steps in ${cpuSecs.toFixed(2)}s (${(cpuSecs * 1000 / nSteps).toFixed(2)} ms/step)`);

  log("[C] loading WebGPU encoder+decoder...");
  const gpuEnc = await onnxLib.loadEncoderSessions(manifest, "webgpu");
  const gpuDec = await onnxLib.loadDecoderSession(manifest, "webgpu");
  if (
    !onnxLib.sessionDevice ||
    onnxLib.sessionDevice(gpuEnc, "unknown") !== "webgpu" ||
    onnxLib.sessionDevice(gpuDec, "unknown") !== "webgpu"
  ) {
    throw new Error("WebGPU parity run fell back to a non-WebGPU provider.");
  }
  log("[C] WebGPU forced decode (actual provider=webgpu)...");
  const tGpu = Date.now();
  const gpuRun = await forcedDecode({
    encoderSession: gpuEnc, decoderSession: gpuDec,
    beatMel, beatMask, nBeats, prefixTokens, prefixBias,
    forcedTokens: cpuRun.fedTokens, beatsEmittedPerStep: cpuRun.beatsEmittedPerStep, modelConfig,
  });
  const gpuSecs = (Date.now() - tGpu) / 1000;
  log(`[C] WebGPU: ${nSteps} steps in ${gpuSecs.toFixed(2)}s (${(gpuSecs * 1000 / nSteps).toFixed(2)} ms/step)`);

  // Per-step logit deltas.
  let maxAbs = 0, sumAbs = 0, count = 0;
  let argmaxDiverge = 0;
  for (let step = 0; step < nSteps; step += 1) {
    const c = cpuRun.perStepLogits[step];
    const g = gpuRun.perStepLogits[step];
    for (let i = 0; i < c.length; i += 1) {
      const d = Math.abs(c[i] - g[i]);
      if (d > maxAbs) maxAbs = d;
      sumAbs += d;
      count += 1;
    }
    if (gpuRun.argmaxTokens[step] !== cpuRun.argmaxTokens[step]) argmaxDiverge += 1;
  }
  const meanAbs = sumAbs / count;
  const pass = maxAbs <= 5e-2;
  printTable(
    ["metric", "value", "bar", "result"],
    [
      ["max|Δlogits|", maxAbs.toExponential(3), "<= 5e-2", pass ? "PASS" : "FAIL"],
      ["mean|Δlogits|", meanAbs.toExponential(3), "info", "INFO"],
      ["argmax divergence", `${argmaxDiverge} / ${nSteps}`, "info (allowed)", "INFO"],
      ["CPU ms/step", (cpuSecs * 1000 / nSteps).toFixed(2), "info", "INFO"],
      ["WebGPU ms/step", (gpuSecs * 1000 / nSteps).toFixed(2), "info", "INFO"],
    ]
  );
  log(`[C] PASS bar: max|Δlogits| <= 5e-2 -> ${pass ? "PASS" : "FAIL"}`);
  log(`[C] argmax divergence ${argmaxDiverge}/${nSteps} steps differ (expected non-zero: WebGPU fp32 != CPU bit-exact)`);
  return { pass, maxAbs, meanAbs, argmaxDiverge, cpuSecs, gpuSecs };
}

// ----------------------------- Section D ---------------------------------

async function sha256File(p) {
  const h = crypto.createHash("sha256");
  const handle = await fsPromises.open(p, "r");
  try { for await (const chunk of handle.createReadStream()) h.update(chunk); } finally { await handle.close(); }
  return h.digest("hex");
}

async function loadGeneratorManifest() {
  return JSON.parse(await fsPromises.readFile(path.join(ENGINE_ROOT, "manifest.json"), "utf8"));
}

// Build a job.json that mirrors engineManager.generateChart for the ONNX
// generator, forcing a specific hardwareMode. hardwareMode 'webgpu' -> the
// engine's resolveOnnxDevice returns 'webgpu'; 'cpu' -> 'cpu'.
//
// Uses CFG (guidanceScale=2.5 + a non-auto chords knob) so the WebGPU run
// exercises the device-resident decoder's TWO-stream path: cond + uncond,
// each with its own gpu-buffer K/V cache, both fed the shared gpu-buffer
// encoder outputs. This is the milestone-5 core contribution.
function buildJob({ jobId, audioPath, audioSha256, outputDir, cacheDir, demucsWorkspacePath, hardwareMode, generator, modelsFolder }) {
  const knobs = { speed: null, chords: 3, technique: null, movement: null, repetition: null };
  return {
    schemaVersion: 1,
    jobId,
    generatorId: "autochart.fretformer.v1-onnx",
    generatorLabel: generator.label,
    generator,
    engineVersion: "webgpu-parity",
    audioPath,
    audioSha256,
    originalAudioSha256: audioSha256,
    sourceTransform: { kind: "original", leadInSilenceSeconds: 0, leadInSilenceMs: 0, key: "lead-in:0", label: "No lead-in" },
    outputDir,
    cacheDir,
    demucsWorkspace: demucsWorkspacePath,
    title: `WebGPU-Parity-${hardwareMode}`,
    metadata: { title: `WebGPU-Parity-${hardwareMode}`, artist: "Autochart" },
    difficulty: E2E_DIFFICULTY,
    stripSustains: false,
    generation: {
      generatorId: "autochart.fretformer.v1-onnx",
      presetId: "tight",
      presetName: "Tight",
      modified: true,
      controls: {
        difficulty: E2E_DIFFICULTY, temperature: 0.9, topP: 0.95, stripSustains: false,
        timingDetector: "beat_this_custom_timing", seedMode: "fixed", seed: 12345,
        knobs, guidanceScale: 2.5,
      },
      resolved: {
        difficulty: E2E_DIFFICULTY, temperature: 0.9, topP: 0.95, stripSustains: false,
        timingDetector: "beat_this_custom_timing", detector: "beat_this_custom_timing",
        timingRaw: true, bpmTolerance: 0, seed: 12345, knobs, guidanceScale: 2.5,
      },
    },
    hardwareMode,
    engine: {
      platform: process.platform,
      runtime: generator.runtime || null,
      modelsFolder: modelsFolder || "",
      modelRoots: modelsFolder ? [modelsFolder] : [],
    },
    createdAt: Date.now(),
  };
}

function runEngine(jobPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENGINE_BIN, "generate", "--job", jobPath], {
      cwd: ENGINE_ROOT,
      env: { ...process.env, AUTOCHART_ENGINE_ROOT: ENGINE_ROOT },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const events = [];
    let stdoutBuf = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() || "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch { events.push({ type: "log", message: line }); }
      }
    });
    let stderrBuf = "";
    child.stderr.on("data", (chunk) => { stderrBuf += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, events, stderrTail: stderrBuf }));
  });
}

function parseNoteLines(chartText, noteSection) {
  const lines = String(chartText || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const notes = [];
  let inNotes = false, lastTick = -Infinity;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === `[${noteSection}]`) { inNotes = true; continue; }
    if (/^\[/.test(line)) { inNotes = false; continue; }
    if (!inNotes || line === "{" || line === "}") continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const tick = Number.parseInt(line.slice(0, eq).trim(), 10);
    if (!Number.isFinite(tick)) continue;
    const parts = line.slice(eq + 1).trim().split(/\s+/);
    if (parts[0] !== "N") continue;
    if (tick < lastTick) return { ok: false, reason: `non-monotonic tick ${tick} < ${lastTick}` };
    notes.push({ tick });
    lastTick = tick;
  }
  return { ok: true, notes };
}

async function runE2E(label, hardwareMode, audioPath, audioSha256, generator, scratch, modelsFolder) {
  const outputDir = path.join(scratch, label, "output");
  const cacheDir = path.join(scratch, label, "cache");
  const jobPath = path.join(scratch, label, "job.json");
  await fsPromises.mkdir(outputDir, { recursive: true });
  await fsPromises.mkdir(cacheDir, { recursive: true });
  const demucsWorkspacePath = await demucsWorkspace.resolveDemucsWorkspace(
    cacheDir,
    audioSha256,
    "demucs_default"
  );
  const job = buildJob({
    jobId: `${label}-${crypto.randomUUID()}`,
    audioPath, audioSha256, outputDir, cacheDir, demucsWorkspacePath, hardwareMode, generator, modelsFolder,
  });
  await fsPromises.writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  log(`[D:${label}] spawning engine (hardwareMode=${hardwareMode})...`);
  const t0 = Date.now();
  const { code, events, stderrTail } = await runEngine(jobPath);
  const wall = (Date.now() - t0) / 1000;
  if (code !== 0) {
    if (stderrTail) log(`[D:${label}] stderr tail:\n${stderrTail.slice(-2000)}`);
    return { ok: false, reason: `engine exit ${code}`, wall };
  }
  const stages = events.filter((e) => e.type === "stage");
  const completed = new Set(stages.filter((e) => e.status === "completed").map((e) => e.stage));
  const expected = ["audio", "demucs", "timing", "transcription", "chart", "done"];
  const missing = expected.filter((s) => !completed.has(s));
  if (missing.length) {
    return { ok: false, reason: `missing completed stages: ${missing.join(",")}`, wall };
  }
  const resultPath = path.join(outputDir, "result.json");
  if (!fs.existsSync(resultPath)) return { ok: false, reason: "no result.json", wall };
  const result = JSON.parse(await fsPromises.readFile(resultPath, "utf8"));
  if (result.status !== "completed") return { ok: false, reason: `status=${result.status} err=${result.error || ""}`, wall };
  const ep = result.provenance?.runtime?.executionProvider;
  const expectedProvider = hardwareMode === "webgpu" ? "webgpu" : "cpu";
  if (ep !== expectedProvider) {
    return {
      ok: false,
      reason: `${hardwareMode} run actual provider=${ep || "unknown"} (expected ${expectedProvider})`,
      wall,
      executionProvider: ep,
    };
  }
  if (hardwareMode === "webgpu" && events.some((event) => event.type === "runtime_fallback")) {
    return { ok: false, reason: "WebGPU run emitted an explicit CPU fallback.", wall, executionProvider: ep };
  }
  if (!result.chartPath || !fs.existsSync(result.chartPath)) return { ok: false, reason: `no chart at ${result.chartPath}`, wall };
  const chartText = await fsPromises.readFile(result.chartPath, "utf8");
  const parsed = parseNoteLines(chartText, E2E_NOTE_SECTION);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, wall };
  if (parsed.notes.length === 0) return { ok: false, reason: `empty [${E2E_NOTE_SECTION}]`, wall };
  log(`[D:${label}] OK: ${parsed.notes.length} notes, wall=${wall.toFixed(1)}s, executionProvider=${ep}`);
  return { ok: true, wall, noteCount: parsed.notes.length, executionProvider: ep };
}

async function sectionD(audioPath, scratch, args) {
  log("\n========== Section D: End-to-end WebGPU vs CPU generate ==========");
  if (args.skipE2e) {
    log("[D] --skip-e2e: skipping end-to-end runs.");
    return { pass: true, skipped: true };
  }
  const generator = (await loadGeneratorManifest()).generators.find((g) => g.id === "autochart.fretformer.v1-onnx");
  if (!generator) return { pass: false, reason: "ONNX generator missing from manifest" };
  const audioSha256 = await sha256File(audioPath);

  log("[D] run 1: WebGPU");
  const wg = await runE2E("webgpu", "webgpu", audioPath, audioSha256, generator, scratch, args.modelsFolder);
  log("[D] run 2: CPU");
  const cpu = await runE2E("cpu", "cpu", audioPath, audioSha256, generator, scratch, args.modelsFolder);

  const rows = [];
  rows.push(["WebGPU", wg.ok ? "completed" : "FAILED", wg.ok ? String(wg.noteCount) : "-", wg.wall.toFixed(1), wg.executionProvider || (wg.ok ? "?" : "-")]);
  rows.push(["CPU", cpu.ok ? "completed" : "FAILED", cpu.ok ? String(cpu.noteCount) : "-", cpu.wall.toFixed(1), cpu.executionProvider || (cpu.ok ? "?" : "-")]);
  if (wg.ok && cpu.ok) {
    rows.push(["speedup", "-", "-", (cpu.wall / Math.max(wg.wall, 0.001)).toFixed(2) + "x", "-"]);
  }
  printTable(["device", "status", "notes", "wall (s)", "EP"], rows);

  const pass = wg.ok && cpu.ok;
  log(`[D] PASS bar: both runs completed with non-empty charts -> ${pass ? "PASS" : "FAIL"}`);
  if (!wg.ok) log(`[D] WebGPU run failed: ${wg.reason}`);
  if (!cpu.ok) log(`[D] CPU run failed: ${cpu.reason}`);
  return { pass, wg, cpu };
}

// ------------------------------- main ------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertSelectedModelsFolder(args.modelsFolder);

  let audioPath = args.audio;
  if (!audioPath && MODEL_REPO_CUSTOMS && fs.existsSync(MODEL_REPO_CUSTOMS)) {
    const picked = await pickShortestAudio(MODEL_REPO_CUSTOMS);
    if (picked) {
      audioPath = picked.path;
      log(`[gate] picked shortest song: ${audioPath} (${picked.duration.toFixed(1)}s)`);
    }
  }
  if (!audioPath) {
    if (!fs.existsSync(REPO_DEMO_AUDIO)) {
      log("[gate] no audio found; pass --audio <real-audio-file> or set AUTOCHART_TEST_AUDIO_ROOT");
      process.exit(2);
    }
    audioPath = REPO_DEMO_AUDIO;
    log(`[gate] using repo demo fixture: ${audioPath}`);
  }
  if (!fs.existsSync(audioPath)) { log(`[gate] audio not found: ${audioPath}`); process.exit(2); }

  const tmpDir = resolveTmpDir(args.tmpDir);
  const work = path.join(tmpDir, `webgpu-parity-${Date.now()}`);
  fs.mkdirSync(work, { recursive: true });
  log(`[gate] work dir: ${work}`);

  // A: availability (gates whether B/C/D run or skip).
  const a = await sectionA(args.modelsFolder);
  if (a.skip) {
    log("\n========== SUMMARY ==========");
    log("[A] WebGPU unavailable: SKIPPED B/C/D (exit 0).");
    log("[A] The wiring + CPU fallback are exercised by the separate CPU gates");
    log("    (transcribe-onnx-parity.cjs, demucs-onnx-parity.cjs).");
    log(`[A] skip reason: ${a.reason}`);
    process.exit(0);
  }

  // B: Demucs.
  const b = await sectionB(a.manifest, audioPath, work);

  // C: Decoder parity.
  const c = await sectionC(a.manifest, audioPath, b.stemPaths, args.steps);

  // D: End-to-end.
  const d = await sectionD(audioPath, work, args);

  log("\n========== SUMMARY ==========");
  printTable(
    ["section", "result", "detail"],
    [
      ["A availability", "PASS", "webgpu bundled + session OK"],
      ["B demucs SDR", b.pass ? "PASS" : "FAIL", b.pass ? `all stems >= 40 dB (CPU ${b.cpuSecs.toFixed(1)}s, WebGPU ${b.gpuSecs.toFixed(1)}s)` : "some stem < 40 dB"],
      ["C logit delta", c.pass ? "PASS" : "FAIL", `max|Δ|=${c.maxAbs.toExponential(2)} mean|Δ|=${c.meanAbs.toExponential(2)} argmax-div=${c.argmaxDiverge}/${args.steps}`],
      ["D e2e generate", d.pass ? "PASS" : "FAIL", d.skipped ? "skipped (--skip-e2e)" : (d.wg.ok && d.cpu.ok ? `WebGPU ${d.wg.wall.toFixed(1)}s vs CPU ${d.cpu.wall.toFixed(1)}s` : "a run failed")],
    ]
  );

  const allPass = b.pass && c.pass && d.pass;
  if (allPass) {
    log("\n=== RESULT: PASS ===\n");
    process.exit(0);
  } else {
    log("\n=== RESULT: FAIL ===\n");
    process.exit(1);
  }
}

main().catch((err) => {
  log(`\n[gate] FATAL: ${err && err.stack ? err.stack : (err && err.message ? err.message : err)}`);
  process.exit(1);
});

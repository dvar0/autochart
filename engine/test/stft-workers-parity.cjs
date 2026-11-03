#!/usr/bin/env node
// Demucs separation with STFT workers against the same run on one thread:
// the stems must match to the byte, and onProgress / onPower must fire in the
// same order with the same values (onProgress's elapsed aside). Then a worker
// is made to fail partway, and the run must finish on its own thread with the
// same stems.
//
// Usage:
//   node engine/test/stft-workers-parity.cjs --models-folder <dir>
//        [--audio <path>] [--seconds <n>] [--workers <n>] [--device cpu|webgpu]
//
// <dir> holds fretformer-v1/ and/or fretformer-v2/ (each needs manifest.json
// and demucs_core_network.onnx). Each one found is checked.
// PASS = exit 0 and a final "passed" line.

"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const APP_ROOT = path.resolve(__dirname, "..", "..");
const ENGINE_ROOT = path.join(APP_ROOT, "engine");
const onnxLib = require(path.join(ENGINE_ROOT, "lib", "onnx"));
const { installHost } = require(path.join(ENGINE_ROOT, "lib", "onnx", "runtime.mjs"));

function parseArgs(argv) {
  const args = {
    modelsFolder: "",
    audio: path.join(APP_ROOT, "fixtures", "demo", "autochart-demo-30s.wav"),
    seconds: 0,
    workers: 4,
    device: "cpu",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[++i];
    if (argv[i] === "--models-folder") args.modelsFolder = path.resolve(next());
    else if (argv[i] === "--audio") args.audio = path.resolve(next());
    else if (argv[i] === "--seconds") args.seconds = Number(next());
    else if (argv[i] === "--workers") args.workers = Number(next());
    else if (argv[i] === "--device") args.device = next();
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.modelsFolder) throw new Error("--models-folder is required");
  return args;
}

function log(message) {
  console.log(`[stft-workers] ${message}`);
}

async function runOnce(planar, length, sessions, orch, workers) {
  const progress = [];
  const power = [];
  const logLines = [];
  const t0 = Date.now();
  const stems = await onnxLib.separate(planar, length, { ...sessions, stftWorkers: workers }, orch, {
    onProgress: ({ elapsed, ...rest }) => progress.push(rest),
    onPower: (value) => power.push(value),
    log: (line) => logLines.push(line),
  });
  return { stems, progress, power, logLines, seconds: (Date.now() - t0) / 1000 };
}

function sameBytes(a, b) {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

function assertSameRun(label, ref, got) {
  assert.strictEqual(got.stems.length, ref.stems.length, `${label}: stem count`);
  ref.stems.forEach((stem, i) => {
    assert.strictEqual(got.stems[i].name, stem.name, `${label}: stem ${i} name`);
    for (const ch of ["left", "right"]) {
      assert.ok(sameBytes(stem[ch], got.stems[i][ch]), `${label}: ${stem.name} ${ch} differs`);
    }
  });
  assert.deepStrictEqual(got.progress, ref.progress, `${label}: onProgress calls differ`);
  assert.deepStrictEqual(got.power, ref.power, `${label}: onPower calls differ`);
}

// Workers that fail on the given task: the first ones answer, then one dies.
function failingWorkers(failAfter) {
  let posted = 0;
  return (count) => onnxLib.startStftWorkers(count).map((worker) => {
    let onError = null;
    return {
      ...worker,
      listen(onMessage, error) {
        onError = error;
        worker.listen(onMessage, error);
      },
      post(message, transfer) {
        posted += 1;
        if (posted === failAfter) {
          setTimeout(() => onError(new Error("test failure")), 0);
          return;
        }
        worker.post(message, transfer);
      },
    };
  });
}

async function checkModel(folder, args) {
  const name = path.basename(folder);
  const manifest = await onnxLib.loadModelsManifest(ENGINE_ROOT, {
    engine: { modelsFolder: path.dirname(folder) },
    generator: { models: { onnxFolder: name } },
  });
  const orch = onnxLib.demucsOrchestration(manifest);
  const decoded = await onnxLib.decodeStereoF32(args.audio, { sampleRate: orch.sampleRate });
  const length = args.seconds > 0 ? Math.min(decoded.length, Math.round(args.seconds * orch.sampleRate)) : decoded.length;
  const planar = new Float32Array(2 * length);
  planar.set(decoded.left.subarray(0, length), 0);
  planar.set(decoded.right.subarray(0, length), length);
  const sessions = await onnxLib.loadDemucsSessions(manifest, args.device);
  log(`${name}: ${orch.sources.length} sources, ${(length / orch.sampleRate).toFixed(1)} s on ${sessions.device}, default ${sessions.stftWorkers} workers`);

  const ref = await runOnce(planar, length, sessions, orch, 0);
  assert.ok(!ref.logLines.some((line) => line.includes("STFT workers")), "workers: 0 must stay on one thread");
  assert.strictEqual(ref.progress.length, ref.progress[ref.progress.length - 1].total, "one onProgress per chunk");
  log(`${name}: one thread ${ref.seconds.toFixed(1)} s, ${ref.progress.length} chunks`);

  for (const workers of [...new Set([1, args.workers])]) {
    const got = await runOnce(planar, length, sessions, orch, workers);
    assert.ok(got.logLines.some((line) => line.includes(`(${workers} STFT workers)`)), `${workers} workers did not start`);
    assertSameRun(`${name} ${workers} workers`, ref, got);
    log(`${name}: ${workers} workers ${got.seconds.toFixed(1)} s, identical`);
  }

  // A worker failure partway through: the rest runs on this thread. Each
  // chunk posts 2 analysis tasks and one inverse STFT task per stem channel;
  // failing in the last chunk's inverse STFTs leaves earlier chunks done.
  const chunks = ref.progress.length;
  assert.ok(chunks >= 4, "the failure check needs at least 4 chunks of audio");
  const tasksPerChunk = 2 + 2 * orch.sources.length;
  installHost({ ...hostFunctions, startStftWorkers: failingWorkers(chunks * tasksPerChunk - orch.sources.length) });
  try {
    const got = await runOnce(planar, length, sessions, orch, args.workers);
    const fallback = got.logLines.find((line) => line.includes("without workers"));
    assert.ok(fallback, "the failure did not fall back");
    assert.ok(!fallback.includes("chunks 1-"), "the failure came before any chunk was done");
    assertSameRun(`${name} worker failure`, ref, got);
    log(`${name}: worker failure fell back (${fallback.trim()}), identical`);
  } finally {
    installHost(hostFunctions);
  }
}

// The desktop host's functions that separate() reaches.
const hostFunctions = {
  tensor: onnxLib.tensor,
  sessionDevice: onnxLib.sessionDevice,
  createSession: onnxLib.createSession,
  graphSource: onnxLib.graphPath,
  hardwareThreads: () => require("os").availableParallelism(),
  startStftWorkers: onnxLib.startStftWorkers,
};

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const folders = ["fretformer-v1", "fretformer-v2"]
    .map((name) => path.join(args.modelsFolder, name))
    .filter((folder) => fs.existsSync(path.join(folder, "demucs_core_network.onnx")));
  if (!folders.length) throw new Error(`No Demucs model folder under ${args.modelsFolder}`);
  for (const folder of folders) await checkModel(folder, args);
  log(`passed (${folders.map((f) => path.basename(f)).join(", ")})`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

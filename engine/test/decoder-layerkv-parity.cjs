"use strict";

// WebGPU parity gate for the per-layer-cache decoder graph (decoderLayerKv.mjs):
// the exported decoder and its rewrite run on WebGPU, are fed the same tokens
// and must give the same logits (up to float rounding) and the same greedy
// tokens, single, batched (CFG) and two-call CFG, past the point where the
// cache grows. A cache returned by
// generate, cut with sliceCache and resumed from must decode the same tokens
// as feeding the whole prefix. A model with a fill-in decoder (Inpaint) must
// also regenerate the same bars with the same tokens and seam scores through
// the rewritten fill-in graph, with and without style picks. Run with a node
// that has WebGPU; it skips when no adapter is available.
//
//   node engine/test/decoder-layerkv-parity.cjs --models-folder <dir> [--model fretformer-v2]

const path = require("path");

const ENGINE_ROOT = path.resolve(__dirname, "..");
const onnxLib = require(path.join(ENGINE_ROOT, "lib", "onnx"));

const STEPS = 1100;
const TOLERANCE = 1e-3;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : "";
}

function log(message) {
  process.stderr.write(`[decoder-layerkv-parity] ${message}\n`);
}

function maxDiff(a, b) {
  let max = 0;
  for (let i = 0; i < a.length; i += 1) {
    const delta = Math.abs(a[i] - b[i]);
    if (!Number.isFinite(delta)) return Infinity;
    max = Math.max(max, delta);
  }
  return max;
}

// Deterministic stand-in features in [-1, 1].
function features(length) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = Math.sin(i * 0.37) * Math.cos(i * 0.011);
  return out;
}

async function main() {
  const modelsFolder = arg("--models-folder") ? path.resolve(arg("--models-folder")) : "";
  const model = arg("--model");
  const manifest = await onnxLib.loadModelsManifest(ENGINE_ROOT, {
    engine: { modelsFolder },
    ...(model ? { generator: { models: { onnxFolder: model } } } : {}),
  });
  const stage = manifest.stages.transcriber;
  const config = stage.modelConfig;
  const nBeats = 24;
  const channels = Number(config.inChannels || 5);
  const ctx0 = { nLayers: config.nLayers, nHead: config.nhead, headDim: config.headDim };
  const encoder = await onnxLib.loadEncoderSessions(manifest, "webgpu");
  if (onnxLib.sessionDevice(encoder, "unknown") !== "webgpu") {
    log("SKIP: no WebGPU adapter in this runtime");
    // Leave now: with no adapter, ONNX Runtime's teardown at a normal exit
    // segfaults (the other WebGPU gate exits the same way).
    process.exit(0);
  }
  const encoderCtx = await onnxLib.runEncoder(encoder, features(nBeats * channels * 80 * 32), new Uint8Array(nBeats).fill(1), nBeats);
  const ctx = { ...ctx0, ...encoderCtx };
  const original = await onnxLib.createSession(onnxLib.graphPath(manifest, "transcriber-decoder-step"), {
    device: "webgpu",
    preferredOutputLocation: { present_self_k: "gpu-buffer", present_self_v: "gpu-buffer" },
  });
  const rewritten = await onnxLib.loadDecoderSession(manifest, "webgpu");
  if (onnxLib.layerKvDecoder(original) || !onnxLib.layerKvDecoder(rewritten)) {
    throw new Error("expected the exported decoder and its per-layer-cache rewrite");
  }
  if (onnxLib.sessionDevice(rewritten, "unknown") !== "webgpu") throw new Error("the rewritten decoder did not load on WebGPU");

  const condBias = new Float32Array(config.dModel);
  const uncondBias = new Float32Array(config.dModel);
  for (let i = 0; i < condBias.length; i += 1) {
    condBias[i] = ((i % 13) - 6) * 0.01;
    uncondBias[i] = ((i % 7) - 3) * 0.01;
  }
  const forced = Array.from({ length: STEPS }, (_, i) => (i % 9 === 0 ? onnxLib.BEAT_TOKEN : 8 + ((i * 7) % 40)));
  forced[0] = onnxLib.BOS_TOKEN;
  let worst = 0;
  let caches = [];
  try {
    let oneOld = [new Float32Array(0), new Float32Array(0)];
    let oneNew = [new Float32Array(0), new Float32Array(0)];
    let twoOld = [new Float32Array(0), new Float32Array(0)];
    let twoNew = [new Float32Array(0), new Float32Array(0)];
    caches = [oneOld, oneNew, twoOld, twoNew];
    for (let step = 0; step < STEPS; step += 1) {
      const beat = Math.min(Math.floor(step / 9), nBeats - 1);
      const a = await onnxLib.runDecoderStep(original, forced[step], step, beat, ctx, condBias, ...oneOld);
      const b = await onnxLib.runDecoderStep(rewritten, forced[step], step, beat, ctx, condBias, ...oneNew);
      const tokens = [forced[step], forced[(step * 5) % STEPS]];
      const c = await onnxLib.runDecoderBatchStep(original, tokens, step, beat, ctx, condBias, uncondBias, ...twoOld);
      const d = await onnxLib.runDecoderBatchStep(rewritten, tokens, step, beat, ctx, condBias, uncondBias, ...twoNew);
      worst = Math.max(worst, maxDiff(a.logits, b.logits), maxDiff(c.condLogits, d.condLogits), maxDiff(c.uncondLogits, d.uncondLogits));
      // The per-layer cache comes back as the same object, written in place.
      for (const value of caches.flat()) onnxLib.disposeGpuTensor(value);
      oneOld = [a.presentK, a.presentV];
      oneNew = [b.presentK, b.presentV];
      twoOld = [c.presentK, c.presentV];
      twoNew = [d.presentK, d.presentV];
      caches = [oneOld, oneNew, twoOld, twoNew];
    }
  } finally {
    for (const [k, v] of caches) onnxLib.disposeCache({ k, v });
  }
  log(`decoder step: ${STEPS} forced steps, single and batched, max|delta logits|=${worst.toExponential(3)} tolerance=${TOLERANCE}`);

  const prefix = [onnxLib.BOS_TOKEN, onnxLib.difficultyToken("expert")];
  const greedy = (decoderSession, guidance, extra = {}) => onnxLib.generate({
    manifest,
    decoderSession,
    encoderCtx,
    nBeats,
    prefixTokens: prefix,
    prefixBias: condBias,
    temperature: 0,
    topP: 1,
    rng: null,
    guidanceScale: guidance,
    uncondPrefixTokens: guidance > 1 ? prefix : null,
    uncondPrefixBias: guidance > 1 ? uncondBias : null,
    maxTokens: STEPS,
    ...extra,
  });
  const same = (x, y) => x.tokens.length === y.tokens.length && x.tokens.every((t, i) => t === y.tokens[i]);
  const single = same(await greedy(original, 1), await greedy(rewritten, 1));
  const cfg = same(await greedy(original, 2), await greedy(rewritten, 2));
  process.env.AUTOCHART_CFG_TWO_CALL = "1";
  const twoCall = same(await greedy(original, 2), await greedy(rewritten, 2));
  delete process.env.AUTOCHART_CFG_TWO_CALL;
  log(`greedy tokens identical: single=${single} cfg=${cfg} two-call=${twoCall}`);

  // Resume: decode with a forced prefix from a cut cache and from scratch.
  let resumed = true;
  for (const guidance of [1, 2]) {
    const first = await greedy(rewritten, guidance, { sampleOnlyAfterPrefix: true, returnCache: true });
    const forcedPrefix = Array.from(first.tokens.slice(0, Math.min(120, first.cache.length)));
    const keep = Math.floor((forcedPrefix.length * 2) / 3);
    const cut = await onnxLib.sliceCache(first.cache, keep);
    onnxLib.disposeCache(first.cache);
    const resume = (initialCache) => greedy(rewritten, guidance, {
      prefixTokens: forcedPrefix,
      uncondPrefixTokens: guidance > 1 ? forcedPrefix : null,
      sampleOnlyAfterPrefix: true,
      maxTokens: 100,
      initialCache,
    });
    const fromCut = await resume(cut);
    onnxLib.disposeCache(cut);
    const fromScratch = await resume(null);
    const ok = same(fromCut, fromScratch);
    log(`resume from ${keep} of ${forcedPrefix.length} prefix tokens (guidance ${guidance}): tokens identical=${ok}`);
    resumed = resumed && ok;
  }

  for (const value of Object.values(encoderCtx)) onnxLib.disposeGpuTensor(value);
  const fill = await fillInParity(manifest, encoder, channels);
  if (!(worst <= TOLERANCE) || !single || !cfg || !twoCall || !resumed || !fill) {
    throw new Error(`per-layer-cache decoder parity failed: ${JSON.stringify({ worst, single, cfg, twoCall, resumed, fill })}`);
  }
  log("PASS");
}

// Regenerate two spans of a stand-in chart (13 tokens a beat) with the
// exported fill-in decoder and its rewrite. The chart is long enough that the
// prefill runs in several chunks and the rewrite's cache grows during it.
async function fillInParity(manifest, encoder, channels) {
  const stage = manifest.stages.transcriber;
  if (!stage.fim) return true;
  const nBeats = 120;
  const encoderCtx = await onnxLib.runEncoder(encoder, features(nBeats * channels * 80 * 32), new Uint8Array(nBeats).fill(1), nBeats);
  const { prefixBiasOf } = await onnxLib.prefixBiasMaker(manifest);
  const tokens = [
    onnxLib.BOS_TOKEN,
    onnxLib.difficultyToken("expert"),
    ...Array.from({ length: onnxLib.N_DESCRIPTORS }, (_, k) => onnxLib.descriptorToken(k, onnxLib.DESC_AUTO_BIN)),
    ...onnxLib.structurePrefixTokens(stage.structure || null, { solos: false }),
  ];
  for (let b = 0; b < nBeats; b += 1) {
    tokens.push(onnxLib.BEAT_TOKEN);
    for (let j = 0; j < 12; j += 1) tokens.push(8 + ((b * 7 + j * 3) % 40));
  }
  tokens.push(onnxLib.EOS_TOKEN);
  const original = await onnxLib.createSession(onnxLib.graphPath(manifest, "transcriber-fim-decoder"), {
    device: "webgpu",
    preferredOutputLocation: { present_self_k: "gpu-buffer", present_self_v: "gpu-buffer" },
  });
  const rewritten = await onnxLib.loadFimDecoderSession(manifest, "webgpu");
  if (onnxLib.layerKvDecoder(original) || !onnxLib.layerKvDecoder(rewritten)) {
    throw new Error("expected the exported fill-in decoder and its per-layer-cache rewrite");
  }
  const regenerate = (session, knobs) => onnxLib.inpaint({
    manifest, session, encoderCtx, nBeats,
    tokens,
    holes: [[10, 14], [100, 106]],
    knobs, knobNames: onnxLib.DESCRIPTOR_NAMES, makePrefixBias: prefixBiasOf,
    guidanceScale: 2, temperature: 0, topP: 1, rng: null, candidates: 2,
  });
  let ok = true;
  for (const knobs of [{}, { chords: 3 }]) {
    const a = await regenerate(original, knobs);
    const b = await regenerate(rewritten, knobs);
    const sameTokens = a.tokens.length === b.tokens.length && a.tokens.every((t, i) => t === b.tokens[i]);
    // Seams come back rounded to 0.001.
    let seam = 0;
    a.holes.forEach((hole, h) => hole.seams.forEach((value, i) => {
      seam = Math.max(seam, Math.abs(value - b.holes[h].seams[i]));
    }));
    const same = sameTokens && seam <= TOLERANCE;
    log(`fill-in: ${tokens.length}-token chart, 2 spans (${Object.keys(knobs).length ? "style picks, CFG" : "auto"}): tokens identical=${sameTokens} max|delta seam|=${seam}`);
    ok = ok && same;
  }
  for (const value of Object.values(encoderCtx)) onnxLib.disposeGpuTensor(value);
  return ok;
}

main().catch((error) => {
  log(`FAIL: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});

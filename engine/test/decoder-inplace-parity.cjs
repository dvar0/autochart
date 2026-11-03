"use strict";

// CPU parity gate for the in-place decoder graphs (decoderInPlace.mjs): the
// exported decoder and its rewrite are fed the same tokens and must give the
// same logits (up to float rounding) and the same greedy tokens, single and
// batched (CFG), past the point where the in-place cache grows. With an
// inpaint model folder the fill-in-the-middle decoder is checked too, fed
// several tokens per call.
//
//   node engine/test/decoder-inplace-parity.cjs --models-folder <dir> [--model fretformer-v2]

const path = require("path");

const ENGINE_ROOT = path.resolve(__dirname, "..");
const onnxLib = require(path.join(ENGINE_ROOT, "lib", "onnx"));

const STEPS = 300;
const TOLERANCE = 1e-3;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : "";
}

function log(message) {
  process.stderr.write(`[decoder-inplace-parity] ${message}\n`);
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
  const encoder = await onnxLib.loadEncoderSessions(manifest, "cpu");
  const encoderCtx = await onnxLib.runEncoder(encoder, features(nBeats * channels * 80 * 32), new Uint8Array(nBeats).fill(1), nBeats);
  const ctx = { ...ctx0, ...encoderCtx };
  const original = await onnxLib.createSession(onnxLib.graphPath(manifest, "transcriber-decoder-step"), { device: "cpu" });
  const rewritten = await onnxLib.loadDecoderSession(manifest, "cpu");
  if (onnxLib.inPlaceDecoder(original) || !onnxLib.inPlaceDecoder(rewritten)) {
    throw new Error("expected the exported decoder and its in-place rewrite");
  }

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
    for (let step = 0; step < STEPS; step += 1) {
      const beat = Math.min(Math.floor(step / 9), nBeats - 1);
      const a = await onnxLib.runDecoderStep(original, forced[step], step, beat, ctx, condBias, ...oneOld);
      const b = await onnxLib.runDecoderStep(rewritten, forced[step], step, beat, ctx, condBias, ...oneNew);
      const tokens = [forced[step], forced[(step * 5) % STEPS]];
      const c = await onnxLib.runDecoderBatchStep(original, tokens, step, beat, ctx, condBias, uncondBias, ...twoOld);
      const d = await onnxLib.runDecoderBatchStep(rewritten, tokens, step, beat, ctx, condBias, uncondBias, ...twoNew);
      worst = Math.max(worst, maxDiff(a.logits, b.logits), maxDiff(c.condLogits, d.condLogits), maxDiff(c.uncondLogits, d.uncondLogits));
      oneOld = [a.presentK, a.presentV];
      oneNew = [b.presentK, b.presentV];
      twoOld = [c.presentK, c.presentV];
      twoNew = [d.presentK, d.presentV];
    }
    caches = [...oneOld, ...twoOld];
  } finally {
    for (const value of caches) onnxLib.disposeGpuTensor(value);
  }
  log(`decoder step: ${STEPS} forced steps, single and batched, max|delta logits|=${worst.toExponential(3)} tolerance=${TOLERANCE}`);

  const prefix = [onnxLib.BOS_TOKEN, onnxLib.difficultyToken("expert")];
  const greedy = (decoderSession, guidance) => onnxLib.generate({
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
  });
  const same = (x, y) => x.tokens.length === y.tokens.length && x.tokens.every((t, i) => t === y.tokens[i]);
  const single = same(await greedy(original, 1), await greedy(rewritten, 1));
  const cfg = same(await greedy(original, 2), await greedy(rewritten, 2));
  log(`greedy tokens identical: single=${single} cfg=${cfg}`);

  let fimWorst = 0;
  const fimEntry = manifest.graphs && Object.values(manifest.graphs).find((g) => g.role === "transcriber-fim-decoder");
  if (fimEntry) {
    const fimOriginal = await onnxLib.createSession(onnxLib.graphPath(manifest, "transcriber-fim-decoder"), { device: "cpu" });
    const fimRewritten = await onnxLib.loadFimDecoderSession(manifest, "cpu");
    if (!onnxLib.inPlaceDecoder(fimRewritten)) throw new Error("expected the in-place fill-in-the-middle decoder");
    let pastK = new Float32Array(0), pastV = new Float32Array(0), length = 0;
    const kv = onnxLib.newKv(ctx, 1);
    for (const n of [200, 90, 1, 1, 7]) {
      const ids = forced.slice(length, length + n);
      const common = {
        token_id: onnxLib.tensor("int64", BigInt64Array.from(ids, BigInt), [n]),
        step_id: onnxLib.tensor("int64", BigInt64Array.from(ids, (_, i) => BigInt(length + i)), [n]),
        beat_idx: onnxLib.tensor("int64", BigInt64Array.from(ids, (_, i) => BigInt(Math.min(Math.floor((length + i) / 9), nBeats - 1))), [n]),
        aligned_memory: ctx.alignedMemory,
        prefix_bias: onnxLib.tensor("float32", condBias, [1, condBias.length]),
        mem_invalid: ctx.memInvalid,
      };
      const dims = [ctx.nLayers, 1, ctx.nHead, length, ctx.headDim];
      const a = await fimOriginal.run({
        ...common,
        cross_k: ctx.crossK,
        cross_v: ctx.crossV,
        past_self_k: onnxLib.tensor("float32", pastK, dims),
        past_self_v: onnxLib.tensor("float32", pastV, dims),
      });
      const b = await fimRewritten.run({ ...common, ...onnxLib.kvFeeds(ctx, kv, n), ...onnxLib.crossLayers(ctx) });
      await onnxLib.appendKv(ctx, kv, b, n);
      fimWorst = Math.max(fimWorst, maxDiff(a.logits.data, b.logits.data));
      pastK = a.present_self_k.data;
      pastV = a.present_self_v.data;
      length += n;
    }
    log(`fill-in-the-middle decoder: ${length} tokens in 5 calls, max|delta logits|=${fimWorst.toExponential(3)}`);
  }

  for (const value of Object.values(encoderCtx)) onnxLib.disposeGpuTensor(value);
  if (!(worst <= TOLERANCE) || !(fimWorst <= TOLERANCE) || !single || !cfg) {
    throw new Error(`in-place decoder parity failed: ${JSON.stringify({ worst, fimWorst, single, cfg })}`);
  }
  log("PASS");
}

main().catch((error) => {
  log(`FAIL: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});

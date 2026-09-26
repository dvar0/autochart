"use strict";

// CPU parity gate for the two CFG decoder orchestration paths. It drives the
// real encoder/decoder with synthetic features, compares forced-step logits,
// then compares greedy CFG token sequences from the same initial state.

const path = require("path");

const ENGINE_ROOT = path.resolve(__dirname, "..");
const onnxLib = require(path.join(ENGINE_ROOT, "lib", "onnx"));

const STEPS = 48;
const TOLERANCE = 1e-4;
function modelsFolderArg() {
  const index = process.argv.indexOf("--models-folder");
  return index >= 0 && process.argv[index + 1] ? path.resolve(process.argv[index + 1]) : "";
}

function log(message) {
  process.stderr.write(`[cfg-batch-parity] ${message}\n`);
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

async function main() {
  const manifest = await onnxLib.loadModelsManifest(ENGINE_ROOT, {
    engine: { modelsFolder: modelsFolderArg() },
  });
  const config = manifest.stages.transcriber.modelConfig;
  const nBeats = 16;
  const ctx0 = { nLayers: config.nLayers, nHead: config.nhead, headDim: config.headDim };
  const encoder = await onnxLib.loadEncoderSessions(manifest, "cpu");
  const decoder = await onnxLib.loadDecoderSession(manifest, "cpu");
  const encoderCtx = await onnxLib.runEncoder(
    encoder,
    new Float32Array(nBeats * 5 * 80 * 32),
    new Uint8Array(nBeats).fill(1),
    nBeats
  );
  const ctx = { ...ctx0, ...encoderCtx };
  const condBias = new Float32Array(config.dModel);
  const uncondBias = new Float32Array(config.dModel);
  for (let i = 0; i < condBias.length; i += 1) {
    condBias[i] = ((i % 13) - 6) * 0.01;
    uncondBias[i] = ((i % 7) - 3) * 0.01;
  }
  const prefix = [onnxLib.BOS_TOKEN, onnxLib.difficultyToken("expert"), 110, 118, 126, 134, 142];
  const uncondPrefix = [onnxLib.BOS_TOKEN, onnxLib.difficultyToken("expert"), 117, 125, 133, 141, 149];
  const forced = Array.from({ length: STEPS }, (_, i) => (i < prefix.length ? prefix[i] : 56 + (i % 30)));
  let twoCondK = new Float32Array(0), twoCondV = new Float32Array(0);
  let twoUncondK = new Float32Array(0), twoUncondV = new Float32Array(0);
  let batchK = new Float32Array(0), batchV = new Float32Array(0);
  let maxLogitDiff = 0;
  try {
    for (let step = 0; step < STEPS; step += 1) {
      const condToken = forced[step];
      const uncondToken = step < uncondPrefix.length ? uncondPrefix[step] : condToken;
      const twoCond = await onnxLib.runDecoderStep(decoder, condToken, step, 0, ctx, condBias, twoCondK, twoCondV);
      const twoUncond = await onnxLib.runDecoderStep(decoder, uncondToken, step, 0, ctx, uncondBias, twoUncondK, twoUncondV);
      const batch = await onnxLib.runDecoderBatchStep(decoder, [condToken, uncondToken], step, 0, ctx, condBias, uncondBias, batchK, batchV);
      maxLogitDiff = Math.max(maxLogitDiff, maxDiff(twoCond.logits, batch.condLogits), maxDiff(twoUncond.logits, batch.uncondLogits));
      twoCondK = twoCond.presentK; twoCondV = twoCond.presentV;
      twoUncondK = twoUncond.presentK; twoUncondV = twoUncond.presentV;
      batchK = batch.presentK; batchV = batch.presentV;
    }
  } finally {
    for (const value of [twoCondK, twoCondV, twoUncondK, twoUncondV, batchK, batchV, ...Object.values(encoderCtx)]) {
      onnxLib.disposeGpuTensor(value);
    }
  }

  const makeRun = () => onnxLib.generate({
    manifest,
    decoderSession: decoder,
    encoderCtx,
    nBeats,
    prefixTokens: prefix,
    prefixBias: condBias,
    temperature: 0,
    topP: 1,
    rng: null,
    guidanceScale: 2,
    uncondPrefixTokens: uncondPrefix,
    uncondPrefixBias: uncondBias,
    maxTokens: STEPS,
  });
  const saved = process.env.AUTOCHART_CFG_TWO_CALL;
  delete process.env.AUTOCHART_CFG_TWO_CALL;
  const batched = await makeRun();
  process.env.AUTOCHART_CFG_TWO_CALL = "1";
  const twoCall = await makeRun();
  if (saved == null) delete process.env.AUTOCHART_CFG_TWO_CALL;
  else process.env.AUTOCHART_CFG_TWO_CALL = saved;

  const tokenMatch = batched.tokens.length === twoCall.tokens.length
    && batched.tokens.every((token, index) => token === twoCall.tokens[index]);
  log(`forced max|delta logits|=${maxLogitDiff.toExponential(3)} tolerance=${TOLERANCE}`);
  log(`greedy tokens batch=${batched.tokens.length} two-call=${twoCall.tokens.length} identical=${tokenMatch}`);
  if (maxLogitDiff > TOLERANCE || !tokenMatch) {
    throw new Error(`CFG batch parity failed: maxLogitDiff=${maxLogitDiff}, tokenMatch=${tokenMatch}`);
  }
  log("PASS");
}

main().catch((error) => {
  log(`FAIL: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});

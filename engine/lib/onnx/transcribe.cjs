"use strict";

// JS port of the reference ONNX transcriber. Greedy (T<=0) is the CPU parity bar;
// sampled mode uses app-owned RNG (not bit-compatible with numpy PCG64).

const { createSession, tensor, runSession } = require("./sessionLoader.cjs");
const { graphPath } = require("./modelsManifest.cjs");
const {
  PAD_TOKEN,
  BOS_TOKEN,
  EOS_TOKEN,
  BEAT_TOKEN,
  VOCAB_SIZE,
} = require("./chartEventStream.cjs");

const NEG_INF = -Infinity;

// Masking order matches the reference sampler (ties -> lowest index).
function greedyArgmax(logits, nBeats, beatsEmitted) {
  let lg = logits; // mutate caller's copy
  let bestIdx = 0;
  let bestVal = NEG_INF;
  for (let i = 0; i < lg.length; i += 1) {
    let v = lg[i];
    if (i === PAD_TOKEN || i === BOS_TOKEN) v = NEG_INF;
    if (beatsEmitted >= nBeats) {
      if (i === BEAT_TOKEN) v = NEG_INF;
    } else if (i === EOS_TOKEN) {
      v = NEG_INF;
    }
    if (v > bestVal) {
      bestVal = v;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function maskedLogits(logits, nBeats, beatsEmitted) {
  const lg = Float32Array.from(logits);
  lg[PAD_TOKEN] = NEG_INF;
  lg[BOS_TOKEN] = NEG_INF;
  if (beatsEmitted >= nBeats) lg[BEAT_TOKEN] = NEG_INF;
  else lg[EOS_TOKEN] = NEG_INF;
  return lg;
}

function sampleNext(logits, { temperature, topP, rng, nBeats, beatsEmitted }) {
  const lg = maskedLogits(logits, nBeats, beatsEmitted);
  if (temperature <= 0) return argmaxFromMasked(lg);
  const scaled = new Float32Array(lg.length);
  const t = Math.max(temperature, 1e-8);
  let maxScaled = NEG_INF;
  for (let i = 0; i < lg.length; i += 1) {
    const v = (lg[i] === NEG_INF) ? NEG_INF : lg[i] / t;
    scaled[i] = v;
    if (v > maxScaled) maxScaled = v;
  }
  const probs = new Float32Array(scaled.length);
  let sum = 0;
  for (let i = 0; i < scaled.length; i += 1) {
    if (scaled[i] === NEG_INF) {
      probs[i] = 0;
      continue;
    }
    const e = Math.exp(scaled[i] - maxScaled);
    probs[i] = e;
    sum += e;
  }
  if (sum <= 0) return argmaxFromMasked(lg);
  for (let i = 0; i < probs.length; i += 1) probs[i] /= sum;

  if (!(topP > 0 && topP < 1)) {
    return rng.choice(probs);
  }
  const order = argsortDesc(probs);
  const sortedProbs = new Float32Array(order.length);
  for (let i = 0; i < order.length; i += 1) sortedProbs[i] = probs[order[i]];
  const keep = new Uint8Array(order.length);
  let cum = 0;
  for (let i = 0; i < sortedProbs.length; i += 1) {
    const cumMinusSelf = cum;
    keep[i] = cumMinusSelf < topP ? 1 : 0;
    cum += sortedProbs[i];
  }
  keep[0] = 1;
  const keptIndices = [];
  const keptProbs = [];
  let keptSum = 0;
  for (let i = 0; i < order.length; i += 1) {
    if (keep[i]) {
      keptIndices.push(order[i]);
      keptProbs.push(probs[order[i]]);
      keptSum += probs[order[i]];
    }
  }
  if (keptSum <= 0) return argmaxFromMasked(lg);
  const renorm = new Float32Array(keptProbs.length);
  for (let i = 0; i < keptProbs.length; i += 1) renorm[i] = keptProbs[i] / keptSum;
  return rng.choiceFromIndices(keptIndices, renorm);
}

function argmaxFromMasked(masked) {
  let bestIdx = 0;
  let bestVal = NEG_INF;
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] > bestVal) {
      bestVal = masked[i];
      bestIdx = i;
    }
  }
  return bestIdx;
}

function argsortDesc(arr) {
  const idx = new Uint32Array(arr.length);
  for (let i = 0; i < arr.length; i += 1) idx[i] = i;
  const tmp = Array.from(idx);
  tmp.sort((a, b) => {
    if (arr[b] !== arr[a]) return arr[b] - arr[a];
    return a - b;
  });
  for (let i = 0; i < tmp.length; i += 1) idx[i] = tmp[i];
  return idx;
}

// WebGPU: present_self_k/v pin to gpu-buffer; past K/V feed back device-resident
// (Float32Array on step 0 / CPU path, ort.Tensor thereafter). Dispose prior
// gpu-buffer tensors each step and in finally. logits/mem_invalid stay unpinned
// (CPU sampling); encoderCtx tensors are caller-owned (see finally).
async function loadEncoderSessions(manifest, device = "cpu") {
  // gpu-buffer pinning is WebGPU-only; CUDA binding rejects it.
  return createSession(graphPath(manifest, "transcriber-encoder"), {
    device,
    preferredOutputLocation: {
      aligned_memory: "gpu-buffer",
      cross_k: "gpu-buffer",
      cross_v: "gpu-buffer",
    },
  });
}
async function loadDecoderSession(manifest, device = "cpu") {
  // logits and mem_invalid intentionally unpinned (read on CPU every step).
  return createSession(graphPath(manifest, "transcriber-decoder-step"), {
    device,
    preferredOutputLocation: {
      present_self_k: "gpu-buffer",
      present_self_v: "gpu-buffer",
    },
  });
}

function disposeGpuTensor(t) {
  if (t && t.location === "gpu-buffer" && typeof t.dispose === "function") {
    try { t.dispose(); } catch { /* ignore */ }
  }
}

function isTensorLike(v) {
  return v != null && typeof v === "object" && typeof v.location === "string" && typeof v.getData === "function";
}

async function runDecoderStep(sess, tokenId, stepId, beatIdx, ctx, prefixBias, pastK, pastV) {
  const { nLayers, nHead, headDim } = ctx;
  let pastKTensor, pastVTensor;
  if (isTensorLike(pastK)) {
    pastKTensor = pastK;
    pastVTensor = pastV;
  } else {
    const pastLen = pastK.length / (nLayers * nHead * headDim);
    const pastKDims = [nLayers, 1, nHead, pastLen, headDim];
    pastKTensor = tensor("float32", pastK, pastKDims);
    pastVTensor = tensor("float32", pastV, pastKDims);
  }
  const prefixBiasT = tensor("float32", prefixBias, [1, prefixBias.length]);
  const tokenIdArr = new BigInt64Array(1);
  tokenIdArr[0] = BigInt(tokenId);
  const stepIdArr = new BigInt64Array(1);
  stepIdArr[0] = BigInt(stepId);
  const beatIdxArr = new BigInt64Array(1);
  beatIdxArr[0] = BigInt(beatIdx);
  const feeds = {
    token_id: tensor("int64", tokenIdArr, [1]),
    step_id: tensor("int64", stepIdArr, [1]),
    beat_idx: tensor("int64", beatIdxArr, [1]),
    aligned_memory: ctx.alignedMemory,
    prefix_bias: prefixBiasT,
    cross_k: ctx.crossK,
    cross_v: ctx.crossV,
    mem_invalid: ctx.memInvalid,
    past_self_k: pastKTensor,
    past_self_v: pastVTensor,
  };
  const out = await runSession(sess, feeds);
  const logitsArr = await out.logits.getData(true);
  const presentK = out.present_self_k;
  const presentV = out.present_self_v;
  const logits = new Float32Array(150);
  for (let i = 0; i < 150; i += 1) logits[i] = logitsArr[i];
  return { logits, presentK, presentV };
}

// Batched CFG shares the encoder context while retaining independent decoder
// histories in the batch dimension. WebGPU keeps the returned batch-2 cache
// in gpu-buffer just like the single-stream path.
async function runDecoderBatchStep(sess, tokenIds, stepId, beatIdx, ctx, condPrefixBias, uncondPrefixBias, pastK, pastV) {
  const { nLayers, nHead, headDim } = ctx;
  let pastKTensor, pastVTensor;
  if (isTensorLike(pastK)) {
    pastKTensor = pastK;
    pastVTensor = pastV;
  } else {
    const pastLen = pastK.length / (nLayers * 2 * nHead * headDim);
    const pastKDims = [nLayers, 2, nHead, pastLen, headDim];
    pastKTensor = tensor("float32", pastK, pastKDims);
    pastVTensor = tensor("float32", pastV, pastKDims);
  }
  const prefixBias = new Float32Array(condPrefixBias.length + uncondPrefixBias.length);
  prefixBias.set(condPrefixBias, 0);
  prefixBias.set(uncondPrefixBias, condPrefixBias.length);
  const tokenIdArr = new BigInt64Array([BigInt(tokenIds[0]), BigInt(tokenIds[1])]);
  const stepIdArr = new BigInt64Array([BigInt(stepId), BigInt(stepId)]);
  const beatIdxArr = new BigInt64Array([BigInt(beatIdx), BigInt(beatIdx)]);
  const feeds = {
    token_id: tensor("int64", tokenIdArr, [2]),
    step_id: tensor("int64", stepIdArr, [2]),
    beat_idx: tensor("int64", beatIdxArr, [2]),
    aligned_memory: ctx.alignedMemory,
    prefix_bias: tensor("float32", prefixBias, [2, condPrefixBias.length]),
    cross_k: ctx.crossK,
    cross_v: ctx.crossV,
    mem_invalid: ctx.memInvalid,
    past_self_k: pastKTensor,
    past_self_v: pastVTensor,
  };
  const out = await runSession(sess, feeds);
  const logitsArr = await out.logits.getData(true);
  const condLogits = new Float32Array(VOCAB_SIZE);
  const uncondLogits = new Float32Array(VOCAB_SIZE);
  for (let i = 0; i < VOCAB_SIZE; i += 1) {
    condLogits[i] = logitsArr[i];
    uncondLogits[i] = logitsArr[VOCAB_SIZE + i];
  }
  return { condLogits, uncondLogits, presentK: out.present_self_k, presentV: out.present_self_v };
}

async function generate({
  manifest,
  encoderSession,
  decoderSession,
  beatMel,
  beatMask,
  nBeats,
  prefixTokens,
  prefixBias,
  temperature,
  topP,
  rng,
  guidanceScale = 1.0,
  uncondPrefixTokens = null,
  uncondPrefixBias = null,
  maxTokens = null,
  onProgress = null,
  progressIntervalBeats = null,
  log = null,
  encoderCtx = null, // precomputed encoder outputs (parity isolation); skips encoder run when present
}) {
  const stage = (manifest && manifest.stages && manifest.stages.transcriber) || {};
  const modelConfig = (stage && stage.modelConfig) || {};
  const nLayers = Number(modelConfig.nLayers || 10);
  const nHead = Number(modelConfig.nhead || 8);
  const headDim = Number(modelConfig.headDim || 64);
  const dModel = Number(modelConfig.dModel || 512);
  const maxTokensLimit = maxTokens != null ? maxTokens : Number(modelConfig.maxTokens || 8192);
  const ctx0 = { nLayers, nHead, headDim };
  const guidanceEnabled = guidanceScale != null && guidanceScale !== 1.0
    && Array.isArray(uncondPrefixTokens) && uncondPrefixBias != null;
  const cfgTwoCall = process.env.AUTOCHART_CFG_TWO_CALL === "1";

  let alignedMemory, crossK, crossV, memInvalid;
  if (encoderCtx) {
    ({ alignedMemory, crossK, crossV, memInvalid } = encoderCtx);
    if (log) log(`  encoder: using precomputed ctx (parity mode)`);
  } else {
    if (!encoderSession) throw new Error("generate: encoderSession required when encoderCtx not provided");
    const beatMelTensor = tensor("float32", beatMel, [1, nBeats, 5, 80, 32]);
    const beatMaskTensor = tensor("bool", beatMask, [1, nBeats]);
    const encFeeds = { beat_mel: beatMelTensor, beat_mask: beatMaskTensor };
    if (log) log("  encoder: running on beat_mel...");
    const encOut = await runSession(encoderSession, encFeeds);
    alignedMemory = encOut.aligned_memory;
    crossK = encOut.cross_k;
    crossV = encOut.cross_v;
    memInvalid = encOut.mem_invalid;
  }
  const ctx = { ...ctx0, alignedMemory, crossK, crossV, memInvalid };

  const pastLen0 = 0;
  const emptyPastK = new Float32Array(nLayers * 1 * nHead * pastLen0 * headDim);

  const tokenList = prefixTokens.slice();
  let condPastK, condPastV, uncondPastK, uncondPastV, batchedPastK, batchedPastV;
  if (guidanceEnabled) {
    if (cfgTwoCall) {
      condPastK = new Float32Array(emptyPastK.length);
      condPastV = new Float32Array(emptyPastK.length);
      uncondPastK = new Float32Array(emptyPastK.length);
      uncondPastV = new Float32Array(emptyPastK.length);
    } else {
      batchedPastK = new Float32Array(0);
      batchedPastV = new Float32Array(0);
    }
  }
  let singlePastK = null, singlePastV = null;
  if (!guidanceEnabled) {
    singlePastK = new Float32Array(emptyPastK.length);
    singlePastV = new Float32Array(emptyPastK.length);
  }
  const uncondTokenList = uncondPrefixTokens ? uncondPrefixTokens.slice() : null;
  const prefixLen = prefixTokens.length;
  const uncondPrefixLen = uncondTokenList ? uncondTokenList.length : 0;

  let beatsEmitted = 0;
  let nextToken = null;
  const totalLimit = Math.min(maxTokensLimit, prefixLen + maxTokensLimit);

  const intervalBeats = progressIntervalBeats && progressIntervalBeats > 0 ? progressIntervalBeats : Infinity;
  let lastProgressBeat = 0;
  const t0 = Date.now();

  let lastIsBeat = false, lastIsEos = false;

  try {
    for (let step = 0; step < totalLimit; step += 1) {
      const beatIdx = Math.min(Math.max(beatsEmitted - 1, 0), Math.max(nBeats - 1, 0));
      let sampled;
      if (guidanceEnabled) {
        let condToken, uncondToken;
        if (step < prefixLen) {
          condToken = tokenList[step];
        } else {
          condToken = nextToken;
        }
        if (step < uncondPrefixLen) {
          uncondToken = uncondTokenList[step];
        } else if (step >= prefixLen) {
          uncondToken = nextToken;
        }
        let condLogits, uncondLogits;
        if (cfgTwoCall) {
          const cond = await runDecoderStep(
            decoderSession, condToken, step, beatIdx, ctx, prefixBias, condPastK, condPastV
          );
          const uncond = await runDecoderStep(
            decoderSession, uncondToken, step, beatIdx, ctx, uncondPrefixBias, uncondPastK, uncondPastV
          );
          disposeGpuTensor(condPastK);
          disposeGpuTensor(condPastV);
          disposeGpuTensor(uncondPastK);
          disposeGpuTensor(uncondPastV);
          condPastK = cond.presentK; condPastV = cond.presentV;
          uncondPastK = uncond.presentK; uncondPastV = uncond.presentV;
          condLogits = cond.logits;
          uncondLogits = uncond.logits;
        } else {
          const batched = await runDecoderBatchStep(
            decoderSession, [condToken, uncondToken], step, beatIdx, ctx,
            prefixBias, uncondPrefixBias, batchedPastK, batchedPastV
          );
          disposeGpuTensor(batchedPastK);
          disposeGpuTensor(batchedPastV);
          batchedPastK = batched.presentK; batchedPastV = batched.presentV;
          condLogits = batched.condLogits;
          uncondLogits = batched.uncondLogits;
        }
        const guided = new Float32Array(condLogits.length);
        for (let i = 0; i < guided.length; i += 1) {
          guided[i] = uncondLogits[i] + guidanceScale * (condLogits[i] - uncondLogits[i]);
        }
        sampled = temperature > 0
          ? sampleNext(guided, { temperature, topP, rng, nBeats, beatsEmitted })
          : greedyArgmax(guided, nBeats, beatsEmitted);
        tokenList.push(sampled);
        uncondTokenList.push(sampled);
      } else {
        let token;
        if (step < prefixLen) token = tokenList[step];
        else token = nextToken;
        const r = await runDecoderStep(
          decoderSession, token, step, beatIdx, ctx, prefixBias, singlePastK, singlePastV
        );
        disposeGpuTensor(singlePastK);
        disposeGpuTensor(singlePastV);
        singlePastK = r.presentK; singlePastV = r.presentV;
        sampled = temperature > 0
          ? sampleNext(r.logits, { temperature, topP, rng, nBeats, beatsEmitted })
          : greedyArgmax(r.logits, nBeats, beatsEmitted);
        tokenList.push(sampled);
      }
      nextToken = sampled;
      lastIsBeat = sampled === BEAT_TOKEN;
      lastIsEos = sampled === EOS_TOKEN;

      if (lastIsBeat) beatsEmitted += 1;

      if (onProgress && (beatsEmitted - lastProgressBeat >= intervalBeats || lastIsEos || step + 1 === totalLimit)) {
        onProgress({
          tokens: tokenList.slice(),
          beatsEmitted,
          committedBeats: Math.min(beatsEmitted, nBeats),
          totalBeats: nBeats,
          tokenCount: tokenList.length,
          done: lastIsEos || step + 1 === totalLimit,
        });
        lastProgressBeat = beatsEmitted;
      }

      if (lastIsEos) break;
    }
  } finally {
    // Encoder outputs owned here unless encoderCtx was passed (parity isolation).
    disposeGpuTensor(condPastK);
    disposeGpuTensor(condPastV);
    disposeGpuTensor(uncondPastK);
    disposeGpuTensor(uncondPastV);
    disposeGpuTensor(batchedPastK);
    disposeGpuTensor(batchedPastV);
    disposeGpuTensor(singlePastK);
    disposeGpuTensor(singlePastV);
    if (!encoderCtx) {
      disposeGpuTensor(ctx.alignedMemory);
      disposeGpuTensor(ctx.crossK);
      disposeGpuTensor(ctx.crossV);
      disposeGpuTensor(ctx.memInvalid);
    }
  }

  const elapsed = (Date.now() - t0) / 1000;
  return {
    tokens: Int32Array.from(tokenList),
    stats: { generationSeconds: Math.round(elapsed * 100) / 100, nTokens: tokenList.length, nBeats },
  };
}

// mulberry32; not bit-compatible with numpy PCG64.
function makeRng(seed) {
  let a = Number(seed) >>> 0;
  if (!a) a = 0x9e3779b9;
  return {
    nextFloat() {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    choice(probs) {
      let r = this.nextFloat();
      let acc = 0;
      for (let i = 0; i < probs.length; i += 1) {
        acc += probs[i];
        if (r < acc) return i;
      }
      return probs.length - 1;
    },
    choiceFromIndices(keptIndices, probs) {
      let r = this.nextFloat();
      let acc = 0;
      for (let i = 0; i < probs.length; i += 1) {
        acc += probs[i];
        if (r < acc) return keptIndices[i];
      }
      return keptIndices[keptIndices.length - 1];
    },
  };
}

module.exports = {
  loadEncoderSessions,
  loadDecoderSession,
  generate,
  makeRng,
  runEncoder: async (encoderSession, beatMel, beatMask, nBeats) => {
    const beatMelTensor = tensor("float32", beatMel, [1, nBeats, 5, 80, 32]);
    const beatMaskTensor = tensor("bool", beatMask, [1, nBeats]);
    const encOut = await runSession(encoderSession, { beat_mel: beatMelTensor, beat_mask: beatMaskTensor });
    return {
      alignedMemory: encOut.aligned_memory,
      crossK: encOut.cross_k,
      crossV: encOut.cross_v,
      memInvalid: encOut.mem_invalid,
    };
  },
  runDecoderStep,
  runDecoderBatchStep,
  disposeGpuTensor,
  greedyArgmax,
  sampleNext,
  maskedLogits,
  NEG_INF,
};

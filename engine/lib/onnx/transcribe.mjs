// JS port of the reference ONNX transcriber. Greedy (T<=0) is the CPU parity bar;
// sampled mode uses app-owned RNG (not bit-compatible with numpy PCG64).

import { createSession, createRawSession, tensor, runSession, graphPath } from "./runtime.mjs";
import { KV_CACHE_SLICE_ONNX_BASE64 } from "./kvCacheSliceGraph.mjs";
import { inPlaceDecoderGraph } from "./decoderInPlace.mjs";
import { layerKvDecoderGraph, layerKvResizeGraph } from "./decoderLayerKv.mjs";
import {
  PAD_TOKEN,
  BOS_TOKEN,
  EOS_TOKEN,
  BEAT_TOKEN,
} from "./chartEventStream.mjs";

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
  // On the CPU the graph is rewritten to read its cache in place; on WebGPU
  // to write a cache per layer in place (decoderLayerKv.mjs). Its present_*
  // outputs must stay unpinned: onnxruntime-node only writes into the cache
  // tensors passed as fetches for outputs it doesn't pin, and allocates new
  // ones (leaving the cache empty) for those it does.
  return createSession(graphPath(manifest, "transcriber-decoder-step"), {
    device,
    preferredOutputLocation: {
      present_self_k: "gpu-buffer",
      present_self_v: "gpu-buffer",
    },
    cpuGraph: { name: "inplace-kv", rewrite: inPlaceDecoderGraph },
    gpuGraph: { name: "layer-kv", rewrite: layerKvDecoderGraph, preferredOutputLocation: {} },
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

// In-place self-attention cache, for decoder graphs that read each layer's
// cache as past_k_<i>/past_v_<i> [batch, heads, cap, headDim] (see
// decoderInPlace.mjs). The cache keeps spare rows past `length`; self_mask
// hides them, and each call writes only its own rows (new_self_k/new_self_v).
// The old graph instead copies the whole cache in and out on every token.
const KV_GROW = 256;

function isInPlaceKv(v) {
  return v != null && v.inPlace === true;
}

function inPlaceDecoder(sess) {
  return Boolean(sess && Array.isArray(sess.inputNames) && sess.inputNames.includes("past_k_0"));
}

function newKv(ctx, batch, cap = KV_GROW) {
  const { nLayers, nHead, headDim } = ctx;
  const size = nLayers * batch * nHead * cap * headDim;
  return {
    inPlace: true, batch, cap, length: 0,
    k: new Float32Array(size), v: new Float32Array(size),
    mask: new Float32Array(cap).fill(NEG_INF),
  };
}

// A copy of kv's first `keep` rows with room for `cap`.
function copyKv(ctx, kv, keep, cap) {
  const { nLayers, nHead, headDim } = ctx;
  const out = newKv(ctx, kv.batch, cap);
  const rows = nLayers * kv.batch * nHead;
  const n = keep * headDim;
  for (let r = 0; r < rows; r += 1) {
    out.k.set(kv.k.subarray(r * kv.cap * headDim, r * kv.cap * headDim + n), r * cap * headDim);
    out.v.set(kv.v.subarray(r * kv.cap * headDim, r * kv.cap * headDim + n), r * cap * headDim);
  }
  out.mask.fill(0, 0, keep);
  out.length = keep;
  return out;
}

// The cache feeds for a call that adds n rows (growing the cache first if needed).
function kvFeeds(ctx, kv, n) {
  const { nLayers, nHead, headDim } = ctx;
  if (kv.length + n > kv.cap) {
    Object.assign(kv, copyKv(ctx, kv, kv.length, Math.ceil((kv.length + n) / KV_GROW) * KV_GROW + KV_GROW));
  }
  const feeds = { self_mask: tensor("float32", kv.mask, [kv.cap]) };
  const layerSize = kv.batch * nHead * kv.cap * headDim;
  const dims = [kv.batch, nHead, kv.cap, headDim];
  for (let i = 0; i < nLayers; i += 1) {
    feeds[`past_k_${i}`] = tensor("float32", kv.k.subarray(i * layerSize, (i + 1) * layerSize), dims);
    feeds[`past_v_${i}`] = tensor("float32", kv.v.subarray(i * layerSize, (i + 1) * layerSize), dims);
  }
  return feeds;
}

// Writes a call's new rows ([layers, batch, heads, n, headDim]) after the cache's.
async function appendKv(ctx, kv, out, n) {
  const { nLayers, nHead, headDim } = ctx;
  const newK = await out.new_self_k.getData();
  const newV = await out.new_self_v.getData();
  const rows = nLayers * kv.batch * nHead;
  const size = n * headDim;
  const at = kv.length * headDim;
  for (let r = 0; r < rows; r += 1) {
    kv.k.set(newK.subarray(r * size, (r + 1) * size), r * kv.cap * headDim + at);
    kv.v.set(newV.subarray(r * size, (r + 1) * size), r * kv.cap * headDim + at);
  }
  kv.mask.fill(0, kv.length, kv.length + n);
  kv.length += n;
}

// Per-layer cache on WebGPU, for decoder graphs that take each layer's cache
// as past_key_<i>/past_value_<i> [batch, heads, cap, headDim] with the first
// seqlens_k rows filled, and write the new row into those same tensors
// (passed again as the present_key_<i>/present_value_<i> outputs; see
// decoderLayerKv.mjs). A call may add several rows (the fill-in decoder).
// The buffers stay on the device and keep spare rows; a full cache is copied
// into a bigger one.
const LAYER_KV_GROW = 1024;

function isLayerKv(v) {
  return v != null && v.layerKv === true;
}

function layerKvDecoder(sess) {
  return Boolean(sess && Array.isArray(sess.inputNames) && sess.inputNames.includes("past_key_0") && sess.inputNames.includes("seqlens_k"));
}

let layerResizeSession = null;
// Each layer's first `keep` rows in new buffers with room for `cap`.
async function resizeLayers(k, v, keep, cap) {
  if (!layerResizeSession) {
    layerResizeSession = createRawSession(layerKvResizeGraph(), {
      executionProviders: ["webgpu"],
      preferredOutputLocation: { k_out: "gpu-buffer", v_out: "gpu-buffer" },
    });
  }
  const session = await layerResizeSession;
  const keepT = tensor("int64", BigInt64Array.from([BigInt(keep)]), [1]);
  const extraT = tensor("int64", BigInt64Array.from([BigInt(cap - keep)]), [1]);
  const out = { k: [], v: [] };
  for (let i = 0; i < k.length; i += 1) {
    const r = await runSession(session, { k: k[i], v: v[i], keep: keepT, extra: extraT });
    out.k.push(r.k_out);
    out.v.push(r.v_out);
  }
  return out;
}

async function newLayerKv(ctx, batch, cap = LAYER_KV_GROW) {
  const { nLayers, nHead, headDim } = ctx;
  const empty = Array(nLayers).fill(tensor("float32", new Float32Array(0), [batch, nHead, 0, headDim]));
  return { layerKv: true, batch, cap, length: 0, ...(await resizeLayers(empty, empty, 0, cap)) };
}

// A copy of kv's first `keep` rows with room for `cap`.
async function copyLayerKv(kv, keep, cap) {
  return { layerKv: true, batch: kv.batch, cap, length: keep, ...(await resizeLayers(kv.k, kv.v, keep, cap)) };
}

function disposeLayerKv(kv) {
  if (!kv.k) return;
  for (const t of [...kv.k, ...kv.v]) disposeGpuTensor(t);
  kv.k = kv.v = null;
}

// Frees any kind of cache: per-layer, a gpu-buffer tensor, or nothing to do.
function freeCache(v) {
  if (isLayerKv(v)) disposeLayerKv(v);
  else disposeGpuTensor(v);
}

// Runs a per-layer-cache graph on feeds that add n rows to kv (growing it
// first when they don't fit). Returns the outputs; kv now holds the rows.
async function runLayerKv(sess, feeds, kv, n) {
  if (kv.length + n > kv.cap) {
    const old = { k: kv.k, v: kv.v };
    Object.assign(kv, await copyLayerKv(kv, kv.length, Math.ceil((kv.length + n) / LAYER_KV_GROW) * LAYER_KV_GROW));
    disposeLayerKv(old);
  }
  const all = {
    ...feeds,
    seqlens_k: tensor("int32", new Int32Array(kv.batch).fill(kv.length + n - 1), [kv.batch]),
    total_sequence_length: tensor("int32", Int32Array.from([kv.length + n]), []),
  };
  const fetches = { logits: null };
  for (let i = 0; i < kv.k.length; i += 1) {
    all[`past_key_${i}`] = fetches[`present_key_${i}`] = kv.k[i];
    all[`past_value_${i}`] = fetches[`present_value_${i}`] = kv.v[i];
  }
  const out = await runSession(sess, all, fetches);
  kv.length += n;
  return out;
}

async function runLayerKvStep(sess, tokenIds, stepId, beatIdx, ctx, prefixBias, kv) {
  const batch = tokenIds.length;
  if (!isLayerKv(kv)) {
    const length = isTensorLike(kv) ? kv.dims[3] : kv ? kv.length : 0;
    if (length) throw new Error("decoder: this graph needs a per-layer cache");
    kv = await newLayerKv(ctx, batch);
  }
  const out = await runLayerKv(sess, {
    token_id: tensor("int64", BigInt64Array.from(tokenIds, BigInt), [batch]),
    step_id: tensor("int64", new BigInt64Array(batch).fill(BigInt(stepId)), [batch]),
    beat_idx: tensor("int64", new BigInt64Array(batch).fill(BigInt(beatIdx)), [batch]),
    aligned_memory: ctx.alignedMemory,
    prefix_bias: tensor("float32", prefixBias, [batch, prefixBias.length / batch]),
    cross_k: ctx.crossK,
    cross_v: ctx.crossV,
    mem_invalid: ctx.memInvalid,
  }, kv, 1);
  return { logits: Float32Array.from(await out.logits.getData()), kv };
}

// The encoder's cross keys/values as per-layer views (cross_k_<i>, cross_v_<i>).
const crossLayerFeeds = new WeakMap();
function crossLayers(ctx) {
  let feeds = crossLayerFeeds.get(ctx.crossK);
  if (feeds) return feeds;
  const { nLayers } = ctx;
  feeds = {};
  for (const [name, t] of [["cross_k", ctx.crossK], ["cross_v", ctx.crossV]]) {
    const [, heads, nBeats, headDim] = t.dims;
    const size = heads * nBeats * headDim;
    for (let i = 0; i < nLayers; i += 1) {
      feeds[`${name}_${i}`] = tensor("float32", t.data.subarray(i * size, (i + 1) * size), [heads, nBeats, headDim]);
    }
  }
  crossLayerFeeds.set(ctx.crossK, feeds);
  return feeds;
}

// An in-place cache holding a plain [layers, batch, heads, length, headDim] one.
function kvFromCache(ctx, batch, k, v) {
  const { nLayers, nHead, headDim } = ctx;
  const kData = isTensorLike(k) ? k.data : k;
  const vData = isTensorLike(v) ? v.data : v;
  const length = kData.length / (nLayers * batch * nHead * headDim);
  return copyKv(ctx, { batch, cap: length, k: kData, v: vData }, length, length + KV_GROW);
}

async function runInPlaceStep(sess, tokenIds, stepId, beatIdx, ctx, prefixBias, kv) {
  const batch = tokenIds.length;
  const feeds = {
    token_id: tensor("int64", BigInt64Array.from(tokenIds, BigInt), [batch]),
    step_id: tensor("int64", new BigInt64Array(batch).fill(BigInt(stepId)), [batch]),
    beat_idx: tensor("int64", new BigInt64Array(batch).fill(BigInt(beatIdx)), [batch]),
    aligned_memory: ctx.alignedMemory,
    prefix_bias: tensor("float32", prefixBias, [batch, prefixBias.length / batch]),
    mem_invalid: ctx.memInvalid,
    ...kvFeeds(ctx, kv, 1),
    ...crossLayers(ctx),
  };
  const out = await runSession(sess, feeds);
  await appendKv(ctx, kv, out, 1);
  return Float32Array.from(await out.logits.getData());
}

async function runDecoderStep(sess, tokenId, stepId, beatIdx, ctx, prefixBias, pastK, pastV) {
  if (layerKvDecoder(sess)) {
    const { logits, kv } = await runLayerKvStep(sess, [tokenId], stepId, beatIdx, ctx, prefixBias, pastK);
    return { logits, presentK: kv, presentV: kv };
  }
  if (!isInPlaceKv(pastK) && inPlaceDecoder(sess)) pastK = kvFromCache(ctx, 1, pastK, pastV);
  if (isInPlaceKv(pastK)) {
    const logits = await runInPlaceStep(sess, [tokenId], stepId, beatIdx, ctx, prefixBias, pastK);
    return { logits, presentK: pastK, presentV: pastK };
  }
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
  // The model's vocab: 150 for v1, 167 with solo/section markers.
  const logits = Float32Array.from(logitsArr.subarray(0, logitsArr.length));
  return { logits, presentK, presentV };
}

// Batched CFG shares the encoder context while retaining independent decoder
// histories in the batch dimension. WebGPU keeps the returned batch-2 cache
// in gpu-buffer just like the single-stream path.
async function runDecoderBatchStep(sess, tokenIds, stepId, beatIdx, ctx, condPrefixBias, uncondPrefixBias, pastK, pastV) {
  const { nLayers, nHead, headDim } = ctx;
  const prefixBias = new Float32Array(condPrefixBias.length + uncondPrefixBias.length);
  prefixBias.set(condPrefixBias, 0);
  prefixBias.set(uncondPrefixBias, condPrefixBias.length);
  if (layerKvDecoder(sess)) {
    const { logits, kv } = await runLayerKvStep(sess, tokenIds, stepId, beatIdx, ctx, prefixBias, pastK);
    const vocab = logits.length / 2;
    return { condLogits: logits.slice(0, vocab), uncondLogits: logits.slice(vocab), presentK: kv, presentV: kv };
  }
  if (!isInPlaceKv(pastK) && inPlaceDecoder(sess)) pastK = kvFromCache(ctx, 2, pastK, pastV);
  if (isInPlaceKv(pastK)) {
    const logits = await runInPlaceStep(sess, tokenIds, stepId, beatIdx, ctx, prefixBias, pastK);
    const vocab = logits.length / 2;
    return { condLogits: logits.slice(0, vocab), uncondLogits: logits.slice(vocab), presentK: pastK, presentV: pastK };
  }
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
  const vocab = logitsArr.length / 2;
  const condLogits = Float32Array.from(logitsArr.subarray(0, vocab));
  const uncondLogits = Float32Array.from(logitsArr.subarray(vocab, 2 * vocab));
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
  // The reference decoder only samples once the whole prefix is in. The
  // original loop also samples while feeding the prefix and appends those
  // predictions after it (never fed back; the chart decoder skips them) and
  // spends RNG draws on them. v1 keeps that so its seeds reproduce; models
  // whose manifest sets decode.sampleOnlyAfterPrefix match the reference.
  sampleOnlyAfterPrefix = false,
  // Read-only hook, called with (tokens fed so far, logits) at every step that
  // samples; with CFG the logits are the guided ones (as the reference's
  // logits_observer).
  onLogits = null,
  // Resume from a self-attention cache that already holds the first
  // initialCache.length prefix tokens (sliceCache of a returned cache);
  // decoding starts at that step. Reference-sampling models only.
  initialCache = null,
  // Hand back the final self-attention cache (every token fed) as result.cache
  // instead of freeing it; the caller owns it (sliceCache, disposeCache).
  returnCache = false,
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
  const cfgTwoCall = globalThis.process?.env?.AUTOCHART_CFG_TWO_CALL === "1";

  let alignedMemory, crossK, crossV, memInvalid;
  if (encoderCtx) {
    ({ alignedMemory, crossK, crossV, memInvalid } = encoderCtx);
    if (log) log(`  encoder: using precomputed ctx (parity mode)`);
  } else {
    if (!encoderSession) throw new Error("generate: encoderSession required when encoderCtx not provided");
    const beatMelTensor = tensor("float32", beatMel, beatMelDims(beatMel, nBeats));
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
  const cacheMode = guidanceEnabled ? (cfgTwoCall ? "twocall" : "batched") : "single";
  if (initialCache) {
    if (!sampleOnlyAfterPrefix) throw new Error("generate: initialCache needs sampleOnlyAfterPrefix");
    if (initialCache.mode !== cacheMode) {
      throw new Error(`generate: initialCache is ${initialCache.mode}, this decode is ${cacheMode}`);
    }
    if (!(initialCache.length > 0 && initialCache.length < prefixTokens.length)) {
      throw new Error("generate: initialCache must hold part of the prefix");
    }
  }
  const inPlace = inPlaceDecoder(decoderSession);
  const layered = layerKvDecoder(decoderSession);
  // An empty cache: K and V are one object for the in-place and per-layer kinds.
  const pair = async (batch) => {
    if (inPlace) return Array(2).fill(newKv(ctx, batch));
    if (layered) return Array(2).fill(await newLayerKv(ctx, batch));
    return [new Float32Array(emptyPastK.length), new Float32Array(emptyPastK.length)];
  };
  let singlePastK = null, singlePastV = null;
  if (!initialCache) {
    if (!guidanceEnabled) [singlePastK, singlePastV] = await pair(1);
    else if (cfgTwoCall) {
      [condPastK, condPastV] = await pair(1);
      [uncondPastK, uncondPastV] = await pair(1);
    } else {
      [batchedPastK, batchedPastV] = await pair(2);
    }
  }
  if (initialCache) {
    if (cacheMode === "single") ({ k: singlePastK, v: singlePastV } = initialCache);
    else if (cacheMode === "batched") ({ k: batchedPastK, v: batchedPastV } = initialCache);
    else ({ condK: condPastK, condV: condPastV, uncondK: uncondPastK, uncondV: uncondPastV } = initialCache);
  }
  const startStep = initialCache ? initialCache.length : 0;
  const uncondTokenList = uncondPrefixTokens ? uncondPrefixTokens.slice() : null;
  const prefixLen = prefixTokens.length;
  const uncondPrefixLen = uncondTokenList ? uncondTokenList.length : 0;

  // BEATs already in the cache count toward the clock, as in the reference.
  let beatsEmitted = 0;
  for (let i = 0; i < startStep; i += 1) if (tokenList[i] === BEAT_TOKEN) beatsEmitted += 1;
  let nextToken = null;
  let stepsFed = startStep;
  let cacheOut = null;
  const totalLimit = Math.min(maxTokensLimit, prefixLen + maxTokensLimit);

  const intervalBeats = progressIntervalBeats && progressIntervalBeats > 0 ? progressIntervalBeats : Infinity;
  let lastProgressBeat = 0;
  const t0 = Date.now();

  let lastIsBeat = false, lastIsEos = false;

  try {
    for (let step = startStep; step < totalLimit; step += 1) {
      // A prefix may carry BEATs (a resumed or forced stream); sampled BEATs
      // are counted when sampled, one step before they are fed.
      if (step < prefixLen && tokenList[step] === BEAT_TOKEN) beatsEmitted += 1;
      const beatIdx = Math.min(Math.max(beatsEmitted - 1, 0), Math.max(nBeats - 1, 0));
      stepsFed = step + 1;
      const samplesThisStep = !sampleOnlyAfterPrefix || step >= prefixLen - 1;
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
        if (!samplesThisStep) continue;
        const guided = new Float32Array(condLogits.length);
        for (let i = 0; i < guided.length; i += 1) {
          guided[i] = uncondLogits[i] + guidanceScale * (condLogits[i] - uncondLogits[i]);
        }
        if (onLogits) onLogits(tokenList, guided);
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
        if (!samplesThisStep) continue;
        if (onLogits) onLogits(tokenList, r.logits);
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
    if (returnCache) {
      // Move the live tensors out so the cleanup below leaves them alone.
      cacheOut = { mode: cacheMode, nLayers, nHead, headDim, batch: cacheMode === "batched" ? 2 : 1, length: stepsFed };
      if (cacheMode === "single") {
        Object.assign(cacheOut, { k: singlePastK, v: singlePastV });
        singlePastK = singlePastV = null;
      } else if (cacheMode === "batched") {
        Object.assign(cacheOut, { k: batchedPastK, v: batchedPastV });
        batchedPastK = batchedPastV = null;
      } else {
        Object.assign(cacheOut, { condK: condPastK, condV: condPastV, uncondK: uncondPastK, uncondV: uncondPastV });
        condPastK = condPastV = uncondPastK = uncondPastV = null;
      }
    }
  } finally {
    // Encoder outputs owned here unless encoderCtx was passed (parity isolation).
    freeCache(condPastK);
    freeCache(condPastV);
    freeCache(uncondPastK);
    freeCache(uncondPastV);
    freeCache(batchedPastK);
    freeCache(batchedPastV);
    freeCache(singlePastK);
    freeCache(singlePastV);
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
    ...(cacheOut ? { cache: cacheOut } : {}),
  };
}

const CACHE_PAIRS = { single: [["k", "v"]], batched: [["k", "v"]], twocall: [["condK", "condV"], ["uncondK", "uncondV"]] };

// Keep the first `keep` positions of a returned cache ([layers, batch, heads,
// length, headDim], along the length axis). Causal attention makes this
// exactly the cache after feeding those tokens. GPU-resident caches are cut on
// the device (onnxruntime-node cannot download a gpu-buffer tensor); CPU ones
// in JS. The input cache is left intact; free it with disposeCache.
async function sliceCache(cache, keep) {
  if (!(keep > 0 && keep <= cache.length)) throw new Error(`sliceCache: keep ${keep} outside 1..${cache.length}`);
  const sliced = { ...cache, length: keep };
  for (const [kKey, vKey] of CACHE_PAIRS[cache.mode]) {
    const k = cache[kKey];
    const v = cache[vKey];
    if (isInPlaceKv(k)) {
      sliced[kKey] = sliced[vKey] = copyKv(cache, k, keep, k.cap);
    } else if (isLayerKv(k)) {
      sliced[kKey] = sliced[vKey] = await copyLayerKv(k, keep, k.cap);
    } else if (isTensorLike(k) && k.location === "gpu-buffer") {
      ({ k: sliced[kKey], v: sliced[vKey] } = await sliceGpuCache(k, v, keep));
    } else {
      sliced[kKey] = sliceCacheData(cache, isTensorLike(k) ? k.data : k, keep);
      sliced[vKey] = sliceCacheData(cache, isTensorLike(v) ? v.data : v, keep);
    }
  }
  return sliced;
}

function sliceCacheData({ nLayers, batch, nHead, headDim, length }, data, keep) {
  const out = new Float32Array(nLayers * batch * nHead * keep * headDim);
  const rows = nLayers * batch * nHead;
  for (let r = 0; r < rows; r += 1) {
    out.set(data.subarray(r * length * headDim, (r * length + keep) * headDim), r * keep * headDim);
  }
  return out;
}

let gpuSliceSession = null;
async function sliceGpuCache(k, v, keep) {
  if (!gpuSliceSession) {
    gpuSliceSession = createRawSession(Uint8Array.from(atob(KV_CACHE_SLICE_ONNX_BASE64), (c) => c.charCodeAt(0)), {
      executionProviders: ["webgpu"],
      preferredOutputLocation: { k_out: "gpu-buffer", v_out: "gpu-buffer" },
    });
  }
  const session = await gpuSliceSession;
  const out = await runSession(session, {
    past_k: k,
    past_v: v,
    keep: tensor("int64", BigInt64Array.from([BigInt(keep)]), [1]),
  });
  return { k: out.k_out, v: out.v_out };
}

// Free a returned or sliced cache's GPU buffers.
function disposeCache(cache) {
  if (!cache) return;
  for (const key of ["k", "v", "condK", "condV", "uncondK", "uncondV"]) freeCache(cache[key]);
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

// beat_mel is [1, n_beats, channels, 80, 32]; the channel count is the
// model's (5 for v1, 6 for the six-stem models) and follows from the buffer size.
function beatMelDims(beatMel, nBeats) {
  const perChannel = nBeats * 80 * 32;
  const channels = perChannel > 0 ? beatMel.length / perChannel : 0;
  if (!Number.isInteger(channels) || channels < 1) {
    throw new Error(`beat_mel length ${beatMel.length} is not n_beats(${nBeats}) x C x 80 x 32`);
  }
  return [1, nBeats, channels, 80, 32];
}

async function runEncoder(encoderSession, beatMel, beatMask, nBeats) {
  const beatMelTensor = tensor("float32", beatMel, beatMelDims(beatMel, nBeats));
  const beatMaskTensor = tensor("bool", beatMask, [1, nBeats]);
  const encOut = await runSession(encoderSession, { beat_mel: beatMelTensor, beat_mask: beatMaskTensor });
  return {
    alignedMemory: encOut.aligned_memory,
    crossK: encOut.cross_k,
    crossV: encOut.cross_v,
    memInvalid: encOut.mem_invalid,
  };
}

export {
  inPlaceDecoder,
  layerKvDecoder,
  newLayerKv,
  copyLayerKv,
  disposeLayerKv,
  runLayerKv,
  newKv,
  copyKv,
  kvFeeds,
  appendKv,
  crossLayers,
  loadEncoderSessions,
  loadDecoderSession,
  generate,
  makeRng,
  runEncoder,
  runDecoderStep,
  runDecoderBatchStep,
  sliceCache,
  disposeCache,
  disposeGpuTensor,
  greedyArgmax,
  sampleNext,
  maskedLogits,
  NEG_INF,
};

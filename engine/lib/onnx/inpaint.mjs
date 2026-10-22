// Regenerate (inpainting) with a fill-in-the-middle model. Port of the
// training repo's FIM inference (src/data/fim.py build_fim_example;
// scripts/eval_inpainting_continuation.py fim_candidates, seam_lp_of).
//
// For each hole, left to right, on the chart with the earlier fills in it:
// 1. Lay the stream out as header, beats before the hole, FIM_SUF, beats after
//    it (later holes as one FIM_HOLE each), FIM_MID, then teacher-force the
//    hole's first BEAT and that beat's markers.
// 2. Sample `candidates` fills from that context. The chart's own solo and
//    section markers are teacher-forced after each hole BEAT and sampled
//    markers are masked, so a regenerate never moves a solo or section.
// 3. Score each fill by how likely the model, reading in normal order, finds
//    the chart's next `seamBeats` beats after it (its seam). Every fill comes
//    back; the best seam is marked chosen and stays in the chart for the
//    holes after it.
//
// One graph does everything (transcriber-fim-decoder): n tokens per call on
// top of a past cache. CFG (style picks set) runs a second, all-auto stream
// beside the conditioned one; seams are scored on the all-auto stream.

import { createSession, tensor, runSession } from "./runtime.mjs";
import { graphPath } from "./runtime.mjs";
import {
  PAD_TOKEN,
  BOS_TOKEN,
  EOS_TOKEN,
  BEAT_TOKEN,
  N_DESCRIPTORS,
  DESC_AUTO_BIN,
  descriptorToken,
  decodeTokens,
} from "./chartEventStream.mjs";
import { sampleNext, sliceCache, disposeCache, disposeGpuTensor, NEG_INF } from "./transcribe.mjs";

async function loadFimDecoderSession(manifest, device = "cpu") {
  return createSession(graphPath(manifest, "transcriber-fim-decoder"), {
    device,
    preferredOutputLocation: { present_self_k: "gpu-buffer", present_self_v: "gpu-buffer" },
  });
}

function isTensorLike(v) {
  return v != null && typeof v === "object" && typeof v.location === "string" && typeof v.getData === "function";
}

// One decoder history: its self-attention cache and the prefix bias it was
// conditioned with. Every token position is its cache position.
class Stream {
  constructor(session, ctx, prefixBias, cache = null) {
    this.session = session;
    this.ctx = ctx;
    this.prefixBias = prefixBias;
    const empty = new Float32Array(0);
    this.k = cache ? cache.k : empty;
    this.v = cache ? cache.v : empty;
    this.length = cache ? cache.length : 0;
  }

  cacheTensor(data) {
    if (isTensorLike(data)) return data;
    const { nLayers, nHead, headDim } = this.ctx;
    return tensor("float32", data, [nLayers, 1, nHead, this.length, headDim]);
  }

  // Feeds tokens at positions length.. and returns their logits (n x vocab).
  async feed(tokens, beatIdx) {
    const n = tokens.length;
    const feeds = {
      token_id: tensor("int64", BigInt64Array.from(tokens, BigInt), [n]),
      step_id: tensor("int64", BigInt64Array.from({ length: n }, (_, i) => BigInt(this.length + i)), [n]),
      beat_idx: tensor("int64", BigInt64Array.from(beatIdx, BigInt), [n]),
      aligned_memory: this.ctx.alignedMemory,
      prefix_bias: tensor("float32", this.prefixBias, [1, this.prefixBias.length]),
      cross_k: this.ctx.crossK,
      cross_v: this.ctx.crossV,
      mem_invalid: this.ctx.memInvalid,
      past_self_k: this.cacheTensor(this.k),
      past_self_v: this.cacheTensor(this.v),
    };
    const out = await runSession(this.session, feeds);
    const logits = Float32Array.from(await out.logits.getData(true));
    disposeGpuTensor(this.k);
    disposeGpuTensor(this.v);
    this.k = out.present_self_k;
    this.v = out.present_self_v;
    this.length += n;
    return logits;
  }

  // Feeds tokens in chunks; returns the last position's logits.
  async prefill(tokens, beatIdx, chunk) {
    let last = null;
    for (let i = 0; i < tokens.length; i += chunk) {
      const logits = await this.feed(tokens.slice(i, i + chunk), beatIdx.slice(i, i + chunk));
      last = logits.subarray(logits.length - this.ctx.vocab);
    }
    return last;
  }

  // A new stream holding a copy of this one's first `keep` positions.
  async fork(keep) {
    const cache = await sliceCache(
      { mode: "single", nLayers: this.ctx.nLayers, nHead: this.ctx.nHead, headDim: this.ctx.headDim, batch: 1, length: this.length, k: this.k, v: this.v },
      keep
    );
    return new Stream(this.session, this.ctx, this.prefixBias, cache);
  }

  dispose() {
    disposeCache({ k: this.k, v: this.v });
    this.k = this.v = null;
  }
}

// Position of every BEAT token; beat b spans [starts[b], starts[b+1]).
function beatStarts(tokens) {
  const starts = [];
  tokens.forEach((t, i) => { if (t === BEAT_TOKEN) starts.push(i); });
  return starts;
}

// The normal clock: each token's beat is the last BEAT at or before it.
function normalBeatIndex(tokens, startBeat = 0) {
  const out = new Array(tokens.length);
  let beats = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === BEAT_TOKEN) beats += 1;
    out[i] = Math.max(startBeat + beats - 1, 0);
  }
  return out;
}

// build_fim_example: reorders a normal stream (header, beats, EOS) around
// sorted, disjoint holes [first beat, end beat); the first hole is filled.
// Returns the context up to and including FIM_MID, its beat indices, and the
// hole's own tokens in the normal stream.
function buildFimContext(tokens, holes, fim) {
  const starts = beatStarts(tokens);
  const nBeats = starts.length;
  const eosPos = tokens.lastIndexOf(EOS_TOKEN) >= 0 ? tokens.lastIndexOf(EOS_TOKEN) : tokens.length;
  const beatPos = starts.concat([eosPos]);
  const plainIndex = normalBeatIndex(tokens);
  const outTokens = [];
  const outBeats = [];
  const span = (first, end) => {
    for (let i = beatPos[first]; i < beatPos[end]; i += 1) {
      outTokens.push(tokens[i]);
      outBeats.push(plainIndex[i]);
    }
  };
  const [holeStart, holeEnd] = holes[0];
  const headerEnd = nBeats ? starts[0] : eosPos;
  for (let i = 0; i < headerEnd; i += 1) {
    outTokens.push(tokens[i]);
    outBeats.push(0);
  }
  span(0, holeStart);
  const p0 = outTokens.length;
  outTokens.push(fim.FIM_SUF_TOKEN);
  outBeats.push(Math.min(holeEnd, nBeats - 1));
  let cursor = holeEnd;
  for (const [laterStart, laterEnd] of holes.slice(1)) {
    span(cursor, laterStart);
    outTokens.push(fim.FIM_HOLE_TOKEN);
    outBeats.push(laterStart);
    cursor = laterEnd;
  }
  span(cursor, nBeats);
  outTokens.push(fim.FIM_MID_TOKEN);
  outBeats.push(holeStart);
  return { tokens: outTokens, beats: outBeats, p0, beatPos, q: beatPos[holeEnd] };
}

// Marker tokens right after beat b's BEAT in a normal stream.
function markersAfterBeat(tokens, beatPos, b, isMarker) {
  const out = [];
  for (let i = beatPos[b] + 1; i < tokens.length && isMarker(tokens[i]); i += 1) out.push(tokens[i]);
  return out;
}

function logSoftmaxAt(logits, offset, vocab, token) {
  let max = NEG_INF;
  for (let i = 0; i < vocab; i += 1) if (logits[offset + i] > max) max = logits[offset + i];
  let sum = 0;
  for (let i = 0; i < vocab; i += 1) sum += Math.exp(logits[offset + i] - max);
  return logits[offset + token] - max - Math.log(sum);
}

// Style: the same knobs and 0..6 bins as Generate, keyed by knob name; a
// missing or null knob stays on auto.
function knobBins(knobs, knobNames) {
  const bins = new Array(N_DESCRIPTORS).fill(DESC_AUTO_BIN);
  let active = false;
  knobNames.forEach((name, index) => {
    const value = knobs[name];
    if (index >= N_DESCRIPTORS || !Number.isInteger(value)) return;
    bins[index] = Math.max(0, Math.min(6, value));
    active = true;
  });
  return { bins, active };
}

/**
 * tokens: the chart's normal stream (header with all-auto knobs, structure
 * flags, beats, EOS). holes: sorted, disjoint [startBeat, endBeat).
 * makePrefixBias(headerTokens) -> Float32Array. knobs: { [knobName]: 0..6 }.
 * Returns the final stream (chosen fills) and, per hole, every fill's tokens
 * and seam score plus the chosen one's index.
 * onProgress({ hole, candidate, candidates, beats, fill }) after each sampled
 * BEAT (fill: that candidate's tokens so far); onHole(result) per finished hole.
 */
async function inpaint({
  manifest,
  session,
  encoderCtx,
  nBeats,
  tokens: inputTokens,
  holes,
  knobs = {},
  knobNames,
  makePrefixBias,
  guidanceScale = 2,
  temperature,
  topP,
  rng,
  candidates,
  onProgress = null,
  onHole = null,
  log = null,
}) {
  const stage = manifest.stages.transcriber;
  const fim = stage.fim;
  const structure = stage.structure || {};
  const modelConfig = stage.modelConfig || {};
  const vocab = Number(fim.vocabSize);
  const maxTokens = Number(modelConfig.maxTokens || 8192);
  const chunk = Number(fim.prefillChunk || 512);
  const seamBeats = Number(fim.seamBeats || 8);
  const nCandidates = Math.max(1, Number(candidates || fim.candidates || 4));
  const ctx = {
    ...encoderCtx,
    nLayers: Number(modelConfig.nLayers || 10),
    nHead: Number(modelConfig.nhead || 8),
    headDim: Number(modelConfig.headDim || 64),
    vocab,
  };
  const markerLo = Number(structure.SOLO_FLAG_OFF ?? vocab);
  const markerHi = Number(structure.vocabSize ?? markerLo);
  const isMarker = (t) => t >= markerLo && t < markerHi;
  const descScan = 2;
  const headerLen = inputTokens.indexOf(BEAT_TOKEN);
  if (headerLen < 0) throw new Error("inpaint: the stream has no beats");

  let tokens = inputTokens.slice();
  const results = [];
  for (let h = 0; h < holes.length; h += 1) {
    const [b0, b1] = holes[h];
    const nHole = b1 - b0;
    const { bins, active } = knobBins(knobs, knobNames);
    const condTokens = tokens.slice();
    for (let k = 0; k < N_DESCRIPTORS; k += 1) condTokens[descScan + k] = descriptorToken(k, bins[k]);
    const useCfg = active && guidanceScale > 1;

    const layout = buildFimContext(condTokens, holes.slice(h), fim);
    const holeMarkers = (b) => markersAfterBeat(tokens, layout.beatPos, b, isMarker);
    const ctxTokens = layout.tokens.concat([BEAT_TOKEN], holeMarkers(b0));
    const ctxBeats = layout.beats.concat(new Array(ctxTokens.length - layout.tokens.length).fill(b0));
    const limit = Math.min(maxTokens - 2, ctxTokens.length + 4 * (layout.q - layout.p0) + 512);
    if (ctxTokens.length >= limit) {
      throw new Error("This song's chart is too long to regenerate part of it.");
    }

    const condBias = makePrefixBias(condTokens.slice(0, headerLen));
    const autoBias = makePrefixBias(tokens.slice(0, headerLen));
    const cond = new Stream(session, ctx, condBias);
    const auto = useCfg ? new Stream(session, ctx, autoBias) : null;
    // The all-auto stream reads the same layout with the plain header.
    const autoCtxTokens = ctxTokens.slice();
    for (let k = 0; k < N_DESCRIPTORS; k += 1) autoCtxTokens[descScan + k] = tokens[descScan + k];
    const t0 = Date.now();
    try {
      const condLast = await cond.prefill(ctxTokens, ctxBeats, chunk);
      const autoLast = auto ? await auto.prefill(autoCtxTokens, ctxBeats, chunk) : null;
      if (log) log(`inpaint: hole ${h + 1}/${holes.length} beats ${b0}-${b1}, context ${ctxTokens.length} tokens${useCfg ? ` (CFG w=${guidanceScale}, bins ${bins.join(",")})` : ""}, prefill ${((Date.now() - t0) / 1000).toFixed(1)}s`);

      // Seam suffix: the chart's next seamBeats beats after the hole.
      const qSeam = b1 + seamBeats < layout.beatPos.length - 1 ? layout.beatPos[b1 + seamBeats] : layout.beatPos[layout.beatPos.length - 1];
      const suffix = tokens.slice(layout.q, qSeam);
      const scoring = auto || cond;

      const fills = [];
      for (let c = 0; c < nCandidates; c += 1) {
        const condRun = await cond.fork(cond.length);
        const autoRun = auto ? await auto.fork(auto.length) : null;
        try {
          const middle = ctxTokens.slice(layout.tokens.length);
          let beats = 1;
          let condLogits = condLast;
          let autoLogits = autoLast;
          let failed = false;
          for (;;) {
            const guided = new Float32Array(vocab);
            for (let i = 0; i < vocab; i += 1) {
              guided[i] = autoLogits ? autoLogits[i] + guidanceScale * (condLogits[i] - autoLogits[i]) : condLogits[i];
            }
            guided[PAD_TOKEN] = NEG_INF;
            guided[BOS_TOKEN] = NEG_INF;
            for (let i = markerLo; i < vocab; i += 1) guided[i] = NEG_INF;
            const next = sampleNext(guided, { temperature, topP, rng, nBeats: nHole, beatsEmitted: beats });
            if (next === EOS_TOKEN) break;
            const feed = [next];
            if (next === BEAT_TOKEN) {
              beats += 1;
              feed.push(...holeMarkers(b0 + beats - 1));
            }
            if (condRun.length + feed.length >= limit) {
              failed = true;
              break;
            }
            middle.push(...feed);
            const beatIdx = new Array(feed.length).fill(b0 + beats - 1);
            const lc = await condRun.feed(feed, beatIdx);
            condLogits = lc.subarray(lc.length - vocab);
            if (autoRun) {
              const la = await autoRun.feed(feed, beatIdx);
              autoLogits = la.subarray(la.length - vocab);
            }
            if (onProgress && next === BEAT_TOKEN) {
              onProgress({ hole: h, candidate: c, candidates: nCandidates, beats: beats - 1, fill: middle });
            }
          }
          if (failed) {
            if (log) log(`inpaint: hole ${h + 1} candidate ${c + 1} hit the token limit`);
            continue;
          }
          let seam = null;
          if (suffix.length) {
            const scorer = await scoring.fork(layout.p0);
            try {
              const seq = middle.concat(suffix);
              const logits = await scorer.feed(seq, normalBeatIndex(seq, b0));
              let sum = 0;
              for (let j = middle.length; j < seq.length; j += 1) sum += logSoftmaxAt(logits, (j - 1) * vocab, vocab, seq[j]);
              seam = sum / suffix.length;
            } finally {
              scorer.dispose();
            }
          }
          fills.push({ middle, seam, candidate: c });
        } finally {
          condRun.dispose();
          if (autoRun) autoRun.dispose();
        }
      }
      if (!fills.length) throw new Error("Regenerate could not fit these bars in the model's token budget.");
      let chosen = 0;
      fills.forEach((fill, i) => {
        if (fill.seam !== null && (fills[chosen].seam === null || fill.seam > fills[chosen].seam)) chosen = i;
      });
      tokens = tokens.slice(0, layout.beatPos[b0]).concat(fills[chosen].middle, tokens.slice(layout.q));
      const seams = fills.map((f) => (f.seam === null ? null : Math.round(f.seam * 1000) / 1000));
      if (log) log(`inpaint: hole ${h + 1} chose fill ${chosen + 1} of ${fills.length} (seams ${seams.join(", ")}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      const done = { startBeat: b0, endBeat: b1, fills: fills.map((f) => f.middle), chosen, seams, cfg: useCfg, bins };
      results.push(done);
      if (onHole) onHole(done);
    } finally {
      cond.dispose();
      if (auto) auto.dispose();
    }
  }
  return { tokens, holes: results };
}

// The events a fill produced (beats relative to the song).
function fillEvents(fillTokens, startBeat) {
  return decodeTokens(fillTokens).events.map((e) => ({ ...e, beat: e.beat + startBeat }));
}

export { loadFimDecoderSession, inpaint, buildFimContext, normalBeatIndex, fillEvents };

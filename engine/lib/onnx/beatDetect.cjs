"use strict";

// Faithful JS port of the production Beat This detect->smooth grid pipeline.
//
// Reference (upstream beat_this + local smoother):
//   beat_this.inference.split_piece              (beat_this/inference.py:100 (upstream))
//   beat_this.inference.aggregate_prediction      (inference.py:138 (upstream))
//   beat_this.model.postprocessor.Postprocessor  (beat_this/model/postprocessor.py (upstream))
//       type="minimal", fps=50
//   production smoother                          (main() call order)
//
// The two ONNX graphs (fp32, opset 17, CPU):
//   beat_this_mel_fp32.onnx:  wav[samples] f32 mono 22050 Hz -> logmel[n_frames, 128] (time x bins)
//   beat_this_core_fp32.onnx: mel[1, 1500, 128] f32 -> beat_logits[1,1500], downbeat_logits[1,1500]
//
// The core graph is traced at chunk_size=1500 frames and is ONLY numerically valid
// at exactly 1500 frames (50 fps = 30 s of audio). Assert chunk mel length == 1500
// before every core call; off-shape inference silently corrupts output.

const { createSession, sessionDevice, tensor, runSession } = require("./sessionLoader.cjs");
const { graphPath } = require("./modelsManifest.cjs");

const DEFAULTS = {
  sampleRate: 22050,
  fps: 50,
  chunkSize: 1500,
  borderSize: 6,
  overlapMode: "keep_first",
  avoidShortEnd: true,
  smoother: {
    removeSpuriousMinRatio: 0.6,
    fillMissedMaxRatio: 1.7,
    dampedSmoothGain: 0.15,
    dampedSmoothWindow: 9,
  },
};

function beatOrchestration(manifest) {
  const stage = manifest?.stages?.beat || {};
  const smoother = { ...DEFAULTS.smoother, ...(stage.smoother || {}) };
  return {
    sampleRate: Number(stage.sampleRate ?? DEFAULTS.sampleRate),
    fps: Number(stage.fps ?? DEFAULTS.fps),
    chunkSize: Number(stage.chunkSize ?? DEFAULTS.chunkSize),
    borderSize: Number(stage.borderSize ?? DEFAULTS.borderSize),
    overlapMode: String(stage.overlapMode || DEFAULTS.overlapMode),
    avoidShortEnd: stage.avoidShortEnd ?? DEFAULTS.avoidShortEnd,
    removeSpuriousMinRatio: Number(smoother.removeSpuriousMinRatio),
    fillMissedMaxRatio: Number(smoother.fillMissedMaxRatio),
    dampedSmoothGain: Number(smoother.dampedSmoothGain),
    dampedSmoothWindow: Number(smoother.dampedSmoothWindow),
  };
}

async function loadBeatSessions(manifest, device = "cpu") {
  const mel = await createSession(graphPath(manifest, "beat-mel"), { device });
  const core = await createSession(graphPath(manifest, "beat-core"), { device });
  const devices = [mel, core].map((session) => sessionDevice(session, device));
  return {
    mel,
    core,
    device: devices.includes("cpu") ? "cpu" : devices[0] || device,
  };
}

// ----------------------------- split_piece ---------------------------------
// spect: Float32Array length N*128 row-major (time x bins).
// Returns chunks: Float32Array[] (each length chunkSize*128, row-major [1500, 128]) and starts: Int32Array.
function splitPiece(spect, N, orch) {
  const { chunkSize, borderSize, avoidShortEnd } = orch;
  if (N <= 0) return { chunks: [], starts: [] };

  const step = chunkSize - 2 * borderSize; // 1488
  // starts = arange(-border_size, N - border_size, step)
  const starts = [];
  for (let s = -borderSize; s < N - borderSize; s += step) starts.push(s);
  if (starts.length === 0) starts.push(-borderSize);
  if (avoidShortEnd && N > step) {
    // move the last index to the end of the piece - (chunk_size - border_size)
    starts[starts.length - 1] = N - (chunkSize - borderSize);
  }

  const nMels = 128;
  const chunks = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const srcStart = Math.max(start, 0);
    const srcEnd = Math.min(start + chunkSize, N);
    const realLen = srcEnd - srcStart;
    const left = Math.max(0, -start);
    const right = Math.max(0, Math.min(borderSize, start + chunkSize - N));
    // chunk = zeropad(spect[srcStart:srcEnd], left, right) to total length = chunkSize
    // The faithful padding guarantees length == chunkSize for every chunk when
    // N > step (avoid_short_end). For the contrived short-piece case the upstream
    // path itself mis-shapes the aggregate (see beat_this/inference.py:138 (upstream) note); we assert below.
    const chunk = new Float32Array(chunkSize * nMels);
    for (let t = 0; t < realLen; t += 1) {
      const srcOff = (srcStart + t) * nMels;
      const dstOff = (left + t) * nMels;
      chunk.set(spect.subarray(srcOff, srcOff + nMels), dstOff);
    }
    // left & right zero-padding is implicit since Float32Array is zero-initialised.
    chunks.push(chunk);
  }
  return { chunks, starts: Int32Array.from(starts) };
}

// ----------------------------- aggregate_prediction ------------------------
// predChunks: array of { beat: Float32Array(1500), downbeat: Float32Array(1500) }
// starts: Int32Array, fullSize: N, overlapMode "keep_first" (earlier overwrites later on overlap)
// Returns { beat: Float32Array(N), downbeat: Float32Array(N) } filled with -1000 default.
function aggregatePrediction(predChunks, starts, fullSize, orch) {
  const { chunkSize, borderSize, overlapMode } = orch;
  const beat = new Float32Array(fullSize).fill(-1000.0);
  const downbeat = new Float32Array(fullSize).fill(-1000.0);

  const order = [];
  for (let i = 0; i < starts.length; i += 1) order.push(i);
  if (overlapMode === "keep_first") {
    // process in reverse so earlier chunks overwrite later ones on overlap
    order.reverse();
  }
  // Strip the border: pred chunk's [border_size : chunk_size - border_size] = [6:1494] (length 1488)
  const stripLen = chunkSize - 2 * borderSize; // 1488
  for (const i of order) {
    const start = starts[i];
    const pchunk = predChunks[i];
    const destStart = start + borderSize;
    const destEnd = start + chunkSize - borderSize;
    // Clamp to piece bounds; for keep_first + avoid_short_end this is exact.
    const dstLo = Math.max(0, destStart);
    const dstHi = Math.min(fullSize, destEnd);
    const dstLen = dstHi - dstLo;
    if (dstLen <= 0) continue;
    const srcOffset = borderSize + (dstLo - destStart);
    beat.set(pchunk.beat.subarray(srcOffset, srcOffset + dstLen), dstLo);
    downbeat.set(pchunk.downbeat.subarray(srcOffset, srcOffset + dstLen), dstLo);
  }
  return { beat, downbeat };
}

// ----------------------------- postproc (minimal) -------------------------
// peak[i] = (logit[i] > 0) AND (logit[i] == max(logit[max(0,i-3) : i+4]))
// Matches torch F.max_pool1d(kernel=7, stride=1, pad=3) with -inf edge padding
// (clamped window picks the actual neighbours only; -inf out-of-range never wins).
function peakPick(logits) {
  const N = logits.length;
  const peaks = new Uint8Array(N);
  for (let i = 0; i < N; i += 1) {
    const v = logits[i];
    if (!(v > 0)) continue;
    let m = -Infinity;
    const lo = Math.max(0, i - 3);
    const hi = Math.min(N, i + 4); // exclusive
    for (let j = lo; j < hi; j += 1) if (logits[j] > m) m = logits[j];
    if (v === m) peaks[i] = 1;
  }
  return peaks;
}

// deduplicate_peaks(width=1): collapse runs of indices that are each <= width apart
// into their running mean (port of beat_this.model.postprocessor.deduplicate_peaks).
// Returns array of (possibly fractional) frame indices.
function deduplicatePeaks(peaks, width = 1) {
  if (!peaks.length) return [];
  const result = [];
  let p = peaks[0];
  let c = 1;
  for (let k = 1; k < peaks.length; k += 1) {
    const p2 = peaks[k];
    if (p2 - p <= width) {
      c += 1;
      p += (p2 - p) / c;
    } else {
      result.push(p);
      p = p2;
      c = 1;
    }
  }
  result.push(p);
  return result;
}

// Move each downbeat time to the nearest beat time, then unique(). Mirrors
// beat_this.model.postprocessor._postp_minimal_item's downbeat handling.
function snapDownbeatsToBeats(beatTimes, downbeatTimes) {
  if (!beatTimes.length || !downbeatTimes.length) return [];
  const snapped = new Float64Array(downbeatTimes.length);
  for (let i = 0; i < downbeatTimes.length; i += 1) {
    const d = downbeatTimes[i];
    let bestIdx = 0;
    let bestAbs = Math.abs(beatTimes[0] - d);
    for (let b = 1; b < beatTimes.length; b += 1) {
      const diff = Math.abs(beatTimes[b] - d);
      if (diff < bestAbs) { bestAbs = diff; bestIdx = b; }
    }
    snapped[i] = beatTimes[bestIdx];
  }
  // np.unique: sorted ascending, duplicates dropped
  const sorted = Float64Array.from(snapped).sort();
  const out = [];
  for (let i = 0; i < sorted.length; i += 1) {
    if (i === 0 || sorted[i] !== sorted[i - 1]) out.push(sorted[i]);
  }
  return out;
}

// Full minimal postproc on the per-frame beat/downbeat logits.
// Returns { beatTimes: Float64Array (raw, seconds), downbeatTimes: Float64Array (raw, snapped, seconds) }.
function postprocessMinimal(beatLogits, downbeatLogits, fps) {
  const N = beatLogits.length;
  const beatPeaks = peakPick(beatLogits);
  const downbeatPeaks = peakPick(downbeatLogits);
  const beatFrameIndices = [];
  for (let i = 0; i < N; i += 1) if (beatPeaks[i]) beatFrameIndices.push(i);
  const downbeatFrameIndices = [];
  for (let i = 0; i < N; i += 1) if (downbeatPeaks[i]) downbeatFrameIndices.push(i);
  const beatFrames = deduplicatePeaks(beatFrameIndices, 1);
  const downbeatFrames = deduplicatePeaks(downbeatFrameIndices, 1);
  const beatTimesRaw = Float64Array.from(beatFrames.map((f) => f / fps));
  const downbeatTimesRaw = Float64Array.from(downbeatFrames.map((f) => f / fps));
  const downbeatSnapped = snapDownbeatsToBeats(beatTimesRaw, downbeatTimesRaw);
  return {
    beatTimes: Float64Array.from(beatTimesRaw),
    downbeatTimes: Float64Array.from(downbeatSnapped),
  };
}

// ----------------------------- smoother ------------------------------------

function median(values) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function localMedian(values, index, window = 9) {
  const half = window >> 1;
  const lo = Math.max(0, index - half);
  const hi = Math.min(values.length, index + half + 1);
  return median(values.subarray(lo, hi));
}

function removeSpuriousBeats(beatTimes, minRatio = 0.6) {
  let times = Float64Array.from(beatTimes);
  let changed = true;
  while (changed && times.length > 4) {
    changed = false;
    const durations = new Float64Array(times.length - 1);
    for (let i = 0; i < durations.length; i += 1) durations[i] = times[i + 1] - times[i];
    const med = median(durations);
    for (let idx = 0; idx < durations.length; idx += 1) {
      const lm = localMedian(durations, idx);
      if (durations[idx] < minRatio * lm && durations[idx] < minRatio * med) {
        // removing the *later* beat of the short pair merges it away
        const next = new Float64Array(times.length - 1);
        next.set(times.subarray(0, idx + 1), 0);
        next.set(times.subarray(idx + 2), idx + 1);
        times = next;
        changed = true;
        break;
      }
    }
  }
  return times;
}

function fillMissedBeats(beatTimes, maxRatio = 1.7) {
  if (beatTimes.length < 2) return Float64Array.from(beatTimes);
  const times = [beatTimes[0]];
  const durations = new Float64Array(beatTimes.length - 1);
  for (let i = 0; i < durations.length; i += 1) durations[i] = beatTimes[i + 1] - beatTimes[i];
  for (let idx = 0; idx < durations.length; idx += 1) {
    const duration = durations[idx];
    const med = localMedian(durations, idx);
    if (duration > maxRatio * med && med > 0) {
      const nInsert = Math.round(duration / med) - 1;
      if (nInsert > 0) {
        for (let k = 1; k <= nInsert; k += 1) {
          times.push(beatTimes[idx] + (duration * k) / (nInsert + 1));
        }
      }
    }
    times.push(beatTimes[idx + 1]);
  }
  return Float64Array.from(times);
}

function dampedSmooth(beatTimes, gain = 0.15, window = 9) {
  if (beatTimes.length < 2) return Float64Array.from(beatTimes);
  const durations = new Float64Array(beatTimes.length - 1);
  for (let i = 0; i < durations.length; i += 1) durations[i] = beatTimes[i + 1] - beatTimes[i];
  const smoothed = [beatTimes[0]];
  for (let idx = 0; idx < durations.length; idx += 1) {
    const targetDuration = localMedian(durations, idx, window);
    const drift = beatTimes[idx + 1] - (smoothed[smoothed.length - 1] + targetDuration);
    const step = targetDuration + gain * drift;
    smoothed.push(smoothed[smoothed.length - 1] + Math.max(step, 0.05));
  }
  return Float64Array.from(smoothed);
}

function prependLeadIn(beatTimes) {
  if (beatTimes.length < 2) return { extended: Float64Array.from(beatTimes), nLead: 0 };
  const lead = beatTimes[0];
  const d0 = beatTimes[1] - beatTimes[0];
  if (lead <= 0.1 * d0 || d0 <= 0) {
    return { extended: Float64Array.from(beatTimes), nLead: 0 };
  }
  const nLead = Math.max(1, Math.round(lead / d0));
  const leadTimes = new Float64Array(nLead);
  for (let j = 0; j < nLead; j += 1) leadTimes[j] = (lead * j) / nLead;
  const extended = new Float64Array(nLead + beatTimes.length);
  extended.set(leadTimes, 0);
  extended.set(beatTimes, nLead);
  return { extended, nLead };
}

// Production smoother main() call order (mirrors the reference pipeline).
// remove_spurious_beats -> fill_missed_beats -> damped_smooth -> prepend_lead_in
function smoothGrid(beatTimes, orch) {
  const cleaned = removeSpuriousBeats(beatTimes, orch.removeSpuriousMinRatio);
  const filled = fillMissedBeats(cleaned, orch.fillMissedMaxRatio);
  const smoothed = dampedSmooth(filled, orch.dampedSmoothGain, orch.dampedSmoothWindow);
  const { extended, nLead } = prependLeadIn(smoothed);
  return { extended, nLead, intermediate: { cleaned, filled, smoothed } };
}

function medianBpm(times) {
  if (times.length < 2) return 0;
  const durations = new Float64Array(times.length - 1);
  for (let i = 0; i < durations.length; i += 1) durations[i] = times[i + 1] - times[i];
  const m = median(durations);
  return m > 0 ? 60.0 / m : 0;
}

// ----------------------------- end-to-end detection ------------------------

// detectBeats: signalMono22050 Float32Array -> { beatTimes, downbeatTimes, rawBeatTimes, nLeadIn, tempoBpm }.
//   beatTimes/beats    = smoothed, lead-in-prepended unless smooth=false (Float64Array seconds)
//   downbeatTimes      = raw minimal-postproc snapped to nearest raw beat (Float64Array seconds)
//   rawBeatTimes       = raw minimal-postproc beat times (pre-smoother, Float64Array seconds)
//   nLeadIn            = number of lead-in beats prepended by prepend_lead_in
//   tempoBpm           = median BPM of the smoothed grid (60/median(durations))
async function detectBeats(signalMono22050, manifest, sessions, orch, {
  log = null,
  smooth = true,
  onSmoothingStart = null,
  onSmoothingEnd = null,
  onSmoothingError = null,
} = {}) {
  const resolved = orch || beatOrchestration(manifest);
  if (!signalMono22050 || signalMono22050.length === 0) {
    throw new Error("detectBeats: empty signal");
  }
  if (Math.round(resolved.sampleRate) !== 22050) {
    throw new Error(`detectBeats: signal must be 22050 Hz mono; sampleRate=${resolved.sampleRate}`);
  }

  // 1) Run the mel frontend on the full mono signal.
  const wav = signalMono22050;
  const wavT = tensor("float32", wav, [wav.length]);
  if (log) log("beat: mel spectrogram over full signal...");
  const melOut = await runSession(sessions.mel, { wav: wavT });
  const melRaw = await melOut.logmel.getData(true); // Float32Array length N*128
  const melDims = melOut.logmel.dims;
  const N = melDims[melDims.length - 2];
  const nMels = melDims[melDims.length - 1];
  if (nMels !== 128) throw new Error(`beat mel: expected 128 mel bins, got ${nMels}`);
  if (log) log(`beat: mel frames=${N} hops at fps=${resolved.fps} (~${(N / resolved.fps).toFixed(1)}s)`);

  // 2) split_piece -> chunks (each exactly 1500 frames) + starts.
  const { chunks, starts } = splitPiece(melRaw, N, resolved);
  if (log) log(`beat: ${chunks.length} chunks, step=${resolved.chunkSize - 2 * resolved.borderSize}`);

  // 3) Core model on each chunk; assert chunk_length == 1500 before every call.
  const predChunks = [];
  for (let i = 0; i < chunks.length; i += 1) {
    if (chunks[i].length !== resolved.chunkSize * 128) {
      throw new Error(
        `beat core: chunk ${i} mel length=${chunks[i].length / 128} != chunkSize=${resolved.chunkSize}. ` +
        `Refusing to run core (silent corruption off-shape).`
      );
    }
    const melT = tensor("float32", chunks[i], [1, resolved.chunkSize, 128]);
    const out = await runSession(sessions.core, { mel: melT });
    const beatLogits = await out.beat_logits.getData(true); // Float32Array length 1500
    const downbeatLogits = await out.downbeat_logits.getData(true);
    predChunks.push({ beat: Float32Array.from(beatLogits), downbeat: Float32Array.from(downbeatLogits) });
    if (log) log(`beat: core chunk ${i + 1}/${chunks.length}`);
  }

  // 4) aggregate_prediction (keep_first = reverse order, earlier overwrites later on overlap).
  const { beat, downbeat } = aggregatePrediction(predChunks, starts, N, resolved);

  // 5) Postprocessor(type="minimal", fps).
  const postproc = postprocessMinimal(beat, downbeat, resolved.fps);
  const rawBeatTimes = postproc.beatTimes;
  const rawDownbeatTimes = postproc.downbeatTimes;
  if (log) log(`beat: postproc -> ${rawBeatTimes.length} raw beats, ${rawDownbeatTimes.length} downbeats`);

  // 6) Smoother (production call order), unless the caller requested raw timing.
  if (rawBeatTimes.length < 2) {
    if (log) log("beat: too few beats to smooth; returning raw");
    return {
      beatTimes: Float64Array.from(rawBeatTimes),
      downbeatTimes: Float64Array.from(rawDownbeatTimes),
      rawBeatTimes: Float64Array.from(rawBeatTimes),
      nLeadIn: 0,
      tempoBpm: 0,
    };
  }
  if (!smooth) {
    const tempoBpm = medianBpm(rawBeatTimes);
    if (log) log(`beat: smoothing disabled -> ${rawBeatTimes.length} raw beats, tempo≈${tempoBpm.toFixed(2)} bpm`);
    return {
      beatTimes: Float64Array.from(rawBeatTimes),
      downbeatTimes: Float64Array.from(rawDownbeatTimes),
      rawBeatTimes: Float64Array.from(rawBeatTimes),
      nLeadIn: 0,
      tempoBpm,
    };
  }
  await onSmoothingStart?.();
  let smoothed;
  try {
    smoothed = smoothGrid(rawBeatTimes, resolved);
  } catch (error) {
    await onSmoothingError?.(error);
    throw error;
  }
  await onSmoothingEnd?.();
  const tempoBpm = medianBpm(smoothed.extended);
  if (log) log(`beat: smoothed -> ${smoothed.extended.length} beats (nLeadIn=${smoothed.nLead}), tempo≈${tempoBpm.toFixed(2)} bpm`);

  return {
    beatTimes: smoothed.extended,
    downbeatTimes: Float64Array.from(rawDownbeatTimes),
    rawBeatTimes: Float64Array.from(rawBeatTimes),
    nLeadIn: smoothed.nLead,
    tempoBpm,
    _intermediate: {
      afterSpuriousRemoval: smoothed.intermediate.cleaned.length,
      afterGapFill: smoothed.intermediate.filled.length,
      smoothedPreLeadIn: smoothed.intermediate.smoothed,
    },
  };
}

module.exports = {
  DEFAULTS,
  beatOrchestration,
  loadBeatSessions,
  detectBeats,
  splitPiece,
  aggregatePrediction,
  peakPick,
  deduplicatePeaks,
  snapDownbeatsToBeats,
  postprocessMinimal,
  localMedian,
  median,
  medianBpm,
  removeSpuriousBeats,
  fillMissedBeats,
  dampedSmooth,
  prependLeadIn,
  smoothGrid,
};

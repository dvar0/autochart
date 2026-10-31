// Faithful JS port of the production Beat This detect->smooth grid pipeline.
//
// Reference (upstream beat_this + local smoother):
//   beat_this.inference.split_piece              (beat_this/inference.py:100 (upstream))
//   beat_this.inference.aggregate_prediction      (inference.py:138 (upstream))
//   beat_this.model.postprocessor.Postprocessor  (beat_this/model/postprocessor.py (upstream))
//       type="minimal", fps=50
//   grid smoother: spurious/missed-beat cleanup, glitch repair, local line fit
//
// The two ONNX graphs (fp32, opset 17, CPU):
//   beat_this_mel_fp32.onnx:  wav[samples] f32 mono 22050 Hz -> logmel[n_frames, 128] (time x bins)
//   beat_this_core_fp32.onnx: mel[1, 1500, 128] f32 -> beat_logits[1,1500], downbeat_logits[1,1500]
//
// The core graph is traced at chunk_size=1500 frames and is ONLY numerically valid
// at exactly 1500 frames (50 fps = 30 s of audio). Assert chunk mel length == 1500
// before every core call; off-shape inference silently corrupts output.

import { createSession, sessionDevice, tensor, runSession } from "./runtime.mjs";
import { graphPath } from "./runtime.mjs";

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
    repairSpan: 8,
    repairTolerance: 0.15,
    repairMaxRun: 6,
    lineFitHalfWindow: 4,
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
    repairSpan: Number(smoother.repairSpan),
    repairTolerance: Number(smoother.repairTolerance),
    repairMaxRun: Number(smoother.repairMaxRun),
    lineFitHalfWindow: Number(smoother.lineFitHalfWindow),
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

// The beats one chunk found, before the whole song is aggregated and smoothed:
// rough, for showing the run.
function chunkTicks(pred, start, { chunkSize, borderSize, fps }) {
  const { beatTimes, downbeatTimes } = postprocessMinimal(
    pred.beat.subarray(borderSize, chunkSize - borderSize),
    pred.downbeat.subarray(borderSize, chunkSize - borderSize),
    fps,
  );
  const shift = (start + borderSize) / fps;
  return { beats: Array.from(beatTimes, (t) => t + shift), downbeats: Array.from(downbeatTimes, (t) => t + shift) };
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

// Least-squares line through (k, times[k]) for k in idx -> { a, b, rms }; b is the beat period.
function fitLine(times, idx) {
  const m = idx.length;
  let mx = 0;
  let my = 0;
  for (const k of idx) { mx += k; my += times[k]; }
  mx /= m;
  my /= m;
  let sxy = 0;
  let sxx = 0;
  for (const k of idx) { sxy += (k - mx) * (times[k] - my); sxx += (k - mx) * (k - mx); }
  const b = sxx > 0 ? sxy / sxx : 0;
  const a = my - b * mx;
  let ss = 0;
  for (const k of idx) { const r = times[k] - (a + b * k); ss += r * r; }
  return { a, b, rms: Math.sqrt(ss / m) };
}

function indexRange(lo, hi, n) {
  const out = [];
  for (let k = Math.max(0, lo); k <= Math.min(n - 1, hi); k += 1) out.push(k);
  return out;
}

// Line fit that drops the worst points once, so one bad beat doesn't bend the window.
function robustFit(times, idx, tol) {
  let fit = fitLine(times, idx);
  if (idx.length < 5) return fit;
  const keep = idx.filter((k) => Math.abs(times[k] - (fit.a + fit.b * k)) <= tol * Math.abs(fit.b));
  if (keep.length >= Math.max(3, idx.length - 3) && keep.length < idx.length) fit = fitLine(times, keep);
  return fit;
}

// Puts short double-time bursts back on the surrounding grid. Beat This follows drum fills
// at 16ths for a few seconds, which writes 400-600 BPM stretches into a steady song. A
// burst counts when its local tempo is over minBpm, at least `ratio` times the steady
// tempo around it, and shorter than maxSec. Inside it, the beats that continue the outer
// grid are kept and the rest dropped; a missing one is filled at the outer spacing.
function fixTempoBursts(beatTimes, {
  minBpm = 300, ratio = 1.6, maxSec = 8, context = 10, contextAgree = 0.25, snap = 0.3,
} = {}) {
  const times = beatTimes;
  const n = times.length;
  if (n < 8) return Float64Array.from(times);
  const intervals = new Float64Array(n - 1);
  for (let i = 0; i + 1 < n; i += 1) intervals[i] = times[i + 1] - times[i];
  const intervalMedian = (lo, hi) => {
    const a = Math.max(0, lo), b = Math.min(n - 1, hi);
    return b - a >= 3 ? median(intervals.subarray(a, b)) : null;
  };
  const fast = new Uint8Array(n - 1);
  for (let i = 0; i + 1 < n; i += 1) fast[i] = 60.0 / intervalMedian(i - 2, i + 3) > minBpm ? 1 : 0;

  const out = [times[0]];
  let i = 0;
  while (i + 1 < n) {
    if (!fast[i]) { out.push(times[i + 1]); i += 1; continue; }
    let e = i;
    while (e + 1 < n - 1 && fast[e + 1]) e += 1;
    // Burst spans beats i..e+1; context skips the two intervals next to it.
    const before = intervalMedian(i - 2 - context, i - 2);
    const after = intervalMedian(e + 3, e + 3 + context);
    let period = null;
    if (before && after) period = Math.abs(before - after) <= contextAgree * Math.max(before, after) ? (before + after) / 2 : null;
    else period = before || after;
    const burst = median(intervals.subarray(i, e + 1));
    const a = i, b = e + 1;
    if (!period || burst * ratio > period || times[b] - times[a] > maxSec) {
      for (let j = a + 1; j <= b; j += 1) out.push(times[j]);
      i = b;
      continue;
    }
    let last = times[a];
    let j = a + 1;
    while (times[b] - last > 1.5 * period) {
      const target = last + period;
      let best = -1;
      for (; j < b && times[j] < target + snap * period; j += 1) {
        if (Math.abs(times[j] - target) <= snap * period && (best < 0 || Math.abs(times[j] - target) < Math.abs(times[best] - target))) best = j;
      }
      last = best >= 0 ? times[best] : target;
      out.push(last);
    }
    out.push(times[b]);
    i = b;
  }
  return Float64Array.from(out);
}

// Repairs short fumbles where the detector loses and re-finds the beat: a run of at most
// maxRun beats that fit the steady pattern on neither side is re-spaced evenly, but only
// when both sides agree on the tempo and the gap holds a whole number of beats.
// Anything less clear-cut is left alone.
function repairGlitches(beatTimes, { span = 8, tol = 0.15, maxRun = 6, tempoAgree = 0.08, wholeBeats = 0.2 } = {}) {
  const times = beatTimes;
  const n = times.length;
  if (n < 2 * span + 2) return Float64Array.from(times);
  const fitSide = (lo, hi) => {
    const idx = indexRange(lo, hi, n);
    return idx.length >= span - 2 ? robustFit(times, idx, tol) : null;
  };
  const steady = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    for (const fit of [fitSide(i - span, i - 1), fitSide(i + 1, i + span)]) {
      if (fit && fit.b > 0 && Math.abs(times[i] - (fit.a + fit.b * i)) <= tol * fit.b) steady[i] = 1;
    }
  }
  const out = [];
  let i = 0;
  while (i < n) {
    if (steady[i] || i === 0) {
      out.push(times[i]);
      i += 1;
      continue;
    }
    let e = i;
    while (e + 1 < n && !steady[e + 1]) e += 1;
    const a = i - 1;
    const b = e + 1;
    const left = b < n ? fitSide(a - span + 1, a) : null;
    const right = b < n ? fitSide(b, b + span - 1) : null;
    let replaced = false;
    if (e - i + 1 <= maxRun && left && right && left.b > 0 && right.b > 0) {
      const period = (left.b + right.b) / 2;
      const gap = times[b] - times[a];
      const beats = Math.round(gap / period);
      if (
        beats >= 1
        && Math.abs(left.b - right.b) / period <= tempoAgree
        && Math.abs(gap / period - beats) <= wholeBeats
      ) {
        for (let j = 1; j < beats; j += 1) out.push(times[a] + (gap * j) / beats);
        replaced = true;
      }
    }
    if (!replaced) for (let j = i; j <= e; j += 1) out.push(times[j]);
    i = e + 1;
  }
  return Float64Array.from(out);
}

// Edge-preserving local line fit. Each beat takes the best-fitting of a centered, left-only
// or right-only window, so tempo changes stay sharp instead of lagging. Fitting positions
// rather than frame-rounded durations keeps the grid centered on the detected beats; the
// previous damped smoother settled 15-50 ms early or late depending on the tempo.
function lineSmooth(beatTimes, { half = 4, shortHalf = 2, sidePenalty = 1.5, periods = null } = {}) {
  const times = beatTimes;
  const n = times.length;
  if (n < 3) return Float64Array.from(times);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const windows = [];
    // Short windows let a stretch of a few beats between tempo changes get its own line.
    for (const h of shortHalf ? [half, shortHalf] : [half]) {
      windows.push(
        { idx: indexRange(i - h, i + h, n), weight: 1 },
        { idx: indexRange(i - 2 * h, i, n), weight: sidePenalty },
        { idx: indexRange(i, i + 2 * h, n), weight: sidePenalty },
      );
    }
    let best = null;
    for (const win of windows) {
      const m = win.idx.length;
      if (m < 4) continue;
      const fit = fitLine(times, win.idx);
      // Unbiased residual spread, so short windows win only where long ones don't fit.
      const score = fit.rms * Math.sqrt(m / (m - 2)) * win.weight;
      if (!best || score < best.score) best = { score, fit };
    }
    if (!best) best = { fit: fitLine(times, indexRange(i - 1, i + 1, n)) };
    out[i] = best.fit.a + best.fit.b * i;
    if (periods) periods[i] = best.fit.b;
  }
  for (let i = 1; i < n; i += 1) if (out[i] < out[i - 1] + 0.05) out[i] = out[i - 1] + 0.05;
  return out;
}

// Merges beats closer together than minRatio of the local beat length into one. These
// come from short stretches where the detector briefly doubles up; left in, they write
// tempo markers of 600+ BPM.
function mergeSqueezedBeats(beatTimes, periods, minRatio = 0.5) {
  const out = [];
  const outPeriods = [];
  for (let i = 0; i < beatTimes.length; i += 1) {
    const last = out.length - 1;
    const period = Math.max(periods[i], last >= 0 ? outPeriods[last] : 0);
    if (last >= 0 && beatTimes[i] - out[last] < minRatio * period) {
      out[last] = (out[last] + beatTimes[i]) / 2;
      continue;
    }
    out.push(beatTimes[i]);
    outPeriods.push(periods[i]);
  }
  return Float64Array.from(out);
}

// Re-smoothing after a merge can squeeze a neighbour, so repeat a few rounds and finish
// with a plain merge.
function smoothRepaired(repaired, options = {}) {
  let times = repaired;
  for (let round = 0; round < 4; round += 1) {
    const periods = new Float64Array(times.length);
    const smoothed = lineSmooth(times, { ...options, periods });
    const merged = mergeSqueezedBeats(smoothed, periods);
    if (merged.length === smoothed.length || round === 3) return merged;
    times = merged;
  }
  return times;
}

// Chart tick 0 is t=0, so the grid has to start there. Lead-in beats fill the time before
// the first beat; a first beat less than half a beat from 0 moves onto 0 instead of
// leaving a sliver beat (which wrote tempo markers like 1500 BPM).
function prependLeadIn(beatTimes) {
  if (beatTimes.length < 2) return { extended: Float64Array.from(beatTimes), nLead: 0 };
  const lead = beatTimes[0];
  const d0 = beatTimes[1] - beatTimes[0];
  if (lead <= 0 || d0 <= 0) {
    return { extended: Float64Array.from(beatTimes), nLead: 0 };
  }
  const nLead = Math.round(lead / d0);
  if (nLead < 1) {
    const extended = Float64Array.from(beatTimes);
    extended[0] = 0;
    return { extended, nLead: 0 };
  }
  const leadTimes = new Float64Array(nLead);
  for (let j = 0; j < nLead; j += 1) leadTimes[j] = (lead * j) / nLead;
  const extended = new Float64Array(nLead + beatTimes.length);
  extended.set(leadTimes, 0);
  extended.set(beatTimes, nLead);
  return { extended, nLead };
}

// remove_spurious_beats -> fill_missed_beats -> fix tempo bursts -> repair glitches -> line smooth -> lead-in
function smoothGrid(beatTimes, orch) {
  const cleaned = removeSpuriousBeats(beatTimes, orch.removeSpuriousMinRatio);
  const filled = fillMissedBeats(cleaned, orch.fillMissedMaxRatio);
  const leveled = fixTempoBursts(filled);
  const repaired = repairGlitches(leveled, {
    span: orch.repairSpan,
    tol: orch.repairTolerance,
    maxRun: orch.repairMaxRun,
  });
  const smoothed = smoothRepaired(repaired, { half: orch.lineFitHalfWindow });
  const { extended, nLead } = prependLeadIn(smoothed);
  return { extended, nLead, intermediate: { cleaned, filled, leveled, repaired, smoothed } };
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
  onChunk = null,
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
    if (onChunk) onChunk({ index: i + 1, total: chunks.length, ...chunkTicks(predChunks[i], starts[i], resolved) });
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
      afterTempoBursts: smoothed.intermediate.leveled.length,
      afterGlitchRepair: smoothed.intermediate.repaired.length,
      smoothedPreLeadIn: smoothed.intermediate.smoothed,
    },
  };
}

export {
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
  fixTempoBursts,
  repairGlitches,
  lineSmooth,
  mergeSqueezedBeats,
  smoothRepaired,
  prependLeadIn,
  smoothGrid,
};

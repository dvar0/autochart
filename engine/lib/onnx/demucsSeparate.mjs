import { createSession, graphPath, sessionDevice, tensor, runSession } from "./runtime.mjs";
import { demucsOrchestration } from "./manifest.mjs";
import { createStft } from "./stft.mjs";

// Only the core network is a graph: both STFTs run in JS (stft.mjs), so the
// model folder's demucs_analysis_stft / demucs_synthesis_istft go unused.
async function loadDemucsSessions(manifest, device = "cpu", log = null) {
  const opts = { device, log };
  const load = async (role) => {
    const t0 = Date.now();
    if (log) log(`  loading ${role}`);
    const session = await createSession(graphPath(manifest, role), opts);
    if (log) log(`  ${role} ready on ${sessionDevice(session, device)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return session;
  };
  const orch = demucsOrchestration(manifest);
  const core = await load("demucs-core-network");
  return { stft: createStft(orch.nfft, orch.hopLength), core, device: sessionDevice(core, device) };
}

// Faithful JS port of the reference Demucs-ONNX separation pipeline, with the
// STFTs computed exactly (stft.mjs): 88-116 dB per stem against PyTorch
// htdemucs_6s, where the reference's float32 DFT basis graphs got 44-81 dB.

const ceil = Math.ceil;
const floor = Math.floor;

// ndarray-style reflect pad on the last axis of shape (rows, cols), padding (pl, pr) on cols.
// arr: Float32Array length rows*cols, row-major. Returns Float32Array length rows*(cols+pl+pr).
function reflectPadLastAxis(arr, rows, cols, pl, pr) {
  const newCols = cols + pl + pr;
  const out = new Float32Array(rows * newCols);
  for (let r = 0; r < rows; r += 1) {
    const inBase = r * cols;
    const outBase = r * newCols + pl;
    // copy original
    out.set(arr.subarray(inBase, inBase + cols), outBase);
    // left reflect
    for (let i = 0; i < pl; i += 1) {
      out[outBase - 1 - i] = arr[inBase + (i + 1)];
    }
    // right reflect
    for (let i = 0; i < pr; i += 1) {
      out[outBase + cols + i] = arr[inBase + (cols - 2 - i)];
    }
  }
  return out;
}

function zeroPadLastAxis(arr, rows, cols, pl, pr) {
  const newCols = cols + pl + pr;
  const out = new Float32Array(rows * newCols);
  for (let r = 0; r < rows; r += 1) {
    out.set(arr.subarray(r * cols, r * cols + cols), r * newCols + pl);
  }
  return out;
}

const tick = (times, key, since) => {
  times[key] = (times[key] || 0) + performance.now() - since;
  return performance.now();
};

// Run STFT -> core -> inverse STFT on ONE chunk padded to segmentLength.
// chunkViews: { data: Float32Array length 1*2*segmentLength, dims: [1,2,L] }
// Returns stems: { data: Float32Array length 1*4*2*L, dims: [1,4,2,L] }
async function runSegment(mixFlat, B, C, L, sessions, orch, times = {}) {
  let t = performance.now();
  if (L !== orch.segmentLength) {
    throw new Error(
      `Demucs core ONNX only valid at segmentLength=${orch.segmentLength}; got L=${L}. ` +
      `Refusing to run core (silent corruption off-shape).`
    );
  }
  const hl = orch.hopLength;
  const le = ceil(L / hl); // 336
  const pad = (hl >> 1) * 3; // 1536
  const padRight = pad + le * hl - L; // matches np.pad reflect (pad, pad_right)
  // Reflect-pad both channels on the sample axis. mixFlat is (B*C=2, L).
  const x0 = reflectPadLastAxis(mixFlat, B * C, L, pad, padRight); // (2, padded_L)
  // [2, 2049, T]
  const { real: realRaw, imag: imagRaw, dims: realDims } = sessions.stft.analysis(x0, B * C, L + pad + padRight);
  const analysisTime = realDims[realDims.length - 1];
  const freqRaw = realDims[realDims.length - 2];
  // real[:, :-1, :] : drop nyquist -> freq=freqRaw-1=2048 ; then [:, :, 2:2+le]
  const freqOut = freqRaw - 1;
  const timeOut = le; // slice 2 : 2+le on last axis
  const sliceStart = 2;
  const realSliced = sliceChannelsTime(realRaw, B * C, freqRaw, analysisTime, 1, sliceStart, timeOut);
  const imagSliced = sliceChannelsTime(imagRaw, B * C, freqRaw, analysisTime, 1, sliceStart, timeOut);
  // core inputs: real [2, 2048, le], imag [2, 2048, le], mix [1, 2, L]
  const realT = tensor("float32", realSliced, [B * C, freqOut, timeOut]);
  const imagT = tensor("float32", imagSliced, [B * C, freqOut, timeOut]);
  const mixT = tensor("float32", mixFlat, [B, C, L]);
  t = tick(times, "analysis", t);
  const coreOut = await runSession(sessions.core, { real: realT, imag: imagT, mix: mixT });
  const zrRaw = await coreOut.zout_real.getData(true); // (1,4,2,2048,le)
  const ziRaw = await coreOut.zout_imag.getData(true);
  const xtRaw = await coreOut.xt.getData(true); // (1,4,2,L)
  t = tick(times, "core", t);
  const zrDims = coreOut.zout_real.dims; // [1,4,2,2048,le]
  const ztTime = zrDims[zrDims.length - 1]; // le
  const S = orch.sources.length; // 4
  // reshape zr/zi to (B*S*C=8, 2048, le)
  const flatSC = B * S * C; // 8
  const zrReshaped = zrRaw; // already contiguous (1*4*2*2048*le == 8*2048*le)
  const ziReshaped = ziRaw;
  const le2 = hl * ceil(L / hl) + 2 * pad;
  // The core's spectrogram has no nyquist bin and sits 2 frames in from each
  // side of the frames the inverse STFT expects; both are zero.
  const y = sessions.stft.synthesis(zrReshaped, ziReshaped, {
    streams: flatSC, inBins: freqOut, inFrames: ztTime, framePad: 2, length: le2,
  });
  tick(times, "synthesis", t);
  return assembleStems(y, xtRaw, flatSC, B, S, C, le2, pad, L, le2);
}

// slice [:, :-1, :] (drop LAST freq bin) then [:, :, 2:2+le] -> (rows, freq-1, tLen)
function sliceChannelsTime(src, rows, freq, time, freqDropLast, tStart, tLen) {
  // Drop the trailing `freqDropLast` freq indices (np [:, :-freqDropLast, :]).
  const drop = freqDropLast || 0;
  const freqOut = freq - drop;
  const out = new Float32Array(rows * freqOut * tLen);
  for (let r = 0; r < rows; r += 1) {
    for (let f = 0; f < freqOut; f += 1) {
      // src freq index = f (keep 0..freqOut-1, drop the tail `drop` indices)
      const srcOff = r * freq * time + f * time + tStart;
      const dstOff = r * freqOut * tLen + f * tLen;
      out.set(src.subarray(srcOff, srcOff + tLen), dstOff);
    }
  }
  return out;
}

// yRaw: (flatSC=8, ySamples). Trim to [..., pad:pad+L], reshape (1,S,C,L), add xt, return {data,dims}.
function assembleStems(yRaw, xtRaw, flatSC, B, S, C, ySamples, pad, L, le2) {
  if (ySamples < pad + L) {
    throw new Error(`synthesis output too short: ${ySamples} < pad+L=${pad + L}`);
  }
  // y trimmed to (flatSC, L)
  const yTrim = new Float32Array(flatSC * L);
  for (let r = 0; r < flatSC; r += 1) {
    yTrim.set(yRaw.subarray(r * ySamples + pad, r * ySamples + pad + L), r * L);
  }
  // reshape to (B, S, C, L). flatSC = B*S*C, ordering is stem-major then channel: index = s*C + c
  const out = new Float32Array(B * S * C * L);
  for (let s = 0; s < S; s += 1) {
    for (let c = 0; c < C; c += 1) {
      const flatRow = s * C + c; // row in yTrim
      const outOff = ((0 * S + s) * C + c) * L; // B=1
      out.set(yTrim.subarray(flatRow * L, flatRow * L + L), outOff);
    }
  }
  // add xt (same layout B,S,C,L)
  for (let i = 0; i < out.length; i += 1) out[i] += xtRaw[i];
  return { data: out, dims: [B, S, C, L] };
}

// TensorChunk.padded port (demucs apply.py (upstream)): center chunk inside target_length, zero-pad overhang.
function chunkPadded(mixFlat, B, C, totalLength, offset, chunkLength, targetLength) {
  const delta = targetLength - chunkLength;
  if (delta < 0) throw new Error(`chunk longer than target: ${chunkLength} > ${targetLength}`);
  const start = offset - (delta >> 1);
  const end = start + targetLength;
  const correctStart = Math.max(0, start);
  const correctEnd = Math.min(totalLength, end);
  const padLeft = correctStart - start;
  const padRight = end - correctEnd;
  const out = new Float32Array(B * C * targetLength);
  for (let r = 0; r < B * C; r += 1) {
    const srcOff = r * totalLength + correctStart;
    const dstOff = r * targetLength + padLeft;
    const copyLen = correctEnd - correctStart;
    if (copyLen > 0) out.set(mixFlat.subarray(srcOff, srcOff + copyLen), dstOff);
  }
  return out;
}

// center_trim port
function centerTrim(arr, length) {
  const cur = arr.length;
  const delta = cur - length;
  if (delta < 0) throw new Error(`tensor smaller than reference: delta=${delta}`);
  if (!delta) return arr;
  const start = delta >> 1;
  return arr.subarray(start, start + length);
}

// Triangular weight vector length N, peak in the middle, normalized to max 1, raised to transitionPower.
function triangularWeights(N, transitionPower) {
  const half = N >> 1;
  const w = new Float32Array(N);
  for (let i = 0; i < half; i += 1) w[i] = i + 1;
  for (let i = 0; i < N - half; i += 1) w[half + i] = N - half - i;
  let max = 0;
  for (let i = 0; i < N; i += 1) if (w[i] > max) max = w[i];
  for (let i = 0; i < N; i += 1) {
    let v = w[i] / max;
    if (transitionPower !== 1) v = Math.pow(v, transitionPower);
    w[i] = v;
  }
  return w;
}

// Separate a stereo mix into the model's sources.
// mixFlat: Float32Array length 2*L, planar (all left samples, then all right).
// Returns [{ name, left, right }] in orch.sources order.
async function separate(mixFlat, totalLength, sessions, orch, { onProgress = null, log = null } = {}) {
  if (totalLength !== mixFlat.length / 2) {
    throw new Error(`mix length mismatch: ${mixFlat.length} != 2*${totalLength}`);
  }
  const B = 1;
  const C = 2;
  const S = orch.sources.length;
  const segmentLength = orch.segmentLength;
  const overlap = orch.overlap;
  const stride = Math.floor((1 - overlap) * segmentLength);
  if (stride <= 0) throw new Error(`non-positive stride: ${stride}`);

  // One buffer per source and channel: the stems come straight out of these.
  const rows = [];
  for (let r = 0; r < S * C; r += 1) rows.push(new Float32Array(totalLength));
  const sumWeight = new Float32Array(totalLength);
  const wAll = triangularWeights(segmentLength, orch.transitionPower); // length segmentLength

  const offsets = [];
  for (let off = 0; off < totalLength; off += stride) offsets.push(off);
  const nTotal = offsets.length;
  if (log) log(`  separating ${nTotal} chunks`);
  const t0 = Date.now();
  const times = {};
  for (let i = 0; i < nTotal; i += 1) {
    const offset = offsets[i];
    const chunkLength = Math.min(totalLength - offset, segmentLength);
    const padded = chunkPadded(mixFlat, B, C, totalLength, offset, chunkLength, segmentLength);
    const seg = await runSegment(padded, B, C, segmentLength, sessions, orch, times); // {data (1,S,2,SEG), dims}
    const segData = seg.data;
    // center_trim each (B,S,C) row to chunkLength
    // out[..., offset:end] += w_clipped * seg_out_trim
    const end = Math.min(offset + segmentLength, totalLength);
    const targetLen = end - offset;
    const wClipped = wAll.subarray(0, chunkLength); // length chunkLength
    // seg layout (B=1,S,C,SEG): index = ((s*C+c)*SEG + t)
    for (let s = 0; s < S; s += 1) {
      for (let c = 0; c < C; c += 1) {
        const segRow = (s * C + c) * segmentLength;
        const trimStart = (segmentLength - chunkLength) >> 1;
        const row = rows[s * C + c];
        for (let t = 0; t < targetLen; t += 1) {
          row[offset + t] += wClipped[t] * segData[segRow + trimStart + t];
        }
      }
    }
    // sum_weight[offset:end] += w_clipped[:targetLen]
    for (let t = 0; t < targetLen; t += 1) sumWeight[offset + t] += wClipped[t];

    const elapsed = (Date.now() - t0) / 1000;
    if (log) log(`  [seg ${i + 1}/${nTotal}] offset=${offset} chunk_len=${chunkLength} (${elapsed.toFixed(1)}s elapsed)`);
    if (onProgress) onProgress({ index: i + 1, total: nTotal, offset, chunkLength, elapsed });
  }

  if (log) log(`  separation time per step: ${Object.entries(times).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(", ")}`);
  let minW = Infinity;
  for (let i = 0; i < totalLength; i += 1) if (sumWeight[i] < minW) minW = sumWeight[i];
  if (!(minW > 0)) throw new Error("overlap-add weight sum must be strictly positive everywhere");

  for (const row of rows) {
    for (let t = 0; t < totalLength; t += 1) row[t] /= sumWeight[t];
  }

  // Stems as {name, left, right} in the model's source order.
  return orch.sources.map((name, s) => ({ name, left: rows[s * C], right: rows[s * C + 1] }));
}

// Sum model sources into the cached stems per orch.stemFold (htdemucs_6s:
// other = other + piano, in float32 like the training cache). Stems that map
// to a single source pass through untouched, so a fold-free model is a no-op.
function foldStems(stems, orch) {
  const byName = new Map(stems.map((stem) => [stem.name, stem]));
  const stemNames = Array.isArray(orch.stems) && orch.stems.length ? orch.stems : stems.map((stem) => stem.name);
  return stemNames.map((name) => {
    const parts = (orch.stemFold && orch.stemFold[name]) || [name];
    const sources = parts.map((part) => {
      const source = byName.get(part);
      if (!source) throw new Error(`Demucs output is missing source ${part} for stem ${name}.`);
      return source;
    });
    if (sources.length === 1) return { name, left: sources[0].left, right: sources[0].right };
    const left = Float32Array.from(sources[0].left);
    const right = Float32Array.from(sources[0].right);
    for (const source of sources.slice(1)) {
      for (let i = 0; i < left.length; i += 1) left[i] += source.left[i];
      for (let i = 0; i < right.length; i += 1) right[i] += source.right[i];
    }
    return { name, left, right };
  });
}

export {
  loadDemucsSessions,
  separate,
  foldStems,
  triangularWeights,
  runSegment,
  chunkPadded,
  centerTrim,
};
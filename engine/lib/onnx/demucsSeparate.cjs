"use strict";

const { tensor, runSession } = require("./sessionLoader.cjs");
const { writeStereoWav } = require("./wavWrite.cjs");

// Faithful JS port of the reference Demucs-ONNX separation pipeline.
// All math mirrors the reference implementation byte-for-byte. Reference validated at
// 77.6 dB mean SDR vs real PyTorch demucs; it is the ground truth for this port.

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

// Run the 3-session chain on ONE chunk padded to segmentLength.
// chunkViews: { data: Float32Array length 1*2*segmentLength, dims: [1,2,L] }
// Returns stems: { data: Float32Array length 1*4*2*L, dims: [1,4,2,L] }
async function runSegment(mixFlat, B, C, L, sessions, orch) {
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
  // analysis STFT input "x" shape [stream=2, samples]
  const xTensor = tensor("float32", x0, [B * C, L + pad + padRight]);
  const analysisOut = await runSession(sessions.analysis, { x: xTensor });
  const realRaw = await analysisOut.real.getData(true); // Float32Array
  const imagRaw = await analysisOut.imag.getData(true);
  const realDims = analysisOut.real.dims; // [2, 2049, T]
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
  const coreOut = await runSession(sessions.core, { real: realT, imag: imagT, mix: mixT });
  const zrRaw = await coreOut.zout_real.getData(true); // (1,4,2,2048,le)
  const ziRaw = await coreOut.zout_imag.getData(true);
  const xtRaw = await coreOut.xt.getData(true); // (1,4,2,L)
  const zrDims = coreOut.zout_real.dims; // [1,4,2,2048,le]
  const ztTime = zrDims[zrDims.length - 1]; // le
  const S = orch.sources.length; // 4
  // reshape zr/zi to (B*S*C=8, 2048, le)
  const flatSC = B * S * C; // 8
  const zrReshaped = zrRaw; // already contiguous (1*4*2*2048*le == 8*2048*le)
  const ziReshaped = ziRaw;
  // pad nyquist bin (freq +1) then time pad (2,2)
  const freqPadded = freqOut + 1; // 2049
  const timePadded = ztTime + 4; // le+4
  const zrPadded = padFreqAndTime(zrReshaped, flatSC, freqOut, ztTime, freqPadded, timePadded);
  const ziPadded = padFreqAndTime(ziReshaped, flatSC, freqOut, ztTime, freqPadded, timePadded);
  const le2 = hl * ceil(L / hl) + 2 * pad;
  // synth inputs: real [8, 2049, timePadded], imag same, length int64 scalar
  const realS = tensor("float32", zrPadded, [flatSC, freqPadded, timePadded]);
  const imagS = tensor("float32", ziPadded, [flatSC, freqPadded, timePadded]);
  const lengthArr = new BigInt64Array(1);
  lengthArr[0] = BigInt(le2);
  const lengthT = tensor("int64", lengthArr, []);
  const synthOut = await runSession(sessions.synthesis, { real: realS, imag: imagS, length: lengthT });
  const yRaw = await synthOut.y.getData(true); // (8, le2)
  const yDims = synthOut.y.dims; // [8, le2]
  const ySamples = yDims[yDims.length - 1];
  // y[..., pad : pad+L] then reshape to (B, S, C, L) and return y + xt
  return assembleStems(yRaw, xtRaw, flatSC, B, S, C, ySamples, pad, L, le2);
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

// pad freq by +1 (zeros, nyquist) and time by (2,2) (zeros). src: (rows, freq, time)
function padFreqAndTime(src, rows, freq, time, freqPadded, timePadded) {
  const out = new Float32Array(rows * freqPadded * timePadded);
  for (let r = 0; r < rows; r += 1) {
    for (let f = 0; f < freq; f += 1) {
      const srcOff = r * freq * time + f * time;
      const dstOff = r * freqPadded * timePadded + f * timePadded + 2;
      out.set(src.subarray(srcOff, srcOff + time), dstOff);
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

// Separate a stereo mix Float32Array (interleaved? NO: planar (C, L) -> we accept planar (1,2,L) flattened) into 4 stems.
// mixFlat: Float32Array length 2*L (planar, channel-major: [ch0samples..., ch1samples...])
// Returns arrays[stemIndex] = Float32Array planar (2, L): [leftSamples, rightSamples] flattened, OR {left,right}.
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

  const out = new Float32Array(B * S * C * totalLength); // (1,S,2,L)
  const sumWeight = new Float32Array(totalLength);
  const wAll = triangularWeights(segmentLength, orch.transitionPower); // length segmentLength

  const offsets = [];
  for (let off = 0; off < totalLength; off += stride) offsets.push(off);
  const nTotal = offsets.length;
  const t0 = Date.now();
  for (let i = 0; i < nTotal; i += 1) {
    const offset = offsets[i];
    const chunkLength = Math.min(totalLength - offset, segmentLength);
    const padded = chunkPadded(mixFlat, B, C, totalLength, offset, chunkLength, segmentLength);
    const seg = await runSegment(padded, B, C, segmentLength, sessions, orch); // {data (1,S,2,SEG), dims}
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
        const outRow = ((0 * S + s) * C + c) * totalLength + offset;
        for (let t = 0; t < targetLen; t += 1) {
          out[outRow + t] += wClipped[t] * segData[segRow + trimStart + t];
        }
      }
    }
    // sum_weight[offset:end] += w_clipped[:targetLen]
    for (let t = 0; t < targetLen; t += 1) sumWeight[offset + t] += wClipped[t];

    const elapsed = (Date.now() - t0) / 1000;
    if (log) log(`  [seg ${i + 1}/${nTotal}] offset=${offset} chunk_len=${chunkLength} (${elapsed.toFixed(1)}s elapsed)`);
    if (onProgress) onProgress({ index: i + 1, total: nTotal, offset, chunkLength, elapsed });
  }

  let minW = Infinity;
  for (let i = 0; i < totalLength; i += 1) if (sumWeight[i] < minW) minW = sumWeight[i];
  if (!(minW > 0)) throw new Error("overlap-add weight sum must be strictly positive everywhere");

  for (let s = 0; s < S; s += 1) {
    for (let c = 0; c < C; c += 1) {
      const row = ((0 * S + s) * C + c) * totalLength;
      for (let t = 0; t < totalLength; t += 1) out[row + t] /= sumWeight[t];
    }
  }

  // Return stems as array of {name, left, right} in SOURCES order: drums, bass, other, vocals
  const stems = [];
  for (let s = 0; s < S; s += 1) {
    const left = out.subarray(((0 * S + s) * C + 0) * totalLength, ((0 * S + s) * C + 1) * totalLength);
    const right = out.subarray(((0 * S + s) * C + 1) * totalLength, ((0 * S + s) * C + 2) * totalLength);
    // copy to detach from out buffer
    stems.push({
      name: orch.sources[s],
      left: Float32Array.from(left),
      right: Float32Array.from(right),
    });
  }
  return stems;
}

// Decode-independent convenience: take planar stereo {left,right} Float32Arrays, separate, write wavs.
async function separateAndWrite(mix, totalLength, sessions, orch, outDir, { onProgress = null, log = null, bits = 32 } = {}) {
  const planar = new Float32Array(2 * totalLength);
  planar.set(mix.left, 0);
  planar.set(mix.right, totalLength);
  const stems = await separate(planar, totalLength, sessions, orch, { onProgress, log });
  const written = {};
  for (const stem of stems) {
    const p = `${outDir}/${stem.name}.wav`;
    await writeStereoWav(p, stem.left, stem.right, orch.sampleRate, { bits });
    written[stem.name] = { path: p, format: "wav", mime: "audio/wav" };
  }
  return { stems: written, stemArrays: stems };
}

module.exports = {
  separate,
  separateAndWrite,
  triangularWeights,
  runSegment,
  chunkPadded,
  centerTrim,
};
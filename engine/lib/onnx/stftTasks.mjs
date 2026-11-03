// The STFT steps of a Demucs chunk, one channel or one stem at a time.
// separate() runs them in place, or hands them to STFT workers (stftWorker.cjs
// on the desktop, engine/web/stftWorker.mjs in the browser); both run this
// same code, so the stems come out the same to the byte.

import { createStft } from "./stft.mjs";

const stfts = new Map();

export function stftFor(nfft, hop) {
  const key = `${nfft}/${hop}`;
  if (!stfts.has(key)) stfts.set(key, createStft(nfft, hop));
  return stfts.get(key);
}

// Shapes for a chunk of segmentLength samples: le frames go into the core,
// pad/padRight is the reflect padding (np.pad) around the chunk, and the
// inverse STFT returns le2 samples, of which [pad, pad + L) are kept.
export function chunkShape(orch) {
  const L = orch.segmentLength;
  const hl = orch.hopLength;
  const le = Math.ceil(L / hl);
  const pad = (hl >> 1) * 3;
  return { L, le, pad, padRight: pad + le * hl - L, freq: orch.nfft / 2, le2: hl * le + 2 * pad };
}

// Analysis STFT of one channel (L samples) into real/imag at (freq, le):
// reflect pad, STFT, drop the Nyquist bin and keep frames 2 .. 2 + le.
export function analyseChannel(stft, row, shape, real, imag) {
  const { L, le, pad, padRight, freq } = shape;
  const padded = new Float32Array(L + pad + padRight);
  padded.set(row, pad);
  for (let i = 0; i < pad; i += 1) padded[pad - 1 - i] = row[i + 1];
  for (let i = 0; i < padRight; i += 1) padded[pad + L + i] = row[L - 2 - i];
  const a = stft.analysis(padded, 1, padded.length);
  const frames = a.dims[2];
  for (let f = 0; f < freq; f += 1) {
    const src = f * frames + 2;
    real.set(a.real.subarray(src, src + le), f * le);
    imag.set(a.imag.subarray(src, src + le), f * le);
  }
}

// Inverse STFT of one stem channel's spectrogram (freq, le) plus its time
// branch xt (L samples) into out (L samples). The core's spectrogram has no
// Nyquist bin and sits 2 frames in from each side of the frames the inverse
// STFT expects; both are zero.
export function synthesiseStream(stft, zr, zi, xt, shape, out) {
  const { L, le, pad, freq, le2 } = shape;
  const y = stft.synthesis(zr, zi, { streams: 1, inBins: freq, inFrames: le, framePad: 2, length: le2 });
  for (let i = 0; i < L; i += 1) out[i] = y[pad + i] + xt[i];
}

// A worker's message: { op, nfft, hop, shape, ...arrays }. Returns the
// result and the buffers to transfer back.
export function runStftTask(task) {
  const stft = stftFor(task.nfft, task.hop);
  const { shape } = task;
  if (task.op === "analysis") {
    const real = new Float32Array(shape.freq * shape.le);
    const imag = new Float32Array(shape.freq * shape.le);
    analyseChannel(stft, task.row, shape, real, imag);
    return { result: { real, imag }, transfer: [real.buffer, imag.buffer] };
  }
  if (task.op === "synthesis") {
    const out = new Float32Array(shape.L);
    synthesiseStream(stft, task.zr, task.zi, task.xt, shape, out);
    return { result: { out }, transfer: [out.buffer] };
  }
  throw new Error(`Unknown STFT task: ${task.op}`);
}

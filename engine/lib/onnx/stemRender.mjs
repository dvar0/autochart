// A stem to listen to, made from a separation's stored mel tables (see
// melTables.mjs) instead of separating the song again: the stem's mel over the
// mix's mel as a soft mask on the mix's own STFT, overlap-added back. Not a
// separation: it sounds like the mix filtered toward the stem, which is what
// the mel holds.

import { createStft } from "./stft.mjs";

const F_SP = 200 / 3;
const MIN_LOG_HZ = 1000;
const MIN_LOG_MEL = MIN_LOG_HZ / F_SP;
const LOG_STEP = Math.log(6.4) / 27;

function hzToMel(hz) {
  return hz >= MIN_LOG_HZ ? MIN_LOG_MEL + Math.log(hz / MIN_LOG_HZ) / LOG_STEP : hz / F_SP;
}

function melToHz(mel) {
  return mel >= MIN_LOG_MEL ? MIN_LOG_HZ * Math.exp(LOG_STEP * (mel - MIN_LOG_MEL)) : F_SP * mel;
}

// librosa.mel_frequencies(n, fmin=0, fmax): n band edges from 0 Hz up to fmax.
export function melFrequencies(n, fmax) {
  const top = hzToMel(fmax);
  return Float64Array.from({ length: n }, (_, i) => melToHz((top * i) / (n - 1)));
}

// Each STFT bin's place between the mel bands' centre frequencies: the band
// below and the weight of the band above (linear interpolation, flat past the
// first and last centres).
function binBandInterp(sampleRate, nFft, nMels, fmax = sampleRate / 2) {
  const centres = melFrequencies(nMels + 2, fmax).subarray(1, nMels + 1);
  const bins = nFft / 2 + 1;
  const lower = new Int32Array(bins);
  const upperWeight = new Float32Array(bins);
  for (let k = 0; k < bins; k += 1) {
    const f = (k * sampleRate) / nFft;
    let b = 0;
    while (b < nMels && centres[b] < f) b += 1; // first centre >= f
    if (b <= 0) { lower[k] = 0; upperWeight[k] = 0; }
    else if (b >= nMels) { lower[k] = nMels - 1; upperWeight[k] = 0; }
    else {
      lower[k] = b - 1;
      upperWeight[k] = (f - centres[b - 1]) / (centres[b] - centres[b - 1]);
    }
  }
  return { lower, upperWeight };
}

// Amplitude gain 10^((stem - mix) / 20) per band and frame, at most 1, spread
// over the bins by band centre.
//   left/right: the mix at sampleRate; mixDb/stemDb: (nMels, nFrames) dB.
//   fmax: the mels' top frequency (their own rate's Nyquist), for a mix at a
//   higher rate than the mels'; bins above it take the top band's gain.
// Returns { left, right } at sampleRate, the mix's length.
export function renderStem({ left, right, mixDb, stemDb, nMels, nFrames, sampleRate = 22050, hop = 512, nFft = 2048, fmax = sampleRate / 2 }) {
  const stft = createStft(nFft, hop);
  const { lower, upperWeight } = binBandInterp(sampleRate, nFft, nMels, fmax);
  const bins = nFft / 2 + 1;
  const half = nFft / 2;
  const length = left.length;
  const span = (nFrames - 1) * hop + nFft;
  const gainBand = new Float64Array(nMels);
  const out = [];
  const wsq = new Float64Array(span);
  for (let t = 0; t < nFrames; t += 1) {
    for (let n = 0; n < nFft; n += 1) wsq[t * hop + n] += stft.window[n] * stft.window[n];
  }
  for (const channel of [left, right]) {
    const padded = new Float32Array(span);
    padded.set(channel.subarray(0, Math.min(length, span - half)), half);
    const acc = new Float64Array(span);
    for (let t = 0; t < nFrames; t += 1) {
      for (let m = 0; m < nMels; m += 1) {
        const g = 10 ** ((stemDb[m * nFrames + t] - mixDb[m * nFrames + t]) / 20);
        gainBand[m] = g < 1 ? g : 1;
      }
      stft.forward(padded, t * hop);
      for (let k = 0; k < bins; k += 1) {
        const b = lower[k];
        const w = upperWeight[k];
        const g = w > 0 ? gainBand[b] * (1 - w) + gainBand[b + 1] * w : gainBand[b];
        stft.xr[k] *= g;
        stft.xi[k] *= g;
      }
      stft.xi[0] = 0;
      stft.xi[bins - 1] = 0;
      stft.inverse();
      const off = t * hop;
      for (let j = 0; j < half; j += 1) {
        acc[off + 2 * j] += stft.re[j] * stft.synthWindow[2 * j];
        acc[off + 2 * j + 1] += stft.im[j] * stft.synthWindow[2 * j + 1];
      }
    }
    const y = new Float32Array(length);
    const n = Math.min(length, span - half);
    for (let i = 0; i < n; i += 1) y[i] = acc[half + i] / (wsq[half + i] + 1e-11);
    out.push(y);
  }
  return { left: out[0], right: out[1] };
}

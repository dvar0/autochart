// A stem heard live from the song, a little at a time: the same soft mask as
// engine/lib/onnx/stemRender.mjs renderStem (the stem's share of the mix per
// mel band and table frame, as an amplitude gain on the song's STFT), but
// overlap-added from any sample on, so playback can start or switch stems
// anywhere without rendering the whole song first. Output matches renderStem
// up to float rounding.
//
// Both channels go through one complex FFT (left as the real part, right as
// the imaginary part): the gain is real and the same on mirrored bins, so the
// channels come back apart.
import { melFrequencies } from "../../../engine/lib/onnx/stemRender.mjs";

export const STREAM_RATE = 44100;
// The tables' hop (512 at 22,050 Hz) at the song's 44.1 kHz.
const HOP = 1024;
const N_FFT = 4096;
const HALF = N_FFT / 2;
const RING = 8192; // > N_FFT; indexes the overlap-add accumulator
const TABLE_TOP_HZ = 22050 / 2;

const shared = (() => {
  const window = new Float64Array(N_FFT);
  for (let n = 0; n < N_FFT; n += 1) window[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT);
  const bits = Math.log2(N_FFT);
  const rev = new Uint32Array(N_FFT);
  for (let i = 0; i < N_FFT; i += 1) {
    let r = 0;
    for (let b = 0; b < bits; b += 1) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(N_FFT / 2);
  const sin = new Float64Array(N_FFT / 2);
  for (let k = 0; k < N_FFT / 2; k += 1) {
    cos[k] = Math.cos((2 * Math.PI * k) / N_FFT);
    sin[k] = Math.sin((2 * Math.PI * k) / N_FFT);
  }
  return { window, rev, cos, sin };
})();

// In-place radix-2 complex FFT of re/im (already in bit-reversed order);
// sign -1 forward, +1 inverse (unscaled).
function fft(re, im, sign) {
  const { cos, sin } = shared;
  for (let size = 2; size <= N_FFT; size <<= 1) {
    const halfSize = size >> 1;
    const step = N_FFT / size;
    for (let start = 0; start < N_FFT; start += size) {
      for (let j = 0, k = 0; j < halfSize; j += 1, k += step) {
        const wr = cos[k];
        const wi = sign * sin[k];
        const a = start + j;
        const b = a + halfSize;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

// Each FFT bin's band below and the weight of the band above (renderStem's
// interpolation between the mel bands' centre frequencies).
const interpCache = new Map();
function binInterp(nMels) {
  if (!interpCache.has(nMels)) {
    const centres = melFrequencies(nMels + 2, TABLE_TOP_HZ).subarray(1, nMels + 1);
    const bins = N_FFT / 2 + 1;
    const lower = new Int32Array(bins);
    const upperWeight = new Float32Array(bins);
    for (let k = 0; k < bins; k += 1) {
      const f = (k * STREAM_RATE) / N_FFT;
      let b = 0;
      while (b < nMels && centres[b] < f) b += 1;
      if (b <= 0) lower[k] = 0;
      else if (b >= nMels) lower[k] = nMels - 1;
      else {
        lower[k] = b - 1;
        upperWeight[k] = (f - centres[b - 1]) / (centres[b] - centres[b - 1]);
      }
    }
    interpCache.set(nMels, { lower, upperWeight });
  }
  return interpCache.get(nMels);
}

// song: { left, right } Float32Array at 44.1 kHz; leadIn: samples of silence
// before it (the separation's lead-in, which its tables include).
// powers: stemTables.stemPowers output; heard: row ids summed into the stem,
// or null for the song itself. Renders from sample `start` on.
export function createStemStream({ song, leadIn = 0, powers, heard, start = 0 }) {
  const { window, rev } = shared;
  const { nMels, nFrames, mix } = powers;
  const parts = heard ? heard.map((id) => powers.stems[id]).filter(Boolean) : null;
  const total = leadIn + song.left.length;
  const accL = new Float64Array(RING);
  const accR = new Float64Array(RING);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const bandGain = new Float64Array(nMels);
  const { lower, upperWeight } = parts ? binInterp(nMels) : {};
  let pos = Math.max(0, Math.floor(start));
  // The first frame reaching sample pos (padded index pos + HALF).
  let nextFrame = Math.max(0, Math.floor((pos + HALF - N_FFT) / HOP) + 1);

  const at = (channel, s) => {
    const i = s - leadIn;
    return i >= 0 && i < channel.length ? channel[i] : 0;
  };

  // from: the first padded index still to be heard; a frame added on a cold
  // start reaches back before it, and those slots must stay clear.
  function addFrame(t, from) {
    const base = t * HOP - HALF; // song sample under window[0]
    for (let n = 0; n < N_FFT; n += 1) {
      const w = window[n];
      const r = rev[n];
      re[r] = at(song.left, base + n) * w;
      im[r] = at(song.right, base + n) * w;
    }
    fft(re, im, -1);
    for (let m = 0; m < nMels; m += 1) {
      const cell = m * nFrames + t;
      let p = 0;
      for (const part of parts) p += part[cell];
      const g = Math.sqrt((p + 1e-20) / (mix[cell] + 1e-20));
      bandGain[m] = g < 1 ? g : 1;
    }
    for (let k = 0; k <= N_FFT / 2; k += 1) {
      const b = lower[k];
      const w = upperWeight[k];
      const g = w > 0 ? bandGain[b] * (1 - w) + bandGain[b + 1] * w : bandGain[b];
      re[k] *= g;
      im[k] *= g;
      if (k > 0 && k < N_FFT / 2) {
        re[N_FFT - k] *= g;
        im[N_FFT - k] *= g;
      }
    }
    // Back to time order for the inverse.
    for (let n = 0; n < N_FFT; n += 1) {
      const r = rev[n];
      if (r > n) {
        let tmp = re[n]; re[n] = re[r]; re[r] = tmp;
        tmp = im[n]; im[n] = im[r]; im[r] = tmp;
      }
    }
    fft(re, im, 1);
    const off = t * HOP;
    for (let n = Math.max(0, from - off); n < N_FFT; n += 1) {
      const w = window[n] / N_FFT;
      const slot = (off + n) % RING;
      accL[slot] += re[n] * w;
      accR[slot] += im[n] * w;
    }
  }

  // The summed squared window over the frames that exist at padded index q.
  function windowSum(q) {
    let sum = 0;
    for (let t = Math.floor(q / HOP); t >= 0 && t * HOP + N_FFT > q; t -= 1) {
      if (t < nFrames) sum += window[q - t * HOP] ** 2;
    }
    return sum;
  }

  return {
    get position() {
      return pos;
    },
    total,
    // The next `count` samples as { left, right }.
    render(count) {
      const left = new Float32Array(count);
      const right = new Float32Array(count);
      for (let i = 0; i < count; i += 1, pos += 1) {
        if (pos >= total) break;
        if (!parts) {
          left[i] = at(song.left, pos);
          right[i] = at(song.right, pos);
          continue;
        }
        const q = pos + HALF;
        while (nextFrame < nFrames && nextFrame * HOP <= q) addFrame(nextFrame++, q);
        const slot = q % RING;
        const norm = windowSum(q) + 1e-11;
        left[i] = accL[slot] / norm;
        right[i] = accR[slot] / norm;
        accL[slot] = 0;
        accR[slot] = 0;
      }
      return { left, right };
    },
  };
}

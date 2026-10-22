// Port of FFmpeg's default swresample resampler (libswresample/resample.c,
// FFmpeg 9.0.1) for the rate pairs Autochart uses. The desktop engine decodes
// through FFmpeg, so a browser engine that resamples with this matches its
// audio to float rounding: same Kaiser-windowed sinc filter bank (filter_size
// 32, phase_shift 10, cutoff 0.97, kaiser_beta 9), same exact-rational phase
// count, same tap alignment.

const BESSEL_P1 = [
  -2.2335582639474375249e+15, -5.5050369673018427753e+14, -3.2940087627407749166e+13,
  -8.4925101247114157499e+11, -1.1912746104985237192e+10, -1.0313066708737980747e+08,
  -5.9545626019847898221e+05, -2.4125195876041896775e+03, -7.0935347449210549190e+00,
  -1.5453977791786851041e-02, -2.5172644670688975051e-05, -3.0517226450451067446e-08,
  -2.6843448573468483278e-11, -1.5982226675653184646e-14, -5.2487866627945699800e-18,
];
const BESSEL_Q1 = [
  -2.2335582639474375245e+15, 7.8858692566751002988e+12, -1.2207067397808979846e+10,
  1.0377081058062166144e+07, -4.8527560179962773045e+03, 1.0,
];
const BESSEL_P2 = [
  -2.2210262233306573296e-04, 1.3067392038106924055e-02, -4.4700805721174453923e-01,
  5.5674518371240761397e+00, -2.3517945679239481621e+01, 3.1611322818701131207e+01,
  -9.6090021968656180000e+00,
];
const BESSEL_Q2 = [
  -5.5194330231005480228e-04, 3.2547697594819615062e-02, -1.1151759188741312645e+00,
  1.3982595353892851542e+01, -6.0228002066743340583e+01, 8.5539563258012929600e+01,
  -3.1446690275135491500e+01, 1.0,
];

function evalPoly(coeff, x) {
  let sum = coeff[coeff.length - 1];
  for (let i = coeff.length - 2; i >= 0; i -= 1) {
    sum *= x;
    sum += coeff[i];
  }
  return sum;
}

// av_bessel_i0 (libavutil/mathematics.c).
function besselI0(x) {
  if (x === 0) return 1.0;
  x = Math.abs(x);
  if (x <= 15) {
    const y = x * x;
    return evalPoly(BESSEL_P1, y) / evalPoly(BESSEL_Q1, y);
  }
  const y = 1 / x - 1.0 / 15;
  const r = evalPoly(BESSEL_P2, y) / evalPoly(BESSEL_Q2, y);
  return (Math.exp(x) / Math.sqrt(x)) * r;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

const filterCache = new Map();

// resample_init + build_filter for AV_SAMPLE_FMT_FLTP, Kaiser window.
export function swrFilterBank(inRate, outRate, { filterSize = 32, phaseShift = 10, cutoff = 0.97, kaiserBeta = 9 } = {}) {
  const key = `${inRate}:${outRate}:${filterSize}:${phaseShift}:${cutoff}:${kaiserBeta}`;
  const cached = filterCache.get(key);
  if (cached) return cached;

  const factor = Math.min((outRate * cutoff) / inRate, 1.0);
  let filterLength = Math.max(Math.ceil(filterSize / factor), 1);
  if (filterLength > 1) filterLength = (filterLength + 1) & ~1;
  const g = gcd(outRate, inRate);
  const phaseCount = outRate / g;
  if (phaseCount > 1 << phaseShift) {
    // FFmpeg would switch to its interpolating path here; no supported rate needs it.
    throw new Error(`Unsupported resampling ratio ${inRate} -> ${outRate} Hz.`);
  }
  const step = inRate / g; // input advance per output sample, in phases
  const tapCount = filterLength;
  const center = (tapCount - 1) >> 1;
  const phNb = phaseCount % 2 ? phaseCount : phaseCount / 2 + 1;
  const bank = new Float32Array(phaseCount * tapCount);
  const tab = new Float64Array(tapCount);
  const sinLut = new Float64Array(phNb);
  if (factor === 1.0) {
    for (let ph = 0; ph < phNb; ph += 1) sinLut[ph] = Math.sin((Math.PI * ph) / phaseCount) * (center & 1 ? 1 : -1);
  }
  let norm = 0;
  for (let ph = 0; ph < phNb; ph += 1) {
    let s = sinLut[ph];
    for (let i = 0; i < tapCount; i += 1) {
      const x = Math.PI * ((i - center) - ph / phaseCount) * factor;
      let y;
      if (x === 0) y = 1.0;
      else if (factor === 1.0) y = s / x;
      else y = Math.sin(x) / x;
      const w = (2.0 * x) / (factor * tapCount * Math.PI);
      y *= besselI0(kaiserBeta * Math.sqrt(Math.max(1 - w * w, 0)));
      tab[i] = y;
      s = -s;
      if (!ph) norm += y;
    }
    for (let i = 0; i < tapCount; i += 1) bank[ph * tapCount + i] = tab[i] / norm;
    if (phaseCount % 2) continue;
    // Mirror into the second half; phase == phaseCount is the wrap copy FFmpeg keeps past the bank.
    if (phaseCount - ph < phaseCount) {
      for (let i = 0; i < tapCount; i += 1) bank[(phaseCount - ph) * tapCount + tapCount - 1 - i] = bank[ph * tapCount + i];
    }
  }
  const out = { phaseCount, step, tapCount, center, bank };
  filterCache.set(key, out);
  return out;
}

// Input sample s with FFmpeg's edge handling: invert_initial_buffer mirrors
// the start without repeating sample 0, resample_flush mirrors the end with
// the last sample repeated, and anything past that reads as silence.
function edgeSample(input, s, tailReflection) {
  const n = input.length;
  if (s < 0) return -s < n ? input[-s] : 0;
  if (s < n) return input[s];
  return s - n < tailReflection ? input[2 * n - 1 - s] : 0;
}

// Resample one channel. At equal rates this is the input itself, not a copy.
export function resampleChannel(input, inRate, outRate, options) {
  if (inRate === outRate) return input;
  const { phaseCount, step, tapCount, center, bank } = swrFilterBank(inRate, outRate, options);
  const n = input.length;
  const outLength = Math.ceil((n * outRate) / inRate);
  const out = new Float32Array(outLength);
  const tailReflection = (Math.min(n, tapCount) + 1) >> 1;
  let index = -phaseCount * center;
  for (let o = 0; o < outLength; o += 1, index += step) {
    const sampleIndex = Math.floor(index / phaseCount);
    const phase = index - sampleIndex * phaseCount;
    const f = phase * tapCount;
    let val = 0;
    if (sampleIndex >= 0 && sampleIndex + tapCount <= n) {
      for (let i = 0; i < tapCount; i += 1) val += input[sampleIndex + i] * bank[f + i];
    } else {
      for (let i = 0; i < tapCount; i += 1) val += edgeSample(input, sampleIndex + i, tailReflection) * bank[f + i];
    }
    out[o] = val;
  }
  return out;
}

// FFmpeg's stereo -> mono rematrix (`-ac 1`): each side times sqrt(1/2) in
// float, unnormalized. The beat stage decodes its audio this way.
const SQRT1_2_F32 = Math.fround(Math.SQRT1_2);
export function ffmpegMonoDownmix(left, right) {
  const out = new Float32Array(left.length);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Math.fround(SQRT1_2_F32 * left[i]) + Math.fround(SQRT1_2_F32 * right[i]);
  }
  return out;
}

// librosa-style mono (0.5 * (L + R)), which the transcriber stage uses.
export function averageMono(left, right) {
  const out = new Float32Array(left.length);
  for (let i = 0; i < out.length; i += 1) out[i] = 0.5 * (left[i] + right[i]);
  return out;
}

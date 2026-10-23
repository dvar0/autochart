// Demucs' STFT and inverse STFT computed with an FFT. They replace the two
// basis graphs (demucs_analysis_stft / demucs_synthesis_istft), which hold the
// DFT as a dense 4098x4096 matrix: same transform (periodic Hann window,
// 1/sqrt(nfft) scaling, centered frames with reflect padding, window-squared
// normalization), about 100x less arithmetic, and no 134 MB of graph files.
// The basis was built with float32 phases, so it is off by up to ~1e-3 at
// high bins; the FFT works in float64 and is closer to the true transform.

// Complex FFT of size m (a power of two), in place on re/im. The input must
// already be in bit-reversed order (fft.rev), which callers fold into their
// loads. One radix-2 stage when log2(m) is odd, then radix-4 stages.
function createFft(m) {
  const bits = Math.log2(m);
  if (!Number.isInteger(bits)) throw new Error(`FFT size must be a power of two: ${m}`);
  const rev = new Uint32Array(m);
  for (let i = 1; i < m; i += 1) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
  const cos = new Float64Array(m);
  const sin = new Float64Array(m);
  for (let i = 0; i < m; i += 1) {
    cos[i] = Math.cos((2 * Math.PI * i) / m);
    sin[i] = Math.sin((2 * Math.PI * i) / m);
  }
  // sign -1: forward (e^-i), +1: inverse without the 1/m.
  function fft(re, im, sign) {
    let q = 1;
    if (bits % 2) {
      for (let a = 0; a < m; a += 2) {
        const xr = re[a + 1], xi = im[a + 1];
        re[a + 1] = re[a] - xr;
        im[a + 1] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
      q = 2;
    }
    // Combine four sub-transforms of length q into one of length 4q. In
    // bit-reversed order they sit at offsets 0, q, 2q, 3q holding the
    // samples congruent to 0, 2, 1, 3 (mod 4).
    for (; q < m; q <<= 2) {
      const step = m / (q << 2);
      for (let start = 0; start < m; start += q << 2) {
        for (let j = 0; j < q; j += 1) {
          const w1 = j * step, w2 = 2 * w1, w3 = 3 * w1;
          const c1 = cos[w1], s1 = sign * sin[w1];
          const c2 = cos[w2], s2 = sign * sin[w2];
          const c3 = cos[w3], s3 = sign * sin[w3];
          const i0 = start + j, i1 = i0 + q, i2 = i1 + q, i3 = i2 + q;
          const ar = re[i0], ai = im[i0];
          const br = re[i1] * c2 - im[i1] * s2, bi = re[i1] * s2 + im[i1] * c2;
          const cr = re[i2] * c1 - im[i2] * s1, ci = re[i2] * s1 + im[i2] * c1;
          const dr = re[i3] * c3 - im[i3] * s3, di = re[i3] * s3 + im[i3] * c3;
          const t0r = ar + br, t0i = ai + bi, t1r = ar - br, t1i = ai - bi;
          const t2r = cr + dr, t2i = ci + di;
          const t3r = -sign * (ci - di), t3i = sign * (cr - dr); // (c - d) * sign * i
          re[i0] = t0r + t2r;
          im[i0] = t0i + t2i;
          re[i2] = t0r - t2r;
          im[i2] = t0i - t2i;
          re[i1] = t1r + t3r;
          im[i1] = t1i + t3i;
          re[i3] = t1r - t3r;
          im[i3] = t1i - t3i;
        }
      }
    }
  }
  fft.rev = rev;
  return fft;
}

export function createStft(nfft, hop) {
  const m = nfft / 2;
  const bins = m + 1;
  const fft = createFft(m);
  const rev = fft.rev;
  const window = new Float64Array(nfft);
  for (let n = 0; n < nfft; n += 1) window[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / nfft);
  // Twiddles that split one m-point FFT into the nfft-point real FFT.
  const tc = new Float64Array(m);
  const ts = new Float64Array(m);
  for (let k = 0; k < m; k += 1) {
    tc[k] = Math.cos((2 * Math.PI * k) / nfft);
    ts[k] = Math.sin((2 * Math.PI * k) / nfft);
  }
  const scale = 1 / Math.sqrt(nfft);
  // The unscaled inverse returns nfft * irfft, so synthesis takes the same scale.
  const synthWindow = window.map((w) => w * scale);
  const re = new Float64Array(m);
  const im = new Float64Array(m);
  const xr = new Float64Array(bins);
  const xi = new Float64Array(bins);
  const wsqCache = new Map();

  // Real FFT of window * frame -> xr/xi (bins values, scaled).
  function forward(src, offset) {
    for (let j = 0; j < m; j += 1) {
      re[rev[j]] = src[offset + 2 * j] * window[2 * j];
      im[rev[j]] = src[offset + 2 * j + 1] * window[2 * j + 1];
    }
    fft(re, im, -1);
    xr[0] = (re[0] + im[0]) * scale;
    xi[0] = 0;
    xr[m] = (re[0] - im[0]) * scale;
    xi[m] = 0;
    for (let k = 1; k < m; k += 1) {
      const ar = re[k], ai = im[k], br = re[m - k], bi = -im[m - k];
      // even = (Z[k] + conj Z[m-k]) / 2, odd = (Z[k] - conj Z[m-k]) / 2i
      const er = (ar + br) / 2, ei = (ai + bi) / 2;
      const or = (ai - bi) / 2, oi = -(ar - br) / 2;
      xr[k] = (er + or * tc[k] + oi * ts[k]) * scale;
      xi[k] = (ei + oi * tc[k] - or * ts[k]) * scale;
    }
  }

  // Inverse real FFT of xr/xi into re/im (frame sample 2j in re[j], 2j+1 in
  // im[j]), unscaled. The imaginary parts of DC and Nyquist are ignored, as
  // the basis graph does.
  function inverse() {
    for (let k = 0; k < m; k += 1) {
      const ar = xr[k], ai = k === 0 ? 0 : xi[k];
      const br = xr[m - k], bi = k === 0 ? 0 : -xi[m - k];
      const er = ar + br, ei = ai + bi;
      const dr = ar - br, di = ai - bi;
      // odd = (X[k] - conj X[m-k]) * e^{+i 2 pi k / nfft}
      const or = dr * tc[k] - di * ts[k];
      const oi = dr * ts[k] + di * tc[k];
      re[rev[k]] = er - oi;
      im[rev[k]] = ei + or;
    }
    fft(re, im, 1);
  }

  // x: Float32Array (streams, samples). Frames are centered (reflect pad of
  // nfft/2 each side). Returns real/imag laid out (streams, bins, frames).
  function analysis(x, streams, samples) {
    const pad = nfft / 2;
    const padded = new Float32Array(samples + 2 * pad);
    const frames = Math.floor(samples / hop) + 1;
    const real = new Float32Array(streams * bins * frames);
    const imag = new Float32Array(streams * bins * frames);
    for (let s = 0; s < streams; s += 1) {
      const row = x.subarray(s * samples, (s + 1) * samples);
      padded.set(row, pad);
      for (let i = 0; i < pad; i += 1) {
        padded[pad - 1 - i] = row[i + 1];
        padded[pad + samples + i] = row[samples - 2 - i];
      }
      const base = s * bins * frames;
      for (let t = 0; t < frames; t += 1) {
        forward(padded, t * hop);
        for (let k = 0; k < bins; k += 1) {
          real[base + k * frames + t] = xr[k];
          imag[base + k * frames + t] = xi[k];
        }
      }
    }
    return { real, imag, dims: [streams, bins, frames] };
  }

  function windowSquareSum(frames) {
    let wsq = wsqCache.get(frames);
    if (!wsq) {
      wsq = new Float64Array((frames - 1) * hop + nfft);
      for (let t = 0; t < frames; t += 1) {
        for (let n = 0; n < nfft; n += 1) wsq[t * hop + n] += window[n] * window[n];
      }
      wsqCache.set(frames, wsq);
    }
    return wsq;
  }

  // Inverse of analysis. real/imag: (streams, inBins, inFrames), where inBins
  // may leave out the Nyquist bin (taken as zero) and the input sits
  // framePad zero frames in from each side of the full frame axis. Returns y
  // (streams, length): the overlap-added signal, normalized by the summed
  // squared window, starting at sample nfft/2.
  function synthesis(real, imag, { streams, inBins, inFrames, framePad = 0, length }) {
    const frames = inFrames + 2 * framePad;
    const wsq = windowSquareSum(frames);
    const pad = nfft / 2;
    if (length + pad > wsq.length) throw new Error(`ISTFT length ${length} exceeds ${wsq.length - pad} samples`);
    const acc = new Float64Array(wsq.length);
    const y = new Float32Array(streams * length);
    for (let s = 0; s < streams; s += 1) {
      acc.fill(0);
      const base = s * inBins * inFrames;
      for (let t = 0; t < inFrames; t += 1) {
        for (let k = 0; k < bins; k += 1) {
          xr[k] = k < inBins ? real[base + k * inFrames + t] : 0;
          xi[k] = k < inBins ? imag[base + k * inFrames + t] : 0;
        }
        inverse();
        const off = (t + framePad) * hop;
        for (let j = 0; j < m; j += 1) {
          acc[off + 2 * j] += re[j] * synthWindow[2 * j];
          acc[off + 2 * j + 1] += im[j] * synthWindow[2 * j + 1];
        }
      }
      for (let i = 0; i < length; i += 1) {
        y[s * length + i] = acc[pad + i] / (wsq[pad + i] + 1e-11);
      }
    }
    return y;
  }

  return { analysis, synthesis, bins };
}

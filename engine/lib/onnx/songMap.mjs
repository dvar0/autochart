// The song map behind the live board: how loud the mix and each stem are over
// the song, and where the beats fall. It is only for showing the run; nothing
// here feeds back into the chart.

export const MAP_RATE = 10; // frames a second
export const MAP_FILE = "song_map.json";

const GAIN = 2.5;

// Mean power to a 0..255 level, with quiet parts lifted so they still show.
function encode(power) {
  return Math.round(255 * Math.min(1, Math.sqrt(power) * GAIN) ** 0.85);
}

// The frames that start inside [start, end) of a signal at this rate.
export function framesIn(start, end, sampleRate, rate = MAP_RATE) {
  const perFrame = sampleRate / rate;
  return { first: Math.ceil(start / perFrame), last: Math.ceil(end / perFrame) };
}

// Mean power per frame across the rows, sampled sparsely. weights, when given,
// divide each sample (the overlap-add weights while a separation is running).
export function framePower(rows, sampleRate, start, end, { rate = MAP_RATE, weights = null } = {}) {
  const perFrame = sampleRate / rate;
  const { first, last } = framesIn(start, end, sampleRate, rate);
  const out = new Float32Array(Math.max(0, last - first));
  const hop = Math.max(1, Math.floor(perFrame / 256));
  for (let f = first; f < last; f += 1) {
    const s0 = Math.max(start, Math.round(f * perFrame));
    const s1 = Math.min(end, Math.round((f + 1) * perFrame));
    let sum = 0;
    let count = 0;
    for (let t = s0; t < s1; t += hop) {
      const w = weights ? weights[t] : 1;
      if (!(w > 0)) continue;
      for (const row of rows) {
        const v = row[t] / w;
        sum += v * v;
      }
      count += rows.length;
    }
    out[f - first] = count ? sum / count : 0;
  }
  return { first, power: out };
}

// The mix's levels over the whole song.
export function mixLevels(channels, sampleRate, rate = MAP_RATE) {
  const { power } = framePower(channels, sampleRate, 0, channels[0].length, { rate });
  return Array.from(power, encode);
}

// One stretch of a separation: per-source power, folded into the stems the
// models read (other + piano) as levels.
export function stemLevels(sourcePower, orch) {
  const names = Array.isArray(orch.stems) && orch.stems.length ? orch.stems : Object.keys(sourcePower);
  return Object.fromEntries(names.map((name) => {
    const parts = ((orch.stemFold && orch.stemFold[name]) || [name]).map((part) => sourcePower[part]);
    const out = new Array(parts[0].length);
    for (let i = 0; i < out.length; i += 1) {
      let sum = 0;
      for (const part of parts) sum += part[i];
      out[i] = encode(sum);
    }
    return [name, out];
  }));
}

export const roundTimes = (times) => Array.from(times, (t) => Math.round(t * 1000) / 1000).filter((t) => t >= 0);

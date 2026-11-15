// A separation's stored stem mel tables (engine/lib/onnx/melTables.mjs) as the
// Separation tab uses them: each stem's power, and the song's as the sum of
// the stems that make it up. Shared by the stem graphs and the stem render
// worker, so both see the same stems.

// The stems a separation stores inside another channel, from its tables'
// recipe: "...+other=other&piano" means its "other" holds the piano too (for a
// charting model that reads them together). { other: ["piano"] }.
export function tableFolds(tables) {
  const out = {};
  for (const [, name, parts] of String(tables?.recipe || "").matchAll(/\+(\w+)=([\w&]+)/g)) {
    const inside = parts.split("&").filter((part) => part !== name);
    if (inside.length) out[name] = inside;
  }
  return out;
}

// Power per (band, frame) for each row in the tables, the mix's included: the
// sum of the stems, each counted once. A folded channel has its folded stems
// taken out of it, so every row is that stem alone. A row the tables lack (an
// older separation) is null.
export function stemPowers(tables, rowIds) {
  const folded = tableFolds(tables);
  const inside = new Set(Object.values(folded).flat());
  const parts = rowIds.filter((id) => !inside.has(id));
  const present = tables.channels.filter((name) => tables.mels[name]);
  if (!present.length) throw new Error("This separation has no stem tables.");
  const { nMels, nFrames } = tables.mels[present[0]];
  const size = nMels * nFrames;
  const cache = new Map();
  const power = (name) => {
    if (!tables.mels[name]) return null;
    if (!cache.has(name)) {
      const { mel } = tables.mels[name];
      const out = new Float32Array(size);
      for (let i = 0; i < size; i += 1) out[i] = 10 ** (mel[i] / 10);
      cache.set(name, out);
    }
    return cache.get(name);
  };
  const mix = new Float32Array(size);
  for (const name of parts) {
    const p = power(name);
    if (p) for (let i = 0; i < size; i += 1) mix[i] += p[i];
  }
  const stems = {};
  for (const id of rowIds) {
    const p = power(id);
    const within = (folded[id] || []).map(power).filter(Boolean);
    if (!p || !within.length) {
      stems[id] = p;
      continue;
    }
    // The stored channel holds the folded stems too; what's left is this one.
    const out = new Float32Array(size);
    for (let i = 0; i < size; i += 1) {
      let v = p[i];
      for (const q of within) v -= q[i];
      out[i] = Math.max(v, p[i] * 1e-4);
    }
    stems[id] = out;
  }
  return { nMels, nFrames, mix, stems };
}

// Several stems heard together go by their ids joined with "+" ("guitar+drums").
export function stemParts(stem) {
  return String(stem || "").split("+").filter(Boolean);
}

export function powerDb(power) {
  const out = new Float32Array(power.length);
  for (let i = 0; i < power.length; i += 1) out[i] = 10 * Math.log10(power[i] + 1e-20);
  return out;
}

// 16-bit stereo WAV bytes; padFrames of silence go first.
export function wav16(left, right, sampleRate, padFrames = 0) {
  const frames = padFrames + left.length;
  const buffer = new ArrayBuffer(44 + frames * 4);
  const view = new DataView(buffer);
  const text = (at, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + frames * 4, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, frames * 4, true);
  const pcm = new Int16Array(buffer, 44, frames * 2);
  for (let i = 0; i < left.length; i += 1) {
    pcm[2 * (padFrames + i)] = Math.max(-1, Math.min(1, left[i])) * 0x7fff;
    pcm[2 * (padFrames + i) + 1] = Math.max(-1, Math.min(1, right[i])) * 0x7fff;
  }
  return buffer;
}

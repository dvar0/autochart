"use strict";

const fs = require("fs");
const path = require("path");
const { writeVerifiedAtomic } = require("../../../electron/fileSafety.cjs");
// Minimal PCM/float WAV writer for stereo Float32 channel buffers.
// bits: 32 = IEEE float (audioFormat 3), 16 = signed PCM (audioFormat 1).
async function writeStereoWav(outPath, left, right, sampleRate = 44100, opts = {}) {
  const bits = opts.bits === 16 ? 16 : 32;
  const floatFmt = bits === 32;
  const frames = Math.min(left.length, right.length);
  const blockAlign = 2 * (bits / 8);
  const dataSize = frames * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(floatFmt ? 3 : 1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  let offset = 44;
  if (floatFmt) {
    for (let i = 0; i < frames; i += 1) {
      buffer.writeFloatLE(left[i], offset); offset += 4;
      buffer.writeFloatLE(right[i], offset); offset += 4;
    }
  } else {
    for (let i = 0; i < frames; i += 1) {
      const l = Math.max(-1, Math.min(1, left[i]));
      const r = Math.max(-1, Math.min(1, right[i]));
      buffer.writeInt16LE(Math.round(l * 32767), offset); offset += 2;
      buffer.writeInt16LE(Math.round(r * 32767), offset); offset += 2;
    }
  }
  await writeVerifiedAtomic(outPath, buffer, {
    rootDirectory: opts.rootDirectory || path.dirname(outPath),
    label: "Demucs WAV",
  });
  return outPath;
}

module.exports = { writeStereoWav };
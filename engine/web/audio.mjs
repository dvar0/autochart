// Browser audio for the engine. The desktop engine decodes through FFmpeg at
// each stage's rate; here the browser decodes once at the file's own rate (no
// browser resampler involved) and resample.mjs makes each stage's audio the way
// FFmpeg would.

import { resampleChannel, ffmpegMonoDownmix, averageMono } from "../lib/onnx/resample.mjs";

const SQRT1_2_F32 = Math.fround(Math.SQRT1_2);
const MP3_RATES =[[44100, 48000, 32000], [22050, 24000, 16000], [11025, 12000, 8000]];
const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function ascii(bytes, at, length) {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function sniffWav(bytes, dv) {
  for (let p = 12; p + 8 <= bytes.length;) {
    const size = dv.getUint32(p + 4, true);
    if (ascii(bytes, p, 4) === "fmt ") return dv.getUint32(p + 12, true);
    p += 8 + size + (size & 1);
  }
  return null;
}

function sniffFlac(bytes) {
  // STREAMINFO is the first metadata block: rate is 20 bits at byte 18.
  return ((bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4)) >>> 0;
}

function sniffOgg(bytes, dv) {
  const limit = Math.min(bytes.length, 4096);
  for (let p = 0; p + 16 < limit; p += 1) {
    if (bytes[p] === 0x01 && ascii(bytes, p + 1, 6) === "vorbis") return dv.getUint32(p + 12, true);
    if (ascii(bytes, p, 8) === "OpusHead") return 48000; // Opus always decodes at 48 kHz.
    if (bytes[p] === 0x7f && ascii(bytes, p + 1, 4) === "FLAC") return sniffFlac(bytes.subarray(p + 13));
  }
  return null;
}

function sniffMp3(bytes) {
  let p = 0;
  if (ascii(bytes, 0, 3) === "ID3") {
    p = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);
  }
  const limit = Math.min(bytes.length - 4, p + 65536);
  for (; p < limit; p += 1) {
    if (bytes[p] !== 0xff || (bytes[p + 1] & 0xe0) !== 0xe0) continue;
    const version = (bytes[p + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const rateIndex = (bytes[p + 2] >> 2) & 3;
    if (version === 1 || rateIndex === 3) continue;
    return MP3_RATES[version === 3 ? 0 : version === 2 ? 1 : 2][rateIndex];
  }
  return null;
}

function sniffMp4(bytes, dv) {
  // The AudioSpecificConfig in esds names the AAC rate; mp4a's own field is a fallback.
  const limit = Math.min(bytes.length - 8, 8 * 1024 * 1024);
  let mp4aRate = null;
  for (let p = 4; p < limit; p += 1) {
    if (bytes[p] === 0x6d && ascii(bytes, p, 4) === "mp4a" && mp4aRate == null) {
      mp4aRate = dv.getUint16(p + 4 + 24, false);
    }
    if (bytes[p] === 0x05 && bytes[p - 1] === 0x80 && bytes[p - 2] === 0x80 && bytes[p - 3] === 0x80) {
      // DecoderSpecificInfo tag with 0x80 0x80 0x80 length padding (the common encoding).
      const asc = p + 2;
      const index = ((bytes[asc] & 0x07) << 1) | (bytes[asc + 1] >> 7);
      if (index < AAC_RATES.length) return AAC_RATES[index];
    }
  }
  return mp4aRate;
}

// The rate a file decodes at, from its header. null when the format is unknown.
export function sniffSampleRate(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 32) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = ascii(bytes, 0, 4);
  if (tag === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return sniffWav(bytes, dv);
  if (tag === "fLaC") return sniffFlac(bytes);
  if (tag === "OggS") return sniffOgg(bytes, dv);
  if (ascii(bytes, 4, 4) === "ftyp") return sniffMp4(bytes, dv);
  return sniffMp3(bytes);
}

// Decode a whole file to stereo at its own rate (main thread only:
// OfflineAudioContext isn't available in workers).
export async function decodeAudioFile(arrayBuffer) {
  const rate = sniffSampleRate(arrayBuffer) || 44100;
  const context = new OfflineAudioContext(2, 1, rate);
  const buffer = await context.decodeAudioData(arrayBuffer.slice(0));
  if (buffer.numberOfChannels === 1) {
    // FFmpeg's `-ac 2` puts a mono file on both sides at sqrt(1/2).
    const mono = buffer.getChannelData(0);
    const side = new Float32Array(mono.length);
    for (let i = 0; i < side.length; i += 1) side[i] = SQRT1_2_F32 * mono[i];
    return { left: side, right: side, sampleRate: buffer.sampleRate };
  }
  return {
    left: Float32Array.from(buffer.getChannelData(0)),
    right: Float32Array.from(buffer.getChannelData(1)),
    sampleRate: buffer.sampleRate,
  };
}

// Each stage's audio from the decoded file, as the desktop engine's FFmpeg calls make it.
export function stereoAt(decoded, rate) {
  return {
    left: resampleChannel(decoded.left, decoded.sampleRate, rate),
    right: resampleChannel(decoded.right, decoded.sampleRate, rate),
  };
}

// `ffmpeg -ac 1 -ar <rate>`: FFmpeg's mono mix, then resample.
export function ffmpegMonoAt(decoded, rate) {
  return resampleChannel(ffmpegMonoDownmix(decoded.left, decoded.right), decoded.sampleRate, rate);
}

// Stereo at a rate, then 0.5 * (L + R): the transcriber's mix and stems.
export function averageMonoAt(left, right, fromRate, rate) {
  return averageMono(resampleChannel(left, fromRate, rate), resampleChannel(right, fromRate, rate));
}

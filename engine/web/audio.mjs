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

// kbit/s by [MPEG1, MPEG2/2.5][layer 1, 2, 3][index].
const MPEG_BITRATES = [
  [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ],
  [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
];

// An MPEG audio frame header at p: its rate and frame length, or null.
function mpegFrame(bytes, p) {
  if (p + 4 > bytes.length || bytes[p] !== 0xff || (bytes[p + 1] & 0xe0) !== 0xe0) return null;
  const version = (bytes[p + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = 4 - ((bytes[p + 1] >> 1) & 3); // 0b00 is reserved (ADTS uses it)
  const bitrateIndex = bytes[p + 2] >> 4;
  const rateIndex = (bytes[p + 2] >> 2) & 3;
  if (version === 1 || layer === 4 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const rate = MP3_RATES[version === 3 ? 0 : version === 2 ? 1 : 2][rateIndex];
  const bitrate = MPEG_BITRATES[version === 3 ? 0 : 1][layer - 1][bitrateIndex] * 1000;
  const padding = (bytes[p + 2] >> 1) & 1;
  const length = layer === 1
    ? (Math.floor((12 * bitrate) / rate) + padding) * 4
    : Math.floor(((layer === 3 && version !== 3 ? 72 : 144) * bitrate) / rate) + padding;
  return { rate, length };
}

// MPEG audio or ADTS AAC, after any ID3 tags: the first frame whose next
// frame is where its length says, so stray sync bytes don't count. Its rate
// and kind ("mp3" or "aac"), or null.
function sniffFrames(bytes) {
  let p = 0;
  while (p + 10 <= bytes.length && ascii(bytes, p, 3) === "ID3") {
    p += 10 + ((bytes[p + 6] << 21) | (bytes[p + 7] << 14) | (bytes[p + 8] << 7) | bytes[p + 9]) + (bytes[p + 5] & 0x10 ? 10 : 0);
  }
  const limit = Math.min(bytes.length - 4, p + 65536);
  for (; p < limit; p += 1) {
    if (bytes[p] !== 0xff) continue;
    if ((bytes[p + 1] & 0xf6) === 0xf0) {
      // ADTS: rate index at bits 2-5 of the third byte, 13-bit frame length.
      const index = (bytes[p + 2] >> 2) & 0x0f;
      const length = ((bytes[p + 3] & 3) << 11) | (bytes[p + 4] << 3) | (bytes[p + 5] >> 5);
      const next = p + length;
      if (index < AAC_RATES.length && length > 7 && (next + 2 > bytes.length || (bytes[next] === 0xff && (bytes[next + 1] & 0xf6) === 0xf0))) {
        return { rate: AAC_RATES[index], kind: "aac" };
      }
      continue;
    }
    const frame = mpegFrame(bytes, p);
    if (!frame) continue;
    const next = p + frame.length;
    if (next + 4 > bytes.length || mpegFrame(bytes, next)?.rate === frame.rate) return { rate: frame.rate, kind: "mp3" };
  }
  return null;
}

// ---- MP4 / MOV / M4A: the first sound track's sample description. ----

function* boxes(dv, start, end) {
  for (let p = start; p + 8 <= end;) {
    let size = dv.getUint32(p);
    let header = 8;
    if (size === 1 && p + 16 <= end) {
      size = Number(dv.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header) return;
    const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
    yield { type, start: p + header, end: Math.min(end, p + size) };
    p += size;
  }
}

function child(dv, box, type) {
  for (const b of boxes(dv, box.start, box.end)) if (b.type === type) return b;
  return null;
}

// MPEG-4 descriptor at p: tag, payload start, payload end.
function descriptor(bytes, p, end) {
  if (p + 2 > end) return null;
  const tag = bytes[p];
  let length = 0;
  let q = p + 1;
  for (let i = 0; i < 4 && q < end; i += 1) {
    const b = bytes[q++];
    length = (length << 7) | (b & 0x7f);
    if (!(b & 0x80)) break;
  }
  return { tag, start: q, end: Math.min(end, q + length) };
}

// The AAC rate an esds box names: its AudioSpecificConfig, with SBR's
// doubled output rate when it's signalled. null when it isn't AAC.
function esdsRate(bytes, esds) {
  const es = descriptor(bytes, esds.start + 4, esds.end);
  if (es?.tag !== 0x03) return null;
  const flags = bytes[es.start + 2];
  let p = es.start + 3 + (flags & 0x80 ? 2 : 0) + (flags & 0x20 ? 2 : 0);
  if (flags & 0x40) p += 1 + bytes[p];
  const config = descriptor(bytes, p, es.end);
  if (config?.tag !== 0x04 || bytes[config.start] !== 0x40) return null; // 0x40: MPEG-4 audio
  const info = descriptor(bytes, config.start + 13, config.end);
  if (info?.tag !== 0x05 || info.end - info.start < 2) return null;
  // Bit positions relative to the config: absolute ones overflow 32-bit shifts past 256 MB.
  const asc = bytes.subarray(info.start, info.end);
  let bit = 0;
  const read = (n) => {
    let value = 0;
    for (let i = 0; i < n; i += 1, bit += 1) value = value * 2 + ((asc[bit >> 3] >> (7 - (bit & 7))) & 1);
    return value;
  };
  const readRate = () => {
    const index = read(4);
    return index === 15 ? read(24) : AAC_RATES[index] ?? null;
  };
  let objectType = read(5);
  if (objectType === 31) objectType = 32 + read(6);
  const rate = readRate();
  read(4); // channel configuration
  if (objectType === 5 || objectType === 29) return readRate(); // SBR / PS: the extension rate
  return rate;
}

// The first sound track in a moov box: its sample entry and timescale.
function soundTrack(bytes, dv, moov) {
  for (const trak of boxes(dv, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;
    const mdia = child(dv, trak, "mdia");
    const hdlr = mdia && child(dv, mdia, "hdlr");
    if (!hdlr || ascii(bytes, hdlr.start + 8, 4) !== "soun") continue;
    const mdhd = child(dv, mdia, "mdhd");
    const timescale = mdhd ? dv.getUint32(mdhd.start + (bytes[mdhd.start] === 1 ? 20 : 12)) : 0;
    const minf = child(dv, mdia, "minf");
    const stbl = minf && child(dv, minf, "stbl");
    const stsd = stbl && child(dv, stbl, "stsd");
    const entry = (stsd && boxes(dv, stsd.start + 8, stsd.end).next().value) || null;
    return { entry, timescale };
  }
  return null;
}

function sniffMp4(bytes, dv) {
  const moov = [...boxes(dv, 0, bytes.length)].find((b) => b.type === "moov");
  const track = moov && soundTrack(bytes, dv, moov);
  if (!track) return null;
  const { entry, timescale } = track;
  if (!entry) return timescale || null;
  if (entry.type === "Opus") return 48000; // Opus always decodes at 48 kHz.
  // Sound sample entry: version at +8, 16.16 rate at +24 (QuickTime v2: float64 at +32).
  const version = dv.getUint16(entry.start + 8);
  const entryRate = version === 2 ? Math.round(dv.getFloat64(entry.start + 32)) : dv.getUint16(entry.start + 24);
  if (entry.type === "mp4a") {
    const children = entry.start + (version === 2 ? 64 : version === 1 ? 44 : 28);
    for (const b of boxes(dv, children, entry.end)) {
      if (b.type === "esds" || b.type === "wave") {
        const esds = b.type === "esds" ? b : child(dv, b, "esds");
        const rate = esds && esdsRate(bytes, esds);
        // Implicit SBR names only the core rate; the track's timescale then shows the doubled one.
        if (rate) return timescale === 2 * rate ? timescale : rate;
      }
    }
  }
  return entryRate || timescale || null;
}

// ---- Matroska / WebM: the first audio track's sampling frequency. ----

function ebmlVint(bytes, p, keepMarker) {
  const first = bytes[p];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length += 1;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + bytes[p + i];
    if (bytes[p + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function* ebmlElements(bytes, start, end) {
  for (let p = start; p < end;) {
    const id = ebmlVint(bytes, p, true);
    if (!id) return;
    const size = ebmlVint(bytes, p + id.length, false);
    if (!size) return;
    const dataStart = p + id.length + size.length;
    const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);
    yield { id: id.value, start: dataStart, end: dataEnd };
    p = dataEnd;
  }
}

function sniffMatroska(bytes, dv) {
  for (const top of ebmlElements(bytes, 0, bytes.length)) {
    if (top.id !== 0x18538067) continue; // Segment
    for (const section of ebmlElements(bytes, top.start, top.end)) {
      if (section.id === 0x1f43b675) return null; // Cluster: the tracks come before it
      if (section.id !== 0x1654ae6b) continue; // Tracks
      for (const track of ebmlElements(bytes, section.start, section.end)) {
        if (track.id !== 0xae) continue; // TrackEntry
        let type = 0, codec = "", rate = 8000, outputRate = 0;
        for (const field of ebmlElements(bytes, track.start, track.end)) {
          if (field.id === 0x83) type = bytes[field.start];
          else if (field.id === 0x86) codec = ascii(bytes, field.start, field.end - field.start);
          else if (field.id === 0xe1) {
            for (const audio of ebmlElements(bytes, field.start, field.end)) {
              const value = audio.end - audio.start === 8 ? dv.getFloat64(audio.start) : dv.getFloat32(audio.start);
              if (audio.id === 0xb5) rate = Math.round(value);
              else if (audio.id === 0x78b5) outputRate = Math.round(value);
            }
          }
        }
        if (type !== 2) continue;
        return codec === "A_OPUS" ? 48000 : outputRate || rate;
      }
      return null;
    }
  }
  return null;
}

// The rate a file decodes at, from its header. null when the format is unknown.
export function sniffSampleRate(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 32) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = ascii(bytes, 0, 4);
  try {
    if (tag === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return sniffWav(bytes, dv);
    if (tag === "fLaC") return sniffFlac(bytes);
    if (tag === "OggS") return sniffOgg(bytes, dv);
    if (ascii(bytes, 4, 4) === "ftyp" || ["moov", "mdat", "wide", "free", "skip"].includes(ascii(bytes, 4, 4))) return sniffMp4(bytes, dv);
    if (dv.getUint32(0) === 0x1a45dfa3) return sniffMatroska(bytes, dv);
    return sniffFrames(bytes)?.rate ?? null;
  } catch {
    // A damaged header: let the browser pick the rate.
    return null;
  }
}

// The kind of file, from its header alone: "mp3", "aac", "wav", "flac",
// "ogg", "mp4", "matroska", "aiff", "wma", "ac3" or "unknown". Used to count
// which formats fail to decode; nothing else about the file is read.
export function audioContainer(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 12) return "unknown";
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = ascii(bytes, 0, 4);
  if (tag === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return "wav";
  if (tag === "fLaC") return "flac";
  if (tag === "OggS") return "ogg";
  if (tag === "FORM" && /^AIF[FC]$/.test(ascii(bytes, 8, 4))) return "aiff";
  if (["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(ascii(bytes, 4, 4))) return "mp4";
  if (dv.getUint32(0) === 0x1a45dfa3) return "matroska";
  if (dv.getUint32(0) === 0x3026b275 && dv.getUint32(4) === 0x8e66cf11) return "wma";
  if (bytes[0] === 0x0b && bytes[1] === 0x77) return "ac3";
  try {
    return sniffFrames(bytes)?.kind || "unknown";
  } catch {
    return "unknown";
  }
}

// ---- Formats no browser decodes ----

const UNSUPPORTED_MP4_CODECS = { alac: "alac", "ac-3": "dolby", "ec-3": "dolby" };
// WAV codecs browsers decode: PCM, float, A-law, mu-law, and the extensible header.
const WAV_CODECS = new Set([1, 3, 6, 7, 0xfffe]);

async function blobBytes(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

// The format of a song file that Chrome, Firefox and Safari's decoders all
// refuse, read from its header ("aiff", "alac", "wma", "ac3", "dolby",
// "adpcm"), or
// null. Only small parts of the file are read, so a long video is cheap.
export async function unsupportedAudioFormat(blob) {
  try {
    const head = await blobBytes(blob, 0, 64);
    if (head.length < 12) return null;
    const dv = new DataView(head.buffer);
    const tag = ascii(head, 0, 4);
    if (tag === "FORM" && /^AIF[FC]$/.test(ascii(head, 8, 4))) return "aiff";
    if (dv.getUint32(0) === 0x3026b275 && dv.getUint32(4) === 0x8e66cf11) return "wma"; // ASF header GUID
    if (head[0] === 0x0b && head[1] === 0x77) return "ac3"; // a bare AC-3 / E-AC-3 stream
    if (tag === "RIFF" && ascii(head, 8, 4) === "WAVE") {
      const wav = await blobBytes(blob, 0, 4096);
      const wdv = new DataView(wav.buffer);
      for (let p = 12; p + 10 <= wav.length;) {
        const size = wdv.getUint32(p + 4, true);
        if (ascii(wav, p, 4) === "fmt ") return WAV_CODECS.has(wdv.getUint16(p + 8, true)) ? null : "adpcm";
        p += 8 + size + (size & 1);
      }
      return null;
    }
    if (!["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(ascii(head, 4, 4))) return null;
    // Walk the top-level boxes by their headers alone, then read only moov.
    for (let p = 0; p + 8 <= blob.size;) {
      const header = await blobBytes(blob, p, p + 16);
      const hdv = new DataView(header.buffer);
      let size = hdv.getUint32(0);
      if (size === 1 && header.length >= 16) size = Number(hdv.getBigUint64(8));
      else if (size === 0) size = blob.size - p;
      if (size < 8) return null;
      if (ascii(header, 4, 4) === "moov") {
        if (size > 64 * 1024 * 1024) return null;
        const moov = await blobBytes(blob, p, p + size);
        const mdv = new DataView(moov.buffer);
        const box = boxes(mdv, 0, moov.length).next().value;
        const entry = box && soundTrack(moov, mdv, box)?.entry;
        return (entry && UNSUPPORTED_MP4_CODECS[entry.type]) || null;
      }
      p += size;
    }
    return null;
  } catch {
    return null;
  }
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

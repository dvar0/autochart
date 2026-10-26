// Stem mel tables: the part of a separation the transcriber reads, kept in
// place of the stems (a few MB a song instead of hundreds), so a song is
// separated once. One mel spectrogram (dB) per stem channel, clipped 80 dB
// under the loudest stem and rounded to 1/256 dB. The transcriber clips 80 dB
// under its reference, which is at least as loud as any stem, so the clip
// changes nothing and the rounding leaves charts unchanged. Generation always
// reads the rounded tables, whether they were just made or stored.
//
// File: gzip of [u32 header length][header JSON][u16 values], each mel row
// stored as the difference from the previous frame (mod 2^16).
// Works in Node and the browser.

export const MEL_TABLES_FILE = "mel-tables.bin";
const FORMAT = "autochart-mel-tables";
const VERSION = 1;
const RANGE_DB = 80;
const STEP = 1 / 256;
const DEFAULT_RECIPE = "transcriber-mel-80";

// Names the mel graph's recipe: tables made by one recipe only feed models
// that declare the same one.
export function melRecipe(transcriberStage) {
  return String(transcriberStage?.melRecipe || DEFAULT_RECIPE);
}

// The channels stored: every transcriber channel but the mix, then any
// reference-only mixes.
export function tableChannels(channelOrder, refOnlyMixes = {}) {
  return [...channelOrder.filter((name) => name !== "full"), ...Object.keys(refOnlyMixes || {})];
}

export function tablesMatch(tables, { recipe, channels }) {
  return Boolean(tables) && tables.recipe === recipe && tables.channels.join(",") === channels.join(",");
}

// mels: { [channel]: { mel: Float32Array [nMels * nFrames], nMels, nFrames } }.
// Rounds them in place. samples: the padded channel length they were made from.
export function roundMelTables(mels, { recipe, channels, samples }) {
  let peak = -Infinity;
  for (const name of channels) {
    const { mel } = mels[name];
    for (let i = 0; i < mel.length; i += 1) if (mel[i] > peak) peak = mel[i];
  }
  const floor = peak - RANGE_DB;
  for (const name of channels) {
    const { mel } = mels[name];
    for (let i = 0; i < mel.length; i += 1) {
      const v = mel[i] > floor ? mel[i] : floor;
      mel[i] = floor + Math.round((v - floor) / STEP) * STEP;
    }
  }
  return { recipe, channels: [...channels], samples, peak, mels };
}

async function pipeBytes(bytes, transform) {
  const stream = new Blob([bytes]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodeMelTables(tables) {
  const { recipe, channels, samples, peak, mels } = tables;
  const floor = peak - RANGE_DB;
  const header = new TextEncoder().encode(JSON.stringify({
    format: FORMAT,
    version: VERSION,
    recipe,
    channels,
    samples,
    peak,
    shapes: channels.map((name) => [mels[name].nMels, mels[name].nFrames]),
  }));
  const dataOffset = 4 + header.length + (header.length % 2);
  let count = 0;
  for (const name of channels) count += mels[name].mel.length;
  const bytes = new Uint8Array(dataOffset + count * 2);
  new DataView(bytes.buffer).setUint32(0, header.length, true);
  bytes.set(header, 4);
  const view = new DataView(bytes.buffer, dataOffset);
  let at = 0;
  for (const name of channels) {
    const { mel, nMels, nFrames } = mels[name];
    for (let m = 0; m < nMels; m += 1) {
      let prev = 0;
      for (let t = 0; t < nFrames; t += 1) {
        const q = Math.round((mel[m * nFrames + t] - floor) / STEP);
        view.setUint16(at, (q - prev) & 0xffff, true);
        prev = q;
        at += 2;
      }
    }
  }
  return pipeBytes(bytes, new CompressionStream("gzip"));
}

export async function decodeMelTables(compressed) {
  const bytes = await pipeBytes(compressed, new DecompressionStream("gzip"));
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLength)));
  if (header.format !== FORMAT || header.version !== VERSION) throw new Error("Unknown mel tables format.");
  const floor = header.peak - RANGE_DB;
  const view = new DataView(bytes.buffer, bytes.byteOffset + 4 + headerLength + (headerLength % 2));
  const mels = {};
  let at = 0;
  header.channels.forEach((name, c) => {
    const [nMels, nFrames] = header.shapes[c];
    const mel = new Float32Array(nMels * nFrames);
    for (let m = 0; m < nMels; m += 1) {
      let q = 0;
      for (let t = 0; t < nFrames; t += 1) {
        q = (q + view.getUint16(at, true)) & 0xffff;
        mel[m * nFrames + t] = floor + q * STEP;
        at += 2;
      }
    }
    mels[name] = { mel, nMels, nFrames };
  });
  return { recipe: header.recipe, channels: header.channels, samples: header.samples, peak: header.peak, mels };
}

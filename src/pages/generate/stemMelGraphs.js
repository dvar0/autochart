// The Separation stage's stem graphs: each stem's stored mel table (see
// engine/lib/onnx/melTables.mjs) drawn as a colored spectrogram, plus the mix
// as the stems' summed power (stemTables.js). Every separation keeps its
// tables, so the graphs show even after its stems were deleted.
import { decodeMelTables } from "../../../engine/lib/onnx/melTables.mjs";
import { readEngineCacheFile } from "../../services/generation.js";
import { stemPowers } from "./stemTables.js";

// The tables' frame rate: hop 512 at 22,050 Hz.
export const MEL_FRAME_SECONDS = 512 / 22050;
const RANGE_DB = 60;
const MAX_COLUMNS = 2000;
const CACHE_SIZE = 4;
const cache = new Map();

function rgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Columns of averaged power, in dB, low bands at the bottom row.
function columnsDb(power, nMels, nFrames, width) {
  const out = new Float32Array(nMels * width);
  for (let m = 0; m < nMels; m += 1) {
    const row = m * nFrames;
    for (let x = 0; x < width; x += 1) {
      const a = Math.floor((x * nFrames) / width);
      const b = Math.max(a + 1, Math.floor(((x + 1) * nFrames) / width));
      let p = 0;
      for (let f = a; f < b; f += 1) p += power[row + f];
      out[(nMels - 1 - m) * width + x] = 10 * Math.log10(p / (b - a) + 1e-12);
    }
  }
  return out;
}

// The stem's color fades in with level; the loudest parts lift toward white.
async function paint(db, nMels, width, top, color) {
  const [r, g, b] = rgb(color);
  const canvas = new OffscreenCanvas(width, nMels);
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(width, nMels);
  const px = image.data;
  for (let i = 0; i < db.length; i += 1) {
    const v = Math.max(0, Math.min(1, (db[i] - (top - RANGE_DB)) / RANGE_DB));
    const lift = Math.max(0, (v - 0.78) / 0.22) * 0.5;
    px[4 * i] = r + (255 - r) * lift;
    px[4 * i + 1] = g + (255 - g) * lift;
    px[4 * i + 2] = b + (255 - b) * lift;
    px[4 * i + 3] = Math.min(1, v ** 1.15 * 1.8) * 255;
  }
  ctx.putImageData(image, 0, 0);
  return URL.createObjectURL(await canvas.convertToBlob({ type: "image/png" }));
}

async function build(path, rows, mixColor) {
  const tables = await decodeMelTables(new Uint8Array(await readEngineCacheFile(path)));
  const powers = stemPowers(tables, rows.map((row) => row.id));
  const { nMels, nFrames, mix, stems } = powers;
  const width = Math.min(nFrames, MAX_COLUMNS);
  const images = {};
  for (const row of rows) {
    if (stems[row.id]) images[row.id] = await paint(columnsDb(stems[row.id], nMels, nFrames, width), nMels, width, tables.peak, row.color);
  }
  images.mix = await paint(columnsDb(mix, nMels, nFrames, width), nMels, width, tables.peak + 3, mixColor);
  return { seconds: nFrames * MEL_FRAME_SECONDS, channels: Object.keys(images), images, powers };
}

// rows: the stem set's rows (stemSets.js); one set per tables file.
// Resolves to { seconds, channels, images: { [row id | "mix"]: url }, powers }
// (powers as stemTables.stemPowers returns them, for live playback); a row the
// tables lack (an older separation) has no image.
export function loadStemMelGraphs(path, rows, mixColor) {
  if (!cache.has(path)) {
    const pending = build(path, rows, mixColor);
    pending.catch(() => cache.delete(path));
    cache.set(path, pending);
    while (cache.size > CACHE_SIZE) {
      const [oldPath, old] = cache.entries().next().value;
      cache.delete(oldPath);
      old.then((graphs) => Object.values(graphs.images).forEach((url) => URL.revokeObjectURL(url)), () => {});
    }
  }
  return cache.get(path);
}

// Each stem's loudness over the song in `columns` steps, 0..1 against the
// loudest stem (RANGE_DB below it is 0), for a separation card's small lanes.
// Resolves to { [row id]: Float32Array }; a row the tables lack is missing.
const LEVEL_RANGE_DB = 42;
const levelCache = new Map();
async function buildLevels(path, rowIds, columns) {
  const tables = await decodeMelTables(new Uint8Array(await readEngineCacheFile(path)));
  const { nMels, nFrames, stems } = stemPowers(tables, rowIds);
  const out = {};
  let top = -Infinity;
  for (const id of rowIds) {
    const power = stems[id];
    if (!power) continue;
    const db = new Float32Array(columns);
    for (let x = 0; x < columns; x += 1) {
      const a = Math.floor((x * nFrames) / columns);
      const b = Math.max(a + 1, Math.floor(((x + 1) * nFrames) / columns));
      let sum = 0;
      for (let m = 0; m < nMels; m += 1) {
        const row = m * nFrames;
        for (let f = a; f < b; f += 1) sum += power[row + f];
      }
      db[x] = 10 * Math.log10(sum / (b - a) + 1e-12);
      if (db[x] > top) top = db[x];
    }
    out[id] = db;
  }
  for (const db of Object.values(out)) {
    for (let x = 0; x < columns; x += 1) db[x] = Math.max(0, Math.min(1, (db[x] - (top - LEVEL_RANGE_DB)) / LEVEL_RANGE_DB));
  }
  return out;
}

export function loadStemLevels(path, rowIds, columns = 64) {
  const key = `${path}|${rowIds.join(",")}|${columns}`;
  if (!levelCache.has(key)) {
    const pending = buildLevels(path, rowIds, columns);
    pending.catch(() => levelCache.delete(key));
    levelCache.set(key, pending);
    while (levelCache.size > 24) levelCache.delete(levelCache.keys().next().value);
  }
  return levelCache.get(key);
}

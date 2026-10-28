// Clone Hero / YARG export for the browser version: the same song folder the
// desktop app writes (notes.chart, song.ini, audio, art), downloaded as one
// .sng (or a .zip, per Settings) or, where the browser can write to folders,
// saved straight into one.
// There is no FFmpeg here, so audio the games can't read is written as WAV and
// media is copied as-is instead of converted.

import { exportChartMetadata } from "../../shared/chartProvenance.js";
import { decodeAudioFile } from "../../engine/web/audio.mjs";
import { loadMelTables } from "../../engine/web/stemStore.mjs";
import {
  audioLeadInMs, buildProjectFile, delayChart, exportableTables, PROJECT_FILE, tablesFileName, versionLeadInMs,
} from "../../shared/projectFile.js";
import { buildSng, iniToSngMetadata } from "../../shared/sng.js";
import { exportCover } from "../lib/coverArt/exportCover.js";
import { getAppSettings } from "../services/appSettings.js";
import { getSongRecord } from "../services/songLibrary.js";

const GAME_AUDIO = new Set(["ogg", "mp3", "opus", "wav"]);
const LITE_GENERATOR_ID = "autochart.fretformer.v2-lite-onnx";
const VIDEO = new Set(["webm", "mp4"]);

function extOf(name = "", mime = "") {
  const fromName = /\.([a-z0-9]+)$/i.exec(String(name))?.[1]?.toLowerCase();
  if (fromName && fromName !== "bin") return fromName;
  const sub = String(mime).split("/")[1] || "";
  return { mpeg: "mp3", "x-wav": "wav", wave: "wav", jpeg: "jpg", "x-flac": "flac" }[sub] || sub.split(";")[0];
}

function safeFolderName(value) {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").slice(0, 120) || "song";
}

export function cloneHeroFolderName(meta = {}, { copy = false } = {}) {
  const title = String(meta.title || "song").trim();
  const artist = String(meta.artist || "").trim();
  const base = artist && title ? `${artist} - ${title}` : title;
  return safeFolderName(copy ? `${base} (Autochart)` : base);
}

// Lite charts say so in the loading phrase, so they aren't taken for
// Fretformer 2's.
function generatedWith(meta) {
  const generators = String(meta.autochart_generator || "").split(",");
  return generators.includes(LITE_GENERATOR_ID) ? "Generated with Autochart (Fretformer 2 Lite)." : "Generated with Autochart.";
}

// Same fields and rules as the desktop export (electron/libraryStore.cjs buildSongIni).
function buildSongIni(meta, resources = {}) {
  const lines = ["[song]"];
  const iniValue = (value) => String(value ?? "").replace(/\r\n?|[\n\u2028\u2029]/g, " ").trim();
  const fields = [
    ["name", iniValue(meta.title) || "Untitled"],
    ["artist", meta.artist],
    ["album", meta.album],
    ["year", meta.year],
    ["genre", meta.genre],
    ["charter", meta.charter],
    ["autochart_provenance_version", meta.autochart_provenance_version],
    ["autochart_ai_generated", meta.autochart_ai_generated],
    ["autochart_generated_difficulties", meta.autochart_generated_difficulties],
    ["autochart_generator", meta.autochart_generator],
    ["loading_phrase", meta.autochart_ai_generated === "true"
      ? `Contains AI-generated guitar difficulties: ${meta.autochart_generated_difficulties}. ${generatedWith(meta)}`
      : ""],
    ["song_length", meta.durationSec ? Math.round(meta.durationSec * 1000) : ""],
    ["background", resources.background || ""],
    ["video", resources.video || ""],
    ["video_start_time", resources.video ? resources.videoStartTime ?? 0 : ""],
  ];
  for (const [key, val] of fields) {
    const value = iniValue(val);
    if (value) lines.push(`${key} = ${value}`);
  }
  return lines.join("\n") + "\n";
}

function wavFromDecoded({ left, right, sampleRate }) {
  const frames = left.length;
  const buffer = new ArrayBuffer(44 + frames * 4);
  const view = new DataView(buffer);
  const text = (at, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + frames * 4, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, frames * 4, true);
  const pcm = new Int16Array(buffer, 44, frames * 2);
  for (let i = 0; i < frames; i += 1) {
    pcm[2 * i] = Math.max(-1, Math.min(1, left[i])) * 0x7fff;
    pcm[2 * i + 1] = Math.max(-1, Math.min(1, right[i])) * 0x7fff;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

// Lead-in silence goes in front of the song's own audio, so the padded copy a
// run stored in this browser isn't needed (it may have been cleared).
function withLeadIn({ left, right, sampleRate }, leadInMs) {
  const pad = Math.round((leadInMs / 1000) * sampleRate);
  const padded = (channel) => {
    const out = new Float32Array(pad + channel.length);
    out.set(channel, pad);
    return out;
  };
  return { left: padded(left), right: right === left ? padded(left) : padded(right), sampleRate };
}

async function songAudio(record, leadInMs) {
  const blob = record._blobs?.audio;
  if (!blob) throw new Error("Add song audio before exporting to Clone Hero / YARG.");
  const ext = extOf(record.assets?.audio || blob.name, blob.type);
  if (!leadInMs && GAME_AUDIO.has(ext)) return { name: `song.${ext}`, data: blob };
  const decoded = await decodeAudioFile(await blob.arrayBuffer());
  return { name: "song.wav", data: wavFromDecoded(leadInMs ? withLeadIn(decoded, leadInMs) : decoded) };
}

// The files of a song's Clone Hero folder for one chart version.
export async function cloneHeroFiles(songId, versionId = null) {
  const record = await getSongRecord(songId);
  if (!record) throw new Error("Project not found in library.");
  const versions = Array.isArray(record.versions) ? record.versions : [];
  const requested = versionId ? versions.find((v) => v.id === versionId) : null;
  const active = versions.find((v) => v.id === record.settings?.activeVersionId);
  const version = requested || active || versions.find((v) => v.chart?.text) || null;
  const chartText = version?.chart?.text || record.chart?.text || "";
  if (!chartText) throw new Error("Selected chart version has no notes.chart data.");
  const exported = exportChartMetadata(version || { ...record, chart: { text: chartText } }, record.meta, versions);
  const versionMeta = version?.meta || {};
  // The audio holds the longest lead-in any take was charted with, so the
  // project file can bring every take back; this take moves later by the rest.
  const takeLeadInMs = versionLeadInMs(version);
  const leadInMs = audioLeadInMs(record, version);
  const exportedChartText = delayChart(exported.chartText, leadInMs - takeLeadInMs).chartText;

  const files = [{ name: "notes.chart", data: new Blob([exportedChartText], { type: "text/plain" }) }];
  files.push(await songAudio(record, leadInMs));
  // Square art for the games: wide covers cropped, missing ones generated.
  const album = record._blobs?.albumArt;
  const cover = await exportCover(album, record.meta).catch(() => null);
  if (cover) {
    files.push({ name: cover.name, data: cover.blob });
  } else if (album) {
    const ext = extOf(record.assets?.albumArt || album.name, album.type);
    files.push({ name: /^(jpe?g|webp|gif)$/.test(ext) ? "album.jpg" : "album.png", data: album });
  }
  const resources = {};
  const bg = record._blobs?.background;
  const bgBlob = bg?.blob || bg;
  if (bgBlob instanceof Blob) {
    const type = bg.type === "video" || String(bgBlob.type).startsWith("video/") ? "video" : "image";
    const ext = extOf(record.assets?.background?.file || bgBlob.name, bgBlob.type);
    if (type === "video" && VIDEO.has(ext)) {
      resources.video = `video.${ext}`;
      // The exported audio has the lead-in silence; the video doesn't.
      resources.videoStartTime = leadInMs > 0 ? -leadInMs : 0;
      files.push({ name: resources.video, data: bgBlob });
    } else if (type === "image") {
      resources.background = /^(jpe?g|webp|gif)$/.test(ext) ? "background.jpg" : "background.png";
      files.push({ name: resources.background, data: bgBlob });
    }
  }
  const durationSec = Number(versionMeta.durationSec) > 0
    ? Number(versionMeta.durationSec) + (leadInMs - takeLeadInMs) / 1000
    : Number(record.meta?.durationSec || 0) + leadInMs / 1000;
  files.push({ name: "song.ini", data: new Blob([buildSongIni({ ...exported.meta, durationSec }, resources)], { type: "text/plain" }) });
  // The project, and its separation as mel tables, so opening the folder
  // brings every take back without separating the song again.
  const stemSets = [];
  for (const { stemSet, path } of exportableTables(record, version)) {
    const bytes = path.startsWith("opfs:") ? await loadMelTables(path.slice("opfs:".length)) : null;
    if (!bytes) continue;
    stemSets.push(stemSet);
    files.push({ name: tablesFileName(stemSet), data: new Blob([bytes], { type: "application/octet-stream" }) });
  }
  const projectJson = await buildProjectFile(record, { version, chartText: exportedChartText, stemSets });
  files.push({ name: PROJECT_FILE, data: new Blob([projectJson], { type: "application/json" }) });
  return { record, versionId: version?.id || null, files };
}

// ----- a store-only zip (the media is already compressed) -----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function zipBlob(folder, files) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const file of files) {
    const name = encoder.encode(`${folder}/${file.name}`);
    const data = new Uint8Array(await file.data.arrayBuffer());
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(local.buffer, name, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(12, dosTime, true);
    entry.setUint16(14, dosDate, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(entry.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// The folder as one .sng: song.ini becomes its metadata, the rest its files.
async function sngBlob(files) {
  const ini = files.find((file) => file.name === "song.ini");
  const packed = [];
  for (const file of files) {
    if (file !== ini) packed.push({ name: file.name, bytes: new Uint8Array(await file.data.arrayBuffer()) });
  }
  return new Blob(buildSng(iniToSngMetadata(ini ? await ini.data.text() : ""), packed), { type: "application/octet-stream" });
}

// Export: one .sng to drop into the songs folder, or a .zip of the folder
// (Settings > Export as).
export async function downloadCloneHeroSong(songId, versionId = null) {
  const { record, versionId: exportedId, files } = await cloneHeroFiles(songId, versionId);
  const folder = cloneHeroFolderName(record.meta);
  const zip = (await getAppSettings().catch(() => ({}))).exportFormat === "zip";
  const name = `${folder}.${zip ? "zip" : "sng"}`;
  download(zip ? await zipBlob(folder, files) : await sngBlob(files), name);
  return {
    path: name,
    format: "clone-hero",
    songId,
    versionId: exportedId,
    message: zip
      ? `Downloaded ${name}. Unzip it into your Clone Hero or YARG songs folder.`
      : `Downloaded ${name}. Put it in your Clone Hero or YARG songs folder.`,
  };
}

// ----- saving into the game's songs folder (Chrome and Edge) -----

export function canSaveToFolder() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

const HANDLE_DB = "autochart-web";
const HANDLE_STORE = "handles";

function handleDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(HANDLE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(HANDLE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storedHandle(op, value) {
  const db = await handleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, op === "get" ? "readonly" : "readwrite");
    const store = tx.objectStore(HANDLE_STORE);
    const request = op === "get" ? store.get("songsFolder") : store.put(value, "songsFolder");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// The songs folder picked before (asking again for write access), or a new pick.
async function songsFolder({ pick = false } = {}) {
  let handle = pick ? null : await storedHandle("get").catch(() => null);
  if (handle) {
    const permission = await handle.requestPermission({ mode: "readwrite" }).catch(() => "denied");
    if (permission !== "granted") handle = null;
  }
  if (!handle) {
    handle = await window.showDirectoryPicker({ id: "clone-hero-songs", mode: "readwrite" });
    await storedHandle("put", handle).catch(() => {});
  }
  return handle;
}

export async function songsFolderName() {
  const handle = await storedHandle("get").catch(() => null);
  return handle?.name || "";
}

export async function chooseSongsFolder() {
  const handle = await songsFolder({ pick: true });
  return handle.name;
}

export async function saveToSongsFolder(songId, versionId = null) {
  if (!canSaveToFolder()) throw new Error("This browser can't save into folders. Use Export to download the song instead.");
  const { record, versionId: exportedId, files } = await cloneHeroFiles(songId, versionId);
  let root;
  try {
    root = await songsFolder();
  } catch (err) {
    if (err?.name === "AbortError") return { canceled: true, message: "Save canceled." };
    throw err;
  }
  const folder = cloneHeroFolderName(record.meta, { copy: true });
  const dir = await root.getDirectoryHandle(folder, { create: true });
  for (const file of files) {
    const handle = await dir.getFileHandle(file.name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(file.data);
    await writable.close();
  }
  return {
    path: `${root.name}/${folder}`,
    format: "clone-hero",
    songId,
    versionId: exportedId,
    message: `Saved to ${root.name}/${folder}`,
  };
}

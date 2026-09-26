import { chartSongMetadata, provenanceFromMetadata } from "../../shared/chartProvenance.js";
// Imports a Clone Hero song from a picked folder (a <input webkitdirectory>
// FileList). Browser mode persists Blobs in IndexedDB; Electron keeps selected
// media path-backed until the main process copies it into project storage.

import { parseChart } from "../lib/chart/parseChart.js";
import { buildPlayableTrack } from "../lib/chart/tempoMap.js";
import { readMediaFileMetadata } from "./mediaMetadata.js";

const AUDIO_EXTS = [".ogg", ".opus", ".mp3", ".wav", ".wave", ".flac", ".m4a", ".aac", ".aiff", ".aif"];
const ART_STEMS = ["album", "albumart", "artwork", "cover", "coverart", "folder", "front"];
const BACKGROUND_STEMS = ["background", "bg", "stage", "venue"];
const VIDEO_STEMS = ["background", "bg", "video"];
const VIDEO_EXTS = [".mp4", ".webm", ".ogv"];
const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

function basename(file) {
  // webkitRelativePath is like "SongFolder/notes.chart".
  const path = file.webkitRelativePath || file.name;
  return path.split("/").pop().toLowerCase();
}

function extname(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot);
}

function compactStem(name) {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  return stem.replace(/[\s_.-]+/g, "");
}

function hasExt(name, exts) {
  return exts.some((e) => name.endsWith(e));
}

function namedLike(name, stems, exts) {
  if (!hasExt(name, exts)) return false;
  const stem = compactStem(name);
  return stems.some((s) => stem === s || stem.startsWith(s));
}

// Minimal song.ini parser — just the [song] section key/values we care about.
function parseSongIni(text) {
  const meta = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("[") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    meta[line.slice(0, eq).trim().toLowerCase()] = line.slice(eq + 1).trim();
  }
  return meta;
}

// Extracts the playable pieces from a picked folder.
// Persistence stays path-backed in Electron. Playback bytes are loaded once,
// after the project is saved, by recordToImported().
export async function importSongFolder(fileList, { difficulty = "expert" } = {}) {
  const files = Array.from(fileList);
  const warnings = [];

  const find = (pred) => files.find((f) => pred(basename(f)));

  const chartFile = find((n) => n === "notes.chart");
  const midFile = find((n) => n === "notes.mid" || n === "notes.midi");
  const iniFile = find((n) => n === "song.ini");
  const audioFile =
    find((n) => n === "song.ogg") ||
    find((n) => AUDIO_EXTS.some((e) => n.endsWith(e)));
  const artFile = find((n) => namedLike(n, ART_STEMS, IMAGE_EXTS));

  // Background: Clone Hero songs may ship a video (video.mp4 / video.webm)
  // or a still image (background.png / bg.jpg). Video wins if both exist.
  const bgVideoFile = find((n) => namedLike(n, VIDEO_STEMS, VIDEO_EXTS));
  const bgImageFile = find((n) => namedLike(n, BACKGROUND_STEMS, IMAGE_EXTS));

  if (!chartFile) {
    if (midFile) {
      throw new Error(
        "This song only ships notes.mid. MIDI import isn't wired up yet. .chart only for now."
      );
    }
    throw new Error("No notes.chart found in the selected folder.");
  }
  if (!audioFile) throw new Error("No audio file found in the selected folder.");

  const ini = iniFile ? parseSongIni(await iniFile.text()) : {};
  const chartText = await chartFile.text();
  const chart = parseChart(chartText);

  // Pick the requested difficulty, else the hardest available.
  const available = Object.keys(chart.tracks);
  let chosen = difficulty;
  if (!chart.tracks[chosen]) {
    const order = ["expert", "hard", "medium", "easy"];
    chosen = order.find((d) => chart.tracks[d]) || available[0];
    if (chosen) {
      warnings.push(`Difficulty "${difficulty}" missing; using "${chosen}".`);
    }
  }
  const track = buildPlayableTrack(chart, chosen);

  const mediaInfo = await readMediaFileMetadata(audioFile);
  const albumBlob = artFile || mediaInfo.albumBlob || null;
  if (!albumBlob) warnings.push("No album art found.");

  let background = null;
  if (bgVideoFile) {
    background = { type: "video" };
  } else if (bgImageFile) {
    background = { type: "image" };
  }

  const durationSec = track.notes.length
    ? track.notes[track.notes.length - 1].endTime
    : 0;

  const meta = {
    title: ini.name || chart.song.name || mediaInfo.meta.title || "Unknown",
    artist: ini.artist || chart.song.artist || mediaInfo.meta.artist || "Unknown",
    album: ini.album || mediaInfo.meta.album || "",
    year: ini.year || mediaInfo.meta.year || "",
    genre: ini.genre || chart.song.genre || mediaInfo.meta.genre || "",
    chartProvenance: provenanceFromMetadata({ ...chartSongMetadata(chartText), ...ini }, chartText),
    charter: ini.charter || chart.song.charter || "",
    difficulty: chosen,
    availableDifficulties: available,
    noteCount: track.notes.length,
    durationSec,
  };

  return {
    track,
    meta,
    audioBuffer: null,
    background,
    warnings,
    // Raw, structured-cloneable pieces for persisting to the song library.
    // (File objects are Blobs, so they store directly in IndexedDB.)
    chartText,
    audioBlob: audioFile,
    albumBlob,
    backgroundBlob: bgVideoFile || bgImageFile || null,
  };
}

import { chartSongMetadata, provenanceFromMetadata } from "../../shared/chartProvenance.js";
import {
  PROJECT_FILE, parseProjectFile, restoreProject, restoredSeparation, stemSetOfTablesFile,
} from "../../shared/projectFile.js";
// Imports a Clone Hero song from a picked folder (a <input webkitdirectory>
// FileList). Browser mode persists Blobs in IndexedDB; Electron keeps selected
// media path-backed until the main process copies it into project storage.

import { parseChart } from "../lib/chart/parseChart.js";
import { buildPlayableTrack } from "../lib/chart/tempoMap.js";
import { isVideoMedia, readMediaFileMetadata } from "./mediaMetadata.js";
import { buildSourceReplacementRecord } from "../pages/generate/sourceReplacement.js";
import { seedSeparation } from "./generation.js";
import { getStoredAssetSource, recordFromImport, saveSongRecord, updateSongRecord } from "./songLibrary.js";

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

  // An Autochart export carries its project: every take comes back.
  let restore = null;
  const projectFile = find((n) => n === PROJECT_FILE);
  if (projectFile) {
    const file = parseProjectFile(await projectFile.text());
    if (file) {
      restore = await restoreProject(file, chartText);
      restore.tables = files
        .map((f) => ({ stemSet: stemSetOfTablesFile(basename(f)), file: f }))
        .filter(({ stemSet }) => stemSet && file.tables?.[stemSet]);
      if (restore.dropped) {
        warnings.push(`${restore.dropped} take${restore.dropped === 1 ? " was" : "s were"} made with more lead-in than this export's audio holds and couldn't be brought back. Exports from this version keep every take.`);
      }
    } else {
      warnings.push(`${PROJECT_FILE} couldn't be read, so only the chart was opened.`);
    }
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
    restore,
    // Raw, structured-cloneable pieces for persisting to the song library.
    // (File objects are Blobs, so they store directly in IndexedDB.)
    chartText,
    audioBlob: audioFile,
    albumBlob,
    backgroundBlob: bgVideoFile || bgImageFile || null,
  };
}

// Saves an imported folder as a project. A restored Autochart project also
// gets its separation back from the mel tables it carried; without them (or
// when they don't fit the models here) the song separates on its next run.
export async function saveImportedSong(result) {
  const saved = await saveSongRecord(recordFromImport(result));
  const tables = result.restore?.tables || [];
  if (!tables.length) return saved;
  try {
    const separation = await seedSeparation({
      audioFile: result.audioBlob,
      audioSource: await getStoredAssetSource(saved.id, saved.assets?.audio),
      tables: await Promise.all(tables.map(async ({ stemSet, file }) => ({
        stemSet,
        bytes: new Uint8Array(await file.arrayBuffer()),
      }))),
    });
    if (separation && Object.keys(separation.stemSets || {}).length) {
      return await updateSongRecord(saved.id, { sourceArtifacts: { demucs: restoredSeparation(separation) } });
    }
  } catch {
    /* separates on the next run */
  }
  return saved;
}

// Saves a song's audio or video as a project with no chart yet, ready to
// generate from the Library.
export async function saveMediaSong(file) {
  const mediaInfo = await readMediaFileMetadata(file, { skipVideoThumbnail: true });
  return saveSongRecord(buildSourceReplacementRecord({
    file,
    mediaInfo,
    backgroundType: isVideoMedia(file) ? "video" : null,
  }));
}

// Imports songs (from droppedItems.js: song folders, or { name, file } for a
// loose audio or video file) one at a time, saving each as it lands, so a
// stopped or failed run keeps what it finished. Returns the saved projects'
// ids and titles and why any song failed. onImported also gets the song it
// came from.
export async function importSongFolders(folders, { onProgress, onImported, shouldStop } = {}) {
  const imported = [];
  const failed = [];
  for (const [index, folder] of folders.entries()) {
    if (shouldStop?.()) break;
    onProgress?.({ done: index, total: folders.length, name: folder.name });
    try {
      const saved = folder.file
        ? await saveMediaSong(folder.file)
        : await saveImportedSong(await importSongFolder(folder.files));
      const project = { id: saved.id, title: saved.meta?.title || folder.name };
      imported.push(project);
      onImported?.(project, folder, saved);
    } catch (error) {
      failed.push({ name: folder.name || "Song", message: error?.message || String(error) });
    }
  }
  return { imported, failed, stopped: imported.length + failed.length < folders.length };
}

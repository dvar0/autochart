// Song library: Electron filesystem (userData) when available, IndexedDB fallback.

import { parseChart } from "../lib/chart/parseChart.js";
import { buildPlayableTrack } from "../lib/chart/tempoMap.js";
import { coverArtSeed } from "../lib/coverArt/render.js";
import {
  createSongFromImport,
  mergeSongRecord,
  migrateRecord,
  stripBlobs,
} from "./songSchema.js";
import {
  electronFiles,
  electronLibrary,
  hasElectronLibrary as bridgeHasElectronLibrary,
  isWebApp,
} from "./runtimeBridge.js";

const DB_NAME = "autochart";
const DB_VERSION = 2;
const STORE = "songs";
const INLINE_ASSET_LIMITS = {
  audio: 32 * 1024 * 1024,
  albumArt: 24 * 1024 * 1024,
  "background-image": 32 * 1024 * 1024,
  "background-video": 64 * 1024 * 1024,
};

function hasElectronLibrary() {
  return bridgeHasElectronLibrary();
}

async function blobToPayload(blob, fallbackName, fallbackMime, role) {
  if (!blob) return null;
  const capability = await electronFiles()?.registerLibraryAsset?.(blob, role);
  if (capability?.token) {
    return {
      name: blob.name || fallbackName,
      mime: blob.type || fallbackMime,
      source: { kind: "selected-file", token: capability.token },
    };
  }
  const limit = INLINE_ASSET_LIMITS[role];
  const size = Number(blob.size);
  if (!Number.isFinite(size) || size < 0 || size > limit) {
    throw new Error(
      `${role} media must be selected from disk or be smaller than ${Math.floor(limit / 1024 / 1024)} MB.`
    );
  }
  const buf = await blob.arrayBuffer();
  return {
    name: blob.name || fallbackName,
    mime: blob.type || fallbackMime,
    data: buf,
  };
}

function mimeFromFile(fileName, fallback = "application/octet-stream") {
  const name = String(fileName || "").toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".mp3")) return "audio/mpeg";
  if (name.endsWith(".flac")) return "audio/flac";
  if (name.endsWith(".m4a")) return "audio/mp4";
  if (name.endsWith(".aac")) return "audio/aac";
  if (name.endsWith(".wav") || name.endsWith(".wave")) return "audio/wav";
  if (name.endsWith(".opus")) return "audio/opus";
  if (name.endsWith(".ogg") || name.endsWith(".oga")) return "audio/ogg";
  if (name.endsWith(".mp4")) return "video/mp4";
  if (name.endsWith(".webm")) return "video/webm";
  if (name.endsWith(".ogv")) return "video/ogg";
  return fallback;
}

async function prepareElectronPayload(record) {
  const blobs = record._blobs || {};
  const manifest = stripBlobs(migrateRecord(record));
  const bgBlob = blobs.background?.blob || blobs.background;
  const bgType = blobs.background?.type || record.assets?.background?.type || "image";

  return {
    record: manifest,
    assets: {
      audio: await blobToPayload(blobs.audio, "song.ogg", "audio/ogg", "audio"),
      albumArt: await blobToPayload(
        blobs.albumArt,
        "album.png",
        "image/png",
        "albumArt"
      ),
      background: bgBlob
        ? {
            ...(await blobToPayload(
              bgBlob,
              bgType === "video" ? "background.mp4" : "background.png",
              bgType === "video" ? "video/mp4" : "image/png",
              bgType === "video" ? "background-video" : "background-image"
            )),
            type: bgType,
          }
        : null,
    },
  };
}

// --- IndexedDB fallback ---

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function withStore(mode, op) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const store = db.transaction(STORE, mode).objectStore(STORE);
        const req = op(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }).finally(() => db.close())
  );
}

// The browser version keeps nothing between visits: its projects live in this
// tab's memory, copied in and out like IndexedDB rows. (Firefox also can't
// read an IndexedDB-backed audio blob again once its record is rewritten.)
const memoryRows = new Map();
// Saves since the last export, per project, so leaving the page can warn
// about charts that would be lost. A project's first save is its baseline.
const memoryRevisions = new Map();

function memoryStore(op) {
  const store = {
    put: (row) => {
      memoryRows.set(row.id, structuredClone(row));
      const revision = memoryRevisions.get(row.id);
      if (revision) revision.saved += 1;
      else memoryRevisions.set(row.id, { saved: 0, exported: 0 });
      return row.id;
    },
    get: (id) => (memoryRows.has(id) ? structuredClone(memoryRows.get(id)) : undefined),
    getAll: () => [...memoryRows.values()].map((row) => structuredClone(row)),
    delete: (id) => { memoryRows.delete(id); memoryRevisions.delete(id); },
  };
  return Promise.resolve().then(() => op(store));
}

/** Browser version: whether any open project changed since it was last exported. */
export function hasUnexportedWork() {
  return [...memoryRevisions.values()].some((revision) => revision.saved > revision.exported);
}

/** Browser version: the project's chart was just exported as it stands. */
export function markProjectExported(id) {
  const revision = memoryRevisions.get(id);
  if (revision) revision.exported = revision.saved;
}

/** Browser version: drop a project that was closed for another song. */
export function forgetProject(id) {
  memoryRows.delete(id);
  memoryRevisions.delete(id);
}

function rowStore(mode, op) {
  return isWebApp() ? memoryStore(op) : withStore(mode, op);
}

function idbPut(record) {
  const migrated = migrateRecord(record);
  const toStore = stripBlobs(migrated);
  if (migrated._blobs) {
    toStore._idbBlobs = migrated._blobs;
  } else if (record._idbBlobs) {
    toStore._idbBlobs = record._idbBlobs;
  }
  return rowStore("readwrite", (s) => s.put(toStore));
}

function idbGetAll() {
  return rowStore("readonly", (s) => s.getAll()).then((rows) =>
    (rows || []).map((row) => {
      const rec = migrateRecord(row);
      if (row._idbBlobs) rec._blobs = row._idbBlobs;
      return rec;
    })
  );
}

function idbGet(id) {
  return rowStore("readonly", (s) => s.get(id)).then((row) => {
    if (!row) return null;
    const rec = migrateRecord(row);
    if (row._idbBlobs) rec._blobs = row._idbBlobs;
    return rec;
  });
}

function idbDelete(id) {
  return rowStore("readwrite", (s) => s.delete(id));
}

// --- Public API ---

export function recordFromImport(result) {
  return createSongFromImport(result);
}

export async function saveSongRecord(record) {
  const migrated = migrateRecord(record);
  if (hasElectronLibrary()) {
    let toSave = migrated;
    if (migrated.id && !migrated._blobs?.audio) {
      try {
        const existing = await electronLibrary().getSong(migrated.id);
        if (existing) toSave = mergeSongRecord(existing, migrated);
      } catch {
        /* new */
      }
    }
    const payload = await prepareElectronPayload(toSave);
    const saved = await electronLibrary().saveSong(payload);
    return migrateRecord(saved);
  }
  await idbPut(migrated);
  return migrated;
}

export async function getAllSongRecords() {
  if (hasElectronLibrary()) {
    const rows = await electronLibrary().listSongs();
    return rows.map((r) => migrateRecord(r));
  }
  return idbGetAll();
}

/** Browser-only IndexedDB library; false in Electron. */
export async function browserHasLocalSongRecords() {
  if (hasElectronLibrary()) return false;
  const rows = await idbGetAll();
  return rows.length > 0;
}

export async function getSongRecord(id) {
  if (hasElectronLibrary()) {
    const row = await electronLibrary().getSong(id);
    return row ? migrateRecord(row) : null;
  }
  return idbGet(id);
}
export async function getStoredAssetSource(id, fileName) {
  if (!hasElectronLibrary() || !electronLibrary()?.getAssetSource) return null;
  if (!id || !fileName) return null;
  const source = await electronLibrary().getAssetSource(id, fileName);
  return {
    ...source,
    mime: source?.mime || mimeFromFile(source?.name || fileName),
  };
}

async function getElectronAssetUrl(id, fileName) {
  if (!id || !fileName) return null;
  return electronLibrary().getAssetUrl(id, fileName);
}

export async function getProjectDeletionDetails(id) {
  if (hasElectronLibrary()) {
    return electronLibrary().getProjectDeletionDetails(id);
  }
  const record = await idbGet(id);
  if (!record) throw new Error("Project not found in browser storage.");
  return {
    id,
    title: String(record.meta?.title || id),
    path: `IndexedDB / ${DB_NAME} / ${STORE} / ${id}`,
    disposition: "delete",
  };
}

export async function deleteProjectRecord(id, expectedPath, expectedTitle) {
  if (hasElectronLibrary()) {
    return electronLibrary().trashProject({ id, expectedPath, expectedTitle });
  }
  const details = await getProjectDeletionDetails(id);
  if (
    !expectedPath ||
    expectedPath !== details.path ||
    expectedTitle !== details.title
  ) {
    throw new Error("The confirmed project details no longer match the project being deleted.");
  }
  await idbDelete(id);
  return { ok: true, path: details.path, disposition: "delete" };
}

/**
 * Merge patches into an existing record and persist.
 * @param {string} id
 * @param {object} patch - meta, settings, chart, assets, _blobs
 */
export async function updateSongRecord(id, patch) {
  if (hasElectronLibrary() && electronLibrary().patchSong) {
    const payload = await prepareElectronPayload({ ...patch, id });
    // Send only the requested fields. Sending a stale whole record for a
    // favorite toggle can overwrite a take committed by background generation.
    payload.record = { ...stripBlobs(patch), id };
    return migrateRecord(await electronLibrary().patchSong(payload));
  }
  const existing = await getSongRecord(id);
  if (!existing) throw new Error("Project not found in library storage.");
  const merged = mergeSongRecord(existing, patch);
  return saveSongRecord(merged);
}

export async function setSongFavorite(id, favorite) {
  const next = Boolean(favorite);
  return updateSongRecord(id, { meta: { favorite: next } });
}

// --- UI helpers ---

function fmtDuration(sec) {
  if (!sec || !isFinite(sec)) return "-";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

const assetUrlCache = new Map();

function cacheKey(id, kind, fileName = "") {
  return `${id}:${kind}:${fileName}`;
}

function assetCacheKey(rec, kind, fileName = "") {
  return cacheKey(rec.id, kind, `${fileName}:${rec.updatedAt || rec.createdAt || ""}`);
}

function cachedObjectUrl(key, blobParts, mime) {
  if (assetUrlCache.has(key)) return assetUrlCache.get(key);
  const url = URL.createObjectURL(new Blob(blobParts, { type: mime }));
  assetUrlCache.set(key, url);
  return url;
}

export function revokeCoverUrl(id) {
  for (const [key, url] of assetUrlCache) {
    if (!key.startsWith(`${id}:`)) continue;
    if (String(url).startsWith("blob:")) URL.revokeObjectURL(url);
    assetUrlCache.delete(key);
  }
}

async function resolveCoverUrl(rec) {
  if (hasElectronLibrary() && rec.assets?.albumArt) {
    const key = assetCacheKey(rec, "cover", rec.assets.albumArt);
    if (assetUrlCache.has(key)) return assetUrlCache.get(key);
    const url = await getElectronAssetUrl(rec.id, rec.assets.albumArt);
    assetUrlCache.set(key, url);
    return url;
  }
  const blob = rec._blobs?.albumArt || rec._idbBlobs?.albumArt;
  if (!blob) return null;
  const key = assetCacheKey(rec, "cover", "idb");
  return cachedObjectUrl(key, [blob], blob.type || "image/png");
}

export async function recordToCard(rec) {
  const r = migrateRecord(rec);
  const m = r.meta || {};
  const s = r.settings || {};
  return {
    id: r.id,
    title: m.title || "Untitled",
    artist: m.artist || "Unknown",
    album: m.album || "",
    year: m.year || "",
    genre: m.genre || "",
    charter: m.charter || "Imported",
    duration: fmtDuration(m.durationSec),
    added: new Date(r.createdAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    status: r.status || "charted",
    fav: Boolean(r.meta?.favorite),
    diff: s.difficulty || "expert",
    style: s.style || "default",
    artSeed: coverArtSeed(m.title, m.artist),
    cover: await resolveCoverUrl(r),
    imported: true,
    source: r.source,
  };
}

// The song's own album art as a Blob, or null when it has none.
export async function loadCoverBlob(rec) {
  if (hasElectronLibrary() && rec.assets?.albumArt) {
    const url = await getElectronAssetUrl(rec.id, rec.assets.albumArt);
    const response = await fetch(url);
    if (!response.ok) throw new Error("Album art could not be loaded.");
    return response.blob();
  }
  return rec._blobs?.albumArt || rec._idbBlobs?.albumArt || null;
}

async function loadAudioBuffer(rec) {
  if (hasElectronLibrary() && rec.assets?.audio) {
    // GameEngine currently uses WebAudio decodeAudioData, so playback still
    // needs one complete ArrayBuffer. The main-process media policy caps saved
    // audio at 512 MB; unlike persistence, this read is required for playback.
    const url = await getElectronAssetUrl(rec.id, rec.assets.audio);
    const response = await fetch(url);
    if (!response.ok) throw new Error("Audio asset could not be loaded.");
    return response.arrayBuffer();
  }
  const blob = rec._blobs?.audio || rec._idbBlobs?.audio;
  if (!blob) throw new Error("Audio asset missing for this project.");
  return blob.arrayBuffer();
}

function audioFileForProject(rec, audioBuffer, audioSource) {
  const blob = rec._blobs?.audio || rec._idbBlobs?.audio;
  if (blob) return blob;
  if (hasElectronLibrary() && audioSource) {
    return {
      name: audioSource.name || rec.assets?.audio || "audio.bin",
      type: audioSource.mime || mimeFromFile(rec.assets?.audio),
      size: audioSource.size || 0,
      stored: true,
    };
  }
  return new Blob([audioBuffer], {
    type: mimeFromFile(rec.assets?.audio, "application/octet-stream"),
  });
}

async function resolveBackground(rec) {
  const bg = rec.assets?.background;
  const legacy = rec._blobs?.background || rec._idbBlobs?.background;
  if (!bg?.file && !legacy) return null;

  if (hasElectronLibrary() && bg?.file) {
    const key = assetCacheKey(rec, "background", bg.file);
    let url = assetUrlCache.get(key);
    if (!url) {
      url = await getElectronAssetUrl(rec.id, bg.file);
      assetUrlCache.set(key, url);
    }
    return {
      type: bg.type || "image", url,
      ...(bg.type === "video" ? {
        source: { kind: "project-asset", projectId: rec.id, fileName: bg.file },
      } : {}),
    };
  }

  if (legacy) {
    const blob = legacy.blob || legacy;
    const type = legacy.type || bg?.type || "image";
    const mime = blob.type || (type === "video" ? "video/mp4" : "image/png");
    return { type, url: cachedObjectUrl(cacheKey(rec.id, "background", "idb"), [blob], mime), file: blob };
  }
  return null;
}

// Refreshing takes after a chart-only save does not need to reload song media.
export function playableVersionsFromRecord(rec) {
  const r = migrateRecord(rec);
  const versions = [];
  for (const version of r.versions || []) {
    const chartText = version.chart?.text;
    if (!chartText) continue;
    try {
      const chart = parseChart(chartText);
      let chosen = version.settings?.difficulty || r.settings?.difficulty || "expert";
      if (!chart.tracks[chosen]) {
        const order = ["expert", "hard", "medium", "easy"];
        chosen = order.find((d) => chart.tracks[d]) || Object.keys(chart.tracks)[0];
      }
      const track = buildPlayableTrack(chart, chosen);
      versions.push({
        ...version,
        difficulty: chosen,
        noteCount: version.meta?.noteCount || track.notes.length,
        track,
      });
    } catch (err) {
      console.warn("[library] Skipping invalid chart version:", version.id, err);
    }
  }

  return versions;
}

export async function recordToImported(rec, { audioBuffer: providedAudioBuffer = null } = {}) {
  const r = migrateRecord(rec);
  const versions = playableVersionsFromRecord(r);
  const activeId = r.settings?.activeVersionId || versions[0]?.id;
  const activeVersion = versions.find((v) => v.id === activeId) || versions[0];
  const chartText = activeVersion?.chart?.text || r.chart?.text || "";

  const m = { ...r.meta };
  const settings = r.settings || {};
  let chosen = activeVersion?.difficulty || settings.difficulty || "expert";
  let track = activeVersion?.track;
  if (!track && chartText) {
    const chart = parseChart(chartText);
    if (!chart.tracks[chosen]) {
      const order = ["expert", "hard", "medium", "easy"];
      chosen = order.find((d) => chart.tracks[d]) || Object.keys(chart.tracks)[0];
    }
    track = buildPlayableTrack(chart, chosen);
  }
  const audioSource = r.assets?.audio
    ? await getStoredAssetSource(r.id, r.assets.audio)
    : null;
  // Source replacement has already read the selected file for immediate
  // playback. Reuse that buffer after reloading the persisted record instead
  // of retaining a second complete copy of a potentially large media file.
  const audioBuffer = providedAudioBuffer || await loadAudioBuffer(r);
  const audioFile = audioFileForProject(r, audioBuffer, audioSource);
  const albumUrl =
    r.assets?.albumArt || r._blobs?.albumArt || r._idbBlobs?.albumArt
      ? await resolveCoverUrl(r)
      : null;
  const background = await resolveBackground(r);

  return {
    id: r.id,
    meta: { ...m, difficulty: chosen },
    settings,
    track,
    versions,
    arrangements: r.arrangements || [],
    sourceArtifacts: r.sourceArtifacts || {},
    activeVersionId: activeVersion?.id || null,
    audioBuffer,
    audioFile,
    audioSource,
    audioName: audioFile?.name || r.assets?.audio || "audio.bin",
    albumUrl,
    background,
    status: r.status,
    source: r.source,
  };
}

export { migrateRecord };

import { isVideoMedia, makeVideoThumbnail } from "./mediaMetadata.js";
import { importSongFolders } from "./songImport.js";
import { deleteProjectRecord, getProjectDeletionDetails, revokeCoverUrl, updateSongRecord } from "./songLibrary.js";
import { createVideoFileUrl } from "./videoPreview.js";

// The desktop Library's song import (song folders and song files), kept
// outside the page so it carries on (and can still be undone) if the Library
// is left mid-import. Undo removes exactly the projects this import created;
// the files it read from are never touched. One import runs at a time.
//
// State: null, or { phase, total, done, name, imported, failed, stopped,
// stopping, removed, kept, undoFailed, disposition }, where phase is
// "running", "done", "undoing" or "undone".

let state = null;
let stopRequested = false;
const listeners = new Set();

// A video without embedded art gets a frame from it as its cover, the way
// opening the project would. That waits for the video to decode (or convert),
// so it runs after each video is in, one at a time, and never holds up the
// import. coversMade counts them so the Library can show each one.
const coverQueue = [];
let coversRunning = false;
let coversMade = 0;

async function videoCover(file) {
  const url = await createVideoFileUrl(file);
  if (!url) return null;
  try {
    return await makeVideoThumbnail(file, url);
  } finally {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
}

async function makeVideoCovers() {
  if (coversRunning) return;
  coversRunning = true;
  while (coverQueue.length) {
    const { id, file } = coverQueue.shift();
    try {
      const cover = await videoCover(file);
      if (!cover) continue;
      await updateSongRecord(id, { _blobs: { albumArt: cover } });
      revokeCoverUrl(id);
      coversMade += 1;
      listeners.forEach((listener) => listener());
    } catch {
      // Keeps its generated cover; opening the project tries again.
    }
  }
  coversRunning = false;
}

export function getImportCoversMade() {
  return coversMade;
}

function set(next) {
  state = next;
  listeners.forEach((listener) => listener());
}

export function subscribeBulkImport(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBulkImport() {
  return state;
}

export function bulkImportBusy() {
  return state?.phase === "running" || state?.phase === "undoing";
}

export async function startBulkImport(folders) {
  if (bulkImportBusy()) throw new Error("Songs are still importing. Try again once they're in.");
  stopRequested = false;
  const imported = [];
  set({ phase: "running", total: folders.length, done: 0, name: folders[0]?.name || "", imported, failed: [] });
  const result = await importSongFolders(folders, {
    shouldStop: () => stopRequested,
    onProgress: ({ done, name }) => set({ ...state, done, name, imported: [...imported] }),
    onImported: (project, song, saved) => {
      imported.push(project);
      set({ ...state, imported: [...imported] });
      if (song.file && isVideoMedia(song.file) && !saved.assets?.albumArt) {
        coverQueue.push({ id: project.id, file: song.file });
        makeVideoCovers();
      }
    },
  });
  set({ phase: "done", total: folders.length, done: result.imported.length + result.failed.length, ...result });
  return result;
}

export function stopBulkImport() {
  if (state?.phase !== "running") return;
  stopRequested = true;
  set({ ...state, stopping: true });
}

/**
 * Removes the projects the last import created, except any listed in
 * `keepIds` (those open in the app right now).
 */
export async function undoBulkImport({ keepIds = [] } = {}) {
  if (state?.phase !== "done") return;
  const keep = new Set(keepIds);
  const targets = state.imported.filter((project) => !keep.has(project.id));
  const kept = state.imported.length - targets.length;
  coverQueue.length = 0;
  set({ ...state, phase: "undoing" });
  let removed = 0;
  let disposition = "delete";
  const undoFailed = [];
  for (const project of targets) {
    try {
      const details = await getProjectDeletionDetails(project.id);
      const result = await deleteProjectRecord(project.id, details.path, details.title);
      disposition = result.disposition || disposition;
      revokeCoverUrl(project.id);
      removed += 1;
    } catch (error) {
      undoFailed.push({ name: project.title, message: error?.message || String(error) });
    }
  }
  set({ phase: "undone", removed, kept, undoFailed, disposition });
}

export function dismissBulkImport() {
  if (bulkImportBusy()) return;
  set(null);
}

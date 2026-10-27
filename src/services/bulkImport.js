import { importSongFolders } from "./songImport.js";
import { deleteProjectRecord, getProjectDeletionDetails, revokeCoverUrl } from "./songLibrary.js";

// The desktop Library's folder import, kept outside the page so it carries on
// (and can still be undone) if the Library is left mid-import. Undo removes
// exactly the projects this import created; the song folders it read from
// are never touched. One import runs at a time.
//
// State: null, or { phase, total, done, name, imported, failed, stopped,
// stopping, removed, kept, undoFailed, disposition }, where phase is
// "running", "done", "undoing" or "undone".

let state = null;
let stopRequested = false;
const listeners = new Set();

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
    onImported: (project) => {
      imported.push(project);
      set({ ...state, imported: [...imported] });
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

// Reads what was dropped or picked into song folders or a single media file.
// A song folder is any folder holding notes.chart, notes.mid or song.ini; a
// folder without one is searched for song folders inside it, so a whole
// Clone Hero songs directory comes in as all of its songs. A .sng or .zip
// opens as the song folders packed in it. Each song folder is a plain list of
// its own files, the shape importSongFolder() reads.

import { isSongArchive, songFoldersFromArchive } from "./songArchives.js";

const SONG_FILES = new Set(["notes.chart", "notes.mid", "notes.midi", "song.ini"]);
const MAX_DEPTH = 8;

function isSongFolder(files) {
  return files.some((file) => SONG_FILES.has(file.name.toLowerCase()));
}

/** Whether a drag carries files or folders at all. */
export function dragHasFiles(event) {
  return Array.from(event.dataTransfer?.items || []).some((item) => item.kind === "file");
}

/**
 * Best guess, mid-drag, at whether folders are coming: a folder has no MIME
 * type, while songs and videos usually do. The drop itself checks for real.
 */
export function dragLooksLikeFolders(event) {
  const items = Array.from(event.dataTransfer?.items || []).filter((item) => item.kind === "file");
  return items.length > 0 && items.every((item) => !item.type);
}

function readEntries(reader) {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

async function listDirectory(entry) {
  const reader = entry.createReader();
  const entries = [];
  // readEntries returns the listing in batches until it comes back empty.
  for (let batch = await readEntries(reader); batch.length; batch = await readEntries(reader)) {
    entries.push(...batch);
  }
  return entries;
}

function entryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function collectSongFolders(entry, depth, folders) {
  const entries = await listDirectory(entry);
  const files = await Promise.all(entries.filter((child) => child.isFile).map(entryFile));
  if (isSongFolder(files)) {
    folders.push({ name: entry.name, files });
    return;
  }
  if (depth >= MAX_DEPTH) return;
  const children = entries.filter((child) => child.isDirectory).sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) await collectSongFolders(child, depth + 1, folders);
}

/**
 * Reads a drop into { folders, directories, archives, file }. `folders` lists
 * every song folder found; `file` is the first loose file when no song folder
 * was dropped.
 * The DataTransfer is only readable during the drop event, so call this
 * from the handler before awaiting anything else.
 */
export function readDrop(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []).filter((item) => item.kind === "file");
  const entries = items.map((item) => item.webkitGetAsEntry?.() || null);
  const looseFiles = Array.from(dataTransfer?.files || []);
  return (async () => {
    const folders = [];
    const directories = entries.filter((entry) => entry?.isDirectory);
    for (const entry of directories) await collectSongFolders(entry, 0, folders);
    const fileEntries = entries.filter((entry) => entry?.isFile);
    const picked = fileEntries.length ? await Promise.all(fileEntries.map(entryFile)) : directories.length ? [] : looseFiles;
    for (const archive of picked.filter(isSongArchive)) folders.push(...await songFoldersFromArchive(archive));
    const files = picked.filter((file) => !isSongArchive(file));
    // A song's files dropped without their folder still make one song.
    if (isSongFolder(files)) folders.push({ name: "", files });
    return {
      folders,
      directories: directories.length,
      archives: picked.length - files.length,
      file: folders.length ? null : files[0] || null,
    };
  })();
}

/**
 * The song folders in picked files: any .sng or .zip among them, and the rest
 * as one song (a song folder's files picked together), for the importer to
 * explain if it isn't one.
 */
export async function songFoldersFromPickedFiles(fileList) {
  const picked = Array.from(fileList || []);
  const folders = [];
  for (const archive of picked.filter(isSongArchive)) folders.push(...await songFoldersFromArchive(archive));
  const files = picked.filter((file) => !isSongArchive(file));
  if (files.length) folders.push({ name: "", files });
  return folders;
}

/**
 * Splits a folder picker's FileList into song folders by their relative
 * paths, so picking a songs directory brings in every song inside it. A pick
 * with no song folder in it comes back whole, for the importer to explain.
 */
export function songFoldersFromFileList(fileList) {
  const files = Array.from(fileList || []);
  const byFolder = new Map();
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(file);
  }
  const folders = [...byFolder.entries()]
    .filter(([, folderFiles]) => isSongFolder(folderFiles))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, folderFiles]) => ({ name: path.split("/").pop(), files: folderFiles }));
  return folders.length || !files.length ? folders : [{ name: files[0].webkitRelativePath?.split("/")[0] || "", files }];
}

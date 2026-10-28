// Opens a song packed in one file, a .sng or a .zip, as the song folders it
// holds: { name, files } with plain Files, the shape importSongFolder() reads,
// so it opens like the folder would. A .sng's metadata comes back as its
// song.ini. Files are read from the package one at a time.

import { SngHeadTooShort, readSngIndex, sngMetadataToIni, unmaskSngFile } from "../../shared/sng.js";
import { mimeFromFile } from "./songLibrary.js";

const SONG_FILES = new Set(["notes.chart", "notes.mid", "notes.midi", "song.ini"]);

/** Why a packed song couldn't be opened, in words for the page. */
export class SongArchiveError extends Error {}

function extension(name) {
  return /\.([a-z0-9]+)$/i.exec(String(name || ""))?.[1]?.toLowerCase() || "";
}

function stem(name) {
  return String(name || "").replace(/\.[a-z0-9]+$/i, "");
}

function baseName(path) {
  return String(path).split("/").pop();
}

/** Whether a file is a packed song this module opens. */
export function isSongArchive(file) {
  return ["sng", "zip"].includes(extension(file?.name));
}

// Typed like a file picked from disk, so the song's audio exports as is.
function songFile(data, name) {
  return new File([data], baseName(name), { type: mimeFromFile(name, "") });
}

async function bytesOf(blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

// ----- .sng -----

async function sngFolder(file) {
  // The index sits at the front; read more until it's all in.
  let length = Math.min(file.size, 64 * 1024);
  let index;
  for (;;) {
    try {
      index = readSngIndex(await bytesOf(file.slice(0, length)));
      break;
    } catch (error) {
      if (!(error instanceof SngHeadTooShort) || length >= file.size) {
        throw error instanceof SngHeadTooShort ? new Error(`${file.name} is cut short.`) : error;
      }
      length = Math.min(file.size, length * 4);
    }
  }
  const files = [new File([sngMetadataToIni(index.metadata)], "song.ini", { type: "text/plain" })];
  for (const entry of index.files) {
    if (entry.offset + entry.size > file.size) throw new SongArchiveError(`${file.name} is cut short.`);
    const bytes = unmaskSngFile(await bytesOf(file.slice(entry.offset, entry.offset + entry.size)), index.mask);
    files.push(songFile(bytes, entry.name));
  }
  return [{ name: stem(file.name), files }];
}

// ----- .zip -----

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

async function zipEntries(file) {
  // The end record is the last 22 bytes, plus a comment of up to 64 KB.
  const tailStart = Math.max(0, file.size - 22 - 0xffff);
  const tail = await bytesOf(file.slice(tailStart));
  const tailView = new DataView(tail.buffer);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tailView.getUint32(i, true) === END_OF_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new SongArchiveError(`${file.name} isn't a zip that can be opened.`);
  const count = tailView.getUint16(end + 10, true);
  const size = tailView.getUint32(end + 12, true);
  const offset = tailView.getUint32(end + 16, true);
  if (offset === 0xffffffff || offset + size > file.size) throw new SongArchiveError(`${file.name} is too large or damaged to open here. Unzip it and open the folder.`);
  const directory = await bytesOf(file.slice(offset, offset + size));
  const view = new DataView(directory.buffer);
  const utf8 = new TextDecoder();
  const latin1 = new TextDecoder("latin1");
  const entries = [];
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > directory.length || view.getUint32(at, true) !== DIRECTORY_ENTRY) throw new SongArchiveError(`${file.name} is damaged.`);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const nameBytes = directory.subarray(at + 46, at + 46 + nameLength);
    const name = (flags & 0x0800 ? utf8 : latin1).decode(nameBytes).replace(/\\/g, "/");
    entries.push({ name, method, compressed, localOffset, encrypted: Boolean(flags & 1) });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function zipEntryFile(file, entry) {
  const local = new DataView(await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
  if (local.getUint32(0, true) !== LOCAL_HEADER) throw new SongArchiveError(`${file.name} is damaged.`);
  const start = entry.localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
  const data = file.slice(start, start + entry.compressed);
  if (entry.method === 0) return songFile(data, entry.name);
  if (entry.method === 8) {
    const inflated = await new Response(data.stream().pipeThrough(new DecompressionStream("deflate-raw"))).blob();
    return songFile(inflated, entry.name);
  }
  throw new SongArchiveError(`${file.name} uses a kind of compression that can't be opened here. Unzip it and open the folder.`);
}

async function zipFolders(file) {
  const entries = (await zipEntries(file)).filter((entry) =>
    !entry.name.endsWith("/") && !entry.name.startsWith("__MACOSX/") && !baseName(entry.name).startsWith("._"));
  if (entries.some((entry) => entry.encrypted)) throw new SongArchiveError(`${file.name} is password protected.`);
  // Each folder in the zip that holds a song is one song; a .sng inside opens too.
  const byFolder = new Map();
  for (const entry of entries) {
    const folder = entry.name.includes("/") ? entry.name.slice(0, entry.name.lastIndexOf("/")) : "";
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(entry);
  }
  const folders = [];
  for (const [folder, folderEntries] of [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const isSong = folderEntries.some((entry) => SONG_FILES.has(baseName(entry.name).toLowerCase()));
    if (isSong) {
      const files = [];
      for (const entry of folderEntries) files.push(await zipEntryFile(file, entry));
      folders.push({ name: folder ? baseName(folder) : stem(file.name), files });
    }
    for (const entry of folderEntries.filter((item) => extension(item.name) === "sng")) {
      folders.push(...await sngFolder(await zipEntryFile(file, entry)));
    }
  }
  return folders;
}

/** The song folders in a .sng or .zip; throws SongArchiveError. */
export async function songFoldersFromArchive(file) {
  try {
    return await (extension(file.name) === "sng" ? sngFolder(file) : zipFolders(file));
  } catch (error) {
    // Our own reasons (and the .sng reader's) say what's wrong; anything
    // else is a file the browser couldn't read or unpack.
    const ours = error instanceof SongArchiveError || error?.constructor === Error;
    throw new SongArchiveError(ours ? error.message : `${file.name} couldn't be opened.`);
  }
}

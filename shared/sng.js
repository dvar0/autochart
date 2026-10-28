// .sng, the one-file song package Clone Hero and YARG read from a songs folder
// like a song folder (format: github.com/mdsitton/SngFileFormat). It holds
// song.ini's keys as metadata and every other file of the folder, each XOR
// masked, uncompressed. Little-endian throughout:
//   "SNGPKG", u32 version, 16-byte mask
//   u64 metadata length, u64 count, { i32 key length, key, i32 value length, value }...
//   u64 index length, u64 count, { u8 name length, name, u64 size, u64 offset from file start }...
//   u64 data length, the masked files
// Shared by the browser export and the song import. Kept dependency-free.

const MAGIC = "SNGPKG";
const VERSION = 1;
const HEADER_BYTES = 6 + 4 + 16;

export const SNG_EXTENSION = ".sng";

// Byte i of a file is masked with mask[i % 16] ^ (i & 0xff), which repeats
// every 256 bytes. Masking twice gives the bytes back.
function maskTable(mask) {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) table[i] = mask[i % 16] ^ i;
  return table;
}

function maskInPlace(bytes, table) {
  for (let i = 0; i < bytes.length; i += 1) bytes[i] ^= table[i & 0xff];
  return bytes;
}

// The format keeps metadata INI-safe: no line breaks or semicolons, and no
// "=" in keys.
function metadataText(value, { key = false } = {}) {
  let text = String(value ?? "").replace(/\r\n?|[\n\u2028\u2029]/g, " ").replace(/;/g, ",").trim();
  if (key) text = text.replace(/=/g, "");
  return text;
}

/** song.ini text to the metadata pairs a .sng carries (the [song] section). */
export function iniToSngMetadata(iniText) {
  const pairs = [];
  let section = "";
  for (const raw of String(iniText || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      section = line.replace(/^\[|\]$/g, "").trim().toLowerCase();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1 || (section && section !== "song")) continue;
    const key = metadataText(line.slice(0, eq), { key: true });
    if (key) pairs.push([key, metadataText(line.slice(eq + 1))]);
  }
  return pairs;
}

/** Metadata pairs back to a song.ini, for importers that read one. */
export function sngMetadataToIni(pairs) {
  return ["[song]", ...pairs.map(([key, value]) => `${key} = ${value}`)].join("\n") + "\n";
}

/**
 * Builds a .sng from metadata pairs ([key, value]) and files ({ name, bytes:
 * Uint8Array }). Returns the package as a list of Uint8Array parts, so a large
 * song is never copied into one buffer; the files' bytes are masked in place.
 */
export function buildSng(metadata, files, { mask = null } = {}) {
  const encoder = new TextEncoder();
  const xorMask = mask || globalThis.crypto.getRandomValues(new Uint8Array(16));
  const pairs = metadata.map(([key, value]) => [encoder.encode(metadataText(key, { key: true })), encoder.encode(metadataText(value))]);
  const names = files.map((file) => {
    const name = encoder.encode(String(file.name));
    if (!name.length || name.length > 255) throw new Error(`Can't put ${file.name} in a .sng: its name must be 1 to 255 bytes.`);
    return name;
  });
  const metadataBytes = 8 + pairs.reduce((sum, [key, value]) => sum + 8 + key.length + value.length, 0);
  const indexBytes = 8 + names.reduce((sum, name) => sum + 1 + name.length + 16, 0);
  const dataBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
  const head = new Uint8Array(HEADER_BYTES + 8 + metadataBytes + 8 + indexBytes + 8);
  const view = new DataView(head.buffer);
  let at = 0;
  const u8 = (value) => { view.setUint8(at, value); at += 1; };
  const i32 = (value) => { view.setInt32(at, value, true); at += 4; };
  const u64 = (value) => { view.setBigUint64(at, BigInt(value), true); at += 8; };
  const raw = (bytes) => { head.set(bytes, at); at += bytes.length; };

  raw(encoder.encode(MAGIC));
  view.setUint32(at, VERSION, true); at += 4;
  raw(xorMask);
  u64(metadataBytes);
  u64(pairs.length);
  for (const [key, value] of pairs) {
    i32(key.length); raw(key);
    i32(value.length); raw(value);
  }
  u64(indexBytes);
  u64(files.length);
  let offset = head.length;
  files.forEach((file, i) => {
    u8(names[i].length); raw(names[i]);
    u64(file.bytes.length);
    u64(offset);
    offset += file.bytes.length;
  });
  u64(dataBytes);

  const table = maskTable(xorMask);
  return [head, ...files.map((file) => maskInPlace(file.bytes, table))];
}

/** Thrown when the bytes given to readSngIndex end before its index does. */
export class SngHeadTooShort extends Error {}

/** Whether these first bytes start a .sng. */
export function isSng(bytes) {
  return bytes.length >= 6 && new TextDecoder().decode(bytes.subarray(0, 6)) === MAGIC;
}

/**
 * Reads a .sng's metadata and file index from its first bytes, without its
 * file data. Throws SngHeadTooShort when more of the file is needed.
 * Returns { metadata: [[key, value]...], files: [{ name, size, offset }...], mask }.
 */
export function readSngIndex(bytes) {
  if (!isSng(bytes)) throw new Error("That isn't a .sng song file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let at = 6;
  const need = (count) => {
    if (at + count > bytes.length) throw new SngHeadTooShort("The .sng index runs past the bytes read.");
  };
  const u8 = () => { need(1); const v = view.getUint8(at); at += 1; return v; };
  const i32 = () => { need(4); const v = view.getInt32(at, true); at += 4; return v; };
  const u64 = () => { need(8); const v = view.getBigUint64(at, true); at += 8; return Number(v); };
  const text = (length) => {
    if (length < 0) throw new Error("This .sng is damaged.");
    need(length);
    const v = decoder.decode(bytes.subarray(at, at + length));
    at += length;
    return v;
  };

  need(4);
  const version = view.getUint32(at, true); at += 4;
  if (version !== VERSION) throw new Error(`This .sng uses format version ${version}, which isn't supported.`);
  need(16);
  const mask = bytes.slice(at, at + 16); at += 16;
  u64();
  const metadataCount = u64();
  const metadata = [];
  for (let i = 0; i < metadataCount; i += 1) {
    const key = text(i32());
    metadata.push([key, text(i32())]);
  }
  u64();
  const fileCount = u64();
  const files = [];
  for (let i = 0; i < fileCount; i += 1) {
    const name = text(u8());
    files.push({ name, size: u64(), offset: u64() });
  }
  return { metadata, files, mask };
}

/** Unmasks one file's bytes, as read from the package at its offset. */
export function unmaskSngFile(bytes, mask) {
  return maskInPlace(bytes, maskTable(mask));
}

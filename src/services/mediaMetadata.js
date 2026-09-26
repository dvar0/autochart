const AUDIO_EXTS = [".ogg", ".opus", ".mp3", ".wav", ".wave", ".flac", ".m4a", ".aac", ".aiff", ".aif"];
const VIDEO_EXTS = [".mp4", ".m4v", ".mov", ".webm", ".ogv", ".mkv"];
export const MAX_METADATA_SCAN_BYTES = 8 * 1024 * 1024;

export const MEDIA_ACCEPT = ["audio/*", "video/*", ...AUDIO_EXTS, ...VIDEO_EXTS].join(",");

const TEXT_FRAME_MAP = {
  TIT2: "title",
  TT2: "title",
  TPE1: "artist",
  TP1: "artist",
  TPE2: "albumArtist",
  TP2: "albumArtist",
  TALB: "album",
  TAL: "album",
  TDRC: "year",
  TYER: "year",
  TYE: "year",
};

const VORBIS_FIELD_MAP = {
  TITLE: "title",
  ARTIST: "artist",
  ALBUMARTIST: "albumArtist",
  ALBUM_ARTIST: "albumArtist",
  ALBUM: "album",
  DATE: "year",
  YEAR: "year",
};

const MP4_FIELD_MAP = {
  "\u00a9nam": "title",
  "\u00a9ART": "artist",
  aART: "albumArtist",
  "\u00a9alb": "album",
  "\u00a9day": "year",
  "\u00a9gen": "genre",
};

function extname(name = "") {
  const clean = String(name).toLowerCase();
  const dot = clean.lastIndexOf(".");
  return dot === -1 ? "" : clean.slice(dot);
}

function fileBaseName(name = "") {
  return String(name).replace(/\.[^/.]+$/, "").replace(/[_.-]+/g, " ").trim();
}

function safeBaseName(name = "album") {
  return (fileBaseName(name) || "album").replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 80) || "album";
}

function hasExt(file, exts) {
  return exts.includes(extname(file?.name || ""));
}

export function isVideoMedia(file) {
  return Boolean(file?.type?.startsWith("video/") || hasExt(file, VIDEO_EXTS));
}

function imageExtForMime(mime = "") {
  const lower = mime.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg";
  if (lower.includes("webp")) return ".webp";
  if (lower.includes("gif")) return ".gif";
  if (lower.includes("heic")) return ".heic";
  return ".png";
}

function makeFile(parts, name, type) {
  try {
    return new File(parts, name, { type });
  } catch {
    const blob = new Blob(parts, { type });
    Object.defineProperty(blob, "name", { value: name });
    return blob;
  }
}

function makePictureBlob(picture, sourceName) {
  if (!picture?.data?.length) return null;
  const mime = picture.mime || "image/png";
  const ext = imageExtForMime(mime);
  return makeFile([picture.data], `${safeBaseName(sourceName)} cover${ext}`, mime);
}

export function makeVideoThumbnail(file, videoUrl = null) {
  if (typeof document === "undefined" || typeof URL === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = videoUrl || URL.createObjectURL(file);
    const video = document.createElement("video");
    let done = false;

    const finish = (blob) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!videoUrl) URL.revokeObjectURL(url);
      video.removeAttribute("src");
      video.load();
      resolve(blob);
    };

    const draw = () => {
      try {
        const width = video.videoWidth || 640;
        const height = video.videoHeight || 360;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return finish(null);
        ctx.drawImage(video, 0, 0, width, height);
        canvas.toBlob(
          (blob) => finish(blob ? makeFile([blob], `${safeBaseName(file.name)} cover.jpg`, "image/jpeg") : null),
          "image/jpeg",
          0.88
        );
      } catch {
        finish(null);
      }
    };

    const seekOrDraw = () => {
      if (done) return;
      const target = Number.isFinite(video.duration) && video.duration > 2 ? Math.min(2, video.duration / 10) : 0;
      if (target > 0) {
        video.currentTime = target;
      } else {
        draw();
      }
    };

    const timer = setTimeout(() => finish(null), 5000);
    const clearFinish = (blob) => {
      clearTimeout(timer);
      finish(blob);
    };
    video.addEventListener("loadedmetadata", seekOrDraw, { once: true });
    video.addEventListener("loadeddata", () => {
      if (!Number.isFinite(video.duration) || video.duration <= 2) draw();
    }, { once: true });
    video.addEventListener("seeked", draw, { once: true });
    video.addEventListener("error", () => clearFinish(null), { once: true });
    video.muted = true;
    video.crossOrigin = "anonymous";
    video.preload = "metadata";
    video.playsInline = true;
    video.src = url;
  });
}

function cleanText(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .replace(/\0+$/g, "")
    .trim();
}

function setMeta(meta, key, value) {
  const clean = cleanText(value);
  if (!clean || meta[key]) return;
  if (key === "year") {
    const match = clean.match(/\d{4}/);
    meta[key] = match ? match[0] : clean.slice(0, 10);
    return;
  }
  meta[key] = clean;
}

function decodeBytes(bytes, encoding = "utf-8") {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function decodeId3Text(bytes) {
  if (!bytes?.length) return "";
  const encoding = bytes[0];
  const body = bytes.slice(1);
  if (encoding === 0) return decodeBytes(body, "iso-8859-1");
  if (encoding === 1) return decodeBytes(body, "utf-16");
  if (encoding === 2) return decodeBytes(body, "utf-16be");
  return decodeBytes(body, "utf-8");
}

function synchsafe(bytes, offset) {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

function uint24be(bytes, offset) {
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function uint32be(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function uint32le(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function findTerminator(bytes, offset, doubleByte) {
  if (doubleByte) {
    for (let i = offset; i + 1 < bytes.length; i += 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) return i;
    }
  } else {
    for (let i = offset; i < bytes.length; i += 1) {
      if (bytes[i] === 0) return i;
    }
  }
  return -1;
}

function parseId3Picture(frame, version) {
  if (!frame.length) return null;
  const encoding = frame[0];
  const doubleByte = encoding === 1 || encoding === 2;
  let offset = 1;
  let mime = "image/jpeg";
  if (version === 2) {
    const fmt = decodeBytes(frame.slice(offset, offset + 3), "iso-8859-1").toLowerCase();
    mime = fmt === "png" ? "image/png" : "image/jpeg";
    offset += 3;
  } else {
    const mimeEnd = findTerminator(frame, offset, false);
    if (mimeEnd === -1) return null;
    mime = cleanText(decodeBytes(frame.slice(offset, mimeEnd), "iso-8859-1")) || mime;
    offset = mimeEnd + 1;
  }
  offset += 1;
  const descEnd = findTerminator(frame, offset, doubleByte);
  if (descEnd === -1) return null;
  offset = descEnd + (doubleByte ? 2 : 1);
  const data = frame.slice(offset);
  return data.length ? { mime, data } : null;
}

function parseId3(bytes) {
  const out = { meta: {}, picture: null };
  if (bytes.length < 10 || decodeBytes(bytes.slice(0, 3), "iso-8859-1") !== "ID3") return out;
  const version = bytes[3];
  const tagSize = synchsafe(bytes, 6);
  const tagEnd = Math.min(bytes.length, 10 + tagSize);
  let offset = 10;

  while (offset + (version === 2 ? 6 : 10) <= tagEnd) {
    const frameIdSize = version === 2 ? 3 : 4;
    const id = decodeBytes(bytes.slice(offset, offset + frameIdSize), "iso-8859-1").replace(/\0/g, "");
    if (!id) break;
    const size = version === 2 ? uint24be(bytes, offset + 3) : version === 4 ? synchsafe(bytes, offset + 4) : uint32be(bytes, offset + 4);
    const headerSize = version === 2 ? 6 : 10;
    const frameStart = offset + headerSize;
    const frameEnd = Math.min(frameStart + size, tagEnd);
    if (size <= 0 || frameEnd <= frameStart) break;
    const frame = bytes.slice(frameStart, frameEnd);
    const metaKey = TEXT_FRAME_MAP[id];
    if (metaKey) setMeta(out.meta, metaKey, decodeId3Text(frame));
    if (!out.picture && (id === "APIC" || id === "PIC")) out.picture = parseId3Picture(frame, version);
    offset = frameEnd;
  }
  return out;
}

function parseFlacPicture(bytes) {
  if (bytes.length < 32) return null;
  let offset = 4;
  const mimeLen = uint32be(bytes, offset);
  offset += 4;
  if (offset + mimeLen + 4 > bytes.length) return null;
  const mime = cleanText(decodeBytes(bytes.slice(offset, offset + mimeLen), "utf-8")) || "image/png";
  offset += mimeLen;
  const descLen = uint32be(bytes, offset);
  offset += 4 + descLen + 16;
  if (offset + 4 > bytes.length) return null;
  const dataLen = uint32be(bytes, offset);
  offset += 4;
  if (offset + dataLen > bytes.length) return null;
  return { mime, data: bytes.slice(offset, offset + dataLen) };
}

function parseVorbisComments(bytes, offset, limit) {
  const meta = {};
  let picture = null;
  if (offset + 8 > limit) return { meta, picture };
  const vendorLen = uint32le(bytes, offset);
  offset += 4 + vendorLen;
  if (offset + 4 > limit) return { meta, picture };
  const count = uint32le(bytes, offset);
  offset += 4;
  for (let i = 0; i < count && offset + 4 <= limit; i += 1) {
    const len = uint32le(bytes, offset);
    offset += 4;
    if (offset + len > limit) break;
    const raw = decodeBytes(bytes.slice(offset, offset + len), "utf-8");
    offset += len;
    const eq = raw.indexOf("=");
    if (eq === -1) continue;
    const key = raw.slice(0, eq).toUpperCase();
    const value = raw.slice(eq + 1);
    const mapped = VORBIS_FIELD_MAP[key];
    if (mapped) setMeta(meta, mapped, value);
    if (!picture && key === "METADATA_BLOCK_PICTURE") {
      try {
        const bin = Uint8Array.from(atob(value.trim()), (ch) => ch.charCodeAt(0));
        picture = parseFlacPicture(bin);
      } catch {
        /* ignore malformed embedded picture */
      }
    }
  }
  return { meta, picture };
}

function parseFlac(bytes) {
  const out = { meta: {}, picture: null };
  if (bytes.length < 4 || decodeBytes(bytes.slice(0, 4), "iso-8859-1") !== "fLaC") return out;
  let offset = 4;
  let last = false;
  while (!last && offset + 4 <= bytes.length) {
    const header = bytes[offset];
    last = Boolean(header & 0x80);
    const type = header & 0x7f;
    const len = uint24be(bytes, offset + 1);
    const start = offset + 4;
    const end = Math.min(start + len, bytes.length);
    if (type === 4) {
      const comments = parseVorbisComments(bytes, start, end);
      Object.assign(out.meta, comments.meta);
      if (!out.picture) out.picture = comments.picture;
    } else if (type === 6 && !out.picture) {
      out.picture = parseFlacPicture(bytes.slice(start, end));
    }
    offset = end;
  }
  return out;
}

function parseOgg(bytes) {
  const signature = new Uint8Array([3, 118, 111, 114, 98, 105, 115]);
  let packet = -1;
  outer: for (let i = 0; i + signature.length < bytes.length; i += 1) {
    for (let j = 0; j < signature.length; j += 1) {
      if (bytes[i + j] !== signature[j]) continue outer;
    }
    packet = i + signature.length;
    break;
  }
  return packet === -1 ? { meta: {}, picture: null } : parseVorbisComments(bytes, packet, bytes.length);
}

function atomType(bytes, offset) {
  return decodeBytes(bytes.slice(offset, offset + 4), "iso-8859-1");
}

function parseMp4DataAtom(bytes, offset, end, itemType) {
  let cursor = offset;
  while (cursor + 16 <= end) {
    const size = uint32be(bytes, cursor);
    const type = atomType(bytes, cursor + 4);
    const atomEnd = size > 0 ? cursor + size : end;
    if (size < 8 || atomEnd > end) break;
    if (type === "data" && cursor + 16 <= atomEnd) {
      const dataType = uint32be(bytes, cursor + 8) & 0xffffff;
      const data = bytes.slice(cursor + 16, atomEnd);
      if (itemType === "covr") {
        const mime = dataType === 13 ? "image/jpeg" : dataType === 14 ? "image/png" : "image/png";
        return { picture: { mime, data } };
      }
      if (dataType === 1 || dataType === 2) {
        return { text: decodeBytes(data, dataType === 2 ? "utf-16be" : "utf-8") };
      }
    }
    cursor = atomEnd;
  }
  return {};
}

function parseIlst(bytes, offset, end, keys = {}) {
  const out = { meta: {}, picture: null };
  let cursor = offset;
  while (cursor + 8 <= end) {
    const size = uint32be(bytes, cursor);
    const type = atomType(bytes, cursor + 4);
    const atomEnd = size > 0 ? cursor + size : end;
    if (size < 8 || atomEnd > end) break;
    const parsed = parseMp4DataAtom(bytes, cursor + 8, atomEnd, type);
    const mapped = MP4_FIELD_MAP[type] || keys[uint32be(bytes, cursor + 4)];
    if (mapped && parsed.text) setMeta(out.meta, mapped, parsed.text);
    if (!out.picture && parsed.picture) out.picture = parsed.picture;
    cursor = atomEnd;
  }
  return out;
}

function parseMp4Keys(bytes) {
  const fields = { title: "title", artist: "artist", album_artist: "albumArtist", album: "album", date: "year", year: "year", creationdate: "year", genre: "genre" };
  const keys = {};
  if (bytes.length < 8) return keys;
  const count = uint32be(bytes, 4);
  let cursor = 8;
  for (let index = 1; index <= count && cursor + 8 <= bytes.length; index += 1) {
    const size = uint32be(bytes, cursor);
    if (size < 8 || cursor + size > bytes.length) break;
    if (atomType(bytes, cursor + 4) === "mdta") {
      const name = decodeBytes(bytes.subarray(cursor + 8, cursor + size)).replace(/^com\.apple\.quicktime\./, "");
      if (Object.hasOwn(fields, name)) keys[index] = fields[name];
    }
    cursor += size;
  }
  return keys;
}

// Follow atom offsets instead of scanning the first bytes: moov can follow a
// multi-gigabyte mdat. Skip media/sample tables and bound both reads and traversal.
async function parseMp4(file) {
  const out = { meta: {}, picture: null };
  const containers = new Set(["moov", "udta", "trak", "mdia"]);
  let remaining = MAX_METADATA_SCAN_BYTES;
  let atomsRemaining = 4096;
  const read = async (start, size) => {
    if (size > remaining) return null;
    remaining -= size;
    const bytes = new Uint8Array(await file.slice(start, start + size).arrayBuffer());
    return bytes.length === size ? bytes : null;
  };

  async function headerAt(cursor, end) {
    if (cursor + 8 > end || atomsRemaining-- <= 0) return null;
    const header = await read(cursor, 8);
    if (!header) return null;
    let size = uint32be(header, 0);
    let headerSize = 8;
    if (size === 1) {
      if (cursor + 16 > end) return null;
      const extended = await read(cursor + 8, 8);
      if (!extended) return null;
      size = uint32be(extended, 0) * 2 ** 32 + uint32be(extended, 4);
      headerSize = 16;
    } else if (size === 0) {
      size = end - cursor;
    }
    if (!Number.isSafeInteger(size) || size < headerSize || size > end - cursor) return null;
    return { type: atomType(header, 4), start: cursor + headerSize, end: cursor + size };
  }

  async function walk(start, end, depth = 0, parent = "") {
    if (depth > 12) return;
    let cursor = start;
    let keys = {};
    const lists = [];
    while (cursor + 8 <= end) {
      const atom = await headerAt(cursor, end);
      if (!atom) break;
      const { type, start: contentStart, end: atomEnd } = atom;
      if (type === "meta") {
        // ISO meta has version/flags; QuickTime meta begins with child atoms.
        const prefix = atomEnd - contentStart >= 4 ? await read(contentStart, 4) : null;
        if (prefix) await walk(contentStart + (uint32be(prefix, 0) === 0 ? 4 : 0), atomEnd, depth + 1, type);
      } else if (type === "keys" && parent === "meta") {
        const bytes = await read(contentStart, atomEnd - contentStart);
        if (bytes) keys = parseMp4Keys(bytes);
      } else if (type === "ilst" && parent === "meta") {
        lists.push(atom);
      } else if (parent === "udta" && MP4_FIELD_MAP[type]) {
        // Classic QuickTime text tags contain a 16-bit byte count and language
        // code, followed by text, rather than an iTunes data atom.
        const bytes = await read(contentStart, atomEnd - contentStart);
        if (bytes?.length >= 4) {
          const size = (bytes[0] << 8) | bytes[1];
          const language = (bytes[2] << 8) | bytes[3];
          if (size <= bytes.length - 4) {
            const text = bytes.subarray(4, 4 + size);
            const encoding = text[0] === 0xfe && text[1] === 0xff ? "utf-16be"
              : text[0] === 0xff && text[1] === 0xfe ? "utf-16le"
              : language < 0x400 ? "macintosh" : "utf-8";
            setMeta(out.meta, MP4_FIELD_MAP[type], decodeBytes(text, encoding));
          }
        }
      } else if (containers.has(type)) {
        await walk(contentStart, atomEnd, depth + 1, type);
      }
      cursor = atomEnd;
    }
    // Keys and ilst may appear in either order within this metadata container.
    for (const atom of lists) {
      const bytes = await read(atom.start, atom.end - atom.start);
      if (!bytes) continue;
      const parsed = parseIlst(bytes, 0, bytes.length, keys);
      for (const [key, value] of Object.entries(parsed.meta)) setMeta(out.meta, key, value);
      out.picture ||= parsed.picture;
    }
  }

  await walk(0, file.size);
  return out;
}

// WAV stores ID3/INFO tags in RIFF chunks, often after the entire PCM payload.
// Read chunk headers and bounded metadata bodies; never read through the audio
// merely to reach an embedded cover at the end of a large file.
async function parseWaveMetadata(file) {
  const out = { meta: {}, picture: null };
  const read = async (start, size) => new Uint8Array(await file.slice(start, start + size).arrayBuffer());
  const header = await read(0, 12);
  if (header.length < 12) return out;
  const end = Math.min(file.size, new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(4, true) + 8);
  const infoFields = { INAM: 'title', IART: 'artist', IPRD: 'album', ICRD: 'year' };
  let offset = 12, remaining = MAX_METADATA_SCAN_BYTES;
  for (let chunk = 0; chunk < 512 && offset + 8 <= end && remaining >= 8; chunk++) {
    const bytes = await read(offset, 8); remaining -= 8;
    if (bytes.length < 8) break;
    const id = decodeBytes(bytes.subarray(0, 4), 'iso-8859-1');
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
    const start = offset + 8;
    if (start + size > end) break;
    if ((id.toLowerCase() === 'id3 ' || id === 'LIST') && size <= remaining) {
      const body = await read(start, size); remaining -= size;
      if (id.toLowerCase() === 'id3 ') {
        const parsed = parseId3(body);
        Object.assign(out.meta, parsed.meta);
        out.picture ||= parsed.picture;
      } else if (decodeBytes(body.subarray(0, 4), 'iso-8859-1') === 'INFO') {
        for (let at = 4; at + 8 <= body.length;) {
          const key = decodeBytes(body.subarray(at, at + 4), 'iso-8859-1');
          const count = new DataView(body.buffer, body.byteOffset + at, 8).getUint32(4, true);
          if (at + 8 + count > body.length) break;
          const field = infoFields[key];
          if (field && !out.meta[field]) out.meta[field] = decodeBytes(body.subarray(at + 8, at + 8 + count), 'utf-8').replace(/\0.*$/, '').trim();
          at += 8 + count + (count & 1);
        }
      }
    }
    offset = start + size + (size & 1);
  }
  return out;
}

export async function readMediaFileMetadata(file, { videoUrl = null, skipVideoThumbnail = false } = {}) {
  if (!file) return { meta: {}, albumBlob: null, raw: { meta: {}, picture: null } };
  // Keep metadata inspection bounded; WAV/MP4 tags may follow the media payload.
  const head = typeof file.slice === 'function' ? new Uint8Array(await file.slice(0, 12).arrayBuffer()) : null;
  const wave = head?.length === 12 && decodeBytes(head.subarray(0, 4), 'iso-8859-1') === 'RIFF'
    && decodeBytes(head.subarray(8, 12), 'iso-8859-1') === 'WAVE';
  const ext = extname(file.name || "");
  const mp4Like = [".mp4", ".m4a", ".m4v", ".mov"].includes(ext) || (head?.length >= 8 && atomType(head, 4) === "ftyp");
  const metadataSlice = typeof file.slice === "function"
    ? file.slice(0, wave || mp4Like ? 12 : MAX_METADATA_SCAN_BYTES)
    : file;
  if (metadataSlice === file && Number(file.size) > MAX_METADATA_SCAN_BYTES) {
    throw new Error("This media object cannot be inspected without loading the whole file.");
  }
  const bytes = new Uint8Array(await metadataSlice.arrayBuffer());
  let parsed = { meta: {}, picture: null };

  if (wave) {
    parsed = await parseWaveMetadata(file);
  } else if (bytes.length >= 10 && decodeBytes(bytes.slice(0, 3), "iso-8859-1") === "ID3") {
    parsed = parseId3(bytes);
  } else if (bytes.length >= 4 && decodeBytes(bytes.slice(0, 4), "iso-8859-1") === "fLaC") {
    parsed = parseFlac(bytes);
  } else if (bytes.length >= 4 && decodeBytes(bytes.slice(0, 4), "iso-8859-1") === "OggS") {
    parsed = parseOgg(bytes);
  } else if (mp4Like) {
    parsed = await parseMp4(typeof file.slice === "function" ? file : new Blob([bytes]));
  }

  const meta = { ...parsed.meta };
  if (!meta.title) meta.title = fileBaseName(file.name || "") || "Untitled";
  if (!meta.artist) meta.artist = "";
  if (!meta.album) meta.album = "";
  if (!meta.year) meta.year = "";

  const albumBlob = makePictureBlob(parsed.picture, file.name || "album") || (!skipVideoThumbnail && isVideoMedia(file) ? await makeVideoThumbnail(file, videoUrl) : null);

  return {
    meta,
    albumBlob,
    raw: parsed,
  };
}

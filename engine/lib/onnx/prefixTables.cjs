"use strict";

// Tiny pure-JS reader for numpy .npz / .npy files holding fp32 little-endian
// arrays. No external deps, no Python at runtime. The only consumer is the
// transcriber prefix_conditioning sidecar (prefix_tables.npz: descriptor_embedding_0..4,
// each (8, 512) fp32).
//
// The npz container is a standard ZIP archive of .npy streams. We parse the
// ZIP Central Directory once (sufficient to find every member), then zlib
// inflate each member's raw DEFLATE payload. .npy is parsed by reading the
// magic + version + header-len header and then the C-order raw bytes.

const fs = require("fs");
const zlib = require("zlib");

const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // \x93NUMPY

function readNpy(buffer) {
  // Verify magic.
  for (let i = 0; i < NPY_MAGIC.length; i += 1) {
    if (buffer[i] !== NPY_MAGIC[i]) {
      throw new Error(`npy: bad magic at byte ${i}: ${buffer[i]}`);
    }
  }
  let off = NPY_MAGIC.length;
  const major = buffer[off];
  const minor = buffer[off + 1];
  off += 2;
  let headerLen;
  if (major === 1) {
    headerLen = buffer.readUInt16LE(off);
    off += 2;
  } else if (major === 2) {
    headerLen = buffer.readUInt32LE(off);
    off += 4;
  } else {
    throw new Error(`npy: unsupported version ${major}.${minor}`);
  }
  const headerEnd = off + headerLen;
  const headerText = buffer.toString("latin1", off, headerEnd);
  off = headerEnd;
  const meta = parseNpyHeader(headerText);
  const { dtype, fortranOrder, shape } = meta;
  if (fortranOrder) {
    throw new Error(`npy: F-order arrays are not supported (got ${headerText.trim()})`);
  }
  const isLittle = !dtype.includes(">");
  if (!isLittle) throw new Error(`npy: only little-endian / byte-order-agnostic supported (got ${dtype})`);
  const code = dtype.replace(/[<>|]/, "");
  if (code !== "f4" && code !== "b1" && code !== "?") {
    throw new Error(`npy: only fp32 (f4) and bool (b1/?) supported here (got ${dtype})`);
  }
  const count = shape.reduce((a, b) => a * b, 1);
  let data;
  if (code === "f4") {
    const bytes = count * 4;
    if (off + bytes > buffer.length) {
      throw new Error(`npy: truncated payload: need ${bytes} bytes from offset ${off}, file has ${buffer.length}`);
    }
    data = new Float32Array(count);
    new Float32Array(buffer.buffer, buffer.byteOffset + off, count).forEach((v, i) => {
      data[i] = v;
    });
    return { shape, data };
  }
  // bool (|b1 / ?): numpy stores one byte per element (0/1).
  const bytes = count;
  if (off + bytes > buffer.length) {
    throw new Error(`npy: truncated payload: need ${bytes} bytes from offset ${off}, file has ${buffer.length}`);
  }
  data = new Uint8Array(count);
  data.set(buffer.subarray(off, off + count));
  return { shape, data };
}

// Parse the Python-literal header dict. Mirrors numpy's own reader.
function parseNpyHeader(text) {
  // Trim trailing newline & whitespace.
  const trimmed = text.replace(/^\(|\)$/g, "").trim().replace(/\s+/g, " ");
  // Example: "'descr': '<f4', 'fortran_order': False, 'shape': (8, 512),"
  const descM = /'descr':\s*'([^']+)'/.exec(trimmed);
  if (!descM) throw new Error(`npy: cannot parse descr in header: ${trimmed}`);
  const fortranM = /'fortran_order':\s*(True|False)/.exec(trimmed);
  const fortranOrder = fortranM ? fortranM[1] === "True" : false;
  const shapeM = /'shape':\s*\(([^)]*)\)/.exec(trimmed);
  if (!shapeM) throw new Error(`npy: cannot parse shape in header: ${trimmed}`);
  const shape = shapeM[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length)
    .map((s) => Number.parseInt(s, 10));
  return { dtype: descM[1], fortranOrder, shape };
}

// Parse the ZIP central directory of an npz. Returns Map<name, {offset, compressedSize, uncompressedSize, method}>.
// We do NOT need local file headers; the central directory alone locates each member.
function parseZipCentralDirectory(buffer) {
  // End Of Central Directory record: signature 0x06054b50, scan from the end.
  const minEocd = 22;
  if (buffer.length < minEocd) throw new Error("npz: file shorter than EOCD record");
  let eocd = -1;
  const maxScan = Math.min(buffer.length, 65557); // 64K+22
  for (let i = buffer.length - minEocd; i >= buffer.length - maxScan; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("npz: EOCD record not found");
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  while (p < cdEnd) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) break; // central file header sig
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const uncompSize = buffer.readUInt32LE(p + 24);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOff = buffer.readUInt32LE(p + 42);
    const name = buffer.toString("latin1", p + 46, p + 46 + nameLen);
    entries.set(name, {
      offset: localOff,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
      method,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Given a central-directory entry, locate the file payload in its local header
// and return the slice of compressed bytes.
function readZipMemberBytes(buffer, entry) {
  // Local file header: sig 0x04034b50, then 26 bytes header, then name + extra + payload.
  let p = entry.offset;
  if (buffer.readUInt32LE(p) !== 0x04034b50) {
    throw new Error("npz: bad local file header signature");
  }
  const nameLen = buffer.readUInt16LE(p + 26);
  const extraLen = buffer.readUInt16LE(p + 28);
  const payloadStart = p + 30 + nameLen + extraLen;
  return buffer.subarray(payloadStart, payloadStart + entry.compressedSize);
}

function inflateMember(buffer, entry) {
  const raw = readZipMemberBytes(buffer, entry);
  if (entry.method === 0) return raw; // stored / no compression
  if (entry.method !== 8) {
    throw new Error(`npz: unsupported compression method ${entry.method}`);
  }
  // DEFLATE without the zlib wrapper (raw bitstream inside a zip).
  return zlib.inflateRawSync(raw);
}

// loadNpz(path) -> Map<memberName (without trailing .npy), {shape, data}>
function loadNpz(filePath) {
  const buf = fs.readFileSync(filePath);
  const entries = parseZipCentralDirectory(buf);
  const out = new Map();
  for (const [name, entry] of entries) {
    if (!name.endsWith(".npy")) {
      out.set(name, entry); // pass-through for the curious
      continue;
    }
    const inflated = inflateMember(buf, entry);
    const npy = readNpy(inflated);
    out.set(name.slice(0, -4), npy);
  }
  return out;
}

// loadNpy(filePath) -> {shape, data}
function loadNpy(filePath) {
  const buf = fs.readFileSync(filePath);
  return readNpy(buf);
}

// ---- transcriber prefix_conditioning lookup ---------------------------------

// computePrefixBias: reads prefix_tables.npz, looks up descriptor knobs from
// the prefix token sequence, and returns a Float32Array length dModel.
//
// The shipped export sets pervasive_difficulty=false, so the difficulty
// embedding branch is skipped. pervasive_descriptors=true so each of the 5
// descriptor knobs gets looked up from the prefix scan window.
function computePrefixBias(prefixTokens, opts) {
  const { descPrefixScan = 8, pervasiveDifficulty = false, pervasiveDescriptors = true, dModel = 512, tables } = opts;
  const bias = new Float32Array(dModel);
  if (pervasiveDifficulty) {
    let diffId = 0;
    if (prefixTokens.length >= 2 && DIFF_BASE <= prefixTokens[1] && prefixTokens[1] < DIFF_BASE + 4) {
      diffId = prefixTokens[1] - DIFF_BASE;
    }
    const diffTable = tables.get("difficulty_embedding");
    if (!diffTable) throw new Error("computePrefixBias: difficulty_embedding missing from prefix_tables.npz (pervasive_difficulty=true)");
    addRow(bias, diffTable.data, diffTable.shape, diffId);
  }
  if (pervasiveDescriptors) {
    const scan = prefixTokens.slice(0, descPrefixScan);
    const autoBin = DESCRIPTOR_BIN_COUNT - 1;
    for (let knob = 0; knob < N_DESCRIPTORS; knob += 1) {
      const base = DESCRIPTOR_BIN_COUNT * knob;
      let binId = autoBin;
      for (const tok of scan) {
        if (base <= tok && tok < base + DESCRIPTOR_BIN_COUNT) {
          binId = tok - base;
          break;
        }
      }
      const key = `descriptor_embedding_${knob}`;
      const tbl = tables.get(key);
      if (!tbl) throw new Error(`computePrefixBias: ${key} missing from prefix_tables.npz`);
      addRow(bias, tbl.data, tbl.shape, binId);
    }
  }
  return bias;
}

// Add row `rowIdx` of a (rows, ...) C-order array `data` into `acc`.
function addRow(acc, data, shape, rowIdx) {
  if (shape.length === 1) {
    acc[rowIdx] += data[rowIdx];
    return;
  }
  const rowLen = shape.slice(1).reduce((a, b) => a * b, 1);
  const base = rowIdx * rowLen;
  for (let i = 0; i < rowLen; i += 1) acc[i] += data[base + i];
}

// Tiny re-export so this file is the only prefixTables-related import site.
const {
  DIFF_BASE,
  DESCRIPTOR_BIN_COUNT,
  N_DESCRIPTORS,
} = require("./chartEventStream.cjs");

module.exports = {
  readNpy,
  loadNpy,
  loadNpz,
  parseZipCentralDirectory,
  computePrefixBias,
};
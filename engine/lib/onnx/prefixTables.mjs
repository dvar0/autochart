// Tiny pure-JS reader for numpy .npz / .npy files holding fp32 little-endian
// arrays. No external deps, no Python at runtime. The only consumer is the
// transcriber prefix_conditioning sidecar (prefix_tables.npz: descriptor_embedding_0..4,
// each (8, 512) fp32).
//
// The npz container is a standard ZIP archive of .npy streams. We parse the
// ZIP Central Directory once (sufficient to find every member), then take
// each member's bytes: shipped tables are stored, and a DEFLATE member needs
// the caller's inflateRaw. .npy is parsed by reading the magic + version +
// header-len header and then the C-order raw bytes. Input is a Uint8Array, so
// the desktop (file bytes) and the browser (fetched bytes) share this reader.

import {
  DIFF_BASE,
  DESCRIPTOR_BIN_COUNT,
  N_DESCRIPTORS,
} from "./chartEventStream.mjs";

const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // \x93NUMPY

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function latin1(bytes, start, end) {
  let out = "";
  for (let i = start; i < end; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

function readNpy(input) {
  // A Node Buffer's slice() is a view; a plain Uint8Array's slice() copies.
  const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  // Verify magic.
  for (let i = 0; i < NPY_MAGIC.length; i += 1) {
    if (bytes[i] !== NPY_MAGIC[i]) {
      throw new Error(`npy: bad magic at byte ${i}: ${bytes[i]}`);
    }
  }
  const dv = view(bytes);
  let off = NPY_MAGIC.length;
  const major = bytes[off];
  const minor = bytes[off + 1];
  off += 2;
  let headerLen;
  if (major === 1) {
    headerLen = dv.getUint16(off, true);
    off += 2;
  } else if (major === 2) {
    headerLen = dv.getUint32(off, true);
    off += 4;
  } else {
    throw new Error(`npy: unsupported version ${major}.${minor}`);
  }
  const headerEnd = off + headerLen;
  const headerText = latin1(bytes, off, headerEnd);
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
  if (code === "f4") {
    const byteCount = count * 4;
    if (off + byteCount > bytes.length) {
      throw new Error(`npy: truncated payload: need ${byteCount} bytes from offset ${off}, file has ${bytes.length}`);
    }
    // Copy first: a member inside a stored zip need not be 4-byte aligned.
    return { shape, data: new Float32Array(bytes.slice(off, off + byteCount).buffer) };
  }
  // bool (|b1 / ?): numpy stores one byte per element (0/1).
  if (off + count > bytes.length) {
    throw new Error(`npy: truncated payload: need ${count} bytes from offset ${off}, file has ${bytes.length}`);
  }
  return { shape, data: bytes.slice(off, off + count) };
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
function parseZipCentralDirectory(bytes) {
  const dv = view(bytes);
  // End Of Central Directory record: signature 0x06054b50, scan from the end.
  const minEocd = 22;
  if (bytes.length < minEocd) throw new Error("npz: file shorter than EOCD record");
  let eocd = -1;
  const maxScan = Math.min(bytes.length, 65557); // 64K+22
  for (let i = bytes.length - minEocd; i >= bytes.length - maxScan; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("npz: EOCD record not found");
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  while (p < cdEnd) {
    if (dv.getUint32(p, true) !== 0x02014b50) break; // central file header sig
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const uncompSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = latin1(bytes, p + 46, p + 46 + nameLen);
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
function readZipMemberBytes(bytes, entry) {
  const dv = view(bytes);
  // Local file header: sig 0x04034b50, then 26 bytes header, then name + extra + payload.
  const p = entry.offset;
  if (dv.getUint32(p, true) !== 0x04034b50) {
    throw new Error("npz: bad local file header signature");
  }
  const nameLen = dv.getUint16(p + 26, true);
  const extraLen = dv.getUint16(p + 28, true);
  const payloadStart = p + 30 + nameLen + extraLen;
  return bytes.subarray(payloadStart, payloadStart + entry.compressedSize);
}

function inflateMember(bytes, entry, inflateRaw) {
  const raw = readZipMemberBytes(bytes, entry);
  if (entry.method === 0) return raw; // stored / no compression
  if (entry.method !== 8) {
    throw new Error(`npz: unsupported compression method ${entry.method}`);
  }
  // DEFLATE without the zlib wrapper (raw bitstream inside a zip).
  if (!inflateRaw) throw new Error("npz: member is compressed and no inflater was given");
  return inflateRaw(raw);
}

// parseNpz(bytes, { inflateRaw }) -> Map<memberName (without trailing .npy), {shape, data}>
function parseNpz(bytes, { inflateRaw = null } = {}) {
  const entries = parseZipCentralDirectory(bytes);
  const out = new Map();
  for (const [name, entry] of entries) {
    if (!name.endsWith(".npy")) {
      out.set(name, entry); // pass-through for the curious
      continue;
    }
    const inflated = inflateMember(bytes, entry, inflateRaw);
    const npy = readNpy(inflated);
    out.set(name.slice(0, -4), npy);
  }
  return out;
}


// ---- transcriber prefix_conditioning lookup ---------------------------------

// computePrefixBias: reads prefix_tables.npz, looks up descriptor knobs from
// the prefix token sequence, and returns a Float32Array length dModel.
//
// The shipped export sets pervasive_difficulty=false, so the difficulty
// embedding branch is skipped. pervasive_descriptors=true so each of the 5
// descriptor knobs gets looked up from the prefix scan window.
//
// The model (ChartTranscriber._descriptor_ids) finds knob k's token in
// [DESC_BASE + 8k, DESC_BASE + 8k + 8). The original port scanned [8k, 8k + 8),
// which matches BOS as Speed bin 1 and never sees a real knob token. v1 still
// runs that original lookup so its charts stay unchanged until it is switched
// on purpose; models whose manifest sets descriptorTokenBase use the model's.
function computePrefixBias(prefixTokens, opts) {
  const {
    descPrefixScan = 8,
    pervasiveDifficulty = false,
    pervasiveDescriptors = true,
    dModel = 512,
    tables,
    descriptorTokenBase = 0,
  } = opts;
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
      const base = descriptorTokenBase + DESCRIPTOR_BIN_COUNT * knob;
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

export {
  readNpy,
  parseNpz,
  parseZipCentralDirectory,
  computePrefixBias,
};

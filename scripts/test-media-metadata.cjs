#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { openAsBlob } = require("node:fs");
const path = require("node:path");

const u32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
const atom = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), typeof type === "number" ? u32(type) : Buffer.from(type, "latin1"), body]);
};
const textItem = (type, text) => atom(type, atom("data", u32(1), u32(0), Buffer.from(text)));
const quickTimeItem = (type, text) => {
  const body = Buffer.from(text);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(body.length);
  header.writeUInt16BE(0x55c4, 2); // ISO language 'und', UTF-8.
  return atom(type, header, body);
};
const ftyp = atom("ftyp", Buffer.from("qt  "), u32(512), Buffer.from("qt  "));
const itunes = (...items) => atom("moov", atom("udta", atom("meta", u32(0), atom("ilst", ...items))));

// Sparse file double: fixtures can have multi-gigabyte payloads while every
// actual read is small. Reject accidental reads of the media payload itself.
function sparseFile(name, size, pieces, forbidden = []) {
  const file = {
    name, size, bytesRead: 0, reads: 0,
    slice(start, end) {
      end = Math.min(end, size);
      assert.ok(start >= 0 && end >= start);
      for (const [low, high] of forbidden) {
        assert.ok(end <= low || start >= high, "metadata inspection read the media payload");
      }
      file.bytesRead += end - start;
      file.reads += 1;
      const result = Buffer.alloc(end - start);
      for (const [at, bytes] of pieces) {
        const low = Math.max(at, start), high = Math.min(at + bytes.length, end);
        if (high > low) bytes.copy(result, low - start, low - at, high - at);
      }
      return { arrayBuffer: async () => result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) };
    },
    arrayBuffer() { throw new Error("Whole-file read is forbidden"); },
  };
  return file;
}
const u32le = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const smallFile = (name, ...parts) => {
  const bytes = Buffer.concat(parts);
  return sparseFile(name, bytes.length, [[0, bytes]]);
};

// Minimal Ogg muxer (CRC left zero; the reader doesn't check it). Packets are
// laced into pages of at most 255 segments, so a large comment spans pages.
function oggStream(packets, serial = 0x1234) {
  const pages = [];
  let sequence = 0;
  let segments = [];
  let body = [];
  const flush = (continued) => {
    const header = Buffer.alloc(27);
    header.write("OggS", 0, "latin1");
    header[5] = (continued ? 1 : 0) | (sequence === 0 ? 2 : 0);
    header.writeUInt32LE(serial, 14);
    header.writeUInt32LE(sequence++, 18);
    header[26] = segments.length;
    pages.push(header, Buffer.from(segments), ...body);
    segments = [];
    body = [];
  };
  for (const packet of packets) {
    let continued = false;
    for (let at = 0; ; at += 255) {
      const size = Math.min(255, packet.length - at);
      segments.push(size);
      body.push(packet.subarray(at, at + size));
      if (segments.length === 255) { flush(continued); continued = true; }
      if (size < 255) break;
    }
    if (segments.length) flush(continued);
  }
  return Buffer.concat(pages);
}
const vorbisComments = (prefix, fields) => {
  const entries = fields.map((field) => Buffer.from(field));
  return Buffer.concat([prefix, u32le(6), Buffer.from("vendor"), u32le(entries.length),
    ...entries.flatMap((entry) => [u32le(entry.length), entry])]);
};
const flacPicture = (mime, data) => Buffer.concat([u32(3), u32(mime.length), Buffer.from(mime), u32(5), Buffer.from("Cover"),
  u32(0), u32(0), u32(0), u32(0), u32(data.length), data]);

(async () => {
  const { readMediaFileMetadata, MAX_METADATA_SCAN_BYTES } = await import("../src/services/mediaMetadata.js");
  const { buildSourceReplacementRecord } = await import("../src/pages/generate/sourceReplacement.js");
  const read = (file) => readMediaFileMetadata(file, { skipVideoThumbnail: true });
  const artist = "lázaro suplika dopamina, Rafaela Andía Zapater, Mairrot Alexander Lazo de la Vega Neyra";
  const title = "Puchito - Live (feat. Guest)";
  const expected = { title, artist, album: "Puchito", year: "2024" };

  // The actual failing MOV layout: classic text directly inside udta.
  const legacy = atom("moov", atom("udta",
    quickTimeItem("©nam", title), quickTimeItem("©ART", artist),
    quickTimeItem("©alb", "Puchito"), quickTimeItem("©day", "20240926")));
  assert.deepEqual((await read(smallFile("unrelated-filename.mov", ftyp, legacy))).meta, expected);

  const picture = Buffer.from([255, 216, 255, 224, 5, 4, 3, 255, 217]);
  const tags = itunes(textItem("©nam", title), textItem("©ART", artist), textItem("©alb", "Puchito"),
    textItem("©day", "2024-09-26"), atom("covr", atom("data", u32(13), u32(0), picture)));
  for (const name of ["track.m4a", "video.mp4", "video.m4v", "video.mov", "no-extension"]) {
    const info = await read(smallFile(name, ftyp, tags));
    assert.deepEqual(info.meta, expected);
    assert.deepEqual(Buffer.from(await info.albumBlob.arrayBuffer()), picture);
  }

  // moov beyond the old 8 MiB scan window, unsigned 32-bit sizes, and 64-bit sizes.
  for (const [payloadSize, extended] of [[128 * 1024 * 1024, false], [0x80000000, false], [5 * 2 ** 30, true]]) {
    const headerSize = extended ? 16 : 8;
    const mdatSize = payloadSize + headerSize;
    const mdat = extended
      ? Buffer.concat([u32(1), Buffer.from("mdat"), u32(Math.floor(mdatSize / 2 ** 32)), u32(mdatSize % 2 ** 32)])
      : Buffer.concat([u32(mdatSize), Buffer.from("mdat")]);
    const tagOffset = ftyp.length + mdatSize;
    const file = sparseFile("trailing.mp4", tagOffset + tags.length,
      [[0, ftyp], [ftyp.length, mdat], [tagOffset, tags]], [[ftyp.length + headerSize, tagOffset]]);
    assert.deepEqual((await read(file)).meta, expected);
    assert.ok(file.bytesRead < 4096, "must read only atom headers and tags");
  }

  // Indexed mdta keys in ISO and QuickTime meta; keys may follow ilst.
  for (const fullBox of [false, true]) {
    const keys = atom("keys", u32(0), u32(2),
      atom("mdta", Buffer.from(fullBox ? "title" : "com.apple.quicktime.title")),
      atom("mdta", Buffer.from(fullBox ? "artist" : "com.apple.quicktime.artist")));
    const meta = atom("meta", ...(fullBox ? [u32(0)] : []), atom("ilst", textItem(1, title), textItem(2, artist)), keys);
    const info = await read(smallFile("indexed.mov", ftyp, atom("moov", meta)));
    assert.equal(info.meta.title, title);
    assert.equal(info.meta.artist, artist);
  }

  // Malformed sizes must stop safely, without accepting truncated values.
  for (const broken of [
    Buffer.concat([u32(4), Buffer.from("moov")]),
    Buffer.concat([u32(1000), Buffer.from("moov")]),
    Buffer.concat([u32(1), Buffer.from("moov"), u32(0xffffffff), u32(0xffffffff)]),
    itunes(atom("©ART", Buffer.concat([u32(1000), Buffer.from("data"), u32(1), u32(0), Buffer.from("partial")]))),
    atom("moov", atom("udta", atom("©ART", Buffer.from([255, 255, 0x55, 0xc4, 65])))),
  ]) {
    const info = await read(smallFile("fallback-name.mov", ftyp, broken));
    assert.equal(info.meta.artist, "");
    assert.equal(info.meta.title, "fallback name");
  }
  const zeroSized = Buffer.from(tags);
  zeroSized.writeUInt32BE(0);
  assert.deepEqual((await read(smallFile("to-eof.mp4", ftyp, zeroSized))).meta, expected);
  let nested = tags;
  for (let i = 0; i < 30; i += 1) nested = atom("moov", nested);
  assert.equal((await read(smallFile("deep.mp4", ftyp, nested))).meta.artist, "");
  const crowded = smallFile("many.mp4", ftyp, ...Array.from({ length: 5000 }, () => atom("free")));
  await read(crowded);
  assert.ok(crowded.reads < 4200, "atom traversal must be bounded");
  assert.ok(crowded.bytesRead < MAX_METADATA_SCAN_BYTES);

  // Existing ID3 audio support and the filename fallback still work.
  const frame = (id, text) => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(text)]);
    return Buffer.concat([Buffer.from(id), u32(body.length), Buffer.alloc(2), body]);
  };
  const body = Buffer.concat([frame("TIT2", title), frame("TPE1", artist)]);
  const syncSize = Buffer.from([(body.length >> 21) & 127, (body.length >> 14) & 127, (body.length >> 7) & 127, body.length & 127]);
  const mp3 = await read(smallFile("audio.mp3", Buffer.from("ID3\x03\0\0", "latin1"), syncSize, body));
  assert.equal(mp3.meta.title, title);
  assert.equal(mp3.meta.artist, artist);

  // ID3 details taggers really write: big-endian UTF-16, v2.4 multiple values,
  // an extended header, unsynchronisation, loosely typed covers, and a tag in
  // front of a FLAC stream.
  const synchsafe = (n) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
  const id3 = (version, flags, ...frames) => {
    const tagBody = Buffer.concat(frames);
    return Buffer.concat([Buffer.from("ID3", "latin1"), Buffer.from([version, 0, flags]), synchsafe(tagBody.length), tagBody]);
  };
  const rawFrame = (id, frameBody, version = 3) =>
    Buffer.concat([Buffer.from(id), version === 4 ? synchsafe(frameBody.length) : u32(frameBody.length), Buffer.alloc(2), frameBody]);
  const utf16be = Buffer.concat([Buffer.from([1, 0xfe, 0xff]), Buffer.from(title, "utf16le").swap16()]);
  const utf16le = Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(artist, "utf16le")]);
  let tagged = await read(smallFile("be.mp3", id3(3, 0, rawFrame("TIT2", utf16be), rawFrame("TPE1", utf16le))));
  assert.equal(tagged.meta.title, title, "UTF-16 big-endian text");
  assert.equal(tagged.meta.artist, artist);
  tagged = await read(smallFile("multi.mp3", id3(4, 0, rawFrame("TPE1", Buffer.from("\x03One\0Two\0", "latin1"), 4))));
  assert.equal(tagged.meta.artist, "One, Two", "v2.4 values are null-separated");
  const extended = Buffer.concat([u32(6), Buffer.alloc(6)]);
  tagged = await read(smallFile("ext.mp3", id3(3, 0x40, extended, frame("TIT2", title))));
  assert.equal(tagged.meta.title, title, "extended header is skipped");
  const cover = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0x00, 0xff, 0xd9]);
  const apic = (mime) => rawFrame("APIC", Buffer.concat([Buffer.from([0]), Buffer.from(mime), Buffer.from([0, 3, 0]), cover]));
  // Unsynchronised: every 0xFF is followed by an inserted zero.
  const unsync = (bytes) => Buffer.from([...bytes].flatMap((byte) => byte === 0xff ? [0xff, 0] : [byte]));
  tagged = await read(smallFile("unsync.mp3", id3(3, 0x80, unsync(Buffer.concat([frame("TIT2", title), apic("image/jpeg")])))));
  assert.equal(tagged.meta.title, title);
  assert.deepEqual(Buffer.from(await tagged.albumBlob.arrayBuffer()), cover, "unsynchronised cover");
  tagged = await read(smallFile("loose.mp3", id3(3, 0, apic("JPG"))));
  assert.equal(tagged.albumBlob?.type, "image/jpeg", "cover type comes from its bytes");
  tagged = await read(smallFile("heic.mp3", id3(3, 0, rawFrame("APIC", Buffer.concat([Buffer.from("\0image/heic\0\x03\0", "latin1"), Buffer.from("....ftypheic")])))));
  assert.equal(tagged.albumBlob, null, "covers the library can't keep are left out");
  const flacBlock = (type, blockBody, last) => Buffer.concat([Buffer.from([(last ? 0x80 : 0) | type, 0, (blockBody.length >> 8) & 255, blockBody.length & 255]), blockBody]);
  const flacComments = Buffer.concat([u32le(6), Buffer.from("vendor"), u32le(1), u32le(Buffer.byteLength(`TITLE=${title}`)), Buffer.from(`TITLE=${title}`)]);
  const flacStream = Buffer.concat([Buffer.from("fLaC"), flacBlock(0, Buffer.alloc(34), false), flacBlock(4, flacComments, true)]);
  tagged = await read(smallFile("prefixed.flac", id3(3, 0, frame("TIT2", "ID3 title"), frame("TPE1", artist)), flacStream));
  assert.equal(tagged.meta.title, title, "FLAC tags behind an ID3 tag");
  assert.equal(tagged.meta.artist, artist, "ID3 fills what the FLAC tags leave out");

  const source = smallFile("unrelated-filename.mov", ftyp, legacy);

  // Ogg Opus (.opus/.ogx) and Ogg Vorbis: cover art large enough to span pages.
  const oggArt = Buffer.concat([Buffer.from([255, 216, 255, 224]), Buffer.alloc(120000, 7), Buffer.from([255, 217])]);
  const oggFields = [`TITLE=${title}`, `ARTIST=${artist}`, "ALBUM=Puchito", "DATE=2024",
    `METADATA_BLOCK_PICTURE=${flacPicture("image/jpeg", oggArt).toString("base64")}`];
  const audioPacket = Buffer.alloc(400, 1);
  for (const [name, head, prefix] of [
    ["track.ogx", Buffer.from("OpusHead\x01\x02\x38\x01\x80\xbb\x00\x00\x00\x00\x00", "latin1"), Buffer.from("OpusTags")],
    ["track.opus", Buffer.from("OpusHead\x01\x02\x38\x01\x80\xbb\x00\x00\x00\x00\x00", "latin1"), Buffer.from("OpusTags")],
    ["track.ogg", Buffer.from("\x01vorbis", "latin1"), Buffer.from("\x03vorbis", "latin1")],
  ]) {
    const info = await read(smallFile(name, oggStream([head, vorbisComments(prefix, oggFields), audioPacket])));
    assert.deepEqual(info.meta, expected, `${name} tags`);
    assert.equal(info.albumBlob?.type, "image/jpeg", `${name} embedded cover`);
    assert.deepEqual(Buffer.from(await info.albumBlob.arrayBuffer()), oggArt, `${name} cover bytes`);
  }
  const record = buildSourceReplacementRecord({ file: source, mediaInfo: await read(source), backgroundType: "video" });
  assert.equal(record.meta.title, title, "embedded title punctuation must survive project creation");
  assert.equal(record.meta.artist, artist);
  assert.equal(buildSourceReplacementRecord({ file: source }).meta.title, "unrelated filename");

  // Optional real files for local diagnosis; never copy personal media into fixtures.
  for (const sourcePath of process.argv.slice(2)) {
    const blob = await openAsBlob(sourcePath);
    Object.defineProperty(blob, "name", { value: path.basename(sourcePath) });
    const info = await read(blob);
    assert.ok(info.raw.meta.artist, "real file artist missing");
    assert.ok(info.raw.meta.title, "real file title missing");
    console.log(path.basename(sourcePath), JSON.stringify(info.meta));
  }
  console.log("Media metadata: QuickTime, iTunes, mdta, trailing tags, bounded reads, malformed files, ID3 (UTF-16, v2.4, extended headers, unsync, FLAC prefix), Ogg Opus/Vorbis, and project metadata passed.");
})().catch((error) => { console.error(error); process.exitCode = 1; });

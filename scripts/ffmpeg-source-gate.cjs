"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const tar = require("tar");
const { readBuild, recipeHash, fileHash } = require("./prepare-ffmpeg.cjs");
const inputs = require("./ffmpeg-sources.json");

// Inspect a small, ordinary tar.gz without extracting anything to disk.
// The nested upstream archives must be byte-for-byte the pinned build inputs.
async function inspectFfmpegSourceArchive(archive, { target = { platform: process.platform, arch: process.arch }, build = readBuild(target) } = {}) {
  if (fs.lstatSync(archive).size > 64 * 1024 * 1024) throw new Error("FFmpeg source archive exceeds size limit.");
  if (fileHash(archive) !== build.sourceSha256) throw new Error("FFmpeg source archive checksum mismatch.");
  const expected = new Map(inputs.sources.map((source) => [source.name, source.sha256]));
  for (const name of ["ffmpeg-build.sh", "ffmpeg-sources.json"]) expected.set(name, fileHash(path.join(__dirname, name)));
  const allowed = new Set([...expected.keys(), "README.txt", "config.log", "config.h", "build-info.json"]);
  const seen = new Set();
  const checks = [];
  let totalBytes = 0;
  let failure;
  await tar.t({ file: archive, strict: true, onentry(entry) {
    const name = entry.path;
    if (!allowed.has(name) || seen.has(name) || entry.type !== "File") failure ||= new Error(`Unexpected FFmpeg source entry: ${name}`);
    seen.add(name);
    totalBytes += entry.size;
    if (totalBytes > 64 * 1024 * 1024) failure ||= new Error("FFmpeg source archive exceeds size limit.");
    const digest = crypto.createHash("sha256");
    const metadata = [];
    checks.push(new Promise((resolve, reject) => {
      entry.on("data", (chunk) => {
        digest.update(chunk);
        if (name === "build-info.json" && entry.size <= 8192) metadata.push(chunk);
      });
      entry.on("error", reject);
      entry.on("end", () => {
        try {
          if (expected.has(name) && digest.digest("hex") !== expected.get(name)) throw new Error(`FFmpeg source input checksum mismatch: ${name}`);
          if (name === "build-info.json") {
            const info = JSON.parse(Buffer.concat(metadata));
            if (info.target !== `${target.platform}-${target.arch}` || info.recipeSha256 !== recipeHash() || info.executableSha256 !== build.executableSha256) throw new Error("FFmpeg source build does not match the executable/target/recipe.");
          }
        } catch (error) { failure ||= error; }
        resolve();
      });
    }));
  } });
  await Promise.all(checks);
  if (failure) throw failure;
  for (const name of allowed) if (!seen.has(name)) throw new Error(`Missing FFmpeg source entry: ${name}`);
  return { entries: [...seen], totalBytes };
}
module.exports = { inspectFfmpegSourceArchive };

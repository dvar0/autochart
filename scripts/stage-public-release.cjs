#!/usr/bin/env node
"use strict";

// Consolidate completed native release gates; never rebuild or alter their bytes.
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { gunzipSync } = require("node:zlib");
const { execFileSync } = require("node:child_process");
const AdmZip = require("adm-zip");
const { sha256File } = require("./create-source-release.cjs");

const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const targets = [
  { id: "linux-x64", os: "linux", binaries: ["linux-x86_64.AppImage"] },
  { id: "win32-x64", os: "windows", binaries: ["win-x64.exe", "win-x64.zip"] },
  { id: "darwin-arm64", os: "macos", binaries: ["arm64.dmg"] },
];

function checksums(text) {
  const entries = new Map();
  for (const line of text.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([^/\\\r\n]+)$/.exec(line);
    if (!match || entries.has(match[2])) throw new Error("Invalid or duplicate checksum entry");
    entries.set(match[2], match[1]);
  }
  return entries;
}

async function regularFile(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected regular file: ${file}`);
}

async function readFile(file) {
  await regularFile(file);
  return fs.readFile(file);
}

function archiveCommit(bytes) {
  const header = gunzipSync(bytes).subarray(0, 1024);
  const commit = execFileSync("git", ["get-tar-commit-id"], { input: header, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Application source lacks a Git archive commit");
  return commit;
}

async function stagePublicRelease({ output, inputs, version = require("../package.json").version }) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid release version");
  if (!output || inputs?.length !== targets.length) throw new Error("Supply a new output directory and three native artifact directories");
  output = path.resolve(output);
  const prefix = `Autochart-${version}`;
  const bundleName = `${prefix}-sources.zip`;
  const bundled = new Map();
  const binaries = [];
  const manifest = { version, commit: null, targets: [] };
  const seen = new Set();

  for (const input of inputs) {
    const sumsBytes = await readFile(path.join(input, "SHA256SUMS.txt"));
    const sums = checksums(sumsBytes.toString("utf8"));
    const matches = targets.filter((target) => target.binaries.every((name) => sums.has(`${prefix}-${name}`)));
    if (matches.length !== 1 || seen.has(matches[0].id)) throw new Error("Missing, ambiguous, or duplicate native target");
    const target = matches[0];
    seen.add(target.id);
    const sourceName = `${prefix}-source.tar.gz`;
    const ffmpegName = `${prefix}-${target.os}-${target.id.split("-")[1]}-ffmpeg-corresponding-source.tar.gz`;
    const sourcePaths = [];

    for (const name of [sourceName, ffmpegName]) {
      const bytes = await readFile(path.join(input, name));
      const hash = digest(bytes);
      if (sums.get(name) !== hash) throw new Error(`Checksum mismatch: ${target.id}/${name}`);
      const sidecar = await readFile(path.join(input, `${name}.sha256`));
      const sidecarSums = checksums(sidecar.toString("utf8"));
      if (sidecarSums.size !== 1 || sidecarSums.get(name) !== hash) throw new Error(`Source sidecar mismatch: ${name}`);
      if (name === sourceName) {
        const commit = archiveCommit(bytes);
        if (manifest.commit && manifest.commit !== commit) throw new Error("Native builds use different source commits");
        manifest.commit = commit;
      }
      const entry = `${target.id}/${name}`;
      bundled.set(entry, bytes);
      bundled.set(`${entry}.sha256`, sidecar);
      sourcePaths.push(entry);
    }
    const notice = await readFile(path.join(input, "UNSIGNED-RELEASE.txt"));
    if (!notice.toString("utf8").includes(`Target: ${target.id}`)) throw new Error(`Wrong unsigned notice: ${target.id}`);
    bundled.set(`${target.id}/UNSIGNED-RELEASE.txt`, notice);
    // Retain original verification records, including checksums for omitted blockmaps.
    bundled.set(`${target.id}/SHA256SUMS.txt`, sumsBytes);
    const targetBinaries = [];
    for (const suffix of target.binaries) {
      const name = `${prefix}-${suffix}`;
      const file = path.join(input, name);
      await regularFile(file);
      const hash = await sha256File(file);
      if (sums.get(name) !== hash) throw new Error(`Checksum mismatch: ${name}`);
      binaries.push({ name, file, sha256: hash });
      targetBinaries.push({ name, sha256: hash });
    }
    manifest.targets.push({ target: target.id, binaries: targetBinaries, applicationSource: sourcePaths[0], ffmpegSource: sourcePaths[1] });
  }
  manifest.targets.sort((a, b) => a.target.localeCompare(b.target));
  bundled.set("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  bundled.set("README.txt", Buffer.from(
    `Autochart ${version}: exact application and FFmpeg sources for all downloads\n\n` +
    "See manifest.json for each installer's SHA-256 and matching source archive paths.\n" +
    "Each platform folder preserves its original source archives, checksum sidecars,\n" +
    "unsigned notice, and native verification checksum list without modification.\n" +
    "Application archives share a Git commit; checkout line endings may differ.\n" +
    "Extract the matching archives for source, licenses, and build instructions.\n\n" +
    "SHA256SUMS.txt at this ZIP's root verifies every other file inside this ZIP.\n" +
    "Platform checksum lists describe original CI outputs, including installers and\n" +
    "unused update metadata not stored in this source bundle. Installers are separate\n" +
    "release downloads. The release's outer SHA256SUMS.txt verifies those and this ZIP.\n"
  ));
  bundled.set("SHA256SUMS.txt", Buffer.from([...bundled].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, bytes]) => `${digest(bytes)}  ${name}\n`).join("")));

  const zip = new AdmZip();
  for (const [name, bytes] of bundled) {
    zip.addFile(name, bytes);
    zip.getEntry(name).header.time = new Date(2000, 0, 1);
  }
  // mkdir without recursive refuses existing destinations; cleanup owns only this directory.
  await fs.mkdir(output);
  try {
    const bundlePath = path.join(output, bundleName);
    await fs.writeFile(bundlePath, zip.toBuffer(), { flag: "wx" });
    const reopened = new AdmZip(bundlePath);
    if (reopened.getEntries().length !== bundled.size) throw new Error("Source bundle entry count changed");
    for (const [name, bytes] of bundled) {
      if (!reopened.getEntry(name)?.getData().equals(bytes)) throw new Error(`Source bundle changed: ${name}`);
    }
    const published = [{ name: bundleName, sha256: await sha256File(bundlePath) }];
    for (const binary of binaries) {
      const destination = path.join(output, binary.name);
      await fs.copyFile(binary.file, destination, fs.constants.COPYFILE_EXCL);
      if (await sha256File(destination) !== binary.sha256) throw new Error(`Copied binary changed: ${binary.name}`);
      published.push(binary);
    }
    await fs.writeFile(path.join(output, "SHA256SUMS.txt"), published.sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, sha256 }) => `${sha256}  ${name}\n`).join(""), { flag: "wx" });
  } catch (error) {
    await fs.rm(output, { recursive: true, force: true });
    throw error;
  }
  return { output, bundleName, commit: manifest.commit, files: (await fs.readdir(output)).sort() };
}

if (require.main === module) {
  const [output, ...inputs] = process.argv.slice(2);
  stagePublicRelease({ output, inputs }).then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { stagePublicRelease };

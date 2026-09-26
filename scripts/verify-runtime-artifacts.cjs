"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const manifest = require("./runtime-artifacts.json");
const { supportedTarget: sharedSupportedTarget } = require("../config/supported-targets.cjs");
const ARCH_NAMES = ["ia32", "x64", "armv7l", "arm64", "universal"];

function targetArch(value) {
  return typeof value === "number" ? ARCH_NAMES[value] : String(value || "");
}

function targetKey(platform, arch) {
  return `${platform}-${targetArch(arch)}`;
}
function supportedTarget(platform, arch) {
  return sharedSupportedTarget(platform, targetArch(arch));
}

function targetSpecification(kind, platform, arch) {
  const key = targetKey(platform, arch);
  if (!supportedTarget(platform, arch)) {
    throw new Error(`Target ${key} is not a supported generation target in this release.`);
  }
  const specification = manifest[kind]?.targets?.[key];
  if (!specification) throw new Error(`${kind} is not pinned for target ${key}.`);
  return { key, specification };
}

function sha256FileSync(filePath) {
  const handle = fs.openSync(filePath, "r");
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

function assertPinnedFileSync(filePath, expected, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`${label} is missing: ${filePath}`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular, non-symlink file: ${filePath}`);
  }
  if (Number.isSafeInteger(expected.size) && stat.size !== expected.size) {
    throw new Error(`${label} size mismatch: expected ${expected.size}, received ${stat.size}.`);
  }
  const actualSha256 = sha256FileSync(filePath);
  if (actualSha256 !== expected.sha256) {
    throw new Error(`${label} checksum mismatch: expected ${expected.sha256}, received ${actualSha256}.`);
  }
  return actualSha256;
}

function verifyFfmpegInstallation({ projectDir = process.cwd(), platform = process.platform, arch = process.arch } = {}) {
  targetSpecification("ffmpeg", platform, arch);
  return require("./prepare-ffmpeg.cjs").readBuild({ projectDir, platform, arch }).executable;
}

module.exports = {
  assertPinnedFileSync,
  manifest,
  sha256FileSync,
  supportedTarget,
  targetArch,
  targetKey,
  targetSpecification,
  verifyFfmpegInstallation,
};

if (require.main === module) {
  try {
    const executable = verifyFfmpegInstallation();
    console.log(`Pinned FFmpeg artifact verified: ${executable}`);
  } catch (error) {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  }
}

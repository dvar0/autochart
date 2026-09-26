#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const REQUIRED_SOURCE_PATHS = Object.freeze([
  "LICENSE",
  "package.json",
  "package-lock.json",
  "electron/main.cjs",
  "engine/manifest.json",
  "scripts/release-verify.cjs",
]);

function runGit(args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const child = spawn("git", args, {
      cwd: ROOT,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
      windowsHide: true,
    });
    if (capture) child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(capture ? Buffer.concat(chunks).toString("utf8") : "");
      else reject(new Error(`git ${args[0]} failed (exit ${code ?? "none"}${signal ? `, ${signal}` : ""})`));
    });
  });
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fsSync.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function assertPublicSourceState(version) {
  const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], { capture: true });
  if (status.trim()) {
    throw new Error(
      "Public source archives require a clean Git worktree. Commit or remove every tracked and untracked source change first."
    );
  }

  const tags = (await runGit(["tag", "--points-at", "HEAD"], { capture: true }))
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (!tags.includes(`v${version}`)) {
    throw new Error(`Public release commit must have the exact v${version} tag.`);
  }

  for (const sourcePath of REQUIRED_SOURCE_PATHS) {
    await runGit(["cat-file", "-e", `HEAD:${sourcePath}`]);
  }
}

async function createSourceRelease({ releaseDir = path.join(ROOT, "release"), verifyState = true } = {}) {
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8"));
  const version = String(manifest.version || "").trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid package version for source archive: ${version || "<missing>"}`);
  }
  if (verifyState) await assertPublicSourceState(version);

  await fs.mkdir(releaseDir, { recursive: true });
  const archiveName = `Autochart-${version}-source.tar.gz`;
  const archivePath = path.join(releaseDir, archiveName);
  const checksumPath = `${archivePath}.sha256`;
  const temporaryPath = `${archivePath}.tmp-${process.pid}`;
  await fs.rm(temporaryPath, { force: true });
  try {
    await runGit([
      "archive",
      "--format=tar.gz",
      `--prefix=Autochart-${version}/`,
      `--output=${temporaryPath}`,
      "HEAD",
    ]);
    await fs.rename(temporaryPath, archivePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }

  const digest = await sha256File(archivePath);
  await fs.writeFile(checksumPath, `${digest}  ${archiveName}\n`, "utf8");
  console.log(`Created ${archivePath}`);
  console.log(`Created ${checksumPath}`);
  return { archivePath, checksumPath, digest, version };
}

if (require.main === module) {
  createSourceRelease().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_SOURCE_PATHS,
  assertPublicSourceState,
  createSourceRelease,
  sha256File,
};

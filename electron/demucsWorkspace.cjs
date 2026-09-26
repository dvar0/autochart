"use strict";

const fs = require("fs/promises");
const path = require("path");

const AUDIO_SHA256_RE = /^[a-f0-9]{64}$/i;
const SEPARATION_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,63})$/i;

function assertAudioSha256(value) {
  const hash = String(value || "").trim();
  if (!AUDIO_SHA256_RE.test(hash)) {
    throw new Error("Invalid cached audio hash for Demucs workspace.");
  }
  return hash.toLowerCase();
}

function assertSeparationId(value) {
  const id = String(value || "").trim();
  if (!SEPARATION_ID_RE.test(id)) {
    throw new Error("Demucs separation ID must be a safe 1-64 character slug.");
  }
  return id;
}

function isStrictlyInside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function separationIdFromPayload(value, defaultId) {
  const separation = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return assertSeparationId(separation.engineId || separation.id || defaultId);
}

async function ensureRealDirectory(directory) {
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Demucs workspace contains a non-directory or symbolic-link component.");
    }
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    await fs.mkdir(directory);
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Demucs workspace contains a non-directory or symbolic-link component.");
    }
  }
}

async function ensureContainedDirectory(ownedRoot, targetDirectory, { create = true } = {}) {
  const root = path.resolve(String(ownedRoot || ""));
  const target = path.resolve(String(targetDirectory || ""));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Demucs workspace directory must be strictly inside the Autochart engine cache.");
  }
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Autochart engine cache root must be a real directory.");
  }
  const canonicalRoot = await fs.realpath(root);
  let current = canonicalRoot;
  for (const part of relative.split(path.sep)) {
    const next = path.join(current, part);
    if (create) {
      await ensureRealDirectory(next);
    } else {
      const stat = await fs.lstat(next);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Demucs workspace contains a non-directory or symbolic-link component.");
      }
    }
    const canonicalNext = await fs.realpath(next);
    if (!isStrictlyInside(canonicalRoot, canonicalNext)) {
      throw new Error("Demucs workspace escapes the Autochart engine cache.");
    }
    current = canonicalNext;
  }
  return current;
}

async function assertSafeLeaf(parentDirectory, leafPath, { allowMissing = true } = {}) {
  const parent = path.resolve(String(parentDirectory || ""));
  const candidate = path.resolve(String(leafPath || ""));
  if (path.dirname(candidate) !== parent) {
    throw new Error("Demucs workspace leaf must be an immediate child of its real directory.");
  }
  const parentStat = await fs.lstat(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error("Demucs workspace leaf parent must be a real directory.");
  }
  const canonicalParent = await fs.realpath(parent);
  let stat;
  try {
    stat = await fs.lstat(candidate);
  } catch (err) {
    if (err?.code === "ENOENT" && allowMissing) return candidate;
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Demucs workspace leaf must be a real regular file, not a link or directory.");
  }
  const canonicalLeaf = await fs.realpath(candidate);
  if (!isStrictlyInside(canonicalParent, canonicalLeaf)) {
    throw new Error("Demucs workspace leaf escapes its real directory.");
  }
  return canonicalLeaf;
}

async function resolveDemucsWorkspace(ownedEngineCacheRoot, audioSha256, separationId) {
  const root = path.resolve(String(ownedEngineCacheRoot || ""));
  await fs.mkdir(root, { recursive: true });
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Autochart engine cache root must be a real directory.");
  }
  const canonicalRoot = await fs.realpath(root);
  const parts = [
    "features",
    "fretformer_demucs_v1",
    assertAudioSha256(audioSha256),
    assertSeparationId(separationId),
  ];
  let current = canonicalRoot;
  for (const part of parts) {
    const next = path.join(current, part);
    await ensureRealDirectory(next);
    const canonicalNext = await fs.realpath(next);
    if (!isStrictlyInside(canonicalRoot, canonicalNext)) {
      throw new Error("Demucs workspace escapes the Autochart engine cache.");
    }
    current = canonicalNext;
  }
  return current;
}

module.exports = {
  assertAudioSha256,
  assertSafeLeaf,
  assertSeparationId,
  ensureContainedDirectory,
  resolveDemucsWorkspace,
  separationIdFromPayload,
};

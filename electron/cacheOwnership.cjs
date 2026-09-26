"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { CACHE_DIR_NAME } = require("./settingsStore.cjs");
const { readVerifiedFile, sameIdentity } = require("./fileSafety.cjs");

const CACHE_MARKER_NAME = ".autochart-cache-owned.json";
const CACHE_MARKER = Object.freeze({
  application: "app.autochart.desktop",
  purpose: "disposable-cache",
  schemaVersion: 1,
});

function comparable(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return comparable(left) === comparable(right);
}

function isStrictChild(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveCachePaths(settings = {}) {
  const parent = String(settings.cacheParentFolder || "").trim();
  const configured = String(settings.cacheFolder || "").trim();
  if (!parent || !configured) throw new Error("No cache folder is configured.");

  const resolvedParent = path.resolve(parent);
  const resolvedTarget = path.resolve(configured);
  const expectedTarget = path.resolve(resolvedParent, CACHE_DIR_NAME);
  if (!samePath(resolvedTarget, expectedTarget) || !isStrictChild(resolvedParent, resolvedTarget)) {
    throw new Error("The configured cache path is not Autochart's owned cache directory.");
  }
  if (samePath(resolvedParent, path.parse(resolvedParent).root)) {
    throw new Error("The filesystem root cannot be used as the cache parent folder.");
  }
  return { parent: resolvedParent, target: resolvedTarget };
}

function assertNotDangerous(target, dangerousPaths = []) {
  if (samePath(target, path.parse(path.resolve(target)).root)) {
    throw new Error("Refusing to operate on a filesystem root as cache storage.");
  }
  for (const candidate of dangerousPaths) {
    if (candidate && samePath(target, candidate)) {
      throw new Error(`Refusing to operate on protected path: ${path.resolve(candidate)}`);
    }
  }
}

async function readMarker(markerPath) {
  let read;
  try {
    read = await readVerifiedFile(markerPath, {
      label: "Cache ownership marker",
      maxBytes: 16 * 1024,
      requireUnlinked: true,
    });
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    if (/real regular file/.test(err.message || "")) {
      throw new Error(`The cache ownership marker is not an unlinked regular file: ${markerPath}`);
    }
    throw new Error(`The cache ownership marker is unreadable: ${markerPath}`);
  }
  let marker;
  try {
    marker = JSON.parse(read.data.toString("utf8"));
  } catch {
    throw new Error(`The cache ownership marker is unreadable: ${markerPath}`);
  }
  if (
    marker?.application !== CACHE_MARKER.application ||
    marker?.purpose !== CACHE_MARKER.purpose ||
    marker?.schemaVersion !== CACHE_MARKER.schemaVersion
  ) {
    throw new Error(`The cache ownership marker is invalid: ${markerPath}`);
  }
  return { marker, identity: read.identity };
}

async function inspectCacheDirectory(settings, dangerousPaths = []) {
  const configured = resolveCachePaths(settings);
  await fs.mkdir(configured.parent, { recursive: true });
  const canonicalParent = await fs.realpath(configured.parent);
  if (samePath(canonicalParent, path.parse(canonicalParent).root)) {
    throw new Error("The filesystem root cannot be used as the cache parent folder.");
  }
  const expectedTarget = path.join(canonicalParent, CACHE_DIR_NAME);
  assertNotDangerous(expectedTarget, dangerousPaths);

  let stat;
  try {
    stat = await fs.lstat(configured.target);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {
        ...configured,
        canonicalParent,
        canonicalTarget: expectedTarget,
        markerPath: path.join(expectedTarget, CACHE_MARKER_NAME),
        exists: false,
      };
    }
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("The Autochart cache path must be a real directory, not a link or file.");
  }

  const canonicalTarget = await fs.realpath(configured.target);
  if (!samePath(canonicalTarget, expectedTarget) || !isStrictChild(canonicalParent, canonicalTarget)) {
    throw new Error("The Autochart cache directory escapes its configured parent folder.");
  }
  assertNotDangerous(canonicalTarget, dangerousPaths);
  return {
    ...configured,
    canonicalParent,
    canonicalTarget,
    markerPath: path.join(canonicalTarget, CACHE_MARKER_NAME),
    device: stat.dev,
    inode: stat.ino,
    exists: true,
  };
}

async function prepareOwnedCacheDirectory(settings, dangerousPaths = []) {
  let inspected = await inspectCacheDirectory(settings, dangerousPaths);
  if (!inspected.exists) {
    try {
      await fs.mkdir(inspected.canonicalTarget);
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
    inspected = await inspectCacheDirectory(settings, dangerousPaths);
  }

  const markerRead = await readMarker(inspected.markerPath);
  if (!markerRead) {
    const entries = await fs.readdir(inspected.canonicalTarget);
    if (entries.length > 0) {
      const racedMarker = await readMarker(inspected.markerPath);
      if (racedMarker) {
        return {
          path: inspected.canonicalTarget,
          markerPath: inspected.markerPath,
          markerIdentity: racedMarker.identity,
        };
      }
      throw new Error(
        `Refusing to claim a non-empty directory as Autochart cache storage: ${inspected.canonicalTarget}`
      );
    }
    try {
      await fs.writeFile(
        inspected.markerPath,
        `${JSON.stringify(CACHE_MARKER, null, 2)}\n`,
        { encoding: "utf8", flag: "wx" }
      );
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
  }
  const trustedMarker = await readMarker(inspected.markerPath);
  if (!trustedMarker) throw new Error(`Cache ownership marker disappeared: ${inspected.markerPath}`);
  return {
    path: inspected.canonicalTarget,
    markerPath: inspected.markerPath,
    markerIdentity: trustedMarker.identity,
  };
}

async function assertOwnedCacheDirectory(settings, dangerousPaths = []) {
  const inspected = await inspectCacheDirectory(settings, dangerousPaths);
  const marker = inspected.exists ? await readMarker(inspected.markerPath) : null;
  if (!inspected.exists || !marker) {
    throw new Error(`Refusing to clear an unowned cache directory: ${inspected.canonicalTarget}`);
  }
  return {
    path: inspected.canonicalTarget,
    markerPath: inspected.markerPath,
    markerIdentity: marker.identity,
    canonicalParent: inspected.canonicalParent,
    device: inspected.device,
    inode: inspected.inode,
  };
}

async function clearOwnedCacheDirectory(settings, expectedPath, dangerousPaths = [], options = {}) {
  const configured = resolveCachePaths(settings);
  if (!expectedPath || !samePath(expectedPath, configured.target)) {
    throw new Error("The confirmed cache path no longer matches the configured cache path.");
  }

  const owned = await assertOwnedCacheDirectory(settings, dangerousPaths);
  await options.beforeRename?.(owned);
  const quarantine = path.join(
    owned.canonicalParent,
    `.${CACHE_DIR_NAME}.quarantine-${process.pid}-${crypto.randomUUID()}`
  );
  await fs.rename(owned.path, quarantine);

  let verified = false;
  try {
    const stat = await fs.lstat(quarantine);
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.dev !== owned.device ||
      stat.ino !== owned.inode
    ) {
      throw new Error("Cache identity changed before quarantine.");
    }
    const quarantineMarker = await readMarker(path.join(quarantine, CACHE_MARKER_NAME));
    if (!quarantineMarker || !sameIdentity(owned.markerIdentity, quarantineMarker.identity, { includeTimes: false })) {
      throw new Error("Cache ownership marker changed before quarantine.");
    }
    verified = true;
  } catch (err) {
    try {
      await fs.rename(quarantine, owned.path);
    } catch {
      throw new Error(`Cache verification failed; quarantine preserved at ${quarantine}. ${err.message}`);
    }
    throw err;
  }
  if (!verified) throw new Error("Cache quarantine verification failed.");
  await fs.rm(quarantine, { recursive: true, force: false });
  return prepareOwnedCacheDirectory(settings, dangerousPaths);
}

module.exports = {
  CACHE_MARKER,
  CACHE_MARKER_NAME,
  assertOwnedCacheDirectory,
  clearOwnedCacheDirectory,
  isStrictChild,
  prepareOwnedCacheDirectory,
  resolveCachePaths,
};

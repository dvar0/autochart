"use strict";

const fs = require("fs");
const fsPromises = require("fs/promises");
const path = require("path");
const { pipeline } = require("stream/promises");
const tar = require("tar");
const yauzl = require("yauzl");
const { removeVerifiedDirectory, removeVerifiedPath } = require("./fileSafety.cjs");

const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 4096,
  maxEntryBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  maxDecompressionRatio: 200,
});
const AMBIGUOUS_SEPARATORS_RE = /[\\\u2044\u2215\uff0f]/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

function normalizeRelativePath(value, { directory = false } = {}) {
  const raw = String(value ?? "");
  if (!raw || raw !== raw.normalize("NFC")) throw new Error(`Archive path is empty or not NFC-normalized: ${JSON.stringify(raw)}`);
  if (CONTROL_RE.test(raw)) throw new Error(`Archive path contains control characters: ${JSON.stringify(raw)}`);
  if (AMBIGUOUS_SEPARATORS_RE.test(raw)) throw new Error(`Archive path uses an ambiguous separator: ${raw}`);
  if (raw.startsWith("/") || path.posix.isAbsolute(raw) || path.win32.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    throw new Error(`Archive path must be relative: ${raw}`);
  }

  let candidate = raw;
  if (directory && candidate.endsWith("/")) candidate = candidate.slice(0, -1);
  if (!candidate || (!directory && candidate.endsWith("/"))) throw new Error(`Invalid archive entry path: ${raw}`);
  const parts = candidate.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Archive path contains an empty, dot, or traversal segment: ${raw}`);
  }
  for (const part of parts) {
    const base = part.split(".")[0].toLowerCase();
    if (part.includes(":") || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(base)) {
      throw new Error(`Archive path is ambiguous on a supported platform: ${raw}`);
    }
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized !== candidate) throw new Error(`Archive path is not canonical: ${raw}`);
  return normalized;
}

function resolveContainedChild(root, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...normalized.split("/"));
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Destination is not a strict child of the target root: ${relativePath}`);
  }
  return resolved;
}

class EntryRegistry {
  constructor(limits = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.entries = [];
    this.byKey = new Map();
    this.totalBytes = 0;
  }

  add(rawPath, type, rawSize) {
    if (type !== "file" && type !== "directory") throw new Error(`Archive entry type is not allowed: ${type}`);
    const normalizedPath = normalizeRelativePath(rawPath, { directory: type === "directory" });
    const key = normalizedPath.toLocaleLowerCase("en-US");
    if (this.byKey.has(key)) throw new Error(`Archive contains a duplicate entry: ${normalizedPath}`);

    const parts = key.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const ancestor = this.byKey.get(parts.slice(0, i).join("/"));
      if (ancestor?.type === "file") throw new Error(`Archive file conflicts with a child entry: ${ancestor.path}`);
    }
    if (type === "file") {
      for (const existingKey of this.byKey.keys()) {
        if (existingKey.startsWith(`${key}/`)) throw new Error(`Archive file conflicts with an existing child entry: ${normalizedPath}`);
      }
    }

    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Archive entry has an invalid size: ${normalizedPath}`);
    if (type === "directory" && size !== 0) throw new Error(`Archive directory has a non-zero size: ${normalizedPath}`);
    if (size > this.limits.maxEntryBytes) throw new Error(`Archive entry exceeds the size limit: ${normalizedPath}`);
    if (this.entries.length + 1 > this.limits.maxEntries) throw new Error(`Archive contains more than ${this.limits.maxEntries} entries.`);
    if (this.totalBytes + size > this.limits.maxTotalBytes) throw new Error("Archive exceeds the total uncompressed size limit.");

    const entry = { path: normalizedPath, type, size };
    this.entries.push(entry);
    this.byKey.set(key, entry);
    this.totalBytes += size;
    return entry;
  }
}

function zipEntryType(entry) {
  const directory = entry.fileName.endsWith("/");
  const host = entry.versionMadeBy >>> 8;
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const unixType = unixMode & 0o170000;
  if (host === 3 && unixType && unixType !== 0o100000 && unixType !== 0o040000) {
    throw new Error(`ZIP entry is a link or special file: ${entry.fileName}`);
  }
  if (entry.generalPurposeBitFlag & 0x1) throw new Error(`Encrypted ZIP entries are not allowed: ${entry.fileName}`);
  return directory ? "directory" : "file";
}

function inspectZip(archivePath, limits) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError) {
        reject(openError);
        return;
      }
      const registry = new EntryRegistry(limits);
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      zip.on("error", fail);
      zip.on("entry", (entry) => {
        try {
          const type = zipEntryType(entry);
          registry.add(entry.fileName, type, type === "directory" ? 0 : entry.uncompressedSize);
          zip.readEntry();
        } catch (error) {
          fail(error);
        }
      });
      zip.on("end", () => {
        if (settled) return;
        if (!registry.entries.length) {
          fail(new Error("Archive contains no entries."));
          return;
        }
        settled = true;
        resolve({ format: "zip", entries: registry.entries, totalBytes: registry.totalBytes });
      });
      zip.readEntry();
    });
  });
}

async function inspectTar(archivePath, limits) {
  const registry = new EntryRegistry(limits);
  const controller = new AbortController();
  let validationError = null;
  try {
    await tar.t({
      file: archivePath,
      strict: true,
      preservePaths: true,
      signal: controller.signal,
      maxDecompressionRatio: registry.limits.maxDecompressionRatio,
      filter(rawPath, entry) {
        try {
          const type = entry.type === "Directory" ? "directory" : entry.type === "File" || entry.type === "OldFile" ? "file" : "special";
          registry.add(rawPath, type, type === "directory" ? 0 : entry.size);
        } catch (error) {
          validationError = error;
          controller.abort();
        }
        return false;
      },
    });
  } catch (error) {
    if (!validationError) throw error;
  }
  if (validationError) throw validationError;
  if (!registry.entries.length) throw new Error("Archive contains no entries.");
  return { format: "tar", entries: registry.entries, totalBytes: registry.totalBytes };
}

function archiveFormat(archivePath) {
  const lower = String(archivePath || "").toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar") || lower.endsWith(".tar.gz") || lower.endsWith(".tgz") || lower.endsWith(".tar.zst") || lower.endsWith(".tzst")) {
    return "tar";
  }
  throw new Error(`Unsupported archive format: ${archivePath}`);
}

async function inspectArchive(archivePath, limits = {}) {
  const format = archiveFormat(archivePath);
  return format === "zip" ? inspectZip(archivePath, limits) : inspectTar(archivePath, limits);
}

async function extractZip(archivePath, stagingRoot, manifest) {
  const expected = new Map(manifest.entries.map((entry) => [entry.path.toLocaleLowerCase("en-US"), entry]));
  const seen = new Set();
  await new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError) {
        reject(openError);
        return;
      }
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };
      zip.on("error", fail);
      zip.on("entry", async (rawEntry) => {
        try {
          const type = zipEntryType(rawEntry);
          const entryPath = normalizeRelativePath(rawEntry.fileName, { directory: type === "directory" });
          const expectedEntry = expected.get(entryPath.toLocaleLowerCase("en-US"));
          if (!expectedEntry || expectedEntry.type !== type || expectedEntry.size !== (type === "directory" ? 0 : rawEntry.uncompressedSize)) {
            throw new Error(`ZIP changed after validation: ${entryPath}`);
          }
          if (seen.has(expectedEntry.path)) throw new Error(`ZIP entry repeated during extraction: ${entryPath}`);
          seen.add(expectedEntry.path);
          const destination = resolveContainedChild(stagingRoot, entryPath);
          if (type === "directory") {
            await fsPromises.mkdir(destination, { recursive: true });
            zip.readEntry();
            return;
          }
          await fsPromises.mkdir(path.dirname(destination), { recursive: true });
          zip.openReadStream(rawEntry, (streamError, stream) => {
            if (streamError) {
              fail(streamError);
              return;
            }
            pipeline(stream, fs.createWriteStream(destination, { flags: "wx", mode: 0o644 }))
              .then(() => zip.readEntry(), fail);
          });
        } catch (error) {
          fail(error);
        }
      });
      zip.on("end", () => {
        if (settled) return;
        if (seen.size !== manifest.entries.length) {
          fail(new Error("ZIP extraction did not produce every validated entry."));
          return;
        }
        settled = true;
        resolve();
      });
      zip.readEntry();
    });
  });
}

async function extractTar(archivePath, stagingRoot, manifest, limits) {
  const expected = new Map(manifest.entries.map((entry) => [entry.path.toLocaleLowerCase("en-US"), entry]));
  const seen = new Set();
  const controller = new AbortController();
  let validationError = null;
  try {
    await tar.x({
      cwd: stagingRoot,
      file: archivePath,
      strict: true,
      preservePaths: false,
      noChmod: true,
      signal: controller.signal,
      maxDecompressionRatio: { ...DEFAULT_LIMITS, ...limits }.maxDecompressionRatio,
      filter(rawPath, rawEntry) {
        try {
          const type = rawEntry.type === "Directory" ? "directory" : rawEntry.type === "File" || rawEntry.type === "OldFile" ? "file" : "special";
          const entryPath = normalizeRelativePath(rawPath, { directory: type === "directory" });
          const expectedEntry = expected.get(entryPath.toLocaleLowerCase("en-US"));
          const size = type === "directory" ? 0 : rawEntry.size;
          if (!expectedEntry || expectedEntry.type !== type || expectedEntry.size !== size || seen.has(expectedEntry.path)) {
            throw new Error(`Tar archive changed after validation: ${entryPath}`);
          }
          seen.add(expectedEntry.path);
          return true;
        } catch (error) {
          validationError = error;
          controller.abort();
          return false;
        }
      },
    });
  } catch (error) {
    if (!validationError) throw error;
  }
  if (validationError) throw validationError;
  if (seen.size !== manifest.entries.length) throw new Error("Tar extraction did not produce every validated entry.");
}

function isStrictArchiveChild(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
async function captureCleanupDirectory(directory, rootDirectory, label) {
  const target = path.resolve(directory);
  const root = path.resolve(rootDirectory);
  const parent = path.dirname(target);
  const rootStat = await fsPromises.lstat(root);
  const parentStat = await fsPromises.lstat(parent);
  const directoryStat = await fsPromises.lstat(target);
  if (
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    !parentStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    (await fsPromises.realpath(root)) !== root ||
    (await fsPromises.realpath(parent)) !== parent ||
    (parent !== root && !isStrictArchiveChild(root, parent)) ||
    !isStrictArchiveChild(root, target)
  ) {
    throw new Error(`${label} is not a trusted real directory.`);
  }
  return {
    path: target,
    identity: directoryStat,
    root,
    rootIdentity: rootStat,
    parent,
    parentIdentity: parentStat,
  };
}
async function ensureSafeParent(root, destination) {
  const rootPath = path.resolve(root);
  const rootStat = await fsPromises.lstat(rootPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || (await fsPromises.realpath(rootPath)) !== rootPath) {
    throw new Error(`Destination root is not a real directory: ${root}`);
  }
  const relative = path.relative(rootPath, path.dirname(destination));
  const parts = relative && relative !== "." ? relative.split(path.sep) : [];
  let current = rootPath;
  for (const part of parts) {
    current = path.join(current, part);
    const before = await archiveLstatIfPresent(current);
    if (before && (before.isSymbolicLink() || !before.isDirectory())) {
      throw new Error(`Destination parent is not a real directory: ${current}`);
    }
    try {
      await fsPromises.mkdir(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const rootAfter = await fsPromises.lstat(rootPath);
    const after = await fsPromises.lstat(current);
    if (
      rootAfter.isSymbolicLink() ||
      !rootAfter.isDirectory() ||
      !isStrictArchiveChild(rootPath, current) ||
      after.isSymbolicLink() ||
      !after.isDirectory() ||
      (await fsPromises.realpath(current)) !== current ||
      (before && !sameArchiveIdentity(before, after, { includeTimes: false }))
    ) {
      throw new Error(`Destination parent changed during preparation: ${current}`);
    }
  }
}
async function archiveLstatIfPresent(filePath) {
  try {
    return await fsPromises.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}
function sameArchiveIdentity(left, right, { includeTimes = true } = {}) {
  return Boolean(left && right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    (!includeTimes || (left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs));
}
async function archiveParentTrusted(root, rootStat, parent, parentStat) {
  try {
    const rootCurrent = await fsPromises.lstat(root);
    const parentCurrent = await fsPromises.lstat(parent);
    return (
      !rootCurrent.isSymbolicLink() &&
      rootCurrent.isDirectory() &&
      !parentCurrent.isSymbolicLink() &&
      parentCurrent.isDirectory() &&
      sameArchiveIdentity(rootStat, rootCurrent, { includeTimes: false }) &&
      sameArchiveIdentity(parentStat, parentCurrent, { includeTimes: false }) &&
      (await fsPromises.realpath(root)) === path.resolve(root) &&
      (await fsPromises.realpath(parent)) === path.resolve(parent)
    );
  } catch {
    return false;
  }
}

async function promoteStaging(
  stagingRoot,
  targetRoot,
  manifest,
  promotionFs = fsPromises,
  { beforePromote = null, beforeLink = null, beforeCleanup = null } = {}
) {
  const targetRootStat = await fsPromises.lstat(targetRoot);
  if (targetRootStat.isSymbolicLink() || !targetRootStat.isDirectory()) {
    throw new Error(`Archive target root is not a real directory: ${targetRoot}`);
  }
  if ((await fsPromises.realpath(targetRoot)) !== path.resolve(targetRoot)) {
    throw new Error(`Archive target root escaped its configured path: ${targetRoot}`);
  }

  const parentStats = new Map();
  const destinationStats = new Map();
  const sourceStats = new Map();
  const destinations = new Map();
  const directories = manifest.entries.filter((entry) => entry.type === "directory").sort((a, b) => a.path.length - b.path.length);
  const files = manifest.entries.filter((entry) => entry.type === "file").sort((a, b) => a.path.localeCompare(b.path));
  for (const entry of manifest.entries) {
    const destination = resolveContainedChild(targetRoot, entry.path);
    destinations.set(entry.path, destination);
    await ensureSafeParent(targetRoot, destination);
    const parentStat = await fsPromises.lstat(path.dirname(destination));
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new Error(`Destination parent is not a real directory: ${path.dirname(destination)}`);
    }
    parentStats.set(entry.path, parentStat);
    let existing = null;
    try {
      existing = await fsPromises.lstat(destination);
      if (existing.isSymbolicLink()) throw new Error(`Refusing to replace a symlink: ${destination}`);
      if (entry.type === "directory" && !existing.isDirectory()) throw new Error(`Archive directory conflicts with an existing file: ${destination}`);
      if (entry.type === "file" && !existing.isFile()) throw new Error(`Archive file conflicts with an existing directory: ${destination}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    destinationStats.set(entry.path, existing);
    const source = resolveContainedChild(stagingRoot, entry.path);
    const sourceStat = await fsPromises.lstat(source);
    if (sourceStat.isSymbolicLink() || (entry.type === "file" ? !sourceStat.isFile() : !sourceStat.isDirectory())) {
      throw new Error(`Staged archive entry has the wrong type: ${entry.path}`);
    }
    sourceStats.set(entry.path, sourceStat);
  }

  for (const entry of directories) {
    const destination = destinations.get(entry.path);
    await ensureSafeParent(targetRoot, destination);
    const rootCurrent = await fsPromises.lstat(targetRoot);
    const parentCurrent = await fsPromises.lstat(path.dirname(destination));
    if (
      !sameArchiveIdentity(targetRootStat, rootCurrent, { includeTimes: false }) ||
      !sameArchiveIdentity(parentStats.get(entry.path), parentCurrent, { includeTimes: false })
    ) {
      throw new Error(`Archive directory changed before promotion: ${entry.path}`);
    }
    await beforePromote?.({ entry, destination, directory: true });
    const rootAfterHook = await fsPromises.lstat(targetRoot);
    const parentAfterHook = await fsPromises.lstat(path.dirname(destination));
    if (
      !sameArchiveIdentity(targetRootStat, rootAfterHook, { includeTimes: false }) ||
      !sameArchiveIdentity(parentStats.get(entry.path), parentAfterHook, { includeTimes: false })
    ) {
      throw new Error(`Archive directory changed during promotion: ${entry.path}`);
    }
    const existing = await archiveLstatIfPresent(destination);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error(`Archive directory changed during promotion: ${entry.path}`);
      }
    } else {
      await promotionFs.mkdir(destination);
    }
    const rootAfterMkdir = await fsPromises.lstat(targetRoot);
    const parentAfterMkdir = await fsPromises.lstat(path.dirname(destination));
    const installedDirectory = await fsPromises.lstat(destination);
    if (
      !sameArchiveIdentity(targetRootStat, rootAfterMkdir, { includeTimes: false }) ||
      !sameArchiveIdentity(parentStats.get(entry.path), parentAfterMkdir, { includeTimes: false }) ||
      installedDirectory.isSymbolicLink() ||
      !installedDirectory.isDirectory() ||
      !(await archiveParentTrusted(targetRoot, targetRootStat, path.dirname(destination), parentStats.get(entry.path)))
    ) {
      throw new Error(`Archive directory changed during promotion: ${entry.path}`);
    }
  }
  const backupRoot = `${stagingRoot}.backup`;
  const existingBackupRoot = await archiveLstatIfPresent(backupRoot);
  if (existingBackupRoot) {
    throw new Error(`Archive backup directory already exists: ${backupRoot}`);
  }
  let backupState = null;
  const completed = [];
  const cleanupBackup = async () => {
    if (!backupState) return;
    await beforeCleanup?.({ kind: "backup", ...backupState });
    await removeVerifiedDirectory(backupState.path, {
      rootDirectory: backupState.root,
      rootIdentity: backupState.rootIdentity,
      parentDirectory: backupState.parent,
      parentIdentity: backupState.parentIdentity,
      identity: backupState.identity,
      label: "Archive backup directory",
    });
    backupState = null;
  };
  try {
    for (const entry of files) {
      const source = resolveContainedChild(stagingRoot, entry.path);
      const destination = destinations.get(entry.path);
      const backup = resolveContainedChild(backupRoot, entry.path);
      const destinationParent = path.dirname(destination);
      const destinationParentStat = parentStats.get(entry.path);
      if (!(await archiveParentTrusted(targetRoot, targetRootStat, destinationParent, destinationParentStat))) {
        throw new Error(`Archive entry parent changed before promotion: ${entry.path}`);
      }
      let backedUp = false;
      try {
        await promotionFs.lstat(destination);
        await promotionFs.mkdir(path.dirname(backup), { recursive: true });
        if (!backupState) {
          backupState = await captureCleanupDirectory(
            backupRoot,
            path.dirname(stagingRoot),
            "Archive backup directory"
          );
        }
        await promotionFs.rename(destination, backup);
        backedUp = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (!(await archiveParentTrusted(targetRoot, targetRootStat, destinationParent, destinationParentStat))) {
        throw new Error(`Archive entry parent changed during backup: ${entry.path}`);
      }
      const operation = {
        destination,
        destinationParent,
        destinationParentStat,
        source,
        backup,
        backedUp,
        linked: false,
        installedIdentity: null,
        destinationBeforeLink: null,
        promoted: false,
      };
      completed.push(operation);
      await beforePromote?.({ entry, source, destination });
      let destinationBeforeLink = null;
      try {
        destinationBeforeLink = await archiveLstatIfPresent(destination);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      operation.destinationBeforeLink = destinationBeforeLink;
      const rootAfter = await fsPromises.lstat(targetRoot);
      const parentAfter = await fsPromises.lstat(destinationParent);
      const sourceAfter = await fsPromises.lstat(source);
      const destinationAfter = await archiveLstatIfPresent(destination);
      if (
        !sameArchiveIdentity(targetRootStat, rootAfter, { includeTimes: false }) ||
        !sameArchiveIdentity(destinationParentStat, parentAfter, { includeTimes: false }) ||
        !sameArchiveIdentity(sourceStats.get(entry.path), sourceAfter) ||
        destinationAfter ||
        !(await archiveParentTrusted(targetRoot, targetRootStat, destinationParent, destinationParentStat))
      ) {
        throw new Error(`Archive entry changed before promotion: ${entry.path}`);
      }
      await beforeLink?.({ entry, source, destination });
      operation.destinationBeforeLink = await archiveLstatIfPresent(destination);
      const rootBeforeLink = await fsPromises.lstat(targetRoot);
      const parentBeforeLink = await fsPromises.lstat(destinationParent);
      const sourceBeforeLink = await fsPromises.lstat(source);
      if (
        !sameArchiveIdentity(targetRootStat, rootBeforeLink, { includeTimes: false }) ||
        !sameArchiveIdentity(destinationParentStat, parentBeforeLink, { includeTimes: false }) ||
        !sameArchiveIdentity(sourceStats.get(entry.path), sourceBeforeLink) ||
        operation.destinationBeforeLink ||
        !(await archiveParentTrusted(targetRoot, targetRootStat, destinationParent, destinationParentStat))
      ) {
        throw new Error(`Archive entry changed immediately before promotion: ${entry.path}`);
      }
      if (promotionFs === fsPromises) {
        await fsPromises.link(source, destination);
      } else {
        await promotionFs.rename(source, destination);
      }
      operation.linked = true;
      const installed = await fsPromises.lstat(destination);
      operation.installedIdentity = installed;
      const rootAfterLink = await fsPromises.lstat(targetRoot);
      const parentAfterLink = await fsPromises.lstat(destinationParent);
      if (
        installed.isSymbolicLink() ||
        !installed.isFile() ||
        !sameArchiveIdentity(sourceStats.get(entry.path), installed, { includeTimes: false }) ||
        !sameArchiveIdentity(targetRootStat, rootAfterLink, { includeTimes: false }) ||
        !sameArchiveIdentity(destinationParentStat, parentAfterLink, { includeTimes: false }) ||
        !(await archiveParentTrusted(targetRoot, targetRootStat, destinationParent, destinationParentStat))
      ) {
        throw new Error(`Archive entry changed during promotion: ${entry.path}`);
      }
      if (promotionFs === fsPromises) {
        const sourceCurrent = await fsPromises.lstat(source);
        if (!sameArchiveIdentity(sourceStats.get(entry.path), sourceCurrent, { includeTimes: false })) {
          throw new Error(`Archive staging entry changed during promotion: ${entry.path}`);
        }
        await fsPromises.rm(source, { force: false });
      }
      operation.promoted = true;
    }
  } catch (promotionError) {
    const rollbackFailures = [];
    for (const operation of completed.reverse()) {
      const trustedParent = await archiveParentTrusted(
        targetRoot,
        targetRootStat,
        operation.destinationParent,
        operation.destinationParentStat
      );
      if (operation.linked) {
        if (!trustedParent) {
          rollbackFailures.push({
            action: "remove promoted file",
            path: operation.destination,
            error: new Error("destination parent changed"),
          });
        } else {
          const current = await archiveLstatIfPresent(operation.destination);
          if (
            current &&
            operation.installedIdentity &&
            sameArchiveIdentity(operation.installedIdentity, current, { includeTimes: false })
          ) {
            try {
              await removeVerifiedPath(operation.destination, {
                rootDirectory: targetRoot,
                rootIdentity: targetRootStat,
                parentDirectory: operation.destinationParent,
                parentIdentity: operation.destinationParentStat,
                identity: operation.installedIdentity,
                label: "Archive promoted file",
              });
            } catch (error) {
              rollbackFailures.push({ action: "remove promoted file", path: operation.destination, error });
            }
          } else if (current) {
            rollbackFailures.push({
              action: "remove promoted file",
              path: operation.destination,
              error: new Error("destination identity changed"),
            });
          }
        }
      }
      if (!operation.linked && operation.backedUp && trustedParent && operation.destinationBeforeLink?.isSymbolicLink()) {
        const current = await archiveLstatIfPresent(operation.destination);
        if (
          current &&
          current.isSymbolicLink() &&
          sameArchiveIdentity(operation.destinationBeforeLink, current, { includeTimes: false })
        ) {
          try {
            await removeVerifiedPath(operation.destination, {
              rootDirectory: targetRoot,
              rootIdentity: targetRootStat,
              parentDirectory: operation.destinationParent,
              parentIdentity: operation.destinationParentStat,
              identity: operation.destinationBeforeLink,
              allowSymbolicLink: true,
              label: "Archive raced destination",
            });
          } catch (error) {
            rollbackFailures.push({ action: "remove raced destination", path: operation.destination, error });
          }
        }
      }
      if (operation.backedUp) {
        if (!trustedParent) {
          rollbackFailures.push({
            action: "restore backup",
            path: operation.backup,
            error: new Error("destination parent changed"),
          });
        } else {
          try {
            await promotionFs.rename(operation.backup, operation.destination);
          } catch (error) {
            rollbackFailures.push({ action: "restore backup", path: operation.backup, error });
          }
        }
      }
    }
    if (rollbackFailures.length) {
      const details = rollbackFailures
        .map((failure) => `${failure.action} ${failure.path}: ${failure.error.message}`)
        .join("; ");
      const error = new Error(
        `Archive promotion failed and rollback was incomplete. ` +
        `Backup retained at ${backupRoot}. Promotion failed: ${promotionError.message}. ` +
        `Rollback failures: ${details}`
      );
      error.cause = promotionError;
      error.backupPath = backupRoot;
      error.rollbackFailures = rollbackFailures;
      throw error;
    }
    await cleanupBackup();
    throw promotionError;
  }
  await cleanupBackup();
}

async function extractArchiveToTarget(
  archivePath,
  targetRoot,
  {
    limits = {},
    stagingRoot = "",
    promotionFs = fsPromises,
    beforePromote = null,
    beforeLink = null,
    beforeCleanup = null,
  } = {}
) {
  const manifest = await inspectArchive(archivePath, limits);
  const root = path.resolve(targetRoot);
  const staging = stagingRoot
    ? path.resolve(stagingRoot)
    : path.join(root, `.autochart-extract-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const relativeStaging = path.relative(root, staging);
  if (!relativeStaging || relativeStaging.startsWith(`..${path.sep}`) || path.isAbsolute(relativeStaging)) {
    throw new Error("Archive staging directory must be a strict child of the target root.");
  }
  try {
    await fsPromises.lstat(root);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fsPromises.mkdir(root);
  }
  await ensureSafeParent(root, staging);
  const rootStat = await fsPromises.lstat(root);
  const stagingParent = path.dirname(staging);
  const stagingParentStat = await fsPromises.lstat(stagingParent);
  const existingStaging = await archiveLstatIfPresent(staging);
  if (existingStaging) {
    if (existingStaging.isSymbolicLink() || !existingStaging.isDirectory()) {
      throw new Error(`Archive staging path is not a real directory: ${staging}`);
    }
    await removeVerifiedDirectory(staging, {
      rootDirectory: root,
      rootIdentity: rootStat,
      parentDirectory: stagingParent,
      parentIdentity: stagingParentStat,
      identity: existingStaging,
      label: "Archive staging directory",
    });
  }
  await fsPromises.mkdir(staging);
  const stagingState = await captureCleanupDirectory(staging, root, "Archive staging directory");
  try {
    if (manifest.format === "zip") await extractZip(archivePath, staging, manifest);
    else await extractTar(archivePath, staging, manifest, limits);
    await promoteStaging(staging, root, manifest, promotionFs, { beforePromote, beforeLink, beforeCleanup });
  } finally {
    await beforeCleanup?.({ kind: "staging", ...stagingState });
    await removeVerifiedDirectory(stagingState.path, {
      rootDirectory: stagingState.root,
      rootIdentity: stagingState.rootIdentity,
      parentDirectory: stagingState.parent,
      parentIdentity: stagingState.parentIdentity,
      identity: stagingState.identity,
      label: "Archive staging directory",
    });
  }
  return manifest;
}

module.exports = {
  DEFAULT_LIMITS,
  EntryRegistry,
  extractArchiveToTarget,
  inspectArchive,
  normalizeRelativePath,
  resolveContainedChild,
};

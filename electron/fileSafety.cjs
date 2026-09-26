"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");

const NO_FOLLOW_READ_FLAGS = fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW || 0);
const HASH_CHUNK_BYTES = 1024 * 1024;
const WINDOWS_UNSUPPORTED_FSYNC_CODES = new Set([
  "EACCES",
  "EINVAL",
  "ENOTSUP",
  "EPERM",
]);

function unsupportedFsync(error, { platform = process.platform, directory = false } = {}) {
  return (platform === "win32" && WINDOWS_UNSUPPORTED_FSYNC_CODES.has(error?.code)) ||
    (directory && ["EISDIR", "EINVAL", "ENOTSUP"].includes(error?.code));
}

async function fsyncHandle(handle, options) {
  try {
    await handle.sync();
  } catch (error) {
    // A bad descriptor, full disk, or I/O failure is never a successful save.
    if (!unsupportedFsync(error, options)) throw error;
  }
}

function identityFromStat(stat) {
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    lastModified: stat.mtimeMs,
    changeTime: stat.ctimeMs,
  };
}

function sameIdentity(left, right, { includeTimes = true } = {}) {
  if (!left || !right) return false;
  if (left.device != null && right.device != null && left.device !== right.device) return false;
  if (left.inode != null && right.inode != null && left.inode !== right.inode) return false;
  if (left.size != null && right.size != null && left.size !== right.size) return false;
  if (includeTimes && left.lastModified != null && right.lastModified != null && left.lastModified !== right.lastModified) return false;
  if (includeTimes && left.changeTime != null && right.changeTime != null && left.changeTime !== right.changeTime) return false;
  return true;
}

function sameStat(left, right) {
  return sameIdentity(identityFromStat(left), identityFromStat(right));
}

function isStrictChild(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function lstatRegular(filePath, label = "File", { requireUnlinked = false } = {}) {
  const candidate = path.resolve(String(filePath || ""));
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink() || !stat.isFile() || (requireUnlinked && stat.nlink !== 1)) {
    throw new Error(`${label} must be a real regular file: ${candidate}`);
  }
  return { path: candidate, stat, identity: identityFromStat(stat) };
}
function sameDeviceInode(left, right) {
  const leftDevice = left?.dev ?? left?.device;
  const leftInode = left?.ino ?? left?.inode;
  const rightDevice = right?.dev ?? right?.device;
  const rightInode = right?.ino ?? right?.inode;
  return leftDevice != null && leftInode != null && rightDevice != null && rightInode != null &&
    leftDevice === rightDevice && leftInode === rightInode;
}
// Linux procfs supports child lookups beneath directory descriptors. macOS
// /dev/fd exists but does not support /dev/fd/<directory-fd>/<child>; treating
// ENOENT there as a missing child silently skips cleanup. macOS and Windows use
// the verified path fallback with root/parent/leaf identity checks instead.
function cleanupStrategyForPlatform(platform = process.platform, { descriptorNamespaceAvailable = null } = {}) {
  const namespace = platform === "linux"
    ? "/proc/self/fd"
    : null;
  const available = namespace && (
    descriptorNamespaceAvailable == null
      ? fsSync.existsSync(namespace)
      : descriptorNamespaceAvailable
  );
  return available
    ? { kind: "descriptor", namespace }
    : {
        kind: "path",
        namespace: null,
        reason: `No validated descriptor namespace is available on ${platform}; cleanup uses trusted pre/post identity checks.`,
      };
}

async function openDescriptorCleanupContext({
  root,
  rootIdentity,
  parent,
  parentIdentity,
  label,
} = {}) {
  let strategy = cleanupStrategyForPlatform();
  const rootStat = await fs.lstat(root);
  const parentStat = await fs.lstat(parent);
  if (
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    !parentStat.isDirectory() ||
    (await fs.realpath(root)) !== root ||
    (await fs.realpath(parent)) !== parent ||
    (parent !== root && !isStrictChild(root, parent)) ||
    !sameDeviceInode(rootStat, rootIdentity) ||
    !sameDeviceInode(parentStat, parentIdentity)
  ) {
    throw new Error(`${label} cleanup parent changed or root changed.`);
  }
  let rootHandle = null;
  let parentHandle = null;
  const wantsHandles = strategy.kind === "descriptor" || process.platform === "win32" || process.platform === "darwin";
  if (wantsHandles) {
    const flags = fsSync.constants.O_RDONLY | (fsSync.constants.O_DIRECTORY || 0);
    try {
      rootHandle = await fs.open(root, flags);
      parentHandle = await fs.open(parent, flags);
      const rootOpened = await rootHandle.stat();
      const parentOpened = await parentHandle.stat();
      if (!sameDeviceInode(rootOpened, rootIdentity) || !sameDeviceInode(parentOpened, parentIdentity)) {
        throw new Error(`${label} cleanup directory identity changed while opening.`);
      }
      const rootCurrent = await fs.lstat(root);
      const parentCurrent = await fs.lstat(parent);
      if (
        !sameDeviceInode(rootCurrent, rootOpened) ||
        !sameDeviceInode(parentCurrent, parentOpened) ||
        (await fs.realpath(root)) !== root ||
        (await fs.realpath(parent)) !== parent
      ) {
        throw new Error(`${label} cleanup parent changed or root changed while opening.`);
      }
    } catch (error) {
      if (parentHandle) await parentHandle.close().catch(() => {});
      if (rootHandle) await rootHandle.close().catch(() => {});
      rootHandle = null;
      parentHandle = null;
      const unsupportedHandleCodes = new Set(["EACCES", "EISDIR", "EINVAL", "ENOTSUP", "ENXIO", "EPERM"]);
      if (strategy.kind === "descriptor" && !unsupportedHandleCodes.has(error?.code)) throw error;
      strategy = {
        kind: "path",
        namespace: null,
        reason: `${label} descriptor handles unavailable; using trusted pre/post identity checks.`,
      };
    }
  }
  return {
    strategy,
    root,
    rootIdentity,
    parent,
    parentIdentity,
    rootHandle,
    parentHandle,
    descriptorParent: strategy.kind === "descriptor" ? `${strategy.namespace}/${parentHandle.fd}` : null,
  };
}

async function verifyDescriptorCleanupContext(context, label) {
  const rootCurrent = await fs.lstat(context.root);
  const parentCurrent = await fs.lstat(context.parent);
  if (
    !sameDeviceInode(rootCurrent, context.rootIdentity) ||
    !sameDeviceInode(parentCurrent, context.parentIdentity) ||
    (await fs.realpath(context.root)) !== context.root ||
    (await fs.realpath(context.parent)) !== context.parent
  ) {
    throw new Error(`${label} cleanup parent changed or root changed.`);
  }
  if (context.rootHandle && context.parentHandle) {
    const rootOpened = await context.rootHandle.stat();
    const parentOpened = await context.parentHandle.stat();
    if (
      !sameDeviceInode(rootOpened, context.rootIdentity) ||
      !sameDeviceInode(parentOpened, context.parentIdentity) ||
      !sameDeviceInode(rootCurrent, rootOpened) ||
      !sameDeviceInode(parentCurrent, parentOpened)
    ) {
      throw new Error(`${label} cleanup directory identity changed.`);
    }
  }
}

async function removeVerifiedPath(filePath, {
  rootDirectory,
  rootIdentity,
  parentDirectory = path.dirname(filePath),
  parentIdentity,
  identity,
  allowSymbolicLink = false,
  label = "File",
} = {}) {
  if (!identity) return false;
  const target = path.resolve(String(filePath || ""));
  const root = path.resolve(String(rootDirectory || parentDirectory || ""));
  const parent = path.resolve(String(parentDirectory || path.dirname(target)));
  const context = await openDescriptorCleanupContext({
    root,
    rootIdentity,
    parent,
    parentIdentity,
    label,
  });
  try {
    await verifyDescriptorCleanupContext(context, label);
    const descriptorLeaf = context.descriptorParent
      ? `${context.descriptorParent}/${path.basename(target)}`
      : target;
    let leaf;
    try {
      leaf = await fs.lstat(descriptorLeaf);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (
      (!allowSymbolicLink && (leaf.isSymbolicLink() || !leaf.isFile())) ||
      (allowSymbolicLink ? (!leaf.isSymbolicLink() && !leaf.isFile()) : false) ||
      !sameDeviceInode(leaf, identity)
    ) {
      throw new Error(`${label} changed before descriptor-relative cleanup.`);
    }
    await fs.unlink(descriptorLeaf);
    try {
      await fs.lstat(descriptorLeaf);
      throw new Error(`${label} remained after descriptor-relative cleanup.`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await verifyDescriptorCleanupContext(context, label);
    return true;
  } finally {
    if (context.parentHandle) await context.parentHandle.close().catch(() => {});
    if (context.rootHandle) await context.rootHandle.close().catch(() => {});
  }
}
async function removeVerifiedDirectory(directoryPath, {
  rootDirectory,
  rootIdentity,
  parentDirectory = path.dirname(directoryPath),
  parentIdentity,
  identity,
  label = "Directory",
} = {}) {
  if (!identity) throw new Error(`${label} identity is unavailable; refusing cleanup.`);
  const target = path.resolve(String(directoryPath || ""));
  const root = path.resolve(String(rootDirectory || parentDirectory || ""));
  const parent = path.resolve(String(parentDirectory || path.dirname(target)));
  const context = await openDescriptorCleanupContext({
    root,
    rootIdentity,
    parent,
    parentIdentity,
    label,
  });
  try {
    await verifyDescriptorCleanupContext(context, label);
    const descriptorTarget = context.descriptorParent
      ? `${context.descriptorParent}/${path.basename(target)}`
      : target;
    let current;
    try {
      current = await fs.lstat(descriptorTarget);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !sameDeviceInode(current, identity)
    ) {
      throw new Error(`${label} changed before cleanup.`);
    }
    const quarantineName = `.${path.basename(target)}.cleanup-${process.pid}-${crypto.randomUUID()}`;
    const descriptorQuarantine = context.descriptorParent
      ? `${context.descriptorParent}/${quarantineName}`
      : path.join(parent, quarantineName);
    await fs.rename(descriptorTarget, descriptorQuarantine);
    const quarantined = await fs.lstat(descriptorQuarantine);
    if (
      quarantined.isSymbolicLink() ||
      !quarantined.isDirectory() ||
      !sameDeviceInode(quarantined, identity)
    ) {
      throw new Error(`${label} changed during cleanup quarantine.`);
    }
    await verifyDescriptorCleanupContext(context, label);
    await fs.rm(descriptorQuarantine, { recursive: true, force: false });
    try {
      await fs.lstat(descriptorQuarantine);
      throw new Error(`${label} remained after descriptor-relative cleanup.`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await verifyDescriptorCleanupContext(context, label);
    return true;
  } finally {
    if (context.parentHandle) await context.parentHandle.close().catch(() => {});
    if (context.rootHandle) await context.rootHandle.close().catch(() => {});
  }
}

async function openVerifiedFile(filePath, {
  expectedIdentity = null,
  label = "File",
  flags = NO_FOLLOW_READ_FLAGS,
  requireUnlinked = false,
} = {}) {
  const initial = await lstatRegular(filePath, label, { requireUnlinked });
  if (expectedIdentity && !sameIdentity(initial.identity, expectedIdentity)) {
    throw new Error(`${label} changed after registration.`);
  }
  let handle;
  try {
    handle = await fs.open(initial.path, flags);
    const opened = await handle.stat();
    if (
      opened.isSymbolicLink() ||
      !opened.isFile() ||
      (requireUnlinked && opened.nlink !== 1) ||
      !sameStat(opened, initial.stat)
    ) {
      throw new Error(`${label} changed while it was opened.`);
    }
    if (expectedIdentity && !sameIdentity(identityFromStat(opened), expectedIdentity)) {
      throw new Error(`${label} changed after registration.`);
    }
    return {
      handle,
      path: initial.path,
      identity: identityFromStat(opened),
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error?.code === "ELOOP") {
      throw new Error(`${label} must be a real regular file: ${initial.path}`);
    }
    throw error;
  }
}
async function inspectVerifiedFile(filePath, options = {}) {
  const opened = await openVerifiedFile(filePath, options);
  await opened.handle.close().catch(() => {});
  return { path: opened.path, identity: opened.identity };
}

async function readHandle(handle, { label = "File", maxBytes = 0 } = {}) {
  const chunks = [];
  const hash = crypto.createHash("sha256");
  let total = 0;
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    total += bytesRead;
    if (maxBytes && total > maxBytes) throw new Error(`${label} exceeds the permitted size.`);
    const chunk = Buffer.from(buffer.subarray(0, bytesRead));
    chunks.push(chunk);
    hash.update(chunk);
  }
  const after = await handle.stat();
  if (!after.isFile() || after.size !== total) {
    throw new Error(`${label} changed while it was being read.`);
  }
  return {
    data: Buffer.concat(chunks, total),
    sha256: hash.digest("hex"),
    identity: identityFromStat(after),
  };
}

async function readVerifiedFile(filePath, options = {}) {
  const opened = await openVerifiedFile(filePath, options);
  try {
    const read = await readHandle(opened.handle, options);
    if (!sameIdentity(opened.identity, read.identity)) {
      throw new Error(`${options.label || "File"} changed while it was being read.`);
    }
    return { ...read, path: opened.path };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

async function ensureRealDirectoryTree(rootDirectory, targetDirectory) {
  const root = path.resolve(String(rootDirectory || ""));
  const target = path.resolve(String(targetDirectory || ""));
  if (target !== root && !isStrictChild(root, target)) {
    throw new Error("Target directory must be strictly contained by its safety root.");
  }
  await fs.mkdir(root, { recursive: true });
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Safety root must be a real directory.");
  }
  const canonicalRoot = await fs.realpath(root);
  let current = canonicalRoot;
  const relative = path.relative(root, target);
  for (const part of relative ? relative.split(path.sep) : []) {
    const next = path.join(current, part);
    try {
      await fs.mkdir(next);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(next);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Safety directory contains a link or non-directory component.");
    }
    const canonicalNext = await fs.realpath(next);
    if (!isStrictChild(canonicalRoot, canonicalNext)) {
      throw new Error("Safety directory escapes its root.");
    }
    current = canonicalNext;
  }
  return current;
}
async function openVerifiedExclusiveOutput(filePath, {
  rootDirectory = path.dirname(filePath),
  label = "Output",
  beforeOpen = null,
} = {}) {
  const target = path.resolve(String(filePath || ""));
  const requestedRoot = path.resolve(String(rootDirectory || ""));
  const canonicalParent = await ensureRealDirectoryTree(requestedRoot, path.dirname(target));
  const canonicalRoot = await fs.realpath(requestedRoot);
  if (canonicalRoot !== requestedRoot) {
    throw new Error(`${label} safety root escaped its configured path.`);
  }
  const rootBefore = await fs.lstat(canonicalRoot);
  const parentBefore = await fs.lstat(canonicalParent);
  await beforeOpen?.({ target, parent: canonicalParent });
  const rootAfterValidation = await fs.lstat(canonicalRoot);
  const realRootAfterValidation = await fs.realpath(requestedRoot);
  const parentAfterValidation = await fs.lstat(canonicalParent);
  const realParentAfterValidation = await fs.realpath(canonicalParent);
  if (
    rootAfterValidation.dev !== rootBefore.dev ||
    rootAfterValidation.ino !== rootBefore.ino ||
    realRootAfterValidation !== canonicalRoot ||
    parentAfterValidation.dev !== parentBefore.dev ||
    parentAfterValidation.ino !== parentBefore.ino ||
    realParentAfterValidation !== canonicalParent ||
    (canonicalParent !== canonicalRoot && !isStrictChild(canonicalRoot, canonicalParent))
  ) {
    throw new Error(`${label} parent changed before opening.`);
  }
  let handle;
  let openedIdentity = null;
  try {
    handle = await fs.open(
      target,
      fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_WRONLY,
      0o600
    );
    const opened = await handle.stat();
    openedIdentity = identityFromStat(opened);
    const rootAfterOpen = await fs.lstat(canonicalRoot);
    const realRootAfterOpen = await fs.realpath(requestedRoot);
    const parentAfterOpen = await fs.lstat(canonicalParent);
    const realParentAfterOpen = await fs.realpath(canonicalParent);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      rootAfterOpen.dev !== rootBefore.dev ||
      rootAfterOpen.ino !== rootBefore.ino ||
      realRootAfterOpen !== canonicalRoot ||
      parentAfterOpen.dev !== parentBefore.dev ||
      parentAfterOpen.ino !== parentBefore.ino ||
      realParentAfterOpen !== canonicalParent
    ) {
      throw new Error(`${label} parent or output changed while opening.`);
    }
    return {
      handle,
      path: target,
      identity: openedIdentity,
      parent: canonicalParent,
      parentIdentity: identityFromStat(parentAfterOpen),
      root: canonicalRoot,
      rootIdentity: identityFromStat(rootAfterOpen),
    };
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      await removeVerifiedPath(target, {
        rootDirectory: requestedRoot,
        rootIdentity: identityFromStat(rootBefore),
        parentDirectory: canonicalParent,
        parentIdentity: identityFromStat(parentBefore),
        identity: openedIdentity,
      });
    }
    throw error;
  }
}
async function verifyExclusiveOutput(output, label = "Output") {
  const after = await output.handle.stat();
  const rootAfter = await fs.lstat(output.root);
  const realRootAfter = await fs.realpath(output.root);
  const parentAfter = await fs.lstat(output.parent);
  const realParentAfter = await fs.realpath(output.parent);
  if (
    !after.isFile() ||
    after.nlink !== 1 ||
    !sameIdentity(
      { device: after.dev, inode: after.ino },
      { device: output.identity.device, inode: output.identity.inode },
      { includeTimes: false }
    ) ||
    rootAfter.dev !== output.rootIdentity.device ||
    rootAfter.ino !== output.rootIdentity.inode ||
    realRootAfter !== output.root ||
    parentAfter.dev !== output.parentIdentity.device ||
    parentAfter.ino !== output.parentIdentity.inode ||
    realParentAfter !== output.parent
  ) {
    throw new Error(`${label} changed while it was being written.`);
  }
  return identityFromStat(after);
}
async function hashVerifiedFile(filePath, options = {}) {
  const opened = await openVerifiedFile(filePath, options);
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let total = 0;
  try {
    while (true) {
      const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await opened.handle.stat();
    if (!sameStat(after, {
      dev: opened.identity.device,
      ino: opened.identity.inode,
      size: opened.identity.size,
      mtimeMs: opened.identity.lastModified,
      ctimeMs: opened.identity.changeTime,
    })) {
      throw new Error(`${options.label || "File"} changed while it was being read.`);
    }
    return { path: opened.path, identity: identityFromStat(after), size: total, sha256: hash.digest("hex") };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

async function fsyncDirectory(directory, { platform = process.platform } = {}) {
  let handle;
  try {
    handle = await fs.open(directory, fsSync.constants.O_RDONLY);
    await fsyncHandle(handle, { platform, directory: true });
  } catch (error) {
    // Directory fsync is not supported on every platform/filesystem. The file
    // itself is still fsynced before promotion when the filesystem allows it.
    if (!unsupportedFsync(error, { platform, directory: true })) throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function streamVerifiedToStaging(sourcePath, stagingDirectory, {
  rootDirectory,
  expectedIdentity = null,
  label = "Source file",
  beforeOpen = null,
  beforeOutputOpen = null,
  onOpen = null,
  onChunk = null,
} = {}) {
  await beforeOpen?.();
  const root = path.resolve(String(rootDirectory || stagingDirectory));
  const staging = path.resolve(stagingDirectory);
  const temporary = path.join(staging, `.source.tmp-${process.pid}-${crypto.randomUUID()}`);
  const source = await openVerifiedFile(sourcePath, { expectedIdentity, label });
  await onOpen?.();
  let output = null;
  let outputRecord = null;
  let sourceRead = false;
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  try {
    output = await openVerifiedExclusiveOutput(temporary, {
      rootDirectory: root,
      label: `${label} staging output`,
      beforeOpen: async () => {
        await beforeOutputOpen?.({ target: temporary, parent: staging });
      },
    });
    outputRecord = output;
    while (true) {
      const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      await output.handle.write(buffer, 0, bytesRead);
      await onChunk?.(bytesRead);
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await source.handle.stat();
    if (!sameStat(after, {
      dev: source.identity.device,
      ino: source.identity.inode,
      size: source.identity.size,
      mtimeMs: source.identity.lastModified,
      ctimeMs: source.identity.changeTime,
    })) {
      throw new Error(`${label} changed while it was being cached.`);
    }
    if (expectedIdentity && !sameIdentity(identityFromStat(after), expectedIdentity)) {
      throw new Error(`${label} changed after registration.`);
    }
    await verifyExclusiveOutput(output, `${label} staging output`);
    sourceRead = true;
    await fsyncHandle(output.handle);
    await output.handle.close();
    output = null;
    return {
      temporary,
      sha256: hash.digest("hex"),
      identity: identityFromStat(after),
    };
  } finally {
    if (output) await output.handle.close().catch(() => {});
    await source.handle.close().catch(() => {});
    if (!sourceRead && outputRecord) {
      await removeVerifiedPath(outputRecord.path, {
        rootDirectory: outputRecord.root,
        rootIdentity: outputRecord.rootIdentity,
        parentDirectory: outputRecord.parent,
        parentIdentity: outputRecord.parentIdentity,
        identity: outputRecord.identity,
      });
    }
  }
}

async function promoteStagedFile(temporary, filePath, {
  rootDirectory = path.dirname(filePath),
  label = "File",
  beforePromote = null,
  beforeLink = null,
} = {}) {
  const target = path.resolve(String(filePath || ""));
  const requestedRoot = path.resolve(String(rootDirectory || ""));
  const canonicalParent = await ensureRealDirectoryTree(requestedRoot, path.dirname(target));
  const canonicalRoot = await fs.realpath(requestedRoot);
  const rootBefore = await fs.lstat(canonicalRoot);
  const parentBefore = await fs.lstat(canonicalParent);
  let destinationBefore = null;
  try {
    destinationBefore = await fs.lstat(target);
    if (destinationBefore.isSymbolicLink() || !destinationBefore.isFile()) {
      throw new Error(`${label} destination must be a real regular file: ${target}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const staged = await lstatRegular(temporary, `${label} staging file`);
  const stagedParentPath = path.dirname(staged.path);
  const stagedParentBeforeStat = await fs.lstat(stagedParentPath);
  const stagedParentIdentity = identityFromStat(stagedParentBeforeStat);
  let stagedParentBefore;
  try {
    stagedParentBefore = await fs.realpath(stagedParentPath);
  } catch {
    throw new Error(`${label} staging parent changed before promotion.`);
  }
  if (stagedParentBefore !== canonicalRoot && !isStrictChild(canonicalRoot, stagedParentBefore)) {
    throw new Error(`${label} staging parent escaped its root.`);
  }
  let quarantine = null;
  let quarantineIdentity = null;
  let destinationBeforeLink = null;
  let linkedIdentity = null;
  let linkSucceeded = false;
  try {
    const parentAfter = await fs.lstat(canonicalParent);
    if (parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino) {
      throw new Error(`${label} parent changed before promotion.`);
    }
    let destinationAfter = null;
    try {
      destinationAfter = await fs.lstat(target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (destinationBefore || destinationAfter) {
      if (
        !destinationBefore ||
        !destinationAfter ||
        destinationAfter.isSymbolicLink() ||
        !destinationAfter.isFile() ||
        !sameStat(destinationBefore, destinationAfter)
      ) {
        throw new Error(`${label} destination changed before promotion.`);
      }
      quarantine = path.join(canonicalParent, `.${path.basename(target)}.old-${process.pid}-${crypto.randomUUID()}`);
      await fs.rename(target, quarantine);
      const quarantined = await fs.lstat(quarantine);
      quarantineIdentity = identityFromStat(quarantined);
      if (!sameIdentity(identityFromStat(destinationAfter), quarantineIdentity, { includeTimes: false })) {
        try {
          const rollbackParent = await fs.lstat(canonicalParent);
          if (
            sameDeviceInode(rollbackParent, parentBefore) &&
            (await fs.realpath(canonicalParent)) === canonicalParent
          ) {
            await fs.rename(quarantine, target);
            quarantine = null;
          }
        } catch {
          // Preserve the quarantine if the parent is no longer trusted.
        }
        throw new Error(`${label} destination changed during quarantine.`);
      }
    }
    await beforePromote?.({ target, parent: canonicalParent, temporary });
    const parentAfterHook = await fs.lstat(canonicalParent);
    const realParentAfterHook = await fs.realpath(canonicalParent);
    let stagedParentAfter;
    try {
      stagedParentAfter = await fs.realpath(path.dirname(staged.path));
    } catch {
      throw new Error(`${label} staging parent changed during promotion.`);
    }
    if (stagedParentAfter !== stagedParentBefore) {
      throw new Error(`${label} staging parent changed during promotion.`);
    }
    if (
      parentAfterHook.dev !== parentBefore.dev ||
      parentAfterHook.ino !== parentBefore.ino ||
      realParentAfterHook !== canonicalParent ||
      (realParentAfterHook !== canonicalRoot && !isStrictChild(canonicalRoot, realParentAfterHook))
    ) {
      throw new Error(`${label} parent changed during promotion.`);
    }
    let stagedBeforeLink;
    try {
      stagedBeforeLink = await fs.lstat(staged.path);
    } catch {
      throw new Error(`${label} staging file changed during promotion.`);
    }
    if (
      stagedBeforeLink.isSymbolicLink() ||
      !stagedBeforeLink.isFile() ||
      !sameStat(stagedBeforeLink, staged.stat)
    ) {
      throw new Error(`${label} staging file changed during promotion.`);
    }
    await beforeLink?.({ target, parent: canonicalParent, temporary });
    try {
      destinationBeforeLink = await fs.lstat(target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      destinationBeforeLink = null;
    }
    try {
      await fs.link(staged.path, target);
      linkSucceeded = true;
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error(`${label} destination changed during promotion.`);
      if (error?.code === "ENOENT") throw new Error(`${label} parent changed during promotion.`);
      throw error;
    }
    let installed;
    try {
      installed = await fs.lstat(target);
    } catch {
      throw new Error(`${label} destination changed during promotion.`);
    }
    linkedIdentity = identityFromStat(installed);
    if (
      installed.isSymbolicLink() ||
      !installed.isFile() ||
      !sameIdentity(linkedIdentity, staged.identity, { includeTimes: false })
    ) {
      throw new Error(`${label} destination changed during promotion.`);
    }
    const rootAfterLink = await fs.lstat(canonicalRoot);
    const realRootAfterLink = await fs.realpath(requestedRoot);
    const parentAfterLink = await fs.lstat(canonicalParent);
    const realParentAfterLink = await fs.realpath(canonicalParent);
    if (
      !sameDeviceInode(rootAfterLink, rootBefore) ||
      realRootAfterLink !== canonicalRoot ||
      !sameDeviceInode(parentAfterLink, parentBefore) ||
      realParentAfterLink !== canonicalParent
    ) {
      throw new Error(`${label} parent changed during promotion.`);
    }
    await fsyncDirectory(canonicalParent);
    await removeVerifiedPath(staged.path, {
      rootDirectory: canonicalRoot,
      rootIdentity: identityFromStat(rootBefore),
      parentDirectory: stagedParentPath,
      parentIdentity: stagedParentIdentity,
      identity: staged.identity,
    });
    if (quarantine) {
      await removeVerifiedPath(quarantine, {
        rootDirectory: canonicalRoot,
        rootIdentity: identityFromStat(rootBefore),
        parentDirectory: canonicalParent,
        parentIdentity: identityFromStat(parentBefore),
        identity: quarantineIdentity,
      });
    }
    return target;
  } catch (error) {
    let parentSafe = false;
    try {
      const rootCurrent = await fs.lstat(canonicalRoot);
      const parentCurrent = await fs.lstat(canonicalParent);
      parentSafe =
        sameDeviceInode(rootCurrent, rootBefore) &&
        (await fs.realpath(requestedRoot)) === canonicalRoot &&
        sameDeviceInode(parentCurrent, parentBefore) &&
        (await fs.realpath(canonicalParent)) === canonicalParent;
    } catch {
      parentSafe = false;
    }
    if (parentSafe) {
      try {
        const current = await fs.lstat(target);
        let cleanupIdentity = null;
        let allowSymbolicLink = false;
        if (linkSucceeded && linkedIdentity && sameDeviceInode(current, linkedIdentity)) {
          cleanupIdentity = linkedIdentity;
          allowSymbolicLink = current.isSymbolicLink();
        } else if (
          !linkSucceeded &&
          quarantine &&
          destinationBeforeLink?.isSymbolicLink() &&
          current.isSymbolicLink() &&
          sameDeviceInode(current, destinationBeforeLink)
        ) {
          cleanupIdentity = identityFromStat(current);
          allowSymbolicLink = true;
        }
        if (cleanupIdentity) {
          await removeVerifiedPath(target, {
            rootDirectory: canonicalRoot,
            rootIdentity: identityFromStat(rootBefore),
            parentDirectory: canonicalParent,
            parentIdentity: identityFromStat(parentBefore),
            identity: cleanupIdentity,
            allowSymbolicLink,
          });
        }
      } catch {
        // Leave an unexpected raced target untouched.
      }
    }
    if (quarantine && parentSafe && quarantineIdentity) {
      try {
        await fs.link(quarantine, target);
        await removeVerifiedPath(quarantine, {
          rootDirectory: canonicalRoot,
          rootIdentity: identityFromStat(rootBefore),
          parentDirectory: canonicalParent,
          parentIdentity: identityFromStat(parentBefore),
          identity: quarantineIdentity,
        });
      } catch {
        // Preserve the quarantine if a raced destination prevents safe restore.
      }
    }
    throw error;
  } finally {
    await removeVerifiedPath(staged.path, {
      rootDirectory: canonicalRoot,
      rootIdentity: identityFromStat(rootBefore),
      parentDirectory: stagedParentPath,
      parentIdentity: stagedParentIdentity,
      identity: staged.identity,
    });
  }
}

async function writeVerifiedAtomic(filePath, data, options = {}) {
  const target = path.resolve(String(filePath || ""));
  const parent = path.dirname(target);
  const rootDirectory = options.rootDirectory || parent;
  const staging = path.resolve(path.dirname(target));
  const temporary = path.join(staging, `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  let output = null;
  let outputRecord = null;
  try {
    output = await openVerifiedExclusiveOutput(temporary, {
      rootDirectory,
      label: `${options.label || "File"} staging output`,
      beforeOpen: options.beforeOpen,
    });
    outputRecord = output;
    await output.handle.writeFile(data);
    await verifyExclusiveOutput(output, `${options.label || "File"} staging output`);
    await fsyncHandle(output.handle);
    await output.handle.close();
    output = null;
    return await promoteStagedFile(temporary, target, options);
  } finally {
    if (output) await output.handle.close().catch(() => {});
    if (outputRecord) {
      await removeVerifiedPath(outputRecord.path, {
        rootDirectory: outputRecord.root,
        rootIdentity: outputRecord.rootIdentity,
        parentDirectory: outputRecord.parent,
        parentIdentity: outputRecord.parentIdentity,
        identity: outputRecord.identity,
      });
    }
  }
}
module.exports = {
  NO_FOLLOW_READ_FLAGS,
  ensureRealDirectoryTree,
  hashVerifiedFile,
  identityFromStat,
  inspectVerifiedFile,
  isStrictChild,
  lstatRegular,
  removeVerifiedDirectory,
  openVerifiedExclusiveOutput,
  openVerifiedFile,
  promoteStagedFile,
  removeVerifiedPath,
  readHandle,
  readVerifiedFile,
  sameIdentity,
  sameStat,
  streamVerifiedToStaging,
  verifyExclusiveOutput,
  writeVerifiedAtomic,
  fsyncHandle,
  fsyncDirectory,
  __test: {
    cleanupStrategyForPlatform,
    fsyncHandle,
  },
};

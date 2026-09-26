const fs = require("fs/promises");
const crypto = require("crypto");
const fsSync = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const runtimeSelection = require("./runtimeSelection.cjs");
const {
  EntryRegistry,
  extractArchiveToTarget,
  normalizeRelativePath,
  resolveContainedChild,
} = require("./archiveSafety.cjs");
const {
  ensureRealDirectoryTree,
  hashVerifiedFile,
  identityFromStat,
  fsyncHandle,
  openVerifiedExclusiveOutput,
  promoteStagedFile,
  removeVerifiedPath,
  verifyExclusiveOutput,
  writeVerifiedAtomic,
} = require("./fileSafety.cjs");

// Pin the public model pack to the revision matching the shipped catalog.
const DEFAULT_ASSET_BASE_URL = "https://huggingface.co/Dvaro/autochart-models/resolve/b38e69ca0dc919cef0218ef7f9c0014a1593b3c2";
const HTTP_REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MAX_REDIRECTS = 3;
const PINNED_CATALOG_MAX_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_BUNDLED_LICENSE_BYTES = 1024 * 1024;
const PINNED_CATALOG_SCHEMA_VERSION = 2;
const FILE_SOURCE_REMOTE = "remote";
const FILE_SOURCE_BUNDLED_LICENSE = "bundled-license";

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function encodePath(filePath) {
  return String(filePath || "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function assetUrl(baseUrl, filePath) {
  return `${normalizeBaseUrl(baseUrl)}/${encodePath(filePath)}`;
}

function downloadSourceHelp() {
  return "Check Settings > Download source or set AUTOCHART_ASSETS_BASE_URL, then try again.";
}

function packPlatformList(pack) {
  return runtimeSelection.platformList(pack);
}

function hasPlatformScopedPack(packs) {
  return packs.some((pack) => packPlatformList(pack).length > 0);
}

function requestStream(url, options = {}, redirects = 0) {
  const {
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    overallTimeoutMs = DEFAULT_OVERALL_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
  } = options;
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      reject(new Error(`Unsupported download protocol: ${parsed.protocol}`));
      return;
    }
    const client = parsed.protocol === "https:" ? https : http;
    let settled = false;
    let responseStream = null;
    let connectTimer = null;
    const req = client.get(parsed);
    const clearConnectTimer = () => {
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = null;
    };
    const overallTimer = setTimeout(() => {
      const error = new Error(`Overall download timeout after ${overallTimeoutMs}ms: ${url}`);
      if (responseStream) responseStream.destroy(error);
      else req.destroy(error);
    }, overallTimeoutMs);
    const fail = (error) => {
      clearConnectTimer();
      clearTimeout(overallTimer);
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on("socket", (socket) => {
      if (!socket.connecting) return;
      connectTimer = setTimeout(() => {
        req.destroy(new Error(`Connection timeout after ${connectTimeoutMs}ms: ${url}`));
      }, connectTimeoutMs);
      socket.once(parsed.protocol === "https:" ? "secureConnect" : "connect", clearConnectTimer);
    });
    req.on("response", (res) => {
      responseStream = res;
      clearConnectTimer();
      if (HTTP_REDIRECTS.has(res.statusCode) && res.headers.location) {
        res.destroy();
        clearTimeout(overallTimer);
        if (redirects >= maxRedirects) {
          fail(new Error(`Too many redirects while downloading ${url}`));
          return;
        }
        settled = true;
        requestStream(new URL(res.headers.location, parsed).toString(), options, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.destroy();
        fail(new Error(`Download failed with HTTP ${res.statusCode}: ${url}`));
        return;
      }
      res.setTimeout(idleTimeoutMs, () => {
        res.destroy(new Error(`Idle download timeout after ${idleTimeoutMs}ms: ${url}`));
      });
      const clearOverall = () => clearTimeout(overallTimer);
      res.once("end", clearOverall);
      res.once("close", clearOverall);
      if (settled) {
        res.destroy();
        return;
      }
      settled = true;
      resolve(res);
    });
    req.on("error", fail);
  });
}

function responseContentLength(stream) {
  const raw = stream?.headers?.["content-length"];
  if (raw === undefined) return 0;
  if (!/^\d+$/.test(String(raw))) throw new Error("Response Content-Length is invalid.");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Response Content-Length is outside the supported range.");
  return value;
}

async function downloadText(url, { maxBytes = PINNED_CATALOG_MAX_BYTES, requestOptions = {} } = {}) {
  const stream = await requestStream(url, requestOptions);
  const declared = responseContentLength(stream);
  if (declared > maxBytes) {
    stream.destroy();
    throw new Error(`Response exceeds the ${maxBytes}-byte limit.`);
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      if (size + chunk.length > maxBytes) {
        stream.destroy();
        throw new Error(`Response exceeds the ${maxBytes}-byte limit.`);
      }
      size += chunk.length;
      chunks.push(chunk);
    }
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return Buffer.concat(chunks, size).toString("utf8");
}


function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function validateExpectedFile(expectedSize, expectedSha256) {
  const size = Number(expectedSize);
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_RESPONSE_BYTES) {
    throw new Error(`Pinned file size must be an integer from 1 to ${MAX_RESPONSE_BYTES}.`);
  }
  const sha256 = String(expectedSha256 || "");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Pinned file SHA256 must be 64 lowercase hexadecimal characters.");
  return { size, sha256 };
}

function fileInstallSource(file) {
  return String(file?.source || "").trim();
}

function sameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

async function lstatIfPresent(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function inspectRealDirectory(rootPath, label) {
  const requestedPath = path.resolve(rootPath);
  const requestedStat = await fs.lstat(requestedPath);
  if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory()) {
    throw new Error(`${label} is not a real directory: ${requestedPath}`);
  }
  const realPath = await fs.realpath(requestedPath);
  const stat = await fs.lstat(realPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} is not a real directory: ${realPath}`);
  }
  return { path: realPath, stat };
}

async function inspectDirectoryChain(root, directory, { create = false, label = "Directory" } = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(resolvedRoot, resolvedDirectory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its allowed root: ${resolvedDirectory}`);
  }
  const parts = relative && relative !== "." ? relative.split(path.sep) : [];
  let current = resolvedRoot;
  let currentStat = await fs.lstat(current);
  if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
    throw new Error(`${label} root is not a real directory: ${current}`);
  }
  for (const part of parts) {
    current = path.join(current, part);
    let stat = await lstatIfPresent(current);
    if (!stat && create) {
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      stat = await fs.lstat(current);
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} parent is not a real directory: ${current}`);
    }
    currentStat = stat;
  }
  return currentStat;
}

async function hashOpenFileExact(handle, expectedSize, onChunk) {
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, expectedSize + 1));
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    position += bytesRead;
    if (position > expectedSize) throw new Error(`File exceeded its pinned ${expectedSize}-byte size.`);
    hash.update(buffer.subarray(0, bytesRead));
    if (typeof onChunk === "function") onChunk(buffer.subarray(0, bytesRead), position);
  }
  if (position !== expectedSize) throw new Error(`File size mismatch: expected ${expectedSize}, got ${position}.`);
  return { size: position, sha256: hash.digest("hex") };
}

async function openVerifiedBundledLicense(sourcePath, root, expected) {
  await inspectDirectoryChain(root.path, path.dirname(sourcePath), { label: "Bundled license source" });
  const before = await fs.lstat(sourcePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Bundled license source is not a regular file: ${sourcePath}`);
  }
  const handle = await fs.open(sourcePath, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error(`Bundled license source changed while opening: ${sourcePath}`);
    }
    if (opened.size !== expected.size) {
      throw new Error(`Bundled license size mismatch for ${sourcePath}: expected ${expected.size}, got ${opened.size}.`);
    }
    const verified = await hashOpenFileExact(handle, expected.size);
    const after = await handle.stat();
    const pathAfter = await fs.lstat(sourcePath);
    if (!sameFileIdentity(opened, after) || !sameFileIdentity(opened, pathAfter) || after.size !== expected.size) {
      throw new Error(`Bundled license source changed while verifying: ${sourcePath}`);
    }
    if (verified.sha256 !== expected.sha256) {
      throw new Error(`Bundled license SHA256 mismatch for ${sourcePath}.`);
    }
    return { handle, stat: after };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function inspectExistingDestination(destination, expected) {
  const before = await lstatIfPresent(destination);
  if (!before) return { state: "missing", stat: null };
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Bundled license destination is not a regular file: ${destination}`);
  }
  const handle = await fs.open(destination, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error(`Bundled license destination changed while opening: ${destination}`);
    }
    let verified = null;
    if (opened.size === expected.size) {
      try {
        verified = await hashOpenFileExact(handle, expected.size);
      } catch {
        verified = null;
      }
    }
    const after = await handle.stat();
    const pathAfter = await fs.lstat(destination);
    if (!sameFileIdentity(opened, after) || !sameFileIdentity(opened, pathAfter)) {
      throw new Error(`Bundled license destination changed while verifying: ${destination}`);
    }
    return {
      state: verified?.sha256 === expected.sha256 ? "valid" : "stale",
      stat: pathAfter,
      verified,
    };
  } finally {
    await handle.close();
  }
}

async function assertDirectoryIdentity(directory, expectedStat, label) {
  const current = await fs.lstat(directory);
  if (current.isSymbolicLink() || !current.isDirectory() || !sameFileIdentity(current, expectedStat)) {
    throw new Error(`${label} changed during bundled license installation: ${directory}`);
  }
  return current;
}

async function removeTemporaryIfUnchanged(temporaryPath, expectedIdentity, {
  rootDirectory,
  rootIdentity,
  parentDirectory,
  parentIdentity,
} = {}) {
  if (!expectedIdentity) return;
  await removeVerifiedPath(temporaryPath, {
    rootDirectory,
    rootIdentity,
    parentDirectory,
    parentIdentity,
    identity: expectedIdentity,
  });

}
function bundledLicenseRelativePath(filePath) {
  const normalized = normalizeRelativePath(filePath);
  const prefix = "licenses/";
  if (!normalized.startsWith(prefix)) {
    throw new Error(`Bundled license destination must be below licenses/: ${filePath}`);
  }
  return normalizeRelativePath(normalized.slice(prefix.length));
}

async function copyBundledLicense({
  bundledLicenseRoot,
  modelsRoot,
  targetPath,
  filePath,
  expectedSize,
  expectedSha256,
  onProgress,
  beforePromote,
}) {
  const expected = validateExpectedFile(expectedSize, expectedSha256);
  if (expected.size > MAX_BUNDLED_LICENSE_BYTES) {
    throw new Error(`Bundled license exceeds the ${MAX_BUNDLED_LICENSE_BYTES}-byte limit: ${filePath}`);
  }
  const sourceRoot = await inspectRealDirectory(bundledLicenseRoot, "Bundled license root");
  const destinationRoot = await inspectRealDirectory(modelsRoot, "Models root");
  const expectedDestination = resolveContainedChild(destinationRoot.path, normalizeRelativePath(filePath));
  if (path.resolve(targetPath) !== expectedDestination) {
    throw new Error(`Bundled license destination does not match its pinned path: ${filePath}`);
  }
  const sourcePath = resolveContainedChild(sourceRoot.path, bundledLicenseRelativePath(filePath));
  const source = await openVerifiedBundledLicense(sourcePath, sourceRoot, expected);
  let temporaryPath = "";
  let temporaryStat = null;
  let parent = "";
  let parentStat = null;
  let promoted = false;
  try {
    parent = path.dirname(expectedDestination);
    parentStat = await inspectDirectoryChain(destinationRoot.path, parent, {
      create: true,
      label: "Bundled license destination",
    });
    const existing = await inspectExistingDestination(expectedDestination, expected);
    if (existing.state === "valid") {
      await assertDirectoryIdentity(destinationRoot.path, destinationRoot.stat, "Models root");
      const parentAfterVerification = await inspectDirectoryChain(destinationRoot.path, parent, { label: "Bundled license destination" });
      const destinationAfterVerification = await fs.lstat(expectedDestination);
      if (!sameFileIdentity(parentAfterVerification, parentStat) || !sameFileIdentity(destinationAfterVerification, existing.stat)) {
        throw new Error(`Bundled license destination changed after verification: ${expectedDestination}`);
      }
      return { path: expectedDestination, size: expected.size, sha256: expected.sha256, skipped: true, source: FILE_SOURCE_BUNDLED_LICENSE };
    }

    temporaryPath = path.join(parent, `.${path.basename(expectedDestination)}.autochart-${process.pid}-${crypto.randomBytes(16).toString("hex")}.tmp`);
    resolveContainedChild(destinationRoot.path, path.relative(destinationRoot.path, temporaryPath).split(path.sep).join("/"));
    const output = await fs.open(temporaryPath, "wx", 0o600);
    temporaryStat = await output.stat();
    let copied = 0;
    const hash = crypto.createHash("sha256");
    try {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, expected.size + 1));
      while (true) {
        const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, copied);
        if (!bytesRead) break;
        copied += bytesRead;
        if (copied > expected.size) throw new Error(`Bundled license exceeded its pinned ${expected.size}-byte size.`);
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await output.write(buffer, written, bytesRead - written, copied - bytesRead + written);
          if (!result.bytesWritten) throw new Error(`Could not write bundled license temporary file: ${temporaryPath}`);
          written += result.bytesWritten;
        }
        if (typeof onProgress === "function") {
          onProgress({
            downloadedBytes: copied,
            totalBytes: expected.size,
            percent: Math.min(100, Math.round((copied / expected.size) * 100)),
          });
        }
      }
      if (copied !== expected.size) throw new Error(`Bundled license size mismatch: expected ${expected.size}, got ${copied}.`);
      if (hash.digest("hex") !== expected.sha256) throw new Error(`Bundled license changed while copying: ${sourcePath}`);
      await output.sync();
      temporaryStat = await output.stat();
      if (!temporaryStat.isFile() || temporaryStat.size !== expected.size) {
        throw new Error(`Bundled license temporary file has the wrong size: ${temporaryPath}`);
      }
    } finally {
      await output.close();
    }

    const sourceAfter = await source.handle.stat();
    if (!sameFileIdentity(source.stat, sourceAfter) || sourceAfter.size !== expected.size) {
      throw new Error(`Bundled license source changed while copying: ${sourcePath}`);
    }
    if (typeof beforePromote === "function") await beforePromote({ temporaryPath, destination: expectedDestination });

    await assertDirectoryIdentity(destinationRoot.path, destinationRoot.stat, "Models root");
    const currentParent = await inspectDirectoryChain(destinationRoot.path, parent, { label: "Bundled license destination" });
    if (!sameFileIdentity(currentParent, parentStat)) {
      throw new Error(`Bundled license destination parent changed during installation: ${parent}`);
    }
    const currentDestination = await lstatIfPresent(expectedDestination);
    if (existing.stat) {
      if (!currentDestination || currentDestination.isSymbolicLink() || !currentDestination.isFile() || !sameFileIdentity(currentDestination, existing.stat)) {
        throw new Error(`Bundled license destination changed before promotion: ${expectedDestination}`);
      }
    } else if (currentDestination) {
      throw new Error(`Bundled license destination appeared before promotion: ${expectedDestination}`);
    }

    await promoteStagedFile(temporaryPath, expectedDestination, {
      rootDirectory: destinationRoot.path,
      label: "Bundled license",
    });
    promoted = true;
    const installed = await fs.lstat(expectedDestination);
    if (installed.isSymbolicLink() || !installed.isFile() || !sameFileIdentity(installed, temporaryStat) || installed.size !== expected.size) {
      throw new Error(`Bundled license destination changed during promotion: ${expectedDestination}`);
    }
    const parentAfter = await inspectDirectoryChain(destinationRoot.path, parent, { label: "Bundled license destination" });
    if (!sameFileIdentity(parentAfter, parentStat)) {
      throw new Error(`Bundled license destination parent changed during promotion: ${parent}`);
    }
    await assertDirectoryIdentity(destinationRoot.path, destinationRoot.stat, "Models root");
    return { path: expectedDestination, size: expected.size, sha256: expected.sha256, source: FILE_SOURCE_BUNDLED_LICENSE };
  } finally {
    await source.handle.close();
    if (!promoted) {
      await removeTemporaryIfUnchanged(temporaryPath, temporaryStat, {
        rootDirectory: destinationRoot.path,
        rootIdentity: destinationRoot.stat,
        parentDirectory: parent,
        parentIdentity: parentStat,
      });
    }
  }
}
async function downloadFile({
  url,
  targetPath,
  expectedSize,
  expectedSha256,
  onProgress,
  requestOptions = {},
  rootDirectory = path.dirname(targetPath),
  beforeTempOpen = null,
  beforeExistingVerify = null,
  beforePromote = null,
}) {
  const expected = validateExpectedFile(expectedSize, expectedSha256);
  await ensureRealDirectoryTree(rootDirectory, path.dirname(targetPath));
  let existing = null;
  try {
    existing = await fs.lstat(targetPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    if (existing.isSymbolicLink()) throw new Error(`Refusing to use a symlink download target: ${targetPath}`);
    if (!existing.isFile()) throw new Error(`Existing download target is not a regular file: ${targetPath}`);
    if (existing.size === expected.size) {
      const expectedIdentity = identityFromStat(existing);
      await beforeExistingVerify?.({ targetPath, identity: expectedIdentity });
      const verified = await hashVerifiedFile(targetPath, {
        expectedIdentity,
        label: "Existing download target",
      });
      if (verified.sha256 === expected.sha256) {
        return { path: targetPath, size: verified.size, sha256: verified.sha256, skipped: true };
      }
    }
  }

  // A terminated process can leave its partial file behind. Each attempt owns
  // a fresh exclusive path, so repair never depends on deleting an untrusted
  // pre-existing file (including partials written by older app versions).
  const tmpPath = `${targetPath}.${crypto.randomUUID()}.download`;
  const stream = await requestStream(url, requestOptions);
  const declared = responseContentLength(stream);
  if (declared && declared !== expected.size) {
    stream.destroy();
    throw new Error(`Response Content-Length mismatch: expected ${expected.size}, got ${declared}.`);
  }

  const hash = crypto.createHash("sha256");
  let size = 0;
  let lastProgressAt = 0;
  const progress = (force = false) => {
    if (typeof onProgress !== "function") return;
    const now = Date.now();
    if (!force && now - lastProgressAt < 150) return;
    lastProgressAt = now;
    onProgress({
      downloadedBytes: size,
      totalBytes: expected.size,
      percent: Math.min(100, Math.round((size / expected.size) * 100)),
    });
  };
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      if (size + chunk.length > expected.size || size + chunk.length > MAX_RESPONSE_BYTES) {
        callback(new Error(`Download exceeded its pinned ${expected.size}-byte limit.`));
        return;
      }
      size += chunk.length;
      hash.update(chunk);
      progress(false);
      callback(null, chunk);
    },
  });

  let output = null;
  let outputRecord = null;
  try {
    output = await openVerifiedExclusiveOutput(tmpPath, {
      rootDirectory,
      label: "Remote asset download",
      beforeOpen: beforeTempOpen,
    });
    outputRecord = output;
    await pipeline(
      stream,
      limiter,
      fsSync.createWriteStream(tmpPath, { fd: output.handle.fd, autoClose: false })
    );
    await verifyExclusiveOutput(output, "Remote asset download");
    await fsyncHandle(output.handle);
    await output.handle.close();
    output = null;
  } catch (error) {
    stream.destroy();
    if (output) await output.handle.close().catch(() => {});
    if (outputRecord) await removeVerifiedPath(outputRecord.path, {
      rootDirectory: outputRecord.root,
      rootIdentity: outputRecord.rootIdentity,
      parentDirectory: outputRecord.parent,
      parentIdentity: outputRecord.parentIdentity,
      identity: outputRecord.identity,
    });
    throw error;
  }
  progress(true);

  const sha256 = hash.digest("hex");
  if (size !== expected.size) {
    if (outputRecord) await removeVerifiedPath(outputRecord.path, {
      rootDirectory: outputRecord.root,
      rootIdentity: outputRecord.rootIdentity,
      parentDirectory: outputRecord.parent,
      parentIdentity: outputRecord.parentIdentity,
      identity: outputRecord.identity,
    });
    throw new Error(`Size mismatch for ${targetPath}: expected ${expected.size}, got ${size}`);
  }
  if (sha256 !== expected.sha256) {
    if (outputRecord) await removeVerifiedPath(outputRecord.path, {
      rootDirectory: outputRecord.root,
      rootIdentity: outputRecord.rootIdentity,
      parentDirectory: outputRecord.parent,
      parentIdentity: outputRecord.parentIdentity,
      identity: outputRecord.identity,
    });
    throw new Error(`SHA256 mismatch for ${targetPath}.`);
  }
  await promoteStagedFile(tmpPath, targetPath, {
    rootDirectory,
    label: "Remote asset",
    beforePromote,
  });
  return { path: targetPath, size, sha256 };
}

async function extractFile(file, archivePath, target, options = {}) {
  if (!file.extract) return false;
  await extractArchiveToTarget(archivePath, target, {
    limits: options.archiveLimits || {},
  });
  return true;
}

function defaultPinnedCatalogPath() {
  return path.resolve(__dirname, "..", "engine", "catalog.json");
}

function defaultBundledLicenseRoot() {
  return path.resolve(__dirname, "..", "engine", "licenses");
}

function validatePinnedCatalog(catalog, modelsRoot) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) throw new Error("Pinned catalog must be a JSON object.");
  if (catalog.schemaVersion !== PINNED_CATALOG_SCHEMA_VERSION) {
    throw new Error(`Pinned catalog schemaVersion must be ${PINNED_CATALOG_SCHEMA_VERSION}.`);
  }
  if (!Array.isArray(catalog.components) || !catalog.components.length) throw new Error("Pinned catalog must contain components.");
  if (!Array.isArray(catalog.packs) || !catalog.packs.length) throw new Error("Pinned catalog must contain packs.");

  const componentsById = new Map();
  const fileRegistry = new EntryRegistry({ maxEntries: 10_000, maxTotalBytes: MAX_RESPONSE_BYTES });
  for (const component of catalog.components) {
    const componentId = String(component?.id || "").trim();
    if (!componentId || componentsById.has(componentId)) throw new Error(`Pinned catalog has a missing or duplicate component id: ${componentId}`);
    if (!String(component.license || "").trim()) throw new Error(`Pinned component ${componentId} is missing its license identifier.`);
    if (!component.attribution || typeof component.attribution !== "object" || Array.isArray(component.attribution)) {
      throw new Error(`Pinned component ${componentId} is missing attribution metadata.`);
    }
    for (const field of ["title", "creator", "source", "license"]) {
      if (!String(component.attribution[field] || "").trim()) {
        throw new Error(`Pinned component ${componentId} attribution is missing ${field}.`);
      }
    }
    if (String(component.attribution.license) !== String(component.license)) {
      throw new Error(`Pinned component ${componentId} attribution license does not match its component license.`);
    }

    const files = Array.isArray(component.files) ? component.files : [];
    if (!files.length) throw new Error(`Pinned component ${componentId} has no files.`);
    const componentPaths = new Set();
    const componentFiles = new Map();
    for (const file of files) {
      const rawPath = String(file?.path || "");
      if (rawPath.includes(":")) throw new Error(`Pinned file path contains an ambiguous colon: ${rawPath}`);
      const normalizedPath = normalizeRelativePath(rawPath);
      if (normalizedPath !== rawPath) throw new Error(`Pinned file path is not canonical: ${rawPath}`);
      if (normalizedPath === "catalog.json" || normalizedPath.startsWith(".autochart-")) {
        throw new Error(`Pinned file path is reserved for installer state: ${normalizedPath}`);
      }
      const expected = validateExpectedFile(file.size, file.sha256);
      const source = fileInstallSource(file);
      if (source !== FILE_SOURCE_REMOTE && source !== FILE_SOURCE_BUNDLED_LICENSE) {
        throw new Error(`Pinned file ${normalizedPath} has an unsupported source: ${source || "(missing)"}`);
      }
      if (source === FILE_SOURCE_BUNDLED_LICENSE) {
        bundledLicenseRelativePath(normalizedPath);
        if (file.extract) throw new Error(`Bundled license cannot be an archive: ${normalizedPath}`);
        if (expected.size > MAX_BUNDLED_LICENSE_BYTES) {
          throw new Error(`Bundled license exceeds the ${MAX_BUNDLED_LICENSE_BYTES}-byte limit: ${normalizedPath}`);
        }
      }
      resolveContainedChild(modelsRoot, normalizedPath);
      fileRegistry.add(normalizedPath, "file", Number(file.size));
      componentPaths.add(normalizedPath);
      componentFiles.set(normalizedPath, file);
    }
    const licenseFiles = Array.isArray(component.licenseFiles) ? component.licenseFiles : [];
    if (!licenseFiles.length) throw new Error(`Pinned component ${componentId} has no license files.`);
    const seenLicenseFiles = new Set();
    for (const licensePath of licenseFiles) {
      const normalizedLicensePath = normalizeRelativePath(licensePath);
      if (seenLicenseFiles.has(normalizedLicensePath)) {
        throw new Error(`Pinned component ${componentId} repeats license file ${licensePath}.`);
      }
      if (!componentPaths.has(normalizedLicensePath)) {
        throw new Error(`Pinned component ${componentId} license file is not a pinned file: ${licensePath}`);
      }
      if (fileInstallSource(componentFiles.get(normalizedLicensePath)) !== FILE_SOURCE_BUNDLED_LICENSE) {
        throw new Error(`Pinned component ${componentId} license file is not sourced from the app bundle: ${licensePath}`);
      }
      seenLicenseFiles.add(normalizedLicensePath);
    }
    for (const [filePath, file] of componentFiles) {
      if (fileInstallSource(file) === FILE_SOURCE_BUNDLED_LICENSE && !seenLicenseFiles.has(filePath)) {
        throw new Error(`Pinned bundled license is not declared by component ${componentId}: ${filePath}`);
      }
    }
    componentsById.set(componentId, component);
  }

  const packIds = new Set();
  for (const pack of catalog.packs) {
    const packId = String(pack?.id || "").trim();
    if (!packId || packIds.has(packId)) throw new Error(`Pinned catalog has a missing or duplicate pack id: ${packId}`);
    packIds.add(packId);
    const componentIds = Array.isArray(pack.components) ? pack.components : [];
    if (!componentIds.length) throw new Error(`Pinned pack ${packId} has no components.`);
    const seen = new Set();
    for (const componentId of componentIds) {
      if (seen.has(componentId)) throw new Error(`Pinned pack ${packId} repeats component ${componentId}.`);
      if (!componentsById.has(componentId)) throw new Error(`Pinned pack ${packId} references missing component ${componentId}.`);
      seen.add(componentId);
    }
  }
  return catalog;
}

async function loadPinnedCatalog(modelsRoot, options = {}) {
  const catalogPath = path.resolve(options.pinnedCatalogPath || defaultPinnedCatalogPath());
  const stat = await fs.lstat(catalogPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Pinned catalog is not a regular file: ${catalogPath}`);
  if (stat.size <= 0 || stat.size > PINNED_CATALOG_MAX_BYTES) {
    throw new Error(`Pinned catalog exceeds the ${PINNED_CATALOG_MAX_BYTES}-byte limit.`);
  }
  const catalogText = await fs.readFile(catalogPath, "utf8");
  if (Buffer.byteLength(catalogText, "utf8") > PINNED_CATALOG_MAX_BYTES) {
    throw new Error(`Pinned catalog exceeds the ${PINNED_CATALOG_MAX_BYTES}-byte limit.`);
  }
  let catalog;
  try {
    catalog = JSON.parse(catalogText);
  } catch (error) {
    throw new Error(`Pinned asset catalog is not valid JSON: ${error.message}`);
  }
  return { catalog: validatePinnedCatalog(catalog, modelsRoot), catalogPath, catalogText };
}

async function ensureSafeDestination(modelsRoot, destination) {
  const root = path.resolve(modelsRoot);
  const relative = path.relative(root, path.dirname(destination));
  const parts = relative && relative !== "." ? relative.split(path.sep) : [];
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Model destination parent is not a real directory: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await fs.mkdir(current);
    }
  }
  try {
    const stat = await fs.lstat(destination);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Model destination is not a regular file: ${destination}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function selectedPack(catalog, settings = {}, options = {}) {
  const packs = Array.isArray(catalog?.packs) ? catalog.packs : [];
  const requestedPackId = String(options.packId || settings.installPackId || "").trim();
  const supportedPacks = packs.filter((pack) => runtimeSelection.supportsPlatformAndArchitecture(pack, process.platform, process.arch));
  if (requestedPackId) {
    return supportedPacks.find((pack) => pack.id === requestedPackId) || null;
  }
  const pack = runtimeSelection.selectPack(packs, catalog, settings, {
    platform: process.platform,
  });
  if (!pack && hasPlatformScopedPack(packs)) return null;
  return pack || packs[0] || null;
}

function filesForPack(catalog, pack) {
  const componentsById = new Map((catalog.components || []).map((component) => [component.id, component]));
  const files = [];
  for (const id of Array.isArray(pack?.components) ? pack.components : []) {
    const component = componentsById.get(id);
    files.push(...component.files);
  }
  return files;
}

async function installFromHttpWithOptions(settings, baseUrl, options = {}) {
  const emit = (event) => {
    if (typeof options.onProgress === "function") {
      options.onProgress({ time: Date.now(), ...event });
    }
  };
  const modelsFolder = String(settings.modelsFolder || "").trim();
  if (!modelsFolder) throw new Error("No chart generation files folder is configured.");
  if (!normalizeBaseUrl(baseUrl)) {
    throw new Error(`No chart generation download source is configured. ${downloadSourceHelp()}`);
  }
  await fs.mkdir(path.resolve(modelsFolder), { recursive: true });
  const target = await fs.realpath(path.resolve(modelsFolder));

  emit({ type: "catalog", phase: "catalog", message: "Loading the shipped pinned asset catalog." });
  let pinned;
  try {
    pinned = await loadPinnedCatalog(target, options);
  } catch (error) {
    throw new Error(`Could not load the shipped pinned asset catalog. ${error.message || error}`);
  }
  const { catalog, catalogText } = pinned;
  const pack = selectedPack(catalog, settings, options);
  if (!pack) {
    throw new Error(`Asset catalog does not contain an installable ${process.platform} ${process.arch} pack.`);
  }

  const files = filesForPack(catalog, pack);
  if (!files.length) throw new Error(`Pinned pack ${pack.id} contains no files.`);
  const bundledLicenseRoot = path.resolve(options.bundledLicenseRoot || defaultBundledLicenseRoot());
  const totalBytes = files.reduce((sum, file) => sum + positiveNumber(file.size), 0);
  const totalFiles = files.length;
  let completedBytes = 0;
  emit({
    type: "start",
    phase: "downloading",
    packId: pack.id,
    packLabel: pack.label,
    totalFiles,
    totalBytes,
    downloadedBytes: 0,
    percent: totalBytes > 0 ? 0 : null,
  });
  let extracted = 0;
  for (const [index, file] of files.entries()) {
    const fileTotalBytes = positiveNumber(file.size);
    const fileIndex = index + 1;
    const fileSource = fileInstallSource(file);
    const transferPhase = fileSource === FILE_SOURCE_BUNDLED_LICENSE ? "copying" : "downloading";
    emit({
      type: "file-start",
      phase: "checking",
      packId: pack.id,
      fileIndex,
      totalFiles,
      filePath: file.path,
      fileSource,
      fileTotalBytes,
      totalBytes,
      downloadedBytes: completedBytes,
      percent: totalBytes > 0 ? Math.min(100, Math.round((completedBytes / totalBytes) * 100)) : null,
    });
    const destination = resolveContainedChild(target, file.path);
    let downloaded = null;
    const onFileProgress = ({ downloadedBytes: fileDownloadedBytes, totalBytes: streamTotalBytes, percent: filePercent }) => {
      const currentFileTotal = fileTotalBytes || streamTotalBytes || fileDownloadedBytes;
      const aggregateDownloaded = completedBytes + fileDownloadedBytes;
      emit({
        type: "progress",
        phase: transferPhase,
        packId: pack.id,
        fileIndex,
        totalFiles,
        filePath: file.path,
        fileSource,
        fileDownloadedBytes,
        fileTotalBytes: currentFileTotal,
        filePercent,
        downloadedBytes: aggregateDownloaded,
        totalBytes,
        percent: totalBytes > 0 ? Math.min(100, Math.round((aggregateDownloaded / totalBytes) * 100)) : null,
      });
    };
    try {
      if (fileSource === FILE_SOURCE_BUNDLED_LICENSE) {
        downloaded = await copyBundledLicense({
          bundledLicenseRoot,
          modelsRoot: target,
          targetPath: destination,
          filePath: file.path,
          expectedSize: file.size,
          expectedSha256: file.sha256,
          onProgress: onFileProgress,
        });
      } else {
        await ensureSafeDestination(target, destination);
        downloaded = await downloadFile({
          url: assetUrl(baseUrl, file.path),
          targetPath: destination,
          expectedSize: file.size,
          expectedSha256: file.sha256,
          requestOptions: options.requestOptions || {},
          onProgress: onFileProgress,
          rootDirectory: target,
          beforeExistingVerify: options.beforeExistingVerify,
        });
      }
    } catch (err) {
      if (fileSource === FILE_SOURCE_BUNDLED_LICENSE) {
        throw new Error(`Could not copy or verify bundled license ${file.path}. The app installation may be damaged. ${err.message || err}`);
      }
      throw new Error(`Could not download or verify ${file.path}. ${downloadSourceHelp()} ${err.message || err}`);
    }
    completedBytes += fileTotalBytes || positiveNumber(downloaded.size);
    emit({
      type: "file-complete",
      phase: "verifying",
      packId: pack.id,
      fileIndex,
      totalFiles,
      filePath: file.path,
      fileSource,
      skipped: Boolean(downloaded.skipped),
      fileDownloadedBytes: positiveNumber(downloaded.size),
      fileTotalBytes: fileTotalBytes || positiveNumber(downloaded.size),
      downloadedBytes: completedBytes,
      totalBytes,
      percent: totalBytes > 0 ? Math.min(100, Math.round((completedBytes / totalBytes) * 100)) : null,
    });
    if (file.extract) {
      emit({
        type: "extract-start",
        phase: "extracting",
        packId: pack.id,
        fileIndex,
        totalFiles,
        filePath: file.path,
        downloadedBytes: completedBytes,
        totalBytes,
        percent: totalBytes > 0 ? Math.min(100, Math.round((completedBytes / totalBytes) * 100)) : null,
      });
    }
    let extractedFile = false;
    try {
      extractedFile = await extractFile(file, downloaded.path, target, options);
    } catch (err) {
      throw new Error(`Could not extract ${file.path}. ${err.message || err}`);
    }
    if (extractedFile) {
      extracted += 1;
      emit({
        type: "extract-complete",
        phase: "extracting",
        packId: pack.id,
        fileIndex,
        totalFiles,
        filePath: file.path,
        downloadedBytes: completedBytes,
        totalBytes,
        percent: totalBytes > 0 ? Math.min(100, Math.round((completedBytes / totalBytes) * 100)) : null,
      });
    }
  }

  const installedCatalogPath = resolveContainedChild(target, "catalog.json");
  await writeVerifiedAtomic(installedCatalogPath, catalogText, {
    rootDirectory: target,
    label: "Installed catalog",
    beforeOpen: options.beforeCatalogOpen,
    beforePromote: options.beforeCatalogPromote,
  });
  emit({
    type: "complete",
    phase: "complete",
    packId: pack.id,
    packLabel: pack.label,
    totalFiles,
    files: totalFiles,
    extracted,
    downloadedBytes: completedBytes,
    totalBytes,
    percent: 100,
  });
  return {
    ok: true,
    path: target,
    source: "http",
    baseUrl: normalizeBaseUrl(baseUrl),
    packId: pack.id,
    files: files.length,
    extracted,
  };
}

async function installAssets(settings = {}, options = {}) {
  runtimeSelection.assertSupportedTarget(process.platform, process.arch);
  const baseUrl = normalizeBaseUrl(process.env.AUTOCHART_ASSETS_BASE_URL || settings.assetBaseUrl || DEFAULT_ASSET_BASE_URL);
  return installFromHttpWithOptions(settings, baseUrl, options);
}

module.exports = {
  DEFAULT_ASSET_BASE_URL,
  installAssets,
  __test: {
    FILE_SOURCE_BUNDLED_LICENSE,
    FILE_SOURCE_REMOTE,
    MAX_RESPONSE_BYTES,
    MAX_BUNDLED_LICENSE_BYTES,
    PINNED_CATALOG_MAX_BYTES,
    PINNED_CATALOG_SCHEMA_VERSION,
    copyBundledLicense,
    defaultBundledLicenseRoot,
    downloadFile,
    downloadText,
    extractFile,
    installFromHttpWithOptions,
    loadPinnedCatalog,
    requestStream,
    validatePinnedCatalog,
  },
};

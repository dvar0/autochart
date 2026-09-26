"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const MARKER_NAME = ".autochart-smoke-owner.json";
const MARKER_PURPOSE = "autochart-smoke-isolation-v1";
const APP_ROOT = path.resolve(__dirname, "..");

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function systemProtectedPaths() {
  return process.platform === "win32"
    ? [process.env.SystemRoot, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramData]
    : ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/opt", "/proc", "/run", "/sbin", "/sys", "/usr", "/var"];
}

function assertSafeTarget(target) {
  const raw = String(target || "").trim();
  if (!raw) throw new Error("Smoke isolation path is required.");
  const resolved = path.resolve(raw);
  const root = path.parse(resolved).root;
  const protectedPaths = [root, os.homedir(), os.tmpdir(), APP_ROOT, process.cwd()]
    .filter(Boolean)
    .map((item) => path.resolve(item));
  for (const protectedPath of protectedPaths) {
    if (pathKey(resolved) === pathKey(protectedPath) || isWithin(resolved, protectedPath)) {
      throw new Error(`Refusing unsafe smoke isolation target: ${resolved}`);
    }
  }
  const temporaryRoot = path.resolve(os.tmpdir());
  const isTemporaryChild = pathKey(resolved) !== pathKey(temporaryRoot) && isWithin(temporaryRoot, resolved);
  for (const protectedPath of systemProtectedPaths().filter(Boolean).map((item) => path.resolve(item))) {
    if (
      !isTemporaryChild && (
        pathKey(resolved) === pathKey(protectedPath) ||
        isWithin(resolved, protectedPath) ||
        isWithin(protectedPath, resolved)
      )
    ) {
      throw new Error(`Refusing unsafe smoke isolation target: ${resolved}`);
    }
  }
  return resolved;
}

async function canonicalExistingPath(target) {
  const resolved = path.resolve(target);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

async function assertSafeCanonicalTarget(target) {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const protectedPaths = await Promise.all(
    [root, os.homedir(), os.tmpdir(), APP_ROOT, process.cwd()]
      .filter(Boolean)
      .map(canonicalExistingPath)
  );
  for (const protectedPath of protectedPaths) {
    if (pathKey(resolved) === pathKey(protectedPath) || isWithin(resolved, protectedPath)) {
      throw new Error(`Refusing unsafe canonical smoke isolation target: ${resolved}`);
    }
  }
  const canonicalTemporaryRoot = await canonicalExistingPath(os.tmpdir());
  const isTemporaryChild =
    pathKey(resolved) !== pathKey(canonicalTemporaryRoot) && isWithin(canonicalTemporaryRoot, resolved);
  const systemProtected = await Promise.all(
    systemProtectedPaths().filter(Boolean).map(canonicalExistingPath)
  );
  for (const protectedPath of systemProtected) {
    if (
      !isTemporaryChild && (
        pathKey(resolved) === pathKey(protectedPath) ||
        isWithin(resolved, protectedPath) ||
        isWithin(protectedPath, resolved)
      )
    ) {
      throw new Error(`Refusing unsafe canonical smoke isolation target: ${resolved}`);
    }
  }
  return resolved;
}

function assertRunId(runId) {
  const value = String(runId || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) {
    throw new Error("Invalid smoke isolation run ID.");
  }
  return value;
}

function markerPath(target) {
  return path.join(path.resolve(target), MARKER_NAME);
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeMarker(target, { runId, role }) {
  const resolved = assertSafeTarget(target);
  const validRunId = assertRunId(runId);
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Smoke isolation target is not a real directory: ${resolved}`);
  }
  const canonicalPath = await fs.realpath(resolved);
  const parentCanonicalPath = await fs.realpath(path.dirname(resolved));
  const marker = {
    schemaVersion: 1,
    purpose: MARKER_PURPOSE,
    runId: validRunId,
    role: String(role || "").trim(),
    logicalPath: resolved,
    canonicalPath,
    parentCanonicalPath,
    device: String(stat.dev),
    inode: String(stat.ino),
    createdAt: new Date().toISOString(),
  };
  if (!marker.role) throw new Error("Smoke isolation role is required.");
  await fs.writeFile(markerPath(resolved), `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return marker;
}

async function markExistingOwnedDirectory(target, ownership) {
  const resolved = assertSafeTarget(target);
  if (await pathExists(markerPath(resolved))) {
    throw new Error(`Smoke isolation marker already exists: ${markerPath(resolved)}`);
  }
  return writeMarker(resolved, ownership);
}

async function createOwnedDirectory(target, ownership) {
  const resolved = assertSafeTarget(target);
  if (await pathExists(resolved)) {
    throw new Error(`Refusing to claim pre-existing smoke path: ${resolved}`);
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  try {
    await fs.mkdir(resolved);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`Refusing to claim concurrently created smoke path: ${resolved}`);
    }
    throw error;
  }
  try {
    return await writeMarker(resolved, ownership);
  } catch (error) {
    // Leave an unmarked, newly created directory behind on failure. It cannot
    // pass validation and is therefore never eligible for automated deletion.
    throw error;
  }
}

async function createIsolatedRunRoot(prefix = "autochart-smoke-") {
  const base = path.join(os.tmpdir(), String(prefix || "autochart-smoke-"));
  const root = await fs.mkdtemp(base);
  const runId = crypto.randomUUID();
  try {
    await markExistingOwnedDirectory(root, { runId, role: "run-root" });
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { root, runId };
}

async function readAndValidateMarker(target, { runId, role } = {}) {
  const resolved = assertSafeTarget(target);
  const targetStat = await fs.lstat(resolved);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error(`Refusing non-directory or symlink smoke target: ${resolved}`);
  }
  const ownershipPath = markerPath(resolved);
  const markerStat = await fs.lstat(ownershipPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new Error(`Invalid smoke ownership marker: ${ownershipPath}`);
  }
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(ownershipPath, "utf8"));
  } catch (error) {
    throw new Error(`Unreadable smoke ownership marker at ${ownershipPath}: ${error.message}`);
  }
  if (marker?.schemaVersion !== 1 || marker?.purpose !== MARKER_PURPOSE) {
    throw new Error(`Unrecognized smoke ownership marker: ${ownershipPath}`);
  }
  if (runId && marker.runId !== assertRunId(runId)) {
    throw new Error(`Smoke ownership run mismatch for ${resolved}`);
  }
  if (role && marker.role !== role) {
    throw new Error(`Smoke ownership role mismatch for ${resolved}`);
  }
  const canonicalPath = await fs.realpath(resolved);
  const parentCanonicalPath = await fs.realpath(path.dirname(resolved));
  if (
    pathKey(marker.logicalPath) !== pathKey(resolved) ||
    pathKey(marker.canonicalPath) !== pathKey(canonicalPath) ||
    pathKey(marker.parentCanonicalPath) !== pathKey(parentCanonicalPath) ||
    String(marker.device) !== String(targetStat.dev) ||
    String(marker.inode) !== String(targetStat.ino)
  ) {
    throw new Error(`Smoke ownership identity mismatch for ${resolved}`);
  }
  return { marker, stat: targetStat, resolved };
}

async function ensureOwnedDirectory(target, ownership) {
  if (!(await pathExists(target))) return createOwnedDirectory(target, ownership);
  await readAndValidateMarker(target, ownership);
  return null;
}

function quarantinePath(target, runId) {
  const resolved = path.resolve(target);
  const suffix = crypto.randomBytes(8).toString("hex");
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}.quarantine-${runId}-${suffix}`);
}

async function quarantineOwnedDirectory(target, ownership) {
  const validated = await readAndValidateMarker(target, ownership);
  const quarantine = quarantinePath(validated.resolved, validated.marker.runId);
  await fs.rename(validated.resolved, quarantine);
  const movedStat = await fs.lstat(quarantine);
  if (
    !movedStat.isDirectory() ||
    movedStat.isSymbolicLink() ||
    String(movedStat.dev) !== String(validated.stat.dev) ||
    String(movedStat.ino) !== String(validated.stat.ino)
  ) {
    if (!(await pathExists(validated.resolved))) {
      await fs.rename(quarantine, validated.resolved).catch(() => {});
    }
    throw new Error(`Smoke target changed during quarantine: ${validated.resolved}`);
  }
  return { quarantine, validated };
}

async function wipeOwnedDirectory(target, ownership) {
  const { quarantine, validated } = await quarantineOwnedDirectory(target, ownership);
  try {
    await fs.mkdir(validated.resolved);
    await writeMarker(validated.resolved, {
      runId: validated.marker.runId,
      role: validated.marker.role,
    });
  } catch (error) {
    if (!(await pathExists(validated.resolved))) {
      await fs.rename(quarantine, validated.resolved).catch(() => {});
    }
    throw error;
  }
  await fs.rm(quarantine, { recursive: true, force: true });
}

async function removeOwnedDirectory(target, ownership) {
  const { quarantine } = await quarantineOwnedDirectory(target, ownership);
  await fs.rm(quarantine, { recursive: true, force: true });
}

function assertDistinctTargets(entries) {
  const resolved = entries.map(({ role, target }) => ({ role, target: assertSafeTarget(target) }));
  for (let i = 0; i < resolved.length; i += 1) {
    for (let j = i + 1; j < resolved.length; j += 1) {
      const left = resolved[i];
      const right = resolved[j];
      if (isWithin(left.target, right.target) || isWithin(right.target, left.target)) {
        throw new Error(
          `Smoke wipe targets must be separate directories; ${left.role}=${left.target}, ${right.role}=${right.target}`
        );
      }
    }
  }
}

async function canonicalTarget(target) {
  const resolved = assertSafeTarget(target);
  let cursor = resolved;
  const missing = [];
  while (true) {
    try {
      const stat = await fs.lstat(cursor);
      if (cursor === resolved && (!stat.isDirectory() || stat.isSymbolicLink())) {
        throw new Error(`Smoke path must be a real directory when it already exists: ${resolved}`);
      }
      const canonicalParent = await fs.realpath(cursor);
      return path.resolve(canonicalParent, ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error(`Unable to resolve smoke path ancestry: ${resolved}`);
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function validateDistinctTargets(entries) {
  assertDistinctTargets(entries);
  const canonicalEntries = [];
  for (const entry of entries) {
    const canonical = await canonicalTarget(entry.target);
    await assertSafeCanonicalTarget(canonical);
    canonicalEntries.push({ role: entry.role, target: canonical });
  }
  assertDistinctTargets(canonicalEntries);
  return canonicalEntries;
}

module.exports = {
  MARKER_NAME,
  MARKER_PURPOSE,
  assertDistinctTargets,
  assertSafeTarget,
  createIsolatedRunRoot,
  createOwnedDirectory,
  canonicalTarget,
  ensureOwnedDirectory,
  isWithin,
  markerPath,
  pathExists,
  readAndValidateMarker,
  removeOwnedDirectory,
  wipeOwnedDirectory,
  validateDistinctTargets,
};

const fs = require("fs/promises");
const { COPYFILE_FICLONE } = require("fs").constants;
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const { resolveFfmpegPath } = require("./ffmpegPath.cjs");
const { isStrictChild, safeFolderName, strictFileName } = require("./pathSafety.cjs");
const { fsyncDirectory: syncDirectory, fsyncHandle, promoteStagedFile, streamVerifiedToStaging } = require("./fileSafety.cjs");
const {
  ROLE_POLICY,
  assertInlineMediaAsset,
  assertMediaAssetMetadata,
  mediaAssetRole,
  mimeFromMediaFileName,
} = require("./mediaAssetPolicy.cjs");

const AUDIO_NAME = "song.bin";
const ALBUM_NAME = "album.bin";
const BACKGROUND_NAME = "background.bin";
const CHART_NAME = "notes.chart";
const MANIFEST_NAME = "song.json";
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const SOURCE_ASSET = Symbol("autochart.library.sourceAsset");
const CLONE_HERO_ASSET_NAMES = [
  "notes.chart",
  "notes.mid",
  "notes.midi",
  "song.ini",
  "song.ogg",
  "song.mp3",
  "song.wav",
  "song.flac",
  "song.m4a",
  "song.aac",
  "song.opus",
  "song.aiff",
  "song.aif",
  "song.mp4",
  "album.png",
  "album.jpg",
  "background.png",
  "background.jpg",
  "background.webp",
  "background.mp4",
  "video.mp4",
  "video.webm",
  "video.ogv",
];
const CLONE_HERO_ASSET_SET = new Set(CLONE_HERO_ASSET_NAMES);

function getUserDataPath(context) {
  if (typeof context === "string") return context;
  return String(context?.userDataPath || "");
}

function getLibraryRoot(context) {
  if (context && typeof context === "object" && context.projectsFolder) {
    return path.resolve(String(context.projectsFolder));
  }
  return path.join(getUserDataPath(context), "library", "songs");
}

function safeSongId(id) {
  if (!id || typeof id !== "string" || !SAFE_ID_RE.test(id)) {
    throw new Error("Invalid song id.");
  }
  return id;
}

function safeFileName(fileName, fallback) {
  const base = path.basename(String(fileName || fallback || ""));
  return safeFolderName(base.replace(/[^a-zA-Z0-9._ -]/g, "_"), fallback);
}

function shortHash(...parts) {
  const h = crypto.createHash("sha1");
  for (const part of parts) {
    if (part == null) continue;
    h.update(String(part));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isOggAudioAsset(fileName) {
  return String(fileName || "").toLowerCase().endsWith(".ogg");
}

async function atomicWrite(filePath, data, beforeCommit = null) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await fs.writeFile(tmp, data);
    await beforeCommit?.();
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

async function cachePathForSource(cacheDir, src, prefix, ext, variant) {
  const stat = await fs.stat(src);
  // fs.cp preserves timestamps through Date's millisecond precision. Round on
  // both sides so staging a file with fractional milliseconds keeps its cache
  // key, instead of occasionally triggering another full video conversion.
  const key = shortHash(variant, path.basename(src), stat.size, Math.round(stat.mtimeMs));
  return path.join(cacheDir, `${prefix}-${key}${ext}`);
}

async function copyCachedOrTranscode({ cachePath, dest, args }) {
  if (!(await fileExists(cachePath))) {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const ext = path.extname(cachePath);
    const stem = ext ? cachePath.slice(0, -ext.length) : cachePath;
    const tmp = `${stem}.tmp-${process.pid}-${Date.now()}${ext}`;
    try {
      await fs.rm(tmp, { force: true });
      await runFfmpeg([...args, tmp]);
      await fs.rename(tmp, cachePath);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }
  await fs.copyFile(cachePath, dest, COPYFILE_FICLONE);
}

function extFromMime(mime, fallback) {
  const value = String(mime || "").toLowerCase();
  if (!value) return fallback;
  if (value.startsWith("video/") && value.includes("ogg")) return ".ogv";
  if (value.startsWith("video/") && (value.includes("mp4") || value.includes("quicktime"))) return ".mp4";
  if (value.startsWith("video/") && value.includes("webm")) return ".webm";
  if (value.startsWith("video/") && value.includes("matroska")) return ".mkv";
  if (value.includes("flac")) return ".flac";
  if (value.includes("aac")) return ".aac";
  if (value.includes("aiff")) return ".aiff";
  if (value.startsWith("audio/") && (value.includes("mp4") || value.includes("m4a"))) return ".m4a";
  if (value.includes("opus")) return ".opus";
  if (value.includes("ogg")) return ".ogg";
  if (value.includes("mpeg") || value.includes("mp3")) return ".mp3";
  if (value.includes("wav")) return ".wav";
  if (value.includes("png")) return ".png";
  if (value.includes("jpeg") || value.includes("jpg")) return ".jpg";
  if (value.includes("webp")) return ".webp";
  if (value.includes("gif")) return ".gif";
  return fallback;
}

function resolveAssetNames(assets) {
  const audio = assets?.audio;
  const albumArt = assets?.albumArt;
  const background = assets?.background;

  const roleScopedName = (role, asset, fallbackName, fallbackExt) => {
    const raw = safeFileName(asset?.name || fallbackName, fallbackName);
    let ext = path.extname(raw).toLowerCase();
    const replaceLegacyBin = ext === ".bin" && asset?.mime;
    if (!ext || replaceLegacyBin) ext = extFromMime(asset?.mime, fallbackExt);
    const originalExt = path.extname(raw);
    const rawStem = originalExt
      ? raw.slice(0, -originalExt.length)
      : raw;
    const stem = (rawStem || role).slice(0, 160).replace(/[ .]+$/g, "") || role;
    const nonce = shortHash(role, crypto.randomUUID());
    return safeFileName(`${role}-${stem}-${nonce}${ext}`, `${role}-${nonce}${fallbackExt}`);
  };

  return {
    audioFile: roleScopedName("audio", audio, AUDIO_NAME, ".ogg"),
    albumFile: roleScopedName("album", albumArt, ALBUM_NAME, ".png"),
    bgFile: roleScopedName(
      "background",
      background,
      BACKGROUND_NAME,
      background?.type === "video" ? ".mp4" : ".png"
    ),
  };
}

async function assertSelectedSource(source, role) {
  if (!source?.path) throw new Error("Selected media source is missing.");
  const stat = await fs.lstat(source.path);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.dev !== source.device ||
    stat.ino !== source.inode ||
    stat.size !== source.size ||
    stat.mtimeMs !== source.lastModified ||
    await fs.realpath(source.path) !== source.path
  ) {
    throw new Error("Selected media file changed before it could be saved.");
  }
  assertMediaAssetMetadata(role, {
    name: source.name,
    mime: source.mime,
    size: stat.size,
  });
  return stat;
}

async function atomicCopySelected(filePath, source, role, beforeCommit = null, streamOptions = {}) {
  await beforeCommit?.();
  const expectedIdentity = {
    device: source.device,
    inode: source.inode,
    size: source.size,
    lastModified: source.lastModified,
  };
  await assertSelectedSource(source, role);
  const parent = path.dirname(filePath);
  const staged = await streamVerifiedToStaging(source.path, parent, {
    rootDirectory: parent,
    expectedIdentity,
    label: "Selected media file",
    ...streamOptions,
  });
  try {
    await beforeCommit?.();
    await promoteStagedFile(staged.temporary, filePath, {
      rootDirectory: parent,
      label: "Selected media file",
    });
  } finally {
    await fs.rm(staged.temporary, { force: true });
  }
}

async function writeAsset(dir, fileName, asset, role, beforeCommit = null) {
  if (!asset) return;
  const source = asset[SOURCE_ASSET];
  if (source) {
    await atomicCopySelected(path.join(dir, fileName), source, role, beforeCommit);
    return;
  }
  if (!Object.hasOwn(asset, "data")) return;
  assertInlineMediaAsset(role, asset);
  await beforeCommit?.();
  const buf = Buffer.from(asset.data);
  await atomicWrite(path.join(dir, fileName), buf, beforeCommit);
}

function projectWorkPath(root, id, label) {
  const candidate = path.join(
    root,
    `.${safeSongId(id)}.autochart-${label}-${process.pid}-${crypto.randomUUID()}`
  );
  if (!isStrictChild(root, candidate) || path.dirname(candidate) !== root) {
    throw new Error("Project transaction path escaped the projects folder.");
  }
  return candidate;
}

async function directoryState(root, candidate, { allowMissing = false } = {}) {
  let stat;
  try {
    stat = await fs.lstat(candidate);
  } catch (err) {
    if (allowMissing && err?.code === "ENOENT") return null;
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Project storage must be a real directory.");
  }
  const canonicalPath = await fs.realpath(candidate);
  if (canonicalPath !== candidate || path.dirname(canonicalPath) !== root) {
    throw new Error("Project storage is outside the configured projects folder.");
  }
  return { path: canonicalPath, device: stat.dev, inode: stat.ino };
}

function sameDirectoryState(left, right) {
  if (!left || !right) return left === right;
  return left.path === right.path && left.device === right.device && left.inode === right.inode;
}

async function assertRootState(root, expected) {
  const stat = await fs.lstat(root);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.dev !== expected.device ||
    stat.ino !== expected.inode ||
    await fs.realpath(root) !== root
  ) {
    throw new Error("Projects root changed during save.");
  }
}

async function assertProjectTransactionState(root, candidate, expectedProject, stageState) {
  let current;
  try {
    current = await directoryState(root, candidate, { allowMissing: true });
  } catch {
    throw new Error("Project directory changed during save.");
  }
  if (!sameDirectoryState(current, expectedProject)) {
    throw new Error("Project directory changed during save.");
  }
  let currentStage;
  try {
    currentStage = await directoryState(root, stageState.path);
  } catch {
    throw new Error("Project staging directory changed during save.");
  }
  if (!sameDirectoryState(currentStage, stageState)) {
    throw new Error("Project staging directory changed during save.");
  }
}

async function promoteStagedProject({
  root,
  rootState,
  candidate,
  expectedProject,
  stageState,
  backup,
  beforeStagePromote,
}) {
  await assertRootState(root, rootState);
  await assertProjectTransactionState(root, candidate, expectedProject, stageState);
  let backedUp = false;
  let promoted = false;
  try {
    if (expectedProject) {
      await fs.rename(candidate, backup);
      backedUp = true;
      const backupState = await directoryState(root, backup);
      if (
        backupState.device !== expectedProject.device ||
        backupState.inode !== expectedProject.inode
      ) {
        throw new Error("Project directory changed during promotion.");
      }
    }
    await beforeStagePromote?.();
    await assertRootState(root, rootState);
    const occupiedDestination = await directoryState(root, candidate, { allowMissing: true });
    if (occupiedDestination) {
      throw new Error("Project destination changed during promotion.");
    }
    const currentStage = await directoryState(root, stageState.path);
    if (
      currentStage.device !== stageState.device ||
      currentStage.inode !== stageState.inode
    ) {
      throw new Error("Project staging directory changed during promotion.");
    }
    if (backedUp) {
      const currentBackup = await directoryState(root, backup);
      if (
        currentBackup.device !== expectedProject.device ||
        currentBackup.inode !== expectedProject.inode
      ) {
        throw new Error("Project backup changed during promotion.");
      }
    }
    await fs.rename(stageState.path, candidate);
    promoted = true;
    await syncDirectory(root);
  } catch (promotionError) {
    try {
      if (promoted) {
        const current = await directoryState(root, candidate);
        if (
          current.device !== stageState.device ||
          current.inode !== stageState.inode
        ) {
          throw new Error("Promoted project changed before rollback.");
        }
        await fs.rename(candidate, stageState.path);
        promoted = false;
      }
      if (backedUp) {
        const current = await directoryState(root, candidate, { allowMissing: true });
        if (current) throw new Error("Project destination is occupied during rollback.");
        await fs.rename(backup, candidate);
        backedUp = false;
      }
      await syncDirectory(root);
    } catch (rollbackError) {
      const error = new Error(
        `Project save failed and the prior project could not be restored. ` +
        `Its backup remains at ${backup}. ${promotionError.message} ` +
        `Rollback failed: ${rollbackError.message}`
      );
      error.cause = promotionError;
      throw error;
    }
    throw promotionError;
  }

  if (backedUp) {
    try {
      await fs.rm(backup, { recursive: true, force: true });
      await syncDirectory(root);
    } catch (cleanupError) {
      // The new project is already durably promoted. Keep the exact prior
      // backup rather than reporting a false save failure or deleting it by a
      // broader cleanup path.
      console.error(`Saved project, but could not remove prior backup at ${backup}: ${cleanupError.message}`);
    }
  }
}

async function copyProjectContents(sourceDir, stageDir) {
  const entries = await fs.readdir(sourceDir);
  for (const name of entries) {
    await fs.cp(path.join(sourceDir, name), path.join(stageDir, name), {
      // Independent copy-on-write files on APFS/Btrfs/etc.; ordinary copies on
      // filesystems without cloning. Never hard-link mutable project files.
      mode: COPYFILE_FICLONE,
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
  }
}

const projectWrites = new Map();

function serializeProjectWrite(context, id, operation) {
  const key = path.join(getLibraryRoot(context), safeSongId(id));
  const previous = projectWrites.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(operation);
  projectWrites.set(key, task);
  const cleanup = () => { if (projectWrites.get(key) === task) projectWrites.delete(key); };
  task.then(cleanup, cleanup);
  return task;
}

function saveSong(context, payload, options = {}) {
  return serializeProjectWrite(context, payload?.record?.id, () => saveSongUnlocked(context, payload, options));
}

function updateSong(context, id, update) {
  return serializeProjectWrite(context, id, async () => {
    const existing = await getSongUnlocked(context, id);
    if (!existing) throw new Error("Project not found in library storage.");
    const payload = await update(existing);
    return payload ? saveSongUnlocked(context, payload) : existing;
  });
}

function patchSong(context, payload) {
  const patch = payload.record;
  return updateSong(context, patch.id, (existing) => {
    const record = { ...existing, ...patch, updatedAt: Date.now() };
    for (const key of ["meta", "settings", "chart", "assets"]) {
      if (patch[key]) record[key] = { ...existing[key], ...patch[key] };
    }
    return { ...payload, record };
  });
}

async function saveSongUnlocked(context, payload, options = {}) {
  const record = payload?.record;
  if (!record?.id) throw new Error("Song record must include an id.");
  const id = safeSongId(record.id);
  const root = await canonicalProjectRoot(context, { create: true });
  const rootStat = await fs.lstat(root);
  const rootState = { path: root, device: rootStat.dev, inode: rootStat.ino };
  const candidate = path.join(root, id);
  const expectedProject = await directoryState(root, candidate, { allowMissing: true });
  let existing = null;
  if (expectedProject) {
    existing = await readManifest(expectedProject.path, id);
  }
  const stage = projectWorkPath(root, id, "stage");
  const backup = projectWorkPath(root, id, "backup");
  let stageState = null;
  try {
    await options.beforeWrite?.();
    await assertRootState(root, rootState);
    let beforeCopy;
    try {
      beforeCopy = await directoryState(root, candidate, { allowMissing: true });
    } catch {
      throw new Error("Project directory changed during save.");
    }
    if (!sameDirectoryState(beforeCopy, expectedProject)) {
      throw new Error("Project directory changed during save.");
    }
    await fs.mkdir(stage);
    stageState = await directoryState(root, stage);
    if (expectedProject) await copyProjectContents(expectedProject.path, stage);
    const assertIdentity = async () => {
      await options.beforeWrite?.();
      await assertRootState(root, rootState);
      await assertProjectTransactionState(root, candidate, expectedProject, stageState);
    };
    await assertIdentity();

    const assets = payload.assets || {};
    const names = resolveAssetNames(assets);
    let chartFile = existing?.chart?.file || record.chart?.file || CHART_NAME;
    if (typeof record.chart?.text === "string") {
      chartFile = CHART_NAME;
      await atomicWrite(path.join(stage, chartFile), record.chart.text, assertIdentity);
    }
    if (assets.audio) {
      await writeAsset(
        stage,
        names.audioFile,
        assets.audio,
        mediaAssetRole("audio", assets.audio),
        assertIdentity
      );
    }
    if (assets.albumArt) {
      await writeAsset(
        stage,
        names.albumFile,
        assets.albumArt,
        mediaAssetRole("albumArt", assets.albumArt),
        assertIdentity
      );
    }
    if (assets.background) {
      await writeAsset(
        stage,
        names.bgFile,
        assets.background,
        mediaAssetRole("background", assets.background),
        assertIdentity
      );
    }

    // Missing upload bytes preserve media; an explicit null declaration removes it.
    const clearBackground = !assets.background && record.assets?.background === null;
    const mergedAssets = {
      audio: assets.audio
        ? names.audioFile
        : existing?.assets?.audio || record.assets?.audio || null,
      albumArt: assets.albumArt
        ? names.albumFile
        : existing?.assets?.albumArt || record.assets?.albumArt || null,
      background: assets.background
        ? {
            type: assets.background.type || record.assets?.background?.type || "image",
            file: names.bgFile,
          }
        : clearBackground ? null : existing?.assets?.background || record.assets?.background || null,
    };
    const manifest = {
      ...(existing || {}),
      ...record,
      id,
      assets: mergedAssets,
      chart: { file: chartFile },
    };

    const retained = new Set([
      chartFile,
      mergedAssets.audio,
      mergedAssets.albumArt,
      mergedAssets.background?.file,
    ].filter(Boolean));
    const superseded = [
      assets.audio ? existing?.assets?.audio : "",
      assets.albumArt ? existing?.assets?.albumArt : "",
      assets.background || clearBackground ? existing?.assets?.background?.file : "",
    ].filter((name) => name && !retained.has(name));
    for (const oldName of new Set(superseded)) {
      await assertIdentity();
      await fs.rm(path.join(stage, strictFileName(oldName, "superseded media asset")), {
        force: true,
      });
    }

    validateManifestStructure(manifest, id);
    await atomicWrite(
      path.join(stage, MANIFEST_NAME),
      JSON.stringify(manifest, null, 2),
      assertIdentity
    );
    await validateManifest(stage, manifest, id);
    await syncStagedExport(stage);
    await options.beforePromote?.();
    await promoteStagedProject({
      root,
      rootState,
      candidate,
      expectedProject,
      stageState,
      backup,
      beforeStagePromote: options.beforeStagePromote,
    });
    stageState = null;
    return manifest;
  } finally {
    if (stageState) {
      let currentStage = null;
      try {
        currentStage = await directoryState(root, stage, { allowMissing: true });
      } catch {
        // A replaced work path is never recursively removed.
      }
      if (sameDirectoryState(currentStage, stageState)) {
        await fs.rm(stage, { recursive: true, force: true });
      }
    }
  }
}

async function canonicalProjectRoot(context, { create = false } = {}) {
  const root = getLibraryRoot(context);
  if (create) await fs.mkdir(root, { recursive: true });
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Projects root must be a real directory.");
  }
  return fs.realpath(root);
}

async function canonicalProjectDir(context, id, { create = false } = {}) {
  const root = await canonicalProjectRoot(context, { create });
  const candidate = path.join(root, safeSongId(id));
  let stat;
  try {
    stat = await fs.lstat(candidate);
  } catch (err) {
    if (!create || err?.code !== "ENOENT") throw err;
    await fs.mkdir(candidate);
    stat = await fs.lstat(candidate);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Project storage must be a real directory.");
  }
  const canonicalDir = await fs.realpath(candidate);
  if (!isStrictChild(root, canonicalDir) || path.dirname(canonicalDir) !== root) {
    throw new Error("Project storage is outside the configured projects folder.");
  }
  return canonicalDir;
}

async function canonicalProjectFile(projectDir, fileName, label = "project asset") {
  const name = strictFileName(fileName, label);
  const candidate = path.join(projectDir, name);
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a real file.`);
  }
  const canonicalPath = await fs.realpath(candidate);
  if (path.dirname(canonicalPath) !== projectDir) {
    throw new Error(`${label} is outside its project directory.`);
  }
  return { path: canonicalPath, name, stat };
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function declaredFileName(value, label) {
  const name = strictFileName(value, label);
  if (safeFileName(name, "asset.bin") !== name) {
    throw new Error(`${label} is not a platform-safe file name.`);
  }
  return name;
}

function declaredMediaName(value, role, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a file name.`);
  const name = declaredFileName(value, label);
  const ext = path.extname(name).toLowerCase();
  if (ext !== ".bin" && !ROLE_POLICY[role].extensions.has(ext)) {
    throw new Error(`${label} has an unsupported file type.`);
  }
  return name;
}

function validateManifestStructure(manifest, expectedId) {
  if (!isPlainObject(manifest)) throw new Error("Project manifest must be a plain object.");
  if (typeof manifest.id !== "string" || manifest.id !== expectedId || !SAFE_ID_RE.test(manifest.id)) {
    throw new Error("Project manifest id does not match its directory.");
  }

  let chartFile = "";
  if (manifest.chart != null) {
    if (!isPlainObject(manifest.chart)) throw new Error("Project chart declaration must be an object.");
    if (manifest.chart.file != null) {
      if (typeof manifest.chart.file !== "string") {
        throw new Error("Chart asset must be a file name.");
      }
      chartFile = declaredFileName(manifest.chart.file, "chart file");
      if (path.extname(chartFile).toLowerCase() !== ".chart") {
        throw new Error("Chart asset must use the .chart file type.");
      }
    }
    if (manifest.chart.text != null && typeof manifest.chart.text !== "string") {
      throw new Error("Inline chart data must be text.");
    }
  }

  const assets = manifest.assets == null ? {} : manifest.assets;
  if (!isPlainObject(assets)) throw new Error("Project media declaration must be an object.");
  const audio = assets.audio == null
    ? ""
    : declaredMediaName(assets.audio, "audio", "audio asset");
  const albumArt = assets.albumArt == null
    ? ""
    : declaredMediaName(assets.albumArt, "albumArt", "album art asset");
  let background = null;
  if (assets.background != null) {
    if (!isPlainObject(assets.background)) {
      throw new Error("Background asset declaration must be an object.");
    }
    if (assets.background.type !== "image" && assets.background.type !== "video") {
      throw new Error("Background asset type must be image or video.");
    }
    const role = assets.background.type === "video"
      ? "background-video"
      : "background-image";
    background = {
      type: assets.background.type,
      file: declaredMediaName(assets.background.file, role, "background asset"),
    };
  }
  return { chartFile, audio, albumArt, background };
}

async function validateManifestFiles(dir, declarations, manifest) {
  if (declarations.chartFile) {
    await canonicalProjectFile(dir, declarations.chartFile, "chart file");
  } else if (typeof manifest.chart?.text !== "string") {
    throw new Error("Project manifest has no chart data.");
  }
  if (declarations.audio) {
    await canonicalProjectFile(dir, declarations.audio, "audio asset");
  }
  if (declarations.albumArt) {
    await canonicalProjectFile(dir, declarations.albumArt, "album art asset");
  }
  if (declarations.background?.file) {
    await canonicalProjectFile(dir, declarations.background.file, "background asset");
  }
}

async function validateManifest(dir, manifest, expectedId = path.basename(dir)) {
  const declarations = validateManifestStructure(manifest, expectedId);
  await validateManifestFiles(dir, declarations, manifest);
  return manifest;
}

async function readManifest(dir, expectedId = path.basename(dir)) {
  const manifestFile = await canonicalProjectFile(dir, MANIFEST_NAME, "project manifest");
  const raw = await fs.readFile(manifestFile.path, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Project manifest is not valid JSON: ${err.message}`);
  }
  return validateManifest(dir, manifest, expectedId);
}

async function listSongs(context) {
  const root = await canonicalProjectRoot(context, { create: true });
  const entries = await fs.readdir(root, { withFileTypes: true });
  const records = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || !SAFE_ID_RE.test(ent.name)) continue;
    try {
      const dir = await canonicalProjectDir(context, ent.name);
      records.push(await readManifest(dir));
    } catch {
      /* skip corrupt or unsafe project folders */
    }
  }
  return records.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getSong(context, id) {
  // Saves replace the complete project directory. Queue reads with writes so a
  // renderer cannot see the short backup/promotion gap or a mixed manifest/chart.
  return serializeProjectWrite(context, id, () => getSongUnlocked(context, id));
}

async function getSongUnlocked(context, id) {
  const dir = await canonicalProjectDir(context, id);
  const manifest = await readManifest(dir);
  if (manifest.chart?.file != null) strictFileName(manifest.chart.file, "chart file");
  let chartText = "";
  if (typeof manifest.chart?.text === "string") {
    chartText = manifest.chart.text;
  } else {
    const chartFileName = manifest.chart?.file || CHART_NAME;
    try {
      const chartFile = await canonicalProjectFile(dir, chartFileName, "chart file");
      chartText = await fs.readFile(chartFile.path, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  }
  return { ...manifest, chart: { ...manifest.chart, text: chartText } };
}

async function getProjectDeletionDetails(context, id) {
  const canonicalDir = await canonicalProjectDir(context, id);
  const manifest = await readManifest(canonicalDir);
  return {
    id: safeSongId(id),
    title: String(manifest.meta?.title || manifest.title || id),
    path: canonicalDir,
    disposition: "trash",
  };
}

async function assetUrl(context, id, fileName) {
  const source = await getMediaAssetSource(context, id, fileName);
  return pathToFileURL(source.path).href;
}

async function readAssetBuffer(context, id, fileName) {
  const source = await getMediaAssetSource(context, id, fileName);
  return fs.readFile(source.path);
}

async function getAssetSource(context, id, fileName) {
  const asset = await getMediaAssetSource(context, id, fileName, "audio");
  return {
    path: asset.path,
    name: asset.name,
    size: asset.size,
    lastModified: asset.lastModified,
  };
}

async function getMediaAssetSource(context, id, fileName, expectedRole = "") {
  const name = strictFileName(fileName, "project media asset");
  const projectDir = await canonicalProjectDir(context, id);
  const manifest = await readManifest(projectDir);
  const declared = [
    manifest.assets?.audio
      ? { name: manifest.assets.audio, role: "audio" }
      : null,
    manifest.assets?.albumArt
      ? { name: manifest.assets.albumArt, role: "albumArt" }
      : null,
    manifest.assets?.background?.file
      ? {
          name: manifest.assets.background.file,
          role: manifest.assets.background.type === "video"
            ? "background-video"
            : "background-image",
        }
      : null,
  ].filter(Boolean);
  const match = declared.find((item) => item.name === name);
  if (!match || (expectedRole && match.role !== expectedRole)) {
    throw new Error("Media file is not a declared project asset.");
  }
  const asset = await canonicalProjectFile(projectDir, name, "project media asset");
  const legacyBinFallback = {
    audio: { name: "legacy.ogg", mime: "audio/ogg" },
    albumArt: { name: "legacy.png", mime: "image/png" },
    "background-image": { name: "legacy.png", mime: "image/png" },
    "background-video": { name: "legacy.mp4", mime: "video/mp4" },
  }[match.role];
  const legacyBin = path.extname(asset.name).toLowerCase() === ".bin";
  const mime = legacyBin
    ? legacyBinFallback.mime
    : mimeFromMediaFileName(asset.name);
  assertMediaAssetMetadata(match.role, {
    // Schema v1/v2 manifests could use role-scoped *.bin names. They are safe
    // only after the manifest declaration check above; new selected *.bin
    // imports remain rejected by the main-process policy.
    name: legacyBin ? legacyBinFallback.name : asset.name,
    mime,
    size: asset.stat.size,
  });
  return {
    path: asset.path,
    name: asset.name,
    mime,
    size: asset.stat.size,
    lastModified: asset.stat.mtimeMs,
    device: asset.stat.dev,
    inode: asset.stat.ino,
    role: match.role,
  };
}

function buildSongIni(meta, settings, resources = {}) {
  const lines = ["[song]"];
  const iniValue = (value) => String(value ?? "").replace(/\r\n?|[\n\u2028\u2029]/g, " ").trim();
  const fields = [
    ["name", iniValue(meta.title) || "Untitled"],
    ["artist", meta.artist],
    ["album", meta.album],
    ["year", meta.year],
    ["genre", meta.genre],
    ["charter", meta.charter],
    ["autochart_provenance_version", meta.autochart_provenance_version],
    ["autochart_ai_generated", meta.autochart_ai_generated],
    ["autochart_generated_difficulties", meta.autochart_generated_difficulties],
    ["autochart_generator", meta.autochart_generator],
    // Marks the folder as an Autochart export so a later export may replace it.
    ["autochart_export", "1"],
    ["loading_phrase", meta.autochart_ai_generated === "true"
      ? `Contains AI-generated guitar difficulties: ${meta.autochart_generated_difficulties}. Generated with Autochart.`
      : ""],
    ["song_length", meta.durationSec ? Math.round(meta.durationSec * 1000) : ""],
    // No diff_guitar/diff_band tier: YARG and Clone Hero parse those as integer
    // star tiers (0-6) and we have no honest tier for a generated chart, so the
    // games fall back to their "unset" display instead of garbage values.
    ["background", resources.background || ""],
    ["video", resources.video || ""],
    ["video_start_time", resources.video ? resources.videoStartTime ?? 0 : ""],
  ];
  for (const [key, val] of fields) {
    const value = iniValue(val);
    if (value) lines.push(`${key} = ${value}`);
  }
  return lines.join("\n") + "\n";
}

function cloneHeroBackgroundName(bg) {
  const file = String(bg?.file || "").toLowerCase();
  const type = bg?.type || "image";
  if (type === "video") {
    return "video.webm";
  }
  if (/\.(jpe?g|webp|gif)$/.test(file)) return "background.jpg";
  return "background.png";
}

function cloneHeroAlbumName(file) {
  file = String(file || "").toLowerCase();
  if (/\.(jpe?g|webp|gif)$/.test(file)) return "album.jpg";
  return "album.png";
}

function cloneHeroAudioName() {
  return "song.ogg";
}

function runFfmpeg(args) {
  const bin = resolveFfmpegPath();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-hide_banner", "-loglevel", "error", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error("ffmpeg is required to convert export media. Install ffmpeg or repair the Autochart installation."));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const input = args[args.indexOf("-i") + 1];
        const name = path.basename(input || "media");
        const error = new Error(
          `Could not convert "${name}" for Clone Hero / YARG. ` +
          "The file may be damaged or use an unsupported media format. Try replacing it."
        );
        // Keep codec diagnostics for logs and the legacy Vorbis fallback,
        // without putting pages of FFmpeg output into the UI's error message.
        error.stderr = stderr.trim();
        console.error(`[export] FFmpeg failed (${code}): ${error.stderr}`);
        reject(error);
      }
    });
  });
}

async function writeCloneHeroAudio(src, destDir, sourceFileName, cacheDir) {
  const destName = cloneHeroAudioName();
  const dest = path.join(destDir, destName);
  if (isOggAudioAsset(sourceFileName)) {
    await fs.copyFile(src, dest, COPYFILE_FICLONE);
    return;
  }
  const cachePath = await cachePathForSource(cacheDir, src, "song", ".ogg", "ogg-vorbis-q5-v1");
  try {
    await copyCachedOrTranscode({
      cachePath,
      dest,
      args: ["-y", "-i", src, "-map", "0:a:0", "-vn", "-c:a", "libvorbis", "-q:a", "5"],
    });
  } catch (err) {
    if (!/Unknown encoder 'libvorbis'|Encoder not found/i.test(String(err?.stderr || err?.message || ""))) throw err;
    const fallbackCachePath = await cachePathForSource(cacheDir, src, "song", ".ogg", "ogg-vorbis-native-q5-v1");
    await copyCachedOrTranscode({
      cachePath: fallbackCachePath,
      dest,
      args: ["-y", "-i", src, "-map", "0:a:0", "-vn", "-ac", "2", "-c:a", "vorbis", "-strict", "-2", "-q:a", "5"],
    });
  }
}

async function writeCloneHeroBackground(src, destDir, bg, cacheDir) {
  const destName = cloneHeroBackgroundName(bg);
  const dest = path.join(destDir, destName);
  if (bg?.type === "video") {
    const variant = "webm-vp8-w854-b1200k-cpu8-v1";
    const cachePath = await cachePathForSource(cacheDir, src, "video", ".webm", variant);
    await copyCachedOrTranscode({
      cachePath,
      dest,
      args: [
        "-y",
        "-i",
        src,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        "scale='min(854,iw)':-2",
        "-c:v",
        "libvpx",
        "-deadline",
        "realtime",
        "-cpu-used",
        "8",
        "-threads",
        "0",
        "-b:v",
        "1200k",
        "-pix_fmt",
        "yuv420p",
      ],
    });
    return;
  }
  await writeCloneHeroImage(src, dest, cacheDir);
}

async function writeCloneHeroImage(src, dest, cacheDir) {
  // Clone Hero supports PNG/JPEG, not the WebP/GIF accepted by our picker.
  // Preserve supported images; flatten other formats to their first frame.
  if (!/\.(webp|gif)$/i.test(src)) {
    await fs.copyFile(src, dest, COPYFILE_FICLONE);
    return;
  }
  const cachePath = await cachePathForSource(cacheDir, src, "image", ".jpg", "jpeg-first-frame-q2-v1");
  await copyCachedOrTranscode({
    cachePath,
    dest,
    args: ["-y", "-i", src, "-map", "0:v:0", "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj420p", "-update", "1"],
  });
}

function cloneHeroSongFolderName(song, { copy = false } = {}) {
  const title = String(song?.meta?.title || song?.id || "song").trim();
  const artist = String(song?.meta?.artist || "").trim();
  const base = artist && title ? `${artist} - ${title}` : title;
  return safeFolderName(copy ? `${base} (Autochart)` : base);
}

function folderPathValue(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return folderPathValue(value[0]);
  if (value && typeof value === "object") {
    if (Array.isArray(value.filePaths)) return folderPathValue(value.filePaths[0]);
    if (value.settings?.cloneHeroLibraryFolder != null) {
      return folderPathValue(value.settings.cloneHeroLibraryFolder);
    }
    for (const key of ["path", "filePath", "folderPath", "folder", "value"]) {
      if (typeof value[key] === "string") return value[key].trim();
    }
  }
  return "";
}

async function chartForExport(song, versionId) {
  const versions = Array.isArray(song.versions) ? song.versions : [];
  const hasVersionCharts = versions.some((v) => v.chart?.text);
  const requested = versionId ? versions.find((v) => v.id === versionId) : null;
  if (versionId && !requested && hasVersionCharts) {
    throw new Error("Selected chart version not found.");
  }

  const activeId = song.settings?.activeVersionId;
  const active = activeId ? versions.find((v) => v.id === activeId) : null;
  const fallback = versions.find((v) => v.chart?.text);
  const version = requested || active || fallback || null;
  const chartText = version?.chart?.text || song.chart?.text || "";
  if (!chartText) throw new Error("Selected chart version has no notes.chart data.");

  const { exportChartMetadata } = await import("../shared/chartProvenance.js");
  const metadata = exportChartMetadata(version || { ...song, chart: { text: chartText } }, song.meta, versions);
  return {
    chartText: metadata.chartText,
    songMeta: metadata.meta,
    settings: { ...(song.settings || {}), ...(version?.settings || {}) },
    meta: version?.meta || {},
    versionId: version?.id || null,
  };
}

function isInsidePath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}
function siblingWorkPath(destDir, label) {
  const parent = path.dirname(path.resolve(destDir));
  const base = path.basename(path.resolve(destDir));
  return path.join(
    parent,
    `.${base}.autochart-${label}-${process.pid}-${crypto.randomUUID()}`
  );
}

async function pathExists(filePath) {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}
async function exportDestinationState(destDir) {
  let stat;
  try {
    stat = await fs.lstat(destDir);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Export destination cannot be a symbolic link: ${destDir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Export destination must be a directory: ${destDir}`);
  }
  return {
    canonicalPath: await fs.realpath(destDir),
    device: stat.dev,
    inode: stat.ino,
  };
}

// Exact loading phrase buildSongIni has written since the first release; exports
// made before `autochart_export` existed are recognised by it or by provenance.
const LEGACY_EXPORT_LOADING_PHRASE_RE =
  /^Contains AI-generated guitar difficulties: (?:easy|medium|hard|expert)(?:,(?:easy|medium|hard|expert))*\. Generated with Autochart\.$/;

// Values of every key in the [song] section(s), ignoring comments and any
// other section, so a marker only counts where the games read metadata.
function songIniFields(text) {
  const fields = new Map();
  let inSong = false;
  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r\n?|\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const section = /^\[(.*)\]$/.exec(line);
    if (section) {
      inSong = section[1].trim().toLowerCase() === "song";
      continue;
    }
    const separator = line.indexOf("=");
    if (!inSong || separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const values = fields.get(key) || [];
    values.push(line.slice(separator + 1).trim());
    fields.set(key, values);
  }
  return fields;
}

function isAutochartExportIni(text) {
  const fields = songIniFields(text);
  // Every occurrence must agree, so a later override cannot disown the marker.
  const affirmed = (key, accept) => {
    const values = fields.get(key);
    return Boolean(values?.length) && values.every(accept);
  };
  return (
    affirmed("autochart_export", (value) => value === "1") ||
    affirmed("autochart_provenance_version", (value) => value === "1") ||
    affirmed("loading_phrase", (value) => LEGACY_EXPORT_LOADING_PHRASE_RE.test(value))
  );
}

// Re-exporting replaces managed chart/audio/art files, which is only safe when
// the folder is a previous Autochart export. Refuse to clobber any other song.
async function assertReplaceableExportDestination(destDir) {
  const entries = await fs.readdir(destDir);
  const managed = entries.filter((name) => CLONE_HERO_ASSET_SET.has(name.toLowerCase()));
  if (managed.length === 0) return;
  const iniNames = managed.filter((name) => name.toLowerCase() === "song.ini");
  let owned = iniNames.length > 0;
  for (const name of iniNames) {
    const iniPath = path.join(destDir, name);
    const stat = await fs.lstat(iniPath);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size > 256 * 1024 ||
      !isAutochartExportIni(await fs.readFile(iniPath, "utf8"))
    ) {
      owned = false;
      break;
    }
  }
  if (owned) return;
  throw new Error(
    `"${path.basename(destDir)}" already contains a song that was not exported by Autochart ` +
    `(${managed.join(", ")}). Choose a different folder so those files are not replaced.`
  );
}

function sameDestinationState(expected, current) {
  if (!expected || !current) return expected === current;
  return (
    expected.canonicalPath === current.canonicalPath &&
    expected.device === current.device &&
    expected.inode === current.inode
  );
}


async function syncFile(filePath) {
  // Windows FlushFileBuffers requires write access; a read-only open returns EPERM.
  // Cloud folders such as OneDrive can still refuse fsync even with write access.
  const handle = await fs.open(filePath, process.platform === "win32" ? "r+" : "r");
  try {
    await fsyncHandle(handle);
  } finally {
    await handle.close();
  }
}

async function syncStagedExport(stageDir) {
  const entries = await fs.readdir(stageDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) await syncFile(path.join(stageDir, entry.name));
  }
  await syncDirectory(stageDir);
}

async function promoteStagedExport(stageDir, destDir, expectedDestination) {
  const parent = path.dirname(path.resolve(destDir));
  const backupDir = siblingWorkPath(destDir, "backup");
  let backedUp = false;
  let promoted = false;

  const currentDestination = await exportDestinationState(destDir);
  if (!sameDestinationState(expectedDestination, currentDestination)) {
    throw new Error("Export destination changed while the replacement was being prepared.");
  }
  if (currentDestination) {
    await fs.rename(destDir, backupDir);
    backedUp = true;
  }

  try {
    await syncDirectory(parent);
    await fs.rename(stageDir, destDir);
    promoted = true;
    await syncDirectory(parent);
  } catch (promotionError) {
    try {
      if (promoted && await pathExists(destDir)) {
        await fs.rename(destDir, stageDir);
      }
      if (backedUp) {
        await fs.rename(backupDir, destDir);
        backedUp = false;
      }
      await syncDirectory(parent);
    } catch (rollbackError) {
      const error = new Error(
        `Export promotion failed and the prior export could not be restored. ` +
        `Its backup remains at ${backupDir}. ${promotionError.message} ` +
        `Rollback failed: ${rollbackError.message}`
      );
      error.cause = promotionError;
      throw error;
    }
    throw promotionError;
  }

  if (backedUp) {
    await fs.rm(backupDir, { recursive: true, force: true });
    await syncDirectory(parent);
  }
}

/**
 * @param {string} userDataPath
 * @param {string} songId
 * @param {string} destDir
 */
async function exportSongToFolder(userDataPath, songId, destDir, options = {}) {
  const appUserDataPath = getUserDataPath(userDataPath);
  const internalDir = await canonicalProjectDir(userDataPath, songId);
  const exportCacheDir = path.join(internalDir, ".export-cache");
  const song = await getSong(userDataPath, songId);
  const exportChart = await chartForExport(song, options.versionId);
  const bg = song.assets?.background;
  const backgroundName = bg?.file ? cloneHeroBackgroundName(bg) : "";
  const leadInSilenceMs = Number(exportChart.meta?.leadInSilenceMs || 0) || 0;
  const analysisAudioPath = String(exportChart.meta?.analysisAudioPath || "");
  const configuredCacheFolder =
    userDataPath && typeof userDataPath === "object"
      ? String(userDataPath.cacheFolder || "")
      : "";
  const legacyCacheFolder =
    userDataPath && typeof userDataPath === "object"
      ? String(userDataPath.legacyCacheFolder || "")
      : "";
  const engineCacheRoots = [
    configuredCacheFolder ? path.join(configuredCacheFolder, "engine") : "",
    legacyCacheFolder ? path.join(legacyCacheFolder, "engine") : "",
    appUserDataPath ? path.join(appUserDataPath, "cache", "engine") : "",
  ].filter(Boolean);
  let canonicalAnalysisAudio = "";
  if (analysisAudioPath) {
    try {
      const stat = await fs.lstat(analysisAudioPath);
      if (!stat.isSymbolicLink() && stat.isFile()) {
        const candidate = await fs.realpath(analysisAudioPath);
        for (const cacheRoot of engineCacheRoots) {
          try {
            const canonicalRoot = await fs.realpath(cacheRoot);
            if (isInsidePath(canonicalRoot, candidate) && canonicalRoot !== candidate) {
              canonicalAnalysisAudio = candidate;
              break;
            }
          } catch {
            /* unavailable cache root */
          }
        }
      }
    } catch {
      /* missing analysis cache */
    }
  }
  const hasAnalysisAudio = Boolean(canonicalAnalysisAudio);
  if (leadInSilenceMs > 0 && !hasAnalysisAudio) {
    throw new Error("This chart was generated with lead-in silence, but its padded audio cache is missing. Regenerate the chart before exporting.");
  }
  const audioAsset = !hasAnalysisAudio && song.assets?.audio
    ? await canonicalProjectFile(internalDir, song.assets.audio, "audio asset")
    : null;
  const audioSourcePath = hasAnalysisAudio ? canonicalAnalysisAudio : audioAsset?.path || "";
  if (!audioSourcePath) throw new Error("Add song audio before exporting to Clone Hero / YARG.");
  const albumAsset = song.assets?.albumArt
    ? await canonicalProjectFile(internalDir, song.assets.albumArt, "album asset")
    : null;
  const backgroundAsset = bg?.file
    ? await canonicalProjectFile(internalDir, bg.file, "background asset")
    : null;
  const iniResources = {
    background: bg?.type === "video" ? "" : backgroundName,
    video: bg?.type === "video" ? backgroundName : "",
    // The exported audio has silence prepended, but the source video does not.
    // Clone Hero and YARG use negative values to delay video playback.
    videoStartTime: bg?.type === "video" && leadInSilenceMs > 0 ? -leadInSilenceMs : 0,
  };
  const exportedDurationSec = Number(exportChart.meta?.durationSec) > 0
    ? Number(exportChart.meta.durationSec)
    : Number(song.meta?.durationSec || 0) + leadInSilenceMs / 1000;
  const resolvedDestDir = path.resolve(destDir);
  const parentDir = path.dirname(resolvedDestDir);
  const stageDir = siblingWorkPath(resolvedDestDir, "stage");
  await fs.mkdir(parentDir, { recursive: true });
  const destinationState = await exportDestinationState(resolvedDestDir);
  if (destinationState) await assertReplaceableExportDestination(resolvedDestDir);

  try {
    if (destinationState) {
      await fs.cp(resolvedDestDir, stageDir, {
        mode: COPYFILE_FICLONE,
        // Preserve user-added files, but skip assets this export replaces.
        // YARG resolves names case-insensitively and prefers MIDI over .chart.
        filter: async (source) => {
          if (path.dirname(source) !== resolvedDestDir ||
              !CLONE_HERO_ASSET_SET.has(path.basename(source).toLowerCase())) return true;
          // A directory with a managed filename may contain user data. As with
          // the previous non-recursive removal, refuse to replace it.
          if ((await fs.lstat(source)).isDirectory()) {
            throw new Error(`Cannot replace export asset directory: ${path.basename(source)}`);
          }
          return false;
        },
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
        verbatimSymlinks: true,
        preserveTimestamps: true,
      });
    } else {
      await fs.mkdir(stageDir);
    }
    await atomicWrite(path.join(stageDir, "notes.chart"), exportChart.chartText);
    await atomicWrite(
      path.join(stageDir, "song.ini"),
      buildSongIni({ ...exportChart.songMeta, durationSec: exportedDurationSec }, exportChart.settings, iniResources)
    );

    if (audioSourcePath) {
      await writeCloneHeroAudio(audioSourcePath, stageDir, path.basename(audioSourcePath), exportCacheDir);
    }
    if (albumAsset) {
      await writeCloneHeroImage(albumAsset.path, path.join(stageDir, cloneHeroAlbumName(albumAsset.name)), exportCacheDir);
    }
    if (backgroundAsset) {
      await writeCloneHeroBackground(backgroundAsset.path, stageDir, bg, exportCacheDir);
    }

    await syncStagedExport(stageDir);
    await promoteStagedExport(stageDir, resolvedDestDir, destinationState);
  } finally {
    if (await pathExists(stageDir)) {
      await fs.rm(stageDir, { recursive: true, force: true });
    }
  }

  return { path: resolvedDestDir, format: "clone-hero", songId, versionId: exportChart.versionId };
}

async function saveSongToCloneHeroLibrary(userDataPath, songId, cloneHeroLibraryFolder, options = {}) {
  const libraryFolder = folderPathValue(cloneHeroLibraryFolder);
  if (!libraryFolder) throw new Error("Choose a Clone Hero / YARG library folder in Settings first.");
  const song = await getSong(userDataPath, songId);
  const destDir = path.join(libraryFolder, cloneHeroSongFolderName(song, { copy: true }));
  return exportSongToFolder(userDataPath, songId, destDir, options);
}

module.exports = {
  updateSong,
  patchSong,
  SOURCE_ASSET,
  getLibraryRoot,
  saveSong,
  listSongs,
  getSong,
  getProjectDeletionDetails,
  assetUrl,
  readAssetBuffer,
  getAssetSource,
  getMediaAssetSource,
  exportSongToFolder,
  saveSongToCloneHeroLibrary,
  __test: { atomicCopySelected, assertSelectedSource },
};

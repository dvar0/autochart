"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const {
  DEFAULT_LIMITS,
  extractArchiveToTarget,
  inspectArchive,
} = require("../electron/archiveSafety.cjs");
const installer = require("../electron/assetInstaller.cjs").__test;

let assertions = 0;
function pass() {
  assertions += 1;
}

async function rejects(action, pattern) {
  await assert.rejects(typeof action === "function" ? action : () => action, pattern);
  pass();
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function pinnedCatalog(files, options = {}) {
  const licenseFiles = options.licenseFiles || files
    .filter((file) => file?.source === installer.FILE_SOURCE_BUNDLED_LICENSE)
    .map((file) => file.path);
  return {
    schemaVersion: installer.PINNED_CATALOG_SCHEMA_VERSION,
    defaults: { packId: "test-pack" },
    components: [{
      id: "test-component",
      kind: "chart-model",
      label: "Test component",
      license: "CC-BY-NC-SA-4.0",
      attribution: {
        title: "Test model",
        creator: "Test creator",
        source: "Test fixture",
        license: "CC-BY-NC-SA-4.0",
      },
      licenseFiles,
      files,
    }],
    packs: [{ id: "test-pack", label: "Test pack", components: ["test-component"] }],
  };
}

function zipCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data || "");
    const crc = zipCrc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = entry.mode ?? (entry.name.endsWith("/") ? 0o040755 : 0o100644);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralBuffer, end]);
}

function writeTarString(header, offset, length, value) {
  Buffer.from(String(value), "utf8").copy(header, offset, 0, length);
}

function tarOctal(value, length) {
  return `${Number(value).toString(8).padStart(length - 1, "0")}\0`;
}

function makeTar(entries) {
  const parts = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data || "");
    const header = Buffer.alloc(512);
    writeTarString(header, 0, 100, entry.name);
    writeTarString(header, 100, 8, tarOctal(entry.mode ?? 0o644, 8));
    writeTarString(header, 108, 8, tarOctal(0, 8));
    writeTarString(header, 116, 8, tarOctal(0, 8));
    writeTarString(header, 124, 12, tarOctal(entry.type === "5" ? 0 : data.length, 12));
    writeTarString(header, 136, 12, tarOctal(0, 12));
    header.fill(0x20, 148, 156);
    writeTarString(header, 156, 1, entry.type || "0");
    writeTarString(header, 157, 100, entry.link || "");
    writeTarString(header, 257, 6, "ustar\0");
    writeTarString(header, 263, 2, "00");
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    parts.push(header);
    if (entry.type !== "5") {
      parts.push(data);
      const remainder = data.length % 512;
      if (remainder) parts.push(Buffer.alloc(512 - remainder));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

async function writeFixture(root, name, data) {
  const filePath = path.join(root, name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data);
  return filePath;
}

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function testCatalogPaths(root) {
  const body = Buffer.from("license fixture\n");
  const validFile = {
    path: "licenses/notice.txt",
    source: installer.FILE_SOURCE_BUNDLED_LICENSE,
    size: body.length,
    sha256: sha256(body),
  };
  installer.validatePinnedCatalog(pinnedCatalog([validFile]), root);
  pass();

  for (const malicious of [
    "/absolute.bin",
    "C:/drive.bin",
    "C:drive-relative.bin",
    "//server/share.bin",
    "../escape.bin",
    "models/../escape.bin",
    "./dot.bin",
    "models//double.bin",
    "models\\backslash.bin",
    "models\u2215unicode.bin",
    "models/:stream.bin",
  ]) {
    const file = { ...validFile, path: malicious };
    assert.throws(() => installer.validatePinnedCatalog(pinnedCatalog([file]), root));
    pass();
  }

  assert.throws(() => installer.validatePinnedCatalog(pinnedCatalog([{ path: "licenses/notice.txt", sha256: validFile.sha256 }]), root));
  pass();
  assert.throws(() => installer.validatePinnedCatalog(pinnedCatalog([{ path: "licenses/notice.txt", size: body.length }]), root));
  pass();
  assert.throws(() => installer.validatePinnedCatalog(pinnedCatalog([validFile, { ...validFile }]), root));
  pass();
  const conflicting = { path: "licenses/notice.txt/child", size: 1, sha256: sha256(Buffer.from("x")) };
  assert.throws(() => installer.validatePinnedCatalog(pinnedCatalog([validFile, conflicting]), root));
  pass();

  assert.throws(() => installer.validatePinnedCatalog({ ...pinnedCatalog([validFile]), schemaVersion: 1 }, root), /schemaVersion/i);
  pass();
  assert.throws(() => installer.validatePinnedCatalog(pinnedCatalog([{ ...validFile, source: undefined }]), root), /source/i);
  pass();
  assert.throws(() => installer.validatePinnedCatalog(pinnedCatalog([{ ...validFile, source: "filesystem" }]), root), /source/i);
  pass();
  assert.throws(() => installer.validatePinnedCatalog(pinnedCatalog([{ ...validFile, path: "notice.txt" }]), root), /licenses/i);
  pass();
  assert.throws(() => installer.validatePinnedCatalog(pinnedCatalog([
    { ...validFile, source: installer.FILE_SOURCE_REMOTE },
  ], { licenseFiles: [validFile.path] }), root), /not sourced from the app bundle/i);
  pass();
  const remoteModel = {
    path: "models/model.bin",
    source: installer.FILE_SOURCE_REMOTE,
    size: 1,
    sha256: sha256(Buffer.from("m")),
  };
  assert.throws(() => installer.validatePinnedCatalog(pinnedCatalog([
    validFile,
    { ...remoteModel, source: installer.FILE_SOURCE_BUNDLED_LICENSE, path: "licenses/undeclared.txt" },
  ], { licenseFiles: [validFile.path] }), root), /not declared/i);
  pass();
}

async function testArchives(root) {
  const archiveRoot = path.join(root, "archives");
  await fs.mkdir(archiveRoot, { recursive: true });
  const maliciousZipCases = [
    ["zip-traversal.zip", [{ name: "../escape.txt", data: "x" }], /traversal|relative/i],
    ["zip-absolute.zip", [{ name: "/absolute.txt", data: "x" }], /absolute|relative/i],
    ["zip-duplicate.zip", [{ name: "same.txt", data: "x" }, { name: "same.txt", data: "y" }], /duplicate/i],
    ["zip-conflict.zip", [{ name: "node", data: "x" }, { name: "node/child", data: "y" }], /conflict/i],
    ["zip-ambiguous.zip", [{ name: "file:stream", data: "x" }], /ambiguous/i],
    ["zip-symlink.zip", [{ name: "link", data: "target", mode: 0o120777 }], /link|special/i],
  ];
  for (const [name, entries, pattern] of maliciousZipCases) {
    const archive = await writeFixture(archiveRoot, name, makeZip(entries));
    await rejects(inspectArchive(archive), pattern);
  }
  const largeZip = await writeFixture(archiveRoot, "zip-large.zip", makeZip([{ name: "large.bin", data: "xx" }]));
  await rejects(inspectArchive(largeZip, { maxEntryBytes: 1 }), /size limit/i);
  const manyZip = await writeFixture(archiveRoot, "zip-many.zip", makeZip([{ name: "a", data: "a" }, { name: "b", data: "b" }]));
  await rejects(inspectArchive(manyZip, { maxEntries: 1 }), /more than 1/i);

  const validZip = await writeFixture(archiveRoot, "valid.zip", makeZip([
    { name: "pack/", type: "directory" },
    { name: "pack/model.bin", data: "valid zip" },
  ]));
  const zipTarget = path.join(root, "zip-target");
  await fs.mkdir(zipTarget);
  await fs.mkdir(path.join(zipTarget, "pack"));
  await fs.writeFile(path.join(zipTarget, "pack", "model.bin"), "old");
  await extractArchiveToTarget(validZip, zipTarget);
  assert.equal(await fs.readFile(path.join(zipTarget, "pack", "model.bin"), "utf8"), "valid zip");
  const cleanupStagingTarget = path.join(root, "archive-cleanup-target");
  const cleanupStagingHeldRoot = path.join(root, "archive-cleanup-held");
  const cleanupStagingOutside = path.join(root, "archive-cleanup-outside");
  const cleanupStaging = path.join(cleanupStagingTarget, ".stage");
  await fs.mkdir(cleanupStagingTarget);
  await fs.mkdir(cleanupStagingOutside);
  await fs.writeFile(path.join(cleanupStagingOutside, "sentinel"), "outside staging sentinel");
  await rejects(
    extractArchiveToTarget(validZip, cleanupStagingTarget, {
      stagingRoot: cleanupStaging,
      beforeCleanup: async ({ kind }) => {
        if (kind !== "staging") return;
        await fs.rename(cleanupStagingTarget, cleanupStagingHeldRoot);
        await fs.symlink(cleanupStagingOutside, cleanupStagingTarget, "dir");
      },
    }),
    /cleanup parent changed/
  );
  assert.equal(await fs.readFile(path.join(cleanupStagingOutside, "sentinel"), "utf8"), "outside staging sentinel");
  await fs.rm(cleanupStagingTarget, { force: true });
  await fs.rename(cleanupStagingHeldRoot, cleanupStagingTarget);
  await fs.rm(cleanupStaging, { recursive: true, force: true });

  const cleanupBackupTarget = path.join(root, "archive-backup-cleanup-target");
  const cleanupBackupHeldRoot = path.join(root, "archive-backup-cleanup-held");
  const cleanupBackupOutside = path.join(root, "archive-backup-cleanup-outside");
  const cleanupBackupStaging = path.join(cleanupBackupTarget, ".stage");
  await fs.mkdir(path.join(cleanupBackupTarget, "pack"), { recursive: true });
  await fs.mkdir(cleanupBackupOutside);
  await fs.writeFile(path.join(cleanupBackupTarget, "pack", "model.bin"), "old backup");
  await fs.writeFile(path.join(cleanupBackupOutside, "sentinel"), "outside backup sentinel");
  await rejects(
    extractArchiveToTarget(validZip, cleanupBackupTarget, {
      stagingRoot: cleanupBackupStaging,
      beforeCleanup: async ({ kind }) => {
        if (kind !== "backup") return;
        await fs.rename(cleanupBackupTarget, cleanupBackupHeldRoot);
        await fs.symlink(cleanupBackupOutside, cleanupBackupTarget, "dir");
      },
    }),
    /cleanup parent changed/
  );
  assert.equal(await fs.readFile(path.join(cleanupBackupOutside, "sentinel"), "utf8"), "outside backup sentinel");
  await fs.rm(cleanupBackupTarget, { force: true });
  await fs.rename(cleanupBackupHeldRoot, cleanupBackupTarget);
  await fs.rm(cleanupBackupStaging, { recursive: true, force: true });
  await fs.rm(`${cleanupBackupStaging}.backup`, { recursive: true, force: true });
  const archiveRaceTarget = path.join(root, "archive-race-target");
  const archiveRaceOutside = path.join(root, "archive-race-outside");
  await fs.mkdir(path.join(archiveRaceTarget, "pack"), { recursive: true });
  await fs.mkdir(archiveRaceOutside);
  await fs.writeFile(path.join(archiveRaceTarget, "pack", "model.bin"), "old archive");
  await rejects(
    extractArchiveToTarget(validZip, archiveRaceTarget, {
      beforeLink: async ({ destination }) => {
        await fs.symlink(archiveRaceOutside, destination);
      },
    }),
    /entry changed|destination changed/
  );
  assert.deepEqual(await fs.readdir(archiveRaceOutside), []);
  assert.equal(await fs.readFile(path.join(archiveRaceTarget, "pack", "model.bin"), "utf8"), "old archive");
  const stagedRaceTarget = path.join(root, "archive-staged-race-target");
  const stagedRaceOutside = path.join(root, "archive-staged-race-outside");
  const stagedRaceStage = path.join(stagedRaceTarget, ".stage");
  await fs.mkdir(stagedRaceOutside);
  await rejects(
    extractArchiveToTarget(validZip, stagedRaceTarget, {
      stagingRoot: stagedRaceStage,
      beforeLink: async ({ source }) => {
        const held = `${source}.held`;
        await fs.rename(source, held);
        await fs.symlink(stagedRaceOutside, source, "dir");
      },
    }),
    /entry changed|staging/
  );
  assert.deepEqual(await fs.readdir(stagedRaceOutside), []);
  const directoryRaceZip = await writeFixture(archiveRoot, "directory-race.zip", makeZip([
    { name: "pack/", type: "directory" },
    { name: "pack/child/", type: "directory" },
  ]));
  const directoryRaceTarget = path.join(root, "directory-race-target");
  const directoryRaceOutside = path.join(root, "directory-race-outside");
  await fs.mkdir(path.join(directoryRaceTarget, "pack"), { recursive: true });
  await fs.mkdir(directoryRaceOutside);
  await rejects(
    extractArchiveToTarget(directoryRaceZip, directoryRaceTarget, {
      beforePromote: async ({ entry, destination, directory }) => {
        if (!directory || !entry.path.endsWith("child")) return;
        const parent = path.dirname(destination);
        const held = `${parent}.held`;
        await fs.rename(parent, held);
        await fs.symlink(directoryRaceOutside, parent, "dir");
      },
    }),
    /directory changed/
  );
  assert.deepEqual(await fs.readdir(directoryRaceOutside), []);
  await fs.rm(path.join(directoryRaceTarget, "pack"), { force: true });
  await fs.rm(`${path.join(directoryRaceTarget, "pack")}.held`, { recursive: true, force: true });
  pass();
  const rollbackZip = await writeFixture(archiveRoot, "rollback.zip", makeZip([
    { name: "first.bin", data: "new first" },
    { name: "second.bin", data: "new second" },
    { name: "third.bin", data: "new third" },
  ]));
  const rollbackTarget = path.join(root, "rollback-target");
  const rollbackStage = path.join(rollbackTarget, ".fault-stage");
  const rollbackBackup = `${rollbackStage}.backup`;
  await fs.mkdir(rollbackTarget);
  await fs.writeFile(path.join(rollbackTarget, "first.bin"), "old first");
  await fs.writeFile(path.join(rollbackTarget, "second.bin"), "old second");
  await fs.writeFile(path.join(rollbackTarget, "third.bin"), "old third");
  const injectedPromotionFs = {
    lstat: fs.lstat,
    mkdir: fs.mkdir,
    rm: fs.rm,
    async rename(from, to) {
      if (from === path.join(rollbackStage, "third.bin") && to === path.join(rollbackTarget, "third.bin")) {
        const error = new Error("injected later promotion failure");
        error.code = "EIO";
        throw error;
      }
      if (from === path.join(rollbackBackup, "second.bin") && to === path.join(rollbackTarget, "second.bin")) {
        const error = new Error("injected earlier backup restore failure");
        error.code = "EIO";
        throw error;
      }
      return fs.rename(from, to);
    },
  };
  let rollbackError = null;
  try {
    await extractArchiveToTarget(rollbackZip, rollbackTarget, {
      stagingRoot: rollbackStage,
      promotionFs: injectedPromotionFs,
    });
  } catch (error) {
    rollbackError = error;
  }
  assert(rollbackError, "fault-injected promotion unexpectedly succeeded");
  assert.equal(rollbackError.backupPath, rollbackBackup);
  assert.match(rollbackError.message, new RegExp(`Backup retained at ${rollbackBackup.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(await fs.readFile(path.join(rollbackBackup, "second.bin"), "utf8"), "old second");
  assert.equal(await fs.readFile(path.join(rollbackTarget, "first.bin"), "utf8"), "old first");
  assert.equal(await fs.readFile(path.join(rollbackTarget, "third.bin"), "utf8"), "old third");
  await assert.rejects(fs.access(rollbackStage), (error) => error?.code === "ENOENT");
  pass();

  const maliciousTarCases = [
    ["tar-traversal.tar", [{ name: "../escape.txt", data: "x" }], /traversal|relative/i],
    ["tar-absolute.tar", [{ name: "/absolute.txt", data: "x" }], /relative/i],
    ["tar-duplicate.tar", [{ name: "same.txt", data: "x" }, { name: "same.txt", data: "y" }], /duplicate/i],
    ["tar-symlink.tar", [{ name: "link", type: "2", link: "target" }], /type|special/i],
    ["tar-hardlink.tar", [{ name: "hardlink", type: "1", link: "target" }], /type|special/i],
    ["tar-device.tar", [{ name: "device", type: "3" }], /type|special/i],
  ];
  for (const [name, entries, pattern] of maliciousTarCases) {
    const archive = await writeFixture(archiveRoot, name, makeTar(entries));
    await rejects(inspectArchive(archive), pattern);
  }
  const validTarBuffer = makeTar([
    { name: "pack/", type: "5" },
    { name: "pack/model.bin", data: "valid tar zstd" },
  ]);
  const validTar = await writeFixture(archiveRoot, "valid.tar.zst", zlib.zstdCompressSync(validTarBuffer));
  const tarTarget = path.join(root, "tar-target");
  await fs.mkdir(tarTarget);
  await extractArchiveToTarget(validTar, tarTarget);
  assert.equal(await fs.readFile(path.join(tarTarget, "pack", "model.bin"), "utf8"), "valid tar zstd");
  pass();
}
async function testShippedLicensePins(root) {
  const { catalog } = await installer.loadPinnedCatalog(root);
  assert.equal(catalog.schemaVersion, installer.PINNED_CATALOG_SCHEMA_VERSION);
  pass();
  const component = catalog.components.find((item) => item.id === "fretformer-v1-onnx");
  assert.equal(component.license, "CC-BY-NC-SA-4.0");
  for (const licensePath of component.licenseFiles) {
    const file = component.files.find((item) => item.path === licensePath);
    assert(file, `missing pinned license entry for ${licensePath}`);
    assert.equal(file.source, installer.FILE_SOURCE_BUNDLED_LICENSE, `${licensePath} source`);
    const localPath = path.join(__dirname, "..", "engine", licensePath);
    const contents = await fs.readFile(localPath);
    assert.equal(contents.length, file.size, `${licensePath} size`);
    assert.equal(sha256(contents), file.sha256, `${licensePath} SHA256`);
    pass();
  }
  for (const file of component.files.filter((item) => !component.licenseFiles.includes(item.path))) {
    assert.equal(file.source, installer.FILE_SOURCE_REMOTE, `${file.path} source`);
  }
  pass();

  const standardPack = catalog.packs.find((item) => item.id === "standard-onnx");
  const remoteFiles = component.files.filter((item) => item.source === installer.FILE_SOURCE_REMOTE);
  assert.equal(standardPack.downloadFileCount, remoteFiles.length);
  assert.equal(
    standardPack.downloadBytes,
    remoteFiles.reduce((total, file) => total + file.size, 0)
  );
  assert.deepEqual(
    standardPack.installContents.map(({ id, delivery }) => ({ id, delivery })),
    [
      { id: "demucs", delivery: "download" },
      { id: "beat-this", delivery: "download" },
      { id: "fretformer", delivery: "download" },
      { id: "ffmpeg", delivery: "bundled" },
      { id: "local-runtime", delivery: "bundled" },
      { id: "licenses", delivery: "bundled-copy" },
    ]
  );
  assert.equal(
    standardPack.installContents
      .filter((item) => item.delivery === "download")
      .reduce((total, item) => total + item.fileCount, 0),
    remoteFiles.length
  );
  pass();
}

async function directoryLink(target, linkPath) {
  await fs.symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

async function testBundledLicenseSafety(root) {
  const safetyRoot = path.join(root, "bundled-license-safety");
  const sourceRoot = path.join(safetyRoot, "source");
  const modelsRoot = path.join(safetyRoot, "models");
  const body = Buffer.from("verified bundled legal notice\n");
  const filePath = "licenses/notice.txt";
  const sourcePath = await writeFixture(sourceRoot, "notice.txt", body);
  await fs.mkdir(path.join(modelsRoot, "licenses"), { recursive: true });
  const destination = path.join(modelsRoot, "licenses", "notice.txt");
  await fs.writeFile(destination, Buffer.alloc(body.length, 0x78));

  const copied = await installer.copyBundledLicense({
    bundledLicenseRoot: sourceRoot,
    modelsRoot,
    targetPath: destination,
    filePath,
    expectedSize: body.length,
    expectedSha256: sha256(body),
  });
  assert.equal(copied.skipped, undefined);
  assert.deepEqual(await fs.readFile(destination), body);
  pass();

  const corrupted = Buffer.from(body);
  corrupted[0] ^= 0xff;
  await fs.writeFile(sourcePath, corrupted);
  await rejects(installer.copyBundledLicense({
    bundledLicenseRoot: sourceRoot,
    modelsRoot,
    targetPath: destination,
    filePath,
    expectedSize: body.length,
    expectedSha256: sha256(body),
  }), /SHA256 mismatch/i);
  assert.deepEqual(await fs.readFile(destination), body, "a valid destination must not bypass or be damaged by a corrupt bundle source");
  pass();
  await fs.writeFile(sourcePath, body);

  const sourceRootLink = path.join(safetyRoot, "source-link");
  await directoryLink(sourceRoot, sourceRootLink);
  await rejects(installer.copyBundledLicense({
    bundledLicenseRoot: sourceRootLink,
    modelsRoot,
    targetPath: destination,
    filePath,
    expectedSize: body.length,
    expectedSha256: sha256(body),
  }), /root is not a real directory/i);

  const linkedModelsRoot = path.join(safetyRoot, "linked-models");
  const outsideRoot = path.join(safetyRoot, "outside");
  await fs.mkdir(linkedModelsRoot, { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });
  await directoryLink(outsideRoot, path.join(linkedModelsRoot, "licenses"));
  await rejects(installer.copyBundledLicense({
    bundledLicenseRoot: sourceRoot,
    modelsRoot: linkedModelsRoot,
    targetPath: path.join(linkedModelsRoot, "licenses", "notice.txt"),
    filePath,
    expectedSize: body.length,
    expectedSha256: sha256(body),
  }), /parent is not a real directory/i);
  await assert.rejects(fs.access(path.join(outsideRoot, "notice.txt")), (error) => error?.code === "ENOENT");
  pass();

  if (process.platform !== "win32") {
    const symlinkSourceRoot = path.join(safetyRoot, "symlink-source");
    await fs.mkdir(symlinkSourceRoot);
    await fs.symlink(sourcePath, path.join(symlinkSourceRoot, "notice.txt"));
    await rejects(installer.copyBundledLicense({
      bundledLicenseRoot: symlinkSourceRoot,
      modelsRoot,
      targetPath: destination,
      filePath,
      expectedSize: body.length,
      expectedSha256: sha256(body),
    }), /source is not a regular file/i);

    const symlinkDestinationRoot = path.join(safetyRoot, "symlink-destination");
    await fs.mkdir(path.join(symlinkDestinationRoot, "licenses"), { recursive: true });
    await fs.symlink(path.join(outsideRoot, "outside-notice.txt"), path.join(symlinkDestinationRoot, "licenses", "notice.txt"));
    await rejects(installer.copyBundledLicense({
      bundledLicenseRoot: sourceRoot,
      modelsRoot: symlinkDestinationRoot,
      targetPath: path.join(symlinkDestinationRoot, "licenses", "notice.txt"),
      filePath,
      expectedSize: body.length,
      expectedSha256: sha256(body),
    }), /destination is not a regular file/i);
  }

  const raceModelsRoot = path.join(safetyRoot, "race-models");
  const raceParent = path.join(raceModelsRoot, "licenses");
  const movedRaceParent = path.join(raceModelsRoot, "licenses-before-race");
  const raceOutside = path.join(safetyRoot, "race-outside");
  let raceTempName = "";
  await fs.mkdir(raceParent, { recursive: true });
  await fs.mkdir(raceOutside, { recursive: true });
  await rejects(installer.copyBundledLicense({
    bundledLicenseRoot: sourceRoot,
    modelsRoot: raceModelsRoot,
    targetPath: path.join(raceParent, "notice.txt"),
    filePath,
    expectedSize: body.length,
    expectedSha256: sha256(body),
    async beforePromote({ temporaryPath }) {
      raceTempName = path.basename(temporaryPath);
      await fs.writeFile(path.join(raceOutside, raceTempName), "outside temp sentinel");
      await fs.rename(raceParent, movedRaceParent);
      await directoryLink(raceOutside, raceParent);
    },
  }), /parent is not a real directory|changed during|cleanup parent changed/i);
  await assert.rejects(fs.access(path.join(raceOutside, "notice.txt")), (error) => error?.code === "ENOENT");
  assert.equal(await fs.readFile(path.join(raceOutside, raceTempName), "utf8"), "outside temp sentinel");
  pass();
}


async function testPinnedInstallAndNetworkLimits(root) {
  const licenseBody = Buffer.from("pinned bundled license\n");
  const modelBody = Buffer.from("pinned remote model\n");
  const bundledLicenseRoot = path.join(root, "bundled-licenses");
  await writeFixture(bundledLicenseRoot, "notice.txt", licenseBody);
  const licenseFile = {
    path: "licenses/notice.txt",
    source: installer.FILE_SOURCE_BUNDLED_LICENSE,
    size: licenseBody.length,
    sha256: sha256(licenseBody),
  };
  const modelFile = {
    path: "models/model.bin",
    source: installer.FILE_SOURCE_REMOTE,
    size: modelBody.length,
    sha256: sha256(modelBody),
  };
  const catalog = pinnedCatalog([licenseFile, modelFile]);
  const catalogPath = await writeFixture(root, "pinned-catalog.json", `${JSON.stringify(catalog)}\n`);
  let remoteCatalogRequests = 0;
  let remoteLicenseRequests = 0;
  let remoteModelRequests = 0;
  const { server, baseUrl } = await startServer((req, res) => {
    if (req.url === "/catalog.json") {
      remoteCatalogRequests += 1;
      res.end(JSON.stringify({ malicious: true }));
      return;
    }
    if (req.url === "/licenses/notice.txt") {
      remoteLicenseRequests += 1;
      res.end("this remote legal file must never be trusted");
      return;
    }
    if (req.url === "/models/model.bin") {
      remoteModelRequests += 1;
      res.setHeader("content-length", modelBody.length);
      res.end(modelBody);
      return;
    }
    if (req.url === "/overflow") {
      res.write("12345");
      res.end();
      return;
    }
    if (req.url === "/declared") {
      res.setHeader("content-length", "5");
      res.end("12345");
      return;
    }
    if (req.url === "/text-cap") {
      res.end("12345");
      return;
    }
    if (req.url === "/redirect") {
      res.statusCode = 302;
      res.setHeader("location", "/redirect");
      res.end();
      return;
    }
    if (req.url === "/idle") {
      res.write("a");
      setTimeout(() => res.end("b"), 250);
      return;
    }
    if (req.url === "/overall") {
      const timer = setInterval(() => res.write("a"), 15);
      res.on("close", () => clearInterval(timer));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  try {
    const modelsRoot = path.join(root, "installed-models");
    const progressEvents = [];
    const result = await installer.installFromHttpWithOptions(
      { modelsFolder: modelsRoot },
      baseUrl,
      {
        pinnedCatalogPath: catalogPath,
        bundledLicenseRoot,
        packId: "test-pack",
        onProgress(event) {
          progressEvents.push(event);
        },
      }
    );
    assert.equal(result.files, 2);
    assert.equal(await fs.readFile(path.join(modelsRoot, "licenses", "notice.txt"), "utf8"), licenseBody.toString());
    assert.equal(await fs.readFile(path.join(modelsRoot, "models", "model.bin"), "utf8"), modelBody.toString());
    assert.equal(remoteCatalogRequests, 0, "remote catalog must never be requested");
    assert.equal(remoteLicenseRequests, 0, "bundled licenses must never be requested remotely");
    assert.equal(remoteModelRequests, 1, "remote model should retain its verified download path");
    const bundledProgress = progressEvents.find((event) => event.type === "progress" && event.filePath === licenseFile.path);
    assert.equal(bundledProgress?.phase, "copying");
    assert.equal(bundledProgress?.fileSource, installer.FILE_SOURCE_BUNDLED_LICENSE);
    const complete = progressEvents.at(-1);
    assert.equal(complete?.type, "complete");
    assert.equal(complete?.downloadedBytes, licenseBody.length + modelBody.length);
    assert.equal(complete?.totalBytes, licenseBody.length + modelBody.length);
    assert.equal(complete?.percent, 100);
    pass();
    const installedCatalogPath = path.join(modelsRoot, "catalog.json");
    const catalogBefore = await fs.readFile(installedCatalogPath);
    const catalogOpenHeldRoot = path.join(root, "catalog-open-held");
    const catalogOpenOutside = path.join(root, "catalog-open-outside");
    await fs.mkdir(catalogOpenOutside);
    await rejects(installer.installFromHttpWithOptions(
      { modelsFolder: modelsRoot },
      baseUrl,
      {
        pinnedCatalogPath: catalogPath,
        bundledLicenseRoot,
        packId: "test-pack",
        beforeCatalogOpen: async ({ parent }) => {
          await fs.rename(parent, catalogOpenHeldRoot);
          await directoryLink(catalogOpenOutside, parent);
        },
      }
    ), /parent changed before opening/);
    assert.deepEqual(await fs.readdir(catalogOpenOutside), []);
    await fs.rm(modelsRoot, { force: true });
    await fs.rename(catalogOpenHeldRoot, modelsRoot);
    assert.deepEqual(await fs.readFile(installedCatalogPath), catalogBefore);

    const catalogPromoteOutside = path.join(root, "catalog-promote-outside");
    await fs.writeFile(catalogPromoteOutside, "outside");
    await rejects(installer.installFromHttpWithOptions(
      { modelsFolder: modelsRoot },
      baseUrl,
      {
        pinnedCatalogPath: catalogPath,
        bundledLicenseRoot,
        packId: "test-pack",
        beforeCatalogPromote: async ({ target }) => {
          await fs.symlink(catalogPromoteOutside, target);
        },
      }
    ), /destination changed/);
    assert.equal(await fs.readFile(catalogPromoteOutside, "utf8"), "outside");
    assert.deepEqual(await fs.readFile(installedCatalogPath), catalogBefore);
    const catalogPromoteStat = await fs.lstat(installedCatalogPath);
    assert.ok(catalogPromoteStat.isFile() && !catalogPromoteStat.isSymbolicLink());

    const staleDownloadTarget = path.join(modelsRoot, "models", "stale.bin");
    const staleDownloadPath = `${staleDownloadTarget}.download`;
    const interruptedDownloadPath = `${staleDownloadTarget}.${crypto.randomUUID()}.download`;
    await fs.writeFile(staleDownloadPath, "preserve stale temp");
    await fs.writeFile(interruptedDownloadPath, "interrupted attempt");
    await installer.downloadFile({
      url: `${baseUrl}/models/model.bin`,
      targetPath: staleDownloadTarget,
      rootDirectory: modelsRoot,
      expectedSize: modelBody.length,
      expectedSha256: sha256(modelBody),
    });
    assert.deepEqual(await fs.readFile(staleDownloadTarget), modelBody);
    assert.equal(await fs.readFile(staleDownloadPath, "utf8"), "preserve stale temp");
    assert.equal(await fs.readFile(interruptedDownloadPath, "utf8"), "interrupted attempt");
    assert.deepEqual((await fs.readdir(path.dirname(staleDownloadTarget)))
      .filter((name) => name.startsWith("stale.bin") && name.endsWith(".download")).sort(),
    [path.basename(staleDownloadPath), path.basename(interruptedDownloadPath)].sort());
    pass();

    // Randomized staging still uses exclusive creation and must never overwrite
    // a file planted between choosing the path and opening it.
    let collisionPath;
    await rejects(installer.downloadFile({
      url: `${baseUrl}/models/model.bin`,
      targetPath: path.join(modelsRoot, "models", "collision.bin"),
      rootDirectory: modelsRoot,
      expectedSize: modelBody.length,
      expectedSha256: sha256(modelBody),
      beforeTempOpen: async ({ target }) => {
        collisionPath = target;
        await fs.writeFile(target, "preserve collision");
      },
    }), /EEXIST|already exists/);
    assert.equal(await fs.readFile(collisionPath, "utf8"), "preserve collision");

    const tempRaceParent = path.join(modelsRoot, "temp-race");
    const tempRaceHeldParent = path.join(modelsRoot, "temp-race-held");
    const tempRaceOutside = path.join(root, "temp-race-outside");
    const tempRaceTarget = path.join(tempRaceParent, "asset.bin");
    const tempRaceOutsideTemp = path.join(tempRaceOutside, "asset.bin.download");
    await fs.mkdir(tempRaceParent);
    await fs.mkdir(tempRaceOutside);
    await fs.writeFile(tempRaceOutsideTemp, "outside stale temp");
    await rejects(installer.downloadFile({
      url: `${baseUrl}/models/model.bin`,
      targetPath: tempRaceTarget,
      rootDirectory: modelsRoot,
      expectedSize: modelBody.length,
      expectedSha256: sha256(modelBody),
      beforeTempOpen: async ({ parent }) => {
        await fs.rename(parent, tempRaceHeldParent);
        await directoryLink(tempRaceOutside, parent);
      },
    }), /parent changed before opening/);
    assert.equal(await fs.readFile(tempRaceOutsideTemp, "utf8"), "outside stale temp");
    await fs.rm(tempRaceParent, { force: true });
    await fs.rename(tempRaceHeldParent, tempRaceParent);

    const hashRaceTarget = path.join(modelsRoot, "models", "hash-race.bin");
    const hashRaceHeld = `${hashRaceTarget}.held`;
    const hashRaceOutside = path.join(root, "hash-race-outside");
    await fs.writeFile(hashRaceTarget, modelBody);
    await fs.writeFile(hashRaceOutside, "outside");
    await rejects(installer.downloadFile({
      url: `${baseUrl}/models/model.bin`,
      targetPath: hashRaceTarget,
      rootDirectory: modelsRoot,
      expectedSize: modelBody.length,
      expectedSha256: sha256(modelBody),
      beforeExistingVerify: async ({ targetPath }) => {
        await fs.rename(targetPath, hashRaceHeld);
        await fs.symlink(hashRaceOutside, targetPath);
      },
    }), /real regular file|changed/);
    assert.equal(await fs.readFile(hashRaceOutside, "utf8"), "outside");
    await fs.rm(hashRaceTarget, { force: true });
    await fs.rename(hashRaceHeld, hashRaceTarget);

    const remoteRaceTarget = path.join(modelsRoot, "models", "race.bin");
    const remoteRaceOutside = path.join(root, "remote-race-outside");
    await fs.writeFile(remoteRaceOutside, "outside");
    await rejects(installer.downloadFile({
      url: `${baseUrl}/models/model.bin`,
      targetPath: remoteRaceTarget,
      rootDirectory: modelsRoot,
      expectedSize: modelBody.length,
      expectedSha256: sha256(modelBody),
      beforePromote: async ({ target }) => {
        await fs.symlink(remoteRaceOutside, target);
      },
    }), /destination changed/);
    assert.equal(await fs.readFile(remoteRaceOutside, "utf8"), "outside");
    const remoteOpenParent = path.join(modelsRoot, "models");
    const remoteOpenHeldParent = path.join(modelsRoot, "models-before-open");
    const remoteOpenOutside = path.join(root, "remote-open-outside");
    const remoteOpenTarget = path.join(remoteOpenParent, "before-open.bin");
    await fs.mkdir(remoteOpenOutside);
    await rejects(installer.downloadFile({
      url: `${baseUrl}/models/model.bin`,
      targetPath: remoteOpenTarget,
      rootDirectory: modelsRoot,
      expectedSize: modelBody.length,
      expectedSha256: sha256(modelBody),
      beforeTempOpen: async ({ parent }) => {
        await fs.rename(parent, remoteOpenHeldParent);
        await directoryLink(remoteOpenOutside, parent);
      },
    }), /parent changed before opening/);
    assert.deepEqual(await fs.readdir(remoteOpenOutside), []);
    await fs.rm(remoteOpenParent, { force: true });
    await fs.rename(remoteOpenHeldParent, remoteOpenParent);
    const expectedHash = sha256(Buffer.from("1234"));
    let overflowTemporaryPath;
    await rejects(installer.downloadFile({
      url: `${baseUrl}/overflow`,
      targetPath: path.join(root, "overflow.bin"),
      expectedSize: 4,
      expectedSha256: expectedHash,
      beforeTempOpen: ({ target }) => { overflowTemporaryPath = target; },
    }), /exceeded.*4-byte/i);
    assert.ok(overflowTemporaryPath);
    await assert.rejects(fs.access(overflowTemporaryPath));
    pass();

    await rejects(installer.downloadFile({
      url: `${baseUrl}/declared`,
      targetPath: path.join(root, "declared.bin"),
      expectedSize: 4,
      expectedSha256: expectedHash,
    }), /Content-Length mismatch/i);
    await rejects(installer.downloadText(`${baseUrl}/text-cap`, { maxBytes: 4 }), /4-byte limit/i);
    await rejects(installer.downloadText(`${baseUrl}/redirect`, {
      maxBytes: 32,
      requestOptions: { maxRedirects: 2 },
    }), /Too many redirects/i);
    await rejects(installer.downloadFile({
      url: `${baseUrl}/idle`,
      targetPath: path.join(root, "idle.bin"),
      expectedSize: 2,
      expectedSha256: sha256(Buffer.from("ab")),
      requestOptions: { idleTimeoutMs: 40, overallTimeoutMs: 500 },
    }), /Idle download timeout/i);
    await rejects(installer.downloadFile({
      url: `${baseUrl}/overall`,
      targetPath: path.join(root, "overall.bin"),
      expectedSize: 100,
      expectedSha256: sha256(Buffer.alloc(100, "a")),
      requestOptions: { idleTimeoutMs: 100, overallTimeoutMs: 60 },
    }), /Overall download timeout/i);
  } finally {
    await closeServer(server);
  }

  const connectStarted = Date.now();
  await rejects(installer.downloadText("http://192.0.2.1:81/connect-timeout", {
    maxBytes: 16,
    requestOptions: { connectTimeoutMs: 40, idleTimeoutMs: 100, overallTimeoutMs: 500 },
  }), /Connection timeout|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/i);
  assert(Date.now() - connectStarted < 1_000, "connect failure must be bounded");
  pass();

  const oversizedCatalog = path.join(root, "oversized-catalog.json");
  await fs.writeFile(oversizedCatalog, Buffer.alloc(installer.PINNED_CATALOG_MAX_BYTES + 1, 0x20));
  await rejects(installer.loadPinnedCatalog(root, { pinnedCatalogPath: oversizedCatalog }), /catalog exceeds/i);
}

async function main() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autochart-installer-test-")));
  try {
    await testCatalogPaths(root);
    await testArchives(root);
    await testShippedLicensePins(root);
    await testBundledLicenseSafety(root);
    await testPinnedInstallAndNetworkLimits(root);
    console.log(`Installer hardening checks passed: ${assertions} behavioral assertions.`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

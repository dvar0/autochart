"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const cacheOwnership = require("../electron/cacheOwnership.cjs");
const { migrateLegacyCache } = require("../electron/cacheMigration.cjs");
const { FileCapabilityRegistry } = require("../electron/fileCapabilities.cjs");
const libraryStore = require("../electron/libraryStore.cjs");
const settingsStore = require("../electron/settingsStore.cjs");
const engineManager = require("../electron/engineManager.cjs");
const modelManager = require("../electron/modelManager.cjs");
const { isStrictChild, safeFolderName, strictChildPath } = require("../electron/pathSafety.cjs");

function sender() {
  const listeners = {};
  return { once: (name, callback) => { listeners[name] = callback; }, destroy: () => listeners.destroyed?.() };
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-app-security-"));
  try {
    const mainProcessSource = await fs.readFile(path.join(__dirname, "..", "electron", "main.cjs"), "utf8");
    assert.doesNotMatch(
      mainProcessSource,
      /select-hid-device|AUTOCHART_DISABLE_HID|Raw HID|setupHidPermissions|hidAccessEnabled|hidDeviceLabel/,
      "main process still exposes Raw HID support"
    );
    assert.match(
      mainProcessSource,
      /setPermissionCheckHandler\(\(\) => false\)/,
      "main process no longer denies unrelated permission checks"
    );
    assert.match(
      mainProcessSource,
      /setPermissionRequestHandler[\s\S]{0,200}callback\(false\)/,
      "main process no longer denies unrelated permission requests"
    );
    assert.equal(safeFolderName("."), "song");
    assert.equal(safeFolderName(".."), "song");
    assert.equal(safeFolderName("CON"), "_CON");
    assert.equal(safeFolderName("LPT1.txt"), "_LPT1.txt");
    assert.equal(safeFolderName("title...   "), "title");
    const selected = path.join(root, "selected");
    assert.equal(isStrictChild(selected, path.join(selected, safeFolderName(".."))), true);
    assert.throws(
      () => settingsStore.assertRendererSettingsPatch({ legacyCacheFolder: root }),
      /internal settings/
    );
    assert.throws(
      () => settingsStore.assertRendererSettingsPatch({ cacheMigrationTarget: root }),
      /internal settings/
    );
    assert.throws(
      () => settingsStore.assertRendererSettingsPatch({ defaults: { cacheFolder: root } }),
      /internal settings/
    );
    assert.throws(
      () => settingsStore.assertRendererSettingsPatch({ settingsRecovery: null }),
      /internal settings/
    );

    const recoveryUserData = path.join(root, "settings-recovery");
    await fs.mkdir(recoveryUserData);
    const corruptSettings = Buffer.from('{"theme":"dark","broken":\0', "utf8");
    await fs.writeFile(path.join(recoveryUserData, "settings.json"), corruptSettings);
    const recoveredSettings = await settingsStore.readSettings(recoveryUserData, {
      theme: "light",
      projectsFolder: path.join(root, "recovery-projects"),
    });
    assert.equal(recoveredSettings.theme, "light");
    assert.ok(recoveredSettings.settingsRecovery?.backupPath);
    assert.deepEqual(
      await fs.readFile(recoveredSettings.settingsRecovery.backupPath),
      corruptSettings
    );
    await assert.rejects(fs.access(path.join(recoveryUserData, "settings.json")));
    const updatedRecoveredSettings = await settingsStore.updateSettings(
      recoveryUserData,
      { theme: "dark" },
      { theme: "light" }
    );
    assert.ok(updatedRecoveredSettings.settingsRecovery);
    const persistedRecoveredSettings = JSON.parse(
      await fs.readFile(path.join(recoveryUserData, "settings.json"), "utf8")
    );
    assert.equal(Object.hasOwn(persistedRecoveredSettings, "settingsRecovery"), false);
    const recoveryBackupPath = recoveredSettings.settingsRecovery.backupPath;
    const dismissedRecovery = await settingsStore.dismissSettingsRecovery(
      recoveryUserData,
      { theme: "light" }
    );
    assert.equal(Object.hasOwn(dismissedRecovery, "settingsRecovery"), false);
    await fs.access(recoveryBackupPath);
    await assert.rejects(fs.access(path.join(recoveryUserData, "settings-recovery.json")));

    const projectsFolder = path.join(root, "projects");
    const context = { userDataPath: path.join(root, "user-data"), projectsFolder };
    assert.equal(path.basename(strictChildPath(selected, ".")), "song");
    assert.equal(path.dirname(strictChildPath(selected, "..")), path.resolve(selected));
    await fs.mkdir(projectsFolder);
    const outsideProject = path.join(root, "outside-project");
    await fs.mkdir(outsideProject);
    await fs.symlink(outsideProject, path.join(projectsFolder, "linked-project"), "dir");
    await assert.rejects(
      libraryStore.saveSong(context, { record: { id: "linked-project", chart: { text: "x" } } }),
      /real directory/
    );
    assert.deepEqual(await fs.readdir(outsideProject), []);

    const writeInvalidProject = async (id, manifest) => {
      const dir = path.join(projectsFolder, id);
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, "song.json"), JSON.stringify(manifest));
      return dir;
    };
    await writeInvalidProject("array-manifest", []);
    await assert.rejects(
      libraryStore.getSong(context, "array-manifest"),
      /plain object/
    );
    await writeInvalidProject("mismatched-manifest", {
      id: "different-project",
      chart: { text: "chart" },
      assets: {},
    });
    await assert.rejects(
      libraryStore.getProjectDeletionDetails(context, "mismatched-manifest"),
      /id does not match/
    );
    await writeInvalidProject("invalid-chart-type", {
      id: "invalid-chart-type",
      chart: { file: "notes.txt" },
      assets: {},
    });
    await assert.rejects(
      libraryStore.getSong(context, "invalid-chart-type"),
      /\.chart file type/
    );
    await writeInvalidProject("unsafe-media-name", {
      id: "unsafe-media-name",
      chart: { text: "chart" },
      assets: { audio: "../outside.ogg" },
    });
    await assert.rejects(
      libraryStore.getSong(context, "unsafe-media-name"),
      /Invalid audio asset name/
    );
    await writeInvalidProject("reserved-media-name", {
      id: "reserved-media-name",
      chart: { text: "chart" },
      assets: { audio: "CON.ogg" },
    });
    await assert.rejects(
      libraryStore.getSong(context, "reserved-media-name"),
      /platform-safe file name/
    );
    await writeInvalidProject("invalid-background-type", {
      id: "invalid-background-type",
      chart: { text: "chart" },
      assets: { background: { type: "html", file: "background.png" } },
    });
    await assert.rejects(
      libraryStore.getSong(context, "invalid-background-type"),
      /type must be image or video/
    );
    const linkedMediaProject = await writeInvalidProject("linked-media-project", {
      id: "linked-media-project",
      chart: { text: "chart" },
      assets: { audio: "linked.ogg" },
    });
    const invalidMediaTarget = path.join(root, "invalid-media-target.ogg");
    await fs.writeFile(invalidMediaTarget, "outside");
    await fs.symlink(invalidMediaTarget, path.join(linkedMediaProject, "linked.ogg"));
    await assert.rejects(
      libraryStore.getSong(context, "linked-media-project"),
      /audio asset must be a real file/
    );
    const invalidIds = new Set([
      "array-manifest",
      "mismatched-manifest",
      "invalid-chart-type",
      "unsafe-media-name",
      "reserved-media-name",
      "invalid-background-type",
      "linked-media-project",
    ]);
    const listedAfterInvalidManifests = await libraryStore.listSongs(context);
    assert.equal(
      listedAfterInvalidManifests.some((record) => invalidIds.has(record.id)),
      false,
      "unsafe manifests were returned by listSongs"
    );

    const saved = await libraryStore.saveSong(context, {
      record: { id: "safe-project", meta: { title: "Safe" }, chart: { text: "chart" }, assets: {} },
      assets: { audio: { name: "source.ogg", mime: "audio/ogg", data: Buffer.from("audio") } },
    });
    const projectDir = path.join(projectsFolder, saved.id);
    await fs.writeFile(path.join(root, "outside.chart"), "outside");
    await fs.writeFile(path.join(projectDir, "song.json"), JSON.stringify({ id: saved.id, chart: { file: "../outside.chart" }, assets: saved.assets }));
    await assert.rejects(libraryStore.getSong(context, saved.id), /Invalid chart file name/);
    await assert.rejects(
      libraryStore.getAssetSource(context, saved.id, "../source.ogg"),
      /Invalid project media asset name/
    );
    await assert.rejects(
      libraryStore.readAssetBuffer(context, "linked-media-project", "linked.ogg"),
      /audio asset must be a real file/
    );
    await assert.rejects(
      libraryStore.assetUrl(context, "linked-media-project", "linked.ogg"),
      /audio asset must be a real file/
    );
    const legacyEngineRoot = path.join(context.userDataPath, "cache", "engine");
    const legacyAnalysis = path.join(legacyEngineRoot, "padded.ogg");
    await fs.mkdir(legacyEngineRoot, { recursive: true });
    await fs.writeFile(legacyAnalysis, "legacy-padded-audio");
    await libraryStore.saveSong(context, {
      record: {
        id: "legacy-export",
        meta: { title: "Legacy Export" },
        settings: { activeVersionId: "legacy-version" },
        versions: [{
          id: "legacy-version",
          chart: { text: "legacy chart" },
          meta: { leadInSilenceMs: 1000, analysisAudioPath: legacyAnalysis },
        }],
        chart: { text: "legacy chart" },
        assets: {},
      },
    });
    const legacyExportDir = path.join(root, "legacy-export-output");
    await libraryStore.exportSongToFolder(context, "legacy-export", legacyExportDir);
    assert.equal(await fs.readFile(path.join(legacyExportDir, "song.ogg"), "utf8"), "legacy-padded-audio");

    await libraryStore.saveSong(context, {
      record: { id: "race-project", chart: { text: "before" }, assets: {} },
    });
    const raceDir = path.join(projectsFolder, "race-project");
    const heldProject = path.join(projectsFolder, "race-project-held");
    const escapeDir = path.join(root, "save-escape");
    await fs.mkdir(escapeDir);
    let swapped = false;
    await assert.rejects(libraryStore.saveSong(
      context,
      { record: { id: "race-project", chart: { text: "after" }, assets: {} } },
      { beforeWrite: async () => {
        if (swapped) return;
        swapped = true;
        await fs.rename(raceDir, heldProject);
        await fs.symlink(escapeDir, raceDir, "dir");
      } }
    ), /changed during save/);
    assert.deepEqual(await fs.readdir(escapeDir), []);
    await fs.rm(raceDir);
    await fs.rename(heldProject, raceDir);
    const selectedFile = path.join(root, "selected.ogg");
    await fs.writeFile(selectedFile, "selected-audio");
    let clock = 100;
    const registry = new FileCapabilityRegistry({ ttlMs: 10, now: () => clock });
    const senderA = sender();
    const senderB = sender();
    const cap = await registry.register(senderA, selectedFile, { name: "selected.ogg" });
    await assert.rejects(registry.consume(senderB, cap.token), /sender-mismatched/);
    await assert.rejects(registry.consume(senderA, "forged"), /Unknown/);
    assert.equal((await registry.consume(senderA, cap.token)).path, await fs.realpath(selectedFile));
    await assert.rejects(registry.consume(senderA, cap.token), /Unknown/);
    const replaced = await registry.register(senderA, selectedFile);
    await fs.rename(selectedFile, `${selectedFile}.original`);
    await fs.writeFile(selectedFile, "replacement");
    await assert.rejects(registry.consume(senderA, replaced.token), /changed after capability registration/);
    const expired = await registry.register(senderA, selectedFile);
    const destroyed = await registry.register(senderB, selectedFile);
    senderB.destroy();
    await assert.rejects(registry.consume(senderB, destroyed.token), /Unknown/);
    clock = 111;
    await assert.rejects(registry.consume(senderA, expired.token), /expired/);
    const audioCacheSettings = { cacheFolder: path.join(root, "selected-audio-cache") };
    const cachedAudio = await engineManager.cacheAudio(
      root,
      { path: selectedFile, name: "selected.ogg", mime: "audio/ogg" },
      audioCacheSettings
    );
    await fs.writeFile(cachedAudio.audioPath, "tampered-audio");
    const rebuiltAudio = await engineManager.cacheAudio(
      root,
      { path: selectedFile, name: "selected.ogg", mime: "audio/ogg" },
      audioCacheSettings
    );
    assert.equal(await fs.readFile(rebuiltAudio.audioPath, "utf8"), "replacement");
    const registeredStat = await fs.lstat(selectedFile);
    const registeredAudio = await engineManager.cacheAudio(
      root,
      {
        path: selectedFile,
        name: "selected.ogg",
        mime: "audio/ogg",
        device: registeredStat.dev,
        inode: registeredStat.ino,
        size: registeredStat.size,
        lastModified: registeredStat.mtimeMs,
      },
      audioCacheSettings
    );
    await fs.rename(selectedFile, `${selectedFile}.registered-original`);
    await fs.writeFile(selectedFile, "selection-replacement");
    await assert.rejects(
      engineManager.cacheAudio(
        root,
        {
          path: selectedFile,
          name: "selected.ogg",
          mime: "audio/ogg",
          device: registeredStat.dev,
          inode: registeredStat.ino,
          size: registeredStat.size,
          lastModified: registeredStat.mtimeMs,
        },
        audioCacheSettings
      ),
      /changed after registration/
    );
    await fs.rm(`${selectedFile}.registered-original`);
    const currentAudio = await engineManager.cacheAudio(
      root,
      { path: selectedFile, name: "selected.ogg", mime: "audio/ogg" },
      audioCacheSettings
    );
    const cacheOutside = path.join(root, "cache-destination-outside");
    await fs.writeFile(cacheOutside, "must remain");
    await fs.rm(currentAudio.audioPath);
    await fs.symlink(cacheOutside, currentAudio.audioPath);
    await assert.rejects(
      engineManager.cacheAudio(root, { path: selectedFile, name: "selected.ogg", mime: "audio/ogg" }, audioCacheSettings),
      /real regular file/
    );
    assert.equal(await fs.readFile(cacheOutside, "utf8"), "must remain");
    await fs.rm(currentAudio.audioPath);

    const legacyRoot = path.join(root, "legacy-cache");
    await fs.mkdir(path.join(legacyRoot, "engine"), { recursive: true });
    await fs.writeFile(path.join(legacyRoot, "engine", "analysis.ogg"), "legacy-analysis");
    await fs.mkdir(path.join(legacyRoot, "jobs"));
    await fs.writeFile(path.join(legacyRoot, "jobs", "user.txt"), "unrelated-user-data");
    const legacy = settingsStore.normalizeSettings({ cacheFolder: legacyRoot }, { cacheParentFolder: path.join(root, "default-cache") });
    assert.equal(legacy.cachePathVersion, 1);
    assert.equal(legacy.cacheFolder, legacyRoot);
    await assert.rejects(migrateLegacyCache({
      settings: legacy,
      defaults: { cacheParentFolder: path.join(root, "default-cache") },
      persist: async () => { throw new Error("injected settings failure"); },
    }), /injected settings failure/);
    assert.equal(await fs.readFile(path.join(legacyRoot, "engine", "analysis.ogg"), "utf8"), "legacy-analysis");
    assert.equal(await fs.readFile(path.join(legacyRoot, "jobs", "user.txt"), "utf8"), "unrelated-user-data");
    assert.equal(legacy.cachePathVersion, 1);
    const migrated = await migrateLegacyCache({
      settings: legacy,
      defaults: { cacheParentFolder: path.join(root, "default-cache") },
      persist: async (patch) => settingsStore.normalizeSettings({ ...legacy, ...patch }, {}),
    });
    assert.equal(migrated.cachePathVersion, 2);
    assert.equal(migrated.legacyCacheFolder, await fs.realpath(legacyRoot));
    assert.equal(await fs.readFile(path.join(legacyRoot, "engine", "analysis.ogg"), "utf8"), "legacy-analysis");
    assert.equal(await fs.readFile(path.join(legacyRoot, "jobs", "user.txt"), "utf8"), "unrelated-user-data");
    await assert.rejects(fs.access(path.join(migrated.cacheFolder, "engine")));
    const migratedContext = {
      ...context,
      cacheFolder: migrated.cacheFolder,
      legacyCacheFolder: migrated.legacyCacheFolder,
    };
    await libraryStore.saveSong(migratedContext, {
      record: {
        id: "migrated-legacy-export",
        meta: { title: "Migrated Legacy Export" },
        settings: { activeVersionId: "legacy-version" },
        versions: [{
          id: "legacy-version",
          chart: { text: "legacy chart" },
          meta: {
            leadInSilenceMs: 1000,
            analysisAudioPath: path.join(legacyRoot, "engine", "analysis.ogg"),
          },
        }],
        chart: { text: "legacy chart" },
        assets: {},
      },
    });
    const migratedExportDir = path.join(root, "migrated-legacy-export-output");
    await libraryStore.exportSongToFolder(
      migratedContext,
      "migrated-legacy-export",
      migratedExportDir
    );
    assert.equal(
      await fs.readFile(path.join(migratedExportDir, "song.ogg"), "utf8"),
      "legacy-analysis"
    );
    await cacheOwnership.clearOwnedCacheDirectory(migrated, migrated.cacheFolder);
    assert.equal(await fs.readFile(path.join(legacyRoot, "engine", "analysis.ogg"), "utf8"), "legacy-analysis");
    assert.equal(await fs.readFile(path.join(legacyRoot, "jobs", "user.txt"), "utf8"), "unrelated-user-data");
    const missingLegacyRoot = path.join(root, "missing-legacy-cache");
    const missingLegacy = settingsStore.normalizeSettings(
      { cacheFolder: missingLegacyRoot },
      { cacheParentFolder: path.join(root, "safe-default-cache") }
    );
    const missingCutover = await migrateLegacyCache({
      settings: missingLegacy,
      defaults: { cacheParentFolder: path.join(root, "safe-default-cache") },
      persist: async (patch) => settingsStore.normalizeSettings({ ...missingLegacy, ...patch }, {}),
    });
    assert.equal(missingCutover.cachePathVersion, 2);
    assert.equal(missingCutover.legacyCacheFolder, "");
    await assert.rejects(fs.access(missingLegacyRoot));
    await fs.access(path.join(root, "safe-default-cache", settingsStore.CACHE_DIR_NAME));

    const clearParent = path.join(root, "clear-parent");
    const clearSettings = settingsStore.normalizeSettings({ cachePathVersion: 2, cacheParentFolder: clearParent }, { cacheParentFolder: clearParent });
    await cacheOwnership.prepareOwnedCacheDirectory(clearSettings);
    const markerOutside = path.join(root, "marker-outside.json");
    await fs.writeFile(markerOutside, `${JSON.stringify(cacheOwnership.CACHE_MARKER)}\n`);
    const ownedMarker = path.join(clearSettings.cacheFolder, cacheOwnership.CACHE_MARKER_NAME);
    await fs.rm(ownedMarker);
    await fs.symlink(markerOutside, ownedMarker);
    await assert.rejects(
      cacheOwnership.prepareOwnedCacheDirectory(clearSettings),
      /unlinked regular file/
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(markerOutside, "utf8")),
      cacheOwnership.CACHE_MARKER
    );
    await fs.rm(ownedMarker);
    await cacheOwnership.prepareOwnedCacheDirectory(clearSettings);
    await fs.writeFile(path.join(clearSettings.cacheFolder, "payload"), "cache");
    const markerReplacementPath = path.join(clearSettings.cacheFolder, cacheOwnership.CACHE_MARKER_NAME);
    await assert.rejects(
      cacheOwnership.clearOwnedCacheDirectory(
        clearSettings,
        clearSettings.cacheFolder,
        [],
        {
          beforeRename: async () => {
            await fs.rm(markerReplacementPath);
            await fs.writeFile(markerReplacementPath, `${JSON.stringify(cacheOwnership.CACHE_MARKER)}\n`);
          },
        }
      ),
      /marker changed/
    );
    assert.equal(await fs.readFile(path.join(clearSettings.cacheFolder, "payload"), "utf8"), "cache");
    assert.equal(
      await fs.readFile(markerReplacementPath, "utf8"),
      `${JSON.stringify(cacheOwnership.CACHE_MARKER)}\n`
    );
    const held = path.join(clearParent, "held-original");
    await assert.rejects(cacheOwnership.clearOwnedCacheDirectory(
      clearSettings,
      clearSettings.cacheFolder,
      [],
      { beforeRename: async (owned) => {
        await fs.rename(owned.path, held);
        await fs.mkdir(owned.path);
        await fs.writeFile(path.join(owned.path, cacheOwnership.CACHE_MARKER_NAME), `${JSON.stringify(cacheOwnership.CACHE_MARKER)}\n`);
      } }
    ), /identity changed/);
    assert.equal(await fs.readFile(path.join(held, "payload"), "utf8"), "cache");
    await fs.rm(clearSettings.cacheFolder, { recursive: true });
    await fs.rename(held, clearSettings.cacheFolder);
    await cacheOwnership.clearOwnedCacheDirectory(clearSettings, clearSettings.cacheFolder);
    await fs.access(path.join(clearSettings.cacheFolder, cacheOwnership.CACHE_MARKER_NAME));
    await assert.rejects(fs.access(path.join(clearSettings.cacheFolder, "payload")));

    const engineRoot = path.join(clearSettings.cacheFolder, "engine");
    await fs.mkdir(engineRoot);
    const validStem = path.join(engineRoot, "valid.ogg");
    await fs.writeFile(validStem, "valid-stem");
    assert.equal(
      (await engineManager.readDemucsStem(root, validStem, { settings: clearSettings })).toString("utf8"),
      "valid-stem"
    );
    const realStem = path.join(root, "outside-stem.ogg");
    await fs.writeFile(realStem, "stem");
    await assert.rejects(
      engineManager.readDemucsStem(root, realStem, { settings: clearSettings }),
      /outside the Autochart engine cache/
    );
    const linkedStem = path.join(engineRoot, "linked.ogg");
    await fs.symlink(realStem, linkedStem);
    await assert.rejects(engineManager.readDemucsStem(root, linkedStem, { settings: clearSettings }), /real regular file/);

    const modelRoot = path.join(root, "model-integrity");
    const modelRelativePath = "fixture/model.bin";
    const expectedModel = Buffer.from("trusted-model-bytes");
    const tamperedModel = Buffer.from("tampered-model-byte");
    assert.equal(tamperedModel.length, expectedModel.length);
    const expectedModelSha256 = crypto.createHash("sha256").update(expectedModel).digest("hex");
    const developmentEngineRoot = path.join(root, "integrity-engine");
    const licenseRelativePath = "licenses/dev-license.txt";
    const expectedLicense = Buffer.from("trusted-development-license");
    const tamperedLicense = Buffer.from("tampered-development-licens");
    assert.equal(tamperedLicense.length, expectedLicense.length);
    const expectedLicenseSha256 = crypto.createHash("sha256").update(expectedLicense).digest("hex");
    await fs.mkdir(path.join(modelRoot, "fixture"), { recursive: true });
    await fs.mkdir(path.join(developmentEngineRoot, "licenses"), { recursive: true });
    await fs.writeFile(path.join(modelRoot, modelRelativePath), tamperedModel);
    await fs.writeFile(path.join(developmentEngineRoot, licenseRelativePath), expectedLicense);
    const integrityComponent = {
      id: "integrity-model",
      kind: "chart-model",
      label: "Integrity model",
      license: "MIT",
      files: [
        {
          path: modelRelativePath,
          source: "remote",
          size: expectedModel.length,
          sha256: expectedModelSha256,
        },
        {
          path: licenseRelativePath,
          source: "bundled-license",
          size: expectedLicense.length,
          sha256: expectedLicenseSha256,
        },
      ],
    };
    const integrityCatalog = {
      schemaVersion: 1,
      defaults: { packId: "integrity-pack", generatorId: "integrity-generator" },
      components: [integrityComponent],
      packs: [{ id: "integrity-pack", label: "Integrity pack", components: [integrityComponent.id] }],
      generatorRequirements: { "integrity-generator": [integrityComponent.id] },
    };
    await fs.writeFile(
      path.join(modelRoot, "catalog.json"),
      `${JSON.stringify(integrityCatalog)}\n`
    );
    const integrityManifest = {
      engineRoot: developmentEngineRoot,
      generators: [{ id: "integrity-generator", models: {} }],
    };
    // A fresh dev checkout includes metadata and legal files, but no models.
    // Keep that distinct from an incomplete or corrupt download.
    const freshModelRoot = path.join(root, "fresh-models");
    const descriptorPath = "fixture/manifest.json";
    const descriptor = Buffer.from('{"graphs":{}}');
    const checkoutFolder = path.join(developmentEngineRoot, "models-onnx", "fixture");
    await fs.mkdir(checkoutFolder, { recursive: true });
    await fs.writeFile(path.join(checkoutFolder, "manifest.json"), descriptor);
    const freshCatalog = {
      ...integrityCatalog,
      components: [{
        ...integrityComponent,
        files: [
          ...integrityComponent.files,
          { ...integrityComponent.files[0], path: "fixture/second-model.bin" },
          {
            path: descriptorPath,
            source: "remote",
            size: descriptor.length,
            sha256: crypto.createHash("sha256").update(descriptor).digest("hex"),
          },
        ],
      }],
    };
    const scanFresh = () => modelManager.scanModelSetup({
      settings: { modelsFolder: freshModelRoot },
      manifest: integrityManifest,
      catalog: freshCatalog,
      developmentAssetRoot: developmentEngineRoot,
    });
    const freshScan = await scanFresh();
    assert.equal(freshScan.combinedStatus, "missing", "checkout support files must not imply an installation");
    assert.equal(freshScan.generationReady, false);
    assert.throws(() => modelManager.assertSetupReadyForCompletion(freshScan), /chart generation package/);
    await fs.mkdir(path.join(freshModelRoot, "fixture"), { recursive: true });
    await fs.writeFile(path.join(freshModelRoot, descriptorPath), descriptor);
    assert.equal((await scanFresh()).combinedStatus, "partial", "an installed descriptor counts as an incomplete download");
    await fs.writeFile(path.join(freshModelRoot, modelRelativePath), expectedModel);
    assert.equal((await scanFresh()).combinedStatus, "partial", "a missing second model must still need repair");
    await fs.writeFile(path.join(freshModelRoot, "fixture/second-model.bin"), expectedModel);
    assert.equal((await scanFresh()).combinedStatus, "ready");
    await fs.writeFile(path.join(freshModelRoot, "fixture/second-model.bin"), tamperedModel);
    assert.equal((await scanFresh()).combinedStatus, "corrupt");
    console.log("application security: fresh checkout metadata is not a partial model installation");

    const tamperedScan = await modelManager.scanModelSetup({
      settings: { modelsFolder: modelRoot },
      manifest: integrityManifest,
      catalog: integrityCatalog,
    });
    assert.equal(tamperedScan.components[0].status, "corrupt");
    assert.equal(tamperedScan.components[0].files[0].verifiedBy, undefined);
    await fs.writeFile(path.join(modelRoot, modelRelativePath), expectedModel);
    const trustedScan = await modelManager.scanModelSetup({
      settings: { modelsFolder: modelRoot },
      manifest: integrityManifest,
      catalog: integrityCatalog,
    });
    assert.equal(trustedScan.components[0].status, "partial");
    assert.equal(trustedScan.components[0].files[0].sha256, expectedModelSha256);
    assert.equal(trustedScan.components[0].files[1].status, "missing");
    assert.throws(
      () => modelManager.assertSetupReadyForCompletion(trustedScan),
      /chart generation package/
    );
    const developmentScan = await modelManager.scanModelSetup({
      settings: { modelsFolder: modelRoot },
      manifest: integrityManifest,
      catalog: integrityCatalog,
      developmentAssetRoot: developmentEngineRoot,
    });
    assert.equal(developmentScan.components[0].status, "ready");
    assert.equal(
      modelManager.assertSetupReadyForCompletion(developmentScan),
      developmentScan
    );
    assert.equal(developmentScan.components[0].files[1].sha256, expectedLicenseSha256);
    assert.equal(
      developmentScan.components[0].files[1].resolvedPath,
      path.join(developmentEngineRoot, licenseRelativePath)
    );

    await fs.mkdir(path.join(modelRoot, "licenses"));
    await fs.writeFile(path.join(modelRoot, licenseRelativePath), tamperedLicense);
    const corruptInstalledLicenseScan = await modelManager.scanModelSetup({
      settings: { modelsFolder: modelRoot },
      manifest: integrityManifest,
      catalog: integrityCatalog,
      developmentAssetRoot: developmentEngineRoot,
    });
    assert.equal(corruptInstalledLicenseScan.components[0].status, "corrupt");
    assert.equal(corruptInstalledLicenseScan.components[0].files[1].status, "corrupt");
    assert.equal(
      corruptInstalledLicenseScan.components[0].files[1].resolvedPath,
      path.join(modelRoot, licenseRelativePath)
    );

    console.log("application security: folder names, project traversal/symlinks, and sender capabilities passed");
    console.log("application security: Raw HID support absent and unrelated permissions remain denied");
    console.log("application security: malformed ids, manifests, chart declarations, and media declarations rejected");
    console.log("application security: non-destructive cache cutover and quarantine identity race passed");
    console.log("application security: corrupt settings preserved with dismissible recovery notice");
    console.log("application security: same-size model tampering rejected by byte hashing");
    console.log("application security: bundled licenses use a hash-pinned development-only fallback");
    console.log("application security: setup completion rejects a missing chart generation package");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

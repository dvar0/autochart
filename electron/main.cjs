const { app, BrowserWindow, Menu, ipcMain, dialog, protocol, screen, shell } = require("electron");
const { installWindowFit } = require("./windowFit.cjs");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { fileURLToPath } = require("url");
const libraryStore = require("./libraryStore.cjs");
const engineManager = require("./engineManager.cjs");
const { persistGeneratedTake } = require("./generatedTake.cjs");
const hardwareProbe = require("./hardwareProbe.cjs");
const modelManager = require("./modelManager.cjs");
const settingsStore = require("./settingsStore.cjs");
const assetInstaller = require("./assetInstaller.cjs");
const runtimeSelection = require("./runtimeSelection.cjs");
const { createHostContext } = require("./hostContext.cjs");
const cacheOwnership = require("./cacheOwnership.cjs");
const { migrateLegacyCache } = require("./cacheMigration.cjs");
const { FileCapabilityRegistry } = require("./fileCapabilities.cjs");
const { resolveLibrarySavePayload } = require("./libraryPayload.cjs");
const { prepareVideoPreview, getVideoPreviewSource } = require("./videoPreview.cjs");
const {
  MEDIA_SCHEME,
  createMediaProtocolHandler,
  mediaAssetUrl,
} = require("./mediaProtocol.cjs");
const { normalizeMediaAssetRole, assertMediaAssetMetadata } = require("./mediaAssetPolicy.cjs");
const { safeFolderName, strictChildPath } = require("./pathSafety.cjs");
const {
  RELEASE_SMOKE_CHANNEL,
  createReleaseSmokePingHandler,
  resolveReleaseSmokePaths,
  waitForReleaseSmokeRenderer,
} = require("./releaseSmoke.cjs");
const { resolveNoticePath } = require("./noticePaths.cjs");
const fileCapabilities = new FileCapabilityRegistry();
const releaseSmokePaths = resolveReleaseSmokePaths();
const releaseSmokeSenderIds = new Set();

protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const isDev = !app.isPackaged;
const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";

function enableNativeWayland() {
  if (process.platform !== "linux") return;
  if (process.env.AUTOCHART_WAYLAND === "0") return;

  const isWaylandSession =
    process.env.XDG_SESSION_TYPE === "wayland" || Boolean(process.env.WAYLAND_DISPLAY);
  if (!isWaylandSession) return;

  app.commandLine.appendSwitch("ozone-platform", "wayland");
  app.commandLine.appendSwitch("ozone-platform-hint", "wayland");
  app.commandLine.appendSwitch("enable-features", "WaylandWindowDecorations");

  if (!app.isPackaged) {
    console.log("[electron] Native Wayland enabled via Ozone.");
  }
}

enableNativeWayland();

app.setName("Autochart");
const userDataOverride = releaseSmokePaths?.userData || process.env.AUTOCHART_USER_DATA;
if (userDataOverride) {
  const override = path.resolve(userDataOverride);
  fsSync.mkdirSync(override, { recursive: true });
  app.setPath("userData", override);
}
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function focusPrimaryWindow() {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    if (app.isReady()) createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", focusPrimaryWindow);
}

// Native menu. The stock Electron menu (Reload, Force Reload, Toggle
// DevTools, "Learn More → electronjs.org") screams dev build, so we ship a
// minimal one: macOS keeps a proper app/Edit/Window menu (the OS draws a menu
// bar no matter what, and Cmd+C/V/A need menu roles there); Windows/Linux get
// no menu bar in release builds — copy/paste/select-all still work natively in
// fields. In dev we keep a hidden, Alt-revealable menu with reload/devtools.
function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const template = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push({
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      ...(isMac ? [{ role: "pasteAndMatchStyle" }] : []),
      { role: "delete" },
      { type: "separator" },
      { role: "selectAll" },
    ],
  });

  const viewSubmenu = [
    { role: "togglefullscreen" },
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
  ];
  if (isDev) {
    viewSubmenu.push({ type: "separator" }, { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" });
  }
  template.push({ label: "View", submenu: viewSubmenu });

  template.push({
    label: "Window",
    submenu: isMac
      ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
      : [{ role: "minimize" }, { role: "close" }],
  });

  return Menu.buildFromTemplate(template);
}

function setupApplicationMenu() {
  const isMac = process.platform === "darwin";
  if (!isMac && !isDev) {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(buildAppMenu());
}

function resolveAppIconPath() {
  const iconPath = isDev
    ? path.join(__dirname, "..", "public", "app-icon.png")
    : path.join(__dirname, "..", "dist", "app-icon.png");
  return fsSync.existsSync(iconPath) ? iconPath : undefined;
}

function appOrigin() {
  if (isDev) return new URL(DEV_URL).origin;
  return "file://";
}

function isAllowedNavigationUrl(url) {
  if (isDev) {
    try {
      return new URL(url).origin === appOrigin();
    } catch {
      return false;
    }
  }
  if (!String(url || "").startsWith("file://")) return false;
  try {
    const distRoot = path.join(__dirname, "..", "dist");
    const target = fileURLToPath(url);
    const relative = path.relative(distRoot, target);
    return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  } catch {
    return false;
  }
}

function openExternalIfSafe(url) {
  try {
    const protocol = new URL(url).protocol;
    if (protocol === "http:" || protocol === "https:" || protocol === "mailto:") {
      shell.openExternal(url).catch(() => {});
    }
  } catch {
    // Ignore malformed or non-external URLs.
  }
}


function setupWindowSecurity(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedNavigationUrl(url)) openExternalIfSafe(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isAllowedNavigationUrl(url)) return;
    event.preventDefault();
    openExternalIfSafe(url);
  });

  const session = win.webContents.session;
  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
}


const hostContext = createHostContext({
  userDataPath: () => app.getPath("userData"),
  documentsPath: () => releaseSmokePaths?.documents || app.getPath("documents"),
  homePath: () => releaseSmokePaths?.home || app.getPath("home"),
  appDataPath: () => releaseSmokePaths?.appData || app.getPath("appData"),
  localAppDataPath: () => releaseSmokePaths?.localAppData || "",
  xdgCachePath: () => releaseSmokePaths ? path.join(releaseSmokePaths.root, "xdg-cache") : "",
  xdgDataPath: () => releaseSmokePaths ? path.join(releaseSmokePaths.root, "xdg-data") : "",
});
const userDataPath = hostContext.userDataPath;
const appDocumentsPath = hostContext.appDocumentsPath;
const resolveDefaultSettings = hostContext.resolveDefaultSettings;
const readStoredSettings = hostContext.readSettings;
const updateAppSettings = hostContext.updateSettings;
const settingsWithDefaults = hostContext.settingsWithDefaults;
const baseLibraryContext = hostContext.libraryContext;
function settingsForRenderer(settings) {
  const visible = settingsWithDefaults(settings);
  for (const key of settingsStore.INTERNAL_SETTINGS_KEYS) delete visible[key];
  return visible;
}

function dangerousCachePaths() {
  return [
    path.parse(app.getPath("home")).root,
    app.getPath("home"),
    app.getPath("userData"),
    app.getPath("documents"),
    app.getPath("appData"),
  ];
}

async function ensureCacheMigration(settings) {
  return migrateLegacyCache({
    settings,
    defaults: resolveDefaultSettings(),
    dangerousPaths: dangerousCachePaths(),
    persist: updateAppSettings,
  });
}

async function readAppSettings() {
  return ensureCacheMigration(await readStoredSettings());
}

async function libraryContext() {
  await readAppSettings();
  return baseLibraryContext();
}
async function prepareCacheDirectory(settings) {
  return cacheOwnership.prepareOwnedCacheDirectory(settings, dangerousCachePaths());
}

function sameResolvedPath(left, right) {
  const resolvedLeft = path.resolve(String(left || ""));
  const resolvedRight = path.resolve(String(right || ""));
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}



async function chooseSettingsFolder(key, title, buttonLabel) {
  const defaults = resolveDefaultSettings();
  const current = await readAppSettings();
  const choosingCacheParent = key === "cacheFolder";
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win ?? undefined, {
    title,
    buttonLabel,
    properties: ["openDirectory", "createDirectory"],
    defaultPath: choosingCacheParent
      ? current.cacheParentFolder || defaults.cacheParentFolder
      : current[key] || defaults[key] || app.getPath("documents"),
  });

  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true, settings: settingsForRenderer(current) };
  }

  const selectedPath = result.filePaths[0];
  if (choosingCacheParent) {
    const prospective = settingsStore.normalizeSettings(
      {
        ...current,
        cacheParentFolder: selectedPath,
        cachePathVersion: settingsStore.CACHE_PATH_VERSION,
      },
      defaults
    );
    await prepareCacheDirectory(prospective);
    const settings = await updateAppSettings({
      cacheParentFolder: selectedPath,
      cachePathVersion: settingsStore.CACHE_PATH_VERSION,
    });
    return { canceled: false, settings: settingsForRenderer(settings) };
  }

  const settings = await updateAppSettings({ [key]: selectedPath });
  return { canceled: false, settings: settingsForRenderer(settings) };
}

async function scanModelSetup(settings = null, manifest = null) {
  const resolvedSettings = settings || (await readAppSettings());
  const resolvedManifest = manifest || (await engineManager.loadManifest());
  const hardware = await hardwareProbe.probeHardware(resolvedSettings);
  return modelManager.scanModelSetup({
    settings: settingsWithHardwareSelection(resolvedSettings, hardware),
    manifest: resolvedManifest,
    developmentAssetRoot: isDev ? resolvedManifest.engineRoot : "",
  });
}

function settingsWithHardwareSelection(settings, hardware) {
  return {
    ...settings,
    effectiveHardwareMode: hardware?.effectiveHardwareMode || hardware?.selectedMode || "",
    selectedRuntimePack: hardware?.selectedRuntimePack || "",
  };
}

async function readRuntimeSettings() {
  const settings = await readAppSettings();
  await prepareCacheDirectory(settings);
  const hardware = await hardwareProbe.probeHardware(settings);
  return settingsWithHardwareSelection(settings, hardware);
}

function normalizeExportPayload(payload) {
  if (typeof payload === "string") return { songId: payload };
  return payload || {};
}
async function resolveEnginePayload(event, payload = {}) {
  const source = payload.audio || {};
  let resolved;
  if (source.kind === "selected-file") {
    resolved = await fileCapabilities.consume(event.sender, source.token, {
      purpose: "generation",
    });
  } else if (source.kind === "project-asset") {
    resolved = await libraryStore.getMediaAssetSource(
      await libraryContext(),
      source.projectId,
      source.fileName,
      "audio"
    );
  } else {
    throw new Error("Generation audio requires a valid selected-file capability or saved project asset.");
  }
  return {
    ...payload,
    audio: {
      path: resolved.path,
      name: resolved.name,
      mime: String(source.mime || resolved.mime || "application/octet-stream"),
      size: resolved.size,
      lastModified: resolved.lastModified,
      device: resolved.device,
      inode: resolved.inode,
    },
  };
}

function registerIpcHandlers() {
  ipcMain.handle(
    RELEASE_SMOKE_CHANNEL,
    createReleaseSmokePingHandler(releaseSmokePaths, releaseSmokeSenderIds)
  );

  ipcMain.handle("window:setFullscreen", (event, next) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    const fullscreen = Boolean(next);
    win.setFullScreen(fullscreen);
    return fullscreen;
  });

  ipcMain.handle("window:isFullscreen", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return Boolean(win?.isFullScreen());
  });

  ipcMain.handle("settings:get", async () => {
    const settings = await readAppSettings();
    return settingsForRenderer(settings);
  });

  ipcMain.handle("settings:dismissRecovery", async () => {
    return settingsForRenderer(await hostContext.dismissSettingsRecovery());
  });

  ipcMain.handle("settings:update", async (_event, patch = {}) => {
    const settings = await updateAppSettings(
      settingsStore.assertRendererSettingsPatch(patch)
    );
    return settingsForRenderer(settings);
  });

  ipcMain.handle("settings:chooseProjectsFolder", async () => {
    return chooseSettingsFolder("projectsFolder", "Choose Autochart projects folder", "Use this folder");
  });

  ipcMain.handle("settings:chooseModelsFolder", async () => {
    return chooseSettingsFolder("modelsFolder", "Choose chart generation files folder", "Use this folder");
  });

  ipcMain.handle("settings:chooseCacheFolder", async () => {
    return chooseSettingsFolder(
      "cacheFolder",
      "Choose a parent folder for Autochart cache storage",
      "Use this folder"
    );
  });

  ipcMain.handle("settings:chooseCloneHeroLibraryFolder", async () => {
    return chooseSettingsFolder("cloneHeroLibraryFolder", "Choose Clone Hero songs folder", "Use this folder");
  });

  ipcMain.handle("settings:clearCloneHeroLibraryFolder", async () => {
    const settings = await updateAppSettings({
      cloneHeroLibraryFolder: "",
    });
    return settingsForRenderer(settings);
  });

  ipcMain.handle("settings:resetPath", async (_event, key) => {
    if (key === "cacheFolder" || key === "cacheParentFolder") {
      const defaults = resolveDefaultSettings();
      const current = await readAppSettings();
      const prospective = settingsStore.normalizeSettings(
        {
          ...current,
          cacheParentFolder: defaults.cacheParentFolder,
          cachePathVersion: settingsStore.CACHE_PATH_VERSION,
        },
        defaults
      );
      await prepareCacheDirectory(prospective);
    }
    const settings = await settingsStore.resetPath(userDataPath(), key, resolveDefaultSettings());
    return settingsForRenderer(settings);
  });

  ipcMain.handle("settings:markSetupComplete", async () => {
    modelManager.assertSetupReadyForCompletion(await scanModelSetup());
    const settings = await settingsStore.markSetupComplete(userDataPath(), resolveDefaultSettings());
    return settingsForRenderer(settings);
  });

  ipcMain.handle("settings:openPath", async (_event, key) => {
    if (!settingsStore.PATH_KEYS.has(key)) throw new Error("Unknown settings path.");
    const settings = await readAppSettings();
    const target = settings[key];
    if (!target) throw new Error("No folder is configured.");
    await fs.mkdir(target, { recursive: true });
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return { ok: true, path: target };
  });

  ipcMain.handle("notices:open", async (_event, key) => {
    const target = resolveNoticePath(path.join(__dirname, ".."), key);
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return { ok: true, notice: key };
  });

  ipcMain.handle("settings:clearCache", async (_event, expectedPath) => {
    const settings = await readAppSettings();
    await prepareCacheDirectory(settings);
    const cleared = await cacheOwnership.clearOwnedCacheDirectory(
      settings,
      expectedPath,
      dangerousCachePaths()
    );
    return {
      settings: settingsForRenderer(settings),
      path: cleared.path,
    };
  });

  ipcMain.handle("modelSetup:scan", async () => {
    return scanModelSetup();
  });

  async function installModelPack(event, options = {}) {
    const settings = await readRuntimeSettings();
    const installOptions = {
      ...options,
      onProgress: (payload) => {
        if (!event.sender.isDestroyed?.()) event.sender.send("modelSetup:installEvent", payload);
      },
    };
    let install = await assetInstaller.installAssets(settings, installOptions);
    let setup = await scanModelSetup(settings);
    const fallbackPack = setup?.standardPack;
    if (
      settings.effectiveHardwareMode === "cuda" &&
      setup?.settings?.effectiveHardwareMode === "cpu" &&
      fallbackPack?.id &&
      fallbackPack.ready === false &&
      fallbackPack.id !== install.packId
    ) {
      const cudaInstall = install;
      install = await assetInstaller.installAssets(
        { ...settings, effectiveHardwareMode: "cpu", selectedRuntimePack: setup.settings.selectedRuntimePack },
        { ...installOptions, packId: fallbackPack.id }
      );
      install = {
        ...install,
        fallbackFromPackId: cudaInstall.packId,
      };
      setup = await scanModelSetup({ ...settings, effectiveHardwareMode: "cpu" });
    }
    return { install, setup, settings: settingsForRenderer(setup?.settings || settings) };
  }

  ipcMain.handle("modelSetup:install", async (event) => {
    return installModelPack(event);
  });

  ipcMain.handle("hardware:probe", async () => {
    return hardwareProbe.probeHardware(await readAppSettings());
  });

  ipcMain.handle("library:saveSong", async (event, payload) => {
    try {
      const resolvedPayload = await resolveLibrarySavePayload(
        fileCapabilities,
        event.sender,
        payload
      );
      return await libraryStore.saveSong(await libraryContext(), resolvedPayload);
    } catch (err) {
      throw new Error(err.message || "Failed to save song to library.");
    }
  });

  ipcMain.handle("library:listSongs", async () => {
    return libraryStore.listSongs(await libraryContext());
  });

  ipcMain.handle("library:patchSong", async (event, payload) => {
    const resolvedPayload = await resolveLibrarySavePayload(fileCapabilities, event.sender, payload);
    return libraryStore.patchSong(await libraryContext(), resolvedPayload);
  });

  ipcMain.handle("library:getSong", async (_event, id) => {
    return libraryStore.getSong(await libraryContext(), id);
  });

  ipcMain.handle("library:getProjectDeletionDetails", async (_event, id) => {
    return libraryStore.getProjectDeletionDetails(await libraryContext(), id);
  });

  ipcMain.handle("library:trashProject", async (_event, payload = {}) => {
    const details = await libraryStore.getProjectDeletionDetails(
      await libraryContext(),
      payload.id
    );
    if (
      !payload.expectedPath ||
      !sameResolvedPath(payload.expectedPath, details.path) ||
      payload.expectedTitle !== details.title
    ) {
      throw new Error("The confirmed project details no longer match the project being deleted.");
    }
    await shell.trashItem(details.path);
    return { ok: true, path: details.path, disposition: "trash" };
  });

  ipcMain.handle("library:getAssetUrl", async (_event, { songId, fileName }) => {
    const source = await libraryStore.getMediaAssetSource(
      await libraryContext(),
      songId,
      fileName
    );
    return mediaAssetUrl(songId, source.name, `${source.size}-${source.lastModified}`);
  });
  ipcMain.handle("files:registerGenerationInput", async (event, source = {}) => {
    return fileCapabilities.register(event.sender, source.path, {
      ...source,
      purpose: "generation",
    });
  });
  ipcMain.handle("library:prepareVideoPreview", async (event, input = {}) => {
    const context = await libraryContext();
    let source;
    if (input.kind === "selected-file") {
      source = await fileCapabilities.consume(event.sender, input.token, { purpose: "library:background-video" });
      assertMediaAssetMetadata("background-video", source);
    } else if (input.kind === "project-asset") {
      source = await libraryStore.getMediaAssetSource(context, input.projectId, input.fileName, "background-video");
    } else {
      throw new Error("A selected video or declared project background is required.");
    }
    const cache = await prepareCacheDirectory(await readAppSettings());
    return prepareVideoPreview(source, cache.path);
  });
  ipcMain.handle("files:registerLibraryAsset", async (event, source = {}) => {
    const role = normalizeMediaAssetRole(source.role);
    return fileCapabilities.register(event.sender, source.path, {
      ...source,
      purpose: `library:${role}`,
    });
  });
  ipcMain.handle("library:getAssetSource", async (_event, { songId, fileName }) => {
    const source = await libraryStore.getMediaAssetSource(
      await libraryContext(),
      songId,
      fileName,
      "audio"
    );
    return {
      kind: "project-asset",
      projectId: songId,
      fileName: source.name,
      name: source.name,
      size: source.size,
      lastModified: source.lastModified,
      mime: source.mime,
    };
  });

  ipcMain.handle("library:exportSong", async (_event, payload) => {
    const { songId, versionId } = normalizeExportPayload(payload);
    if (!songId) throw new Error("No project selected to export.");
    const win = BrowserWindow.getFocusedWindow();
    const context = await libraryContext();
    const song = await libraryStore.getSong(context, songId);
    const defaultName = safeFolderName(song.meta?.title);

    const result = await dialog.showOpenDialog(win ?? undefined, {
      title: "Choose folder for Clone Hero export",
      buttonLabel: "Export here",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: path.join(app.getPath("documents"), defaultName),
    });

    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true };
    }

    const selectedRoot = await fs.realpath(path.resolve(result.filePaths[0]));
    const dest = strictChildPath(selectedRoot, defaultName);
    const out = await libraryStore.exportSongToFolder(context, songId, dest, { versionId });
    return {
      canceled: false,
      path: out.path,
      format: out.format,
      message: `Exported to ${out.path}`,
    };
  });

  ipcMain.handle("library:saveSongToCloneHeroLibrary", async (_event, payload = {}) => {
    const { songId, versionId } = normalizeExportPayload(payload);
    if (!songId) throw new Error("No project selected to save.");

    const settings = await readAppSettings();
    if (!settings.cloneHeroLibraryFolder) {
      throw new Error("Choose a Clone Hero / YARG library folder in Settings first.");
    }

    const out = await libraryStore.saveSongToCloneHeroLibrary(
      await libraryContext(),
      songId,
      settings.cloneHeroLibraryFolder,
      { versionId }
    );
    return {
      path: out.path,
      format: out.format,
      message: `Saved Autochart copy to Clone Hero / YARG library: ${out.path}`,
    };
  });

  ipcMain.handle("engine:getManifest", async () => {
    const settings = await readAppSettings();
    const loaded = await engineManager.loadManifest();
    if (!loaded.available) return loaded;
    const manifest = loaded;
    const scan = await scanModelSetup(settings, manifest);
    return modelManager.decorateManifest(manifest, scan);
  });

  ipcMain.handle("engine:generateChart", async (event, payload) => {
    runtimeSelection.assertSupportedTarget(process.platform, process.arch);
    try {
      const enginePayload = await resolveEnginePayload(event, payload);
      const projectId = payload.audio?.kind === "project-asset" ? payload.audio.projectId : null;
      const projectContext = projectId ? await libraryContext() : null;
      const settings = await readRuntimeSettings();
      const loaded = await engineManager.loadManifest();
      if (!loaded.available) throw new Error(loaded.error || "Autochart engine is unavailable.");
      const manifest = loaded;
      const catalog = await modelManager.loadCatalog(manifest);
      const scan = await scanModelSetup(settings, manifest);
      const generatorId = enginePayload.generatorId || manifest.generators?.[0]?.id;
      const setup = modelManager.readinessForCommand(scan, catalog, generatorId, {
        command: "generate",
        generation: enginePayload.generation,
      });
      if (!setup?.ready) {
        throw new Error(setup?.message || modelManager.generatorFailureMessage(generatorId, scan));
      }
      const result = await engineManager.generateChart(
        userDataPath(),
        event.sender,
        enginePayload,
        { settings }
      );
      const saved = projectId
        ? await persistGeneratedTake(projectContext, projectId, result, payload)
        : result;
      if (saved.savedVersion && !event.sender.isDestroyed()) {
        event.sender.send("engine:jobEvent", { type: "project_saved", jobId: saved.jobId, projectId });
      }
      return saved;
    } catch (err) {
      throw new Error(err.message || "Chart generation failed.");
    }
  });

  ipcMain.handle("engine:cancelJob", async (event, payload) => {
    return engineManager.cancelJob(payload?.jobId, event.sender);
  });

  ipcMain.handle("engine:prepareDemucs", async (event, payload) => {
    runtimeSelection.assertSupportedTarget(process.platform, process.arch);
    try {
      const enginePayload = await resolveEnginePayload(event, payload);
      const settings = await readRuntimeSettings();
      const loaded = await engineManager.loadManifest();
      if (!loaded.available) throw new Error(loaded.error || "Autochart engine is unavailable.");
      const manifest = loaded;
      const catalog = await modelManager.loadCatalog(manifest);
      const scan = await scanModelSetup(settings, manifest);
      const generatorId = enginePayload.generatorId || manifest.generators?.[0]?.id;
      const setup = modelManager.readinessForCommand(scan, catalog, generatorId, {
        command: "prepare-demucs",
      });
      if (!setup?.ready) {
        throw new Error(setup?.message || modelManager.generatorFailureMessage(generatorId, scan));
      }
      return await engineManager.prepareDemucs(
        userDataPath(),
        event.sender,
        enginePayload,
        { settings }
      );
    } catch (err) {
      throw new Error(err.message || "Demucs preparation failed.");
    }
  });

  ipcMain.handle("engine:readDemucsStem", async (_event, payload = {}) => {
    try {
      const settings = await readAppSettings();
      await prepareCacheDirectory(settings);
      const buf = await engineManager.readDemucsStem(
        userDataPath(),
        payload.path || payload.stemPath,
        { settings }
      );
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch (err) {
      throw new Error(err.message || "Could not read Demucs stem.");
    }
  });
}

function createWindow() {
  const iconPath = resolveAppIconPath();
  // Default to the ~1280x800 design size, but never open larger than the
  // user's actual screen (small laptops).
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: Math.min(1280, workArea.width),
    height: Math.min(800, workArea.height),
    minWidth: Math.min(820, workArea.width),
    minHeight: Math.min(640, workArea.height),
    title: "Autochart",
    ...(iconPath ? { icon: iconPath } : {}),
    // Match the app's dark window plane so there's no white flash before the
    // renderer paints; reveal the window only once it has content.
    backgroundColor: "#14111b",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  const sendFullscreenState = () => {
    if (!win.isDestroyed()) {
      win.webContents.send("window:fullscreen-changed", win.isFullScreen());
    }
  };
  win.on("enter-full-screen", sendFullscreenState);
  win.on("leave-full-screen", sendFullscreenState);

  setupWindowSecurity(win);

  installWindowFit(win);

  if (releaseSmokePaths) {
    const releaseSmokeSenderId = win.webContents.id;
    releaseSmokeSenderIds.add(releaseSmokeSenderId);
    win.webContents.once("destroyed", () => {
      releaseSmokeSenderIds.delete(releaseSmokeSenderId);
    });
    win.webContents.once("did-finish-load", () => {
      writeReleaseSmokeReadyMarker(win).catch((error) => {
        console.error(`[electron] Release smoke readiness failed: ${error.message || error}`);
      });
    });
  }

  if (isDev) {
    win.loadURL(DEV_URL);
    if (process.env.AUTOCHART_DEVTOOLS === "1") {
      win.webContents.openDevTools({ mode: "detach" });
    }
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

function registerMediaProtocol() {
  protocol.handle(
    MEDIA_SCHEME,
    createMediaProtocolHandler({
      getPreviewSource: getVideoPreviewSource,
      getSource: async (songId, fileName) =>
        libraryStore.getMediaAssetSource(await libraryContext(), songId, fileName),
    })
  );
}

async function writeReleaseSmokeReadyMarker(win) {
  if (!releaseSmokePaths) return;
  await waitForReleaseSmokeRenderer(win);
  const marker = path.join(userDataPath(), "release-smoke-ready.json");
  const temporary = `${marker}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(userDataPath(), { recursive: true });
  try {
    await fs.writeFile(
      temporary,
      `${JSON.stringify({
        schemaVersion: 1,
        product: "Autochart",
        version: app.getVersion(),
        platform: process.platform,
        architecture: process.arch,
        processId: process.pid,
        readyAt: new Date().toISOString(),
      }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
    await fs.rename(temporary, marker);
    console.log(`[electron] Release smoke renderer ready: ${marker}`);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

if (hasSingleInstanceLock) {
  app.whenReady().then(() => {
    setupApplicationMenu();
    registerIpcHandlers();
    registerMediaProtocol();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else focusPrimaryWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

const { contextBridge, ipcRenderer, webUtils } = require("electron");

function selectedFilePath(file) {
  try {
    return webUtils.getPathForFile(file);
  } catch {
    return "";
  }
}

function selectedFileMetadata(file, extra = {}) {
  const filePath = selectedFilePath(file);
  if (!filePath) return null;
  return {
    path: filePath,
    name: file.name || "",
    mime: file.type || "application/octet-stream",
    size: Number(file.size) || 0,
    lastModified: Number(file.lastModified) || 0,
    ...extra,
  };
}

contextBridge.exposeInMainWorld("autochart", {
  platform: process.platform,
  releaseSmoke: {
    ping: () => ipcRenderer.invoke("releaseSmoke:ping"),
  },
  files: {
    registerGenerationInput: async (file) => {
      const source = selectedFileMetadata(file);
      return source
        ? ipcRenderer.invoke("files:registerGenerationInput", source)
        : null;
    },
    registerLibraryAsset: async (file, role) => {
      const source = selectedFileMetadata(file, { role });
      return source
        ? ipcRenderer.invoke("files:registerLibraryAsset", source)
        : null;
    },
  },
  window: {
    setFullscreen: (next) => ipcRenderer.invoke("window:setFullscreen", next),
    isFullscreen: () => ipcRenderer.invoke("window:isFullscreen"),
    onFullscreenChange: (callback) => {
      const listener = (_event, active) => callback(Boolean(active));
      ipcRenderer.on("window:fullscreen-changed", listener);
      return () => ipcRenderer.removeListener("window:fullscreen-changed", listener);
    },
  },
  library: {
    isAvailable: () => true,
    saveSong: (payload) => ipcRenderer.invoke("library:saveSong", payload),
    patchSong: (payload) => ipcRenderer.invoke("library:patchSong", payload),
    listSongs: () => ipcRenderer.invoke("library:listSongs"),
    getSong: (id) => ipcRenderer.invoke("library:getSong", id),
    getProjectDeletionDetails: (id) =>
      ipcRenderer.invoke("library:getProjectDeletionDetails", id),
    trashProject: (payload) => ipcRenderer.invoke("library:trashProject", payload),
    getAssetUrl: (songId, fileName) =>
      ipcRenderer.invoke("library:getAssetUrl", { songId, fileName }),
    prepareVideoPreview: (source) => ipcRenderer.invoke("library:prepareVideoPreview", source),
    getAssetSource: (songId, fileName) =>
      ipcRenderer.invoke("library:getAssetSource", { songId, fileName }),
    exportSong: (payload) => ipcRenderer.invoke("library:exportSong", payload),
    saveSongToCloneHeroLibrary: (payload) =>
      ipcRenderer.invoke("library:saveSongToCloneHeroLibrary", payload),
  },
  settings: {
    isAvailable: () => true,
    get: () => ipcRenderer.invoke("settings:get"),
    dismissRecovery: () => ipcRenderer.invoke("settings:dismissRecovery"),
    update: (patch) => ipcRenderer.invoke("settings:update", patch),
    chooseProjectsFolder: () => ipcRenderer.invoke("settings:chooseProjectsFolder"),
    chooseModelsFolder: () => ipcRenderer.invoke("settings:chooseModelsFolder"),
    chooseCacheFolder: () => ipcRenderer.invoke("settings:chooseCacheFolder"),
    chooseCloneHeroLibraryFolder: () =>
      ipcRenderer.invoke("settings:chooseCloneHeroLibraryFolder"),
    clearCloneHeroLibraryFolder: () =>
      ipcRenderer.invoke("settings:clearCloneHeroLibraryFolder"),
    resetPath: (key) => ipcRenderer.invoke("settings:resetPath", key),
    markSetupComplete: () => ipcRenderer.invoke("settings:markSetupComplete"),
    openPath: (key) => ipcRenderer.invoke("settings:openPath", key),
    clearCache: (expectedPath) => ipcRenderer.invoke("settings:clearCache", expectedPath),
  },
  notices: {
    open: (key) => ipcRenderer.invoke("notices:open", key),
  },
  modelSetup: {
    isAvailable: () => true,
    scan: () => ipcRenderer.invoke("modelSetup:scan"),
    install: () => ipcRenderer.invoke("modelSetup:install"),
    onInstallEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("modelSetup:installEvent", listener);
      return () => ipcRenderer.removeListener("modelSetup:installEvent", listener);
    },
  },
  hardware: {
    isAvailable: () => true,
    probe: () => ipcRenderer.invoke("hardware:probe"),
  },
  engine: {
    isAvailable: () => true,
    getManifest: () => ipcRenderer.invoke("engine:getManifest"),
    generateChart: (payload) => ipcRenderer.invoke("engine:generateChart", payload),
    cancelJob: (payload) => ipcRenderer.invoke("engine:cancelJob", payload),
    prepareDemucs: (payload) => ipcRenderer.invoke("engine:prepareDemucs", payload),
    readDemucsStem: (payload) => ipcRenderer.invoke("engine:readDemucsStem", payload),
    onJobEvent: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("engine:jobEvent", listener);
      return () => ipcRenderer.removeListener("engine:jobEvent", listener);
    },
  },
});

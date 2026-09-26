const path = require("path");

const settingsStore = require("./settingsStore.cjs");
const libraryStore = require("./libraryStore.cjs");
const assetInstaller = require("./assetInstaller.cjs");

function resolveValue(value) {
  return typeof value === "function" ? value() : value;
}

function createHostContext({
  userDataPath,
  documentsPath,
  homePath,
  appDataPath,
  localAppDataPath,
  xdgCachePath,
  xdgDataPath,
}) {
  function userDataPathFn() {
    return resolveValue(userDataPath);
  }

  function appDocumentsPath() {
    return path.join(resolveValue(documentsPath), "Autochart");
  }

  function resolveDefaultSettings() {
    const home = resolveValue(homePath);
    const localAppData =
      resolveValue(localAppDataPath) || process.env.LOCALAPPDATA || resolveValue(userDataPath);
    const roamingAppData = process.env.APPDATA || resolveValue(appDataPath);
    if (process.platform === "win32") {
      const cacheParentFolder = path.join(localAppData, "Autochart", "Cache");
      return {
        projectsFolder: path.join(appDocumentsPath(), "Projects"),
        modelsFolder: path.join(localAppData, "Autochart", "Models"),
        cacheParentFolder,
        cacheFolder: path.join(cacheParentFolder, settingsStore.CACHE_DIR_NAME),
        cloneHeroLibraryFolder: "",
        assetBaseUrl: process.env.AUTOCHART_ASSETS_BASE_URL || assetInstaller.DEFAULT_ASSET_BASE_URL,
      };
    }
    if (process.platform === "darwin") {
      const cacheParentFolder = path.join(home, "Library", "Caches", "Autochart");
      return {
        projectsFolder: path.join(appDocumentsPath(), "Projects"),
        modelsFolder: path.join(home, "Library", "Application Support", "Autochart", "Models"),
        cacheParentFolder,
        cacheFolder: path.join(cacheParentFolder, settingsStore.CACHE_DIR_NAME),
        cloneHeroLibraryFolder: "",
        assetBaseUrl: process.env.AUTOCHART_ASSETS_BASE_URL || assetInstaller.DEFAULT_ASSET_BASE_URL,
      };
    }
    const cacheParentFolder = path.join(
      resolveValue(xdgCachePath) || process.env.XDG_CACHE_HOME || path.join(home, ".cache"),
      "autochart"
    );
    return {
      projectsFolder: path.join(appDocumentsPath(), "Projects"),
      modelsFolder: path.join(
        resolveValue(xdgDataPath) || process.env.XDG_DATA_HOME || path.join(home, ".local", "share"),
        "autochart",
        "models"
      ),
      cacheParentFolder,
      cacheFolder: path.join(cacheParentFolder, settingsStore.CACHE_DIR_NAME),
      cloneHeroLibraryFolder: "",
      assetBaseUrl: process.env.AUTOCHART_ASSETS_BASE_URL || assetInstaller.DEFAULT_ASSET_BASE_URL,
    };
  }

  async function readSettings() {
    return settingsStore.readSettings(resolveValue(userDataPath), resolveDefaultSettings());
  }

  async function updateSettings(patch) {
    return settingsStore.updateSettings(resolveValue(userDataPath), patch, resolveDefaultSettings());
  }

  async function dismissSettingsRecovery() {
    return settingsStore.dismissSettingsRecovery(
      resolveValue(userDataPath),
      resolveDefaultSettings()
    );
  }

  function settingsWithDefaults(settings) {
    return {
      ...settings,
      defaults: resolveDefaultSettings(),
    };
  }

  async function libraryContext() {
    const settings = await readSettings();
    return {
      userDataPath: resolveValue(userDataPath),
      projectsFolder: settings.projectsFolder,
      cacheFolder: settings.cacheFolder,
      legacyCacheFolder: settings.legacyCacheFolder,
    };
  }

  return {
    userDataPath: userDataPathFn,
    readSettings,
    updateSettings,
    dismissSettingsRecovery,
    settingsWithDefaults,
    resolveDefaultSettings,
    libraryContext,
    appDocumentsPath,
    settingsStore,
    libraryStore,
  };
}

module.exports = { createHostContext };

import { electronSettings } from "./runtimeBridge.js";

const STORAGE_KEY = "autochart.settings";

const DEFAULT_SETTINGS = {
  setupComplete: false,
  projectsFolder: "",
  modelsFolder: "",
  cacheParentFolder: "",
  cacheFolder: "",
  cloneHeroLibraryFolder: "",
  hardwareMode: "auto",
  updateChannel: "stable",
  theme: "system",
  railCollapsed: false,
  assetBaseUrl: "",
  defaults: {},
};

function hasElectronSettings() {
  return Boolean(electronSettings()?.isAvailable?.());
}

function readBrowserSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeBrowserSettings(settings) {
  const next = { ...DEFAULT_SETTINGS, ...settings };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Settings are best-effort in browser preview mode.
  }
  return next;
}
export async function getAppSettings() {
  if (hasElectronSettings()) return electronSettings().get();
  return readBrowserSettings();
}

export async function updateAppSettings(patch) {
  const bridge = electronSettings();
  if (hasElectronSettings() && bridge?.update) {
    return bridge.update(patch);
  }
  return writeBrowserSettings({ ...readBrowserSettings(), ...patch });
}

async function chooseFolder(methodName) {
  const bridge = electronSettings();
  if (!hasElectronSettings() || !bridge?.[methodName]) {
    throw new Error("Folder selection requires the Electron app.");
  }
  return bridge[methodName]();
}

export async function chooseProjectsFolder() {
  return chooseFolder("chooseProjectsFolder");
}

export async function chooseModelsFolder() {
  return chooseFolder("chooseModelsFolder");
}

export async function chooseCacheFolder() {
  return chooseFolder("chooseCacheFolder");
}

export async function chooseCloneHeroLibraryFolder() {
  return chooseFolder("chooseCloneHeroLibraryFolder");
}

export async function clearCloneHeroLibraryFolder() {
  const bridge = electronSettings();
  if (hasElectronSettings() && bridge?.clearCloneHeroLibraryFolder) {
    return bridge.clearCloneHeroLibraryFolder();
  }
  return writeBrowserSettings({ ...readBrowserSettings(), cloneHeroLibraryFolder: "" });
}

export async function resetSettingsPath(key) {
  const bridge = electronSettings();
  if (hasElectronSettings() && bridge?.resetPath) {
    return bridge.resetPath(key);
  }
  const current = readBrowserSettings();
  return writeBrowserSettings({ ...current, [key]: DEFAULT_SETTINGS[key] || "" });
}

export async function markSetupComplete() {
  const bridge = electronSettings();
  if (hasElectronSettings() && bridge?.markSetupComplete) {
    return bridge.markSetupComplete();
  }
  return writeBrowserSettings({ ...readBrowserSettings(), setupComplete: true });
}

export async function openSettingsPath(key) {
  const bridge = electronSettings();
  if (!hasElectronSettings() || !bridge?.openPath) {
    throw new Error("Opening folders requires the Electron app.");
  }
  return bridge.openPath(key);
}

export async function clearCacheFolder(expectedPath) {
  const bridge = electronSettings();
  if (!hasElectronSettings() || !bridge?.clearCache) {
    throw new Error("Clearing cache requires the Electron app.");
  }
  return bridge.clearCache(expectedPath);
}

export async function dismissSettingsRecoveryNotice() {
  const bridge = electronSettings();
  if (!hasElectronSettings() || !bridge?.dismissRecovery) {
    return readBrowserSettings();
  }
  return bridge.dismissRecovery();
}

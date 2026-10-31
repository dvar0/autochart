import { electronSettings } from "./runtimeBridge.js";
import { t } from "../i18n/index.js";

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
  language: "system",
  railCollapsed: false,
  defaultGeneratorId: "",
  fillInDrafts: false,
  liteOfferDeclined: false,
  keepStems: false,
  checkForUpdates: true,
  // Browser version: what Export downloads, "sng" or "zip".
  exportFormat: "sng",
  // Browser version: send usage counts (src/web/usageCounts.js).
  shareUsageCounts: true,
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

// The folder picker is the system's own window; its title and button come
// from here so they're in the app's language.
async function chooseFolder(methodName, title) {
  const bridge = electronSettings();
  if (!hasElectronSettings() || !bridge?.[methodName]) {
    throw new Error("Folder selection requires the Electron app.");
  }
  return bridge[methodName]({ title, buttonLabel: t("Use this folder") });
}

export async function chooseProjectsFolder() {
  return chooseFolder("chooseProjectsFolder", t("Choose Autochart projects folder"));
}

export async function chooseModelsFolder() {
  return chooseFolder("chooseModelsFolder", t("Choose chart generation files folder"));
}

export async function chooseCacheFolder() {
  return chooseFolder("chooseCacheFolder", t("Choose a parent folder for Autochart cache storage"));
}

export async function chooseCloneHeroLibraryFolder() {
  return chooseFolder("chooseCloneHeroLibraryFolder", t("Choose Clone Hero songs folder"));
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

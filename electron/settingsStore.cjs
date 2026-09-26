const fs = require("fs/promises");
const path = require("path");

const SETTINGS_NAME = "settings.json";
const SETTINGS_RECOVERY_NAME = "settings-recovery.json";
const CACHE_DIR_NAME = "Autochart Cache";
const CACHE_PATH_VERSION = 2;
const settingsWriteQueues = new Map();
const PATH_KEYS = new Set([
  "projectsFolder",
  "modelsFolder",
  "cacheParentFolder",
  "cacheFolder",
  "cloneHeroLibraryFolder",
]);
const INTERNAL_SETTINGS_KEYS = new Set([
  "cachePathVersion",
  "legacyCacheFolder",
  "cacheMigrationTarget",
  "defaults",
]);
const READ_ONLY_SETTINGS_KEYS = new Set(["settingsRecovery"]);

const DEFAULT_SETTINGS = {
  setupComplete: false,
  projectsFolder: "",
  modelsFolder: "",
  cacheParentFolder: "",
  cacheFolder: "",
  cachePathVersion: CACHE_PATH_VERSION,
  legacyCacheFolder: "",
  cloneHeroLibraryFolder: "",
  hardwareMode: "auto",
  updateChannel: "stable",
  theme: "system",
  assetBaseUrl: "",
};

function settingsPath(userDataPath) {
  return path.join(userDataPath, SETTINGS_NAME);
}

function settingsRecoveryPath(userDataPath) {
  return path.join(userDataPath, SETTINGS_RECOVERY_NAME);
}

function normalizePathSetting(value, key) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return normalizePathSetting(value[0], key);
  if (value && typeof value === "object") {
    if (value.settings && value.settings[key] != null) {
      return normalizePathSetting(value.settings[key], key);
    }
    if (Array.isArray(value.filePaths)) return normalizePathSetting(value.filePaths[0], key);
    for (const prop of ["path", "filePath", "folderPath", "folder", "value"]) {
      if (typeof value[prop] === "string") return value[prop].trim();
    }
    return "";
  }
  return String(value || "").trim();
}
function assertRendererSettingsPatch(patch) {
  const next = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
  const protectedKeys = [...PATH_KEYS, ...INTERNAL_SETTINGS_KEYS, ...READ_ONLY_SETTINGS_KEYS];
  if (protectedKeys.some((key) => Object.prototype.hasOwnProperty.call(next, key))) {
    throw new Error("Storage and internal settings can only be changed by Autochart.");
  }
  return next;
}


function normalizeSettings(settings = {}, defaults = {}) {
  const next = { ...DEFAULT_SETTINGS, ...defaults, ...settings };
  next.setupComplete = Boolean(next.setupComplete);
  const requestedHardwareMode = String(next.hardwareMode || "").toLowerCase();
  next.hardwareMode = requestedHardwareMode === "macos"
    ? "cpu"
    : ["auto", "cuda", "cpu", "webgpu", "coreml"].includes(requestedHardwareMode)
      ? requestedHardwareMode
      : DEFAULT_SETTINGS.hardwareMode;
  next.updateChannel = ["stable", "beta", "experimental"].includes(next.updateChannel)
    ? next.updateChannel
    : DEFAULT_SETTINGS.updateChannel;
  next.theme = ["system", "light", "dark"].includes(next.theme) ? next.theme : DEFAULT_SETTINGS.theme;
  next.assetBaseUrl = String(next.assetBaseUrl || "").trim();

  const storedVersion = Number(settings.cachePathVersion) || 0;
  const legacyCacheFolder = normalizePathSetting(settings.cacheFolder, "cacheFolder");
  const defaultCacheParent = normalizePathSetting(
    defaults.cacheParentFolder || defaults.cacheFolder,
    "cacheParentFolder"
  );
  const hasLegacyCache = storedVersion < CACHE_PATH_VERSION &&
    Object.prototype.hasOwnProperty.call(settings, "cacheFolder") &&
    Boolean(legacyCacheFolder);
  if (hasLegacyCache) {
    next.cacheParentFolder = legacyCacheFolder;
    next.cacheFolder = legacyCacheFolder;
    next.legacyCacheFolder = legacyCacheFolder;
    next.cacheMigrationTarget = path.join(legacyCacheFolder, CACHE_DIR_NAME);
    next.cachePathVersion = 1;
  } else {
    next.cacheParentFolder = normalizePathSetting(
      settings.cacheParentFolder || defaultCacheParent,
      "cacheParentFolder"
    );
    next.cacheFolder = next.cacheParentFolder
      ? path.join(next.cacheParentFolder, CACHE_DIR_NAME)
      : "";
    next.legacyCacheFolder = normalizePathSetting(
      settings.legacyCacheFolder,
      "legacyCacheFolder"
    );
    next.cacheMigrationTarget = "";
    next.cachePathVersion = CACHE_PATH_VERSION;
  }

  for (const key of PATH_KEYS) {
    if (key !== "cacheParentFolder" && key !== "cacheFolder") {
      next[key] = normalizePathSetting(next[key], key);
    }
  }
  return next;
}

async function readRecoveryNotice(userDataPath) {
  try {
    const raw = await fs.readFile(settingsRecoveryPath(userDataPath), "utf8");
    const notice = JSON.parse(raw);
    if (!notice || typeof notice !== "object" || typeof notice.backupPath !== "string") {
      throw new Error("Invalid settings recovery record.");
    }
    return {
      occurredAt: String(notice.occurredAt || ""),
      backupPath: notice.backupPath,
      message: "Autochart preserved an unreadable settings file and restored safe defaults.",
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    console.error(`Could not read Autochart settings recovery record: ${error.message || error}`);
    return null;
  }
}

async function withRecoveryNotice(settings, userDataPath) {
  const settingsRecovery = await readRecoveryNotice(userDataPath);
  return settingsRecovery ? { ...settings, settingsRecovery } : settings;
}

async function preserveCorruptSettings(userDataPath, error) {
  const sourcePath = settingsPath(userDataPath);
  const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]/g, "");
  const backupPath = path.join(
    userDataPath,
    `${SETTINGS_NAME}.corrupt-${stamp}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`
  );
  try {
    await fs.rename(sourcePath, backupPath);
  } catch (renameError) {
    if (renameError?.code === "ENOENT") return readRecoveryNotice(userDataPath);
    throw new Error(`Could not preserve unreadable Autochart settings: ${renameError.message}`, {
      cause: renameError,
    });
  }

  const notice = {
    occurredAt: new Date().toISOString(),
    backupPath,
    reason: String(error?.message || "Settings JSON was invalid."),
  };
  const recoveryPath = settingsRecoveryPath(userDataPath);
  const temporaryPath = `${recoveryPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(notice, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, recoveryPath);
  } catch (writeError) {
    await fs.rm(temporaryPath, { force: true });
    throw new Error(
      `Settings were preserved at ${backupPath}, but the recovery record could not be written: ${writeError.message}`,
      { cause: writeError }
    );
  }
  console.error(`Unreadable Autochart settings were preserved at ${backupPath}.`);
  return readRecoveryNotice(userDataPath);
}

async function readSettings(userDataPath, defaults = {}) {
  let raw;
  try {
    raw = await fs.readFile(settingsPath(userDataPath), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Could not read Autochart settings: ${error.message}`, { cause: error });
    }
    return withRecoveryNotice(normalizeSettings({}, defaults), userDataPath);
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Settings must contain a JSON object.");
    }
    return withRecoveryNotice(normalizeSettings(parsed, defaults), userDataPath);
  } catch (error) {
    const recovery = await preserveCorruptSettings(userDataPath, error);
    const next = normalizeSettings({}, defaults);
    return recovery ? { ...next, settingsRecovery: recovery } : next;
  }
}

function withSettingsWriteLock(userDataPath, action) {
  const key = path.resolve(userDataPath);
  const previous = settingsWriteQueues.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(action);
  settingsWriteQueues.set(key, pending);
  return pending.finally(() => {
    if (settingsWriteQueues.get(key) === pending) settingsWriteQueues.delete(key);
  });
}

async function writeSettingsUnlocked(userDataPath, settings, defaults = {}) {
  await fs.mkdir(userDataPath, { recursive: true });
  const filePath = settingsPath(userDataPath);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const persistedSettings = { ...settings };
  for (const key of READ_ONLY_SETTINGS_KEYS) delete persistedSettings[key];
  const next = normalizeSettings(persistedSettings, defaults);
  try {
    await fs.writeFile(tmpPath, JSON.stringify(next, null, 2));
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    throw err;
  }
  return withRecoveryNotice(next, userDataPath);
}

async function updateSettings(userDataPath, patch, defaults = {}) {
  return withSettingsWriteLock(userDataPath, async () => {
    const current = await readSettings(userDataPath, defaults);
    return writeSettingsUnlocked(userDataPath, { ...current, ...patch }, defaults);
  });
}

async function resetPath(userDataPath, key, defaults = {}) {
  if (!PATH_KEYS.has(key)) throw new Error(`Unknown settings path: ${key}`);
  if (key === "cacheFolder" || key === "cacheParentFolder") {
    return updateSettings(
      userDataPath,
      {
        cacheParentFolder: defaults.cacheParentFolder || defaults.cacheFolder || "",
        cachePathVersion: CACHE_PATH_VERSION,
      },
      defaults
    );
  }
  return updateSettings(userDataPath, { [key]: defaults[key] || "" }, defaults);
}

async function markSetupComplete(userDataPath, defaults = {}) {
  return updateSettings(userDataPath, { setupComplete: true }, defaults);
}

async function dismissSettingsRecovery(userDataPath, defaults = {}) {
  await fs.rm(settingsRecoveryPath(userDataPath), { force: true });
  return readSettings(userDataPath, defaults);
}

module.exports = {
  INTERNAL_SETTINGS_KEYS,
  assertRendererSettingsPatch,
  CACHE_DIR_NAME,
  CACHE_PATH_VERSION,
  DEFAULT_SETTINGS,
  PATH_KEYS,
  READ_ONLY_SETTINGS_KEYS,
  dismissSettingsRecovery,
  normalizeSettings,
  readSettings,
  resetPath,
  markSetupComplete,
  updateSettings,
};

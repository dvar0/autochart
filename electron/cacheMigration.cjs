const fs = require("fs/promises");
const path = require("path");
const cacheOwnership = require("./cacheOwnership.cjs");
const settingsStore = require("./settingsStore.cjs");

async function migrateLegacyCache({ settings, defaults, dangerousPaths = [], persist }) {
  if (Number(settings.cachePathVersion) >= settingsStore.CACHE_PATH_VERSION) return settings;
  const rawLegacy = String(settings.cacheFolder || "").trim();
  if (!rawLegacy) throw new Error("Legacy cache path is missing.");
  const legacyRoot = path.resolve(rawLegacy);
  let stat;
  try {
    stat = await fs.lstat(legacyRoot);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    const fallbackParent = String(defaults.cacheParentFolder || defaults.cacheFolder || "").trim();
    if (!fallbackParent) throw new Error("Legacy cache is missing and no safe default cache parent is configured.");
    const prospective = settingsStore.normalizeSettings({
      ...settings,
      cacheParentFolder: path.resolve(fallbackParent),
      cachePathVersion: settingsStore.CACHE_PATH_VERSION,
      legacyCacheFolder: "",
    }, defaults);
    await cacheOwnership.prepareOwnedCacheDirectory(prospective, dangerousPaths);
    return persist({
      cacheParentFolder: path.resolve(fallbackParent),
      cachePathVersion: settingsStore.CACHE_PATH_VERSION,
      legacyCacheFolder: "",
    });
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Legacy cache root must be a real directory.");
  }
  const canonicalLegacy = await fs.realpath(legacyRoot);
  const prospective = settingsStore.normalizeSettings({
    ...settings,
    cacheParentFolder: canonicalLegacy,
    cachePathVersion: settingsStore.CACHE_PATH_VERSION,
    legacyCacheFolder: canonicalLegacy,
  }, defaults);

  // V1 cache roots were never ownership-marked and may be arbitrary user
  // folders. Claim only the new fixed child; leave every legacy byte and path
  // untouched so saved absolute analysis/stem references remain valid.
  await cacheOwnership.prepareOwnedCacheDirectory(prospective, dangerousPaths);
  return persist({
    cacheParentFolder: canonicalLegacy,
    cachePathVersion: settingsStore.CACHE_PATH_VERSION,
    legacyCacheFolder: canonicalLegacy,
  });
}

module.exports = { migrateLegacyCache };

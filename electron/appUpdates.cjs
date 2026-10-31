const crypto = require("crypto");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// Each GitHub release carries a signed update.json naming its version and
// downloads. Only the signature is trusted, so the feed can move hosts without
// an app update. See docs/github-release.md for how a release makes one.
const FEED_URL = "https://github.com/dvar0/autochart/releases/latest/download/update.json";
const FEED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAUMyhPXlmi1MQTlMguFOgkXz7VFOwOKrM7ggbb3Lejec=
-----END PUBLIC KEY-----`;
const FEED_MAX_BYTES = 64 * 1024;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STATE_NAME = "updates.json";
const DOWNLOADS_DIR = "Updates";
// What a release says about itself: features up front, smaller changes and
// fixes in a short list, and a link to the full notes.
const FEATURE_LIMIT = 8;
const FIX_LIMIT = 30;
const TITLE_MAX_CHARS = 60;
const LINE_MAX_CHARS = 160;
const FILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const INSTALL_EXTENSIONS = { replace: ".AppImage", installer: ".exe", dmg: ".dmg" };
const HEADLINE_MAX_CHARS = 80;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

function parseVersion(value) {
  const match = VERSION.exec(String(value || ""));
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), pre: match[4] || "" };
}

// Release order; a prerelease sorts before its release.
function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error("Invalid version.");
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

function httpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error(`${label} is not a URL.`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${label} must use https.`);
  return parsed.toString();
}

function verifyFeed(text, publicKey = FEED_PUBLIC_KEY) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error("Update feed is not JSON.");
  }
  const payload = envelope?.payload;
  const signature = envelope?.signature;
  if (typeof payload !== "string" || typeof signature !== "string") {
    throw new Error("Update feed is not signed.");
  }
  const valid = crypto.verify(
    null,
    Buffer.from(payload, "utf8"),
    crypto.createPublicKey(publicKey),
    Buffer.from(signature, "base64")
  );
  if (!valid) throw new Error("Update feed signature does not match.");
  return { envelope: { payload, signature }, feed: validateFeed(JSON.parse(payload)) };
}

function validateFile(file, label) {
  if (!FILE_NAME.test(String(file?.name || ""))) throw new Error(`Update file name is invalid: ${label}`);
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error(`Update file size is invalid: ${label}`);
  if (!SHA256.test(String(file.sha256 || ""))) throw new Error(`Update file hash is invalid: ${label}`);
  return { name: file.name, url: httpsUrl(file.url, "Update file URL"), size: file.size, sha256: file.sha256 };
}

function validateFeed(feed) {
  if (!feed || feed.schemaVersion !== 1 || feed.product !== "Autochart") {
    throw new Error("Update feed is not an Autochart feed.");
  }
  if (!parseVersion(feed.version)) throw new Error("Update feed version is invalid.");
  const line = (value, max = LINE_MAX_CHARS) => typeof value === "string" && value.length <= max;
  const features = feed.features == null ? [] : feed.features;
  if (!Array.isArray(features) || features.length > FEATURE_LIMIT ||
    features.some((feature) => !line(feature?.title, TITLE_MAX_CHARS) || !line(feature?.text ?? "") ||
      (feature.icon != null && !/^[a-z][A-Za-z]{0,23}$/.test(feature.icon)))) {
    throw new Error("Update feed features are invalid.");
  }
  const fixes = feed.fixes == null ? [] : feed.fixes;
  if (!Array.isArray(fixes) || fixes.length > FIX_LIMIT || fixes.some((fix) => !line(fix))) {
    throw new Error("Update feed fixes are invalid.");
  }
  if (feed.sub != null && !line(feed.sub)) throw new Error("Update feed summary is invalid.");
  const files = {};
  for (const [target, file] of Object.entries(feed.files || {})) files[target] = validateFile(file, target);
  const headline = feed.headline == null ? "" : feed.headline;
  if (typeof headline !== "string" || headline.length > HEADLINE_MAX_CHARS) throw new Error("Update feed headline is invalid.");
  let image = null;
  if (feed.image != null) {
    image = validateFile(feed.image, "image");
    if (image.size > IMAGE_MAX_BYTES || !IMAGE_TYPES[path.extname(image.name).toLowerCase()]) {
      throw new Error("Update feed image is invalid.");
    }
  }
  return {
    version: feed.version,
    headline: headline.trim(),
    image,
    sub: String(feed.sub || "").trim(),
    important: feed.important === true,
    features: features.map((feature) => ({
      icon: feature.icon || "",
      title: feature.title.trim(),
      text: String(feature.text || "").trim(),
    }))
      .filter((feature) => feature.title),
    fixes: fixes.map((fix) => fix.trim()).filter(Boolean),
    page: httpsUrl(feed.page, "Update page"),
    notesUrl: feed.notesUrl == null ? "" : httpsUrl(feed.notesUrl, "Release notes URL"),
    files,
  };
}

// How this copy can update itself. Anything unrecognised (a portable zip, a
// development run, an app outside a bundle) gets the download page instead.
function detectInstallMode({ packaged, platform, env = process.env, execPath = process.execPath, productName = "Autochart" }) {
  if (!packaged) return "page";
  if (platform === "linux") return env.APPIMAGE ? "replace" : "page";
  if (platform === "win32") {
    const uninstaller = path.join(path.dirname(execPath), `Uninstall ${productName}.exe`);
    return fsSync.existsSync(uninstaller) ? "installer" : "page";
  }
  if (platform === "darwin") return /\.app\/Contents\/MacOS\/[^/]+$/.test(execPath) ? "dmg" : "page";
  return "page";
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fsSync.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function createAppUpdates({
  userDataPath,
  currentVersion,
  target,
  installMode = "page",
  publicKey = FEED_PUBLIC_KEY,
  feedUrl = FEED_URL,
  fetchText,
  downloadFile,
  downloadImage = downloadFile,
  readSettings,
  now = () => Date.now(),
  onChange = () => {},
}) {
  const statePath = path.join(userDataPath, STATE_NAME);
  const downloadsRoot = path.join(userDataPath, DOWNLOADS_DIR);
  let stored = { lastCheckedAt: 0, envelope: null, dismissedVersion: "", announcedVersion: "", lastSeenVersion: "" };
  let feed = null;
  let checking = null;
  let error = "";
  let download = { status: "idle", percent: 0, error: "", path: "" };
  let whatsNewSince = "";
  let enabled = true;
  let imageReady = false;

  const offer = () => (feed && compareVersions(feed.version, currentVersion) > 0 ? feed : null);
  const file = () => offer()?.files[target] || null;
  const image = () => offer()?.image || null;
  const keepNames = () => [file()?.name, image()?.name].filter(Boolean);
  const mode = () => (file() && INSTALL_EXTENSIONS[installMode] && file().name.endsWith(INSTALL_EXTENSIONS[installMode])
    ? installMode
    : "page");

  function snapshot() {
    const update = offer();
    return {
      currentVersion,
      enabled,
      checking: Boolean(checking),
      lastCheckedAt: stored.lastCheckedAt || 0,
      error,
      update: update && {
        version: update.version,
        headline: update.headline,
        sub: update.sub,
        hasImage: imageReady,
        features: update.features,
        fixes: update.fixes,
        notesUrl: update.notesUrl || update.page,
        important: update.important,
        size: file()?.size || 0,
        installMode: mode(),
      },
      dismissed: Boolean(update) && stored.dismissedVersion === update.version,
      announce: Boolean(update?.important) && stored.announcedVersion !== update.version,
      download: { status: download.status, percent: download.percent, error: download.error },
      whatsNewSince,
    };
  }

  const changed = () => onChange(snapshot());

  async function save() {
    await writeJsonAtomic(statePath, { schemaVersion: 1, ...stored });
  }

  async function init() {
    const saved = await readJson(statePath);
    if (saved && typeof saved === "object") {
      stored = {
        lastCheckedAt: Number(saved.lastCheckedAt) || 0,
        envelope: saved.envelope || null,
        dismissedVersion: String(saved.dismissedVersion || ""),
        announcedVersion: String(saved.announcedVersion || ""),
        lastSeenVersion: parseVersion(saved.lastSeenVersion) ? saved.lastSeenVersion : "",
      };
    }
    if (stored.envelope) {
      try {
        feed = verifyFeed(JSON.stringify(stored.envelope), publicKey).feed;
      } catch {
        stored.envelope = null;
      }
    }
    // The first release with this file can't tell an upgrade from a fresh
    // install by version, so a finished setup means someone used an older one.
    const settings = await readSettings();
    enabled = settings?.checkForUpdates !== false;
    if (!stored.lastSeenVersion) {
      if (settings?.setupComplete) whatsNewSince = "0.0.0";
      else stored.lastSeenVersion = currentVersion;
    } else if (compareVersions(stored.lastSeenVersion, currentVersion) < 0) {
      whatsNewSince = stored.lastSeenVersion;
    }
    await save();
    await pruneDownloads(keepNames());
    imageReady = Boolean(image()) && fsSync.existsSync(path.join(downloadsRoot, image().name));
    return snapshot();
  }

  async function pruneDownloads(keep) {
    let entries = [];
    try {
      entries = await fs.readdir(downloadsRoot);
    } catch {
      return;
    }
    await Promise.all(entries.filter((name) => !keep.includes(name))
      .map((name) => fs.rm(path.join(downloadsRoot, name), { force: true, recursive: true }).catch(() => {})));
  }

  async function check({ manual = false } = {}) {
    if (checking) return checking;
    if (!manual) {
      enabled = (await readSettings())?.checkForUpdates !== false;
      if (!enabled || now() - stored.lastCheckedAt < CHECK_INTERVAL_MS) return snapshot();
    }
    checking = (async () => {
      error = "";
      changed();
      try {
        const verified = verifyFeed(await fetchText(feedUrl, FEED_MAX_BYTES), publicKey);
        const previous = offer()?.version;
        feed = verified.feed;
        stored.envelope = verified.envelope;
        if (previous !== offer()?.version) {
          download = { status: "idle", percent: 0, error: "", path: "" };
          imageReady = false;
        }
      } catch (err) {
        error = manual ? "Couldn't check for updates. Try again later." : "";
        if (manual) console.warn(`[updates] ${err.message || err}`);
      }
      stored.lastCheckedAt = now();
      await save();
      await fetchImage();
    })();
    try {
      await checking;
    } finally {
      checking = null;
      changed();
    }
    return snapshot();
  }

  // The release's picture comes down with the check, so the notice can show it.
  async function fetchImage() {
    const wanted = image();
    if (!wanted || imageReady) return;
    try {
      await pruneDownloads(keepNames());
      await downloadImage({
        url: wanted.url,
        targetPath: path.join(downloadsRoot, wanted.name),
        rootDirectory: downloadsRoot,
        expectedSize: wanted.size,
        expectedSha256: wanted.sha256,
      });
      imageReady = true;
    } catch (err) {
      console.warn(`[updates] ${err.message || err}`);
    }
  }

  async function imageDataUrl() {
    const wanted = image();
    if (!wanted || !imageReady) return "";
    const bytes = await fs.readFile(path.join(downloadsRoot, wanted.name));
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== wanted.sha256) {
      imageReady = false;
      return "";
    }
    return `data:${IMAGE_TYPES[path.extname(wanted.name).toLowerCase()]};base64,${bytes.toString("base64")}`;
  }

  async function fetchUpdate() {
    const wanted = file();
    if (!wanted || mode() === "page") throw new Error("This copy of Autochart updates from the download page.");
    if (download.status === "downloading") return snapshot();
    if (download.status === "ready" && download.path) return snapshot();
    download = { status: "downloading", percent: 0, error: "", path: "" };
    changed();
    try {
      await pruneDownloads(keepNames());
      const result = await downloadFile({
        url: wanted.url,
        targetPath: path.join(downloadsRoot, wanted.name),
        rootDirectory: downloadsRoot,
        expectedSize: wanted.size,
        expectedSha256: wanted.sha256,
        onProgress: ({ percent }) => {
          if (percent === download.percent) return;
          download = { ...download, percent };
          changed();
        },
      });
      download = { status: "ready", percent: 100, error: "", path: result.path };
    } catch (err) {
      console.warn(`[updates] ${err.message || err}`);
      download = { status: "failed", percent: 0, error: "The download didn't finish.", path: "" };
    }
    changed();
    return snapshot();
  }

  // Checks the downloaded file again right before it runs.
  async function readyFile() {
    const wanted = file();
    if (download.status !== "ready" || !wanted) throw new Error("Download the update first.");
    if (await hashFile(download.path) !== wanted.sha256) {
      download = { status: "failed", percent: 0, error: "The download didn't finish.", path: "" };
      changed();
      throw new Error("The downloaded update changed on disk.");
    }
    return download.path;
  }

  async function setStored(patch) {
    Object.assign(stored, patch);
    await save();
    changed();
    return snapshot();
  }

  return {
    init,
    check,
    fetchUpdate,
    readyFile,
    imageDataUrl,
    snapshot,
    installMode: mode,
    pageUrl: () => offer()?.page || "",
    dismiss: () => (offer() ? setStored({ dismissedVersion: offer().version }) : snapshot()),
    markAnnounced: () => (offer() ? setStored({ announcedVersion: offer().version }) : snapshot()),
    markWhatsNewSeen: () => {
      whatsNewSince = "";
      return setStored({ lastSeenVersion: currentVersion });
    },
    setEnabled: (value) => {
      enabled = value !== false;
      changed();
    },
  };
}

// Puts the downloaded AppImage where the running one is, keeping its path so
// menus and shortcuts still open it. The running copy stays mounted until exit.
async function replaceAppImage(downloadedPath, appImagePath) {
  const directory = path.dirname(appImagePath);
  await fs.access(directory, fsSync.constants.W_OK);
  const staged = path.join(directory, `.${path.basename(appImagePath)}.${crypto.randomUUID()}.update`);
  try {
    await fs.copyFile(downloadedPath, staged, fsSync.constants.COPYFILE_EXCL);
    await fs.chmod(staged, 0o755);
    await fs.rename(staged, appImagePath);
  } catch (error) {
    await fs.rm(staged, { force: true }).catch(() => {});
    throw error;
  }
}

// The running AppImage's environment without what it added for itself, so the
// next one doesn't inherit paths into a mount that's about to go away.
function freshAppImageEnv(env) {
  const fresh = { ...env };
  for (const name of ["APPDIR", "APPIMAGE", "ARGV0", "OWD"]) delete fresh[name];
  if (!env.APPDIR) return fresh;
  for (const name of ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"]) {
    if (fresh[name] === undefined) continue;
    const kept = fresh[name].split(":").filter((entry) => entry !== env.APPDIR && !entry.startsWith(`${env.APPDIR}/`));
    if (kept.length) fresh[name] = kept.join(":");
    else delete fresh[name];
  }
  return fresh;
}

// Opens the AppImage again once this process has exited and freed the
// single-instance lock. app.relaunch can't do this: Electron starts it with
// no_new_privs, and an AppImage needs setuid fusermount to mount itself.
// Chromium leaves some files open across exec, so they're closed first;
// otherwise the new app would hold the old mount (and old file) until it quits.
function relaunchAppImage(appImagePath, args = [], { pid = process.pid, env = process.env, start = spawn } = {}) {
  const waitThenOpen = [
    'for fd in /proc/self/fd/*; do fd=${fd##*/}; [ "$fd" -gt 2 ] 2>/dev/null && eval "exec $fd>&-"; done',
    'i=0; while [ "$i" -lt 100 ] && kill -0 "$0" 2>/dev/null; do i=$((i+1)); sleep 0.1; done',
    'exec "$@"',
  ].join("\n");
  const child = start("/bin/sh", ["-c", waitThenOpen, String(pid), appImagePath, ...args], {
    detached: true,
    stdio: "ignore",
    env: freshAppImageEnv(env),
  });
  child.unref();
}

module.exports = {
  FEED_URL,
  compareVersions,
  createAppUpdates,
  detectInstallMode,
  relaunchAppImage,
  replaceAppImage,
  verifyFeed,
};

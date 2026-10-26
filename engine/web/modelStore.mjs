// Model files for the browser engine: fetched once, then served from the
// browser's Cache Storage, so a model downloads a single time per browser.
// Works in the page and in the engine worker (both have `caches`).

const CACHE_NAME = "autochart-models-v1";

let cachePromise = null;

function openCache() {
  if (!globalThis.caches) return Promise.resolve(null);
  cachePromise ??= caches.open(CACHE_NAME).catch(() => null);
  return cachePromise;
}

function cacheKey(url) {
  return new URL(url, globalThis.location?.href).href;
}

// Room the browser gives this site, in bytes: { free, quota, usage }, or null
// when it won't say. Browsers estimate, so treat it as a guide.
export async function storageRoom() {
  try {
    const { quota, usage } = await globalThis.navigator.storage.estimate();
    if (!Number.isFinite(quota) || quota <= 0) return null;
    const used = Number.isFinite(usage) ? usage : 0;
    return { free: Math.max(0, quota - used), quota, usage: used };
  } catch {
    return null;
  }
}

function megabytes(bytes) {
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

// Thrown when the device has no room for a model. needed and free are bytes
// (free is null when the browser didn't say).
export class StorageFullError extends Error {
  constructor(needed, free) {
    super(free == null
      ? "There isn't enough space on this device for the model. Free up space, or remove models in Settings."
      : `There isn't enough space on this device for the model: it needs ${megabytes(needed)}, about ${megabytes(free)} is free. Free up space, or remove models in Settings.`);
    this.name = "StorageFullError";
    this.code = "storage_full";
    this.needed = needed;
    this.free = free;
  }
}

function isQuotaError(err) {
  return err?.name === "QuotaExceededError" || err?.code === 22;
}

// Models take some room beyond their bytes once stored.
const STORAGE_MARGIN = 1.05;

// Whether bytes fit in a storageRoom() estimate (true when there's none).
export function fitsInRoom(bytes, room) {
  return !room || !bytes || bytes * STORAGE_MARGIN <= room.free;
}

// Throws StorageFullError when bytes won't fit, by the browser's estimate.
export async function checkStorageRoom(bytes) {
  const room = await storageRoom();
  if (!fitsInRoom(bytes, room)) throw new StorageFullError(bytes, room.free);
}

export async function isCached(url) {
  const cache = await openCache();
  return Boolean(cache && (await cache.match(cacheKey(url))));
}

// Cached with its size, so adding up the cache never has to read the files.
function cachedResponse(bytes) {
  return new Response(bytes, {
    headers: { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) },
  });
}

// The file's bytes, from the cache or the network. onProgress gets
// { loaded, total } while the file downloads.
export async function fetchModelFile(url, { onProgress = null } = {}) {
  const key = cacheKey(url);
  const cache = await openCache();
  const hit = cache && (await cache.match(key));
  if (hit) return new Uint8Array(await hit.arrayBuffer());

  const response = await fetch(key);
  if (!response.ok) throw new Error(`Couldn't download ${key.split("/").pop()} (${response.status})`);
  const total = Number(response.headers.get("Content-Length")) || 0;
  let bytes;
  if (onProgress && response.body) {
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress({ loaded, total });
    }
    bytes = new Uint8Array(loaded);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
  } else {
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  if (cache) {
    try {
      await cache.put(key, cachedResponse(bytes));
    } catch (err) {
      // Out of room: stop, rather than download it again on every run.
      if (isQuotaError(err)) throw new StorageFullError(bytes.length, (await storageRoom())?.free ?? null);
      // Storage unavailable (some private windows): it downloads each time.
    }
  }
  return bytes;
}

export async function fetchModelJson(url) {
  return JSON.parse(new TextDecoder().decode(await fetchModelFile(url)));
}

// The folder's manifest from the network when it can be reached (so a changed
// model is picked up), else the cached copy, so a downloaded model works offline.
// null when neither has it.
export async function loadModelManifest(folderUrl, { offlineOnly = false } = {}) {
  const baseUrl = new URL(folderUrl.endsWith("/") ? folderUrl : `${folderUrl}/`, globalThis.location?.href);
  const url = new URL("manifest.json", baseUrl).href;
  let bytes = null;
  if (!offlineOnly) {
    try {
      const response = await fetch(url, { cache: "no-cache" });
      if (response.ok) {
        bytes = new Uint8Array(await response.arrayBuffer());
        const cache = await openCache();
        try { await cache?.put(url, cachedResponse(bytes)); } catch { /* not cached, fine */ }
      }
    } catch { /* offline: use the cached copy */ }
  }
  if (!bytes) {
    const cache = await openCache();
    const hit = cache && (await cache.match(url));
    if (!hit) {
      if (offlineOnly) return null;
      throw new Error(`Couldn't reach the model at ${baseUrl.href}`);
    }
    bytes = new Uint8Array(await hit.arrayBuffer());
  }
  const manifest = JSON.parse(new TextDecoder().decode(bytes));
  manifest.baseUrl = baseUrl.href;
  return manifest;
}

// Graphs the browser never loads: Demucs' STFTs run in JS (stft.mjs).
const UNUSED_ROLES = new Set(["demucs-analysis-stft", "demucs-synthesis-istft"]);

// Every file a model folder's manifest points at (graphs and tables).
export function modelFiles(manifest) {
  const files = new Set();
  for (const graph of Object.values(manifest?.graphs || {})) {
    if (graph?.file && !UNUSED_ROLES.has(graph.role)) files.add(graph.file);
  }
  for (const stage of Object.values(manifest?.stages || {})) {
    for (const value of Object.values(stage || {})) {
      if (value && typeof value === "object" && typeof value.file === "string") files.add(value.file);
    }
  }
  return [...files];
}

// The files stem separation needs (the Demucs graphs).
export function separationFiles(manifest) {
  return Object.values(manifest?.graphs || {})
    .filter((graph) => graph?.file && String(graph.role || "").startsWith("demucs-") && !UNUSED_ROLES.has(graph.role))
    .map((graph) => graph.file);
}

// The files a model folder still needs (or only the listed ones), with their
// sizes from the host: { urls, sizes, total }.
export async function missingModelFiles(manifest, { only = null } = {}) {
  const urls = [];
  for (const file of only || modelFiles(manifest)) {
    const url = new URL(file, manifest.baseUrl).href;
    if (!(await isCached(url))) urls.push(url);
  }
  const sizes = await Promise.all(urls.map(async (url) => {
    try {
      const head = await fetch(url, { method: "HEAD" });
      return Number(head.headers.get("Content-Length")) || 0;
    } catch {
      return 0;
    }
  }));
  return { urls, sizes, total: sizes.reduce((sum, n) => sum + n, 0) };
}

// Downloads whatever the folder's manifest needs that isn't cached yet, or
// only the listed files. onProgress gets { loaded, total, file } in bytes
// across the missing files.
export async function ensureModelFiles(manifest, { onProgress = null, only = null } = {}) {
  const { urls: missing, sizes, total } = await missingModelFiles(manifest, { only });
  if (!missing.length) return { downloaded: 0 };
  await checkStorageRoom(total);
  let done = 0;
  try {
    for (const [i, url] of missing.entries()) {
      await fetchModelFile(url, {
        onProgress: ({ loaded }) => onProgress?.({ loaded: done + loaded, total, file: url.split("/").pop() }),
      });
      done += sizes[i];
    }
  } catch (err) {
    // A model that didn't fit gives back the room its other files took: it
    // can't run without the rest anyway.
    if (err?.code === "storage_full") {
      await removeModelFolder(manifest.baseUrl).catch(() => {});
      throw new StorageFullError(total, err.free);
    }
    throw err;
  }
  return { downloaded: missing.length, bytes: total };
}

// How much of a model folder is in the browser: { files, cachedFiles }.
export async function modelFolderStatus(manifest) {
  const files = modelFiles(manifest);
  let cachedFiles = 0;
  for (const file of files) {
    if (await isCached(new URL(file, manifest.baseUrl).href)) cachedFiles += 1;
  }
  return { files: files.length, cachedFiles };
}

// The cached files' total size in bytes, their URLs, and each one's size.
export async function cachedModelSummary() {
  const cache = await openCache();
  if (!cache) return { bytes: 0, urls: [], sizes: {} };
  const keys = await cache.keys();
  let bytes = 0;
  const sizes = {};
  for (const request of keys) {
    const response = await cache.match(request);
    if (!response) continue;
    const length = Number(response.headers.get("Content-Length"));
    const size = Number.isFinite(length) && length > 0 ? length : (await response.clone().blob()).size;
    sizes[request.url] = size;
    bytes += size;
  }
  return { bytes, urls: Object.keys(sizes), sizes };
}

// Removes a model folder's downloaded files (everything cached under it).
export async function removeModelFolder(folderUrl) {
  const cache = await openCache();
  if (!cache) return;
  const base = cacheKey(folderUrl.endsWith("/") ? folderUrl : `${folderUrl}/`);
  const keys = await cache.keys();
  await Promise.all(keys.filter((request) => request.url.startsWith(base)).map((request) => cache.delete(request)));
}

// Empties the cache rather than deleting it: the engine worker keeps the
// cache it opened, and files put in a deleted cache are lost.
export async function clearModelCache() {
  const cache = await openCache();
  if (!cache) return;
  const keys = await cache.keys();
  await Promise.all(keys.map((request) => cache.delete(request)));
}

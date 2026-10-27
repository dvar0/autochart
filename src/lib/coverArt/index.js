// Generated cover art for songs without an album cover, drawn once per seed
// and cached for the session as an object URL plus the cover's accent ink.
// Drawing happens in a small worker pool when OffscreenCanvas is available,
// otherwise on the main thread, one cover per animation frame.
import { renderCoverArt } from "./render.js";
// Inlined so the worker ships inside the main bundle (started from a blob: URL,
// which the CSP allows) rather than as an extra packaged asset.
import CoverArtWorker from "./worker.js?worker&inline";

// Library tiles are about 190 CSS px wide, so this stays sharp at 2x.
export const COVER_ART_SIZE = 384;

const cache = new Map(); // seed -> { url, accent }
const pending = new Map(); // seed -> Promise<{ url, accent }>

// Synchronous peek so a revisited grid renders its covers immediately.
export function peekCoverArt(seed) {
  return cache.get(seed) ?? null;
}

export function requestCoverArt(seed) {
  const hit = cache.get(seed);
  if (hit) return Promise.resolve(hit);
  if (!pending.has(seed)) {
    const job = draw(seed).then(
      ({ blob, accent }) => {
        const entry = { url: URL.createObjectURL(blob), accent };
        cache.set(seed, entry);
        pending.delete(seed);
        return entry;
      },
      (err) => {
        pending.delete(seed);
        throw err;
      }
    );
    pending.set(seed, job);
  }
  return pending.get(seed);
}

function draw(seed) {
  const pool = workerPool();
  if (!pool.length) return drawOnMainThread(seed);
  return drawInWorker(pool, seed).catch(() => drawOnMainThread(seed));
}

// --- Worker pool ---------------------------------------------------------

let pool = null;
let nextJobId = 1;

function workerPool() {
  if (pool) return pool;
  pool = [];
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return pool;
  const count = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
  for (let i = 0; i < count; i++) {
    let worker;
    try {
      worker = new CoverArtWorker();
    } catch {
      break;
    }
    const slot = { worker, jobs: new Map() };
    worker.onmessage = ({ data }) => {
      const job = slot.jobs.get(data.id);
      if (!job) return;
      slot.jobs.delete(data.id);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve({ blob: data.blob, accent: data.accent });
    };
    // A worker that fails to load or crashes leaves the pool; its jobs fall
    // back to the main thread through draw()'s catch.
    worker.onerror = (event) => {
      event.preventDefault?.();
      pool.splice(pool.indexOf(slot), 1);
      for (const job of slot.jobs.values()) job.reject(new Error("Cover art worker failed."));
      slot.jobs.clear();
      worker.terminate();
    };
    pool.push(slot);
  }
  return pool;
}

function drawInWorker(slots, seed) {
  const slot = slots.reduce((a, b) => (b.jobs.size < a.jobs.size ? b : a));
  const id = nextJobId++;
  return new Promise((resolve, reject) => {
    slot.jobs.set(id, { resolve, reject });
    slot.worker.postMessage({ id, seed, size: COVER_ART_SIZE });
  });
}

// --- Main-thread fallback ------------------------------------------------

const queue = [];

function drawOnMainThread(seed) {
  return new Promise((resolve, reject) => {
    queue.push({ seed, resolve, reject });
    if (queue.length === 1) requestAnimationFrame(pump);
  });
}

function pump() {
  const job = queue.shift();
  if (job) {
    try {
      const { canvas, accent } = renderCoverArt(job.seed, COVER_ART_SIZE);
      canvasToBlob(canvas).then((blob) => job.resolve({ blob, accent }), job.reject);
    } catch (err) {
      job.reject(err);
    }
  }
  if (queue.length) requestAnimationFrame(pump);
}

function canvasToBlob(canvas) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: "image/webp", quality: 0.92 });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Cover art encode failed."))), "image/webp", 0.92);
  });
}

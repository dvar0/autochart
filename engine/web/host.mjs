// The browser engine's runtime host (see engine/lib/onnx/runtime.mjs):
// onnxruntime-web with WebGPU when the browser has a usable adapter, else the
// multithreaded WebAssembly CPU backend. Graphs load from the model folder's
// URL (manifest.baseUrl). Same latch as the desktop: once WebGPU fails, the
// rest of the run stays on CPU.

import * as ort from "onnxruntime-web/webgpu";
import { installHost } from "../lib/onnx/runtime.mjs";
import { graphEntry } from "../lib/onnx/manifest.mjs";
import { parseNpz } from "../lib/onnx/prefixTables.mjs";

let webgpuState = null; // null = not probed, "ok" | "unavailable"
let fallbackCallback = null;
const sessions = new Map();

function normalizeDevice(value) {
  const dev = String(value || "auto").trim().toLowerCase();
  return dev === "cpu" || dev === "wasm" ? "cpu" : dev === "webgpu" || dev === "gpu" ? "webgpu" : "auto";
}

async function probeWebgpu() {
  if (webgpuState) return webgpuState === "ok";
  let ok = false;
  try {
    const adapter = globalThis.navigator?.gpu ? await navigator.gpu.requestAdapter() : null;
    ok = Boolean(adapter) && !adapter.info?.isFallbackAdapter && !adapter.isFallbackAdapter;
  } catch {
    ok = false;
  }
  webgpuState = ok ? "ok" : "unavailable";
  return ok;
}

// How long the page waits to read a few bytes back from the GPU. The decoder
// reads its logits back once per token, so a browser that only notices
// finished GPU work on a timer (Firefox: about every 100 ms) decodes far
// faster on the CPU. Median of a few round trips; null without WebGPU.
async function measureReadbackMs() {
  if (!(await probeWebgpu())) return null;
  let device = null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    device = await adapter.requestDevice();
    const usage = globalThis.GPUBufferUsage;
    const src = device.createBuffer({ size: 256, usage: usage.COPY_SRC | usage.COPY_DST });
    const dst = device.createBuffer({ size: 256, usage: usage.MAP_READ | usage.COPY_DST });
    const times = [];
    for (let i = 0; i < 5; i += 1) {
      const t0 = performance.now();
      device.queue.writeBuffer(src, 0, new Float32Array(64));
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(src, 0, dst, 0, 256);
      device.queue.submit([encoder.finish()]);
      await dst.mapAsync(globalThis.GPUMapMode.READ);
      dst.unmap();
      times.push(performance.now() - t0);
    }
    return times.sort((a, b) => a - b)[2];
  } catch {
    return null;
  } finally {
    try { device?.destroy(); } catch { /* ignore */ }
  }
}

async function resolveDevice(requested) {
  const dev = normalizeDevice(requested);
  if (dev === "cpu") return "cpu";
  return (await probeWebgpu()) ? "webgpu" : "cpu";
}

function latchCpu(reason, log) {
  if (webgpuState === "unavailable") return;
  webgpuState = "unavailable";
  if (log) log(`[webHost] WebGPU session failed (${reason}); using CPU for the rest of this run`);
  if (fallbackCallback) fallbackCallback({ from: "webgpu", reason });
}

function providers(device) {
  return device === "webgpu" ? ["webgpu"] : ["wasm"];
}

async function createSession(source, options = {}) {
  const device = await resolveDevice(options.device);
  const key = `${source}|${device}|${JSON.stringify(options.preferredOutputLocation || {})}`;
  if (sessions.has(key)) return sessions.get(key);
  const sessionOptions = {
    executionProviders: providers(device),
    graphOptimizationLevel: options.graphOptimizationLevel || "all",
  };
  if (device === "webgpu" && options.preferredOutputLocation) {
    sessionOptions.preferredOutputLocation = options.preferredOutputLocation;
  }
  let session;
  try {
    session = await ort.InferenceSession.create(source, sessionOptions);
    session.__resolvedDevice = device;
  } catch (err) {
    if (device !== "webgpu") throw err;
    latchCpu(String(err?.message || err).split("\n")[0], options.log || null);
    return createSession(source, { ...options, device: "cpu" });
  }
  sessions.set(key, session);
  return session;
}

function sessionDevice(session, fallback = null) {
  return session?.__resolvedDevice || fallback;
}

function graphSource(manifest, role) {
  return new URL(graphEntry(manifest, role).file, manifest.baseUrl).href;
}

// Prefix tables ship stored (uncompressed) in the npz, so no inflater is needed.
async function loadTables(manifest, file) {
  const response = await fetch(new URL(file, manifest.baseUrl));
  if (!response.ok) throw new Error(`Couldn't load ${file} (${response.status})`);
  return parseNpz(new Uint8Array(await response.arrayBuffer()));
}

// Frees every loaded model. The browser has far less memory than the desktop,
// so the engine drops each stage's models once the stage is done.
export async function releaseSessions(match = null) {
  for (const [key, session] of [...sessions]) {
    if (match && !match(key)) continue;
    sessions.delete(key);
    try { await session.release(); } catch { /* already gone */ }
  }
}

export function setRuntimeFallbackCallback(fn) {
  fallbackCallback = typeof fn === "function" ? fn : null;
}

export async function installWebHost({ wasmPaths = null, threads = null } = {}) {
  // Node-placement notices ("some nodes were not assigned...") are expected.
  ort.env.logLevel = "error";
  if (wasmPaths) ort.env.wasm.wasmPaths = wasmPaths;
  if (threads) ort.env.wasm.numThreads = threads;
  installHost({
    createSession,
    createRawSession: (source, sessionOptions) => ort.InferenceSession.create(source, sessionOptions),
    tensor: (type, data, dims) => new ort.Tensor(type, data, dims),
    sessionDevice,
    graphSource,
    loadTables,
  });
  return {
    webgpu: await probeWebgpu(),
    readbackMs: await measureReadbackMs(),
    crossOriginIsolated: Boolean(globalThis.crossOriginIsolated),
  };
}

// Above this round trip, decoding on the CPU beats waiting on the GPU every token.
const SLOW_READBACK_MS = 20;

// The transcriber's device: the run's device, except CPU where reading back
// from the GPU is slow. A run asking for "webgpu" explicitly keeps it.
export function transcriberDevice(requested, runtime) {
  const dev = normalizeDevice(requested);
  if (dev !== "auto") return dev;
  return runtime.readbackMs != null && runtime.readbackMs > SLOW_READBACK_MS ? "cpu" : dev;
}

export async function loadManifest(folderUrl) {
  const baseUrl = new URL(folderUrl.endsWith("/") ? folderUrl : `${folderUrl}/`, globalThis.location?.href);
  const response = await fetch(new URL("manifest.json", baseUrl));
  if (!response.ok) throw new Error(`Couldn't load the model manifest (${response.status})`);
  const manifest = await response.json();
  manifest.baseUrl = baseUrl.href;
  return manifest;
}

export { resolveDevice };

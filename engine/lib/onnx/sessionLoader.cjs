"use strict";

// ONNX session loader: EP selection (cpu/webgpu/coreml/cuda/auto), provider probes + runtime latches.
// gpu-buffer preferredOutputLocation is WebGPU-only; CUDA throws BatchOrCopyMLValue if pinned.

const ort = require("onnxruntime-node");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { graphPath } = require("./modelsManifest.cjs");

function defaultThreads() {
  try {
    const observed = (os.availableParallelism && os.availableParallelism()) || (os.cpus().length || 2);
    return Math.max(1, Math.floor(observed / 2));
  } catch {
    return 2;
  }
}

const KNOWN_DEVICES = new Set(["cpu", "webgpu", "coreml", "cuda", "auto"]);

function normalizeDevice(value) {
  const dev = String(value || "cpu").trim().toLowerCase();
  if (dev === "gpu") return "webgpu";
  if (KNOWN_DEVICES.has(dev)) return dev;
  return "cpu";
}

let autoDeviceResolution = null; // cached auto probe: "webgpu" | "cpu"; explicit cuda/cpu/webgpu skip
let windowsGraphicsProbe = null;

function softwareOnlyWindowsAdapters(adapters) {
  if (!Array.isArray(adapters) || adapters.length === 0) return false;
  return adapters.every((adapter) =>
    /^Microsoft (?:Hyper-V Video|Basic (?:Display Adapter|Render Driver)|Remote Display Adapter)$/i.test(
      String(adapter?.Name || "").trim()
    )
  );
}

async function windowsSoftwareGraphicsReason() {
  if (process.platform !== "win32") return "";
  if (!windowsGraphicsProbe) {
    windowsGraphicsProbe = new Promise((resolve) => {
      const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      execFile(powershell, [
        "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_VideoController | Select-Object Name | ConvertTo-Json -Compress",
      ], { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 }, (error, stdout) => {
        // A successful WebGPU session can still be software-rendered. If the
        // inventory fails, do not let the provider probe bypass this safeguard.
        const unavailable = "Windows display-adapter inventory is unavailable; using CPU to avoid software WebGPU.";
        if (error) return resolve(error.killed
          ? "Windows display-adapter inventory timed out; using CPU to avoid software WebGPU."
          : unavailable);
        try {
          const value = JSON.parse(stdout);
          const adapters = Array.isArray(value) ? value : [value];
          if (!adapters.length || adapters.some((adapter) =>
            typeof adapter?.Name !== "string" || !adapter.Name.trim()
          )) return resolve(unavailable);
          resolve(softwareOnlyWindowsAdapters(adapters)
            ? "Windows reports only software display adapters; using CPU instead of software WebGPU."
            : "");
        } catch { resolve(unavailable); }
      });
    });
  }
  return windowsGraphicsProbe;
}

// Latch CPU after any runtime WebGPU failure (e.g. ELECTRON_RUN_AS_NODE / no adapter).
let webgpuRuntimeUnavailable = false;
// CUDA is optional too: hardware discovery can find a GPU while ORT cannot
// load its provider or matching cuDNN. Keep the rest of that job on CPU.
let cudaRuntimeUnavailable = false;
let coremlRuntimeUnavailable = false;

// One-time structured signal for the engine entry to emit as a runtime_fallback
// event when a GPU EP first fails and the job latches to CPU. Registered once
// per process (per job) via setRuntimeFallbackCallback; fires at most once.
let runtimeFallbackCallback = null;
let runtimeFallbackEmitted = false;

function setRuntimeFallbackCallback(fn) {
  runtimeFallbackCallback = typeof fn === "function" ? fn : null;
}

function resetAutoDeviceResolution() {
  autoDeviceResolution = null;
  windowsGraphicsProbe = null;
  webgpuRuntimeUnavailable = false;
  cudaRuntimeUnavailable = false;
  coremlRuntimeUnavailable = false;
  runtimeFallbackEmitted = false;
}

function getAutoDeviceResolution() {
  return autoDeviceResolution;
}

function sessionDevice(session, fallback = null) {
  const explicit = normalizeDevice(session?.__resolvedDevice);
  if (session?.__resolvedDevice && explicit !== "cpu") return explicit;
  const reported = session?.executionProvider || session?.executionProviders || session?._executionProvider;
  const provider = Array.isArray(reported) ? reported[0] : reported;
  if (provider) return normalizeDevice(provider);
  return session?.__resolvedDevice ? explicit : fallback;
}

// Bundled EP != usable GPU at runtime.
function webgpuBackendBundled() {
  try {
    const backends = ort.listSupportedBackends();
    return Array.isArray(backends) && backends.some((b) => b && b.name === "webgpu" && b.bundled);
  } catch {
    return false;
  }
}

async function probeWebgpuAvailable(probeGraphPath, { log = null } = {}) {
  if (!probeGraphPath) {
    return false;
  }
  if (process.env.ELECTRON_RUN_AS_NODE === "1") {
    if (log) log(`[sessionLoader] WebGPU is disabled under ELECTRON_RUN_AS_NODE`);
    return false;
  }
  if (!webgpuBackendBundled()) {
    if (log) log(`[sessionLoader] WebGPU backend not bundled`);
    return false;
  }
  const softwareReason = await windowsSoftwareGraphicsReason();
  if (softwareReason) {
    if (log) log(`[sessionLoader] ${softwareReason}`);
    return false;
  }
  try {
    const probe = await ort.InferenceSession.create(probeGraphPath, {
      executionProviders: ["webgpu"],
      graphOptimizationLevel: "all",
    });
    const actualDevice = sessionDevice(probe, "webgpu");
    if (actualDevice !== "webgpu") {
      if (log) log(`[sessionLoader] WebGPU probe initialized ${actualDevice || "an unknown provider"}`);
      if (typeof probe.dispose === "function") {
        try { probe.dispose(); } catch { /* ignore */ }
      }
      return false;
    }
    if (typeof probe.dispose === "function") {
      try { probe.dispose(); } catch { /* ignore */ }
    }
    if (log) log(`[sessionLoader] WebGPU probe succeeded`);
    return true;
  } catch (err) {
    if (log) log(`[sessionLoader] WebGPU probe failed (${err && err.message ? err.message : err})`);
    return false;
  }
}

async function probeWebgpu(probeGraphPath, { log = null } = {}) {
  if (autoDeviceResolution) return autoDeviceResolution;
  const available = await probeWebgpuAvailable(probeGraphPath, { log: null });
  autoDeviceResolution = available ? "webgpu" : "cpu";
  if (log) log(`[sessionLoader] WebGPU probe ${available ? "succeeded; auto -> webgpu" : "failed; auto -> cpu"}`);
  return autoDeviceResolution;
}

async function resolveDevice(requested, probeGraphPath, opts = {}) {
  const dev = normalizeDevice(requested);
  if (process.env.ELECTRON_RUN_AS_NODE === "1" && dev !== "cpu") return "cpu";
  if (webgpuRuntimeUnavailable) return "cpu";
  if (dev === "cuda" && cudaRuntimeUnavailable) return "cpu";
  if (dev === "coreml" && coremlRuntimeUnavailable) return "cpu";
  if (dev === "webgpu" || dev === "auto") {
    const softwareReason = await windowsSoftwareGraphicsReason();
    if (softwareReason) {
      latchRuntimeFallback("webgpu", softwareReason, opts.log || null);
      return "cpu";
    }
  }
  if (dev === "cpu" || dev === "webgpu" || dev === "coreml" || dev === "cuda") return dev;
  return probeWebgpu(probeGraphPath, opts);
}

const sessionCache = new Map();

function cacheKey(onnxPath, resolvedDevice, preferredOutputLocation) {
  return `${onnxPath}|${resolvedDevice}|${JSON.stringify(preferredOutputLocation || {})}`;
}
function isAcceleratedDevice(device) {
  return device === "webgpu" || device === "coreml" || device === "cuda";
}

function latchRuntimeFallback(device, reason, log) {
  if (device === "webgpu") {
    webgpuRuntimeUnavailable = true;
    autoDeviceResolution = "cpu";
  } else if (device === "cuda") {
    cudaRuntimeUnavailable = true;
  } else if (device === "coreml") {
    coremlRuntimeUnavailable = true;
  }
  if (log) {
    const labels = { cuda: "CUDA", coreml: "Core ML", webgpu: "WebGPU" };
    log(`[sessionLoader] ${labels[device]} session failed (${reason}); falling back to CPU for the rest of this run`);
  }
  if (!runtimeFallbackEmitted) {
    runtimeFallbackEmitted = true;
    if (runtimeFallbackCallback) runtimeFallbackCallback({ from: device, reason });
  }
}

async function createSession(onnxPath, options = {}) {
  const requestedDevice = normalizeDevice(options.device);
  const resolvedDevice = await resolveDevice(requestedDevice, onnxPath, { log: options.log || null });
  const key = cacheKey(onnxPath, resolvedDevice, options.preferredOutputLocation);
  const cached = sessionCache.get(key);
  if (cached) return cached;

  const sessionOptions = {
    executionProviders: [resolvedDevice],
    graphOptimizationLevel: options.graphOptimizationLevel || "all",
  };
  if (resolvedDevice === "webgpu" && options.preferredOutputLocation) {
    sessionOptions.preferredOutputLocation = options.preferredOutputLocation;
  }
  let session;
  try {
    session = await ort.InferenceSession.create(onnxPath, sessionOptions);
  } catch (err) {
    if (isAcceleratedDevice(resolvedDevice)) {
      const reason = err && err.message ? String(err.message).split("\n")[0] : String(err);
      latchRuntimeFallback(resolvedDevice, reason, options.log || null);
      const cpuKey = cacheKey(onnxPath, "cpu", options.preferredOutputLocation);
      const cachedCpu = sessionCache.get(cpuKey);
      if (cachedCpu) return cachedCpu;
      const cpuOptions = { ...sessionOptions, executionProviders: ["cpu"] };
      session = await ort.InferenceSession.create(onnxPath, cpuOptions);
      sessionCache.set(cpuKey, session);
      try { session.__resolvedDevice = "cpu"; } catch { /* ignore */ }
      return session;
    }
    throw err;
  }
  const actualDevice = sessionDevice(session, resolvedDevice);
  if (isAcceleratedDevice(resolvedDevice) && actualDevice !== resolvedDevice) {
    try { session.dispose?.(); } catch { /* ignore */ }
    latchRuntimeFallback(
      resolvedDevice,
      `session initialized ${actualDevice || "an unknown provider"}`,
      options.log || null
    );
    return createSession(onnxPath, { ...options, device: "cpu" });
  }
  const actualKey = cacheKey(onnxPath, actualDevice, options.preferredOutputLocation);
  sessionCache.set(actualKey, session);
  try {
    session.__resolvedDevice = actualDevice;
  } catch { /* ignore */ }
  return session;
}

async function loadDemucsSessions(manifest, device = "cpu") {
  const opts = { device };
  const analysis = await createSession(graphPath(manifest, "demucs-analysis-stft"), opts);
  const core = await createSession(graphPath(manifest, "demucs-core-network"), opts);
  const synthesis = await createSession(graphPath(manifest, "demucs-synthesis-istft"), opts);
  const devices = [analysis, core, synthesis].map((session) => sessionDevice(session, device));
  return {
    analysis,
    core,
    synthesis,
    device: devices.includes("cpu") ? "cpu" : devices[0] || device,
  };
}

function tensor(type, data, dims) {
  return new ort.Tensor(type, data, dims);
}
async function runSession(session, inputs) {
  return session.run(inputs);
}

function clearSessionCache() {
  sessionCache.clear();
  resetAutoDeviceResolution();
}

module.exports = {
  createSession,
  loadDemucsSessions,
  tensor,
  runSession,
  clearSessionCache,
  normalizeDevice,
  resolveDevice,
  probeWebgpu,
  probeWebgpuAvailable,
  webgpuBackendBundled,
  getAutoDeviceResolution,
  resetAutoDeviceResolution,
  setRuntimeFallbackCallback,
  sessionDevice,
};

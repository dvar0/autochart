import { STATUS_LABELS } from "./humanLabels.js";
import { supportedTarget } from "./supportedTargets.js";

export const HARDWARE_MODES = Object.freeze([
  Object.freeze({ value: "auto", label: "Automatic" }),
  Object.freeze({ value: "webgpu", label: "WebGPU" }),
  Object.freeze({ value: "cuda", label: "CUDA", platforms: ["linux", "win32"] }),
  Object.freeze({ value: "coreml", label: "Core ML", platforms: ["darwin"] }),
  Object.freeze({ value: "cpu", label: "CPU" }),
]);

export function normalizeHardwareMode(value) {
  const mode = String(value || "auto").toLowerCase();
  if (mode === "macos") return "cpu";
  return HARDWARE_MODES.some((item) => item.value === mode) ? mode : "auto";
}

export function hardwareModeForPlatform(value, platform) {
  const mode = normalizeHardwareMode(value);
  const option = HARDWARE_MODES.find((item) => item.value === mode);
  return !option?.platforms || option.platforms.includes(platform) ? mode : "cpu";
}

export function hardwareModesForPlatform(platform) {
  return HARDWARE_MODES.filter((mode) => !mode.platforms || mode.platforms.includes(platform));
}

export function hardwareModeCaveat(mode, platform) {
  const normalized = normalizeHardwareMode(mode);
  if (normalized === "auto") return "Tries WebGPU, then uses CPU if the provider cannot initialize.";
  if (normalized === "webgpu") return "Provider availability is verified when generation starts; CPU is the fallback.";
  if (normalized === "cuda") return "Requires a compatible NVIDIA CUDA and cuDNN installation; CPU is the fallback.";
  if (normalized === "coreml") return platform === "darwin"
    ? "Available on Apple Silicon; CPU is the fallback."
    : "Core ML is available only on macOS Apple Silicon.";
  return "Runs locally on the CPU without an acceleration provider.";
}


export function humanizeStatus(status) {
  const key = String(status || "missing").toLowerCase();
  if (STATUS_LABELS[key]) return STATUS_LABELS[key];
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function humanizeRuntime(value) {
  const runtime = String(value || "").trim().toLowerCase();
  if (!runtime || runtime.startsWith("unsupported-")) return "Unavailable";
  if (runtime === "onnxruntime-node") return "ONNX Runtime";
  if (runtime === "browser-preview") return "Browser preview";
  return humanizeStatus(runtime);
}

export function humanizeSupportLabel(value) {
  return String(value || "").replace(/^supported:\s*/i, "").trim();
}

export function friendlyTarget(source = {}) {
  const target = supportedTarget(source.platform, source.arch);
  if (target) return target.label;
  const platform = source.platformLabel || source.platform || "Unknown OS";
  return `${platform} ${source.arch || "unknown architecture"}`;
}

import { STATUS_LABELS } from "./humanLabels.js";
import { supportedTarget } from "./supportedTargets.js";
import { t } from "../i18n/index.js";

export const HARDWARE_MODES = Object.freeze([
  Object.freeze({ value: "auto", get label() { return t("Automatic"); } }),
  Object.freeze({ value: "webgpu", label: "WebGPU" }),
  Object.freeze({ value: "cuda", label: "CUDA", platforms: ["linux", "win32"] }),
  Object.freeze({ value: "cpu", label: "CPU" }),
]);

export function normalizeHardwareMode(value) {
  const mode = String(value || "auto").toLowerCase();
  if (mode === "macos") return "cpu";
  // Core ML was removed: it ran Demucs on the CPU, far slower than WebGPU.
  if (mode === "coreml") return "webgpu";
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
  if (normalized === "auto") return t("Tries WebGPU, then uses CPU if the provider cannot initialize.");
  if (normalized === "webgpu") return t("Provider availability is verified when generation starts; CPU is the fallback.");
  if (normalized === "cuda") return t("Requires a compatible NVIDIA CUDA and cuDNN installation; CPU is the fallback.");
  return t("Runs locally on the CPU without an acceleration provider.");
}


// Shown words for the statuses in config/human-labels.json.
const STATUS_TEXT = {
  checking: () => t("Checking"),
  ready: () => t("Ready"),
  missing: () => t("Not installed"),
  partial: () => t("Needs repair"),
  corrupt: () => t("Damaged"),
  unsupported: () => t("Unsupported"),
  unverified: () => t("Not yet verified"),
  skipped: () => t("Not required"),
  failed: () => t("Failed"),
};

export function humanizeStatus(status) {
  const key = String(status || "missing").toLowerCase();
  if (STATUS_TEXT[key]) return STATUS_TEXT[key]();
  if (STATUS_LABELS[key]) return STATUS_LABELS[key];
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function humanizeRuntime(value) {
  const runtime = String(value || "").trim().toLowerCase();
  if (!runtime || runtime.startsWith("unsupported-")) return t("Unavailable");
  if (runtime === "onnxruntime-node") return "ONNX Runtime";
  if (runtime === "onnxruntime-web") return "ONNX Runtime Web";
  if (runtime === "browser-preview") return t("Browser preview");
  return humanizeStatus(runtime);
}

export function humanizeSupportLabel(value) {
  return String(value || "").replace(/^supported:\s*/i, "").trim();
}

export function friendlyTarget(source = {}) {
  const target = supportedTarget(source.platform, source.arch);
  if (target) return target.label;
  const platform = source.platformLabel || source.platform || t("Unknown OS");
  return `${platform} ${source.arch || t("unknown architecture")}`;
}

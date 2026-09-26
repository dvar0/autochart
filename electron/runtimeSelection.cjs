const path = require("path");

const CURRENT_PLATFORM = process.platform;
const CURRENT_ARCH = process.arch;
const {
  SUPPORTED_TARGETS,
  assertSupportedTarget: assertSharedSupportedTarget,
  isSupportedTarget: isSharedSupportedTarget,
  platformLabel,
  supportedTarget: sharedSupportedTarget,
  unsupportedTargetMessage: sharedUnsupportedTargetMessage,
} = require("../config/supported-targets.cjs");

function supportedTarget(platform = CURRENT_PLATFORM, arch = CURRENT_ARCH) {
  return sharedSupportedTarget(platform, arch);
}

function isSupportedTarget(platform = CURRENT_PLATFORM, arch = CURRENT_ARCH) {
  return isSharedSupportedTarget(platform, arch);
}

function unsupportedTargetMessage(platform = CURRENT_PLATFORM, arch = CURRENT_ARCH) {
  return sharedUnsupportedTargetMessage(platform, arch);
}

function assertSupportedTarget(platform = CURRENT_PLATFORM, arch = CURRENT_ARCH) {
  return assertSharedSupportedTarget(platform, arch);
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function listValue(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizeRequestedHardwareMode(value) {
  const mode = String(value || "auto").trim().toLowerCase();
  if (mode === "macos") return "cpu";
  return ["auto", "cuda", "cpu", "webgpu", "coreml"].includes(mode) ? mode : "auto";
}

function chooseHardwareMode({
  platform = CURRENT_PLATFORM,
  arch = CURRENT_ARCH,
  requestedMode = "auto",
  nvidia = {},
} = {}) {
  const requested = normalizeRequestedHardwareMode(requestedMode);
  if (!isSupportedTarget(platform, arch)) {
    return { mode: "cpu", fallbackReason: unsupportedTargetMessage(platform, arch) };
  }
  if (requested === "webgpu" || requested === "auto") {
    return { mode: "webgpu", fallbackReason: "" };
  }
  if (requested === "coreml") {
    return platform === "darwin"
      ? { mode: "coreml", fallbackReason: "" }
      : { mode: "cpu", fallbackReason: "Core ML was requested, but it is only available on macOS." };
  }
  if (requested === "cpu") return { mode: "cpu", fallbackReason: "" };
  if (platform === "darwin") {
    return { mode: "cpu", fallbackReason: "CUDA was requested, but macOS uses the CPU runtime." };
  }
  if (nvidia.cudaAvailable) return { mode: "cuda", fallbackReason: "" };
  return {
    mode: "cpu",
    fallbackReason: "CUDA was requested, but an NVIDIA CUDA device was not detected.",
  };
}

function effectiveHardwareMode(settings = {}, platform = CURRENT_PLATFORM, arch = CURRENT_ARCH) {
  if (!isSupportedTarget(platform, arch)) return "cpu";
  const explicit = String(settings.effectiveHardwareMode || settings.selectedHardwareMode || "").trim().toLowerCase();
  if (explicit === "cpu" || explicit === "webgpu") return explicit;
  if (explicit === "cuda") return platform === "darwin" ? "cpu" : "cuda";
  if (explicit === "coreml") return platform === "darwin" ? "coreml" : "cpu";
  return chooseHardwareMode({
    platform,
    arch,
    requestedMode: settings.hardwareMode,
    nvidia: settings.nvidia || {},
  }).mode;
}

function modeLabel(mode) {
  if (mode === "webgpu") return "WebGPU";
  if (mode === "cuda") return "CUDA";
  if (mode === "coreml") return "Core ML";
  return "CPU";
}

function runtimeComponentId(platform = CURRENT_PLATFORM, mode = "cpu", arch = CURRENT_ARCH) {
  // ONNX-only build: onnxruntime-node ships bundled in node_modules, so there
  // is no installable runtime-pack component per platform. Return a stable
  // label the Hardware/Setup UI can display; hardwareProbe still uses this.
  if (platform === "linux" && arch === "x64") return "onnxruntime-node";
  if (platform === "darwin" && arch === "arm64") return "onnxruntime-node";
  if (platform === "win32" && arch === "x64") return "onnxruntime-node";
  return `unsupported-${platform}-${arch}`;
}

function executablePathCandidates(filePath, platform = CURRENT_PLATFORM) {
  const raw = String(filePath || "");
  if (!raw) return [];
  if (platform !== "win32" || path.extname(raw)) return [raw];
  return [`${raw}.exe`, `${raw}.cmd`, `${raw}.bat`, raw];
}

function packHardwareMode(platform = CURRENT_PLATFORM, mode = "") {
  if (platform === "darwin") return "cpu";
  return mode || "";
}

function platformList(item = {}) {
  const platforms = listValue(item.platforms);
  const platform = String(item.platform || "").trim();
  if (platform && !["all", "auto", "local"].includes(platform)) platforms.push(platform);
  return [...new Set(platforms)];
}

function architectureList(item = {}) {
  const architectures = listValue(item.architectures || item.arches);
  const arch = String(item.arch || "").trim();
  if (arch && !["all", "auto"].includes(arch)) architectures.push(arch);
  return [...new Set(architectures)];
}

function supportsPlatform(item = {}, platform = CURRENT_PLATFORM) {
  const platforms = platformList(item);
  return platforms.length === 0 || platforms.includes(platform);
}

function supportsArchitecture(item = {}, arch = CURRENT_ARCH) {
  const architectures = architectureList(item);
  return architectures.length === 0 || architectures.includes(arch);
}

function supportsPlatformAndArchitecture(item = {}, platform = CURRENT_PLATFORM, arch = CURRENT_ARCH) {
  return isSupportedTarget(platform, arch) &&
    supportsPlatform(item, platform) &&
    supportsArchitecture(item, arch);
}

function selectPack(packs, catalog = {}, settings = {}, {
  platform = CURRENT_PLATFORM,
  arch = CURRENT_ARCH,
} = {}) {
  const candidates = (Array.isArray(packs) ? packs : [])
    .filter((pack) => supportsPlatformAndArchitecture(pack, platform, arch));
  if (!candidates.length) return null;

  const mode = packHardwareMode(platform, effectiveHardwareMode(settings, platform, arch));
  const exactStandard = mode ? `standard-${platform}-${mode}` : "";
  const byId = (id) => id ? candidates.find((pack) => pack.id === id) : null;
  const isStandard = (pack) => /^standard-/.test(String(pack?.id || ""));
  const defaultPack = byId(catalog?.defaults?.packId);
  const exact = byId(exactStandard) || candidates.find((pack) => pack.id === `standard-${platform}`);
  const standard = candidates.find(isStandard);

  return exact || defaultPack || standard || candidates[0] || null;
}

module.exports = {
  SUPPORTED_TARGETS,
  architectureList,
  assertSupportedTarget,
  chooseHardwareMode,
  effectiveHardwareMode,
  executablePathCandidates,
  isSupportedTarget,
  modeLabel,
  normalizeRequestedHardwareMode,
  packHardwareMode,
  platformLabel,
  platformList,
  runtimeComponentId,
  selectPack,
  supportedTarget,
  supportsArchitecture,
  supportsPlatform,
  supportsPlatformAndArchitecture,
  unsupportedTargetMessage,
};

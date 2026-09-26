const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const runtimeSelection = require("./runtimeSelection.cjs");

const CURRENT_PLATFORM = process.platform;

function execFileText(command, args = [], timeout = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawnCommand(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, stdout, stderr: stderr || `${command} timed out.` });
    }, timeout);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr || err.message || "" });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

function isWindowsCommandShim(command) {
  if (CURRENT_PLATFORM !== "win32") return false;
  return [".cmd", ".bat"].includes(path.extname(String(command || "")).toLowerCase());
}

function quoteCmdArg(value) {
  return `"${String(value ?? "").replace(/"/g, "^\"").replace(/%/g, "%%")}"`;
}

function spawnCommand(command, args = [], options = {}) {
  if (!isWindowsCommandShim(command)) return spawn(command, args, options);
  const comspec = process.env.ComSpec || "cmd.exe";
  const commandLine = ["call", quoteCmdArg(command), ...args.map(quoteCmdArg)].join(" ");
  return spawn(comspec, ["/d", "/c", commandLine], { ...options, windowsVerbatimArguments: true });
}

async function probeNvidia() {
  const result = await execFileText("nvidia-smi", [
    "--query-gpu=name,memory.total",
    "--format=csv,noheader,nounits",
  ]);
  if (!result.ok || !result.stdout.trim()) {
    return {
      detected: false,
      cudaAvailable: false,
      gpus: [],
      reason: "nvidia-smi did not report an NVIDIA GPU.",
    };
  }

  const gpus = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [name, memoryMb] = line.split(",").map((part) => String(part || "").trim());
      return {
        name,
        vramMb: Number.parseInt(memoryMb, 10) || null,
      };
    })
    .filter((gpu) => gpu.name);

  return {
    detected: gpus.length > 0,
    cudaAvailable: gpus.length > 0,
    gpus,
    reason: gpus.length ? "" : "nvidia-smi did not report an NVIDIA GPU.",
  };
}

function platformSupport(platform, arch, mode) {
  const target = runtimeSelection.supportedTarget(platform, arch);
  if (!target) {
    return {
      supportedPlatform: false,
      supportLabel: runtimeSelection.unsupportedTargetMessage(platform, arch),
    };
  }
  return {
    supportedPlatform: true,
    supportLabel: target.label,
    providerCaveat: mode === "cuda"
      ? "CUDA and cuDNN availability is verified during generation; CPU is the fallback."
      : mode === "coreml"
        ? "Core ML availability is verified during generation; CPU is the fallback."
        : mode === "webgpu"
          ? "WebGPU availability is verified during generation; CPU is the fallback."
          : "CPU does not require an acceleration provider.",
  };
}

async function probeHardware(settings = {}) {
  const cpus = os.cpus() || [];
  const nvidia = await probeNvidia();
  const requestedMode = runtimeSelection.normalizeRequestedHardwareMode(settings.hardwareMode);
  const selected = runtimeSelection.chooseHardwareMode({
    platform: CURRENT_PLATFORM,
    requestedMode,
    arch: process.arch,
    nvidia,
  });
  const runtimePack = runtimeSelection.runtimeComponentId(CURRENT_PLATFORM, selected.mode, process.arch);
  const support = platformSupport(CURRENT_PLATFORM, process.arch, selected.mode);
  return {
    platform: CURRENT_PLATFORM,
    platformLabel: runtimeSelection.platformLabel(CURRENT_PLATFORM),
    arch: process.arch,
    supportedPlatform: support.supportedPlatform,
    supportLabel: support.supportLabel,
    cpu: cpus[0]?.model || "",
    providerCaveat: support.providerCaveat || "",
    cpuCount: cpus.length || os.availableParallelism?.() || null,
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    appleSilicon: CURRENT_PLATFORM === "darwin" && process.arch === "arm64",
    nvidia,
    requestedMode,
    effectiveHardwareMode: selected.mode,
    selectedMode: selected.mode,
    selectedModeLabel: runtimeSelection.modeLabel(selected.mode, CURRENT_PLATFORM),
    providerStatus: support.supportedPlatform ? (selected.mode === "cpu" ? "cpu" : "unverified") : "unsupported",
    providerVerified: support.supportedPlatform && selected.mode === "cpu",
    selectedRuntimePack: runtimePack,
    fallbackReason: selected.fallbackReason,
    // Accelerated providers are not truthful to report as active until a real
    // model session initializes. Generation emits the resolved provider or a
    // runtime_fallback event after this check actually runs.
    smokeTest: {
      status: "skipped",
      message: selected.mode === "cpu"
        ? "CPU mode does not require an acceleration-provider probe."
        : "ONNX execution-provider availability is verified during generation.",
    },
  };
}
module.exports = {
  platformSupport,
  probeHardware,
};

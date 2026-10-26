import { electronHardware, electronModelSetup } from "./runtimeBridge.js";

function hasElectronModelSetup() {
  return Boolean(electronModelSetup()?.isAvailable?.());
}

function hasElectronHardware() {
  return Boolean(electronHardware()?.isAvailable?.());
}

export async function scanModelSetup({ fresh = false } = {}) {
  if (hasElectronModelSetup()) return electronModelSetup().scan({ fresh });
  return {
    schemaVersion: 1,
    scannedAt: Date.now(),
    platform: "browser",
    sourceRoots: [],
    components: [],
    packs: [],
    standardPack: null,
    generatorReadiness: {},
    readyGeneratorIds: [],
    generationReady: false,
    browserOnly: true,
    message: "Checking chart generation files requires the Electron app.",
  };
}

// packId picks one of the catalog's packs; without it the app installs the
// catalog's default pack.
export async function installAssets(packId = "") {
  const bridge = electronModelSetup();
  if (hasElectronModelSetup() && bridge?.install) {
    return bridge.install(packId);
  }
  throw new Error("Downloading the chart generation package requires the Electron app.");
}

// Frees room in the browser version: { packId } removes one family's models,
// { all: true } every model and stored separation.
export async function removeModelDownloads(request) {
  const bridge = electronModelSetup();
  if (hasElectronModelSetup() && bridge?.remove) return bridge.remove(request);
  throw new Error("Removing models is done from the models folder in the desktop app.");
}

export function subscribeModelInstallEvents(callback) {
  const bridge = electronModelSetup();
  if (hasElectronModelSetup() && bridge?.onInstallEvent) {
    return bridge.onInstallEvent(callback);
  }
  return () => {};
}

export async function probeHardware() {
  if (hasElectronHardware()) return electronHardware().probe();
  return {
    platform: "browser",
    platformLabel: "Browser preview",
    arch: "",
    supportedPlatform: false,
    supportLabel: "Chart generation support is checked in the Electron app.",
    cpu: "",
    cpuCount: null,
    totalMemoryMb: null,
    appleSilicon: false,
    nvidia: { detected: false, cudaAvailable: false, gpus: [] },
    requestedMode: "auto",
    selectedMode: "cpu",
    selectedModeLabel: "CPU mode",
    selectedRuntimePack: "browser-preview",
    fallbackReason: "Hardware detection requires the Electron app.",
    smokeTest: {
      status: "skipped",
      message: "Runtime smoke tests require the Electron app.",
    },
  };
}

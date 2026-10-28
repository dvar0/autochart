export function getAutochartBridge() {
  return typeof window !== "undefined" ? window.autochart || null : null;
}

export function electronPlatform() {
  return String(getAutochartBridge()?.platform || "").trim();
}

// The browser version (src/web): the engine runs in the page, not in Electron.
export function isWebApp() {
  return electronPlatform() === "web";
}

export function electronLibrary() {
  return getAutochartBridge()?.library || null;
}

export function electronEngine() {
  return getAutochartBridge()?.engine || null;
}

export function electronSettings() {
  return getAutochartBridge()?.settings || null;
}

export function electronModelSetup() {
  return getAutochartBridge()?.modelSetup || null;
}

export function electronHardware() {
  return getAutochartBridge()?.hardware || null;
}

export function electronFiles() {
  return getAutochartBridge()?.files || null;
}

export function electronWindow() {
  return getAutochartBridge()?.window || null;
}

export function hasElectronLibrary() {
  return Boolean(electronLibrary()?.isAvailable?.());
}

export function hasElectronEngine() {
  return Boolean(electronEngine()?.isAvailable?.());
}

export function hasElectronSettings() {
  return Boolean(electronSettings()?.isAvailable?.());
}

export function hasElectronModelSetup() {
  return Boolean(electronModelSetup()?.isAvailable?.());
}

export function hasElectronHardware() {
  return Boolean(electronHardware()?.isAvailable?.());
}

export function electronUpdates() {
  return getAutochartBridge()?.updates || null;
}

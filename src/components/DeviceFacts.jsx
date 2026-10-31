// What the browser version knows about this device, without promising a
// speed: the browser either reaches the graphics card or it doesn't, and some
// devices report little memory. Shared by the Start page's device pill and the
// Performance card in Settings.
import { msg, rich, t } from "../i18n/index.js";

export function browserName() {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return msg("This browser");
}

// The browser and its major version, e.g. "Firefox 144". Browsers built on
// another one (Zen, Brave…) report as that one.
export function browserLabel() {
  const ua = navigator.userAgent;
  const name = browserName();
  const pattern = { Firefox: /Firefox\/(\d+)/, Edge: /Edg\/(\d+)/, Opera: /OPR\/(\d+)/, Chrome: /Chrome\/(\d+)/, Safari: /Version\/(\d+)/ }[name];
  const version = pattern && ua.match(pattern)?.[1];
  return version ? `${name} ${version}` : name;
}

export const UNCHECKED_DEVICE = {
  checked: false,
  webgpu: false,
  gpuReachable: false,
  gpu: "",
  requestedMode: "auto",
  browser: "",
  memoryGb: null,
  lowMemory: false,
  handheld: false,
};

export function deviceFromProbe(probe) {
  // deviceMemory is Chromium-only and capped at 8, so "low" means under 8.
  const memoryGb = navigator.deviceMemory;
  return {
    checked: true,
    webgpu: probe?.selectedMode === "webgpu",
    gpuReachable: Boolean(probe?.gpu),
    gpu: probe?.gpu || "",
    requestedMode: probe?.requestedMode || "auto",
    browser: browserName(),
    memoryGb: Number.isFinite(memoryGb) ? memoryGb : null,
    lowMemory: Number.isFinite(memoryGb) && memoryGb < 8,
    handheld: Boolean(navigator.userAgentData?.mobile || globalThis.matchMedia?.("(pointer: coarse)").matches),
  };
}

export function memoryText(memoryGb) {
  if (!Number.isFinite(memoryGb)) return t("Not reported by this browser");
  return memoryGb >= 8 ? t("8 GB or more") : t("About {gb} GB", { gb: memoryGb });
}

function gpuText(device) {
  if (!device.gpuReachable) return t("Not reachable from this browser");
  return device.gpu.replace(/\b\w/g, (c) => c.toUpperCase());
}

// A short reading plus what to do about it. Firefox gets its own words: on
// most systems WebGPU is off until it's switched on in about:config, and even
// with it on, Chrome and the desktop app chart faster.
export function deviceFact(device) {
  if (!device.checked) return { tone: "", label: t("Checking…"), note: "" };
  if (!device.gpuReachable) {
    if (device.browser === "Firefox") {
      return {
        tone: "warn",
        label: t("Graphics card off"),
        note: rich("Firefox keeps WebGPU switched off here, so charting runs on the processor and is slow. You can turn it on in <code>about:config</code> by setting <code>dom.webgpu.enabled</code> to true, but Chrome and the desktop app are still faster.", { code: (text) => <code>{text}</code> }),
      };
    }
    if (device.browser === "Safari") {
      return {
        tone: "warn",
        label: t("No graphics card access"),
        note: t("This Safari can't reach your graphics card, so charting runs on the processor and is slow. Updating Safari may fix it; Chrome and the desktop app are faster."),
      };
    }
    return {
      tone: "warn",
      label: t("No graphics card access"),
      note: t("This browser can't reach your graphics card, so charting runs on the processor and is slow. Chrome and the desktop app are much faster."),
    };
  }
  if (device.requestedMode === "cpu") {
    return { tone: "", label: t("Set to processor"), note: t("Charting is set to the processor. Your graphics card is faster.") };
  }
  if (device.lowMemory || device.handheld) {
    return { tone: "warn", label: t("Low memory"), note: t("This device may run out of memory on long songs.") };
  }
  if (device.browser === "Firefox") {
    return {
      tone: "warn",
      label: t("Slower in Firefox"),
      note: t("Firefox reaches your graphics card, but parts of charting run slower here. Chrome and the desktop app are faster."),
    };
  }
  return { tone: "ok", label: t("Graphics card found"), note: t("Charts are made on it, right in this tab. The desktop app is faster still.") };
}

export function DeviceReadout({ device }) {
  const fact = deviceFact(device);
  const runsOn = device.gpuReachable && device.requestedMode !== "cpu" ? t("Graphics card") : t("Processor");
  return (
    <div className="device-readout">
      <dl>
        <dt>{t("Browser")}</dt>
        <dd>{t(device.browser) || "…"}</dd>
        <dt>{t("Graphics card")}</dt>
        <dd>{device.checked ? gpuText(device) : "…"}</dd>
        <dt>{t("Memory")}</dt>
        <dd>{device.checked ? memoryText(device.memoryGb) : "…"}</dd>
        <dt>{t("Charting runs on")}</dt>
        <dd>{device.checked ? runsOn : "…"}</dd>
      </dl>
      {fact.note && <p className={fact.tone === "warn" ? "is-warn" : ""}>{fact.note}</p>}
    </div>
  );
}

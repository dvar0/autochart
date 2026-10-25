// What the browser version knows about this device, without promising a
// speed: the browser either reaches the graphics card or it doesn't, and some
// devices report little memory. Shared by the Start page's device pill and the
// Performance card in Settings.

export function browserName() {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "This browser";
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

function memoryText(memoryGb) {
  if (!Number.isFinite(memoryGb)) return "Not reported by this browser";
  return memoryGb >= 8 ? "8 GB or more" : `About ${memoryGb} GB`;
}

function gpuText(device) {
  if (!device.gpuReachable) return "Not reachable from this browser";
  return device.gpu.replace(/\b\w/g, (c) => c.toUpperCase());
}

// A short reading plus what to do about it. Firefox gets its own words: on
// most systems WebGPU is off until it's switched on in about:config, and even
// with it on, Chrome and the desktop app chart faster.
export function deviceFact(device) {
  if (!device.checked) return { tone: "", label: "Checking…", note: "" };
  if (!device.gpuReachable) {
    if (device.browser === "Firefox") {
      return {
        tone: "warn",
        label: "Graphics card off",
        note: <>Firefox keeps WebGPU switched off here, so charting runs on the processor and is slow. You can turn it on in <code>about:config</code> by setting <code>dom.webgpu.enabled</code> to true, but Chrome and the desktop app are still faster.</>,
      };
    }
    if (device.browser === "Safari") {
      return {
        tone: "warn",
        label: "No graphics card access",
        note: "This Safari can't reach your graphics card, so charting runs on the processor and is slow. Updating Safari may fix it; Chrome and the desktop app are faster.",
      };
    }
    return {
      tone: "warn",
      label: "No graphics card access",
      note: "This browser can't reach your graphics card, so charting runs on the processor and is slow. Chrome and the desktop app are much faster.",
    };
  }
  if (device.requestedMode === "cpu") {
    return { tone: "", label: "Set to processor", note: "Charting is set to the processor. Your graphics card is faster." };
  }
  if (device.lowMemory || device.handheld) {
    return { tone: "warn", label: "Low memory", note: "This device may run out of memory on long songs." };
  }
  if (device.browser === "Firefox") {
    return {
      tone: "warn",
      label: "Slower in Firefox",
      note: "Firefox reaches your graphics card, but parts of charting run slower here. Chrome and the desktop app are faster.",
    };
  }
  return { tone: "ok", label: "Graphics card found", note: "Charts are made on it, right in this tab. The desktop app is faster still." };
}

export function DeviceReadout({ device }) {
  const fact = deviceFact(device);
  const runsOn = device.gpuReachable && device.requestedMode !== "cpu" ? "Graphics card" : "Processor";
  return (
    <div className="device-readout">
      <dl>
        <dt>Browser</dt>
        <dd>{device.browser || "…"}</dd>
        <dt>Graphics card</dt>
        <dd>{device.checked ? gpuText(device) : "…"}</dd>
        <dt>Memory</dt>
        <dd>{device.checked ? memoryText(device.memoryGb) : "…"}</dd>
        <dt>Charting runs on</dt>
        <dd>{device.checked ? runsOn : "…"}</dd>
      </dl>
      {fact.note && <p className={fact.tone === "warn" ? "is-warn" : ""}>{fact.note}</p>}
    </div>
  );
}

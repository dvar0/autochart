// The browser engine runs in a worker so the page stays responsive. Messages:
//   in:  { type: "generate", id, modelUrl, wasmPaths, device, transcriberDevice?, settings, knobNames, metadata, audio }
//   out: { type: "event", id, event } ... then { type: "result", id, result } or { type: "error", id, message }

import { installWebHost, loadManifest, setRuntimeFallbackCallback, transcriberDevice } from "./host.mjs";
import { generateChart } from "./generate.mjs";

function transferablesOf(result) {
  const buffers = [];
  for (const stem of result.stems || []) buffers.push(stem.left.buffer, stem.right.buffer);
  return buffers;
}

self.onmessage = async ({ data }) => {
  if (data?.type !== "generate") return;
  const { id } = data;
  const post = (event) => self.postMessage({ type: "event", id, event });
  try {
    const runtime = await installWebHost({ wasmPaths: data.wasmPaths });
    post({ type: "runtime", ...runtime });
    setRuntimeFallbackCallback((fallback) => post({ type: "runtime_fallback", to: "cpu", ...fallback }));
    const manifest = await loadManifest(data.modelUrl);
    const result = await generateChart({
      manifest,
      audio: data.audio,
      settings: data.settings,
      knobNames: data.knobNames,
      device: data.device,
      transcriberDevice: transcriberDevice(data.transcriberDevice || data.device, runtime),
      metadata: data.metadata,
      onEvent: post,
    });
    self.postMessage({ type: "result", id, result }, transferablesOf(result));
  } catch (err) {
    self.postMessage({ type: "error", id, message: String(err?.stack || err?.message || err) });
  }
};

// The browser engine runs in a worker so the page stays responsive. Messages:
//   in:  { type: "job", id, kind: "generate" | "prepareDemucs" | "inpaint", job, wasmPaths }
//        { type: "generate", id, modelUrl, wasmPaths, device, transcriberDevice?, settings, knobNames, metadata, audio }
//        (the second is scripts/web-spike's bare pipeline run)
//   out: { type: "event", id, event } ... then { type: "result", id, result } or { type: "error", id, message }
// One job runs at a time; the page cancels a job by terminating the worker.

import {
  installWebHost, loadManifest, setRuntimeFallbackCallback, transcriberDevice, releaseSessions, isWebgpuRunFailure, fallBackToCpu,
} from "./host.mjs";
import { generateChart } from "./generate.mjs";
import { runGenerate, runPrepareDemucs, runInpaint } from "./jobs.mjs";

const JOBS = { generate: runGenerate, prepareDemucs: runPrepareDemucs, inpaint: runInpaint };

let runtimePromise = null;

// A job whose WebGPU run fails starts over on the CPU, like the desktop
// engine's fallback. Stems a finished separation stored are reused.
async function runJob(run, job, post, runtime) {
  try {
    return await run(job, post, runtime);
  } catch (err) {
    if (String(job.device).toLowerCase() === "cpu" || !isWebgpuRunFailure(err)) throw err;
    const reason = String(err?.message || err).split("\n")[0];
    post({ type: "log", stream: "stdout", message: `WebGPU failed in this browser (${reason}). Running again on the CPU.` });
    await releaseSessions();
    fallBackToCpu(reason);
    return run({ ...job, device: "cpu", transcriberDevice: "cpu" }, post, runtime);
  }
}

function transferablesOf(result) {
  const buffers = new Set();
  for (const stem of result.stems || []) buffers.add(stem.left.buffer).add(stem.right.buffer);
  return [...buffers];
}

async function spikeGenerate(data, post, runtime) {
  const manifest = await loadManifest(data.modelUrl);
  return generateChart({
    manifest,
    audio: data.audio,
    settings: data.settings,
    knobNames: data.knobNames,
    device: data.device,
    transcriberDevice: transcriberDevice(data.transcriberDevice || data.device, runtime),
    metadata: data.metadata,
    onEvent: post,
  });
}

// A production build bundles onnxruntime-web into this file, so its CPU
// threads start as copies of this worker named "em-pthread". Those must keep
// ONNX Runtime's own message handler, or no thread starts and the first model
// load waits forever.
const isRuntimeThread = String(self.name || "").startsWith("em-pthread");

if (!isRuntimeThread) self.onmessage = async ({ data }) => {
  if (data?.type !== "job" && data?.type !== "generate") return;
  const { id } = data;
  const post = (event) => self.postMessage({ type: "event", id, event });
  try {
    runtimePromise ??= installWebHost({ wasmPaths: data.wasmPaths });
    const runtime = await runtimePromise;
    post({ type: "runtime", ...runtime });
    setRuntimeFallbackCallback((fallback) => post({ type: "runtime_fallback", to: "cpu", ...fallback }));
    if (data.type === "generate") {
      const result = await spikeGenerate(data, post, runtime);
      self.postMessage({ type: "result", id, result }, transferablesOf(result));
      return;
    }
    const run = JOBS[data.kind];
    if (!run) throw new Error(`Unknown engine job: ${data.kind}`);
    const result = await runJob(run, { ...data.job, jobId: id }, post, runtime);
    self.postMessage({ type: "result", id, result });
  } catch (err) {
    self.postMessage({ type: "error", id, message: String(err?.message || err), code: err?.code || "", stack: String(err?.stack || "") });
  }
};

// The stage modules run on two ONNX Runtimes: onnxruntime-node with model files
// on disk (the desktop engine, sessionLoader.cjs) and onnxruntime-web with
// downloaded models (the browser engine, engine/web/). Each installs a host
// before running a stage; stages reach the runtime only through these calls.
//
// A host provides:
//   createSession(source, { device, preferredOutputLocation, cpuGraph, gpuGraph, log }) -> session
//     (cpuGraph { name, rewrite(bytes) }: a CPU session loads rewrite's graph
//     when it returns one; gpuGraph { name, rewrite(bytes), preferredOutputLocation }
//     the same for a WebGPU session, where the host supports it)
//   createRawSession(source, sessionOptions) -> session, with no device policy
//   tensor(type, data, dims) -> ort.Tensor
//   sessionDevice(session, fallback) -> "cpu" | "webgpu" | ...
//   graphSource(manifest, role) -> what createSession loads for that graph
//   loadTables(manifest, file) -> Map of the npz's arrays (see parseNpz)
// and may provide:
//   hardwareThreads() -> logical CPU count
//   startStftWorkers(count) -> worker adapters (see workerPool.mjs), or null
//     where workers can't start; each runs stftTasks.mjs

let host = null;

export function installHost(next) {
  host = next;
}

function current() {
  if (!host) throw new Error("No ONNX runtime host is installed.");
  return host;
}

export function createSession(source, options = {}) {
  return current().createSession(source, options);
}

export function createRawSession(source, sessionOptions) {
  return current().createRawSession(source, sessionOptions);
}

export function tensor(type, data, dims) {
  return current().tensor(type, data, dims);
}

// fetches (optional): output tensors to write into, by name (null lets the
// session allocate that output).
export function runSession(session, inputs, fetches = null) {
  return fetches ? session.run(inputs, fetches) : session.run(inputs);
}

export function sessionDevice(session, fallback = null) {
  return current().sessionDevice(session, fallback);
}

export function graphPath(manifest, role) {
  return current().graphSource(manifest, role);
}

export function loadTables(manifest, file) {
  return current().loadTables(manifest, file);
}

export function hardwareThreads() {
  const h = current();
  return h.hardwareThreads ? h.hardwareThreads() : 1;
}

// Null when the host has no workers: the caller stays on its own thread.
export function startStftWorkers(count) {
  const h = current();
  if (!h.startStftWorkers || !(count > 0)) return null;
  try {
    return h.startStftWorkers(count) || null;
  } catch {
    return null;
  }
}

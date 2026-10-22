// The stage modules run on two ONNX Runtimes: onnxruntime-node with model files
// on disk (the desktop engine, sessionLoader.cjs) and onnxruntime-web with
// downloaded models (the browser engine, engine/web/). Each installs a host
// before running a stage; stages reach the runtime only through these calls.
//
// A host provides:
//   createSession(source, { device, preferredOutputLocation, log }) -> session
//   createRawSession(source, sessionOptions) -> session, with no device policy
//   tensor(type, data, dims) -> ort.Tensor
//   sessionDevice(session, fallback) -> "cpu" | "webgpu" | ...
//   graphSource(manifest, role) -> what createSession loads for that graph
//   loadTables(manifest, file) -> Map of the npz's arrays (see parseNpz)

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

export function runSession(session, inputs) {
  return session.run(inputs);
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

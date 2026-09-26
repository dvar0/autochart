"use strict";

// The CLI owns one job and one native runtime. After all job files are persisted,
// drain the event pipes before exiting. Natural Node teardown can crash inside
// ONNX Runtime's environment cleanup after a failed WebGPU adapter request.
// This must never be called by a long-lived host or before job finalization.
async function finishProcess(code) {
  try {
    await Promise.all([process.stdout, process.stderr].map((stream) =>
      new Promise((resolve, reject) => stream.write("", (error) => error ? reject(error) : resolve()))
    ));
  } catch {
    code = 1;
  }
  process.exit(code);
}

module.exports = { finishProcess };

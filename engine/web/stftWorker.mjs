// Browser STFT worker, started by host.mjs for separate(). The desktop's is
// engine/lib/onnx/stftWorker.cjs.

import { runStftTask } from "../lib/onnx/stftTasks.mjs";

self.onmessage = ({ data: task }) => {
  try {
    const { result, transfer } = runStftTask(task);
    self.postMessage({ id: task.id, result }, transfer);
  } catch (err) {
    self.postMessage({ id: task.id, error: String(err?.message || err) });
  }
};

"use strict";

// Desktop STFT worker (worker_threads), started by sessionLoader.cjs for
// separate(). The browser's is engine/web/stftWorker.mjs.

const { parentPort } = require("worker_threads");
const { runStftTask } = require("./stftTasks.mjs");

parentPort.on("message", (task) => {
  try {
    const { result, transfer } = runStftTask(task);
    parentPort.postMessage({ id: task.id, result }, transfer);
  } catch (err) {
    parentPort.postMessage({ id: task.id, error: String(err?.message || err) });
  }
});

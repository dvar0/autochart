// Runs tasks on a few workers. Each task goes out as soon as it is queued, to
// the worker with the fewest tasks waiting, so a worker never sits idle while
// the thread that queued its next task is busy (a CPU run in the browser
// blocks that thread for the whole core network).
//
// workers: host adapters { post(message, transfer), listen(onMessage, onError), terminate() }.
// A worker answers each message, in order, with { id, result } or { id, error }.

export function createWorkerPool(workers) {
  const queued = workers.map(() => []);
  let nextId = 0;
  let failure = null;
  let workerFailed = false;

  const failAll = (err) => {
    if (!failure) failure = err instanceof Error ? err : new Error(String(err?.message || err));
    for (const list of queued) {
      for (const entry of list.splice(0)) entry.reject(failure);
    }
  };

  workers.forEach((worker, w) => {
    worker.listen((data) => {
      const list = queued[w];
      const index = list.findIndex((entry) => entry.id === data?.id);
      if (index < 0) return;
      const [entry] = list.splice(index, 1);
      if (data.error) entry.reject(new Error(data.error));
      else entry.resolve(data.result);
    }, (err) => {
      if (!failure) workerFailed = true;
      failAll(new Error(`STFT worker failed: ${err?.message || err}`));
    });
  });

  return {
    size: workers.length,
    // True once a worker failed (not when the pool was closed).
    get failed() {
      return workerFailed;
    },
    run(message, transfer = []) {
      if (failure) return Promise.reject(failure);
      let w = 0;
      for (let i = 1; i < workers.length; i += 1) if (queued[i].length < queued[w].length) w = i;
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        queued[w].push({ id, resolve, reject });
        try {
          workers[w].post({ ...message, id }, transfer);
        } catch (err) {
          failAll(err);
        }
      });
    },
    close() {
      failAll(new Error("STFT workers closed"));
      for (const worker of workers) {
        try { worker.terminate(); } catch { /* already gone */ }
      }
    },
  };
}

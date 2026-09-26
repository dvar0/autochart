const assert = require("assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const libraryStore = require("../electron/libraryStore.cjs");

async function rendererContract(sourcePath) {
  const calls = [];
  const file = {
    name: "selected.ogg",
    type: "audio/ogg",
    size: 17,
    lastModified: 1234,
    sourcePath,
    arrayBuffer() {
      throw new Error("generation must not read the Blob into an ArrayBuffer");
    },
  };
  let tokenIndex = 0;
  global.window = {
    autochart: {
      files: {
        registerGenerationInput: async (value) =>
          value?.sourcePath ? { token: `selected-token-${++tokenIndex}` } : null,
      },
      engine: {
        isAvailable: () => true,
        generateChart: async (payload) => { calls.push(["generate", payload]); return { status: "completed" }; },
        prepareDemucs: async (payload) => { calls.push(["demucs", payload]); return { status: "completed" }; },
      },
    },
  };
  try {
    const serviceUrl = `${pathToFileURL(path.join(__dirname, "..", "src", "services", "generation.js")).href}?path-contract=${Date.now()}`;
    const generation = await import(serviceUrl);
    await generation.generateChart({ audioFile: file, difficulty: "expert" });
    await generation.prepareDemucs({ audioFile: file });
    for (const [operation, payload] of calls) {
      assert.equal(payload.audio.kind, "selected-file", `${operation} omitted capability kind`);
      assert.match(payload.audio.token, /^selected-token-/);
      assert.equal(Object.hasOwn(payload.audio, "path"), false, `${operation} exposed a raw path`);
      assert.equal(Object.hasOwn(payload.audio, "data"), false, `${operation} sent binary audio data`);
    }

    const inMemory = { name: "memory.ogg", type: "audio/ogg", size: 8, arrayBuffer: file.arrayBuffer };
    await assert.rejects(
      generation.generateChart({ audioFile: inMemory, difficulty: "expert" }),
      /exists only in memory/
    );
    const storedResult = await generation.generateChart({
      audioFile: inMemory,
      audioSource: {
        kind: "project-asset",
        projectId: "path-song",
        fileName: "stored.ogg",
        name: "stored.ogg",
        mime: "audio/ogg",
        size: 17,
      },
      difficulty: "expert",
    });
    assert.equal(storedResult.status, "completed");
    const storedPayload = calls.at(-1)[1];
    assert.equal(storedPayload.audio.kind, "project-asset");
    assert.equal(storedPayload.audio.projectId, "path-song");
    assert.equal(Object.hasOwn(storedPayload.audio, "path"), false);
  } finally {
    delete global.window;
  }
}

async function engineContract(root) {
  const projectsFolder = path.join(root, "projects");
  const context = { userDataPath: path.join(root, "user-data"), projectsFolder };
  const saved = await libraryStore.saveSong(context, {
    record: {
      schemaVersion: 2,
      id: "path-song",
      meta: { title: "Path Song", artist: "Harness" },
      settings: {},
      chart: { text: "[Song]\n{\n  Name = Path Song\n}\n" },
      assets: {},
    },
    assets: {
      audio: {
        name: "imported.ogg",
        mime: "audio/ogg",
        data: Buffer.from("path-backed-audio"),
      },
    },
  });
  const source = await libraryStore.getAssetSource(context, saved.id, saved.assets.audio);
  assert.equal(await fs.readFile(source.path, "utf8"), "path-backed-audio");

  const engineRoot = path.join(root, "fake-engine");
  const engineBin = path.join(engineRoot, "fake-engine.cjs");
  await fs.mkdir(engineRoot, { recursive: true });
  await fs.writeFile(
    path.join(engineRoot, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      engineVersion: "path-contract",
      entry: { command: "node", args: ["{engineRoot}/fake-engine.cjs"] },
      generators: [{
        id: "path.generator",
        label: "Path Generator",
        status: "stable",
        platforms: [process.platform],
        architectures: [process.arch],
        capabilities: { difficulties: ["expert"] },
      }],
    })
  );
  await fs.writeFile(
    engineBin,
    `const fs = require("fs");\n` +
    `const path = require("path");\n` +
    `const jobPath = process.argv[process.argv.indexOf("--job") + 1];\n` +
    `const command = process.argv[process.argv.indexOf("--job") - 1];\n` +
    `const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));\n` +
    `const audioBytes = fs.readFileSync(job.audioPath);\n` +
    `if (path.extname(job.audioPath) === ".wav") {\n` +
    `  if (audioBytes.toString("ascii", 0, 4) !== "RIFF" || audioBytes.readUInt16LE(22) !== 2) throw new Error("engine did not receive stereo WAV");\n` +
    `} else if (audioBytes.toString("utf8") !== "path-backed-audio") throw new Error("engine did not read path-backed audio");\n` +
    `const delay = Number(process.env.AUTOCHART_TEST_ENGINE_DELAY_MS || 0);\n` +
    `if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);\n` +
    `const chartPath = process.env.AUTOCHART_TEST_CHART_PATH || path.join(job.outputDir, "notes.chart");\n` +
    `fs.writeFileSync(chartPath, "[Song]\\n{\\n  Name = Path Result\\n}\\n");\n` +
    `if (command === "prepare-demucs") {\n` +
    `  fs.mkdirSync(job.demucsWorkspace, { recursive: true });\n` +
    `  for (const stem of ["drums", "bass", "vocals", "other"]) fs.writeFileSync(path.join(job.demucsWorkspace, stem + ".wav"), "stem");\n` +
    `}\n` +
    `const status = process.env.AUTOCHART_TEST_RESULT_STATUS;\n` +
    `const result = status ? { chartPath, status } : { chartPath };\n` +
    `if (!process.env.AUTOCHART_TEST_OMIT_RESULT) fs.writeFileSync(path.join(job.outputDir, "result.json"), JSON.stringify(result));\n` +
    `if (process.env.AUTOCHART_TEST_ENGINE_STDOUT) {\n` +
    `  console.log(process.env.AUTOCHART_TEST_ENGINE_STDOUT);\n` +
    `  const stdoutDelay = Number(process.env.AUTOCHART_TEST_STDOUT_DELAY_MS || 0);\n` +
    `  if (stdoutDelay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stdoutDelay);\n` +
    `}\n`
  );

  process.env.AUTOCHART_ENGINE_PATH = engineRoot;
  process.env.AUTOCHART_TEST_RESULT_STATUS = "completed";
  const engineManager = require("../electron/engineManager.cjs");
  const senderA = { isDestroyed: () => false, send() {} };
  const senderB = { isDestroyed: () => false, send() {} };
  const cacheFolder = path.join(root, "owned-cache");
  const loadedManifest = await engineManager.loadManifest();
  assert.equal(loadedManifest.generators.some((generator) => generator.id === "path.generator"), true);
  const result = await engineManager.generateChart(
    context.userDataPath,
    senderA,
    {
      generatorId: "path.generator",
      audio: { ...source, mime: "audio/ogg" },
      difficulty: "expert",
      generation: {},
      metadata: { title: "Path Song" },
      hardwareMode: "cpu",
    },
    { settings: { cacheFolder, hardwareMode: "webgpu" } }
  );
  assert.equal(result.status, "completed");
  assert.match(result.chartText, /Path Result/);
  const job = JSON.parse(
    await fs.readFile(path.join(cacheFolder, "jobs", result.jobId, "job.json"), "utf8")
  );
  assert.notEqual(job.audioPath, source.path, "engine skipped its stable cache copy");
  assert.equal(job.hardwareMode, "cpu", "per-job CPU retry ignored saved acceleration preference");
  assert.equal(job.transcriberDevice, "cpu");
  assert.equal(job.demucsDevice, "cpu");
  assert.equal(await fs.readFile(job.audioPath, "utf8"), "path-backed-audio");
  assert.equal(Object.hasOwn(job, "audio"), false);

  const wavPath = path.join(root, "selected.wav");
  const originalWav = await fs.readFile(path.join(__dirname, "..", "fixtures", "demo", "autochart-demo-30s.wav"));
  await fs.writeFile(wavPath, originalWav);
  const wavStat = await fs.stat(wavPath);
  // Both first-copy and cache-hit paths must validate the cached file's identity,
  // then normalize mono WAV without changing the selected source.
  for (const attempt of ["fresh", "cached"]) {
    const wavResult = await engineManager.generateChart(
      context.userDataPath,
      senderA,
      {
        generatorId: "path.generator",
        audio: {
          path: wavPath, name: "selected.wav", mime: "audio/wav",
          device: wavStat.dev, inode: wavStat.ino, size: wavStat.size, lastModified: wavStat.mtimeMs,
        },
        difficulty: "expert",
      },
      { settings: { cacheFolder, hardwareMode: "cpu" } }
    );
    assert.equal(wavResult.status, "completed", `${attempt} WAV generation failed`);
    const wavJob = JSON.parse(await fs.readFile(path.join(cacheFolder, "jobs", wavResult.jobId, "job.json"), "utf8"));
    const normalizedWav = await fs.readFile(wavJob.audioPath);
    assert.notEqual(wavJob.audioPath, wavPath);
    assert.equal(normalizedWav.readUInt16LE(22), 2, `${attempt} WAV was not normalized to stereo`);
    assert.equal(normalizedWav.length, 44 + (originalWav.length - 44) * 2);
    assert.deepEqual(await fs.readFile(wavPath), originalWav, "normalization changed selected audio");
  }
  for (const status of ["failed", "canceled", null]) {
    if (status == null) delete process.env.AUTOCHART_TEST_RESULT_STATUS;
    else process.env.AUTOCHART_TEST_RESULT_STATUS = status;
    await assert.rejects(
      engineManager.generateChart(
        context.userDataPath,
        senderA,
        {
          generatorId: "path.generator",
          audio: { ...source, mime: "audio/ogg" },
          difficulty: "expert",
          generation: {},
          metadata: { title: "Path Song" },
        },
        { settings: { cacheFolder: path.join(root, `status-${status || "missing"}`), hardwareMode: "cpu" } }
      ),
      /Engine generation failed/
    );
  }
  process.env.AUTOCHART_TEST_RESULT_STATUS = "completed";
  process.env.AUTOCHART_TEST_ENGINE_DELAY_MS = "1000";
  const duplicateJobId = "d0d0d0d0d0d0";
  const duplicatePayload = {
    jobId: duplicateJobId,
    generatorId: "path.generator",
    audio: { ...source, mime: "audio/ogg" },
    difficulty: "expert",
    generation: {},
    metadata: { title: "Path Song" },
  };
  const firstDuplicate = engineManager.generateChart(
    context.userDataPath,
    senderA,
    duplicatePayload,
    { settings: { cacheFolder: path.join(root, "duplicate-cache"), hardwareMode: "cpu" } }
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(
    engineManager.generateChart(
      context.userDataPath,
      senderA,
      duplicatePayload,
      { settings: { cacheFolder: path.join(root, "duplicate-cache"), hardwareMode: "cpu" } }
    ),
    /already active/
  );
  assert.equal((await firstDuplicate).status, "completed");
  assert.equal(engineManager.cancelJob(duplicateJobId, senderB).status, "sender-mismatched");
  assert.equal(engineManager.cancelJob(duplicateJobId, senderA).status, "completed");
  await assert.rejects(
    engineManager.generateChart(
      context.userDataPath,
      senderA,
      duplicatePayload,
      { settings: { cacheFolder: path.join(root, "duplicate-cache"), hardwareMode: "cpu" } }
    ),
    /already completed/
  );
  assert.equal(engineManager.cancelJob(duplicateJobId, senderA).status, "completed");
  const staleJobId = "d1d1d1d1d1d1";
  const staleCache = path.join(root, "stale-cache");
  const staleJobDir = path.join(staleCache, "jobs", staleJobId);
  const staleOutputDir = path.join(staleJobDir, "output");
  const staleChartPath = path.join(staleOutputDir, "stale.chart");
  await fs.mkdir(staleOutputDir, { recursive: true });
  await fs.writeFile(path.join(staleJobDir, "job.json"), JSON.stringify({ stale: true }));
  await fs.writeFile(staleChartPath, "[Song]\\n{\\n  Name = stale\\n}\\n");
  await fs.writeFile(
    path.join(staleOutputDir, "result.json"),
    JSON.stringify({ status: "completed", chartPath: staleChartPath })
  );
  process.env.AUTOCHART_TEST_OMIT_RESULT = "1";
  await assert.rejects(
    engineManager.generateChart(
      context.userDataPath,
      senderA,
      { ...duplicatePayload, jobId: staleJobId },
      { settings: { cacheFolder: staleCache, hardwareMode: "cpu" } }
    ),
    /job directory already exists/
  );
  assert.equal(await fs.readFile(path.join(staleOutputDir, "result.json"), "utf8"), JSON.stringify({ status: "completed", chartPath: staleChartPath }));
  delete process.env.AUTOCHART_TEST_OMIT_RESULT;
  const logRaceJobId = "e2e2e2e2e2e2";
  const logRaceCache = path.join(root, "log-race-cache");
  const logRaceOutputDir = path.join(logRaceCache, "jobs", logRaceJobId, "output");
  const logRaceHeldOutputDir = path.join(logRaceCache, "jobs", logRaceJobId, "output-held");
  const logRaceOutside = path.join(root, "log-race-outside");
  await fs.mkdir(logRaceOutside);
  let logRaceSwapPromise = null;
  let logRaceSwapped = false;
  let logRaceSwapError = null;
  let logRaceOriginalIdentity = null;
  const senderLogRace = {
    isDestroyed: () => false,
    send(_channel, event) {
      if (logRaceSwapped || event?.jobId !== logRaceJobId || event?.type !== "log") return;
      logRaceSwapped = true;
      logRaceSwapPromise = (async () => {
        logRaceOriginalIdentity = await fs.lstat(logRaceOutputDir);
        await fs.rename(logRaceOutputDir, logRaceHeldOutputDir);
        await fs.symlink(logRaceOutside, logRaceOutputDir, "dir");
      })().catch((error) => { logRaceSwapError = error; });
    },
  };
  process.env.AUTOCHART_TEST_ENGINE_STDOUT = "log-race";
  process.env.AUTOCHART_TEST_STDOUT_DELAY_MS = "500";
  const logRaceOutcome = await engineManager.generateChart(
    context.userDataPath,
    senderLogRace,
    { ...duplicatePayload, jobId: logRaceJobId },
    { settings: { cacheFolder: logRaceCache, hardwareMode: "cpu" } }
  ).then((result) => ({ result }), (error) => ({ error }));
  await logRaceSwapPromise;
  if (process.platform === "win32" && logRaceSwapError?.syscall === "rename" &&
      ["EPERM", "EACCES", "EBUSY"].includes(logRaceSwapError.code)) {
    // Windows can prevent the attack while the verified log handle is open.
    // Prove the original directory survived and generation completed safely.
    assert.ifError(logRaceOutcome.error);
    assert.equal(logRaceOutcome.result.status, "completed");
    const currentIdentity = await fs.lstat(logRaceOutputDir);
    assert.equal(currentIdentity.isSymbolicLink(), false);
    assert.equal(currentIdentity.dev, logRaceOriginalIdentity.dev);
    assert.equal(currentIdentity.ino, logRaceOriginalIdentity.ino);
    assert.equal(await fs.stat(path.join(logRaceOutputDir, "engine-process.log")).then((s) => s.isFile()), true);
    console.log("path generation: Windows denied the open output-directory swap; original output retained");
  } else {
    assert.ifError(logRaceSwapError);
    assert.match(logRaceOutcome.error?.message || "", /changed|directory/);
    await fs.rm(logRaceOutputDir, { force: true });
    await fs.rename(logRaceHeldOutputDir, logRaceOutputDir);
  }
  assert.deepEqual(await fs.readdir(logRaceOutside), []);
  delete process.env.AUTOCHART_TEST_ENGINE_STDOUT;
  delete process.env.AUTOCHART_TEST_STDOUT_DELAY_MS;
  assert.ok(logRaceSwapPromise, "child stdout must trigger output path swap");

  const cancelJobId = "c0c0c0c0c0c0";
  const cancelPayload = { ...duplicatePayload, jobId: cancelJobId };
  const pendingCancel = engineManager.generateChart(
    context.userDataPath,
    senderA,
    cancelPayload,
    { settings: { cacheFolder: path.join(root, "cancel-cache"), hardwareMode: "cpu" } }
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(engineManager.cancelJob(cancelJobId, senderB).status, "sender-mismatched");
  assert.equal(engineManager.cancelJob(cancelJobId, senderA).status, "canceling");
  assert.equal((await pendingCancel).status, "canceled");
  delete process.env.AUTOCHART_TEST_ENGINE_DELAY_MS;
  const preSpawnJobId = "a0a0a0a0a0a0";
  assert.equal(engineManager.cancelJob(preSpawnJobId, senderA).status, "canceling");
  assert.equal(
    (await engineManager.generateChart(
      context.userDataPath,
      senderA,
      { ...duplicatePayload, jobId: preSpawnJobId },
      { settings: { cacheFolder: path.join(root, "pre-spawn-cache"), hardwareMode: "cpu" } }
    )).status,
    "canceled"
  );
  const preparePendingJobId = "a1a1a1a1a1a1";
  assert.equal(engineManager.cancelJob(preparePendingJobId, senderA).status, "canceling");
  await assert.rejects(
    engineManager.prepareDemucs(
      context.userDataPath,
      senderA,
      { ...duplicatePayload, jobId: preparePendingJobId, separationId: "demucs-pending" },
      { settings: { cacheFolder: path.join(root, "prepare-pending-cache"), hardwareMode: "cpu" } }
    ),
    /canceled/
  );
  const prepared = await engineManager.prepareDemucs(
    context.userDataPath,
    senderA,
    { ...duplicatePayload, jobId: "b1b1b1b1b1b1", separationId: "demucs-ready", name: "Ready" },
    { settings: { cacheFolder: path.join(root, "prepare-ready-cache"), hardwareMode: "cpu" } }
  );
  assert.equal(prepared.status, "completed");
  assert.ok(prepared.stems.drums?.path);
  process.env.AUTOCHART_TEST_ENGINE_DELAY_MS = "1000";
  const prepareDuplicatePayload = {
    ...duplicatePayload,
    jobId: "c2c2c2c2c2c2",
    separationId: "demucs-duplicate",
    name: "Duplicate",
  };
  const firstPrepare = engineManager.prepareDemucs(
    context.userDataPath,
    senderA,
    prepareDuplicatePayload,
    { settings: { cacheFolder: path.join(root, "prepare-duplicate-cache"), hardwareMode: "cpu" } }
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(
    engineManager.prepareDemucs(
      context.userDataPath,
      senderA,
      prepareDuplicatePayload,
      { settings: { cacheFolder: path.join(root, "prepare-duplicate-cache"), hardwareMode: "cpu" } }
    ),
    /already active/
  );
  assert.equal(engineManager.cancelJob(prepareDuplicatePayload.jobId, senderB).status, "sender-mismatched");
  assert.equal(engineManager.cancelJob(prepareDuplicatePayload.jobId, senderA).status, "canceling");
  await assert.rejects(firstPrepare, /canceled/);
  delete process.env.AUTOCHART_TEST_ENGINE_DELAY_MS;
  const outsideChart = path.join(root, "outside-result.chart");
  process.env.AUTOCHART_TEST_CHART_PATH = outsideChart;
  await assert.rejects(
    engineManager.generateChart(
      context.userDataPath,
      senderA,
      { ...duplicatePayload, jobId: "f0f0f0f0f0f0" },
      { settings: { cacheFolder: path.join(root, "outside-result-cache"), hardwareMode: "cpu" } }
    ),
    /outside the job output directory|no readable chart/
  );
  assert.equal(await fs.readFile(outsideChart, "utf8"), "[Song]\n{\n  Name = Path Result\n}\n");
  delete process.env.AUTOCHART_TEST_CHART_PATH;
  const symlinkCache = path.join(root, "job-symlink-cache");
  const symlinkOutside = path.join(root, "job-symlink-outside");
  await fs.mkdir(symlinkCache);
  await fs.mkdir(symlinkOutside);
  await fs.symlink(symlinkOutside, path.join(symlinkCache, "jobs"), "dir");
  await assert.rejects(
    engineManager.generateChart(
      context.userDataPath,
      senderA,
      { ...duplicatePayload, jobId: "e0e0e0e0e0e0" },
      { settings: { cacheFolder: symlinkCache, hardwareMode: "cpu" } }
    ),
    /link or .*directory|Safety root/
  );
  assert.deepEqual(await fs.readdir(symlinkOutside), []);
}

async function main() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "autochart-path-generation-")));
  const previousEngine = process.env.AUTOCHART_ENGINE_PATH;
  try {
    const selectedPath = path.join(root, "selected.ogg");
    await fs.writeFile(selectedPath, "path-backed-audio");
    await rendererContract(selectedPath);
    await engineContract(root);
    console.log("path generation: renderer sent metadata only for generation and Demucs");
    console.log("path generation: saved project asset was canonicalized, cached, and read by the engine");
  } finally {
    if (previousEngine == null) delete process.env.AUTOCHART_ENGINE_PATH;
    else process.env.AUTOCHART_ENGINE_PATH = previousEngine;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

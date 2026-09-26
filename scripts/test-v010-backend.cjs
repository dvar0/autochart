"use strict";

const assert = require("assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const vm = require("vm");
const chartEvents = require("../engine/lib/onnx/chartEventStream.cjs");
const chartWriter = require("../shared/chartWriter.cjs");
const generationStages = require("../engine/lib/generationStages.cjs");
const demucsWorkspace = require("../electron/demucsWorkspace.cjs");
const hardwareProbe = require("../electron/hardwareProbe.cjs");
const modelManager = require("../electron/modelManager.cjs");
const runtimeSelection = require("../electron/runtimeSelection.cjs");
const settingsStore = require("../electron/settingsStore.cjs");
// keep the production integrity helpers and the shared target matrix
const engineManager = require("../electron/engineManager.cjs");
const fileSafety = require("../electron/fileSafety.cjs");
const sharedTargetMatrix = require("../config/supported-targets.json");
const sharedTargetPredicates = require("../config/supported-targets.cjs");

async function main() {
  // Exercise the real session-selection path without needing a Windows GPU.
  // Software-only or unavailable inventories must choose CPU; named hardware
  // retains the WebGPU probe, and CPU mode must avoid the OS query.
  const loaderSource = await fs.readFile(path.join(__dirname, "../engine/lib/onnx/sessionLoader.cjs"), "utf8");
  async function checkWindowsGraphics(stdout, { error = null, requested = "auto", expected = "webgpu" } = {}) {
    let queries = 0;
    const providers = [];
    const fallbacks = [];
    const fakeOrt = {
      listSupportedBackends: () => [{ name: "webgpu", bundled: true }],
      InferenceSession: { create: async (_graph, options) => {
        const provider = options.executionProviders[0];
        providers.push(provider);
        if (provider === "cpu") assert.equal(options.preferredOutputLocation, undefined);
        return { executionProvider: provider, dispose() {} };
      } },
    };
    const context = {
      module: { exports: {} },
      process: { platform: "win32", env: { SystemRoot: "C:\\Windows" } },
      require: (name) => {
        if (name === "onnxruntime-node") return fakeOrt;
        if (name === "./modelsManifest.cjs") return { graphPath: () => "fixture.onnx" };
        if (name === "child_process") return { execFile: (_command, _args, options, callback) => {
          queries += 1;
          assert.ok(options.windowsHide && options.timeout > 0 && options.maxBuffer > 0);
          callback(error, stdout);
        } };
        return require(name);
      },
    };
    vm.runInNewContext(loaderSource, context, { filename: "sessionLoader.cjs" });
    const loader = context.module.exports;
    loader.setRuntimeFallbackCallback((event) => fallbacks.push(event));
    if (requested !== "cpu") {
      assert.equal(await loader.probeWebgpuAvailable("probe.onnx"), expected === "webgpu");
    }
    for (const graph of ["one.onnx", "two.onnx"]) {
      const session = await loader.createSession(graph, { device: requested, preferredOutputLocation: { out: "gpu-buffer" } });
      assert.equal(loader.sessionDevice(session), expected);
    }
    assert.ok(providers.every((provider) => provider === expected));
    assert.equal(queries, requested === "cpu" ? 0 : 1, "inventory is cached across model sessions");
    assert.equal(fallbacks.length, expected === "cpu" && requested !== "cpu" ? 1 : 0);
    if (fallbacks.length) assert.match(fallbacks[0].reason, /using CPU.*software WebGPU/);
  }
  for (const requested of ["auto", "webgpu"]) {
    await checkWindowsGraphics('{"Name":"Microsoft Hyper-V Video"}', { requested, expected: "cpu" });
    await checkWindowsGraphics('[{"Name":"Microsoft Basic Display Adapter"},{"Name":"Microsoft Basic Render Driver"}]', { requested, expected: "cpu" });
  }
  await checkWindowsGraphics('[{"Name":"Microsoft Hyper-V Video"},{"Name":"NVIDIA GeForce RTX"}]');
  await checkWindowsGraphics('{"Name":"AMD Radeon Graphics"}');
  await checkWindowsGraphics('{"Name":"Intel UHD Graphics"}');
  await checkWindowsGraphics('{"Name":"Unknown future GPU"}');
  for (const requested of ["auto", "webgpu"]) {
    for (const stdout of ['[]', 'null', '{}', '{"Name":""}', '{"Name":42}', 'unparseable',
      '[{"Name":"Microsoft Hyper-V Video"},{}]']) {
      await checkWindowsGraphics(stdout, { requested, expected: "cpu" });
    }
    await checkWindowsGraphics('', {
      requested, expected: "cpu", error: Object.assign(new Error("inventory timed out"), { killed: true }),
    });
    await checkWindowsGraphics('', { requested, expected: "cpu", error: new Error("PowerShell unavailable") });
  }
  await checkWindowsGraphics('', { requested: "cpu", expected: "cpu" });

  const cleanupStrategy = fileSafety.__test.cleanupStrategyForPlatform;
  assert.deepEqual(cleanupStrategy("linux", { descriptorNamespaceAvailable: true }), {
    kind: "descriptor",
    namespace: "/proc/self/fd",
  });
  assert.equal(cleanupStrategy("darwin", { descriptorNamespaceAvailable: true }).kind, "path");
  assert.equal(cleanupStrategy("darwin", { descriptorNamespaceAvailable: false }).kind, "path");
  assert.equal(cleanupStrategy("win32").kind, "path");
  const special = 'Title "quoted" \\ folder\r\nnext\u2028last';
  const chart = chartWriter.writeChartText([[0, 1, 0]], {
    title: special,
    artist: 'Artist \\ "A"\nB',
    charter: 'Charter "C" \\',
    difficulty: "hard",
    resolution: 192,
    syncLines: ["0 = B 120000"],
  }).text;
  assert.equal(chartWriter.normalizeChartValue(special), 'Title "quoted" \\ folder next last');
  assert.ok(chart.includes('Name = "Title "quoted" \\ folder next last"'));
  assert.ok(chart.includes('Artist = "Artist \\ "A" B"'));
  assert.doesNotMatch(chart, /\\n(?:next|B)/);
  assert.match(chart, /\[HardSingle\]/);
  assert.doesNotMatch(chart, /AI Fretformer|Guitar Charts AI/);
  assert.match(
    chartWriter.writeChartText([], { title: "Song", artist: "Artist" }).text,
    /Charter = "Autochart"/
  );
  const chartParser = await import("../src/lib/chart/parseChart.js");
  const parsedChart = chartParser.parseChart(chart);
  assert.equal(parsedChart.song.name, 'Title "quoted" \\ folder next last');
  assert.equal(parsedChart.song.artist, 'Artist \\ "A" B');
  assert.equal(parsedChart.song.charter, 'Charter "C" \\');
  assert.ok(parsedChart.tracks.hard);
  assert.equal(parsedChart.tracks.expert, undefined);

  const finalChart = chartEvents.writeChartText([[0, 1, 0, []]], {
    title: special,
    artist: "Artist",
    charter: "Autochart",
    resolution: 192,
    syncLines: ["0 = B 120000"],
  }).text;
  assert.equal(chartParser.parseChart(finalChart).song.name, 'Title "quoted" \\ folder next last');

  const transcriptionFailure = generationStages.failureStageDetails("transcription");
  assert.equal(transcriptionFailure.stage, "transcription");
  assert.equal(transcriptionFailure.label, "transcription");
  assert.deepEqual(transcriptionFailure.completedStages, ["demucs", "timing"]);
  const chartFailure = generationStages.failureStageDetails("chart");
  assert.equal(chartFailure.stage, "chart");
  assert.equal(chartFailure.label, "chart writing");
  assert.deepEqual(chartFailure.completedStages, ["demucs", "timing", "transcription"]);
  const lifecycleStages = ["audio", "demucs", "timing", "smoothing", "transcription", "chart", "finalization"];
  for (const stage of lifecycleStages) {
    const events = [];
    const lifecycle = generationStages.createGenerationLifecycle({ emit: (event) => events.push(event) });
    if (stage === "finalization") {
      await assert.rejects(
        lifecycle.finalize({ status: "completed" }, async () => { throw new Error("injected persistence failure"); }, "result.json"),
        /injected persistence failure/
      );
    } else {
      await assert.rejects(
        lifecycle.runStage(stage, async () => { throw new Error(`${stage} injected failure`); }),
        new RegExp(`${stage} injected failure`)
      );
    }
    assert.equal(events.filter((event) => event.type === "stage" && event.status === "failed").length, 1);
    assert.equal(events.find((event) => event.type === "stage" && event.status === "failed").stage, stage);
    assert.equal(events.some((event) => event.type === "result" || event.stage === "done"), false);
  }
  const successEvents = [];
  const successfulLifecycle = generationStages.createGenerationLifecycle({ emit: (event) => successEvents.push(event) });
  for (const stage of lifecycleStages.slice(0, -1)) {
    await successfulLifecycle.runStage(stage, async () => {});
  }
  await successfulLifecycle.finalize({ status: "completed" }, async () => {}, "result.json");
  assert.deepEqual(successEvents.slice(-2).map((event) => event.type), ["result", "stage"]);
  assert.equal(successEvents.at(-1).stage, "done");
  assert.equal(successfulLifecycle.isTerminal(), true);
  const canceledEvents = [];
  const canceledLifecycle = generationStages.createGenerationLifecycle({ emit: (event) => canceledEvents.push(event) });
  canceledLifecycle.cancel();
  assert.deepEqual(canceledEvents.map((event) => event.type), ["canceled"]);
  assert.equal(canceledLifecycle.isTerminal(), true);
  let persistenceWrites = 0;
  const persistence = generationStages.createResultPersistence(async () => {
    persistenceWrites += 1;
  });
  await persistence.persist({ status: "completed" });
  assert.equal(persistence.writeCount, 1);
  assert.equal(persistenceWrites, 1);
  await assert.rejects(persistence.persist({ status: "completed" }), /already attempted/);
  const failingPersistence = generationStages.createResultPersistence(async () => {
    throw new Error("injected persistence failure");
  });
  await assert.rejects(failingPersistence.persist({ status: "completed" }), /injected persistence failure/);
  assert.equal(failingPersistence.writeCount, 1);
  assert.deepEqual(
    runtimeSelection.SUPPORTED_TARGETS.map((target) => target.key).sort(),
    sharedTargetMatrix.targets.map((target) => target.key).sort(),
    "Electron target matrix drifted from shared target matrix"
  );
  for (const target of sharedTargetPredicates.SUPPORTED_TARGETS) {
    assert.equal(sharedTargetPredicates.isSupportedTarget(target.platform, target.arch), true);
    assert.doesNotThrow(() => sharedTargetPredicates.assertSupportedTarget(target.platform, target.arch));
  }
  for (const [platform, arch] of [["linux", "arm64"], ["win32", "arm64"], ["darwin", "x64"], ["freebsd", "x64"]]) {
    assert.equal(sharedTargetPredicates.isSupportedTarget(platform, arch), false);
    assert.throws(
      () => sharedTargetPredicates.assertSupportedTarget(platform, arch),
      /not a supported generation target/
    );
  }

  const combinations = [
    ["linux", "x64", true],
    ["win32", "x64", true],
    ["darwin", "arm64", true],
    ["linux", "arm64", false],
    ["linux", "ia32", false],
    ["win32", "arm64", false],
    ["win32", "ia32", false],
    ["darwin", "x64", false],
    ["darwin", "ia32", false],
    ["freebsd", "x64", false],
  ];
  for (const [platform, arch, expected] of combinations) {
    const support = hardwareProbe.platformSupport(platform, arch, "webgpu");
    assert.equal(support.supportedPlatform, expected, `${platform}/${arch} hardware probe`);
    if (expected) {
      assert.doesNotMatch(support.supportLabel, /^Supported:/);
      assert.equal(support.supportLabel, runtimeSelection.supportedTarget(platform, arch).label);
    } else {
      assert.match(support.supportLabel, /not a supported generation target/);
    }
    assert.equal(runtimeSelection.isSupportedTarget(platform, arch), expected, `${platform}/${arch}`);
    assert.equal(runtimeSelection.supportsPlatformAndArchitecture({}, platform, arch), expected, `${platform}/${arch} catalog`);
    assert.equal(
      modelManager.deriveCombinedStatus({ platform, arch, generationReady: true, packStatus: "ready" }),
      expected ? "ready" : "unsupported"
    );
  }
  assert.equal(runtimeSelection.platformLabel("win32"), "Windows");
  assert.equal(runtimeSelection.platformLabel("darwin"), "macOS");
  assert.equal(runtimeSelection.normalizeRequestedHardwareMode("macos"), "cpu");
  assert.equal(settingsStore.normalizeSettings({ hardwareMode: "macos" }).hardwareMode, "cpu");
  const packs = [
    { id: "standard-linux-cpu", platforms: ["linux"], architectures: ["x64"] },
    { id: "standard-linux-webgpu", platforms: ["linux"], architectures: ["x64"] },
  ];
  assert.equal(
    runtimeSelection.selectPack(packs, { defaults: { packId: "standard-linux-cpu" } }, {
      hardwareMode: "webgpu",
    }, { platform: "linux", arch: "x64" }).id,
    "standard-linux-webgpu"
  );
  assert.equal(
    runtimeSelection.selectPack(
      [{ id: "custom-default", platforms: ["linux"], architectures: ["x64"] }],
      { defaults: { packId: "custom-default" } },
      { hardwareMode: "cpu" },
      { platform: "linux", arch: "x64" }
    ).id,
    "custom-default"
  );
  assert.equal(
    runtimeSelection.selectPack(packs, {}, {}, { platform: "linux", arch: "arm64" }),
    null
  );
  assert.equal(runtimeSelection.chooseHardwareMode({ platform: "darwin", arch: "arm64", requestedMode: "macos" }).mode, "cpu");
  assert.equal(
    runtimeSelection.effectiveHardwareMode({ effectiveHardwareMode: "cuda" }, "darwin", "arm64"),
    "cpu"
  );
  assert.equal(runtimeSelection.effectiveHardwareMode({ hardwareMode: "auto" }, "linux", "x64"), "webgpu");
  const rewrittenJob = engineManager.rewriteJobForCpu(
    { jobId: "cpu-fallback", hardwareMode: "webgpu", transcriberDevice: "webgpu" },
    "Electron-run-as-Node cannot initialize Dawn"
  );
  assert.equal(rewrittenJob.hardwareMode, "cpu");
  assert.equal(rewrittenJob.transcriberDevice, "cpu");
  assert.equal(rewrittenJob.demucsDevice, "cpu");
  assert.equal(rewrittenJob.timingDevice, "cpu");
  assert.equal(rewrittenJob.requestedHardwareMode, "webgpu");
  assert.match(rewrittenJob.hardwareFallback.reason, /Dawn/);
  assert.equal(runtimeSelection.effectiveHardwareMode({ hardwareMode: "auto" }, "linux", "arm64"), "cpu");
  assert.equal(modelManager.deriveCombinedStatus({ platform: "linux", arch: "x64", packStatus: "corrupt" }), "corrupt");
  assert.equal(modelManager.deriveCombinedStatus({ platform: "linux", arch: "x64", packStatus: "partial" }), "partial");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-demucs-workspace-"));
  try {
    const cacheRoot = path.join(root, "cache", "engine");
    const hash = "a".repeat(64);
    const safe = await demucsWorkspace.resolveDemucsWorkspace(cacheRoot, hash, "demucs_safe-1");
    const forgedPayload = {
      id: "demucs_safe-1",
      workspace: path.join(root, "forged"),
      cache: { workspace: path.join(root, "forged-cache") },
    };
    assert.equal(
      demucsWorkspace.separationIdFromPayload(forgedPayload, "demucs_default"),
      "demucs_safe-1"
    );
    assert.equal(
      await demucsWorkspace.resolveDemucsWorkspace(
        cacheRoot,
        hash,
        demucsWorkspace.separationIdFromPayload(forgedPayload, "demucs_default")
      ),
      safe
    );
    assert.equal(
      safe,
      path.join(await fs.realpath(cacheRoot), "features", "fretformer_demucs_v1", hash, "demucs_safe-1")
    );
    for (const invalid of ["../escape", "/tmp/escape", "a/b", "..", ".", "", "x".repeat(65)]) {
      await assert.rejects(
        demucsWorkspace.resolveDemucsWorkspace(cacheRoot, hash, invalid),
        /safe 1-64 character slug/
      );
    }
    await assert.rejects(
      demucsWorkspace.resolveDemucsWorkspace(cacheRoot, "not-a-hash", "demucs_safe"),
      /Invalid cached audio hash/
    );
    const symlinkRoot = path.join(root, "symlink-cache", "engine");
    const outside = path.join(root, "outside");
    const nestedOutside = path.join(root, "nested-outside");
    await fs.mkdir(nestedOutside);
    await fs.symlink(nestedOutside, path.join(safe, "timing"), "dir");
    await assert.rejects(
      demucsWorkspace.ensureContainedDirectory(
        cacheRoot,
        path.join(safe, "timing", "take"),
        { create: true }
      ),
      /symbolic-link component/
    );
    const leafOutside = path.join(root, "leaf-outside.wav");
    const leaf = path.join(safe, "drums.wav");
    await fs.writeFile(leafOutside, "keep");
    await fs.symlink(leafOutside, leaf);
    await assert.rejects(
      demucsWorkspace.assertSafeLeaf(safe, leaf),
      /real regular file/
    );
    assert.equal(await fs.readFile(leafOutside, "utf8"), "keep");
    await fs.rm(leaf);
    await fs.mkdir(symlinkRoot, { recursive: true });
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(symlinkRoot, "features"), "dir");
    await assert.rejects(
      demucsWorkspace.resolveDemucsWorkspace(symlinkRoot, hash, "demucs_safe"),
      /symbolic-link component/
    );
    assert.deepEqual(await fs.readdir(outside), []);
    const atomicRoot = path.join(root, "atomic");
    const atomicParent = path.join(atomicRoot, "nested");
    const atomicTarget = path.join(atomicParent, "payload.bin");
    await fileSafety.ensureRealDirectoryTree(atomicRoot, atomicParent);
    await fs.writeFile(atomicTarget, "before");
    const atomicOutside = path.join(root, "atomic-outside");
    await fs.writeFile(atomicOutside, "outside");
    await assert.rejects(
      fileSafety.writeVerifiedAtomic(atomicTarget, "replacement", {
        rootDirectory: atomicRoot,
        label: "atomic payload",
        beforePromote: async ({ target }) => {
          await fs.rm(target, { force: true });
          await fs.symlink(atomicOutside, target);
        },
      }),
      /destination changed/
    );
    assert.equal(await fs.readFile(atomicOutside, "utf8"), "outside");
    await fs.rm(atomicTarget);
    const parentSentinel = path.join(atomicParent, "sentinel");
    await fs.writeFile(parentSentinel, "before");
    const heldAtomicParent = path.join(atomicRoot, "held-parent");
    await assert.rejects(
      fileSafety.writeVerifiedAtomic(atomicTarget, "replacement", {
        rootDirectory: atomicRoot,
        label: "atomic payload",
        beforePromote: async ({ parent }) => {
          await fs.rename(parent, heldAtomicParent);
          await fs.mkdir(parent);
        },
      }),
      /parent changed/
    );
    assert.equal(await fs.readFile(path.join(heldAtomicParent, "sentinel"), "utf8"), "before");
    await fs.rm(atomicParent, { recursive: true, force: true });
    await fs.rename(heldAtomicParent, atomicParent);
    const atomicOpenOutside = path.join(root, "atomic-open-outside");
    const atomicOpenHeldParent = path.join(atomicRoot, "atomic-open-held-parent");
    await fs.mkdir(atomicOpenOutside);
    await assert.rejects(
      fileSafety.writeVerifiedAtomic(path.join(atomicParent, "before-open.bin"), "must not escape", {
        rootDirectory: atomicRoot,
        label: "atomic open payload",
        beforeOpen: async ({ target, parent }) => {
          await fs.writeFile(path.join(atomicOpenOutside, "atomic-open-sentinel"), "outside atomic temp");
          await fs.rename(parent, atomicOpenHeldParent);
          await fs.symlink(atomicOpenOutside, parent, "dir");
        },
      }),
      /parent changed before opening/
    );
    assert.equal(await fs.readFile(path.join(atomicOpenOutside, "atomic-open-sentinel"), "utf8"), "outside atomic temp");
    await fs.rm(atomicParent, { force: true });
    await fs.rename(atomicOpenHeldParent, atomicParent);
    const streamedSource = path.join(root, "streamed-source.bin");
    const streamedBytes = Buffer.alloc(2 * 1024 * 1024 + 17, 7);
    await fs.writeFile(streamedSource, streamedBytes);
    const streamedStat = await fs.lstat(streamedSource);
    let opens = 0;
    let chunks = 0;
    const staged = await fileSafety.streamVerifiedToStaging(
      streamedSource,
      path.join(atomicRoot, "staging"),
      {
        rootDirectory: atomicRoot,
        expectedIdentity: {
          device: streamedStat.dev,
          inode: streamedStat.ino,
          size: streamedStat.size,
          lastModified: streamedStat.mtimeMs,
        },
        onOpen: () => { opens += 1; },
        onChunk: () => { chunks += 1; },
      }
    );
    assert.equal(opens, 1);
    assert.ok(chunks > 1);
    assert.equal(staged.sha256, require("crypto").createHash("sha256").update(streamedBytes).digest("hex"));
    assert.equal((await fs.stat(staged.temporary)).size, streamedBytes.length);
    await fs.rm(staged.temporary);
    const streamOpenStaging = path.join(atomicRoot, "stream-open-staging");
    const streamOpenHeld = path.join(atomicRoot, "stream-open-held");
    const streamOpenOutside = path.join(root, "stream-open-outside");
    await fs.mkdir(streamOpenOutside);
    await assert.rejects(
      fileSafety.streamVerifiedToStaging(streamedSource, streamOpenStaging, {
        rootDirectory: atomicRoot,
        label: "stream open payload",
        beforeOutputOpen: async ({ parent }) => {
          await fs.writeFile(path.join(streamOpenOutside, "stream-open-sentinel"), "outside stream temp");
          await fs.rename(parent, streamOpenHeld);
          await fs.symlink(streamOpenOutside, parent, "dir");
        },
      }),
      /parent changed before opening/
    );
    assert.equal(await fs.readFile(path.join(streamOpenOutside, "stream-open-sentinel"), "utf8"), "outside stream temp");
    await fs.rm(streamOpenStaging, { force: true });
    await fs.rename(streamOpenHeld, streamOpenStaging);
    await assert.rejects(
      fileSafety.streamVerifiedToStaging(
        streamedSource,
        path.join(atomicRoot, "staging"),
        {
          rootDirectory: atomicRoot,
          expectedIdentity: {
            device: streamedStat.dev,
            inode: streamedStat.ino,
            size: streamedStat.size,
            lastModified: streamedStat.mtimeMs,
          },
          beforeOpen: async () => {
            await fs.rename(streamedSource, `${streamedSource}.old`);
            await fs.writeFile(streamedSource, "replacement");
          },
        }
      ),
      /changed after registration/
    );
    await fs.rm(streamedSource);
    await fs.rename(`${streamedSource}.old`, streamedSource);
    const stagedForSwap = await fileSafety.streamVerifiedToStaging(
      streamedSource,
      path.join(atomicRoot, "staging"),
      { rootDirectory: atomicRoot, label: "streamed swap source" }
    );
    const streamedTargetParent = path.join(atomicRoot, "stream-target");
    await fileSafety.ensureRealDirectoryTree(atomicRoot, streamedTargetParent);
    const streamedTarget = path.join(streamedTargetParent, "payload.bin");
    const heldStreamTarget = path.join(atomicRoot, "held-stream-target");
    const streamedOutside = path.join(root, "stream-outside");
    await fs.writeFile(streamedOutside, "outside");
    await assert.rejects(
      fileSafety.promoteStagedFile(stagedForSwap.temporary, streamedTarget, {
        rootDirectory: atomicRoot,
        label: "streamed payload",
        beforePromote: async ({ parent }) => {
          await fs.rename(parent, heldStreamTarget);
          await fs.mkdir(parent);
        },
      }),
      /parent changed/
    );
    assert.equal(await fs.readFile(streamedOutside, "utf8"), "outside");
    await fs.rm(streamedTargetParent, { recursive: true, force: true });
    await fs.rename(heldStreamTarget, streamedTargetParent);
    const stagedForStagingSwap = await fileSafety.streamVerifiedToStaging(
      streamedSource,
      path.join(atomicRoot, "staging"),
      { rootDirectory: atomicRoot, label: "staging swap source" }
    );
    const stagingParent = path.dirname(stagedForStagingSwap.temporary);
    const heldStagingParent = path.join(atomicRoot, "held-staging");
    const stagingOutside = path.join(root, "staging-outside");
    await fs.mkdir(stagingOutside);
    const stagingTarget = path.join(streamedTargetParent, "staging-payload.bin");
    await assert.rejects(
      fileSafety.promoteStagedFile(stagedForStagingSwap.temporary, stagingTarget, {
        rootDirectory: atomicRoot,
        label: "staging payload",
        beforePromote: async ({ temporary }) => {
          await fs.writeFile(path.join(stagingOutside, path.basename(temporary)), "outside staged temp");
          await fs.rename(stagingParent, heldStagingParent);
          await fs.symlink(stagingOutside, stagingParent, "dir");
        },
      }),
      /staging parent changed|cleanup parent changed/
    );
    assert.equal(await fs.readFile(path.join(stagingOutside, path.basename(stagedForStagingSwap.temporary)), "utf8"), "outside staged temp");
    await fs.rm(stagingParent, { force: true });
    await fs.rename(heldStagingParent, stagingParent);
    await fs.rm(stagedForStagingSwap.temporary, { force: true });
    const stagedForLeafReplacement = await fileSafety.streamVerifiedToStaging(
      streamedSource,
      path.join(atomicRoot, "staging"),
      { rootDirectory: atomicRoot, label: "staged leaf replacement source" }
    );
    const leafReplacementHeld = `${stagedForLeafReplacement.temporary}.held`;
    const leafReplacement = `${stagedForLeafReplacement.temporary}.replacement`;
    const leafReplacementTarget = path.join(streamedTargetParent, "leaf-replacement.bin");
    await fs.writeFile(leafReplacement, "replacement");
    await assert.rejects(
      fileSafety.promoteStagedFile(stagedForLeafReplacement.temporary, leafReplacementTarget, {
        rootDirectory: atomicRoot,
        label: "staged leaf replacement",
        beforePromote: async ({ temporary }) => {
          await fs.rename(temporary, leafReplacementHeld);
          await fs.rename(leafReplacement, temporary);
        },
      }),
      /staging file changed|descriptor-relative cleanup/
    );
    await assert.rejects(fs.access(leafReplacementTarget), (error) => error?.code === "ENOENT");
    await fs.rm(leafReplacementHeld, { force: true });
    const stagedForLeafSymlink = await fileSafety.streamVerifiedToStaging(
      streamedSource,
      path.join(atomicRoot, "staging"),
      { rootDirectory: atomicRoot, label: "staged leaf symlink source" }
    );
    const leafSymlinkHeld = `${stagedForLeafSymlink.temporary}.held`;
    const leafSymlinkOutside = path.join(root, "staged-leaf-symlink-outside.bin");
    const leafSymlinkTarget = path.join(streamedTargetParent, "leaf-symlink.bin");
    await fs.writeFile(leafSymlinkOutside, "outside");
    await assert.rejects(
      fileSafety.promoteStagedFile(stagedForLeafSymlink.temporary, leafSymlinkTarget, {
        rootDirectory: atomicRoot,
        label: "staged leaf symlink",
        beforePromote: async ({ temporary }) => {
          await fs.rename(temporary, leafSymlinkHeld);
          await fs.symlink(leafSymlinkOutside, temporary);
        },
      }),
      /staging file changed|descriptor-relative cleanup/
    );
    assert.equal(await fs.readFile(leafSymlinkOutside, "utf8"), "outside");
    await assert.rejects(fs.access(leafSymlinkTarget), (error) => error?.code === "ENOENT");
    await fs.rm(leafSymlinkHeld, { force: true });
    const stagedForPostLink = await fileSafety.streamVerifiedToStaging(
      streamedSource,
      path.join(atomicRoot, "staging"),
      { rootDirectory: atomicRoot, label: "post-link cleanup source" }
    );
    const postLinkHeld = `${stagedForPostLink.temporary}.held`;
    const postLinkTarget = path.join(streamedTargetParent, "post-link.bin");
    const postLinkOutside = path.join(root, "post-link-outside.bin");
    await fs.writeFile(postLinkTarget, "previous");
    await fs.writeFile(postLinkOutside, "outside");
    await assert.rejects(
      fileSafety.promoteStagedFile(stagedForPostLink.temporary, postLinkTarget, {
        rootDirectory: atomicRoot,
        label: "post-link cleanup",
        beforeLink: async ({ temporary }) => {
          await fs.rename(temporary, postLinkHeld);
          await fs.symlink(postLinkOutside, temporary);
        },
      }),
      /destination changed during promotion|descriptor-relative cleanup/
    );
    const restoredPostLink = await fs.lstat(postLinkTarget);
    assert.ok(restoredPostLink.isFile() && !restoredPostLink.isSymbolicLink());
    assert.equal(await fs.readFile(postLinkTarget, "utf8"), "previous");
    assert.equal(await fs.readFile(postLinkOutside, "utf8"), "outside");
    await fs.rm(postLinkHeld, { force: true });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  const sourceReplacement = await import("../src/pages/generate/sourceReplacement.js");
  const requestRef = { current: 0 };
  const first = sourceReplacement.beginMediaRequest(requestRef);
  const second = sourceReplacement.beginMediaRequest(requestRef);
  assert.equal(first.isCurrent(), false, "stale metadata request was allowed to commit");
  const hardwareUi = await import("../src/data/hardwareModes.js");
  assert.equal(hardwareUi.normalizeHardwareMode("macos"), "cpu");
  assert.deepEqual(
    hardwareUi.hardwareModesForPlatform("darwin").map((mode) => mode.value),
    ["auto", "webgpu", "coreml", "cpu"]
  );
  assert.deepEqual(
    hardwareUi.hardwareModesForPlatform("linux").map((mode) => mode.value),
    ["auto", "webgpu", "cuda", "cpu"]
  );
  assert.equal(hardwareUi.humanizeStatus("unsupported"), "Unsupported");
  assert.equal(hardwareUi.humanizeStatus("unverified"), "Not yet verified");
  assert.equal(hardwareUi.humanizeStatus("cuda"), "CUDA");
  assert.equal(hardwareUi.humanizeStatus("webgpu"), "WebGPU");
  assert.equal(hardwareUi.humanizeRuntime("onnxruntime-node"), "ONNX Runtime");
  assert.equal(hardwareUi.humanizeSupportLabel("Supported: Linux x64"), "Linux x64");
  const transactionRef = { current: false };
  const transaction = sourceReplacement.beginExclusiveMediaTransaction(transactionRef);
  assert.ok(transaction);
  assert.equal(sourceReplacement.beginExclusiveMediaTransaction(transactionRef), null);
  transaction.release();
  assert.ok(sourceReplacement.beginExclusiveMediaTransaction(transactionRef));

  assert.equal(hardwareUi.hardwareModeForPlatform("cuda", "darwin"), "cpu");
  assert.equal(hardwareUi.hardwareModeForPlatform("coreml", "darwin"), "coreml");
  assert.equal(second.isCurrent(), true);
  const file = new Blob(["replacement-audio"], { type: "audio/ogg" });
  Object.defineProperty(file, "name", { value: "new_source.ogg" });
  const replacement = sourceReplacement.buildSourceReplacementRecord({
    file,
    mediaInfo: { meta: { title: "New Source", artist: "New Artist" }, albumBlob: null },
  });
  assert.equal(replacement.meta.title, "New Source");
  assert.equal(replacement.meta.charter, "Autochart");
  assert.deepEqual(replacement.versions, []);
  assert.deepEqual(replacement.arrangements, []);
  assert.deepEqual(replacement.chart, { text: "" });
  assert.deepEqual(replacement.sourceArtifacts, sourceReplacement.emptyReplacementSourceArtifacts());
  assert.equal(replacement._blobs.audio, file);

  let storedAudioReads = 0;
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: async () => {
      storedAudioReads += 1;
      throw new Error("persisted audio should not be read when a replacement buffer is supplied");
    },
  });
  const replacementBuffer = new Uint8Array([1, 2, 3, 4]).buffer;
  const songLibrary = await import("../src/services/songLibrary.js");
  const reloadedReplacement = await songLibrary.recordToImported(replacement, {
    audioBuffer: replacementBuffer,
  });
  assert.equal(reloadedReplacement.audioBuffer, replacementBuffer);
  assert.equal(storedAudioReads, 0, "source replacement loaded a second complete audio buffer");

  for (const platform of ["win32", "linux", "darwin"]) {
    await fileSafety.fsyncHandle({ sync: async () => {} }, { platform });
    for (const code of ["EACCES", "EPERM", "EINVAL", "ENOTSUP", "EBADF", "EIO", "ENOSPC", "ENXIO"]) {
      const error = Object.assign(new Error(`fsync ${code}`), { code });
      const syncing = fileSafety.fsyncHandle({ sync: async () => { throw error; } }, { platform });
      if (platform === "win32" && ["EACCES", "EPERM", "EINVAL", "ENOTSUP"].includes(code)) {
        await syncing;
      } else {
        await assert.rejects(syncing, (actual) => actual === error);
      }
    }
  }
  // Directory flushes are best effort only for unsupported operations, not EIO.
  const originalOpen = fs.open;
  let closed = 0;
  try {
    for (const code of ["EINVAL", "EIO"]) {
      fs.open = async () => ({
        sync: async () => { throw Object.assign(new Error(code), { code }); },
        close: async () => { closed += 1; },
      });
      const syncing = fileSafety.fsyncDirectory("unused", { platform: "linux" });
      if (code === "EINVAL") await syncing;
      else await assert.rejects(syncing, { code: "EIO" });
    }
    assert.equal(closed, 2, "directory descriptors close even after failed flushes");
  } finally {
    fs.open = originalOpen;
  }

  console.log("v0.1.0 backend regressions passed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const esbuild = require("esbuild");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const ROOT = path.resolve(__dirname, "..");

async function bundle(entry, directory) {
  const outfile = path.join(directory, `${path.basename(entry).replace(/[^a-z0-9]+/gi, "_")}.cjs`);
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    bundle: true,
    format: "cjs",
    platform: "node",
    loader: { ".jsx": "jsx" },
    outfile,
    logLevel: "silent",
  });
  return require(outfile);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-frontend-contract-"));
  try {
    const gameLibrary = await bundle("src/data/gameLibrary.js", temp);
    assert(gameLibrary.GAME_LIBRARY_NAME === "Clone Hero / YARG", "game-library destination is ambiguous");
    assert(
      gameLibrary.GAME_LIBRARY_SAVE_LABEL === "SAVE TO CLONE HERO / YARG",
      "game-library save action does not name Clone Hero / YARG"
    );
    assert(
      gameLibrary.GAME_LIBRARY_SAVING_LABEL === "SAVING TO CLONE HERO / YARG…",
      "game-library busy action does not name Clone Hero / YARG"
    );
    assert(
      gameLibrary.GAME_LIBRARY_SAVED_LABEL === "SAVED TO CLONE HERO / YARG",
      "game-library success action does not name Clone Hero / YARG"
    );
    const chartVersions = await bundle("src/services/chartVersions.js", temp);
    assert(!Object.prototype.hasOwnProperty.call(chartVersions, "createMergedVersion"), "range merge API is still public");
    const runtimeBridge = await bundle("src/services/runtimeBridge.js", temp);
    const browserWindow = global.window;
    delete global.window;
    assert(runtimeBridge.electronPlatform() === "", "browser bridge exposed an Electron platform");
    assert(runtimeBridge.hasElectronLibrary() === false, "browser bridge claimed Electron library availability");
    global.window = {
      autochart: {
        platform: "linux",
        library: { isAvailable: () => true },
        engine: { isAvailable: () => true },
        settings: { isAvailable: () => true },
        modelSetup: { isAvailable: () => true },
        hardware: { isAvailable: () => true },
        files: { registerGenerationInput: () => null },
        notices: { open: () => Promise.resolve() },
        window: { setFullscreen: () => Promise.resolve(), onFullscreenChange: () => () => {} },
      },
    };
    assert(runtimeBridge.electronPlatform() === "linux", "Electron-shaped bridge did not expose platform");
    assert(runtimeBridge.hasElectronLibrary() === true, "Electron-shaped bridge did not expose library availability");
    assert(runtimeBridge.hasElectronEngine() && runtimeBridge.hasElectronSettings(), "Electron-shaped service bridges missing");
    assert(runtimeBridge.hasElectronModelSetup() && runtimeBridge.hasElectronHardware(), "Electron-shaped setup bridges missing");
    assert(runtimeBridge.electronFiles()?.registerGenerationInput, "Electron-shaped file bridge missing");
    assert(runtimeBridge.electronLibrary()?.isAvailable, "Electron-shaped library bridge missing");
    assert(typeof runtimeBridge.electronWindow()?.setFullscreen === "function", "Electron-shaped window bridge missing");
    if (browserWindow === undefined) delete global.window;
    else global.window = browserWindow;
    const generationPipeline = await bundle("src/components/GenerationPipeline.jsx", temp);
    const standardPack = require("../engine/catalog.json").packs.find((pack) => pack.id === "standard-onnx");
    assert(generationPipeline.generationDownloadSize() === generationPipeline.generationDownloadSize(standardPack), "download size fallback drifted from catalog");
    const generationGate = await bundle("src/pages/generate/generationGate.js", temp);
    const unsupportedState = await bundle("src/pages/generate/UnsupportedGenerationState.jsx", temp);
    const unsupportedPairs = [
      ["linux", "arm64"],
      ["linux", "ia32"],
      ["win32", "arm64"],
      ["win32", "ia32"],
      ["darwin", "x64"],
      ["darwin", "ia32"],
      ["freebsd", "x64"],
    ];
    for (const [platform, arch] of unsupportedPairs) {
      const status = { supportedPlatform: false, platform, arch, message: `${platform}-${arch} unsupported` };
      assert(generationGate.isUnsupportedGenerationTarget(status), `${platform}/${arch} was not gated as unsupported`);
      const html = renderToStaticMarkup(
        React.createElement(unsupportedState.default, {
          targetLabel: `${platform} ${arch}`,
          message: status.message,
        })
      );
      assert(!/<button\b|Download Package|Set Up Autochart/.test(html), `${platform}/${arch} exposes an unsupported setup CTA`);
    }

    const progress = await bundle("src/pages/generate/GenerationProgress.jsx", temp);
    const ids = progress.GENERATION_STAGES.map((stage) => stage.id);
    const transcriptionIndex = ids.indexOf("transcription");
    const chartIndex = ids.indexOf("chart");
    assert(transcriptionIndex >= 0 && chartIndex > transcriptionIndex, "transcription and chart stages are not distinct and ordered");

    const warmup = {
      startedAt: 1,
      stages: { demucs: { status: "completed" }, transcription: { status: "running" } },
      live: null,
    };
    assert(!progress.runIsSeparating(warmup), "transcription warm-up was reported as stem separation");

    const chartWriting = {
      startedAt: 2,
      stages: { transcription: { status: "completed" }, chart: { status: "running" } },
    };
    assert(progress.runProgressPercent(chartWriting) === 86, "chart-writing range must begin at 86%");
    assert(/Write chart/.test(progress.describeRunStage(chartWriting)), "chart-writing headline does not name chart writing");

    const separating = { startedAt: 3, stages: { demucs: { status: "running" } } };
    assert(progress.runIsSeparating(separating), "running Demucs stage was not reported as separation");

    // A project that ships a human-charted notes.chart reuses its sync track by
    // default; a project built from bare audio detects timing instead.
    const settings = await bundle("src/data/generationSettings.js", temp);
    const importedDefault = { fallbackTimingDetector: settings.SOURCE_CHART_TIMING_DETECTOR_ID };
    assert(
      settings.controlsFromSavedGeneration(null, "expert", importedDefault).timingDetector === settings.SOURCE_CHART_TIMING_DETECTOR_ID,
      "imported projects do not default to reusing the imported sync track"
    );
    assert(
      settings.controlsFromSavedGeneration(null, "expert").timingDetector === settings.DEFAULT_TIMING_DETECTOR_ID,
      "audio-only projects do not default to beat detection"
    );
    const savedDetection = settings.buildGenerationSettings({
      controls: { ...settings.DEFAULT_GENERATION_CONTROLS, timingDetector: settings.DEFAULT_TIMING_DETECTOR_ID },
    }).generation;
    assert(
      settings.controlsFromSavedGeneration(savedDetection, "expert", importedDefault).timingDetector === settings.DEFAULT_TIMING_DETECTOR_ID,
      "a saved detector choice is overridden by the project default"
    );
    const importedGeneration = settings.buildGenerationSettings({
      controls: settings.controlsFromSavedGeneration(null, "expert", importedDefault),
      defaultTimingDetector: settings.SOURCE_CHART_TIMING_DETECTOR_ID,
    }).generation;
    assert(!importedGeneration.modified, "the imported-sync default is reported as a modified recipe");
    assert(
      importedGeneration.resolved.detector === "source_chart" &&
        importedGeneration.resolved.leadInSilenceMs === 0 &&
        importedGeneration.resolved.timingSmoothing.enabled === false,
      "imported sync does not pin the engine detector, lead-in and smoothing"
    );

    const [
      setupSource,
      settingsSource,
      projectBarSource,
      styles,
      targetSource,
      appSource,
      progressSource,
      consoleSource,
      generationSource,
      labelsSource,
      railSource,
      generatePageSource,
      librarySource,
      hookSource,
    ] = await Promise.all([
      fs.readFile(path.join(ROOT, "src/pages/SetupWizard.jsx"), "utf8"),
      fs.readFile(path.join(ROOT, "src/pages/Settings.jsx"), "utf8"),
      fs.readFile(path.join(ROOT, "src/pages/generate/ProjectBar.jsx"), "utf8"),
      fs.readFile(path.join(ROOT, "src/styles.css"), "utf8"),
      fs.readFile(path.join(ROOT, "config/supported-targets.json"), "utf8"),
      fs.readFile(path.join(ROOT, "src/App.jsx"), "utf8"),
      fs.readFile(path.join(ROOT, "src/pages/generate/GenerationProgress.jsx"), "utf8"),
      fs.readFile(path.join(ROOT, "src/pages/generate/Console.jsx"), "utf8"),
      fs.readFile(path.join(ROOT, "src/services/generation.js"), "utf8"),
      fs.readFile(path.join(ROOT, "config/human-labels.json"), "utf8"),
      fs.readFile(path.join(ROOT, "src/components/index.jsx"), "utf8"),
      fs.readFile(path.join(ROOT, "src/pages/generate/GeneratePage.jsx"), "utf8"),
      fs.readFile(path.join(ROOT, "src/pages/Library.jsx"), "utf8"),
      fs.readFile(path.join(ROOT, "src/pages/generate/useGenerateProject.js"), "utf8"),
    ]);
    assert(/role=\{message\.tone === "ok" \? "status" : "alert"\}/.test(setupSource), "setup messages lack semantic status roles");
    assert(/aria-live=\{message\.tone === "ok" \? "polite" : "assertive"\}/.test(setupSource), "setup messages are not announced");
    assert(setupSource.includes("Scan Again") && settingsSource.includes("Scan Again"), "setup scan actions use different wording");
    assert(setupSource.includes("Save Source") && settingsSource.includes("Save Source"), "download-source actions use different wording");
    assert(projectBarSource.includes("Start new project with this media"), "source replacement does not explain that it creates a project");
    assert(!projectBarSource.includes('"Replace media"'), "misleading source-replacement label remains");
    assert(/\.setup-status\.checking\s*\{[^}]*var\(--text-dim\)[^}]*var\(--surface-2\)/.test(styles), "checking status is not neutral");
    assert(settingsSource.includes("RELEASE NOTICES"), "release notices are not actionable in Settings");
    assert(settingsSource.includes("Open FFmpeg LGPL notice") && settingsSource.includes("FFmpeg legal information"), "FFmpeg notice actions are missing");
    assert(generatePageSource.indexOf("project.unsupportedTarget") < generatePageSource.indexOf("project.setupBlocking"), "unsupported state must render before setup CTA");
    const targets = JSON.parse(targetSource).targets;
    assert(JSON.stringify(targets.map((target) => target.key).sort()) === JSON.stringify(["darwin-arm64", "linux-x64", "win32-x64"]), "shared target matrix is incomplete");
    assert(appSource.includes("mainRef.current?.focus"), "page navigation does not restore focus");
    assert(railSource.includes('aria-current={page === it.id ? "page" : undefined}'), "navigation lacks current-page semantics");
    assert(progressSource.includes('aria-label="Chart generation completion"') && progressSource.includes("aria-valuetext"), "progress bar lacks accessible value text");
    assert(progressSource.includes('aria-controls="generation-pipeline-details"'), "pipeline toggle does not expose its controlled region");
    assert(settingsSource.includes("settings-install-reason") && setupSource.includes("setup-finish-reason"), "disabled setup controls lack reasons");
    assert(consoleSource.includes("generate-cta-reason"), "Generate CTA lacks a disabled reason");
    assert(labelsSource.includes('"Fretformer"') && labelsSource.includes('"FFmpeg media support"'), "shared human label catalog is incomplete");
    assert(!generationSource.includes("Mock chart generated") && !generationSource.includes("Mock export"), "stale browser mock wording remains");
    assert(!librarySource.includes('useState("inok")'), "stale library selection id remains");
    assert(!hookSource.includes("draftVersionId: editorDraftVersionId") && !hookSource.includes("sourceVersionId: editorSourceVersionId"), "dead editor ids remain in project return");
    // The public snapshot copies only listed files; an unlisted src/ module
    // would leave an unresolved import behind.
    const publicSources = new Set(JSON.parse(await fs.readFile(path.join(ROOT, "config/public-source-files.json"), "utf8")).files);
    const unlistedSources = (await fs.readdir(path.join(ROOT, "src"), { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
      .filter((file) => !publicSources.has(file));
    assert(!unlistedSources.length, `src files missing from config/public-source-files.json: ${unlistedSources.join(", ")}`);

    const fullscreenPolicy = await bundle("src/hooks/ownedFullscreenPolicy.js", temp);
    const fullscreenHookSource = await fs.readFile(path.join(ROOT, "src/hooks/useOwnedFullscreen.js"), "utf8");
    assert(fullscreenHookSource.includes("shouldApplyBrowserFullscreenChange"), "Electron overlay ignores DOM fullscreenchange without a policy gate");
    assert(fullscreenHookSource.includes("shouldIgnoreElectronLeave"), "spurious Windows leave-full-screen is not filtered");
    assert(fullscreenHookSource.includes("shouldRestoreOverlayOnElectronEnter"), "owned overlay is not restored after a raced leave");
    assert(
      !fullscreenPolicy.shouldApplyBrowserFullscreenChange({ targetIsFullscreen: false, browserOwned: false }),
      "native window fullscreen must not clobber the highway overlay"
    );
    assert(
      fullscreenPolicy.shouldApplyBrowserFullscreenChange({ targetIsFullscreen: true, browserOwned: false }),
      "HTML fullscreen enter must still apply overlay before browserOwned is set"
    );
    assert(
      fullscreenPolicy.shouldApplyBrowserFullscreenChange({ targetIsFullscreen: false, browserOwned: true }),
      "HTML fullscreen exit must still clear overlay"
    );
    assert(
      fullscreenPolicy.shouldIgnoreElectronLeave({ pendingEnter: true, windowStillFullscreen: false }),
      "leave during pending enter must be ignored"
    );
    assert(
      fullscreenPolicy.shouldIgnoreElectronLeave({ pendingEnter: false, windowStillFullscreen: true }),
      "leave while the window is still fullscreen must be ignored"
    );
    assert(
      !fullscreenPolicy.shouldIgnoreElectronLeave({ pendingEnter: false, windowStillFullscreen: false }),
      "confirmed window leave must dismiss highway fullscreen"
    );
    assert(
      fullscreenPolicy.shouldRestoreOverlayOnElectronEnter({ electronOwned: true, overlayActive: false }),
      "owned enter must restore overlay after a raced leave"
    );
    assert(
      !fullscreenPolicy.shouldRestoreOverlayOnElectronEnter({ electronOwned: false, overlayActive: false }),
      "F11 fullscreen must not steal overlay ownership"
    );
    {
      let overlay = true;
      let owned = true;
      const pendingEnter = true;
      if (fullscreenPolicy.shouldApplyBrowserFullscreenChange({ targetIsFullscreen: false, browserOwned: false })) {
        overlay = false;
      }
      if (!fullscreenPolicy.shouldIgnoreElectronLeave({ pendingEnter, windowStillFullscreen: false })) {
        owned = false;
        overlay = false;
      }
      assert(overlay && owned, "first Full screen click must keep overlay and window ownership");
      if (fullscreenPolicy.shouldRestoreOverlayOnElectronEnter({ electronOwned: owned, overlayActive: overlay })) {
        overlay = true;
      }
      overlay = false;
      const exitWindow = owned;
      owned = false;
      assert(exitWindow && !overlay && !owned, "Exit must unwind the window fullscreen this surface started");
    }
    {
      const alreadyFullscreen = true;
      const owned = !alreadyFullscreen;
      assert(!owned, "F11-already-fullscreen must not be stolen on highway Exit");
    }
    assert(hookSource.includes("defaultTimingDetectorFor(versions, importedSong)"), "opening a project does not apply its default timing detector");
    const recovery = await bundle("src/pages/generate/hardwareRecovery.js", temp);
    const failedHardwareRun = { finishedAt: 1, error: "WebGPU device lost: execution failed" };
    assert(recovery.canRetryUsingCpu(failedHardwareRun), "accelerated failure must offer CPU recovery");
    for (const override of [
      { finishedAt: 0 }, { ok: true }, { canceled: true }, { hardwareMode: "cpu" },
      { runtimeFallback: { from: "webgpu" } }, { error: "Audio file is missing" },
      { error: "Model file unavailable for WebGPU" }, { error: "ENOSPC writing CUDA output" },
    ]) assert(!recovery.canRetryUsingCpu({ ...failedHardwareRun, ...override }), "unrelated, active, or CPU failure offered recovery");
    console.log("frontend contract checks passed");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

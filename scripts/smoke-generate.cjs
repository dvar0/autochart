#!/usr/bin/env node
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { pathToFileURL } = require("url");

const assetInstaller = require("../electron/assetInstaller.cjs");
const engineManager = require("../electron/engineManager.cjs");
const hardwareProbe = require("../electron/hardwareProbe.cjs");
const modelManager = require("../electron/modelManager.cjs");
const settingsStore = require("../electron/settingsStore.cjs");
const smokePathSafety = require("./smoke-path-safety.cjs");

const APP_ROOT = path.resolve(__dirname, "..");
const DEMO_AUDIO = path.join(APP_ROOT, "fixtures", "demo", "autochart-demo-30s.wav");

function usage() {
  return `
Usage: node scripts/smoke-generate.cjs [options]

Options:
  --audio <path>            Audio file to generate from.
  --user-data <path>        Autochart userData path (default: isolated temporary path).
  --models-folder <path>    Models/runtime install folder (default: isolated temporary path).
  --cache-folder <path>     Job/cache folder (default: isolated temporary path).
  --projects-folder <path>  Project folder (default: isolated temporary path).
  --asset-base-url <url>    Asset catalog base URL.
  --hardware <mode>         auto, cuda, webgpu, coreml, or cpu. Default: auto.
  --generation-timeout-seconds <n>  Cancel generation after n seconds (default: 900; excludes installation).
  --difficulty <value>      easy, medium, hard, or expert. Default: expert.
  --seed <number>           Fixed generation seed. Default: 20260622.
  --min-partials <number>   Minimum partial_chart events. Default: 1.
  --min-note-partials <n>   Minimum partial_chart events with noteLines. Default: 1.
  --wipe                    Reset only new or marker-owned paths for this isolated run.
  --skip-install            Do not install missing model assets.
  --expect-cpu-fallback     Require a reported GPU fallback and a completed CPU result.
  --isolation-root <path>   Reuse a marked isolation root created by release verification.
  --help                    Show this help.
`.trim();
}

function parseArgs(argv) {
  const args = {
    audio: DEMO_AUDIO,
    userData: process.env.AUTOCHART_USER_DATA || "",
    modelsFolder: "",
    cacheFolder: "",
    projectsFolder: "",
    isolationRoot: "",
    assetBaseUrl: process.env.AUTOCHART_ASSETS_BASE_URL || assetInstaller.DEFAULT_ASSET_BASE_URL,
    hardware: "auto",
    generationTimeoutSeconds: 900,
    difficulty: "expert",
    seed: 20260622,
    minPartials: 1,
    minNotePartials: 1,
    wipe: false,
    skipInstall: false,
    expectCpuFallback: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--audio") args.audio = next();
    else if (arg === "--user-data") {
      args.userData = next();
    } else if (arg === "--models-folder") {
      args.modelsFolder = next();
    } else if (arg === "--cache-folder") {
      args.cacheFolder = next();
    } else if (arg === "--projects-folder") {
      args.projectsFolder = next();
    } else if (arg === "--isolation-root") args.isolationRoot = next();
    else if (arg === "--asset-base-url") args.assetBaseUrl = next();
    else if (arg === "--hardware") args.hardware = next();
    else if (arg === "--generation-timeout-seconds") args.generationTimeoutSeconds = Number(next());
    else if (arg === "--difficulty") args.difficulty = next();
    else if (arg === "--seed") args.seed = Number.parseInt(next(), 10);
    else if (arg === "--min-partials") args.minPartials = Number.parseInt(next(), 10);
    else if (arg === "--min-note-partials") args.minNotePartials = Number.parseInt(next(), 10);
    else if (arg === "--wipe") args.wipe = true;
    else if (arg === "--skip-install") args.skipInstall = true;
    else if (arg === "--expect-cpu-fallback") args.expectCpuFallback = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (args.userData) args.userData = path.resolve(args.userData);
  args.audio = path.resolve(args.audio);
  if (args.modelsFolder) args.modelsFolder = path.resolve(args.modelsFolder);
  if (args.cacheFolder) args.cacheFolder = path.resolve(args.cacheFolder);
  if (args.projectsFolder) args.projectsFolder = path.resolve(args.projectsFolder);
  if (args.isolationRoot) args.isolationRoot = path.resolve(args.isolationRoot);
  if (!["auto", "cuda", "webgpu", "coreml", "cpu"].includes(args.hardware)) throw new Error("--hardware must be auto, cuda, webgpu, coreml, or cpu.");
  if (!Number.isFinite(args.generationTimeoutSeconds) || args.generationTimeoutSeconds <= 0 || args.generationTimeoutSeconds * 1000 > 2147483647) {
    throw new Error("--generation-timeout-seconds must be positive and within the timer range.");
  }
  if (!["easy", "medium", "hard", "expert"].includes(args.difficulty)) throw new Error("--difficulty must be easy, medium, hard, or expert.");
  if (!Number.isInteger(args.seed) || args.seed < 0) throw new Error("--seed must be a non-negative integer.");
  if (!Number.isInteger(args.minPartials) || args.minPartials < 0) throw new Error("--min-partials must be >= 0.");
  if (!Number.isInteger(args.minNotePartials) || args.minNotePartials < 0) throw new Error("--min-note-partials must be >= 0.");
  return args;
}

function defaultSettings(args) {
  return {
    projectsFolder: args.projectsFolder,
    modelsFolder: args.modelsFolder,
    cacheFolder: args.cacheFolder,
    cloneHeroLibraryFolder: "",
    assetBaseUrl: args.assetBaseUrl,
    hardwareMode: args.hardware,
  };
}

const ISOLATED_PATHS = Object.freeze([
  { key: "userData", role: "user-data", leaf: "user-data" },
  { key: "modelsFolder", role: "models", leaf: "models" },
  { key: "cacheFolder", role: "cache", leaf: "cache" },
  { key: "projectsFolder", role: "projects", leaf: "projects" },
]);

async function initializeIsolation(args) {
  let isolation;
  const ownedEntries = [];
  try {
    if (args.isolationRoot) {
      const validated = await smokePathSafety.readAndValidateMarker(args.isolationRoot, { role: "run-root" });
      isolation = { root: validated.resolved, runId: validated.marker.runId, ownsRoot: false };
    } else {
      isolation = await smokePathSafety.createIsolatedRunRoot("autochart-generation-smoke-");
      isolation.ownsRoot = true;
      args.isolationRoot = isolation.root;
    }

    for (const entry of ISOLATED_PATHS) {
      if (!args[entry.key]) args[entry.key] = path.join(isolation.root, entry.leaf);
    }

    const targets = ISOLATED_PATHS.map((entry) => ({ role: entry.role, target: args[entry.key] }));
    await smokePathSafety.validateDistinctTargets(targets);
    if (args.wipe) {
      // Validate every existing target before changing any target. A normal
      // pre-existing caller path therefore fails atomically with no partial wipe.
      for (const entry of ISOLATED_PATHS) {
        const target = args[entry.key];
        if (await smokePathSafety.pathExists(target)) {
          try {
            await smokePathSafety.readAndValidateMarker(target, {
              runId: isolation.runId,
              role: entry.role,
            });
          } catch (error) {
            throw new Error(
              `Refusing to wipe pre-existing ${entry.role} path not owned by this run: ${target}. ${error.message}`
            );
          }
        }
      }
      for (const entry of ISOLATED_PATHS) {
        const target = args[entry.key];
        await smokePathSafety.ensureOwnedDirectory(target, { runId: isolation.runId, role: entry.role });
        ownedEntries.push(entry);
        await smokePathSafety.wipeOwnedDirectory(target, { runId: isolation.runId, role: entry.role });
        log(`reset marker-owned ${entry.role}`, target);
      }
    }

    log("isolated paths", {
      runRoot: isolation.root,
      userData: args.userData,
      modelsFolder: args.modelsFolder,
      cacheFolder: args.cacheFolder,
      projectsFolder: args.projectsFolder,
    });
    return isolation;
  } catch (error) {
    if (isolation?.ownsRoot) {
      for (const entry of ownedEntries.reverse()) {
        const target = args[entry.key];
        if (smokePathSafety.isWithin(isolation.root, target) || !(await smokePathSafety.pathExists(target))) continue;
        await smokePathSafety.removeOwnedDirectory(target, {
          runId: isolation.runId,
          role: entry.role,
        }).catch(() => {});
      }
      if (await smokePathSafety.pathExists(isolation.root)) {
        await smokePathSafety.removeOwnedDirectory(isolation.root, {
          runId: isolation.runId,
          role: "run-root",
        }).catch(() => {});
      }
    }
    throw error;
  }
}

async function cleanupOwnedIsolation(args, isolation) {
  if (!isolation?.ownsRoot) return;
  if (args.wipe) {
    for (const entry of ISOLATED_PATHS) {
      const target = args[entry.key];
      if (smokePathSafety.isWithin(isolation.root, target) || !(await smokePathSafety.pathExists(target))) continue;
      await smokePathSafety.removeOwnedDirectory(target, {
        runId: isolation.runId,
        role: entry.role,
      });
    }
  }
  await smokePathSafety.removeOwnedDirectory(isolation.root, {
    runId: isolation.runId,
    role: "run-root",
  });
}

function log(message, detail = null) {
  const text = `[smoke] ${message}`;
  if (detail == null) console.log(text);
  else console.log(`${text}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

function settingsWithHardware(settings, hardware) {
  return {
    ...settings,
    effectiveHardwareMode: hardware?.effectiveHardwareMode || hardware?.selectedMode || "",
    selectedRuntimePack: hardware?.selectedRuntimePack || "",
  };
}

function setupReady(scan) {
  return Boolean(scan?.generationReady && scan?.standardPack?.ready);
}

async function scan(settings) {
  const manifest = await engineManager.loadManifest();
  return modelManager.scanModelSetup({ settings, manifest });
}

async function installIfNeeded(settings, args) {
  let hardware = await hardwareProbe.probeHardware(settings);
  let runtimeSettings = settingsWithHardware(settings, hardware);
  log("hardware", {
    platform: hardware.platform,
    arch: hardware.arch,
    requested: hardware.requestedMode,
    selected: hardware.effectiveHardwareMode,
    runtime: hardware.selectedRuntimePack,
  });

  let currentScan = await scan(runtimeSettings);
  log("initial setup", {
    ready: setupReady(currentScan),
    pack: currentScan.standardPack?.id || "",
    status: currentScan.standardPack?.status || "",
  });
  // The development checkout can make a scan look ready through its fallback
  // symlinks. A smoke run must populate and exercise the selected modelsFolder
  // instead of silently testing a different model root.
  const selectedManifest = path.join(settings.modelsFolder, "fretformer-v1", "manifest.json");
  const directManifest = path.join(settings.modelsFolder, "manifest.json");
  const selectedModelsReady = fsSync.existsSync(selectedManifest) || fsSync.existsSync(directManifest);
  if ((setupReady(currentScan) && !args.wipe && selectedModelsReady) || args.skipInstall) {
    return { settings: runtimeSettings, scan: currentScan, hardware };
  }

  log("installing assets", currentScan.standardPack?.id || "standard pack");
  const install = await assetInstaller.installAssets(runtimeSettings, {
    onProgress: (event) => {
      if (event.type === "progress" && Number.isFinite(event.percent)) {
        process.stdout.write(`\r[smoke] install ${event.percent}% ${event.filePath || event.path || ""}`.slice(0, 160));
      } else if (event.type === "complete") {
        process.stdout.write("\n");
        log("install complete", { pack: event.packId, files: event.files, extracted: event.extracted });
      }
    },
  });
  if (!install?.ok) throw new Error("Asset install did not report success.");

  hardware = await hardwareProbe.probeHardware(settings);
  runtimeSettings = settingsWithHardware(settings, hardware);
  currentScan = await scan(runtimeSettings);
  if (!setupReady(currentScan)) {
    const components = (currentScan.standardPack?.components || [])
      .filter((component) => !component.ready)
      .map((component) => `${component.id}:${component.status}`)
      .join(", ");
    throw new Error(`Setup is not ready after install. ${components}`);
  }
  return { settings: runtimeSettings, scan: currentScan, hardware };
}

async function generationSettings(generatorId, difficulty, seed) {
  const modulePath = pathToFileURL(path.join(APP_ROOT, "src", "data", "generationSettings.js")).href;
  const generation = await import(modulePath);
  const controls = {
    ...generation.DEFAULT_GENERATION_CONTROLS,
    difficulty,
    seedMode: "fixed",
    seed: String(seed),
  };
  return generation.buildGenerationSettings({ generatorId, controls }).generation;
}

function mimeForAudio(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".flac") return "audio/flac";
  if (ext === ".ogg" || ext === ".opus") return "audio/ogg";
  if (ext === ".m4a" || ext === ".aac") return "audio/mp4";
  return "application/octet-stream";
}

function chartNoteLineCount(chartText) {
  return (String(chartText || "").match(/^\s*\d+\s+=\s+N\s+/gm) || []).length;
}

async function withGenerationTimeout(jobId, sender, timeoutSeconds, generate) {
  let timeoutError = null;
  const timer = setTimeout(() => {
    timeoutError = new Error(`Generation smoke exceeded ${timeoutSeconds} seconds; canceling job ${jobId}. See stage/provider logs above.`);
    console.error(`[smoke] ${timeoutError.message}`);
    engineManager.cancelJob(jobId, sender);
  }, timeoutSeconds * 1000);
  try {
    const result = await generate();
    if (timeoutError) throw timeoutError;
    return result;
  } catch (error) {
    throw timeoutError || error;
  } finally {
    clearTimeout(timer);
  }
}

async function runGeneration(userData, settings, args) {
  const manifest = await engineManager.loadManifest();
  const generator = manifest.generators?.[0];
  if (!generator) throw new Error("No generator is available.");
  const events = [];
  const sender = {
    isDestroyed: () => false,
    send(channel, payload) {
      if (channel !== "engine:jobEvent") return;
      events.push(payload);
      if (payload.type === "partial_chart") {
        log("partial_chart", {
          sequence: payload.sequence,
          complete: payload.complete,
          noteLines: Array.isArray(payload.noteLines) ? payload.noteLines.length : 0,
          tokenCount: payload.tokenCount,
        });
      } else if (payload.type === "stage") {
        log(`stage ${payload.stage}`, {
          status: payload.status,
          device: payload.device,
          requestedDevice: payload.requestedDevice,
          progress: payload.progress,
        });
      } else if (payload.type === "log") {
        log("engine", payload.message);
      } else if (payload.type === "runtime_fallback") {
        log("runtime_fallback", { from: payload.from, to: payload.to, reason: payload.reason });
      }
    },
  };
  const generation = await generationSettings(generator.id, args.difficulty, args.seed);
  const jobId = randomUUID();
  const result = await withGenerationTimeout(jobId, sender, args.generationTimeoutSeconds, () => engineManager.generateChart(
    userData,
    sender,
    {
      jobId,
      generatorId: generator.id,
      audio: {
        path: path.resolve(args.audio),
        name: path.basename(args.audio),
        mime: mimeForAudio(args.audio),
      },
      difficulty: args.difficulty,
      style: "default",
      intensity: 0.5,
      stripSustains: false,
      generation,
      metadata: {
        title: "Autochart Smoke Demo",
        artist: "Demo Fixture",
      },
      title: "Autochart Smoke Demo",
    },
    { settings }
  ));
  const partials = events.filter((event) => event.type === "partial_chart");
  const notePartials = partials.filter((event) => Array.isArray(event.noteLines) && event.noteLines.length > 0);
  const noteCount = chartNoteLineCount(result.chartText);
  if (partials.length < args.minPartials) throw new Error(`Expected at least ${args.minPartials} partial_chart events, got ${partials.length}.`);
  if (notePartials.length < args.minNotePartials) {
    throw new Error(`Expected at least ${args.minNotePartials} partial_chart events with noteLines, got ${notePartials.length}.`);
  }
  if (noteCount <= 0) throw new Error("Generated chart has no note lines.");
  const runtimeFallbacks = events.filter((event) => event.type === "runtime_fallback");
  const executionProvider = result.provenance?.runtime?.executionProvider || null;
  if (args.expectCpuFallback && (
    !runtimeFallbacks.some((event) => event.to === "cpu" && event.from !== "cpu") ||
    executionProvider !== "cpu"
  )) {
    throw new Error("Expected a reported GPU-to-CPU fallback and completed CPU generation.");
  }
  return {
    jobId: result.jobId,
    chartPath: result.chartPath,
    reportPath: result.reportPath,
    partialChartEvents: partials.length,
    partialChartEventsWithNotes: notePartials.length,
    noteLines: noteCount,
    executionProvider,
    runtimeFallbacks: runtimeFallbacks.map(({ from, to, reason }) => ({ from, to, reason })),
    generatorId: generator.id,
    generatorLabel: generator.label,
  };
}

async function writeReport(userData, report) {
  const dir = path.join(userData, "smoke-reports");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `generation-smoke-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return filePath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!fsSync.existsSync(args.audio)) throw new Error(`Audio fixture does not exist: ${args.audio}`);
  const isolation = await initializeIsolation(args);
  let completed = false;
  try {
    const defaults = defaultSettings(args);
    const settings = await settingsStore.updateSettings(args.userData, defaults, defaults);
    const { settings: runtimeSettings, scan: setupScan, hardware } = await installIfNeeded(settings, args);
    const completedSettings = await settingsStore.markSetupComplete(args.userData, defaults);
    const completedRuntimeSettings = {
      ...runtimeSettings,
      setupComplete: completedSettings.setupComplete,
    };
    const generation = await runGeneration(args.userData, completedRuntimeSettings, args);
    const report = {
      ok: true,
      platform: process.platform,
      arch: process.arch,
      userData: args.userData,
      isolationRoot: args.isolationRoot,
      audio: args.audio,
      settings: completedRuntimeSettings,
      hardware: {
        selected: hardware.effectiveHardwareMode,
        runtime: hardware.selectedRuntimePack,
      },
      setup: {
        ready: setupReady(setupScan),
        pack: setupScan.standardPack?.id || "",
      },
      generation,
    };
    const reportPath = await writeReport(args.userData, report);
    log("ok", {
      jobId: generation.jobId,
      notes: generation.noteLines,
      partials: generation.partialChartEvents,
      notePartials: generation.partialChartEventsWithNotes,
      reportPath,
      reportIsTemporary: isolation.ownsRoot && smokePathSafety.isWithin(isolation.root, reportPath),
    });
    completed = true;
  } finally {
    if (completed && isolation.ownsRoot) {
      await cleanupOwnedIsolation(args, isolation);
      log("removed successful isolated run", isolation.root);
    } else if (!completed && isolation.ownsRoot) {
      console.error(`[smoke] retained failed-run isolation for diagnostics: ${isolation.root}`);
    }
  }
}

module.exports = { parseArgs, withGenerationTimeout };

if (require.main === module) {
  main().catch((err) => {
    console.error(`[smoke] failed: ${err.stack || err.message || err}`);
    process.exitCode = 1;
  });
}

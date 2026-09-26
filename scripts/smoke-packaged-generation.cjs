#!/usr/bin/env node
"use strict";

const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const demucsWorkspace = require("../electron/demucsWorkspace.cjs");

const { SUPPORTED_TARGETS } = require("../config/supported-targets.cjs");
const APP_ROOT = path.resolve(__dirname, "..");
const DEMO_AUDIO = path.join(APP_ROOT, "fixtures", "demo", "autochart-demo-30s.wav");
const ONNX_GENERATOR_ID = "autochart.fretformer.v1-onnx";
const ONNX_SMOKE_DIFFICULTY = "hard";
const ONNX_SMOKE_NOTE_SECTION = "HardSingle";
const ONNX_SMOKE_SEED = 12345;
const STDERR_TAIL_LIMIT = 16 * 1024;
const STDOUT_TAIL_LIMIT = 4 * 1024;
const SUPPORTED_HARDWARE = new Set(["auto", "cuda", "webgpu", "coreml", "cpu"]);

function usage() {
  return `
Usage: node scripts/smoke-packaged-generation.cjs --app-out <dir> --platform <linux|win32|darwin> --arch <arch> [options]

Options:
  --app-out <dir>          Unpacked artifact directory.
  --platform <platform>    linux, win32, or darwin.
  --arch <arch>            Target Node/ONNX Runtime architecture.
  --models-folder <dir>    Installed chart generation files folder for the target user.
  --audio <file>           Input audio. Default: fixtures/demo/autochart-demo-30s.wav.
  --hardware <mode>        auto, cuda, webgpu, coreml, or cpu. Default: cpu.
  --scratch-root <dir>     Parent directory for a unique smoke run.
  --check-only             Validate packaged paths without spawning the artifact.
  --help, -h               Show this help.
`.trim();
}

function parseArgs(argv) {
  const args = {
    appOut: "",
    platform: "",
    arch: "",
    modelsFolder: "",
    audio: DEMO_AUDIO,
    hardware: "cpu",
    scratchRoot: path.join(os.tmpdir(), "autochart-packaged-generation-smoke"),
    checkOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[index];
    };

    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--app-out") args.appOut = next();
    else if (arg === "--platform") args.platform = next();
    else if (arg === "--arch") args.arch = next();
    else if (arg === "--models-folder") args.modelsFolder = next();
    else if (arg === "--audio") args.audio = next();
    else if (arg === "--hardware") args.hardware = next();
    else if (arg === "--scratch-root") args.scratchRoot = next();
    else if (arg === "--check-only") args.checkOnly = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (args.help) return args;
  if (!args.appOut) throw new Error("--app-out is required.");
  if (!args.arch || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.arch)) {
    throw new Error("--arch must be a non-empty target architecture name.");
  }
  if (!SUPPORTED_TARGETS.some((target) => target.platform === args.platform && target.arch === args.arch)) {
    throw new Error(`Unsupported generation target: ${args.platform || "unknown"}-${args.arch || "unknown"}.`);
  }
  if (!SUPPORTED_HARDWARE.has(args.hardware)) {
    throw new Error("--hardware must be auto, cuda, webgpu, coreml, or cpu.");
  }

  args.appOut = path.resolve(args.appOut);
  args.audio = path.resolve(args.audio);
  args.scratchRoot = path.resolve(args.scratchRoot);
  args.modelsFolder = path.resolve(args.modelsFolder || defaultModelsFolder(args.platform));
  return args;
}

// This matches scripts/smoke-generate.cjs's defaultSettings() branches, but
// selects the requested target platform rather than this script's host.
function defaultModelsFolder(platform) {
  const home = os.homedir();
  if (platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Autochart", "Models");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Autochart", "Models");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "autochart", "models");
}

function log(message, detail = null) {
  const prefix = `[packaged-generation-smoke] ${message}`;
  if (detail == null) console.log(prefix);
  else console.log(`${prefix}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

function pathError(kind, label, target, error) {
  const suffix = error && error.code !== "ENOENT" ? ` (${error.message})` : "";
  return new Error(`${kind} ${label}: ${target}${suffix}`);
}

async function requireDirectory(target, label) {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch (error) {
    throw pathError("Missing", label, target, error);
  }
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${target}`);
  return target;
}

async function requireFile(target, label) {
  let stat;
  try {
    stat = await fs.stat(target);
  } catch (error) {
    throw pathError("Missing", label, target, error);
  }
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${target}`);
  return target;
}

async function isFile(target) {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

async function findMacBundle(appOut) {
  if (path.basename(appOut).endsWith(".app")) return appOut;

  let entries;
  try {
    entries = await fs.readdir(appOut, { withFileTypes: true });
  } catch (error) {
    throw pathError("Unable to inspect", "macOS app output directory", appOut, error);
  }
  const bundles = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => path.join(appOut, entry.name));

  if (!bundles.length) {
    throw new Error(`Missing macOS app bundle under ${appOut}; expected exactly one .app directory.`);
  }
  if (bundles.length > 1) {
    throw new Error(`Ambiguous macOS app bundles under ${appOut}: ${bundles.join(", ")}`);
  }
  return bundles[0];
}

async function discoverBundle(args) {
  await requireDirectory(args.appOut, "app output directory");

  const resourcesDir = args.platform === "darwin"
    ? path.join(await findMacBundle(args.appOut), "Contents", "Resources")
    : path.join(args.appOut, "resources");
  const executableSuffix = args.platform === "win32" ? ".exe" : "";
  const appDir = path.join(resourcesDir, "app");
  const engineRoot = path.join(appDir, "engine");
  const nodeModules = path.join(appDir, "node_modules");
  const onnxRuntimeDir = path.join(nodeModules, "onnxruntime-node");
  const onnxNativeDir = path.join(onnxRuntimeDir, "bin", "napi-v6", args.platform, args.arch);
  const bundle = {
    resourcesDir,
    appDir,
    appPackage: path.join(appDir, "package.json"),
    engineRoot,
    engineEntry: path.join(engineRoot, "bin", "autochart-engine.cjs"),
    engineManifest: path.join(engineRoot, "manifest.json"),
    nodeModules,
    onnxRuntimeDir,
    onnxRuntimePackage: path.join(onnxRuntimeDir, "package.json"),
    onnxNativeDir,
    nodeExecutable: path.join(resourcesDir, "node-runtime", `node${executableSuffix}`),
    ffmpegPath: path.join(resourcesDir, "ffmpeg", `ffmpeg${executableSuffix}`),
  };

  await requireDirectory(resourcesDir, "packaged resources directory");
  await requireDirectory(appDir, "packaged resources/app directory");
  await requireFile(bundle.appPackage, "packaged app package.json");
  await requireDirectory(engineRoot, "packaged engine directory");
  await requireFile(bundle.engineEntry, "packaged engine entry");
  await requireFile(bundle.engineManifest, "packaged engine manifest");
  await requireFile(bundle.nodeExecutable, "bundled Node executable");
  await requireFile(bundle.ffmpegPath, "bundled FFmpeg executable");
  await requireDirectory(nodeModules, "packaged node_modules directory");
  await requireDirectory(onnxRuntimeDir, "packaged ONNX Runtime directory");
  await requireFile(bundle.onnxRuntimePackage, "packaged ONNX Runtime package.json");
  await requireDirectory(onnxNativeDir, `packaged ONNX Runtime native directory for ${args.platform}/${args.arch}`);

  let nativeEntries;
  try {
    nativeEntries = await fs.readdir(onnxNativeDir, { withFileTypes: true });
  } catch (error) {
    throw pathError("Unable to inspect", "packaged ONNX Runtime native directory", onnxNativeDir, error);
  }
  if (!nativeEntries.some((entry) => entry.isFile())) {
    throw new Error(`Packaged ONNX Runtime native files are missing for ${args.platform}/${args.arch}: ${onnxNativeDir}`);
  }

  return bundle;
}

function assertNativeTarget(args) {
  if (args.platform !== process.platform || args.arch !== process.arch) {
    throw new Error(
      `Cannot execute packaged generation for target ${args.platform}/${args.arch} on host ${process.platform}/${process.arch}. Use --check-only for cross-platform structural checks.`
    );
  }
}

async function requireInstalledModels(modelsFolder) {
  await requireDirectory(modelsFolder, "installed chart generation files folder");
  const directManifest = path.join(modelsFolder, "manifest.json");
  const nestedManifest = path.join(modelsFolder, "fretformer-v1", "manifest.json");
  if (!(await isFile(directManifest)) && !(await isFile(nestedManifest))) {
    throw new Error(
      `Installed ONNX models manifest is missing. Expected ${nestedManifest} or ${directManifest}.`
    );
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function readJson(filePath, label) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read ${label}: ${filePath} (${error.message})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label}: ${filePath} (${error.message})`);
  }
}

async function loadPackagedGenerator(bundle, platform) {
  const manifest = await readJson(bundle.engineManifest, "packaged engine manifest");
  const generator = Array.isArray(manifest.generators)
    ? manifest.generators.find((candidate) => candidate && candidate.id === ONNX_GENERATOR_ID)
    : null;
  if (!generator) {
    throw new Error(`Packaged engine manifest has no ${ONNX_GENERATOR_ID} generator: ${bundle.engineManifest}`);
  }
  if (Array.isArray(generator.platforms) && !generator.platforms.includes(platform)) {
    throw new Error(`Packaged ONNX generator does not support ${platform}: ${bundle.engineManifest}`);
  }
  return generator;
}

function buildJob({ jobId, audioPath, audioSha256, outputDir, cacheDir, demucsWorkspacePath, generator, platform, modelsFolder, hardware }) {
  // Keep this aligned with engine/test/generate-onnx-smoke.cjs so the packaged
  // run exercises the fixed descriptor, CFG, timing, and transcriber settings.
  const knobs = {
    speed: null,
    chords: 3,
    technique: null,
    movement: null,
    repetition: null,
  };
  const guidanceScale = 2.5;
  const temperature = 0.9;
  const topP = 0.95;
  return {
    schemaVersion: 1,
    jobId,
    generatorId: ONNX_GENERATOR_ID,
    generatorLabel: generator.label,
    generator,
    engineVersion: "onnx-smoke",
    audioPath,
    audioSha256,
    originalAudioSha256: audioSha256,
    sourceTransform: {
      kind: "original",
      leadInSilenceSeconds: 0,
      leadInSilenceMs: 0,
      key: "lead-in:0",
      label: "No lead-in",
    },
    outputDir,
    cacheDir,
    demucsWorkspace: demucsWorkspacePath,
    title: "ONNX Smoke",
    metadata: { title: "ONNX Smoke", artist: "Autochart Smoke" },
    difficulty: ONNX_SMOKE_DIFFICULTY,
    stripSustains: false,
    generation: {
      generatorId: ONNX_GENERATOR_ID,
      presetId: "tight",
      presetName: "Tight",
      modified: true,
      controls: {
        difficulty: ONNX_SMOKE_DIFFICULTY,
        temperature,
        topP,
        stripSustains: false,
        timingDetector: "beat_this_custom_timing",
        seedMode: "fixed",
        seed: ONNX_SMOKE_SEED,
        knobs,
        guidanceScale,
      },
      resolved: {
        difficulty: ONNX_SMOKE_DIFFICULTY,
        temperature,
        topP,
        stripSustains: false,
        timingDetector: "beat_this_custom_timing",
        detector: "beat_this_custom_timing",
        timingRaw: true,
        bpmTolerance: 0,
        seed: ONNX_SMOKE_SEED,
        knobs,
        guidanceScale,
      },
    },
    hardwareMode: hardware,
    engine: {
      platform,
      runtime: generator.runtime || null,
      modelsFolder,
      modelRoots: [],
    },
    createdAt: Date.now(),
  };
}

async function createScratch(scratchRoot) {
  await fs.mkdir(scratchRoot, { recursive: true });
  return fs.mkdtemp(path.join(scratchRoot, "run-"));
}

function appendTail(current, chunk, limit) {
  const next = current + chunk.toString("utf8");
  return next.length > limit ? next.slice(-limit) : next;
}

function runPackagedEngine(bundle, jobPath) {
  return new Promise((resolve, reject) => {
    const counts = {
      jsonEvents: 0,
      nonJsonStdoutLines: 0,
      partialCharts: 0,
      partialChartsWithNotes: 0,
    };
    let stdoutBuffer = "";
    let stdoutTail = "";
    let stderrTail = "";
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const consumeLine = (raw) => {
      const line = raw.trim();
      if (!line) return;
      try {
        const event = JSON.parse(line);
        counts.jsonEvents += 1;
        if (!event || typeof event !== "object") return;
        if (event.type === "partial_chart") {
          counts.partialCharts += 1;
          if (Array.isArray(event.noteLines) && event.noteLines.length > 0) {
            counts.partialChartsWithNotes += 1;
          }
        }
      } catch {
        counts.nonJsonStdoutLines += 1;
        stdoutTail = appendTail(stdoutTail, `${line}\n`, STDOUT_TAIL_LIMIT);
      }
    };

    const child = spawn(bundle.nodeExecutable, [bundle.engineEntry, "generate", "--job", jobPath], {
      cwd: bundle.engineRoot,
      env: {
        ...process.env,
        AUTOCHART_ENGINE_ROOT: bundle.engineRoot,
        AUTOCHART_FFMPEG_PATH: bundle.ffmpegPath,
        NODE_PATH: bundle.nodeModules,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) consumeLine(line);
    });
    child.stderr.on("data", (chunk) => {
      stderrTail = appendTail(stderrTail, chunk, STDERR_TAIL_LIMIT);
    });
    child.once("error", (error) => {
      settle(
        reject,
        new Error(`Unable to start packaged Node at ${bundle.nodeExecutable}: ${error.message}`)
      );
    });
    child.once("close", (code, signal) => {
      if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);
      settle(resolve, { code, signal, counts, stderrTail, stdoutTail });
    });
  });
}

function childExitError(result) {
  const status = result.signal ? `signal ${result.signal}` : `code ${result.code}`;
  const stderr = result.stderrTail.trim() || "(no stderr output retained)";
  const stdout = result.stdoutTail.trim();
  return new Error(
    `Packaged engine exited with ${status}. stderr (last ${STDERR_TAIL_LIMIT} chars):\n${stderr}` +
      (stdout ? `\nstdout non-JSON tail:\n${stdout}` : "")
  );
}

function resolveChartPath(result, outputDir) {
  if (!result || typeof result.chartPath !== "string" || !result.chartPath.trim()) {
    throw new Error("Completed result.json has no chartPath.");
  }
  return path.isAbsolute(result.chartPath)
    ? result.chartPath
    : path.resolve(outputDir, result.chartPath);
}

function noteLineCount(chartText, noteSection) {
  let section = "";
  let count = 0;
  for (const raw of String(chartText || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    const header = line.match(/^\[(.+)]$/);
    if (header) {
      section = header[1];
      continue;
    }
    if (section === noteSection && /^\d+\s*=\s*N(?:\s|$)/.test(line)) count += 1;
  }
  return count;
}

async function validateGenerationOutput(outputDir, run) {
  const resultPath = path.join(outputDir, "result.json");
  await requireFile(resultPath, "completed result.json");
  const result = await readJson(resultPath, "completed result.json");
  if (result.status !== "completed") {
    throw new Error(`result.json is not completed (status: ${String(result.status || "missing")}; error: ${String(result.error || "")}).`);
  }

  const chartPath = resolveChartPath(result, outputDir);
  await requireFile(chartPath, "generated chartPath");
  let chartText;
  try {
    chartText = await fs.readFile(chartPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read generated chartPath: ${chartPath} (${error.message})`);
  }
  const noteLines = noteLineCount(chartText, ONNX_SMOKE_NOTE_SECTION);
  const problems = [];
  if (noteLines < 1) problems.push(`Generated chart has no ${ONNX_SMOKE_NOTE_SECTION} note lines: ${chartPath}`);
  if (run.counts.partialCharts < 1) problems.push("Packaged engine emitted no partial_chart events.");
  if (run.counts.partialChartsWithNotes < 1) {
    problems.push("Packaged engine emitted no partial_chart event with nonempty noteLines.");
  }

  log("generation counts", {
    jsonEvents: run.counts.jsonEvents,
    nonJsonStdoutLines: run.counts.nonJsonStdoutLines,
    partialCharts: run.counts.partialCharts,
    partialChartsWithNotes: run.counts.partialChartsWithNotes,
    generatedNoteSection: ONNX_SMOKE_NOTE_SECTION,
    noteLines,
  });
  if (problems.length) throw new Error(problems.join(" "));

  return { chartPath, noteLines };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const bundle = await discoverBundle(args);
  log("packaged paths", {
    resources: bundle.resourcesDir,
    app: bundle.appDir,
    node: bundle.nodeExecutable,
    engine: bundle.engineEntry,
    onnxRuntime: bundle.onnxRuntimeDir,
    onnxNative: bundle.onnxNativeDir,
    ffmpeg: bundle.ffmpegPath,
  });

  if (args.checkOnly) {
    log("check-only passed", { platform: args.platform, arch: args.arch });
    return;
  }

  assertNativeTarget(args);
  await requireFile(args.audio, "audio file");
  await requireInstalledModels(args.modelsFolder);

  let scratch = "";
  try {
    scratch = await createScratch(args.scratchRoot);
    const outputDir = path.join(scratch, "output");
    const cacheDir = path.join(scratch, "cache");
    const jobPath = path.join(scratch, "job.json");
    await Promise.all([
      fs.mkdir(outputDir, { recursive: true }),
      fs.mkdir(cacheDir, { recursive: true }),
    ]);

    const [generator, audioSha256] = await Promise.all([
      loadPackagedGenerator(bundle, args.platform),
      sha256File(args.audio),
    ]);
    const demucsWorkspacePath = await demucsWorkspace.resolveDemucsWorkspace(
      cacheDir,
      audioSha256,
      "demucs_default"
    );
    const job = buildJob({
      jobId: crypto.randomUUID(),
      audioPath: args.audio,
      audioSha256,
      outputDir,
      cacheDir,
      demucsWorkspacePath,
      generator,
      platform: args.platform,
      modelsFolder: args.modelsFolder,
      hardware: args.hardware,
    });
    await fs.writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
    log("scratch run", scratch);

    const run = await runPackagedEngine(bundle, jobPath);
    if (run.code !== 0 || run.signal) {
      log("generation counts", {
        jsonEvents: run.counts.jsonEvents,
        nonJsonStdoutLines: run.counts.nonJsonStdoutLines,
        partialCharts: run.counts.partialCharts,
        partialChartsWithNotes: run.counts.partialChartsWithNotes,
      });
      throw childExitError(run);
    }

    const output = await validateGenerationOutput(outputDir, run);
    log("generation completed", {
      chartPath: output.chartPath,
      noteSection: ONNX_SMOKE_NOTE_SECTION,
      noteLines: output.noteLines,
    });
    await fs.rm(scratch, { recursive: true, force: true });
    log("scratch cleaned", scratch);
    scratch = "";
  } catch (error) {
    if (scratch) console.error(`[packaged-generation-smoke] retained scratch after failure: ${scratch}`);
    throw error;
  }
}

main().catch((error) => {
  console.error(`[packaged-generation-smoke] FAILED: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});

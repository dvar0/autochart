#!/usr/bin/env node
// End-to-end smoke test for the ONNX generator
// (`autochart.fretformer.v1-onnx`).
//
// Drives the engine the same way the Electron app does, but headless: it
// builds a job.json whose shape mirrors `electron/engineManager.cjs`
// `generateChart`, spawns
//   `node engine/bin/autochart-engine.cjs generate --job <path>`,
// streams the engine's newline-delimited JSON stage events, and asserts that
// the run produces a real `notes.chart` with a non-empty note block for the
// requested difficulty and a `[SyncTrack]`, plus a `result.json` with
// `status:"completed"` and a valid `chartPath`.
//
// PASS = exit 0 + a written summary; FAIL = exit 1.
//
// Usage:
//   node engine/test/generate-onnx-smoke.cjs [--audio <path>]
//                                            [--models-folder <path>]
//                                            [--scratch <dir>]
//                                            [--difficulty <easy|medium|hard|expert>]
//                                            [--seed <int>]
//                                            [--keep-output]
//
// Defaults pick the shortest `song.ogg` from the model repo's customs folder
// when present, falling back to the in-repo 30s procedural demo WAV.

"use strict";

const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { pathToFileURL } = require("url");
const demucsWorkspace = require("../../electron/demucsWorkspace.cjs");

const APP_ROOT = path.resolve(__dirname, "..", "..");
const ENGINE_ROOT = path.join(APP_ROOT, "engine");
const ENGINE_BIN = path.join(ENGINE_ROOT, "bin", "autochart-engine.cjs");
const ONNX_GENERATOR_ID = "autochart.fretformer.v1-onnx";

// Optional local library of <song>/song.ogg folders to pick test audio from.
const MODEL_REPO_CUSTOMS = process.env.AUTOCHART_TEST_AUDIO_ROOT || "";
const REPO_DEMO_AUDIO = path.join(APP_ROOT, "fixtures", "demo", "autochart-demo-30s.wav");

function log(message, detail) {
  const text = `[onnx-smoke] ${message}`;
  if (detail == null) console.log(text);
  else console.log(`${text}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

function parseArgs(argv) {
  const args = {
    audio: "",
    modelsFolder: "",
    scratch: "",
    difficulty: "hard",
    seed: 12345,
    keepOutput: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--audio") args.audio = path.resolve(next());
    else if (arg === "--models-folder") args.modelsFolder = path.resolve(next());
    else if (arg === "--scratch") args.scratch = path.resolve(next());
    else if (arg === "--difficulty") args.difficulty = String(next());
    else if (arg === "--seed") args.seed = Number.parseInt(next(), 10);
    else if (arg === "--keep-output") args.keepOutput = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!["easy", "medium", "hard", "expert"].includes(args.difficulty)) {
    throw new Error(`--difficulty must be easy|medium|hard|expert (got ${args.difficulty})`);
  }
  if (!Number.isInteger(args.seed) || args.seed < 0) {
    throw new Error(`--seed must be a non-negative integer (got ${args.seed})`);
  }
  return args;
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function assertSelectedModelsFolder(modelsFolder) {
  if (!modelsFolder) return;
  const nested = path.join(modelsFolder, "fretformer-v1", "manifest.json");
  const direct = path.join(modelsFolder, "manifest.json");
  if (!(await fileExists(nested)) && !(await fileExists(direct))) {
    throw new Error(
      `--models-folder does not contain a Fretformer manifest: ${modelsFolder}. ` +
      "Refusing to fall back to development models."
    );
  }
}

async function pickDefaultAudio() {
  try {
    if (!MODEL_REPO_CUSTOMS) throw new Error("no test audio root configured");
    const entries = await fs.readdir(MODEL_REPO_CUSTOMS, { withFileTypes: true });
    const candidates = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const ogg = path.join(MODEL_REPO_CUSTOMS, ent.name, "song.ogg");
      if (await fileExists(ogg)) {
        const stat = await fs.stat(ogg);
        candidates.push({ path: ogg, size: stat.size });
      }
    }
    if (candidates.length) {
      candidates.sort((a, b) => a.size - b.size);
      return candidates[0].path;
    }
  } catch {
    /* fall through */
  }
  if (await fileExists(REPO_DEMO_AUDIO)) return REPO_DEMO_AUDIO;
  throw new Error(
    `No audio fixture found. Pass --audio <path>, or set AUTOCHART_TEST_AUDIO_ROOT to a folder of <song>/song.ogg dirs. Tried ${REPO_DEMO_AUDIO}.`
  );
}

async function sha256File(p) {
  const h = crypto.createHash("sha256");
  const handle = await fs.open(p, "r");
  try {
    for await (const chunk of handle.createReadStream()) h.update(chunk);
  } finally {
    await handle.close();
  }
  return h.digest("hex");
}

// Build a job.json that mirrors what engineManager.generateChart writes for
// the ONNX generator. The generation payload mirrors the shape that the
// renderer's `buildGenerationSettings` + engineManager's
// `normalizeGenerationPayload` produce: `controls.knobs` (resolved null-or-int
// map) + `controls.guidanceScale` + the scalar fields the engine reads via
// `normalizeTranscriberSettings`.
function buildJob({
  jobId,
  audioPath,
  audioSha256,
  outputDir,
  cacheDir,
  demucsWorkspacePath,
  difficulty,
  seed,
  generator,
  modelsFolder,
}) {
  // A representative non-auto knob (chords=3) so CFG + descriptor tokens are
  // actually exercised. Guidance > 1 with knobsActive triggers CFG.
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
    difficulty,
    stripSustains: false,
    generation: {
      generatorId: ONNX_GENERATOR_ID,
      presetId: "tight",
      presetName: "Tight",
      modified: true,
      controls: {
        difficulty,
        temperature,
        topP,
        stripSustains: false,
        timingDetector: "beat_this_custom_timing",
        seedMode: "fixed",
        seed,
        knobs,
        guidanceScale,
      },
      resolved: {
        difficulty,
        temperature,
        topP,
        stripSustains: false,
        timingDetector: "beat_this_custom_timing",
        detector: "beat_this_custom_timing",
        timingRaw: true,
        bpmTolerance: 0,
        seed,
        knobs,
        guidanceScale,
      },
    },
    engine: {
      platform: process.platform,
      runtime: generator.runtime || null,
      modelsFolder: modelsFolder || "",
      modelRoots: modelsFolder ? [modelsFolder] : [],
    },
    createdAt: Date.now(),
  };
}

function runEngine(jobPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENGINE_BIN, "generate", "--job", jobPath], {
      cwd: ENGINE_ROOT,
      env: {
        ...process.env,
        AUTOCHART_ENGINE_ROOT: ENGINE_ROOT,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const events = [];
    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() || "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let evt = null;
        try {
          evt = JSON.parse(line);
        } catch {
          evt = { type: "log", stream: "stdout", message: line };
        }
        events.push(evt);
        if (evt.type === "stage") {
          log(`stage ${evt.stage}`, `${evt.status}${evt.cache === "hit" ? " (cache hit)" : ""}`);
        } else if (evt.type === "partial_chart") {
          log("partial_chart", {
            committedBeats: evt.committedBeats,
            totalBeats: evt.totalBeats,
            tokens: evt.tokenCount,
            done: Boolean(evt.done),
          });
        } else if (evt.type === "error") {
          log("engine error event", evt.message);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split(/\r?\n/);
      stderrBuf = lines.pop() || "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        events.push({ type: "log", stream: "stderr", message: line });
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, events, stderrTail: stderrBuf });
    });
  });
}

// Minimal .chart section splitter + validator. Returns
// { sections, noteTicks, syncTickPairs, resolution }. Ticks are checked for
// monotonicity (non-decreasing) inside each section.
function parseChartForSmoke(text, noteSection = "ExpertSingle") {
  const sections = {};
  let current = null;
  let body = null;
  for (const raw of String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const header = line.match(/^\[(.+)]$/);
    if (header) {
      current = header[1];
      body = [];
      sections[current] = body;
      continue;
    }
    if (!current || line === "{" || line === "}") continue;
    body.push(line);
  }
  let resolution = 192;
  for (const line of sections.Song || []) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() === "Resolution") {
      resolution = Number.parseInt(line.slice(eq + 1).trim(), 10) || 192;
    }
  }
  const parseEvents = (lines, prefix) => {
    const out = [];
    let lastTick = -Infinity;
    for (const line of lines || []) {
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const tick = Number.parseInt(line.slice(0, eq).trim(), 10);
      if (!Number.isFinite(tick)) continue;
      const rest = line.slice(eq + 1).trim();
      const parts = rest.split(/\s+/);
      if (parts[0] !== prefix) continue;
      if (tick < lastTick) {
        throw new Error(`Non-monotonic tick at line: ${line} (tick=${tick}, prev=${lastTick})`);
      }
      out.push({ tick, raw: rest });
      lastTick = tick;
    }
    return out;
  };
  const noteEvents = parseEvents(sections[noteSection], "N");
  const syncBpms = parseEvents(sections.SyncTrack, "B");
  return { sections, resolution, noteEvents, syncBpms, noteSection };
}

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

async function loadGenerator() {
  const manifest = await readJson(path.join(ENGINE_ROOT, "manifest.json"));
  const gen = (manifest.generators || []).find((g) => g.id === ONNX_GENERATOR_ID);
  if (!gen) throw new Error(`ONNX generator missing from ${ENGINE_ROOT}/manifest.json`);
  return gen;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node engine/test/generate-onnx-smoke.cjs [--audio <path>] [--models-folder <path>] [--scratch <dir>] [--difficulty <hard>] [--seed <int>] [--keep-output]");
    return;
  }
  await assertSelectedModelsFolder(args.modelsFolder);
  const audio = args.audio || (await pickDefaultAudio());
  if (!(await fileExists(audio))) throw new Error(`Audio not found: ${audio}`);
  log("audio", audio);

  const scratchRoot = args.scratch || path.join(os.tmpdir(), "autochart-onnx-smoke");
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const scratch = path.join(scratchRoot, runId);
  const cacheDir = path.join(scratch, "cache");
  const outputDir = path.join(scratch, "output");
  const jobPath = path.join(scratch, "job.json");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });

  const generator = await loadGenerator();
  const audioSha256 = await sha256File(audio);
  const demucsWorkspacePath = await demucsWorkspace.resolveDemucsWorkspace(
    cacheDir,
    audioSha256,
    "demucs_default"
  );
  const jobId = crypto.randomUUID();
  const job = buildJob({
    jobId,
    audioPath: path.resolve(audio),
    audioSha256,
    outputDir,
    cacheDir,
    demucsWorkspacePath,
    difficulty: args.difficulty,
    seed: args.seed,
    generator,
    modelsFolder: args.modelsFolder,
  });
  await fs.writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  log("job", jobPath);

  const t0 = Date.now();
  const { code, events, stderrTail } = await runEngine(jobPath);
  const wallSeconds = (Date.now() - t0) / 1000;

  if (code !== 0) {
    log("engine exited non-zero", code);
    if (stderrTail) console.log(`[onnx-smoke] stderr tail:\n${stderrTail.slice(-4000)}`);
    throw new Error(`Engine exited with code ${code}`);
  }

  // Stage-event accounting.
  const stageEvents = events.filter((e) => e.type === "stage");
  const stagesSeen = Array.from(
    stageEvents
      .reduce((m, e) => {
        const key = `${e.stage}:${e.status}`;
        m.set(key, (m.get(key) || 0) + 1);
        return m;
      }, new Map())
      .keys()
  );
  const expectedStages = ["audio", "demucs", "timing", "transcription", "chart", "done"];
  const completedStages = new Set(
    stageEvents.filter((e) => e.status === "completed").map((e) => e.stage)
  );
  const missing = expectedStages.filter((s) => !completedStages.has(s));
  if (missing.length) {
    throw new Error(`Missing completed stage events: ${missing.join(", ")}. Saw: ${stagesSeen.join(", ")}`);
  }
  log("stages seen", stagesSeen);

  // result.json
  const resultPath = path.join(outputDir, "result.json");
  if (!(await fileExists(resultPath))) throw new Error(`Engine did not write result.json: ${resultPath}`);
  const result = await readJson(resultPath);
  if (result.status !== "completed") {
    throw new Error(`result.json status != completed (got ${result.status}). error: ${result.error || ""}`);
  }
  if (!result.chartPath || !(await fileExists(result.chartPath))) {
    throw new Error(`result.json has no readable chartPath: ${result.chartPath || "missing"}`);
  }
  log("result.chartPath", result.chartPath);

  // notes.chart validation
  const chartText = await fs.readFile(result.chartPath, "utf8");
  const noteSection = `${args.difficulty[0].toUpperCase()}${args.difficulty.slice(1)}Single`;
  const parsed = parseChartForSmoke(chartText, noteSection);
  if (!parsed.sections[noteSection]) {
    throw new Error(`Chart has no [${noteSection}] section.`);
  }
  if (!parsed.sections.SyncTrack) {
    throw new Error("Chart has no [SyncTrack] section.");
  }
  if (parsed.noteEvents.length === 0) {
    throw new Error(`[${noteSection}] note block is empty.`);
  }
  if (parsed.syncBpms.length === 0) {
    throw new Error(`[SyncTrack] has no BPM anchors.`);
  }
  log("chart", {
    resolution: parsed.resolution,
    noteLines: parsed.noteEvents.length,
    syncAnchors: parsed.syncBpms.length,
    firstNoteTick: parsed.noteEvents[0].tick,
    lastNoteTick: parsed.noteEvents[parsed.noteEvents.length - 1].tick,
    firstBpm: parsed.syncBpms[0] ? parsed.syncBpms[0].raw : "",
  });

  // ---- partial_chart (live note-streaming) accounting -------------------
  // The ONNX generator must emit MORE THAN ONE partial_chart for a real song
  // (cadence every ~4 beats), at least one non-final event must carry a
  // non-empty noteLines array, the timing block must appear on the first
  // event, and every noteLines tick must be a finite int within the final
  // chart's tick range. This callback is observe-only, so the final chart's
  // note count must be unaffected.
  const partials = events.filter((e) => e.type === "partial_chart");
  const partialCount = partials.length;
  const finalPartial = partials.length ? partials[partials.length - 1] : null;
  const midPartials = partials.filter((e) => !e.done && !e.complete);
  const firstWithNotes = midPartials.find((e) => Array.isArray(e.noteLines) && e.noteLines.length > 0);
  const firstWithTiming = partials.find((e) => e.timing && Array.isArray(e.timing.syncLines) && e.timing.syncLines.length);

  const finalTicks = parsed.noteEvents.map((n) => n.tick);
  const finalMinTick = finalTicks.length ? Math.min(...finalTicks) : 0;
  const finalMaxTick = finalTicks.length ? Math.max(...finalTicks) : 0;
  let partialTickMin = Infinity, partialTickMax = -Infinity, partialTickBad = 0;
  for (const e of partials) {
    if (!Array.isArray(e.noteLines)) continue;
    for (const line of e.noteLines) {
      const tick = Number(line && line[0]);
      if (!Number.isFinite(tick)) { partialTickBad += 1; continue; }
      if (tick < partialTickMin) partialTickMin = tick;
      if (tick > partialTickMax) partialTickMax = tick;
    }
  }

  const streaming = { ok: true, checked: {} };
  const checkStream = (label, condition, detail) => {
    streaming.checked[label] = { condition: Boolean(condition), detail };
    if (!condition) streaming.ok = false;
  };
  checkStream("partial_chart count > 1", partialCount > 1, `${partialCount} events`);
  checkStream("a non-final event has noteLines.length > 0", Boolean(firstWithNotes), firstWithNotes ? `${firstWithNotes.noteLines.length} notes at seq ${firstWithNotes.sequence}` : "none");
  checkStream("first event carries timing.syncLines", Boolean(firstWithTiming), firstWithTiming ? `${firstWithTiming.timing.syncLines.length} sync lines` : "missing");
  checkStream("final partial marked done/complete", Boolean(finalPartial && (finalPartial.done || finalPartial.complete)), `done=${finalPartial && finalPartial.done} complete=${finalPartial && finalPartial.complete}`);
  checkStream("all partial ticks finite", partialTickBad === 0, `${partialTickBad} bad`);
  // Partial ticks should sit within the final chart's tick span (the live
  // callback only renders committed beats, so it can never run past the end).
  checkStream("partial ticks within final range", Number.isFinite(partialTickMin) && partialTickMin >= 0 && partialTickMax <= finalMaxTick + parsed.resolution, `partial[${partialTickMin},${partialTickMax}] final[${finalMinTick},${finalMaxTick}]`);
  log("partial_chart streaming", {
    count: partialCount,
    midWithNotes: firstWithNotes ? firstWithNotes.noteLines.length : 0,
    firstTimingSyncLines: firstWithTiming ? firstWithTiming.timing.syncLines.length : 0,
    tickRange: `[${partialTickMin},${partialTickMax}] within final [${finalMinTick},${finalMaxTick}]`,
    finalNoteLines: parsed.noteEvents.length,
    ok: streaming.ok,
  });
  if (!streaming.ok) {
    throw new Error(`partial_chart streaming assertions failed: ${JSON.stringify(streaming.checked)}`);
  }

  // Beat count comes from the report (or result.metrics.timing.nBeats).
  const reportPath = result.reportPath && (await fileExists(result.reportPath)) ? result.reportPath : null;
  const report = reportPath ? await readJson(reportPath) : null;
  const beats =
    report?.timing?.nBeats ??
    result?.metrics?.timing?.nBeats ??
    null;
  const tempoBpm =
    report?.timing?.tempoBpm ??
    result?.metrics?.timing?.tempoBpm ??
    null;

  // Settings-plumbing proof: the ONNX adapter writes the resolved descriptor
  // knobs / guidance / difficulty / temperature / top_p / seed back into the
  // report. Asserting them here confirms the whole UI -> service -> IPC ->
  // engineManager -> engine -> adapter chain delivered the values under the
  // names the adapter reads.
  const plumbing = {
    ok: true,
    checked: {},
  };
  const check = (label, actual, expected) => {
    plumbing.checked[label] = { actual, expected };
    if (actual !== expected) {
      plumbing.ok = false;
      plumbing.checked[label].mismatch = true;
    }
  };
  if (report) {
    check("difficulty", report.difficulty, args.difficulty);
    check("temperature", report.temperature, 0.9);
    check("top_p", report.top_p, 0.95);
    check("seed", report.seed, args.seed);
    check("strip_sustains", report.strip_sustains, false);
    if (report.descriptor_knobs) {
      check("descriptor_knobs.chords", report.descriptor_knobs.chords, 3);
    }
    if (report.guidance_scale != null) {
      check("guidance_scale", report.guidance_scale, 2.5);
    }
  }

  // Save artifacts + summary under scratch.
  const chartCopy = path.join(scratch, "notes.chart");
  await fs.copyFile(result.chartPath, chartCopy);
  const summary = {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    audio,
    generatorId: ONNX_GENERATOR_ID,
    jobId,
    wallSeconds,
    stages: stagesSeen,
    chart: {
      path: result.chartPath,
      copy: chartCopy,
      resolution: parsed.resolution,
      noteLineCount: parsed.noteEvents.length,
      syncAnchorCount: parsed.syncBpms.length,
      firstNoteTick: parsed.noteEvents[0].tick,
      lastNoteTick: parsed.noteEvents[parsed.noteEvents.length - 1].tick,
      ticksMonotonic: true,
    },
    beats,
    tempoBpm,
    plumbing,
    result: {
      status: result.status,
      chartPath: result.chartPath,
      reportPath: reportPath || null,
      metrics: result.metrics || null,
    },
  };
  const summaryPath = path.join(scratch, "summary.json");
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  log("summary", {
    notes: parsed.noteEvents.length,
    beats,
    tempoBpm,
    wallSeconds: wallSeconds.toFixed(1),
    summaryPath,
    plumbingOk: plumbing.ok,
  });

  if (!plumbing.ok) {
    throw new Error(`Settings plumbing mismatch: ${JSON.stringify(plumbing.checked)}`);
  }

  if (!args.keepOutput) {
    // Keep the summary + chart copy (small); drop the bulky engine
    // output/cache to avoid filling /tmp. The summary retains absolute paths
    // for forensics if --keep-output is ever passed.
    try {
      await fs.rm(path.join(outputDir), { recursive: true, force: true });
      await fs.rm(path.join(cacheDir), { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  }
}

main().catch(async (err) => {
  console.error(`[onnx-smoke] FAILED: ${err.stack || err.message || err}`);
  process.exit(1);
});

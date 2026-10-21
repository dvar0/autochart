#!/usr/bin/env node
// End-to-end check for running Fretformer and Fretformer v2 DPO on one song.
//
// Drives electron/engineManager.cjs generateChart (the same path the app's IPC
// handler uses) with a scratch user-data/cache directory, then asserts:
//   1. Fretformer generates normally.
//   2. Fretformer v2 DPO on the same audio runs its own htdemucs_6s separation
//      but reuses the beat map, so both charts carry the same [SyncTrack] and
//      can share a final chart. The separation reports both stem sets. It
//      writes section events and pairs its solo markers.
//   3. A second v2 DPO run hits both caches; a set knob turns on CFG and lands
//      in the prefix; all-Auto runs without CFG. Solos off asks for no solos.
//   4. A beat map left in a separation workspace by an older app is adopted
//      into the shared per-audio cache instead of being re-detected.
//   5. `--force-solo-audio <song>`: "Force a solo" on a song the model charts
//      without a solo (e.g. Termonuclear) ends up with exactly one.
//
// `--only v1` runs step 1 and writes the chart to <scratch>/v1.chart, which is
// how the v1 regression gate compares this branch against another checkout:
//   node engine/test/generator-switch-e2e.cjs --only v1 --app-root <other checkout> ...
// `--only v2` runs the marker-model steps on their own (it then separates and
// detects itself). AUTOCHART_E2E_V2_ID points those steps at another marker
// generator, such as autochart.fretformer.v2-dpo-fim-onnx.
//
// Usage:
//   node engine/test/generator-switch-e2e.cjs --audio <song> --scratch <dir>
//        [--models-folder <dir>] [--hardware cpu|auto] [--seed <int>]
//        [--only v1|v2] [--app-root <checkout>] [--force-solo-audio <song>]

"use strict";

const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const { pathToFileURL } = require("url");

const DEFAULT_APP_ROOT = path.resolve(__dirname, "..", "..");
const V1_ID = "autochart.fretformer.v1-onnx";
// AUTOCHART_E2E_V2_ID runs the marker steps against another installed generator
// (e.g. autochart.fretformer.v2-dpo-fim-onnx).
const V2_ID = process.env.AUTOCHART_E2E_V2_ID || "autochart.fretformer.v2-dpo-onnx";

function parseArgs(argv) {
  const args = {
    audio: "",
    scratch: "",
    modelsFolder: path.join(os.homedir(), ".local", "share", "autochart", "models"),
    hardware: "auto",
    seed: 20261005,
    only: "",
    appRoot: DEFAULT_APP_ROOT,
    forceSoloAudio: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--audio") args.audio = value;
    else if (key === "--scratch") args.scratch = value;
    else if (key === "--models-folder") args.modelsFolder = value;
    else if (key === "--hardware") args.hardware = value;
    else if (key === "--seed") args.seed = Number(value);
    else if (key === "--only") args.only = value;
    else if (key === "--app-root") args.appRoot = path.resolve(value);
    else if (key === "--force-solo-audio") args.forceSoloAudio = value;
    else continue;
    i += 1;
  }
  if (!args.audio || !args.scratch) throw new Error("--audio and --scratch are required");
  return args;
}

function log(message, detail) {
  console.log(detail == null ? `[switch-e2e] ${message}` : `[switch-e2e] ${message}: ${JSON.stringify(detail)}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`ok - ${message}`);
}

function section(chartText, name) {
  const match = String(chartText).match(new RegExp(`\\[${name}\\]\\s*\\{([\\s\\S]*?)\\}`));
  return match ? match[1].trim() : "";
}

function noteLines(chartText) {
  return (String(chartText || "").match(/^\s*\d+\s+=\s+N\s+/gm) || []).length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const engineManager = require(path.join(args.appRoot, "electron", "engineManager.cjs"));
  // A packaged app (release/linux-unpacked/resources/app) ships no src/; its
  // settings module is the one in this checkout.
  const settingsPath = path.join(args.appRoot, "src", "data", "generationSettings.js");
  const generationModule = await import(pathToFileURL(
    require("fs").existsSync(settingsPath) ? settingsPath : path.join(DEFAULT_APP_ROOT, "src", "data", "generationSettings.js")
  ).href);
  const userData = path.resolve(args.scratch, "userdata");
  const settings = {
    modelsFolder: path.resolve(args.modelsFolder),
    cacheFolder: path.resolve(args.scratch, "cache"),
    hardwareMode: args.hardware,
  };
  await fs.mkdir(userData, { recursive: true });
  await fs.mkdir(settings.cacheFolder, { recursive: true });
  const manifest = await engineManager.loadManifest();
  const generatorFor = (id) => {
    const generator = manifest.generators.find((item) => item.id === id);
    if (!generator) throw new Error(`generator ${id} is not in ${args.appRoot}/engine/manifest.json`);
    return generator;
  };

  async function run(label, generatorId, controlsPatch, audio = args.audio) {
    const generator = generatorFor(generatorId);
    const controls = {
      ...generationModule.DEFAULT_GENERATION_CONTROLS,
      seedMode: "fixed",
      seed: String(args.seed),
      ...controlsPatch,
    };
    const { generation, difficulty } = generationModule.buildGenerationSettings({ generatorId, controls, generator });
    const logs = [];
    const sender = {
      isDestroyed: () => false,
      send(channel, payload) {
        if (channel === "engine:jobEvent" && payload?.type === "log") logs.push(String(payload.message || ""));
      },
    };
    const started = Date.now();
    const result = await engineManager.generateChart(userData, sender, {
      generatorId,
      audio: { path: path.resolve(audio), name: path.basename(audio), mime: "audio/ogg" },
      difficulty,
      stripSustains: false,
      generation,
      demucsSeparation: { id: "demucs_default", name: "Default separation" },
      metadata: { title: path.basename(path.dirname(path.resolve(audio))), artist: "switch-e2e" },
      title: label,
    }, { settings });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const runtime = result.provenance?.runtime || {};
    log(`${label} done in ${seconds}s`, {
      notes: noteLines(result.chartText),
      cached: runtime.cachedStages,
      devices: runtime.devices,
      guidance: result.report?.guidance_scale ?? null,
      channels: result.report?.featureBuild?.channelOrder,
    });
    return { result, logs };
  }

  // `prior` is a Fretformer result on the same audio. The marker model then
  // separates with htdemucs_6s itself and reuses that beat map.
  async function checkMarker({ prior = null } = {}) {
    const marker = await run("marker expert", V2_ID, { difficulty: "expert" });
    const text = marker.result.chartText;
    const report = marker.result.report;
    const runtime = marker.result.provenance.runtime;
    assert(noteLines(text) > 0, "marker chart has notes");
    assert(
      JSON.stringify(report.featureBuild.channelOrder) === JSON.stringify(["full", "drums", "bass", "vocals", "guitar", "other"]),
      "marker model builds six mel channels"
    );
    assert(report.featureBuild.demucsModel === "htdemucs_6s", "marker model separated with htdemucs_6s");
    assert(report.guidance_scale == null, "all-Auto marker run skips CFG");
    assert(
      JSON.stringify(Object.keys(report.descriptor_knobs)) === JSON.stringify(["speed", "chords", "hopos", "taps", "movement"]),
      "marker model reports its knob set"
    );
    if (prior) {
      assert(!runtime.cachedStages.includes("demucs"), "marker model ran its own separation");
      assert(runtime.cachedStages.includes("timing"), "marker model reused the song's beat map");
      assert(section(text, "SyncTrack") === section(prior.chartText, "SyncTrack"), "Fretformer and the marker model share one [SyncTrack]");
      const stemSets = marker.result.sourceSeparation?.stemSets || {};
      assert(Boolean(stemSets.htdemucs && stemSets.htdemucs_6s), "separation reports both stem sets");
      assert(Object.keys(stemSets.htdemucs_6s.stems).sort().join(",") === "bass,drums,guitar,other,vocals", "six-stem set has guitar and folded other");
      assert(
        marker.result.sourceSeparation.stems?.other?.path === prior.sourceSeparation?.stems?.other?.path,
        "the separation's Fretformer stems are unchanged"
      );
    }
    assert(JSON.stringify(report.prefix.cond.slice(-2)) === "[151,155]", "marker prefix ends with solo ON + section ON");
    const sections = report.structure.sections;
    const eventLines = section(text, "Events").split("\n").filter((line) => /= E "section /.test(line));
    assert(sections.length > 0 && eventLines.length === sections.length, `marker model writes its ${sections.length} sections to [Events]`);
    const track = section(text, "ExpertSingle");
    const starts = (track.match(/= E solo$/gm) || []).length;
    const ends = (track.match(/= E soloend$/gm) || []).length;
    assert(starts === report.structure.solos.length && ends === starts, `marker solo markers are paired (${starts} solos)`);
    log("marker structure", { solos: report.structure.solos, sections: sections.map(([beat, type]) => `${beat}:${type}`).join(" ") });

    const noSolos = await run("marker expert solos off", V2_ID, { difficulty: "expert", solos: false });
    assert(noSolos.result.report.prefix.cond.slice(-2).join(",") === "150,155", "Solos off sends the solo OFF flag");
    assert(!/= E solo/.test(section(noSolos.result.chartText, "ExpertSingle")), "Solos off writes no solo markers");

    const knobbed = await run("marker hard chords=5", V2_ID, { difficulty: "hard", knobChords: "5", guidanceScale: "2" });
    const knobbedRuntime = knobbed.result.provenance.runtime;
    assert(knobbedRuntime.cachedStages.includes("demucs") && knobbedRuntime.cachedStages.includes("timing"), "second marker run hits both caches");
    assert(knobbed.result.report.guidance_scale === 2, "a set knob turns on CFG");
    assert(knobbed.result.report.prefix.cond.includes(110 + 1 * 8 + 5), "chords bin 5 is in the conditional prefix");
    assert(knobbed.result.report.prefix.uncond.slice(-2).join(",") === "151,155", "the unconditional prefix keeps the structure flags");
    assert(noteLines(knobbed.result.chartText) > 0, "CFG chart has notes");
    return marker;
  }

  async function checkForceSolo() {
    const plain = await run("v2 expert (force-solo song)", V2_ID, { difficulty: "expert" }, args.forceSoloAudio);
    const forced = await run("v2 expert force a solo", V2_ID, { difficulty: "expert", forceSolo: true }, args.forceSoloAudio);
    const structure = forced.result.report.structure;
    assert(structure.force_solo === true, "Force a solo reaches the engine");
    const track = section(forced.result.chartText, "ExpertSingle");
    const starts = (track.match(/= E solo$/gm) || []).length;
    assert(starts >= 1 && starts === (track.match(/= E soloend$/gm) || []).length, "the forced chart has a paired solo");
    if (plain.result.report.structure.solos.length === 0) {
      assert(structure.forced_solo && structure.solos.length === 1, "no natural solo, so exactly one was forced");
      assert(structure.solos[0][0] === structure.forced_solo.start.beat, "the solo starts at the forced beat");
    } else {
      log("this song got a natural solo; nothing to force");
    }
    assert(forced.logs.some((line) => line.startsWith("force-solo:")) === Boolean(structure.forced_solo), "force-solo logs what it did");
    log("forced solo", { forced: structure.forced_solo, solos: structure.solos });
  }

  if (args.only === "v2") {
    await checkMarker();
    if (args.forceSoloAudio) await checkForceSolo();
    log("PASS");
    return;
  }

  const v1 = await run("v1 expert", V1_ID, { difficulty: "expert" });
  assert(noteLines(v1.result.chartText) > 0, "v1 chart has notes");
  await fs.writeFile(path.join(args.scratch, "v1.chart"), v1.result.chartText);
  if (args.only === "v1") return;

  await checkMarker({ prior: v1.result });

  // Step 4: move the shared map back into the separation, as an older app left it.
  const timingRoot = path.join(settings.cacheFolder, "engine", "features", "fretformer_timing_v1", v1.result.audioSha256);
  const keys = await fs.readdir(timingRoot);
  assert(keys.length === 1, "one shared beat map for this song and setting");
  const sharedDir = path.join(timingRoot, keys[0]);
  const legacyDir = path.join(settings.cacheFolder, "engine", "features", "fretformer_demucs_v1", v1.result.audioSha256, "demucs_default", "timing", keys[0]);
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.rename(path.join(sharedDir, "beats.json"), path.join(legacyDir, "beats.json"));
  await fs.rmdir(sharedDir);
  const adopted = await run("v1 expert (legacy beat map)", V1_ID, { difficulty: "expert" });
  assert(adopted.logs.some((line) => line.startsWith("timing: adopted separation beat map")), "legacy beat map was adopted");
  assert(adopted.result.provenance.runtime.cachedStages.includes("timing"), "adopted map counts as a timing cache hit");
  // Titles differ per run, so compare the timing and note sections.
  assert(
    section(adopted.result.chartText, "SyncTrack") === section(v1.result.chartText, "SyncTrack") &&
      section(adopted.result.chartText, "ExpertSingle") === section(v1.result.chartText, "ExpertSingle"),
    "v1 rerun with the adopted map reproduces the first chart"
  );
  log("PASS");
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});

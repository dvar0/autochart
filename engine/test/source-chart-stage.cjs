"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const onnx = require("../lib/onnx");
const { onnxDetectBeats } = require("../bin/autochart-engine.cjs");
const { writeChartText } = require("../../shared/chartWriter.cjs");
const hash = text => crypto.createHash("sha256").update(text).digest("hex");

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-source-stage-"));
  const saved = { loadModelsManifest: onnx.loadModelsManifest, decodeDurationSeconds: onnx.decodeDurationSeconds };
  let decodes = 0;
  onnx.loadModelsManifest = async () => { throw new Error("Imported sync must not load beat models"); };
  onnx.decodeDurationSeconds = async (...args) => {
    decodes += 1;
    return saved.decodeDurationSeconds(...args);
  };
  try {
    const jobDir = path.join(root, "job");
    const jobPath = path.join(jobDir, "job.json");
    const chartPath = path.join(jobDir, "source_chart", "notes.chart");
    const job = {
      audioPath: path.resolve(__dirname, "../../fixtures/demo/autochart-demo-30s.wav"),
      outputDir: path.join(jobDir, "output"), cacheDir: path.join(root, "cache"),
      demucsWorkspace: path.join(root, "cache", "demucs"), sourceChart: { path: chartPath },
    };
    for (const dir of [path.dirname(chartPath), job.outputDir, job.demucsWorkspace]) await fs.mkdir(dir, { recursive: true });
    const source = writeChartText([[480, 0, 240]], {
      resolution: 480, offset: -0.25, syncLines: ["0 = B 120000", "1920 = TS 3", "1920 = B 150000"],
    }).text;
    await fs.writeFile(chartPath, source);
    job.sourceChart.sha256 = hash(source);
    const options = { generator: {}, settings: { detector: "source_chart", smoothing: { enabled: false } } };
    const first = await onnxDetectBeats(job, jobPath, options);
    assert.equal(first.beats.resolution, 480);
    assert.equal(first.beats.offset, -0.25);
    assert.equal(first.beats.beatTimes[0], -0.25);
    assert.deepEqual(first.beats.syncLines, ["0 = B 120000", "1920 = TS 3", "1920 = B 150000"]);
    const cached = await onnxDetectBeats(job, jobPath, options);
    assert.equal(cached.cacheHit, true);
    assert.deepEqual(Array.from(cached.beats.beatTimes), Array.from(first.beats.beatTimes));
    assert.equal(cached.beats.resolution, 480);
    assert.equal(cached.beats.offset, -0.25);
    assert.equal(decodes, 1, "cache reuse must avoid decoding audio again");

    // Source identity is checked even when timing was cached successfully.
    const changed = source.replace("120000", "100000");
    await fs.writeFile(chartPath, changed);
    await assert.rejects(onnxDetectBeats(job, jobPath, options), /changed after/);
    job.sourceChart.sha256 = hash(changed);
    const updated = await onnxDetectBeats(job, jobPath, options);
    assert.notEqual(updated.beatsJsonPath, first.beatsJsonPath);
    assert.equal(updated.beats.beatTimes[1], 0.35);

    job.sourceChart.path = path.join(root, "outside.chart");
    await fs.writeFile(job.sourceChart.path, changed);
    await assert.rejects(onnxDetectBeats(job, jobPath, options), /strictly inside/);
    job.sourceChart.path = chartPath;
    const invalid = "[SyncTrack]\n{\n0 = TS 4\n}\n";
    await fs.writeFile(chartPath, invalid);
    job.sourceChart.sha256 = hash(invalid);
    await assert.rejects(onnxDetectBeats(job, jobPath, options), /no usable/);
    console.log("source chart timing stage: real audio, cache reuse, source identity and path boundaries passed");
  } finally {
    Object.assign(onnx, saved);
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

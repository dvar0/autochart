"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { writeChartText } = require("../shared/chartWriter.js");
const { sourceChartBeatGrid } = require("../engine/lib/chartTiming.mjs");
const library = require("../electron/libraryStore.cjs");
const { persistGeneratedTake } = require("../electron/generatedTake.cjs");

(async () => {
  const { inferFinalSlots, buildFinalChartVersion, finalTimingMismatchMessage } = await import("../src/services/finalChart.js");
  const { parseChart } = await import("../src/lib/chart/parseChart.js");
  const { playableVersionsFromRecord } = await import("../src/services/songLibrary.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-imported-final-"));
  const context = { userDataPath: root, projectsFolder: path.join(root, "projects") };
  try {
    for (const resolution of [192, 480, 960]) {
      const original = writeChartText([[resolution, 0, resolution]], {
        title: "Human chart", resolution, offset: -0.25, syncLines: ["0 = B 120000"], difficulty: "expert",
      }).text.replace("[Events]\n{\n}", '[Events]\n{\n  0 = E "section Intro"\n}') +
        `[HardSingle]\n{\n  ${resolution * 2} = N 1 0\n}\n[ExpertDoubleBass]\n{\n  0 = N 2 0\n}\n`;
      const imported = { id: "original", source: "imported-chart", chart: { text: original }, settings: { difficulty: "expert" } };
      const grid = sourceChartBeatGrid(original, { audioDuration: 5 });
      const generatedText = writeChartText([[resolution * 3, 3, 0]], {
        difficulty: "easy", resolution: grid.resolution, offset: grid.offset, syncLines: grid.syncLines,
      }).text;
      const generated = { id: "easy", source: "generated", settings: { difficulty: "easy" }, chart: { text: generatedText } };
      const versions = [imported, generated];
      // Take refreshes need only chart data. No audio file, browser storage, or
      // media bridge is available here, as on a chart-only save refresh.
      const playable = playableVersionsFromRecord({ id: "takes-only", schemaVersion: 2, versions });
      assert.deepEqual(playable.map(version => version.id), ["original", "easy"]);
      assert.equal(playable[0].track.notes[0].tick, resolution);
      assert.equal(playable[1].difficulty, "easy");
      assert.equal(playable[1].track.notes.length, 1);
      const slots = inferFinalSlots(versions);
      assert.deepEqual(slots, { easy: "easy", medium: "", hard: "original", expert: "original" });
      const final = buildFinalChartVersion({ versions, slots }).finalVersion;
      const parsed = parseChart(final.chart.text);
      assert.equal(parsed.song.name, "Human chart");
      assert.equal(parsed.song.resolution, resolution);
      assert.equal(parsed.song.offset, -0.25);
      assert.equal(parsed.tracks.expert.notes[0].tick, resolution);
      assert.equal(parsed.tracks.hard.notes[0].tick, resolution * 2);
      assert.equal(parsed.tracks.easy.notes[0].tick, resolution * 3);
      assert.match(final.chart.text, /section Intro/);
      assert.match(final.chart.text, /\[ExpertDoubleBass\]/);
      assert.throws(() => buildFinalChartVersion({ versions: [imported, {
        ...generated, chart: { text: generatedText.replace("Offset = -0.25", "Offset = 0") },
      }], slots }), /one shared beatmap/);
      const smoothed = (method) => ({ generation: { resolved: { timingSmoothing: { enabled: true, ...(method ? { method } : {}) } } } });
      assert.equal(finalTimingMismatchMessage({
        expert: { ...generated, source: "generated", settings: smoothed("") },
        easy: { ...generated, source: "generated", chart: { text: generatedText.replace("Offset = -0.25", "Offset = 0") }, settings: smoothed("line-fit") },
      }), "Expert was made with older timing, so it can't share a final chart with Easy. Generate Expert again to use them together.");

      const id = `imported_${resolution}`;
      await library.saveSong(context, { record: { id, source: "imported-chart", meta: {}, settings: {},
        chart: { text: original }, versions: [imported],
      } });
      const result = { status: "completed", jobId: `job_${resolution}`, chartText: generatedText };
      const saved = await persistGeneratedTake(context, id, result, { difficulty: "easy" });
      const record = await library.getSong(context, id);
      assert.deepEqual(record.arrangements[0].slots, { ...slots, easy: saved.savedVersion.id });
      buildFinalChartVersion({ versions: record.versions, slots: record.arrangements[0].slots });
      await persistGeneratedTake(context, id, result, { difficulty: "easy" });
      assert.equal((await library.getSong(context, id)).versions.length, 2, "completion remains idempotent");
    }
    const expert = writeChartText([[0, 0, 0]], { syncLines: ["0 = B 120000"] }).text;
    // Audio-only projects must not acquire a phantom imported version or slot.
    await library.saveSong(context, { record: { id: "audio", source: "generated", meta: {}, settings: {},
      chart: { text: expert }, versions: [{ id: "old", source: "generated", chart: { text: expert }, settings: { difficulty: "expert" } }],
    } });
    const audioSaved = await persistGeneratedTake(context, "audio", { status: "completed", jobId: "audio_take", chartText: expert }, { difficulty: "expert" });
    assert.equal((await library.getSong(context, "audio")).arrangements[0].slots.expert, audioSaved.savedVersion.id);
    // Legacy imports without versions must persist the imported version they assign.
    await library.saveSong(context, { record: { id: "legacy", source: "imported-chart", meta: {}, settings: {}, chart: { text: expert } } });
    const easy = writeChartText([[0, 1, 0]], { difficulty: "easy", syncLines: ["0 = B 120000"] }).text;
    await persistGeneratedTake(context, "legacy", { status: "completed", jobId: "legacy_take", chartText: easy }, { difficulty: "easy" });
    const legacy = await library.getSong(context, "legacy");
    assert.ok(legacy.versions.some(version => version.id === legacy.arrangements[0].slots.expert));
    for (const explicit of [false, true]) {
      const id = explicit ? "assigned" : "unassigned";
      await library.saveSong(context, { record: { id, source: "imported-chart", meta: {}, settings: {},
        chart: { text: expert }, versions: [{ id: "original", source: "imported-chart", chart: { text: expert } }],
        arrangements: explicit ? [{ id: "arr_final", slots: { expert: "original" } }] : [],
      } });
      const saved = await persistGeneratedTake(context, id, { status: "completed", jobId: id, chartText: expert }, { difficulty: "expert" });
      assert.equal((await library.getSong(context, id)).arrangements[0].slots.expert,
        explicit ? "original" : saved.savedVersion.id,
        "imported defaults must not hide a new take, and explicit assignments must survive");
    }
    // The Library's project list carries no chart text, but still sees that an
    // older-timing take can't share a final chart with a new one.
    {
      const { migrateRecord } = await import("../src/services/songSchema.js");
      const { finalSlotsFromRecord, buildFinalSlotVersions, finalValidationMessage } = await import("../src/services/finalChart.js");
      const smoothed = (method) => ({ difficulty: "expert", generation: { resolved: { timingSmoothing: { enabled: true, ...(method ? { method } : {}) } } } });
      const hard = writeChartText([[0, 1, 0]], { difficulty: "hard", syncLines: ["0 = B 121000"] }).text;
      await library.saveSong(context, { record: { id: "mixed", source: "generated", meta: {}, settings: {}, chart: { text: expert },
        versions: [
          { id: "old", source: "generated", chart: { text: expert }, settings: smoothed("") },
          { id: "new", source: "generated", chart: { text: hard }, settings: { ...smoothed("line-fit"), difficulty: "hard" } },
        ],
        arrangements: [{ id: "arr_final", slots: { expert: "old", hard: "new" } }],
      } });
      const listed = migrateRecord((await library.listSongSummaries(context)).find((record) => record.id === "mixed"));
      assert(listed.versions.every((version) => !version.chart.text && version.chart.timingKey), "the list keeps timing keys, not charts");
      const slotVersions = buildFinalSlotVersions(finalSlotsFromRecord(listed, listed.versions), listed.versions);
      assert.equal(finalValidationMessage(slotVersions),
        "Expert was made with older timing, so it can't share a final chart with Hard. Generate Expert again to use them together.");
      const same = migrateRecord({ ...listed, versions: listed.versions.map((version) => ({ ...version, chart: { ...version.chart, timingKey: "k" } })) });
      assert.equal(finalValidationMessage(buildFinalSlotVersions(finalSlotsFromRecord(same, same.versions), same.versions)), "");
    }
    console.log("imported final chart: native timing, difficulty sections, saved slots, and legacy records passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { writeChartText } = require("../shared/chartWriter.cjs");
const library = require("../electron/libraryStore.cjs");

(async () => {
  const { chartSongMetadata, chartProvenance, exportChartMetadata } = await import("../shared/chartProvenance.js");
  const { buildGeneratedVersion } = await import("../shared/generatedVersion.js");
  const { buildFinalChartVersion } = await import("../src/services/finalChart.js");
  const { makeEditedVersion } = await import("../src/pages/generate/edit/chartEditor.js");
  const { createSongFromImport, migrateRecord } = await import("../src/services/songSchema.js");
  const { importSongFolder } = await import("../src/services/songImport.js");
  const { parseChart } = await import("../src/lib/chart/parseChart.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autochart-metadata-"));
  try {
    const context = { userDataPath: root, projectsFolder: path.join(root, "projects") };
    const baseText = writeChartText([[192, 0, 96], [384, 2, 0], [384, 5, 0]], {
      title: 'Song } "quoted"', charter: "Human Author", genre: "Rock", syncLines: ["0 = B 120000"],
    }).text;
    const human = { id: "human", source: "imported-chart", settings: { difficulty: "expert" }, chart: { text: baseText } };
    const generated = buildGeneratedVersion({
      chartText: baseText.replaceAll("ExpertSingle", "EasySingle").replace('Genre = "Rock"', 'Genre = "AI"'),
      generatorId: "autochart.fretformer.v1-onnx",
    }, null, { difficulty: "easy" });
    assert.equal(chartSongMetadata(generated.chart.text).charter, "Autochart");
    assert.equal(chartSongMetadata(generated.chart.text).genre, undefined, "legacy AI genre is removed");
    assert.equal(chartSongMetadata(generated.chart.text).name, 'Song } "quoted"');
    const editedHuman = makeEditedVersion(human, baseText, "Human edit");
    const editedGenerated = makeEditedVersion(generated, generated.chart.text, "AI edit");
    assert.deepEqual(chartProvenance(editedHuman).generatedDifficulties, []);
    assert.deepEqual(chartProvenance(editedGenerated).generatedDifficulties, ["easy"]);
    const mixed = buildFinalChartVersion({ versions: [human, generated], slots: { expert: human.id, easy: generated.id } }).finalVersion;
    const handmadeFinal = buildFinalChartVersion({ versions: [editedHuman], slots: { expert: editedHuman.id } }).finalVersion;
    assert.deepEqual(chartProvenance(mixed).generatedDifficulties, ["easy"]);
    assert.deepEqual(chartProvenance(handmadeFinal).generatedDifficulties, []);
    const legacyMixed = structuredClone(mixed);
    delete legacyMixed.meta.chartProvenance;
    assert.deepEqual(chartProvenance(legacyMixed, [human, generated]).generatedDifficulties, ["easy"]);

    for (const [id, version, expectedCredit, generatedDifficulties] of [
      ["generated", generated, "Autochart", "easy"],
      ["edited", editedGenerated, "Autochart", "easy"],
      ["mixed", mixed, "Human Author; Autochart", "easy"],
      ["human", human, "Human Author", ""],
      ["human_final", handmadeFinal, "Human Author", ""],
    ]) {
      const record = migrateRecord({
        id, source: id === "generated" ? "generated" : "imported-chart",
        meta: { title: 'Song } "quoted"', charter: "Human Author", genre: "Progressive Rock" },
        versions: [version], settings: { activeVersionId: version.id }, chart: version.chart,
        assets: { audio: "song.ogg" },
      });
      assert.equal(record.meta.genre, "Progressive Rock");
      await library.saveSong(context, { record: { ...record, assets: {} } });
      // Export copies existing Ogg assets without transcoding. Audio bytes are
      // irrelevant to this metadata/round-trip regression.
      await fs.writeFile(path.join(context.projectsFolder, id, "song.ogg"), "OggS");
      await library.saveSong(context, { record });
      const dest = path.join(root, "exports", id);
      await library.exportSongToFolder(context, id, dest, { versionId: version.id });
      const ini = await fs.readFile(path.join(dest, "song.ini"), "utf8");
      const chart = await fs.readFile(path.join(dest, "notes.chart"), "utf8");
      const header = chartSongMetadata(chart);
      assert.equal(header.charter, expectedCredit);
      assert.equal(header.genre, "Progressive Rock");
      assert.ok(ini.includes(`charter = ${expectedCredit}\n`));
      assert.match(ini, /genre = Progressive Rock/);
      assert.equal(header.autochart_generated_difficulties || "", generatedDifficulties);
      assert.equal(ini.includes("autochart_ai_generated = true"), Boolean(generatedDifficulties));
      assert.deepEqual(parseChart(chart).tracks, parseChart(version.chart.text).tracks, "metadata must not change notes");
      assert.deepEqual(parseChart(chart).sync, parseChart(version.chart.text).sync, "metadata must not change timing");
      const imported = await importSongFolder([
        new File([chart], "notes.chart"), new File([ini], "song.ini"), new File(["OggS"], "song.ogg"),
      ]);
      const reimported = migrateRecord(createSongFromImport(imported));
      assert.equal(reimported.meta.genre, "Progressive Rock");
      const roundTrip = exportChartMetadata(reimported.versions[0], reimported.meta);
      assert.equal(roundTrip.meta.autochart_generated_difficulties, generatedDifficulties);
      assert.equal(roundTrip.meta.charter, expectedCredit);
    }
    const injection = exportChartMetadata(generated, { charter: "Someone else", genre: 'Rock\ncharter = Spoofed' });
    assert.equal(chartSongMetadata(injection.chartText).charter, "Autochart");
    assert.equal(chartSongMetadata(injection.chartText).genre, "Rock charter = Spoofed");
    const cleared = exportChartMetadata(generated, { genre: "" });
    assert.equal(chartSongMetadata(cleared.chartText).genre, undefined);
    console.log("chart metadata: genre, fixed AI credit, mixed/edited lineage, export and re-import passed");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

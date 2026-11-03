#!/usr/bin/env node
"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const chartWriter = require("../shared/chartWriter.js");

(async () => {
  const parser = await import("../src/lib/chart/parseChart.js");
  const fixtureRoot = path.join(__dirname, "..", "fixtures", "chart-interoperability");
  const standard = parser.parseChart(fs.readFileSync(path.join(fixtureRoot, "clone-hero-standard.chart"), "utf8"));
  assert.equal(standard.song.name, "Fixture Song");
  assert.equal(standard.song.offset, -0.25);
  assert.equal(standard.sync.bpms.length, 2);
  assert.equal(standard.tracks.expert.notes.length, 5);
  assert.deepEqual(standard.tracks.expert.notes[0].frets, [0, 2]);
  assert.equal(standard.tracks.expert.notes[1].force, true);
  assert.equal(standard.tracks.expert.notes[2].open, true);
  assert.equal(standard.tracks.expert.notes[3].tap, true);

  const raw = parser.parseChart(fs.readFileSync(path.join(fixtureRoot, "moonscraper-raw-metadata.chart"), "utf8"));
  assert.equal(raw.song.name, 'Folder \\ Charts \\"quoted\\"');
  assert.equal(raw.song.artist, "Artist \\\\ A");
  assert.equal(raw.song.charter, "Charter \\\\ Name");
  assert.equal(raw.tracks.hard.notes.length, 5);

  const generated = chartWriter.writeChartText([[0, 0, 96], [192, 5, 0]], {
    title: 'Folder \\ Charts "quoted"',
    artist: "Artist \\\\ A",
    charter: "Charter \\\\ Name",
    difficulty: "hard",
    syncLines: ["0 = B 120000"],
  }).text;
  assert.match(generated, /Name = "Folder \\ Charts "quoted""/);
  assert.match(generated, /Artist = "Artist \\\\ A"/);
  assert.doesNotMatch(generated, /\\n|\\r|\\\\"/);
  const roundTrip = parser.parseChart(generated);
  assert.equal(roundTrip.song.name, 'Folder \\ Charts "quoted"');
  assert.equal(roundTrip.song.artist, "Artist \\\\ A");
  assert.equal(roundTrip.song.charter, "Charter \\\\ Name");
  assert.equal(roundTrip.tracks.hard.notes.length, 2);

  // Back-to-back solos: the first ends on the tick the second starts.
  const solos = "[Song]\n{\n  Resolution = 192\n}\n[SyncTrack]\n{\n  0 = B 120000\n}\n[ExpertSingle]\n{\n" +
    "  0 = E solo\n  0 = N 0 0\n  768 = E soloend\n  768 = E solo\n  768 = N 1 0\n  1536 = E soloend\n}\n";
  const twoSolos = [{ startTick: 0, endTick: 768 }, { startTick: 768, endTick: 1536 }];
  assert.deepEqual(parser.parseChart(solos).tracks.expert.solos, twoSolos);
  const { parseEditableChart } = await import("../src/pages/generate/edit/chartEditor.js");
  assert.deepEqual(parseEditableChart(solos).ranges.map(({ startTick, endTick }) => ({ startTick, endTick })), twoSolos);
  console.log("chart interoperability fixtures passed (raw metadata, no C-style escapes, back-to-back solos)");
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

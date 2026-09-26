#!/usr/bin/env node
// Hermetic gate for the "Imported chart sync" timing detector: the beat grid and
// the emitted [SyncTrack] must come from the imported chart's tempo map instead
// of a detected grid. No models or audio needed.
"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const {
  chartTimeSignatures,
  hasChartTempoAnchor,
  parseChartSections,
  sourceChartBeatGrid,
} = require("../lib/chartTiming.cjs");

const RESOLUTION = 192;

function chart({ resolution = 192, offset = 0, sync = [] } = {}) {
  return [
    "[Song]",
    "{",
    `  Resolution = ${resolution}`,
    `  Offset = ${offset}`,
    "}",
    "[SyncTrack]",
    "{",
    ...sync.map((line) => `  ${line}`),
    "}",
    "",
  ].join("\n");
}

function close(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} +/- ${tolerance}, got ${actual}`
  );
}

// A steady 120 BPM map puts a beat every 0.5s, and the grid runs one beat past
// the audio so the last beat window is closed.
const steady = sourceChartBeatGrid(chart({ sync: ["0 = TS 4", "0 = B 120000"] }), {
  resolution: RESOLUTION,
  audioDuration: 10,
});
assert.equal(steady.beatTimes[0], 0);
close(steady.beatTimes[1], 0.5, 1e-9, "second beat at 120 BPM");
assert.equal(steady.beatTimes.length, 22, "10s at 120 BPM is 20 beats plus the closing beat");
assert.ok(steady.beatTimes[steady.beatTimes.length - 1] > 10, "grid must extend past the audio");
close(steady.downbeatTimes[1], 2, 1e-9, "second 4/4 measure at 120 BPM");
assert.deepEqual(steady.syncLines, ["0 = TS 4", "0 = B 120000"]);

// A tempo change mid-song must land where the source says, not where a
// re-derived grid would put it: 8 beats of 120 BPM (4s), then 150 BPM.
const tempoChange = sourceChartBeatGrid(
  chart({ sync: ["0 = TS 4", "0 = B 120000", "1536 = B 150000"] }),
  { resolution: RESOLUTION, audioDuration: 12 }
);
close(tempoChange.beatTimes[8], 4, 1e-9, "tempo change beat");
close(tempoChange.beatTimes[9], 4 + 60 / 150, 1e-9, "first beat after tempo change");
assert.deepEqual(tempoChange.syncLines, ["0 = TS 4", "0 = B 120000", "1536 = B 150000"]);

// Non-192 source resolutions are rescaled, tempo values kept exact.
const rescaled = sourceChartBeatGrid(
  chart({ resolution: 480, sync: ["0 = TS 4", "0 = B 100000", "3840 = B 200000"] }),
  { resolution: RESOLUTION, audioDuration: 8 }
);
assert.equal(rescaled.sourceResolution, 480);
close(rescaled.beatTimes[8], 8 * 0.6, 1e-9, "eighth beat at 100 BPM");
assert.deepEqual(rescaled.syncLines, ["0 = TS 4", "0 = B 100000", "1536 = B 200000"]);

// Time signatures survive, including non-4 denominators, and downbeats follow
// the measure length each signature implies.
const meters = sourceChartBeatGrid(
  chart({ sync: ["0 = TS 3", "0 = B 120000", "1152 = TS 6 3"] }),
  { resolution: RESOLUTION, audioDuration: 12 }
);
assert.deepEqual(meters.syncLines, ["0 = TS 3", "0 = B 120000", "1152 = TS 6 3"]);
close(meters.downbeatTimes[1], 1.5, 1e-9, "second 3/4 measure at 120 BPM");
const sixEight = meters.downbeatTimes.filter((seconds) => seconds >= 3 - 1e-9);
close(sixEight[1] - sixEight[0], 1.5, 1e-9, "6/8 measure at 120 BPM");

// A chart with no tempo anchors must fail loudly rather than fall back to the
// 120 BPM default that chartBpms() invents for reporting.
assert.equal(hasChartTempoAnchor(["0 = TS 4"]), false);
assert.throws(
  () => sourceChartBeatGrid(chart({ sync: ["0 = TS 4"] }), { resolution: RESOLUTION, audioDuration: 10 }),
  /no usable \[SyncTrack\] tempo map/
);
assert.throws(
  () => sourceChartBeatGrid("not a chart at all", { resolution: RESOLUTION, audioDuration: 10 }),
  /no usable \[SyncTrack\] tempo map/
);

// Missing time signatures default to 4/4 at tick 0 rather than dropping out.
assert.deepEqual(chartTimeSignatures([]), [{ tick: 0, numerator: 4, denominator: 4 }]);

// Real Clone Hero fixture: 120 BPM to 128 BPM at bar 3 of a 4/4 chart.
const fixtureRoot = path.join(__dirname, "..", "..", "fixtures", "chart-interoperability");
const fixtureText = fs.readFileSync(path.join(fixtureRoot, "clone-hero-standard.chart"), "utf8");
const fixture = sourceChartBeatGrid(fixtureText, { resolution: RESOLUTION, audioDuration: 15 });
assert.equal(parseChartSections(fixtureText).SyncTrack.length, fixture.syncLines.length);
assert.deepEqual(fixture.tempoMap, [{ tick: 0, bpm: 120 }, { tick: 384, bpm: 128 }]);
assert.deepEqual(fixture.timeSignatures, [{ tick: 0, numerator: 4, denominator: 4 }]);
close(fixture.beatTimes[2], 0.75, 1e-9, "fixture beat 2 at 120 BPM");
close(fixture.beatTimes[3], 0.75 + 60 / 128, 1e-9, "fixture beat after the 128 BPM anchor");

// Feeding the emitted [SyncTrack] back in must reproduce the same grid, so the
// exported chart plays at the timing the transcriber was conditioned on.
const roundTrip = sourceChartBeatGrid(chart({ sync: fixture.syncLines, offset: fixture.offset }), {
  resolution: RESOLUTION,
  audioDuration: 15,
});
assert.deepEqual(roundTrip.beatTimes, fixture.beatTimes);
assert.deepEqual(roundTrip.tempoMap, fixture.tempoMap);
assert.deepEqual(roundTrip.timeSignatures, fixture.timeSignatures);

// Unknown audio duration still yields a usable grid instead of throwing.
const unbounded = sourceChartBeatGrid(chart({ sync: ["0 = B 120000"] }), { resolution: RESOLUTION });
assert.ok(unbounded.beatTimes.length > 2);

const nativeResolution = sourceChartBeatGrid(chart({
  resolution: 480, offset: 0.25, sync: ["0 = B 120000", "960 = B 150000"],
}), { audioDuration: 5 });
assert.equal(nativeResolution.resolution, 480);
assert.equal(nativeResolution.offset, 0.25);
assert.deepEqual(nativeResolution.syncLines, ["0 = B 120000", "960 = B 150000"]);
close(nativeResolution.beatTimes[2], 1.25, 1e-9, "native resolution with chart offset");
for (const sync of [["-1 = B 120000"], ["0 = B Infinity"]]) {
  assert.throws(() => sourceChartBeatGrid(chart({ sync }), { audioDuration: 1 }), /no usable/);
}
assert.throws(() => sourceChartBeatGrid(chart({ sync: ["0 = B 120000"] }), {
  audioDuration: 20000,
}), /does not cover/);
const futureMeter = sourceChartBeatGrid(chart({ sync: ["0 = B 120000", "99999999 = TS 3"] }), { audioDuration: 5 });
assert.ok(futureMeter.downbeatTimes.every(time => time <= futureMeter.beatTimes.at(-1)));

console.log("imported chart sync timing passed (source tempo map drives the beat grid and [SyncTrack])");

#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { framePower, mixLevels, stemLevels, roundTimes } = require("../engine/lib/onnx/songMap.mjs");
const { mergeSongMap, progressAt } = require("../src/pages/generate/liveScore.js");

const RATE = 100;
const sine = (length, amp) => Float32Array.from({ length }, (_, i) => amp * Math.sin(i * 0.3));

// Stretches of a separation meet exactly: no frame is lost or sent twice.
{
  const row = sine(RATE * 30, 0.2);
  const stops = [0, 700, 1400, 2100, 3000];
  let next = 0;
  for (let i = 0; i + 1 < stops.length; i += 1) {
    const { first, power } = framePower([row], RATE, stops[i], stops[i + 1], { rate: 10 });
    assert.equal(first, next, "each stretch starts where the last one ended");
    next = first + power.length;
  }
  assert.equal(next, 300);
}

// Overlap-add weights are divided out, so a running separation reads as its result.
{
  const row = sine(RATE * 2, 0.2);
  const plain = framePower([row], RATE, 0, row.length, { rate: 10 }).power;
  const weighted = framePower([row.map((v) => v * 2)], RATE, 0, row.length, { rate: 10, weights: new Float32Array(row.length).fill(2) }).power;
  plain.forEach((value, i) => assert.ok(Math.abs(value - weighted[i]) < 1e-6));
}

// Folded stems take their sources' energy; silence stays at zero.
{
  const loud = Float32Array.of(0.04);
  const quiet = Float32Array.of(0.01);
  const levels = stemLevels(
    { other: quiet, piano: loud, drums: new Float32Array(1) },
    { stems: ["drums", "other"], stemFold: { other: ["other", "piano"] } },
  );
  assert.equal(levels.drums[0], 0);
  assert.ok(levels.other[0] > stemLevels({ piano: loud }, { stems: ["piano"] }).piano[0]);
  assert.equal(mixLevels([new Float32Array(RATE)], RATE, 10).every((v) => v === 0), true);
}

assert.deepEqual(roundTimes([-0.2, 0.12345]), [0.123]);

const mix = { type: "song_map", kind: "mix", rate: 10, seconds: 10, levels: new Array(100).fill(100) };
const stage = (name, extra = {}) => ({ type: "stage", stage: name, status: "running", ...extra });
const stemsAt = (from, length, value = 50) => ({
  type: "song_map",
  kind: "stems",
  from,
  levels: { guitar: new Array(length).fill(value), drums: new Array(length).fill(value) },
});

// A first run: progress eases, stems fill in, a repeated piece changes nothing.
{
  let map = mergeSongMap(null, stage("demucs"), 0);
  assert.equal(map.phase, "split");
  map = mergeSongMap(map, mix, 1);
  map = mergeSongMap(map, stemsAt(0, 40), 2);
  map = mergeSongMap(map, stage("demucs", { progress: 0.4 }), 2);
  assert.equal(map.stemFrames, 40);
  map = mergeSongMap(map, stemsAt(0, 40), 3);
  assert.equal(map.stemFrames, 40);
  assert.equal(map.stems.guitar[39], 50);
  assert.equal(map.stems.guitar[40], 0);
  assert.equal(progressAt(map.split, 1e6), 0.4);
  map = mergeSongMap(map, stage("demucs", { progress: 0.2 }), 500);
  assert.equal(progressAt(map.split, 1e6) >= 0.4, true, "the position never goes back");
}

// A reused separation arrives whole and gets one quick pass.
{
  let map = mergeSongMap(null, mix, 0);
  map = mergeSongMap(map, stemsAt(0, 100), 10);
  assert.equal(map.stemFrames, 100);
  assert.equal(progressAt(map.split, 10), 0);
  assert.equal(progressAt(map.split, 1e6), 1);
}

// Pieces too long for the song are cut, and a map doesn't need stems.
{
  let map = mergeSongMap(null, mix, 0);
  map = mergeSongMap(map, stemsAt(90, 50), 1);
  assert.equal(map.stemFrames, 100);
  const lite = mergeSongMap(null, stage("demucs", { status: "skipped" }), 0);
  assert.equal(lite.noStems, true);
}

// A model download isn't the separation.
assert.equal(mergeSongMap(null, stage("demucs", { downloading: true }), 0).phase, "read");

// Rough beats skip the last chunk's overlap; the final grid replaces them and stays.
{
  let map = mergeSongMap(null, mix, 0);
  map = mergeSongMap(map, { type: "song_map", kind: "beats", from: 1, beats: [1, 2, 3], downbeats: [1] }, 1);
  map = mergeSongMap(map, { type: "song_map", kind: "beats", from: 2, beats: [2.01, 3.02, 4], downbeats: [1.01, 4] }, 2);
  assert.deepEqual(map.beats, [1, 2, 3, 4]);
  assert.deepEqual(map.downbeats, [1, 4]);
  map = mergeSongMap(map, { type: "song_map", kind: "beats", final: true, beats: [1.1, 2.1], downbeats: [1.1] }, 3);
  assert.deepEqual(map.beats, [1.1, 2.1]);
  map = mergeSongMap(map, { type: "song_map", kind: "beats", from: 3, beats: [9], downbeats: [] }, 4);
  assert.deepEqual(map.beats, [1.1, 2.1]);
}

// Stages move the phase; other events leave the map alone.
{
  let map = mergeSongMap(null, stage("timing", { progress: 0.5 }), 0);
  assert.equal(map.phase, "beat");
  map = mergeSongMap(map, stage("transcription"), 1);
  assert.equal(map.phase, "warm");
  assert.equal(mergeSongMap(map, { type: "log", message: "x" }, 2), map);
}

console.log("Live score checks passed.");

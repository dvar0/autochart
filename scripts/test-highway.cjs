#!/usr/bin/env node
// Geometry and transport regressions; run with node scripts/test-highway.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { build } = require('esbuild');

function recordingCanvas(width = 900, height = 600) {
  let points = [];
  const fills = [];
  const strokes = [];
  const images = [];
  const ctx = new Proxy({
    fills, strokes, images,
    beginPath() { points = []; },
    moveTo(x, y) { points.push([x, y]); },
    lineTo(x, y) { points.push([x, y]); },
    fill() { fills.push({ points: [...points], color: this.fillStyle }); },
    stroke() { strokes.push([...points]); },
    drawImage(image) { images.push(image); },
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
  }, { get(target, key) { return key in target ? target[key] : () => {}; } });
  return { width, height, getContext: () => ctx, getBoundingClientRect: () => ({ width, height }) };
}

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autochart-highway-'));
  try {
    const outfile = path.join(dir, 'highway.cjs');
    await build({ stdin: { contents: 'export { HighwayRenderer } from "./src/highway/HighwayRenderer.js"; export { GameEngine } from "./src/highway/GameEngine.js";', resolveDir: path.resolve(__dirname, '..') }, bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
    const { HighwayRenderer, GameEngine } = require(outfile);
    global.window = { devicePixelRatio: 3 };
    global.document = { createElement: () => recordingCanvas() };
    global.requestAnimationFrame = () => 1;
    global.cancelAnimationFrame = () => {};
    const canvas = recordingCanvas();
    const r = new HighwayRenderer(canvas, { hitEffects: false });
    const ctx = canvas.getContext('2d');
    const note = { time: 1, endTime: 6, sustain: 960, frets: [0, 4] };

    // Fresh streamed notes have no hit state. A long tail must survive even
    // when its head is many visible windows behind the playhead.
    r.setNotes([note]);
    for (const time of [0.5, 1, 3, 5.999]) {
      assert.equal(r._collectVisibleNotes(time), 1);
      ctx.fills.length = 0;
      r._drawSustain(note, r.proj.depthForTime(note.time, time), time);
      assert.equal(ctx.fills.length, 6, 'both chord tails remain visible without extra moving polygons');
      for (const fill of ctx.fills) {
        assert.equal(fill.points.length, 4);
        for (const [x, y] of fill.points) {
          assert.ok(Number.isFinite(x) && Number.isFinite(y));
          assert.ok(y <= r.proj.strikeY + 1e-8, 'tail leaked behind strike line');
        }
      }
      if (time >= 1) assert.deepEqual([...r._sustainLanes], [0, 4]);
    }
    assert.equal(r._collectVisibleNotes(6), 0, 'finished sustain must disappear');
    ctx.fills.length = 0;
    r._drawSustain(note, -1, 6);
    assert.equal(ctx.fills.length, 0);

    // Shimmer is a continuous strand, reproducible on pause/seek and contained
    // above the strike line. Reduced motion retains the plain sustain.
    ctx.strokes.length = 0;
    r._drawSustain(note, -1, 3);
    const strands = ctx.strokes.slice();
    assert.equal(strands.length, 4, 'held chord needs two strands per lane');
    for (const points of strands) {
      assert.ok(points.length > 16, 'shimmer should be continuous');
      for (const [x, y] of points) assert.ok(Number.isFinite(x) && y <= r.proj.strikeY + 1e-8);
    }
    ctx.strokes.length = 0;
    r._drawSustain(note, -1, 3);
    assert.deepEqual(ctx.strokes, strands, 'paused shimmer must not move');
    ctx.strokes.length = 0;
    r._drawSustain(note, -1, 3.1);
    assert.notDeepEqual(ctx.strokes, strands, 'playing shimmer must move');
    r.setReduceMotion(true);
    ctx.strokes.length = 0;
    r._drawSustain(note, -1, 3);
    assert.equal(ctx.strokes.length, 0, 'reduced motion must disable shimmer');
    r.setReduceMotion(false);

    // Open tails previously traced only two points (zero fill area).
    const open = { ...note, open: true, frets: [] };
    ctx.fills.length = 0;
    r._drawSustain(open, -1, 3);
    const polygon = ctx.fills[0].points;
    assert.equal(polygon.length, 4);
    const twiceArea = polygon.reduce((sum, [x, y], i) => {
      const [nx, ny] = polygon[(i + 1) % polygon.length];
      return sum + x * ny - nx * y;
    }, 0);
    assert.ok(Math.abs(twiceArea) > 100, 'open tail has no visible area');

    // Stale hit flags after a backward seek cannot hide an upcoming head.
    r.setNotes([{ ...note, result: 'perfect', visualHeld: true }]);
    ctx.images.length = 0;
    r._drawNote(r.notes[0], 0.3, 0.5, 'heads');
    assert.equal(ctx.images.length, 2, 'upcoming chord heads were hidden by stale state');
    r._drawNote(r.notes[0], 0, 1, 'heads');
    assert.equal(ctx.images.length, 2, 'head persisted after crossing the strike line');

    // Reapplying a streaming track at the same dimensions must preserve caches
    // and the backing store, while a real perspective change invalidates them.
    r.draw(3);
    const back = r._backLayer;
    const proj = r.proj;
    assert.equal(canvas.width, 1800, 'DPR must be capped at 2');
    r.resize();
    assert.equal(r._backLayer, back);
    assert.equal(r.proj, proj);
    r.setPerspective(2.5);
    assert.notEqual(r.proj, proj);
    assert.equal(r._backLayer, null);
    const drawSustain = r._drawSustain.bind(r);
    r._drawSustain = (...args) => { ctx.images.push('sustain'); drawSustain(...args); };
    ctx.images.length = 0;
    r.draw(3);
    assert.ok(ctx.images.indexOf(r._strikeLayer) < ctx.images.indexOf('sustain'), 'strike plate obscures sustain tails');
    assert.ok(ctx.images.indexOf('sustain') < ctx.images.indexOf(r._buttonSprites.get('0|lit').canvas), 'tails overlap fret buttons');

    // Star rotation follows song time, including pause, backward seek and
    // reduced motion. Repeated frames must reuse the same sprite surfaces.
    const starRenderer = new HighwayRenderer(recordingCanvas(), { hitEffects: false });
    for (const kind of ['strum', 'hopo', 'tap']) {
      const star = { time: 100, endTime: 100, frets: [0], kind, star: true };
      starRenderer._drawNote(star, 0.2, 1, 'heads');
      const sprite = [...starRenderer._gemSprites.values()].at(-1);
      const spriteCtx = sprite.getContext('2d');
      const snapshot = () => spriteCtx.fills.map(({ points, color }) => ({
        points, color: typeof color === 'string' ? color : 'gradient',
      }));
      const first = snapshot();
      starRenderer._drawNote(star, 0.2, 1, 'heads');
      assert.deepEqual(snapshot(), first, 'paused star must reuse its frame');
      spriteCtx.fills.length = 0;
      starRenderer._drawNote(star, 0.2, 2, 'heads');
      assert.notDeepEqual(snapshot(), first, 'star must rotate during playback');
      spriteCtx.fills.length = 0;
      starRenderer._drawNote(star, 0.2, 1, 'heads');
      assert.deepEqual(snapshot(), first, 'seek must restore the earlier orientation');
      starRenderer.setReduceMotion(true);
      starRenderer._drawNote(star, 0.2, 1, 'heads');
      spriteCtx.fills.length = 0;
      starRenderer._drawNote(star, 0.2, 2, 'heads');
      assert.equal(spriteCtx.fills.length, 0, 'reduced motion must freeze star rotation');
      starRenderer.setReduceMotion(false);
      for (let frame = 0; frame < 60; frame++) starRenderer._drawNote(star, 0.2, frame / 60, 'heads');
      assert.equal([...starRenderer._gemSprites.values()].at(-1), sprite, 'rotation must reuse its canvas');
    }
    assert.equal(starRenderer._gemSprites.size, 3, 'rotation must not accumulate sprite frames');

    const flashes = [];
    let cleared = 0;
    const transportRenderer = { setNotes() {}, draw() {}, flashLane: (lane) => flashes.push(lane), clearEffects: () => cleared++ };
    const engine = new GameEngine(transportRenderer);
    const track = { song: {}, duration: 12, notes: [note, { time: 7, endTime: 7, sustain: 0, frets: [2] }] };
    engine.setTrack(track);
    engine.seek(3);
    assert.equal(engine.notes[0].visualHeld, true);
    engine._advanceVisualNotes(3.1);
    assert.equal(flashes.length, 0, 'seeking into a sustain must not replay hits');
    engine._advanceVisualNotes(7);
    assert.deepEqual(flashes, [2]);
    engine._advanceVisualNotes(7.1);
    assert.deepEqual(flashes, [2], 'crossing feedback fired twice');
    engine.seek(0);
    engine._advanceVisualNotes(1);
    assert.deepEqual(flashes, [2, 0, 4], 'backward seek must rearm hits');
    assert.ok(cleared >= 2, 'seeks must clear old decorative effects');

    // A newly committed sustain is already active at the current playhead.
    engine.seek(3);
    const before = cleared;
    engine.setTrack({ ...track, notes: [{ ...note, endTime: 8 }, track.notes[1]] });
    assert.equal(engine.songTime, 3);
    assert.equal(engine.notes[0].visualHeld, true);
    assert.equal(cleared, before, 'stream updates must preserve live feedback');

    // Audio source starts 100ms ahead: play/resume/seek must hold position,
    // including nonzero audio latency and a chart-to-audio timeline offset.
    engine.audioCtx = {
      currentTime: 10, state: 'running', baseLatency: 0.02, outputLatency: 0.03,
      createBufferSource: () => ({ connect() {}, start() {}, stop() {}, disconnect() {} }),
    };
    engine.buffer = { duration: 12 };
    engine.setChartTimeOffset(-2);
    engine.seek(3);
    await engine.play();
    assert.ok(Math.abs(engine.songTime - 3) < 1e-8);
    engine.audioCtx.currentTime = 10.05;
    engine._updateClock();
    assert.equal(engine._clockOffset, null);
    assert.ok(Math.abs(engine.songTime - 3) < 1e-8);
    assert.ok(Math.abs(engine.chartTime - 5) < 1e-8);
    engine.audioCtx.currentTime = 10.15;
    assert.ok(Math.abs(engine.songTime - 3.05) < 1e-8);
    engine.pause();
    const paused = engine.songTime;
    await engine.play();
    assert.ok(Math.abs(engine.songTime - paused) < 1e-8, 'resume rewound clock');
    engine.seek(5);
    assert.ok(Math.abs(engine.songTime - 5) < 1e-8, 'running seek rewound clock');

    // Natural completion must notify the UI after stopping. Otherwise its
    // Pause button keeps invoking a no-op, even after seeking or changing takes.
    let ended = 0;
    engine.onEnded = () => {
      ended++;
      assert.equal(engine.running, false);
      assert.equal(engine.source, null);
      assert.equal(engine.rafId, null);
    };
    engine.audioCtx.currentTime += 20;
    engine._tick();
    assert.equal(ended, 1, 'natural completion must notify the preview');
    engine._tick();
    assert.equal(ended, 1, 'completion must fire only once');
    engine.setTrack({ ...track, notes: [track.notes[1]] });
    engine.seek(3);
    await engine.play();
    assert.equal(engine.running, true, 'seek and play must work after completion and a take change');
    assert.ok(Math.abs(engine.songTime - 3) < 1e-8);
    engine.pause();
    assert.equal(ended, 1, 'manual pause must not report completion');
    engine.seek(engine.duration);
    await engine.play();
    assert.ok(Math.abs(engine.songTime) < 1e-8, 'Play at the end must replay from the beginning');
    engine.stop();
    assert.equal(ended, 1, 'manual stop must not report completion');
    console.log('Highway geometry, streaming, cache, and playback regressions passed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

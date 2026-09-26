import { FRET_COLORS } from "../../data/notePalette.js";

// Pure canvas renderer for the generation stage visuals. Every frame is a
// function of (time, mode history) alone, so the animation is deterministic
// and never touches real audio.
//
// The song flows left to right as one white beam through a gate:
// - prep: the prism pops in and the beam streams in from the left; nothing
//   comes out yet while the prism warms up.
// - split: the gate is a prism. The beam goes in white and leaves as five
//   colour bands (the fret colours in spectrum order) that fan out into lanes.
// - beat: the prism flattens its top into a metronome. Its arm swings in time,
//   and every tick stamps a beat marker, in that beat's colour, onto the audio
//   as it leaves.
// Once the prism starts emitting, whatever comes out shoots across the board.
// After that, a mode change happens at the gate: only audio that crosses it
// afterwards shows the new state, so changes flow outward instead of
// crossfading.

const TAU = Math.PI * 2;
const [GREEN, RED, YELLOW, BLUE, ORANGE] = FRET_COLORS;
// Top to bottom, like light out of a prism.
const BAND_RGB = [RED, ORANGE, YELLOW, GREEN, BLUE].map(hexToRgb);
// Beat-in-bar colours: one, two, three, four.
const BEAT_RGB = [GREEN, RED, YELLOW, BLUE].map(hexToRgb);
const WHITE = [255, 255, 255];

const SIZES = {
  board: { gate: 0.34, fan: 0.2, bps: 1.8, fade: 0.08, step: 2, stroke: 2 },
  strip: { gate: 0.27, fan: 0.24, bps: 1.5, fade: 0.06, step: 1, stroke: 1 },
};
// Seconds of audio over which a mode change blends as it crosses the gate.
const CHANGE_BLEND = 0.9;
// Intro timing, in seconds: the prism pops in, the beam reaches it, and the
// first output shoots across the board.
const POP_IN = 0.45;
const ARRIVE = 0.7;
const SHOOT = 0.6;
const MIX_GAIN = 0.44;
const SQRT3 = Math.sqrt(3);

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const fract = (v) => v - Math.floor(v);
const smooth = (v) => {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
};
const ramp = (a, b, v) => smooth((v - a) / (b - a));
const mod = (n, m) => ((n % m) + m) % m;
const rgba = ([r, g, b], a) => `rgba(${r},${g},${b},${clamp01(a).toFixed(3)})`;
const tint = ([r, g, b], w) => [r + (255 - r) * w, g + (255 - g) * w, b + (255 - b) * w].map(Math.round);
const easeOutCubic = (v) => 1 - Math.pow(1 - clamp01(v), 3);
const easeOutBack = (v) => {
  const x = clamp01(v) - 1;
  return 1 + 2.4 * x * x * x + 1.4 * x * x;
};

// 1 on the beat (or subdivision), easing to 0 halfway between: a rounded pulse.
const onBeat = (p, div = 1) => Math.cos(Math.PI * (fract(p * div + 0.5) - 0.5));

// Each band is a loudness envelope (0..1) over the audio position in beats.
// Everything is smooth and rounded; peaks sit on the beat.
const BANDS = [
  // drums: a round thump on every beat, heavier on one and three
  (p) => 0.28 + 0.72 * (mod(Math.round(p), 2) === 0 ? 1 : 0.78) * Math.pow(onBeat(p), 8),
  // guitar: eighth-note strums
  (p) => 0.32 + 0.5 * (mod(Math.round(p * 2), 2) === 0 ? 1 : 0.7) * Math.pow(onBeat(p, 2), 4),
  // keys: a slow sway
  (p) => 0.42 + 0.28 * Math.sin((TAU * p) / 4 + 0.8) + 0.1 * Math.sin((TAU * p) / 1.5),
  // vocals: phrases that swell and rest
  (p) => {
    const phrase = fract(p / 8) * 8;
    const sung = ramp(0, 1.2, phrase) * (1 - ramp(5, 6.6, phrase));
    return 0.16 + 0.74 * sung * (0.8 + 0.2 * Math.sin((TAU * p) / 3));
  },
  // bass: broad pulses
  (p) => 0.4 + 0.42 * Math.pow(onBeat(p), 2),
];

function layout(size, width, height) {
  const S = SIZES[size] || SIZES.board;
  const board = S === SIZES.board;
  const lane = board ? Math.min(84, Math.max(22, height * 0.14)) : height * 0.155;
  const prismH = lane * 3.3;
  const side = (prismH * 2) / SQRT3;
  const gateX = width * S.gate;
  return {
    ...S,
    board,
    lane,
    unit: lane * 0.42,
    beat: board ? Math.min(90, Math.max(44, width * 0.055)) : Math.min(30, Math.max(18, width * 0.12)),
    gateX,
    mid: height / 2,
    prismH,
    side,
    // Where the beam meets the prism's faces at mid height.
    entryX: gateX - side * 0.29,
    exitX: gateX + side * 0.29,
    fanW: width * S.fan,
  };
}

// The mode in effect when audio crossed the gate at time `at`.
function modeAt(history, at) {
  if (!history.length) return { split: 0, grid: 0 };
  let split = history[0].split;
  let grid = history[0].grid;
  for (let i = 1; i < history.length; i += 1) {
    const e = history[i];
    const blend = smooth((at - e.t) / CHANGE_BLEND);
    split += (e.split - split) * blend;
    grid += (e.grid - grid) * blend;
  }
  return { split, grid };
}

// Horizontal gradient that carries each column's opacity.
function columnStyle(ctx, W, columns, rgb, alpha) {
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  for (let i = 0; i < columns.length; i += 1) {
    grad.addColorStop(i / (columns.length - 1), rgba(rgb, alpha * columns[i]));
  }
  return grad;
}

// A mirrored waveform: top edge left to right, bottom edge back.
function envelopePath(ctx, xs, centers, halves) {
  const n = xs.length;
  ctx.beginPath();
  ctx.moveTo(xs[0], centers[0] - halves[0]);
  for (let i = 1; i < n; i += 1) ctx.lineTo(xs[i], centers[i] - halves[i]);
  for (let i = n - 1; i >= 0; i -= 1) ctx.lineTo(xs[i], centers[i] + halves[i]);
  ctx.closePath();
}

function roundedPoly(ctx, pts, radii) {
  const n = pts.length;
  ctx.beginPath();
  ctx.moveTo((pts[n - 1][0] + pts[0][0]) / 2, (pts[n - 1][1] + pts[0][1]) / 2);
  for (let i = 0; i < n; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    ctx.arcTo(a[0], a[1], b[0], b[1], radii[i]);
  }
  ctx.closePath();
}

// The gate's body: a rounded prism, point up. `flat` (0..1) cuts the tip off
// into the flat top of a metronome; `scale` pops it in.
function bodyGeometry(L, flat, scale = 1) {
  const h = L.prismH * Math.max(0.001, scale);
  const s = L.side * Math.max(0.001, scale);
  const cx = L.gateX;
  const cy = L.mid + L.prismH * 0.06;
  const apex = cy - h * 0.58;
  const base = cy + h * 0.42;
  const topW = s * 0.26 * flat;
  return { cx, apex, base, top: apex + (topW / s) * h, topW, h, s, r: L.lane * 0.32 * Math.max(0.001, scale) };
}

function bodyPath(ctx, L, g) {
  const r = g.r;
  if (g.topW < 1) {
    roundedPoly(ctx, [[g.cx, g.apex], [g.cx + g.s / 2, g.base], [g.cx - g.s / 2, g.base]], [r, r, r]);
    return;
  }
  const rt = Math.min(r, g.topW * 0.45);
  roundedPoly(
    ctx,
    [[g.cx - g.topW / 2, g.top], [g.cx + g.topW / 2, g.top], [g.cx + g.s / 2, g.base], [g.cx - g.s / 2, g.base]],
    [rt, rt, r, r],
  );
}

/**
 * @param {CanvasRenderingContext2D} ctx already scaled to CSS pixels
 * @param {{width:number,height:number,time:number,
 *          history:{t:number,split:number,grid:number,prep?:boolean}[],
 *          ink:number[],dark:boolean,size?:"board"|"strip"}} o
 *   history: mode changes in clock seconds, oldest first. The clock starts
 *   when the board appears; the first processing (non-prep) entry also covers
 *   audio that crossed before it.
 */
export function drawStageSignal(ctx, o) {
  const { width: W, height: H, time, ink, dark } = o;
  const history = o.history?.length ? o.history : [{ t: 0, split: 1, grid: 0 }];
  const processing = history.filter((e) => !e.prep);
  const L = layout(o.size, W, H);
  const now = time * L.bps;
  // Audio moves left to right into the gate, but reads forwards, so position
  // grows with x and the clock scrolls it.
  const posAt = (x) => (x - L.gateX) / L.beat - now;
  // When the audio now at x crossed the gate, in clock seconds.
  const crossedAt = (x) => time - (x - L.gateX) / (L.beat * L.bps);
  const crossed = (x) => modeAt(processing, crossedAt(x));
  const gate = modeAt(history, time);
  // Intro: the beam's leading edge sweeps in to the prism, then the first
  // output's leading edge shoots from the exit face to the far edge.
  const taper = L.lane * 1.2;
  const beamFront = time >= ARRIVE ? Infinity : -taper + (L.gateX + taper) * easeOutCubic(time / ARRIVE);
  const emitAt = processing.length ? Math.max(processing[0].t, ARRIVE) : Infinity;
  const outFront = time < emitAt ? L.exitX : L.exitX + (W + taper - L.exitX) * easeOutCubic((time - emitAt) / SHOOT);
  const inBeam = (x) => (beamFront === Infinity ? 1 : smooth((beamFront - x) / taper));
  const outOf = (x) => smooth((outFront - x) / taper);
  const warm = ramp(ARRIVE * 0.6, ARRIVE + 1.2, time);
  const beam = dark ? WHITE : ink;
  // The metronome ticks as each beat clears the body's base, where its marker
  // is stamped.
  const stampX = L.gateX + L.side * 0.54;
  const tickNow = now - (stampX - L.gateX) / L.beat;
  const tickPhase = fract(tickNow); // beats since the last tick
  const lastTick = Math.round(tickPhase - tickNow);

  ctx.clearRect(0, 0, W, H);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Sample every band once, then derive the beam and the fanned-out bands.
  const count = Math.ceil(W / L.step) + 1;
  const xs = new Float32Array(count);
  const beamC = new Float32Array(count);
  const beamH = new Float32Array(count);
  const bandC = BANDS.map(() => new Float32Array(count));
  const bandH = BANDS.map(() => new Float32Array(count));
  const own = new Float32Array(BANDS.length);
  for (let i = 0; i < count; i += 1) {
    const x = Math.min(W, i * L.step);
    const p = posAt(x);
    xs[i] = x;
    let sum = 0;
    for (let b = 0; b < BANDS.length; b += 1) {
      own[b] = BANDS[b](p) * L.unit;
      sum += own[b];
    }
    // The beam is the bands stacked into one shape; after the prism they part
    // into their own lanes and grow to full size.
    const half = sum * MIX_GAIN;
    beamC[i] = L.mid;
    beamH[i] = half * inBeam(x) * (x > L.exitX ? outOf(x) : 1);
    const split = x > L.gateX ? crossed(x).split : 0;
    const k = split * ramp(L.exitX - L.side * 0.12, L.exitX + L.fanW, x);
    let top = L.mid - half;
    for (let b = 0; b < BANDS.length; b += 1) {
      const band = own[b] * MIX_GAIN;
      const stacked = top + band;
      top += band * 2;
      bandC[b][i] = stacked + (L.mid + (b - 2) * L.lane - stacked) * k;
      bandH[b][i] = (band + (own[b] - band) * k) * outOf(x);
    }
  }

  // Beat markers: a line through the audio capped with a bead in that beat's
  // colour, popping in at the stamp point and riding along with the audio.
  {
    const first = Math.ceil(posAt(stampX));
    const last = Math.floor(posAt(W));
    for (let n = first; n <= last; n += 1) {
      const age = n + tickNow;
      const x = stampX + age * L.beat;
      const grid = crossed(x).grid * outOf(x);
      if (grid <= 0.001) continue;
      const down = mod(n, 4) === 0;
      const grow = easeOutBack(age / 0.45);
      const reach = L.lane * (down ? 1.9 : 1.45) * grow;
      const w = L.board ? 2 : 1;
      ctx.fillStyle = rgba(ink, grid * (down ? 0.34 : 0.22));
      ctx.fillRect(x - w / 2, L.mid - reach, w, reach * 2);
      const r = (L.board ? (down ? 7.5 : 5) : down ? 2.6 : 1.8) * grow;
      ctx.fillStyle = rgba(BEAT_RGB[mod(n, 4)], grid);
      ctx.beginPath();
      ctx.arc(x, L.mid - reach, r, 0, TAU);
      ctx.fill();
    }
  }

  // Per-column opacity. Colour arrives inside the prism, while the bands are
  // still stacked; past the exit face only what has been emitted shows.
  const COLUMNS = 121;
  const bandCols = new Float32Array(COLUMNS);
  const beamCols = new Float32Array(COLUMNS);
  let anySplit = false;
  for (let i = 0; i < COLUMNS; i += 1) {
    const x = (i / (COLUMNS - 1)) * W;
    const inside = ramp(L.gateX, L.exitX, x);
    const split = x > L.gateX ? crossed(x).split : 0;
    const out = x > L.gateX ? outOf(x) : 1;
    bandCols[i] = inside * split * out;
    beamCols[i] = inBeam(x) * (1 - inside + inside * (1 - split) * out);
    if (bandCols[i] > 0.001) anySplit = true;
  }

  // Chunky candy shapes: a solid fill and a lighter rim.
  const drawShape = (centers, halves, rgb, columns, rim) => {
    envelopePath(ctx, xs, centers, halves);
    ctx.fillStyle = columnStyle(ctx, W, columns, rgb, rim ? 0.86 : dark ? 0.9 : 0.86);
    ctx.fill();
    ctx.lineWidth = L.stroke;
    ctx.strokeStyle = columnStyle(ctx, W, columns, rim ? tint(rgb, 0.35) : rgb, 0.9);
    ctx.stroke();
  };
  drawShape(beamC, beamH, beam, beamCols, false);
  if (anySplit) bandC.forEach((centers, b) => drawShape(centers, bandH[b], BAND_RGB[b], bandCols, true));

  // The body: glass over the beam. As a prism, the light fans into a rainbow
  // inside it; as a metronome, it carries the swinging arm.
  {
    const pop = easeOutBack(time / POP_IN);
    const g = bodyGeometry(L, gate.grid, pop);
    bodyPath(ctx, L, g);
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,0.9)";
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.clip();
    const left = L.gateX - L.side * 0.6;
    // While warming up the rainbow glimmers faintly; splitting lights it up.
    const prism = 1 - gate.grid;
    const colour = (0.6 * gate.split + 0.2 * warm * (1 - gate.split)) * prism;
    if (colour > 0.01) {
      // A rainbow that strengthens toward the exit face, and a soft white
      // glow where the beam comes in.
      const spread = L.lane * 1.6;
      const rainbow = ctx.createLinearGradient(0, L.mid - spread, 0, L.mid + spread);
      BAND_RGB.forEach((rgb, i) => rainbow.addColorStop(i / (BAND_RGB.length - 1), rgba(rgb, colour)));
      ctx.fillStyle = rainbow;
      ctx.fillRect(left, 0, L.side * 1.2, H);
      const fade = ctx.createLinearGradient(L.entryX, 0, L.exitX + L.side * 0.08, 0);
      fade.addColorStop(0, "rgba(0,0,0,1)");
      fade.addColorStop(0.4, "rgba(0,0,0,0.8)");
      fade.addColorStop(1, "rgba(0,0,0,0)");
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = fade;
      ctx.fillRect(left, 0, L.side * 1.2, H);
      ctx.globalCompositeOperation = "source-over";
      const glow = ctx.createRadialGradient(L.entryX, L.mid, 0, L.entryX, L.mid, L.lane * 1.4);
      glow.addColorStop(0, rgba(beam, 0.5 * warm * prism));
      glow.addColorStop(1, rgba(beam, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(left, 0, L.side * 1.2, H);
    }
    const glass = ctx.createLinearGradient(L.gateX - L.side / 2, g.apex, L.gateX + L.side / 2, g.base);
    glass.addColorStop(0, rgba(ink, 0.2));
    glass.addColorStop(1, rgba(ink, 0.04 + 0.08 * gate.grid));
    ctx.fillStyle = glass;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    bodyPath(ctx, L, g);
    ctx.lineWidth = L.stroke + (L.board ? 0.5 : 0.25);
    ctx.strokeStyle = rgba(ink, 0.85 * clamp01(pop));
    ctx.stroke();

    if (gate.grid > 0.01) {
      // The metronome: a slot down the face, and an arm that reaches each end
      // of its swing on a tick. The weight flashes the colour of that beat.
      const a = gate.grid;
      const pivotY = g.base - L.lane * 0.55;
      const slotW = L.lane * 0.22;
      ctx.fillStyle = rgba(ink, 0.16 * a);
      ctx.beginPath();
      ctx.roundRect(g.cx - slotW / 2, g.top + L.lane * 0.3, slotW, pivotY - g.top - L.lane * 0.3, slotW / 2);
      ctx.fill();
      const angle = 0.46 * a * Math.cos(Math.PI * tickNow);
      const len = g.h * 0.98;
      const dx = Math.sin(angle);
      const dy = -Math.cos(angle);
      ctx.lineWidth = L.board ? 4 : 1.5;
      ctx.strokeStyle = rgba(ink, 0.95 * a);
      ctx.beginPath();
      ctx.moveTo(g.cx, pivotY);
      ctx.lineTo(g.cx + dx * len, pivotY + dy * len);
      ctx.stroke();
      const color = BEAT_RGB[mod(lastTick, 4)];
      const hit = Math.exp(-tickPhase * 7);
      const wx = g.cx + dx * len * 0.64;
      const wy = pivotY + dy * len * 0.64;
      const wr = L.lane * 0.26 * (1 + 0.28 * hit) * a;
      ctx.lineWidth = L.board ? 2 : 1;
      ctx.strokeStyle = rgba(color, 0.55 * a * (1 - tickPhase));
      ctx.beginPath();
      ctx.arc(wx, wy, wr * (1 + 1.3 * easeOutBack(tickPhase)), 0, TAU);
      ctx.stroke();
      ctx.fillStyle = rgba(color, a);
      ctx.beginPath();
      ctx.arc(wx, wy, wr, 0, TAU);
      ctx.fill();
      ctx.lineWidth = L.board ? 2 : 1;
      ctx.strokeStyle = rgba(tint(color, 0.4), a);
      ctx.stroke();
      ctx.fillStyle = rgba(ink, a);
      ctx.beginPath();
      ctx.arc(g.cx, pivotY, L.lane * 0.12, 0, TAU);
      ctx.fill();
    }
  }

  // Soft edges so the beam enters and leaves instead of being cut off.
  ctx.globalCompositeOperation = "destination-in";
  const edge = ctx.createLinearGradient(0, 0, W, 0);
  edge.addColorStop(0, "rgba(0,0,0,0)");
  edge.addColorStop(L.fade, "rgba(0,0,0,1)");
  edge.addColorStop(1 - L.fade, "rgba(0,0,0,1)");
  edge.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = "source-over";
}

// Parse a computed CSS color ("rgb(...)", "rgba(...)" or "color(srgb ...)").
export function parseInk(value) {
  const nums = String(value || "").match(/-?[\d.]+/g)?.map(Number) || [];
  if (nums.length < 3) return [230, 233, 255];
  const scale = /^color\(/.test(String(value).trim()) ? 255 : 1;
  return nums.slice(0, 3).map((n) => Math.round(n * scale));
}

export function inkIsLight([r, g, b]) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
}

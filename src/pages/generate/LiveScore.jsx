import { useEffect, useRef } from "react";
import { FRET_COLORS } from "../../data/notePalette.js";
import { progressAt, STEM_LANES } from "./liveScore.js";

// The song while a run gets ready (liveScore.js): rows of time, read like a
// page. The mix starts as one grey waveform; as the separation gets through
// it, each bar springs apart into five colored lanes, the real stems. Then the
// beat finder makes a pass and leaves its beats under the rows. Everything
// moves at the real speed of the run; animations only ease what already
// happened. Draws at most 60 times a second, 30 where a frame is costly, and
// stops when idle: on a slow device the board shares the CPU with the run.

const [GREEN, RED, YELLOW, BLUE, ORANGE] = FRET_COLORS;
const STEM_COLORS = { vocals: RED, guitar: ORANGE, other: YELLOW, bass: GREEN, drums: BLUE };
// Each lane's mark, on a 24 unit square: filled shapes, rounded lines, and thin
// lines for what only holds the rest up.
const STEM_ICONS = {
  vocals: {
    fill: "M12 1.5a4.5 4.5 0 0 1 4.5 4.5v5.5a4.5 4.5 0 0 1-9 0V6A4.5 4.5 0 0 1 12 1.5z",
    line: "M4.8 11a7.2 7.2 0 0 0 14.4 0M12 18.5v3.2M8.2 22h7.6",
  },
  guitar: {
    fill: "M14.03 10.55C13.74 10.34 13.32 10.17 12.96 10.15L12.81 10.14C12.45 10.12 11.95 10.16 11.56 10.26L11.41 10.3C11.02 10.4 10.63 10.78 10.45 11.25L9.81 12.87C9.41 13.86 8.53 14.87 7.59 15.38L0.26 19.47C-0.7 20 -0.64 20.57 0.42 20.88L11.63 24.15C12.48 24.4 13.2 24 13.42 23.13L14.5 18.91C14.68 18.23 15.14 17.45 15.67 16.97L20.1 12.89C20.73 12.32 20.58 11.98 19.73 12.02L16.85 12.22C16.23 12.25 15.71 12.13 15.56 11.92L15.33 11.61C15.27 11.53 15.19 11.45 15.12 11.39ZM8.34 19.64L10.86 15.28C10.86 15.28 10.86 15.28 10.86 15.28L12.81 16.4C12.81 16.4 12.81 16.4 12.81 16.4L10.29 20.77C10.29 20.77 10.29 20.77 10.29 20.77L8.34 19.64C8.34 19.64 8.34 19.64 8.34 19.64ZM18.34 3.47C18.25 3.45 18.19 3.38 18.18 3.28L18.08 1.89C18.05 1.62 18.22 1.36 18.48 1.26L22.54 -0.2C23.11 -0.4 23.76 -0.34 24.16 -0.02L24.3 0.1C24.7 0.4 24.68 0.83 24.25 1.14L22.04 2.78C21.67 3.07 21.21 3.37 20.88 3.53L20.35 3.82C20.27 3.86 20.16 3.88 20.07 3.86Z",
    line: "M13.71 12.21L19.37 2.94",
  },
  other: {
    fill: "M3.15 19.84C2.53 18.12 3.79 16.09 5.97 15.3C8.15 14.51 10.42 15.25 11.05 16.96C11.67 18.68 10.41 20.71 8.23 21.5C6.05 22.29 3.78 21.55 3.15 19.84Z",
    line: "M9.95 17.4L9.95 2.6C10.4 6 16.6 6.8 16.6 11.6",
  },
  bass: {
    fill: "M14.94 10.71C14.42 9.1 14.39 7.27 15.34 5.49C17.09 6.92 17.63 8.29 18.04 9.65C18.59 10.9 20.95 9.93 23.25 12.48C25.84 15.36 25.04 18.97 22.81 20.99C20.57 23 16.89 23.42 14.3 20.54C12 17.98 13.5 16.05 12.23 14.89C11.52 14.37 10.74 14.26 9.83 13C11.08 12.33 12.45 11.8 13.41 12.09ZM15.2 17.42L20.06 13.05L21.67 14.84L16.81 19.21ZM2.5 -0.54L3.52 -1.46C3.94 -1.84 4.6 -1.8 4.98 -1.38L6.59 0.41C6.97 0.83 6.94 1.48 6.51 1.86L5.49 2.78C5.07 3.16 4.41 3.13 4.03 2.71L2.42 0.92C2.04 0.5 2.08 -0.16 2.5 -0.54Z",
    line: "M14.18 11.4L4.97 1.17",
  },
  drums: {
    fill: "M5.5 16.6C5.5 13.010050000000001 8.41005 10.100000000000001 12 10.100000000000001C15.58995 10.100000000000001 18.5 13.010050000000001 18.5 16.6C18.5 20.189950000000003 15.58995 23.1 12 23.1C8.41005 23.1 5.5 20.189950000000003 5.5 16.6ZM7.0 16.6C7.0 13.838500000000002 9.2385 11.600000000000001 12 11.600000000000001C14.7615 11.600000000000001 17.0 13.838500000000002 17.0 16.6C17.0 19.3615 14.7615 21.6 12 21.6C9.2385 21.6 7.0 19.3615 7.0 16.6ZM8.1 16.6C8.1 14.44603 9.846029999999999 12.700000000000001 12 12.700000000000001C14.153970000000001 12.700000000000001 15.9 14.44603 15.9 16.6C15.9 18.753970000000002 14.153970000000001 20.5 12 20.5C9.846029999999999 20.5 8.1 18.753970000000002 8.1 16.6ZM5.09 6.75L8.9 4.97C9.54 4.67 10.32 4.95 10.62 5.6L11.34 7.14C11.64 7.79 11.36 8.57 10.71 8.87L6.91 10.64C6.26 10.95 5.48 10.66 5.18 10.02L4.46 8.48C4.16 7.83 4.44 7.05 5.09 6.75ZM18.91 6.75L15.1 4.97C14.46 4.67 13.68 4.95 13.38 5.6L12.66 7.14C12.36 7.79 12.64 8.57 13.29 8.87L17.09 10.64C17.74 10.95 18.52 10.66 18.82 10.02L19.54 8.48C19.84 7.83 19.56 7.05 18.91 6.75ZM-0.77 3.79C-1.11 3.84 -1.19 3.3 -0.85 3.2C0.68 2.58 1.56 1.65 2.55 1.51C3.54 1.37 4.64 2.02 6.28 2.2C6.63 2.2 6.71 2.74 6.36 2.79ZM24.77 3.79C25.11 3.84 25.19 3.3 24.85 3.2C23.32 2.58 22.44 1.65 21.45 1.51C20.46 1.37 19.36 2.02 17.72 2.2C17.37 2.2 17.29 2.74 17.64 2.79Z",
    line: "",
    thin: "M2.7 3L2.7 19.6M2.7 19.6L0.9 23M2.7 19.6L4.5 23M21.3 3L21.3 19.6M21.3 19.6L23.1 23M21.3 19.6L19.5 23",
  },
};
const iconPaths = {};
function stemIcon(name) {
  const icon = STEM_ICONS[name];
  iconPaths[name] ||= { fill: new Path2D(icon.fill), line: new Path2D(icon.line), thin: icon.thin && new Path2D(icon.thin) };
  return iconPaths[name];
}

const INK = "#e8ecfa";
const MIX_COLOR = "rgba(149,160,187,0.42)";
const TIME_COLOR = "#8893b0";
const PANEL_COLOR = "rgba(255,255,255,0.035)";

const FRAME_MS = 1000 / 60;
const SLOW_FRAME_MS = 1000 / 30;
const COSTLY_DRAW_MS = 3;
const POP_MS = 380;
const TICK_POP_MS = 300;
const MIX_FADE_MS = 300;
const TOP = 18;
const BOTTOM = 14;
const RAIL = 9;
const ICON_PITCH = 11;

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const lerp = (a, b, k) => a + (b - a) * k;
const easeOut = (x) => 1 - (1 - x) ** 3;
const easeOutBack = (x) => {
  const k = x - 1;
  return 1 + 2.2 * k * k * k + 1.2 * k * k;
};

function fmtTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// As many rows as make both the lanes and the time as roomy as they can be.
function layoutRows(seconds, W, H) {
  const narrow = W < 560;
  const gutter = narrow ? 46 : 52;
  const padR = narrow ? 10 : 16;
  const gap = narrow ? 10 : 14;
  const rowW = W - gutter - padR;
  const room = H - TOP - BOTTOM + gap;
  let best = null;
  for (let count = 1; count <= 16; count += 1) {
    const laneH = Math.min(26, (room / count - gap - RAIL) / 5);
    if (laneH < 4) break;
    const fit = Math.min(laneH / 16, (rowW * count) / seconds / 16);
    if (!best || fit > best.fit) best = { count, laneH, fit };
  }
  const { count, laneH } = best || { count: 1, laneH: 4 };
  const pitchWanted = narrow ? 4 : 5;
  const barsPerRow = Math.max(4, Math.floor(rowW / pitchWanted));
  const pitch = rowW / barsPerRow;
  const rowH = laneH * 5 + RAIL + gap;
  const top = TOP + Math.max(0, (room - rowH * count) / 2);
  const rows = Array.from({ length: count }, (_, i) => ({ index: i, y: top + i * rowH, stripY: top + i * rowH + laneH * 5 }));
  return {
    W, H, gutter, rowW, rows, laneH, pitch, barsPerRow,
    barW: Math.max(2, Math.round(pitch * 0.62)),
    nBars: barsPerRow * count,
    rowSeconds: seconds / count,
    barSeconds: seconds / (barsPerRow * count),
  };
}

const barRow = (L, bar) => L.rows[Math.floor(bar / L.barsPerRow)];
const barX = (L, bar) => L.gutter + ((bar % L.barsPerRow) + 0.5) * L.pitch;

// A bar's level, 0..1: the loudest of the frames it covers mixed with their mean.
function barLevel(levels, rate, t0, t1) {
  if (!levels) return 0;
  const f0 = Math.floor(t0 * rate);
  const f1 = Math.max(f0 + 1, Math.ceil(t1 * rate));
  let sum = 0;
  let peak = 0;
  let count = 0;
  for (let f = f0; f < f1 && f < levels.length; f += 1) {
    const v = levels[f] / 255;
    sum += v;
    if (v > peak) peak = v;
    count += 1;
  }
  return count ? (sum / count + peak) / 2 : 0;
}

function capsule(ctx, x, y, h, w) {
  const height = Math.max(w, h);
  ctx.roundRect(x - w / 2, y - height / 2, w, height, w / 2);
}

function newLayer(canvas, dpr) {
  const layer = document.createElement("canvas");
  layer.width = canvas.width;
  layer.height = canvas.height;
  const ctx = layer.getContext("2d");
  ctx.scale(dpr, dpr);
  return { canvas: layer, ctx };
}

function drawBase(ctx, L, font) {
  for (const row of L.rows) {
    ctx.fillStyle = PANEL_COLOR;
    ctx.beginPath();
    ctx.roundRect(L.gutter - 4, row.y, L.rowW + 8, L.laneH * 5, 8);
    ctx.fill();
    if (row.index) drawTime(ctx, L, row, font);
  }
}

function drawTime(ctx, L, row, font) {
  ctx.fillStyle = TIME_COLOR;
  ctx.font = `600 10.5px ${font}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText(fmtTime(row.index * L.rowSeconds), L.gutter - 10, row.y + 1);
}

// The first row's gutter: its time until the lanes split, then each lane's
// icon, which springs out with the first bar. On a cramped board they keep a
// readable spacing and let their color say which lane is whose.
function drawFirstGutter(ctx, L, font, k) {
  const row = L.rows[0];
  if (k < 1) {
    ctx.globalAlpha = 1 - clamp01(k * 3);
    drawTime(ctx, L, row, font);
  }
  if (k > 0) {
    const mid = row.y + L.laneH * 2.5;
    const out = easeOutBack(k);
    const pitch = Math.max(L.laneH, ICON_PITCH);
    const size = Math.min(18, pitch - 1.5);
    ctx.globalAlpha = clamp01(k * 4);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    STEM_LANES.forEach((name, lane) => {
      const icon = stemIcon(name);
      ctx.save();
      ctx.translate(L.gutter - 10 - size, lerp(mid, mid + (lane - 2) * pitch, out) - size / 2);
      ctx.scale(size / 24, size / 24);
      ctx.fillStyle = STEM_COLORS[name] || INK;
      ctx.strokeStyle = ctx.fillStyle;
      if (icon.thin) {
        ctx.lineWidth = 1.7;
        ctx.stroke(icon.thin);
      }
      ctx.fill(icon.fill, "evenodd");
      ctx.lineWidth = 2.5;
      ctx.stroke(icon.line);
      ctx.restore();
    });
  }
  ctx.globalAlpha = 1;
}

function drawMix(ctx, L, levels, rate) {
  ctx.fillStyle = MIX_COLOR;
  ctx.beginPath();
  const room = L.laneH * 5 - 6;
  for (let bar = 0; bar < L.nBars; bar += 1) {
    const level = barLevel(levels, rate, bar * L.barSeconds, (bar + 1) * L.barSeconds);
    capsule(ctx, barX(L, bar), barRow(L, bar).y + L.laneH * 2.5, room * level, L.barW);
  }
  ctx.fill();
}

// One stem's piece of a bar, `k` of the way out of the mix (1 = settled).
function drawStemBar(ctx, L, stems, rate, bar, k, startH) {
  const row = barRow(L, bar);
  const x = barX(L, bar);
  const mid = row.y + L.laneH * 2.5;
  const out = easeOutBack(k);
  const grow = easeOut(k);
  STEM_LANES.forEach((name, lane) => {
    const level = barLevel(stems[name], rate, bar * L.barSeconds, (bar + 1) * L.barSeconds);
    const laneMid = row.y + (lane + 0.5) * L.laneH;
    const quiet = level < 0.06;
    ctx.globalAlpha = (quiet ? 0.28 : 0.72 + 0.28 * level) * clamp01(k * 4);
    ctx.fillStyle = STEM_COLORS[name] || INK;
    ctx.beginPath();
    capsule(ctx, x, lerp(mid, laneMid, out), lerp(startH, (L.laneH - 2) * level, grow), L.barW);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
}

function drawTick(ctx, L, tick, scale) {
  const r = Math.min(L.rows.length - 1, Math.floor(tick.t / L.rowSeconds));
  const row = L.rows[r];
  const x = L.gutter + ((tick.t - r * L.rowSeconds) / L.rowSeconds) * L.rowW;
  const y = row.stripY + RAIL / 2 + 0.5;
  ctx.fillStyle = tick.down ? INK : "rgba(232,236,250,0.42)";
  ctx.beginPath();
  if (tick.down) {
    const w = 3 * scale;
    const h = 7 * scale;
    ctx.roundRect(x - w / 2, y - h / 2, w, h, w / 2);
  } else {
    ctx.arc(x, y, 1.5 * scale, 0, Math.PI * 2);
  }
  ctx.fill();
}

// The working position: a chunky line down the row.
function drawCaret(ctx, L, pos) {
  const bars = pos * L.nBars;
  const r = Math.min(L.rows.length - 1, Math.floor(bars / L.barsPerRow));
  const row = L.rows[r];
  const x = L.gutter + (bars / L.barsPerRow - r) * L.rowW;
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.roundRect(x - 1.5, row.y - 4, 3, L.laneH * 5 + 8, 1.5);
  ctx.fill();
}

export default function LiveScore({ map, leaving = false }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return undefined;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const font = getComputedStyle(wrap).getPropertyValue("--font-mono").trim() || "monospace";
    let frame = 0;
    let last = { t: -Infinity, updatedAt: -1 };
    let dirty = true;
    let drawCost = 0;
    let key = "";
    let L = null;
    let base = null;
    let mix = null;
    let bars = null;
    let ticksLayer = null;
    let mixOf = null;
    // What has been shown so far: bars settled or springing, beats likewise.
    let barsShown = 0;
    let barsActive = [];
    let ticks = [];
    let ticksOf = null;
    let ticksShown = 0;
    let ticksActive = [];
    let namesAt = null;
    let namesSettled = false;

    const rebuild = (current, W, H, dpr) => {
      key = `${W}|${H}|${dpr}|${current.seconds}`;
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      L = layoutRows(current.seconds, W, H);
      base = newLayer(canvas, dpr);
      drawBase(base.ctx, L, font);
      mix = newLayer(canvas, dpr);
      drawMix(mix.ctx, L, current.mix, current.rate);
      mixOf = current.mix;
      bars = newLayer(canvas, dpr);
      ticksLayer = newLayer(canvas, dpr);
      barsShown = 0;
      barsActive = [];
      ticksOf = null;
      namesAt = null;
      namesSettled = false;
    };

    const readTicks = (current) => {
      if (ticksOf === current.beats) return;
      ticksOf = current.beats;
      // Each downbeat marks the beat it falls on.
      ticks = current.beats.map((t) => ({ t, down: false }));
      let at = 0;
      for (const t of current.downbeats) {
        while (at + 1 < ticks.length && Math.abs(ticks[at + 1].t - t) <= Math.abs(ticks[at].t - t)) at += 1;
        if (ticks.length) ticks[at].down = true;
      }
      // Spaced too tightly to tell apart, only the downbeats show.
      const gap = ticks.length > 1 ? (ticks[ticks.length - 1].t - ticks[0].t) / (ticks.length - 1) : 1;
      if ((gap / L.rowSeconds) * L.rowW < 4) ticks = ticks.filter((tick) => tick.down);
      // The final grid replaces the rough beats: what the pass has reached stays shown.
      const ctx = ticksLayer.ctx;
      ctx.clearRect(0, 0, L.W, L.H);
      ticksShown = 0;
      ticksActive = [];
      const reached = progressAt(current.beat, performance.now()) * current.seconds;
      while (ticksShown < ticks.length && ticks[ticksShown].t <= reached) {
        drawTick(ctx, L, ticks[ticksShown], 1);
        ticksShown += 1;
      }
    };

    const tick = (t) => {
      frame = requestAnimationFrame(tick);
      const current = mapRef.current;
      if (!current || !current.seconds) return;
      const splitting = t - (current.split?.at ?? -1e9) < (current.split?.dur ?? 0) + 60;
      const beating = t - (current.beat?.at ?? -1e9) < (current.beat?.dur ?? 0) + 60;
      const fadingIn = t - (current.mixAt ?? -1e9) < MIX_FADE_MS;
      const warm = current.phase === "warm" && !reduced;
      if (!dirty && !splitting && !beating && !fadingIn && !warm && !barsActive.length && !ticksActive.length && current.updatedAt === last.updatedAt) return;
      if (t - last.t < (drawCost > COSTLY_DRAW_MS ? SLOW_FRAME_MS : FRAME_MS) - 2) return;
      const drawStart = performance.now();
      last = { t, updatedAt: current.updatedAt };
      dirty = false;
      const W = wrap.clientWidth;
      const H = wrap.clientHeight;
      if (W < 40 || H < 40) return;
      const dpr = window.devicePixelRatio || 1;
      // A board that opens mid-run or resizes shows what has happened, without replaying it.
      const instant = reduced || !L || key !== `${W}|${H}|${dpr}|${current.seconds}`;
      if (key !== `${W}|${H}|${dpr}|${current.seconds}`) rebuild(current, W, H, dpr);
      if (mixOf !== current.mix) {
        mix.ctx.clearRect(0, 0, L.W, L.H);
        drawMix(mix.ctx, L, current.mix, current.rate);
        mixOf = current.mix;
      }

      const splitPos = current.stems ? progressAt(current.split, t) : 0;
      const available = Math.min(L.nBars, Math.floor(current.stemFrames / current.rate / L.barSeconds));
      const reachedBars = Math.min(available, Math.floor(splitPos * L.nBars));
      const startH = L.laneH * 1.2;
      while (barsShown < reachedBars) {
        if (!instant) barsActive.push({ bar: barsShown, at: t });
        else drawStemBar(bars.ctx, L, current.stems, current.rate, barsShown, 1, 0);
        barsShown += 1;
      }
      if (namesAt === null && barsShown > 0) namesAt = instant ? t - POP_MS : t;

      readTicks(current);
      const beatPos = progressAt(current.beat, t);
      const reachedTime = beatPos * current.seconds;
      while (ticksShown < ticks.length && ticks[ticksShown].t <= reachedTime) {
        if (reduced) drawTick(ticksLayer.ctx, L, ticks[ticksShown], 1);
        else ticksActive.push({ tick: ticks[ticksShown], at: t });
        ticksShown += 1;
      }

      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const px = (fn) => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        fn();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      };
      if (!namesSettled) {
        const k = namesAt === null ? 0 : clamp01((t - namesAt) / POP_MS);
        if (k >= 1) {
          drawFirstGutter(base.ctx, L, font, 1);
          namesSettled = true;
        } else {
          drawFirstGutter(ctx, L, font, k);
        }
      }
      px(() => ctx.drawImage(base.canvas, 0, 0));
      // The grey mix, only where the stems haven't reached yet.
      ctx.globalAlpha = clamp01((t - (current.mixAt ?? 0)) / MIX_FADE_MS);
      const shownW = (barsShown / L.barsPerRow);
      for (const row of L.rows) {
        const done = clamp01(shownW - row.index);
        if (done >= 1) continue;
        const x = L.gutter + done * L.rowW;
        const w = L.W - x;
        ctx.drawImage(mix.canvas, x * dpr, (row.y - 2) * dpr, w * dpr, (L.laneH * 5 + 4) * dpr, x, row.y - 2, w, L.laneH * 5 + 4);
      }
      ctx.globalAlpha = 1;
      px(() => {
        ctx.drawImage(bars.canvas, 0, 0);
        ctx.drawImage(ticksLayer.canvas, 0, 0);
      });

      barsActive = barsActive.filter((item) => {
        const k = clamp01((t - item.at) / POP_MS);
        if (k >= 1) {
          drawStemBar(bars.ctx, L, current.stems, current.rate, item.bar, 1, 0);
          drawStemBar(ctx, L, current.stems, current.rate, item.bar, 1, 0);
          return false;
        }
        drawStemBar(ctx, L, current.stems, current.rate, item.bar, k, startH);
        return true;
      });
      ticksActive = ticksActive.filter((item) => {
        const k = clamp01((t - item.at) / TICK_POP_MS);
        if (k >= 1) {
          drawTick(ticksLayer.ctx, L, item.tick, 1);
          drawTick(ctx, L, item.tick, 1);
          return false;
        }
        drawTick(ctx, L, item.tick, 1 + 1.4 * (1 - easeOut(k)));
        return true;
      });

      if (current.phase === "split" && current.split && splitPos < 1) drawCaret(ctx, L, splitPos);
      if (current.phase === "beat" && current.beat && beatPos < 1) drawCaret(ctx, L, beatPos);
      // Waiting on the model: the beats count along at the song's own speed.
      if (warm && ticks.length > 1) {
        const song = ((t - current.phaseAt) / 1000 + ticks[0].t) % current.seconds;
        let lo = 0;
        let hi = ticks.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (ticks[mid].t <= song) lo = mid;
          else hi = mid - 1;
        }
        const since = song - ticks[lo].t;
        drawTick(ctx, L, { t: ticks[lo].t, down: true }, 1 + 0.9 * (1 - clamp01(since / 0.28)));
      }
      drawCost = drawCost * 0.9 + (performance.now() - drawStart) * 0.1;
    };

    frame = requestAnimationFrame(tick);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { dirty = true; });
    observer?.observe(wrap);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, []);

  return (
    <div className={"live-score" + (leaving ? " is-leaving" : "")} ref={wrapRef}>
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  );
}

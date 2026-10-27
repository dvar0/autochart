// Generated cover art for projects without an album cover. Each song gets a
// seeded, deterministic print in one of six styles (riso shapes, brush, flow,
// marble, halftone, cutouts), so the same title and artist always produce the
// same cover. Pure canvas code: it runs on the main thread or inside the cover
// worker with an OffscreenCanvas, and touches no DOM beyond canvas creation.

const FRET = ["#21d07a", "#e2464a", "#f2c531", "#3a8ee6", "#f08a3c"];
const INKS = [...FRET, "#f5c2e7", "#b4befe", "#2ad1c4", "#ea76cb"];
// Pastels vanish on pale paper, so light grounds print with the saturated inks only.
const BOLD_INKS = INKS.filter((c) => c !== "#f5c2e7" && c !== "#b4befe");
const DARK = ["#1d2236", "#241a2e", "#14232a", "#2a1d22", "#1a1f2e", "#22223a", "#1f1a14"];
const LIGHT = ["#efe9dc", "#e4e6f7", "#f6e3ee", "#e3efe6", "#f3ead2", "#ebe4f5"];
const TAU = Math.PI * 2;
// Near-black ink for printing on colored grounds.
const INK_BLACK = "#1b1730";

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const range = (r, a, b) => a + r() * (b - a);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function inks(r, n, dark) {
  const pool = dark ? INKS : BOLD_INKS;
  const out = [];
  while (out.length < n) { const c = pick(r, pool); if (!out.includes(c)) out.push(c); }
  return out;
}
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function makeNoise(r) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const g = new Float32Array(256).map(() => r());
  const v = (x, y) => g[p[(p[x & 255] + y) & 255]];
  const n = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), w = yf * yf * (3 - 2 * yf);
    const a = v(xi, yi) + (v(xi + 1, yi) - v(xi, yi)) * u;
    const b = v(xi, yi + 1) + (v(xi + 1, yi + 1) - v(xi, yi + 1)) * u;
    return a + (b - a) * w;
  };
  return (x, y) => n(x, y) * 0.65 + n(x * 2.1 + 17, y * 2.1 + 31) * 0.35;
}
function makeCanvas(W) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(W, W);
  const c = document.createElement("canvas");
  c.width = c.height = W;
  return c;
}
const layer = makeCanvas;
function grain(ctx, W, r, amount) {
  const img = ctx.getImageData(0, 0, W, W);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const k = (r() - 0.5) * amount;
    d[i] += k; d[i + 1] += k; d[i + 2] += k;
  }
  ctx.putImageData(img, 0, 0);
}
function inkTexture(c, r) {
  const W = c.width, ctx = c.getContext("2d");
  const noise = makeNoise(r);
  const img = ctx.getImageData(0, 0, W, W);
  const d = img.data;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4 + 3;
      if (!d[i]) continue;
      let a = 0.8 + 0.2 * noise(x * 0.025, y * 0.025);
      a *= 0.86 + 0.14 * r();
      if (r() < 0.035) a *= 0.35;
      d[i] *= a;
    }
  }
  ctx.putImageData(img, 0, 0);
}
// Two ink layers, textured, overprinted with a little misregistration.
function risoPrint(ctx, W, r, opts) {
  const dark = opts.dark ?? r() < 0.55;
  ctx.fillStyle = pick(r, dark ? DARK : LIGHT);
  ctx.fillRect(0, 0, W, W);
  const [i1, i2] = inks(r, 2, dark);
  const l1 = layer(W), l2 = layer(W);
  const a = l1.getContext("2d"), b = l2.getContext("2d");
  a.fillStyle = a.strokeStyle = i1;
  b.fillStyle = b.strokeStyle = i2;
  a.lineCap = b.lineCap = "round";
  a.lineJoin = b.lineJoin = "round";
  opts.draw(a, b, r, W, l1, l2, i1, i2);
  inkTexture(l1, r); inkTexture(l2, r);
  ctx.globalCompositeOperation = dark ? "screen" : "multiply";
  ctx.drawImage(l1, 0, 0);
  ctx.drawImage(l2, range(r, -1, 1) * W * 0.012, range(r, -1, 1) * W * 0.012);
  ctx.globalCompositeOperation = "source-over";
  grain(ctx, W, r, dark ? 16 : 22);
  return { dark, ink: i1 };
}
function catalog(ctx, W, seed, dark) {
  ctx.font = `500 ${Math.round(W * 0.042)}px "JetBrains Mono", monospace`;
  ctx.fillStyle = dark ? "rgba(255,255,255,.55)" : "rgba(20,20,40,.55)";
  ctx.fillText("AC-" + String(hashStr(seed) % 1000).padStart(3, "0"), W * 0.06, W * 0.94);
}
// Antialiased banding of a scalar field into coverage per ink. assign(k) maps band k to an ink index or -1.
function bands(W, f, L, assign, nInks) {
  const G = W + 1;
  const v = new Float32Array(G * G);
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) v[y * G + x] = f(x, y);
  const cov = Array.from({ length: nInks }, () => new Float32Array(W * W));
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const c = v[y * G + x];
    const g = Math.hypot(v[y * G + x + 1] - c, v[(y + 1) * G + x] - c) * L + 1e-6;
    const t = c * L, k = Math.floor(t), fr = t - k;
    const near = fr < 0.5 ? k - 1 : k + 1;
    const own = clamp01(0.5 + (fr < 0.5 ? fr : 1 - fr) / g);
    const i = y * W + x;
    const ai = assign(k), bi = assign(near);
    if (ai >= 0) cov[ai][i] += own;
    if (bi >= 0) cov[bi][i] += 1 - own;
  }
  return cov;
}
function flowPath(field, x, y, steps, stepLen, s, twist, offset) {
  const pts = [[x, y]];
  for (let k = 0; k < steps; k++) {
    const a = field(x * s, y * s) * TAU * twist + offset;
    x += Math.cos(a) * stepLen; y += Math.sin(a) * stepLen;
    pts.push([x, y]);
  }
  return pts;
}

// --- Riso shapes: one big geometric object in two inks ---------------------
const RISO_COMPS = [
  function sun(a, b, r, W) {
    const cx = range(r, 0.35, 0.65) * W, cy = range(r, 0.34, 0.5) * W;
    a.beginPath(); a.arc(cx, cy, range(r, 0.26, 0.34) * W, 0, TAU); a.fill();
    let y = range(r, 0.5, 0.58) * W, h = W * 0.075;
    for (let i = 0; i < 6 && y < W; i++) { b.fillRect(0, y, W, h); y += h + W * 0.03; h *= 0.78; }
  },
  function arches(a, b, r, W) {
    const corner = Math.floor(r() * 4);
    const ox = corner & 1 ? W : 0, oy = corner & 2 ? W : 0;
    a.lineWidth = W * 0.055;
    for (let k = 1; k <= 6; k++) { a.beginPath(); a.arc(ox, oy, k * W * 0.17, 0, TAU); a.stroke(); }
    b.beginPath(); b.arc(ox ? W * 0.32 : W * 0.68, oy ? W * 0.32 : W * 0.68, W * range(r, 0.18, 0.26), 0, TAU); b.fill();
  },
  function split(a, b, r, W) {
    const t = range(r, 0.3, 0.7) * W;
    a.beginPath(); a.moveTo(0, t); a.lineTo(W, t - W * range(r, 0.2, 0.6)); a.lineTo(W, W); a.lineTo(0, W); a.fill();
    b.beginPath(); b.arc(range(r, 0.3, 0.7) * W, t - W * 0.12, W * range(r, 0.16, 0.24), 0, TAU); b.fill();
    for (let i = 0; i < 5; i++) { b.beginPath(); b.arc(W * (0.18 + i * 0.16), W * 0.86, W * 0.035, 0, TAU); b.fill(); }
  },
  function moon(a, b, r, W) {
    const R = range(r, 0.27, 0.34) * W;
    const cx = range(r, 0.38, 0.62) * W, cy = range(r, 0.36, 0.5) * W;
    a.beginPath(); a.arc(cx, cy, R, 0, TAU); a.fill();
    const dir = r() < 0.5 ? -1 : 1;
    b.beginPath(); b.arc(cx + dir * R * range(r, 0.45, 0.7), cy - R * 0.25, R * 0.92, 0, TAU); b.fill();
    a.lineWidth = W * 0.022;
    for (let i = 0; i < 3; i++) {
      const y = W * (0.8 + i * 0.06);
      a.beginPath(); a.moveTo(W * (0.12 + i * 0.08), y); a.lineTo(W * (0.88 - i * 0.08), y); a.stroke();
    }
  },
  function bauhaus(a, b, r, W) {
    const c = W / 2;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const ink = (i + j + Math.floor(r() * 2)) % 2 ? a : b;
      const x = j * c, y = i * c;
      ink.save();
      ink.beginPath(); ink.rect(x, y, c, c); ink.clip();
      const kind = Math.floor(r() * 3);
      ink.beginPath();
      if (kind === 0) {
        const cx = x + (r() < 0.5 ? 0 : c), cy = y + (r() < 0.5 ? 0 : c);
        ink.moveTo(cx, cy); ink.arc(cx, cy, c, 0, TAU);
      } else if (kind === 1) {
        const side = Math.floor(r() * 4);
        const cx = x + [c / 2, c, c / 2, 0][side], cy = y + [0, c / 2, c, c / 2][side];
        ink.arc(cx, cy, c / 2, 0, TAU);
      } else {
        ink.arc(x + c / 2, y + c / 2, c * 0.36, 0, TAU);
      }
      ink.fill();
      ink.restore();
    }
  },
  function ripple(a, b, r, W) {
    const cx = range(r, 0.3, 0.7) * W, cy = range(r, 0.3, 0.7) * W;
    a.lineWidth = W * 0.042;
    for (let k = 1; k <= 9; k++) { a.beginPath(); a.arc(cx, cy, k * W * 0.105, 0, TAU); a.stroke(); }
    const ang = r() * TAU;
    b.beginPath(); b.arc(cx + Math.cos(ang) * W * 0.13, cy + Math.sin(ang) * W * 0.13, W * range(r, 0.17, 0.24), 0, TAU); b.fill();
  },
  function stripes(a, b, r, W) {
    a.save();
    a.translate(W / 2, W / 2); a.rotate(range(r, -0.9, 0.9)); a.translate(-W / 2, -W / 2);
    a.beginPath(); a.rect(-W, W * range(r, 0.35, 0.55), W * 3, W * 2); a.clip();
    for (let x = -W; x < W * 2; x += W * 0.12) a.fillRect(x, -W, W * 0.06, W * 3);
    a.restore();
    b.beginPath(); b.arc(range(r, 0.35, 0.65) * W, range(r, 0.3, 0.45) * W, W * range(r, 0.24, 0.31), 0, TAU); b.fill();
  },
];
function risoShapes(ctx, W, seed) {
  const r = mulberry(hashStr(seed));
  const comp = pick(r, RISO_COMPS);
  const { dark, ink } = risoPrint(ctx, W, r, { draw: comp });
  catalog(ctx, W, seed, dark);
  return ink;
}

// --- Brush: one deliberate gesture, placed, turned and colored per song ----
function paintStroke(ctx, pts, w, color, r, dry) {
  const bristles = 30;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  for (let b = 0; b < bristles; b++) {
    const o = b / (bristles - 1) - 0.5;
    const end = Math.floor(pts.length * range(r, 0.82, 1));
    ctx.globalAlpha = range(r, 0.7, 1);
    ctx.lineWidth = (w / bristles) * range(r, 1.6, 2.4);
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < end - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const t = i / (pts.length - 1);
      // Loaded brush: lands round, holds width, lifts off thin.
      const taper = Math.min(1, Math.sqrt(t * 14)) * Math.pow(1 - t, 0.35);
      const px = x0 - (y1 - y0) / len * o * w * taper, py = y0 + (x1 - x0) / len * o * w * taper;
      // Dry brush only toward the tail, where the brush runs out of ink.
      if (dry(px * 0.06, py * 0.06) + t * t * 0.7 > 1.05) { pen = false; continue; }
      if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
function dab(ctx, r, x, y, R, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  const p = r() * TAU;
  for (let i = 0; i <= 60; i++) {
    const t = (i / 60) * TAU;
    const rr = R * (1 + 0.06 * Math.sin(t * 5 + p) + 0.04 * Math.sin(t * 11 + p * 2));
    i ? ctx.lineTo(x + Math.cos(t) * rr, y + Math.sin(t) * rr) : ctx.moveTo(x + Math.cos(t) * rr, y + Math.sin(t) * rr);
  }
  ctx.fill();
}
const curve = (n, f) => Array.from({ length: n + 1 }, (_, i) => f(i / n));
const bezier = (P) => (t) => {
  const u = 1 - t;
  return [0, 1].map((k) => u * u * u * P[0][k] + 3 * u * u * t * P[1][k] + 3 * u * t * t * P[2][k] + t * t * t * P[3][k]);
};
// Each gesture works in a unit square (0..1) and returns strokes with an ink slot: 0 main, 1 accent.
const GESTURES = {
  enso: (r) => {
    const a0 = r() * TAU, sweep = range(r, 1.7, 1.9) * Math.PI, R = range(r, 0.28, 0.33);
    return { strokes: [{ pts: curve(140, (t) => [0.5 + Math.cos(a0 + sweep * t) * R * (1 + 0.03 * Math.sin(t * 9)), 0.5 + Math.sin(a0 + sweep * t) * R]), w: range(r, 0.13, 0.17), ink: 0 }],
      dabs: r() < 0.5 ? [[0.5, 0.5, 0.06]] : [] };
  },
  swoosh: (r) => ({ strokes: [{ pts: curve(120, bezier([[0.1, 0.78], [range(r, 0.2, 0.5), range(r, 0.05, 0.3)], [range(r, 0.5, 0.8), range(r, 0.7, 0.95)], [0.9, 0.22]])), w: range(r, 0.2, 0.26), ink: 0 }], dabs: [] }),
  stack: (r) => {
    const n = 2 + Math.floor(r() * 3), hot = Math.floor(r() * n), gap = 0.5 / Math.max(1, n - 1);
    return { strokes: Array.from({ length: n }, (_, k) => {
      const y = 0.25 + k * gap, x0 = range(r, 0.1, 0.22), x1 = range(r, 0.7, 0.9), ph = r() * TAU;
      return { pts: curve(80, (t) => [x0 + (x1 - x0) * t, y + Math.sin(t * Math.PI + ph) * 0.015 - t * 0.02]), w: range(r, 0.12, 0.16) * (n > 3 ? 0.8 : 1), ink: k === hot ? 1 : 0 };
    }), dabs: [] };
  },
  slash: (r) => {
    const bend = range(r, -0.12, 0.12);
    return { strokes: [{ pts: curve(100, (t) => [0.18 + 0.6 * t + Math.sin(t * Math.PI) * bend, 0.86 - 0.72 * t]), w: range(r, 0.2, 0.25), ink: 0 }], dabs: [[0.72, 0.66, range(r, 0.08, 0.11)]] };
  },
  wave: (r) => {
    const f = range(r, 0.8, 1.6), ph = r() * TAU;
    return { strokes: [{ pts: curve(120, (t) => [0.08 + 0.84 * t, 0.5 + 0.13 * Math.sin(t * TAU * f + ph)]), w: range(r, 0.15, 0.2), ink: 0 }], dabs: [] };
  },
  spiral: (r) => {
    const turns = range(r, 1.8, 2.6), a0 = r() * TAU;
    return { strokes: [{ pts: curve(180, (t) => { const a = a0 + t * turns * TAU, rr = 0.04 + 0.3 * t; return [0.5 + Math.cos(a) * rr, 0.5 + Math.sin(a) * rr]; }), w: range(r, 0.07, 0.09), ink: 0 }], dabs: [] };
  },
  zigzag: (r) => {
    const n = 3 + Math.floor(r() * 3), pts = [];
    for (let i = 0; i <= n; i++) pts.push([0.12 + (0.76 * i) / n, i % 2 ? 0.3 : 0.7]);
    const dense = [];
    for (let i = 0; i < n; i++) for (let k = 0; k < 20; k++) {
      const t = k / 20;
      dense.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t]);
    }
    dense.push(pts[n]);
    return { strokes: [{ pts: dense, w: range(r, 0.1, 0.13), ink: 0 }], dabs: [] };
  },
  cross: (r) => ({ strokes: [
    { pts: curve(80, (t) => [0.2 + 0.6 * t, 0.2 + 0.6 * t + Math.sin(t * Math.PI) * 0.04]), w: range(r, 0.17, 0.21), ink: 0 },
    { pts: curve(80, (t) => [0.8 - 0.6 * t, 0.2 + 0.6 * t]), w: range(r, 0.17, 0.21), ink: r() < 0.5 ? 1 : 0 },
  ], dabs: [] }),
  dots: (r) => {
    const n = 3 + Math.floor(r() * 3), hot = Math.floor(r() * n), R = range(r, 0.07, 0.1);
    return { strokes: [{ pts: curve(80, (t) => [0.14 + 0.72 * t, 0.72 + Math.sin(t * Math.PI) * 0.03]), w: range(r, 0.05, 0.07), ink: 0 }],
      dabs: Array.from({ length: n }, (_, i) => [0.2 + (0.6 * i) / (n - 1), 0.42 - Math.sin((i / (n - 1)) * Math.PI) * 0.1, R, i === hot ? 1 : 0]) };
  },
  rainbow: (r) => {
    const n = 2 + Math.floor(r() * 2);
    return { strokes: Array.from({ length: n }, (_, k) => {
      const R = 0.36 - k * 0.11;
      return { pts: curve(100, (t) => [0.5 - Math.cos(t * Math.PI) * R, 0.78 - Math.sin(t * Math.PI) * R]), w: 0.09, ink: k % 2 };
    }), dabs: [] };
  },
  loop: (r) => {
    const loops = 2 + Math.floor(r() * 2), b = range(r, 0.09, 0.12);
    return { strokes: [{ pts: curve(200, (t) => { const th = t * loops * TAU; return [0.14 + 0.72 * t - b * Math.sin(th) * 0.9, 0.52 - b * Math.cos(th)]; }), w: range(r, 0.07, 0.09), ink: 0 }], dabs: [] };
  },
};
function brush(ctx, W, seed) {
  const r = mulberry(hashStr(seed));
  const mode = pick(r, ["paper", "paper", "dark", "color"]);
  const dark = mode === "dark";
  const [main, accent, alt] = inks(r, 3, dark || mode === "color");
  const paper = mode === "color" ? alt : pick(r, dark ? DARK : LIGHT);
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, W, W);
  // On a colored ground the brush paints in cream or ink-black instead of a third color.
  const inkMain = mode === "color" ? pick(r, ["#f4efe4", INK_BLACK]) : main;
  const dry = makeNoise(r);
  const g = GESTURES[pick(r, Object.keys(GESTURES))](r);
  const rot = range(r, -0.5, 0.5), scale = range(r, 0.85, 1.12);
  const ox = range(r, -0.06, 0.06), oy = range(r, -0.06, 0.06);
  const place = ([x, y]) => {
    const dx = (x - 0.5) * scale, dy = (y - 0.5) * scale;
    return [(0.5 + ox + dx * Math.cos(rot) - dy * Math.sin(rot)) * W, (0.5 + oy + dx * Math.sin(rot) + dy * Math.cos(rot)) * W];
  };
  const color = (k) => (k ? accent : inkMain);
  for (const s of g.strokes) paintStroke(ctx, s.pts.map(place), s.w * W * scale, color(s.ink), r, dry);
  for (const [x, y, R, k = 1] of g.dabs) { const [px, py] = place([x, y]); dab(ctx, r, px, py, R * W * scale, color(k)); }
  // A small seal stamp, like a print signature.
  const sz = W * 0.075, corner = r() < 0.5;
  const sx = corner ? W * 0.88 - sz : W * 0.12, sy = W * 0.9 - sz;
  ctx.fillStyle = accent; ctx.globalAlpha = 0.9;
  ctx.fillRect(sx, sy, sz, sz);
  ctx.globalAlpha = 1;
  ctx.fillStyle = paper;
  ctx.fillRect(sx + sz * 0.22, sy + sz * 0.22, sz * 0.18, sz * 0.56);
  ctx.fillRect(sx + sz * 0.58, sy + sz * 0.22, sz * 0.18, sz * 0.56);
  grain(ctx, W, r, dark ? 14 : 20);
  return mode === "color" ? paper : main;
}

// --- Flow: thick flow lines printed as two riso inks ----------------------
function flow(ctx, W, seed) {
  const r = mulberry(hashStr(seed));
  return risoPrint(ctx, W, r, {
    dark: r() < 0.7,
    draw(a, b, r, W) {
      const field = makeNoise(r);
      const s = range(r, 1.2, 2.4) / W, twist = range(r, 1, 2), offset = r() * TAU;
      const mask = makeNoise(r);
      for (let p = 0; p < 200; p++) {
        const x = range(r, -0.1, 1.1) * W, y = range(r, -0.1, 1.1) * W;
        const ink = mask(x * 2 / W, y * 2 / W) > 0.5 ? a : b;
        ink.lineWidth = W * range(r, 0.016, 0.04);
        const pts = flowPath(field, x, y, 30 + Math.floor(r() * 60), W * 0.009, s, twist, offset);
        ink.beginPath(); ink.moveTo(pts[0][0], pts[0][1]);
        for (const [px, py] of pts) ink.lineTo(px, py);
        ink.stroke();
      }
    },
  }).ink;
}

// --- Halftone: two sharp-edged abstract forms, each its own screen ---------
function screenDots(ctx, W, sp, ang, form, dot) {
  const ca = Math.cos(ang), sa = Math.sin(ang);
  for (let i = -W; i < W * 2; i += sp) for (let j = -W; j < W * 2; j += sp) {
    const x = W / 2 + (i - W / 2) * ca - (j - W / 2) * sa;
    const y = W / 2 + (i - W / 2) * sa + (j - W / 2) * ca;
    if (x < -sp || y < -sp || x > W + sp || y > W + sp) continue;
    const v = clamp01(form(x, y));
    if (v < 0.04) continue;
    if (dot === "circle") {
      ctx.beginPath(); ctx.arc(x, y, sp * 0.62 * Math.sqrt(v), 0, TAU); ctx.fill();
    } else {
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      if (dot === "square") { const h = sp * 0.5 * Math.sqrt(v); ctx.fillRect(-h, -h, h * 2, h * 2); }
      else ctx.fillRect(-sp * 0.51, -sp * 0.5 * v, sp * 1.02, sp * v);
      ctx.restore();
    }
  }
}
// Each form has a crisp silhouette and a graded interior, so it reads at thumbnail size.
const HALF_FORMS = {
  orb: (r, W) => {
    const cx = range(r, 0.3, 0.7) * W, cy = range(r, 0.3, 0.7) * W, R = range(r, 0.24, 0.34) * W;
    const lx = range(r, -0.7, 0.7), ly = -0.6;
    return (x, y) => {
      const nx = (x - cx) / R, ny = (y - cy) / R, d2 = nx * nx + ny * ny;
      if (d2 > 1) return 0;
      return 0.12 + 0.88 * (1 - clamp01(lx * nx + ly * ny + 0.55 * Math.sqrt(1 - d2)));
    };
  },
  eclipse: (r, W) => {
    const cx = range(r, 0.35, 0.65) * W, cy = range(r, 0.35, 0.65) * W, R = range(r, 0.26, 0.36) * W;
    return (x, y) => {
      const d = Math.hypot(x - cx, y - cy) / R;
      if (d > 1) return 0;
      return d > 0.68 ? 1 - Math.abs(d - 0.84) * 3 : d * 0.35;
    };
  },
  sunset: (r, W) => {
    const cx = range(r, 0.35, 0.65) * W, hz = range(r, 0.55, 0.68) * W, R = range(r, 0.26, 0.34) * W;
    return (x, y) => {
      if (y <= hz) {
        const d = Math.hypot(x - cx, y - hz);
        return d > R ? 0 : 0.2 + 0.8 * ((y - (hz - R)) / R);
      }
      // Reflection: bars that shorten as they go down.
      const t = (y - hz) / (W - hz);
      const half = R * (1 - t * 0.85);
      return Math.abs(x - cx) < half && Math.sin(t * 34) > -0.1 ? 0.85 - t * 0.5 : 0;
    };
  },
  band: (r, W) => {
    const a = range(r, -1.2, 1.2) + (r() < 0.5 ? Math.PI / 2 : 0), ca = Math.cos(a), sa = Math.sin(a);
    const off = range(r, -0.15, 0.15) * W, w = range(r, 0.2, 0.32) * W;
    return (x, y) => {
      const d = (x - W / 2) * ca + (y - W / 2) * sa - off;
      return Math.abs(d) > w / 2 ? 0 : 0.1 + 0.9 * (d / w + 0.5);
    };
  },
  arch: (r, W) => {
    const side = Math.floor(r() * 4), R = range(r, 0.42, 0.56) * W;
    const cx = [W * 0.5, W, W * 0.5, 0][side] + (side % 2 ? 0 : range(r, -0.15, 0.15) * W);
    const cy = [W, W * 0.5, 0, W * 0.5][side] + (side % 2 ? range(r, -0.15, 0.15) * W : 0);
    return (x, y) => {
      const d = Math.hypot(x - cx, y - cy) / R;
      return d > 1 ? 0 : 0.15 + 0.85 * Math.pow(d, 1.5);
    };
  },
  ripple: (r, W) => {
    const cx = range(r, 0.3, 0.7) * W, cy = range(r, 0.3, 0.7) * W, R = range(r, 0.3, 0.42) * W, k = 3 + Math.floor(r() * 2);
    return (x, y) => {
      const d = Math.hypot(x - cx, y - cy) / R;
      return d > 1 ? 0 : 0.5 + 0.5 * Math.cos(d * Math.PI * k);
    };
  },
  fold: (r, W) => {
    const flip = r() < 0.5;
    return (x, y) => {
      const u = x / W, v = flip ? 1 - y / W : y / W;
      return u > v ? 0.1 + 0.9 * u : 0.1 + 0.9 * (1 - v) * 0.6;
    };
  },
};
function halftone(ctx, W, seed) {
  const r = mulberry(hashStr(seed));
  const mode = pick(r, ["paper", "paper", "dark", "color"]);
  const dark = mode === "dark";
  let [i1, i2, i3] = inks(r, 3, dark);
  // On a colored ground, two more colored inks fight it, so print in ink-black and cream instead.
  if (mode === "color") [i1, i2] = r() < 0.5 ? [INK_BLACK, "#f4efe4"] : ["#f4efe4", INK_BLACK];
  ctx.fillStyle = mode === "color" ? i3 : pick(r, dark ? DARK : LIGHT);
  ctx.fillRect(0, 0, W, W);
  const names = Object.keys(HALF_FORMS);
  const nA = pick(r, names);
  let nB = pick(r, names);
  while (nB === nA) nB = pick(r, names);
  const formA = HALF_FORMS[nA](r, W), formB = HALF_FORMS[nB](r, W);
  // A coarse primary screen and a finer secondary at a different angle, so they moiré where they meet.
  const spA = W / (12 + Math.floor(r() * 5)), spB = W / (22 + Math.floor(r() * 8));
  const dotA = pick(r, ["circle", "circle", "square"]), dotB = pick(r, ["circle", "circle", "square"]);
  const l1 = layer(W), l2 = layer(W);
  const a = l1.getContext("2d"), b = l2.getContext("2d");
  b.fillStyle = i2; screenDots(b, W, spB, range(r, 0.9, 1.3), formB, dotB);
  a.fillStyle = i1; screenDots(a, W, spA, range(r, 0.15, 0.45), formA, dotA);
  ctx.globalCompositeOperation = mode === "color" ? "source-over" : dark ? "screen" : "multiply";
  ctx.drawImage(l2, 0, 0);
  ctx.drawImage(l1, range(r, -1, 1) * W * 0.01, range(r, -1, 1) * W * 0.01);
  ctx.globalCompositeOperation = "source-over";
  grain(ctx, W, r, 14);
  return mode === "color" ? i3 : i1;
}

// --- Cutouts: two or three big cut-paper shapes in a composed layout -------
function shapePath(ctx, r, cx, cy, R, kind, rot = 0) {
  ctx.beginPath();
  if (kind === "leaf") {
    const ux = Math.cos(rot), uy = Math.sin(rot), l = R * 1.25, w = R * 0.75;
    ctx.moveTo(cx - ux * l, cy - uy * l);
    ctx.quadraticCurveTo(cx - uy * w * 2, cy + ux * w * 2, cx + ux * l, cy + uy * l);
    ctx.quadraticCurveTo(cx + uy * w * 2, cy - ux * w * 2, cx - ux * l, cy - uy * l);
    return;
  }
  if (kind === "half") {
    ctx.arc(cx, cy, R, Math.PI + rot, rot);
    ctx.closePath();
    return;
  }
  const lobes = kind === "frond" ? 6 + Math.floor(r() * 3) : 3;
  const amp = kind === "frond" ? 0.22 : 0.1;
  const n = kind === "star" ? 12 : 120;
  const p = r() * TAU;
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * TAU + rot;
    const rr = kind === "star" ? R * (i % 2 ? 0.55 : 1) : R * (1 + amp * Math.sin(lobes * t + p));
    const x = cx + Math.cos(t) * rr, y = cy + Math.sin(t) * rr;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
}
const CUT_LAYOUTS = [
  // One giant shape cropped by an edge, a counter-shape, a small accent.
  (r) => {
    const left = r() < 0.5;
    return [
      { x: left ? range(r, -0.05, 0.12) : range(r, 0.88, 1.05), y: range(r, 0.35, 0.65), R: range(r, 0.5, 0.62), kind: pick(r, ["blob", "frond", "leaf"]) },
      { x: left ? 0.74 : 0.26, y: range(r, 0.25, 0.4), R: range(r, 0.2, 0.26), kind: pick(r, ["blob", "star", "leaf"]) },
      { x: left ? 0.7 : 0.3, y: range(r, 0.74, 0.84), R: range(r, 0.08, 0.11), kind: "blob" },
    ];
  },
  // Two big leaves crossing at the center.
  (r) => {
    const a = range(r, 0.5, 1.1);
    return [
      { x: 0.46, y: 0.5, R: range(r, 0.36, 0.42), kind: "leaf", rot: a },
      { x: 0.56, y: 0.52, R: range(r, 0.3, 0.36), kind: "leaf", rot: a + range(r, 1.2, 1.8) },
      { x: range(r, 0.2, 0.8), y: 0.18, R: 0.07, kind: "blob" },
    ];
  },
  // A big half-disc rising from the bottom, a shape resting on it, a sun.
  (r) => [
    { x: range(r, 0.4, 0.6), y: 1.0, R: range(r, 0.46, 0.56), kind: "half", rot: 0 },
    { x: range(r, 0.35, 0.65), y: range(r, 0.42, 0.5), R: range(r, 0.17, 0.22), kind: pick(r, ["frond", "star", "blob"]) },
    { x: range(r, 0.15, 0.3) + (r() < 0.5 ? 0.55 : 0), y: 0.2, R: range(r, 0.08, 0.11), kind: "blob" },
  ],
  // One huge frond filling the frame, a small star.
  (r) => [
    { x: range(r, 0.42, 0.58), y: range(r, 0.45, 0.58), R: range(r, 0.4, 0.46), kind: "frond" },
    { x: range(r, 0.15, 0.3), y: range(r, 0.15, 0.3), R: range(r, 0.09, 0.12), kind: "star" },
  ],
];
function cutouts(ctx, W, seed) {
  const r = mulberry(hashStr(seed));
  const dark = r() < 0.3;
  const pal = inks(r, 4, dark);
  ctx.fillStyle = dark ? pick(r, DARK) : pal[0];
  ctx.fillRect(0, 0, W, W);
  const shapes = pick(r, CUT_LAYOUTS)(r);
  shapes.forEach((s, i) => {
    ctx.save();
    ctx.shadowColor = "rgba(10,8,20,.4)";
    ctx.shadowBlur = W * 0.04;
    ctx.shadowOffsetX = W * 0.012; ctx.shadowOffsetY = W * 0.02;
    ctx.fillStyle = pal[1 + (i % 3)];
    shapePath(ctx, r, s.x * W, s.y * W, s.R * W, s.kind, s.rot ?? r() * TAU);
    ctx.fill();
    ctx.restore();
  });
  grain(ctx, W, r, 20);
  return dark ? pal[1] : pal[0];
}

// --- Marble: combed paper-marbling bands in three flat inks ---------------
function marble(ctx, W, seed) {
  const r = mulberry(hashStr(seed));
  const dark = r() < 0.5;
  const ground = rgb(pick(r, dark ? DARK : LIGHT));
  const hexes = inks(r, 3, dark);
  const pal = hexes.map(rgb);
  const n = makeNoise(r), m = makeNoise(r);
  const th = r() * TAU, cs = Math.cos(th), sn = Math.sin(th);
  const freq = range(r, 2.5, 5), strength = range(r, 0.8, 1.8), s = range(r, 1.2, 2.4);
  const f = (x, y) => {
    const u = x / W, v = y / W;
    const w = (n(u * s, v * s) - 0.5) * strength + (m(u * s * 2.3, v * s * 2.3) - 0.5) * strength * 0.4;
    return (Math.sin(((u * cs + v * sn) * freq + w * 2) * TAU) + 1) / 2;
  };
  const pattern = pick(r, [[0, -1, 1, 2], [0, 1, -1, 2, -1], [0, 2, 1, -1]]);
  const cov = bands(W, f, pattern.length, (k) => (k >= 0 && k < pattern.length ? pattern[k] : -1), 3);
  const img = ctx.createImageData(W, W);
  for (let i = 0; i < W * W; i++) {
    let R = ground[0], G = ground[1], B = ground[2];
    for (let l = 0; l < 3; l++) {
      const c = clamp01(cov[l][i]);
      if (!c) continue;
      R += (pal[l][0] - R) * c; G += (pal[l][1] - G) * c; B += (pal[l][2] - B) * c;
    }
    const j = i * 4;
    img.data[j] = R; img.data[j + 1] = G; img.data[j + 2] = B; img.data[j + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  grain(ctx, W, r, dark ? 12 : 18);
  return hexes[0];
}

const STYLES = [risoShapes, brush, flow, marble, halftone, cutouts];

export function coverArtSeed(title, artist) {
  return `${title || ""}${artist || ""}`;
}

// Draw the cover for `seed` into a new size x size canvas. Returns the canvas
// and the cover's dominant ink, which the library uses as the song's accent.
export function renderCoverArt(seed, size) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext("2d");
  const style = STYLES[hashStr(seed + "|style") % STYLES.length];
  const accent = style(ctx, size, seed);
  return { canvas, accent };
}

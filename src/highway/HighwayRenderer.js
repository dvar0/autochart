// Draws the guitar highway to a 2D canvas. Pure rendering: it owns no timing
// or audio — call draw(songTime) each frame from the game loop. Decoupled from
// React so the per-frame work never touches the reconciler.

import {
  LANE_COUNT,
  LANE_COLORS,
  createProjection,
} from "./projection.js";
import { OPEN_NOTE_COLOR } from "../data/notePalette.js";

// Blend a #rrggbb color toward white (amt > 0) or black (amt < 0), 0..1.
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const target = amt < 0 ? 0 : 255;
  const t = Math.abs(amt);
  const mix = (c) => Math.round(c + (target - c) * t);
  return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
}

// Accept both palette hex colors and the rgb() values returned by shade().
function rgba(hex, a) {
  const [r, g, b] = colorToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function colorToRgb(color) {
  if (color.startsWith("#")) {
    const n = parseInt(color.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const parts = color.match(/\d+/g)?.map(Number) || [255, 255, 255];
  return [parts[0] ?? 255, parts[1] ?? 255, parts[2] ?? 255];
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lowerBoundNumber(values, target) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lowerBoundNoteTime(notes, target) {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].time < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const EFFECT_PROFILES = {
  lite: {
    particleCap: 120,
    particleCount: 3,
    particleLife: 0.24,
    particleLifeJitter: 0.12,
    particleSpeed: 70,
    particleSpeedJitter: 110,
    flameCap: 18,
    flameLife: 0.18,
    flameHeight: 3.5,
    flameGlow: 1.35,
  },
  rich: {
    particleCap: 340,
    particleCount: 8,
    particleLife: 0.3,
    particleLifeJitter: 0.16,
    particleSpeed: 90,
    particleSpeedJitter: 160,
    flameCap: 48,
    flameLife: 0.24,
    flameHeight: 4.4,
    flameGlow: 1.65,
  },
};

// Prerendered flame texture variants (see _flameSprites).
const FLAME_SPRITE_VARIANTS = 4;

// One symmetric silhouette shared by every layer of a star-power gem.
const STAR_POINTS = Array.from({ length: 10 }, (_, i) => {
  const angle = -Math.PI / 2 + Math.PI / 5 + i * Math.PI / 5;
  const radius = i % 2 === 0 ? 1 : 0.52;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius];
});

export class HighwayRenderer {
  constructor(
    canvas,
    { lookAhead = 1.4, zMax = 1.75, hitEffects = true, effectProfile = "lite" } = {}
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.lookAhead = lookAhead;
    this.effectProfile = EFFECT_PROFILES[effectProfile] || EFFECT_PROFILES.lite;
    // Perspective aggressiveness (depth at the horizon). See projection.js.
    this.zMax = zMax;
    this.notes = [];
    // Lanes with a sustain visually ringing this frame.
    this._sustainLanes = new Set();
    this.hitFlash = new Map();
    // Live hit-burst particles, animated against songTime.
    this._particles = [];
    // Live flame jets shooting up from a strike button on a hit, keyed nowhere
    // — just a flat list animated against songTime, like the particles.
    this._flames = [];
    // Star-power phrase ranges (seconds), for the highway glow.
    this._starPhrases = [];
    // Solo phrase ranges (seconds), drawn as lightweight runway bands.
    this._soloPhrases = [];
    this._gemSprites = new Map();
    // Static-geometry caches, rebuilt on resize: the board + lane lines layer,
    // the strike-line layer, and the pre-rendered fret-button sprites. Blitting
    // these each frame replaces dozens of per-frame gradient/stroke ops, which
    // is what keeps the hot loop from stuttering.
    this._backLayer = null;
    this._strikeLayer = null;
    this._buttonSprites = null;
    // Beat-rung gradient strips, keyed by quantized perspective scale.
    this._rungCache = new Map();
    // Reusable scratch for the per-frame visible-note pass (no allocations).
    this._visNotes = [];
    this._visDepths = [];
    this._dpr = 1;
    // Reduced motion only quiets decorative glows and bursts; notes and sustain
    // ribbons continue to scroll so the visual preview remains understandable.
    this.reduceMotion = false;
    this.hitEffects = hitEffects;
    this.resize();
  }

  // Honor the user's prefers-reduced-motion preference. Toggled live from React.
  setReduceMotion(on) {
    this.reduceMotion = !!on;
    if (this.reduceMotion) this.clearEffects();
  }

  setEffectProfile(profile) {
    this.effectProfile = EFFECT_PROFILES[profile] || EFFECT_PROFILES.lite;
  }

  clearEffects() {
    this.hitFlash.clear();
    this._particles.length = 0;
    this._flames.length = 0;
  }

  // Seconds of chart visible from the strike line to the horizon. Higher = more
  // reaction time / slower scroll. Rebuilds the projection.
  setLookAhead(seconds) {
    this.lookAhead = Math.max(0.4, seconds);
    this.resize();
  }

  // Perspective aggressiveness. Higher = notes accelerate harder into the strike
  // zone; lower = flatter, more even approach. Rebuilds the projection.
  setPerspective(zMax) {
    this.zMax = Math.max(0.5, zMax);
    this.resize();
  }

  // Visual strike feedback for notes crossing the near plane.
  flashLane(lane, songTime) {
    this.hitFlash.set(lane, songTime);
    if (this.hitEffects && !this.reduceMotion) {
      this._spawnHitBurst(lane, songTime);
      this._spawnFlame(lane, songTime);
    }
  }

  setNotes(notes) {
    this.notes = notes;
    this.maxSustainSeconds = notes.reduce(
      (max, n) => Math.max(max, Math.max(0, (n.endTime || n.time) - n.time)),
      0
    );
  }


  // Recompute backing-store size for the current element size + DPR.
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w === this.cssWidth && h === this.cssHeight && dpr === this._dpr &&
        this.proj?.lookAhead === this.lookAhead && this._projectionZ === this.zMax) return;
    this.cssWidth = w;
    this.cssHeight = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._dpr = dpr;
    this.proj = createProjection(w, h, this.lookAhead, this.zMax);
    this._projectionZ = this.zMax;
    // Geometry changed: rebuild the prerendered static layers and sprites.
    this._backLayer = null;
    this._strikeLayer = null;
    this._buttonSprites = null;
    this._fogGrad = null;
  }

  draw(songTime) {
    const ctx = this.ctx;
    const p = this.proj;
    ctx.clearRect(0, 0, p.width, p.height);

    this._ensureStaticLayers();
    ctx.drawImage(this._backLayer, 0, 0, p.width, p.height); // board + lane lines
    this._drawStarGlow(songTime);
    this._drawSoloBands(songTime);
    this._drawBeatLines(songTime);
    ctx.drawImage(this._strikeLayer, 0, 0, p.width, p.height);
    const visibleCount = this._collectVisibleNotes(songTime);
    this._drawNotes(songTime, "sustains", visibleCount);
    this._drawStrikeZone(songTime);
    this._drawFlames(songTime);
    this._drawNotes(songTime, "heads", visibleCount);
    this._drawHorizonFog();
    this._drawParticles(songTime);
  }

  // Prerender the projection-static geometry into offscreen layers so the hot
  // loop blits two images instead of re-running gradients and strokes. The
  // strike plate stays separate so it sits beneath the ribbons and frets.
  _ensureStaticLayers() {
    if (this._backLayer) return;
    const prev = this.ctx;
    try {
      this._backLayer = this._makeLayer((ctx) => {
        this.ctx = ctx;
        this._drawBoard();
        this._drawLaneLines();
      });
      this._strikeLayer = this._makeLayer((ctx) => {
        this.ctx = ctx;
        this._paintStrikePlate();
      });
    } finally {
      this.ctx = prev;
    }
  }

  _makeLayer(paint) {
    const p = this.proj;
    const dpr = this._dpr || 1;
    const layer = document.createElement("canvas");
    layer.width = Math.max(1, Math.round(p.width * dpr));
    layer.height = Math.max(1, Math.round(p.height * dpr));
    const ctx = layer.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    paint(ctx);
    return layer;
  }

  // Board trapezoid converging to the horizon vanishing point, as a path. The
  // near edge extends past the strike line all the way to the bottom of the
  // canvas so the highway runs off-screen rather than ending in a visible cut.
  _traceBoardPath() {
    const ctx = this.ctx;
    const p = this.proj;
    const far = p.project(1);
    const bottomScale = p.scaleForY(p.height);
    const bottomHalf = p.halfWidthNear * bottomScale;
    const farHalf = p.halfWidthNear * far.scale;
    ctx.beginPath();
    ctx.moveTo(p.centerX - bottomHalf, p.height);
    ctx.lineTo(p.centerX + bottomHalf, p.height);
    ctx.lineTo(p.centerX + farHalf, far.y);
    ctx.lineTo(p.centerX - farHalf, far.y);
    ctx.closePath();
  }

  _drawBoard() {
    const ctx = this.ctx;
    const p = this.proj;
    const far = p.project(1);
    const bottomScale = p.scaleForY(p.height);

    this._traceBoardPath();
    const grad = ctx.createLinearGradient(0, far.y, 0, p.height);
    grad.addColorStop(0, "#090e19");
    grad.addColorStop(0.6, "#131d2c");
    grad.addColorStop(1, "#080d16");
    ctx.fillStyle = grad;
    ctx.fill();

    // A restrained lane tint gives the dark runway depth without competing
    // with the saturated gems. This entire surface is cached on resize.
    ctx.save();
    this._traceBoardPath();
    ctx.clip();
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const tint = ctx.createLinearGradient(0, far.y, 0, p.height);
      tint.addColorStop(0, rgba(LANE_COLORS[lane], 0));
      tint.addColorStop(0.8, rgba(LANE_COLORS[lane], 0.035));
      tint.addColorStop(1, rgba(LANE_COLORS[lane], 0.015));
      ctx.fillStyle = tint;
      const x0Near = (lane - LANE_COUNT / 2) * p.laneSpacingNear;
      const x1Near = x0Near + p.laneSpacingNear;
      ctx.beginPath();
      ctx.moveTo(p.centerX + x0Near * bottomScale, p.height);
      ctx.lineTo(p.centerX + x1Near * bottomScale, p.height);
      ctx.lineTo(p.centerX + x1Near * far.scale, far.y);
      ctx.lineTo(p.centerX + x0Near * far.scale, far.y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  _drawLaneLines() {
    const ctx = this.ctx;
    const p = this.proj;
    // LANE_COUNT lanes => LANE_COUNT + 1 dividers (including outer edges).
    // Dividers run from the horizon down to the bottom edge of the canvas, in
    // step with the board's extended near edge.
    const far = p.project(1);
    const bottomScale = p.scaleForY(p.height);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(186,205,231,0.09)";
    for (let i = 1; i < LANE_COUNT; i++) {
      const offsetNear = (i - LANE_COUNT / 2) * p.laneSpacingNear;
      ctx.beginPath();
      ctx.moveTo(p.centerX + offsetNear * bottomScale, p.height);
      ctx.lineTo(p.centerX + offsetNear * far.scale, far.y);
      ctx.stroke();
    }
    // Edge rails: the silhouette of the highway, brighter than the inner
    // dividers and brightening toward the viewer so the board reads as a
    // solid object rather than a flat wedge.
    const rail = ctx.createLinearGradient(0, far.y, 0, p.height);
    rail.addColorStop(0, "rgba(140,180,225,0.03)");
    rail.addColorStop(0.65, "rgba(140,180,225,0.42)");
    rail.addColorStop(1, "rgba(140,180,225,0.15)");
    ctx.strokeStyle = rail;
    ctx.lineWidth = 1.5;
    for (const i of [0, LANE_COUNT]) {
      const offsetNear = (i - LANE_COUNT / 2) * p.laneSpacingNear;
      ctx.beginPath();
      ctx.moveTo(p.centerX + offsetNear * bottomScale, p.height);
      ctx.lineTo(p.centerX + offsetNear * far.scale, far.y);
      ctx.lineWidth = 7;
      ctx.strokeStyle = "rgba(4,8,15,0.85)";
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = rail;
      ctx.stroke();
    }
  }

  // Depth haze over the far end of the board. A light touch — the per-note
  // depth fade does the heavy lifting for pop-in; this just settles the far
  // rungs/sustains into the backdrop. Clipped to the board so a background
  // image/video behind the highway is untouched.
  _drawHorizonFog() {
    const ctx = this.ctx;
    const p = this.proj;
    if (!this._fogGrad) {
      const y0 = p.horizonY;
      const y1 = p.horizonY + (p.strikeY - p.horizonY) * 0.3;
      const grad = ctx.createLinearGradient(0, y0, 0, y1);
      grad.addColorStop(0, "rgba(7,9,15,0.31)");
      grad.addColorStop(0.5, "rgba(7,9,15,0.13)");
      grad.addColorStop(1, "rgba(7,9,15,0)");
      this._fogGrad = { grad, y0, y1 };
    }
    const { grad, y0, y1 } = this._fogGrad;
    ctx.save();
    this._traceBoardPath();
    ctx.clip();
    ctx.fillStyle = grad;
    ctx.fillRect(0, y0, p.width, y1 - y0);
    ctx.restore();
  }

  // Fine perspective-scaled beat lines provide timing without looking like
  // additional notes in dense passages.
  _drawBeatLines(songTime) {
    const beats = this._beatTimes;
    if (!beats) return;
    const ctx = this.ctx;
    const p = this.proj;
    const start = lowerBoundNumber(beats, songTime - p.lookAhead * 0.25);
    const end = lowerBoundNumber(beats, songTime + p.lookAhead);
    const strikeR = p.gemRadiusNear * p.project(0).scale;
    for (let i = start; i < end; i++) {
      const t = beats[i];
      const d = p.depthForTime(t, songTime);
      if (d > 1) continue;
      const { scale, y } = p.project(d);
      // scale <= 0 is past the projection singularity (far behind the
      // viewer); y > height is already below the canvas.
      if (scale <= 0 || y > p.height) continue;
      // Rungs dissolve just above the strike plate: a grey line crossing the
      // button row reads as an artifact, and the notes themselves carry the
      // timing there. Full strength for the rest of the board.
      const fade = Math.max(
        0,
        Math.min(1, (p.strikeY - strikeR * 0.6 - y) / (strikeR * 0.75))
      );
      if (fade <= 0) continue;
      const half = p.halfWidthNear * scale;
      const h = Math.max(1, 2.2 * scale);
      const x = p.centerX - half;
      const w = half * 2;

      ctx.globalAlpha = fade * 0.65;
      // Rounded vertical shading: bright in the middle, falling off top/bottom.
      // The gradient strip is cached per quantized scale — building a fresh
      // gradient per rung per frame shows up in profiles.
      ctx.drawImage(this._rungSprite(scale), x, y - h / 2, w, h);

      // Crisp highlight along the leading (top) edge for a beveled look.
      ctx.fillStyle = `rgba(190,211,238,${0.22 * scale + 0.06})`;
      ctx.fillRect(x, y - h / 2, w, Math.max(1, h * 0.22));
      ctx.globalAlpha = 1;
    }
  }

  // A rung's vertical gradient as a 1px-wide strip, cached by quantized scale
  // (the middle stop's alpha varies with scale; 1/32 steps are invisible).
  // Stretching the strip to the rung's width/height is exact for a vertical
  // gradient and far cheaper than a per-rung createLinearGradient each frame.
  _rungSprite(scale) {
    const q = Math.max(0, Math.min(32, Math.round(scale * 32)));
    let strip = this._rungCache.get(q);
    if (!strip) {
      strip = document.createElement("canvas");
      strip.width = 1;
      strip.height = 32;
      const c = strip.getContext("2d");
      const grad = c.createLinearGradient(0, 0, 0, 32);
      grad.addColorStop(0, "rgba(255,255,255,0.04)");
      grad.addColorStop(0.5, `rgba(255,255,255,${0.26 * (q / 32) + 0.06})`);
      grad.addColorStop(1, "rgba(0,0,0,0.28)");
      c.fillStyle = grad;
      c.fillRect(0, 0, 1, 32);
      this._rungCache.set(q, strip);
    }
    return strip;
  }

  // Optional: precomputed beat timestamps (seconds) for the beat grid.
  setBeatTimes(times) {
    this._beatTimes = times;
  }

  // Star-power phrase ranges in seconds: [{ start, end }], start-sorted.
  setStarPhrases(phrases) {
    this._starPhrases = phrases || [];
  }

  // Solo phrase ranges in seconds: [{ start, end }], start-sorted.
  setSoloPhrases(phrases) {
    this._soloPhrases = (phrases || [])
      .map((phrase) => ({
        start: Number(phrase.start),
        end: Number(phrase.end),
      }))
      .filter((phrase) => Number.isFinite(phrase.start) && Number.isFinite(phrase.end) && phrase.end > phrase.start)
      .sort((a, b) => a.start - b.start);
  }

  // The phrase containing songTime, or null.
  _starActive(songTime) {
    for (const ph of this._starPhrases) {
      if (ph.start > songTime) break; // sorted by start
      if (songTime < ph.end) return ph;
    }
    return null;
  }

  // While a star-power phrase is active, wash the highway in a pulsing cyan
  // glow that brightens toward the strike line, with an extra glow band at
  // the strike zone so the active phrase is readable at a glance.
  _drawStarGlow(songTime) {
    if (!this._starActive(songTime)) return;
    const ctx = this.ctx;
    const p = this.proj;
    const far = p.project(1);

    ctx.save();
    this._traceBoardPath();
    ctx.clip();

    // Steady wash under reduced motion; gently pulsing otherwise.
    const pulse = this.reduceMotion ? 0.2 : 0.16 + 0.07 * Math.sin(songTime * 9);
    const grad = ctx.createLinearGradient(0, far.y, 0, p.height);
    grad.addColorStop(0, "rgba(90,200,255,0)");
    grad.addColorStop(0.55, `rgba(105,210,255,${pulse * 0.45})`);
    grad.addColorStop(1, `rgba(125,220,255,${pulse})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, far.y, p.width, p.height - far.y);

    // Cyan shimmer hugging the strike line, fading with the same pulse.
    const { y: strikeY, scale } = p.project(0);
    const bandH = Math.max(8, p.gemRadiusNear * scale * 1.6);
    const band = ctx.createLinearGradient(0, strikeY - bandH, 0, strikeY + bandH);
    band.addColorStop(0, "rgba(140,225,255,0)");
    band.addColorStop(0.5, `rgba(150,230,255,${pulse * 0.85})`);
    band.addColorStop(1, "rgba(140,225,255,0)");
    ctx.fillStyle = band;
    const half = p.halfWidthNear * scale;
    ctx.fillRect(p.centerX - half, strikeY - bandH, half * 2, bandH * 2);
    ctx.restore();
  }

  _drawSoloBands(songTime) {
    const phrases = this._soloPhrases;
    if (!phrases.length) return;
    const ctx = this.ctx;
    const p = this.proj;
    const visibleStart = songTime - p.lookAhead * 0.2;
    const visibleEnd = songTime + p.lookAhead;

    ctx.save();
    for (const phrase of phrases) {
      if (phrase.end < visibleStart) continue;
      if (phrase.start > visibleEnd) break;
      const start = Math.max(phrase.start, visibleStart);
      const end = Math.min(phrase.end, visibleEnd);
      const dStart = p.depthForTime(start, songTime);
      const dEnd = p.depthForTime(end, songTime);
      const yStart = p.project(dStart).y;
      const yEnd = p.project(dEnd).y;
      const topY = Math.max(p.horizonY, Math.min(yStart, yEnd));
      const bottomY = Math.min(p.height, Math.max(yStart, yEnd));
      if (bottomY <= topY) continue;

      const topScale = Math.max(0, p.scaleForY(topY));
      const bottomScale = Math.max(0, p.scaleForY(bottomY));
      const topHalf = p.halfWidthNear * topScale;
      const bottomHalf = p.halfWidthNear * bottomScale;

      const grad = ctx.createLinearGradient(0, topY, 0, bottomY);
      grad.addColorStop(0, "rgba(154,107,255,0.04)");
      grad.addColorStop(0.5, "rgba(154,107,255,0.13)");
      grad.addColorStop(1, "rgba(154,107,255,0.06)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(p.centerX - topHalf, topY);
      ctx.lineTo(p.centerX + topHalf, topY);
      ctx.lineTo(p.centerX + bottomHalf, bottomY);
      ctx.lineTo(p.centerX - bottomHalf, bottomY);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = "rgba(190,165,255,0.38)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.centerX - topHalf, topY + 0.5);
      ctx.lineTo(p.centerX + topHalf, topY + 0.5);
      ctx.moveTo(p.centerX - bottomHalf, bottomY - 0.5);
      ctx.lineTo(p.centerX + bottomHalf, bottomY - 0.5);
      ctx.stroke();
    }
    ctx.restore();
  }

  // One visibility pass per frame, shared by the sustain and head draw passes.
  // Fills the reusable scratch arrays and returns the visible count.
  _collectVisibleNotes(songTime) {
    const p = this.proj;
    const visNotes = this._visNotes;
    const visDepths = this._visDepths;
    const sustainLanes = this._sustainLanes;
    sustainLanes.clear();
    let count = 0;
    const maxTail = this.maxSustainSeconds || 0;
    const firstVisibleTime = songTime - p.lookAhead * 0.15 - maxTail;
    const lastVisibleTime = songTime + p.lookAhead * 1.05;
    const start = lowerBoundNoteTime(this.notes, firstVisibleTime);
    const end = lowerBoundNoteTime(this.notes, lastVisibleTime);
    for (let i = start; i < end; i++) {
      const note = this.notes[i];
      // Visual playback has no missed notes. Derive consumption from the same
      // clock as geometry, including freshly streamed notes and paused seeks.
      const hit = note.time <= songTime;
      const sustaining = note.sustain > 0 && note.endTime > songTime;
      // Consumed heads disappear while the remaining sustain stays visible.
      if (hit && !sustaining) continue;
      // A ringing, still-held sustain keeps its button lit for the hold. The
      // visible window always contains a ringing note (see firstVisibleTime),
      // so no sustain is missed here. Open notes press no frets, so they
      // light nothing.
      if (hit && sustaining && !note.open) {
        for (const l of note.frets) sustainLanes.add(l);
      }
      const d = p.depthForTime(note.time, songTime);
      const dTail = note.sustain > 0 ? p.depthForTime(note.endTime, songTime) : d;
      if (d > 1.05) continue; // head still beyond the horizon
      if (dTail < -0.15) continue; // whole note past the viewer
      visNotes[count] = note;
      visDepths[count] = d;
      count++;
    }
    visNotes.length = count;
    visDepths.length = count;
    return count;
  }

  _drawNotes(songTime, pass, count) {
    // Draw far-to-near so nearer (larger) notes overlap correctly.
    for (let i = count - 1; i >= 0; i--) {
      this._drawNote(this._visNotes[i], this._visDepths[i], songTime, pass);
    }
  }

  _drawNote(note, d, songTime, pass = "all") {
    const ctx = this.ctx;
    const p = this.proj;

    if (pass !== "heads" && note.sustain > 0 && note.endTime > note.time) {
      this._drawSustain(note, d, songTime);
    }
    if (pass === "sustains") return;

    // Once struck, only the sustain tail remains — the gem is already gone.
    if (note.time <= songTime) return;

    // Notes materialize out of the horizon haze: ramp opacity over the far
    // stretch so they fade in smoothly instead of popping in fully formed.
    // Full opacity by d=0.78, gone by d=0.98 (just inside the 1.05 cull).
    const fade = 1 - smoothstep(0.78, 0.98, d);
    if (fade <= 0) return;

    if (note.open) {
      // Open note: a full-width bar across the board, beveled like the beat
      // rungs so it reads as part of the same world rather than a flat stripe.
      const { scale, y } = p.project(d);
      if (scale <= 0) return;
      const half = p.halfWidthNear * scale;
      const h = Math.max(3, 14 * scale);
      const x = p.centerX - half;
      const w = half * 2;
      const top = y - h / 2;

      ctx.globalAlpha = fade;
      // Dark contour so the bar separates from the board.
      this._roundedBar(x, top + Math.max(1, h * 0.1), w, h, h / 2);
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fill();

      const grad = ctx.createLinearGradient(0, top, 0, top + h);
      if (note.star) {
        grad.addColorStop(0, "rgba(250,253,255,0.98)");
        grad.addColorStop(0.45, "rgba(205,228,255,0.92)");
        grad.addColorStop(1, "rgba(140,170,235,0.85)");
      } else {
        grad.addColorStop(0, rgba(shade(OPEN_NOTE_COLOR, 0.42), 0.96));
        grad.addColorStop(0.45, rgba(shade(OPEN_NOTE_COLOR, 0.05), 0.9));
        grad.addColorStop(1, rgba(shade(OPEN_NOTE_COLOR, -0.28), 0.85));
      }
      this._roundedBar(x, top, w, h, h / 2);
      ctx.fillStyle = grad;
      ctx.fill();

      // Bright leading edge, matching the rung bevel.
      ctx.fillStyle = note.star ? "rgba(255,255,255,0.85)" : "rgba(244,224,255,0.6)";
      ctx.fillRect(x, top, w, Math.max(1, h * 0.2));
      ctx.globalAlpha = 1;
      return;
    }

    for (const lane of note.frets) {
      const { x, y, scale } = p.place(lane, d);
      // A note far enough past the strike line projects to a non-positive
      // scale (behind the viewpoint). Skip it — a negative radius would throw.
      if (scale <= 0) continue;
      const r = p.gemRadiusNear * scale;
      ctx.globalAlpha = fade;
      this._drawGem(x, y, r, LANE_COLORS[lane], note.kind, note.star, songTime);
      ctx.globalAlpha = 1;
    }
  }

  _drawSustain(note, dHead, songTime = 0) {
    const ctx = this.ctx;
    const p = this.proj;
    // Clip both endpoints to the playable runway. Timing, never cached hit
    // flags, determines where a streamed/seeked sustain is consumed.
    if (note.endTime <= songTime || dHead >= 1) return;
    const active = note.time <= songTime;
    const head = p.project(Math.max(0, dHead));
    const tail = p.project(Math.min(1, p.depthForTime(note.endTime, songTime)));
    if (tail.y >= head.y) return;
    const fade = 1 - smoothstep(0.78, 0.98, Math.max(0, dHead));
    const ribbon = (xHead, xTail, wHead, wTail) => {
      ctx.beginPath();
      ctx.moveTo(xHead - wHead, head.y);
      ctx.lineTo(xHead + wHead, head.y);
      ctx.lineTo(xTail + wTail, tail.y);
      ctx.lineTo(xTail - wTail, tail.y);
      ctx.closePath();
    };
    ctx.save();
    // Also clips the active contact highlight, so nothing leaks below frets.
    ctx.beginPath();
    ctx.rect(0, p.horizonY, p.width, p.strikeY - p.horizonY);
    ctx.clip();
    ctx.globalAlpha = fade;
    if (note.open) {
      const halfHead = p.halfWidthNear * head.scale;
      const halfTail = p.halfWidthNear * tail.scale;
      ribbon(p.centerX, p.centerX, halfHead, halfTail);
      const grad = ctx.createLinearGradient(0, tail.y, 0, head.y);
      grad.addColorStop(0, rgba(OPEN_NOTE_COLOR, 0.08));
      grad.addColorStop(1, rgba(OPEN_NOTE_COLOR, active ? 0.46 : 0.26));
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = rgba(OPEN_NOTE_COLOR, active ? 0.85 : 0.5);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (active) {
        ctx.fillStyle = shade(OPEN_NOTE_COLOR, 0.6);
        ctx.fillRect(p.centerX - halfHead, head.y - 3, halfHead * 2, 3);
        if (!this.reduceMotion) this._drawSustainFlow(note, songTime, null);
      }
    } else {
      for (const lane of note.frets) {
        const xHead = p.centerX + (p.laneCenterNear(lane) - p.centerX) * head.scale;
        const xTail = p.centerX + (p.laneCenterNear(lane) - p.centerX) * tail.scale;
        const wHead = p.gemRadiusNear * 0.25 * head.scale;
        const wTail = p.gemRadiusNear * 0.25 * tail.scale;
        const color = LANE_COLORS[lane];
        ribbon(xHead, xTail, wHead * 1.5, wTail * 1.5);
        ctx.fillStyle = rgba(color, active ? 0.18 : 0.08);
        ctx.fill();
        ribbon(xHead, xTail, wHead, wTail);
        ctx.fillStyle = rgba(color, active ? 0.95 : 0.64);
        ctx.fill();
        ribbon(xHead, xTail, wHead * 0.24, wTail * 0.24);
        ctx.fillStyle = rgba('#ffffff', active ? (this.reduceMotion ? 0.65 : 0.32) : 0.28);
        ctx.fill();
        if (active && !this.reduceMotion) this._drawSustainFlow(note, songTime, lane);
      }
    }
    ctx.restore();
  }

  // Continuous light strands ripple inside held sustains. Song time drives
  // their phase, so pause and seek need no independent animation state.
  _drawSustainFlow(note, songTime, lane) {
    const ctx = this.ctx;
    const p = this.proj;
    const depthEnd = Math.min(1, p.depthForTime(note.endTime, songTime));
    const open = lane === null;
    const nearX = open ? 0 : p.laneCenterNear(lane) - p.centerX;
    const width = open ? p.halfWidthNear : p.gemRadiusNear * 0.25;
    const phase = (songTime - note.time) * 7;
    const segments = 32;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let strand = 0; strand < 2; strand++) {
      ctx.beginPath();
      for (let i = 0; i <= segments; i++) {
        const depth = depthEnd * i / segments;
        const { scale, y } = p.project(depth);
        // A wavelength measured along the board, independent of tail length.
        const wave = Math.sin(depth * 19 + phase + strand * Math.PI);
        const envelope = Math.sin(Math.PI * i / segments);
        const offset = open
          ? width * (strand ? 0.93 : -0.93) + wave * width * 0.018 * envelope
          : wave * width * 0.48 * envelope;
        const x = p.centerX + (nearX + offset) * scale;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = strand ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.18)';
      ctx.lineWidth = open ? 1.3 : Math.max(1, p.gemRadiusNear * (strand ? 0.035 : 0.12));
      ctx.stroke();
    }
    ctx.restore();
  }

  // Regular gems stay cached. Rotating stars reuse one canvas per style,
  // repainted once per song-time frame, regardless of how many notes use it.
  _drawGem(x, y, r, color, kind = "strum", star = false, songTime = 0) {
    if (!(r > 0)) return;
    const key = `${color}|${kind}|${star}`;
    let sprite = this._gemSprites.get(key);
    const radius = star ? 64 : 96;
    const half = radius * 2;
    // Sixteen seconds per revolution. Fivefold symmetry repeats every 72°.
    const period = Math.PI * 2 / 5;
    const angle = this.reduceMotion ? 0 : ((songTime * Math.PI / 8) % period + period) % period;
    const repaint = !sprite || (star && sprite.starAngle !== angle);
    if (!sprite) {
      sprite = document.createElement("canvas");
      sprite.width = sprite.height = half * 2;
      this._gemSprites.set(key, sprite);
    }
    if (repaint) {
      const previous = this.ctx;
      this.ctx = sprite.getContext("2d");
      try {
        this.ctx.clearRect(0, 0, sprite.width, sprite.height);
        if (star) this._drawStarGem(half, half, radius, color, kind, angle);
        else this._paintGem(half, half, radius, color, kind);
        sprite.starAngle = angle;
      } finally {
        this.ctx = previous;
      }
    }
    this.ctx.drawImage(sprite, x - r * 2, y - r * 2, r * 4, r * 4);
  }

  // Classic raised fret gems: a small cap above a sloping colored body,
  // seated on a silver base. The vertical separation is what gives the note
  // its height instead of making the cap look recessed into an oval dish.
  _paintGem(x, y, r, color, kind) {
    const ctx = this.ctx;
    const hopo = kind === 'hopo';
    const tap = kind === 'tap';
    const ellipse = (cy, rx, ry) => {
      ctx.beginPath();
      ctx.ellipse(x, cy, rx, ry, 0, 0, Math.PI * 2);
    };
    if (tap) {
      // The board and sustain must remain visible through the whole tap gem,
      // including its base. Opaque backing layers would defeat the glass body.
      ellipse(y + r * 0.06, r, r * 0.28);
      ctx.fillStyle = rgba(color, 0.06);
      ctx.fill();
      ctx.lineWidth = r * 0.045;
      ctx.strokeStyle = rgba(color, 0.78);
      ctx.stroke();
    } else {
      ellipse(y + r * 0.22, r * 1.03, r * 0.28);
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fill();
      const silver = ctx.createLinearGradient(x - r, 0, x + r, 0);
      silver.addColorStop(0, '#65717c');
      silver.addColorStop(0.23, '#e6ecf0');
      silver.addColorStop(0.5, '#bfc9d1');
      silver.addColorStop(0.78, '#f5f8fa');
      silver.addColorStop(1, '#687884');
      ctx.save();
      if (hopo) {
        // Keep the base bloom weaker and much tighter than the cap halo so
        // it hugs the silver rim without washing into neighboring notes.
        ctx.shadowColor = 'rgba(255,255,255,0.42)';
        ctx.shadowBlur = r * 0.18;
      }
      ellipse(y + r * 0.12, r, r * 0.28);
      ctx.fillStyle = silver;
      ctx.fill();
      ctx.restore();
      ellipse(y, r, r * 0.26);
      ctx.fillStyle = '#e2e7eb';
      ctx.fill();
      ellipse(y - r * 0.025, r * 0.94, r * 0.24);
      ctx.fillStyle = '#11171c';
      ctx.fill();
    }

    // The cone rises from the wide base toward the smaller elevated cap.
    ctx.beginPath();
    ctx.moveTo(x - r * 0.92, y - r * 0.02);
    ctx.bezierCurveTo(x - r * 0.87, y - r * 0.16, x - r * 0.55, y - r * 0.29, x - r * 0.4, y - r * 0.39);
    ctx.bezierCurveTo(x - r * 0.22, y - r * 0.47, x + r * 0.22, y - r * 0.47, x + r * 0.4, y - r * 0.39);
    ctx.bezierCurveTo(x + r * 0.55, y - r * 0.29, x + r * 0.87, y - r * 0.16, x + r * 0.92, y - r * 0.02);
    ctx.bezierCurveTo(x + r * 0.84, y + r * 0.25, x - r * 0.84, y + r * 0.25, x - r * 0.92, y - r * 0.02);
    ctx.closePath();
    const body = ctx.createLinearGradient(x - r, 0, x + r, 0);
    body.addColorStop(0, tap ? rgba(color, 0.12) : shade(color, -0.56));
    body.addColorStop(0.28, tap ? rgba(shade(color, 0.5), 0.24) : shade(color, 0.18));
    body.addColorStop(0.45, tap ? rgba(shade(color, 0.7), 0.36) : shade(color, 0.4));
    body.addColorStop(0.65, tap ? rgba(color, 0.2) : color);
    body.addColorStop(1, tap ? rgba(color, 0.1) : shade(color, -0.55));
    ctx.fillStyle = body;
    ctx.fill();
    ctx.lineWidth = r * 0.025;
    ctx.strokeStyle = rgba(color, 0.8);
    ctx.stroke();

    this._paintGemCap(x, y, r, kind);
  }

  _paintGemCap(x, y, r, kind) {
    const ctx = this.ctx;
    const hopo = kind === 'hopo';
    const tap = kind === 'tap';
    const ellipse = (cy, rx, ry) => {
      ctx.beginPath();
      ctx.ellipse(x, cy, rx, ry, 0, 0, Math.PI * 2);
    };
    // Both solid note types have white caps; HOPOs add the bright halo.
    // Taps use a hollow, translucent cap with a bright outline.
    if (!tap) {
      ellipse(y - r * 0.365, r * 0.43, r * 0.155);
      ctx.fillStyle = hopo ? '#e5f4ff' : '#18202a';
      ctx.fill();
    }
    if (hopo) this._paintHopoGlow(x, y - r * 0.4, r);
    const cap = ctx.createLinearGradient(0, y - r * 0.53, 0, y - r * 0.27);
    cap.addColorStop(0, tap ? 'rgba(235,250,255,0.25)' : '#ffffff');
    cap.addColorStop(0.5, tap ? 'rgba(235,250,255,0.08)' : hopo ? '#ffffff' : '#f1f4f6');
    cap.addColorStop(1, tap ? 'rgba(235,250,255,0.12)' : hopo ? '#dceeff' : '#bbc6ce');
    ctx.save();
    if (hopo) {
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = r * 0.55;
    }
    ellipse(y - r * 0.4, r * (hopo ? 0.46 : 0.38), r * (hopo ? 0.15 : 0.12));
    ctx.fillStyle = cap;
    ctx.fill();
    if (tap) {
      ctx.strokeStyle = 'rgba(220,245,255,0.85)';
      ctx.lineWidth = r * 0.04;
      ctx.stroke();
    }
    ctx.restore();
  }

  // A broad white bloom remains legible as the cached sprite shrinks into the
  // distance. Painted once per HOPO sprite, including star-power variants.
  _paintHopoGlow(x, y, r) {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(r * 0.95, r * 0.52);
    const bloom = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    bloom.addColorStop(0, 'rgba(255,255,255,0.95)');
    bloom.addColorStop(0.3, 'rgba(255,255,255,0.7)');
    bloom.addColorStop(0.62, 'rgba(230,247,255,0.25)');
    bloom.addColorStop(1, 'rgba(230,247,255,0)');
    ctx.fillStyle = bloom;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }

  // Rounded-rect path for the open-note bar; falls back to a plain rect where
  // roundRect is unavailable.
  _roundedBar(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(r, h / 2));
    else ctx.rect(x, y, w, h);
  }

  _traceStarPath(x, y, w, h, points = STAR_POINTS) {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const [px, py] = points[i];
      const sx = x + px * w;
      const sy = y + py * h;
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.closePath();
  }

  // A low, hard-edged star: vertical walls under planar ramps leading into
  // the black circular cap rim. Rotate in the board plane before projection.
  _drawStarGem(x, y, r, color, kind = "strum", rotation = 0) {
    const ctx = this.ctx;
    const tap = kind === "tap";
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const points = STAR_POINTS.map(([px, py]) => [px * cos - py * sin, px * sin + py * cos]);
    const trace = (offset, width, depth) => this._traceStarPath(x, y + r * offset, r * width, r * depth, points);
    const polygon = (vertices) => {
      ctx.beginPath();
      vertices.forEach(([px, py], i) => {
        if (i === 0) ctx.moveTo(x + px * r, y + py * r);
        else ctx.lineTo(x + px * r, y + py * r);
      });
      ctx.closePath();
    };
    const faces = points.map(([ax, ay], i) => {
      const [bx, by] = points[(i + 1) % points.length];
      return { ax, ay, bx, by, index: i, depth: ay + by };
    }).sort((a, b) => a.depth - b.depth);
    ctx.save();
    ctx.lineJoin = "miter";
    ctx.miterLimit = 3;

    if (!tap) {
      trace(0.15, 1.09, 0.47);
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fill();
      trace(0.085, 1.06, 0.46);
      ctx.fillStyle = "#899ba7";
      ctx.fill();
      for (const { ax, ay, bx, by } of faces) {
        polygon([[ax * 1.06, ay * 0.46], [bx * 1.06, by * 0.46],
          [bx * 1.06, by * 0.46 + 0.085], [ax * 1.06, ay * 0.46 + 0.085]]);
        ctx.fillStyle = ax + bx < 0 ? "#c5d7df" : "#829cae";
        ctx.fill();
      }
      trace(0, 1.06, 0.46);
      ctx.fillStyle = "#dce7ec";
      ctx.fill();
      trace(-0.012, 1.015, 0.443);
      ctx.fillStyle = "#11171c";
      ctx.fill();
    } else {
      trace(0.035, 1.06, 0.46);
      ctx.fillStyle = rgba(color, 0.05);
      ctx.fill();
      ctx.lineWidth = r * 0.025;
      ctx.strokeStyle = rgba(color, 0.78);
      ctx.stroke();
    }

    // Each arm is one continuous ramp. Its two inner corners rise toward
    // the rim together; splitting it down the middle would create a ridge.
    const rimRadius = 0.387;
    const rimDepth = 0.1953;
    const rimY = -0.1259;
    const tipY = -0.075;
    const valleyY = tipY + (rimY - tipY)
      * (1 - 0.52 * Math.cos(Math.PI / 5)) / (1 - rimRadius);
    const topY = (index) => index % 2 === 0 ? tipY : valleyY;
    for (const { ax, ay, bx, by, index } of faces) {
      polygon([[ax, ay * 0.44 + topY(index)], [bx, by * 0.44 + topY(index + 1)],
        [bx, by * 0.44 - 0.012], [ax, ay * 0.44 - 0.012]]);
      ctx.fillStyle = tap ? rgba(color, 0.12) : shade(color, ax + bx < 0 ? -0.32 : -0.55);
      ctx.fill();
    }

    const arms = [0, 2, 4, 6, 8].map((index) => ({
      tip: points[index],
      left: points[(index + points.length - 1) % points.length],
      right: points[(index + 1) % points.length],
    })).sort((a, b) => a.tip[1] - b.tip[1]);
    for (const { tip, left, right } of arms) {
      const angle = Math.atan2(tip[1], tip[0]);
      const leftAngle = angle - Math.PI / 5;
      const rightAngle = angle + Math.PI / 5;
      ctx.beginPath();
      ctx.moveTo(x + left[0] * r, y + (left[1] * 0.44 + valleyY) * r);
      ctx.lineTo(x + tip[0] * r, y + (tip[1] * 0.44 + tipY) * r);
      ctx.lineTo(x + right[0] * r, y + (right[1] * 0.44 + valleyY) * r);
      ctx.lineTo(x + Math.cos(rightAngle) * rimRadius * r, y + (Math.sin(rightAngle) * rimDepth + rimY) * r);
      // Terminate the entire ramp flush against the circular black rim.
      ctx.ellipse(x, y + rimY * r, rimRadius * r, rimDepth * r, 0, rightAngle, leftAngle, true);
      ctx.closePath();
      const light = -tip[0] * 0.2 - tip[1] * 0.08;
      ctx.fillStyle = tap ? rgba(shade(color, 0.15), 0.2) : shade(color, light);
      ctx.fill();
      if (!tap) {
        ctx.lineWidth = r * 0.009;
        ctx.strokeStyle = ctx.fillStyle;
        ctx.stroke();
      }
    }

    // Seat the cap low while keeping its round top visible above the ramps.
    ctx.translate(x, y - r * 0.17);
    ctx.scale(1, 1.4);
    this._paintGemCap(0, r * 0.36, r * 0.9, kind);
    ctx.restore();
  }

  // Throw a short-lived spark burst up from a lane's strike button on a hit.
  _spawnHitBurst(lane, songTime) {
    const fx = this.effectProfile;
    if (this._particles.length > fx.particleCap) return; // safety cap on heavy charts
    const p = this.proj;
    const { scale, y } = p.project(0);
    const x = p.centerX + (p.laneCenterNear(lane) - p.centerX) * scale;
    const color = LANE_COLORS[lane] || "#ffffff";
    const count = fx.particleCount;
    for (let i = 0; i < count; i++) {
      // Mostly upward (toward the horizon), with spread.
      const ang = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
      const spd = (fx.particleSpeed + Math.random() * fx.particleSpeedJitter) * scale;
      this._particles.push({
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        born: songTime,
        life: fx.particleLife + Math.random() * fx.particleLifeJitter,
        r: (2 + Math.random() * 2.5) * scale,
        color,
      });
    }
  }

  // Advance + draw live particles against the audio clock. Particles outside
  // their lifetime (including after a seek backward) are dropped.
  _drawParticles(songTime) {
    if (!this._particles.length) return;
    const ctx = this.ctx;
    const g = 700; // gravity pulling sparks back down
    const alive = [];
    for (const pt of this._particles) {
      const e = songTime - pt.born;
      if (e < 0 || e > pt.life) continue;
      const x = pt.x + pt.vx * e;
      const y = pt.y + pt.vy * e + 0.5 * g * e * e;
      const a = 1 - e / pt.life;
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(x, y, pt.r * (0.5 + a * 0.5), 0, Math.PI * 2);
      ctx.fillStyle = pt.color;
      ctx.fill();
      alive.push(pt);
    }
    ctx.globalAlpha = 1;
    this._particles = alive;
  }

  // Spawn a flame jet rising from a lane's strike button on a hit. Like the
  // Guitar Hero fret flames: an obvious tongue of fire shooting up the highway
  // that makes a clean hit unmistakable. Decorative, so callers skip it under
  // reduced motion. Stacking flames on rapid hits reads as a sustained blaze.
  _spawnFlame(lane, songTime) {
    const fx = this.effectProfile;
    // Safety cap on dense charts: evict the OLDEST flame, never the new one —
    // the freshest hit is exactly the fire the player needs to see.
    if (this._flames.length >= fx.flameCap) this._flames.shift();
    this._flames.push({
      lane,
      born: songTime,
      life: fx.flameLife,
      seed: Math.random() * 1000,
      sprite: (Math.random() * FLAME_SPRITE_VARIANTS) | 0,
    });
  }

  // Prerendered flame textures, built once and scaled at draw time. Each
  // sprite has a broad root and asymmetric tongues, with amber edges around
  // a bright core. A soft bottom mask seats the root on the fret without a
  // rounded droplet hanging below it. Variants share the same root position.
  _flameSprites() {
    if (this._flameSpriteCache) return this._flameSpriteCache;
    const W = 240;
    const H = 400;
    // Deterministic per-variant RNG (LCG) so the cached sprites are stable.
    const rngFor = (seed) => () =>
      (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

    // A twisting tongue with a flat root, a full shoulder and a fine tip.
    const lick = (c, x, baseY, h, w, lean, stops) => {
      const tipX = x + lean;
      const tipY = baseY - h;
      const grad = c.createLinearGradient(0, baseY, 0, tipY);
      for (const [o, col] of stops) grad.addColorStop(o, col);
      c.fillStyle = grad;
      c.beginPath();
      c.moveTo(x - w * 0.5, baseY);
      c.bezierCurveTo(
        x - w * 0.7, baseY - h * 0.34,
        x + lean - w * 0.32, baseY - h * 0.52,
        tipX, tipY
      );
      c.bezierCurveTo(
        x + lean + w * 0.56, baseY - h * 0.62,
        x + w * 0.26, baseY - h * 0.32,
        x + w * 0.5, baseY
      );
      c.closePath();
      c.fill();
    };

    this._flameSpriteCache = [0, 1, 2, 3].map((variant) => {
      const rng = rngFor(0x9e3779b9 + variant * 7919);
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const c = canvas.getContext("2d");
      const cx = W / 2;
      const baseY = H * 0.94;

      // Warm light connects the individual tongues at their root.
      const mass = c.createRadialGradient(cx, baseY - H * 0.05, 0, cx, baseY - H * 0.05, W * 0.42);
      mass.addColorStop(0, "rgba(255,140,30,0.55)");
      mass.addColorStop(0.6, "rgba(255,90,12,0.28)");
      mass.addColorStop(1, "rgba(220,50,0,0)");
      c.save();
      c.translate(cx, baseY - H * 0.05);
      c.scale(1, 0.55);
      c.translate(-cx, -(baseY - H * 0.05));
      c.fillStyle = mass;
      c.beginPath();
      c.arc(cx, baseY - H * 0.05, W * 0.42, 0, Math.PI * 2);
      c.fill();
      c.restore();

      // A row of licks across the base: center tallest, edges shorter and
      // leaning outward, each jittered so the silhouette is ragged.
      const offsets = [-0.28, -0.14, 0.015, 0.15, 0.28];
      const licks = offsets.map((off) => {
        const x = cx + (off + (rng() - 0.5) * 0.05) * W;
        const center = 1 - Math.min(1, Math.abs(off) * 2.6); // 1 center → ~0.3 edge
        const h = H * (0.34 + 0.49 * center) * (0.88 + rng() * 0.18);
        const w = W * (0.24 + rng() * 0.08);
        const lean = off * W * 0.38 + (rng() - 0.5) * W * 0.2;
        return { x, h, w, lean, center };
      });

      const outerStops = [[0, "rgba(255,155,24,0.9)"], [0.45, "rgba(255,110,12,0.85)"], [0.8, "rgba(255,70,8,0.6)"], [1, "rgba(255,60,0,0)"]];
      const midStops = [[0, "rgba(255,240,150,0.98)"], [0.4, "rgba(255,195,55,0.9)"], [0.8, "rgba(255,145,20,0.65)"], [1, "rgba(255,100,10,0)"]];
      const coreStops = [[0, "rgba(255,255,240,1)"], [0.45, "rgba(255,245,190,0.95)"], [1, "rgba(255,205,80,0)"]];

      for (const l of licks) lick(c, l.x, baseY, l.h, l.w, l.lean, outerStops);
      for (const l of licks) lick(c, l.x, baseY, l.h * 0.86, l.w * 0.7, l.lean * 0.85, midStops);
      for (const l of licks) {
        if (l.center < 0.55) continue; // only the tall middle licks get a hot core
        lick(c, l.x, baseY, l.h * 0.64, l.w * 0.48, l.lean * 0.65, coreStops);
      }

      // White-hot seat where the fire erupts.
      const seat = c.createRadialGradient(cx, baseY, 0, cx, baseY, W * 0.2);
      seat.addColorStop(0, "rgba(255,255,248,0.95)");
      seat.addColorStop(0.5, "rgba(255,225,160,0.55)");
      seat.addColorStop(1, "rgba(255,190,90,0)");
      c.save();
      c.translate(cx, baseY);
      c.scale(1, 0.5);
      c.translate(-cx, -baseY);
      c.fillStyle = seat;
      c.beginPath();
      c.arc(cx, baseY, W * 0.2, 0, Math.PI * 2);
      c.fill();
      c.restore();

      const rootMask = c.createLinearGradient(0, 0, 0, H);
      rootMask.addColorStop(0, "rgba(0,0,0,1)");
      rootMask.addColorStop(0.88, "rgba(0,0,0,1)");
      rootMask.addColorStop(0.95, "rgba(0,0,0,0)");
      rootMask.addColorStop(1, "rgba(0,0,0,0)");
      c.globalCompositeOperation = "destination-in";
      c.fillStyle = rootMask;
      c.fillRect(0, 0, W, H);

      return canvas;
    });
    return this._flameSpriteCache;
  }

  // Draw + cull the live flame jets against the audio clock. Each flame is a
  // prerendered texture over a lane-tinted base glow, animated by a tight
  // fast-attack envelope: snapped to full force almost instantly, stretching
  // as it fades, with a slight sway. A seek backward leaves born > songTime,
  // which is culled like any expired flame.
  _drawFlames(songTime) {
    if (!this._flames.length) return;
    const ctx = this.ctx;
    const p = this.proj;
    const fx = this.effectProfile;
    const sprites = this._flameSprites();
    const { scale, y: strikeY } = p.project(0);
    const r = p.gemRadiusNear * scale;
    // The sprite root sits on the button's upper face; its transparent bottom
    // padding must not pull it upward as the flame stretches.
    const baseY = strikeY - r * 0.12;
    const alive = [];
    ctx.save();
    ctx.globalCompositeOperation = "lighter"; // additive: fire builds on itself
    for (const f of this._flames) {
      const e = songTime - f.born;
      if (e < 0 || e > f.life) continue;
      alive.push(f);
      const prog = e / f.life;
      // Envelope: snap up fast, ease out — the shape of a flame puff. The
      // quick attack is what keeps the hit feedback feeling tight.
      const attack = smoothstep(0, 0.07, prog);
      const env = (0.65 + 0.35 * attack) * (1 - smoothstep(0.22, 1, prog));
      const x = p.centerX + (p.laneCenterNear(f.lane) - p.centerX) * scale;
      const laneColor = LANE_COLORS[f.lane] || "#ffffff";

      // Lane-tinted glow seated on the button, so the fire keeps a lane identity.
      const bgRadius = r * fx.flameGlow;
      const bg = ctx.createRadialGradient(x, baseY, 0, x, baseY, bgRadius);
      bg.addColorStop(0, `rgba(255,220,140,${0.42 * env})`);
      bg.addColorStop(0.45, rgba(laneColor, 0.2 * env));
      bg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(x, baseY, bgRadius, 0, Math.PI * 2);
      ctx.fill();

      const sprite = sprites[f.sprite];
      // Stretch upward through the decay instead of shrinking into a puff.
      // Width stays tied to the fret so taller flames don't spill across lanes.
      const flick = 0.5 + 0.5 * Math.sin(songTime * 33 + f.seed * 2.1);
      const h = r * fx.flameHeight * (0.64 + 0.28 * attack + 0.16 * prog) * (0.97 + 0.06 * flick);
      const w = r * (2.05 - 0.32 * prog);
      const sway = Math.sin(songTime * 23 + f.seed) * r * 0.09 * env;
      const blend = 0.18 + 0.3 * flick;
      ctx.globalAlpha = env * (1 - blend);
      ctx.drawImage(sprite, x + sway - w / 2, baseY - h * 0.94, w, h);
      const alt = sprites[(f.sprite + 2) % sprites.length];
      const h2 = h * 1.06;
      const w2 = w * 0.94;
      ctx.globalAlpha = env * blend;
      ctx.drawImage(alt, x - sway * 0.6 - w2 / 2, baseY - h2 * 0.94, w2, h2);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    this._flames = alive;
  }

  // The strike zone: fret buttons at the near plane where notes are hit.
  _drawStrikeZone(songTime) {
    const ctx = this.ctx;
    const p = this.proj;
    const { scale, y } = p.project(0);

    const FLASH = 0.12;
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const x = p.centerX + (p.laneCenterNear(lane) - p.centerX) * scale;
      const sustaining = this._sustainLanes.has(lane);
      const flashAt = this.hitFlash.get(lane);
      const flash =
        flashAt !== undefined && songTime - flashAt >= 0 && songTime - flashAt < FLASH
          ? 1 - (songTime - flashAt) / FLASH
          : 0;
      const lit = sustaining || flash > 0;
      // A sustain breathes gently instead of sitting at a flat brightness.
      const sustainPulse = sustaining
        ? this.reduceMotion
          ? 0.16
          : 0.16 + 0.1 * Math.sin(songTime * 5 + lane * 1.3)
        : 0;
      this._drawFretButton(
        lane,
        x,
        y,
        lit,
        Math.max(flash, sustainPulse)
      );
    }
  }

  // Strike zone painted into the static layer: the fret buttons sit in a
  // recessed plate across the board, with a soft light pool behind them and a
  // faint baseline fully below the button row. No glowing bar through the
  // buttons — the plate grounds them instead. The buttons are drawn on top
  // each frame.
  _paintStrikePlate() {
    const ctx = this.ctx;
    const p = this.proj;
    const { scale, y } = p.project(0);
    const r = p.gemRadiusNear * scale;
    const half = p.halfWidthNear * scale;
    const x0 = p.centerX - half;
    const w = half * 2;
    const plateH = r * 1.3;
    const top = y - plateH / 2;
    ctx.save();

    // A soft pool of light behind the buttons, grounding the plate like a
    // stage light. Kept faint so it never competes with the notes.
    const pool = ctx.createRadialGradient(
      p.centerX, y, r * 0.5,
      p.centerX, y, half * 1.25
    );
    pool.addColorStop(0, "rgba(140,175,255,0.13)");
    pool.addColorStop(0.55, "rgba(130,165,240,0.05)");
    pool.addColorStop(1, "rgba(130,165,240,0)");
    ctx.save();
    ctx.translate(p.centerX, y);
    ctx.scale(1, (r * 2.6) / (half * 1.25));
    ctx.translate(-p.centerX, -y);
    ctx.fillStyle = pool;
    ctx.beginPath();
    ctx.arc(p.centerX, y, half * 1.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Plate body: a recessed strip darker than the board, soft-edged top and
    // bottom...
    const body = ctx.createLinearGradient(0, top - r * 0.12, 0, top + plateH + r * 0.12);
    body.addColorStop(0, "rgba(4,6,11,0)");
    body.addColorStop(0.18, "rgba(4,6,11,0.74)");
    body.addColorStop(0.82, "rgba(4,6,11,0.74)");
    body.addColorStop(1, "rgba(4,6,11,0)");
    ctx.fillStyle = body;
    ctx.fillRect(x0, top - r * 0.12, w, plateH + r * 0.24);

    // ...and fading out toward the board edges (alpha mask).
    ctx.globalCompositeOperation = "destination-in";
    const mask = ctx.createLinearGradient(x0, 0, x0 + w, 0);
    mask.addColorStop(0, "rgba(0,0,0,0)");
    mask.addColorStop(0.14, "rgba(0,0,0,1)");
    mask.addColorStop(0.86, "rgba(0,0,0,1)");
    mask.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = mask;
    ctx.fillRect(x0, 0, w, p.height);
    ctx.globalCompositeOperation = "source-over";

    // Baseline: a faint light line fully below the button row, marking the
    // near edge of the plate without touching the buttons.
    const base = ctx.createLinearGradient(x0, 0, x0 + w, 0);
    base.addColorStop(0, "rgba(190,210,255,0)");
    base.addColorStop(0.5, "rgba(190,210,255,0.2)");
    base.addColorStop(1, "rgba(190,210,255,0)");
    ctx.fillStyle = base;
    ctx.fillRect(x0, top + plateH, w, 1);
    ctx.restore();
  }

  // Blit a prerendered fret-button sprite. The hit flash cross-fades the lit
  // (glow = 0) sprite toward the glow = 1 variant so the flash still ramps
  // smoothly without re-running the gradient/shadow painter every frame.
  _drawFretButton(lane, x, y, lit, glow = 0) {
    const ctx = this.ctx;
    const base = this._buttonSprite(lane, lit ? "lit" : "unlit");
    const size = base.half * 2;
    ctx.drawImage(base.canvas, x - base.half, y - base.half, size, size);
    if (lit && glow > 0) {
      const hot = this._buttonSprite(lane, "glow");
      ctx.globalAlpha = Math.min(1, glow);
      ctx.drawImage(hot.canvas, x - hot.half, y - hot.half, hot.half * 2, hot.half * 2);
      ctx.globalAlpha = 1;
    }
  }

  _buttonSprite(lane, variant) {
    if (!this._buttonSprites) this._buttonSprites = new Map();
    const key = `${lane}|${variant}`;
    let sprite = this._buttonSprites.get(key);
    if (sprite) return sprite;
    const p = this.proj;
    const r = p.gemRadiusNear * p.project(0).scale;
    // Include the soft halo without allocating a large mostly empty texture.
    const half = Math.ceil(r * 2.75);
    const dpr = this._dpr || 1;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = Math.max(1, Math.round(half * 2 * dpr));
    const spriteCtx = canvas.getContext("2d");
    spriteCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const prev = this.ctx;
    this.ctx = spriteCtx;
    try {
      this._paintFretButton(
        half,
        half,
        r,
        LANE_COLORS[lane],
        variant !== "unlit",
        variant === "glow" ? 1 : 0
      );
    } finally {
      this.ctx = prev;
    }
    sprite = { canvas, half };
    this._buttonSprites.set(key, sprite);
    return sprite;
  }

  // Classic circular fret targets: a colored outer ring, metallic shoulder,
  // and a dark central button that lights up while the sustain is held.
  _paintFretButton(x, y, r, color, lit, glow = 0) {
    const ctx = this.ctx;
    const ellipse = (cy, rx, ry) => {
      ctx.beginPath();
      ctx.ellipse(x, cy, rx, ry, 0, 0, Math.PI * 2);
    };
    ctx.save();
    ellipse(y + r * 0.14, r * 1.07, r * 0.41);
    ctx.fillStyle = '#030509';
    ctx.fill();
    if (lit) {
      ctx.shadowColor = color;
      ctx.shadowBlur = r * (0.75 + glow * 0.65);
    }
    ellipse(y, r * 1.04, r * 0.4);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.shadowBlur = 0;
    const metal = ctx.createLinearGradient(0, y - r * 0.4, 0, y + r * 0.4);
    metal.addColorStop(0, '#c5d2dc');
    metal.addColorStop(0.3, '#677787');
    metal.addColorStop(0.65, '#d5e1e9');
    metal.addColorStop(1, '#46515e');
    ellipse(y - r * 0.02, r * 0.86, r * 0.32);
    ctx.fillStyle = metal;
    ctx.fill();
    ellipse(y - r * 0.035, r * 0.68, r * 0.255);
    ctx.fillStyle = '#060a10';
    ctx.fill();
    const button = ctx.createLinearGradient(0, y - r * 0.3, 0, y + r * 0.2);
    button.addColorStop(0, lit ? shade(color, 0.55) : '#3d4650');
    button.addColorStop(0.5, lit ? color : '#19212a');
    button.addColorStop(1, lit ? shade(color, -0.2) : '#0b1018');
    ellipse(y - r * 0.075, r * 0.59, r * 0.2);
    ctx.fillStyle = button;
    ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.028);
    ctx.strokeStyle = lit ? shade(color, 0.7) : '#62707b';
    ctx.stroke();
    ctx.restore();
  }
}

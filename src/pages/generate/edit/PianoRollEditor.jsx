import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { I } from "../../../icons.jsx";
import { FRET_COLORS, OPEN_NOTE_COLOR } from "../../../data/notePalette.js";
import { snapTicks } from "./chartEditor.js";
import { normalizeRegions, snapSpanToBars } from "./editRegions.js";

// Canvas-based piano roll. The editor doc (ticks) is the source of truth; this
// component renders a virtualized horizontal timeline and translates pointer
// gestures into committed reducer actions (one per gesture). Live drag state is
// kept in a ref and drawn directly, so pointermove never spams the reducer.
//
// The two-row ruler is where redo regions are picked: click a section name in
// the top row, or drag across bar numbers in the bottom row (snapped outward
// to whole bars). Shift adds another region.

const SECTION_ROW_H = 24;
const BAR_ROW_H = 22;
const RULER_H = SECTION_ROW_H + BAR_ROW_H;
const SP_H = 22;
const SOLO_H = 22;
const SCROLLBAR_H = 15;
const EDGE_GRAB = 5;
const BOX_SELECT_MIN_DRAG = 3;
const REGION_MIN_DRAG = 4;

const LANE_COLORS = FRET_COLORS;
const OPEN_COLOR = OPEN_NOTE_COLOR;
const SP_COLOR = "#36c5f0";
const SOLO_COLOR = "#9a6bff";
const FORCE_OUTLINE = "rgba(255,255,255,0.96)";

// Lanes grow with the available height so the roll fills the edit screen.
// Gems scale with the lane so tall screens get chunkier, easier targets.
function layoutFor(height) {
  const laneH = Math.max(30, Math.floor((height - RULER_H - SP_H - SOLO_H - SCROLLBAR_H) / 5));
  const noteAreaH = laneH * 5;
  const spY = RULER_H + noteAreaH;
  const soloY = spY + SP_H;
  return {
    laneH,
    noteAreaH,
    spY,
    soloY,
    editorH: soloY + SOLO_H,
    totalH: soloY + SOLO_H + SCROLLBAR_H,
    headH: Math.round(Math.max(18, Math.min(40, laneH * 0.42))),
    noteW: Math.round(Math.max(16, Math.min(30, laneH * 0.3))),
    tailH: Math.round(Math.max(8, Math.min(14, laneH * 0.12))),
  };
}

function hexToRgb(color) {
  const hex = String(color || "").trim();
  const full = hex.length === 4
    ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
    : hex;
  const n = full.startsWith("#") ? Number.parseInt(full.slice(1), 16) : NaN;
  if (!Number.isFinite(n)) return [255, 255, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function alpha(color, amount) {
  const [r, g, b] = hexToRgb(color);
  return `rgba(${r},${g},${b},${amount})`;
}

function mixWithWhite(color, amount) {
  const [r, g, b] = hexToRgb(color);
  const mix = (value) => Math.round(value + (255 - value) * amount).toString(16).padStart(2, "0");
  return `#${mix(r)}${mix(g)}${mix(b)}`;
}

function drawRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

function regionAtY(L, y) {
  if (y < SECTION_ROW_H) return { type: "sections" };
  if (y < RULER_H) return { type: "bars" };
  if (y < L.spY) return { type: "note", lane: Math.max(0, Math.min(4, Math.floor((y - RULER_H) / L.laneH))) };
  if (y < L.soloY) return { type: "sp" };
  return { type: "solo" };
}

function laneCenterY(L, lane) {
  return RULER_H + lane * L.laneH + L.laneH / 2;
}

export default function PianoRollEditor({
  project,
  bars = [],
  sections = [],
  regions = [],
  onRegionsChange,
  pending = null,
  loop = null,
  apiRef,
  onViewChange,
  onRedoMore,
}) {
  const { editor, applyEditorChange, requestEditorSeek } = project;
  const doc = editor.doc;
  const [pxPerBeat, setPxPerBeat] = useState(64);
  const [layout, setLayout] = useState(() => layoutFor(300));

  const rootRef = useRef(null);
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const scrollLeftRef = useRef(0);
  const dragRef = useRef(null);
  const rafRef = useRef(0);

  // Fresh-prop refs so the once-bound pointer handlers never read stale state.
  const docRef = useRef(doc);
  const editorRef = useRef(editor);
  const pxPerBeatRef = useRef(pxPerBeat);
  const layoutRef = useRef(layout);
  const viewRef = useRef({ bars, sections, regions, pending, loop });
  docRef.current = doc;
  editorRef.current = editor;
  pxPerBeatRef.current = pxPerBeat;
  layoutRef.current = layout;
  viewRef.current = { bars, sections, regions, pending, loop };

  const resolution = doc?.resolution || 192;
  const pxPerTick = pxPerBeat / resolution;

  const snapTick = useCallback(
    (tick) => {
      const step = snapTicks(docRef.current?.resolution || 192, editorRef.current.snap);
      if (!step) return Math.max(0, Math.round(tick));
      return Math.max(0, Math.round(tick / step) * step);
    },
    []
  );

  const lastTick = (() => {
    if (!doc) return resolution * 16;
    let max = resolution * 8;
    for (const note of doc.notes) {
      const sustain = Math.max(0, ...Object.values(note.sustainsByLane), 0);
      max = Math.max(max, note.tick + sustain);
    }
    for (const range of doc.ranges) max = Math.max(max, range.endTick);
    if (doc.durationSec) max = Math.max(max, doc.tempoMap.secondsToTick(doc.durationSec));
    return max + resolution * 8;
  })();
  const contentWidth = Math.max(1200, lastTick * pxPerTick);

  // ---- drawing ----
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    const activeDoc = docRef.current;
    if (!canvas || !container || !activeDoc) return;
    const L = layoutRef.current;
    const view = viewRef.current;
    const scrollLeft = scrollLeftRef.current;
    const ppt = pxPerBeatRef.current / (activeDoc.resolution || 192);
    const viewW = container.clientWidth || 1;
    const editorH = L.editorH;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewW * dpr);
    canvas.height = Math.floor(L.totalH * dpr);
    canvas.style.width = `${viewW}px`;
    canvas.style.height = `${L.totalH}px`;
    canvas.style.left = `${scrollLeft}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const app = canvas.closest(".ac-app");
    const dark = app?.dataset.theme === "dark";
    const vars = getComputedStyle(app || document.documentElement);
    const surface = vars.getPropertyValue("--surface").trim() || (dark ? "#313a52" : "#f7f7ff");
    const surface2 = vars.getPropertyValue("--surface-2").trim() || (dark ? "#3d4761" : "#e3e7f4");
    const border = vars.getPropertyValue("--border").trim() || (dark ? "#505a76" : "#a7b2d4");
    const borderSoft = vars.getPropertyValue("--border-soft").trim() || (dark ? "#404b66" : "#c7cfe7");
    const textDim = vars.getPropertyValue("--text-dim").trim() || (dark ? "#95a0bb" : "#535a7c");
    const purple = vars.getPropertyValue("--purple").trim() || (dark ? "#92a3d3" : "#4a4585");
    const purpleBri = vars.getPropertyValue("--purple-bri").trim() || purple;
    const orange = vars.getPropertyValue("--orange").trim() || "#ea76cb";

    const tickToX = (tick) => tick * ppt - scrollLeft;
    const startTick = scrollLeft / ppt;
    const endTick = (scrollLeft + viewW) / ppt;
    const sel = new Set(editorRef.current.selectedNoteIds);
    const rangeSel = new Set(editorRef.current.selectedRangeIds);
    const drag = dragRef.current;
    const pendingJob = view.pending;
    const inPending = (tick) => pendingJob?.regions.some((r) => tick >= r.startTick && tick < r.endTick);

    ctx.clearRect(0, 0, viewW, L.totalH);

    const bgGrad = ctx.createLinearGradient(0, 0, 0, editorH);
    bgGrad.addColorStop(0, dark ? "#252d40" : surface);
    bgGrad.addColorStop(1, surface2);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, viewW, editorH);

    // Lane backgrounds.
    for (let lane = 0; lane < 5; lane += 1) {
      const y = RULER_H + lane * L.laneH;
      ctx.fillStyle = lane % 2 === 0
        ? (dark ? "rgba(255,255,255,0.018)" : "rgba(255,255,255,0.22)")
        : (dark ? "rgba(255,255,255,0.045)" : "rgba(74,69,133,0.035)");
      ctx.fillRect(0, y, viewW, L.laneH);
      const wash = ctx.createLinearGradient(0, 0, 74, 0);
      wash.addColorStop(0, alpha(LANE_COLORS[lane], dark ? 0.23 : 0.18));
      wash.addColorStop(1, alpha(LANE_COLORS[lane], 0));
      ctx.fillStyle = wash;
      ctx.fillRect(0, y, 96, L.laneH);
      ctx.strokeStyle = alpha(borderSoft, dark ? 0.6 : 0.75);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + L.laneH - 0.5);
      ctx.lineTo(viewW, y + L.laneH - 0.5);
      ctx.stroke();
    }

    // The horizontal scrollbar lives in this footer band, so it never covers
    // the solo strip at the bottom of the editable lanes.
    ctx.fillStyle = dark ? "rgba(20,22,34,0.72)" : "rgba(241,243,251,0.92)";
    ctx.fillRect(0, editorH, viewW, SCROLLBAR_H);

    // Grid lines (snap subdivisions, beats, bars).
    const snapStep = snapTicks(activeDoc.resolution, editorRef.current.snap);
    const drawGridLines = (step, color, width) => {
      if (!step || step * ppt < 4) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      const first = Math.floor(startTick / step) * step;
      ctx.beginPath();
      for (let tick = first; tick <= endTick; tick += step) {
        const x = Math.round(tickToX(tick)) + 0.5;
        ctx.moveTo(x, RULER_H);
        ctx.lineTo(x, editorH);
      }
      ctx.stroke();
    };
    if (snapStep && snapStep < activeDoc.resolution) {
      drawGridLines(snapStep, dark ? "rgba(255,255,255,0.035)" : "rgba(74,69,133,0.035)", 1);
    }
    drawGridLines(activeDoc.resolution, dark ? "rgba(255,255,255,0.075)" : "rgba(74,69,133,0.065)", 1);
    ctx.strokeStyle = alpha(purple, dark ? 0.42 : 0.28);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const barTick of view.bars) {
      if (barTick < startTick - 1 || barTick > endTick + 1) continue;
      const x = Math.round(tickToX(barTick)) + 0.5;
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, editorH);
    }
    ctx.stroke();

    // Redo regions: selected (solid purple) and in-flight (sweeping).
    const drawRegionBand = (region, fill, edge) => {
      const x = tickToX(region.startTick);
      const w = (region.endTick - region.startTick) * ppt;
      if (x > viewW || x + w < 0) return;
      ctx.fillStyle = fill;
      ctx.fillRect(x, RULER_H, w, L.noteAreaH);
      ctx.fillStyle = edge;
      ctx.fillRect(x, RULER_H, 2, L.noteAreaH);
      ctx.fillRect(x + w - 2, RULER_H, 2, L.noteAreaH);
    };
    for (const region of view.regions) {
      drawRegionBand(region, alpha(purpleBri, dark ? 0.16 : 0.1), alpha(purpleBri, 0.85));
    }
    if (pendingJob) {
      const now = performance.now();
      for (const region of pendingJob.regions) {
        drawRegionBand(region, alpha(orange, dark ? 0.1 : 0.08), alpha(orange, 0.9));
        const x = tickToX(region.startTick);
        const w = (region.endTick - region.startTick) * ppt;
        const sweep = x + ((now / 900) % 1) * w;
        const grad = ctx.createLinearGradient(sweep - 60, 0, sweep + 60, 0);
        grad.addColorStop(0, alpha(orange, 0));
        grad.addColorStop(0.5, alpha(orange, dark ? 0.22 : 0.16));
        grad.addColorStop(1, alpha(orange, 0));
        ctx.fillStyle = grad;
        ctx.fillRect(Math.max(x, sweep - 60), RULER_H, Math.min(120, x + w - Math.max(x, sweep - 60)), L.noteAreaH);
      }
    }
    if (drag?.kind === "barSelect" && drag.moved) {
      const preview = snapSpanToBars(view.bars, drag.anchorTick, drag.curTick);
      drawRegionBand(preview, alpha(purpleBri, 0.14), alpha(purpleBri, 0.9));
    }

    // Range bands (star power / solo) drawn behind notes plus on their lanes.
    const drawRange = (range, color, laneY, laneH) => {
      const x = tickToX(range.startTick);
      const w = (range.endTick - range.startTick) * ppt;
      const selected = rangeSel.has(range.id);
      const visibleW = Math.max(1, w);
      ctx.fillStyle = alpha(color, dark ? 0.12 : 0.09);
      ctx.fillRect(x, RULER_H, w, L.noteAreaH);
      const grad = ctx.createLinearGradient(0, laneY, 0, laneY + laneH);
      grad.addColorStop(0, alpha(color, selected ? 0.48 : 0.34));
      grad.addColorStop(1, alpha(color, selected ? 0.30 : 0.20));
      ctx.fillStyle = grad;
      drawRoundRect(ctx, x, laneY + 3, visibleW, laneH - 6, 5);
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 2 : 1;
      ctx.strokeRect(Math.round(x) + 0.5, laneY + 3.5, Math.round(visibleW), laneH - 7);
    };
    for (const range of activeDoc.ranges) {
      if (drag?.kind === "erase" && drag.rangeIds?.has(range.id)) continue;
      const drawData = drag?.kind === "erase" && drag.rangeCuts?.has(range.id)
        ? { ...range, endTick: drag.rangeCuts.get(range.id) }
        : range;
      if (drawData.endTick <= drawData.startTick) continue;
      if (drawData.endTick < startTick || drawData.startTick > endTick) continue;
      if (drawData.kind === "starPower") drawRange(drawData, SP_COLOR, L.spY, SP_H);
      else drawRange(drawData, SOLO_COLOR, L.soloY, SOLO_H);
    }

    // Notes (with live drag transform applied).
    const moveDelta = drag?.kind === "move" ? { tick: drag.deltaTick, lane: drag.deltaLane } : null;
    const sustainOverride = drag?.kind === "sustain" ? { id: drag.noteId, sustain: drag.sustain } : null;
    const eraseOverride = drag?.kind === "erase" ? drag : null;
    const drawNoteHead = (x, y, color, selected, tap, force) => {
      const h = L.headH;
      const top = y - h / 2;
      const fillColor = force && !tap ? mixWithWhite(color, 0.38) : color;
      const tapOutline = dark ? "#8af3ff" : "#0f92b3";
      const grad = ctx.createLinearGradient(0, top, 0, top + h);
      grad.addColorStop(0, alpha(fillColor, tap ? 0.68 : 0.98));
      grad.addColorStop(1, alpha(fillColor, tap ? 0.38 : 0.72));
      ctx.fillStyle = grad;
      drawRoundRect(ctx, x - L.noteW / 2, top, L.noteW, h, 6);
      ctx.strokeStyle = selected ? "#ffffff" : tap ? tapOutline : force ? FORCE_OUTLINE : "rgba(0,0,0,0.28)";
      ctx.lineWidth = selected ? 2.5 : tap || force ? 2.2 : 1;
      ctx.stroke();
      ctx.fillStyle = tap ? "rgba(255,255,255,0.12)" : force ? "rgba(255,255,255,0.34)" : "rgba(255,255,255,0.22)";
      drawRoundRect(ctx, x - L.noteW / 2 + 3, top + 3, L.noteW - 6, 3, 3);
      if (selected) {
        ctx.strokeStyle = alpha(purple, dark ? 0.95 : 0.85);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    };
    const sustainFor = (note, lane) => {
      if (eraseOverride?.sustainCuts?.has(note.id)) return eraseOverride.sustainCuts.get(note.id);
      if (sustainOverride?.id === note.id) return sustainOverride.sustain;
      return note.open ? note.sustainsByLane.open || 0 : note.sustainsByLane[lane] || 0;
    };
    const drawNote = (note, { faded = false } = {}) => {
      if (eraseOverride?.noteIds?.has(note.id)) return;
      const moved = moveDelta && sel.has(note.id);
      const baseTick = note.tick + (moved ? moveDelta.tick : 0);
      const headX = tickToX(baseTick);
      if (headX < -200 || headX > viewW + 200) return;
      const selected = sel.has(note.id);
      ctx.globalAlpha = faded ? 0.22 : 1;
      if (note.open) {
        const sustain = sustainFor(note, "open");
        if (sustain > 0) {
          ctx.fillStyle = alpha(OPEN_COLOR, 0.32);
          drawRoundRect(ctx, headX, RULER_H + 8, sustain * ppt, L.noteAreaH - 16, 5);
        }
        ctx.fillStyle = OPEN_COLOR;
        ctx.strokeStyle = selected ? "#fff" : "rgba(0,0,0,0.35)";
        ctx.lineWidth = selected ? 2.5 : 1;
        drawRoundRect(ctx, headX - L.noteW / 2, RULER_H + 8, L.noteW, L.noteAreaH - 16, 6);
        ctx.stroke();
        ctx.globalAlpha = 1;
        return;
      }
      for (const lane of note.lanes) {
        const drawLane = moved ? Math.max(0, Math.min(4, lane + moveDelta.lane)) : lane;
        const cy = laneCenterY(L, drawLane);
        const sustain = sustainFor(note, lane);
        if (sustain > 0) {
          const tailGrad = ctx.createLinearGradient(headX, 0, headX + sustain * ppt, 0);
          tailGrad.addColorStop(0, alpha(LANE_COLORS[drawLane], 0.58));
          tailGrad.addColorStop(1, alpha(LANE_COLORS[drawLane], 0.24));
          ctx.fillStyle = tailGrad;
          drawRoundRect(ctx, headX, cy - L.tailH / 2, sustain * ppt, L.tailH, L.tailH / 2);
        }
        drawNoteHead(headX, cy, LANE_COLORS[drawLane], selected, note.tap, note.force);
      }
      ctx.globalAlpha = 1;
    };
    for (const note of activeDoc.notes) drawNote(note, { faded: Boolean(pendingJob && inPending(note.tick)) });
    // Streamed notes from an in-flight redo draw over the faded originals.
    for (const note of pendingJob?.notes || []) drawNote(note);

    // Pending draw-note preview.
    if (drag?.kind === "drawNote") {
      const x = tickToX(drag.tick);
      if (drag.lane === "open") {
        ctx.fillStyle = alpha(OPEN_COLOR, 0.55);
        drawRoundRect(ctx, x - L.noteW / 2, RULER_H + 8, L.noteW, L.noteAreaH - 16, 5);
        if (drag.sustain > 0) drawRoundRect(ctx, x, RULER_H + 8, drag.sustain * ppt, L.noteAreaH - 16, 5);
      } else {
        const cy = laneCenterY(L, drag.lane);
        if (drag.sustain > 0) {
          ctx.fillStyle = LANE_COLORS[drag.lane];
          ctx.globalAlpha = 0.45;
          drawRoundRect(ctx, x, cy - L.tailH / 2, drag.sustain * ppt, L.tailH, L.tailH / 2);
          ctx.globalAlpha = 1;
        }
        drawNoteHead(x, cy, LANE_COLORS[drag.lane], true, false, false);
      }
    }

    // Pending range preview.
    if (drag?.kind === "range") {
      const x = tickToX(Math.min(drag.startTick, drag.curTick));
      const w = Math.abs(drag.curTick - drag.startTick) * ppt;
      ctx.fillStyle = alpha(drag.kind2 === "solo" ? SOLO_COLOR : SP_COLOR, 0.24);
      ctx.fillRect(x, RULER_H, w, L.noteAreaH);
    }

    // Pending box-select preview.
    if (drag?.kind === "boxSelect") {
      const x = Math.min(drag.startX, drag.curX);
      const y = Math.max(RULER_H, Math.min(drag.startY, drag.curY));
      const w = Math.abs(drag.curX - drag.startX);
      const h = Math.max(0, Math.min(L.spY, Math.max(drag.startY, drag.curY)) - y);
      if (w > 0 && h > 0) {
        ctx.fillStyle = alpha(purple, dark ? 0.16 : 0.12);
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = alpha(purple, dark ? 0.92 : 0.72);
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
        ctx.setLineDash([]);
      }
    }

    // Ruler: section row on top, bar numbers below.
    ctx.fillStyle = dark ? "rgba(35,42,59,0.97)" : "rgba(247,247,255,0.97)";
    ctx.fillRect(0, 0, viewW, RULER_H);
    ctx.strokeStyle = alpha(border, 0.55);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5);
    ctx.lineTo(viewW, RULER_H - 0.5);
    ctx.stroke();

    ctx.font = "700 11px Inter, system-ui, sans-serif";
    for (const section of view.sections) {
      const x1 = tickToX(section.startTick);
      const x2 = tickToX(section.endTick);
      if (x2 < 0 || x1 > viewW) continue;
      const selected = view.regions.some((r) => r.startTick === section.startTick && r.endTick === section.endTick);
      const left = Math.max(x1 + 2, 0);
      const width = Math.max(0, x2 - 2 - left);
      ctx.fillStyle = alpha(section.color, selected ? 0.95 : dark ? 0.32 : 0.26);
      drawRoundRect(ctx, left, 3, width, SECTION_ROW_H - 5, 7);
      if (width > 30) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(left, 0, width - 6, SECTION_ROW_H);
        ctx.clip();
        ctx.fillStyle = selected ? "#fff" : dark ? "#e8ecfa" : "#2b2f4d";
        ctx.fillText(section.name, left + 8, 16);
        ctx.restore();
      }
    }

    // Bar numbers; thin out when bars get narrow.
    const barW = (view.bars[1] - view.bars[0] || activeDoc.resolution * 4) * ppt;
    const every = barW >= 34 ? 1 : barW >= 16 ? 2 : barW >= 8 ? 4 : 8;
    ctx.font = "600 10px 'JetBrains Mono', ui-monospace, monospace";
    for (const region of view.regions) {
      const x = tickToX(region.startTick);
      const w = (region.endTick - region.startTick) * ppt;
      ctx.fillStyle = alpha(purpleBri, 0.9);
      drawRoundRect(ctx, x + 1, SECTION_ROW_H + 2, Math.max(2, w - 2), BAR_ROW_H - 4, 6);
    }
    view.bars.forEach((barTick, index) => {
      if (index % every) return;
      const x = tickToX(barTick);
      if (x < -40 || x > viewW + 4) return;
      const selected = view.regions.some((r) => barTick >= r.startTick && barTick < r.endTick);
      ctx.fillStyle = selected ? "#fff" : textDim;
      ctx.fillText(String(index + 1), x + 4, SECTION_ROW_H + 15);
    });

    // Loop bracket along the bottom of the bar row.
    if (view.loop) {
      const x1 = tickToX(view.loop.startTick);
      const x2 = tickToX(view.loop.endTick);
      ctx.fillStyle = orange;
      ctx.fillRect(x1, RULER_H - 3, x2 - x1, 3);
      ctx.fillRect(x1, SECTION_ROW_H + 4, 2, BAR_ROW_H - 4);
      ctx.fillRect(x2 - 2, SECTION_ROW_H + 4, 2, BAR_ROW_H - 4);
    }

    // Playhead.
    const playTick = activeDoc.tempoMap.secondsToTick(editorRef.current.playhead.time || 0);
    const px = tickToX(playTick);
    if (px >= 0 && px <= viewW) {
      ctx.strokeStyle = orange;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, SECTION_ROW_H);
      ctx.lineTo(px, editorH);
      ctx.stroke();
      ctx.fillStyle = orange;
      ctx.beginPath();
      ctx.moveTo(px - 6, SECTION_ROW_H);
      ctx.lineTo(px + 6, SECTION_ROW_H);
      ctx.lineTo(px, SECTION_ROW_H + 8);
      ctx.fill();
    }
  }, []);

  const scheduleDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  }, [draw]);

  const reportView = useCallback(() => {
    const container = containerRef.current;
    const activeDoc = docRef.current;
    if (!container || !activeDoc || !onViewChange) return;
    const ppt = pxPerBeatRef.current / (activeDoc.resolution || 192);
    onViewChange({ startTick: container.scrollLeft / ppt, endTick: (container.scrollLeft + container.clientWidth) / ppt });
  }, [onViewChange]);

  // Redraw on any state that affects the picture.
  useEffect(() => {
    scheduleDraw();
  }, [doc, editor.revision, editor.selectedNoteIds, editor.selectedRangeIds, editor.playhead, editor.snap, pxPerBeat, layout, bars, sections, regions, pending, loop, scheduleDraw]);

  useEffect(() => {
    reportView();
  }, [pxPerBeat, layout, doc, reportView]);

  // Keep the sweep animating while a redo is in flight.
  useEffect(() => {
    if (!pending) return undefined;
    let frame = 0;
    const tick = () => {
      draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [pending, draw]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      const next = layoutFor(root.clientHeight);
      setLayout((prev) => (prev.laneH === next.laneH ? prev : next));
      scheduleDraw();
      reportView();
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [scheduleDraw, reportView]);

  // Follow the playhead while playing (paused during an active drag gesture).
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !doc || dragRef.current) return;
    if (!editor.playing) return;
    const playTick = doc.tempoMap.secondsToTick(editor.playhead.time || 0);
    const px = playTick * pxPerTick - container.scrollLeft;
    const viewW = container.clientWidth;
    if (px < viewW * 0.15 || px > viewW * 0.75) {
      container.scrollLeft = Math.max(0, playTick * pxPerTick - viewW * 0.3);
    }
  }, [editor.playhead, editor.playing, doc, pxPerTick]);

  const onScroll = useCallback(() => {
    scrollLeftRef.current = containerRef.current?.scrollLeft || 0;
    scheduleDraw();
    reportView();
  }, [scheduleDraw, reportView]);

  useImperativeHandle(apiRef, () => ({
    scrollToTick(tick, align = "center") {
      const container = containerRef.current;
      if (!container) return;
      const offset = align === "start" ? container.clientWidth * 0.12 : container.clientWidth / 2;
      container.scrollLeft = Math.max(0, tick * pxPerTick - offset);
    },
    zoom(factor) {
      setPxPerBeat((v) => Math.max(12, Math.min(260, Math.round(v * factor))));
    },
  }), [pxPerTick]);

  // Ctrl/Cmd + wheel zooms around the pointer.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    const onWheel = (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const activeDoc = docRef.current;
      const res = activeDoc?.resolution || 192;
      const anchorTick = (container.scrollLeft + offsetX) / (pxPerBeatRef.current / res);
      const next = Math.max(12, Math.min(260, Math.round(pxPerBeatRef.current * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
      setPxPerBeat(next);
      requestAnimationFrame(() => {
        container.scrollLeft = Math.max(0, anchorTick * (next / res) - offsetX);
      });
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  // ---- pointer interactions ----
  const toLocal = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const xToTick = (x) => Math.max(0, (scrollLeftRef.current + x) / pxPerTick);
  const timeAtTick = (tick) => doc.tempoMap.tickToSeconds(tick);

  const hitTest = (localX, localY) => {
    const activeDoc = docRef.current;
    const L = layoutRef.current;
    const ppt = pxPerBeatRef.current / (activeDoc.resolution || 192);
    const tickToX = (tick) => tick * ppt - scrollLeftRef.current;
    // Ranges on their dedicated strips (with edge resize handles).
    const region = regionAtY(L, localY);
    if (region.type === "sp" || region.type === "solo") {
      const kind = region.type === "sp" ? "starPower" : "solo";
      for (const range of activeDoc.ranges) {
        if (range.kind !== kind) continue;
        const x1 = tickToX(range.startTick);
        const x2 = tickToX(range.endTick);
        if (localX >= x1 - EDGE_GRAB && localX <= x2 + EDGE_GRAB) {
          if (Math.abs(localX - x1) <= EDGE_GRAB) return { range, part: "start" };
          if (Math.abs(localX - x2) <= EDGE_GRAB) return { range, part: "end" };
          return { range, part: "body" };
        }
      }
      return null;
    }
    if (region.type !== "note") return null;
    for (const note of activeDoc.notes) {
      const headX = tickToX(note.tick);
      const lanes = note.open ? [0, 1, 2, 3, 4] : note.lanes;
      for (const lane of lanes) {
        const cy = laneCenterY(L, lane);
        if (Math.abs(localY - cy) > L.laneH / 2 - 2) continue;
        if (Math.abs(localX - headX) <= L.noteW / 2 + 2) return { note, part: "head", lane };
        const sustain = note.open ? note.sustainsByLane.open || 0 : note.sustainsByLane[lane] || 0;
        if (sustain > 0) {
          const tailEndX = (note.tick + sustain) * ppt - scrollLeftRef.current;
          if (localX > headX + L.noteW / 2 && localX <= tailEndX + 4) return { note, part: "tail", lane };
        }
      }
    }
    return null;
  };

  const noteIdsInBox = (drag) => {
    const activeDoc = docRef.current;
    if (!activeDoc) return [];
    const L = layoutRef.current;
    const ppt = pxPerBeatRef.current / (activeDoc.resolution || 192);
    const left = Math.min(drag.startX, drag.curX);
    const right = Math.max(drag.startX, drag.curX);
    const top = Math.max(RULER_H, Math.min(drag.startY, drag.curY));
    const bottom = Math.min(L.spY, Math.max(drag.startY, drag.curY));
    if (right - left < BOX_SELECT_MIN_DRAG || bottom - top < BOX_SELECT_MIN_DRAG) return [];

    const tickToX = (tick) => tick * ppt - scrollLeftRef.current;
    const ids = [];
    for (const note of activeDoc.notes) {
      const x = tickToX(note.tick);
      if (x + L.noteW / 2 < left || x - L.noteW / 2 > right) continue;
      if (note.open) {
        if (bottom >= RULER_H && top <= L.spY) ids.push(note.id);
        continue;
      }
      const hitLane = note.lanes.some((lane) => {
        const cy = laneCenterY(L, lane);
        const headTop = cy - L.headH / 2;
        const headBottom = cy + L.headH / 2;
        return headBottom >= top && headTop <= bottom;
      });
      if (hitLane) ids.push(note.id);
    }
    return ids;
  };

  const markEraseRange = (drag, range, localX) => {
    if (drag.rangeIds.has(range.id)) return false;
    const endTick = snapTick(xToTick(localX));
    if (endTick <= range.startTick) {
      drag.rangeIds.add(range.id);
      drag.rangeCuts.delete(range.id);
      drag.changed = true;
      return true;
    }
    if (endTick >= range.endTick) return false;
    const current = drag.rangeCuts.get(range.id);
    if (current == null || endTick < current) {
      drag.rangeCuts.set(range.id, endTick);
      drag.changed = true;
      return true;
    }
    return false;
  };

  const markEraseHit = (drag, localX, localY) => {
    const hit = hitTest(localX, localY);
    if (hit?.range) {
      return markEraseRange(drag, hit.range, localX);
    }
    if (!hit?.note) {
      const region = regionAtY(layoutRef.current, localY);
      if (region.type !== "note") return false;
      const tick = xToTick(localX);
      let changed = false;
      for (const range of docRef.current?.ranges || []) {
        if (tick < range.startTick || tick > range.endTick || drag.rangeIds.has(range.id)) continue;
        changed = markEraseRange(drag, range, localX) || changed;
      }
      return changed;
    }
    if (hit.part === "tail") {
      if (drag.noteIds.has(hit.note.id)) return false;
      const sustain = Math.max(0, snapTick(xToTick(localX)) - hit.note.tick);
      const current = drag.sustainCuts.get(hit.note.id);
      if (current == null || sustain < current) {
        drag.sustainCuts.set(hit.note.id, sustain);
        drag.changed = true;
        return true;
      }
      return false;
    }
    if (drag.noteIds.has(hit.note.id)) return false;
    drag.noteIds.add(hit.note.id);
    drag.sustainCuts.delete(hit.note.id);
    drag.changed = true;
    return true;
  };

  const markErasePath = (drag, localX, localY) => {
    const fromX = drag.lastX ?? localX;
    const fromY = drag.lastY ?? localY;
    const dx = localX - fromX;
    const dy = localY - fromY;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (layoutRef.current.noteW / 2)));
    let changed = false;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      changed = markEraseHit(drag, fromX + dx * t, fromY + dy * t) || changed;
    }
    drag.lastX = localX;
    drag.lastY = localY;
    if (changed) scheduleDraw();
  };

  const newEraseDrag = (x, y) => ({ kind: "erase", noteIds: new Set(), rangeIds: new Set(), sustainCuts: new Map(), rangeCuts: new Map(), lastX: x, lastY: y, changed: false });

  const onPointerDown = (e) => {
    if (!doc || e.button !== 0) return;
    canvasRef.current.setPointerCapture(e.pointerId);
    const { x, y } = toLocal(e);
    const region = regionAtY(layoutRef.current, y);
    const tick = xToTick(x);
    const tool = editor.tool;

    if (region.type === "sections") {
      const section = sections.find((s) => tick >= s.startTick && tick < s.endTick);
      if (section) {
        const span = { startTick: section.startTick, endTick: section.endTick };
        const already = regions.some((r) => r.startTick === span.startTick && r.endTick === span.endTick);
        if (e.shiftKey) {
          onRegionsChange?.(already
            ? regions.filter((r) => r.startTick !== span.startTick || r.endTick !== span.endTick)
            : normalizeRegions([...regions, span]));
        } else {
          onRegionsChange?.(already && regions.length === 1 ? [] : [span]);
        }
      } else {
        requestEditorSeek(timeAtTick(tick));
      }
      dragRef.current = { kind: "noop" };
      return;
    }

    if (region.type === "bars") {
      dragRef.current = { kind: "barSelect", anchorTick: tick, curTick: tick, startX: x, additive: e.shiftKey, moved: false };
      return;
    }

    const hit = hitTest(x, y);

    // Range strips: create / resize / move / select regardless of tool.
    if (region.type === "sp" || region.type === "solo") {
      const kind = region.type === "sp" ? "starPower" : "solo";
      if (tool === "erase") {
        const drag = newEraseDrag(x, y);
        markErasePath(drag, x, y);
        dragRef.current = drag;
        return;
      }
      if (hit?.range) {
        applyEditorChange({ type: "select", rangeIds: [hit.range.id], additive: e.shiftKey });
        if (hit.part === "body") {
          dragRef.current = { kind: "rangeMove", id: hit.range.id, startTick: tick, origStart: hit.range.startTick, origEnd: hit.range.endTick };
        } else {
          dragRef.current = { kind: "rangeResize", id: hit.range.id, edge: hit.part, otherTick: hit.part === "start" ? hit.range.endTick : hit.range.startTick };
        }
        return;
      }
      dragRef.current = { kind: "range", kind2: kind, startTick: snapTick(tick), curTick: snapTick(tick) };
      return;
    }

    // Note area.
    if (tool === "draw") {
      const lane = region.lane;
      dragRef.current = { kind: "drawNote", tick: snapTick(tick), lane, sustain: 0, anchorTick: snapTick(tick) };
      scheduleDraw();
      return;
    }
    if (tool === "erase") {
      const drag = newEraseDrag(x, y);
      markErasePath(drag, x, y);
      dragRef.current = drag;
      return;
    }

    // Select tool.
    if (hit?.note) {
      const alreadySelected = editor.selectedNoteIds.includes(hit.note.id);
      if (!alreadySelected || e.shiftKey) {
        applyEditorChange({ type: "select", noteIds: [hit.note.id], additive: e.shiftKey });
      }
      if (hit.part === "tail") {
        dragRef.current = { kind: "sustain", noteId: hit.note.id, headTick: hit.note.tick, sustain: hit.note.sustainsByLane[hit.lane] ?? hit.note.sustainsByLane.open ?? 0 };
      } else {
        const ids = alreadySelected ? editor.selectedNoteIds : [hit.note.id];
        dragRef.current = { kind: "move", ids, startTick: tick, startLane: region.lane, deltaTick: 0, deltaLane: 0, moved: false };
      }
      return;
    }
    dragRef.current = { kind: "boxSelect", startX: x, startY: y, curX: x, curY: y, additive: e.shiftKey, moved: false };
    scheduleDraw();
  };

  const onPointerMove = (e) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { x, y } = toLocal(e);
    const tick = xToTick(x);
    if (drag.kind === "barSelect") {
      drag.curTick = tick;
      drag.moved = drag.moved || Math.abs(x - drag.startX) >= REGION_MIN_DRAG;
      scheduleDraw();
      return;
    }
    if (drag.kind === "move") {
      const region = regionAtY(layoutRef.current, y);
      drag.deltaTick = snapTick(tick) - snapTick(drag.startTick);
      drag.deltaLane = region.type === "note" ? region.lane - drag.startLane : drag.deltaLane;
      drag.moved = true;
      scheduleDraw();
      return;
    }
    if (drag.kind === "sustain") {
      drag.sustain = Math.max(0, snapTick(tick) - drag.headTick);
      scheduleDraw();
      return;
    }
    if (drag.kind === "drawNote") {
      drag.sustain = Math.max(0, snapTick(tick) - drag.anchorTick);
      scheduleDraw();
      return;
    }
    if (drag.kind === "erase") {
      markErasePath(drag, x, y);
      return;
    }
    if (drag.kind === "boxSelect") {
      drag.curX = x;
      drag.curY = y;
      drag.moved = drag.moved || Math.hypot(drag.curX - drag.startX, drag.curY - drag.startY) >= BOX_SELECT_MIN_DRAG;
      scheduleDraw();
      return;
    }
    if (drag.kind === "range" || drag.kind === "rangeResize" || drag.kind === "rangeMove") {
      drag.curTick = snapTick(tick);
      scheduleDraw();
    }
  };

  const onPointerUp = (e) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    try {
      canvasRef.current.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    if (drag.kind === "barSelect") {
      if (drag.moved) {
        const span = snapSpanToBars(bars, drag.anchorTick, drag.curTick);
        onRegionsChange?.(drag.additive ? normalizeRegions([...regions, span]) : [span]);
      } else {
        requestEditorSeek(timeAtTick(drag.anchorTick));
      }
    } else if (drag.kind === "move" && drag.moved && (drag.deltaTick || drag.deltaLane)) {
      applyEditorChange({ type: "moveNotes", ids: drag.ids, deltaTick: drag.deltaTick, deltaLane: drag.deltaLane });
    } else if (drag.kind === "sustain") {
      applyEditorChange({ type: "setSustain", id: drag.noteId, sustain: drag.sustain });
    } else if (drag.kind === "drawNote") {
      applyEditorChange({ type: "addNote", tick: drag.tick, lane: drag.lane, sustain: drag.sustain });
    } else if (drag.kind === "erase") {
      if (drag.changed) {
        applyEditorChange({
          type: "eraseGesture",
          ids: [...drag.noteIds],
          rangeIds: [...drag.rangeIds],
          sustainCuts: [...drag.sustainCuts].map(([id, sustain]) => ({ id, sustain })),
          rangeCuts: [...drag.rangeCuts].map(([id, endTick]) => ({ id, endTick })),
        });
      }
    } else if (drag.kind === "boxSelect") {
      const { x, y } = toLocal(e);
      drag.curX = x;
      drag.curY = y;
      const moved = drag.moved || Math.hypot(drag.curX - drag.startX, drag.curY - drag.startY) >= BOX_SELECT_MIN_DRAG;
      if (moved) {
        applyEditorChange({ type: "select", noteIds: noteIdsInBox(drag), additive: drag.additive });
      } else {
        applyEditorChange({ type: "clearSelection" });
        if (!drag.additive && regions.length) onRegionsChange?.([]);
      }
    } else if (drag.kind === "range") {
      const { x } = toLocal(e);
      const endTick = snapTick(xToTick(x));
      if (Math.abs(endTick - drag.startTick) >= 1) {
        applyEditorChange({ type: "addRange", kind: drag.kind2, startTick: drag.startTick, endTick });
      }
    } else if (drag.kind === "rangeResize") {
      applyEditorChange({ type: "updateRange", id: drag.id, startTick: drag.edge === "start" ? drag.curTick : drag.otherTick, endTick: drag.edge === "end" ? drag.curTick : drag.otherTick });
    } else if (drag.kind === "rangeMove") {
      const delta = drag.curTick - drag.startTick;
      if (delta) applyEditorChange({ type: "updateRange", id: drag.id, startTick: Math.max(0, drag.origStart + delta), endTick: Math.max(0, drag.origEnd + delta) });
    }
    scheduleDraw();
  };

  if (!doc) {
    return <div className="piano-roll-empty">Pick a take and press Edit to open it here.</div>;
  }

  const redos = doc.redos || [];

  return (
    <div className="piano-roll" ref={rootRef} data-tool={editor.tool}>
      <div className="piano-roll-side" aria-hidden="true">
        <div className="pr-ruler-spacer" style={{ height: RULER_H }} />
        {["G", "R", "Y", "B", "O"].map((label, lane) => (
          <div key={label} className="pr-lane-label" style={{ height: layout.laneH, "--lane": LANE_COLORS[lane] }}>
            <span />
          </div>
        ))}
        <div className="pr-strip-label" style={{ height: SP_H, color: SP_COLOR }}>SP</div>
        <div className="pr-strip-label" style={{ height: SOLO_H, color: SOLO_COLOR }}>SOLO</div>
      </div>
      <div className="piano-roll-scroll" ref={containerRef} onScroll={onScroll}>
        <div className="piano-roll-content" style={{ width: contentWidth, height: layout.totalH }}>
          <canvas
            ref={canvasRef}
            className="piano-roll-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {redos.map((redo) => (
            <RedoChips
              key={redo.id}
              redo={redo}
              left={redo.regions[0].startTick * pxPerTick}
              width={(redo.regions[redo.regions.length - 1].endTick - redo.regions[0].startTick) * pxPerTick}
              top={RULER_H + 6}
              busy={Boolean(pending)}
              onPick={(index) => applyEditorChange({ type: "pickRedoTake", redoId: redo.id, index })}
              onMore={() => onRedoMore?.(redo)}
              onKeep={() => applyEditorChange({ type: "keepRedo", redoId: redo.id })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// The per-redo take switcher: Original, each take, "+" for another one, and ✓
// to keep the current one and dismiss the switcher.
// The track spans the redo; the chips stick to its left edge while scrolling
// through it, so they stay in view anywhere inside a long section.
function RedoChips({ redo, left, width, top, busy, onPick, onMore, onKeep }) {
  return (
    <div className="redo-chips-track" style={{ left, width, top }}>
    <div className="redo-chips" onPointerDown={(e) => e.stopPropagation()}>
      <button className={redo.active < 0 ? "active orig" : "orig"} onClick={() => onPick(-1)} title="Original notes">
        <I.undo />
      </button>
      {redo.takes.map((_, index) => (
        <button key={index} className={redo.active === index ? "active" : ""} onClick={() => onPick(index)} title={`Take ${index + 1}`}>
          {index + 1}
        </button>
      ))}
      <button onClick={onMore} disabled={busy} title="Try another take"><I.plus /></button>
      <button className="keep" onClick={onKeep} title="Keep this one"><I.check /></button>
    </div>
    </div>
  );
}

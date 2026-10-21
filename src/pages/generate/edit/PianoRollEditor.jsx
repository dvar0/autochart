import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { FRET_COLORS, OPEN_NOTE_COLOR } from "../../../data/notePalette.js";
import { snapTicks } from "./chartEditor.js";
import {
  barIndexAt,
  extendToEnd,
  moveRegion,
  nearestBarLine,
  paintRegions,
  regionsCover,
  regionsOverlap,
  resizeRegion,
  resizedSpan,
  shiftSpan,
  snapSpanToBars,
  songEndBarTick,
} from "./editRegions.js";

// Canvas-based piano roll. The editor doc (ticks) is the source of truth; this
// component renders a virtualized horizontal timeline and translates pointer
// gestures into committed reducer actions (one per gesture). Live drag state is
// kept in a ref and drawn directly, so pointermove never spams the reducer.
//
// `mode` follows the screen's tab. "regen": bars are painted like steps in a
// step sequencer. A drag that starts on unpicked bars adds them (merging with
// any area it touches); one that starts on picked bars removes them; a click
// toggles one bar; right-drag always removes. Each picked area shows as a block
// in the bar row: drag it to move it, drag its grips to stretch it. Clicking a
// section name is handled by the screen. Past each area's end sits an arrow
// that stretches it to the end of the song (hover shows how far). Notes
// can't be touched. "edit":
// click empty space to add a note (a ghost shows where), drag empty space to
// select notes, drag a note to move it, drag its right end to stretch a
// sustain, right-click or right-drag to delete; the bar row only seeks.

const SECTION_ROW_H = 24;
const BAR_ROW_H = 22;
const SP_H = 20;
const SOLO_H = 20;
const SCROLLBAR_H = 18;
const EDGE_GRAB = 5;
const SUSTAIN_GRAB = 7;
const SELECTION_GRAB = 6;
const BOX_SELECT_MIN_DRAG = 3;
const REGION_MIN_DRAG = 4;
// The "to the end" arrow just past a picked area's end, in the bar row.
const EXTEND_GAP = 8;
const EXTEND_W = 22;

const LANE_COLORS = FRET_COLORS;
const OPEN_COLOR = OPEN_NOTE_COLOR;
const SP_COLOR = "#36c5f0";
const SOLO_COLOR = "#9a6bff";
const FORCE_OUTLINE = "rgba(255,255,255,0.96)";

// Lanes stay compact: height adds no information, width does, so the roll
// spends the screen on bars instead of taller rows.
function layoutFor(laneH) {
  const rulerH = SECTION_ROW_H + BAR_ROW_H;
  const noteAreaH = laneH * 5;
  const spY = rulerH + noteAreaH;
  const soloY = spY + SP_H;
  return {
    laneH,
    rulerH,
    noteAreaH,
    spY,
    soloY,
    editorH: soloY + SOLO_H,
    totalH: soloY + SOLO_H + SCROLLBAR_H,
    headH: Math.round(laneH * 0.62),
    noteW: Math.round(laneH * 0.36),
    tailH: Math.round(laneH * 0.22),
  };
}

const laneHeightFor = (viewportH) => (viewportH >= 1000 ? 40 : viewportH >= 820 ? 36 : 32);

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
  if (y < SECTION_ROW_H + BAR_ROW_H) return { type: "bars" };
  if (y < L.spY) return { type: "note", lane: Math.max(0, Math.min(4, Math.floor((y - L.rulerH) / L.laneH))) };
  if (y < L.soloY) return { type: "sp" };
  return { type: "solo" };
}

// The picked areas as a drag in progress would leave them, or null when no
// drag is changing them. `active` is the area being moved or stretched and
// `origin` where a moved one started; the roll and the song strip draw both.
function selectionPreview(drag, bars, regions) {
  if (drag?.kind === "selectionResize") {
    return {
      regions: resizeRegion(bars, regions, drag.index, drag.edge, drag.curTick),
      active: resizedSpan(bars, regions[drag.index], drag.edge, drag.curTick),
      origin: null,
    };
  }
  if (drag?.kind === "selectionMove" && drag.moved) {
    const delta = barIndexAt(bars, drag.curTick) - barIndexAt(bars, drag.startTick);
    return {
      regions: moveRegion(bars, regions, drag.index, delta),
      active: shiftSpan(bars, regions[drag.index], delta),
      origin: regions[drag.index],
    };
  }
  if (drag?.kind === "paint" && drag.moved) {
    return { regions: paintRegions(bars, regions, drag.anchorTick, drag.curTick, drag.erase), active: null, origin: null };
  }
  return null;
}

function laneCenterY(L, lane) {
  return L.rulerH + lane * L.laneH + L.laneH / 2;
}

export default function PianoRollEditor({
  project,
  mode = "edit",
  bars = [],
  sections = [],
  regions = [],
  onPickSection,
  onBoxSelect,
  onClearSelection,
  onSetSelection,
  onPreviewSelection,
  songEndTick = 0,
  pending = null,
  loop = null,
  apiRef,
  onViewChange,
}) {
  const { editor, applyEditorChange, requestEditorSeek } = project;
  const doc = editor.doc;
  const [pxPerBeat, setPxPerBeat] = useState(56);
  const [layout, setLayout] = useState(() => layoutFor(laneHeightFor(window.innerHeight)));

  const rootRef = useRef(null);
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const scrollLeftRef = useRef(0);
  const dragRef = useRef(null);
  const hoverRef = useRef(null);
  const rafRef = useRef(0);

  // Fresh-prop refs so the once-bound pointer handlers never read stale state.
  const docRef = useRef(doc);
  const editorRef = useRef(editor);
  const pxPerBeatRef = useRef(pxPerBeat);
  const layoutRef = useRef(layout);
  const viewRef = useRef({ mode, bars, sections, regions, pending, loop, songEnd: 0 });
  docRef.current = doc;
  editorRef.current = editor;
  pxPerBeatRef.current = pxPerBeat;
  layoutRef.current = layout;
  viewRef.current = { mode, bars, sections, regions, pending, loop, songEnd: songEndBarTick(bars, songEndTick) };

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

  // Where each picked area's "to the end" arrow sits (canvas x). An area that
  // already reaches the end, or has a neighbour too close behind it, has none.
  function extendChips() {
    const view = viewRef.current;
    const activeDoc = docRef.current;
    if (view.mode !== "regen" || !activeDoc) return [];
    const ppt = pxPerBeatRef.current / (activeDoc.resolution || 192);
    const toX = (tick) => tick * ppt - scrollLeftRef.current;
    const out = [];
    view.regions.forEach((region, index) => {
      if (region.endTick >= view.songEnd) return;
      const x = toX(region.endTick) + EXTEND_GAP;
      const next = view.regions[index + 1];
      if (next && toX(next.startTick) < x + EXTEND_W + 6) return;
      out.push({ index, x });
    });
    return out;
  }

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
    // Note selection belongs to the Edit tab; Regenerate doesn't show it.
    const sel = new Set(view.mode === "edit" ? editorRef.current.selectedNoteIds : []);
    const rangeSel = new Set(view.mode === "edit" ? editorRef.current.selectedRangeIds : []);
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
      const y = L.rulerH + lane * L.laneH;
      ctx.fillStyle = lane % 2 === 0
        ? (dark ? "rgba(255,255,255,0.018)" : "rgba(255,255,255,0.22)")
        : (dark ? "rgba(255,255,255,0.045)" : "rgba(74,69,133,0.035)");
      ctx.fillRect(0, y, viewW, L.laneH);
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
        ctx.moveTo(x, L.rulerH);
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
      ctx.moveTo(x, L.rulerH);
      ctx.lineTo(x, editorH);
    }
    ctx.stroke();

    // Redo regions: selected (solid purple) and in-flight (sweeping).
    const drawRegionBand = (region, fill, edge) => {
      const x = tickToX(region.startTick);
      const w = (region.endTick - region.startTick) * ppt;
      if (x > viewW || x + w < 0) return;
      ctx.fillStyle = fill;
      ctx.fillRect(x, L.rulerH, w, L.noteAreaH);
      ctx.fillStyle = edge;
      ctx.fillRect(x, L.rulerH, 2, L.noteAreaH);
      ctx.fillRect(x + w - 2, L.rulerH, 2, L.noteAreaH);
    };
    const preview = selectionPreview(drag, view.bars, view.regions);
    const shownRegions = preview?.regions || view.regions;
    // While an area is being moved or stretched it turns a lighter lilac,
    // and a dashed outline stays where a moved one started.
    const lifted = mixWithWhite(purpleBri, 0.4);
    const isLifted = (region) => Boolean(preview?.active && regionsOverlap(region, preview.active));
    for (const region of shownRegions) {
      if (isLifted(region)) drawRegionBand(region, alpha(lifted, dark ? 0.34 : 0.3), lifted);
      else drawRegionBand(region, alpha(purpleBri, dark ? 0.24 : 0.14), alpha(purpleBri, 0.9));
    }
    const drawOrigin = (top, height) => {
      if (!preview?.origin) return;
      const x = tickToX(preview.origin.startTick);
      const w = (preview.origin.endTick - preview.origin.startTick) * ppt;
      ctx.strokeStyle = alpha(purpleBri, 0.85);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(Math.round(x) + 1.5, top + 1.5, Math.round(w) - 3, height - 3);
      ctx.setLineDash([]);
    };
    drawOrigin(L.rulerH, L.noteAreaH);
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
        ctx.fillRect(Math.max(x, sweep - 60), L.rulerH, Math.min(120, x + w - Math.max(x, sweep - 60)), L.noteAreaH);
      }
    }
    // What a paint stroke (or a click, on hover) would add or remove.
    const eraseRed = "#e5484d";
    const drawPaintHint = (span, erase) => {
      const x = tickToX(span.startTick);
      const w = (span.endTick - span.startTick) * ppt;
      if (x > viewW || x + w < 0) return;
      ctx.fillStyle = erase ? alpha(eraseRed, dark ? 0.2 : 0.14) : alpha(purpleBri, dark ? 0.14 : 0.1);
      ctx.fillRect(x, L.rulerH, w, L.noteAreaH);
      if (w < 18) return;
      const cx = x + w / 2;
      const cy = L.rulerH + 12;
      ctx.fillStyle = erase ? eraseRed : purpleBri;
      ctx.beginPath();
      ctx.arc(cx, cy, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillRect(cx - 4, cy - 1, 8, 2);
      if (!erase) ctx.fillRect(cx - 1, cy - 4, 2, 8);
    };
    if (drag?.kind === "paint" && drag.erase && drag.moved) {
      drawPaintHint(snapSpanToBars(view.bars, drag.anchorTick, drag.curTick), true);
    } else if (!drag && hoverRef.current?.paint) {
      drawPaintHint(hoverRef.current.paint, hoverRef.current.paint.erase);
    }

    // Range bands (star power / solo) drawn behind notes plus on their lanes.
    const drawRange = (range, color, laneY, laneH) => {
      const x = tickToX(range.startTick);
      const w = (range.endTick - range.startTick) * ppt;
      const selected = rangeSel.has(range.id);
      const visibleW = Math.max(1, w);
      ctx.fillStyle = alpha(color, dark ? 0.12 : 0.09);
      ctx.fillRect(x, L.rulerH, w, L.noteAreaH);
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
        // A slim bar across all five lanes, like the open-note bar in game.
        const sustain = sustainFor(note, "open");
        const barW = Math.max(6, Math.round(L.noteW * 0.5));
        if (sustain > 0) {
          ctx.fillStyle = alpha(OPEN_COLOR, 0.22);
          drawRoundRect(ctx, headX, L.rulerH + 4, sustain * ppt, L.noteAreaH - 8, 4);
        }
        ctx.fillStyle = alpha(OPEN_COLOR, 0.9);
        ctx.strokeStyle = selected ? "#fff" : "rgba(0,0,0,0.3)";
        ctx.lineWidth = selected ? 2.5 : 1;
        drawRoundRect(ctx, headX - barW / 2, L.rulerH + 4, barW, L.noteAreaH - 8, barW / 2);
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

    // Ghost note under the pointer: where a click would add one.
    const hover = hoverRef.current;
    if (!drag && hover?.ghost) {
      const x = tickToX(hover.ghost.tick);
      const cy = laneCenterY(L, hover.ghost.lane);
      ctx.globalAlpha = 0.38;
      drawNoteHead(x, cy, LANE_COLORS[hover.ghost.lane], false, false, false);
      ctx.globalAlpha = 1;
    }
    // Stretch handle on the hovered note's right end.
    if (!drag && hover?.handle) {
      const { x, cy } = hover.handle;
      ctx.fillStyle = dark ? "#ffffff" : "#2b2f4d";
      drawRoundRect(ctx, x - 2, cy - L.headH / 2 + 3, 4, L.headH - 6, 2);
    }

    // Pending range preview.
    if (drag?.kind === "range") {
      const x = tickToX(Math.min(drag.startTick, drag.curTick));
      const w = Math.abs(drag.curTick - drag.startTick) * ppt;
      ctx.fillStyle = alpha(drag.kind2 === "solo" ? SOLO_COLOR : SP_COLOR, 0.24);
      ctx.fillRect(x, L.rulerH, w, L.noteAreaH);
    }

    // Pending box-select preview.
    if (drag?.kind === "boxSelect") {
      const x = Math.min(drag.startX, drag.curX);
      const y = Math.max(L.rulerH, Math.min(drag.startY, drag.curY));
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
    ctx.fillRect(0, 0, viewW, L.rulerH);
    ctx.strokeStyle = alpha(border, 0.55);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, L.rulerH - 0.5);
    ctx.lineTo(viewW, L.rulerH - 0.5);
    ctx.moveTo(0, SECTION_ROW_H + BAR_ROW_H - 0.5);
    ctx.lineTo(viewW, SECTION_ROW_H + BAR_ROW_H - 0.5);
    ctx.stroke();

    // Redone spans get an orange edge along the top of the lanes (faint
    // while showing the original). Takes are switched from the side panel.
    for (const redo of activeDoc.redos || []) {
      for (const region of redo.regions) {
        const x = tickToX(region.startTick);
        const w = (region.endTick - region.startTick) * ppt;
        if (x > viewW || x + w < 0) continue;
        ctx.fillStyle = alpha(orange, redo.active < 0 ? 0.35 : 0.95);
        ctx.fillRect(x, L.rulerH, w, 4);
      }
    }

    ctx.font = "700 11px Inter, system-ui, sans-serif";
    for (const section of view.sections) {
      const x1 = tickToX(section.startTick);
      const x2 = tickToX(section.endTick);
      if (x2 < 0 || x1 > viewW) continue;
      const selected = regionsCover(shownRegions, section);
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
    drawOrigin(SECTION_ROW_H, BAR_ROW_H);
    for (const region of shownRegions) {
      const x = tickToX(region.startTick);
      const w = (region.endTick - region.startTick) * ppt;
      ctx.fillStyle = isLifted(region) ? lifted : alpha(purpleBri, 0.9);
      drawRoundRect(ctx, x + 1, SECTION_ROW_H + 2, Math.max(2, w - 2), BAR_ROW_H - 4, 6);
    }
    view.bars.forEach((barTick, index) => {
      if (index % every) return;
      const x = tickToX(barTick);
      if (x < -40 || x > viewW + 4) return;
      const selected = shownRegions.some((r) => barTick >= r.startTick && barTick < r.endTick);
      const onLifted = selected && preview?.active && barTick >= preview.active.startTick && barTick < preview.active.endTick;
      ctx.fillStyle = onLifted ? "#2b2f4d" : selected ? "#fff" : textDim;
      ctx.fillText(String(index + 1), x + 4, SECTION_ROW_H + 15);
    });

    // Loop bracket along the bottom of the bar row.
    if (view.loop) {
      const x1 = tickToX(view.loop.startTick);
      const x2 = tickToX(view.loop.endTick);
      ctx.fillStyle = orange;
      ctx.fillRect(x1, SECTION_ROW_H + BAR_ROW_H - 3, x2 - x1, 3);
      ctx.fillRect(x1, SECTION_ROW_H + 4, 2, BAR_ROW_H - 4);
      ctx.fillRect(x2 - 2, SECTION_ROW_H + 4, 2, BAR_ROW_H - 4);
    }

    // Grips on the selection's ends in the bar row, where nothing covers
    // them: drag one to stretch the span, drag the span itself to move it.
    for (const region of shownRegions) {
      for (const edgeTick of [region.startTick, region.endTick]) {
        const ex = tickToX(edgeTick);
        if (ex < -10 || ex > viewW + 10) continue;
        ctx.fillStyle = "#fff";
        drawRoundRect(ctx, ex - 4, SECTION_ROW_H + 1, 8, BAR_ROW_H - 2, 4);
        ctx.strokeStyle = purpleBri;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = purpleBri;
        ctx.fillRect(ex - 1, SECTION_ROW_H + 6, 2, BAR_ROW_H - 12);
      }
    }

    // "To the end" arrows. Hovering one outlines what it would add.
    if (!drag) {
      const hoverExtend = hoverRef.current?.extend;
      extendChips().forEach(({ index, x }) => {
        const on = hoverExtend === index;
        if (on) {
          const from = tickToX(view.regions[index].endTick);
          const to = tickToX(view.songEnd);
          ctx.fillStyle = alpha(purpleBri, dark ? 0.12 : 0.08);
          ctx.fillRect(from, L.rulerH, to - from, L.noteAreaH);
          ctx.strokeStyle = alpha(purpleBri, 0.9);
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 4]);
          ctx.strokeRect(Math.round(from) + 0.5, SECTION_ROW_H + 2.5, Math.round(to - from) - 1, L.rulerH - SECTION_ROW_H + L.noteAreaH - 4);
          ctx.setLineDash([]);
        }
        ctx.fillStyle = on ? purpleBri : surface;
        drawRoundRect(ctx, x, SECTION_ROW_H + 2, EXTEND_W, BAR_ROW_H - 4, 6);
        ctx.strokeStyle = purpleBri;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        const cy = SECTION_ROW_H + BAR_ROW_H / 2;
        const cx = x + EXTEND_W / 2;
        ctx.strokeStyle = on ? "#fff" : purpleBri;
        ctx.lineWidth = 2;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(cx - 6, cy);
        ctx.lineTo(cx + 2, cy);
        ctx.moveTo(cx - 1, cy - 3.5);
        ctx.lineTo(cx + 2.5, cy);
        ctx.lineTo(cx - 1, cy + 3.5);
        ctx.moveTo(cx + 5.5, cy - 5);
        ctx.lineTo(cx + 5.5, cy + 5);
        ctx.stroke();
        ctx.lineCap = "butt";
      });
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
  }, [doc, editor.revision, editor.selectedNoteIds, editor.selectedRangeIds, editor.playhead, editor.snap, pxPerBeat, layout, mode, bars, sections, regions, pending, loop, scheduleDraw]);

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
      const laneH = laneHeightFor(window.innerHeight);
      setLayout((prev) => (prev.laneH === laneH ? prev : layoutFor(laneH)));
      scheduleDraw();
      reportView();
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [scheduleDraw, reportView]);

  // Open at a zoom that fits about eight bars of 4/4 across the roll.
  const fittedRef = useRef(false);
  useEffect(() => {
    const container = containerRef.current;
    if (fittedRef.current || !container?.clientWidth) return;
    fittedRef.current = true;
    setPxPerBeat(Math.max(32, Math.min(72, Math.round(container.clientWidth / 32))));
  });

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
        const sustain = note.open ? note.sustainsByLane.open || 0 : note.sustainsByLane[lane] || 0;
        const tailEndX = (note.tick + sustain) * ppt - scrollLeftRef.current;
        const endX = Math.max(headX + L.noteW / 2, tailEndX);
        // The note's right end is the stretch handle, sustain or not.
        if (localX >= endX - 3 && localX <= endX + SUSTAIN_GRAB) return { note, part: "tail", lane, endX, cy };
        if (Math.abs(localX - headX) <= L.noteW / 2 + 2) return { note, part: "head", lane };
        if (sustain > 0 && localX > headX && localX <= tailEndX + 4) return { note, part: "tail", lane, endX, cy };
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
    const top = Math.max(L.rulerH, Math.min(drag.startY, drag.curY));
    const bottom = Math.min(L.spY, Math.max(drag.startY, drag.curY));
    if (right - left < BOX_SELECT_MIN_DRAG || bottom - top < BOX_SELECT_MIN_DRAG) return [];

    const tickToX = (tick) => tick * ppt - scrollLeftRef.current;
    const ids = [];
    for (const note of activeDoc.notes) {
      const x = tickToX(note.tick);
      if (x + L.noteW / 2 < left || x - L.noteW / 2 > right) continue;
      if (note.open) {
        if (bottom >= L.rulerH && top <= L.spY) ids.push(note.id);
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

  // Grip of a selected span under the pointer (in the bar row); dragging it
  // stretches or shrinks the span to another bar line.
  const selectionEdgeAt = (x) => {
    const ppt = pxPerBeatRef.current / (docRef.current?.resolution || 192);
    const list = viewRef.current.regions;
    for (let index = 0; index < list.length; index += 1) {
      for (const edge of ["start", "end"]) {
        const edgeTick = edge === "start" ? list[index].startTick : list[index].endTick;
        if (Math.abs(x - (edgeTick * ppt - scrollLeftRef.current)) <= SELECTION_GRAB) return { index, edge };
      }
    }
    return null;
  };

  // Selected span under the pointer, by index.
  const selectionBodyAt = (x) => {
    const tick = xToTick(x);
    const index = viewRef.current.regions.findIndex((r) => tick >= r.startTick && tick < r.endTick);
    return index < 0 ? null : index;
  };

  // Hover feedback: a ghost note where a click would add one (only when
  // nothing is selected, since that click deselects instead), a stretch
  // handle on note ends, and a cursor that says what a drag would do.
  const updateHover = (x, y) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const region = regionAtY(layoutRef.current, y);
    let next = null;
    let cursor = "default";
    const regen = viewRef.current.mode === "regen";
    const chip = regen && region.type === "bars" ? extendChips().find((c) => x >= c.x && x <= c.x + EXTEND_W) : null;
    if (chip) {
      next = { extend: chip.index };
      cursor = "pointer";
    } else if (region.type === "bars") {
      cursor = regen && selectionEdgeAt(x) ? "ew-resize" : regen && selectionBodyAt(x) != null ? "grab" : "pointer";
    } else if (regen && region.type !== "sections") {
      if (selectionEdgeAt(x)) {
        cursor = "ew-resize";
      } else {
        const tick = xToTick(x);
        const bar = snapSpanToBars(viewRef.current.bars, tick, tick + 1);
        next = { paint: { ...bar, erase: regionsCover(viewRef.current.regions, bar) } };
        cursor = "crosshair";
      }
    } else if (region.type === "note") {
      const hit = hitTest(x, y);
      if (hit?.part === "tail") {
        next = { handle: { x: hit.endX, cy: hit.cy } };
        cursor = "ew-resize";
      } else if (hit?.note) {
        cursor = "grab";
      } else {
        const ed = editorRef.current;
        const view = viewRef.current;
        if (!ed.selectedNoteIds.length && !ed.selectedRangeIds.length && !view.regions.length && !view.pending) {
          next = { ghost: { tick: snapTick(xToTick(x)), lane: region.lane } };
          cursor = "pointer";
        }
      }
    } else if (region.type === "sections") {
      cursor = "pointer";
    } else if (region.type === "sp" || region.type === "solo") {
      const hit = hitTest(x, y);
      cursor = hit?.range ? (hit.part === "body" ? "grab" : "ew-resize") : "copy";
    }
    canvas.style.cursor = cursor;
    const prev = hoverRef.current;
    const same = prev?.ghost && next?.ghost
      ? prev.ghost.tick === next.ghost.tick && prev.ghost.lane === next.ghost.lane
      : prev?.handle && next?.handle
        ? prev.handle.x === next.handle.x && prev.handle.cy === next.handle.cy
        : prev?.paint && next?.paint
          ? prev.paint.startTick === next.paint.startTick && prev.paint.erase === next.paint.erase
          : prev?.extend != null && next?.extend != null
            ? prev.extend === next.extend
            : !prev && !next;
    if (!same) {
      hoverRef.current = next;
      scheduleDraw();
    }
  };

  const onPointerLeave = () => {
    if (!hoverRef.current) return;
    hoverRef.current = null;
    scheduleDraw();
  };

  const onPointerDown = (e) => {
    if (!doc || (e.button !== 0 && e.button !== 2)) return;
    canvasRef.current.setPointerCapture(e.pointerId);
    hoverRef.current = null;
    const { x, y } = toLocal(e);
    const region = regionAtY(layoutRef.current, y);
    const tick = xToTick(x);
    const erasing = e.button === 2;
    const regen = mode === "regen";

    if (erasing && regen && region.type !== "sections") {
      dragRef.current = { kind: "paint", erase: true, anchorTick: tick, curTick: tick, startX: x, moved: false, clickToggles: true };
      return;
    }
    if (erasing && (regen || region.type === "sections" || region.type === "bars")) {
      dragRef.current = { kind: "noop" };
      return;
    }

    if (region.type === "sections") {
      const section = sections.find((s) => tick >= s.startTick && tick < s.endTick);
      if (section) {
        onPickSection?.(section);
      } else {
        requestEditorSeek(timeAtTick(tick));
      }
      dragRef.current = { kind: "noop" };
      return;
    }

    if (!regen && region.type === "bars") {
      dragRef.current = { kind: "seek", tick };
      return;
    }

    // Regenerate tab: grips stretch the selection anywhere; the bar-row block
    // moves it; any other drag (or click) below the ruler picks bars.
    if (regen && region.type !== "bars") {
      const edge = selectionEdgeAt(x);
      if (edge) {
        dragRef.current = { kind: "selectionResize", ...edge, curTick: edge.edge === "start" ? regions[edge.index].startTick : regions[edge.index].endTick };
        scheduleDraw();
        return;
      }
      const erase = regionsCover(regions, snapSpanToBars(bars, tick, tick + 1));
      dragRef.current = { kind: "paint", erase, anchorTick: tick, curTick: tick, startX: x, moved: false, clickToggles: true };
      scheduleDraw();
      return;
    }

    if (region.type === "bars") {
      const chip = extendChips().find((c) => x >= c.x && x <= c.x + EXTEND_W);
      if (chip) {
        onSetSelection?.(extendToEnd(bars, regions, songEndTick, chip.index));
        dragRef.current = { kind: "noop" };
        return;
      }
      const edge = selectionEdgeAt(x);
      if (edge) {
        dragRef.current = { kind: "selectionResize", ...edge, curTick: edge.edge === "start" ? regions[edge.index].startTick : regions[edge.index].endTick };
        scheduleDraw();
        return;
      }
      const index = selectionBodyAt(x);
      if (index != null) {
        dragRef.current = { kind: "selectionMove", index, startTick: tick, curTick: tick, startX: x, moved: false };
        canvasRef.current.style.cursor = "grabbing";
        return;
      }
      dragRef.current = { kind: "paint", erase: false, anchorTick: tick, curTick: tick, startX: x, moved: false };
      return;
    }

    const hit = hitTest(x, y);

    // Right button erases whatever the pointer sweeps over.
    if (erasing) {
      const drag = newEraseDrag(x, y);
      markErasePath(drag, x, y);
      dragRef.current = drag;
      return;
    }

    // Range strips: create / resize / move / select.
    if (region.type === "sp" || region.type === "solo") {
      const kind = region.type === "sp" ? "starPower" : "solo";
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
    // Empty space: becomes a box select once dragged, otherwise a click
    // (add a note, or deselect if something is selected).
    dragRef.current = { kind: "emptyPress", startX: x, startY: y, curX: x, curY: y, additive: e.shiftKey, tick: snapTick(tick), lane: region.lane };
    scheduleDraw();
  };

  // Tells the screen how a drag would leave the picked areas, so the song
  // strip follows it live. Only sent when the result changes bar-wise.
  const previewKeyRef = useRef("");
  const reportPreview = (drag) => {
    const next = selectionPreview(drag, bars, regions);
    const key = next ? JSON.stringify(next) : "";
    if (key === previewKeyRef.current) return;
    previewKeyRef.current = key;
    onPreviewSelection?.(next);
  };

  const onPointerMove = (e) => {
    const drag = dragRef.current;
    const { x, y } = toLocal(e);
    if (!drag) {
      updateHover(x, y);
      return;
    }
    const tick = xToTick(x);
    if (drag.kind === "emptyPress") {
      if (Math.hypot(x - drag.startX, y - drag.startY) < BOX_SELECT_MIN_DRAG) return;
      drag.kind = "boxSelect";
      drag.moved = true;
    }
    if (drag.kind === "selectionResize") {
      drag.curTick = nearestBarLine(bars, tick);
      reportPreview(drag);
      scheduleDraw();
      return;
    }
    if (drag.kind === "selectionMove" || drag.kind === "paint") {
      drag.curTick = tick;
      drag.moved = drag.moved || Math.abs(x - drag.startX) >= REGION_MIN_DRAG;
      reportPreview(drag);
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
    reportPreview(null);
    try {
      canvasRef.current.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    if (drag.kind === "selectionResize") {
      onSetSelection?.(resizeRegion(bars, regions, drag.index, drag.edge, drag.curTick));
    } else if (drag.kind === "selectionMove") {
      canvasRef.current.style.cursor = "grab";
      if (drag.moved) onSetSelection?.(moveRegion(bars, regions, drag.index, barIndexAt(bars, drag.curTick) - barIndexAt(bars, drag.startTick)));
      else requestEditorSeek(timeAtTick(drag.startTick));
    } else if (drag.kind === "paint") {
      if (drag.moved || drag.clickToggles) {
        onSetSelection?.(paintRegions(bars, regions, drag.anchorTick, drag.curTick, drag.erase));
      } else {
        requestEditorSeek(timeAtTick(drag.anchorTick));
      }
    } else if (drag.kind === "seek") {
      requestEditorSeek(timeAtTick(drag.tick));
    } else if (drag.kind === "move" && drag.moved && (drag.deltaTick || drag.deltaLane)) {
      applyEditorChange({ type: "moveNotes", ids: drag.ids, deltaTick: drag.deltaTick, deltaLane: drag.deltaLane });
    } else if (drag.kind === "sustain") {
      applyEditorChange({ type: "setSustain", id: drag.noteId, sustain: drag.sustain });
    } else if (drag.kind === "emptyPress") {
      const ed = editorRef.current;
      if (ed.selectedNoteIds.length || ed.selectedRangeIds.length || regions.length) {
        onClearSelection?.();
      } else {
        applyEditorChange({ type: "addNote", tick: drag.tick, lane: drag.lane, sustain: 0 });
      }
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
      if (moved) onBoxSelect?.(noteIdsInBox(drag), drag.additive);
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

  return (
    <div className="piano-roll" ref={rootRef}>
      <div className="piano-roll-side" aria-hidden="true">
        <div className="pr-ruler-spacer" style={{ height: layout.rulerH }} />
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
            onPointerLeave={onPointerLeave}
            onContextMenu={(e) => e.preventDefault()}
          />
        </div>
      </div>
    </div>
  );
}

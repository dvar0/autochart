import { useCallback, useEffect, useRef, useState } from "react";
import { I } from "../../../icons.jsx";
import { FRET_COLORS, OPEN_NOTE_COLOR } from "../../../data/notePalette.js";
import { snapTicks } from "./chartEditor.js";

// Canvas-based piano roll. The editor doc (ticks) is the source of truth; this
// component renders a virtualized horizontal timeline and translates pointer
// gestures into committed reducer actions (one per gesture). Live drag state is
// kept in a ref and drawn directly, so pointermove never spams the reducer.

const RULER_H = 28;
const LANE_H = 35;
const SP_H = 22;
const SOLO_H = 22;
const SCROLLBAR_H = 15;
const NOTE_W = 16;
const NOTE_AREA_H = LANE_H * 5;
const SP_Y = RULER_H + NOTE_AREA_H;
const SOLO_Y = SP_Y + SP_H;
const TOTAL_H = SOLO_Y + SOLO_H + SCROLLBAR_H;
const EDGE_GRAB = 5;
const BOX_SELECT_MIN_DRAG = 3;

const LANE_COLORS = FRET_COLORS;
const OPEN_COLOR = OPEN_NOTE_COLOR;
const SP_COLOR = "#36c5f0";
const SOLO_COLOR = "#9a6bff";
const FORCE_OUTLINE = "rgba(255,255,255,0.96)";

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

function regionAtY(y) {
  if (y < RULER_H) return { type: "ruler" };
  if (y < SP_Y) return { type: "note", lane: Math.max(0, Math.min(4, Math.floor((y - RULER_H) / LANE_H))) };
  if (y < SOLO_Y) return { type: "sp" };
  return { type: "solo" };
}

function laneCenterY(lane) {
  return RULER_H + lane * LANE_H + LANE_H / 2;
}

function flagIsActive(note, flag) {
  return flag === "tap" ? note.tap : note.force && !note.tap;
}

function noteNeedsFlagPaint(note, flag, enabled) {
  if (flag === "tap") return note.tap !== enabled || (enabled && note.force);
  if (flag === "force") return note.force !== enabled || (enabled && note.tap);
  return false;
}

function applyFlagPreview(note, drag) {
  if (!drag?.ids?.has(note.id)) return { tap: note.tap, force: note.force };
  if (drag.flag === "tap") return { tap: drag.enabled, force: drag.enabled ? false : note.force };
  return { tap: drag.enabled ? false : note.tap, force: drag.enabled };
}

export default function PianoRollEditor({ project }) {
  const { editor, applyEditorChange, requestEditorSeek, requestEditorPlayToggle } = project;
  const doc = editor.doc;
  const [pxPerBeat, setPxPerBeat] = useState(56);

  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const scrollLeftRef = useRef(0);
  const dragRef = useRef(null);
  const rafRef = useRef(0);
  const actionsRef = useRef({
    applyEditorChange,
    requestEditorPlayToggle,
    undoEditorChange: project.undoEditorChange,
    redoEditorChange: project.redoEditorChange,
  });

  // Fresh-prop refs so the once-bound pointer handlers never read stale state.
  const docRef = useRef(doc);
  const editorRef = useRef(editor);
  const pxPerBeatRef = useRef(pxPerBeat);
  docRef.current = doc;
  editorRef.current = editor;
  pxPerBeatRef.current = pxPerBeat;
  actionsRef.current = {
    applyEditorChange,
    requestEditorPlayToggle,
    undoEditorChange: project.undoEditorChange,
    redoEditorChange: project.redoEditorChange,
  };

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
    const scrollLeft = scrollLeftRef.current;
    const ppt = pxPerBeatRef.current / (activeDoc.resolution || 192);
    const viewW = container.clientWidth || 1;
    const editorH = TOTAL_H - SCROLLBAR_H;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewW * dpr);
    canvas.height = Math.floor(TOTAL_H * dpr);
    canvas.style.width = `${viewW}px`;
    canvas.style.height = `${TOTAL_H}px`;
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
    const orange = vars.getPropertyValue("--orange").trim() || "#ea76cb";

    const tickToX = (tick) => tick * ppt - scrollLeft;
    const startTick = scrollLeft / ppt;
    const endTick = (scrollLeft + viewW) / ppt;
    const sel = new Set(editorRef.current.selectedNoteIds);
    const rangeSel = new Set(editorRef.current.selectedRangeIds);
    const drag = dragRef.current;

    ctx.clearRect(0, 0, viewW, TOTAL_H);

    const bgGrad = ctx.createLinearGradient(0, 0, 0, editorH);
    bgGrad.addColorStop(0, dark ? "#252d40" : surface);
    bgGrad.addColorStop(1, surface2);
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, viewW, editorH);

    // Lane backgrounds.
    for (let lane = 0; lane < 5; lane += 1) {
      const y = RULER_H + lane * LANE_H;
      ctx.fillStyle = lane % 2 === 0
        ? (dark ? "rgba(255,255,255,0.018)" : "rgba(255,255,255,0.22)")
        : (dark ? "rgba(255,255,255,0.045)" : "rgba(74,69,133,0.035)");
      ctx.fillRect(0, y, viewW, LANE_H);
      const wash = ctx.createLinearGradient(0, 0, 74, 0);
      wash.addColorStop(0, alpha(LANE_COLORS[lane], dark ? 0.23 : 0.18));
      wash.addColorStop(1, alpha(LANE_COLORS[lane], 0));
      ctx.fillStyle = wash;
      ctx.fillRect(0, y, 96, LANE_H);
      ctx.fillStyle = alpha(LANE_COLORS[lane], dark ? 0.78 : 0.64);
      drawRoundRect(ctx, 7, y + 8, 4, LANE_H - 16, 4);
      ctx.strokeStyle = alpha(borderSoft, dark ? 0.6 : 0.75);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + LANE_H - 0.5);
      ctx.lineTo(viewW, y + LANE_H - 0.5);
      ctx.stroke();
    }

    // The horizontal scrollbar lives in this footer band, so it never covers
    // the solo strip at the bottom of the editable lanes.
    ctx.fillStyle = dark ? "rgba(20,22,34,0.72)" : "rgba(241,243,251,0.92)";
    ctx.fillRect(0, editorH, viewW, SCROLLBAR_H);

    // Grid lines (snap subdivisions, beats, bars).
    const snapStep = snapTicks(activeDoc.resolution, editorRef.current.snap);
    const drawGridLines = (step, color, width) => {
      if (!step) return;
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
    drawGridLines(activeDoc.resolution * 4, alpha(purple, dark ? 0.42 : 0.28), 1.5);

    // Range bands (star power / solo) drawn behind notes plus on their lanes.
    const drawRange = (range, color, laneY, laneH) => {
      const x = tickToX(range.startTick);
      const w = (range.endTick - range.startTick) * ppt;
      const selected = rangeSel.has(range.id);
      const visibleW = Math.max(1, w);
      ctx.fillStyle = alpha(color, dark ? 0.12 : 0.09);
      ctx.fillRect(x, RULER_H, w, NOTE_AREA_H);
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
      if (drawData.kind === "starPower") drawRange(drawData, SP_COLOR, SP_Y, SP_H);
      else drawRange(drawData, SOLO_COLOR, SOLO_Y, SOLO_H);
    }

    // Notes (with live drag transform applied).
    const moveDelta = drag?.kind === "move" ? { tick: drag.deltaTick, lane: drag.deltaLane } : null;
    const sustainOverride = drag?.kind === "sustain" ? { id: drag.noteId, sustain: drag.sustain } : null;
    const eraseOverride = drag?.kind === "erase" ? drag : null;
    const flagPaintOverride = drag?.kind === "flagPaint" ? drag : null;
    const drawNoteHead = (x, y, color, selected, tap, force) => {
      const h = LANE_H - 12;
      const top = y - h / 2;
      const fillColor = force && !tap ? mixWithWhite(color, 0.38) : color;
      const tapOutline = dark ? "#8af3ff" : "#0f92b3";
      const grad = ctx.createLinearGradient(0, top, 0, top + h);
      grad.addColorStop(0, alpha(fillColor, tap ? 0.68 : 0.98));
      grad.addColorStop(1, alpha(fillColor, tap ? 0.38 : 0.72));
      ctx.fillStyle = grad;
      drawRoundRect(ctx, x - NOTE_W / 2, top, NOTE_W, h, 5);
      ctx.strokeStyle = selected ? "#ffffff" : tap ? tapOutline : force ? FORCE_OUTLINE : "rgba(0,0,0,0.28)";
      ctx.lineWidth = selected ? 2.5 : tap || force ? 2.2 : 1;
      ctx.stroke();
      ctx.fillStyle = tap ? "rgba(255,255,255,0.12)" : force ? "rgba(255,255,255,0.34)" : "rgba(255,255,255,0.22)";
      drawRoundRect(ctx, x - NOTE_W / 2 + 3, top + 3, NOTE_W - 6, 3, 3);
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
    for (const note of activeDoc.notes) {
      if (eraseOverride?.noteIds?.has(note.id)) continue;
      const moved = moveDelta && sel.has(note.id);
      const baseTick = note.tick + (moved ? moveDelta.tick : 0);
      const headX = tickToX(baseTick);
      if (headX < -200 || headX > viewW + 200) continue;
      const selected = sel.has(note.id);
      if (note.open) {
        const sustain = sustainFor(note, "open");
        if (sustain > 0) {
          ctx.fillStyle = alpha(OPEN_COLOR, 0.32);
          drawRoundRect(ctx, headX, RULER_H + 8, sustain * ppt, NOTE_AREA_H - 16, 5);
        }
        ctx.fillStyle = OPEN_COLOR;
        ctx.strokeStyle = selected ? "#fff" : "rgba(0,0,0,0.35)";
        ctx.lineWidth = selected ? 2.5 : 1;
        drawRoundRect(ctx, headX - NOTE_W / 2, RULER_H + 8, NOTE_W, NOTE_AREA_H - 16, 5);
        ctx.strokeRect(headX - NOTE_W / 2, RULER_H + 8, NOTE_W, NOTE_AREA_H - 16);
        continue;
      }
      for (const lane of note.lanes) {
        const flags = applyFlagPreview(note, flagPaintOverride);
        const drawLane = moved ? Math.max(0, Math.min(4, lane + moveDelta.lane)) : lane;
        const cy = laneCenterY(drawLane);
        const sustain = sustainFor(note, lane);
        if (sustain > 0) {
          const tailGrad = ctx.createLinearGradient(headX, 0, headX + sustain * ppt, 0);
          tailGrad.addColorStop(0, alpha(LANE_COLORS[drawLane], 0.58));
          tailGrad.addColorStop(1, alpha(LANE_COLORS[drawLane], 0.24));
          ctx.fillStyle = tailGrad;
          drawRoundRect(ctx, headX, cy - 4, sustain * ppt, 8, 4);
        }
        drawNoteHead(headX, cy, note.star ? SP_COLOR : LANE_COLORS[drawLane], selected, flags.tap, flags.force);
      }
    }

    // Pending draw-note preview.
    if (drag?.kind === "drawNote") {
      const x = tickToX(drag.tick);
      if (drag.lane === "open") {
        ctx.fillStyle = alpha(OPEN_COLOR, 0.55);
        drawRoundRect(ctx, x - NOTE_W / 2, RULER_H + 8, NOTE_W, NOTE_AREA_H - 16, 5);
        if (drag.sustain > 0) drawRoundRect(ctx, x, RULER_H + 8, drag.sustain * ppt, NOTE_AREA_H - 16, 5);
      } else {
        const cy = laneCenterY(drag.lane);
        if (drag.sustain > 0) {
          ctx.fillStyle = LANE_COLORS[drag.lane];
          ctx.globalAlpha = 0.45;
          drawRoundRect(ctx, x, cy - 4, drag.sustain * ppt, 8, 4);
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
      ctx.fillRect(x, RULER_H, w, NOTE_AREA_H);
    }

    // Pending box-select preview.
    if (drag?.kind === "boxSelect") {
      const x = Math.min(drag.startX, drag.curX);
      const y = Math.max(RULER_H, Math.min(drag.startY, drag.curY));
      const w = Math.abs(drag.curX - drag.startX);
      const h = Math.max(0, Math.min(SP_Y, Math.max(drag.startY, drag.curY)) - y);
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

    // Ruler with bar-time labels.
    ctx.fillStyle = dark ? "rgba(35,42,59,0.94)" : "rgba(247,247,255,0.94)";
    ctx.fillRect(0, 0, viewW, RULER_H);
    ctx.strokeStyle = alpha(border, 0.55);
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5);
    ctx.lineTo(viewW, RULER_H - 0.5);
    ctx.stroke();
    ctx.fillStyle = textDim;
    ctx.font = "10px ui-monospace, monospace";
    const bar = activeDoc.resolution * 4;
    const firstBar = Math.floor(startTick / bar) * bar;
    for (let tick = firstBar; tick <= endTick; tick += bar) {
      const x = tickToX(tick);
      const t = activeDoc.tempoMap.tickToSeconds(tick);
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      ctx.fillText(`${m}:${String(s).padStart(2, "0")}`, x + 3, 15);
    }

    // Playhead.
    const playTick = activeDoc.tempoMap.secondsToTick(editorRef.current.playhead.time || 0);
    const px = tickToX(playTick);
    if (px >= 0 && px <= viewW) {
      ctx.strokeStyle = orange;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, editorH);
      ctx.stroke();
      ctx.fillStyle = alpha(orange, 0.18);
      ctx.fillRect(px - 1, RULER_H, 2, editorH - RULER_H);
    }

    // Lane labels for the SP / solo strips.
    ctx.font = "800 9px ui-monospace, monospace";
    ctx.fillStyle = SP_COLOR;
    ctx.fillText("SP", 4, SP_Y + 11);
    ctx.fillStyle = SOLO_COLOR;
    ctx.fillText("SOLO", 4, SOLO_Y + 11);
  }, []);

  const scheduleDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  }, [draw]);

  // Redraw on any state that affects the picture.
  useEffect(() => {
    scheduleDraw();
  }, [doc, editor.revision, editor.selectedNoteIds, editor.selectedRangeIds, editor.playhead, editor.snap, pxPerBeat, scheduleDraw]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => scheduleDraw());
    observer.observe(container);
    return () => observer.disconnect();
  }, [scheduleDraw]);

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
  }, [scheduleDraw]);

  // ---- pointer interactions ----
  const toLocal = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const xToTick = (x) => Math.max(0, (scrollLeftRef.current + x) / pxPerTick);
  const timeAtTick = (tick) => doc.tempoMap.tickToSeconds(tick);

  const hitTest = (localX, localY) => {
    const activeDoc = docRef.current;
    const ppt = pxPerBeatRef.current / (activeDoc.resolution || 192);
    const tickToX = (tick) => tick * ppt - scrollLeftRef.current;
    // Ranges on their dedicated strips (with edge resize handles).
    const region = regionAtY(localY);
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
        const cy = laneCenterY(lane);
        if (Math.abs(localY - cy) > LANE_H / 2 - 2) continue;
        if (Math.abs(localX - headX) <= NOTE_W / 2 + 2) return { note, part: "head", lane };
        const sustain = note.open ? note.sustainsByLane.open || 0 : note.sustainsByLane[lane] || 0;
        if (sustain > 0) {
          const tailEndX = (note.tick + sustain) * ppt - scrollLeftRef.current;
          if (localX > headX + NOTE_W / 2 && localX <= tailEndX + 4) return { note, part: "tail", lane };
        }
      }
    }
    return null;
  };

  const noteIdsInBox = (drag) => {
    const activeDoc = docRef.current;
    if (!activeDoc) return [];
    const ppt = pxPerBeatRef.current / (activeDoc.resolution || 192);
    const left = Math.min(drag.startX, drag.curX);
    const right = Math.max(drag.startX, drag.curX);
    const top = Math.max(RULER_H, Math.min(drag.startY, drag.curY));
    const bottom = Math.min(SP_Y, Math.max(drag.startY, drag.curY));
    if (right - left < BOX_SELECT_MIN_DRAG || bottom - top < BOX_SELECT_MIN_DRAG) return [];

    const tickToX = (tick) => tick * ppt - scrollLeftRef.current;
    const ids = [];
    for (const note of activeDoc.notes) {
      const x = tickToX(note.tick);
      if (x + NOTE_W / 2 < left || x - NOTE_W / 2 > right) continue;
      if (note.open) {
        if (bottom >= RULER_H && top <= SP_Y) ids.push(note.id);
        continue;
      }
      const hitLane = note.lanes.some((lane) => {
        const cy = laneCenterY(lane);
        const headTop = cy - (LANE_H - 12) / 2;
        const headBottom = cy + (LANE_H - 12) / 2;
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
      const region = regionAtY(localY);
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
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (NOTE_W / 2)));
    let changed = false;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      changed = markEraseHit(drag, fromX + dx * t, fromY + dy * t) || changed;
    }
    drag.lastX = localX;
    drag.lastY = localY;
    if (changed) scheduleDraw();
  };

  const markFlagHit = (drag, localX, localY) => {
    const hit = hitTest(localX, localY);
    if (!hit?.note || drag.ids.has(hit.note.id)) return false;
    if (!noteNeedsFlagPaint(hit.note, drag.flag, drag.enabled)) return false;
    drag.ids.add(hit.note.id);
    drag.changed = true;
    return true;
  };

  const markFlagPath = (drag, localX, localY) => {
    const fromX = drag.lastX ?? localX;
    const fromY = drag.lastY ?? localY;
    const dx = localX - fromX;
    const dy = localY - fromY;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (NOTE_W / 2)));
    let changed = false;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      changed = markFlagHit(drag, fromX + dx * t, fromY + dy * t) || changed;
    }
    drag.lastX = localX;
    drag.lastY = localY;
    if (changed) scheduleDraw();
  };

  const onPointerDown = (e) => {
    if (!doc) return;
    canvasRef.current.setPointerCapture(e.pointerId);
    const { x, y } = toLocal(e);
    const region = regionAtY(y);
    const tick = xToTick(x);
    const tool = editor.tool;

    if (region.type === "ruler") {
      dragRef.current = { kind: "seek" };
      requestEditorSeek(timeAtTick(snapTick(tick)));
      return;
    }

    const hit = hitTest(x, y);

    // Range strips: create / resize / move / select regardless of tool.
    if (region.type === "sp" || region.type === "solo") {
      const kind = region.type === "sp" ? "starPower" : "solo";
      if (tool === "erase") {
        const drag = { kind: "erase", noteIds: new Set(), rangeIds: new Set(), sustainCuts: new Map(), rangeCuts: new Map(), lastX: x, lastY: y, changed: false };
        markErasePath(drag, x, y);
        dragRef.current = drag;
        return;
      }
      if (hit?.range && ((tool === "starPower" && kind === "solo") || (tool === "solo" && kind === "starPower"))) {
        applyEditorChange({ type: "addRange", kind: tool, startTick: hit.range.startTick, endTick: hit.range.endTick });
        dragRef.current = { kind: "noop" };
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
    if (tool === "starPower" || tool === "solo") {
      dragRef.current = { kind: "range", kind2: tool, startTick: snapTick(tick), curTick: snapTick(tick) };
      return;
    }
    if (tool === "draw") {
      const lane = region.lane;
      dragRef.current = { kind: "drawNote", tick: snapTick(tick), lane, sustain: 0, anchorTick: snapTick(tick) };
      scheduleDraw();
      return;
    }
    if (tool === "erase") {
      const drag = { kind: "erase", noteIds: new Set(), rangeIds: new Set(), sustainCuts: new Map(), rangeCuts: new Map(), lastX: x, lastY: y, changed: false };
      markErasePath(drag, x, y);
      dragRef.current = drag;
      return;
    }
    if (tool === "tap") {
      const drag = { kind: "flagPaint", flag: "tap", enabled: hit?.note ? !flagIsActive(hit.note, "tap") : true, ids: new Set(), lastX: x, lastY: y, changed: false };
      markFlagPath(drag, x, y);
      dragRef.current = drag;
      return;
    }
    if (tool === "force") {
      const drag = { kind: "flagPaint", flag: "force", enabled: hit?.note ? !flagIsActive(hit.note, "force") : true, ids: new Set(), lastX: x, lastY: y, changed: false };
      markFlagPath(drag, x, y);
      dragRef.current = drag;
      return;
    }
    if (tool === "sustainCut") {
      if (hit?.note) applyEditorChange({ type: "setSustain", id: hit.note.id, sustain: Math.max(0, snapTick(tick) - hit.note.tick) });
      dragRef.current = { kind: "noop" };
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
    if (drag.kind === "seek") {
      requestEditorSeek(timeAtTick(snapTick(tick)));
      return;
    }
    if (drag.kind === "move") {
      const region = regionAtY(y);
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
    if (drag.kind === "flagPaint") {
      markFlagPath(drag, x, y);
      return;
    }
    if (drag.kind === "boxSelect") {
      drag.curX = x;
      drag.curY = y;
      drag.moved = drag.moved || Math.hypot(drag.curX - drag.startX, drag.curY - drag.startY) >= BOX_SELECT_MIN_DRAG;
      scheduleDraw();
      return;
    }
    if (drag.kind === "range") {
      drag.curTick = snapTick(tick);
      scheduleDraw();
      return;
    }
    if (drag.kind === "rangeResize") {
      drag.curTick = snapTick(tick);
      scheduleDraw();
      return;
    }
    if (drag.kind === "rangeMove") {
      drag.curTick = snapTick(tick);
      scheduleDraw();
      return;
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
    if (drag.kind === "move" && drag.moved && (drag.deltaTick || drag.deltaLane)) {
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
    } else if (drag.kind === "flagPaint") {
      if (drag.changed) applyEditorChange({ type: "paintNoteFlag", flag: drag.flag, enabled: drag.enabled, ids: [...drag.ids] });
    } else if (drag.kind === "boxSelect") {
      const { x, y } = toLocal(e);
      drag.curX = x;
      drag.curY = y;
      const moved = drag.moved || Math.hypot(drag.curX - drag.startX, drag.curY - drag.startY) >= BOX_SELECT_MIN_DRAG;
      if (moved) {
        applyEditorChange({ type: "select", noteIds: noteIdsInBox(drag), additive: drag.additive });
      } else {
        applyEditorChange({ type: "clearSelection" });
      }
    } else if (drag.kind === "range") {
      const { x, y } = toLocal(e);
      const endTick = snapTick(xToTick(x));
      const startTick = drag.startTick;
      void y;
      if (Math.abs(endTick - startTick) >= 1) {
        applyEditorChange({ type: "addRange", kind: drag.kind2, startTick, endTick });
      }
    } else if (drag.kind === "rangeResize") {
      applyEditorChange({ type: "updateRange", id: drag.id, startTick: drag.edge === "start" ? drag.curTick : drag.otherTick, endTick: drag.edge === "end" ? drag.curTick : drag.otherTick });
    } else if (drag.kind === "rangeMove") {
      const delta = drag.curTick - drag.startTick;
      if (delta) applyEditorChange({ type: "updateRange", id: drag.id, startTick: Math.max(0, drag.origStart + delta), endTick: Math.max(0, drag.origEnd + delta) });
    }
    scheduleDraw();
  };

  // Keyboard: delete, undo/redo, play/pause.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      const actions = actionsRef.current;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        actions.applyEditorChange({ type: "deleteSelection" });
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) actions.redoEditorChange();
        else actions.undoEditorChange();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        actions.redoEditorChange();
      } else if (e.key === " ") {
        e.preventDefault();
        actions.requestEditorPlayToggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!doc) {
    return <div className="piano-roll-empty">Pick a take and press Edit to open it here.</div>;
  }

  return (
    <div className="piano-roll">
      <div className="piano-roll-side" aria-hidden="true">
        <div className="pr-ruler-spacer" />
        {["G", "R", "Y", "B", "O"].map((label, lane) => (
          <div key={label} className="pr-lane-label" style={{ height: LANE_H, color: LANE_COLORS[lane] }}>
            {label}
          </div>
        ))}
        <div className="pr-strip-label" style={{ height: SP_H, color: SP_COLOR }}>SP</div>
        <div className="pr-strip-label" style={{ height: SOLO_H, color: SOLO_COLOR }}>SOLO</div>
      </div>
      <div className="piano-roll-scroll" ref={containerRef} onScroll={onScroll}>
        <div className="piano-roll-content" style={{ width: contentWidth, height: TOTAL_H }}>
          <canvas
            ref={canvasRef}
            className="piano-roll-canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        </div>
      </div>
      <div className="piano-roll-zoom">
        <button onClick={() => setPxPerBeat((v) => Math.max(20, Math.round(v * 0.8)))} title="Zoom out" aria-label="Zoom out"><I.minus /></button>
        <button onClick={() => setPxPerBeat((v) => Math.min(220, Math.round(v * 1.25)))} title="Zoom in" aria-label="Zoom in"><I.plus /></button>
      </div>
    </div>
  );
}

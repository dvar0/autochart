import { useEffect, useRef } from "react";
import { FRET_COLORS, OPEN_NOTE_COLOR } from "../../data/notePalette.js";

// A tiny piano-roll: the same five GRYBO lanes the take editor uses
// (the shared fret palette), showing a moving window of the last few seconds
// the model has committed. The writing head stays near the right edge and notes
// scroll left as they're written — a close, readable view that travels with the
// generation instead of cramming the whole song into one strip.
const LANE_COLORS = FRET_COLORS;
const OPEN_COLOR = OPEN_NOTE_COLOR;

// Seconds of music shown across the strip at once.
const WINDOW_SEC = 6;

function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export default function LiveNoteStrip({ notes = [], head = 0, className = "" }) {
  const canvasRef = useRef(null);
  // Keep the latest data in a ref so the ResizeObserver redraw always paints the
  // current notes without re-subscribing.
  const dataRef = useRef({ notes, head });
  dataRef.current = { notes, head };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const { notes, head } = dataRef.current;
      const laneH = rect.height / 5;

      // Lane washes + center guides, the editor's lane styling in miniature.
      for (let lane = 0; lane < 5; lane += 1) {
        const y = lane * laneH;
        const wash = ctx.createLinearGradient(0, y, 0, y + laneH);
        wash.addColorStop(0, withAlpha(LANE_COLORS[lane], 0.16));
        wash.addColorStop(1, withAlpha(LANE_COLORS[lane], 0.02));
        ctx.fillStyle = wash;
        ctx.fillRect(0, y, rect.width, laneH);
        ctx.fillStyle = withAlpha(LANE_COLORS[lane], 0.14);
        ctx.fillRect(0, Math.round(y + laneH / 2) + 0.5, rect.width, 1);
      }

      // The window keeps the head pinned to the right once enough has been
      // written; before that it fills in from the left so early notes aren't
      // bunched up against the edge.
      const windowEnd = Math.max(head, WINDOW_SEC);
      const windowStart = windowEnd - WINDOW_SEC;
      const headX = ((head - windowStart) / WINDOW_SEC) * rect.width;
      const xFor = (t) => ((t - windowStart) / WINDOW_SEC) * rect.width;
      const r = Math.min(laneH * 0.38, 5);

      if (notes.length) {
        for (const note of notes) {
          if (note.time < windowStart - 0.3 || note.time > windowEnd + 0.3) continue;
          const x = xFor(note.time);
          // Notes within the last beat of the head still glow like wet ink.
          const wet = head - note.time < 0.28;

          if (note.open || !note.frets?.length) {
            ctx.fillStyle = withAlpha(OPEN_COLOR, wet ? 0.9 : 0.55);
            ctx.fillRect(x - 1.5, 1.5, 3, rect.height - 3);
            continue;
          }
          for (const fret of note.frets) {
            const color = LANE_COLORS[fret] || OPEN_COLOR;
            const cy = fret * laneH + laneH / 2;
            ctx.beginPath();
            ctx.arc(x, cy, wet ? r + 0.8 : r, 0, Math.PI * 2);
            ctx.fillStyle = color;
            if (wet) {
              ctx.shadowColor = withAlpha(color, 0.95);
              ctx.shadowBlur = 8;
            }
            ctx.fill();
            ctx.shadowBlur = 0;
          }
        }
      }

      // The writing head: a soft trailing glow plus a bright vertical line, so
      // you can see where the model is currently committing notes.
      if (headX > 0 && headX <= rect.width + 1) {
        const trail = ctx.createLinearGradient(headX - 26, 0, headX, 0);
        trail.addColorStop(0, withAlpha(OPEN_COLOR, 0));
        trail.addColorStop(1, withAlpha(OPEN_COLOR, 0.16));
        ctx.fillStyle = trail;
        ctx.fillRect(headX - 26, 0, 26, rect.height);
        ctx.fillStyle = withAlpha(OPEN_COLOR, 0.95);
        ctx.fillRect(headX - 1, 0, 2, rect.height);
      }
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [notes, head]);

  return (
    <canvas
      ref={canvasRef}
      className={"live-note-strip" + (className ? ` ${className}` : "")}
      aria-hidden="true"
    />
  );
}

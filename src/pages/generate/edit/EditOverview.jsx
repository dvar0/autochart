import { useEffect, useRef } from "react";
import { FRET_COLORS } from "../../../data/notePalette.js";
import { barEndTick, regionsCover, regionsOverlap } from "./editRegions.js";

// The whole song in one strip: a block per section (name inside, the bars'
// note counts drawn along the bottom), the selected spans, the playhead, and a
// thin marker under the part the piano roll is showing. Clicking a section
// hands it to the screen (which picks or unpicks it and moves the playhead).
// While an area is dragged on the roll it follows live: `lifted` is the area
// being moved or stretched, `origin` where a moved one started.

function barProfile(doc, bars) {
  const out = bars.map(() => ({ count: 0, lanes: [0, 0, 0, 0, 0], open: 0 }));
  if (!doc) return out;
  let index = 0;
  for (const note of doc.notes) {
    while (index + 1 < bars.length && bars[index + 1] <= note.tick) index += 1;
    const bar = out[index];
    if (!bar) continue;
    bar.count += 1;
    if (note.open) bar.open += 1;
    for (const lane of note.lanes) bar.lanes[lane] += 1;
  }
  return out;
}

export default function EditOverview({ doc, bars, sections, regions, lifted = null, origin = null, pending, view, playheadTick, endTick, onJump, onSection }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const total = Math.max(1, endTick);
  const pct = (tick) => `${(Math.max(0, Math.min(total, tick)) / total) * 100}%`;
  const span = (a, b) => ({ left: pct(a), width: `${(Math.max(0, Math.min(total, b) - Math.max(0, a)) / total) * 100}%` });

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return undefined;
    const paint = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const profile = barProfile(doc, bars);
      const max = Math.max(4, ...profile.map((bar) => bar.count));
      const maxH = h * 0.42;
      profile.forEach((bar, index) => {
        if (!bar.count) return;
        const x = (bars[index] / total) * w;
        const bw = Math.max(1, ((barEndTick(bars, index) - bars[index]) / total) * w - 1);
        const bh = Math.max(2, (bar.count / max) * maxH);
        let lane = 0;
        for (let i = 1; i < 5; i += 1) if (bar.lanes[i] > bar.lanes[lane]) lane = i;
        ctx.fillStyle = bar.open > bar.lanes[lane] ? "#a66be3" : FRET_COLORS[lane];
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.roundRect(x, h - 4 - bh, bw, bh, Math.min(2, bw / 2));
        ctx.fill();
      });
      ctx.globalAlpha = 1;
    };
    paint();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(paint);
    observer?.observe(wrap);
    return () => observer?.disconnect();
  }, [doc, bars, total]);

  const onPointerDown = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const tick = ((e.clientX - rect.left) / rect.width) * total;
    const section = sections.find((s) => tick >= s.startTick && tick < s.endTick);
    if (section) onSection?.(section);
    else onJump?.(tick);
  };

  return (
    <div
      className="song-strip"
      ref={wrapRef}
      onPointerDown={onPointerDown}
    >
      {sections.map((section) => (
        <span
          key={section.id}
          className={"strip-section" + (regionsCover(regions, section) ? " selected" : "")}
          style={{ ...span(section.startTick, section.endTick), "--sec": section.color }}
        >
          <b>{section.name}</b>
        </span>
      ))}
      <canvas ref={canvasRef} />
      {origin && <span className="strip-origin" style={span(origin.startTick, origin.endTick)} />}
      {regions.map((region) => (
        <span
          key={`s${region.startTick}`}
          className={"strip-sel" + (lifted && regionsOverlap(region, lifted) ? " lifted" : "")}
          style={span(region.startTick, region.endTick)}
        />
      ))}
      {(doc?.redos || []).flatMap((redo) =>
        redo.regions.map((region) => (
          <span key={`d${redo.id}${region.startTick}`} className="strip-redo" style={span(region.startTick, region.endTick)} />
        ))
      )}
      {pending?.regions.map((region) => (
        <span key={`p${region.startTick}`} className="strip-pending" style={span(region.startTick, region.endTick)} />
      ))}
      {view && <span className="strip-view" style={span(view.startTick, view.endTick)} />}
      <span className="strip-playhead" style={{ left: pct(playheadTick) }} />
    </div>
  );
}

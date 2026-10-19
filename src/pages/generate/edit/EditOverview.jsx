import { useEffect, useRef } from "react";
import { FRET_COLORS } from "../../../data/notePalette.js";
import { barEndTick } from "./editRegions.js";

// Whole-song map above the piano roll: section blocks, one column per bar
// (height = notes, color = the bar's busiest fret), redo regions, the piano
// roll's visible window and the playhead. Click to jump there.

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

export default function EditOverview({ doc, bars, sections, regions, pending, view, playheadTick, endTick, onJump, onSection }) {
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
      profile.forEach((bar, index) => {
        if (!bar.count) return;
        const x = (bars[index] / total) * w;
        const bw = Math.max(1, ((barEndTick(bars, index) - bars[index]) / total) * w - 1);
        const bh = Math.max(3, (bar.count / max) * (h - 4));
        let lane = 0;
        for (let i = 1; i < 5; i += 1) if (bar.lanes[i] > bar.lanes[lane]) lane = i;
        ctx.fillStyle = bar.open > bar.lanes[lane] ? "#a66be3" : FRET_COLORS[lane];
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.roundRect(x, h - bh, bw, bh, Math.min(3, bw / 2));
        ctx.fill();
      });
      ctx.globalAlpha = 1;
    };
    paint();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(paint);
    observer?.observe(wrap);
    return () => observer?.disconnect();
  }, [doc, bars, total]);

  const jumpFromEvent = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    onJump?.(((e.clientX - rect.left) / rect.width) * total);
  };

  return (
    <div className="edit-overview">
      <div className="edit-overview-sections">
        {sections.length ? (
          sections.map((section) => {
            const selected = regions.some((r) => r.startTick === section.startTick && r.endTick === section.endTick);
            return (
              <button
                key={section.id}
                className={"ov-section" + (selected ? " selected" : "")}
                style={{ ...span(section.startTick, section.endTick), "--sec": section.color }}
                onClick={(e) => onSection?.(section, e.shiftKey)}
                title={section.name}
              >
                <span>{section.name}</span>
              </button>
            );
          })
        ) : (
          <span className="ov-no-sections">No sections in this chart</span>
        )}
      </div>
      <div className="edit-overview-map" ref={wrapRef} onPointerDown={jumpFromEvent}>
        <canvas ref={canvasRef} />
        {regions.map((region) => (
          <span key={`r${region.startTick}`} className="ov-region" style={span(region.startTick, region.endTick)} />
        ))}
        {(doc?.redos || []).flatMap((redo) =>
          redo.regions.map((region) => (
            <span key={`d${redo.id}${region.startTick}`} className="ov-redo" style={span(region.startTick, region.endTick)} />
          ))
        )}
        {pending?.regions.map((region) => (
          <span key={`p${region.startTick}`} className="ov-pending" style={span(region.startTick, region.endTick)} />
        ))}
        {view && <span className="ov-window" style={span(view.startTick, view.endTick)} />}
        <span className="ov-playhead" style={{ left: pct(playheadTick) }} />
      </div>
    </div>
  );
}

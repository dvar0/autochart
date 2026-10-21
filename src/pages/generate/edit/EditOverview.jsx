import { useEffect, useRef, useState } from "react";
import { FRET_COLORS } from "../../../data/notePalette.js";
import { barEndTick, regionsCover, regionsOverlap } from "./editRegions.js";

// The whole song in two bands that share one playhead. The top band is the
// song's sections: clicking one hands it to the screen (which picks or unpicks
// it and shows it on the roll). The bottom band is the timeline: each bar's
// note count, brackets around what the roll is showing, and the playhead's
// handle; clicking or dragging anywhere on it moves the playhead there. The
// playhead can be grabbed from either band. On the timeline, section starts
// are magnetic: within a few pixels of one the playhead lands exactly on it,
// and dragging further lets go (Alt turns the magnet off). It is drawn as one shape (the
// outlines of line and handle first, then both fills) so it reads and moves
// as a single object.
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

// How close (in px) the pointer must be to a section start to snap to it.
const SNAP_PX = 8;

function fmtTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function EditOverview({ doc, bars, sections, regions, lifted = null, origin = null, pending, view, playheadTick, endTick, onScrub, onSection }) {
  const canvasRef = useRef(null);
  const trackRef = useRef(null);
  const scrubRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [scrubbing, setScrubbing] = useState(false);
  const total = Math.max(1, endTick);
  const pct = (tick) => `${(Math.max(0, Math.min(total, tick)) / total) * 100}%`;
  const span = (a, b) => ({ left: pct(a), width: `${(Math.max(0, Math.min(total, b) - Math.max(0, a)) / total) * 100}%` });

  useEffect(() => {
    const canvas = canvasRef.current;
    const track = trackRef.current;
    if (!canvas || !track) return undefined;
    const paint = () => {
      const w = track.clientWidth;
      const h = track.clientHeight;
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
      const maxH = h - 8;
      profile.forEach((bar, index) => {
        if (!bar.count) return;
        const x = (bars[index] / total) * w;
        const bw = Math.max(1, ((barEndTick(bars, index) - bars[index]) / total) * w - 1);
        const bh = Math.max(3, (bar.count / max) * maxH);
        let lane = 0;
        for (let i = 1; i < 5; i += 1) if (bar.lanes[i] > bar.lanes[lane]) lane = i;
        ctx.fillStyle = bar.open > bar.lanes[lane] ? "#a66be3" : FRET_COLORS[lane];
        ctx.beginPath();
        ctx.roundRect(x, h - 3 - bh, bw, bh, Math.min(2, bw / 2));
        ctx.fill();
      });
    };
    paint();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(paint);
    observer?.observe(track);
    return () => observer?.disconnect();
  }, [doc, bars, total]);

  const tickAt = (e) => {
    const rect = trackRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * total;
  };

  // The pointer's spot on the timeline, pulled onto a nearby section start.
  const snapAt = (e) => {
    const tick = tickAt(e);
    if (e.altKey) return { tick, section: null };
    const pxPerTick = trackRef.current.clientWidth / total;
    let best = null;
    for (const section of sections) {
      const dist = Math.abs(section.startTick - tick) * pxPerTick;
      if (dist <= SNAP_PX && (!best || dist < best.dist)) best = { dist, section };
    }
    return best ? { tick: best.section.startTick, section: best.section } : { tick, section: null };
  };

  // Scrubbing: the playhead follows the pointer until it lets go. Moves are
  // batched per frame so a fast drag doesn't seek more than the screen draws.
  const startScrub = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const spot = snapAt(e);
    scrubRef.current = { tick: spot.tick, frame: 0 };
    setHover(spot);
    setScrubbing(true);
    onScrub?.(scrubRef.current.tick, "start");
  };
  const moveScrub = (e) => {
    const spot = snapAt(e);
    setHover(spot);
    const scrub = scrubRef.current;
    if (!scrub) return;
    scrub.tick = spot.tick;
    if (scrub.frame) return;
    scrub.frame = requestAnimationFrame(() => {
      scrub.frame = 0;
      if (scrubRef.current === scrub) onScrub?.(scrub.tick, "move");
    });
  };
  const endScrub = () => {
    const scrub = scrubRef.current;
    if (!scrub) return;
    if (scrub.frame) cancelAnimationFrame(scrub.frame);
    scrubRef.current = null;
    setScrubbing(false);
    onScrub?.(scrub.tick, "end");
  };
  const scrubHandlers = { onPointerDown: startScrub, onPointerMove: moveScrub, onPointerUp: endScrub, onPointerCancel: endScrub };

  const onSectionDown = (e) => {
    if (e.button !== 0) return;
    const section = sections.find((s) => { const t = tickAt(e); return t >= s.startTick && t < s.endTick; });
    if (section) onSection?.(section);
  };

  const hoverTick = hover?.tick ?? null;
  const hoverSeconds = hoverTick != null && doc ? doc.tempoMap.tickToSeconds(hoverTick) : null;
  const hoverPct = hoverTick != null ? (hoverTick / total) * 100 : 0;

  return (
    <div className={"song-map" + (scrubbing ? " scrubbing" : "")}>
      <div className="map-sections" onPointerDown={onSectionDown}>
        {sections.map((section) => (
          <span
            key={section.id}
            className={"strip-section" + (regionsCover(regions, section) ? " selected" : "")}
            style={{ ...span(section.startTick, section.endTick), "--sec": section.color }}
          >
            <b>{section.name}</b>
          </span>
        ))}
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
      </div>

      <div
        className="map-track"
        ref={trackRef}
        {...scrubHandlers}
        onPointerLeave={() => { if (!scrubRef.current) setHover(null); }}
      >
        {view && <span className="track-view" style={span(view.startTick, view.endTick)} />}
        {regions.map((region) => (
          <span key={`t${region.startTick}`} className="track-sel" style={span(region.startTick, region.endTick)} />
        ))}
        <canvas ref={canvasRef} />
        {hoverTick != null && !scrubbing && (
          <span className={"track-hover" + (hover.section ? " snapped" : "")} style={{ left: `${hoverPct}%`, "--sec": hover.section?.color }} />
        )}
        {hoverSeconds != null && (
          <span className={"track-time" + (hoverPct > 50 ? " flip" : "")} style={{ left: `${hoverPct}%` }}>
            {hover.section && <b style={{ "--sec": hover.section.color }}>{hover.section.name}</b>}
            {fmtTime(hoverSeconds)}
          </span>
        )}
      </div>

      {pending?.regions.map((region) => (
        <span key={`p${region.startTick}`} className="strip-pending" style={span(region.startTick, region.endTick)} />
      ))}
      <span className="map-playhead" style={{ left: pct(playheadTick) }} {...scrubHandlers}>
        <svg viewBox="0 0 16 54" width="16" height="54" aria-hidden="true">
          <rect className="ph-edge" x="7" y="-2" width="2" height="58" />
          <rect className="ph-edge ph-head" x="2" y="14" width="12" height="18" rx="6" />
          <rect className="ph-fill" x="7" y="-2" width="2" height="58" />
          <rect className="ph-fill ph-head" x="2" y="14" width="12" height="18" rx="6" />
          <path className="ph-grip ph-head" d="M5.5 20.5h5M5.5 23h5M5.5 25.5h5" />
        </svg>
      </span>
    </div>
  );
}

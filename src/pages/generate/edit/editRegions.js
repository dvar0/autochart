// Bar grid, section markers and redo regions for the edit screen. Regions are
// always whole bars: the inpainting model is trained on bar-aligned holes, and
// snapping outward keeps a problem's first beat inside the region (otherwise
// the model copies whatever pattern remains to its left).

import { FRET_COLORS } from "../../../data/notePalette.js";

// Bar start ticks from the time-signature map, through the end of the song.
// A `TS n d` bar is n beats of a 1/d note: resolution * 4 / d ticks per beat.
export function buildBarGrid(doc, endTick) {
  if (!doc) return [];
  const resolution = doc.resolution || 192;
  const signatures = doc.sync?.timeSignatures?.length
    ? doc.sync.timeSignatures
    : [{ tick: 0, numerator: 4, denominator: 4 }];
  const last = Math.max(endTick || 0, resolution * 8);
  const bars = [];
  let tick = 0;
  let index = 0;
  while (tick <= last && bars.length < 5000) {
    while (index + 1 < signatures.length && signatures[index + 1].tick <= tick) index += 1;
    const ts = signatures[index];
    const beatTicks = (resolution * 4) / (ts.denominator || 4);
    const barTicks = Math.max(1, Math.round(beatTicks * (ts.numerator || 4)));
    bars.push(tick);
    const next = tick + barTicks;
    // A signature change mid-bar starts a new bar at the change.
    const change = signatures[index + 1];
    tick = change && change.tick > tick && change.tick < next ? change.tick : next;
  }
  return bars;
}

// Index of the bar containing tick (binary search).
export function barIndexAt(bars, tick) {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid] <= tick) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

export function barEndTick(bars, index) {
  if (index + 1 < bars.length) return bars[index + 1];
  const prev = index > 0 ? bars[index] - bars[index - 1] : 768;
  return bars[index] + prev;
}

// Snaps any tick span outward to whole bars (at least one bar).
export function snapSpanToBars(bars, a, b) {
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  const first = barIndexAt(bars, from);
  let last = barIndexAt(bars, Math.max(from, to - 1));
  if (last < first) last = first;
  return { startTick: bars[first], endTick: barEndTick(bars, last) };
}

export function regionBarCount(bars, region) {
  return barIndexAt(bars, region.endTick - 1) - barIndexAt(bars, region.startTick) + 1;
}

// Sorts and merges touching or overlapping regions.
export function normalizeRegions(regions) {
  const sorted = regions
    .filter((r) => r.endTick > r.startTick)
    .map((r) => ({ startTick: r.startTick, endTick: r.endTick }))
    .sort((a, b) => a.startTick - b.startTick);
  const out = [];
  for (const region of sorted) {
    const prev = out[out.length - 1];
    if (prev && region.startTick <= prev.endTick) prev.endTick = Math.max(prev.endTick, region.endTick);
    else out.push(region);
  }
  return out;
}

export function regionsOverlap(a, b) {
  return a.startTick < b.endTick && b.startTick < a.endTick;
}

export function tickInRegions(tick, regions) {
  return regions.some((r) => tick >= r.startTick && tick < r.endTick);
}

// Section kinds get fret colors, so the song map reads like the highway.
const SECTION_KINDS = [
  { kind: "intro", match: /intro|start/i, color: FRET_COLORS[0] },
  { kind: "verse", match: /verse/i, color: FRET_COLORS[3] },
  { kind: "chorus", match: /chorus|refrain|hook/i, color: FRET_COLORS[4] },
  { kind: "solo", match: /solo|lead/i, color: "#9a6bff" },
  { kind: "bridge", match: /bridge|break|interlude|pre/i, color: FRET_COLORS[2] },
  { kind: "outro", match: /outro|end|ending/i, color: FRET_COLORS[1] },
];

function sectionKind(name) {
  return SECTION_KINDS.find((entry) => entry.match.test(name)) || { kind: "other", color: "#8a93b8" };
}

function cleanSectionName(raw) {
  return raw
    .replace(/^prc_/i, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

// `[Events]` section markers (`E "section Chorus 2"`, or `section Chorus` from
// hand-written charts) as contiguous spans that end where the next one starts.
export function sectionsFromDoc(doc, endTick) {
  if (!doc?.events?.length) return [];
  const markers = doc.events
    .map((event) => {
      const m = String(event.text || "").match(/^section\s+(.+)$/i);
      return m ? { tick: event.tick, name: cleanSectionName(m[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.tick - b.tick);
  return markers.map((marker, index) => {
    const next = markers[index + 1];
    const { kind, color } = sectionKind(marker.name);
    return {
      id: `section_${marker.tick}`,
      name: marker.name,
      kind,
      color,
      startTick: marker.tick,
      endTick: next ? next.tick : Math.max(endTick || marker.tick, marker.tick + 1),
    };
  });
}

// Short human label for a selection, used on the Redo button.
export function selectionLabel(bars, regions, sections) {
  if (!regions.length) return "";
  if (regions.length === 1) {
    const region = regions[0];
    const section = sections.find((s) => s.startTick === region.startTick && s.endTick === region.endTick);
    if (section) return section.name;
    const count = regionBarCount(bars, region);
    return `${count} bar${count === 1 ? "" : "s"}`;
  }
  return `${regions.length} spots`;
}

export function barNumberLabel(bars, region) {
  const first = barIndexAt(bars, region.startTick) + 1;
  const last = barIndexAt(bars, region.endTick - 1) + 1;
  return first === last ? `Bar ${first}` : `Bars ${first}–${last}`;
}

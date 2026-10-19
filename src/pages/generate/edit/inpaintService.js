// Redo (inpainting) requests for the edit screen.
//
// MOCK: nothing here runs a model yet. The UI talks to startRedo() only, so
// the engine job can replace mockRedo() without touching the screen. The real
// job will be an engine `inpaint` request:
//   { chartText, difficulty, regions: [{ startTick, endTick }] (bar-aligned,
//     filled left to right so later fills see earlier ones), knobs,
//     seed, keepMarkers: true }
// streaming `partial_chart` lines per region and resolving with the new notes
// for every region. Timing comes from the take's own tempo map; nothing is
// re-separated or re-beat-tracked unless the take's stems don't match the model.
//
// Until then the mock rebuilds each bar from another bar of the same chart,
// so results look like plausible charting instead of noise.

import { barEndTick, barIndexAt, tickInRegions } from "./editRegions.js";

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function notesInSpan(notes, startTick, endTick) {
  return notes.filter((note) => note.tick >= startTick && note.tick < endTick && (note.open || note.lanes.length));
}

function shiftLanes(lanes, shift) {
  const out = [];
  for (const lane of lanes) {
    const next = Math.max(0, Math.min(4, lane + shift));
    if (!out.includes(next)) out.push(next);
  }
  return out.sort((a, b) => a - b);
}

// Builds one bar of new notes from a donor bar.
function rebuildBar({ donorNotes, donorStart, targetStart, targetEnd, shift, knobs, random }) {
  const out = [];
  for (const source of donorNotes) {
    const tick = targetStart + (source.tick - donorStart);
    if (tick >= targetEnd) continue;
    if (knobs.density === "less" && out.length && random() < 0.4) continue;
    let lanes = source.open ? [] : shiftLanes(source.lanes, shift);
    if (knobs.chords === "less" && lanes.length > 1) lanes = [lanes[0]];
    if (knobs.chords === "more" && lanes.length === 1 && random() < 0.45) {
      const add = lanes[0] + (lanes[0] >= 3 ? -2 : 2);
      lanes = [...lanes, add].sort((a, b) => a - b);
    }
    const sustain = Math.max(0, ...Object.values(source.sustainsByLane), 0);
    const clipped = Math.min(sustain, Math.max(0, targetEnd - tick - 1));
    const sustainsByLane = {};
    if (source.open) sustainsByLane.open = clipped;
    for (const lane of lanes) sustainsByLane[lane] = clipped;
    out.push({
      id: `redo_${tick}_${Math.random().toString(36).slice(2, 7)}`,
      tick,
      lanes,
      open: source.open && !lanes.length,
      tap: source.tap,
      force: source.force,
      sustainsByLane,
    });
  }
  return out;
}

function mockRedo({ doc, bars, regions, knobs, seed, onProgress, signal }) {
  const random = rng(seed);
  const donorBars = [];
  for (let i = 0; i < bars.length; i += 1) {
    const start = bars[i];
    const end = barEndTick(bars, i);
    if (tickInRegions(start, regions)) continue;
    const notes = notesInSpan(doc.notes, start, end);
    if (notes.length) donorBars.push({ start, end, notes, length: end - start });
  }

  // Work list: every bar inside every region, left to right.
  const work = [];
  for (const region of regions) {
    for (let i = barIndexAt(bars, region.startTick); i < bars.length && bars[i] < region.endTick; i += 1) {
      work.push({ start: bars[i], end: Math.min(barEndTick(bars, i), region.endTick) });
    }
  }

  const movement = knobs.movement === "more" ? 2 : knobs.movement === "less" ? 0 : 1;
  // One lane shift per take keeps repeated bars inside a region coherent.
  const shift = Math.round((random() * 2 - 1) * movement);
  const produced = [];

  return new Promise((resolve, reject) => {
    let index = 0;
    const step = () => {
      if (signal.aborted) {
        reject(new DOMException("Redo canceled", "AbortError"));
        return;
      }
      if (index >= work.length) {
        resolve(produced);
        return;
      }
      const bar = work[index];
      const original = notesInSpan(doc.notes, bar.start, bar.end).length;
      const wanted = knobs.density === "more" ? original * 1.6 + 2 : original;
      const fits = donorBars.filter((d) => d.length === bar.end - bar.start || d.length >= bar.end - bar.start);
      const pool = fits.length ? fits : donorBars;
      let donor = null;
      if (pool.length) {
        const ranked = [...pool].sort(
          (a, b) => Math.abs(a.notes.length - wanted) - Math.abs(b.notes.length - wanted) + (random() - 0.5) * 6
        );
        donor = ranked[Math.floor(random() * Math.min(4, ranked.length))];
      }
      const notes = donor
        ? rebuildBar({ donorNotes: donor.notes, donorStart: donor.start, targetStart: bar.start, targetEnd: bar.end, shift, knobs, random })
        : [];
      produced.push(...notes);
      index += 1;
      onProgress?.({ done: index, total: work.length, notes: [...produced] });
      setTimeout(step, 180 + notes.length * 22 + random() * 120);
    };
    setTimeout(step, 450);
  });
}

/**
 * Starts a redo. Resolves with the new notes for every region (editor-doc
 * note shape). onProgress({ done, total, notes }) streams partial results.
 * Returns { promise, cancel }.
 */
export function startRedo({ doc, bars, regions, knobs = {}, seed = Date.now(), onProgress }) {
  const controller = new AbortController();
  const promise = mockRedo({ doc, bars, regions, knobs, seed, onProgress, signal: controller.signal });
  return { promise, cancel: () => controller.abort() };
}

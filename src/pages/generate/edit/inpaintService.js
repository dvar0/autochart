// Redo (inpainting) requests for the edit screen.
//
// The desktop app runs the engine's `inpaint` job (Fretformer v2 DPO+FIM, see
// useGenerateProject startInpaint): the edited chart as it stands, the picked
// bar spans (filled left to right, so later fills see earlier ones), the
// style knobs, the number of tries per area and a seed; timing is the take's
// own tempo map, stems come from the take's separation. Every try comes back
// with its seam score. The browser preview has no engine, so it keeps a mock
// that rebuilds each bar from another bar of the same chart.

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
    if (knobs.speed != null && knobs.speed < 3 && out.length && random() < 0.4) continue;
    let lanes = source.open ? [] : shiftLanes(source.lanes, shift);
    if (knobs.chords != null && knobs.chords < 3 && lanes.length > 1) lanes = [lanes[0]];
    if (knobs.chords != null && knobs.chords > 3 && lanes.length === 1 && random() < 0.45) {
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

function mockRedo({ doc, bars, regions, knobs, tries, seed, onProgress, signal }) {
  const random = rng(seed);
  const donorBars = [];
  for (let i = 0; i < bars.length; i += 1) {
    const start = bars[i];
    const end = barEndTick(bars, i);
    if (tickInRegions(start, regions)) continue;
    const notes = notesInSpan(doc.notes, start, end);
    if (notes.length) donorBars.push({ start, end, notes, length: end - start });
  }

  // Work list: every try of every region, each try bar by bar.
  const work = [];
  regions.forEach((region, area) => {
    for (let t = 0; t < tries; t += 1) {
      for (let i = barIndexAt(bars, region.startTick); i < bars.length && bars[i] < region.endTick; i += 1) {
        work.push({ area, try: t, start: bars[i], end: Math.min(barEndTick(bars, i), region.endTick) });
      }
    }
  });

  const movement = knobs.movement == null ? 1 : knobs.movement > 3 ? 2 : knobs.movement < 3 ? 0 : 1;
  const areas = regions.map((region) => ({ ...region, tries: Array.from({ length: tries }, () => []), seams: [], chosen: 0 }));
  let shift = 0;

  return new Promise((resolve, reject) => {
    let index = 0;
    const step = () => {
      if (signal.aborted) {
        reject(new DOMException("Redo canceled", "AbortError"));
        return;
      }
      if (index >= work.length) {
        for (const area of areas) {
          area.seams = area.tries.map(() => Math.round(-random() * 1000) / 1000);
          area.chosen = area.seams.indexOf(Math.max(...area.seams));
        }
        resolve({ areas });
        return;
      }
      const bar = work[index];
      // One lane shift per try keeps repeated bars inside a region coherent.
      if (bar.start === bars[barIndexAt(bars, regions[bar.area].startTick)]) shift = Math.round((random() * 2 - 1) * movement);
      const original = notesInSpan(doc.notes, bar.start, bar.end).length;
      const wanted = knobs.speed != null && knobs.speed > 3 ? original * 1.6 + 2 : original;
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
      areas[bar.area].tries[bar.try].push(...notes);
      index += 1;
      const shown = areas.slice(0, bar.area).flatMap((area) => area.tries[0]);
      onProgress?.({ done: index, total: work.length, try: bar.try, tries, notes: [...shown, ...areas[bar.area].tries[bar.try]] });
      setTimeout(step, 180 + notes.length * 22 + random() * 120);
    };
    setTimeout(step, 450);
  });
}

/**
 * Starts a redo. knobs: { [knobId]: 0..6 } (missing = auto). Resolves with
 * { areas: [{ startTick, endTick, tries: [notes], seams, chosen }] }, one per
 * region (editor-doc note shape). onProgress({ done, total, try, tries,
 * notes }) streams the try being written (beside earlier areas' picks).
 * run: the engine runner (editor.startInpaint); without it, the mock.
 * Returns { promise, cancel }.
 */
export function startRedo({ doc, bars, regions, knobs = {}, tries = 1, seed = Date.now() % 2147483647, onProgress, run = null }) {
  if (run) return run({ regions, knobs, tries, seed, onProgress });
  const controller = new AbortController();
  const promise = mockRedo({ doc, bars, regions, knobs, tries, seed, onProgress, signal: controller.signal });
  return { promise, cancel: () => controller.abort() };
}

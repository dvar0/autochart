// "Keep repeats alike" for Regenerate. Areas that are the same kind of
// section (Verse 1 and Verse 2) are partners; when one is longer, they are
// compared over the shorter one's length, from their starts. When the
// partners' notes already look alike before regenerating, the tries picked
// for them should look alike too; when they differ, the model treated them as
// different parts, so the pick is left to the seam score.

// Partners whose notes score this or more count as repeats.
export const ALIKE_THRESHOLD = 0.6;

// "Verse 2" -> "verse", "Chorus 3b" -> "chorus".
function sectionStem(name) {
  return String(name || "").replace(/\s*\d+[a-z]?$/i, "").trim().toLowerCase();
}

// The stems of the sections that exactly fill an area, or null when the area
// isn't whole sections.
export function areaStem(region, sections) {
  const inside = sections.filter((s) => s.startTick >= region.startTick && s.endTick <= region.endTick);
  const covered = inside.reduce((sum, s) => sum + (s.endTick - s.startTick), 0);
  if (!inside.length || covered !== region.endTick - region.startTick) return null;
  return inside.map((s) => sectionStem(s.name)).join("+");
}

function noteKeys(notes, region, length, resolution) {
  const step = Math.max(1, resolution / 4);
  const exact = new Set();
  const rhythm = new Set();
  const end = region.startTick + length;
  for (const note of notes) {
    if (note.tick < region.startTick || note.tick >= end) continue;
    const offset = Math.round((note.tick - region.startTick) / step);
    exact.add(`${offset}:${note.open ? "o" : note.lanes.join("")}`);
    rhythm.add(offset);
  }
  return { exact, rhythm };
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let shared = 0;
  for (const key of a) if (b.has(key)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// 0..1: how alike two areas' notes are, lined up from each area's start on a
// 16th-note grid, over the shorter area. Same frets on the same 16ths count
// most; same rhythm on other frets counts some.
export function notesSimilarity(a, regionA, b, regionB, resolution) {
  const length = Math.min(regionA.endTick - regionA.startTick, regionB.endTick - regionB.startTick);
  const ka = noteKeys(a, regionA, length, resolution);
  const kb = noteKeys(b, regionB, length, resolution);
  return 0.7 * jaccard(ka.exact, kb.exact) + 0.3 * jaccard(ka.rhythm, kb.rhythm);
}

// Groups partner areas by stem. items: [{ region, ... }]. Returns arrays of
// 2+ items.
export function partnerGroups(items, sections) {
  const groups = new Map();
  for (const item of items) {
    const stem = areaStem(item.region, sections);
    if (!stem) continue;
    if (!groups.has(stem)) groups.set(stem, []);
    groups.get(stem).push(item);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * The most alike pick across a group. members: [{ region, options: [{ notes,
 * seam }] }] (a fixed partner has one option). Ties go to the better seams.
 * Returns one option index per member.
 */
export function mostAlikePicks(members, resolution) {
  // Pair scores once: sims[i][j][a][b] for member i option a vs member j option b.
  const sims = members.map((mi, i) => members.map((mj, j) => (j <= i ? null : mi.options.map((a) =>
    mj.options.map((b) => notesSimilarity(a.notes, mi.region, b.notes, mj.region, resolution))
  ))));
  const score = (picks) => {
    let sum = 0;
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) sum += sims[i][j][picks[i]][picks[j]];
    }
    return sum;
  };
  const seamOf = (picks) => members.reduce((sum, m, i) => sum + (m.options[picks[i]]?.seam ?? 0), 0);
  const combos = members.reduce((n, m) => n * m.options.length, 1);
  if (combos > 4096) {
    // Too many to try them all: settle each member against the others.
    const picks = members.map(() => 0);
    for (let pass = 0; pass < 3; pass += 1) {
      members.forEach((member, i) => {
        let best = -1;
        member.options.forEach((_, k) => {
          const trial = picks.slice();
          trial[i] = k;
          const s = score(trial);
          if (s > best) {
            best = s;
            picks[i] = k;
          }
        });
      });
    }
    return picks;
  }
  let best = null;
  for (let c = 0; c < combos; c += 1) {
    let rest = c;
    const picks = members.map((m) => {
      const k = rest % m.options.length;
      rest = Math.floor(rest / m.options.length);
      return k;
    });
    const sim = score(picks);
    const seam = seamOf(picks);
    if (!best || sim > best.sim + 1e-9 || (Math.abs(sim - best.sim) <= 1e-9 && seam > best.seam)) best = { sim, seam, picks };
  }
  return best ? best.picks : members.map(() => 0);
}

// Mean pair score of a group's current notes: are these repeats already?
export function groupSimilarity(members, resolution) {
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      sum += notesSimilarity(members[i].notes, members[i].region, members[j].notes, members[j].region, resolution);
      pairs += 1;
    }
  }
  return pairs ? sum / pairs : 0;
}

function overlapsAny(span, regions) {
  return regions.some((r) => span.startTick < r.endTick && r.startTick < span.endTick);
}

// Partner groups among `items` plus the song's sections outside them, which
// join as fixed partners with their current notes.
function groupsWithSections(items, doc, sections) {
  const regions = items.map((item) => item.region);
  const fixed = sections
    .filter((s) => !overlapsAny(s, regions))
    .map((s) => ({ region: { startTick: s.startTick, endTick: s.endTick }, name: s.name, options: [{ notes: doc.notes, seam: 0 }] }));
  return partnerGroups([...items, ...fixed], sections).filter((group) => group.some((item) => !item.name));
}

/**
 * A fresh regenerate's picks. areas: [{ region, label, tries, seams, pick }]
 * with pick = the best seam. Where the areas' partners already look alike,
 * the picks favour tries that keep them alike (matchedWith names them).
 */
export function alikeRegenPicks(areas, doc, sections) {
  const items = areas.map((area) => ({ area, region: area.region, options: area.tries.map((notes, i) => ({ notes, seam: area.seams[i] ?? 0 })) }));
  const out = new Map(areas.map((area) => [area, { pick: area.pick, matchedWith: null }]));
  for (const group of groupsWithSections(items, doc, sections)) {
    if (!group.some((item) => item.area && item.options.length > 1)) continue;
    const before = group.map((item) => ({ region: item.region, notes: doc.notes }));
    if (groupSimilarity(before, doc.resolution) < ALIKE_THRESHOLD) continue;
    const picks = mostAlikePicks(group, doc.resolution);
    group.forEach((item, i) => {
      if (!item.area) return;
      const others = group.filter((other) => other !== item).map((other) => other.area?.label || other.name);
      out.set(item.area, { pick: picks[i], matchedWith: others.join(", ") });
    });
  }
  return areas.map((area) => ({ ...area, ...out.get(area) }));
}

/**
 * "Pick most alike": for every regenerated area with partners, the try that
 * looks most like them, whether or not the originals were alike. Areas set
 * back to their original stay put and count as partners. Returns the picks
 * that differ from what is showing: [{ redoId, index }].
 */
export function mostAlikeRecordPicks(redos, doc, sections) {
  const items = redos
    .filter((redo) => redo.takes.length && redo.active >= 0)
    .map((redo) => ({ redo, region: redo.region, options: redo.takes.map((notes, i) => ({ notes, seam: redo.seams[i] ?? 0 })) }));
  const changes = [];
  for (const group of groupsWithSections(items, doc, sections)) {
    const picks = mostAlikePicks(group, doc.resolution);
    group.forEach((item, i) => {
      if (item.redo && item.redo.active !== picks[i]) changes.push({ redoId: item.redo.id, index: picks[i] });
    });
  }
  return changes;
}

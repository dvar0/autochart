// Difficulty-slot seeding shared by the renderer (final chart assembly) and the
// Electron main process (durable generated-take saves). Kept dependency-free so
// both ESM renderer bundles and CommonJS main-process dynamic imports can use it.

const TRACK_SECTION_BY_DIFFICULTY = Object.freeze({
  easy: "EasySingle",
  medium: "MediumSingle",
  hard: "HardSingle",
  expert: "ExpertSingle",
});

export const FINAL_SLOT_SEED_ORDER = Object.freeze(["easy", "medium", "hard", "expert"]);

function findSection(lines, sectionName) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== `[${sectionName}]`) continue;
    let open = i + 1;
    while (open < lines.length && lines[open].trim() !== "{") open++;
    if (open >= lines.length) return null;
    let close = open + 1;
    while (close < lines.length && lines[close].trim() !== "}") close++;
    if (close >= lines.length) return null;
    return { header: i, open, bodyStart: open + 1, bodyEnd: close, close };
  }
  return null;
}

/**
 * Difficulties a chart text actually ships. YARG and Clone Hero only surface a
 * difficulty when its track contains note events, so present-but-empty
 * sections do not count.
 *
 * @param {string} chartText
 * @returns {string[]} subset of ["easy","medium","hard","expert"]
 */
export function difficultySectionsWithNotes(chartText = "") {
  const text = String(chartText || "");
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const found = [];
  for (const [difficulty, sectionName] of Object.entries(TRACK_SECTION_BY_DIFFICULTY)) {
    const section = findSection(lines, sectionName);
    if (!section) continue;
    const hasNote = lines
      .slice(section.bodyStart, section.bodyEnd)
      .some((line) => /^\s*\d+\s*=\s*N\s+(?:[0-4]|7)\s+\d+/.test(line));
    if (hasNote) found.push(difficulty);
  }
  return found;
}

/**
 * Final-chart slot map an imported chart can seed on its own: every difficulty
 * section it ships that has notes maps to the imported version. Callers merge
 * this under their existing assignments (generated takes keep precedence for
 * their own difficulty).
 *
 * @param {Array<{id: string, source?: string, chart?: {text?: string}}>} versions
 * @param {string[]} [order]
 * @returns {Record<string, string>} slots ("" where unfilled)
 */
export function importedFinalSlotSeed(versions = [], order = FINAL_SLOT_SEED_ORDER) {
  const slots = order.reduce((map, difficulty) => ({ ...map, [difficulty]: "" }), {});
  for (const version of Array.isArray(versions) ? versions : []) {
    if (!version || version.source !== "imported-chart" || !version.chart?.text) continue;
    for (const difficulty of difficultySectionsWithNotes(version.chart.text)) {
      if (difficulty in slots && !slots[difficulty]) slots[difficulty] = version.id || "imported";
    }
  }
  return slots;
}

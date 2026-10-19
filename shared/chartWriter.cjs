"use strict";

const TRACK_SECTION_BY_DIFFICULTY = Object.freeze({
  easy: "EasySingle",
  medium: "MediumSingle",
  hard: "HardSingle",
  expert: "ExpertSingle",
});

// Moonscraper-style readers treat quoted metadata as raw, line-oriented text;
// they do not decode C-style escape sequences. Preserve quotes and backslashes
// verbatim, but flatten line breaks so one value cannot create a new chart line.
function normalizeChartValue(value) {
  return String(value ?? "").replace(/\r\n?|[\n\u2028\u2029]/g, " ");
}

function quotedChartField(name, value) {
  return `  ${name} = "${normalizeChartValue(value)}"`;
}

function writeChartText(noteLines, {
  title,
  artist,
  charter = "Autochart",
  genre = "",
  resolution = 192,
  offset = 0,
  syncLines = [],
  difficulty = "expert",
  // Optional structure markers: globalEvents [{tick, text}] go in [Events];
  // trackEvents [{tick, order, text}] go in the difficulty track, with notes
  // at order 1 (order 0 sorts before a tick's notes, 2 after).
  globalEvents = [],
  trackEvents = [],
} = {}) {
  const section = TRACK_SECTION_BY_DIFFICULTY[String(difficulty || "expert").toLowerCase()]
    || TRACK_SECTION_BY_DIFFICULTY.expert;
  const out = [
    "[Song]",
    "{",
    quotedChartField("Name", title || "Untitled"),
    quotedChartField("Artist", artist || "Unknown Artist"),
    quotedChartField("Charter", charter || "Autochart"),
    `  Offset = ${Number.isFinite(Number(offset)) ? Number(offset) : 0}`,
    `  Resolution = ${Number(resolution) || 192}`,
    quotedChartField("Player2", "bass"),
    "  Difficulty = 0",
    "  PreviewStart = 0",
    "  PreviewEnd = 0",
    quotedChartField("Genre", genre),
    quotedChartField("MediaType", "cd"),
    quotedChartField("MusicStream", "song.ogg"),
    "}",
    "[SyncTrack]",
    "{",
  ];
  for (const line of syncLines) {
    const clean = String(line).trim();
    if (clean) out.push(`  ${clean}`);
  }
  out.push("}", "[Events]", "{");
  for (const event of globalEvents || []) out.push(`  ${event.tick} = ${event.text}`);
  out.push("}", `[${section}]`, "{");
  const trackLines = [];
  for (const line of noteLines || []) {
    if (!Array.isArray(line) || line.length < 3) continue;
    trackLines.push({ tick: Number(line[0]), order: 1, text: `N ${line[1]} ${line[2]}` });
  }
  if (trackEvents && trackEvents.length) {
    for (const event of trackEvents) trackLines.push(event);
    // Stable sort: notes keep their given order within a tick.
    trackLines.sort((a, b) => a.tick - b.tick || a.order - b.order);
  }
  for (const line of trackLines) out.push(`  ${line.tick} = ${line.text}`);
  out.push("}", "");
  return { text: out.join("\n"), noteLineCount: (noteLines || []).length };
}

module.exports = {
  TRACK_SECTION_BY_DIFFICULTY,
  normalizeChartValue,
  writeChartText,
};

const DIFFICULTIES = ["easy", "medium", "hard", "expert"];
const unique = (values) => [...new Set(values.filter(Boolean))];
const clean = (value) => String(value ?? "").replace(/\r\n?|[\n\u2028\u2029]/g, " ").trim();

export function chartSongMetadata(text = "") {
  const body = text.match(/^\uFEFF?[ \t]*\[Song\]\s*\{[ \t]*\r?\n([^]*?)^[ \t]*\}/im)?.[1] || "";
  return Object.fromEntries(body.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*([^=]+?)\s*=\s*(.*?)\s*$/);
    return match ? [[match[1].toLowerCase(), match[2].replace(/^"(.*)"$/, "$1")]] : [];
  }));
}

export function chartDifficulties(text = "") {
  return DIFFICULTIES.filter((difficulty) => new RegExp(`^[ \t]*\\[${difficulty}Single\\][ \t]*$`, "im").test(text));
}

export function provenanceFromMetadata(metadata, text = "") {
  if (String(metadata.autochart_ai_generated).toLowerCase() !== "true") return null;
  const listed = String(metadata.autochart_generated_difficulties || "").toLowerCase().split(",").map((s) => s.trim());
  return {
    generatedDifficulties: chartDifficulties(text).filter((d) => !listed.some((s) => DIFFICULTIES.includes(s)) || listed.includes(d)),
    generators: String(metadata.autochart_generator || "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

// Explicit lineage takes precedence over the legacy source flag: final charts
// and handmade edits historically both used source: "generated".
export function chartProvenance(version, versions = [], visited = new Set()) {
  const empty = { generatedDifficulties: [], generators: [] };
  if (!version || visited.has(version)) return empty;
  const seen = new Set(visited).add(version);
  const text = version.chart?.text || "";
  const available = chartDifficulties(text);
  if (version.meta?.chartProvenance) {
    return {
      generatedDifficulties: available.filter((d) => version.meta.chartProvenance.generatedDifficulties?.includes(d)),
      generators: unique(version.meta.chartProvenance.generators || []),
    };
  }
  const slots = version.meta?.slotVersionIds || version.settings?.arrangement?.slots;
  if (slots) {
    return combinedProvenance(Object.fromEntries(Object.entries(slots).map(([d, id]) => [d, versions.find((v) => v.id === id)])), versions, seen);
  }
  const marked = provenanceFromMetadata(chartSongMetadata(text), text);
  if (marked) return marked;
  if (version.meta?.edited || version.provenance?.editedFromId) {
    const parentId = version.meta?.editedFromId || version.provenance?.editedFromId || version.parentId;
    const parent = versions.find((v) => v.id === parentId);
    if (parent) return chartProvenance(parent, versions, seen);
    // A retained generator ID is evidence even if the original take was deleted.
    if (!version.meta?.generatorId && !version.provenance?.generatorId) return empty;
  }
  if (version.source !== "generated" && !version.meta?.generatorId && !version.provenance?.generatorId) return empty;
  return {
    generatedDifficulties: available,
    generators: unique([version.meta?.generatorId || version.provenance?.generatorId]),
  };
}

export function combinedProvenance(slotVersions, versions = Object.values(slotVersions), visited = new Set()) {
  const generatedDifficulties = [];
  const generators = [];
  for (const difficulty of DIFFICULTIES) {
    const version = slotVersions[difficulty];
    if (!version) continue;
    const available = chartDifficulties(version.chart?.text);
    const sourceDifficulty = available.includes(difficulty) ? difficulty : [...DIFFICULTIES].reverse().find((d) => available.includes(d));
    const origin = chartProvenance(version, versions, visited);
    if (!origin.generatedDifficulties.includes(sourceDifficulty)) continue;
    generatedDifficulties.push(difficulty);
    generators.push(...origin.generators);
  }
  return { generatedDifficulties, generators: unique(generators) };
}

export function provenanceFields(provenance) {
  const generated = provenance.generatedDifficulties.length > 0;
  return {
    autochart_provenance_version: generated ? "1" : "",
    autochart_ai_generated: generated ? "true" : "",
    autochart_generated_difficulties: provenance.generatedDifficulties.join(","),
    autochart_generator: generated ? provenance.generators.join(",") : "",
  };
}

// Rewrite only Song metadata. Notes, timing, events and other tracks stay intact.
export function updateChartMetadata(text, fields) {
  return text.replace(/(^\uFEFF?[ \t]*\[Song\][ \t]*\r?\n[ \t]*\{[ \t]*)([^]*?)(^[ \t]*\})/im, (_, open, body, close) => {
    const pending = new Map(Object.entries(fields).map(([key, value]) => [key.toLowerCase(), [key, clean(value)]]));
    const lines = body.split(/\r?\n/).filter((line) => {
      const key = line.match(/^\s*([^=]+?)\s*=/)?.[1]?.toLowerCase();
      return !pending.has(key);
    });
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    while (lines.length && !lines[0].trim()) lines.shift();
    for (const [key, value] of pending.values()) {
      if (value) lines.push(`  ${key} = "${value}"`);
    }
    return `${open}\n${lines.join("\n")}\n${close}`;
  });
}

export function exportChartMetadata(version, songMeta = {}, versions = []) {
  const text = version.chart?.text || "";
  const provenance = chartProvenance(version, versions);
  const original = chartSongMetadata(text);
  const generated = provenance.generatedDifficulties.length > 0;
  const mixed = generated && (chartDifficulties(text).some((d) => !provenance.generatedDifficulties.includes(d)) || /^[ \t]*\[(?:Easy|Medium|Hard|Expert)(?!Single\])\w+\][ \t]*$/m.test(text));
  const originalCredit = clean(songMeta.charter || original.charter);
  let charter = originalCredit;
  if (generated) {
    const credits = mixed ? originalCredit.split(";").map((credit) => credit.trim()).filter(Boolean) : [];
    if (!credits.some((credit) => /^Autochart(?: \(AI-generated\))?$/i.test(credit))) credits.push("Autochart");
    charter = credits.join("; ");
  }
  // Old generated outputs used AI as a placeholder genre, never as music genre.
  const genre = songMeta.genre ?? (generated && original.genre === "AI" ? "" : original.genre || "");
  const fields = provenanceFields(provenance);
  return {
    chartText: updateChartMetadata(text, { Charter: charter, Genre: genre, ...fields }),
    meta: { ...songMeta, charter, genre, ...fields },
    provenance,
  };
}

import { FINAL_SLOT_ORDER } from "./finalChart.js";

// What a chart run needs to know about its generator and project, shared by a
// project's Generate and the queue.

// The stem set a generator separates with: v1's htdemucs stems unless the
// generator names its own (the six-stem models: htdemucs_6s).
export function generatorStemSetId(generator = null) {
  const separation = generator?.separation || {};
  return separation.cacheSubdir ? String(separation.stemSet || separation.cacheSubdir) : "htdemucs";
}

// False for a model that reads only the mix (Lite): its runs skip separation.
export function readsStems(generator) {
  return generator?.capabilities?.usesStemCache !== false;
}

// One separation can hold a stem set per separation model; `stems` is v1's.
export function separationStemSet(artifact, stemSetId = "htdemucs") {
  const fromSet = artifact?.stemSets?.[stemSetId]?.stems;
  if (fromSet && Object.keys(fromSet).length) return fromSet;
  return stemSetId === "htdemucs" ? artifact?.stems || {} : {};
}

// Whether a separation holds this stem set: its stems, or (usually) only
// their mel tables, which is all charts need.
export function hasSeparation(artifact, stemSetId = "htdemucs") {
  if (artifact?.stemSets?.[stemSetId]?.melTables) return true;
  return Object.values(separationStemSet(artifact, stemSetId)).some((stem) => stem?.path);
}

export function generatorDifficultyIds(generator) {
  const raw = Array.isArray(generator?.capabilities?.difficulties)
    ? generator.capabilities.difficulties
    : [];
  const supported = raw
    .map((value) => String(value || "").trim().toLowerCase())
    .filter((value) => FINAL_SLOT_ORDER.includes(value));
  return supported.length ? supported : FINAL_SLOT_ORDER;
}

export function sourceChartPayloadFromVersions(versions = [], importedSong = null) {
  const sourceVersion = versions.find((v) => v.source === "imported-chart" && v.chart?.text) || null;
  const chartText = sourceVersion?.chart?.text || (importedSong?.source !== "generated" ? importedSong?.chart?.text : "") || "";
  if (!chartText) return null;
  return {
    text: chartText,
    versionId: sourceVersion?.id || "imported",
    name: sourceVersion?.name || "Imported Clone Hero",
  };
}

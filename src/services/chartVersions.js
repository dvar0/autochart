import { combinedProvenance, provenanceFields, updateChartMetadata } from "../../shared/chartProvenance.js";
import { TRACK_BY_DIFFICULTY, parseChart } from "../lib/chart/parseChart.js";
import { generationVersionName } from "../data/generationSettings.js";
import { newVersionId } from "./songSchema.js";
import { buildGeneratedVersion } from "../../shared/generatedVersion.js";

function sectionNameForDifficulty(difficulty = "expert") {
  return TRACK_BY_DIFFICULTY[difficulty] || TRACK_BY_DIFFICULTY.expert;
}

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


function removeSection(text, sectionName) {
  const lines = text.split(/\r?\n/);
  const section = findSection(lines, sectionName);
  if (!section) return text;
  return [...lines.slice(0, section.header), ...lines.slice(section.close + 1)].join("\n");
}

function removeDifficultySections(chartText) {
  const sectionNames = Object.values(TRACK_BY_DIFFICULTY);
  return sectionNames.reduce((text, sectionName) => removeSection(text, sectionName), chartText);
}

function songTimingValues(lines) {
  const values = { resolution: 192, offset: 0 };
  const section = findSection(lines, "Song");
  if (!section) return values;
  for (let i = section.bodyStart; i < section.bodyEnd; i++) {
    const match = lines[i].trim().match(/^(Resolution|Offset)\s*=\s*(.+)$/i);
    if (!match) continue;
    const value = Number(match[2]);
    const key = match[1].toLowerCase();
    if (Number.isFinite(value) && (key !== "resolution" || value > 0)) values[key] = value;
  }
  return values;
}

export function chartTimingSignature(chartText = "") {
  const lines = String(chartText || "").split(/\r?\n/);
  const section = findSection(lines, "SyncTrack");
  if (!section) return "";
  const body = lines
    .slice(section.bodyStart, section.bodyEnd)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  if (!body) return "";
  // Resolution and offset both affect playback, even when sync lines match.
  const song = songTimingValues(lines);
  return `res:${song.resolution};offset:${song.offset}\n${body}`;
}

export function versionTimingSignature(version = null) {
  return chartTimingSignature(version?.chart?.text || "");
}

function versionSourceVariantKey(version = null) {
  return version?.meta?.sourceVariantKey || version?.provenance?.sourceTransform?.key || "lead-in:0";
}


function playableNoteCount(chartText, difficulty = "expert") {
  try {
    const chart = parseChart(chartText);
    let chosen = difficulty;
    if (!chart.tracks[chosen]) {
      const order = ["expert", "hard", "medium", "easy"];
      chosen = order.find((d) => chart.tracks[d]) || Object.keys(chart.tracks)[0];
    }
    return chart.tracks[chosen]?.notes?.length || 0;
  } catch {
    return 0;
  }
}

export function createGeneratedVersionFromResult(result, baseVersion, settings, index = 1) {
  const difficulty = settings.difficulty || baseVersion?.settings?.difficulty || "expert";
  const generatorLabel = result.generatorLabel || result.provenance?.generatorLabel || settings.model || "Generated";
  const effectiveGeneration = result.generation || result.provenance?.generation || settings.generation || null;
  return buildGeneratedVersion(result, baseVersion, settings, index, {
    id: newVersionId("gen"),
    name: generationVersionName(generatorLabel, effectiveGeneration, index),
    noteCount: playableNoteCount(result?.chartText, difficulty) || Number(result.report?.event_count || result.metrics?.eventCount || 0),
  });
}


function sectionBodyLines(chartText, sectionName) {
  const lines = chartText.split(/\r?\n/);
  const section = findSection(lines, sectionName);
  return section ? lines.slice(section.bodyStart, section.bodyEnd) : null;
}

function firstPlayableSectionBody(chartText, preferredDifficulty = "expert") {
  const preferred = sectionNameForDifficulty(preferredDifficulty);
  const sectionNames = [
    preferred,
    TRACK_BY_DIFFICULTY.expert,
    TRACK_BY_DIFFICULTY.hard,
    TRACK_BY_DIFFICULTY.medium,
    TRACK_BY_DIFFICULTY.easy,
  ].filter((name, index, names) => name && names.indexOf(name) === index);
  for (const sectionName of sectionNames) {
    const body = sectionBodyLines(chartText, sectionName);
    if (body) return body;
  }
  return null;
}

function replaceOrAppendSection(chartText, sectionName, body) {
  const lines = chartText.split(/\r?\n/);
  const section = findSection(lines, sectionName);
  if (section) {
    const before = lines.slice(0, section.bodyStart);
    const after = lines.slice(section.bodyEnd);
    return [...before, ...body, ...after].join("\n");
  }
  const trimmed = chartText.replace(/\s*$/, "");
  return `${trimmed}\n[${sectionName}]\n{\n${body.join("\n")}\n}\n`;
}

function highestPreviewDifficulty(difficulties) {
  return ["expert", "hard", "medium", "easy"].find((d) => difficulties.includes(d)) || "expert";
}

/**
 * Compile chosen candidate versions into one Clone Hero chart with multiple
 * difficulty sections. Candidate generators may emit only ExpertSingle; the UI
 * slot assignment is the source of truth for the target section.
 */
export function createFinalChartVersion({
  id = "final_chart",
  name = "Final Chart",
  baseVersion = null,
  slotVersions = {},
  versions = Object.values(slotVersions),
  previousVersion = null,
} = {}) {
  const assigned = Object.entries(slotVersions).filter(([, version]) => version?.chart?.text);
  if (!assigned.length) throw new Error("Assign at least one difficulty before building the final chart.");

  const firstVersion = assigned[0][1];
  const firstSourceVariantKey = versionSourceVariantKey(firstVersion);
  const sourceMismatch = assigned.find(([, version]) => versionSourceVariantKey(version) !== firstSourceVariantKey);
  if (sourceMismatch) {
    throw new Error(
      "Final chart needs one shared source audio. Assign takes generated with the same lead-in silence before exporting."
    );
  }
  const firstTimingSignature = chartTimingSignature(firstVersion.chart.text);
  const mismatch = assigned.find(([, version]) => chartTimingSignature(version.chart.text) !== firstTimingSignature);
  if (mismatch) {
    throw new Error(
      "Final chart needs one shared beatmap. Assign takes with the same timing grid before exporting."
    );
  }

  // Prefer an assigned imported chart as the base text: its [Song] metadata,
  // [Events] (practice sections) and any non-lead tracks are the authoritative
  // song scaffolding, and generated takes only carry a bare header. The timing
  // guard above keeps its [SyncTrack] identical to every assigned take's.
  const importedAssigned = assigned.find(([, version]) => version.source === "imported-chart");
  const baseAssigned = importedAssigned || assigned[0];
  let chartText = removeDifficultySections(baseAssigned[1].chart.text);
  const assignedDifficulties = [];
  const slotVersionIds = {};

  for (const [difficulty, version] of assigned) {
    // The slot's own section first: an imported multi-difficulty chart must
    // contribute the body matching the slot, never its hardest section.
    const body = firstPlayableSectionBody(version.chart.text, difficulty);
    if (!body) continue;
    chartText = replaceOrAppendSection(chartText, sectionNameForDifficulty(difficulty), body);
    assignedDifficulties.push(difficulty);
    slotVersionIds[difficulty] = version.id;
  }

  if (!assignedDifficulties.length) {
    throw new Error("Assigned candidates do not contain playable chart sections.");
  }

  const difficulty = highestPreviewDifficulty(assignedDifficulties);
  const noteCount = assignedDifficulties.reduce(
    (sum, diff) => sum + playableNoteCount(chartText, diff),
    0
  );

  const origin = combinedProvenance(slotVersions, versions);
  chartText = updateChartMetadata(chartText, provenanceFields(origin));

  return {
    id,
    name,
    source: "generated",
    status: "charted",
    parentId: baseVersion?.id || firstVersion.id || "imported",
    createdAt: previousVersion?.createdAt || Date.now(),
    updatedAt: Date.now(),
    settings: {
      difficulty,
      style: "final",
      intensity: 0.5,
      model: "Final Chart",
      arrangement: {
        kind: "difficulty-slots",
        slots: slotVersionIds,
      },
    },
    meta: {
      noteCount,
      durationSec: firstVersion.meta?.durationSec || baseVersion?.meta?.durationSec || 0,
      availableDifficulties: assignedDifficulties,
      slotVersionIds,
      chartProvenance: origin,
      sourceVariantKey: firstVersion.meta?.sourceVariantKey || firstVersion.provenance?.sourceTransform?.key || "lead-in:0",
      sourceVariantLabel: firstVersion.meta?.sourceVariantLabel || firstVersion.provenance?.sourceTransform?.label || "No lead-in",
      leadInSilenceMs: firstVersion.meta?.leadInSilenceMs || firstVersion.provenance?.sourceTransform?.leadInSilenceMs || 0,
      analysisAudioSha256: firstVersion.meta?.analysisAudioSha256 || firstVersion.meta?.audioSha256 || null,
      analysisAudioPath: firstVersion.meta?.analysisAudioPath || null,
      timingDetector: firstVersion.meta?.timingDetector || firstVersion.settings?.generation?.resolved?.detector || null,
      timingRaw: Boolean(firstVersion.meta?.timingRaw || firstVersion.settings?.generation?.resolved?.timingRaw),
      timingSmoothing: Boolean(
        firstVersion.meta?.timingSmoothing ?? firstVersion.settings?.generation?.resolved?.timingSmoothing?.enabled
      ),
    },
    chart: { text: chartText },
  };
}

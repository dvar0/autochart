import { DIFF } from "../data/difficultyMetadata.js";
import {
  SOURCE_CHART_TIMING_DETECTOR_ID,
  timingDetectorLabel,
  timingDetectorOptionFromResolved,
  timingSmoothingEnabledFromGeneration,
} from "../data/generationSettings.js";
import { createFinalChartVersion, versionTimingSignature } from "./chartVersions.js";
import { importedFinalSlotSeed } from "../../shared/finalSlots.js";

export const FINAL_ARRANGEMENT_ID = "arr_final";
export const FINAL_VERSION_ID = "final_chart";
export const FINAL_SLOT_ORDER = ["easy", "medium", "hard", "expert"];
export const FINAL_SLOT_DISPLAY_ORDER = ["expert", "hard", "medium", "easy"];

export function emptyFinalSlots(order = FINAL_SLOT_ORDER) {
  return order.reduce((slots, difficulty) => ({ ...slots, [difficulty]: "" }), {});
}

export function cleanFinalSlots(slots = {}, versions = [], order = FINAL_SLOT_ORDER) {
  const versionIds = new Set(versions.map((version) => version.id));
  return order.reduce((next, difficulty) => {
    const versionId = slots?.[difficulty] || "";
    next[difficulty] = versionId && versionIds.has(versionId) ? versionId : "";
    return next;
  }, {});
}

export function getVersionDifficulty(version, fallback = "expert") {
  return version?.settings?.difficulty || version?.difficulty || fallback;
}

export function versionSourceVariantKey(version = null) {
  return version?.meta?.sourceVariantKey || version?.provenance?.sourceTransform?.key || "lead-in:0";
}

function versionSourceVariantLabel(version = null) {
  return version?.meta?.sourceVariantLabel || version?.provenance?.sourceTransform?.label || "No lead-in";
}

function versionTimingLabel(version) {
  if (!version || version.source !== "generated") return "imported timing";
  const generation = version.settings?.generation || {};
  const controls = generation.controls || {};
  const resolved = generation.resolved || {};
  const timingDetector = controls.timingDetector || timingDetectorOptionFromResolved(resolved);
  const label = timingDetectorLabel(timingDetector);
  if (timingDetector === SOURCE_CHART_TIMING_DETECTOR_ID) return label;
  return `${label} (${timingSmoothingEnabledFromGeneration(generation) ? "smoothed" : "raw grid"})`;
}

function assignedSlotEntries(slotVersions = {}, order = FINAL_SLOT_ORDER) {
  return order
    .map((difficulty) => [difficulty, slotVersions[difficulty]])
    .filter(([, version]) => version?.chart?.text);
}

export function finalTimingMismatchMessage(slotVersions = {}, order = FINAL_SLOT_ORDER) {
  const assigned = assignedSlotEntries(slotVersions, order);
  if (assigned.length < 2) return "";
  const [firstDifficulty, firstVersion] = assigned[0];
  const firstSignature = versionTimingSignature(firstVersion);
  const mismatch = assigned.find(([, version]) => versionTimingSignature(version) !== firstSignature);
  if (!mismatch) return "";
  const [otherDifficulty, otherVersion] = mismatch;
  return `Final chart needs one shared beatmap. ${DIFF[firstDifficulty]?.name || firstDifficulty} uses ${versionTimingLabel(firstVersion)}; ${DIFF[otherDifficulty]?.name || otherDifficulty} uses ${versionTimingLabel(otherVersion)}.`;
}

export function finalSourceVariantMismatchMessage(slotVersions = {}, order = FINAL_SLOT_ORDER) {
  const assigned = assignedSlotEntries(slotVersions, order);
  if (assigned.length < 2) return "";
  const [firstDifficulty, firstVersion] = assigned[0];
  const firstKey = versionSourceVariantKey(firstVersion);
  const mismatch = assigned.find(([, version]) => versionSourceVariantKey(version) !== firstKey);
  if (!mismatch) return "";
  const [otherDifficulty, otherVersion] = mismatch;
  return `Final chart needs one shared source audio. ${DIFF[firstDifficulty]?.name || firstDifficulty} uses ${versionSourceVariantLabel(firstVersion)}; ${DIFF[otherDifficulty]?.name || otherDifficulty} uses ${versionSourceVariantLabel(otherVersion)}.`;
}

export function finalValidationMessage(slotVersions = {}, order = FINAL_SLOT_ORDER) {
  return finalSourceVariantMismatchMessage(slotVersions, order) || finalTimingMismatchMessage(slotVersions, order);
}

export function inferFinalSlots(versions = [], order = FINAL_SLOT_ORDER) {
  const slots = emptyFinalSlots(order);
  // Generated takes claim their own difficulty first…
  for (const version of versions) {
    if (version.id === FINAL_VERSION_ID || version.source !== "generated" || version.status === "draft") continue;
    const difficulty = getVersionDifficulty(version);
    if (difficulty in slots && !slots[difficulty]) slots[difficulty] = version.id;
  }
  // …then the difficulties the imported chart already ships fill what is left.
  // The whole point of importing is keeping the original difficulties (many
  // songs ship Expert only) next to the generated easier ones, so without this
  // an import + one generated take would export without the original chart.
  const seed = importedFinalSlotSeed(versions, order);
  for (const difficulty of order) {
    if (!slots[difficulty] && seed[difficulty]) slots[difficulty] = seed[difficulty];
  }
  return slots;
}

export function finalSlotsFromRecord(record, versions = [], { infer = true, order = FINAL_SLOT_ORDER } = {}) {
  const arrangements = Array.isArray(record?.arrangements) ? record.arrangements : [];
  const arrangement = arrangements.find((item) => item.id === FINAL_ARRANGEMENT_ID);
  const finalVersion = record?.versions?.find((version) => version.id === FINAL_VERSION_ID);
  const cleaned = cleanFinalSlots(arrangement?.slots || finalVersion?.meta?.slotVersionIds || {}, versions, order);
  return infer && !Object.values(cleaned).some(Boolean) ? inferFinalSlots(versions, order) : cleaned;
}

export function buildFinalSlotVersions(slots = {}, versions = [], order = FINAL_SLOT_ORDER) {
  const sourceVersions = versions.filter((version) => version.id !== FINAL_VERSION_ID);
  return order.reduce((map, difficulty) => {
    map[difficulty] = sourceVersions.find((version) => version.id === slots[difficulty]) || null;
    return map;
  }, {});
}

export function buildFinalArrangementList(record, slots, versions = [], order = FINAL_SLOT_ORDER) {
  const now = Date.now();
  const existing = Array.isArray(record?.arrangements) ? record.arrangements : [];
  const current = existing.find((item) => item.id === FINAL_ARRANGEMENT_ID);
  const cleanSlots = cleanFinalSlots(slots, versions, order);
  const assigned = order.filter((difficulty) => cleanSlots[difficulty]);
  return [
    ...existing.filter((item) => item.id !== FINAL_ARRANGEMENT_ID),
    {
      id: FINAL_ARRANGEMENT_ID,
      name: "Final Chart",
      kind: "difficulty-slots",
      status: assigned.length ? "ready" : "draft",
      createdAt: current?.createdAt || now,
      updatedAt: now,
      slots: cleanSlots,
      difficulties: assigned,
    },
  ];
}

export function buildFinalChartVersion({
  id = FINAL_VERSION_ID,
  name = "Final Chart",
  versions = [],
  slots = {},
  baseVersion = null,
  previousVersion = null,
} = {}) {
  const sourceVersions = versions.filter((version) => version.id !== FINAL_VERSION_ID && version.chart?.text);
  const cleanSlots = cleanFinalSlots(slots, sourceVersions);
  const slotVersions = buildFinalSlotVersions(cleanSlots, sourceVersions);
  const assignedCount = Object.values(slotVersions).filter(Boolean).length;
  if (!assignedCount) throw new Error("Assign at least one difficulty before building the final chart.");
  const validationMessage = finalValidationMessage(slotVersions);
  if (validationMessage) throw new Error(validationMessage);
  const resolvedBaseVersion = baseVersion || sourceVersions.find((version) => version.source === "imported-chart") || sourceVersions[0] || null;
  const finalVersion = createFinalChartVersion({
    id,
    name,
    baseVersion: resolvedBaseVersion,
    slotVersions,
    versions: sourceVersions,
    previousVersion,
  });
  return {
    sourceVersions,
    slots: cleanSlots,
    slotVersions,
    finalVersion,
    versionsWithFinal: [...sourceVersions, finalVersion],
  };
}

import { DIFF } from "../data/difficultyMetadata.js";
import { t } from "../i18n/index.js";
import { leadInText } from "../pages/generate/separationNames.js";
import {
  SOURCE_CHART_TIMING_DETECTOR_ID,
  timingDetectorLabel,
  timingDetectorOptionFromResolved,
  timingSmoothingEnabledFromGeneration,
  usesOlderTimingSmoother,
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
  if (!version || version.source !== "generated") return t("imported timing");
  const generation = version.settings?.generation || {};
  const controls = generation.controls || {};
  const resolved = generation.resolved || {};
  const timingDetector = controls.timingDetector || timingDetectorOptionFromResolved(resolved);
  const label = timingDetectorLabel(timingDetector);
  if (timingDetector === SOURCE_CHART_TIMING_DETECTOR_ID) return label;
  if (!timingSmoothingEnabledFromGeneration(generation)) return t("{timing} (raw grid)", { timing: label });
  return usesOlderTimingSmoother(generation)
    ? t("{timing} (old smoothing)", { timing: label })
    : t("{timing} (smoothed)", { timing: label });
}

function assignedSlotEntries(slotVersions = {}, order = FINAL_SLOT_ORDER) {
  return order
    .map((difficulty) => [difficulty, slotVersions[difficulty]])
    // Library listings say whether a take has a chart instead of carrying it.
    .filter(([, version]) => version?.chart?.text || version?.chart?.hasText);
}

export function finalTimingMismatchMessage(slotVersions = {}, order = FINAL_SLOT_ORDER) {
  const assigned = assignedSlotEntries(slotVersions, order);
  if (assigned.length < 2) return "";
  const [firstDifficulty, firstVersion] = assigned[0];
  const firstSignature = versionTimingSignature(firstVersion);
  const mismatch = assigned.find(([, version]) => versionTimingSignature(version) !== firstSignature);
  if (!mismatch) return "";
  const [otherDifficulty, otherVersion] = mismatch;
  const olderTiming = (version) => version.source === "generated" && usesOlderTimingSmoother(version.settings?.generation || {});
  if (firstVersion.source === "generated" && otherVersion.source === "generated" && olderTiming(firstVersion) !== olderTiming(otherVersion)) {
    const [oldDifficulty, newDifficulty] = olderTiming(firstVersion) ? [firstDifficulty, otherDifficulty] : [otherDifficulty, firstDifficulty];
    const oldName = DIFF[oldDifficulty]?.name || oldDifficulty;
    return t("{old} was made with older timing, so it can't share a final chart with {other}. Generate {old} again to use them together.", { old: oldName, other: DIFF[newDifficulty]?.name || newDifficulty });
  }
  return t("Final chart needs one shared beatmap. {first} uses {firstTiming}; {other} uses {otherTiming}.", {
    first: DIFF[firstDifficulty]?.name || firstDifficulty,
    firstTiming: versionTimingLabel(firstVersion),
    other: DIFF[otherDifficulty]?.name || otherDifficulty,
    otherTiming: versionTimingLabel(otherVersion),
  });
}

export function finalSourceVariantMismatchMessage(slotVersions = {}, order = FINAL_SLOT_ORDER) {
  const assigned = assignedSlotEntries(slotVersions, order);
  if (assigned.length < 2) return "";
  const [firstDifficulty, firstVersion] = assigned[0];
  const firstKey = versionSourceVariantKey(firstVersion);
  const mismatch = assigned.find(([, version]) => versionSourceVariantKey(version) !== firstKey);
  if (!mismatch) return "";
  const [otherDifficulty, otherVersion] = mismatch;
  return t("Final chart needs one shared source audio. {first} uses {firstAudio}; {other} uses {otherAudio}.", {
    first: DIFF[firstDifficulty]?.name || firstDifficulty,
    firstAudio: leadInText(versionSourceVariantLabel(firstVersion)),
    other: DIFF[otherDifficulty]?.name || otherDifficulty,
    otherAudio: leadInText(versionSourceVariantLabel(otherVersion)),
  });
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
  // …then edited takes, so a project whose only take of a difficulty is an
  // edit can still export it. An edit of an imported chart is left out: it
  // doesn't say which of the chart's difficulties it changed.
  for (const version of versions) {
    if (version.id === FINAL_VERSION_ID || version.source !== "generated" || version.status !== "draft") continue;
    const parent = versions.find((item) => item.id === version.parentId);
    if (parent?.source === "imported-chart") continue;
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

// The final chart after `source` is first edited into the new take `edit`
// (difficulty: the one edited). What the source held goes to the edit, since
// an edit is what's meant to be exported; an imported chart only gives up the
// difficulty that was edited. An edit holding nothing takes the edited
// difficulty if no take has it, as a new generated take would.
export function slotsAfterEdit(slots = {}, source = null, edit = null, difficulty = "", versions = [], order = FINAL_SLOT_ORDER) {
  const next = { ...emptyFinalSlots(order), ...slots };
  if (!edit) return cleanFinalSlots(next, versions, order);
  const imported = source?.source === "imported-chart";
  for (const slot of order) {
    if (source && next[slot] === source.id && (!imported || slot === difficulty)) next[slot] = edit.id;
  }
  if (difficulty in next && !next[difficulty] && !order.some((slot) => next[slot] === edit.id)) next[difficulty] = edit.id;
  return cleanFinalSlots(next, versions, order);
}

// The final chart after the take `removed` is deleted (versions: the takes
// left). Each difficulty it held goes to the newest edit made from it, else to
// the take the project would pick on its own, so deleting a take doesn't
// quietly leave nothing to export. A generated take still holds one
// difficulty at most.
export function slotsAfterRemoval(slots = {}, removed = null, versions = [], order = FINAL_SLOT_ORDER) {
  const next = cleanFinalSlots(slots, versions, order);
  if (!removed) return next;
  const used = () => new Set(order.map((slot) => next[slot]).filter(Boolean));
  const edits = versions
    .filter((version) => version.parentId === removed.id || version.meta?.editedFromId === removed.id)
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  // A removed edit hands its place back to the take it was made from.
  const parentId = removed.meta?.editedFromId || removed.parentId;
  const parent = parentId ? versions.find((version) => version.id === parentId) : null;
  const inferred = inferFinalSlots(versions, order);
  const fits = (version, slot, taken) =>
    version && (version.source === "imported-chart" || (!taken.has(version.id) && getVersionDifficulty(version) === slot));
  for (const slot of order) {
    if (slots?.[slot] !== removed.id) continue;
    const taken = used();
    const heir = edits.find((version) => fits(version, slot, taken) && version.source !== "imported-chart");
    const pick = versions.find((version) => version.id === inferred[slot]);
    if (heir) next[slot] = heir.id;
    else if (fits(parent, slot, taken)) next[slot] = parent.id;
    else if (pick && (pick.source === "imported-chart" || !taken.has(pick.id))) next[slot] = pick.id;
  }
  return next;
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
  if (!assignedCount) throw new Error(t("Assign at least one difficulty before building the final chart."));
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

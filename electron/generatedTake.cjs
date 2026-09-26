const libraryStore = require("./libraryStore.cjs");

// Commit before replying to the renderer. A navigation, reload, or lost IPC
// listener cannot turn a successfully generated chart into an orphaned result.
async function persistGeneratedTake(context, projectId, result, input = {}) {
  if (result.status !== "completed" || !result.chartText) return result;
  if (typeof result.jobId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(result.jobId)) {
    throw new Error("Completed generation must include a valid job id.");
  }
  const { buildGeneratedVersion } = await import("../shared/generatedVersion.js");
  const { importedFinalSlotSeed } = await import("../shared/finalSlots.js");
  let savedVersion;
  await libraryStore.updateSong(context, projectId, (record) => {
    let versions = record.versions || [];
    if (record.source === "imported-chart" && record.chart?.text &&
        !versions.some(version => version.source === "imported-chart" && version.chart?.text)) {
      versions = [{ id: "imported", name: "Imported chart", source: "imported-chart",
        status: "charted", chart: { text: record.chart.text }, settings: record.settings || {},
      }, ...versions];
    }
    savedVersion = versions.find(version =>
      version.provenance?.jobId === result.jobId ||
      (result.provenance?.jobPath && version.provenance?.jobPath === result.provenance.jobPath)
    );
    if (savedVersion) return null;
    const count = versions.filter(version => version.source === "generated").length + 1;
    const base = versions.find(version => version.id === input.parentVersionId) || versions[0];
    const difficulty = input.difficulty || result.generation?.resolved?.difficulty || "expert";
    savedVersion = buildGeneratedVersion(result, base, {
      difficulty, generation: input.generation,
      sourceTransform: result.sourceTransform,
    }, count, { id: `gen_${result.jobId.replaceAll("-", "")}`, name: typeof input.versionName === "string" ? input.versionName : undefined });
    const now = Date.now();
    const arrangements = [...(record.arrangements || [])];
    const finalIndex = arrangements.findIndex(item => item.id === "arr_final");
    const final = arrangements[finalIndex] || {
      id: "arr_final", name: "Final Chart", kind: "difficulty-slots", createdAt: now,
      slots: { easy: "", medium: "", hard: "", expert: "" },
    };
    // Seed difficulties the imported chart already ships (Expert-only songs are
    // the norm) so the final chart keeps them next to the generated take. This
    // mirrors inferFinalSlots() in the renderer, which cannot run here: the
    // renderer may have reloaded or navigated away by the time we commit.
    const slots = importedFinalSlotSeed(versions);
    for (const [slot, versionId] of Object.entries(final.slots || {})) {
      if (versionId) slots[slot] = versionId;
    }
    slots[difficulty] = final.slots?.[difficulty] || savedVersion.id;
    const nextFinal = { ...final, slots, status: "ready", updatedAt: now, difficulties: Object.keys(slots).filter(key => slots[key]) };
    if (finalIndex < 0) arrangements.push(nextFinal);
    else arrangements[finalIndex] = nextFinal;
    let sourceArtifacts = record.sourceArtifacts || {};
    if (result.sourceSeparation) {
      const separation = result.sourceSeparation;
      const key = result.sourceTransform?.key || "lead-in:0";
      const id = key === "lead-in:0" || separation.id !== "demucs_default"
        ? separation.id : `demucs_default__${key.replace(/[^a-z0-9]+/gi, "_")}`;
      const artifact = { ...separation, id, engineId: separation.id, status: "ready", createdAt: now, updatedAt: now, sourceTransform: result.sourceTransform, sourceVariantKey: key };
      const demucs = sourceArtifacts.demucs || {};
      sourceArtifacts = { ...sourceArtifacts, demucs: {
        ...demucs,
        activeId: key === "lead-in:0" ? id : demucs.activeId || "demucs_default",
        activeBySourceVariant: { ...demucs.activeBySourceVariant, [key]: id },
        items: [artifact, ...(demucs.items || []).filter(item => item.id !== id)],
      } };
    }
    return { record: {
      ...record, updatedAt: now, status: "charted",
      versions: [...versions, savedVersion], arrangements, sourceArtifacts,
      settings: {
        ...record.settings, difficulty,
        generation: input.generation || savedVersion.settings.generation,
        ...(result.sourceTransform ? { sourceTransform: result.sourceTransform } : {}),
        ...(result.sourceSeparation ? { demucsSeparation: result.sourceSeparation } : {}),
        activeVersionId: savedVersion.id,
      },
      ...(!record.chart?.text ? {
        chart: { text: result.chartText },
        meta: { ...record.meta, noteCount: savedVersion.meta.noteCount, durationSec: savedVersion.meta.durationSec, availableDifficulties: [difficulty] },
      } : {}),
    } };
  });
  return { ...result, savedVersion, savedProjectId: projectId };
}

module.exports = { persistGeneratedTake };

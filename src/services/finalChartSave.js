import {
  FINAL_ARRANGEMENT_ID,
  FINAL_VERSION_ID,
  buildFinalArrangementList,
  buildFinalChartVersion,
  finalSlotsFromRecord,
} from "./finalChart.js";
import { updateSongRecord } from "./songLibrary.js";

// Rebuilds a saved project's final chart from its slots and stores it, ready to
// export. Throws with the reason when its takes can't share a final chart.
export async function ensureFinalVersionSaved(record) {
  const versions = Array.isArray(record?.versions) ? record.versions : [];
  const previousFinalVersion = versions.find((version) => version.id === FINAL_VERSION_ID) || null;
  const { slots, finalVersion, versionsWithFinal } = buildFinalChartVersion({
    versions,
    slots: finalSlotsFromRecord(record, versions.filter((version) => version.id !== FINAL_VERSION_ID && version.chart?.text)),
    previousVersion: previousFinalVersion,
  });
  await updateSongRecord(record.id, {
    versions: versionsWithFinal,
    arrangements: buildFinalArrangementList(record, slots, versionsWithFinal),
    settings: {
      ...(record.settings || {}),
      activeVersionId: finalVersion.id,
      activeArrangementId: FINAL_ARRANGEMENT_ID,
    },
    meta: {
      availableDifficulties: finalVersion.meta.availableDifficulties || [],
      noteCount: finalVersion.meta.noteCount || record.meta?.noteCount || 0,
      durationSec: finalVersion.meta.durationSec || record.meta?.durationSec || 0,
    },
  });
  return finalVersion;
}

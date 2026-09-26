import { chartSongMetadata, chartDifficulties, provenanceFields, updateChartMetadata } from "./chartProvenance.js";

// Shared by the renderer and Electron's durable generation completion handler.
export function countGeneratedNotes(text, difficulty = "expert") {
  const section = `${difficulty[0].toUpperCase()}${difficulty.slice(1)}Single`;
  let active = false;
  const ticks = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const header = line.trim().match(/^\[(.+)\]$/);
    if (header) active = header[1] === section;
    if (!active) continue;
    const note = line.match(/^\s*(\d+)\s*=\s*N\s+([0-4]|7)\s+\d+/);
    if (note) ticks.add(Number(note[1]));
  }
  return ticks.size;
}

export function buildGeneratedVersion(result, baseVersion, settings, index = 1, options = {}) {
  let chartText = result?.chartText || "";
  if (!chartText) throw new Error("Generation completed without chart text.");
  const chartOrigin = {
    generatedDifficulties: chartDifficulties(chartText),
    generators: [result.generatorId || result.provenance?.generatorId].filter(Boolean),
  };
  chartText = updateChartMetadata(chartText, {
    Charter: "Autochart",
    ...(chartSongMetadata(chartText).genre === "AI" ? { Genre: "" } : {}),
    ...provenanceFields(chartOrigin),
  });
  const difficulty = settings.difficulty || baseVersion?.settings?.difficulty || "expert";
  const generatorLabel = result.generatorLabel || result.provenance?.generatorLabel || settings.model || "Generated";
  const report = result.report || {};
  const noteCount = options.noteCount ?? (countGeneratedNotes(chartText, difficulty) || Number(report.event_count || result.metrics?.eventCount || 0));
  const durationSec =
    Number(report.package_validation?.audio_duration_seconds || result.metrics?.packageValidation?.audio_duration_seconds || 0) ||
    baseVersion?.meta?.durationSec || 0;
  const effectiveGeneration = result.generation || result.provenance?.generation || settings.generation || null;
  const sourceSeparation = result.sourceSeparation || result.provenance?.sourceSeparation || settings.demucsSeparation || null;
  const sourceTransform = result.sourceTransform || result.provenance?.sourceTransform || settings.sourceTransform || null;
  const provenance = {
    ...(result.provenance || {}),
    ...(result.jobId ? { jobId: result.jobId } : {}),
    ...(settings.generation ? { uiGeneration: settings.generation } : {}),
    ...(effectiveGeneration ? { generation: effectiveGeneration } : {}),
    ...(sourceSeparation ? { sourceSeparation } : {}),
    ...(sourceTransform ? { sourceTransform } : {}),
  };
  return {
    id: options.id || `gen_${crypto.randomUUID().replaceAll("-", "")}`,
    name: options.name || `${generatorLabel} ${difficulty[0].toUpperCase()}${difficulty.slice(1)} #${index}`,
    source: "generated",
    status: "charted",
    parentId: baseVersion?.id || "imported",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    settings: { difficulty, model: generatorLabel, ...(effectiveGeneration ? { generation: effectiveGeneration } : {}) },
    meta: {
      noteCount, durationSec, runNumber: index,
      chartProvenance: chartOrigin,
      generatorId: result.generatorId || null,
      audioSha256: result.audioSha256 || null,
      demucsId: sourceSeparation?.id || null,
      demucsName: sourceSeparation?.name || null,
      sourceVariantKey: sourceTransform?.key || "lead-in:0",
      sourceVariantLabel: sourceTransform?.label || "No lead-in",
      leadInSilenceMs: sourceTransform?.leadInSilenceMs || 0,
      analysisAudioSha256: result.analysisAudioSha256 || result.audioSha256 || null,
      analysisAudioPath: result.analysisAudioPath || result.cache?.analysisAudioPath || null,
      timingDetector: effectiveGeneration?.resolved?.detector || null,
      timingRaw: Boolean(effectiveGeneration?.resolved?.timingRaw),
      timingSmoothing: Boolean(effectiveGeneration?.resolved?.timingSmoothing?.enabled),
    },
    provenance,
    metrics: {
      ...(result.metrics || {}),
      tokenStats: report.token_stats || result.metrics?.tokenStats || null,
      chartValidation: report.chart_validation || result.metrics?.chartValidation || null,
      packageValidation: report.package_validation || result.metrics?.packageValidation || null,
      eventCopy: report.event_copy || null,
      tokenDecode: report.token_decode || null,
    },
    chart: { text: chartText },
  };
}

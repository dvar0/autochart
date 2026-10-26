import { GAME_LIBRARY_NAME } from "../data/gameLibrary.js";
import { getSongRecord } from "./songLibrary.js";
import {
  electronEngine,
  electronFiles,
  electronLibrary,
  getAutochartBridge,
  hasElectronEngine as bridgeHasElectronEngine,
  hasElectronLibrary as bridgeHasElectronLibrary,
} from "./runtimeBridge.js";

function hasElectronLibrary() {
  return bridgeHasElectronLibrary();
}

function hasElectronEngine() {
  return bridgeHasElectronEngine();
}

// The browser version's engine takes the audio file itself; the desktop
// engine reads files from disk, so it needs the audio saved or picked.
function engineAcceptsAudioBlobs() {
  return Boolean(electronEngine()?.acceptsAudioBlobs);
}

export function requiresPathBackedAudio() {
  return hasElectronEngine() && !engineAcceptsAudioBlobs();
}

function webExport() {
  return getAutochartBridge()?.webExport || null;
}

async function audioPayloadFromInput(input) {
  if (engineAcceptsAudioBlobs()) {
    const blob = input.audioFile;
    if (!(blob instanceof Blob)) throw new Error("Choose a song file first.");
    return {
      kind: "blob",
      blob,
      name: blob.name || input.audioName || "audio",
      mime: blob.type || "application/octet-stream",
    };
  }
  const stored = input.audioSource?.kind === "project-asset" ? input.audioSource : null;
  if (stored) {
    return {
      ...stored,
      mime: stored.mime || "application/octet-stream",
    };
  }
  const blob = input.audioFile;
  const capability = blob
    ? await electronFiles()?.registerGenerationInput?.(blob)
    : null;
  if (!capability?.token) {
    throw new Error(
      "This audio exists only in memory. Save it to the project before generation or choose a file from disk."
    );
  }
  return {
    kind: "selected-file",
    token: capability.token,
    name: blob.name || input.audioName || "audio.ogg",
    mime: blob.type || "application/octet-stream",
  };
}

export async function listGenerators() {
  if (!hasElectronEngine()) {
    return {
      available: false,
      generators: [],
      error: "Generator engine requires the Electron app.",
    };
  }
  return electronEngine().getManifest();
}

export function subscribeGenerationEvents(callback) {
  if (!hasElectronEngine() || !electronEngine()?.onJobEvent) return () => {};
  return electronEngine().onJobEvent(callback);
}

/**
 * Cancel an in-flight generation job by jobId.
 * @param {string} jobId
 * @returns {Promise<{ ok: boolean, jobId?: string, status: string }>}
 */
export async function cancelGeneration(jobId) {
  if (!hasElectronEngine() || !electronEngine()?.cancelJob) {
    return { ok: true, status: "idle" };
  }
  return electronEngine().cancelJob({ jobId });
}

/**
 * @param {{ audioFile?: File|Blob, audioSource?: object, difficulty: string, generation?: object, metadata?: object, sourceChart?: object, jobId?: string }} input
 * @returns {Promise<{ jobId: string, status: string }>}
 */
export async function generateChart(input) {
  if (hasElectronEngine()) {
    const audio = await audioPayloadFromInput(input);
    return electronEngine().generateChart({
      jobId: input.jobId,
      hardwareMode: input.hardwareMode === "cpu" ? "cpu" : undefined,
      generatorId: input.generatorId,
      audio,
      difficulty: input.difficulty,
      generation: input.generation,
      stripSustains: input.stripSustains,
      metadata: input.metadata,
      versionName: input.versionName,
      parentVersionId: input.parentVersionId,
      demucsSeparation: input.demucsSeparation,
      sourceTransform: input.sourceTransform,
      sourceChart: input.sourceChart,
      title: input.metadata?.title,
    });
  }

  throw new Error("Chart generation requires the Electron app; browser mode is import and preview only.");
}

export function canInpaint() {
  return Boolean(hasElectronEngine() && electronEngine()?.inpaintChart);
}

/**
 * Inpaint: new notes for bar spans of a take. Nothing is saved.
 * @param {{ audioSource: object, generatorId: string, inpaint: { chartText: string, difficulty: string, regions: object[], knobs: object, seed: number }, jobId?: string }} input
 * @returns {Promise<{ jobId: string, status: string, chartText?: string, inpaint?: { resolution: number, regions: { startTick: number, endTick: number, noteLines: number[][] }[] } }>}
 */
export async function inpaintChart(input) {
  if (!canInpaint()) throw new Error("Inpaint requires the Electron app.");
  const audio = await audioPayloadFromInput(input);
  return electronEngine().inpaintChart({
    jobId: input.jobId,
    hardwareMode: input.hardwareMode === "cpu" ? "cpu" : undefined,
    generatorId: input.generatorId,
    audio,
    difficulty: input.inpaint.difficulty,
    generation: input.generation,
    demucsSeparation: input.demucsSeparation,
    sourceTransform: input.sourceTransform,
    metadata: input.metadata,
    title: input.metadata?.title,
    inpaint: input.inpaint,
  });
}

export async function prepareDemucs(input) {
  if (!hasElectronEngine() || !electronEngine()?.prepareDemucs) {
    throw new Error("Demucs separation requires the Electron app.");
  }
  const audio = await audioPayloadFromInput(input);
  return electronEngine().prepareDemucs({
    generatorId: input.generatorId,
    audio,
    audioName: input.audioName,
    separationId: input.separationId,
    name: input.name,
    metadata: input.metadata,
    sourceTransform: input.sourceTransform,
    title: input.metadata?.title,
    needStems: Boolean(input.needStems),
  });
}

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (data?.type === "Buffer" && Array.isArray(data.data)) return new Uint8Array(data.data).buffer;
  if (Array.isArray(data)) return new Uint8Array(data).buffer;
  return data;
}

export async function readDemucsStem(path) {
  if (!hasElectronEngine() || !electronEngine()?.readDemucsStem) {
    throw new Error("Demucs stem playback requires the Electron app.");
  }
  const data = await electronEngine().readDemucsStem({ path });
  return toArrayBuffer(data);
}

export async function readEngineCacheFile(path) {
  if (!hasElectronEngine() || !electronEngine()?.readDemucsStem) {
    throw new Error("Engine cache playback requires the Electron app.");
  }
  const data = await electronEngine().readDemucsStem({ path });
  return toArrayBuffer(data);
}

async function invokeLibraryExport(action, payload) {
  try {
    return await electronLibrary()[action](payload);
  } catch (error) {
    // Electron prefixes IPC exceptions with internal method names. Show the
    // actionable main-process message for both folder export and library save.
    const message = String(error?.message || error).replace(
      /^Error invoking remote method 'library:(?:exportSong|saveSongToCloneHeroLibrary)': (?:Error: )?/,
      ""
    );
    throw new Error(message, { cause: error });
  }
}

/**
 * Export a saved song to a Clone Hero folder in Electron, or download an
 * existing notes.chart file in browser preview mode.
 * @param {string} songId
 * @param {string=} versionId
 * @returns {Promise<{ path?: string, format?: string, message?: string, canceled?: boolean }>}
 */
export async function exportChart(songId, versionId = null) {
  if (!songId) throw new Error("No project selected to export.");
  if (webExport()) return webExport().downloadZip(songId, versionId);

  if (hasElectronLibrary()) {
    const rec = await getSongRecord(songId);
    if (!rec) throw new Error("Project not found in library.");
    const result = await invokeLibraryExport("exportSong", { songId, versionId });
    if (result.canceled) {
      return { canceled: true, message: "Export canceled." };
    }
    return result;
  }

  const rec = await getSongRecord(songId);
  const activeVersion = rec?.versions?.find((v) => v.id === (versionId || rec.settings?.activeVersionId));
  const chartText = activeVersion?.chart?.text || rec?.chart?.text;
  if (!chartText) {
    throw new Error("Browser mode can download an existing notes.chart only; generate charts and export folders in Electron.");
  }

  const blob = new Blob([chartText], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "notes.chart";
  a.click();
  URL.revokeObjectURL(url);

  return {
    format: "clone-hero",
    message: "Downloaded notes.chart (browser mode). Use Electron for full folder export.",
  };
}

export async function saveChartToCloneHeroLibrary(songId, versionId = null) {
  if (!songId) throw new Error("No project selected to save.");
  if (webExport()) return webExport().saveToFolder(songId, versionId);
  if (!hasElectronLibrary() || !electronLibrary()?.saveSongToCloneHeroLibrary) {
    throw new Error(`Saving to a ${GAME_LIBRARY_NAME} library folder requires the Electron app.`);
  }
  return invokeLibraryExport("saveSongToCloneHeroLibrary", { songId, versionId });
}

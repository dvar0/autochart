// Models-manifest reading shared by the desktop and browser engines. Where the
// manifest and its graphs come from (a folder, a URL) is the host's business.

// Each generator names its model folder (generator.models.onnxFolder in
// engine/manifest.json). Jobs without one are v1 jobs.
export const DEFAULT_ONNX_FOLDER = "fretformer-v1";

export function onnxFolderName(job) {
  const folder = String(job?.generator?.models?.onnxFolder || "").trim();
  return folder || DEFAULT_ONNX_FOLDER;
}

export function graphEntry(manifest, role) {
  const graphs = manifest?.graphs || {};
  const entry = Object.values(graphs).find((g) => g.role === role);
  if (!entry) throw new Error(`ONNX graph role not found in manifest: ${role}`);
  return entry;
}

export const DEMUCS_SOURCES = ["drums", "bass", "other", "vocals"];

// stages.demucs.stems lists the stems written to the cache and read by the
// transcriber; stages.demucs.stemFold says which model sources sum into each
// (htdemucs_6s: other = other + piano). Without either, stems = sources.
function demucsStemPlan(stage, sources) {
  const stems = Array.isArray(stage.stems) && stage.stems.length ? stage.stems.map(String) : sources;
  const foldIn = stage.stemFold && typeof stage.stemFold === "object" ? stage.stemFold : {};
  const stemFold = {};
  const used = new Set();
  for (const stem of stems) {
    const parts = Array.isArray(foldIn[stem]) && foldIn[stem].length ? foldIn[stem].map(String) : [stem];
    for (const part of parts) {
      if (!sources.includes(part)) {
        throw new Error(`Demucs stem ${stem} folds unknown source ${part} (sources: ${sources.join(",")})`);
      }
      if (used.has(part)) throw new Error(`Demucs source ${part} is folded into more than one stem.`);
      used.add(part);
    }
    stemFold[stem] = parts;
  }
  return { stems, stemFold };
}

export function demucsOrchestration(manifest) {
  const stage = manifest?.stages?.demucs || {};
  const sampleRate = Number(stage.sampleRate || 44100);
  const audioChannels = Number(stage.audioChannels || 2);
  const nfft = Number(stage.nfft || 4096);
  const hopLength = Number(stage.hopLength || 1024);
  const segmentLength = Number(stage.segmentLength || 343980);
  const overlap = Number(stage.overlap ?? 0.25);
  const transitionPower = Number(stage.transitionPower ?? 1.0);
  const sources = Array.isArray(stage.sources) && stage.sources.length
    ? stage.sources.map(String)
    : DEMUCS_SOURCES;
  const model = String(stage.tagName || "htdemucs");
  const { stems, stemFold } = demucsStemPlan(stage, sources);
  return { sampleRate, audioChannels, nfft, hopLength, segmentLength, overlap, transitionPower, sources, model, stems, stemFold };
}

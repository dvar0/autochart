"use strict";

const fs = require("fs");
const path = require("path");

function resolveModelsFolder(engineRoot, job) {
  const override = job?.engine?.modelsFolder;
  if (override && fs.existsSync(path.join(override, "fretformer-v1", "manifest.json"))) {
    return path.join(override, "fretformer-v1");
  }
  if (override && fs.existsSync(path.join(override, "manifest.json"))) {
    return override;
  }
  return path.join(engineRoot, "models-onnx", "fretformer-v1");
}

async function loadModelsManifest(engineRoot, job) {
  const folder = resolveModelsFolder(engineRoot, job);
  const manifestPath = path.join(folder, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`ONNX models manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
  manifest.folder = folder;
  return manifest;
}

function graphPath(manifest, role) {
  const graphs = manifest?.graphs || {};
  const entry = Object.values(graphs).find((g) => g.role === role);
  if (!entry) throw new Error(`ONNX graph role not found in manifest: ${role}`);
  const resolved = path.resolve(manifest.folder, entry.file);
  if (!fs.existsSync(resolved)) {
    throw new Error(`ONNX graph file missing (role=${role}): ${resolved}`);
  }
  return resolved;
}

const DEMUCS_SOURCES = ["drums", "bass", "other", "vocals"];

function demucsOrchestration(manifest) {
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
  return { sampleRate, audioChannels, nfft, hopLength, segmentLength, overlap, transitionPower, sources };
}

module.exports = {
  loadModelsManifest,
  graphPath,
  demucsOrchestration,
  DEMUCS_SOURCES,
};
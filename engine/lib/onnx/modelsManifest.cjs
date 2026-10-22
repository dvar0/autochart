"use strict";

// Desktop side of the models manifest: model folders and graph files on disk.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const {
  DEFAULT_ONNX_FOLDER,
  onnxFolderName,
  graphEntry,
  demucsOrchestration,
  DEMUCS_SOURCES,
} = require("./manifest.mjs");
const { parseNpz } = require("./prefixTables.mjs");

function resolveModelsFolder(engineRoot, job) {
  const folderName = onnxFolderName(job);
  const override = job?.engine?.modelsFolder;
  if (override && fs.existsSync(path.join(override, folderName, "manifest.json"))) {
    return path.join(override, folderName);
  }
  // A modelsFolder that points straight at a model folder only stands in for v1.
  if (override && folderName === DEFAULT_ONNX_FOLDER && fs.existsSync(path.join(override, "manifest.json"))) {
    return override;
  }
  return path.join(engineRoot, "models-onnx", folderName);
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
  const entry = graphEntry(manifest, role);
  const resolved = path.resolve(manifest.folder, entry.file);
  if (!fs.existsSync(resolved)) {
    throw new Error(`ONNX graph file missing (role=${role}): ${resolved}`);
  }
  return resolved;
}

// loadNpz(path) -> Map<memberName (without trailing .npy), {shape, data}>
function loadNpz(filePath) {
  return parseNpz(fs.readFileSync(filePath), { inflateRaw: (raw) => zlib.inflateRawSync(raw) });
}

module.exports = {
  loadModelsManifest,
  graphPath,
  loadNpz,
  demucsOrchestration,
  onnxFolderName,
  DEMUCS_SOURCES,
};

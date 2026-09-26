const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const runtimeSelection = require("./runtimeSelection.cjs");

const APP_ROOT = path.resolve(__dirname, "..");
const ENGINE_ROOT = path.join(APP_ROOT, "engine");
const CATALOG_PATH = path.join(ENGINE_ROOT, "catalog.json");
const CURRENT_PLATFORM = process.platform;

function defaultEngineRoot() {
  return path.resolve(process.env.AUTOCHART_ENGINE_PATH || ENGINE_ROOT);
}

function engineRootFromManifest(manifest = {}) {
  return path.resolve(manifest.engineRoot || defaultEngineRoot());
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function supportsCurrentPlatform(item) {
  return runtimeSelection.supportsPlatformAndArchitecture(item, CURRENT_PLATFORM, process.arch);
}

function supportsCurrentPlatformOnly(item) {
  return runtimeSelection.supportsPlatform(item, CURRENT_PLATFORM);
}

function uniquePush(list, value) {
  const raw = String(value || "").trim();
  if (!raw) return;
  const resolved = path.resolve(raw);
  if (!list.includes(resolved)) list.push(resolved);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function loadCatalog(manifest = null) {
  const catalogPath = manifest?.engineRoot ? path.join(engineRootFromManifest(manifest), "catalog.json") : CATALOG_PATH;
  if (catalogPath !== CATALOG_PATH && (await fileExists(catalogPath))) return readJson(catalogPath);
  return readJson(CATALOG_PATH);
}

async function loadManifest() {
  const engineRoot = defaultEngineRoot();
  const manifestPath = path.join(engineRoot, "manifest.json");
  return {
    ...(await readJson(manifestPath)),
    engineRoot,
    manifestPath,
  };
}

function rootCandidates(settings = {}, manifest = {}) {
  const roots = [];
  uniquePush(roots, settings.modelsFolder);
  uniquePush(roots, process.env.AUTOCHART_MODELS_ROOT);
  // Dev-checkout fallback: the ONNX graphs ship as symlinks under
  // engineRoot/models-onnx/ in development. A packaged build finds them via
  // settings.modelsFolder after install; this only matches in a dev checkout.
  const engineRoot = engineRootFromManifest(manifest);
  uniquePush(roots, path.join(engineRoot, "models-onnx"));
  return roots;
}

function fileCandidates(filePath, roots) {
  const raw = String(filePath || "").trim();
  if (!raw) return [];
  if (path.isAbsolute(raw)) return runtimeSelection.executablePathCandidates(raw);

  const normalized = raw.replace(/\\/g, "/");
  const withoutModels = normalized.startsWith("models/") ? normalized.slice("models/".length) : "";
  const candidates = [];
  const pushCandidate = (candidate) => {
    for (const executablePath of runtimeSelection.executablePathCandidates(candidate)) {
      uniquePush(candidates, executablePath);
    }
  };
  for (const root of roots) {
    pushCandidate(path.join(root, normalized));
    if (withoutModels) pushCandidate(path.join(root, withoutModels));
    if (!normalized.startsWith("models/")) pushCandidate(path.join(root, "models", normalized));
  }
  return candidates;
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    const stream = handle.createReadStream();
    for await (const chunk of stream) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function isGitLfsPointer(filePath, size) {
  if (!Number.isFinite(size) || size <= 0 || size > 1024 * 1024) return false;
  const handle = await fs.open(filePath, "r");
  try {
    const prefix = Buffer.alloc(Math.min(160, Math.max(1, size)));
    await handle.read(prefix, 0, prefix.length, 0);
    return prefix.toString("utf8").startsWith("version https://git-lfs.github.com/spec");
  } finally {
    await handle.close();
  }
}

function catalogScanFiles(catalog = {}) {
  const files = [];
  for (const component of Array.isArray(catalog.components) ? catalog.components : []) {
    for (const file of Array.isArray(component?.files) ? component.files : []) {
      if (file?.path) files.push(file);
    }
  }
  return files;
}

async function loadInstalledCatalogs(roots) {
  const catalogs = new Map();
  for (const root of roots) {
    try {
      const catalog = await readJson(path.join(root, "catalog.json"));
      const files = new Map();
      for (const file of catalogScanFiles(catalog)) {
        files.set(normalizePathKey(file.path), file);
      }
      catalogs.set(root, files);
    } catch {
      // A missing installed catalog just means we fall back to hashing files.
    }
  }
  return catalogs;
}

function installedCatalogEntry(candidate, filePath, roots, installedCatalogs) {
  const fileKey = normalizePathKey(filePath);
  for (const root of roots) {
    const relative = path.relative(root, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const catalog = installedCatalogs.get(root);
    if (!catalog) continue;
    return catalog.get(normalizePathKey(relative)) || catalog.get(fileKey) || null;
  }
  return null;
}

async function inspectFile(file, roots, installedCatalogs = new Map()) {
  const candidates = fileCandidates(file?.path, roots);
  const useInstalledCatalog = file?.verify !== false;
  for (const candidate of candidates) {
    if (!(await fileExists(candidate))) continue;
    const stat = await fs.stat(candidate);
    const installed = useInstalledCatalog ? installedCatalogEntry(candidate, file.path, roots, installedCatalogs) : null;
    const expectedSize =
      Number(file.size) > 0
        ? Number(file.size)
        : Number(installed?.size) > 0
          ? Number(installed.size)
          : 0;
    const expectedSha256 = file.sha256 || installed?.sha256 || "";
    if (await isGitLfsPointer(candidate, stat.size)) {
      return {
        path: file.path,
        resolvedPath: candidate,
        status: "corrupt",
        size: stat.size,
        message: "File is a Git LFS pointer, not a downloaded model.",
      };
    }
    if (expectedSize > 0 && stat.size !== expectedSize) {
      return {
        path: file.path,
        resolvedPath: candidate,
        status: "corrupt",
        size: stat.size,
        expectedSize,
        message: "File size does not match the catalog.",
      };
    }
    if (expectedSha256) {
      const digest = await sha256(candidate);
      if (digest !== expectedSha256) {
        return {
          path: file.path,
          resolvedPath: candidate,
          status: "corrupt",
          size: stat.size,
          sha256: digest,
          expectedSha256,
          message: "SHA256 does not match the catalog.",
        };
      }
      return {
        path: file.path,
        resolvedPath: candidate,
        status: "ready",
        size: stat.size,
        sha256: digest,
      };
    }
    return {
      path: file.path,
      resolvedPath: candidate,
      status: "ready",
      size: stat.size,
    };
  }
  return {
    path: file?.path || "",
    resolvedPath: "",
    status: "missing",
    candidates,
    message: "File is missing.",
  };
}

function requirementIdsForMode(value, settings = {}) {
  if (Array.isArray(value)) return value;
  const object = plainObject(value);
  const mode = runtimeSelection.effectiveHardwareMode(settings, CURRENT_PLATFORM);
  const modeIds = mode ? object[mode] : null;
  if (Array.isArray(modeIds)) return modeIds;
  return Array.isArray(object.default) ? object.default : [];
}

function requirementIdsForGenerator(generatorRequirements, generatorId, settings = {}) {
  const raw = generatorRequirements[generatorId];
  if (Array.isArray(raw)) return raw;
  const object = plainObject(raw);
  const platformIds = object[CURRENT_PLATFORM];
  if (platformIds !== undefined) return requirementIdsForMode(platformIds, settings);
  return requirementIdsForMode(object.default, settings);
}

function packSupportsCurrentPlatform(pack) {
  return runtimeSelection.supportsPlatformAndArchitecture(pack, CURRENT_PLATFORM, process.arch);
}

function selectStandardPack(packs, catalog, settings = {}) {
  return runtimeSelection.selectPack(packs, catalog, settings, { platform: CURRENT_PLATFORM });
}

function worstStatus(statuses) {
  if (statuses.includes("corrupt")) return "corrupt";
  if (statuses.includes("unsupported")) return "unsupported";
  if (statuses.includes("partial")) return "partial";
  if (statuses.includes("missing")) {
    return statuses.every((status) => status === "missing") ? "missing" : "partial";
  }
  if (statuses.every((status) => status === "ready")) return "ready";
  return "partial";
}

function deriveCombinedStatus({
  platform = CURRENT_PLATFORM,
  arch = process.arch,
  generationReady = false,
  packStatus = "missing",
} = {}) {
  if (!runtimeSelection.isSupportedTarget(platform, arch)) return "unsupported";
  if (generationReady) return "ready";
  return ["corrupt", "partial", "missing"].includes(packStatus) ? packStatus : "missing";
}

function statusMessage(status, label) {
  if (status === "ready") return `${label} is ready.`;
  if (status === "missing") return `${label} is missing.`;
  if (status === "corrupt") return `${label} needs repair.`;
  if (status === "unsupported") return `${label} is not supported on this platform.`;
  return `${label} is partially installed.`;
}

async function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return "";
}

async function scanComponent(
  component,
  roots,
  manifest,
  installedCatalogs,
  developmentAssetRoot = ""
) {
  if (!supportsCurrentPlatform(component)) {
    const architectures = runtimeSelection.architectureList(component);
    return {
      ...component,
      status: "unsupported",
      ready: false,
      message: architectures.length && !architectures.includes(process.arch)
        ? `${component.label} is not supported on ${CURRENT_PLATFORM} ${process.arch}.`
        : `${component.label} is not supported on ${CURRENT_PLATFORM}.`,
      files: [],
    };
  }

  const files = [];
  let hasInstallationFiles = false;
  const developmentModelsRoot = path.join(engineRootFromManifest(manifest), "models-onnx");
  for (const file of Array.isArray(component.files) ? component.files : []) {
    const fileRoots = [...roots];
    // A development checkout keeps the canonical bundled legal files under
    // engine/licenses while its large ONNX graphs live under
    // engine/models-onnx (often as symlinks). Installed builds must still
    // contain their verified copies under <modelsFolder>/licenses; main.cjs
    // supplies this extra root only when Electron is not packaged.
    if (file?.source === "bundled-license" && developmentAssetRoot) {
      uniquePush(fileRoots, developmentAssetRoot);
    }
    const inspected = await inspectFile(file, fileRoots, installedCatalogs);
    files.push(inspected);
    // A clean source checkout already has a model descriptor and licenses.
    // Those verified source files alone are not a partial model installation.
    // Installed copies, model data, and corrupt files still count for repair.
    const checkoutSupportFile = inspected.status === "ready" && (
      (path.basename(file.path) === "manifest.json" &&
        inspected.resolvedPath === path.resolve(developmentModelsRoot, file.path)) ||
      (file.source === "bundled-license" && developmentAssetRoot &&
        inspected.resolvedPath === path.resolve(developmentAssetRoot, file.path))
    );
    if (inspected.status !== "missing" && !checkoutSupportFile) hasInstallationFiles = true;
  }

  const artifactStatuses = files.map((file) => file.status);
  let noticeStatus = "ready";
  if (component.licenseNotice) {
    const noticePath = path.join(APP_ROOT, component.licenseNotice);
    const noticeReady = await fileExists(noticePath);
    noticeStatus = noticeReady ? "ready" : "missing";
    files.push({
      path: component.licenseNotice,
      resolvedPath: noticePath,
      status: noticeStatus,
      kind: "licenseNotice",
      message: noticeReady ? "License notice present." : "License notice is missing.",
    });
  }

  let artifactStatus = artifactStatuses.length ? worstStatus(artifactStatuses) : "ready";
  if (artifactStatus === "partial" && !hasInstallationFiles) artifactStatus = "missing";
  const status = artifactStatus === "ready" && noticeStatus !== "ready" ? "partial" : artifactStatus;
  return {
    ...component,
    status,
    ready: status === "ready",
    message: statusMessage(status, component.label),
    files,
  };
}

function normalizePathKey(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function componentFileKeys(component) {
  return (Array.isArray(component.files) ? component.files : [])
    .filter((file) => file?.path)
    .map((file) => normalizePathKey(file.path));
}

async function inferGeneratorModelFiles(generator, coveredKeys, roots, installedCatalogs) {
  const files = [];
  for (const modelPath of Object.values(plainObject(generator?.models))) {
    const key = normalizePathKey(modelPath);
    if (!key || coveredKeys.has(key)) continue;
    files.push(await inspectFile({ path: modelPath, size: 0, sha256: "" }, roots, installedCatalogs));
  }
  return files;
}

// ONNX graph folders need per-graph inspection; inspectFile would mark the directory "ready".
async function inferOnnxGeneratorFiles(generator, roots, manifest) {
  const onnxModels = plainObject(generator?.models);
  const folderRel = String(onnxModels.onnxFolder || "").trim();
  if (!folderRel) return null;

  const engineRoot = engineRootFromManifest(manifest);
  const folderCandidates = [];
  if (path.isAbsolute(folderRel)) {
    for (const candidate of runtimeSelection.executablePathCandidates(folderRel)) {
      uniquePush(folderCandidates, candidate);
    }
  } else {
    const normalized = folderRel.replace(/\\/g, "/");
    // Installed layout: <modelsFolder>/<folderRel>.
    for (const root of roots) {
      uniquePush(folderCandidates, path.join(root, normalized));
    }
    // Dev-checkout fallback: the engine ships symlinks under
    // engineRoot/models-onnx/<folderRel> for local development. This is the
    // only place that path is consulted; a packaged build finds the files via
    // the modelsFolder candidate above.
    uniquePush(folderCandidates, path.join(engineRoot, "models-onnx", normalized));
  }

  let folder = "";
  let folderStat = null;
  for (const candidate of folderCandidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        folder = candidate;
        folderStat = stat;
        break;
      }
    } catch {
      // try next candidate
    }
  }

  const inferredFrom = (file, statusOverride = null) => ({
    path: file.path,
    resolvedPath: file.resolvedPath || "",
    status: statusOverride || file.status,
    size: file.size || 0,
    message:
      statusOverride === "ready"
        ? `${file.path} is present.`
        : statusOverride === "missing"
          ? `${file.path} is missing.`
          : file.message || "",
  });

  if (!folder) {
    return [
      {
        path: folderRel,
        resolvedPath: "",
        status: "missing",
        size: 0,
        message: `ONNX model folder ${folderRel} is not installed.`,
      },
    ];
  }

  const files = [
    inferredFrom({ path: folderRel, resolvedPath: folder, status: "ready", size: 0 }, "ready"),
  ];

  // The folder manifest names every required graph; if it's missing we can't
  // know which graphs to verify, so report the folder itself partial.
  const folderManifestPath = path.join(folder, "manifest.json");
  let folderManifest = null;
  try {
    folderManifest = JSON.parse(await fs.readFile(folderManifestPath, "utf8"));
    files.push(inferredFrom({ path: `${folderRel}/manifest.json`, resolvedPath: folderManifestPath, status: "ready", size: 0 }, "ready"));
  } catch {
    files.push({
      path: `${folderRel}/manifest.json`,
      resolvedPath: folderManifestPath,
      status: "missing",
      size: 0,
      message: `ONNX model manifest is missing under ${folderRel}.`,
    });
    return files;
  }

  const graphs = plainObject(folderManifest.graphs);
  for (const [key, graph] of Object.entries(graphs)) {
    const file = String(graph?.file || "").trim();
    if (!file) continue;
    const filePath = path.join(folder, file);
    const exists = await fileExists(filePath);
    files.push(
      exists
        ? inferredFrom({ path: `${folderRel}/${file}`, resolvedPath: filePath, status: "ready", size: 0 }, "ready")
        : {
            path: `${folderRel}/${file}`,
            resolvedPath: filePath,
            status: "missing",
            size: 0,
            message: `ONNX graph ${file} (${key}) is missing.`,
          }
    );
  }

  // prefix_tables.npz is required by the transcriber's CFG path when present.
  const prefixConditioning = plainObject(folderManifest.stages?.transcriber?.prefixConditioning);
  const prefixFile = String(prefixConditioning.file || "").trim();
  if (prefixFile) {
    const prefixPath = path.join(folder, prefixFile);
    const exists = await fileExists(prefixPath);
    files.push(
      exists
        ? inferredFrom({ path: `${folderRel}/${prefixFile}`, resolvedPath: prefixPath, status: "ready", size: 0 }, "ready")
        : {
            path: `${folderRel}/${prefixFile}`,
            resolvedPath: prefixPath,
            status: "missing",
            size: 0,
            message: `Prefix tables ${prefixFile} are missing.`,
          }
    );
  }

  return files;
}

function summarizeGeneratorStatus(requirements, inferredFiles) {
  const statuses = [
    ...requirements.map((component) => component.status),
    ...inferredFiles.map((file) => file.status),
  ];
  const status = statuses.length ? worstStatus(statuses) : "ready";
  const failedComponent = requirements.find((component) => component.status !== "ready");
  const failedFile = inferredFiles.find((file) => file.status !== "ready");
  let message = "Generator is ready.";
  if (failedComponent) {
    if (failedComponent.status === "unsupported") {
      message = failedComponent.message || `${failedComponent.label} is not supported on this platform.`;
    } else if (failedComponent.status === "corrupt") {
      message = `The ${failedComponent.label} needs repair. Open Setup to scan or repair the chart generation package.`;
    } else {
      message = `The ${failedComponent.label} is not installed. Open Setup to scan or repair the chart generation package.`;
    }
  } else if (failedFile) {
    message = `The model file ${failedFile.path} is not installed. Open Setup to scan or repair the chart generation package.`;
  }
  return {
    status,
    ready: status === "ready",
    message,
  };
}

async function buildGeneratorReadiness({ manifest, catalog, componentsById, roots, installedCatalogs, settings = {} }) {
  const generatorRequirements = plainObject(catalog.generatorRequirements);
  const generators = Array.isArray(manifest?.generators) ? manifest.generators : [];
  const defaultRequirementId = catalog.defaults?.generatorId || "";
  const readiness = {};
  for (const generator of generators) {
    let requirementIds = requirementIdsForGenerator(generatorRequirements, generator.id, settings);
    if (
      !requirementIds.length &&
      generator.discovered &&
      defaultRequirementId &&
      defaultRequirementId !== generator.id
    ) {
      requirementIds = requirementIdsForGenerator(generatorRequirements, defaultRequirementId, settings);
    }
    const requirements = requirementIds
      .map((id) => componentsById[id])
      .filter(Boolean);
    const coveredKeys = new Set(requirements.flatMap(componentFileKeys));
    const onnxModels = plainObject(generator.models);
    const inferredFiles = onnxModels.onnxFolder
      ? await inferOnnxGeneratorFiles(generator, roots, manifest)
      : await inferGeneratorModelFiles(generator, coveredKeys, roots, installedCatalogs);
    readiness[generator.id] = {
      generatorId: generator.id,
      requiredComponentIds: requirementIds,
      components: requirements.map((component) => ({
        id: component.id,
        label: component.label,
        kind: component.kind,
        status: component.status,
        ready: component.ready,
        message: component.message,
      })),
      inferredFiles,
      ...summarizeGeneratorStatus(requirements, inferredFiles),
    };
  }
  return readiness;
}

function catalogComponentsById(catalog = {}) {
  return new Map((Array.isArray(catalog.components) ? catalog.components : []).map((component) => [component.id, component]));
}

function timingOptionComponentIds(catalog = {}) {
  const ids = new Set();
  for (const option of Array.isArray(catalog.timingOptions) ? catalog.timingOptions : []) {
    for (const id of Array.isArray(option.componentIds) ? option.componentIds : []) ids.add(id);
  }
  return ids;
}

function timingDetectorFromGeneration(generation = {}) {
  const controls = plainObject(generation.controls);
  const resolved = plainObject(generation.resolved);
  return String(resolved.timingDetector || controls.timingDetector || "").trim();
}

function requirementIdsForGeneration(catalog = {}, generatorId, generation = {}, settings = {}) {
  const base = requirementIdsForGenerator(plainObject(catalog.generatorRequirements), generatorId, settings);
  const timingDetector = timingDetectorFromGeneration(generation);
  if (!timingDetector) return base;

  const timingOption = (Array.isArray(catalog.timingOptions) ? catalog.timingOptions : [])
    .find((option) => option.id === timingDetector);
  if (!timingOption) return base;

  const timingComponentIds = timingOptionComponentIds(catalog);
  const next = base.filter((id) => !timingComponentIds.has(id));
  for (const id of Array.isArray(timingOption.componentIds) ? timingOption.componentIds : []) {
    if (!next.includes(id)) next.push(id);
  }
  return next;
}

function requirementIdsForCommand(catalog = {}, generatorId, { command = "generate", generation = {}, settings = {} } = {}) {
  const ids = command === "generate"
    ? requirementIdsForGeneration(catalog, generatorId, generation, settings)
    : requirementIdsForGenerator(plainObject(catalog.generatorRequirements), generatorId, settings);
  if (command !== "prepare-demucs") return ids;

  const componentsById = catalogComponentsById(catalog);
  return ids.filter((id) => {
    const kind = componentsById.get(id)?.kind;
    return kind === "runtime" || kind === "audio-separation-model";
  });
}

function readinessForRequirements(scan = {}, catalog = {}, generatorId, requirementIds) {
  const scannedComponents = new Map((Array.isArray(scan.components) ? scan.components : []).map((component) => [component.id, component]));
  const catalogComponents = catalogComponentsById(catalog);
  const requirements = (Array.isArray(requirementIds) ? requirementIds : [])
    .map((id) => scannedComponents.get(id) || {
      ...(catalogComponents.get(id) || { id, label: id, kind: "component" }),
      status: "missing",
      ready: false,
      message: `${catalogComponents.get(id)?.label || id} is missing.`,
    });
  const inferredFiles = scan.generatorReadiness?.[generatorId]?.inferredFiles || [];
  return {
    generatorId,
    requiredComponentIds: requirementIds,
    components: requirements.map((component) => ({
      id: component.id,
      label: component.label,
      kind: component.kind,
      status: component.status,
      ready: component.ready,
      message: component.message,
    })),
    inferredFiles,
    ...summarizeGeneratorStatus(requirements, inferredFiles),
  };
}

function readinessForCommand(scan = {}, catalog = {}, generatorId, options = {}) {
  const settings = options.settings || scan.settings || {};
  return readinessForRequirements(
    scan,
    catalog,
    generatorId,
    requirementIdsForCommand(catalog, generatorId, { ...options, settings })
  );
}

function decorateManifest(manifest, scan) {
  const generatorReadiness = plainObject(scan?.generatorReadiness);
  const generators = (Array.isArray(manifest?.generators) ? manifest.generators : []).map((generator) => {
    const setup = generatorReadiness[generator.id] || {
      status: "missing",
      ready: false,
      message: "Generator setup has not been scanned.",
    };
    return {
      ...generator,
      setup,
    };
  });
  const status = scan?.combinedStatus || (scan?.generationReady ? "ready" : "missing");
  return {
    ...manifest,
    generators,
    supportedPlatform: scan?.supportedPlatform !== false,
    setup: {
      ready: Boolean(scan?.generationReady),
      setupComplete: Boolean(scan?.settings?.setupComplete),
      standardReady: Boolean(scan?.standardPack?.ready),
      status,
      message: status === "unsupported"
        ? scan?.message || runtimeSelection.unsupportedTargetMessage(scan?.platform, scan?.arch)
        : scan?.generationReady
          ? "At least one generator is ready."
          : "Chart generation needs setup.",
      scan,
    },
  };
}

function generatorFailureMessage(generatorId, scan) {
  if (scan?.supportedPlatform === false || scan?.combinedStatus === "unsupported") {
    return scan?.message || runtimeSelection.unsupportedTargetMessage(scan?.platform, scan?.arch);
  }
  const setup = scan?.generatorReadiness?.[generatorId];
  if (!setup) return "Chart generation needs setup before this generator can run.";
  return setup.ready ? "" : setup.message || "Chart generation needs setup before this generator can run.";
}

function assertSetupReadyForCompletion(scan) {
  if (scan?.supportedPlatform === false || scan?.combinedStatus === "unsupported") {
    throw new Error(scan?.message || runtimeSelection.unsupportedTargetMessage(scan?.platform, scan?.arch));
  }
  if (!scan?.generationReady) {
    throw new Error(
      "Download and verify Autochart's chart generation package before continuing."
    );
  }
  return scan;
}

async function scanModelSetup({
  settings = {},
  manifest = null,
  catalog = null,
  developmentAssetRoot = "",
} = {}) {
  const loadedManifest = manifest || (await loadManifest());
  const loadedCatalog = catalog || (await loadCatalog(loadedManifest));
  const supportedPlatform = runtimeSelection.isSupportedTarget(CURRENT_PLATFORM, process.arch);
  if (!supportedPlatform) {
    const message = runtimeSelection.unsupportedTargetMessage(CURRENT_PLATFORM, process.arch);
    const generators = Array.isArray(loadedManifest?.allGenerators)
      ? loadedManifest.allGenerators
      : Array.isArray(loadedManifest?.generators)
        ? loadedManifest.generators
        : [];
    const generatorReadiness = Object.fromEntries(generators.map((generator) => [
      generator.id,
      {
        generatorId: generator.id,
        requiredComponentIds: [],
        components: [],
        inferredFiles: [],
        status: "unsupported",
        ready: false,
        message,
      },
    ]));
    return {
      schemaVersion: 1,
      scannedAt: Date.now(),
      platform: CURRENT_PLATFORM,
      arch: process.arch,
      platformLabel: runtimeSelection.platformLabel(CURRENT_PLATFORM),
      supportedPlatform: false,
      combinedStatus: "unsupported",
      message,
      settings,
      catalog: {
        schemaVersion: loadedCatalog.schemaVersion,
        updatedAt: loadedCatalog.updatedAt,
        channel: loadedCatalog.channel,
        defaults: loadedCatalog.defaults || {},
      },
      sourceRoots: [],
      components: [],
      packs: [],
      standardPack: null,
      generatorReadiness,
      readyGeneratorIds: [],
      generationReady: false,
    };
  }
  const roots = rootCandidates(settings, loadedManifest);
  const installedCatalogs = await loadInstalledCatalogs(roots);
  const components = [];
  const catalogComponents = (Array.isArray(loadedCatalog.components) ? loadedCatalog.components : [])
    .filter(supportsCurrentPlatformOnly);
  for (const component of catalogComponents) {
    components.push(await scanComponent(
      component,
      roots,
      loadedManifest,
      installedCatalogs,
      developmentAssetRoot
    ));
  }
  const componentsById = Object.fromEntries(components.map((component) => [component.id, component]));
  const packs = (Array.isArray(loadedCatalog.packs) ? loadedCatalog.packs : [])
    .filter(packSupportsCurrentPlatform)
    .map((pack) => {
    const packComponents = (Array.isArray(pack.components) ? pack.components : [])
      .map((id) => componentsById[id])
      .filter(Boolean);
    const status = packComponents.length ? worstStatus(packComponents.map((component) => component.status)) : "missing";
    return {
      ...pack,
      status,
      ready: status === "ready",
      components: packComponents.map((component) => ({
        id: component.id,
        label: component.label,
        status: component.status,
        ready: component.ready,
      })),
    };
  });
  const generatorReadiness = await buildGeneratorReadiness({
    manifest: loadedManifest,
    catalog: loadedCatalog,
    componentsById,
    roots,
    installedCatalogs,
    settings,
  });
  const readyGeneratorIds = Object.values(generatorReadiness)
    .filter((setup) => setup.ready)
    .map((setup) => setup.generatorId);
  const standardPack = selectStandardPack(packs, loadedCatalog, settings);

  const generationReady = readyGeneratorIds.length > 0;
  return {
    schemaVersion: 1,
    scannedAt: Date.now(),
    platform: CURRENT_PLATFORM,
    arch: process.arch,
    platformLabel: runtimeSelection.platformLabel(CURRENT_PLATFORM),
    supportedPlatform: true,
    combinedStatus: deriveCombinedStatus({
      generationReady,
      packStatus: standardPack?.status || "missing",
    }),
    settings,
    catalog: {
      schemaVersion: loadedCatalog.schemaVersion,
      updatedAt: loadedCatalog.updatedAt,
      channel: loadedCatalog.channel,
      defaults: loadedCatalog.defaults || {},
    },
    sourceRoots: roots,
    components,
    packs,
    standardPack,
    generatorReadiness,
    readyGeneratorIds,
    generationReady,
  };
}

module.exports = {
  assertSetupReadyForCompletion,
  decorateManifest,
  deriveCombinedStatus,
  generatorFailureMessage,
  readinessForCommand,
  requirementIdsForCommand,
  requirementIdsForGeneration,
  loadCatalog,
  rootCandidates,
  scanModelSetup,
};

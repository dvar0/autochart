import { useEffect, useRef, useState } from "react";
import LanguagePicker from "../components/LanguagePicker.jsx";
import { msg, rich, t, tn } from "../i18n/index.js";
import { I } from "../icons.jsx";
import { generationDownloadSize } from "../data/generationCatalog.js";
import { DeviceReadout, UNCHECKED_DEVICE, browserLabel, deviceFromProbe, memoryText } from "../components/DeviceFacts.jsx";
import { askConfirm } from "../components/ConfirmDialog.jsx";
import InstallProgress from "../components/InstallProgress.jsx";
import {
  friendlyTarget,
  hardwareModeCaveat,
  hardwareModeForPlatform,
  hardwareModesForPlatform,
  humanizeStatus,
  humanizeRuntime,
  humanizeSupportLabel,
  normalizeHardwareMode,
} from "../data/hardwareModes.js";
import { BETA_MODELS, MODEL_FAMILIES, defaultGeneratorIdFrom, isBetaGenerator } from "../data/modelFamilies.js";
import {
  chooseCacheFolder,
  chooseCloneHeroLibraryFolder,
  chooseModelsFolder,
  chooseProjectsFolder,
  clearCacheFolder,
  dismissSettingsRecoveryNotice,
  getAppSettings,
  openSettingsPath,
  resetSettingsPath,
  updateAppSettings,
} from "../services/appSettings.js";
import { listGenerators } from "../services/generation.js";
import {
  activeModelInstalls, installAssets, probeHardware, removeModelDownloads, scanModelSetup, subscribeModelInstallEvents,
} from "../services/modelSetup.js";
import { NOTICE_LINKS, openNotice } from "../services/notices.js";
import { SITE_LINKS } from "../data/siteLinks.js";
import { electronPlatform, isWebApp } from "../services/runtimeBridge.js";

const EMPTY_SETTINGS = {
  setupComplete: false,
  cloneHeroLibraryFolder: "",
  projectsFolder: "",
  modelsFolder: "",
  cacheParentFolder: "",
  cacheFolder: "",
  hardwareMode: "auto",
  defaultGeneratorId: "",
  fillInDrafts: false,
  keepStems: false,
  pathDefaults: null,
  homeFolder: "",
  settingsRecovery: null,
};

const FOLDER_ROWS = [
  { key: "cloneHeroLibraryFolder", title: msg("Clone Hero / YARG songs"), choose: chooseCloneHeroLibraryFolder },
  { key: "projectsFolder", title: msg("Projects"), choose: chooseProjectsFolder },
  { key: "cacheFolder", title: msg("Cache"), choose: chooseCacheFolder },
  { key: "modelsFolder", title: msg("Model files"), choose: chooseModelsFolder },
];

const KEEP_STEMS_HELP = msg("Charts only need a few MB from each separation, so the separated stems (hundreds of MB a song) are deleted afterwards. Turn this on to keep them. Playing stems separates the song again when they're gone.");

const FILL_IN_DRAFTS_HELP = msg("Inpaint normally redoes the bars you pick. Turn this on to also use it in Generate to write a whole chart, and to pick it for new projects. It's still experimental.");

const NOTICE_BUTTONS = [
  { key: "releaseNotes", label: msg("Release notes") },
  { key: "thirdParty", label: msg("Licenses") },
  { key: "ffmpegLicense", label: msg("FFmpeg license") },
  { key: "privacy", label: msg("Privacy") },
];

// Last values the page saw. Revisits render these immediately and refresh them
// in the background instead of waiting on the model scan again.
const lastLoaded = { settings: null, setup: null, hardware: null, manifest: null };

function shortPath(value, home) {
  if (!value) return "";
  if (home && (value === home || value.startsWith(home + "/") || value.startsWith(home + "\\"))) {
    return "~" + value.slice(home.length);
  }
  return value;
}

function gpuName(hardware) {
  const name = hardware?.nvidia?.detected ? hardware.nvidia.gpus?.[0]?.name || "" : "";
  return name.replace(/^NVIDIA\s+(GeForce\s+)?/i, "");
}

function performanceSummary(hardware, unsupported) {
  if (unsupported) return t("{platform} is unsupported.", { platform: friendlyTarget(hardware) });
  if (!hardware) return t("Checking hardware…");
  const device = hardware.selectedMode === "cpu" ? hardware.cpu : gpuName(hardware);
  const mode = hardware.selectedModeLabel;
  return device ? t("Using {mode} · {device}", { mode, device }) : t("Using {mode}", { mode });
}

const EXPORT_FORMATS = [
  { value: "sng", label: msg("One file (.sng)"), help: msg("Goes straight into your Clone Hero or YARG songs folder.") },
  { value: "zip", label: msg("Folder (.zip)"), help: msg("Unzips into a song folder you can edit by hand.") },
];
const USAGE_COUNTS_HELP = msg(
  "Counts like charts made, which model, and what failed, so we can see what works. Never your songs, files or anything that identifies you. Do Not Track turns it off too.");

const UPDATE_CHECK_HELP = msg("Once a day, Autochart checks GitHub for a newer version. Nothing about you or your songs is sent.");

// One status for a family's generators: ready, missing, partial (some files),
// or repair (a file failed verification).
function familyStatus(family, generatorsById, manifestLoaded) {
  if (!manifestLoaded) return "checking";
  const statuses = [family.generatorId, family.inpaintGeneratorId]
    .filter(Boolean)
    .map((id) => generatorsById.get(id)?.setup?.status || "missing");
  if (statuses.includes("unsupported")) return "unsupported";
  if (statuses.some((status) => status === "corrupt" || status === "partial")) return "repair";
  if (statuses.every((status) => status === "ready")) return "ready";
  return statuses.some((status) => status === "ready") ? "partial" : "missing";
}

// The browser version downloads each model the first time it's used, and the
// Inpaint model separately, so a family is ready once its own model is in the
// browser.
function webFamilyStatus(family, generatorsById, manifestLoaded) {
  if (!manifestLoaded) return "checking";
  const setup = generatorsById.get(family.generatorId)?.setup;
  if (!setup || setup.status === "unsupported") return "unsupported";
  return setup.downloaded ? "ready" : "missing";
}

function formatSize(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function StatusPill({ status, label = "" }) {
  const value = status || "missing";
  return <span className={`setup-status ${value}`}>{label ? t(label) : humanizeStatus(value)}</span>;
}

// The browser's models count as usable before they're downloaded (they
// download on first use), so its pill says what's actually in the browser.
function webModelFilesPill(setup) {
  if (!setup) return { status: "checking" };
  const statuses = Object.values(setup.generatorReadiness || {});
  if (statuses.some((status) => status.downloaded)) return { status: "ready", label: msg("Downloaded") };
  if (statuses.some((status) => status.status === "partial")) return { status: "partial", label: msg("Partly downloaded") };
  return { status: "missing", label: msg("Not downloaded") };
}

// A model's status line. The main process words it in English, so model
// statuses are said again here in the current language.
const MODEL_STATUS_TEXT = {
  ready: msg("{model} is ready."),
  missing: msg("{model} is missing."),
  corrupt: msg("{model} needs repair."),
  unsupported: msg("{model} is not supported on this platform."),
  partial: msg("{model} is partly installed."),
};

function componentMessage(component) {
  const text = component.kind === "chart-model" && MODEL_STATUS_TEXT[component.status];
  return text ? t(text, { model: component.label }) : component.message || component.kind;
}

function ComponentCard({ component }) {
  const files = Array.isArray(component.files) ? component.files : [];
  return (
    <div className="setup-component">
      <div className="setup-component-main">
        <div>
          <h3>{component.label}</h3>
          <p>{componentMessage(component)}</p>
        </div>
        <StatusPill status={component.status} />
      </div>
      <div className="setup-component-meta">
        <span>{component.kind}</span>
        {component.version && <span>{component.version}</span>}
        {component.license && <span>{component.license}</span>}
      </div>
      {files.length > 0 && (
        <details className="setup-details">
          <summary>{t("Exact files")}</summary>
          <div className="setup-file-list">
            {files.map((file, index) => (
              <div key={`${file.path}-${index}`} className="setup-file-row">
                <StatusPill status={file.status} />
                <span>{file.resolvedPath || file.path}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// What the browser version can see of the device. Browsers don't name the
// processor, and some don't name the graphics card.
function WebHardwareDetails({ hardware }) {
  const webgpu = hardware.webgpuAvailable
    ? hardware.selectedMode === "webgpu" ? t("Available") : t("Available, set to processor")
    : t("Not available");
  const gpu = hardware.webgpuAvailable ? hardware.gpuDetails || t("Not named by this browser") : t("Not reachable");
  const threads = hardware.cpuCount ? tn(hardware.cpuCount, "{count} thread", "{count} threads") : t("Not reported");
  return (
    <div className="hardware-details">
      <div><span>{t("Browser")}</span><b>{browserLabel()}</b></div>
      <div><span>WebGPU</span><b>{webgpu}</b></div>
      <div><span>GPU</span><b>{gpu}</b></div>
      <div><span>CPU</span><b>{hardware.crossOriginIsolated ? threads : t("{threads}, one used (page not isolated)", { threads })}</b></div>
      <div><span>{t("Memory")}</span><b>{memoryText(hardware.totalMemoryMb ? hardware.totalMemoryMb / 1024 : null)}</b></div>
      <div><span>{t("Runtime")}</span><b>{humanizeRuntime(hardware.selectedRuntimePack)}</b></div>
    </div>
  );
}

// Model file checks, hardware, and the folders the scan looked in. Opens over
// the page so the main cards keep their layout.
function DiagnosticsSheet({ setup, hardware, busy, onCheck, onClose }) {
  const components = setup?.components || [];
  const chartComponents = components.filter((component) => component.kind === "chart-model");
  const runtimeComponents = components.filter((component) => component.kind === "runtime");
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="settings-sheet-scrim" onClick={onClose} aria-hidden="true" />
      <section className="settings-sheet" role="dialog" aria-label={t("Diagnostics")}>
        <header className="ms-head">
          <h2>{t("Diagnostics")}</h2>
          <button type="button" className="ms-close" onClick={onClose} aria-label={t("Close diagnostics")} title={t("Close (Esc)")}>
            <I.plus />
          </button>
        </header>
        <div className="settings-sheet-body">
          <div className="advanced-row">
            <div>
              <b>{t("Model files")}</b>
              <small>{isWebApp() ? t("Checks which model files this browser has.") : t("Checks every installed file against its checksum.")}</small>
            </div>
            <div className="advanced-row-actions">
              {isWebApp()
                ? <StatusPill {...webModelFilesPill(setup)} />
                : <StatusPill status={setup ? setup.combinedStatus || setup.standardPack?.status || "missing" : "checking"} />}
              <button
                className="settings-secondary"
                onClick={onCheck}
                disabled={Boolean(busy)}
                title={busy ? t("Wait for the current settings operation to finish.") : t("Check the model files again")}
              >
                <I.spark /> {busy === "loading" ? t("Checking…") : t("Check files")}
              </button>
            </div>
          </div>
          {[...chartComponents, ...runtimeComponents].map((component) => (
            <ComponentCard key={component.id} component={component} />
          ))}
          {hardware && isWebApp() && <WebHardwareDetails hardware={hardware} />}
          {hardware && !isWebApp() && (
            <div className="hardware-details">
              <div><span>{t("Platform")}</span><b>{friendlyTarget(hardware)}</b></div>
              {hardware.supportLabel && <div><span>{t("Support")}</span><b>{humanizeSupportLabel(hardware.supportLabel)}</b></div>}
              <div><span>CPU</span><b>{hardware.cpu || t("Unknown")}</b></div>
              <div><span>GPU</span><b>{hardware.nvidia?.detected ? hardware.nvidia.gpus.map((gpu) => gpu.name).join(", ") : t("Not detected")}</b></div>
              <div><span>{t("Runtime")}</span><b>{humanizeRuntime(hardware.selectedRuntimePack)}</b></div>
              <div><span>{t("Provider")}</span><b>{humanizeStatus(hardware.providerStatus)}</b></div>
            </div>
          )}
          {setup?.sourceRoots?.length > 0 && (
            <div className="setup-file-list">
              <b className="settings-sheet-label">{t("Folders checked")}</b>
              {setup.sourceRoots.map((root) => (
                <div className="setup-file-row" key={root}>
                  <span>{root}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}

export default function Settings() {
  const [settings, setSettingsState] = useState(() => lastLoaded.settings || EMPTY_SETTINGS);
  const [setup, setSetupState] = useState(() => lastLoaded.setup);
  const [hardware, setHardwareState] = useState(() => lastLoaded.hardware);
  const [manifest, setManifestState] = useState(() => lastLoaded.manifest);
  const setSettings = (next) => setSettingsState((current) => {
    const value = typeof next === "function" ? next(current) : next;
    lastLoaded.settings = value;
    return value;
  });
  const setSetup = (value) => {
    lastLoaded.setup = value;
    setSetupState(value);
  };
  const setHardware = (value) => {
    lastLoaded.hardware = value;
    setHardwareState(value);
  };
  const setManifest = (value) => {
    lastLoaded.manifest = value;
    setManifestState(value);
  };
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [installProgress, setInstallProgress] = useState(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  // Each source fills in as soon as it answers; settings are instant, the
  // model scan is the slow one. Only an explicit rescan blocks the controls.
  const loadAll = async ({ fresh = false } = {}) => {
    if (fresh) setBusy("loading");
    setMessage("");
    try {
      await Promise.all([
        getAppSettings().then((next) => setSettings({ ...EMPTY_SETTINGS, ...next })),
        scanModelSetup({ fresh }).then(setSetup),
        probeHardware().then(setHardware),
      ]);
      // After the scan so a fresh check's digests are reused here.
      setManifest(await listGenerators());
    } catch (err) {
      setMessage({ text: err.message || t("Could not load settings."), tone: "error" });
    } finally {
      if (fresh) setBusy("");
    }
  };

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => subscribeModelInstallEvents(setInstallProgress), []);

  const refreshModels = async () => {
    const [nextSetup, nextHardware] = await Promise.all([scanModelSetup(), probeHardware()]);
    setSetup(nextSetup);
    setHardware(nextHardware);
    setManifest(await listGenerators());
  };

  const runAction = async (label, action) => {
    setBusy(label);
    setMessage("");
    try {
      const result = await action();
      if (result?.settings) setSettings({ ...EMPTY_SETTINGS, ...result.settings });
      else if (result && ("projectsFolder" in result || "setupComplete" in result)) {
        setSettings({ ...EMPTY_SETTINGS, ...result });
      }
      if (label !== "opening") await refreshModels();
      setMessage(
        result?.canceled || label === "opening"
          ? ""
          : label === "clear-cache"
            ? t("Cache cleared.")
            : t("Settings updated.")
      );
    } catch (err) {
      setMessage({ text: err.message || t("Settings action failed."), tone: "error" });
    } finally {
      setBusy("");
    }
  };

  const confirmAndClearCache = async () => {
    const cachePath = settings.cacheFolder;
    if (!cachePath) return;
    const confirmed = await askConfirm({
      title: t("Clear the cache?"),
      body: t("This deletes Autochart's separations and analysis for good. Your projects stay."),
      detail: cachePath,
      confirmLabel: t("Clear cache"),
      danger: true,
    });
    if (confirmed) {
      void runAction("clear-cache", () => clearCacheFolder(cachePath));
    }
  };

  // The mode only matters to the next run, so the pick shows at once and saves
  // quietly; then the hardware check reruns so the card shows where runs go.
  // Only the latest pick's check is shown when they overlap.
  const hardwareModeSeq = useRef(0);
  const updateHardwareMode = async (mode) => {
    const previous = settings;
    const hardwareMode = normalizeHardwareMode(mode);
    const seq = ++hardwareModeSeq.current;
    setSettings((current) => ({ ...current, hardwareMode }));
    setMessage("");
    try {
      const next = await updateAppSettings({ hardwareMode });
      if (seq !== hardwareModeSeq.current) return;
      setSettings({ ...EMPTY_SETTINGS, ...next });
      const nextHardware = await probeHardware();
      if (seq === hardwareModeSeq.current) setHardware(nextHardware);
    } catch (err) {
      if (seq !== hardwareModeSeq.current) return;
      setSettings(previous);
      setMessage({ text: err.message || t("Could not update hardware mode."), tone: "error" });
    }
  };

  // Model preferences save quietly: the selected row and the switch show the result.
  const updateModelPreference = async (patch) => {
    const previous = settings;
    setSettings((current) => ({ ...current, ...patch }));
    try {
      const next = await updateAppSettings(patch);
      setSettings({ ...EMPTY_SETTINGS, ...next });
    } catch (err) {
      setSettings(previous);
      setMessage({ text: err.message || t("Could not save the model setting."), tone: "error" });
    }
  };

  const installModels = async (family) => {
    setBusy(`installing-${family.id}`);
    setMessage("");
    setInstallProgress({ phase: "starting", percent: 0, message: t("Preparing download.") });
    try {
      const result = await installAssets(family.packId);
      if (result?.settings) setSettings({ ...EMPTY_SETTINGS, ...result.settings });
      if (result?.setup) setSetup(result.setup);
      await refreshModels();
      setInstallProgress((current) => ({ ...(current || {}), phase: "complete", percent: 100 }));
      setMessage(t("Model installed."));
    } catch (err) {
      setInstallProgress((current) => ({ ...(current || {}), phase: "failed" }));
      setMessage({ text: err.message || t("Could not install the model."), tone: "error" });
    } finally {
      setBusy("");
    }
  };

  // A download started on another screen shows its progress here instead of
  // offering the same download again.
  useEffect(() => {
    const family = MODEL_FAMILIES.find((item) => activeModelInstalls().includes(item.packId));
    if (family) void installModels(family);
  }, []);

  // Browser version: models and separations live in the browser's storage, which
  // phones run short of, so they can be removed here.
  const removeDownloads = async (request, question) => {
    const confirmed = await askConfirm({ title: t("Remove downloads?"), body: question, confirmLabel: t("Remove"), danger: true });
    if (!confirmed) return;
    setBusy(request.all ? "removing-all" : `removing-${request.packId}`);
    setMessage("");
    try {
      const result = await removeModelDownloads(request);
      if (result?.setup) setSetup(result.setup);
      await refreshModels();
      setInstallProgress(null);
      setMessage(t("Removed."));
    } catch (err) {
      setMessage({ text: err.message || t("Could not remove the models."), tone: "error" });
    } finally {
      setBusy("");
    }
  };

  const removeFamily = (family) => {
    const bytes = [family.generatorId, family.inpaintGeneratorId]
      .filter((id, index, ids) => id && ids.indexOf(id) === index)
      .reduce((sum, id) => sum + (generatorsById.get(id)?.setup?.bytes || 0), 0);
    void removeDownloads(
      { packId: family.packId },
      bytes
        ? t("{model} leaves this browser, freeing {size}. It downloads again the next time you use it.", { model: family.label, size: formatSize(bytes) })
        : t("{model} leaves this browser. It downloads again the next time you use it.", { model: family.label })
    );
  };

  // Under a megabyte is only the models' small manifest files.
  const storedTotal = (setup?.cachedBytes || 0) + (setup?.stemBytes || 0);
  const storedBytes = storedTotal >= 1e6 ? storedTotal : 0;

  const removeAll = () => {
    const parts = [
      setup?.cachedBytes >= 1e6 ? t("models {size}", { size: formatSize(setup.cachedBytes) }) : "",
      setup?.stemBytes >= 1e6 ? t("separations {size}", { size: formatSize(setup.stemBytes) }) : "",
    ].filter(Boolean).join(", ");
    void removeDownloads(
      { all: true },
      parts
        ? t("Models and separations leave this browser ({sizes}). They come back the next time you generate. Your songs and charts stay.", { sizes: parts })
        : t("Models and separations leave this browser. They come back the next time you generate. Your songs and charts stay.")
    );
  };

  const openBundledNotice = async (key) => {
    try {
      const opened = await openNotice(key);
      if (!opened) {
        setMessage({ text: t("Notices are available in the desktop app."), tone: "info" });
      }
    } catch (err) {
      setMessage({ text: err.message || t("Could not open the notice."), tone: "error" });
    }
  };

  const generators = manifest?.generators || [];
  const generatorsById = new Map(generators.map((generator) => [generator.id, generator]));
  const manifestLoaded = Boolean(manifest);
  const preferences = { defaultGeneratorId: settings.defaultGeneratorId, fillInDrafts: settings.fillInDrafts };
  const defaultGeneratorId = defaultGeneratorIdFrom(generators, preferences);
  const isReady = (generatorId) => Boolean(generatorsById.get(generatorId)?.setup?.ready);
  const web = isWebApp();

  const unsupported = setup?.combinedStatus === "unsupported" || hardware?.supportedPlatform === false;
  const targetPlatform = setup?.platform || hardware?.platform || electronPlatform();
  const hardwareModes = hardwareModesForPlatform(targetPlatform);
  const aboutLinks = (
    <>
      {NOTICE_BUTTONS.map((notice) => (
        <button key={notice.key} className="settings-secondary" onClick={() => openBundledNotice(notice.key)}>
          {t(notice.label)}
        </button>
      ))}
      <a className="settings-secondary" href={NOTICE_LINKS.ffmpeg} target="_blank" rel="noreferrer">
        {t("FFmpeg legal")}
      </a>
    </>
  );
  const selectedHardwareMode = hardwareModeForPlatform(settings.hardwareMode, targetPlatform);
  const home = settings.homeFolder;

  const messageText = typeof message === "string" ? message : message?.text;
  const messageTone = typeof message === "object" ? message.tone : "success";

  const familyAction = (family) => {
    const status = (web ? webFamilyStatus : familyStatus)(family, generatorsById, manifestLoaded);
    const pack = (setup?.packs || []).find((item) => item.id === family.packId);
    const downloadable = web || Boolean(pack);
    const size = web ? (family.downloadMb ? `${family.downloadMb} MB` : "") : pack ? generationDownloadSize(pack) : "";
    if (status === "checking") return <StatusPill status="checking" />;
    if (status === "ready" && web) {
      return (
        <>
          <StatusPill status="ready" />
          <button
            type="button"
            className="settings-secondary model-remove"
            onClick={() => removeFamily(family)}
            disabled={Boolean(busy)}
            aria-label={t("Remove {model}", { model: family.label })}
            title={t("Remove {model} from this browser", { model: family.label })}
          >
            <I.trash />
          </button>
        </>
      );
    }
    if (status === "ready") return <StatusPill status="ready" />;
    if (status === "unsupported") return <StatusPill status="unsupported" />;
    const installing = busy === `installing-${family.id}`;
    const spaceShort = web && generatorsById.get(family.generatorId)?.setup?.spaceShort;
    const label = installing
      ? t("Installing…")
      : spaceShort
        ? t("Not enough space")
        : status === "missing"
          ? size ? t("Download · {size}", { size }) : t("Download")
          : t("Repair");
    const reason = spaceShort
      ? t("Needs {needed} MB, about {free} MB is free on this device.", { needed: spaceShort.neededMb, free: spaceShort.freeMb })
      : !downloadable
        ? t("Not available to download yet.")
        : busy && !installing
          ? t("Wait for the current settings operation to finish.")
          : "";
    return (
      <>
        <button
          className={(downloadable && !family.experimental ? "btn-primary" : "settings-secondary") + " model-action"}
          onClick={() => installModels(family)}
          disabled={!downloadable || Boolean(spaceShort) || Boolean(busy)}
          aria-describedby={`settings-install-reason-${family.id}`}
          title={reason || t("Download {model}", { model: family.label })}
        >
          {label}
        </button>
        <span id={`settings-install-reason-${family.id}`} className="sr-only">{reason}</span>
      </>
    );
  };

  // One row per model; picking a row makes it the model new projects start
  // with. Beta models come with a family's download and can only be picked
  // while "Write whole charts" is on. Experimental families come last.
  const familyRow = (family) => ({
    ...family,
    action: familyAction(family),
    pickable: isReady(family.generatorId),
    reason: t("Download {model} first", { model: family.label }),
  });
  const families = MODEL_FAMILIES.filter((family) => !(web && family.desktopOnly));
  const modelRows = [
    ...families.filter((family) => !family.experimental).map(familyRow),
    ...BETA_MODELS.map((model) => {
      const family = MODEL_FAMILIES.find((item) => item.id === model.familyId);
      const installed = isReady(model.generatorId);
      const downloaded = web ? generatorsById.get(model.generatorId)?.setup?.downloaded : installed;
      return {
        ...model,
        // In the browser it downloads the first time Inpaint runs.
        action: downloaded
          ? <StatusPill status="ready" />
          : installed ? null : <span className="model-row-note">{t("With {model}", { model: family.label })}</span>,
        pickable: installed && settings.fillInDrafts,
        reason: installed ? t("Turn on Write whole charts first") : t("Download {model} first", { model: family.label }),
      };
    }),
    ...families.filter((family) => family.experimental).map(familyRow),
  ];

  const setFillInDrafts = (on) => {
    const patch = { fillInDrafts: on };
    // Turning drafting off moves new projects back to the recommended model.
    if (!on && isBetaGenerator(defaultGeneratorId)) {
      patch.defaultGeneratorId = MODEL_FAMILIES.find((family) => family.recommended)?.generatorId || "";
    }
    void updateModelPreference(patch);
  };

  return (
    <div className="ac-body settings-page">
      <main className="settings-main">
        <header className="page-head settings-head">
          <h1 className="page-title">{t("Settings")}</h1>
          <div className="settings-head-actions">
            <LanguagePicker />
            <button className="settings-secondary" onClick={() => setDiagnosticsOpen(true)} title={t("Model files and hardware")}>
              <I.info /> {t("Diagnostics")}
            </button>
          </div>
        </header>

        {settings.settingsRecovery && (
          <section className="settings-card settings-recovery" role="status">
            <div>
              <h2 className="settings-card-title">{t("Your settings were reset")}</h2>
              <p className="settings-card-sub">
                {rich("The old settings file couldn't be read. It's saved at <code>{path}</code>.", { code: (text) => <code>{text}</code> }, { path: settings.settingsRecovery.backupPath })}
              </p>
            </div>
            <button
              className="settings-secondary"
              disabled={Boolean(busy)}
              onClick={() => runAction("dismiss-recovery", dismissSettingsRecoveryNotice)}
            >
              {t("Dismiss")}
            </button>
          </section>
        )}

        <div className={"settings-grid" + (isWebApp() ? " is-web" : "")}>
          <section className="settings-card settings-models" aria-labelledby="settings-models-title">
            <div className="settings-card-head">
              <h2 className="settings-card-title" id="settings-models-title">{t("Models")}</h2>
              <span className="settings-card-hint" id="settings-models-pick">{t("Pick the one new projects start with")}</span>
            </div>

            <div
              className="model-list"
              role="radiogroup"
              aria-labelledby="settings-models-title"
              aria-describedby="settings-models-pick"
            >
              {modelRows.map((row) => {
                const selected = defaultGeneratorId === row.generatorId;
                return (
                  <div className={"model-row" + (selected ? " selected" : "")} key={row.id}>
                    {/* Covers the whole row so a click anywhere picks it; the
                        switch and the action sit above it. */}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={row.label}
                      className="model-pick"
                      onClick={() => updateModelPreference({ defaultGeneratorId: row.generatorId })}
                      disabled={!row.pickable}
                      title={row.pickable ? t("Start new projects with {model}", { model: row.label }) : row.reason}
                    />
                    <span className="model-radio" aria-hidden="true" />
                    <span className={`model-badge ${row.id}`} aria-hidden="true">{row.badge}</span>
                    <div className="model-row-copy">
                      <div className="model-row-name">
                        <b>{row.label}</b>
                        {row.recommended && <span className="model-tag recommended">{t("Recommended")}</span>}
                        {row.experimental && <span className="model-tag beta">{t("Experimental")}</span>}
                      </div>
                      <small>{row.about}</small>
                    </div>
                    <div className="model-row-action">
                      {isBetaGenerator(row.generatorId) && (
                        <div className="model-row-option">
                          <span id="settings-fill-in-drafts">{t("Write whole charts")}</span>
                          <span className="model-tag beta">{t("Beta")}</span>
                          <i
                            className="ms-info"
                            role="img"
                            aria-label={t(FILL_IN_DRAFTS_HELP)}
                            title={t(FILL_IN_DRAFTS_HELP)}
                          >
                            <I.info />
                          </i>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={settings.fillInDrafts}
                            aria-labelledby="settings-fill-in-drafts"
                            className={"model-switch" + (settings.fillInDrafts ? " on" : "")}
                            onClick={() => setFillInDrafts(!settings.fillInDrafts)}
                          >
                            <span className="model-switch-knob" aria-hidden="true" />
                          </button>
                        </div>
                      )}
                      {row.action}
                    </div>
                  </div>
                );
              })}
            </div>

            {(busy.startsWith("installing-") || installProgress) && <InstallProgress progress={installProgress} />}

            {web && (
              <div className="model-storage">
                <span>{storedBytes ? t("{size} on this device", { size: formatSize(storedBytes) }) : t("Nothing downloaded yet")}</span>
                <button
                  type="button"
                  className="settings-secondary"
                  onClick={removeAll}
                  disabled={Boolean(busy) || !storedBytes}
                  title={t("Remove every model and separated stem from this browser")}
                >
                  <I.trash /> {t("Remove all")}
                </button>
              </div>
            )}
          </section>

          {/* The browser keeps its files in its own storage: no folders to pick. */}
          {!isWebApp() && <section className="settings-card settings-folders" aria-labelledby="settings-folders-title">
            <div className="settings-card-head">
              <h2 className="settings-card-title" id="settings-folders-title">{t("Folders")}</h2>
            </div>
            <div className="folder-list">
              {FOLDER_ROWS.map((row) => {
                const value = settings[row.key];
                const atDefault = settings.pathDefaults ? value === (settings.pathDefaults[row.key] || "") : false;
                return (
                  <div className="folder-row" key={row.key}>
                    <div className="folder-row-copy">
                      <b>{t(row.title)}</b>
                      <button
                        type="button"
                        className={"folder-path" + (value ? "" : " empty")}
                        onClick={() => runAction("opening", () => openSettingsPath(row.key))}
                        disabled={Boolean(busy) || !value}
                        title={value ? t("Open {path}", { path: value }) : ""}
                      >
                        {value ? shortPath(value, home) : t("Not set")}
                      </button>
                    </div>
                    <div className="folder-row-actions">
                      {row.key === "cacheFolder" && (
                        <button
                          className="folder-link"
                          onClick={confirmAndClearCache}
                          disabled={Boolean(busy) || !value}
                          title={t("Delete separations and analysis")}
                        >
                          {t("Clear")}
                        </button>
                      )}
                      <button
                        className="folder-link"
                        onClick={() => runAction(`reset-${row.key}`, () => resetSettingsPath(row.key))}
                        disabled={Boolean(busy) || atDefault}
                        title={atDefault ? t("Already the default") : t("Go back to the default folder")}
                      >
                        {t("Reset")}
                      </button>
                      <button
                        className="settings-secondary"
                        onClick={() => runAction(row.key, row.choose)}
                        disabled={Boolean(busy)}
                        title={t("Choose another folder")}
                      >
                        {t("Change")}
                      </button>
                    </div>
                  </div>
                );
              })}
              <div className="folder-option">
                <span id="settings-keep-stems">{t("Keep separated stems")}</span>
                <i className="ms-info" role="img" aria-label={t(KEEP_STEMS_HELP)} title={t(KEEP_STEMS_HELP)}>
                  <I.info />
                </i>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.keepStems}
                  aria-labelledby="settings-keep-stems"
                  className={"model-switch" + (settings.keepStems ? " on" : "")}
                  onClick={() => void updateModelPreference({ keepStems: !settings.keepStems })}
                >
                  <span className="model-switch-knob" aria-hidden="true" />
                </button>
              </div>
            </div>
          </section>}

          <section className="settings-card settings-perf" aria-labelledby="settings-perf-title">
            <div className="settings-card-head">
              <h2 className="settings-card-title" id="settings-perf-title">{t("Performance")}</h2>
              {!isWebApp() && (
                <span className="settings-card-hint" title={hardwareModeCaveat(settings.hardwareMode, targetPlatform)}>
                  {performanceSummary(hardware, unsupported)}
                </span>
              )}
            </div>
            <div
              className="perf-modes"
              role="radiogroup"
              aria-labelledby="settings-perf-title"
              style={{ gridTemplateColumns: `repeat(${hardwareModes.length}, minmax(0, 1fr))` }}
            >
              {hardwareModes.map((mode) => (
                <button
                  key={mode.value}
                  role="radio"
                  aria-checked={selectedHardwareMode === mode.value}
                  className={selectedHardwareMode === mode.value ? "active" : ""}
                  onClick={() => updateHardwareMode(mode.value)}
                  disabled={Boolean(busy) || unsupported}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            {isWebApp()
              ? <DeviceReadout device={hardware ? deviceFromProbe(hardware) : UNCHECKED_DEVICE} />
              : hardware?.fallbackReason && <p className="settings-card-sub warn">{hardware.fallbackReason}</p>}
          </section>

          {/* The browser version downloads songs, so it says in what form. */}
          {isWebApp() && (
            <section className="settings-card settings-export" aria-labelledby="settings-export-title">
              <div className="settings-card-head">
                <h2 className="settings-card-title" id="settings-export-title">{t("Export")}</h2>
                <span className="settings-card-hint">{t("What Export downloads")}</span>
              </div>
              <div
                className="perf-modes"
                role="radiogroup"
                aria-labelledby="settings-export-title"
                style={{ gridTemplateColumns: `repeat(${EXPORT_FORMATS.length}, minmax(0, 1fr))` }}
              >
                {EXPORT_FORMATS.map((format) => {
                  const selected = (settings.exportFormat === "zip" ? "zip" : "sng") === format.value;
                  return (
                    <button
                      key={format.value}
                      role="radio"
                      aria-checked={selected}
                      className={selected ? "active" : ""}
                      onClick={() => void updateModelPreference({ exportFormat: format.value })}
                      title={t(format.help)}
                    >
                      {t(format.label)}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

        {/* About is quiet text, not a card that looks like a setting. */}
        <footer className="settings-about-foot" aria-label={t("About")}>
          <div className="about-line">
          <span>{web ? t("Your songs and charts stay in this browser.") : t("Everything stays on this computer. No telemetry.")}</span>
          {web ? (
            <div className="folder-option">
              <span id="settings-usage-counts">{t("Share usage counts")}</span>
              <i className="ms-info" role="img" aria-label={t(USAGE_COUNTS_HELP)} title={t(USAGE_COUNTS_HELP)}>
                <I.info />
              </i>
              <button
                type="button"
                role="switch"
                aria-checked={settings.shareUsageCounts !== false}
                aria-labelledby="settings-usage-counts"
                className={"model-switch" + (settings.shareUsageCounts !== false ? " on" : "")}
                onClick={() => void updateModelPreference({ shareUsageCounts: settings.shareUsageCounts === false })}
              >
                <span className="model-switch-knob" aria-hidden="true" />
              </button>
            </div>
          ) : (
            <div className="folder-option">
              <span id="settings-check-updates">{t("Check for updates")}</span>
              <i className="ms-info" role="img" aria-label={t(UPDATE_CHECK_HELP)} title={t(UPDATE_CHECK_HELP)}>
                <I.info />
              </i>
              <button
                type="button"
                role="switch"
                aria-checked={settings.checkForUpdates !== false}
                aria-labelledby="settings-check-updates"
                className={"model-switch" + (settings.checkForUpdates !== false ? " on" : "")}
                onClick={() => void updateModelPreference({ checkForUpdates: settings.checkForUpdates === false })}
              >
                <span className="model-switch-knob" aria-hidden="true" />
              </button>
            </div>
          )}
          </div>
          <div className="about-links">
            <a className="settings-secondary" href={SITE_LINKS.repo} target="_blank" rel="noreferrer">GitHub</a>
            {aboutLinks}
          </div>
        </footer>
        </div>

        {diagnosticsOpen && (
          <DiagnosticsSheet
            setup={setup}
            hardware={hardware}
            busy={busy}
            onCheck={() => loadAll({ fresh: true })}
            onClose={() => setDiagnosticsOpen(false)}
          />
        )}

        {messageText && (
          <div
            className={`${messageTone === "error" ? "play-error" : "play-info"} settings-message`}
            role={messageTone === "error" ? "alert" : "status"}
            aria-live={messageTone === "error" ? "assertive" : "polite"}
          >
            {messageText}
          </div>
        )}
      </main>
    </div>
  );
}
